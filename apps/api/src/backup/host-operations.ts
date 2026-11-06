import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { createInterface, type Interface as ReadLineInterface } from 'node:readline'

type Pending = {
  id: number
  kind: 'result' | 'duplex'
  resolve(value: string | number): void
  reject(error: Error): void
  stdout?: PassThrough
  stderr?: PassThrough
  bytes: number
  maxBytes: number
}

let reader: ReadLineInterface | undefined
let nextId = 0
const pendingRequests = new Map<number, Pending>()
let writes = Promise.resolve()
let receives = Promise.resolve()

function brokerEnabled(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1'
}

function lineReader(): ReadLineInterface {
  if (!reader) {
    reader = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
    reader.on('line', line => {
      receives = receives.then(() => receive(line)).catch(() => {
        for (const request of pendingRequests.values()) request.reject(new Error('BACKUP_HOST_PROTOCOL_INVALID'))
        pendingRequests.clear()
      })
    })
    reader.on('close', () => {
      for (const request of pendingRequests.values()) request.reject(new Error('BACKUP_HOST_CHANNEL_CLOSED'))
      pendingRequests.clear()
    })
  }
  return reader
}

/** Close the per-command RPC channel after the helper returns. Keeping the
 * inherited Docker stdin open must not pin a failed helper or its host lock. */
export function closeHostOperationChannel(): void {
  reader?.close()
  reader = undefined
  process.stdin.pause()
}

function send(fields: string[]): Promise<void> {
  const line = `${fields.join('\t')}\n`
  writes = writes.then(() => new Promise<void>((resolve, reject) => {
    process.stdout.write(line, error => error ? reject(error) : resolve())
  }))
  return writes
}

function decode(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('BACKUP_HOST_PROTOCOL_INVALID')
  return Buffer.from(value, 'base64')
}

async function write(stream: PassThrough | undefined, value: Buffer): Promise<void> {
  if (!stream || stream.destroyed || stream.writableEnded) throw new Error('BACKUP_HOST_STREAM_CLOSED')
  if (stream.write(value)) return
  reader?.pause()
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        stream.removeListener('drain', onDrain)
        stream.removeListener('close', onClose)
        stream.removeListener('error', onError)
      }
      const finish = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onDrain = () => finish()
      const onClose = () => fail(new Error('BACKUP_HOST_STREAM_CLOSED'))
      const onError = (error: Error) => fail(error)
      stream.once('drain', onDrain)
      stream.once('close', onClose)
      stream.once('error', onError)
      if (stream.destroyed || stream.writableEnded) onClose()
      else if (!stream.writableNeedDrain) onDrain()
    })
  } finally { reader?.resume() }
}

async function receive(line: string): Promise<void> {
  const fields = line.split('\t')
  const id = Number(fields[1])
  const request = pendingRequests.get(id)
  if (!request || !Number.isSafeInteger(id) || line.length > Math.min(request.maxBytes * 2 + 4096, 2 * 1024 * 1024)) {
    request?.reject(new Error('BACKUP_HOST_PROTOCOL_INVALID'))
    pendingRequests.delete(id)
    return
  }
  if (fields[0] !== 'RES' || fields[1] !== String(request.id)) {
    request.reject(new Error('BACKUP_HOST_PROTOCOL_INVALID'))
    pendingRequests.delete(id)
    return
  }
  if (fields[2] === 'ERR' && fields.length === 4 && /^[A-Z0-9_]{1,80}$/.test(fields[3]!)) {
    request.reject(new Error(fields[3]!))
    pendingRequests.delete(id)
    return
  }
  if (fields[2] === 'OK' && fields.length === 4 && request.kind === 'result') {
    let value: Buffer
    try { value = decode(fields[3]!) } catch {
      request.reject(new Error('BACKUP_HOST_PROTOCOL_INVALID')); pendingRequests.delete(id); return
    }
    if (value.byteLength > request.maxBytes) {
      request.reject(new Error('BACKUP_HOST_OUTPUT_LIMIT')); pendingRequests.delete(id); return
    }
    request.resolve(value.toString('utf8'))
    pendingRequests.delete(id)
    return
  }
  if (fields[2] === 'STREAM' && fields.length === 3 && request.kind === 'duplex') return
  if (request.kind === 'duplex' && fields.length === 4 && (fields[2] === 'DATA' || fields[2] === 'STDERR')) {
    let value: Buffer
    try { value = decode(fields[3]!) } catch {
      request.reject(new Error('BACKUP_HOST_PROTOCOL_INVALID')); pendingRequests.delete(id); return
    }
    request.bytes += value.byteLength
    if (request.bytes > request.maxBytes) {
      request.reject(new Error('BACKUP_HOST_OUTPUT_LIMIT')); pendingRequests.delete(id); return
    }
    await write(fields[2] === 'DATA' ? request.stdout : request.stderr, value)
    return
  }
  if (request.kind === 'duplex' && fields.length === 4 && fields[2] === 'END' && /^(0|[1-9][0-9]{0,3})$/.test(fields[3]!)) {
    request.resolve(Number(fields[3]))
    pendingRequests.delete(id)
    return
  }
  request.reject(new Error('BACKUP_HOST_PROTOCOL_INVALID'))
  pendingRequests.delete(id)
}

function encode(value: string): string {
  if (value.includes('\0') || Buffer.byteLength(value) > 1024 * 1024) throw new Error('BACKUP_HOST_ARGUMENT_INVALID')
  return Buffer.from(value, 'utf8').toString('base64')
}

