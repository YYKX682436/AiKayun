<script setup lang="ts">
import type { CartSkuQuantity, CheckoutQuote, CheckoutQuoteItem, CheckoutRequestLineV2, GuestOrderSession } from '@aikayun/contracts'
import type { CreateOrderResult } from '@aikayun/contracts'
import { CheckoutConflictError, CustomerApiError } from '~/composables/useCustomerApi'
import { loadCheckoutSelection } from '~/utils/checkoutSelection'
import {
  completeOrderIntentV2, findOrderIntentBySelectionId, findOrderIntentV2, hasOrderIntentV2,
  PendingOwnerConflictError, prepareOrderIntentV2, rejectOrderIntentV2,
  withOrderSubmissionLock,
} from '~/utils/checkoutOrderIntent'
import type { PendingOrderIntentV2 } from '~/utils/checkoutOrderIntent'
import type { OrderIntentV2 } from '~/utils/checkoutOrderIntent'
import { bindNewLegacyGuestOrder, forgetCompletedLegacyGuestOrder, legacyGuestOrderOwner } from '~/utils/legacyCheckoutGuestOwner'

const route = useRoute()
const customerApi = useCustomerApi()
type CheckoutRequest = typeof customerApi.request
const shoppingCart = useShoppingCart()
const quote = ref<CheckoutQuote | null>(null)
const busy = ref(false)
const submitting = ref(false)
const errorMessage = ref('')
const submitError = ref('')
const pendingOwnerBlocked = ref(false)
const sharedIntentRevision = ref(0)
let requestSequence = 0
const clientReady = ref(false)
type CheckoutSelection =
  | { version: 1; items: CartSkuQuantity[] }
  | { version: 2; items: CheckoutRequestLineV2[] }
const orderIntentStoreV2Key = 'aikayun-order-intents-v2'

useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

useSeoMeta({ title: '结算报价预览', description: '查看所选商品的当前结算报价。', robots: 'noindex, nofollow' })

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function parseRequestedItems(): CheckoutSelection | null {
  const intentId = route.query.intent
  let raw = route.query.items
  if (typeof intentId === 'string') {
    if (!clientReady.value) return null
    try {
      const saved = loadCheckoutSelection(intentId)
      raw = saved ? JSON.stringify(saved) : null
    } catch {
      return null
    }
  }
  if (typeof raw !== 'string' || raw.length > 16000) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50) return null
    const legacyItems: CartSkuQuantity[] = []
    const lineItems: CheckoutRequestLineV2[] = []
    const seenLineIds = new Set<string>()
    let requestVersion: 1 | 2 | null = null
    const skuTotals = new Map<string, number>()
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || !('skuId' in item) || !('quantity' in item)) return null
      const skuId = String(item.skuId)
      const quantity = item.quantity
      if (!isUuid(skuId)
        || !Number.isSafeInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 99) return null
      const total = (skuTotals.get(skuId) ?? 0) + (quantity as number)
      if (total > 99) return null
      skuTotals.set(skuId, total)
      if ('lineId' in item) {
        if (requestVersion === 1 || !isUuid(item.lineId) || seenLineIds.has(item.lineId)) return null
        requestVersion = 2
        seenLineIds.add(item.lineId)
        const hasDraftId = Object.hasOwn(item, 'draftId')
        const hasDraftRevision = Object.hasOwn(item, 'draftRevision')
        if (hasDraftId !== hasDraftRevision) return null
        if (hasDraftId && (item.draftId !== null || item.draftRevision !== null)
          && (!isUuid(item.draftId) || !Number.isSafeInteger(item.draftRevision) || (item.draftRevision as number) < 1)) return null
        if (Object.keys(item).some(key => !['lineId', 'skuId', 'quantity', 'draftId', 'draftRevision'].includes(key))) return null
        lineItems.push({ ...item } as CheckoutRequestLineV2)
      } else {
        if (requestVersion === 2 || Object.keys(item).some(key => !['skuId', 'quantity'].includes(key))) return null
        requestVersion = 1
        legacyItems.push({ skuId, quantity: quantity as number })
      }
    }
    // V2 requests need an opaque selection URL so a completed receipt can
    // remain bound to that exact operation across tabs and browser restarts.
    if (requestVersion === 2 && typeof intentId !== 'string') return null
    return requestVersion === 2 ? { version: 2, items: lineItems } : { version: 1, items: legacyItems }
  } catch {
    return null
  }
}

