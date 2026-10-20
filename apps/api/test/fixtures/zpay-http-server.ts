import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo, IncomingMessage, ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'

type ZpaySignatureHelpers = Pick<typeof import('../../src/payments/zpay-epay.js'), 'verifyZpaySignature' | 'createZpaySignature'>
const zpaySignatureHelpers: ZpaySignatureHelpers = process.env.AIKAYUN_TEST_ZPAY_PROVIDER_MODULE
  ? await import(process.env.AIKAYUN_TEST_ZPAY_PROVIDER_MODULE)
  : await import('../../src/payments/zpay-epay.js')
const { verifyZpaySignature, createZpaySignature } = zpaySignatureHelpers

interface FixtureOrder {
  merchantOrderNo: string
  merchantId: string
  merchantKey: string
  providerOrderId: string
  paymentMethod: 'alipay' | 'wxpay'
  amount: string
  status: '0' | '1'
  paidAt: string | null
}

interface FixtureOptions {
  host?: string
  port?: number
  merchantCredentials?: Record<string, string>
}

export interface ZpayHttpFixture {
  baseUrl: string
  close(): Promise<void>
  orders(): Array<Omit<FixtureOrder, 'merchantKey'>>
  pauseNextCreateResponse(): { entered: Promise<void>; release(): void }
  pauseNextQueryResponse(): { entered: Promise<void>; release(): void }
  setPaid(merchantOrderNo: string, overrides?: { amount?: string; providerOrderId?: string }): Record<string, string>
  stats(): { creates: number; queries: number; balanceChecks: number }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    size += chunk.byteLength
    if (size > 64 * 1024) throw new Error('fixture_request_too_large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function parseBody(contentType: string, body: Buffer): Record<string, string> {
  const raw = body.toString('utf8')
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw))
  }
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/u.exec(contentType)?.[1]
    ?? /boundary=(?:"([^"]+)"|([^;]+))/u.exec(contentType)?.[2]
  if (!boundary) return {}
  const fields: Record<string, string> = {}
  for (const part of raw.split(`--${boundary}`)) {
    const crlfSeparator = part.indexOf('\r\n\r\n')
    const lfSeparator = part.indexOf('\n\n')
    const separatorIndex = crlfSeparator >= 0 ? crlfSeparator : lfSeparator
    const separatorLength = crlfSeparator >= 0 ? 4 : 2
    if (separatorIndex < 0) continue
    const name = /content-disposition:\s*form-data;\s*name="([^"]+)"/iu.exec(part.slice(0, separatorIndex))?.[1]
    if (!name) continue
    fields[name] = part.slice(separatorIndex + separatorLength).replace(/\r?\n$/u, '')
  }
  return fields
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

function signedCallback(order: FixtureOrder): Record<string, string> {
  const parameters: Record<string, string> = {
    pid: order.merchantId,
    trade_no: order.providerOrderId,
    out_trade_no: order.merchantOrderNo,
    type: order.paymentMethod,
    money: order.amount,
    trade_status: 'TRADE_SUCCESS',
    sign_type: 'MD5',
  }
  parameters.sign = createZpaySignature(order.merchantKey, parameters)
  return parameters
}

