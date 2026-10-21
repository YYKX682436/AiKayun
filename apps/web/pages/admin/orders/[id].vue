<script setup lang="ts">
import type { AdminOrderDetail, AdminOrderRefunds, AdminOrderRefundMutation, ManualFulfillmentResult } from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '订单详情' })
useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const route = useRoute()
const orderId = computed(() => String(route.params.id))
const { request } = useAdminApi()
const data = shallowRef<AdminOrderDetail | null>(null)
const refunds = shallowRef<AdminOrderRefunds | null>(null)
const loading = ref(false)
const savingItemId = ref('')
const reconcilingAttemptId = ref('')
const errorMessage = ref('')
const successMessage = ref('')
const deliveryDrafts = reactive<Record<string, string>>({})
const rejectionDrafts = reactive<Record<string, string>>({})
const manualDrafts = reactive<Record<string, { providerRefundId: string; amount: string; actualRefundedAt: string; evidenceSummary: string; resolutionNote: string }>>({})
const refundActionKey = ref('')
let sequence = 0

function statusLabel(status: AdminOrderDetail['order']['status'], paymentStatus: AdminOrderDetail['order']['paymentStatus']): string {
  if (status === 'pending_payment') return '等待付款'
  if (status === 'processing') return paymentStatus === 'not_required' ? '等待订单交付' : '付款成功 · 等待订单交付'
  if (status === 'completed') return '已完成'
  return '已关闭'
}

function fulfillmentFailureLabel(code: AdminOrderDetail['fulfillmentAttempts'][number]['failureCode']): string {
  if (code === 'CODE_POOL_KEY_UNAVAILABLE') return '服务端缺少历史加密密钥'
  if (code === 'CODE_POOL_DECRYPTION_FAILED') return '卡密密文完整性校验失败'
  if (code === 'CODE_POOL_PAYMENT_UNRESOLVED') return '付款或对账状态尚未确认'
  if (code === 'CODE_POOL_DATA_INCONSISTENT') return '卡密、库存或交付记录不一致'
  return ''
}

function fulfillmentAttemptStatusLabel(status: AdminOrderDetail['fulfillmentAttempts'][number]['status']): string {
  return status === 'processing' ? '处理中' : status === 'unknown' ? '结果未知' : status === 'succeeded' ? '成功' : '失败'
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function refundStatusLabel(status: AdminOrderRefunds['items'][number]['status']): string {
  const names: Record<typeof status, string> = {
    requested: '待审核', approved: '已通过', processing: '处理中',
    partially_succeeded: '部分成功', succeeded: '已成功', failed: '失败', cancelled: '已拒绝',
  }
  return names[status]
}

function refundBucketLabel(bucket: AdminOrderRefunds['items'][number]['allocations'][number]['sourceBucket']): string {
  if (bucket === 'gift') return '赠送余额'
  if (bucket === 'cash') return '现金余额'
  return '外部收款'
}

function refundDestinationLabel(destination: AdminOrderRefunds['items'][number]['allocations'][number]['destination']): string {
  if (destination === 'gift_balance') return '赠送余额'
  if (destination === 'cash_balance') return '现金余额'
  return '原支付来源（人工）'
}

function manualDraft(attemptId: string, amount: string) {
  if (!manualDrafts[attemptId]) {
    const now = new Date()
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    manualDrafts[attemptId] = {
      providerRefundId: '', amount, actualRefundedAt: local, evidenceSummary: '', resolutionNote: '',
    }
  }
  return manualDrafts[attemptId]!
}

function stateLabel(value: string): string {
  return value === 'reserve' ? '预留' : value === 'release' ? '释放' : '消耗'
}

function ownerLabel(): string {
  if (!data.value) return ''
  if (data.value.owner.type === 'customer') return `顾客账户 · ${data.value.owner.customerUsername ?? data.value.owner.customerId ?? '已删除账户'}`
  return `游客会话 · ${data.value.owner.guestSessionId ?? ''}`
}

async function loadOrder() {
  const currentSequence = ++sequence
  loading.value = true
  errorMessage.value = ''
  try {
    const [result, refundResult] = await Promise.all([
      request<AdminOrderDetail>(`/api/v1/admin/orders/${orderId.value}`),
      request<AdminOrderRefunds>(`/api/v1/admin/orders/${orderId.value}/refunds`),
    ])
    if (currentSequence !== sequence) return
    data.value = result
    refunds.value = refundResult
  } catch (error) {
    if (currentSequence !== sequence) return
    errorMessage.value = error instanceof Error ? error.message : '订单详情暂时无法加载。'
  } finally {
    if (currentSequence === sequence) loading.value = false
  }
}

async function refundIdempotencyKey(scope: string, requestBody: Record<string, unknown>): Promise<string> {
  if (!import.meta.client) throw new Error('请在后台浏览器中处理退款。')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({
    orderId: orderId.value, scope, requestBody,
  })))
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const storageKey = `aikayun-admin-refund-v1:${hash}`
  try {
    const existing = sessionStorage.getItem(storageKey)
    if (existing && /^[0-9a-f-]{36}$/iu.test(existing)) return existing
    const next = crypto.randomUUID()
    sessionStorage.setItem(storageKey, next)
    return next
  } catch {
    throw new Error('浏览器无法保存退款操作的幂等标识，请启用会话存储后重试。')
  }
}

async function runRefundAction(
  scope: string,
  path: string,
  body: Record<string, unknown>,
  successText: string,
) {
  if (refundActionKey.value) return
  refundActionKey.value = scope
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const result = await request<AdminOrderRefundMutation>(path, {
      method: 'POST', body: { ...body, idempotencyKey: await refundIdempotencyKey(scope, body) },
    })
    refunds.value = result.refunds
    successMessage.value = result.repeated ? '已读取这项相同操作的最新结果。' : successText
  } catch (error) {
    errorMessage.value = error instanceof AdminApiError || error instanceof Error
      ? error.message
      : '退款操作结果尚未确认，请刷新订单退款记录后检查。'
    try { refunds.value = await request<AdminOrderRefunds>(`/api/v1/admin/orders/${orderId.value}/refunds`) } catch { /* Keep the action error visible. */ }
  } finally {
    refundActionKey.value = ''
  }
}

async function approveRefund(refundId: string) {
  await runRefundAction(`approve:${refundId}`, `/api/v1/admin/orders/${orderId.value}/refunds/${refundId}/approve`, {}, '已审核通过，退款分配已预留。顾客钱包退款已在同一事务中完成。')
}

