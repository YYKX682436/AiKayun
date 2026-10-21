<script setup lang="ts">
import type { CustomerOrderPayment, CustomerOrderRefunds, ExternalPaymentMethod, OrderDetail } from '@aikayun/contracts'
import { CustomerApiError, useCustomerApi } from '~/composables/useCustomerApi'

const route = useRoute()
const customerApi = useCustomerApi()
const orderId = computed(() => String(route.params.id))
const order = shallowRef<OrderDetail | null>(null)
const payment = shallowRef<CustomerOrderPayment | null>(null)
const refunds = shallowRef<CustomerOrderRefunds | null>(null)
const loading = ref(false)
const cancelling = ref(false)
const creatingPayment = ref(false)
const refreshingPayment = ref(false)
const requestingRefund = ref(false)
const refundAmountInput = ref('')
const refundReason = ref('')
const refundMessage = ref('')
const refundError = ref('')
const confirmCancel = ref(false)
const errorMessage = ref('')
const mounted = ref(false)
const selectedChannelId = ref('')
const selectedPaymentMethod = ref<ExternalPaymentMethod>('alipay')
const selectedPaymentMode = ref<'external' | 'wallet' | 'hybrid'>('external')
const hybridWalletAmountInput = ref('')
const qrDataUrl = ref('')
const qrError = ref('')
const copiedDeliveryId = ref('')
const deliveryCopyMessage = ref('')
let sequence = 0
let qrSequence = 0
let renderedQrValue = ''
let deliveryPollTimer: number | undefined

useSeoMeta({ title: '订单详情', description: '查看订单状态、成交快照和已完成的数字交付。', robots: 'noindex, nofollow' })
useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const isCustomer = computed(() => Boolean(customerApi.session.value?.customer.id))
const hasActiveAttempt = computed(() => Boolean(payment.value?.attempt
  && ['created', 'pending', 'reconciliation_required'].includes(payment.value.attempt.status)))
const canCancel = computed(() => order.value?.status === 'pending_payment' && !hasActiveAttempt.value)
const automaticDeliveryPending = computed(() => order.value?.items.some(item =>
  ['code_pool', 'fixed_content', 'link'].includes(item.fulfillmentMethod) && item.fulfilledQuantity < item.quantity) ?? false)
const selectedChannel = computed(() => payment.value?.channels.find(channel => channel.id === selectedChannelId.value) ?? null)
const qrAction = computed(() => payment.value?.attempt?.action?.type === 'qr_code'
  ? payment.value.attempt.action.value
  : '')

const refundStatusNames: Record<CustomerOrderRefunds['refundStatus'], string> = {
  none: '尚无退款',
  requested_or_processing: '审核或处理中',
  partially_refunded: '部分已退款',
  refunded: '已全额退款',
}

const refundRequestAmount = computed(() => {
  const value = refundAmountInput.value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value)) return ''
  const normalized = value.includes('.') ? value.padEnd(value.indexOf('.') + 3, '0') : `${value}.00`
  return amountToCents(normalized) > 0n ? normalized : ''
})

function refundItemStatusLabel(status: CustomerOrderRefunds['items'][number]['status']): string {
  const names: Record<typeof status, string> = {
    requested: '等待商家审核',
    approved: '审核通过',
    processing: '退款处理中',
    partially_succeeded: '部分退款成功',
    succeeded: '退款成功',
    failed: '退款失败',
    cancelled: '已拒绝',
  }
  return names[status]
}

function refundDestinationLabel(destination: CustomerOrderRefunds['items'][number]['allocations'][number]['destination']): string {
  if (destination === 'gift_balance') return '退回赠送余额'
  if (destination === 'cash_balance') return '退回现金余额'
  return '人工退回原支付来源'
}

function refundSourceLabel(source: CustomerOrderRefunds['items'][number]['allocations'][number]['sourceBucket']): string {
  if (source === 'gift') return '赠送余额'
  if (source === 'cash') return '现金余额'
  return '支付宝 / 微信实收'
}

function amountToCents(value: string): bigint {
  const [whole, fraction = '00'] = value.split('.')
  if (!/^\d+$/u.test(whole!) || !/^\d{2}$/u.test(fraction)) return 0n
  return BigInt(whole!) * 100n + BigInt(fraction)
}

