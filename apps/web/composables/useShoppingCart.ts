import type {
  CartSkuQuantity,
  CheckoutRequestLineV2,
  CheckoutQuote,
  CustomerCart,
  CustomerCartLinePurchaseFormBody,
  CustomerCartMergeBody,
  CustomerCartMutation,
} from '@aikayun/contracts'
import { CustomerApiError, useCustomerApi } from './useCustomerApi'
import { saveCheckoutSelection } from '~/utils/checkoutSelection'

const storageKey = 'aikayun-guest-cart-v2'
const storageLockName = 'aikayun:guest-cart:v2'
const maxLineQuantity = 99
const maxCartLines = 50
const maxPendingBatches = 50

type GuestCartBatchV1 = {
  ownerId: string
  mergeId: string
  items: CartSkuQuantity[]
}

type GuestCartBatchV2 = {
  version: 2
  ownerId: string
  mergeId: string
  items: CheckoutRequestLineV2[]
}

type GuestCartBatch = GuestCartBatchV1 | GuestCartBatchV2
type CartRequestItems = CartSkuQuantity[] | CheckoutRequestLineV2[]

type GuestCartStoreV2 = {
  version: 2
  unclaimedItems: CartSkuQuantity[]
  pendingBatches: GuestCartBatchV1[]
}

type GuestCartStoreV3 = {
  version: 3
  unclaimedItems: CheckoutRequestLineV2[]
  pendingBatches: GuestCartBatch[]
}

type GuestCartStore = GuestCartStoreV2 | GuestCartStoreV3

type StoredGuestCart = {
  ok: boolean
  raw: string | null
  store: GuestCartStore
}

