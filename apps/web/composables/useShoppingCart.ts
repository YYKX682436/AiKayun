import type {
  CartSkuQuantity,
  CheckoutQuote,
  CustomerCart,
  CustomerCartMergeBody,
  CustomerCartMutation,
} from '@aikayun/contracts'
import { CustomerApiError, useCustomerApi } from './useCustomerApi'

const storageKey = 'aikayun-guest-cart-v1'
const maxLineQuantity = 99
const maxCartLines = 50

type GuestCartEnvelope = {
  version: 1
  mergeId: string
  items: CartSkuQuantity[]
}

type GuestCartSnapshot = GuestCartEnvelope & {
  raw: string | null
  revision: number
}

type CartScope = {
  identityVersion: number
  customerId: string | null
}

type MergeClaim = {
  identityVersion: number
  customerId: string
  mergeId: string
  raw: string | null
  items: CartSkuQuantity[]
  status: 'pending' | 'failed' | 'succeeded'
}

type SyncResult = 'complete' | 'failed' | 'deferred'

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function newId(): string {
  return crypto.randomUUID()
}

function parseGuestCart(raw: string | null): GuestCartEnvelope {
  if (!raw) return { version: 1, mergeId: newId(), items: [] }
  try {
    const parsed = JSON.parse(raw) as Partial<GuestCartEnvelope>
    if (parsed.version !== 1 || !isUuid(parsed.mergeId) || !Array.isArray(parsed.items) || parsed.items.length > maxCartLines) {
      throw new Error('Invalid guest cart')
    }
    const merged = new Map<string, number>()
    for (const candidate of parsed.items) {
      if (!candidate || !isUuid(candidate.skuId) || !Number.isSafeInteger(candidate.quantity)
        || candidate.quantity < 1 || candidate.quantity > maxLineQuantity) {
        throw new Error('Invalid guest cart item')
      }
      const quantity = (merged.get(candidate.skuId) ?? 0) + candidate.quantity
      if (quantity > maxLineQuantity) throw new Error('Invalid guest cart quantity')
      merged.set(candidate.skuId, quantity)
    }
    if (merged.size > maxCartLines) throw new Error('Invalid guest cart size')
    return {
      version: 1,
      mergeId: parsed.mergeId,
      items: [...merged].map(([skuId, quantity]) => ({ skuId, quantity })),
    }
  } catch {
    return { version: 1, mergeId: newId(), items: [] }
  }
}

