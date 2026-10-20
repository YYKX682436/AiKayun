import { createHash, timingSafeEqual } from 'node:crypto'
import { settleAmount } from '@aikayun/money'
import type {
  PaymentCreateRequest,
  PaymentCreateResult,
  PaymentMethod,
  PaymentProviderAdapter,
  PaymentProviderCredentials,
  PaymentQueryResult,
  ProviderResultStatus,
  VerifiedCallback,
} from './provider.js'

const maxProviderResponseBytes = 64 * 1024

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = String(value).trim()
  return normalized.length ? normalized : null
}

function mapMethod(value: string | null): PaymentMethod | null {
  if (value === 'alipay') return 'alipay'
  if (value === 'wxpay') return 'wechat'
  return null
}

function mapMethodToProvider(value: PaymentMethod): 'alipay' | 'wxpay' {
  return value === 'wechat' ? 'wxpay' : 'alipay'
}

function normalizedAmount(value: unknown): string | null {
  const amount = text(value)
  if (!amount || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u.test(amount)) return null
  try {
    const settled = settleAmount(amount)
    return settled === '0.00' ? null : settled
  } catch {
    return null
  }
}

export function createZpaySignature(merchantKey: string, parameters: Record<string, string>): string {
  const entries = Object.entries(parameters)
    .filter(([key, value]) => key !== 'sign' && key !== 'sign_type' && value !== '')
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  const canonical = entries.map(([key, value]) => `${key}=${value}`).join('&') + merchantKey
  return createHash('md5').update(canonical, 'utf8').digest('hex')
}

export function verifyZpaySignature(merchantKey: string, parameters: Record<string, string>): boolean {
  const received = parameters.sign
  if (!received || !/^[0-9a-f]{32}$/iu.test(received)) return false
  const expected = Buffer.from(createZpaySignature(merchantKey, parameters), 'hex')
  const actual = Buffer.from(received.toLowerCase(), 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function callbackStatus(value: string | null): ProviderResultStatus {
  // The provider documents only TRADE_SUCCESS as a paid callback state.
  if (value === 'TRADE_SUCCESS') return 'paid'
  return value ? 'pending' : 'unknown'
}

function checkedBaseUrl(baseUrl: string): URL {
  const url = new URL(baseUrl)
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password
    || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('Payment provider base URL must be an origin without credentials, path, query or fragment')
  }
  return url
}

async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxProviderResponseBytes) {
    await response.body?.cancel()
    throw new Error('provider_response_too_large')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxProviderResponseBytes) {
        await reader.cancel()
        throw new Error('provider_response_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

async function requestJson(url: URL, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(8_000),
  })
    if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel()
    throw new Error('provider_http_status_unknown')
  }
  const raw = await readLimitedBody(response)
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error('provider_response_content_type_unknown')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new Error('provider_response_json_unknown')
  }
  const record = asRecord(parsed)
  if (!record) throw new Error('provider_response_shape_unknown')
  return record
}

