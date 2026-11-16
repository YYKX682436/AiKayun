<script setup lang="ts">
import type { CheckoutQuote, CheckoutQuoteItem, CheckoutRequestLineV2, GuestOrderSession } from '@aikayun/contracts'
import type { CreateOrderResult } from '@aikayun/contracts'
import { CheckoutConflictError, CustomerApiError } from '~/composables/useCustomerApi'
import { loadCheckoutSelection } from '~/utils/checkoutSelection'
import { saveFreshCheckoutSelection } from '~/utils/checkoutSelection'
import {
  completeOrderIntentV2, findAnyOrderIntentBySelectionId, findOrderIntentBySelectionId, findOrderIntentV2, hasOrderIntentV2,
  PendingOwnerConflictError, prepareOrderIntentV2, rejectOrderIntentV2,
  withOrderSubmissionLock,
} from '~/utils/checkoutOrderIntent'
import type { PendingOrderIntentV2 } from '~/utils/checkoutOrderIntent'
import type { OrderIntentV2 } from '~/utils/checkoutOrderIntent'

const route = useRoute()
const router = useRouter()
const customerApi = useCustomerApi()
type CheckoutRequest = typeof customerApi.request
const quote = ref<CheckoutQuote | null>(null)
const busy = ref(false)
const errorMessage = ref('')
const submitError = ref('')
const pendingOwnerBlocked = ref(false)
let requestSequence = 0
const clientReady = ref(false)
type CheckoutSelection = { version: 2; items: CheckoutRequestLineV2[] }
type CheckoutOperationContext = {
  selectionId: string | null
  requestVersion: 2 | null
  selection: CheckoutSelection | null
  selectionFingerprint: string | null
  quoteToken: string | null
  identityVersion: number
  pageGeneration: number
  routeFullPath: string
}
const orderIntentStoreV2Key = 'aikayun-order-intents-v2'
const pageGeneration = ref(0)
const activeSubmissionGeneration = ref<number | null>(null)
const submitting = computed(() => activeSubmissionGeneration.value === pageGeneration.value)
const quoteGeneration = ref<number | null>(null)
let pageDisposed = false

if (import.meta.server) useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

useSeoMeta({ title: '结算报价预览', description: '查看所选商品的当前结算报价。', robots: 'noindex, nofollow' })

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function parseRequestedItems(): CheckoutSelection | null {
  const intentId = route.query.intent
  if (typeof intentId !== 'string' || !isUuid(intentId)) return null
  if (!clientReady.value) return null
  try {
    const raw = loadCheckoutSelection(intentId)
    if (!raw || !Array.isArray(raw) || raw.length !== 1) return null
    const item = raw[0] as { lineId?: unknown; skuId?: unknown; quantity?: unknown; draftId?: unknown; draftRevision?: unknown }
    if (!item || typeof item !== 'object') return null
    const skuId = typeof item.skuId === 'string' ? item.skuId : ''
    const lineId = typeof item.lineId === 'string' ? item.lineId : ''
    const quantity = typeof item.quantity === 'number' ? item.quantity : 0
    if (!isUuid(skuId) || !isUuid(lineId) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) return null
    const hasDraftId = Object.hasOwn(item, 'draftId')
    const hasDraftRevision = Object.hasOwn(item, 'draftRevision')
    if (hasDraftId !== hasDraftRevision) return null
    const draftId = item.draftId
    const draftRevision = item.draftRevision
    if (hasDraftId && (draftId !== null || draftRevision !== null)
      && (typeof draftId !== 'string' || !isUuid(draftId) || typeof draftRevision !== 'number' || !Number.isSafeInteger(draftRevision) || draftRevision < 1)) return null
    const line: CheckoutRequestLineV2 = {
      lineId,
      skuId,
      quantity,
      ...(typeof draftId === 'string' && typeof draftRevision === 'number' ? { draftId, draftRevision } : {}),
    }
    return { version: 2, items: [line] }
  } catch {
    return null
  }
}