onMounted(() => { clientReady.value = true })

const requestedSelection = computed(() => {
  void sharedIntentRevision.value
  return parseRequestedItems()
})
const requestedItems = computed(() => requestedSelection.value?.items ?? null)
const isCustomer = computed(() => Boolean(customerApi.session.value?.customer.id))
const loginRedirect = computed(() => `/login?redirect=${encodeURIComponent(route.fullPath)}`)
const purchaseLoginRequired = computed(() => !isCustomer.value
  && Boolean(quote.value?.items.some(item => item.purchaseLimits.requiresLogin)))

function statusLabel(item: CheckoutQuoteItem): string {
  switch (item.reason) {
    case 'sku_not_found': return '商品规格已不存在'
    case 'product_not_active': return item.productStatus === 'paused' ? '商品已暂停' : item.productStatus === 'archived' ? '商品已归档' : '商品暂不可购买'
    case 'sku_disabled': return '此规格已停用'
    case 'sku_retired': return '此规格已永久退役'
    case 'specification_invalid': return '规格组合已变化'
    case 'inventory_not_configured': return '库存尚未配置'
    case 'insufficient_inventory': return `库存不足（可售 ${item.availableQuantity ?? 0} 件）`
    case 'inventory_not_ready': return '库存来源尚未就绪'
    case 'fulfillment_not_ready': return '发货能力尚未开放'
    case 'guest_checkout_disabled': return '游客结算已关闭'
    case 'guest_free_claim_disabled': return '游客免费领取已关闭'
    case 'purchase_limit_exceeded': return '超过商品或规格限购额度'
    case 'login_required_for_purchase_limit': return '该商品需要登录后购买'
    case 'purchase_form_invalid': return '购买资料已失效，请重新确认'
    case 'purchase_form_version_changed': return '填写模板已变化，请重新确认'
    case 'purchase_form_required': return '此商品需要填写购买资料'
    case 'product_not_found': return '商品已删除或无法读取'
    default: return item.canPurchase ? '可继续报价' : '暂不可购买'
  }
}

async function loadQuote(items = requestedItems.value) {
  const sequence = ++requestSequence
  errorMessage.value = ''
  quote.value = null
  if (!items) {
    busy.value = false
    errorMessage.value = '报价链接无效，请返回购物车重新选择商品。'
    return
  }
  busy.value = true
  try {
    const result = await shoppingCart.quote(items)
    if (sequence === requestSequence) quote.value = result
  } catch (error) {
    if (sequence === requestSequence) errorMessage.value = error instanceof Error ? error.message : '报价暂时无法加载，请重试。'
  } finally {
    if (sequence === requestSequence) busy.value = false
  }
}

function canonicalItems(items: CartSkuQuantity[]): CartSkuQuantity[] {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.skuId, (counts.get(item.skuId) ?? 0) + item.quantity)
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([skuId, quantity]) => ({ skuId, quantity }))
}

async function currentOrderOwnerId(request: CheckoutRequest): Promise<string> {
  const customerId = customerApi.session.value?.customer.id
  if (customerId) return customerId
  const session = await request<GuestOrderSession>('/api/v1/guest/session', { method: 'POST' })
  if (!isUuid(session.sessionId)) throw new Error('游客会话无法确认，请稍后重试。')
  return `guest:${session.sessionId}`
}

