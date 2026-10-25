import type { CheckoutRequestLineV2 } from '@aikayun/contracts'
import { isTerminalSelectionId, readSharedSelectionById, readSharedSelectionId } from './checkoutOrderIntent'

const selectionStorageKey = 'aikayun-checkout-selections-v2'

type StoredSelection = {
  id: string
  fingerprint: string
  items: CheckoutRequestLineV2[]
}

function selectionFingerprint(items: CheckoutRequestLineV2[]): string {
  return JSON.stringify(items.map(item => ({ ...item })).sort((left, right) => left.lineId.localeCompare(right.lineId)))
}

function readSelections(): StoredSelection[] {
  const raw = sessionStorage.getItem(selectionStorageKey)
  if (!raw) return []
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed) || parsed.length > 100 || parsed.some(item => !item || typeof item !== 'object'
    || typeof item.id !== 'string' || typeof item.fingerprint !== 'string' || !Array.isArray(item.items))) {
    throw new Error('本机结算选择记录无效，请重新从购物车进入。')
  }
  return parsed as StoredSelection[]
}

export function saveCheckoutSelection(items: CheckoutRequestLineV2[]): string {
  if (!import.meta.client) return '/cart'
  const sharedId = readSharedSelectionId(items)
  if (sharedId) return `/checkout?intent=${encodeURIComponent(sharedId)}`
  const fingerprint = selectionFingerprint(items)
  const selections = readSelections()
  const latest = [...selections].reverse().find(item => item.fingerprint === fingerprint)
  if (latest && !isTerminalSelectionId(latest.id)) return `/checkout?intent=${encodeURIComponent(latest.id)}`
  const id = crypto.randomUUID()
  const next = [...selections.slice(-99), { id, fingerprint, items: items.map(item => ({ ...item })) }]
  sessionStorage.setItem(selectionStorageKey, JSON.stringify(next))
  return `/checkout?intent=${encodeURIComponent(id)}`
}

/** Create a new opaque selection after an explicit ownership transition. */
export function saveFreshCheckoutSelection(items: CheckoutRequestLineV2[]): string {
  if (!import.meta.client) return '/cart'
  const fingerprint = selectionFingerprint(items)
  const selections = readSelections()
  const id = crypto.randomUUID()
  sessionStorage.setItem(selectionStorageKey, JSON.stringify([
    ...selections.slice(-99), { id, fingerprint, items: items.map(item => ({ ...item })) },
  ]))
  return `/checkout?intent=${encodeURIComponent(id)}`
}

export function loadCheckoutSelection(id: string): CheckoutRequestLineV2[] | null {
  if (!import.meta.client || !/^[0-9a-f-]{36}$/iu.test(id)) return null
  const selection = readSelections().find(item => item.id === id)
  return selection?.items.map(item => ({ ...item })) ?? readSharedSelectionById(id)
}