function queryHash(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(Object.keys(payload).sort().map(key => [key, payload[key]]))
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export class ZpayEpayProvider implements PaymentProviderAdapter {
  readonly id = 'zpay_epay_v1' as const
  readonly displayName = 'ZPAY 易支付兼容协议 v1'
  readonly paymentMethods = ['alipay', 'wechat'] as const
  readonly supportsStatusQuery = true as const
  private readonly baseUrl: URL

  constructor(baseUrl = 'https://zpayz.cn') {
    this.baseUrl = checkedBaseUrl(baseUrl)
  }

  async create(
    credentials: PaymentProviderCredentials,
    request: PaymentCreateRequest,
  ): Promise<PaymentCreateResult> {
    const parameters: Record<string, string> = {
      pid: credentials.merchantId,
      type: mapMethodToProvider(request.paymentMethod),
      out_trade_no: request.merchantOrderNo,
      notify_url: request.notifyUrl,
      name: request.productName,
      money: request.amount,
      clientip: request.clientIp,
    }
    parameters.sign = createZpaySignature(credentials.merchantKey, parameters)
    parameters.sign_type = 'MD5'
    const form = new FormData()
    for (const [key, value] of Object.entries(parameters)) form.set(key, value)

    let response: Record<string, unknown>
    try {
      response = await requestJson(new URL('/mapi.php', this.baseUrl), { method: 'POST', body: form })
    } catch {
      return { kind: 'unknown', code: 'provider_create_response_unknown' }
    }
    if (response.code === 'error' || (typeof response.code === 'number' && Number.isFinite(response.code) && response.code !== 1)) {
      return { kind: 'rejected', code: 'provider_rejected_request' }
    }
    if (!(response.code === 1 || response.code === '1')) return { kind: 'unknown', code: 'provider_create_response_unknown' }

    const providerOrderId = text(response.trade_no)
    // The documented MAPI success body does not echo out_trade_no or money.
    // Its authenticated order query is the authority for those facts.
    if (!providerOrderId || providerOrderId.length > 200) return { kind: 'unknown', code: 'provider_create_identity_unknown' }
    const qrValue = text(response.qrcode)
    if (qrValue && qrValue.length <= 2048) return { kind: 'ready', providerOrderId, action: { type: 'qr_code', value: qrValue } }

    for (const carrier of [response.payurl, response.payurl2]) {
      const value = text(carrier)
      if (!value || value.length > 2048) continue
      try {
        const url = new URL(value)
        if (url.protocol === 'https:' && !url.username && !url.password) {
          return { kind: 'ready', providerOrderId, action: { type: 'redirect', url: url.toString() } }
        }
      } catch {
        // Invalid provider-generated payment URLs are treated as unknown, not redirected.
      }
    }
    return { kind: 'unknown', code: 'provider_payment_action_unknown' }
  }

  verifyCallback(
    credentials: PaymentProviderCredentials,
    parameters: Record<string, string>,
    eventSha256: string,
  ): VerifiedCallback | null {
    if (parameters.sign_type !== 'MD5' || parameters.pid !== credentials.merchantId
      || !verifyZpaySignature(credentials.merchantKey, parameters)) return null
    const merchantOrderNo = text(parameters.out_trade_no)
    const rawProviderOrderId = text(parameters.trade_no)
    const providerOrderId = rawProviderOrderId && rawProviderOrderId.length <= 200 ? rawProviderOrderId : null
    const paymentMethod = mapMethod(text(parameters.type))
    const amount = normalizedAmount(parameters.money)
    return {
      merchantOrderNo,
      merchantId: text(parameters.pid),
      providerOrderId,
      paymentMethod,
      amount,
      status: callbackStatus(text(parameters.trade_status)),
      currency: 'CNY',
      payload: parameters,
      eventSha256,
      providerTimeText: null,
    }
  }

  async query(credentials: PaymentProviderCredentials, merchantOrderNo: string): Promise<PaymentQueryResult> {
    const url = new URL('/api.php', this.baseUrl)
    url.searchParams.set('act', 'order')
    url.searchParams.set('pid', credentials.merchantId)
    url.searchParams.set('key', credentials.merchantKey)
    url.searchParams.set('out_trade_no', merchantOrderNo)
    const unknown = (payload: Record<string, unknown> = {}): PaymentQueryResult => ({
      status: 'unknown', merchantOrderNo: null, merchantId: null, providerOrderId: null,
      paymentMethod: null, amount: null, currency: 'CNY', paidAtText: null,
      payload, eventSha256: queryHash(payload),
    })
    let response: Record<string, unknown>
    try {
      response = await requestJson(url, { method: 'GET' })
    } catch {
      return unknown({ query: 'unavailable' })
    }
    if (Number(response.code) !== 1) return unknown(response)
    const result: Record<string, unknown> = {
      code: response.code,
      trade_no: response.trade_no,
      out_trade_no: response.out_trade_no,
      type: response.type,
      pid: response.pid,
      money: response.money,
      status: response.status,
      endtime: response.endtime,
    }
    const returnedOrderNo = text(response.out_trade_no)
    const merchantId = text(response.pid)
    const providerOrderId = text(response.trade_no)
    const paymentMethod = mapMethod(text(response.type))
    const amount = normalizedAmount(response.money)
    const status = response.status === 1 || response.status === '1'
      ? 'paid'
      : response.status === 0 || response.status === '0'
        ? 'pending'
        : 'unknown'
    return {
      status: returnedOrderNo === merchantOrderNo && merchantId === credentials.merchantId
        && returnedOrderNo.length <= 32 && providerOrderId && providerOrderId.length <= 200
        && amount ? status : 'unknown',
      merchantOrderNo: returnedOrderNo,
      merchantId,
      providerOrderId,
      paymentMethod,
      amount,
      currency: 'CNY',
      paidAtText: text(response.endtime),
      payload: result,
      eventSha256: queryHash(result),
    }
  }

  async testConfiguration(credentials: PaymentProviderCredentials): Promise<boolean> {
    const url = new URL('/api.php', this.baseUrl)
    url.searchParams.set('act', 'balance')
    url.searchParams.set('pid', credentials.merchantId)
    url.searchParams.set('key', credentials.merchantKey)
    try {
      const response = await requestJson(url, { method: 'GET' })
      return Number(response.code) === 1
    } catch {
      return false
    }
  }
}