function orderIntentKey(items: CartSkuQuantity[], ownerId: string, actualOwnerId: string): string {
  if (!import.meta.client) throw new Error('请在浏览器中继续创建订单。')
  const fingerprint = JSON.stringify(canonicalItems(items))
  const storageKey = `aikayun-order-intent-v1:${ownerId}:${fingerprint}`
  let existing: string | null
  try {
    existing = sessionStorage.getItem(storageKey)
  } catch {
    throw new Error('浏览器暂时无法保存安全的提交标识。请启用会话存储后重试。')
  }
  if (existing && /^[0-9a-f-]{36}$/iu.test(existing)) {
    const boundOwner = ownerId === 'guest' ? legacyGuestOrderOwner(existing) : null
    if (boundOwner && boundOwner !== actualOwnerId) throw new PendingOwnerConflictError()
    return existing
  }
  const key = crypto.randomUUID()
  if (ownerId === 'guest') bindNewLegacyGuestOrder(key, actualOwnerId)
  try {
    sessionStorage.setItem(storageKey, key)
  } catch {
    throw new Error('浏览器暂时无法保存安全的提交标识。请启用会话存储后重试。')
  }
  return key
}

function removeOrderIntent(items: CartSkuQuantity[], ownerId: string, idempotencyKey: string): void {
  const storageKey = `aikayun-order-intent-v1:${ownerId}:${JSON.stringify(canonicalItems(items))}`
  try {
    sessionStorage.removeItem(storageKey)
    if (ownerId === 'guest') forgetCompletedLegacyGuestOrder(idempotencyKey)
  } catch { /* The completed order remains available through order history. */ }
}

function routeSelectionId(): string | null {
  return typeof route.query.intent === 'string' && isUuid(route.query.intent) ? route.query.intent : null
}

function guestOrderHeaders(ownerId: string): Record<string, string> | undefined {
  return ownerId.startsWith('guest:') ? { 'x-aikayun-guest-session-id': ownerId.slice('guest:'.length) } : undefined
}

async function submitPendingV2(intent: PendingOrderIntentV2, request: CheckoutRequest): Promise<string> {
  let result: CreateOrderResult
  try {
    result = await request<CreateOrderResult>('/api/v1/checkout/orders', {
      method: 'POST',
      headers: guestOrderHeaders(intent.ownerId),
      body: { version: 2, idempotencyKey: intent.idempotencyKey, quoteToken: intent.quoteToken, items: intent.items },
    })
  } catch (error) {
    if (error instanceof CheckoutConflictError) {
      const completed = await rejectOrderIntentV2(intent)
      if (completed) return completed.orderId
    }
    throw error
  }
  // The original pending request stays replayable if this local receipt write fails.
  await completeOrderIntentV2(intent, result.order.id)
  return result.order.id
}

async function processV2Intent(
  selection: CheckoutSelection | null, identityAtStart: number,
  quoteToken: string | null,
): Promise<string | null> {
  return withOrderSubmissionLock(() => customerApi.withCheckoutIdentity(async (request) => {
    if (identityAtStart !== customerApi.identityVersion.value) return null
    const ownerId = await currentOrderOwnerId(request)
    if (identityAtStart !== customerApi.identityVersion.value) return null
    let intent: OrderIntentV2 | null
    if (quoteToken && selection?.version === 2) {
      intent = await prepareOrderIntentV2(selection.items, ownerId, quoteToken, routeSelectionId())
    } else if (selection?.version === 2) {
      intent = await findOrderIntentV2(selection.items, ownerId, routeSelectionId())
    } else {
      const selectionId = routeSelectionId()
      intent = selectionId ? await findOrderIntentBySelectionId(selectionId, ownerId) : null
    }
    if (!intent || intent.state === 'rejected') return null
    if (intent.state === 'completed') return intent.orderId
    if (identityAtStart !== customerApi.identityVersion.value) return null
    return submitPendingV2(intent, request)
  }))
}

async function showCompletedOrder(orderId: string, identityAtStart: number): Promise<void> {
  if (identityAtStart !== customerApi.identityVersion.value) return
  await navigateTo(`/orders/${orderId}`)
}

