import { lookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { AppConfig } from '../config.js'
import type { ApiDeliveryResult } from './supplier-api-crypto.js'

const timeoutMs = 8_000
const maxResponseBytes = 64 * 1024
const maxRequestBytes = 16 * 1024

function containsAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  })
}

export interface HttpJsonV1Supplier {
  baseUrl: string
  bearerToken: string
}

export interface HttpJsonV1DeliveryRequest {
  operationId: string
  idempotencyKey: string
  productId: string
  unitAmount: string
  parameters: Record<string, string>
}

export type HttpJsonV1Outcome =
  | { kind: 'succeeded'; providerOperationId: string; result: ApiDeliveryResult; responseSha256: string; httpStatus: number }
  | { kind: 'processing'; providerOperationId: string; status: 'accepted' | 'processing'; responseSha256: string; httpStatus: number }
  | { kind: 'rejected'; code: string; responseSha256: string; httpStatus: number }
  | { kind: 'not_found'; responseSha256: string; httpStatus: number }

export type SupplierErrorClass = 'transport_unknown' | 'http_unknown' | 'redirect_rejected'
  | 'response_invalid' | 'identity_mismatch' | 'result_invalid' | 'capability_missing'

export class HttpJsonV1Error extends Error {
  constructor(
    readonly classification: SupplierErrorClass,
    readonly code: string,
    readonly httpStatus: number | null = null,
  ) {
    super(code)
    this.name = 'HttpJsonV1Error'
  }
}

interface ResolvedAddress { address: string; family: 4 | 6 }

function ipv4Number(value: string): number | null {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0
}

function inV4Cidr(value: number, base: string, bits: number): boolean {
  const network = ipv4Number(base)
  if (network === null) return true
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (network & mask)
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address)
  if (value === null) return false
  const denied: Array<[string, number]> = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
  ]
  return !denied.some(([base, bits]) => inV4Cidr(value, base, bits))
}