onMounted(() => { clientReady.value = true })

const requestedSelection = computed(() => {
  return parseRequestedItems()
})
const requestedSelectionFingerprint = computed(() => selectionFingerprint(requestedSelection.value))
const isCustomer = computed(() => Boolean(customerApi.session.value?.customer.id))
const loginRedirect = computed(() => {
  let target = route.fullPath
  const selection = requestedSelection.value
  const selected = selection?.items[0]
  const selectedDraftId = selected && 'draftId' in selected && typeof selected.draftId === 'string' ? selected.draftId : null
  if (!isCustomer.value && selectedDraftId && route.query.claimGuestDraft !== '1') {
    const [pathname, query = ''] = target.split('?', 2)
    const params = new URLSearchParams(query)
    params.set('claimGuestDraft', '1')
    target = `${pathname}?${params.toString()}`
  }
  return `/login?redirect=${encodeURIComponent(target)}`
})
const purchaseLoginRequired = computed(() => !isCustomer.value
  && Boolean(quote.value?.items.some(item => item.purchaseLimits.requiresLogin)))
const claimSelectedGuestDraft = computed(() => route.query.claimGuestDraft === '1')

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
    case 'purchase_forms_paused': return '填写商品已暂停新订单'
    case 'product_not_found': return '商品已删除或无法读取'
    default: return item.canPurchase ? '可继续报价' : '暂不可购买'
  }
}

function purchaseEditPath(item: CheckoutQuoteItem): string {
  if (!item.productId) return '/'
  const query = new URLSearchParams({ skuId: item.skuId, quantity: String(item.quantity) })
  if (item.draftId) query.set('draftId', item.draftId)
  return `/products/${encodeURIComponent(item.productId)}?${query.toString()}`
}

const backToProductPath = computed(() => {
  const item = quote.value?.items[0]
  if (item) return purchaseEditPath(item)
  return '/'
})

function cloneSelection(selection: CheckoutSelection | null): CheckoutSelection | null {
  if (!selection) return null
  return { version: 2, items: selection.items.map(item => ({ ...item })) }
}

function selectionFingerprint(selection: CheckoutSelection | null): string | null {
  if (!selection) return null
  return `2:${JSON.stringify(selection.items)}`
}

function routeSelectionId(): string | null {
  return typeof route.query.intent === 'string' && isUuid(route.query.intent) ? route.query.intent : null
}

function captureOperationContext(
  selection: CheckoutSelection | null = requestedSelection.value,
  generation = pageGeneration.value,
  quoteToken: string | null = null,
): CheckoutOperationContext {
  const snapshot = cloneSelection(selection)
  return {
    selectionId: routeSelectionId(), requestVersion: snapshot?.version ?? null,
    selection: snapshot, selectionFingerprint: selectionFingerprint(snapshot), quoteToken,
    identityVersion: customerApi.identityVersion.value, pageGeneration: generation, routeFullPath: route.fullPath,
  }
}

function pageContextIsCurrent(context: CheckoutOperationContext): boolean {
  return !pageDisposed
    && router.currentRoute.value.path === '/checkout'
    && router.currentRoute.value.fullPath === context.routeFullPath
    && context.pageGeneration === pageGeneration.value
    && route.path === '/checkout'
    && route.fullPath === context.routeFullPath
    && routeSelectionId() === context.selectionId
    && selectionFingerprint(requestedSelection.value) === context.selectionFingerprint
    && customerApi.identityVersion.value === context.identityVersion
}

function identityContextIsCurrent(context: CheckoutOperationContext): boolean {
  return context.identityVersion === customerApi.identityVersion.value
}