async function createOrder() {
  const selection = requestedSelection.value
  const items = requestedItems.value
  const currentQuote = quote.value
  if (submitting.value || !selection || !items || !currentQuote?.canContinue || !currentQuote.quoteToken) return
  const identityAtStart = customerApi.identityVersion.value
  const identityIsCurrent = () => identityAtStart === customerApi.identityVersion.value
  submitting.value = true
  submitError.value = ''
  try {
    if (selection.version === 2) {
      const orderId = await processV2Intent(selection, identityAtStart, currentQuote.quoteToken)
      if (orderId) await showCompletedOrder(orderId, identityAtStart)
    } else {
      const completed = await withOrderSubmissionLock(() => customerApi.withCheckoutIdentity(async (request) => {
        if (!identityIsCurrent()) return null
        const actualOwnerId = await currentOrderOwnerId(request)
        if (!identityIsCurrent()) return null
        // Keep the historical v1 storage key; new guest keys have a separate
        // owner receipt so an unknown result cannot cross a later guest session.
        const ownerId = actualOwnerId.startsWith('guest:') ? 'guest' : actualOwnerId
        const idempotencyKey = orderIntentKey(selection.items, ownerId, actualOwnerId)
        const result = await request<CreateOrderResult>('/api/v1/checkout/orders', {
          method: 'POST', headers: guestOrderHeaders(actualOwnerId),
          body: { idempotencyKey, quoteToken: currentQuote.quoteToken, items },
        })
        return { result, ownerId, idempotencyKey }
      }))
      if (!completed || !identityIsCurrent()) return
      const orderPath = `/orders/${completed.result.order.id}`
      await navigateTo(orderPath)
      if (identityIsCurrent() && route.path === orderPath) removeOrderIntent(selection.items, completed.ownerId, completed.idempotencyKey)
    }
  } catch (error) {
    if (!identityIsCurrent()) return
    if (error instanceof PendingOwnerConflictError || (error instanceof CustomerApiError && error.code === 'GUEST_SESSION_CHANGED')) pendingOwnerBlocked.value = true
    if (error instanceof CheckoutConflictError) {
      quote.value = error.currentQuote
      submitError.value = `${error.message} 已显示最新报价，请再次确认后重新提交。`
    } else {
      submitError.value = error instanceof CustomerApiError || error instanceof Error
        ? error.message
        : '订单暂时未能创建。请稍后重试，重复提交会返回同一订单。'
    }
  } finally {
    submitting.value = false
  }
}

async function replayPendingV2(selection: CheckoutSelection | null): Promise<void> {
  if (!import.meta.client || selection?.version === 1 || submitting.value || !customerApi.sessionResolved.value) return
  const identityAtStart = customerApi.identityVersion.value
  try {
    if (!hasOrderIntentV2(selection?.version === 2 ? selection.items : null, routeSelectionId())) return
    submitting.value = true
    const orderId = await processV2Intent(selection, identityAtStart, null)
    if (orderId) await showCompletedOrder(orderId, identityAtStart)
  } catch (error) {
    if (identityAtStart !== customerApi.identityVersion.value) return
    if (error instanceof PendingOwnerConflictError || (error instanceof CustomerApiError && error.code === 'GUEST_SESSION_CHANGED')) pendingOwnerBlocked.value = true
    if (error instanceof CheckoutConflictError) {
      quote.value = error.currentQuote
      submitError.value = `${error.message} 已显示最新报价，请再次确认。`
    } else if (error instanceof PendingOwnerConflictError || (error instanceof CustomerApiError && error.code === 'GUEST_SESSION_CHANGED')) {
      submitError.value = error.message
    } else {
      submitError.value = '上次提交结果尚未确认。保留原请求标识，继续重试会先核对原订单。'
    }
  } finally {
    submitting.value = false
  }
}

