// Pure protocol construction; this module cannot send requests or grant procurement eligibility.
const validIdentity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && ![...value].some(char => { const code = char.codePointAt(0)!; return code < 32 || code === 127 })

/** Parse only identity. Status, amounts and cards are intentionally not given business meaning. */
export function parseKayixinDetailIdentity(body: string, outerNumber: string, expectedOrderNumber: string | null):
  { kind: 'identified'; orderNumber: string } | { kind: 'identity_conflict' } | { kind: 'unknown' } {
  if (!validIdentity(outerNumber) || (expectedOrderNumber !== null && !validIdentity(expectedOrderNumber))
    || Buffer.byteLength(body) > 1024 * 1024) return { kind: 'unknown' }
  try {
    const envelope: unknown = JSON.parse(body)
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { kind: 'unknown' }
    const row = envelope as Record<string, unknown>
    if (row.code !== 1000 || typeof row.msg !== 'string' || !row.data || typeof row.data !== 'object' || Array.isArray(row.data)) return { kind: 'unknown' }
    const data = row.data as Record<string, unknown>
    if ((validIdentity(data.outerNumber) && data.outerNumber !== outerNumber)
      || (validIdentity(data.orderNumber) && expectedOrderNumber !== null && data.orderNumber !== expectedOrderNumber)) return { kind: 'identity_conflict' }
    if (data.outerNumber !== outerNumber || !validIdentity(data.orderNumber)) return { kind: 'unknown' }
    return { kind: 'identified', orderNumber: data.orderNumber }
  } catch { return { kind: 'unknown' } }
}
