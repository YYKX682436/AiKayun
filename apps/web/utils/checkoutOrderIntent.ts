import type { CheckoutRequestLineV2 } from '@aikayun/contracts'

const storageKey = 'aikayun-order-intents-v2'
const storageLockName = 'aikayun:order-intents:v2'
const submissionLockName = 'aikayun:order-submission:v2'
const maxStoredIntents = 5000

export type PendingOrderIntentV2 = {
  state: 'pending' | 'rejected'
  ownerId: string
  fingerprint: string
  selectionId: string | null
  selectionAliases?: string[]
  idempotencyKey: string
  quoteToken: string
  items: CheckoutRequestLineV2[]
}

export type CompletedOrderIntentV2 = {
  state: 'completed'
  ownerId: string
  fingerprint: string
  selectionId: string | null
  selectionAliases?: string[]
  idempotencyKey: string
  orderId: string
}

export type OrderIntentV2 = PendingOrderIntentV2 | CompletedOrderIntentV2

export class PendingOwnerConflictError extends Error {
  constructor() {
    super('这份结算选择已有其他账户或游客会话的未确认订单。请先在原身份核对结果。')
    this.name = 'PendingOwnerConflictError'
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function validOwnerId(value: unknown): value is string {
  return isUuid(value) || (typeof value === 'string' && value.startsWith('guest:') && isUuid(value.slice(6)))
}

export function v2SelectionFingerprint(items: CheckoutRequestLineV2[]): string {
  return JSON.stringify(items.map(item => ({ ...item })).sort((left, right) => left.lineId.localeCompare(right.lineId)))
}

function validItems(value: unknown): value is CheckoutRequestLineV2[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) return false
  const lineIds = new Set<string>()
  const skuTotals = new Map<string, number>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || !isUuid(item.lineId) || lineIds.has(item.lineId)
      || !isUuid(item.skuId) || !Number.isSafeInteger(item.quantity)
      || item.quantity < 1 || item.quantity > 99) return false
    const hasDraftId = Object.hasOwn(item, 'draftId')
    const hasDraftRevision = Object.hasOwn(item, 'draftRevision')
    if (hasDraftId !== hasDraftRevision) return false
    if (hasDraftId && (item.draftId !== null || item.draftRevision !== null)
      && (!isUuid(item.draftId) || !Number.isSafeInteger(item.draftRevision)
        || item.draftRevision < 1)) return false
    if (Object.keys(item).some(key => !['lineId', 'skuId', 'quantity', 'draftId', 'draftRevision'].includes(key))) return false
    const total = (skuTotals.get(item.skuId) ?? 0) + item.quantity
    if (total > 99) return false
    skuTotals.set(item.skuId, total)
    lineIds.add(item.lineId)
  }
  return true
}

function parseIntents(raw: string | null, legacySession = false): OrderIntentV2[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.length > maxStoredIntents) throw new Error('invalid')
    const pendingFingerprints = new Set<string>()
    const keys = new Set<string>()
    const selectionIds = new Set<string>()
    const result: OrderIntentV2[] = []
    for (const candidate of parsed) {
      if (!candidate || typeof candidate !== 'object') throw new Error('invalid')
      const value = candidate as Record<string, unknown>
      const state = legacySession && value.state === undefined ? 'pending' : value.state
      if (!['pending', 'rejected', 'completed'].includes(String(state))
        || !validOwnerId(value.ownerId) || !isUuid(value.idempotencyKey)
        || typeof value.fingerprint !== 'string' || value.fingerprint.length > 16000
        || (value.selectionId !== undefined && value.selectionId !== null && !isUuid(value.selectionId))
        || (state === 'pending' && pendingFingerprints.has(value.fingerprint))
        || keys.has(value.idempotencyKey)
        || (typeof value.selectionId === 'string' && selectionIds.has(value.selectionId))
        || (value.selectionAliases !== undefined
          && (!Array.isArray(value.selectionAliases) || value.selectionAliases.length > 100
            || value.selectionAliases.some(alias => !isUuid(alias) || selectionIds.has(alias))))) throw new Error('invalid')
      const selectionId = value.selectionId === undefined ? null : value.selectionId as string | null
      const selectionAliases = value.selectionAliases as string[] | undefined
      if (selectionAliases && (new Set(selectionAliases).size !== selectionAliases.length
        || (selectionId !== null && selectionAliases.includes(selectionId)))) throw new Error('invalid')
      if (state === 'completed') {
        if (!isUuid(value.orderId)) throw new Error('invalid')
        result.push({ state, ownerId: value.ownerId, fingerprint: value.fingerprint,
          selectionId, ...(selectionAliases ? { selectionAliases } : {}),
          idempotencyKey: value.idempotencyKey, orderId: value.orderId })
      } else {
        if (typeof value.quoteToken !== 'string' || !/^[0-9a-f]{64}$/u.test(value.quoteToken)
          || !validItems(value.items) || v2SelectionFingerprint(value.items) !== value.fingerprint) throw new Error('invalid')
        result.push({ state: state as 'pending' | 'rejected', ownerId: value.ownerId,
          fingerprint: value.fingerprint, selectionId,
          ...(selectionAliases ? { selectionAliases } : {}), idempotencyKey: value.idempotencyKey,
          quoteToken: value.quoteToken, items: value.items })
      }
      if (state === 'pending') pendingFingerprints.add(value.fingerprint)
      if (selectionId) selectionIds.add(selectionId)
      for (const alias of selectionAliases ?? []) selectionIds.add(alias)
      keys.add(value.idempotencyKey)
    }
    return result
  } catch {
    throw new Error('本机保存的原订单请求无效；请先核对订单历史，避免重复下单。')
  }
}

