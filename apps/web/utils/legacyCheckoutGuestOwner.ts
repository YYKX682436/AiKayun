// Legacy v1 keys keep their original storage name and request body. New keys
// add a separate owner receipt; old keys without one retain their old behavior.
const storageKey = 'aikayun-order-intent-guest-owners-v1'
const capacity = 5000
type Binding = { idempotencyKey: string; ownerId: string }

function read(): Binding[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]')
    if (!Array.isArray(parsed) || parsed.length > capacity) throw new Error('invalid')
    const seen = new Set<string>()
    for (const item of parsed) {
      if (!item || typeof item !== 'object'
        || Object.keys(item).some(key => !['idempotencyKey', 'ownerId'].includes(key))
        || typeof item.idempotencyKey !== 'string' || !/^[0-9a-f-]{36}$/iu.test(item.idempotencyKey)
        || typeof item.ownerId !== 'string' || !/^guest:[0-9a-f-]{36}$/iu.test(item.ownerId)
        || seen.has(item.idempotencyKey)) throw new Error('invalid')
      seen.add(item.idempotencyKey)
    }
    return parsed as Binding[]
  } catch {
    throw new Error('浏览器无法安全读取原游客订单归属，请保留当前页面并检查会话存储。')
  }
}

function write(bindings: Binding[]): void {
  try {
    const raw = JSON.stringify(bindings)
    sessionStorage.setItem(storageKey, raw)
    if (sessionStorage.getItem(storageKey) !== raw) throw new Error('changed')
  } catch {
    throw new Error('浏览器无法安全保存游客订单归属，本次订单尚未发送。')
  }
}

export function legacyGuestOrderOwner(idempotencyKey: string): string | null {
  return read().find(binding => binding.idempotencyKey === idempotencyKey)?.ownerId ?? null
}

export function bindNewLegacyGuestOrder(idempotencyKey: string, ownerId: string): void {
  const bindings = read()
  const previous = bindings.find(binding => binding.idempotencyKey === idempotencyKey)
  if (previous) {
    if (previous.ownerId !== ownerId) throw new Error('原游客订单归属已变化，请在原会话核对结果。')
    return
  }
  if (bindings.length >= capacity) throw new Error('浏览器保存的未确认游客订单已达容量，请先核对已有订单。')
  write([...bindings, { idempotencyKey, ownerId }])
}

export function forgetCompletedLegacyGuestOrder(idempotencyKey: string): void {
  write(read().filter(binding => binding.idempotencyKey !== idempotencyKey))
}
