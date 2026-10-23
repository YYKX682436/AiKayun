import { createServer } from 'node:http'
import type { AddressInfo, IncomingMessage, ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'

interface DeliveryRequest {
  protocol: 'http_json_v1'
  operationId: string
  idempotencyKey: string
  productId: string
  quantity: 1
  unitAmount: string
  currency: 'CNY'
  parameters: Record<string, string>
}

interface FixtureOperation {
  request: DeliveryRequest
  supplierOperationId: string
  status: 'processing' | 'succeeded'
  result: { type: string; content?: string | null; title?: string | null; instructions?: string | null } | null
  mode: string
  queryCount: number
}

interface Gate {
  entered: Promise<void>
  release(): void
}

export interface HttpJsonV1Fixture {
  baseUrl: string
  close(): Promise<void>
  setBearerTokens(tokens: string[]): void
  reset(): void
  stats(): { createRequests: number; executions: number; queries: number; providerIdQueries: number; idempotencyQueries: number; capabilities: number; redirects: number }
  deliveries(): Array<{ request: DeliveryRequest; supplierOperationId: string; status: string }>
  pauseNextCreateResponse(): Gate
  pauseNextQueryResponse(): Gate
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue)
    length += chunk.length
    if (length > 16 * 1024) throw new Error('fixture_request_too_large')
    chunks.push(chunk)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('fixture_request_invalid')
  return parsed as Record<string, unknown>
}

function responseIdentity(request: DeliveryRequest, mode?: string) {
  return {
    protocol: 'http_json_v1', operationId: request.operationId, idempotencyKey: request.idempotencyKey,
    productId: mode === 'identity_mismatch' ? 'mismatched-product' : request.productId,
    ...(mode === 'wrong_operation' ? { operationId: '00000000-0000-4000-8000-000000000002' } : {}),
    ...(mode === 'wrong_idempotency' ? { idempotencyKey: 'aikayun:00000000-0000-4000-8000-000000000002' } : {}),
    quantity: mode === 'wrong_quantity' ? 2 : 1,
    unitAmount: mode === 'wrong_amount' ? '999.99' : request.unitAmount,
    currency: mode === 'wrong_currency' ? 'USD' : 'CNY',
  }
}