async function rejectRefund(refundId: string) {
  const reason = (rejectionDrafts[refundId] ?? '').trim()
  if (!reason) {
    errorMessage.value = '请填写拒绝原因。'
    return
  }
  await runRefundAction(`reject:${refundId}`, `/api/v1/admin/orders/${orderId.value}/refunds/${refundId}/reject`, { reason }, '已拒绝此退款申请。')
}

async function retryGuestRefund(refund: AdminOrderRefunds['items'][number]) {
  const allocationState = refund.allocations.map(allocation => `${allocation.id}:${allocation.status}`).join('|')
  await runRefundAction(`retry:${refund.id}:${allocationState}`, `/api/v1/admin/orders/${orderId.value}/refunds/${refund.id}/retry`, {}, '已为待处理金额重新预留资金来源。')
}

async function startManualRefund(refundId: string, allocationId: string) {
  await runRefundAction(`manual-start:${allocationId}`, `/api/v1/admin/orders/${orderId.value}/refunds/${refundId}/allocations/${allocationId}/manual-attempts`, {}, '已记录人工原路退款操作开始。请在实际完成转账后再登记结果。')
}

async function resolveManualRefund(
  refundId: string,
  allocationId: string,
  attemptId: string,
  outcome: 'succeeded' | 'failed' | 'unknown',
) {
  const draft = manualDrafts[attemptId]
  if (!draft) return
  let body: Record<string, unknown>
  if (outcome === 'succeeded') {
    if (!draft.providerRefundId.trim() || !draft.amount.trim() || !draft.actualRefundedAt || !draft.evidenceSummary.trim()) {
      errorMessage.value = '确认成功必须填写实际退款流水号、精确金额、时间和证据摘要。'
      return
    }
    body = {
      outcome, providerRefundId: draft.providerRefundId.trim(), amount: draft.amount,
      actualRefundedAt: new Date(draft.actualRefundedAt).toISOString(), evidenceSummary: draft.evidenceSummary.trim(),
    }
  } else {
    if (!draft.resolutionNote.trim()) {
      errorMessage.value = outcome === 'unknown' ? '请说明哪些情况仍无法确认。' : '请说明已核实没有实际退款的依据。'
      return
    }
    body = { outcome, resolutionNote: draft.resolutionNote.trim() }
  }
  await runRefundAction(
    `manual-result:${attemptId}:${outcome}`,
    `/api/v1/admin/orders/${orderId.value}/refunds/${refundId}/allocations/${allocationId}/manual-attempts/${attemptId}/resolve`,
    body,
    outcome === 'succeeded' ? '已记录真实原路退款凭证并确认成功。' : outcome === 'unknown' ? '结果已标记为未知，资金继续预留，不能重复发起转账。' : '已确认未发生退款并释放本次预留。',
  )
}

async function reconcilePayment(attemptId: string) {
  if (reconcilingAttemptId.value) return
  reconcilingAttemptId.value = attemptId
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const result = await request<{
      state: 'resolved' | 'still_open' | 'throttled'
      providerStatus: 'paid' | 'pending' | 'failed' | 'unknown' | null
      message: string
    }>(`/api/v1/admin/orders/${orderId.value}/payments/${attemptId}/reconcile`, { method: 'POST' })
    await loadOrder()
    successMessage.value = result.message
  } catch (error) {
    errorMessage.value = error instanceof AdminApiError || error instanceof Error
      ? error.message
      : '服务商核验未能确认，请查看支付事件后重试。'
    await loadOrder()
  } finally {
    reconcilingAttemptId.value = ''
  }
}

function deliveriesFor(itemId: string): string[] | null {
  const source = deliveryDrafts[itemId] ?? ''
  const deliveries = source.split(/\r?\n/u)
  if (deliveries.length < 1 || deliveries.length > 20 || deliveries.some(value => !value.trim() || value.length > 512)) return null
  return deliveries
}