watch(
  [requestedSelection, () => customerApi.identityVersion.value, () => customerApi.sessionResolved.value, clientReady],
  ([selection]) => {
    if (!import.meta.client) return
    if (typeof route.query.intent === 'string' && !clientReady.value) return
    pendingOwnerBlocked.value = false
    void (async () => {
      await replayPendingV2(selection)
      if (route.path === '/checkout') await loadQuote(selection?.items ?? null)
    })()
  },
  { immediate: true, flush: 'sync' },
)

function onSharedIntentChange(event: StorageEvent): void {
  if (event.key === orderIntentStoreV2Key) sharedIntentRevision.value += 1
}

onMounted(() => window.addEventListener('storage', onSharedIntentChange))
onBeforeUnmount(() => window.removeEventListener('storage', onSharedIntentChange))

watch(() => customerApi.identityVersion.value, () => {
  submitError.value = ''
  pendingOwnerBlocked.value = false
}, { flush: 'sync' })

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
</script>

<template>
  <UContainer class="py-7 sm:py-10">
    <main
      id="main-content"
      class="mx-auto max-w-4xl"
    >
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p class="text-sm font-medium text-primary">
            购物车
          </p>
          <h1 class="mt-1 text-2xl font-semibold tracking-tight text-highlighted sm:text-3xl">
            确认订单
          </h1>
          <p class="mt-2 text-sm text-muted">
            提交时会在数据库事务中重新核对价格、购买资格并预留数量库存。
          </p>
        </div>
        <NuxtLink
          to="/cart"
          class="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <UIcon
            name="i-lucide-arrow-left"
            class="size-4"
            aria-hidden="true"
          />
          返回购物车
        </NuxtLink>
      </div>

      <UAlert
        class="mt-6"
        color="info"
        variant="subtle"
        icon="i-lucide-shield-check"
        title="下单前会重新验证"
        description="报价用于预览；只有商家明确开启人工数字交付的商品可以下单。下单会原子创建订单并预留数量库存。当前正价订单只会进入待付款，支付宝和微信支付尚未开放。"
      />

      <UAlert
        v-if="quote?.policyReasons.includes('guest_checkout_disabled') || quote?.policyReasons.includes('guest_free_claim_disabled')"
        class="mt-4"
        color="warning"
        variant="subtle"
        title="此商品需要登录后继续"
        description="店铺当前关闭了对应的游客结算或免费领取方式。登录后可以重新检查当前报价。"
      >
        <template #actions>
          <UButton
            :to="loginRedirect"
            color="primary"
            variant="outline"
          >
            登录后继续
          </UButton>
        </template>
      </UAlert>

      <UAlert
        v-if="purchaseLoginRequired"
        class="mt-4"
        color="warning"
        variant="subtle"
        title="该商品需要登录后购买"
        description="登录后会按当前账号重新核对累计购买数量和滚动24小时额度；本次结算商品会保留。"
      >
        <template #actions>
          <UButton
            :to="loginRedirect"
            color="primary"
            variant="outline"
          >
            登录后继续
          </UButton>
        </template>
      </UAlert>

      <UAlert
        v-if="errorMessage"
        class="mt-4"
        color="error"
        variant="subtle"
        :title="errorMessage"
        role="alert"
        aria-live="assertive"
      >
        <template #actions>
          <UButton
            color="error"
            variant="outline"
            :loading="busy"
            @click="loadQuote()"
          >
            重试报价
          </UButton>
        </template>
      </UAlert>

      <UAlert
        v-if="submitError"
        class="mt-4"
        color="error"
        variant="soft"
        :title="submitError"
        role="alert"
        aria-live="assertive"
      />

      <div
        v-if="busy && !quote"
        class="mt-6 space-y-3"
        aria-label="正在计算报价"
        aria-busy="true"
      >
        <div
          v-for="index in 2"
          :key="index"
          class="h-24 animate-pulse rounded-xl border border-default bg-elevated motion-reduce:animate-none"
        />
      </div>

      <section
        v-else-if="quote"
        class="mt-6 grid gap-5"
      >
        <ul
          class="space-y-3"
          aria-label="报价商品"
        >
          <li
            v-for="(item, index) in quote.items"
            :key="item.lineId ?? `legacy:${item.skuId}`"
            class="grid min-w-0 gap-3 rounded-xl border border-default bg-elevated p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5"
          >
            <div class="min-w-0">
              <h2 class="break-words font-medium text-highlighted">
                {{ item.productName ?? '商品信息暂不可用' }}
              </h2>
              <p class="mt-1 text-xs text-muted">
                购买行 {{ index + 1 }}<span v-if="item.draftId"> · 已绑定填写资料</span>
              </p>
              <p
                v-if="item.options.length"
                class="mt-1 text-sm text-muted"
              >
                {{ item.options.map(option => `${option.groupName}：${option.valueName}`).join(' / ') }}
              </p>
              <p class="mt-1 break-all text-sm text-muted">
                数量：{{ item.quantity }} <span v-if="item.skuCode">· SKU {{ item.skuCode }}</span>
              </p>
              <UBadge
                class="mt-2"
                :color="item.canPurchase ? 'success' : 'warning'"
                variant="soft"
              >
                {{ statusLabel(item) }}
              </UBadge>
              <StorefrontPurchaseLimitNotice
                class="mt-3"
                :purchase-limits="item.purchaseLimits"
              />
            </div>
            <dl class="grid grid-cols-2 gap-x-5 text-right text-sm sm:min-w-36 sm:grid-cols-1 sm:gap-y-1">
              <div>
                <dt class="text-muted">
                  单价
                </dt><dd class="tabular-nums text-highlighted">
                  {{ item.unitPrice === null ? '暂不可计价' : `¥${item.unitPrice}` }}
                </dd>
              </div>
              <div>
                <dt class="text-muted">
                  小计
                </dt><dd class="font-medium tabular-nums text-highlighted">
                  {{ item.lineTotal === null ? '暂不可计价' : `¥${item.lineTotal}` }}
                </dd>
              </div>
            </dl>
          </li>
        </ul>

        <div class="grid gap-4 rounded-xl border border-default bg-elevated p-4 sm:grid-cols-[1fr_auto] sm:items-end sm:p-5">
          <dl class="grid gap-2 text-sm">
            <div class="flex justify-between gap-4">
              <dt class="text-muted">
                商品金额
              </dt><dd class="tabular-nums text-highlighted">
                ¥{{ quote.pricedSubtotal }}
              </dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-muted">
                报价时间
              </dt><dd class="text-right text-muted">
                {{ formatDate(quote.quotedAt) }}
              </dd>
            </div>
          </dl>
          <div class="text-right">
            <p class="text-sm text-muted">
              {{ quote.totalComplete ? '当前报价合计' : '当前报价合计不完整' }}
            </p>
            <p class="mt-1 text-2xl font-semibold tabular-nums text-primary">
              {{ quote.totalAmount === null ? '无法完整计价' : `¥${quote.totalAmount}` }}
            </p>
          </div>
        </div>

        <p
          v-if="!isCustomer && !quote.guestCheckoutEnabled && quote.policyReasons.includes('guest_checkout_disabled')"
          class="text-sm text-muted"
        >
          登录后会以顾客身份再次读取商品价格和库存。当前页面仍未提交订单。
        </p>
        <div class="flex flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-refresh-cw"
            :loading="busy"
            @click="loadQuote()"
          >
            重新报价
          </UButton>
          <UButton
            to="/cart"
            color="primary"
            variant="soft"
          >
            返回购物车调整
          </UButton>
          <UButton
            v-if="quote.canContinue"
            color="primary"
            icon="i-lucide-lock-keyhole"
            :loading="submitting"
            :disabled="submitting || busy || pendingOwnerBlocked"
            @click="createOrder"
          >
            {{ submitting ? '正在安全创建订单' : '提交订单' }}
          </UButton>
        </div>
      </section>
    </main>
  </UContainer>
</template>
