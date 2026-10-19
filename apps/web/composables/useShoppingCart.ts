import type {
  CartSkuQuantity,
  CheckoutQuote,
  CustomerCart,
  CustomerCartMergeBody,
  CustomerCartMutation,
} from '@aikayun/contracts'
import { CustomerApiError, useCustomerApi } from './useCustomerApi'

const storageKey = 'aikayun-guest-cart-v2'
const storageLockName = 'aikayun:guest-cart:v2'
const maxLineQuantity = 99
const maxCartLines = 50
const maxPendingBatches = 50

type GuestCartBatch = {
  ownerId: string
  mergeId: string
  items: CartSkuQuantity[]
}

type GuestCartStore = {
  version: 2
  unclaimedItems: CartSkuQuantity[]
  pendingBatches: GuestCartBatch[]
}

type StoredGuestCart = {
  ok: boolean
  raw: string | null
  store: GuestCartStore
}

type GuestCartSnapshot = {
  items: CartSkuQuantity[]
  raw: string | null
  revision: number
  storageOk: boolean
}

type CartScope = {
  identityVersion: number
  customerId: string | null
}

type SyncResult = 'complete' | 'failed' | 'deferred'
type MergeResult = 'merged' | 'failed' | 'stale'

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function newId(): string {
  return crypto.randomUUID()
}

function emptyGuestCartStore(): GuestCartStore {
  return { version: 2, unclaimedItems: [], pendingBatches: [] }
}

function parseItems(value: unknown): CartSkuQuantity[] | null {
  if (!Array.isArray(value) || value.length > maxCartLines) return null
  const seen = new Set<string>()
  const items: CartSkuQuantity[] = []
  for (const candidate of value) {
    if (!candidate || !isUuid(candidate.skuId) || seen.has(candidate.skuId)
      || !Number.isSafeInteger(candidate.quantity) || candidate.quantity < 1 || candidate.quantity > maxLineQuantity) {
      return null
    }
    seen.add(candidate.skuId)
    items.push({ skuId: candidate.skuId, quantity: candidate.quantity })
  }
  return items
}

function parseGuestCartStore(raw: string | null): GuestCartStore | null {
  if (!raw) return emptyGuestCartStore()
  try {
    const value = JSON.parse(raw) as Partial<GuestCartStore>
    if (value.version !== 2 || !Array.isArray(value.pendingBatches) || value.pendingBatches.length > maxPendingBatches) return null
    const unclaimedItems = parseItems(value.unclaimedItems)
    if (!unclaimedItems) return null
    const pendingBatches: GuestCartBatch[] = []
    for (const candidate of value.pendingBatches) {
      if (!candidate || !isUuid(candidate.ownerId) || !isUuid(candidate.mergeId)) return null
      const items = parseItems(candidate.items)
      if (!items?.length) return null
      pendingBatches.push({ ownerId: candidate.ownerId, mergeId: candidate.mergeId, items })
    }
    return { version: 2, unclaimedItems, pendingBatches }
  }
  catch {
    return null
  }
}

function cloneItems(items: CartSkuQuantity[]): CartSkuQuantity[] {
  return items.map(item => ({ skuId: item.skuId, quantity: item.quantity }))
}