async function stableOperationId(itemId: string, deliveries: string[]): Promise<{ id: string; storageKey: string }> {
  if (!import.meta.client) throw new Error('请在后台浏览器中提交人工交付。')
  const storageKey = `aikayun-admin-fulfillment-v1:${orderId.value}:${itemId}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(deliveries)))
  const contentHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  type PendingOperation = { id?: string; contentHash?: string }
  let existing: PendingOperation | null = null
  try {
    const raw = sessionStorage.getItem(storageKey)
    if (raw) existing = JSON.parse(raw) as PendingOperation
  } catch {
    throw new Error('浏览器无法安全保存本次履约的重试标识，请启用会话存储后重试。')
  }
  if (existing?.contentHash === contentHash && typeof existing.id === 'string') return { id: existing.id, storageKey }
  const id = crypto.randomUUID()
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ id, contentHash }))
  } catch {
    throw new Error('浏览器无法安全保存本次履约的重试标识，请启用会话存储后重试。')
  }
  return { id, storageKey }
}

async function recordDelivery(itemId: string) {
  const current = data.value?.order
  const item = current?.items.find(row => row.id === itemId)
  if (!current || !item || current.status !== 'processing' || item.fulfillmentMethod !== 'manual' || savingItemId.value) return
  const deliveries = deliveriesFor(itemId)
  if (!deliveries) {
    errorMessage.value = '每件交付内容需单独占一行；内容不能为空、每条最多 512 个字符，每次最多录入 20 件。'
    return
  }
  const remaining = item.quantity - item.fulfilledQuantity - item.fulfillmentReservedQuantity
  if (deliveries.length > remaining) {
    errorMessage.value = `本次交付 ${deliveries.length} 件，但订单项最多还可交付 ${remaining} 件。`
    return
  }
  savingItemId.value = itemId
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const operation = await stableOperationId(itemId, deliveries)
    const result = await request<ManualFulfillmentResult>(`/api/v1/admin/orders/${orderId.value}/items/${itemId}/fulfillments`, {
      method: 'POST',
      body: { operationId: operation.id, deliveries: deliveries.map(content => ({ content })) },
    })
    try { sessionStorage.removeItem(operation.storageKey) } catch { /* The server operation remains idempotent for its request key. */ }
    await loadOrder()
    deliveryDrafts[itemId] = ''
    successMessage.value = result.repeated ? '这是已成功记录的相同履约请求；库存和订单状态未重复变更。' : `已记录 ${deliveries.length} 件实际交付，库存及订单状态已由数据库规则更新。`
  } catch (error) {
    errorMessage.value = error instanceof AdminApiError || error instanceof Error
      ? error.message
      : '人工交付未能确认。请勿更换内容或操作标识，先刷新订单检查履约记录后再重试。'
    await loadOrder()
  } finally {
    savingItemId.value = ''
  }
}

onMounted(() => { void loadOrder() })
onBeforeUnmount(() => { sequence++ })
</script>

<template>
  <UDashboardPanel id="admin-main">
    <template #header>
      <UDashboardNavbar title="订单详情">
        <template #left>
          <UButton
            to="/admin/orders"
            color="neutral"
            variant="ghost"
            icon="i-lucide-arrow-left"
          >
            订单列表
          </UButton>
        </template>
        <template #right>
          <ThemeModeSelect />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <main
        id="admin-main-content"
        class="mx-auto w-full max-w-[90rem] min-w-0 px-4 py-5 sm:px-6 lg:px-8"
      >
        <header
          v-if="data"
          class="mb-6 flex flex-wrap items-start justify-between gap-3"
        >
          <div class="min-w-0">
            <p class="text-sm font-medium text-primary">
              成交与履约
            </p>
            <h1 class="mt-1 break-all font-mono text-xl font-semibold tracking-tight text-highlighted sm:text-2xl">
              订单 {{ data.order.id }}
            </h1>
            <p class="mt-2 break-all text-sm text-muted">
              {{ ownerLabel() }} · 创建于 {{ formatDate(data.order.createdAt) }}
            </p>
          </div>
          <UBadge
            :color="data.order.status === 'completed' ? 'success' : data.order.status === 'closed' ? 'neutral' : data.order.status === 'pending_payment' ? 'warning' : 'primary'"
            variant="soft"
            size="lg"
          >
            {{ statusLabel(data.order.status, data.order.paymentStatus) }}
          </UBadge>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-refresh-cw"
            :loading="loading"
            @click="loadOrder"
          >
            刷新订单与交付
          </UButton>
        </header>

        <UAlert
          v-if="errorMessage"
          class="mb-4"
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
              重新读取
            </UButton>
          </template>
        </UAlert>
        <UAlert
          v-if="successMessage"
          class="mb-4"
          color="success"
          variant="soft"
          :title="successMessage"
          role="status"
          aria-live="polite"
        />
        <div
          v-if="loading && !data"
          class="space-y-3"
          aria-label="正在加载订单"
          aria-busy="true"
        >
          <div
            v-for="index in 3"
            :key="index"
            class="h-28 animate-pulse rounded-xl border border-default bg-elevated motion-reduce:animate-none"
          />
        </div>

        <template v-if="data">
          <UAlert
            v-if="data.order.status === 'pending_payment' && data.order.totalAmount !== '0.00'"
            class="mb-5"
            color="warning"
            variant="subtle"
            title="等待付款"
            description="付款状态只由已验证的服务商通知或主动查单更新。后台没有手工标记已付款的操作。"
          />

          <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
            <section
              class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
              aria-labelledby="admin-order-summary-title"
            >
              <h2
                id="admin-order-summary-title"
                class="font-semibold text-highlighted"
              >
                订单金额与付款状态
              </h2>
              <dl class="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
                <div>
                  <dt class="text-muted">
                    订单金额
                  </dt><dd class="mt-1 text-lg font-semibold tabular-nums text-highlighted">
                    ¥{{ data.order.totalAmount }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    付款状态
                  </dt><dd class="mt-1 font-medium text-highlighted">
                    {{ data.order.paymentStatus === 'not_required' ? '零元，无需付款' : data.order.paymentStatus === 'unpaid' ? '尚未付款' : '已确认付款' }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    订单项
                  </dt><dd class="mt-1 font-medium text-highlighted">
                    {{ data.order.itemCount }}
                  </dd>
                </div>
              </dl>
            </section>

            <section
              class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
              aria-labelledby="inventory-audit-title"
            >
              <h2
                id="inventory-audit-title"
                class="font-semibold text-highlighted"
              >
                库存预留与事件
              </h2>
              <ul class="mt-3 space-y-3">
                <li
                  v-for="entry in data.inventory"
                  :key="entry.orderItemId"
                  class="min-w-0 rounded-lg border border-default p-3"
                >
                  <p class="break-all font-mono text-xs text-muted">
                    订单项 {{ entry.orderItemId }}
                  </p>
                  <p class="mt-1 text-sm text-highlighted">
                    当前预留 {{ entry.reservedQuantity }} 件
                  </p>
                  <p
                    v-if="!entry.reservationId"
                    class="mt-1 text-xs text-muted"
                  >
                    unlimited 模式，不建立数量库存预留。
                  </p>
                  <ol
                    v-if="entry.events.length"
                    class="mt-2 space-y-1 text-xs text-muted"
                  >
                    <li
                      v-for="(event, index) in entry.events"
                      :key="`${event.createdAt}-${index}`"
                      class="flex flex-wrap justify-between gap-2"
                    >
                      <span>{{ stateLabel(event.action) }} {{ event.quantity }} 件</span>
                      <time :datetime="event.createdAt">{{ formatDate(event.createdAt) }}</time>
                    </li>
                  </ol>
                  <p
                    v-else
                    class="mt-2 text-xs text-muted"
                  >
                    尚无数量库存事件。
                  </p>
                </li>
              </ul>
            </section>
          </div>

          <section
            class="mt-5 rounded-xl border border-default bg-elevated p-4 sm:p-5"
            aria-labelledby="admin-payment-evidence-title"
          >
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2
                  id="admin-payment-evidence-title"
                  class="font-semibold text-highlighted"
                >
                  在线支付与收款凭证
                </h2>
                <p class="mt-1 text-sm text-muted">
                  订单事实来自支付尝试、回调/查单事件与受保护的支付回执。
                </p>
              </div>
              <UBadge
                :color="data.payments.needsReconciliation ? 'warning' : 'neutral'"
                variant="soft"
              >
                {{ data.payments.needsReconciliation ? '需要核对' : '无待核对异常' }}
              </UBadge>
            </div>
            <UAlert
              v-if="data.payments.needsReconciliation"
              class="mt-4"
              color="warning"
              variant="subtle"
              icon="i-lucide-shield-alert"
              title="存在待核对支付事件"
              description="系统已保留服务商事件和实际收款回执。请先核对交易号、金额和订单状态；此页面不能伪造付款或自动履约。"
            />
            <UAlert
              v-if="!data.payments.attempts.length"
              class="mt-4"
              color="neutral"
              variant="subtle"
              title="尚无在线支付尝试"
              description="此订单目前没有建立在线支付尝试。"
            />
            <ol
              v-else
              class="mt-4 grid gap-4"
            >
              <li
                v-for="attempt in data.payments.attempts"
                :key="attempt.id"
                class="min-w-0 rounded-lg border border-default p-3 sm:p-4"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="break-all font-mono text-xs text-muted">
                      支付尝试 {{ attempt.id }} · {{ attempt.providerType }}
                    </p>
                    <p class="mt-1 break-words font-medium text-highlighted">
                      {{ attempt.channelName ?? '未知通道' }} · {{ attempt.paymentMethod === 'wechat' ? '微信支付' : attempt.paymentMethod === 'alipay' ? '支付宝' : '未知方式' }}
                    </p>
                  </div>
                  <UBadge
                    :color="attempt.receiptDisposition === 'on_time' ? 'success' : attempt.receiptDisposition ? 'warning' : attempt.status === 'failed' ? 'error' : 'neutral'"
                    variant="soft"
                  >
                    {{ attempt.receiptDisposition === 'on_time' ? '已确认收款' : attempt.receiptDisposition === 'late' ? '迟到收款' : attempt.receiptDisposition === 'excess' ? '超额收款' : attempt.receiptDisposition === 'amount_mismatch' ? '金额不符' : attempt.status }}
                  </UBadge>
                </div>
                <dl class="mt-3 grid min-w-0 grid-cols-1 gap-3 border-t border-default pt-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  <div class="min-w-0">
                    <dt class="text-muted">
                      应付金额
                    </dt>
                    <dd class="mt-1 font-medium tabular-nums text-highlighted">
                      ¥{{ attempt.expectedAmount }}
                    </dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="text-muted">
                      已验证实收
                    </dt>
                    <dd class="mt-1 font-medium tabular-nums text-highlighted">
                      {{ attempt.actualAmount ? `¥${attempt.actualAmount}` : '尚无回执' }}
                    </dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="text-muted">
                      平台交易号
                    </dt>
                    <dd class="mt-1 break-all font-mono text-xs text-highlighted">
                      {{ attempt.providerTransactionId ?? attempt.providerOrderId ?? '尚未返回' }}
                    </dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="text-muted">
                      商户订单号
                    </dt>
                    <dd class="mt-1 break-all font-mono text-xs text-highlighted">
                      {{ attempt.merchantOrderNo ?? '—' }}
                    </dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="text-muted">
                      支付创建时间
                    </dt>
                    <dd class="mt-1 text-highlighted">
                      {{ formatDate(attempt.createdAt) }}
                    </dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="text-muted">
                      支付完成时间
                    </dt>
                    <dd class="mt-1 text-highlighted">
                      {{ attempt.completedAt ? formatDate(attempt.completedAt) : '尚未确认' }}
                    </dd>
                  </div>
                </dl>
                <UAlert
                  v-if="attempt.providerErrorCode"
                  class="mt-3"
                  color="warning"
                  variant="subtle"
                  :title="`服务商状态：${attempt.providerErrorCode}`"
                  description="请查看下方事件并通过服务商后台核对，不要手工改写订单付款状态。"
                />
                <div
                  v-if="attempt.reconciliationCases.length"
                  class="mt-3 grid gap-2"
                >
                  <div
                    v-for="reconciliationCase in attempt.reconciliationCases"
                    :key="reconciliationCase.id"
                    class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm"
                  >
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <p class="font-medium text-highlighted">
                        {{ reconciliationCase.state === 'open' ? '待核对' : '已核对' }} · {{ reconciliationCase.reason }} · {{ formatDate(reconciliationCase.openedAt) }}
                      </p>
                      <UButton
                        v-if="reconciliationCase.state === 'open'"
                        size="sm"
                        color="warning"
                        variant="soft"
                        :loading="reconcilingAttemptId === attempt.id"
                        :disabled="Boolean(reconcilingAttemptId)"
                        @click="reconcilePayment(attempt.id)"
                      >
                        重新向服务商核验
                      </UButton>
                    </div>
                    <p class="mt-1 text-muted">
                      只有新的认证查单与既有查单及实际回执一致时才会解除异常；此操作不会手工标记付款。
                    </p>
                    <p
                      v-if="reconciliationCase.state === 'resolved'"
                      class="mt-1 break-all text-muted"
                    >
                      {{ reconciliationCase.resolvedAt ? formatDate(reconciliationCase.resolvedAt) : '' }} · 管理员 {{ reconciliationCase.resolvedByAdminId ?? '未知' }} · 查单 SHA-256 {{ reconciliationCase.resolutionQueryEventSha256 ?? '未知' }}
                    </p>
                  </div>
                </div>
                <div
                  v-if="attempt.events.length"
                  class="mt-4 border-t border-default pt-3"
                >
                  <h3 class="text-sm font-medium text-highlighted">
                    服务商事件
                  </h3>
                  <ol class="mt-2 grid gap-2">
                    <li
                      v-for="event in attempt.events"
                      :key="event.id"
                      class="min-w-0 rounded-md bg-muted/50 p-3 text-xs"
                    >
                      <div class="flex flex-wrap justify-between gap-2">
                        <span class="font-medium text-highlighted">{{ event.source === 'callback' ? '异步回调' : '主动查单' }} · {{ event.verification === 'verified' ? '已验证' : '未验证' }} · {{ event.disposition }}</span>
                        <time
                          class="text-muted"
                          :datetime="event.receivedAt"
                        >{{ formatDate(event.receivedAt) }}</time>
                      </div>
                      <p class="mt-1 break-all text-muted">
                        状态 {{ event.providerStatus }} · 金额 {{ event.reportedAmount ? `¥${event.reportedAmount}` : '未知' }} · 交易号 {{ event.providerTransactionId ?? '未知' }}
                      </p>
                      <p
                        v-if="event.providerTimeText"
                        class="mt-1 break-all text-muted"
                      >
                        服务商原始完成时间 {{ event.providerTimeText }}
                      </p>
                      <p
                        v-if="event.errorCode"
                        class="mt-1 break-all text-warning"
                      >
                        {{ event.errorCode }}
                      </p>
                      <p class="mt-1 break-all font-mono text-dimmed">
                        事件 SHA-256 {{ event.eventSha256 }}
                      </p>
                    </li>
                  </ol>
                </div>
              </li>
            </ol>
          </section>

          <section
            v-if="refunds"
            class="mt-5 rounded-xl border border-default bg-elevated p-4 sm:p-5"
            aria-labelledby="admin-order-refunds-title"
          >
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2
                  id="admin-order-refunds-title"
                  class="font-semibold text-highlighted"
                >
                  退款与订单售后
                </h2>
                <p class="mt-1 text-sm text-muted">
                  退款状态由实际回执、预留和不可变账本流水推导，不会改写成交或履约状态。
                </p>
              </div>
              <UBadge
                :color="refunds.refundStatus === 'refunded' ? 'success' : refunds.refundStatus === 'partially_refunded' ? 'warning' : refunds.refundStatus === 'requested_or_processing' ? 'primary' : 'neutral'"
                variant="soft"
              >
                {{ refunds.refundStatus === 'refunded' ? '全额已退' : refunds.refundStatus === 'partially_refunded' ? '部分已退' : refunds.refundStatus === 'requested_or_processing' ? '审核或退款处理中' : '尚无成功退款' }}
              </UBadge>
            </div>

            <dl class="mt-4 grid grid-cols-2 gap-3 border-t border-default pt-4 text-sm sm:grid-cols-4">
              <div>
                <dt class="text-muted">
                  确认实收
                </dt><dd class="mt-1 font-semibold tabular-nums text-highlighted">
                  ¥{{ refunds.confirmedReceiptAmount }}
                </dd>
              </div>
              <div>
                <dt class="text-muted">
                  当前可退款
                </dt><dd class="mt-1 font-semibold tabular-nums text-highlighted">
                  ¥{{ refunds.refundableAmount }}
                </dd>
              </div>
              <div>
                <dt class="text-muted">
                  已退款
                </dt><dd class="mt-1 font-semibold tabular-nums text-highlighted">
                  ¥{{ refunds.refundedAmount }}
                </dd>
              </div>
              <div>
                <dt class="text-muted">
                  来源预留
                </dt><dd class="mt-1 font-semibold tabular-nums text-highlighted">
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
              title="游客订单：人工原路退款"
              description="请在支付宝或微信商户后台按来源回执线下办理。当前没有自动退款协议；开始操作不会联网转账，只有真实退款流水、精确金额、实际时间和证据摘要齐全后，才能登记成功。请勿改成顾客钱包退款。"
            />

            <UAlert
              v-if="refunds.blockedReason && refunds.blockedReason !== 'no_refundable_balance'"
              class="mt-4"
              color="warning"
              variant="subtle"
              icon="i-lucide-shield-alert"
              :title="refunds.blockedReason === 'payment_reconciliation_required' ? '支付对账异常阻止退款' : refunds.blockedReason === 'payment_unresolved' ? '未决支付阻止退款' : '没有可用于退款的确认回执'"
              description="先解决支付尝试、钱包预留或开放对账案例。预留资金继续受数据库保护。"
            />

            <UAlert
              v-if="errorMessage"
              class="mt-4"
              color="error"
              variant="soft"
              :title="errorMessage"
              role="alert"
              aria-live="assertive"
            />
            <UAlert
              v-if="successMessage"
              class="mt-4"
              color="success"
              variant="soft"
              :title="successMessage"
              role="status"
              aria-live="polite"
            />

            <UAlert
              v-if="!refunds.items.length"
              class="mt-4"
              color="neutral"
              variant="subtle"
              title="尚无退款申请"
              description="顾客提交申请后，会在此显示金额、原因、资金来源和审核操作。"
            />

            <ol
              v-else
              class="mt-4 grid gap-4"
            >
              <li
                v-for="refund in refunds.items"
                :key="refund.id"
                class="min-w-0 rounded-xl border border-default p-3 sm:p-4"
              >
                <header class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="break-all font-mono text-xs text-muted">
                      退款申请 {{ refund.id }}
                    </p>
                    <p class="mt-1 font-semibold tabular-nums text-highlighted">
                      申请 ¥{{ refund.amount }} · 已成功 ¥{{ refund.succeededAmount }} · 预留 ¥{{ refund.reservedAmount }}
                    </p>
                    <p class="mt-1 break-words text-sm text-muted">
                      原因：{{ refund.reason }}
                    </p>
                    <p
                      v-if="refund.rejectionReason"
                      class="mt-1 break-words text-sm text-error"
                    >
                      商家拒绝原因：{{ refund.rejectionReason }}
                    </p>
                  </div>
                  <UBadge
                    :color="refund.status === 'succeeded' ? 'success' : refund.status === 'failed' || refund.status === 'cancelled' ? 'error' : refund.status === 'partially_succeeded' ? 'warning' : 'primary'"
                    variant="soft"
                  >
                    {{ refundStatusLabel(refund.status) }}
                  </UBadge>
                </header>

                <dl class="mt-3 grid grid-cols-1 gap-2 border-t border-default pt-3 text-xs text-muted sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <dt>申请时间</dt><dd class="mt-1 text-highlighted">
                      {{ formatDate(refund.createdAt) }}
                    </dd>
                  </div>
                  <div>
                    <dt>审核人</dt><dd class="mt-1 break-all text-highlighted">
                      {{ refund.reviewedByAdminId ?? '尚未审核' }}
                    </dd>
                  </div>
                  <div>
                    <dt>审核时间</dt><dd class="mt-1 text-highlighted">
                      {{ refund.reviewedAt ? formatDate(refund.reviewedAt) : '—' }}
                    </dd>
                  </div>
                </dl>

                <div
                  v-if="refund.status === 'requested'"
                  class="mt-3 grid gap-3 rounded-lg border border-primary/25 bg-primary/5 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
                >
                  <UFormField label="拒绝原因">
                    <UTextarea
                      v-model="rejectionDrafts[refund.id]"
                      :rows="2"
                      :maxlength="500"
                      :disabled="Boolean(refundActionKey)"
                      placeholder="拒绝时必填；审核通过时不会使用此内容"
                      class="w-full"
                    />
                  </UFormField>
                  <div class="flex flex-wrap gap-2">
                    <UButton
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-x"
                      :loading="refundActionKey === `reject:${refund.id}`"
                      :disabled="Boolean(refundActionKey) || !rejectionDrafts[refund.id]?.trim()"
                      @click="rejectRefund(refund.id)"
                    >
                      拒绝
                    </UButton>
                    <UButton
                      color="primary"
                      icon="i-lucide-check"
                      :loading="refundActionKey === `approve:${refund.id}`"
                      :disabled="Boolean(refundActionKey)"
                      @click="approveRefund(refund.id)"
                    >
                      审核通过
                    </UButton>
                  </div>
                </div>

                <div
                  v-if="refund.allocations.length"
                  class="mt-4 grid gap-3"
                >
                  <section
                    v-for="allocation in refund.allocations"
                    :key="allocation.id"
                    class="min-w-0 rounded-lg bg-muted/35 p-3"
                    :aria-labelledby="`refund-allocation-${allocation.id}`"
                  >
                    <div class="flex flex-wrap items-start justify-between gap-2">
                      <div class="min-w-0">
                        <h3
                          :id="`refund-allocation-${allocation.id}`"
                          class="font-medium text-highlighted"
                        >
                          {{ refundBucketLabel(allocation.sourceBucket) }} → {{ refundDestinationLabel(allocation.destination) }} · ¥{{ allocation.amount }}
                        </h3>
                        <p class="mt-1 break-all font-mono text-[11px] text-muted">
                          收款回执 {{ allocation.sourceReceiptId }} · 原回执 ¥{{ allocation.sourceReceiptAmount }} · {{ allocation.sourceDisposition }} · {{ allocation.sourceProvider ?? '钱包' }}
                        </p>
                        <p
                          v-if="allocation.sourceProviderTransactionId"
                          class="mt-1 break-all font-mono text-[11px] text-muted"
                        >
                          原收款流水 {{ allocation.sourceProviderTransactionId }}
                        </p>
                        <p class="mt-1 break-all font-mono text-[11px] text-muted">
                          退款操作 {{ allocation.operationId }}
                        </p>
                      </div>
                      <UBadge
                        :color="allocation.status === 'succeeded' ? 'success' : allocation.status === 'released' ? 'neutral' : 'warning'"
                        variant="soft"
                      >
                        {{ allocation.status === 'succeeded' ? '已退款' : allocation.status === 'released' ? '预留已释放' : '资金已预留' }}
                      </UBadge>
                    </div>

                    <div
                      v-if="refund.payoutMode === 'manual_original_source' && allocation.destination === 'original_source' && allocation.status === 'reserved' && !allocation.manualAttempts.some(attempt => attempt.status === 'started' || attempt.status === 'unknown')"
                      class="mt-3"
                    >
                      <UButton
                        size="sm"
                        color="warning"
                        variant="soft"
                        icon="i-lucide-hand-coins"
                        :loading="refundActionKey === `manual-start:${allocation.id}`"
                        :disabled="Boolean(refundActionKey) || Boolean(refunds.blockedReason && refunds.blockedReason !== 'no_refundable_balance')"
                        @click="startManualRefund(refund.id, allocation.id)"
                      >
                        开始人工原路退款记录
                      </UButton>
                      <p class="mt-2 text-xs text-muted">
                        此按钮只登记人工操作并保留资金，不会调用支付宝/微信或发起转账。
                      </p>
                    </div>

                    <ol
                      v-if="allocation.manualAttempts.length"
                      class="mt-3 grid gap-3"
                    >
                      <li
                        v-for="attempt in allocation.manualAttempts"
                        :key="attempt.id"
                        class="min-w-0 rounded-lg border border-default bg-elevated p-3"
                      >
                        <div class="flex flex-wrap items-center justify-between gap-2">
                          <p class="break-all font-mono text-xs text-muted">
                            人工原路退款 {{ attempt.id }}
                          </p>
                          <UBadge
                            :color="attempt.status === 'succeeded' ? 'success' : attempt.status === 'failed' ? 'error' : 'warning'"
                            variant="soft"
                          >
                            {{ attempt.status === 'succeeded' ? '有凭证已成功' : attempt.status === 'failed' ? '已确认未退款' : attempt.status === 'unknown' ? '结果未知，继续预留' : '操作已开始' }}
                          </UBadge>
                        </div>
                        <p class="mt-1 break-all text-xs text-muted">
                          开始管理员 {{ attempt.startedByAdminId }} · {{ formatDate(attempt.createdAt) }}<template v-if="attempt.resolvedByAdminId">
                            · 处理管理员 {{ attempt.resolvedByAdminId }}
                          </template>
                        </p>
                        <dl
                          v-if="attempt.status === 'succeeded'"
                          class="mt-2 grid gap-2 text-xs sm:grid-cols-2"
                        >
                          <div>
                            <dt class="text-muted">
                              实际退款流水号
                            </dt><dd class="mt-1 break-all font-mono text-highlighted">
                              {{ attempt.providerReference }}
                            </dd>
                          </div>
                          <div>
                            <dt class="text-muted">
                              真实金额与时间
                            </dt><dd class="mt-1 tabular-nums text-highlighted">
                              ¥{{ attempt.amount }} · {{ attempt.actualRefundedAt ? formatDate(attempt.actualRefundedAt) : '—' }}
                            </dd>
                          </div>
                          <div class="sm:col-span-2">
                            <dt class="text-muted">
                              证据摘要
                            </dt><dd class="mt-1 break-words text-highlighted">
                              {{ attempt.evidenceSummary }}
                            </dd>
                          </div>
                        </dl>
                        <p
                          v-if="attempt.resolutionNote"
                          class="mt-2 break-words text-xs text-muted"
                        >
                          处理说明：{{ attempt.resolutionNote }}
                        </p>

                        <div
                          v-if="refund.payoutMode === 'manual_original_source' && (attempt.status === 'started' || attempt.status === 'unknown')"
                          class="mt-3 grid gap-3 border-t border-default pt-3"
                        >
                          <UAlert
                            color="warning"
                            variant="subtle"
                            title="不要仅凭商户页面或提交结果确认退款"
                            description="只有确认服务商已经实际退回款项，并核对本笔准确金额后，才填写成功凭证。若结果未知，保留预留并先核实流水，不能重复发起。"
                          />
                          <div class="grid gap-3 sm:grid-cols-2">
                            <UFormField label="实际退款流水号">
                              <UInput
                                v-model="manualDraft(attempt.id, allocation.amount).providerRefundId"
                                :maxlength="200"
                                :disabled="Boolean(refundActionKey)"
                                class="w-full"
                              />
                            </UFormField>
                            <UFormField label="实际退款金额">
                              <UInput
                                v-model="manualDraft(attempt.id, allocation.amount).amount"
                                inputmode="decimal"
                                :disabled="Boolean(refundActionKey)"
                                class="w-full"
                              />
                            </UFormField>
                            <UFormField label="实际退款时间">
                              <UInput
                                v-model="manualDraft(attempt.id, allocation.amount).actualRefundedAt"
                                type="datetime-local"
                                :disabled="Boolean(refundActionKey)"
                                class="w-full"
                              />
                            </UFormField>
                            <UFormField label="证据摘要">
                              <UInput
                                v-model="manualDraft(attempt.id, allocation.amount).evidenceSummary"
                                :maxlength="500"
                                :disabled="Boolean(refundActionKey)"
                                placeholder="商户退款详情、凭证或核对摘要"
                                class="w-full"
                              />
                            </UFormField>
                          </div>
                          <UFormField label="未确认结果或未退款的核实说明">
                            <UTextarea
                              v-model="manualDraft(attempt.id, allocation.amount).resolutionNote"
                              :maxlength="500"
                              :rows="2"
                              :disabled="Boolean(refundActionKey)"
                              placeholder="未知时说明正在核对什么；确认未退款时说明核实依据"
                              class="w-full"
                            />
                          </UFormField>
                          <div class="flex flex-wrap gap-2">
                            <UButton
                              color="success"
                              icon="i-lucide-circle-check"
                              :loading="refundActionKey === `manual-result:${attempt.id}:succeeded`"
                              :disabled="Boolean(refundActionKey)"
                              @click="resolveManualRefund(refund.id, allocation.id, attempt.id, 'succeeded')"
                            >
                              登记实际退款成功
                            </UButton>
                            <UButton
                              v-if="attempt.status === 'started'"
                              color="warning"
                              variant="soft"
                              :loading="refundActionKey === `manual-result:${attempt.id}:unknown`"
                              :disabled="Boolean(refundActionKey) || !manualDrafts[attempt.id]?.resolutionNote.trim()"
                              @click="resolveManualRefund(refund.id, allocation.id, attempt.id, 'unknown')"
                            >
                              结果未知，继续预留
                            </UButton>
                            <UButton
                              color="neutral"
                              variant="outline"
                              :loading="refundActionKey === `manual-result:${attempt.id}:failed`"
                              :disabled="Boolean(refundActionKey) || !manualDrafts[attempt.id]?.resolutionNote.trim()"
                              @click="resolveManualRefund(refund.id, allocation.id, attempt.id, 'failed')"
                            >
                              确认未退款并释放预留
                            </UButton>
                          </div>
                        </div>
                      </li>
                    </ol>
                  </section>
                </div>

                <div
                  v-if="refund.payoutMode === 'manual_original_source' && (refund.status === 'failed' || refund.status === 'partially_succeeded') && refunds.refundableAmount !== '0.00'"
                  class="mt-3"
                >
                  <UButton
                    size="sm"
                    color="warning"
                    variant="outline"
                    icon="i-lucide-rotate-cw"
                    :loading="refundActionKey.startsWith(`retry:${refund.id}:`)"
                    :disabled="Boolean(refundActionKey) || Boolean(refunds.blockedReason && refunds.blockedReason !== 'no_refundable_balance')"
                    @click="retryGuestRefund(refund)"
                  >
                    重新预留已确认未退款的金额
                  </UButton>
                </div>

                <details
                  v-if="refund.auditEvents.length"
                  class="mt-4 border-t border-default pt-3"
                >
                  <summary class="min-h-11 cursor-pointer content-center text-sm font-medium text-primary">
                    操作与状态审计（{{ refund.auditEvents.length }}）
                  </summary>
                  <ol class="mt-2 grid gap-2">
                    <li
                      v-for="event in refund.auditEvents"
                      :key="event.id"
                      class="min-w-0 rounded-lg bg-muted/40 p-3 text-xs"
                    >
                      <p class="break-words font-medium text-highlighted">
                        {{ event.action }} · {{ event.actorType === 'admin' ? `管理员 ${event.actorAdminId}` : event.actorType === 'customer' ? `顾客 ${event.actorCustomerId}` : event.actorType }}
                      </p>
                      <p class="mt-1 text-muted">
                        {{ event.previousStatus ?? '—' }} → {{ event.nextStatus ?? '—' }} · {{ formatDate(event.createdAt) }}
                      </p>
                      <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-dimmed">{{ JSON.stringify(event.details, null, 2) }}</pre>
                    </li>
                  </ol>
                </details>
              </li>
            </ol>
          </section>

          <section
            class="mt-6"
            aria-labelledby="admin-order-items-title"
          >
            <h2
              id="admin-order-items-title"
              class="text-lg font-semibold text-highlighted"
            >
              成交商品快照与人工交付
            </h2>
            <ul class="mt-3 space-y-4">
              <li
                v-for="item in data.order.items"
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
                      SKU {{ item.skuCode }} · {{ item.inventoryMode }} · {{ item.fulfillmentMethod === 'code_pool' ? '卡密池自动发货' : item.fulfillmentMethod === 'manual' ? '人工数字交付' : item.fulfillmentMethod }}
                    </p>
                  </div>
                  <UBadge
                    :color="item.fulfillmentStatus === 'completed' ? 'success' : 'neutral'"
                    variant="soft"
                  >
                    {{ item.fulfilledQuantity }} / {{ item.quantity }} 已交付
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
                      履约状态
                    </dt><dd class="mt-1 text-highlighted">
                      {{ item.fulfillmentStatus }}
                    </dd>
                  </div>
                </dl>

                <UAlert
                  v-if="item.fulfillmentMethod === 'code_pool' && data.order.status === 'processing' && item.fulfillmentStatus === 'failed'"
                  class="mt-3"
                  color="warning"
                  variant="soft"
                  icon="i-lucide-shield-alert"
                  title="自动交付失败，系统按退避计划重试"
                  description="查看下方履约审计中的失败原因与下次重试时间。预留卡密不会被其他订单占用。"
                  role="status"
                />

                <section
                  v-if="item.deliveries.length"
                  class="mt-4 border-t border-default pt-4"
                  :aria-labelledby="`admin-delivery-${item.id}`"
                >
                  <h4
                    :id="`admin-delivery-${item.id}`"
                    class="font-medium text-highlighted"
                  >
                    已录入的交付内容
                  </h4>
                  <ol class="mt-2 grid gap-2">
                    <li
                      v-for="delivery in item.deliveries"
                      :key="delivery.id"
                      class="rounded-lg border border-success/30 bg-success/5 p-3"
                    >
                      <div class="flex flex-wrap justify-between gap-2 text-xs text-muted">
                        <span>第 {{ delivery.unitIndex }} 件</span><time :datetime="delivery.createdAt">{{ formatDate(delivery.createdAt) }}</time>
                      </div>
                      <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-sm text-highlighted">{{ delivery.content }}</pre>
                    </li>
                  </ol>
                </section>

                <section
                  v-if="data.order.status === 'processing' && item.fulfillmentMethod === 'manual' && item.fulfilledQuantity + item.fulfillmentReservedQuantity < item.quantity"
                  class="mt-4 rounded-lg border border-primary/25 bg-primary/5 p-3 sm:p-4"
                  :aria-labelledby="`fulfill-${item.id}`"
                >
                  <h4
                    :id="`fulfill-${item.id}`"
                    class="font-medium text-highlighted"
                  >
                    记录实际人工数字交付
                  </h4>
                  <p class="mt-1 text-sm text-muted">
                    仅限零元或已确认付款的 processing 订单。每行录入一件实际交付内容；记录成功后数据库会完成履约并扣减对应库存。
                  </p>
                  <UFormField
                    label="实际交付内容"
                    :description="`还可交付 ${item.quantity - item.fulfilledQuantity - item.fulfillmentReservedQuantity} 件。内容只会显示给订单归属顾客与授权管理员。`"
                    class="mt-3"
                  >
                    <UTextarea
                      v-model="deliveryDrafts[item.id]"
                      :rows="Math.min(6, Math.max(3, item.quantity - item.fulfilledQuantity))"
                      :maxlength="10_260"
                      :disabled="Boolean(savingItemId)"
                      :aria-label="`${item.productName}实际交付内容，每行一件`"
                      placeholder="例如：每一行录入一件独立的兑换码或授权内容"
                      class="w-full font-mono"
                      :ui="{ base: 'min-h-24 resize-y' }"
                    />
                  </UFormField>
                  <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <p class="text-xs text-muted">
                      交付内容不会写入应用日志；请仅录入实际可交付给顾客的内容。
                    </p>
                    <UButton
                      color="primary"
                      icon="i-lucide-send"
                      :loading="savingItemId === item.id"
                      :disabled="Boolean(savingItemId) || !deliveryDrafts[item.id]?.length"
                      @click="recordDelivery(item.id)"
                    >
                      确认实际交付
                    </UButton>
                  </div>
                </section>
              </li>
            </ul>
          </section>

          <section
            class="mt-6 rounded-xl border border-default bg-elevated p-4 sm:p-5"
            aria-labelledby="fulfillment-attempts-title"
          >
            <h2
              id="fulfillment-attempts-title"
              class="font-semibold text-highlighted"
            >
              人工与自动履约审计
            </h2>
            <UAlert
              v-if="!data.fulfillmentAttempts.length"
              class="mt-3"
              color="neutral"
              variant="subtle"
              title="尚无履约记录"
              description="系统自动发卡和人工录入共用同一履约尝试、私有交付历史与库存消费流水。"
            />
            <ul
              v-else
              class="mt-3 divide-y divide-default rounded-lg border border-default px-3"
            >
              <li
                v-for="attempt in data.fulfillmentAttempts"
                :key="attempt.id"
                class="flex flex-wrap items-start justify-between gap-3 py-3 text-sm"
              >
                <div class="min-w-0">
                  <p class="break-all font-mono text-xs text-muted">
                    履约 {{ attempt.id }}
                  </p>
                  <p class="mt-1 text-highlighted">
                    {{ attempt.quantity }} 件 · {{ attempt.deliveryCount }} 条交付 · {{ attempt.deliverySource === 'code_pool' ? '系统自动发卡' : `管理员 ${attempt.administratorId ?? '未知'}` }}
                  </p>
                  <p
                    v-if="attempt.failureCode"
                    class="mt-1 text-sm text-warning"
                  >
                    失败原因：{{ fulfillmentFailureLabel(attempt.failureCode) }}
                  </p>
                  <p
                    v-if="attempt.resultSha256"
                    class="mt-1 break-all font-mono text-xs text-dimmed"
                  >
                    SHA-256 {{ attempt.resultSha256 }}
                  </p>
                </div>
                <div class="text-right text-xs text-muted">
                  <p>{{ fulfillmentAttemptStatusLabel(attempt.status) }}</p><time :datetime="attempt.createdAt">{{ formatDate(attempt.createdAt) }}</time>
                  <p
                    v-if="attempt.retryAfter"
                    class="mt-1"
                  >
                    下次自动重试 {{ formatDate(attempt.retryAfter) }}
                  </p>
                </div>
              </li>
            </ul>
          </section>

          <section
            class="mt-6 rounded-xl border border-default bg-elevated p-4 sm:p-5"
            aria-labelledby="admin-order-events-title"
          >
            <h2
              id="admin-order-events-title"
              class="font-semibold text-highlighted"
            >
              订单状态事件
            </h2>
            <ol
              v-if="data.order.statusEvents.length"
              class="mt-3 divide-y divide-default"
            >
              <li
                v-for="(event, index) in data.order.statusEvents"
                :key="`${event.createdAt}-${index}`"
                class="flex flex-wrap justify-between gap-2 py-3 text-sm"
              >
                <span class="text-highlighted">{{ event.previousStatus }} → {{ event.nextStatus }}</span><time
                  class="text-muted"
                  :datetime="event.createdAt"
                >{{ formatDate(event.createdAt) }}</time>
              </li>
            </ol>
            <p
              v-else
              class="mt-2 text-sm text-muted"
            >
              当前订单处于初始状态。
            </p>
          </section>
        </template>
      </main>
    </template>
  </UDashboardPanel>
</template>
