import type {
  CartSkuQuantity,
  CheckoutQuote,
  CustomerCart,
  CustomerCartMutation,
  CustomerCartMergeBody,
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
  const ready = useState('storefront-cart-ready', () => false)
  const syncing = useState('storefront-cart-syncing', () => false)
  const busy = useState('storefront-cart-busy', () => false)
  const errorMessage = useState<string | null>('storefront-cart-error', () => null)
  const noticeMessage = useState<string | null>('storefront-cart-notice', () => null)

  const isCustomer = computed(() => Boolean(customerApi.session.value?.customer.id))
  const cartView = computed(() => isCustomer.value ? customerCart.value : guestQuote.value)
  const currentLineCount = computed(() => isCustomer.value
    ? customerCart.value?.itemCount ?? 0
    : guestItems.value.length)
  const currentQuantity = computed(() => isCustomer.value
    ? customerCart.value?.totalQuantity ?? 0
    : guestItems.value.reduce((total, item) => total + item.quantity, 0))

  function readStorage(): GuestCartEnvelope {
    if (!import.meta.client) return { version: 1, mergeId: '00000000-0000-4000-8000-000000000000', items: [] }
    let raw: string | null = null
    try { raw = localStorage.getItem(storageKey) } catch { /* Browser storage may be unavailable. */ }
    const envelope = parseGuestCart(raw)
    if (raw && envelope.items.length === 0) {
      try { localStorage.removeItem(storageKey) } catch { /* Best effort only. */ }
    }
    return envelope
  }

  function writeStorage(items: CartSkuQuantity[], mergeId = newId()): GuestCartEnvelope {
    const envelope: GuestCartEnvelope = { version: 1, mergeId, items }
    if (import.meta.client) {
      try { localStorage.setItem(storageKey, JSON.stringify(envelope)) } catch { /* The visible cart still works for this page view. */ }
    }
    guestItems.value = items
    return envelope
  }

  function clearStorage(): void {
    if (import.meta.client) {
      try { localStorage.removeItem(storageKey) } catch { /* Best effort only. */ }
    }
    guestItems.value = []
    guestQuote.value = null
  }

  async function refreshGuestQuote(): Promise<void> {
    if (!guestItems.value.length) {
      guestQuote.value = null
      errorMessage.value = null
      return
    }
    try {
      guestQuote.value = await customerApi.request<CheckoutQuote>('/api/v1/checkout/quote', {
        method: 'POST',
        body: { items: guestItems.value },
      })
      errorMessage.value = null
    } catch (error) {
      errorMessage.value = error instanceof CustomerApiError ? error.message : '购物车报价暂时无法加载，请重试。'
      throw error
    }
  }

  async function refreshCustomerCart(): Promise<void> {
    try {
      customerCart.value = await customerApi.request<CustomerCart>('/api/v1/customer/cart')
      errorMessage.value = null
    } catch (error) {
      if (error instanceof CustomerApiError && error.status === 401) {
        customerCart.value = null
      }
      errorMessage.value = error instanceof CustomerApiError ? error.message : '购物车暂时无法加载，请重试。'
      throw error
    }
  }

  async function refresh(): Promise<void> {
    if (isCustomer.value) await refreshCustomerCart()
    else await refreshGuestQuote()
  }

  async function syncSession(): Promise<void> {
    if (!import.meta.client || syncing.value || !customerApi.sessionResolved.value) return
    const customerId = customerApi.session.value?.customer.id ?? null
    if (ready.value && ownerId.value === customerId) return

    syncing.value = true
    ready.value = false
    errorMessage.value = null
    noticeMessage.value = null
    customerCart.value = null
    guestQuote.value = null
    ownerId.value = customerId

    try {
      if (customerId) {
        const guest = readStorage()
        guestItems.value = guest.items
        if (guest.items.length) {
          try {
            const mergeBody: CustomerCartMergeBody = { mergeId: guest.mergeId, items: guest.items }
            const merged = await customerApi.request<CustomerCartMutation>('/api/v1/customer/cart/merge', {
              method: 'POST', body: mergeBody,
            })
            clearStorage()
            customerCart.value = merged.cart
            if (merged.skippedSkuIds.length) {
              noticeMessage.value = `${merged.skippedSkuIds.length} 件已删除的商品规格未能合并。`
            } else if (merged.changed) {
              noticeMessage.value = '游客购物车已合并到当前账户。'
            }
          } catch (error) {
            errorMessage.value = error instanceof CustomerApiError
              ? `游客购物车合并未完成：${error.message} 本机购物车仍已保留。`
              : '游客购物车合并未完成，本机购物车仍已保留。'
          }
        }
        try {
          await refreshCustomerCart()
        } catch { /* Keep the customer cart hidden behind the retry state. */ }
      } else {
        customerCart.value = null
        const guest = readStorage()
        guestItems.value = guest.items
        if (guest.items.length) {
          try { await refreshGuestQuote() } catch { /* The local list remains available for retry. */ }
        }
      }
    } finally {
      ready.value = true
      syncing.value = false
    }
  }

  async function add(skuId: string, quantity: number): Promise<void> {
    if (!isUuid(skuId) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > maxLineQuantity) {
      errorMessage.value = '请选择有效商品规格和数量。'
      return
    }
    if (busy.value) return
    busy.value = true
    errorMessage.value = null
    try {
      if (isCustomer.value) {
        const result = await customerApi.request<CustomerCartMutation>('/api/v1/customer/cart/items', {
          method: 'POST', body: { skuId, quantity },
        })
        customerCart.value = result.cart
      } else {
        const current = guestItems.value.find(item => item.skuId === skuId)?.quantity ?? 0
        const next = current + quantity
        if (next > maxLineQuantity) throw new Error(`同一规格数量不能超过 ${maxLineQuantity}。`)
        if (!current && guestItems.value.length >= maxCartLines) throw new Error(`购物车最多包含 ${maxCartLines} 个规格。`)
        const nextItems = current
          ? guestItems.value.map(item => item.skuId === skuId ? { skuId, quantity: next } : item)
          : [...guestItems.value, { skuId, quantity }]
        writeStorage(nextItems)
        await refreshGuestQuote()
      }
      noticeMessage.value = '已加入购物车。'
    } catch (error) {
      errorMessage.value = error instanceof CustomerApiError || error instanceof Error
        ? error.message
        : '暂时无法加入购物车，请重试。'
    } finally {
      busy.value = false
    }
  }

  async function setQuantity(skuId: string, quantity: number): Promise<void> {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > maxLineQuantity || busy.value) return
    busy.value = true
    errorMessage.value = null
    try {
      if (isCustomer.value) {
        const result = await customerApi.request<CustomerCartMutation>(`/api/v1/customer/cart/items/${encodeURIComponent(skuId)}`, {
          method: 'PATCH', body: { quantity },
        })
        customerCart.value = result.cart
      } else {
        writeStorage(guestItems.value.map(item => item.skuId === skuId ? { skuId, quantity } : item))
        await refreshGuestQuote()
      }
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '数量更新失败，请重试。'
    } finally {
      busy.value = false
    }
  }

  async function remove(skuId: string): Promise<void> {
    if (busy.value) return
    busy.value = true
    errorMessage.value = null
    try {
      if (isCustomer.value) {
        const result = await customerApi.request<CustomerCartMutation>(`/api/v1/customer/cart/items/${encodeURIComponent(skuId)}`, { method: 'DELETE' })
        customerCart.value = result.cart
      } else {
        writeStorage(guestItems.value.filter(item => item.skuId !== skuId))
        await refreshGuestQuote()
      }
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '移除商品失败，请重试。'
    } finally {
      busy.value = false
    }
  }

  async function clear(): Promise<void> {
    if (busy.value) return
    busy.value = true
    errorMessage.value = null
    try {
      if (isCustomer.value) {
        const result = await customerApi.request<CustomerCartMutation>('/api/v1/customer/cart', { method: 'DELETE' })
        customerCart.value = result.cart
      } else {
        clearStorage()
      }
      noticeMessage.value = null
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '清空购物车失败，请重试。'
    } finally {
      busy.value = false
    }
  }

  async function quote(items: CartSkuQuantity[]): Promise<CheckoutQuote> {
    return customerApi.request<CheckoutQuote>('/api/v1/checkout/quote', {
      method: 'POST', body: { items },
    })
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