export function useShoppingCart() {
  const customerApi = useCustomerApi()
  const guestItems = useState<CartSkuQuantity[]>('storefront-guest-cart-items', () => [])
  const customerCart = useState<CustomerCart | null>('storefront-customer-cart', () => null)
  const guestQuote = useState<CheckoutQuote | null>('storefront-guest-cart-quote', () => null)
  const ownerId = useState<string | null>('storefront-cart-owner-id', () => null)
  const ownerIdentityVersion = useState('storefront-cart-owner-identity-version', () => -1)
  const readyState = useState('storefront-cart-ready', () => false)
  const syncing = useState('storefront-cart-syncing', () => false)
  const busyState = useState('storefront-cart-busy', () => false)
  const busyIdentityVersion = useState('storefront-cart-busy-identity-version', () => -1)
  const errorState = useState<string | null>('storefront-cart-error', () => null)
  const noticeState = useState<string | null>('storefront-cart-notice', () => null)
  const syncRequestVersion = useState('storefront-cart-sync-request-version', () => 0)
  const syncAttemptedIdentityVersion = useState<number | null>('storefront-cart-sync-attempted-version', () => null)
  const cartMutationVersion = useState('storefront-cart-mutation-version', () => 0)
  const cartOperationVersion = useState('storefront-cart-operation-version', () => 0)
  const guestRevision = useState('storefront-cart-guest-revision', () => 0)
  const mergeClaim = useState<MergeClaim | null>('storefront-cart-merge-claim', () => null)

  const customerId = computed(() => customerApi.session.value?.customer.id ?? null)
  const activeIdentityVersion = computed(() => customerApi.identityVersion.value)

  function currentScope(): CartScope {
    return { identityVersion: customerApi.identityVersion.value, customerId: customerId.value }
  }

  function scopeIsCurrent(scope: CartScope): boolean {
    return customerApi.sessionResolved.value
      && customerApi.identityVersion.value === scope.identityVersion
      && customerId.value === scope.customerId
  }

  function scopeIsActive(scope: CartScope): boolean {
    return scopeIsCurrent(scope)
      && ownerIdentityVersion.value === scope.identityVersion
      && ownerId.value === scope.customerId
  }

  function readStorageRaw(): string | null {
    if (!import.meta.client) return null
    try { return localStorage.getItem(storageKey) } catch { return null }
  }

  function readGuestSnapshot(): GuestCartSnapshot {
    const raw = readStorageRaw()
    const envelope = parseGuestCart(raw)
    if (raw && envelope.items.length === 0) {
      try { localStorage.removeItem(storageKey) } catch { /* Best effort only. */ }
    }
    return { ...envelope, raw, revision: guestRevision.value }
  }

  function writeStorage(items: CartSkuQuantity[], mergeId = newId()): GuestCartEnvelope {
    const envelope: GuestCartEnvelope = { version: 1, mergeId, items }
    guestRevision.value += 1
    if (import.meta.client) {
      try { localStorage.setItem(storageKey, JSON.stringify(envelope)) } catch { /* The visible cart still works for this page view. */ }
    }
    guestItems.value = items
    return envelope
  }

  function clearStorageIfUnchanged(scope: CartScope, snapshot: GuestCartSnapshot): boolean {
    if (!scopeIsCurrent(scope) || guestRevision.value !== snapshot.revision || readStorageRaw() !== snapshot.raw) return false
    const latest = parseGuestCart(snapshot.raw)
    if (latest.mergeId !== snapshot.mergeId || JSON.stringify(latest.items) !== JSON.stringify(snapshot.items)) return false
    guestRevision.value += 1
    if (import.meta.client) {
      try { localStorage.removeItem(storageKey) } catch { /* Best effort only. */ }
    }
    guestItems.value = []
    guestQuote.value = null
    return true
  }

  function clearGuestCart(): void {
    guestRevision.value += 1
    if (import.meta.client) {
      try { localStorage.removeItem(storageKey) } catch { /* Best effort only. */ }
    }
    guestItems.value = []
    guestQuote.value = null
    if (mergeClaim.value?.status !== 'pending') mergeClaim.value = null
  }

  function activateScope(scope: CartScope): void {
    ownerId.value = scope.customerId
    ownerIdentityVersion.value = scope.identityVersion
    readyState.value = false
    customerCart.value = null
    guestQuote.value = null
    errorState.value = null
    noticeState.value = null
    busyState.value = false
    busyIdentityVersion.value = scope.identityVersion
    cartOperationVersion.value += 1
    cartMutationVersion.value += 1
    syncAttemptedIdentityVersion.value = null
    syncRequestVersion.value += 1
    if (!scope.customerId) guestItems.value = readGuestSnapshot().items
  }

  function readError(error: unknown, fallback: string): string {
    return error instanceof CustomerApiError ? error.message : fallback
  }

  async function refreshGuestQuote(scope: CartScope, snapshot = readGuestSnapshot()): Promise<boolean> {
    if (!snapshot.items.length) {
      if (scopeIsActive(scope) && guestRevision.value === snapshot.revision) {
        guestQuote.value = null
        errorState.value = null
      }
      return scopeIsActive(scope)
    }
    try {
      const quote = await customerApi.request<CheckoutQuote>('/api/v1/checkout/quote', {
        method: 'POST',
        body: { items: snapshot.items },
      })
      if (!scopeIsActive(scope) || guestRevision.value !== snapshot.revision) return false
      guestQuote.value = quote
      errorState.value = null
      return true
    } catch (error) {
      if (scopeIsActive(scope) && guestRevision.value === snapshot.revision) {
        errorState.value = readError(error, '购物车报价暂时无法加载，请重试。')
      }
      return false
    }
  }

  function mergeClaimMatches(claim: MergeClaim, scope: CartScope, snapshot: GuestCartSnapshot): boolean {
    return claim.customerId === scope.customerId
      && claim.mergeId === snapshot.mergeId
      && claim.raw === snapshot.raw
      && JSON.stringify(claim.items) === JSON.stringify(snapshot.items)
  }

  async function mergeGuestCart(scope: CartScope, snapshot: GuestCartSnapshot): Promise<'merged' | 'failed' | 'blocked' | 'stale'> {
    if (!scope.customerId || !snapshot.items.length) return 'merged'
    const existing = mergeClaim.value
    if (existing) {
      if (!mergeClaimMatches(existing, scope, snapshot)) {
        if (scopeIsActive(scope)) {
          noticeState.value = '游客购物车仍保留在本机，未合并到当前账户。'
        }
        return 'blocked'
      }
      if (existing.status === 'pending') return 'blocked'
      if (existing.status === 'succeeded') {
        if (!scopeIsCurrent(scope)) return 'stale'
        if (clearStorageIfUnchanged(scope, snapshot) && scopeIsActive(scope)) {
          noticeState.value = '游客购物车已合并到当前账户。'
        }
        return 'merged'
      }
    }

    const claim: MergeClaim = {
      identityVersion: scope.identityVersion,
      customerId: scope.customerId,
      mergeId: snapshot.mergeId,
      raw: snapshot.raw,
      items: snapshot.items.map(item => ({ ...item })),
      status: 'pending',
    }
    mergeClaim.value = claim
    const mergeBody: CustomerCartMergeBody = { mergeId: snapshot.mergeId, items: snapshot.items }
    try {
      const merged = await customerApi.request<CustomerCartMutation>('/api/v1/customer/cart/merge', {
        method: 'POST',
        body: mergeBody,
      })
      if (mergeClaim.value?.mergeId === claim.mergeId && mergeClaim.value.identityVersion === claim.identityVersion) {
        mergeClaim.value = { ...claim, status: 'succeeded' }
      }
      if (!scopeIsCurrent(scope)) return 'stale'
      const cleared = clearStorageIfUnchanged(scope, snapshot)
      if (!scopeIsActive(scope)) return 'stale'
      if (cleared) {
        customerCart.value = merged.cart
        if (merged.skippedSkuIds.length) {
          noticeState.value = `${merged.skippedSkuIds.length} 件已删除的商品规格未能合并。`
        } else if (merged.changed) {
          noticeState.value = '游客购物车已合并到当前账户。'
        }
      } else if (guestRevision.value !== snapshot.revision || readStorageRaw() !== snapshot.raw) {
        noticeState.value = '购物车在同步期间发生了变化，本机数据已保留。'
      }
      return 'merged'
    } catch (error) {
      if (mergeClaim.value?.mergeId === claim.mergeId && mergeClaim.value.identityVersion === claim.identityVersion) {
        mergeClaim.value = { ...claim, status: 'failed' }
      }
      if (!scopeIsCurrent(scope)) return 'stale'
      if (scopeIsActive(scope)) {
        errorState.value = error instanceof CustomerApiError
          ? `游客购物车合并未完成：${error.message} 本机购物车仍已保留。`
          : '游客购物车合并未完成，本机购物车仍已保留。'
      }
      return 'failed'
    }
  }

  async function syncCustomerCart(scope: CartScope, mutationVersion: number): Promise<SyncResult> {
    try {
      const cart = await customerApi.request<CustomerCart>('/api/v1/customer/cart')
      if (!scopeIsActive(scope) || busyState.value || cartMutationVersion.value !== mutationVersion) return 'deferred'
      customerCart.value = cart
      return 'complete'
    } catch (error) {
      if (!scopeIsActive(scope) || busyState.value || cartMutationVersion.value !== mutationVersion) return 'deferred'
      if (scopeIsActive(scope) && !busyState.value && cartMutationVersion.value === mutationVersion) {
        errorState.value = readError(error, '购物车暂时无法加载，请重试。')
      }
      return 'failed'
    }
  }

  async function syncOneScope(scope: CartScope): Promise<SyncResult> {
    if (busyState.value) return 'deferred'
    if (scope.customerId) {
      const snapshot = readGuestSnapshot()
      guestItems.value = snapshot.items
      let mergeResult: 'merged' | 'failed' | 'blocked' | 'stale' = 'merged'
      if (snapshot.items.length) mergeResult = await mergeGuestCart(scope, snapshot)
      if (mergeResult === 'stale' || !scopeIsActive(scope)) return 'deferred'
      if (busyState.value) return 'deferred'
      const cartResult = await syncCustomerCart(scope, cartMutationVersion.value)
      if (cartResult !== 'complete') return cartResult
      if (mergeResult === 'merged' && !errorState.value) errorState.value = null
      return 'complete'
    }

    customerCart.value = null
    const snapshot = readGuestSnapshot()
    guestItems.value = snapshot.items
    const quoted = await refreshGuestQuote(scope, snapshot)
    if (!quoted) {
      if (!scopeIsActive(scope) || guestRevision.value !== snapshot.revision) return 'deferred'
      return 'failed'
    }
    if (!scopeIsActive(scope)) return 'deferred'
    return 'complete'
  }

  async function runSyncWorker(): Promise<void> {
    syncing.value = true
    try {
      while (customerApi.sessionResolved.value) {
        const scope = currentScope()
        if (!scopeIsActive(scope)) activateScope(scope)
        const requestVersion = syncRequestVersion.value
        const result = await syncOneScope(scope)

        if (!scopeIsCurrent(scope)) continue
        if (!scopeIsActive(scope)) {
          activateScope(currentScope())
          continue
        }
        if (requestVersion !== syncRequestVersion.value) continue
        if (result === 'deferred') break

        syncAttemptedIdentityVersion.value = scope.identityVersion
        readyState.value = result === 'complete'
        break
      }
    } finally {
      syncing.value = false
      const scope = currentScope()
      const superseded = !scopeIsActive(scope)
        || (readyState.value && syncAttemptedIdentityVersion.value !== scope.identityVersion)
      if (customerApi.sessionResolved.value && !busyState.value && superseded) void syncSession()
    }
  }

  async function syncSession(force = false): Promise<void> {
    if (!import.meta.client || !customerApi.sessionResolved.value) return
    const scope = currentScope()
    const scopeChanged = !scopeIsActive(scope)
    if (scopeChanged) activateScope(scope)
    if (force && scopeIsActive(scope)) errorState.value = null
    if (force) syncRequestVersion.value += 1
    if (syncing.value) return
    if (!force && (readyState.value || syncAttemptedIdentityVersion.value === scope.identityVersion)) return
    if (!scopeChanged && !force) syncRequestVersion.value += 1
    await runSyncWorker()
  }

  const ready = computed(() => readyState.value
    && ownerIdentityVersion.value === activeIdentityVersion.value
    && ownerId.value === customerId.value)
  const busy = computed(() => busyState.value && busyIdentityVersion.value === activeIdentityVersion.value)
  const errorMessage = computed(() => ownerIdentityVersion.value === activeIdentityVersion.value ? errorState.value : null)
  const noticeMessage = computed(() => ownerIdentityVersion.value === activeIdentityVersion.value ? noticeState.value : null)
  const cartView = computed(() => {
    if (!ready.value) return null
    return customerId.value ? customerCart.value : guestQuote.value
  })
  const currentLineCount = computed(() => {
    if (customerId.value) return ready.value ? customerCart.value?.itemCount ?? 0 : 0
    return guestItems.value.length
  })
  const currentQuantity = computed(() => {
    if (customerId.value) return ready.value ? customerCart.value?.totalQuantity ?? 0 : 0
    return guestItems.value.reduce((total, item) => total + item.quantity, 0)
  })

  function beginOperation(scope: CartScope): number | null {
    if (!scopeIsActive(scope) || busyState.value) return null
    cartOperationVersion.value += 1
    cartMutationVersion.value += 1
    busyIdentityVersion.value = scope.identityVersion
    busyState.value = true
    errorState.value = null
    noticeState.value = null
    return cartOperationVersion.value
  }

  function operationIsCurrent(scope: CartScope, operationVersion: number): boolean {
    return scopeIsActive(scope) && cartOperationVersion.value === operationVersion
  }

  function finishOperation(scope: CartScope, operationVersion: number): void {
    if (!operationIsCurrent(scope, operationVersion)) return
    busyState.value = false
    if (!readyState.value || syncing.value) void syncSession(true)
  }

  async function refresh(): Promise<void> {
    const scope = currentScope()
    if (scope.customerId) {
      await syncSession(true)
      return
    }
    if (!scopeIsActive(scope)) {
      await syncSession(true)
      return
    }
    const success = await refreshGuestQuote(scope)
    if (success && !readyState.value) readyState.value = true
  }

  async function add(skuId: string, quantity: number): Promise<void> {
    const scope = currentScope()
    if (!isUuid(skuId) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > maxLineQuantity) {
      if (scopeIsActive(scope)) errorState.value = '请选择有效商品规格和数量。'
      return
    }
    const operationVersion = beginOperation(scope)
    if (operationVersion === null) return
    try {
      if (scope.customerId) {
        const result = await customerApi.request<CustomerCartMutation>('/api/v1/customer/cart/items', {
          method: 'POST', body: { skuId, quantity },
        })
        if (operationIsCurrent(scope, operationVersion)) customerCart.value = result.cart
      } else {
        const current = guestItems.value.find(item => item.skuId === skuId)?.quantity ?? 0
        const next = current + quantity
        if (next > maxLineQuantity) throw new Error(`同一规格数量不能超过 ${maxLineQuantity}。`)
        if (!current && guestItems.value.length >= maxCartLines) throw new Error(`购物车最多包含 ${maxCartLines} 个规格。`)
        const nextItems = current
          ? guestItems.value.map(item => item.skuId === skuId ? { skuId, quantity: next } : item)
          : [...guestItems.value, { skuId, quantity }]
        writeStorage(nextItems)
        const snapshot = readGuestSnapshot()
        await refreshGuestQuote(scope, snapshot)
      }
      if (operationIsCurrent(scope, operationVersion)) noticeState.value = '已加入购物车。'
    } catch (error) {
      if (operationIsCurrent(scope, operationVersion)) {
        errorState.value = error instanceof CustomerApiError || error instanceof Error
          ? error.message
          : '暂时无法加入购物车，请重试。'
      }
    } finally {
      finishOperation(scope, operationVersion)
    }
  }

  async function setQuantity(skuId: string, quantity: number): Promise<void> {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > maxLineQuantity) return
    const scope = currentScope()
    const operationVersion = beginOperation(scope)
    if (operationVersion === null) return
    try {
      if (scope.customerId) {
        const result = await customerApi.request<CustomerCartMutation>(`/api/v1/customer/cart/items/${encodeURIComponent(skuId)}`, {
          method: 'PATCH', body: { quantity },
        })
        if (operationIsCurrent(scope, operationVersion)) customerCart.value = result.cart
      } else {
        writeStorage(guestItems.value.map(item => item.skuId === skuId ? { skuId, quantity } : item))
        await refreshGuestQuote(scope, readGuestSnapshot())
      }
    } catch (error) {
      if (operationIsCurrent(scope, operationVersion)) errorState.value = error instanceof Error ? error.message : '数量更新失败，请重试。'
    } finally {
      finishOperation(scope, operationVersion)
    }
  }

  async function remove(skuId: string): Promise<void> {
    const scope = currentScope()
    const operationVersion = beginOperation(scope)
    if (operationVersion === null) return
    try {
      if (scope.customerId) {
        const result = await customerApi.request<CustomerCartMutation>(`/api/v1/customer/cart/items/${encodeURIComponent(skuId)}`, { method: 'DELETE' })
        if (operationIsCurrent(scope, operationVersion)) customerCart.value = result.cart
      } else {
        writeStorage(guestItems.value.filter(item => item.skuId !== skuId))
        await refreshGuestQuote(scope, readGuestSnapshot())
      }
    } catch (error) {
      if (operationIsCurrent(scope, operationVersion)) errorState.value = error instanceof Error ? error.message : '移除商品失败，请重试。'
    } finally {
      finishOperation(scope, operationVersion)
    }
  }

  async function clear(): Promise<void> {
    const scope = currentScope()
    const operationVersion = beginOperation(scope)
    if (operationVersion === null) return
    try {
      if (scope.customerId) {
        const result = await customerApi.request<CustomerCartMutation>('/api/v1/customer/cart', { method: 'DELETE' })
        if (operationIsCurrent(scope, operationVersion)) customerCart.value = result.cart
      } else {
        clearGuestCart()
      }
      if (operationIsCurrent(scope, operationVersion)) noticeState.value = null
    } catch (error) {
      if (operationIsCurrent(scope, operationVersion)) errorState.value = error instanceof Error ? error.message : '清空购物车失败，请重试。'
    } finally {
      finishOperation(scope, operationVersion)
    }
  }

  async function quote(items: CartSkuQuantity[]): Promise<CheckoutQuote> {
    const scope = currentScope()
    const result = await customerApi.request<CheckoutQuote>('/api/v1/checkout/quote', {
      method: 'POST', body: { items },
    })
    if (!scopeIsCurrent(scope)) throw new CustomerApiError(0, 'STALE_IDENTITY', '登录状态已变化，请重新获取报价。')
    return result
  }

  function checkoutPath(items: CartSkuQuantity[]): string {
    return `/checkout?items=${encodeURIComponent(JSON.stringify(items))}`
  }

  return {
    guestItems,
    customerCart,
    guestQuote,
    cartView,
    currentLineCount,
    currentQuantity,
    ready,
    busy,
    errorMessage,
    noticeMessage,
    syncSession,
    refresh,
    add,
    setQuantity,
    remove,
    clear,
    quote,
    checkoutPath,
  }
}
