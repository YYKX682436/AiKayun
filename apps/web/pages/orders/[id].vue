<script setup lang="ts">
import type { CustomerOrderPayment, ExternalPaymentMethod, OrderDetail } from '@aikayun/contracts'
import { CustomerApiError, useCustomerApi } from '~/composables/useCustomerApi'

const route = useRoute()
const customerApi = useCustomerApi()
const orderId = computed(() => String(route.params.id))
const order = shallowRef<OrderDetail | null>(null)
const payment = shallowRef<CustomerOrderPayment | null>(null)
const loading = ref(false)
const cancelling = ref(false)
const creatingPayment = ref(false)
const refreshingPayment = ref(false)
const confirmCancel = ref(false)
const errorMessage = ref('')
const mounted = ref(false)
const selectedChannelId = ref('')
const selectedPaymentMethod = ref<ExternalPaymentMethod>('alipay')
const selectedPaymentMode = ref<'external' | 'wallet' | 'hybrid'>('external')
const hybridWalletAmountInput = ref('')
const qrDataUrl = ref('')
const qrError = ref('')
let sequence = 0
let qrSequence = 0
let renderedQrValue = ''

useSeoMeta({ title: '订单详情', description: '查看订单状态、成交快照和已完成的数字交付。', robots: 'noindex, nofollow' })
useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const isCustomer = computed(() => Boolean(customerApi.session.value?.customer.id))
const hasActiveAttempt = computed(() => Boolean(payment.value?.attempt
  && ['created', 'pending', 'reconciliation_required'].includes(payment.value.attempt.status)))
const canCancel = computed(() => order.value?.status === 'pending_payment' && !hasActiveAttempt.value)
const selectedChannel = computed(() => payment.value?.channels.find(channel => channel.id === selectedChannelId.value) ?? null)
const qrAction = computed(() => payment.value?.attempt?.action?.type === 'qr_code'
  ? payment.value.attempt.action.value
  : '')

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

async function loadOrder() {
  const currentSequence = ++sequence
  const identityAtStart = customerApi.identityVersion.value
  loading.value = true
  errorMessage.value = ''
  try {
    const path = isCustomer.value ? `/api/v1/customer/orders/${orderId.value}` : `/api/v1/guest/orders/${orderId.value}`
    const [result, paymentResult] = await Promise.all([
      customerApi.request<OrderDetail>(path),
      customerApi.request<CustomerOrderPayment>(`/api/v1/orders/${orderId.value}/payment`),
    ])
    if (currentSequence !== sequence || identityAtStart !== customerApi.identityVersion.value) return
    order.value = result
    payment.value = paymentResult
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
})

watch(() => customerApi.identityVersion.value, () => {
  if (!mounted.value) return
  order.value = null
  payment.value = null
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
            :title="order.paymentStatus === 'not_required' ? '零元订单，等待商家交付' : '付款已确认，等待商家交付'"
            description="订单正在履约。商家完成人工数字交付后，交付内容会安全显示在此订单详情中。"
          />
          <UAlert
            v-else-if="order.status === 'completed'"
            color="success"
            variant="subtle"
            icon="i-lucide-circle-check"
            title="订单已完成"
            description="订单中的人工数字交付内容已记录在下方订单项。"
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
                    {{ item.fulfillmentMethod === 'manual' ? '人工数字交付' : '尚未开放' }}
                  </dd>
                </div>
              </dl>

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
                      <time :datetime="delivery.createdAt">{{ formatDate(delivery.createdAt) }}</time>
                    </div>
                    <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-sm text-highlighted">{{ delivery.content }}</pre>
                  </li>
                </ol>
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