type GuestCartSnapshot = {
  items: CartRequestItems
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

function parseLegacyItems(value: unknown): CartSkuQuantity[] | null {
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

function parseLineItems(value: unknown): CheckoutRequestLineV2[] | null {
  if (!Array.isArray(value) || value.length > maxCartLines) return null
  const seen = new Set<string>()
  const skuTotals = new Map<string, number>()
  const items: CheckoutRequestLineV2[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || !isUuid(candidate.lineId) || !isUuid(candidate.skuId)
      || seen.has(candidate.lineId) || !Number.isSafeInteger(candidate.quantity)
      || candidate.quantity < 1 || candidate.quantity > maxLineQuantity) return null
    const hasDraftId = Object.hasOwn(candidate, 'draftId')
    const hasDraftRevision = Object.hasOwn(candidate, 'draftRevision')
    if (hasDraftId !== hasDraftRevision) return null
    if (hasDraftId && (candidate.draftId !== null || candidate.draftRevision !== null)
      && (!isUuid(candidate.draftId) || !Number.isSafeInteger(candidate.draftRevision) || candidate.draftRevision < 1)) return null
    if (Object.keys(candidate).some(key => !['lineId', 'skuId', 'quantity', 'draftId', 'draftRevision'].includes(key))) return null
    const total = (skuTotals.get(candidate.skuId) ?? 0) + candidate.quantity
    if (total > maxLineQuantity) return null
    seen.add(candidate.lineId)
    skuTotals.set(candidate.skuId, total)
    items.push({ ...candidate } as CheckoutRequestLineV2)
  }
  return items
}

function parseGuestCartStore(raw: string | null): GuestCartStore | null {
  if (!raw) return emptyGuestCartStore()
  try {
    const value = JSON.parse(raw) as Partial<GuestCartStore>
    if ((value.version !== 2 && value.version !== 3)
      || !Array.isArray(value.pendingBatches) || value.pendingBatches.length > maxPendingBatches) return null
    const unclaimedItems = value.version === 2
      ? parseLegacyItems(value.unclaimedItems)
      : parseLineItems(value.unclaimedItems)
    if (!unclaimedItems) return null
    const pendingBatches: GuestCartBatch[] = []
    for (const candidate of value.pendingBatches) {
      if (!candidate || !isUuid(candidate.ownerId) || !isUuid(candidate.mergeId)) return null
      const items = 'version' in candidate && candidate.version === 2
        ? parseLineItems(candidate.items)
        : parseLegacyItems(candidate.items)
      if (!items?.length) return null
      if ('version' in candidate && candidate.version === 2) {
        if (value.version !== 3) return null
        pendingBatches.push({ version: 2, ownerId: candidate.ownerId, mergeId: candidate.mergeId, items: items as CheckoutRequestLineV2[] })
      } else {
        // Do not upgrade an already-claimed batch: its original request body
        // and SHA-256 must remain replayable after a local v3 transition.
        pendingBatches.push({ ownerId: candidate.ownerId, mergeId: candidate.mergeId, items: items as CartSkuQuantity[] })
      }
    }
    return value.version === 2
      ? { version: 2, unclaimedItems: unclaimedItems as CartSkuQuantity[], pendingBatches: pendingBatches as GuestCartBatchV1[] }
      : { version: 3, unclaimedItems: unclaimedItems as CheckoutRequestLineV2[], pendingBatches }
  }
  catch {
    return null
  }
}

function cloneItems<T extends CartSkuQuantity | CheckoutRequestLineV2>(items: T[]): T[] {
  return items.map(item => ({ ...item }))
}

function sameItems(left: CartRequestItems, right: CartRequestItems): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameBatch(left: GuestCartBatch, right: GuestCartBatch): boolean {
  return left.ownerId === right.ownerId
    && left.mergeId === right.mergeId
    && ('version' in left ? left.version : 1) === ('version' in right ? right.version : 1)
    && sameItems(left.items, right.items)
}

function isLineItems(items: CartRequestItems): items is CheckoutRequestLineV2[] {
  return items.every(item => 'lineId' in item)
}

function upgradeGuestStore(store: GuestCartStoreV2): GuestCartStoreV3 {
  return {
    version: 3,
    unclaimedItems: store.unclaimedItems.map(item => ({ lineId: newId(), ...item })),
    pendingBatches: store.pendingBatches.map(batch => ({
      ownerId: batch.ownerId,
      mergeId: batch.mergeId,
      items: cloneItems(batch.items),
    })),
  }
}

export function useShoppingCart() {
  const customerApi = useCustomerApi()
  const guestItems = useState<CartRequestItems>('storefront-guest-cart-items', () => [])
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
  const mergedGuestLineTargets = useState<Record<string, string>>('storefront-merged-guest-line-targets', () => ({}))
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
    mergedGuestLineTargets.value = {}
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

  async function reconcileGuestQuoteLines(
    scope: CartScope, snapshot: GuestCartSnapshot, quote: CheckoutQuote,
  ): Promise<GuestCartSnapshot | null> {
    if (!isLineItems(snapshot.items) || !quote.items.some(item => item.sourceLineIds.length > 1)) return null
    const originals = new Map(snapshot.items.map(item => [item.lineId.toLowerCase(), item]))
    const used = new Set<string>()
    const nextItems: CheckoutRequestLineV2[] = []
    for (const quoted of quote.items) {
      if (!quoted.lineId || !quoted.sourceLineIds.length) throw new Error('购买行报价缺少来源身份，请刷新后重试。')
      const sourceIds = quoted.sourceLineIds.map(id => id.toLowerCase())
      if (!sourceIds.includes(quoted.lineId.toLowerCase())) throw new Error('购买行报价身份不一致，请刷新后重试。')
      const sources = sourceIds.map((id) => {
        if (used.has(id)) throw new Error('购买行报价来源重复，请刷新后重试。')
        used.add(id)
        return originals.get(id)
      })
      if (sources.some(item => !item || item.skuId.toLowerCase() !== quoted.skuId.toLowerCase())
        || sources.reduce((total, item) => total + (item?.quantity ?? 0), 0) !== quoted.quantity) {
        throw new Error('购买行报价数量不一致，请刷新后重试。')
      }
      const retained = originals.get(quoted.lineId.toLowerCase())!
      if ((('draftId' in retained ? retained.draftId : null) ?? null) !== quoted.draftId
        || (('draftRevision' in retained ? retained.draftRevision : null) ?? null) !== quoted.draftRevision) {
        throw new Error('购买行报价资料引用不一致，请刷新后重试。')
      }
      nextItems.push({ ...retained, lineId: quoted.lineId, quantity: quoted.quantity })
    }
    if (used.size !== originals.size) throw new Error('购买行报价未覆盖全部来源，请刷新后重试。')
    return withGuestStorageLock(() => {
      if (!scopeIsActive(scope) || guestRevision.value !== snapshot.revision) return null
      const stored = readStoredGuestCart()
      if (!stored.ok || stored.raw !== snapshot.raw || stored.store.version !== 3) return null
      const next = { ...stored.store, unclaimedItems: nextItems }
      writeGuestStore(next)
      const redirects = { ...mergedGuestLineTargets.value }
      for (const quoted of quote.items) {
        if (!quoted.lineId) continue
        for (const sourceId of quoted.sourceLineIds) redirects[sourceId] = quoted.lineId
      }
      mergedGuestLineTargets.value = redirects
      return {
        items: cloneItems(nextItems),
        raw: JSON.stringify(next),
        revision: guestRevision.value,
        storageOk: true,
      }
    }, true)
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
        body: isLineItems(snapshot.items)
          ? { version: 2, items: snapshot.items }
          : { items: snapshot.items },
      })
      if (!snapshotIsCurrent(scope, snapshot)) return false
      if (isLineItems(snapshot.items) && quote.items.some(item => item.sourceLineIds.length > 1)) {
        const merged = await reconcileGuestQuoteLines(scope, snapshot, quote)
        if (!merged) return false
        return refreshGuestQuote(scope, merged)
      }
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
        if (store.version === 2) {
          const batch: GuestCartBatchV1 = {
            ownerId: claimingCustomerId,
            mergeId: newId(),
            items: cloneItems(store.unclaimedItems),
          }
          store = { ...store, unclaimedItems: [], pendingBatches: [...store.pendingBatches, batch] }
        } else {
          const batch: GuestCartBatchV2 = {
            version: 2,
            ownerId: claimingCustomerId,
            mergeId: newId(),
            items: cloneItems(store.unclaimedItems),
          }
          store = { ...store, unclaimedItems: [], pendingBatches: [...store.pendingBatches, batch] }
        }
        writeGuestStore(store)
      }
      else {
        applyStoredGuestCart(stored)
      }
      return {
        batches: store.pendingBatches.filter(batch => batch.ownerId === claimingCustomerId).map(batch => (
          'version' in batch
            ? { version: 2, ownerId: batch.ownerId, mergeId: batch.mergeId, items: cloneItems(batch.items) }
            : { ownerId: batch.ownerId, mergeId: batch.mergeId, items: cloneItems(batch.items) }
        )),
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
    const mergeBody: CustomerCartMergeBody = 'version' in batch
      ? { version: 2, mergeId: batch.mergeId, items: cloneItems(batch.items) }
      : { mergeId: batch.mergeId, items: cloneItems(batch.items) }
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
  // Guest cart mutations are local and preserve pending owner-bound merge
  // batches, so they remain available while the guest quote is refreshing.
  // Customer mutations wait for the authoritative account cart to load.
  const canAddToCart = computed(() => customerApi.sessionResolved.value
    && ownerIdentityVersion.value === activeIdentityVersion.value
    && ownerId.value === customerId.value
    && (!customerId.value || ready.value))
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
          if (store.version === 2) {
            const current = store.unclaimedItems.find(item => item.skuId === skuId)?.quantity ?? 0
            const next = current + quantity
            if (next > maxLineQuantity) throw new Error(`同一规格数量不能超过 ${maxLineQuantity}。`)
            if (!current && store.unclaimedItems.length >= maxCartLines) throw new Error(`购物车最多包含 ${maxCartLines} 个购买行。`)
            const unclaimedItems = current
              ? store.unclaimedItems.map(item => item.skuId === skuId ? { skuId, quantity: next } : item)
              : [...store.unclaimedItems, { skuId, quantity }]
            return { ...store, unclaimedItems }
          }
          const skuTotal = store.unclaimedItems.filter(item => item.skuId === skuId)
            .reduce((total, item) => total + item.quantity, 0)
          if (skuTotal + quantity > maxLineQuantity) throw new Error(`同一规格跨行数量不能超过 ${maxLineQuantity}。`)
          const existing = store.unclaimedItems.find(item => item.skuId === skuId && (!('draftId' in item) || item.draftId === null))
          if (!existing && store.unclaimedItems.length >= maxCartLines) throw new Error(`购物车最多包含 ${maxCartLines} 个购买行。`)
          const unclaimedItems = existing
            ? store.unclaimedItems.map(item => item.lineId === existing.lineId ? { ...item, quantity: item.quantity + quantity } : item)
            : [...store.unclaimedItems, { lineId: newId(), skuId, quantity }]
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

  // The storefront passes the current owner-bound draft reference here; the
  // server validates it before persisting the cart purchase line.
  async function addWithDraft(skuId: string, quantity: number, draftId: string, draftRevision: number): Promise<string | null> {
    const scope = currentScope()
    if (!isUuid(skuId) || !isUuid(draftId) || !Number.isSafeInteger(quantity)
      || quantity < 1 || quantity > maxLineQuantity || !Number.isSafeInteger(draftRevision) || draftRevision < 1) {
      if (scopeIsActive(scope)) errorState.value = '购买行或资料版本无效，请重新确认。'
      return null
    }
    const operationVersion = beginOperation(scope)
    if (operationVersion === null) return null
    const normalizedSkuId = skuId.toLowerCase()
    const normalizedDraftId = draftId.toLowerCase()
    try {
      if (scope.customerId) {
        const result = await customerApi.request<CustomerCartMutation>('/api/v1/customer/cart/items', {
          method: 'POST', body: { version: 2, skuId: normalizedSkuId, quantity, draftId: normalizedDraftId, draftRevision },
        })
        if (operationIsCurrent(scope, operationVersion)) customerCart.value = result.cart
        return result.retainedLineId
      }
      let retainedLineId = newId()
      const snapshot = await mutateGuestCart(scope, operationVersion, (currentStore) => {
        const store = currentStore.version === 2 ? upgradeGuestStore(currentStore) : currentStore
        const existingDraftLine = store.unclaimedItems.find(item => 'draftId' in item
          && item.draftId?.toLowerCase() === normalizedDraftId)
        if (existingDraftLine && (existingDraftLine.skuId.toLowerCase() !== normalizedSkuId
          || !('draftRevision' in existingDraftLine) || existingDraftLine.draftRevision !== draftRevision)) {
          throw new Error('同一填写草稿已绑定不同规格或修订，请先重新确认原购买行。')
        }
        const skuTotal = store.unclaimedItems.filter(item => item.skuId.toLowerCase() === normalizedSkuId)
          .reduce((total, item) => total + item.quantity, 0)
        if (skuTotal + quantity > maxLineQuantity) throw new Error(`同一规格跨行数量不能超过 ${maxLineQuantity}。`)
        if (existingDraftLine) {
          retainedLineId = existingDraftLine.lineId
          return {
            ...store,
            unclaimedItems: store.unclaimedItems.map(item => item.lineId === retainedLineId
              ? { ...item, quantity: item.quantity + quantity } : item),
          }
        }
        if (store.unclaimedItems.length >= maxCartLines) throw new Error(`购物车最多包含 ${maxCartLines} 个购买行。`)
        return {
          ...store,
          unclaimedItems: [...store.unclaimedItems, {
            lineId: retainedLineId, skuId: normalizedSkuId, quantity,
            draftId: normalizedDraftId, draftRevision,
          }],
        }
      })
      if (snapshot && scopeIsActive(scope)) await refreshGuestQuote(scope, snapshot)
      return snapshot ? retainedLineId : null
    } catch (error) {
      if (operationIsCurrent(scope, operationVersion)) errorState.value = readError(error, '购买行暂时无法保存，请重试。')
      return null
    } finally {
      finishOperation(scope, operationVersion)
    }
  }

  async function editPurchaseFormLine(lineId: string, body: CustomerCartLinePurchaseFormBody): Promise<string | null> {
    const scope = currentScope()
    if (!scope.customerId || !isUuid(lineId)) return null
    const operationVersion = beginOperation(scope)
    if (operationVersion === null) return null
    try {
      const result = await customerApi.request<CustomerCartMutation>(`/api/v1/customer/cart/lines/${encodeURIComponent(lineId)}/purchase-form`, {
        method: 'PATCH', body,
      })
      if (operationIsCurrent(scope, operationVersion)) customerCart.value = result.cart
      return result.retainedLineId
    } catch (error) {
      if (operationIsCurrent(scope, operationVersion)) errorState.value = readError(error, '购买资料更新失败，请重新核对资料与报价。')
      return null
    } finally {
      finishOperation(scope, operationVersion)
    }
  }

  async function replaceGuestPurchaseFormLine(
    lineId: string,
    expectedDraftId: string | null,
    expectedDraftRevision: number | null,
    draftId: string,
    draftRevision: number,
  ): Promise<string | null> {
    const scope = currentScope()
    if (scope.customerId || !isUuid(lineId) || !isUuid(draftId) || !Number.isSafeInteger(draftRevision) || draftRevision < 1) return null
    const operationVersion = beginOperation(scope)
    if (operationVersion === null) return null
    try {
      const snapshot = await mutateGuestCart(scope, operationVersion, (currentStore) => {
        const store = currentStore.version === 2 ? upgradeGuestStore(currentStore) : currentStore
        const line = store.unclaimedItems.find(item => item.lineId.toLowerCase() === lineId.toLowerCase())
        const currentDraftId = line && 'draftId' in line ? line.draftId ?? null : null
        const currentDraftRevision = line && 'draftRevision' in line ? line.draftRevision ?? null : null
        if (!line || currentDraftId !== expectedDraftId || currentDraftRevision !== expectedDraftRevision) {
          throw new Error('游客购买行已在其他标签页变化，请刷新购物车后重试。')
        }
        return { ...store, unclaimedItems: store.unclaimedItems.map(item => item.lineId === line.lineId
          ? { ...item, draftId, draftRevision } : item) }
      })
      if (snapshot && scopeIsActive(scope)) await refreshGuestQuote(scope, snapshot)
      return snapshot ? lineId : null
    } catch (error) {
      if (operationIsCurrent(scope, operationVersion)) errorState.value = readError(error, '游客购买行资料更新失败，请刷新后重试。')
      return null
    } finally { finishOperation(scope, operationVersion) }
  }

  async function setQuantity(lineIdOrSkuId: string, quantity: number): Promise<void> {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > maxLineQuantity) return
    const scope = currentScope()
    const operationVersion = beginOperation(scope)
    if (operationVersion === null) return
    try {
      if (scope.customerId) {
        const line = customerCart.value?.items.find(item => item.lineId === lineIdOrSkuId)
        if (line && line.lineRevision === null) throw new Error('购买行版本不可用，请刷新购物车后重试。')
        const result = line
          ? await customerApi.request<CustomerCartMutation>(`/api/v1/customer/cart/lines/${encodeURIComponent(lineIdOrSkuId)}`, {
            method: 'PATCH', body: { quantity, expectedLineRevision: line.lineRevision },
          })
          : await customerApi.request<CustomerCartMutation>(`/api/v1/customer/cart/items/${encodeURIComponent(lineIdOrSkuId)}`, {
            method: 'PATCH', body: { quantity },
          })
        if (operationIsCurrent(scope, operationVersion)) customerCart.value = result.cart
      }
      else {
        const snapshot = await mutateGuestCart(scope, operationVersion, (store) => {
          if (store.version === 2) return {
            ...store,
            unclaimedItems: store.unclaimedItems.map(item => item.skuId === lineIdOrSkuId ? { ...item, quantity } : item),
          }
          const line = store.unclaimedItems.find(item => item.lineId === lineIdOrSkuId)
          if (!line) return store
          const otherQuantity = store.unclaimedItems.filter(item => item.skuId === line.skuId && item.lineId !== line.lineId)
            .reduce((total, item) => total + item.quantity, 0)
          if (otherQuantity + quantity > maxLineQuantity) throw new Error(`同一规格跨行数量不能超过 ${maxLineQuantity}。`)
          return {
            ...store,
            unclaimedItems: store.unclaimedItems.map(item => item.lineId === lineIdOrSkuId ? { ...item, quantity } : item),
          }
        })
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

  async function remove(lineIdOrSkuId: string): Promise<void> {
    const scope = currentScope()
    const operationVersion = beginOperation(scope)
    if (operationVersion === null) return
    try {
      if (scope.customerId) {
        const line = customerCart.value?.items.find(item => item.lineId === lineIdOrSkuId)
        const path = line
          ? `/api/v1/customer/cart/lines/${encodeURIComponent(lineIdOrSkuId)}`
          : `/api/v1/customer/cart/items/${encodeURIComponent(lineIdOrSkuId)}`
        const result = await customerApi.request<CustomerCartMutation>(path, { method: 'DELETE' })
        if (operationIsCurrent(scope, operationVersion)) customerCart.value = result.cart
      }
      else {
        const snapshot = await mutateGuestCart(scope, operationVersion, store => store.version === 2
          ? { ...store, unclaimedItems: store.unclaimedItems.filter(item => item.skuId !== lineIdOrSkuId) }
          : { ...store, unclaimedItems: store.unclaimedItems.filter(item => item.lineId !== lineIdOrSkuId) })
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

  async function quote(items: CartRequestItems): Promise<CheckoutQuote> {
    const scope = currentScope()
    const result = await customerApi.request<CheckoutQuote>('/api/v1/checkout/quote', {
      method: 'POST', body: isLineItems(items) ? { version: 2, items } : { items },
    })
    if (!scopeIsCurrent(scope)) throw new CustomerApiError(0, 'STALE_IDENTITY', '登录状态已变化，请重新获取报价。')
    return result
  }

  function checkoutPath(items: CartRequestItems): string {
    if (isLineItems(items)) {
      try {
        return saveCheckoutSelection(items)
      } catch {
        errorState.value = '浏览器暂时无法保存结算选择，请启用会话存储后重试。'
        return '/cart'
      }
    }
    // Existing legacy links remain replayable without rewriting their body.
    return `/checkout?items=${encodeURIComponent(JSON.stringify(items))}`
  }

  async function prepareCheckoutPath(items: CartRequestItems): Promise<string> {
    if (!items.length) throw new Error('请先选择要结算的购买行。')
    const scope = currentScope()
    if (!scopeIsActive(scope)) throw new Error('购物车身份已变化，请刷新后重新选择。')
    if (scope.customerId || isLineItems(items)) return checkoutPath(items)

    // Only a deliberate cart checkout upgrades old unclaimed guest rows. Old
    // claimed merge batches retain their owner, merge ID, and exact v1 items.
    const operationVersion = beginOperation(scope)
    if (operationVersion === null) throw new Error('购物车正在更新，请稍后重新结算。')
    try {
      const snapshot = readGuestSnapshot()
      if (!snapshot.storageOk || isLineItems(snapshot.items)) {
        throw new Error('游客购物车已变化，请重新选择购买行。')
      }
      const selected = new Map<string, number>()
      for (const item of items) {
        if (!isUuid(item.skuId) || !Number.isSafeInteger(item.quantity)
          || item.quantity < 1 || item.quantity > maxLineQuantity || selected.has(item.skuId)) {
          throw new Error('所选商品数量或身份无效，请重新选择。')
        }
        selected.set(item.skuId, item.quantity)
      }
      const upgraded = await withGuestStorageLock(() => {
        if (!operationIsCurrent(scope, operationVersion) || scope.customerId
          || guestRevision.value !== snapshot.revision) {
          throw new Error('购物车身份已变化，请重新选择购买行。')
        }
        const stored = readStoredGuestCart()
        if (!stored.ok || stored.raw !== snapshot.raw || stored.store.version !== 2) {
          throw new Error('游客购物车已变化，请重新选择购买行。')
        }
        const selectedRows = [...selected].map(([skuId, quantity]) => {
          const row = stored.store.unclaimedItems.find(item => item.skuId === skuId)
          if (!row || row.quantity !== quantity) throw new Error('所选购买行已变化，请重新选择。')
          return row
        })
        const next = upgradeGuestStore(stored.store)
        const upgradedRows = selectedRows.map(row => next.unclaimedItems.find(item => item.skuId === row.skuId)!)
        try {
          if (localStorage.getItem(storageKey) !== stored.raw) throw new Error('changed')
        } catch {
          throw new Error('本机购物车已变化，请重新选择购买行。')
        }
        writeGuestStore(next)
        const redirects = { ...mergedGuestLineTargets.value }
        for (const row of stored.store.unclaimedItems) {
          const line = next.unclaimedItems.find(item => item.skuId === row.skuId)!
          redirects[`legacy:${row.skuId}`] = line.lineId
        }
        mergedGuestLineTargets.value = redirects
        return {
          selectedItems: cloneItems(upgradedRows),
          snapshot: {
            items: cloneItems(next.unclaimedItems), raw: JSON.stringify(next),
            revision: guestRevision.value, storageOk: true,
          } satisfies GuestCartSnapshot,
        }
      }, true)
      if (!operationIsCurrent(scope, operationVersion)) throw new Error('购物车身份已变化，请重新选择购买行。')
      const path = checkoutPath(upgraded.selectedItems)
      if (path === '/cart') throw new Error(errorState.value ?? '浏览器无法保存结算选择，请重试。')
      const refreshed = await refreshGuestQuote(scope, upgraded.snapshot)
      if (!refreshed || !operationIsCurrent(scope, operationVersion)) {
        throw new Error('购物车报价已变化，请重新选择购买行。')
      }
      return path
    } catch (error) {
      if (operationIsCurrent(scope, operationVersion)) {
        errorState.value = readError(error, '无法安全准备结算，请重试。')
      }
      throw error
    } finally {
      finishOperation(scope, operationVersion)
    }
  }

  function resolveLineKey(key: string): string {
    return mergedGuestLineTargets.value[key] ?? key
  }

  return {
    guestItems,
    customerCart,
    guestQuote,
    cartView,
    currentLineCount,
    currentQuantity,
    ready,
    canAddToCart,
    busy,
    errorMessage,
    noticeMessage,
    syncSession,
    refresh,
    add,
    addWithDraft,
    editPurchaseFormLine,
    replaceGuestPurchaseFormLine,
    setQuantity,
    remove,
    clear,
    quote,
    checkoutPath,
    prepareCheckoutPath,
    resolveLineKey,
  }
}
