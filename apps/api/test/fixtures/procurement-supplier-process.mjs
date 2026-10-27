import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('A private fixture directory is required')
await mkdir(root, { recursive: true, mode: 0o700 })
const journal = join(root, 'supplier-events.jsonl')
const controlPath = join(root, 'supplier-control.json')
let control = { kind: 'success', execute: true, holdSubmit: false, queryError: false }
let appendQueue = Promise.resolve()
const heldResponses = new Set()

async function append(event) {
  const row = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'
  appendQueue = appendQueue.then(async () => {
    const handle = await import('node:fs/promises').then(fs => fs.open(journal, 'a', 0o600))
    try { await handle.writeFile(row); await handle.sync() } finally { await handle.close() }
  })
  await appendQueue
}

async function events() {
  try {
    const data = await readFile(journal, 'utf8')
    return data.split('\n').filter(Boolean).map(row => JSON.parse(row))
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
}

function resultFor(request) {
  const number = control.supplierOrderNumber || 'fixture-' + createHash('sha256').update(request.requestIdentity).digest('hex').slice(0, 20)
  const digest = createHash('sha256').update(JSON.stringify({ requestIdentity: request.requestIdentity, kind: control.kind, number })).digest('hex')
  return {
    requestIdentity: request.requestIdentity,
    kind: control.kind || 'success',
    supplierOrderNumber: number,
    ...(control.kind === 'success' ? { unitIndices: control.unitIndices || [1], deliveryConfirmed: true } : {}),
    responseDigest: digest,
  }
}

async function readRequest(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ready: true, pid: process.pid })); return
    }
    if (request.method === 'GET' && url.pathname === '/stats') {
      const rows = await events()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        pid: process.pid,
        submitRequests: rows.filter(row => row.type === 'submit').length,
        queryRequests: rows.filter(row => row.type === 'query').length,
        executions: rows.filter(row => row.type === 'execution').length,
        events: rows,
      }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/control') {
      const next = await readRequest(request)
      control = { ...control, ...next }
      const temporary = controlPath + '.tmp'
      await writeFile(temporary, JSON.stringify(control), { mode: 0o600 })
      await rename(temporary, controlPath)
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(control)); return
    }
    if (request.method === 'POST' && url.pathname === '/release') {
      for (const resume of [...heldResponses]) resume()
      heldResponses.clear()
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ released: true })); return
    }
    if (request.method !== 'POST' || !['/submit', '/query'].includes(url.pathname)) {
      response.writeHead(404); response.end(); return
    }
    const body = await readRequest(request)
    const action = url.pathname === '/submit' ? 'submit' : 'query'
    await append({ type: action, operationId: body.operationId, requestIdentity: body.requestIdentity,
      generation: body.generation, action: body.action, supplierOrderNumber: body.supplierOrderNumber ?? null })
    control = { ...control, ...JSON.parse(await readFile(controlPath, 'utf8').catch(() => '{}')) }
    if (action === 'query') {
      if (control.queryError) { response.writeHead(503); response.end('fixture query fault'); return }
      const rows = await events()
      const fact = rows.findLast(row => row.type === 'provider_fact' && row.requestIdentity === body.requestIdentity)
      const result = fact ? fact.result : {
        requestIdentity: body.requestIdentity, kind: 'not_found', supplierOrderNumber: null,
        responseDigest: createHash('sha256').update('not-found:' + body.requestIdentity).digest('hex'),
      }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result)); return
    }
    const result = control.execute === false
      ? { requestIdentity: body.requestIdentity, kind: 'unknown', supplierOrderNumber: null,
          responseDigest: createHash('sha256').update('unknown:' + body.requestIdentity).digest('hex') }
      : resultFor(body)
    if (control.execute !== false) {
      await append({ type: 'provider_fact', operationId: body.operationId, requestIdentity: body.requestIdentity, result })
      if (!['rejected', 'unknown', 'not_found'].includes(result.kind)) {
        await append({ type: 'execution', operationId: body.operationId, requestIdentity: body.requestIdentity,
          supplierOrderNumber: result.supplierOrderNumber })
      }
    }
    if (control.holdSubmit) {
      await new Promise(resolve => heldResponses.add(resolve))
    }
    if (!response.destroyed) {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
    }
  } catch {
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
})

const requestedPort = process.argv[3] ? Number(process.argv[3]) : 0
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid fixture port')
server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(JSON.stringify({ ready: 'http://127.0.0.1:' + address.port, pid: process.pid }) + '\n')
})

function shutdown() {
  server.close(() => process.exit(0))
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