function readLocal(): { raw: string | null; intents: OrderIntentV2[] } {
  let raw: string | null
  try {
    raw = localStorage.getItem(storageKey)
  } catch {
    throw new Error('浏览器暂时无法读取原订单请求，请启用本地存储后重试。')
  }
  return { raw, intents: parseIntents(raw) }
}

function writeLocal(rawBefore: string | null, intents: OrderIntentV2[]): void {
  if (intents.length > maxStoredIntents) throw new Error('本机有过多未确认的订单记录，请先核对订单历史。')
  const nextRaw = JSON.stringify(intents)
  try {
    if (localStorage.getItem(storageKey) !== rawBefore) throw new Error('changed')
    localStorage.setItem(storageKey, nextRaw)
    if (localStorage.getItem(storageKey) !== nextRaw) throw new Error('changed')
  } catch {
    throw new Error('浏览器暂时无法安全保存原订单请求，本次订单尚未发送。')
  }
}

async function withStorageLock<T>(operation: () => T): Promise<T> {
  if (!import.meta.client || !navigator.locks) {
    throw new Error('当前浏览器不支持安全的跨标签订单恢复。')
  }
  return navigator.locks.request(storageLockName, { mode: 'exclusive' }, operation)
}

export async function withOrderSubmissionLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!import.meta.client || !navigator.locks) {
    throw new Error('当前浏览器不支持安全的跨标签订单恢复。')
  }
  return navigator.locks.request(submissionLockName, { mode: 'exclusive' }, operation)
}

function readMigrated(): { raw: string | null; intents: OrderIntentV2[] } {
  const local = readLocal()
  let oldRaw: string | null
  try {
    oldRaw = sessionStorage.getItem(storageKey)
  } catch {
    throw new Error('浏览器暂时无法读取旧订单请求，请核对订单历史。')
  }
  if (!oldRaw) return local
  const oldIntents = parseIntents(oldRaw, true)
  const next = [...local.intents]
  let changed = false
  for (const oldIntent of oldIntents) {
    const existing = next.find(item => item.idempotencyKey === oldIntent.idempotencyKey)
    if (!existing) {
      if (next.some(item => item.state === 'pending' && item.fingerprint === oldIntent.fingerprint)) {
        throw new Error('本机订单恢复记录存在冲突；请先核对订单历史。')
      }
      next.push(oldIntent)
      changed = true
    } else if (existing.ownerId !== oldIntent.ownerId
      || existing.fingerprint !== oldIntent.fingerprint
      || existing.idempotencyKey !== oldIntent.idempotencyKey) {
      throw new Error('本机订单恢复记录存在冲突；请先核对订单历史。')
    }
  }
  if (changed) writeLocal(local.raw, next)
  // The old tab-local request is removed only after the shared copy is durable.
  try {
    if (sessionStorage.getItem(storageKey) === oldRaw) sessionStorage.removeItem(storageKey)
  } catch { /* A matching shared copy is already durable. */ }
  return changed ? readLocal() : local
}