export async function startHttpJsonV1Fixture(options: {
  host?: string
  port?: number
  bearerTokens?: string[]
} = {}): Promise<HttpJsonV1Fixture> {
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('The supplier HTTP fixture must bind to loopback')
  const tokenSet = new Set(options.bearerTokens ?? ['playwright-only-supplier-token'])
  const operations = new Map<string, FixtureOperation>()
  const idempotency = new Map<string, FixtureOperation>()
  const productCounts = new Map<string, number>()
  let createRequests = 0
  let executions = 0
  let queries = 0
  let providerIdQueries = 0
  let idempotencyQueries = 0
  let capabilities = 0
  let redirects = 0
  let createGate: { entered: () => void; release: () => void; promise: Promise<void> } | undefined
  let queryGate: { entered: () => void; release: () => void; promise: Promise<void> } | undefined

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/__fixture/health' && request.method === 'GET') return json(response, 200, { ready: true })
      if (url.pathname === '/__fixture/stats' && request.method === 'GET') return json(response, 200, {
        createRequests, executions, queries, providerIdQueries, idempotencyQueries, capabilities, redirects,
      })
      if (url.pathname.startsWith('/redirect/')) {
        redirects += 1
        response.writeHead(302, { location: 'http://127.0.0.1:1/internal' })
        response.end()
        return
      }
      if (request.headers.authorization !== `Bearer ${[...tokenSet][0]}`
        && ![...tokenSet].some(token => request.headers.authorization === `Bearer ${token}`)) {
        return json(response, 401, { error: { code: 'unauthorized' } })
      }
      if (url.pathname === '/capabilities' && request.method === 'GET') {
        capabilities += 1
        return json(response, 200, {
          protocol: 'http_json_v1', idempotencyGuaranteed: true,
          statusQueryByIdempotency: true, statusQueryBySupplierOperationId: true,
        })
      }
      if (url.pathname === '/deliveries' && request.method === 'POST') {
        createRequests += 1
        const row = await readJson(request)
        const fixtureRequest = row as unknown as DeliveryRequest
        const prior = idempotency.get(fixtureRequest.idempotencyKey)
        if (prior) return json(response, 200, {
          ...responseIdentity(prior.request), supplierOperationId: prior.supplierOperationId,
          status: prior.status, result: prior.status === 'succeeded' ? prior.result : null,
        })
        const mode = fixtureRequest.parameters?.mode ?? 'success'
        const count = (productCounts.get(fixtureRequest.productId) ?? 0) + 1
        productCounts.set(fixtureRequest.productId, count)
        if (mode === 'rejected' || (mode === 'two_rejected_once' && count <= 2)) {
          if (createGate) {
            const gate = createGate
            createGate = undefined
            gate.entered()
            await gate.promise
          }
          return json(response, 200, {
            ...responseIdentity(fixtureRequest), supplierOperationId: null, status: 'rejected', result: null,
            error: { code: 'fixture_rejected_without_delivery' },
          })
        }
        const partialMode = mode === 'partial'
        if (partialMode && count === 4) {
          if (createGate) {
            const gate = createGate
            createGate = undefined
            gate.entered()
            await gate.promise
          }
          return json(response, 200, {
            ...responseIdentity(fixtureRequest), supplierOperationId: null, status: 'rejected', result: null,
            error: { code: 'fixture_partial_unit_rejected' },
          })
        }
        const supplierOperationId = `fixture-${fixtureRequest.operationId}`
        const shouldRemainProcessing = mode === 'accepted' || (partialMode && count === 5)
        let result: FixtureOperation['result'] = { type: 'code', content: `fixture-code-${fixtureRequest.operationId}` }
        if (mode === 'duplicate') result = { type: 'code', content: 'fixture-duplicate-code' }
        if (mode === 'text') result = { type: 'text', content: 'fixture delivery text' }
        if (mode === 'redemption') result = { type: 'redemption', content: 'https://redeem.example/claim/fixture' }
        if (mode === 'link') result = { type: 'link', content: 'https://deliver.example/fixture' }
        if (mode === 'completed') result = { type: 'completed', content: null }
        if (mode === 'partial' && count === 5) result = null
        const operation: FixtureOperation = {
          request: fixtureRequest,
          supplierOperationId,
          status: shouldRemainProcessing ? 'processing' : 'succeeded',
          result: shouldRemainProcessing ? null : result,
          mode,
          queryCount: 0,
        }
        idempotency.set(fixtureRequest.idempotencyKey, operation)
        operations.set(supplierOperationId, operation)
        executions += 1
        if (createGate) {
          const gate = createGate
          createGate = undefined
          gate.entered()
          await gate.promise
        }
        if (mode === 'response_lost_after_execution' || mode === 'unknown_after_execution') {
          response.destroy()
          return
        }
        if (mode === 'http_429' || mode === 'http_500') return json(response, mode === 'http_429' ? 429 : 500, { error: 'temporarily unavailable' })
        if (mode === 'interrupted') {
          response.writeHead(200, { 'content-type': 'application/json', 'content-length': '999' })
          response.write('{"protocol":')
          setImmediate(() => response.destroy())
          return
        }
        return json(response, 200, {
          ...responseIdentity(fixtureRequest, mode), supplierOperationId,
          status: operation.status === 'succeeded' ? 'succeeded' : 'accepted',
          result: operation.result,
        })
      }
      if (url.pathname.startsWith('/deliveries/by-idempotency/') && request.method === 'GET') {
        return sendQuery(request, response, decodeURIComponent(url.pathname.split('/').at(-1) ?? ''), null)
      }
      if (url.pathname.startsWith('/deliveries/') && request.method === 'GET') {
        return sendQuery(request, response, null, decodeURIComponent(url.pathname.split('/').at(-1) ?? ''))
      }
      return json(response, 404, { error: { code: 'not_found' } })
    } catch {
      if (!response.headersSent) json(response, 400, { error: { code: 'fixture_request_invalid' } })
      else response.destroy()
    }
  })

  async function sendQuery(
    request: IncomingMessage,
    response: ServerResponse,
    key: string | null,
    providerId: string | null,
  ) {
    queries += 1
    if (key) idempotencyQueries += 1
    if (providerId) providerIdQueries += 1
    const operation = key ? idempotency.get(key) : providerId ? operations.get(providerId) : undefined
    if (queryGate) {
      const gate = queryGate
      queryGate = undefined
      gate.entered()
      await gate.promise
    }
    if (!operation) {
      if (key === 'aikayun:00000000-0000-4000-8000-000000000001' || providerId === 'capability-probe-operation') return json(response, 200, {
        protocol: 'http_json_v1', operationId: '00000000-0000-4000-8000-000000000001',
        idempotencyKey: 'aikayun:00000000-0000-4000-8000-000000000001',
        productId: 'capability-probe', quantity: 1, unitAmount: '0.00', currency: 'CNY',
        supplierOperationId: null, status: 'not_found', result: null,
      })
      return json(response, 200, {
        protocol: 'http_json_v1', supplierOperationId: null, status: 'not_found', result: null,
        ...(key ? { operationId: key.slice('aikayun:'.length), idempotencyKey: key }
          : { queriedSupplierOperationId: providerId }),
      })
    }
    operation.queryCount += 1
    if ((operation.mode === 'accepted' || (operation.mode === 'partial' && operation.queryCount > 0))) {
      operation.status = 'succeeded'
      operation.result = operation.result ?? { type: 'completed', content: null }
    }
    return json(response, 200, {
      ...responseIdentity(operation.request), supplierOperationId: operation.supplierOperationId,
      status: operation.status, result: operation.status === 'succeeded' ? operation.result : null,
    })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })
  const address = server.address() as AddressInfo

  const makeGate = (action: 'create' | 'query'): Gate => {
    let entered!: () => void
    let release!: () => void
    const gate: Gate = {
      entered: new Promise<void>(resolve => { entered = resolve }),
      release: () => release(),
    }
    const record = { entered: () => entered(), release: () => release(), promise: new Promise<void>(resolve => { release = resolve }) }
    if (action === 'create') createGate = record
    else queryGate = record
    return gate
  }

  return {
    baseUrl: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    setBearerTokens(tokens) { tokenSet.clear(); tokens.forEach(token => tokenSet.add(token)) },
    reset() {
      operations.clear(); idempotency.clear(); productCounts.clear()
      createRequests = 0; executions = 0; queries = 0; providerIdQueries = 0; idempotencyQueries = 0; capabilities = 0; redirects = 0
      createGate = undefined; queryGate = undefined
    },
    stats: () => ({ createRequests, executions, queries, providerIdQueries, idempotencyQueries, capabilities, redirects }),
    deliveries: () => [...idempotency.values()].map(operation => ({
      request: operation.request, supplierOperationId: operation.supplierOperationId, status: operation.status,
    })),
    pauseNextCreateResponse: () => makeGate('create'),
    pauseNextQueryResponse: () => makeGate('query'),
  }
}

if (process.argv.includes('--serve') && import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.HTTP_JSON_V1_FIXTURE_PORT ?? '3101')
  const bearerToken = process.env.HTTP_JSON_V1_FIXTURE_BEARER_TOKEN ?? 'playwright-only-supplier-token'
  const fixture = await startHttpJsonV1Fixture({ host: '127.0.0.1', port, bearerTokens: [bearerToken] })
  process.on('SIGTERM', () => { void fixture.close().then(() => process.exit(0)) })
  process.on('SIGINT', () => { void fixture.close().then(() => process.exit(0)) })
  process.stdout.write(`http_json_v1 fixture ready at ${fixture.baseUrl}\n`)
}
