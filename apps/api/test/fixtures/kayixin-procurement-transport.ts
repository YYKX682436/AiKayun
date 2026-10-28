import { parseKayixinDetailIdentity } from '../../src/commerce/kayixin-procurement-protocol.js'
import { createHash } from 'node:crypto'
import { signKayixinV3, type KayixinV3Supplier } from '../../src/commerce/kayixin-customer-v3.js'
import type { ProcurementFixtureRequest, ProcurementFixtureResult, ProcurementFixtureTransport } from '../../src/commerce/procurement-executor.js'

/** Offline protocol exercise only: no production transport, credential lookup, or eligibility switch. */
export type KayixinFixtureWire = (request: { path: '/api/v3/order/getDetail'; headers: Record<string, string>; body: string }) => Promise<{ status: number; body: string }>

const validIdentity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && ![...value].some(char => { const code = char.codePointAt(0)!; return code < 32 || code === 127 })

/** The fixture explicitly binds an operation to its test outerNumber; local identity alone is not proof of that mapping. */
export function createKayixinProcurementFixtureTransport(options: {
  supplier: KayixinV3Supplier; wire: KayixinFixtureWire; timestamp: () => string;
  outerNumberForOperation: (operationId: string, requestIdentity: string) => string | null;
}): ProcurementFixtureTransport {
  return async (request: ProcurementFixtureRequest): Promise<ProcurementFixtureResult> => {
    const unknown = (digest = '0'.repeat(64)): ProcurementFixtureResult => ({ requestIdentity: request.requestIdentity, kind: 'unknown', supplierOrderNumber: null, responseDigest: digest })
    // All real create semantics remain unverified. Do not issue a purchase request.
    if (request.action === 'submit') return unknown()
    const outerNumber = options.outerNumberForOperation(request.operationId, request.requestIdentity)
    if (!validIdentity(outerNumber) || (request.supplierOrderNumber !== null && !validIdentity(request.supplierOrderNumber))) return unknown()
    const { appId, appSecret } = options.supplier
    const timestamp = options.timestamp()
    if (!/^[0-9]{1,32}$/u.test(appId) || !/^[!-~]{1,512}$/u.test(appSecret) || !/^\d{10}$/u.test(timestamp)) return unknown()
    const body = JSON.stringify(request.supplierOrderNumber ? { orderNumber: request.supplierOrderNumber } : { outerNumber })
    try {
      const response = await options.wire({ path: '/api/v3/order/getDetail', body, headers: {
        'X-APP-ID': appId, 'X-Version': '3.0', 'X-Timestamp': timestamp,
        'X-Signature': signKayixinV3(appId, appSecret, timestamp, body),
      } })
      if (typeof response.body !== 'string' || Buffer.byteLength(response.body) > 1024 * 1024) return unknown()
      const digest = createHash('sha256').update(response.body, 'utf8').digest('hex')
      if (response.status !== 200) return unknown(digest)
      const parsed = parseKayixinDetailIdentity(response.body, outerNumber, request.supplierOrderNumber)
      if (parsed.kind === 'identity_conflict') return { ...unknown(digest), identityConflict: true }
      if (parsed.kind !== 'identified') return unknown(digest)
      return { requestIdentity: request.requestIdentity, kind: 'unknown', supplierOrderNumber: parsed.orderNumber, responseDigest: digest }
    } catch { return unknown() }
  }
}