function makePending(kind: Pending['kind'], maxBytes: number, streams: Pick<Pending, 'stdout' | 'stderr'> = {}): Pending {
  if (!brokerEnabled() || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024 * 1024) {
    throw new Error('BACKUP_HOST_BROKER_UNAVAILABLE')
  }
  lineReader()
  const request = { id: ++nextId, kind, maxBytes, bytes: 0, ...streams, resolve: () => {}, reject: () => {} }
  pendingRequests.set(request.id, request)
  return request
}

function responsePromise(request: Pending): Promise<string | number> {
  return new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject })
}

export async function hostOperation(action: 'assert-lock' | 'verify-deployment', value?: string): Promise<void> {
  if (action === 'verify-deployment' && (!value || !/^[a-f0-9]{64}$/.test(value))) throw new Error('BACKUP_HOST_ARGUMENT_INVALID')
  const request = makePending('result', 4096)
  const pending = responsePromise(request)
  await send(['REQ', String(request.id), action, ...(value ? [encode(value)] : [])])
  const result = await pending
  if (result !== '') throw new Error('BACKUP_HOST_PROTOCOL_INVALID')
}

export async function hostDockerExec(args: string[], options: { maxBuffer?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
  if (!Array.isArray(args) || args.length < 1 || args.length > 64 || args.some(arg => typeof arg !== 'string')) {
    throw new Error('BACKUP_HOST_ARGUMENT_INVALID')
  }
  if (options.signal?.aborted) throw new Error('BACKUP_HOST_INTERRUPTED')
  const maxBuffer = Math.min(options.maxBuffer ?? 1024 * 1024, 1024 * 1024)
  const timeoutMs = options.timeoutMs ?? 60_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 6 * 60 * 60 * 1000) throw new Error('BACKUP_HOST_ARGUMENT_INVALID')
  const request = makePending('result', maxBuffer)
  const pending = responsePromise(request)
  await send(['REQ', String(request.id), 'docker-exec', encode(String(timeoutMs)), ...args.map(encode)])
  const result = await pending
  if (options.signal?.aborted) throw new Error('BACKUP_HOST_INTERRUPTED')
  if (typeof result !== 'string') throw new Error('BACKUP_HOST_PROTOCOL_INVALID')
  return result
}

class HostDockerChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private readonly id: number
  private canceled = false

  constructor(action: 'docker-stream' | 'docker-stream-file', args: string[], maxBytes: number, signal?: AbortSignal) {
    super()
    const request = makePending('duplex', maxBytes, { stdout: this.stdout, stderr: this.stderr })
    this.id = request.id
    const requestId = request.id
    const pending = responsePromise(request)
    const cancel = () => this.cancelRequest()
    signal?.addEventListener('abort', cancel, { once: true })
    this.stdin.end()
    void (async () => {
      try {
        await send(['REQ', String(requestId), action, ...args.map(encode)])
        const result = await pending
        signal?.removeEventListener('abort', cancel)
        this.stdout.end()
        this.stderr.end()
        this.emit('close', result, null)
      } catch (error) {
        signal?.removeEventListener('abort', cancel)
        this.stdin.destroy(); this.stdout.destroy(); this.stderr.destroy()
        this.emit('error', error)
        this.emit('close', null, null)
      }
    })()
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.cancelRequest(typeof signal === 'string' ? signal : 'SIGTERM')
    return true
  }

  private cancelRequest(signal = 'SIGTERM') {
    if (this.canceled) return
    this.canceled = true
    void send(['CANCEL', String(this.id), signal])
  }
}

/** A ChildProcess-shaped stream whose Docker command runs in the signed host
 * utility. The API container gets no Docker executable or socket. */
export function hostDockerSpawn(args: string[], options: { maxBytes?: number; signal?: AbortSignal } = {}): ChildProcess {
  if (!Array.isArray(args) || args.length < 1 || args.length > 64 || args.some(arg => typeof arg !== 'string')) {
    throw new Error('BACKUP_HOST_ARGUMENT_INVALID')
  }
  return new HostDockerChild('docker-stream', args, options.maxBytes ?? 1024 * 1024 * 1024 * 1024, options.signal) as unknown as ChildProcess
}

export function hostDockerSpawnFile(args: string[], inputPath: string, options: { maxBytes?: number; signal?: AbortSignal } = {}): ChildProcess {
  if (!Array.isArray(args) || args.length < 1 || args.length > 64 || args.some(arg => typeof arg !== 'string') ||
      !inputPath.startsWith('/var/lib/aikayun-backup/')) throw new Error('BACKUP_HOST_ARGUMENT_INVALID')
  return new HostDockerChild('docker-stream-file', [inputPath, ...args], options.maxBytes ?? 1024 * 1024 * 1024, options.signal) as unknown as ChildProcess
}

export async function reportHostEvent(operation: string, backupSetId: string, status: string): Promise<void> {
  if (!/^[a-z-]{1,32}$/.test(operation) || !/^[0-9a-f-]{36}$/.test(backupSetId) || !/^[a-z_]{1,32}$/.test(status)) {
    throw new Error('BACKUP_HOST_EVENT_INVALID')
  }
  const request = makePending('result', 4096)
  const pending = responsePromise(request)
  await send(['REQ', String(request.id), 'client-event', encode(operation), encode(backupSetId), encode(status)])
  await pending
}

export async function reportHostResult(value: unknown): Promise<void> {
  const serialized = JSON.stringify(value)
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 8192) throw new Error('BACKUP_HOST_RESULT_INVALID')
  const request = makePending('result', 4096)
  const pending = responsePromise(request)
  await send(['REQ', String(request.id), 'client-result', encode(serialized)])
  await pending
}