function exactIntent(intents: OrderIntentV2[], selectionId: string | null): OrderIntentV2 | null {
  return selectionId ? intents.find(intent => intent.selectionId === selectionId
    || intent.selectionAliases?.includes(selectionId)) ?? null : null
}

function checkOwner(intent: OrderIntentV2 | null, ownerId: string): OrderIntentV2 | null {
  if (intent && intent.ownerId !== ownerId) throw new PendingOwnerConflictError()
  return intent
}

function attachSelectionId(
  raw: string | null, intents: OrderIntentV2[], intent: PendingOrderIntentV2, selectionId: string | null,
  rejected: PendingOrderIntentV2 | null = null,
): PendingOrderIntentV2 {
  const ids = [...new Set([
    intent.selectionId, ...(intent.selectionAliases ?? []),
    rejected?.selectionId, ...(rejected?.selectionAliases ?? []), selectionId,
  ].filter(isUuid))]
  for (const id of ids) {
    const existing = exactIntent(intents, id)
    if (existing && existing !== intent && existing !== rejected) {
      throw new Error('结算选择身份已被占用，请返回购物车重试。')
    }
  }
  const primary = intent.selectionId ?? ids[0] ?? null
  const aliases = ids.filter(id => id !== primary)
  if (aliases.length > 100) throw new Error('原订单请求关联过多结算链接，请先核对订单历史。')
  if (!rejected && primary === intent.selectionId
    && JSON.stringify(aliases) === JSON.stringify(intent.selectionAliases ?? [])) return intent
  const updated: PendingOrderIntentV2 = {
    ...intent, selectionId: primary, selectionAliases: aliases,
  }
  // Rejoining a durable pending request transfers every old URL in the same
  // storage write. Its original key, quote and request body remain intact.
  writeLocal(raw, intents.filter(item => item !== rejected).map(item => item === intent ? updated : item))
  return updated
}

export async function findOrderIntentV2(
  items: CheckoutRequestLineV2[], ownerId: string, selectionId: string | null,
): Promise<OrderIntentV2 | null> {
  return withStorageLock(() => {
    const { raw, intents } = readMigrated()
    const fingerprint = v2SelectionFingerprint(items)
    const exact = checkOwner(exactIntent(intents, selectionId), ownerId)
    if (exact) {
      if (exact.fingerprint !== fingerprint) throw new Error('结算选择已变化，请返回购物车重新选择。')
      return exact
    }
    const pending = checkOwner(intents.find(intent => intent.state === 'pending'
      && intent.fingerprint === fingerprint) ?? null, ownerId)
    return pending?.state === 'pending'
      ? attachSelectionId(raw, intents, pending, selectionId)
      : null
  })
}

export async function findOrderIntentBySelectionId(selectionId: string, ownerId: string): Promise<OrderIntentV2 | null> {
  if (!isUuid(selectionId)) return null
  return withStorageLock(() => {
    return checkOwner(exactIntent(readMigrated().intents, selectionId), ownerId)
  })
}

/** Inspect the exact opaque selection without changing or adopting its owner. */
export async function findAnyOrderIntentBySelectionId(selectionId: string): Promise<OrderIntentV2 | null> {
  if (!isUuid(selectionId)) return null
  return withStorageLock(() => exactIntent(readMigrated().intents, selectionId))
}

export async function prepareOrderIntentV2(
  items: CheckoutRequestLineV2[], ownerId: string, quoteToken: string, selectionId: string | null,
): Promise<PendingOrderIntentV2 | CompletedOrderIntentV2> {
  return withStorageLock(() => {
    const { raw, intents } = readMigrated()
    const fingerprint = v2SelectionFingerprint(items)
    const exact = checkOwner(exactIntent(intents, selectionId), ownerId)
    if (exact && exact.fingerprint !== fingerprint) throw new Error('结算选择已变化，请返回购物车重新选择。')
    if (exact?.state === 'completed') return exact
    const pending = checkOwner(intents.find(intent => intent.state === 'pending'
      && intent.fingerprint === fingerprint) ?? null, ownerId)
    if (pending?.state === 'pending') {
      return attachSelectionId(raw, intents, pending, selectionId, exact?.state === 'rejected' ? exact : null)
    }
    if (exact?.state === 'rejected' && exact.quoteToken === quoteToken) {
      throw new Error('原报价已被拒绝，请重新报价后再次确认。')
    }
    const pendingCount = intents.filter(intent => intent.state === 'pending').length
    if (pendingCount >= 50) throw new Error('本机有过多未确认的订单请求，请先核对订单历史。')
    const intent: PendingOrderIntentV2 = {
      state: 'pending', ownerId, fingerprint,
      selectionId: exact?.state === 'rejected' ? exact.selectionId : isUuid(selectionId) ? selectionId : null,
      ...(exact?.state === 'rejected' && exact.selectionAliases ? { selectionAliases: [...exact.selectionAliases] } : {}),
      idempotencyKey: crypto.randomUUID(), quoteToken,
      items: items.map(item => ({ ...item })).sort((left, right) => left.lineId.localeCompare(right.lineId)),
    }
    writeLocal(raw, exact?.state === 'rejected'
      ? intents.map(item => item === exact ? intent : item)
      : [...intents, intent])
    return intent
  })
}