function ipv6Groups(value: string): number[] | null {
  if (value.includes('%')) return null
  let input = value.toLowerCase()
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':')
    const v4 = ipv4Number(input.slice(lastColon + 1))
    if (v4 === null) return null
    input = `${input.slice(0, lastColon)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const halves = input.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0]!.split(':') : []
  const right = halves[1] ? halves[1]!.split(':') : []
  if (halves.length === 1 && left.length !== 8) return null
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0
  if (zeros < 0 || (halves.length === 2 && zeros < 1)) return null
  const groups = [...left, ...Array.from({ length: zeros }, () => '0'), ...right]
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/u.test(group))) return null
  return groups.map(group => Number.parseInt(group, 16))
}

function isPublicIpv6(address: string): boolean {
  const groups = ipv6Groups(address)
  if (!groups) return false
  const first = groups[0]!
  const second = groups[1]!
  // Global unicast only. This excludes unspecified, loopback, mapped IPv4,
  // link-local, ULA, multicast, NAT64 and other non-global ranges.
  if ((first & 0xe000) !== 0x2000) return false
  if (first === 0x2002 || (first === 0x2001 && second <= 0x01ff)) return false
  if (first === 0x2001 && second === 0x0db8) return false
  return true
}

export function isPublicAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/gu, '')
  const family = isIP(normalized)
  return family === 4 ? isPublicIpv4(normalized) : family === 6 ? isPublicIpv6(normalized) : false
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/gu, '').toLowerCase()
  if (isIP(normalized) === 4) return normalized.startsWith('127.')
  const groups = ipv6Groups(normalized)
  return Boolean(groups && groups.every((part, index) => index === 7 ? part === 1 : part === 0))
}

export function validateSupplierBaseUrl(value: string, config: AppConfig): URL {
  if (value !== value.trim() || value.length > 2048 || containsAsciiControl(value) || /\s|\\/u.test(value)
    || /(?:^|\/)\.{1,2}(?:\/|$)|%(?:2e|2f|5c)/iu.test(value)) {
    throw new HttpJsonV1Error('response_invalid', 'supplier_url_invalid')
  }
  let url: URL
  try { url = new URL(value) } catch { throw new HttpJsonV1Error('response_invalid', 'supplier_url_invalid') }
  if (!url.hostname || url.username || url.password || url.search || url.hash || url.href.length > 2048
    || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new HttpJsonV1Error('response_invalid', 'supplier_url_invalid')
  }
  if (url.protocol === 'http:' && !(config.nodeEnv === 'test' && config.supplierHttpTestAllowlist.includes(url.origin))) {
    throw new HttpJsonV1Error('response_invalid', 'supplier_https_required')
  }
  if (url.protocol === 'https:' && config.supplierHttpTestAllowlist.includes(url.origin)) {
    throw new HttpJsonV1Error('response_invalid', 'supplier_test_allowlist_is_http_only')
  }
  return url
}

export async function resolvePinnedAddress(
  url: URL,
  config: AppConfig,
  resolveHostname: (hostname: string) => Promise<ResolvedAddress[]> = async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true }))
      .map(row => ({ address: row.address, family: row.family as 4 | 6 })),
): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/gu, '')
  const family = isIP(host)
  let addresses: ResolvedAddress[]
  if (family) {
    addresses = [{ address: host, family: family as 4 | 6 }]
  } else {
    try {
      addresses = await resolveHostname(host)
    } catch {
      throw new HttpJsonV1Error('transport_unknown', 'supplier_dns_failed')
    }
  }
  if (!addresses.length) throw new HttpJsonV1Error('transport_unknown', 'supplier_dns_empty')
  const testAllowed = config.nodeEnv === 'test' && url.protocol === 'http:'
    && config.supplierHttpTestAllowlist.includes(url.origin)
  const allAllowed = addresses.every(row => testAllowed ? isLoopbackAddress(row.address) : isPublicAddress(row.address))
  if (!allAllowed) throw new HttpJsonV1Error('response_invalid', 'supplier_address_not_public')
  return addresses[0]!
}

function appendPath(baseUrl: URL, suffix: string): URL {
  const basePath = baseUrl.pathname.replace(/\/+$/u, '')
  return new URL(`${basePath}${suffix}`, baseUrl.origin)
}

interface WireResponse { status: number; contentType: string; body: Buffer; sha256: string }

async function requestWire(
  config: AppConfig,
  supplier: HttpJsonV1Supplier,
  target: URL,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<WireResponse> {
  const pinned = await resolvePinnedAddress(target, config)
  const encodedBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  if (encodedBody && encodedBody.length > maxRequestBytes) throw new HttpJsonV1Error('response_invalid', 'supplier_request_too_large')
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
  return await new Promise<WireResponse>((resolve, reject) => {
    let settled = false
    const finishReject = (error: HttpJsonV1Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const request = transport(target, {
      method,
      agent: false,
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        authorization: `Bearer ${supplier.bearerToken}`,
        ...(encodedBody ? { 'content-type': 'application/json', 'content-length': String(encodedBody.length) } : {}),
      },
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) {
          callback(null, [{ address: pinned.address, family: pinned.family }])
        } else callback(null, pinned.address, pinned.family)
      },
      servername: isIP(target.hostname.replace(/^\[|\]$/gu, '')) ? undefined : target.hostname,
    }, (response) => {
      const status = response.statusCode ?? 0
      const declared = Number(response.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        response.destroy()
        finishReject(new HttpJsonV1Error('response_invalid', 'supplier_response_too_large', status))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer | string) => {
        if (settled) return
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += value.length
        if (size > maxResponseBytes) {
          response.destroy()
          finishReject(new HttpJsonV1Error('response_invalid', 'supplier_response_too_large', status))
          return
        }
        chunks.push(value)
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        const bytes = Buffer.concat(chunks)
        resolve({
          status,
          contentType: String(response.headers['content-type'] ?? '').toLowerCase(),
          body: bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      })
      response.on('error', () => finishReject(new HttpJsonV1Error('transport_unknown', 'supplier_response_interrupted', status || null)))
    })
    const timer = setTimeout(() => request.destroy(new Error('supplier_timeout')), timeoutMs)
    timer.unref()
    request.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      const code = error.message === 'supplier_timeout' ? 'supplier_timeout'
        : error.code === 'ECONNREFUSED' ? 'supplier_connection_refused'
          : error.code === 'ETIMEDOUT' ? 'supplier_timeout' : 'supplier_network_error'
      finishReject(new HttpJsonV1Error('transport_unknown', code))
    })
    request.on('close', () => clearTimeout(timer))
    if (encodedBody) request.write(encodedBody)
    request.end()
  })
}

function parseJson(response: WireResponse): Record<string, unknown> {
  if (response.status >= 300 && response.status < 400) {
    throw new HttpJsonV1Error('redirect_rejected', 'supplier_redirect_rejected', response.status)
  }
  if (response.status < 200 || response.status >= 300) {
    throw new HttpJsonV1Error('http_unknown', `supplier_http_${response.status || 'unknown'}`, response.status || null)
  }
  if (!response.contentType.startsWith('application/json')) {
    throw new HttpJsonV1Error('response_invalid', 'supplier_content_type_invalid', response.status)
  }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)) as unknown }
  catch { throw new HttpJsonV1Error('response_invalid', 'supplier_json_invalid', response.status) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpJsonV1Error('response_invalid', 'supplier_json_shape_invalid', response.status)
  }
  return value as Record<string, unknown>
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength
    || containsAsciiControl(value)) return null
  return value
}

function validateIdentity(row: Record<string, unknown>, request: HttpJsonV1DeliveryRequest): void {
  if (row.protocol !== 'http_json_v1' || row.operationId !== request.operationId
    || row.idempotencyKey !== request.idempotencyKey || row.productId !== request.productId
    || row.quantity !== 1 || row.unitAmount !== request.unitAmount || row.currency !== 'CNY') {
    throw new HttpJsonV1Error('identity_mismatch', 'supplier_identity_mismatch')
  }
}

function normalizeResult(value: unknown): ApiDeliveryResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpJsonV1Error('result_invalid', 'supplier_result_invalid')
  }
  const result = value as Record<string, unknown>
  const type = result.type
  if (!['code', 'text', 'redemption', 'link', 'completed'].includes(String(type))) {
    throw new HttpJsonV1Error('result_invalid', 'supplier_result_type_invalid')
  }
  if (type === 'completed') {
    if (result.content !== undefined && result.content !== null) throw new HttpJsonV1Error('result_invalid', 'supplier_result_content_invalid')
    return { type: 'completed', content: null, title: null, instructions: null }
  }
  const content = safeText(result.content, type === 'code' ? 1024 : 20_000)
  if (!content || Buffer.byteLength(content, 'utf8') > 20_000) {
    throw new HttpJsonV1Error('result_invalid', 'supplier_result_content_invalid')
  }
  const title = result.title === undefined || result.title === null ? null : safeText(result.title, 160)
  const instructions = result.instructions === undefined || result.instructions === null
    ? null : safeText(result.instructions, 4_000)
  if ((result.title !== undefined && result.title !== null && !title)
    || (result.instructions !== undefined && result.instructions !== null && !instructions)) {
    throw new HttpJsonV1Error('result_invalid', 'supplier_result_metadata_invalid')
  }
  if (type === 'link') {
    let link: URL
    try { link = new URL(content) } catch { throw new HttpJsonV1Error('result_invalid', 'supplier_result_link_invalid') }
    if (link.protocol !== 'https:' || link.username || link.password || link.href !== content
      || [...content].some(character => character.codePointAt(0)! <= 0x20)) {
      throw new HttpJsonV1Error('result_invalid', 'supplier_result_link_invalid')
    }
  }
  const resultPayload = { type, content, title, instructions }
  if (Buffer.byteLength(JSON.stringify(resultPayload), 'utf8') > maxResponseBytes) {
    throw new HttpJsonV1Error('result_invalid', 'supplier_result_too_large')
  }
  return resultPayload as ApiDeliveryResult
}

function normalizeOutcome(
  row: Record<string, unknown>,
  response: WireResponse,
  request: HttpJsonV1DeliveryRequest,
): HttpJsonV1Outcome {
  validateIdentity(row, request)
  const status = row.status
  const rawProviderId = row.supplierOperationId
  const providerOperationId = rawProviderId === null ? null : safeText(rawProviderId, 200)
  if (rawProviderId !== null && !providerOperationId) {
    throw new HttpJsonV1Error('identity_mismatch', 'supplier_operation_id_invalid', response.status)
  }
  if (status === 'not_found') {
    if (providerOperationId || row.result !== null && row.result !== undefined) {
      throw new HttpJsonV1Error('identity_mismatch', 'supplier_not_found_shape_invalid', response.status)
    }
    return { kind: 'not_found', responseSha256: response.sha256, httpStatus: response.status }
  }
  if (status === 'accepted' || status === 'processing') {
    if (!providerOperationId || (row.result !== null && row.result !== undefined)) {
      throw new HttpJsonV1Error('identity_mismatch', 'supplier_processing_shape_invalid', response.status)
    }
    return { kind: 'processing', providerOperationId, status, responseSha256: response.sha256, httpStatus: response.status }
  }
  if (status === 'succeeded') {
    if (!providerOperationId) throw new HttpJsonV1Error('identity_mismatch', 'supplier_operation_id_missing', response.status)
    if (row.error !== null && row.error !== undefined) throw new HttpJsonV1Error('identity_mismatch', 'supplier_success_shape_invalid', response.status)
    return {
      kind: 'succeeded', providerOperationId, result: normalizeResult(row.result),
      responseSha256: response.sha256, httpStatus: response.status,
    }
  }
  if (status === 'rejected') {
    const error = row.error && typeof row.error === 'object' && !Array.isArray(row.error)
      ? row.error as Record<string, unknown> : null
    const code = error ? safeText(error.code, 64) : null
    if (!code || (row.result !== null && row.result !== undefined)) {
      throw new HttpJsonV1Error('identity_mismatch', 'supplier_rejection_shape_invalid', response.status)
    }
    return { kind: 'rejected', code, responseSha256: response.sha256, httpStatus: response.status }
  }
  throw new HttpJsonV1Error('response_invalid', 'supplier_status_invalid', response.status)
}

function prepareBase(supplier: HttpJsonV1Supplier, config: AppConfig): URL {
  if (!/^[A-Za-z0-9._~+/-]+={0,}$/u.test(supplier.bearerToken) || supplier.bearerToken.length > 2048) {
    throw new HttpJsonV1Error('response_invalid', 'supplier_credential_invalid')
  }
  return validateSupplierBaseUrl(supplier.baseUrl, config)
}

export async function createHttpJsonV1Delivery(
  config: AppConfig,
  supplier: HttpJsonV1Supplier,
  request: HttpJsonV1DeliveryRequest,
): Promise<HttpJsonV1Outcome> {
  const base = prepareBase(supplier, config)
  const wire = await requestWire(config, supplier, appendPath(base, '/deliveries'), 'POST', {
    protocol: 'http_json_v1',
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    productId: request.productId,
    quantity: 1,
    unitAmount: request.unitAmount,
    currency: 'CNY',
    parameters: request.parameters,
  })
  return normalizeOutcome(parseJson(wire), wire, request)
}

export async function queryHttpJsonV1Delivery(
  config: AppConfig,
  supplier: HttpJsonV1Supplier,
  request: HttpJsonV1DeliveryRequest,
  providerOperationId: string | null,
): Promise<HttpJsonV1Outcome> {
  const base = prepareBase(supplier, config)
  const suffix = providerOperationId
    ? `/deliveries/${encodeURIComponent(providerOperationId)}`
    : `/deliveries/by-idempotency/${encodeURIComponent(request.idempotencyKey)}`
  const wire = await requestWire(config, supplier, appendPath(base, suffix), 'GET')
  return normalizeOutcome(parseJson(wire), wire, request)
}

export async function testHttpJsonV1Connection(
  config: AppConfig,
  supplier: HttpJsonV1Supplier,
): Promise<{ connectionOk: boolean; queryCapable: boolean }> {
  const base = prepareBase(supplier, config)
  const wire = await requestWire(config, supplier, appendPath(base, '/capabilities'), 'GET')
  const capabilities = parseJson(wire)
  if (capabilities.protocol !== 'http_json_v1' || capabilities.idempotencyGuaranteed !== true
    || capabilities.statusQueryByIdempotency !== true || capabilities.statusQueryBySupplierOperationId !== true) {
    throw new HttpJsonV1Error('capability_missing', 'supplier_capabilities_missing', wire.status)
  }
  const operationId = '00000000-0000-4000-8000-000000000001'
  const probe: HttpJsonV1DeliveryRequest = {
    operationId,
    idempotencyKey: `aikayun:${operationId}`,
    productId: 'capability-probe',
    unitAmount: '0.00',
    parameters: {},
  }
  const query = await queryHttpJsonV1Delivery(config, supplier, probe, null)
  if (query.kind !== 'not_found') throw new HttpJsonV1Error('capability_missing', 'supplier_query_probe_invalid')
  const operationQuery = await queryHttpJsonV1Delivery(config, supplier, probe, 'capability-probe-operation')
  if (operationQuery.kind !== 'not_found') throw new HttpJsonV1Error('capability_missing', 'supplier_operation_query_probe_invalid')
  return { connectionOk: true, queryCapable: true }
}
