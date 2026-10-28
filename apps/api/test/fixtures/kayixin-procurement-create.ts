const validIdentity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && ![...value].some(char => { const code = char.codePointAt(0)!; return code < 32 || code === 127 })

/** Synthetic shape for isolated protocol tests only. These bounds are fixture rules, not merchant guarantees.
 * No mapping, SKU, quantity, currency, amount, image or safePrice semantics are authorized by this encoder. */
export function encodeFixtureCreate(input: { goodsId: number; count: number; notifyUrl: string; outerNumber: string; safePrice: string; sku: string; attach: Array<{ name: string; value: string }> }): string {
  if (!Number.isSafeInteger(input.goodsId) || input.goodsId <= 0 || !Number.isSafeInteger(input.count) || input.count <= 0
    || !validIdentity(input.outerNumber) || typeof input.notifyUrl !== 'string' || input.notifyUrl.length > 2048
    || !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/u.test(input.safePrice)
    || typeof input.sku !== 'string' || input.sku.length > 200 || !Array.isArray(input.attach) || input.attach.length > 50
    || input.attach.some(item => !item || !validIdentity(item.name) || typeof item.value !== 'string' || item.value.length > 2000)
    || new Set(input.attach.map(item => item.name)).size !== input.attach.length) throw new Error('fixture_create_invalid')
  return JSON.stringify({ goodsId: input.goodsId, count: input.count, notifyUrl: input.notifyUrl, outerNumber: input.outerNumber,
    safePrice: input.safePrice, sku: input.sku, attach: input.attach })
}