async function loadQuote(context = captureOperationContext()) {
  if (!pageContextIsCurrent(context)) return
  const sequence = ++requestSequence
  errorMessage.value = ''
  quote.value = null
  quoteGeneration.value = null
  if (!context.selection || context.selection.items.length !== 1) {
    busy.value = false
    errorMessage.value = '结算链接无效或已过期，请返回商品页重新发起购买。'
    return
  }
  busy.value = true
  try {
    const result = await customerApi.request<CheckoutQuote>('/api/v1/checkout/quote', {
      method: 'POST',
      body: { version: 2, items: context.selection.items },
    })
    if (sequence === requestSequence && pageContextIsCurrent(context)) {
      quote.value = result
      quoteGeneration.value = context.pageGeneration
    }
  } catch (error) {
    if (sequence === requestSequence && pageContextIsCurrent(context)) {
      errorMessage.value = error instanceof Error ? error.message : '报价暂时无法加载，请重试。'
    }
  } finally {
    if (sequence === requestSequence && pageContextIsCurrent(context)) busy.value = false
  }
}

async function currentOrderOwnerId(request: CheckoutRequest): Promise<string> {
  const customerId = customerApi.session.value?.customer.id
  if (customerId) return customerId
  const session = await request<GuestOrderSession>('/api/v1/guest/session', { method: 'POST' })
  if (!isUuid(session.sessionId)) throw new Error('游客会话无法确认，请稍后重试。')
  return `guest:${session.sessionId}`
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

async function processV2Intent(context: CheckoutOperationContext): Promise<string | null> {
  return withOrderSubmissionLock(() => customerApi.withCheckoutIdentity(async (request) => {
    if (!identityContextIsCurrent(context)) return null
    const ownerId = await currentOrderOwnerId(request)
    if (!identityContextIsCurrent(context)) return null
    const selection = context.selection
    let intent: OrderIntentV2 | null
    if (context.quoteToken && selection?.version === 2) {
      intent = await prepareOrderIntentV2(selection.items, ownerId, context.quoteToken, context.selectionId)
    } else if (selection?.version === 2) {
      intent = await findOrderIntentV2(selection.items, ownerId, context.selectionId)
    } else {
      intent = context.selectionId ? await findOrderIntentBySelectionId(context.selectionId, ownerId) : null
    }
    if (!intent || intent.state === 'rejected') return null
    if (intent.state === 'completed') return intent.orderId
    if (!identityContextIsCurrent(context)) return null
    return submitPendingV2(intent, request)
  }))
}

async function showCompletedOrder(orderId: string, context: CheckoutOperationContext): Promise<void> {
  if (!pageContextIsCurrent(context)) return
  await navigateTo(`/orders/${orderId}`)
}

async function claimSelectedGuestDraftAfterLogin(context: CheckoutOperationContext): Promise<boolean> {
  if (!claimSelectedGuestDraft.value || !isCustomer.value) return true
  const selection = context.selection
  const candidate = selection?.version === 2 && selection.items.length === 1 ? selection.items[0] : undefined
  const candidateDraft = candidate as (CheckoutRequestLineV2 & { draftId?: unknown; draftRevision?: unknown }) | undefined
  const draftId = candidateDraft?.draftId
  const draftRevision = candidateDraft?.draftRevision
  const selected = candidate && typeof draftId === 'string' && typeof draftRevision === 'number'
    ? candidate as { lineId: string; skuId: string; quantity: number; draftId: string; draftRevision: number }
    : undefined
  if (!selected || typeof draftId !== 'string' || typeof draftRevision !== 'number'
    || !Number.isSafeInteger(draftRevision) || !context.selectionId) {
    submitError.value = '本次登录继续购买缺少有效的游客资料引用。请返回商品页重新确认。'
    pendingOwnerBlocked.value = true
    return false
  }
  return withOrderSubmissionLock(async () => {
    if (!pageContextIsCurrent(context) || !identityContextIsCurrent(context)) return false
    // Keep any guest-owned pending or completed idempotency request untouched.
    // Claiming the draft would otherwise silently move its selection to a new
    // customer identity or key.
    const priorIntent = await findAnyOrderIntentBySelectionId(context.selectionId!)
    if (!pageContextIsCurrent(context) || !identityContextIsCurrent(context)) return false
    if (priorIntent && priorIntent.state !== 'rejected') {
      pendingOwnerBlocked.value = true
      submitError.value = '原游客订单请求仍待核实。已保留原资料归属和提交标识，请先使用游客身份核对订单结果。'
      return false
    }
    try {
      const result = await customerApi.request<{ draftId: string; skuId: string; templateVersionId: string; revision: number; complete: true }>(
        `/api/v1/customer/purchase-drafts/${encodeURIComponent(draftId)}/claim-selected`, {
          method: 'POST', body: { skuId: selected.skuId, expectedRevision: draftRevision },
        },
      )
      if (!pageContextIsCurrent(context) || !identityContextIsCurrent(context)) return false
      const items: CheckoutRequestLineV2[] = [{
        lineId: selected.lineId, skuId: selected.skuId, quantity: selected.quantity,
        draftId: result.draftId, draftRevision: result.revision,
      }]
      const nextPath = saveFreshCheckoutSelection(items)
      await router.replace(nextPath)
      return false
    } catch (error) {
      if (pageContextIsCurrent(context) && identityContextIsCurrent(context)) {
        submitError.value = error instanceof Error ? error.message : '无法认领本次所选游客资料；原资料仍保留。请重新报价后重试。'
      }
      return false
    }
  })
}

async function createOrder() {
  const pageContext = captureOperationContext()
  const currentQuote = quote.value
  if (submitting.value || !pageContext.selection || !currentQuote?.canContinue
    || quoteGeneration.value !== pageContext.pageGeneration || !currentQuote.quoteToken) return
  const context: CheckoutOperationContext = { ...pageContext, quoteToken: currentQuote.quoteToken }
  activeSubmissionGeneration.value = context.pageGeneration
  submitError.value = ''
  try {
    const orderId = await processV2Intent(context)
    if (orderId) await showCompletedOrder(orderId, context)
  } catch (error) {
    if (!identityContextIsCurrent(context) || !pageContextIsCurrent(context)) return
    if (error instanceof PendingOwnerConflictError || (error instanceof CustomerApiError && error.code === 'GUEST_SESSION_CHANGED')) pendingOwnerBlocked.value = true
    if (error instanceof CheckoutConflictError) {
      quote.value = error.currentQuote
      quoteGeneration.value = context.pageGeneration
      submitError.value = `${error.message} 已显示最新报价，请再次确认后重新提交。`
    } else {
      submitError.value = error instanceof CustomerApiError || error instanceof Error
        ? error.message
        : '订单暂时未能创建。请稍后重试，重复提交会返回同一订单。'
    }
  } finally {
    if (activeSubmissionGeneration.value === context.pageGeneration) activeSubmissionGeneration.value = null
  }
}

async function replayPendingV2(context: CheckoutOperationContext): Promise<void> {
  if (!import.meta.client || submitting.value
    || !customerApi.sessionResolved.value || !pageContextIsCurrent(context)) return
  try {
    if (!hasOrderIntentV2(context.selection?.items ?? null, context.selectionId)) return
    activeSubmissionGeneration.value = context.pageGeneration
    const orderId = await processV2Intent(context)
    if (orderId) await showCompletedOrder(orderId, context)
  } catch (error) {
    if (!identityContextIsCurrent(context) || !pageContextIsCurrent(context)) return
    if (error instanceof PendingOwnerConflictError || (error instanceof CustomerApiError && error.code === 'GUEST_SESSION_CHANGED')) pendingOwnerBlocked.value = true
    if (error instanceof CheckoutConflictError) {
      quote.value = error.currentQuote
      quoteGeneration.value = context.pageGeneration
      submitError.value = `${error.message} 已显示最新报价，请再次确认。`
    } else if (error instanceof PendingOwnerConflictError || (error instanceof CustomerApiError && ['GUEST_SESSION_CHANGED', 'LICENSE_NEW_OBLIGATION_BLOCKED', 'LICENSE_STATE_UNAVAILABLE'].includes(error.code))) {
      submitError.value = error.message
    } else {
      submitError.value = '上次提交结果尚未确认。保留原请求标识，继续重试会先核对原订单。'
    }
  } finally {
    if (activeSubmissionGeneration.value === context.pageGeneration) activeSubmissionGeneration.value = null
  }
}

watch(
  [() => route.fullPath, requestedSelectionFingerprint, () => customerApi.identityVersion.value,
    clientReady],
  () => {
    const generation = pageGeneration.value + 1
    pageGeneration.value = generation
    const context = captureOperationContext(requestedSelection.value, generation)
    // Invalidate prior quote work before replay can await a lock or network.
    requestSequence += 1
    quote.value = null
    quoteGeneration.value = null
    busy.value = false
    errorMessage.value = ''
    submitError.value = ''
    pendingOwnerBlocked.value = false
    if (!import.meta.client || route.path !== '/checkout') return
    if (typeof route.query.intent === 'string' && !clientReady.value) return
    void (async () => {
      const claimReady = await claimSelectedGuestDraftAfterLogin(context)
      if (!claimReady || !pageContextIsCurrent(context)) return
      await replayPendingV2(context)
      if (pageContextIsCurrent(context)) await loadQuote(context)
    })()
  },
  { immediate: true, flush: 'sync' },
)

watch(
  () => customerApi.sessionResolved.value,
  () => {
    const context = captureOperationContext()
    if (!import.meta.client || !clientReady.value || route.path !== '/checkout') return
    void (async () => {
      const claimReady = await claimSelectedGuestDraftAfterLogin(context)
      if (!claimReady || !pageContextIsCurrent(context)) return
      await replayPendingV2(context)
      if (pageContextIsCurrent(context)) await loadQuote(context)
    })()
  },
  { flush: 'sync' },
)

function onSharedIntentChange(event: StorageEvent): void {
  if (event.key !== orderIntentStoreV2Key || !import.meta.client || route.path !== '/checkout') return
  const context = captureOperationContext()
  if (context.selection?.version === 2 && context.selectionId) void replayPendingV2(context)
}

onMounted(() => window.addEventListener('storage', onSharedIntentChange))
onBeforeUnmount(() => {
  pageDisposed = true
  window.removeEventListener('storage', onSharedIntentChange)
})

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
</script>

<template>
  <UContainer class="py-6 sm:py-10">
    <main
      id="main-content"
      class="mx-auto max-w-6xl"
    >
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <NuxtLink
            :to="backToProductPath"
            class="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-default/70 bg-elevated/60 px-3.5 py-2 text-xs sm:text-sm font-medium text-muted shadow-2xs backdrop-blur-xs transition-all hover:border-default hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <UIcon
              name="i-lucide-arrow-left"
              class="size-4"
              aria-hidden="true"
            />
            返回商品
          </NuxtLink>
        </div>
        <div class="text-right sm:text-left sm:order-first">
          <p class="text-xs font-semibold uppercase tracking-wider text-primary">
            结算流程
          </p>
          <h1 class="mt-0.5 text-2xl font-bold tracking-tight text-highlighted sm:text-3xl">
            确认订单
          </h1>
        </div>
      </div>

      <UAlert
        class="mt-5 rounded-2xl border border-info/30 bg-info/5 shadow-xs"
        color="info"
        variant="subtle"
        icon="i-lucide-shield-check"
        title="下单前会重新验证"
        description="报价用于预览；下单时会重新检查当前商品、库存、购买填写和已配置的履约能力，并原子创建订单、预留数量库存。付款方式以订单详情页实际提供的选项为准。"
      />

      <UAlert
        v-if="quote?.policyReasons.includes('guest_checkout_disabled') || quote?.policyReasons.includes('guest_free_claim_disabled')"
        class="mt-4 rounded-2xl border border-warning/30 bg-warning/5 shadow-xs"
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
            size="sm"
            class="rounded-lg"
          >
            登录后继续
          </UButton>
        </template>
      </UAlert>

      <UAlert
        v-if="purchaseLoginRequired"
        class="mt-4 rounded-2xl border border-warning/30 bg-warning/5 shadow-xs"
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
            size="sm"
            class="rounded-lg"
          >
            登录后继续
          </UButton>
        </template>
      </UAlert>

      <UAlert
        v-if="errorMessage"
        class="mt-4 rounded-2xl border border-error/30 bg-error/5 shadow-xs"
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
            size="sm"
            class="rounded-lg"
            :loading="busy"
            @click="loadQuote()"
          >
            重试报价
          </UButton>
        </template>
      </UAlert>

      <UAlert
        v-if="submitError"
        class="mt-4 rounded-2xl border border-error/30 bg-error/5 shadow-xs"
        color="error"
        variant="soft"
        :title="submitError"
        role="alert"
        aria-live="assertive"
      />

      <div
        v-if="busy && !quote"
        class="mt-6 space-y-4"
        aria-label="正在计算报价"
        aria-busy="true"
      >
        <div
          v-for="index in 2"
          :key="index"
          class="h-32 animate-pulse rounded-2xl border border-default/60 bg-elevated/40 motion-reduce:animate-none"
        />
      </div>

      <section
        v-else-if="quote"
        class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start xl:gap-8"
      >
        <div class="min-w-0 space-y-4">
          <ul
            class="space-y-3.5"
            aria-label="报价商品"
          >
            <li
              v-for="item in quote.items"
              :key="item.lineId ?? item.skuId"
              class="rounded-2xl border border-default/70 bg-elevated/70 p-4 shadow-xs backdrop-blur-xs transition-all hover:border-default sm:p-5"
            >
              <div class="flex flex-col gap-3">
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <div class="min-w-0">
                    <h2 class="break-words text-base sm:text-lg font-semibold tracking-tight text-highlighted">
                      {{ item.productName ?? '商品信息暂不可用' }}
                    </h2>
                    <p
                      v-if="item.draftId"
                      class="mt-1 text-xs text-muted"
                    >
                      已绑定购买资料
                    </p>
                  </div>
                  <UBadge
                    :color="item.canPurchase ? 'success' : 'warning'"
                    variant="subtle"
                    size="sm"
                    class="rounded-md font-medium"
                  >
                    <UIcon
                      :name="item.canPurchase ? 'i-lucide-check-circle-2' : 'i-lucide-alert-circle'"
                      class="size-3.5"
                    />
                    {{ statusLabel(item) }}
                  </UBadge>
                </div>

                <div
                  v-if="item.options.length"
                  class="flex flex-wrap gap-1.5 text-xs text-muted"
                >
                  <span
                    v-for="option in item.options"
                    :key="option.groupId"
                    class="inline-flex items-center rounded-md border border-default/50 bg-muted/30 px-2 py-0.5"
                  >
                    <span class="text-muted/70">{{ option.groupName }}：</span>
                    <span class="font-medium text-highlighted">{{ option.valueName }}</span>
                  </span>
                </div>

                <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>数量：<strong class="font-semibold text-highlighted">{{ item.quantity }}</strong></span>
                  <span
                    v-if="item.skuCode"
                    class="font-mono text-muted/70"
                  >· SKU {{ item.skuCode }}</span>
                </div>

                <StorefrontPurchaseLimitNotice
                  class="mt-1"
                  :purchase-limits="item.purchaseLimits"
                />

                <div
                  v-if="item.purchasePreview"
                  class="mt-2 space-y-2.5"
                >
                  <StorefrontPurchaseDataPreview
                    title="本次购买资料"
                    :definition="item.purchasePreview.definition"
                    :values="item.purchasePreview.values"
                    :attachments="item.purchasePreview.attachments.map(attachment => ({ id: attachment.id, fieldId: attachment.fieldId, url: attachment.url, byteSize: attachment.byteSize }))"
                  />
                  <NuxtLink
                    v-if="item.draftId && !submitting && !pendingOwnerBlocked"
                    :to="purchaseEditPath(item)"
                    class="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <UIcon
                      name="i-lucide-pencil"
                      class="size-3.5"
                      aria-hidden="true"
                    />
                    编辑此购买行资料并重新报价
                  </NuxtLink>
                </div>

                <dl class="mt-2 flex flex-wrap items-baseline justify-between gap-3 border-t border-default/40 pt-3 text-xs sm:text-sm">
                  <div>
                    <dt class="inline text-muted">
                      单价
                    </dt>
                    <dd class="inline ml-1.5 font-medium tabular-nums text-highlighted">
                      {{ item.unitPrice === null ? '暂不可计价' : `¥${item.unitPrice}` }}
                    </dd>
                  </div>
                  <div>
                    <dt class="inline text-muted">
                      小计
                    </dt>
                    <dd class="inline ml-1.5 text-base font-semibold tabular-nums text-primary">
                      {{ item.lineTotal === null ? '暂不可计价' : `¥${item.lineTotal}` }}
                    </dd>
                  </div>
                </dl>
              </div>
            </li>
          </ul>

          <p
            v-if="!isCustomer && !quote.guestCheckoutEnabled && quote.policyReasons.includes('guest_checkout_disabled')"
            class="rounded-xl border border-warning/20 bg-warning/5 p-3.5 text-xs leading-5 text-muted"
          >
            登录后会以顾客身份再次读取商品价格和库存。当前页面仍未提交订单。
          </p>
        </div>

        <aside
          class="rounded-2xl border border-default/70 bg-elevated/70 p-5 sm:p-6 shadow-xs backdrop-blur-xs lg:sticky lg:top-24"
          aria-label="订单总额与提交"
        >
          <h2 class="text-base sm:text-lg font-semibold tracking-tight text-highlighted">
            结算汇总
          </h2>
          <dl class="mt-4 space-y-3 border-b border-default/60 pb-4 text-xs sm:text-sm">
            <div class="flex items-center justify-between gap-4">
              <dt class="text-muted">
                商品金额
              </dt>
              <dd class="font-medium tabular-nums text-highlighted">
                ¥{{ quote.pricedSubtotal }}
              </dd>
            </div>
            <div class="flex items-center justify-between gap-4">
              <dt class="text-muted">
                报价时间
              </dt>
              <dd class="text-right text-xs text-muted tabular-nums">
                {{ formatDate(quote.quotedAt) }}
              </dd>
            </div>
            <div class="flex items-baseline justify-between gap-4 pt-1">
              <dt class="text-xs sm:text-sm font-medium text-highlighted">
                {{ quote.totalComplete ? '当前报价合计' : '当前报价合计不完整' }}
              </dt>
              <dd class="text-xl sm:text-2xl font-bold tracking-tight tabular-nums text-primary">
                {{ quote.totalAmount === null ? '无法完整计价' : `¥${quote.totalAmount}` }}
              </dd>
            </div>
          </dl>

          <div class="mt-5 space-y-2.5">
            <UButton
              v-if="quote.canContinue"
              color="primary"
              block
              size="lg"
              icon="i-lucide-lock-keyhole"
              class="min-h-12 rounded-xl text-base font-semibold shadow-xs transition-all active:scale-[0.99]"
              :loading="submitting"
              :disabled="submitting || busy || pendingOwnerBlocked"
              @click="createOrder"
            >
              {{ submitting ? '正在安全创建订单' : '提交订单' }}
            </UButton>

            <div class="grid grid-cols-2 gap-2 pt-1">
              <UButton
                color="neutral"
                variant="outline"
                size="sm"
                icon="i-lucide-refresh-cw"
                class="justify-center rounded-xl text-xs font-medium"
                :loading="busy"
                @click="loadQuote()"
              >
                重新报价
              </UButton>
              <UButton
                :to="backToProductPath"
                color="neutral"
                variant="soft"
                size="sm"
                class="justify-center rounded-xl text-xs font-medium"
              >
                返回修改
              </UButton>
            </div>
          </div>
        </aside>
      </section>
    </main>
  </UContainer>
</template>