export async function completeOrderIntentV2(intent: PendingOrderIntentV2, orderId: string): Promise<CompletedOrderIntentV2> {
  if (!isUuid(orderId)) throw new Error('服务器返回的订单身份无效。')
  return withStorageLock(() => {
    const { raw, intents } = readMigrated()
    const existing = intents.find(item => item.idempotencyKey === intent.idempotencyKey)
    if (!existing || existing.fingerprint !== intent.fingerprint || existing.ownerId !== intent.ownerId) {
      throw new Error('原订单请求记录已变化，请先核对订单历史。')
    }
    if (existing.state === 'completed') {
      if (existing.orderId !== orderId) throw new Error('原订单确认结果不一致，请核对订单历史。')
      return existing
    }
    const completed: CompletedOrderIntentV2 = {
      state: 'completed', ownerId: intent.ownerId, fingerprint: intent.fingerprint,
      selectionId: existing.selectionId,
      ...(existing.selectionAliases ? { selectionAliases: existing.selectionAliases } : {}),
      idempotencyKey: intent.idempotencyKey, orderId,
    }
    writeLocal(raw, intents.map(item => item === existing ? completed : item))
    return completed
  })
}

export async function rejectOrderIntentV2(intent: PendingOrderIntentV2): Promise<CompletedOrderIntentV2 | null> {
  return withStorageLock(() => {
    const { raw, intents } = readMigrated()
    const existing = intents.find(item => item.idempotencyKey === intent.idempotencyKey)
    if (!existing || existing.fingerprint !== intent.fingerprint || existing.ownerId !== intent.ownerId) {
      throw new Error('原订单请求记录已变化，请先核对订单历史。')
    }
    if (existing.state === 'completed') return existing
    if (existing.state === 'rejected') return null
    writeLocal(raw, intents.map(item => item === existing ? { ...existing, state: 'rejected' } : item))
    return null
  })
}

// The checkout URL contains only this opaque UUID. A fresh tab can recover its
// original line references after a POST has been durably staged in localStorage.
export function readSharedSelectionById(selectionId: string): CheckoutRequestLineV2[] | null {
  if (!import.meta.client || !isUuid(selectionId)) return null
  const intent = exactIntent(readLocal().intents, selectionId)
  return intent && intent.state !== 'completed' ? intent.items.map(item => ({ ...item })) : null
}

export function readSharedSelectionId(items: CheckoutRequestLineV2[]): string | null {
  if (!import.meta.client) return null
  const intent = readLocal().intents.find(item => item.state === 'pending'
    && item.fingerprint === v2SelectionFingerprint(items))
  return intent?.selectionId ?? null
}

export function isTerminalSelectionId(selectionId: string): boolean {
  if (!import.meta.client || !isUuid(selectionId)) return false
  const intent = exactIntent(readLocal().intents, selectionId)
  return intent !== null && intent.state !== 'pending'
}

export function hasOrderIntentV2(items: CheckoutRequestLineV2[] | null, selectionId: string | null): boolean {
  if (!import.meta.client) return false
  const fingerprint = items ? v2SelectionFingerprint(items) : null
  const matches = (intents: OrderIntentV2[]) => intents.some(intent =>
    (selectionId !== null && (intent.selectionId === selectionId || intent.selectionAliases?.includes(selectionId)))
    || (fingerprint !== null && intent.state === 'pending' && intent.fingerprint === fingerprint))
  if (matches(readLocal().intents)) return true
  try {
    return matches(parseIntents(sessionStorage.getItem(storageKey), true))
  } catch {
    throw new Error('浏览器暂时无法读取旧订单请求，请核对订单历史。')
  }
}