function sameItems(left: CartSkuQuantity[], right: CartSkuQuantity[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameBatch(left: GuestCartBatch, right: GuestCartBatch): boolean {
  return left.ownerId === right.ownerId
    && left.mergeId === right.mergeId
    && sameItems(left.items, right.items)
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
  const guestStoreRaw = useState<string | null>('storefront-cart-storage-raw', () => null)
  const guestStorageError = useState<string | null>('storefront-cart-storage-error', () => null)
  const nuxtApp = useNuxtApp() as ReturnType<typeof useNuxtApp> & {
    _shoppingCartStorageListener?: (event: StorageEvent) => void
  }

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

  function readStoredGuestCart(rawOverride?: string | null): StoredGuestCart {
    if (!import.meta.client) return { ok: false, raw: null, store: emptyGuestCartStore() }
    try {
      const raw = rawOverride === undefined ? localStorage.getItem(storageKey) : rawOverride
      const store = parseGuestCartStore(raw)
      return store ? { ok: true, raw, store } : { ok: false, raw, store: emptyGuestCartStore() }
    }
    catch {
      return { ok: false, raw: null, store: emptyGuestCartStore() }
    }
  }

  function applyStoredGuestCart(stored: StoredGuestCart, forceRevision = false): void {
    if (!stored.ok) {
      guestStorageError.value = '本机购物车存储不可用或数据无效，无法安全同步。'
      guestItems.value = []
      guestQuote.value = null
      return
    }
    guestStorageError.value = null
    if (forceRevision || guestStoreRaw.value !== stored.raw) {
      guestStoreRaw.value = stored.raw
      guestRevision.value += 1
      guestQuote.value = null
    }
    guestItems.value = cloneItems(stored.store.unclaimedItems)
  }

  function restoreGuestItems(): boolean {
    const stored = readStoredGuestCart()
    applyStoredGuestCart(stored)
    return stored.ok
  }

  function writeGuestStore(store: GuestCartStore): void {
    const raw = store.unclaimedItems.length || store.pendingBatches.length
      ? JSON.stringify(store)
      : null
    try {
      if (raw) localStorage.setItem(storageKey, raw)
      else localStorage.removeItem(storageKey)
    }
    catch {
      throw new Error('本机购物车无法写入浏览器存储，请检查存储空间后重试。')
    }
    applyStoredGuestCart({ ok: true, raw, store }, true)
  }

  async function withGuestStorageLock<T>(operation: () => T, required = false): Promise<T> {
    if (!import.meta.client) return operation()
    const locks = navigator.locks
    if (!locks) {
      if (required) throw new Error('当前浏览器不支持安全的跨标签购物车同步。')
      return operation()
    }
    return locks.request(storageLockName, { mode: 'exclusive' }, operation)
  }

  function readGuestSnapshot(): GuestCartSnapshot {
    const stored = readStoredGuestCart()
    applyStoredGuestCart(stored)
    return {
      items: stored.ok ? cloneItems(stored.store.unclaimedItems) : [],
      raw: stored.raw,
      revision: guestRevision.value,
      storageOk: stored.ok,
    }
  }

  function snapshotIsCurrent(scope: CartScope, snapshot: GuestCartSnapshot): boolean {
    if (!scopeIsActive(scope) || guestRevision.value !== snapshot.revision) return false
    const latest = readStoredGuestCart()
    return latest.ok && latest.raw === snapshot.raw
  }

  function installStorageListener(): void {
    if (!import.meta.client || nuxtApp._shoppingCartStorageListener) return
    const listener = (event: StorageEvent) => {
      if (event.key !== storageKey) return
      const stored = readStoredGuestCart()
      applyStoredGuestCart(stored, true)
      if (!customerApi.sessionResolved.value) return
      const scope = currentScope()
      if (scope.customerId) void syncSession(true)
      else if (scopeIsActive(scope)) void refreshGuestQuote(scope, readGuestSnapshot())
    }
    window.addEventListener('storage', listener)
    nuxtApp._shoppingCartStorageListener = listener
  }

  installStorageListener()

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
    restoreGuestItems()
    if (guestStorageError.value) errorState.value = guestStorageError.value
  }

  function readError(error: unknown, fallback: string): string {
    return error instanceof CustomerApiError ? error.message : error instanceof Error ? error.message : fallback
  }

  async function refreshGuestQuote(scope: CartScope, snapshot = readGuestSnapshot()): Promise<boolean> {
    if (!snapshot.storageOk) {
      if (scopeIsActive(scope)) errorState.value = guestStorageError.value ?? '本机购物车无法安全读取，请重试。'
      return false
    }
    if (!snapshot.items.length) {
      if (snapshotIsCurrent(scope, snapshot)) {
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
      if (!snapshotIsCurrent(scope, snapshot)) return false
      guestQuote.value = quote
      errorState.value = null
      return true
    }
    catch (error) {
      if (snapshotIsCurrent(scope, snapshot)) errorState.value = readError(error, '购物车报价暂时无法加载，请重试。')
      return false
    }
  }

  async function claimGuestItems(scope: CartScope): Promise<{ batches: GuestCartBatch[]; hasOtherOwners: boolean }> {
    const claimingCustomerId = scope.customerId
    if (!claimingCustomerId) return { batches: [], hasOtherOwners: false }
    return withGuestStorageLock(() => {
      if (!scopeIsActive(scope)) return { batches: [], hasOtherOwners: false }
      const stored = readStoredGuestCart()
      if (!stored.ok) throw new Error(guestStorageError.value ?? '本机购物车存储不可用，未发送合并请求。')
      let store = stored.store
      if (store.unclaimedItems.length) {
        if (store.pendingBatches.length >= maxPendingBatches) throw new Error('本机有过多待确认购物车批次，请先登录原账户完成同步。')
        const batch: GuestCartBatch = {
          ownerId: claimingCustomerId,
          mergeId: newId(),
          items: cloneItems(store.unclaimedItems),
        }
        store = {
          version: 2,
          unclaimedItems: [],
          pendingBatches: [...store.pendingBatches, batch],
        }
        writeGuestStore(store)
      }
      else {
        applyStoredGuestCart(stored)
      }
      return {
        batches: store.pendingBatches.filter(batch => batch.ownerId === claimingCustomerId).map(batch => ({
          ownerId: batch.ownerId,
          mergeId: batch.mergeId,
          items: cloneItems(batch.items),
        })),
        hasOtherOwners: store.pendingBatches.some(batch => batch.ownerId !== claimingCustomerId),
      }
    }, true)
  }

  async function removeConfirmedBatch(scope: CartScope, batch: GuestCartBatch): Promise<boolean> {
    return withGuestStorageLock(() => {
      if (!scopeIsCurrent(scope)) return false
      const stored = readStoredGuestCart()
      if (!stored.ok) throw new Error('本机存储暂时无法确认合并结果；原始批次已保留供幂等重试。')
      const index = stored.store.pendingBatches.findIndex(candidate => sameBatch(candidate, batch))
      if (index < 0) {
        applyStoredGuestCart(stored)
        return !stored.store.pendingBatches.some(candidate => candidate.mergeId === batch.mergeId && candidate.ownerId === batch.ownerId)
      }
      const pendingBatches = stored.store.pendingBatches.filter((_, candidateIndex) => candidateIndex !== index)
      writeGuestStore({ ...stored.store, pendingBatches })
      return true
    }, true)
  }

  async function mergeGuestBatch(scope: CartScope, batch: GuestCartBatch): Promise<MergeResult> {
    if (!scopeIsCurrent(scope)) return 'stale'
    const mergeBody: CustomerCartMergeBody = {
      mergeId: batch.mergeId,
      items: cloneItems(batch.items),
    }
    try {
      const merged = await customerApi.request<CustomerCartMutation>('/api/v1/customer/cart/merge', {
        method: 'POST',
        body: mergeBody,
      })
      if (!scopeIsCurrent(scope)) return 'stale'
      const cleared = await removeConfirmedBatch(scope, batch)
      if (!scopeIsActive(scope)) return 'stale'
      if (!cleared) throw new Error('合并已响应，但本机仍保留待确认批次；重试不会重复增加商品。')
      if (merged.skippedSkuIds.length) {
        noticeState.value = `${merged.skippedSkuIds.length} 件已删除的商品规格未能合并。`
      }
      else if (merged.changed) {
        noticeState.value = '游客购物车已合并到当前账户。'
      }
      return 'merged'
    }
    catch (error) {
      if (!scopeIsCurrent(scope)) return 'stale'
      if (scopeIsActive(scope)) {
        errorState.value = error instanceof CustomerApiError || error instanceof Error
          ? `游客购物车合并待确认：${error.message} 原始批次仍已保留，可安全重试。`
          : '游客购物车合并结果未知，原始批次仍已保留，可安全重试。'
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
    }
    catch (error) {
      if (!scopeIsActive(scope) || busyState.value || cartMutationVersion.value !== mutationVersion) return 'deferred'
      errorState.value = readError(error, '购物车暂时无法加载，请重试。')
      return 'failed'
    }
  }

  async function syncOneScope(scope: CartScope): Promise<SyncResult> {
    if (busyState.value) return 'deferred'
    if (scope.customerId) {
      let mergeFailed = false
      let hasOtherOwners = false
      try {
        const claimed = await claimGuestItems(scope)
        hasOtherOwners = claimed.hasOtherOwners
        for (const batch of claimed.batches) {
          const result = await mergeGuestBatch(scope, batch)
          if (result === 'stale' || !scopeIsActive(scope)) return 'deferred'
          if (result === 'failed') mergeFailed = true
        }
      }
      catch (error) {
        if (!scopeIsCurrent(scope)) return 'deferred'
        mergeFailed = true
        if (scopeIsActive(scope)) errorState.value = readError(error, '本机购物车暂时无法安全同步，请重试。')
      }
      if (!scopeIsActive(scope) || busyState.value) return 'deferred'
      const cartResult = await syncCustomerCart(scope, cartMutationVersion.value)
      if (cartResult !== 'complete') return cartResult
      if (hasOtherOwners && scopeIsActive(scope)) noticeState.value = '另有待确认购物车已绑定其他账户，当前账户不会读取或合并该批次。'
      if (!mergeFailed && scopeIsActive(scope)) errorState.value = null
      return 'complete'
    }

    customerCart.value = null
    const snapshot = readGuestSnapshot()
    if (guestStorageError.value) {
      if (scopeIsActive(scope)) errorState.value = guestStorageError.value
      return 'failed'
    }
    const stored = readStoredGuestCart()
    if (stored.ok && stored.store.pendingBatches.length && scopeIsActive(scope)) {
      noticeState.value = '有待原账户确认的游客购物车，已与当前访客购物车隔离。'
    }
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
    }
    finally {
      syncing.value = false
      const scope = currentScope()
      const superseded = !scopeIsActive(scope)
        || syncAttemptedIdentityVersion.value !== scope.identityVersion
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

  async function mutateGuestCart(
    scope: CartScope,
    operationVersion: number,
    update: (store: GuestCartStore) => GuestCartStore,
  ): Promise<GuestCartSnapshot | null> {
    return withGuestStorageLock(() => {
      if (!operationIsCurrent(scope, operationVersion) || scope.customerId) return null
      const stored = readStoredGuestCart()
      if (!stored.ok) throw new Error('本机购物车存储不可用或数据无效，尚未修改。')
      const next = update(stored.store)
      writeGuestStore(next)
      return {
        items: cloneItems(next.unclaimedItems),
        raw: next.unclaimedItems.length || next.pendingBatches.length ? JSON.stringify(next) : null,
        revision: guestRevision.value,
        storageOk: true,
      }
    })
  }

  async function refresh(): Promise<void> {
    const scope = currentScope()
    if (scope.customerId || !scopeIsActive(scope)) {
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
      }
      else {
        const snapshot = await mutateGuestCart(scope, operationVersion, (store) => {
          const current = store.unclaimedItems.find(item => item.skuId === skuId)?.quantity ?? 0
          const next = current + quantity
          if (next > maxLineQuantity) throw new Error(`同一规格数量不能超过 ${maxLineQuantity}。`)
          if (!current && store.unclaimedItems.length >= maxCartLines) throw new Error(`购物车最多包含 ${maxCartLines} 个规格。`)
          const unclaimedItems = current
            ? store.unclaimedItems.map(item => item.skuId === skuId ? { skuId, quantity: next } : item)
            : [...store.unclaimedItems, { skuId, quantity }]
          return { ...store, unclaimedItems }
        })
        if (snapshot && scopeIsActive(scope)) await refreshGuestQuote(scope, snapshot)
      }
      if (operationIsCurrent(scope, operationVersion)) noticeState.value = '已加入购物车。'
    }
    catch (error) {
      if (operationIsCurrent(scope, operationVersion)) errorState.value = readError(error, '暂时无法加入购物车，请重试。')
    }
    finally {
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
      }
      else {
        const snapshot = await mutateGuestCart(scope, operationVersion, store => ({
          ...store,
          unclaimedItems: store.unclaimedItems.map(item => item.skuId === skuId ? { skuId, quantity } : item),
        }))
        if (snapshot && scopeIsActive(scope)) await refreshGuestQuote(scope, snapshot)
      }
    }
    catch (error) {
      if (operationIsCurrent(scope, operationVersion)) errorState.value = readError(error, '数量更新失败，请重试。')
    }
    finally {
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
      }
      else {
        const snapshot = await mutateGuestCart(scope, operationVersion, store => ({
          ...store,
          unclaimedItems: store.unclaimedItems.filter(item => item.skuId !== skuId),
        }))
        if (snapshot && scopeIsActive(scope)) await refreshGuestQuote(scope, snapshot)
      }
    }
    catch (error) {
      if (operationIsCurrent(scope, operationVersion)) errorState.value = readError(error, '移除商品失败，请重试。')
    }
    finally {
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
      }
      else {
        await mutateGuestCart(scope, operationVersion, store => ({ ...store, unclaimedItems: [] }))
      }
      if (operationIsCurrent(scope, operationVersion)) noticeState.value = null
    }
    catch (error) {
      if (operationIsCurrent(scope, operationVersion)) errorState.value = readError(error, '清空购物车失败，请重试。')
    }
    finally {
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