export async function startZpayHttpFixture(options: FixtureOptions = {}): Promise<ZpayHttpFixture> {
  const host = options.host ?? '127.0.0.1'
  const loopback = host === '127.0.0.1' || host === '::1'
  const explicitlyPublishedComposeTestFixture = host === '0.0.0.0'
    && process.env.NODE_ENV === 'test'
    && process.env.AIKAYUN_TEST_ZPAY_FIXTURE === 'true'
    && process.env.AIKAYUN_TEST_ZPAY_FIXTURE_ALLOW_PUBLIC_BIND === 'true'
  if (!loopback && !explicitlyPublishedComposeTestFixture) {
    throw new Error('The test provider fixture must bind to loopback unless explicitly enabled for isolated Compose E2E')
  }
  const ordersByMerchantNo = new Map<string, FixtureOrder>()
  const merchantCredentials = options.merchantCredentials ?? {}
  let creates = 0
  let queries = 0
  let balanceChecks = 0
  let nextCreateResponseGate: {
    entered: Promise<void>
    signalEntered(): void
    waitForRelease: Promise<void>
    release(): void
  } | null = null
  let nextQueryResponseGate: {
    entered: Promise<void>
    signalEntered(): void
    waitForRelease: Promise<void>
    release(): void
  } | null = null

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/__fixture/health' && request.method === 'GET') {
        sendJson(response, 200, { status: 'ok' })
        return
      }
      if (url.pathname === '/__fixture/orders' && request.method === 'GET') {
        sendJson(response, 200, {
          items: [...ordersByMerchantNo.values()].map(({ merchantKey: _merchantKey, ...order }) => order),
          ...{ creates, queries, balanceChecks },
        })
        return
      }
      if (url.pathname === '/__fixture/mark-paid' && request.method === 'POST') {
        const payload = JSON.parse((await readBody(request)).toString('utf8')) as {
          merchantOrderNo?: string
          amount?: string
          providerOrderId?: string
        }
        const merchantOrderNo = payload.merchantOrderNo ?? [...ordersByMerchantNo.keys()].at(-1)
        const existing = merchantOrderNo ? ordersByMerchantNo.get(merchantOrderNo) : undefined
        if (!existing) {
          sendJson(response, 404, { error: 'fixture_order_not_found' })
          return
        }
        const updated: FixtureOrder = {
          ...existing,
          amount: payload.amount ?? existing.amount,
          providerOrderId: payload.providerOrderId ?? existing.providerOrderId,
          status: '1',
          paidAt: '2026-10-20 10:00:00',
        }
        ordersByMerchantNo.set(merchantOrderNo!, updated)
        sendJson(response, 200, { callback: signedCallback(updated) })
        return
      }
      if (url.pathname === '/api.php' && request.method === 'GET') {
        const action = url.searchParams.get('act')
        const merchantId = url.searchParams.get('pid') ?? ''
        const merchantKey = url.searchParams.get('key') ?? ''
        if (action === 'balance') {
          balanceChecks += 1
          sendJson(response, 200, { code: merchantCredentials[merchantId] === merchantKey ? 1 : 0, money: '0.00' })
          return
        }
        if (action !== 'order') {
          sendJson(response, 200, { code: 0 })
          return
        }
        queries += 1
        const merchantOrderNo = url.searchParams.get('out_trade_no') ?? ''
        const order = ordersByMerchantNo.get(merchantOrderNo)
        if (!order || order.merchantId !== merchantId || order.merchantKey !== merchantKey) {
          sendJson(response, 200, { code: 0 })
          return
        }
        const queryOrder = { ...order }
        const queryResponseGate = nextQueryResponseGate
        if (queryResponseGate) {
          nextQueryResponseGate = null
          queryResponseGate.signalEntered()
          await queryResponseGate.waitForRelease
        }
        sendJson(response, 200, {
          code: 1,
          trade_no: queryOrder.providerOrderId,
          out_trade_no: queryOrder.merchantOrderNo,
          type: queryOrder.paymentMethod,
          pid: queryOrder.merchantId,
          money: queryOrder.amount,
          status: Number(queryOrder.status),
          endtime: queryOrder.paidAt ?? '',
        })
        return
      }
      if (url.pathname === '/mapi.php' && request.method === 'POST') {
        creates += 1
        const payload = parseBody(request.headers['content-type'] ?? '', await readBody(request))
        const expectedMerchantKey = merchantCredentials[payload.pid ?? '']
        if (!expectedMerchantKey || !verifyZpaySignature(expectedMerchantKey, payload) || !payload.pid) {
          sendJson(response, 200, { code: 'error', msg: 'invalid fixture signature' })
          return
        }
        const merchantOrderNo = payload.out_trade_no ?? ''
        const paymentMethod = payload.type
        const amount = payload.money ?? ''
        if (!/^\d{20,32}$/u.test(merchantOrderNo) || !/^(?:0|[1-9]\d{0,15})\.\d{2}$/u.test(amount)
          || (paymentMethod !== 'alipay' && paymentMethod !== 'wxpay')) {
          sendJson(response, 200, { code: 0 })
          return
        }
        if ((payload.name ?? '').startsWith('__reject__')) {
          sendJson(response, 200, { code: 0, msg: 'fixture rejection' })
          return
        }
        const existing = ordersByMerchantNo.get(merchantOrderNo)
        if (existing && (existing.merchantId !== payload.pid || existing.amount !== amount || existing.paymentMethod !== paymentMethod)) {
          sendJson(response, 200, { code: 0, msg: 'fixture order conflict' })
          return
        }
        if ((payload.name ?? '').startsWith('__unknown__')) {
          sendJson(response, 200, { code: 1 })
          return
        }
        const order = existing ?? {
          merchantOrderNo,
          merchantId: payload.pid,
          merchantKey: expectedMerchantKey,
          providerOrderId: `ZPAY-${randomUUID()}`,
          paymentMethod,
          amount,
          status: '0' as const,
          paidAt: null,
        }
        ordersByMerchantNo.set(merchantOrderNo, order)
        const createResponseGate = nextCreateResponseGate
        if (createResponseGate) {
          nextCreateResponseGate = null
          createResponseGate.signalEntered()
          await createResponseGate.waitForRelease
        }
        sendJson(response, 200, {
          code: 1,
          trade_no: order.providerOrderId,
          qrcode: `https://pay.fixture.invalid/${order.providerOrderId}`,
        })
        return
      }
      sendJson(response, 404, { error: 'fixture_not_found' })
    } catch {
      sendJson(response, 400, { error: 'fixture_invalid_request' })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })
  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://${host}:${address.port}`,
    close: async () => await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    orders: () => [...ordersByMerchantNo.values()].map(({ merchantKey: _merchantKey, ...order }) => order),
    pauseNextCreateResponse() {
      if (nextCreateResponseGate) throw new Error('A provider create response is already paused')
      let signalEntered!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => { signalEntered = resolve })
      const waitForRelease = new Promise<void>((resolve) => { release = resolve })
      nextCreateResponseGate = { entered, signalEntered, waitForRelease, release }
      return { entered, release: () => release() }
    },
    pauseNextQueryResponse() {
      if (nextQueryResponseGate) throw new Error('A provider query response is already paused')
      let signalEntered!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => { signalEntered = resolve })
      const waitForRelease = new Promise<void>((resolve) => { release = resolve })
      nextQueryResponseGate = { entered, signalEntered, waitForRelease, release }
      return { entered, release: () => release() }
    },
    setPaid(merchantOrderNo, overrides = {}) {
      const existing = ordersByMerchantNo.get(merchantOrderNo)
      if (!existing) throw new Error('fixture_order_not_found')
      const updated: FixtureOrder = {
        ...existing, ...overrides, status: '1', paidAt: '2026-10-20 10:00:00',
      }
      ordersByMerchantNo.set(merchantOrderNo, updated)
      return signedCallback(updated)
    },
    stats: () => ({ creates, queries, balanceChecks }),
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.env.NODE_ENV !== 'test' || process.env.AIKAYUN_TEST_ZPAY_FIXTURE !== 'true') {
    throw new Error('The local payment provider fixture can only run when explicitly enabled in NODE_ENV=test')
  }
  const port = Number(process.env.ZPAY_FIXTURE_PORT ?? '3099')
  const host = process.env.ZPAY_FIXTURE_HOST ?? '127.0.0.1'
  const fixtureMerchantId = process.env.ZPAY_FIXTURE_MERCHANT_ID ?? ''
  const fixtureMerchantKey = process.env.ZPAY_FIXTURE_MERCHANT_KEY ?? ''
  if (!fixtureMerchantId || !fixtureMerchantKey) throw new Error('Test fixture merchant credentials must be supplied explicitly')
  const fixture = await startZpayHttpFixture({
    host, port,
    merchantCredentials: { [fixtureMerchantId]: fixtureMerchantKey },
  })
  process.stdout.write(`test-only ZPAY HTTP fixture listening on ${fixture.baseUrl}\n`)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void fixture.close().finally(() => process.exit(0)) })
  }
}
