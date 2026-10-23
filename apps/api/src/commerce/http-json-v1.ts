import type { AppConfig } from '../config.js'
import type { ApiDeliveryResult } from './supplier-api-crypto.js'
import { SupplierHttpError as HttpJsonV1Error, containsAsciiControl, validateSupplierBaseUrl,
  appendPath, requestSupplierWire, parseSupplierJson as parseJson, type WireResponse } from './supplier-http.js'
// Retain public imports and the error identity used by existing delivery recovery.
export { SupplierHttpError as HttpJsonV1Error, isPublicAddress, resolvePinnedAddress, validateSupplierBaseUrl } from './supplier-http.js'
export type { SupplierErrorClass } from './supplier-http.js'
const maxResponseBytes = 64 * 1024
const maxRequestBytes = 16 * 1024

async function requestWire(config: AppConfig, supplier: HttpJsonV1Supplier, target: URL, method: 'GET' | 'POST', body?: unknown): Promise<WireResponse> {
  const encodedBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  return await requestSupplierWire(config, target, method, { authorization: `Bearer ${supplier.bearerToken}` }, encodedBody,
    { maxRequestBytes, maxResponseBytes })
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
  query?: { providerOperationId: string | null },
): HttpJsonV1Outcome {
  // A never-submitted operation has no product/price record at the supplier.
  // Its negative lookup must bind to the queried key, not invent that record.
  // Bare 404s and contradictory identities remain unknown/integrity failures.
  if (query && row.status === 'not_found') {
    const keyMatches = row.operationId === request.operationId && row.idempotencyKey === request.idempotencyKey
    const providerMatches = query.providerOperationId !== null
      && row.queriedSupplierOperationId === query.providerOperationId
    const expected = { operationId: request.operationId, idempotencyKey: request.idempotencyKey,
      productId: request.productId, quantity: 1, unitAmount: request.unitAmount, currency: 'CNY' }
    if (row.protocol !== 'http_json_v1' || (!keyMatches && !providerMatches)
      || row.supplierOperationId !== null || row.result !== null
      || Object.entries(expected).some(([name, value]) => row[name] !== undefined && row[name] !== value)) {
      throw new HttpJsonV1Error('identity_mismatch', 'supplier_not_found_shape_invalid', response.status)
    }
    return { kind: 'not_found', responseSha256: response.sha256, httpStatus: response.status }
  }
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
  return normalizeOutcome(parseJson(wire), wire, request, { providerOperationId })
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