function centsToAmount(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`
}

const walletAvailableCents = computed(() => payment.value?.walletBalance
  ? amountToCents(payment.value.walletBalance.totalAvailable) : 0n)
const orderAmountCents = computed(() => payment.value ? amountToCents(payment.value.totalAmount) : 0n)
const maxWalletContributionCents = computed(() => walletAvailableCents.value < orderAmountCents.value
  ? walletAvailableCents.value : orderAmountCents.value)
const maxWalletContribution = computed(() => centsToAmount(maxWalletContributionCents.value))
const walletOnlyAvailable = computed(() => orderAmountCents.value > 0n
  && maxWalletContributionCents.value >= orderAmountCents.value)
const walletPaymentAvailable = computed(() => walletAvailableCents.value > 0n)
const canCombineWallet = computed(() => walletPaymentAvailable.value && orderAmountCents.value > 1n)
const selectedWalletAmount = computed(() => {
  if (selectedPaymentMode.value === 'external') return '0.00'
  if (selectedPaymentMode.value === 'wallet') return payment.value?.totalAmount ?? '0.00'
  const value = hybridWalletAmountInput.value
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value)) return '0.00'
  const normalized = value.includes('.') ? value.padEnd(value.indexOf('.') + 3, '0') : `${value}.00`
  const cents = amountToCents(normalized)
  return cents > 0n && cents < orderAmountCents.value && cents <= walletAvailableCents.value
    ? centsToAmount(cents) : '0.00'
})
const selectedExternalAmount = computed(() => {
  const remainder = orderAmountCents.value - amountToCents(selectedWalletAmount.value)
  return centsToAmount(remainder > 0n ? remainder : 0n)
})
const estimatedGiftUse = computed(() => {
  const gift = amountToCents(payment.value?.walletBalance?.giftAvailable ?? '0.00')
  const spend = amountToCents(selectedWalletAmount.value)
  return centsToAmount(gift < spend ? gift : spend)
})
const estimatedCashUse = computed(() => {
  const remainder = amountToCents(selectedWalletAmount.value) - amountToCents(estimatedGiftUse.value)
  return centsToAmount(remainder > 0n ? remainder : 0n)
})
const canCreatePayment = computed(() => Boolean(payment.value?.paymentStatus === 'unpaid'
  && !hasActiveAttempt.value
  && (selectedPaymentMode.value === 'wallet'
    ? walletOnlyAvailable.value
    : selectedPaymentMode.value === 'hybrid'
      ? selectedWalletAmount.value !== '0.00' && selectedExternalAmount.value !== '0.00'
        && selectedChannel.value?.paymentMethods.includes(selectedPaymentMethod.value)
      : selectedChannel.value?.paymentMethods.includes(selectedPaymentMethod.value))))
const paymentButtonLabel = computed(() => selectedPaymentMode.value === 'wallet'
  ? `确认钱包支付 · ¥${payment.value?.totalAmount ?? '0.00'}`
  : selectedPaymentMode.value === 'hybrid'
    ? `创建组合支付 · ¥${selectedWalletAmount.value} + ¥${selectedExternalAmount.value}`
    : `创建外部支付 · ¥${payment.value?.totalAmount ?? '0.00'}`)

function selectPaymentMode(mode: 'external' | 'wallet' | 'hybrid') {
  selectedPaymentMode.value = mode
  if (mode === 'hybrid' && (hybridWalletAmountInput.value === '' || selectedWalletAmount.value === '0.00')) {
    const initial = maxWalletContributionCents.value < orderAmountCents.value
      ? maxWalletContributionCents.value
      : orderAmountCents.value / 2n
    hybridWalletAmountInput.value = centsToAmount(initial)
  }
}

function statusLabel(value: OrderDetail): string {
  if (value.status === 'pending_payment') return '等待付款'
  if (value.status === 'processing' && value.items.some(item =>
    ['code_pool', 'fixed_content', 'link'].includes(item.fulfillmentMethod) && item.fulfilledQuantity < item.quantity)) {
    return value.paymentStatus === 'not_required' ? '自动交付处理中' : '付款成功 · 自动交付处理中'
  }
  if (value.status === 'processing') return value.paymentStatus === 'not_required' ? '等待发货' : '付款成功 · 等待发货'
  if (value.status === 'completed') return '已完成'
  return '已关闭'
}

function paymentLabel(value: OrderDetail): string {
  if (value.paymentStatus === 'not_required') return '零元订单，无需付款'
  if (value.paymentStatus === 'unpaid') return '等待付款'
  return '付款已确认'
}

function statusColor(value: OrderDetail['status']): 'success' | 'neutral' | 'warning' | 'primary' {
  if (value === 'completed') return 'success'
  if (value === 'closed') return 'neutral'
  if (value === 'pending_payment') return 'warning'
  return 'primary'
}

const statusNames: Record<OrderDetail['status'], string> = {
  pending_payment: '待付款',
  processing: '处理中',
  completed: '已完成',
  closed: '已关闭',
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

async function copyDelivery(deliveryId: string, content: string) {
  deliveryCopyMessage.value = ''
  try {
    await navigator.clipboard.writeText(content)
    copiedDeliveryId.value = deliveryId
    deliveryCopyMessage.value = '交付内容已复制到剪贴板。'
    window.setTimeout(() => {
      if (copiedDeliveryId.value === deliveryId) copiedDeliveryId.value = ''
    }, 1800)
  } catch {
    deliveryCopyMessage.value = '浏览器未允许复制，请手动选择交付内容。'
  }
}

function safeDeliveryHref(value: string): string {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

function hasPendingAutomaticDelivery(): boolean {
  return order.value?.status === 'processing' && order.value.items.some(item =>
    ['code_pool', 'fixed_content', 'link'].includes(item.fulfillmentMethod) && item.fulfilledQuantity < item.quantity)
}

function fulfillmentFailureHint(code: string | null): string {
  if (code === 'FIXED_DELIVERY_KEY_UNAVAILABLE' || code === 'CODE_POOL_KEY_UNAVAILABLE') return '系统交付密钥暂不可用，内容已保护，后台正在重试。'
  if (code === 'FIXED_DELIVERY_DECRYPTION_FAILED' || code === 'CODE_POOL_DECRYPTION_FAILED') return '交付内容完整性校验未通过，系统已阻止错误交付并正在重试。'
  if (code === 'FIXED_DELIVERY_PAYMENT_UNRESOLVED' || code === 'CODE_POOL_PAYMENT_UNRESOLVED') return '付款或对账仍需核验，确认完成后系统会继续交付。'
  return '系统暂时未能完成交付，正在安全重试；请稍后刷新订单。'
}

async function loadOrder() {
  const currentSequence = ++sequence
  const identityAtStart = customerApi.identityVersion.value
  loading.value = true
  errorMessage.value = ''
  try {
    const path = isCustomer.value ? `/api/v1/customer/orders/${orderId.value}` : `/api/v1/guest/orders/${orderId.value}`
    const refundPath = isCustomer.value
      ? `/api/v1/customer/orders/${orderId.value}/refunds`
      : `/api/v1/guest/orders/${orderId.value}/refunds`
    const [result, paymentResult, refundResult] = await Promise.all([
      customerApi.request<OrderDetail>(path),
      customerApi.request<CustomerOrderPayment>(`/api/v1/orders/${orderId.value}/payment`),
      customerApi.request<CustomerOrderRefunds>(refundPath),
    ])
    if (currentSequence !== sequence || identityAtStart !== customerApi.identityVersion.value) return
    order.value = result
    payment.value = paymentResult
    refunds.value = refundResult
    if (!refundAmountInput.value && refundResult.refundableAmount !== '0.00') refundAmountInput.value = refundResult.refundableAmount
    if (!paymentResult.channels.some(channel => channel.id === selectedChannelId.value)) {
      selectedChannelId.value = paymentResult.channels[0]?.id ?? ''
    }
    const supportedMethods = paymentResult.channels.find(channel => channel.id === selectedChannelId.value)?.paymentMethods ?? []
    if (!supportedMethods.includes(selectedPaymentMethod.value) && supportedMethods[0]) {
      selectedPaymentMethod.value = supportedMethods[0]
    }
  } catch (error) {
    if (currentSequence !== sequence || identityAtStart !== customerApi.identityVersion.value) return
    errorMessage.value = error instanceof Error ? error.message : '订单暂时无法读取。'
  } finally {
    if (currentSequence === sequence) loading.value = false
  }
}

async function refundRequestKey(amount: string, reason: string): Promise<string> {
  if (!import.meta.client) throw new Error('请在浏览器中提交退款申请。')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({
    orderId: orderId.value, identity: customerApi.identityVersion.value, amount, reason: reason.trim(),
  })))
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const storageKey = `aikayun-refund-request-v1:${hash}`
  try {
    const existing = sessionStorage.getItem(storageKey)
    if (existing && /^[0-9a-f-]{36}$/iu.test(existing)) return existing
    const next = crypto.randomUUID()
    sessionStorage.setItem(storageKey, next)
    return next
  } catch {
    throw new Error('浏览器无法保存退款重试标识，请启用会话存储后重试。')
  }
}

async function requestRefund() {
  if (!refunds.value?.canRequest || requestingRefund.value || !refundRequestAmount.value) return
  if (amountToCents(refundRequestAmount.value) > amountToCents(refunds.value.refundableAmount)) {
    refundError.value = '申请金额超过当前可退款金额，请刷新后重新填写。'
    return
  }
  if (!refundReason.value.trim()) {
    refundError.value = '请填写退款原因。'
    return
  }
  requestingRefund.value = true
  refundError.value = ''
  refundMessage.value = ''
  try {
    const path = isCustomer.value
      ? `/api/v1/customer/orders/${orderId.value}/refunds`
      : `/api/v1/guest/orders/${orderId.value}/refunds`
    const result = await customerApi.request<{ repeated: boolean; refunds: CustomerOrderRefunds }>(path, {
      method: 'POST',
      body: {
        idempotencyKey: await refundRequestKey(refundRequestAmount.value, refundReason.value),
        amount: refundRequestAmount.value,
        reason: refundReason.value.trim(),
      },
    })
    refunds.value = result.refunds
    refundMessage.value = result.repeated ? '已读取这笔相同申请的最新状态。' : '退款申请已提交，实际退款仍需商家审核处理。'
    await loadOrder()
  } catch (error) {
    refundError.value = error instanceof Error ? error.message : '退款申请结果尚未确认，请刷新进度后再试。'
    try {
      const path = isCustomer.value
        ? `/api/v1/customer/orders/${orderId.value}/refunds`
        : `/api/v1/guest/orders/${orderId.value}/refunds`
      refunds.value = await customerApi.request<CustomerOrderRefunds>(path)
    } catch { /* Keep the original error and require a deliberate refresh. */ }
  } finally {
    requestingRefund.value = false
  }
}

async function cancelOrder() {
  if (!canCancel.value || cancelling.value) return
  cancelling.value = true
  errorMessage.value = ''
  try {
    const path = isCustomer.value
      ? `/api/v1/customer/orders/${orderId.value}/cancel`
      : `/api/v1/guest/orders/${orderId.value}/cancel`
    order.value = await customerApi.request<OrderDetail>(path, { method: 'POST' })
    confirmCancel.value = false
    await loadOrder()
  } catch (error) {
    errorMessage.value = error instanceof CustomerApiError || error instanceof Error
      ? error.message
      : '订单暂时无法取消，请刷新后检查状态。'
  } finally {
    cancelling.value = false
  }
}

function paymentKeyStorageKey(channelId: string, method: ExternalPaymentMethod, walletAmount: string): string {
  const mode = walletAmount === '0.00' ? 'external' : walletAmount === payment.value?.totalAmount ? 'wallet' : 'hybrid'
  return `aikayun-payment-request-v2:${customerApi.identityVersion.value}:${orderId.value}:${mode}:${walletAmount}:${channelId}:${method}`
}

function paymentIdempotencyKey(channelId: string, method: ExternalPaymentMethod, walletAmount: string): string {
  if (!import.meta.client) throw new Error('请在浏览器中发起支付。')
  const key = paymentKeyStorageKey(channelId, method, walletAmount)
  try {
    const existing = sessionStorage.getItem(key)
    if (existing && /^[0-9a-f-]{36}$/iu.test(existing)) return existing
    const next = crypto.randomUUID()
    sessionStorage.setItem(key, next)
    return next
  } catch {
    throw new Error('浏览器无法安全保存支付重试标识，请启用会话存储后重试。')
  }
}

async function createPayment() {
  if (!canCreatePayment.value || creatingPayment.value) return
  const walletAmount = selectedWalletAmount.value
  const needsExternal = selectedExternalAmount.value !== '0.00'
  if (needsExternal && !selectedChannelId.value) return
  creatingPayment.value = true
  errorMessage.value = ''
  const orderAtStart = orderId.value
  const identityAtStart = customerApi.identityVersion.value
  try {
    const result = await customerApi.request<CustomerOrderPayment>(`/api/v1/orders/${orderAtStart}/payments`, {
      method: 'POST',
      body: {
        idempotencyKey: paymentIdempotencyKey(needsExternal ? selectedChannelId.value : '', selectedPaymentMethod.value, walletAmount),
        ...(walletAmount !== '0.00' ? { walletAmount } : {}),
        ...(needsExternal ? { channelId: selectedChannelId.value, paymentMethod: selectedPaymentMethod.value } : {}),
      },
    })
    if (orderAtStart !== orderId.value || identityAtStart !== customerApi.identityVersion.value) return
    payment.value = result
    if (result.attempt && ['failed', 'expired', 'cancelled'].includes(result.attempt.status)) {
      try { sessionStorage.removeItem(paymentKeyStorageKey(selectedChannelId.value, selectedPaymentMethod.value, walletAmount)) } catch { /* The server attempt remains authoritative. */ }
    }
    await loadOrder()
  } catch (error) {
    if (orderAtStart !== orderId.value || identityAtStart !== customerApi.identityVersion.value) return
    errorMessage.value = error instanceof Error ? error.message : '支付请求结果尚未确认，请刷新订单状态后再试。'
  } finally {
    creatingPayment.value = false
  }
}

async function refreshPayment() {
  if (!payment.value || refreshingPayment.value) return
  refreshingPayment.value = true
  errorMessage.value = ''
  const orderAtStart = orderId.value
  const identityAtStart = customerApi.identityVersion.value
  try {
    payment.value = await customerApi.request<CustomerOrderPayment>(`/api/v1/orders/${orderAtStart}/payment/refresh`, {
      method: 'POST',
    })
    if (orderAtStart !== orderId.value || identityAtStart !== customerApi.identityVersion.value) return
    await loadOrder()
  } catch (error) {
    if (orderAtStart !== orderId.value || identityAtStart !== customerApi.identityVersion.value) return
    errorMessage.value = error instanceof Error ? error.message : '支付状态暂时无法确认，请稍后重试。'
  } finally {
    refreshingPayment.value = false
  }
}

watch(qrAction, async (value) => {
  const currentSequence = ++qrSequence
  if (!value) {
    renderedQrValue = ''
    qrDataUrl.value = ''
    qrError.value = ''
    return
  }
  if (!import.meta.client || value === renderedQrValue) return
  qrError.value = ''
  try {
    const QRCode = await import('qrcode')
    const dataUrl = await QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 2, width: 256 })
    if (currentSequence !== qrSequence || value !== qrAction.value) return
    renderedQrValue = value
    qrDataUrl.value = dataUrl
  } catch {
    if (currentSequence === qrSequence) qrError.value = '二维码暂时无法生成，请刷新订单后重试。'
  }
}, { immediate: true })

onMounted(() => {
  mounted.value = true
  void loadOrder()
  deliveryPollTimer = window.setInterval(() => {
    if (mounted.value && !loading.value && hasPendingAutomaticDelivery()) void loadOrder()
  }, 3000)
})

onBeforeUnmount(() => {
  if (deliveryPollTimer) window.clearInterval(deliveryPollTimer)
})

watch(() => customerApi.identityVersion.value, () => {
  if (!mounted.value) return
  order.value = null
  payment.value = null
  refunds.value = null
  confirmCancel.value = false
  selectedChannelId.value = ''
  selectedPaymentMode.value = 'external'
  hybridWalletAmountInput.value = ''
  qrDataUrl.value = ''
  void loadOrder()
}, { flush: 'sync' })

watch(orderId, () => {
  if (!mounted.value) return
  sequence++
  order.value = null
  payment.value = null
  refunds.value = null
  selectedChannelId.value = ''
  selectedPaymentMode.value = 'external'
  hybridWalletAmountInput.value = ''
  confirmCancel.value = false
  qrDataUrl.value = ''
  void loadOrder()
}, { flush: 'sync' })

watch(() => selectedChannel.value?.paymentMethods, (methods) => {
  if (methods?.length && !methods.includes(selectedPaymentMethod.value)) selectedPaymentMethod.value = methods[0]!
})
</script>

<template>
  <UContainer class="py-7 sm:py-10">
    <main
      id="main-content"
      class="mx-auto w-full max-w-5xl"
    >
      <NuxtLink
        to="/orders"
        class="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium text-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <UIcon
          name="i-lucide-arrow-left"
          class="size-4"
          aria-hidden="true"
        />
        返回订单列表
      </NuxtLink>

      <div
        v-if="loading && !order"
        class="mt-5 space-y-3"
        aria-label="正在加载订单"
        aria-busy="true"
      >
        <div class="h-36 animate-pulse rounded-xl border border-default bg-elevated motion-reduce:animate-none" />
        <div class="h-48 animate-pulse rounded-xl border border-default bg-elevated motion-reduce:animate-none" />
      </div>

      <UAlert
        v-if="errorMessage"
        class="mt-5"
        color="error"
        variant="soft"
        :title="errorMessage"
        role="alert"
        aria-live="assertive"
      >
        <template #actions>
          <UButton
            color="error"
            variant="outline"
            :loading="loading"
            @click="loadOrder"
          >
            重试读取
          </UButton>
        </template>
      </UAlert>

      <template v-if="order">
        <header class="mt-5 grid gap-4 rounded-2xl border border-default bg-elevated p-4 sm:p-6">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0">
              <p class="text-sm font-medium text-primary">
                {{ isCustomer ? '顾客订单' : '游客订单' }}
              </p>
              <h1 class="mt-1 break-all font-mono text-xl font-semibold tracking-tight text-highlighted sm:text-2xl">
                订单 {{ order.id }}
              </h1>
              <p class="mt-2 text-sm text-muted">
                创建于 {{ formatDate(order.createdAt) }}
              </p>
            </div>
            <UBadge
              :color="statusColor(order.status)"
              variant="soft"
              size="lg"
            >
              {{ statusLabel(order) }}
            </UBadge>
          </div>

          <div class="grid gap-3 border-t border-default pt-4 sm:grid-cols-3">
            <div>
              <p class="text-sm text-muted">
                订单金额
              </p>
              <p class="mt-1 text-xl font-semibold tabular-nums text-highlighted">
                ¥{{ order.totalAmount }}
              </p>
            </div>
            <div>
              <p class="text-sm text-muted">
                付款状态
              </p>
              <p class="mt-1 font-medium text-highlighted">
                {{ paymentLabel(order) }}
              </p>
            </div>
            <div v-if="order.status === 'pending_payment' && order.unpaidExpiresAt">
              <p class="text-sm text-muted">
                待付款截止时间
              </p>
              <p class="mt-1 font-medium text-highlighted">
                {{ formatDate(order.unpaidExpiresAt) }}
              </p>
            </div>
            <div v-else>
              <p class="text-sm text-muted">
                订单商品
              </p>
              <p class="mt-1 font-medium text-highlighted">
                {{ order.itemCount }} 个成交订单项
              </p>
            </div>
          </div>

          <UAlert
            v-if="order.status === 'pending_payment' && order.totalAmount !== '0.00'"
            color="warning"
            variant="subtle"
            icon="i-lucide-clock-3"
            title="等待付款"
            description="请在本订单页面选择可用支付方式并完成付款。订单状态只会在服务端确认实际收款后更新。"
          />
          <UAlert
            v-else-if="order.status === 'processing'"
            color="info"
            variant="subtle"
            icon="i-lucide-package-check"
            :title="automaticDeliveryPending ? (order.paymentStatus === 'not_required' ? '零元订单，自动交付处理中' : '付款已确认，自动交付处理中') : (order.paymentStatus === 'not_required' ? '零元订单，等待商家交付' : '付款已确认，等待商家交付')"
            :description="automaticDeliveryPending ? '系统正在按此订单绑定的履约版本安全交付，完成后会显示在下方。付款确认前不会展示内容。' : '订单正在履约。商家完成人工数字交付后，交付内容会安全显示在此订单详情中。'"
          />
          <UAlert
            v-else-if="order.status === 'completed'"
            color="success"
            variant="subtle"
            icon="i-lucide-circle-check"
            title="订单已完成"
            :description="order.items.some(item => ['code_pool', 'fixed_content', 'link'].includes(item.fulfillmentMethod)) ? '数字交付内容已按订单绑定版本安全记录在下方。退款不会清除已交付历史。' : '订单中的人工数字交付内容已记录在下方订单项。'"
          />

          <div
            v-if="canCancel"
            class="flex flex-wrap items-center gap-2"
          >
            <UButton
              v-if="!confirmCancel"
              color="error"
              variant="outline"
              icon="i-lucide-x-circle"
              @click="confirmCancel = true"
            >
              取消未付款订单
            </UButton>
            <template v-else>
              <span class="text-sm text-muted">取消后会释放预留库存，订单历史仍会保留。</span>
              <UButton
                color="neutral"
                variant="outline"
                :disabled="cancelling"
                @click="confirmCancel = false"
              >
                返回
              </UButton>
              <UButton
                color="error"
                :loading="cancelling"
                @click="cancelOrder"
              >
                确认取消
              </UButton>
            </template>
          </div>
        </header>

        <section
          v-if="payment && order.status === 'pending_payment' && order.totalAmount !== '0.00'"
          class="mt-5 rounded-2xl border border-default bg-elevated p-4 sm:p-6"
          aria-labelledby="order-payment-title"
        >
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0">
              <p class="text-sm font-medium text-primary">
                付款方式
              </p>
              <h2
                id="order-payment-title"
                class="mt-1 text-lg font-semibold text-highlighted"
              >
                应付 ¥{{ payment.totalAmount }}
              </h2>
              <p class="mt-1 text-sm text-muted">
                人民币 · 以本订单金额为准
              </p>
            </div>
            <UButton
              v-if="hasActiveAttempt"
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              :loading="refreshingPayment"
              :disabled="refreshingPayment"
              @click="refreshPayment"
            >
              刷新支付状态
            </UButton>
          </div>

          <UAlert
            v-if="payment.paymentStatus === 'paid'"
            class="mt-4"
            color="success"
            variant="subtle"
            icon="i-lucide-circle-check"
            title="服务端已确认付款"
            description="订单已进入等待商家交付状态。"
          />
          <UAlert
            v-else-if="payment.paymentStatus === 'late_paid' || payment.paymentStatus === 'reconciliation_required'"
            class="mt-4"
            color="warning"
            variant="subtle"
            icon="i-lucide-shield-alert"
            title="收款需要商家核对"
            description="系统已保留服务商凭证，订单不会自动进入履约。请联系商家核对实际收款。"
          />

          <template v-else-if="hasActiveAttempt && payment.attempt">
            <div class="mt-4 rounded-xl border border-default p-4">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="font-medium text-highlighted">
                    {{ payment.attempt.paymentMethod === 'wechat' ? '微信支付' : '支付宝' }}
                    <span
                      v-if="payment.attempt.channelName"
                      class="font-normal text-muted"
                    >· {{ payment.attempt.channelName }}</span>
                  </p>
                  <p class="mt-1 text-sm text-muted">
                    {{ payment.attempt.providerState === 'ready' ? '支付请求已创建。完成支付后返回此页并刷新状态。' : '支付创建结果尚未确认。请勿重复付款，稍后刷新以安全确认服务商状态。' }}
                  </p>
                  <p
                    v-if="payment.attempt.expiresAt"
                    class="mt-2 text-xs text-muted"
                  >
                    本次支付尝试截止 {{ formatDate(payment.attempt.expiresAt) }}
                  </p>
                </div>
                <UBadge
                  color="warning"
                  variant="soft"
                >
                  {{ payment.attempt.providerState === 'ready' ? '待支付' : '确认中' }}
                </UBadge>
              </div>

              <figure
                v-if="payment.attempt.action?.type === 'qr_code' && qrDataUrl"
                class="mx-auto mt-4 grid w-full max-w-64 justify-items-center gap-2 rounded-xl border border-default bg-default p-4"
              >
                <img
                  :src="qrDataUrl"
                  alt="本次订单的支付二维码"
                  width="256"
                  height="256"
                  class="size-56 max-w-full"
                >
                <figcaption class="text-center text-xs text-muted">
                  使用对应的支付应用扫码
                </figcaption>
              </figure>
              <p
                v-if="qrError"
                class="mt-3 text-sm text-error"
                role="alert"
              >
                {{ qrError }}
              </p>
              <a
                v-if="payment.attempt.action?.type === 'redirect'"
                :href="payment.attempt.action.url"
                target="_blank"
                rel="noopener noreferrer"
                class="mt-4 inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-inverted hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                打开支付页面
              </a>
            </div>
          </template>

          <template v-else-if="payment.paymentStatus === 'unpaid'">
            <div
              v-if="isCustomer && payment.walletBalance"
              class="mt-4 grid gap-4 rounded-xl border border-default bg-default/60 p-4"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 class="font-medium text-highlighted">
                    钱包余额
                  </h3>
                  <p class="mt-1 text-sm text-muted">
                    可用 ¥{{ payment.walletBalance.totalAvailable }} · 赠送余额优先抵扣
                  </p>
                </div>
                <UButton
                  to="/wallet"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  icon="i-lucide-wallet"
                >
                  钱包明细
                </UButton>
              </div>

              <fieldset class="grid gap-2 sm:grid-cols-3">
                <legend class="mb-2 text-sm font-medium text-highlighted">
                  选择付款方式
                </legend>
                <label
                  class="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-default px-3 py-2 hover:bg-muted"
                  :class="selectedPaymentMode === 'external' ? 'border-primary bg-primary/5' : ''"
                >
                  <input
                    type="radio"
                    name="payment-mode"
                    :checked="selectedPaymentMode === 'external'"
                    class="size-4 shrink-0 accent-primary"
                    @change="selectPaymentMode('external')"
                  >
                  <span class="text-sm font-medium text-highlighted">外部支付</span>
                </label>
                <label
                  class="flex min-h-12 items-center gap-3 rounded-xl border border-default px-3 py-2"
                  :class="[walletOnlyAvailable ? 'cursor-pointer hover:bg-muted' : 'cursor-not-allowed opacity-50', selectedPaymentMode === 'wallet' ? 'border-primary bg-primary/5' : '']"
                >
                  <input
                    type="radio"
                    name="payment-mode"
                    :checked="selectedPaymentMode === 'wallet'"
                    :disabled="!walletOnlyAvailable"
                    class="size-4 shrink-0 accent-primary"
                    @change="selectPaymentMode('wallet')"
                  >
                  <span class="text-sm font-medium text-highlighted">钱包全额支付</span>
                </label>
                <label
                  class="flex min-h-12 items-center gap-3 rounded-xl border border-default px-3 py-2"
                  :class="[canCombineWallet ? 'cursor-pointer hover:bg-muted' : 'cursor-not-allowed opacity-50', selectedPaymentMode === 'hybrid' ? 'border-primary bg-primary/5' : '']"
                >
                  <input
                    type="radio"
                    name="payment-mode"
                    :checked="selectedPaymentMode === 'hybrid'"
                    :disabled="!canCombineWallet"
                    class="size-4 shrink-0 accent-primary"
                    @change="selectPaymentMode('hybrid')"
                  >
                  <span class="text-sm font-medium text-highlighted">钱包与外部组合</span>
                </label>
              </fieldset>

              <div
                v-if="selectedPaymentMode === 'hybrid'"
                class="grid gap-3 sm:grid-cols-2 sm:items-end"
              >
                <UFormField
                  label="钱包支付金额"
                  :description="`可用余额最多 ¥${maxWalletContribution}，赠送余额先抵扣。`"
                >
                  <UInput
                    v-model="hybridWalletAmountInput"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    placeholder="输入钱包支付金额"
                    class="w-full"
                  />
                </UFormField>
                <p class="text-sm text-muted">
                  钱包 ¥{{ selectedWalletAmount }}（赠送 ¥{{ estimatedGiftUse }}，现金 ¥{{ estimatedCashUse }}），外部支付 ¥{{ selectedExternalAmount }}
                </p>
              </div>
              <p
                v-else-if="selectedPaymentMode === 'wallet'"
                class="text-sm text-muted"
              >
                本次使用赠送余额 ¥{{ estimatedGiftUse }}，现金余额 ¥{{ estimatedCashUse }}。
              </p>
            </div>

            <UAlert
              v-if="selectedPaymentMode !== 'wallet' && payment.channels.length === 0"
              class="mt-4"
              color="neutral"
              variant="subtle"
              title="暂时没有可用支付通道"
              description="请稍后重试，或联系商家确认支付配置。"
            />
            <div
              class="mt-4 grid gap-5"
            >
              <fieldset
                v-if="selectedPaymentMode !== 'wallet' && payment.channels.length > 0"
                class="grid gap-2"
              >
                <legend class="text-sm font-medium text-highlighted">
                  {{ selectedPaymentMode === 'hybrid' ? '选择尾款支付通道' : '选择支付通道' }}
                </legend>
                <label
                  v-for="channel in payment.channels"
                  :key="channel.id"
                  class="flex min-h-12 min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-default px-3 py-2 transition-colors hover:bg-muted"
                  :class="selectedChannelId === channel.id ? 'border-primary bg-primary/5' : ''"
                >
                  <input
                    v-model="selectedChannelId"
                    type="radio"
                    name="payment-channel"
                    :value="channel.id"
                    class="size-4 shrink-0 accent-primary"
                  >
                  <span class="min-w-0 break-words text-sm font-medium text-highlighted">{{ channel.name }}</span>
                </label>
              </fieldset>

              <fieldset
                v-if="selectedPaymentMode !== 'wallet' && selectedChannel"
                class="grid gap-2"
              >
                <legend class="text-sm font-medium text-highlighted">
                  选择支付方式
                </legend>
                <div class="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
                  <label
                    v-for="method in selectedChannel.paymentMethods"
                    :key="method"
                    class="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-default px-3 py-2 transition-colors hover:bg-muted"
                    :class="selectedPaymentMethod === method ? 'border-primary bg-primary/5' : ''"
                  >
                    <input
                      v-model="selectedPaymentMethod"
                      type="radio"
                      name="payment-method"
                      :value="method"
                      class="size-4 shrink-0 accent-primary"
                    >
                    <span class="text-sm font-medium text-highlighted">{{ method === 'wechat' ? '微信支付' : '支付宝' }}</span>
                  </label>
                </div>
              </fieldset>

              <div class="flex flex-wrap items-center justify-between gap-3 border-t border-default pt-4">
                <p class="max-w-xl text-xs leading-5 text-muted">
                  金额由服务器按订单快照计算。钱包先使用赠送余额，再使用现金余额；浏览器返回不会确认外部收款。
                </p>
                <UButton
                  color="primary"
                  icon="i-lucide-lock-keyhole"
                  :loading="creatingPayment"
                  :disabled="!canCreatePayment || creatingPayment"
                  @click="createPayment"
                >
                  {{ paymentButtonLabel }}
                </UButton>
              </div>
            </div>
          </template>

          <p
            v-if="payment.attempt?.errorCode"
            class="mt-3 text-sm text-muted"
          >
            上次支付尝试未能创建，请重新选择通道后再试。
          </p>
        </section>

        <UAlert
          v-if="payment?.paymentStatus === 'paid' && order.status !== 'pending_payment'"
          class="mt-5"
          color="success"
          variant="subtle"
          icon="i-lucide-circle-check"
          title="服务端已确认付款"
          :description="`已验证收款 ¥${payment.confirmedAmount}，订单等待商家交付。`"
        />
        <UAlert
          v-else-if="payment?.paymentStatus === 'late_paid' || payment?.paymentStatus === 'reconciliation_required'"
          class="mt-5"
          color="warning"
          variant="subtle"
          icon="i-lucide-shield-alert"
          title="收款需要商家核对"
          description="系统已保留服务商凭证，订单不会自动进入履约。请联系商家核对实际收款。"
        />

        <section
          v-if="refunds"
          class="mt-6 rounded-2xl border border-default bg-elevated p-4 sm:p-6"
          aria-labelledby="order-refunds-title"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-primary">
                订单售后
              </p>
              <h2
                id="order-refunds-title"
                class="mt-1 text-lg font-semibold text-highlighted"
              >
                退款进度
              </h2>
            </div>
            <UBadge
              :color="refunds.refundStatus === 'refunded' ? 'success' : refunds.refundStatus === 'partially_refunded' ? 'warning' : refunds.refundStatus === 'requested_or_processing' ? 'primary' : 'neutral'"
              variant="soft"
            >
              {{ refundStatusNames[refunds.refundStatus] }}
            </UBadge>
          </div>

          <dl class="mt-4 grid grid-cols-2 gap-4 border-t border-default pt-4 text-sm sm:grid-cols-4">
            <div>
              <dt class="text-muted">
                已确认实收
              </dt>
              <dd class="mt-1 font-semibold tabular-nums text-highlighted">
                ¥{{ refunds.confirmedReceiptAmount }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">
                可申请退款
              </dt>
              <dd class="mt-1 font-semibold tabular-nums text-highlighted">
                ¥{{ refunds.refundableAmount }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">
                已退款
              </dt>
              <dd class="mt-1 font-semibold tabular-nums text-highlighted">
                ¥{{ refunds.refundedAmount }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">
                等待处理预留
              </dt>
              <dd class="mt-1 font-semibold tabular-nums text-highlighted">
                ¥{{ refunds.refundReservedAmount }}
              </dd>
            </div>
          </dl>

          <UAlert
            v-if="refunds.payoutMode === 'manual_original_source'"
            class="mt-4"
            color="warning"
            variant="subtle"
            icon="i-lucide-hand-coins"
            title="游客订单采用人工原路退款"
            description="游客订单没有钱包。商家会按已确认的支付宝或微信收款来源线下办理；系统不会调用自动退款接口，也不会转入任意顾客账户。款项实际退回并记录凭证前，状态不会显示为成功。"
          />

          <UAlert
            v-if="refunds.blockedReason && refunds.blockedReason !== 'no_refundable_balance'"
            class="mt-4"
            color="warning"
            variant="subtle"
            icon="i-lucide-shield-alert"
            :title="refunds.blockedReason === 'payment_reconciliation_required' ? '收款凭证待核对' : refunds.blockedReason === 'payment_unresolved' ? '订单存在未决支付' : '暂无可退款实收凭证'"
            description="支付状态或服务商对账处理完成后，系统会重新计算可退款金额。退款不会改变已交付记录或订单履约状态。"
          />

          <UAlert
            v-if="refundError"
            class="mt-4"
            color="error"
            variant="soft"
            :title="refundError"
            role="alert"
            aria-live="assertive"
          />
          <UAlert
            v-if="refundMessage"
            class="mt-4"
            color="success"
            variant="soft"
            :title="refundMessage"
            role="status"
            aria-live="polite"
          />

          <form
            v-if="refunds.canRequest"
            class="mt-4 grid gap-3 rounded-xl border border-default bg-default/60 p-4 sm:grid-cols-[minmax(10rem,0.7fr)_minmax(0,1.3fr)_auto] sm:items-end"
            @submit.prevent="requestRefund"
          >
            <UFormField
              label="申请金额"
              :description="`最多 ¥${refunds.refundableAmount}`"
            >
              <UInput
                v-model="refundAmountInput"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                maxlength="19"
                aria-label="申请退款金额"
                class="w-full"
              />
            </UFormField>
            <UFormField label="退款原因">
              <UTextarea
                v-model="refundReason"
                :maxlength="500"
                :rows="2"
                aria-label="退款原因"
                placeholder="请说明申请退款的原因"
                class="w-full"
              />
            </UFormField>
            <UButton
              type="submit"
              color="primary"
              icon="i-lucide-send"
              :loading="requestingRefund"
              :disabled="requestingRefund || !refundRequestAmount || amountToCents(refundRequestAmount) > amountToCents(refunds.refundableAmount) || !refundReason.trim()"
            >
              提交退款申请
            </UButton>
          </form>

          <p class="mt-3 text-xs leading-5 text-muted">
            审核中的金额会先预留，审核通过后按真实收款来源逐笔退款。退款不会删除成交记录、清除已交付内容、恢复已消费库存或重置限购统计。
          </p>

          <ol
            v-if="refunds.items.length"
            class="mt-4 grid gap-3"
          >
            <li
              v-for="item in refunds.items"
              :key="item.id"
              class="min-w-0 rounded-xl border border-default p-3 sm:p-4"
            >
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="min-w-0">
                  <p class="font-medium text-highlighted">
                    申请 ¥{{ item.amount }} · {{ formatDate(item.createdAt) }}
                  </p>
                  <p class="mt-1 break-words text-sm text-muted">
                    {{ item.reason }}
                  </p>
                </div>
                <UBadge
                  :color="item.status === 'succeeded' ? 'success' : item.status === 'failed' || item.status === 'cancelled' ? 'error' : item.status === 'partially_succeeded' ? 'warning' : 'primary'"
                  variant="soft"
                >
                  {{ refundItemStatusLabel(item.status) }}
                </UBadge>
              </div>
              <p
                v-if="item.rejectionReason"
                class="mt-2 text-sm text-error"
              >
                商家说明：{{ item.rejectionReason }}
              </p>
              <dl class="mt-3 grid grid-cols-2 gap-3 border-t border-default pt-3 text-sm sm:grid-cols-3">
                <div>
                  <dt class="text-muted">
                    已成功
                  </dt><dd class="mt-1 tabular-nums text-highlighted">
                    ¥{{ item.succeededAmount }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    预留处理中
                  </dt><dd class="mt-1 tabular-nums text-highlighted">
                    ¥{{ item.reservedAmount }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    预计去向
                  </dt><dd class="mt-1 text-highlighted">
                    {{ item.payoutMode === 'wallet' ? '顾客本人钱包' : item.payoutMode === 'manual_original_source' ? '人工原支付来源' : '暂不可处理' }}
                  </dd>
                </div>
              </dl>
              <ul
                v-if="item.allocations.length"
                class="mt-3 grid gap-2"
              >
                <li
                  v-for="allocation in item.allocations"
                  :key="allocation.id"
                  class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm"
                >
                  <span class="text-highlighted">{{ refundSourceLabel(allocation.sourceBucket) }} → {{ refundDestinationLabel(allocation.destination) }}</span>
                  <span class="tabular-nums text-muted">¥{{ allocation.amount }} · {{ allocation.status === 'succeeded' ? '已完成' : allocation.status === 'reserved' ? '处理中' : '已释放' }}</span>
                </li>
              </ul>
            </li>
          </ol>
          <p
            v-else
            class="mt-4 rounded-lg border border-dashed border-default p-4 text-sm text-muted"
          >
            暂无退款申请。
          </p>
        </section>

        <section
          class="mt-6"
          aria-labelledby="order-items-title"
        >
          <h2
            id="order-items-title"
            class="text-lg font-semibold text-highlighted"
          >
            成交商品快照
          </h2>
          <ul class="mt-3 space-y-3">
            <li
              v-for="item in order.items"
              :key="item.id"
              class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <h3 class="break-words font-medium text-highlighted">
                    {{ item.productName }}
                  </h3>
                  <p class="mt-1 break-words text-sm text-muted">
                    {{ item.options.map(option => `${option.groupName}：${option.valueName}`).join(' / ') || '默认规格' }}
                  </p>
                  <p class="mt-1 font-mono text-xs text-dimmed">
                    SKU {{ item.skuCode }}
                  </p>
                </div>
                <UBadge
                  :color="item.fulfillmentStatus === 'completed' ? 'success' : 'neutral'"
                  variant="soft"
                >
                  {{ item.fulfillmentStatus === 'completed' ? '已交付' : item.fulfilledQuantity ? `已交付 ${item.fulfilledQuantity} / ${item.quantity}` : '等待交付' }}
                </UBadge>
              </div>
              <dl class="mt-4 grid grid-cols-2 gap-3 border-t border-default pt-3 text-sm sm:grid-cols-4">
                <div>
                  <dt class="text-muted">
                    成交单价
                  </dt><dd class="mt-1 tabular-nums text-highlighted">
                    ¥{{ item.unitPrice }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    数量
                  </dt><dd class="mt-1 tabular-nums text-highlighted">
                    {{ item.quantity }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    成交小计
                  </dt><dd class="mt-1 font-medium tabular-nums text-highlighted">
                    ¥{{ item.lineAmount }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    交付方式
                  </dt><dd class="mt-1 text-highlighted">
                    {{ item.fulfillmentMethod === 'manual' ? '人工数字交付' : item.fulfillmentMethod === 'code_pool' ? 'SKU 卡密池自动发货' : item.fulfillmentMethod === 'fixed_content' ? '固定文本自动交付' : item.fulfillmentMethod === 'link' ? '固定链接自动交付' : '尚未开放' }}
                  </dd>
                </div>
              </dl>

              <UAlert
                v-if="['code_pool', 'fixed_content', 'link'].includes(item.fulfillmentMethod) && order.status === 'processing' && item.fulfilledQuantity < item.quantity"
                class="mt-4"
                color="info"
                variant="soft"
                icon="i-lucide-loader-circle"
                :title="item.fulfillmentStatus === 'failed' ? '自动交付正在安全重试' : '自动交付处理中'"
                :description="item.fulfillmentAttempts.some(attempt => attempt.status === 'failed') ? fulfillmentFailureHint(item.fulfillmentAttempts.find(attempt => attempt.status === 'failed')?.failureCode ?? null) : '交付仅使用订单绑定版本，页面会自动刷新进度；付款确认前不会展示内容。'"
                role="status"
              />

              <section
                v-if="item.deliveries.length"
                class="mt-4 border-t border-default pt-4"
                :aria-labelledby="`delivery-${item.id}`"
              >
                <h4
                  :id="`delivery-${item.id}`"
                  class="font-medium text-highlighted"
                >
                  已完成的数字交付
                </h4>
                <ol class="mt-3 grid gap-2">
                  <li
                    v-for="delivery in item.deliveries"
                    :key="delivery.id"
                    class="min-w-0 rounded-lg border border-success/30 bg-success/5 p-3"
                  >
                    <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                      <span>第 {{ delivery.unitIndex }} 件</span>
                      <div class="flex flex-wrap items-center gap-2">
                        <time :datetime="delivery.createdAt">{{ formatDate(delivery.createdAt) }}</time>
                        <UButton
                          color="neutral"
                          variant="outline"
                          size="xs"
                          icon="i-lucide-copy"
                          :aria-label="`复制第 ${delivery.unitIndex} 件交付内容`"
                          @click="copyDelivery(delivery.id, delivery.content)"
                        >
                          {{ copiedDeliveryId === delivery.id ? '已复制' : delivery.contentFormat === 'link' ? '复制链接' : '复制内容' }}
                        </UButton>
                      </div>
                    </div>
                    <p
                      v-if="delivery.title"
                      class="mt-3 font-medium text-highlighted"
                    >
                      {{ delivery.title }}
                    </p>
                    <a
                      v-if="delivery.contentFormat === 'link' && safeDeliveryHref(delivery.content)"
                      class="mt-2 inline-block break-all text-primary underline underline-offset-2"
                      :href="safeDeliveryHref(delivery.content)"
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                    >
                      打开安全链接
                    </a>
                    <p
                      v-else-if="delivery.contentFormat === 'link'"
                      class="mt-2 break-all text-sm text-error"
                    >
                      链接校验失败，已隐藏点击入口。请联系商家核验。
                    </p>
                    <SafeMarkdown
                      v-else-if="delivery.contentFormat === 'markdown'"
                      class="mt-2"
                      :content="delivery.content"
                    />
                    <pre
                      v-else
                      class="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-sm text-highlighted"
                    >{{ delivery.content }}</pre>
                    <p
                      v-if="delivery.contentFormat === 'link'"
                      class="mt-2 break-all font-mono text-sm text-muted"
                    >
                      {{ delivery.content }}
                    </p>
                    <p
                      v-if="delivery.accessInstructions"
                      class="mt-3 whitespace-pre-wrap break-words text-sm text-muted"
                    >
                      {{ delivery.accessInstructions }}
                    </p>
                  </li>
                </ol>
                <p
                  v-if="deliveryCopyMessage"
                  class="mt-2 text-xs text-muted"
                  role="status"
                  aria-live="polite"
                >
                  {{ deliveryCopyMessage }}
                </p>
              </section>
            </li>
          </ul>
        </section>

        <section
          class="mt-7"
          aria-labelledby="order-events-title"
        >
          <h2
            id="order-events-title"
            class="text-lg font-semibold text-highlighted"
          >
            订单状态记录
          </h2>
          <ol
            v-if="order.statusEvents.length"
            class="mt-3 divide-y divide-default rounded-xl border border-default bg-elevated px-4"
          >
            <li
              v-for="(event, index) in order.statusEvents"
              :key="`${event.createdAt}-${index}`"
              class="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
            >
              <span class="text-highlighted">{{ statusNames[event.previousStatus] }} → {{ statusNames[event.nextStatus] }}</span>
              <time
                class="text-muted"
                :datetime="event.createdAt"
              >{{ formatDate(event.createdAt) }}</time>
            </li>
          </ol>
          <p
            v-else
            class="mt-3 rounded-xl border border-default bg-elevated p-4 text-sm text-muted"
          >
            当前订单处于初始状态。
          </p>
        </section>
      </template>
    </main>
  </UContainer>
</template>
