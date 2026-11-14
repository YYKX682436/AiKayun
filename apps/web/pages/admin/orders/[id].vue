<script setup lang="ts">
import type { AdminOrderDetail, AdminOrderRefunds, AdminOrderRefundMutation, ManualFulfillmentResult } from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '订单详情' })
if (import.meta.server) useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const route = useRoute()
const orderId = computed(() => String(route.params.id))
const { request } = useAdminApi()
const data = shallowRef<AdminOrderDetail | null>(null)
const refunds = shallowRef<AdminOrderRefunds | null>(null)
const loading = ref(false)
const savingItemId = ref('')
const reconcilingAttemptId = ref('')
const supplierActionId = ref('')
const errorMessage = ref('')
const successMessage = ref('')
const deliveryDrafts = reactive<Record<string, string>>({})
const rejectionDrafts = reactive<Record<string, string>>({})
const manualDrafts = reactive<Record<string, { providerRefundId: string; amount: string; actualRefundedAt: string; evidenceSummary: string; resolutionNote: string }>>({})
const refundActionKey = ref('')
const copiedOrderId = ref(false)
let sequence = 0

// 章节导航状态与 IntersectionObserver
const activeSection = ref('overview')
let sectionObserver: IntersectionObserver | null = null

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

function supplierOperationStatusLabel(state: AdminOrderDetail['supplierOperations'][number]['state']): string {
  const labels: Record<typeof state, string> = {
    create_pending: '等待创建', create_in_flight: '正在创建', query_pending: '等待查询',
    query_in_flight: '正在查询', processing: '供应商处理中', unknown: '结果未知',
    succeeded_pending_finalize: '已确认成功，商城待落账', manual_review: '需要人工核对',
    succeeded: '已交付', failed: '明确失败',
  }
  return labels[state]
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function adminPurchaseAttachmentUrl(itemId: string, attachmentId: string): string {
  const currentOrderId = data.value?.order.id
  return currentOrderId
    ? `/api/v1/admin/orders/${encodeURIComponent(currentOrderId)}/items/${encodeURIComponent(itemId)}/purchase-attachments/${encodeURIComponent(attachmentId)}`
    : ''
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

async function copyOrderId() {
  if (!data.value?.order.id || !import.meta.client) return
  try {
    await navigator.clipboard.writeText(data.value.order.id)
    copiedOrderId.value = true
    setTimeout(() => {
      copiedOrderId.value = false
    }, 2000)
  } catch {
    // 忽略剪贴板写入失败
  }
}

// 待处理事项推导
const pendingActionCount = computed(() => {
  let count = 0
  if (!data.value) return 0
  // 1. 等待人工交付的订单项
  if (data.value.order.status === 'processing') {
    for (const item of data.value.order.items) {
      if (item.fulfillmentMethod === 'manual' && (item.fulfilledQuantity + item.fulfillmentReservedQuantity < item.quantity)) {
        count++
      }
    }
  }
  // 2. 支付对账异常
  if (data.value.payments.needsReconciliation) {
    count++
  }
  // 3. 退款待审核或待人工处理
  if (refunds.value) {
    for (const item of refunds.value.items) {
      if (item.status === 'requested') count++
      if (refunds.value.payoutMode === 'manual_original_source') {
        for (const alloc of item.allocations) {
          if (alloc.status === 'reserved' && alloc.destination === 'original_source') {
            count++
          }
        }
      }
    }
  }
  // 4. 供应商异常需人工关注（如失败且需重试、或manual_review）
  for (const op of data.value.supplierOperations) {
    if (op.state === 'manual_review' || (op.state === 'failed' && op.lastFailureClass === 'supplier_rejected' && data.value.order.status === 'processing')) {
      count++
    }
  }
  return count
})

// 快捷章节导航定义
const navSections = computed(() => {
  if (!data.value) return []
  const list = [
    {
      id: 'overview',
      label: '订单概览',
      icon: 'i-lucide-file-text',
      badge: '',
      hasWarning: false,
    },
    {
      id: 'items',
      label: '成交与交付',
      icon: 'i-lucide-package-check',
      badge: `${data.value.order.items.length}`,
      hasWarning: data.value.order.status === 'processing' && data.value.order.items.some(i => i.fulfillmentMethod === 'manual' && i.fulfilledQuantity + i.fulfillmentReservedQuantity < i.quantity),
    },
    {
      id: 'payments',
      label: '支付对账',
      icon: 'i-lucide-credit-card',
      badge: `${data.value.payments.attempts.length}`,
      hasWarning: data.value.payments.needsReconciliation,
    },
  ]
  if (refunds.value) {
    list.push({
      id: 'refunds',
      label: '退款售后',
      icon: 'i-lucide-rotate-ccw',
      badge: `${refunds.value.items.length}`,
      hasWarning: refunds.value.items.some(r => r.status === 'requested') || Boolean(refunds.value.blockedReason && refunds.value.blockedReason !== 'no_refundable_balance'),
    })
  }
  if (data.value.supplierOperations.length > 0) {
    list.push({
      id: 'supplier-operations',
      label: '供应商交付',
      icon: 'i-lucide-cloud-cog',
      badge: `${data.value.supplierOperations.length}`,
      hasWarning: data.value.supplierOperations.some(op => op.state === 'manual_review' || (op.state === 'failed' && op.lastFailureClass === 'supplier_rejected')),
    })
  }
  list.push(
    {
      id: 'inventory-audit',
      label: '库存预留',
      icon: 'i-lucide-boxes',
      badge: `${data.value.inventory.length}`,
      hasWarning: false,
    },
    {
      id: 'fulfillment-audit',
      label: '履约与状态审计',
      icon: 'i-lucide-history',
      badge: `${data.value.fulfillmentAttempts.length + data.value.order.statusEvents.length}`,
      hasWarning: data.value.fulfillmentAttempts.some(a => a.status === 'failed' || a.status === 'unknown'),
    },
  )
  return list
})

function scrollToSection(id: string) {
  activeSection.value = id
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

function setupSectionObserver() {
  if (!import.meta.client) return
  cleanupSectionObserver()
  const sectionIds = navSections.value.map(s => s.id)
  const visibleSections = new Set<string>()

  sectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        visibleSections.add(entry.target.id)
      } else {
        visibleSections.delete(entry.target.id)
      }
    }
    for (const id of sectionIds) {
      if (visibleSections.has(id)) {
        activeSection.value = id
        break
      }
    }
  }, {
    rootMargin: '-70px 0px -40% 0px',
    threshold: 0,
  })

  for (const id of sectionIds) {
    const el = document.getElementById(id)
    if (el) sectionObserver.observe(el)
  }
}

function cleanupSectionObserver() {
  if (sectionObserver) {
    sectionObserver.disconnect()
    sectionObserver = null
  }
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
    await nextTick()
    setupSectionObserver()
  } catch (error) {
    if (currentSequence !== sequence) return
    errorMessage.value = error instanceof Error ? error.message : '订单详情暂时无法加载。'
  } finally {
    if (currentSequence === sequence) loading.value = false
  }
}

async function runSupplierAction(operationId: string, action: 'query' | 'retry') {
  if (supplierActionId.value) return
  supplierActionId.value = operationId
  errorMessage.value = ''
  successMessage.value = ''
  try {
    await request<{ operation: AdminOrderDetail['supplierOperations'][number] }>(
      `/api/v1/admin/orders/${orderId.value}/supplier-operations/${operationId}/${action}`,
      { method: 'POST' },
    )
    await loadOrder()
    successMessage.value = action === 'query'
      ? '已排入原供应商操作的状态查询；系统不会因此创建新的交付。'
      : '已记录人工恢复请求；仅会重试供应商明确拒绝且确认未交付的单位。'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '供应商操作未能排队，请刷新状态后重试。'
    await loadOrder()
  } finally {
    supplierActionId.value = ''
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
    if (result.refunds.refundStatus === 'refunded' && ['pending_payment', 'processing'].includes(data.value?.order.status ?? '')) {
      await loadOrder()
    }
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
    outcome === 'succeeded' ? '已记录真实原路退款凭证并确认成功。' : outcome === 'unknown' ? '结果已标记为未知，资金继续预留，不能重复发起转账。' : '已确认未退款并释放本次预留。',
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
onBeforeUnmount(() => {
  sequence++
  cleanupSectionObserver()
})
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
        <!-- 全局错误通知（包括首次加载失败与后续操作失败） -->
        <UAlert
          v-if="errorMessage"
          class="mb-5"
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
              size="xs"
              :loading="loading"
              @click="loadOrder"
            >
              重新读取
            </UButton>
          </template>
        </UAlert>

        <!-- 骨架屏加载状态 -->
        <div
          v-if="loading && !data"
          class="space-y-4"
          aria-label="正在加载订单"
          aria-busy="true"
        >
          <div class="h-28 animate-pulse rounded-2xl border border-default bg-elevated motion-reduce:animate-none" />
          <div class="h-40 animate-pulse rounded-2xl border border-default bg-elevated motion-reduce:animate-none" />
          <div class="h-64 animate-pulse rounded-2xl border border-default bg-elevated motion-reduce:animate-none" />
        </div>

        <template v-if="data">
          <!-- 顶部订单核心概览 Header Card -->
          <header class="mb-6 rounded-2xl border border-default bg-elevated/70 p-5 shadow-xs backdrop-blur-xs sm:p-6">
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-xs font-semibold uppercase tracking-wider text-primary">
                    订单履约详情
                  </span>
                  <span class="text-xs text-dimmed">·</span>
                  <span class="text-xs text-muted">{{ formatDate(data.order.createdAt) }}</span>
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-2.5">
                  <h1 class="break-all font-mono text-xl font-bold tracking-tight text-highlighted sm:text-2xl">
                    订单 {{ data.order.id }}
                  </h1>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :icon="copiedOrderId ? 'i-lucide-check' : 'i-lucide-copy'"
                    :aria-label="copiedOrderId ? '已复制' : '复制订单号'"
                    @click="copyOrderId"
                  >
                    <span class="sr-only">复制订单号</span>
                  </UButton>
                </div>
                <p class="mt-2 flex items-center gap-1.5 break-all text-xs text-muted sm:text-sm">
                  <UIcon
                    name="i-lucide-user"
                    class="size-4 shrink-0 text-dimmed"
                  />
                  <span>{{ ownerLabel() }}</span>
                </p>
              </div>

              <!-- 右侧状态徽章与操作 -->
              <div class="flex flex-wrap items-center gap-2.5">
                <UBadge
                  :color="data.order.status === 'completed' ? 'success' : data.order.status === 'closed' ? 'neutral' : data.order.status === 'pending_payment' ? 'warning' : 'primary'"
                  variant="subtle"
                  size="lg"
                  class="font-medium"
                >
                  <UIcon
                    :name="data.order.status === 'completed' ? 'i-lucide-check-circle' : data.order.status === 'closed' ? 'i-lucide-ban' : data.order.status === 'pending_payment' ? 'i-lucide-clock' : 'i-lucide-truck'"
                    class="mr-1 size-4"
                  />
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
              </div>
            </div>

            <!-- 核心经营事实 KPI 关键指标条 -->
            <div class="mt-5 grid grid-cols-2 gap-3 border-t border-default/70 pt-5 sm:grid-cols-4 lg:gap-4">
              <div class="rounded-xl bg-default/50 p-3.5 border border-default/60">
                <span class="text-xs font-medium text-muted">订单金额</span>
                <p class="mt-1 text-xl font-bold tabular-nums text-highlighted">
                  ¥{{ data.order.totalAmount }}
                </p>
                <span class="text-[11px] text-dimmed">共 {{ data.order.itemCount }} 件商品</span>
              </div>
              <div class="rounded-xl bg-default/50 p-3.5 border border-default/60">
                <span class="text-xs font-medium text-muted">付款状态</span>
                <p class="mt-1 text-base font-semibold text-highlighted">
                  {{ data.order.paymentStatus === 'not_required' ? '零元 · 无需付款' : data.order.paymentStatus === 'unpaid' ? '尚未付款' : '已确认付款' }}
                </p>
                <span class="text-[11px] text-dimmed">{{ data.payments.attempts.length }} 次在线支付尝试</span>
              </div>
              <div class="rounded-xl bg-default/50 p-3.5 border border-default/60">
                <span class="text-xs font-medium text-muted">售后与退款</span>
                <p class="mt-1 text-base font-semibold text-highlighted">
                  <template v-if="refunds">
                    {{ refunds.refundStatus === 'refunded' ? '全额已退' : refunds.refundStatus === 'partially_refunded' ? '部分已退' : refunds.refundStatus === 'requested_or_processing' ? '待处理退款' : '无退款' }}
                  </template>
                  <template v-else>
                    —
                  </template>
                </p>
                <span class="text-[11px] text-dimmed">
                  {{ refunds?.items.length ? `${refunds.items.length} 笔申请 · 可退 ¥${refunds.refundableAmount}` : '暂无售后申请' }}
                </span>
              </div>
              <div class="rounded-xl bg-default/50 p-3.5 border border-default/60">
                <span class="text-xs font-medium text-muted">待处理任务</span>
                <div class="mt-1 flex items-center gap-1.5">
                  <span
                    class="text-xl font-bold tabular-nums"
                    :class="pendingActionCount > 0 ? 'text-warning' : 'text-success'"
                  >
                    {{ pendingActionCount }}
                  </span>
                  <span class="text-xs text-muted">项需关注</span>
                </div>
                <span class="text-[11px] text-dimmed">
                  {{ pendingActionCount > 0 ? '优先在下方完成履约或对账' : '暂无待人工处理事项' }}
                </span>
              </div>
            </div>
          </header>

          <UAlert
            v-if="successMessage"
            class="mb-5"
            color="success"
            variant="soft"
            :title="successMessage"
            role="status"
            aria-live="polite"
          />

          <!-- 特殊警示：待付款非零元订单 -->
          <UAlert
            v-if="data.order.status === 'pending_payment' && data.order.totalAmount !== '0.00'"
            class="mb-5"
            color="warning"
            variant="subtle"
            icon="i-lucide-clock"
            title="等待付款"
            description="付款状态只由已验证的服务商通知或主动查单更新。后台没有手工标记已付款的操作。"
          />

          <!-- 移动端粘性章节导航条 -->
          <nav
            aria-label="快捷章节导航"
            class="sticky top-0 z-20 -mx-4 mb-6 flex items-center gap-2 overflow-x-auto border-b border-default bg-default/95 px-4 py-2.5 backdrop-blur-md no-scrollbar lg:hidden"
          >
            <button
              v-for="item in navSections"
              :key="item.id"
              type="button"
              class="relative inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
              :class="activeSection === item.id ? 'bg-primary text-white shadow-xs' : 'bg-elevated text-muted hover:text-highlighted border border-default'"
              @click="scrollToSection(item.id)"
            >
              <UIcon
                :name="item.icon"
                class="size-3.5"
              />
              <span>{{ item.label }}</span>
              <span
                v-if="item.hasWarning"
                class="size-1.5 rounded-full bg-warning animate-pulse"
              />
            </button>
          </nav>

          <!-- 主体两栏布局：左侧主体内容（按店主操作频率排序） + 右侧桌面端侧边导航与核对面板 -->
          <div class="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-8">
            <div class="min-w-0 space-y-8">
              <!-- 章节 1：订单概览与基础事实 -->
              <section
                id="overview"
                aria-labelledby="admin-order-summary-title"
                class="scroll-mt-16 rounded-2xl border border-default bg-elevated/40 p-5 shadow-xs sm:p-6"
              >
                <header class="mb-4 flex items-center justify-between border-b border-default pb-3">
                  <div class="flex items-center gap-2">
                    <UIcon
                      name="i-lucide-file-text"
                      class="size-5 text-primary"
                    />
                    <h2
                      id="admin-order-summary-title"
                      class="font-semibold text-highlighted"
                    >
                      订单概览
                    </h2>
                  </div>
                  <span class="text-xs text-muted">事实基准</span>
                </header>

                <dl class="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                  <div class="rounded-xl border border-default/60 bg-default/40 p-3">
                    <dt class="text-xs text-muted">
                      订单总金额
                    </dt>
                    <dd class="mt-1 text-lg font-bold tabular-nums text-highlighted">
                      ¥{{ data.order.totalAmount }}
                    </dd>
                  </div>
                  <div class="rounded-xl border border-default/60 bg-default/40 p-3">
                    <dt class="text-xs text-muted">
                      付款确认状态
                    </dt>
                    <dd class="mt-1 font-semibold text-highlighted">
                      {{ data.order.paymentStatus === 'not_required' ? '零元，无需付款' : data.order.paymentStatus === 'unpaid' ? '尚未付款' : '已确认付款' }}
                    </dd>
                  </div>
                  <div class="rounded-xl border border-default/60 bg-default/40 p-3">
                    <dt class="text-xs text-muted">
                      包含商品项数
                    </dt>
                    <dd class="mt-1 font-semibold text-highlighted">
                      {{ data.order.itemCount }} 项
                    </dd>
                  </div>
                  <div class="rounded-xl border border-default/60 bg-default/40 p-3">
                    <dt class="text-xs text-muted">
                      当前履约阶段
                    </dt>
                    <dd class="mt-1 font-semibold text-highlighted">
                      {{ statusLabel(data.order.status, data.order.paymentStatus) }}
                    </dd>
                  </div>
                </dl>
              </section>

              <!-- 章节 2：成交商品快照与人工交付（店主最核心的履约操作区域） -->
              <section
                id="items"
                aria-labelledby="admin-order-items-title"
                class="scroll-mt-16 rounded-2xl border border-default bg-elevated/40 p-5 shadow-xs sm:p-6"
              >
                <header class="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-default pb-4">
                  <div>
                    <div class="flex items-center gap-2">
                      <UIcon
                        name="i-lucide-package-check"
                        class="size-5 text-primary"
                      />
                      <h2
                        id="admin-order-items-title"
                        class="text-lg font-semibold text-highlighted"
                      >
                        成交商品与数字履约
                      </h2>
                    </div>
                    <p class="mt-1 text-xs text-muted">
                      支持卡密自动发货、人工逐行数字交付与顾客资料预览。
                    </p>
                  </div>
                  <UBadge
                    color="neutral"
                    variant="soft"
                  >
                    {{ data.order.items.length }} 件订单项
                  </UBadge>
                </header>

                <ul class="space-y-5">
                  <li
                    v-for="item in data.order.items"
                    :key="item.id"
                    class="min-w-0 rounded-xl border border-default bg-elevated p-4 shadow-2xs sm:p-5"
                  >
                    <div class="flex flex-wrap items-start justify-between gap-3">
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                          <h3 class="break-words font-semibold text-highlighted">
                            {{ item.productName }}
                          </h3>
                          <UBadge
                            :color="item.fulfillmentStatus === 'completed' ? 'success' : item.fulfillmentStatus === 'failed' ? 'error' : 'neutral'"
                            variant="subtle"
                            size="xs"
                          >
                            {{ item.fulfilledQuantity }} / {{ item.quantity }} 已交付
                          </UBadge>
                        </div>
                        <p class="mt-1 break-words text-xs text-muted">
                          规格：{{ item.options.map(option => `${option.groupName}：${option.valueName}`).join(' / ') || '默认规格' }}
                        </p>
                        <p class="mt-1 font-mono text-[11px] text-dimmed">
                          SKU {{ item.skuCode }} · 库存模式 {{ item.inventoryMode }} · 履约方式 {{ item.fulfillmentMethod === 'code_pool' ? '卡密池自动发货' : item.fulfillmentMethod === 'manual' ? '人工数字交付' : item.fulfillmentMethod }}
                        </p>
                      </div>
                    </div>

                    <!-- 数量与金额统计指标条 -->
                    <dl class="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-default/70 bg-default/40 p-3 text-xs sm:grid-cols-4">
                      <div>
                        <dt class="text-muted">
                          成交单价
                        </dt>
                        <dd class="mt-1 font-medium tabular-nums text-highlighted">
                          ¥{{ item.unitPrice }}
                        </dd>
                      </div>
                      <div>
                        <dt class="text-muted">
                          购买数量
                        </dt>
                        <dd class="mt-1 font-medium tabular-nums text-highlighted">
                          {{ item.quantity }} 件
                        </dd>
                      </div>
                      <div>
                        <dt class="text-muted">
                          成交小计
                        </dt>
                        <dd class="mt-1 font-semibold tabular-nums text-highlighted">
                          ¥{{ item.lineAmount }}
                        </dd>
                      </div>
                      <div>
                        <dt class="text-muted">
                          履约进度
                        </dt>
                        <dd class="mt-1 font-medium text-highlighted">
                          已交付 {{ item.fulfilledQuantity }} · 预留 {{ item.fulfillmentReservedQuantity }} · 待交付 {{ Math.max(0, item.quantity - item.fulfilledQuantity - item.fulfillmentReservedQuantity) }}
                        </dd>
                      </div>
                    </dl>

                    <!-- 顾客提交的购买资料预览 -->
                    <StorefrontPurchaseDataPreview
                      v-if="item.purchaseData.state === 'filled'"
                      class="mt-4"
                      :title="`${item.purchaseData.templateName ?? '购买资料'} · 人工处理参考${item.purchaseData.templateVersionNumber ? ` v${item.purchaseData.templateVersionNumber}` : ''}`"
                      :definition="item.purchaseData.definition"
                      :values="item.purchaseData.values"
                      :attachments="item.purchaseData.attachments.map(attachment => ({
                        id: attachment.attachmentId,
                        fieldId: attachment.fieldId,
                        url: adminPurchaseAttachmentUrl(item.id, attachment.attachmentId),
                        byteSize: attachment.byteSize,
                      }))"
                    />

                    <!-- 自动发卡失败警示 -->
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

                    <!-- 已录入的交付内容历史展示 -->
                    <section
                      v-if="item.deliveries.length"
                      class="mt-4 border-t border-default pt-4"
                      :aria-labelledby="`admin-delivery-${item.id}`"
                    >
                      <div class="flex items-center justify-between">
                        <h4
                          :id="`admin-delivery-${item.id}`"
                          class="text-xs font-semibold uppercase tracking-wider text-muted"
                        >
                          已交付内容清单（{{ item.deliveries.length }} 件）
                        </h4>
                        <UBadge
                          color="success"
                          variant="subtle"
                          size="xs"
                        >
                          交付已生效
                        </UBadge>
                      </div>
                      <ol class="mt-2.5 grid gap-2">
                        <li
                          v-for="delivery in item.deliveries"
                          :key="delivery.id"
                          class="rounded-lg border border-success/30 bg-success/5 p-3 text-xs"
                        >
                          <div class="flex flex-wrap justify-between gap-2 text-muted">
                            <span class="font-medium text-success">第 {{ delivery.unitIndex }} 件交付</span>
                            <time :datetime="delivery.createdAt">{{ formatDate(delivery.createdAt) }}</time>
                          </div>
                          <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-sm text-highlighted">{{ delivery.content }}</pre>
                        </li>
                      </ol>
                    </section>

                    <!-- 人工数字交付输入区域（高亮唤起区） -->
                    <section
                      v-if="data.order.status === 'processing' && item.fulfillmentMethod === 'manual' && item.fulfilledQuantity + item.fulfillmentReservedQuantity < item.quantity"
                      class="mt-4 rounded-xl border border-primary/30 bg-primary/5 p-4 sm:p-5"
                      :aria-labelledby="`fulfill-${item.id}`"
                    >
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <h4
                          :id="`fulfill-${item.id}`"
                          class="font-semibold text-highlighted flex items-center gap-2"
                        >
                          <UIcon
                            name="i-lucide-pen-tool"
                            class="size-4 text-primary"
                          />
                          <span>记录实际人工数字交付</span>
                        </h4>
                        <UBadge
                          color="primary"
                          variant="soft"
                          size="xs"
                        >
                          待交付 {{ item.quantity - item.fulfilledQuantity - item.fulfillmentReservedQuantity }} 件
                        </UBadge>
                      </div>

                      <div class="mt-2.5 rounded-lg border border-primary/20 bg-default/60 p-3 text-xs text-muted space-y-1">
                        <p class="font-medium text-highlighted">
                          交付规则提示：
                        </p>
                        <p>• 每一行录入一件独立的实际交付内容（兑换码、下载地址、授权账号等），每行最多 512 字符。</p>
                        <p>• 仅限零元或已确认付款的订单；单次最多录入 20 件，当前剩余可交付 {{ item.quantity - item.fulfilledQuantity - item.fulfillmentReservedQuantity }} 件。</p>
                        <p>• 采用高可靠幂等提交，内容仅对订单归属顾客与管理员可见，不会泄露至应用日志。</p>
                      </div>

                      <UFormField
                        label="实际交付内容（按行输入）"
                        :description="`剩余待交付 ${item.quantity - item.fulfilledQuantity - item.fulfillmentReservedQuantity} 件。请严格每行一件。`"
                        class="mt-3.5"
                      >
                        <UTextarea
                          v-model="deliveryDrafts[item.id]"
                          :rows="Math.min(6, Math.max(3, item.quantity - item.fulfilledQuantity))"
                          :maxlength="10_260"
                          :disabled="Boolean(savingItemId)"
                          :aria-label="`${item.productName}实际交付内容，每行一件`"
                          placeholder="例如：
第一件授权码
第二件授权码"
                          class="w-full font-mono text-sm"
                          :ui="{ base: 'min-h-24 resize-y' }"
                        />
                      </UFormField>

                      <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <p class="text-xs text-dimmed">
                          请仔细核对行数与待交付数量，确认后将调用现有履约服务扣减库存。
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

              <!-- 章节 3：在线支付与收款凭证 -->
              <section
                id="payments"
                aria-labelledby="admin-payment-evidence-title"
                class="scroll-mt-16 rounded-2xl border border-default bg-elevated/40 p-5 shadow-xs sm:p-6"
              >
                <header class="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-default pb-4">
                  <div>
                    <div class="flex items-center gap-2">
                      <UIcon
                        name="i-lucide-credit-card"
                        class="size-5 text-primary"
                      />
                      <h2
                        id="admin-payment-evidence-title"
                        class="text-lg font-semibold text-highlighted"
                      >
                        在线支付与收款凭证
                      </h2>
                    </div>
                    <p class="mt-1 text-xs text-muted">
                      展示真实支付尝试、第三方渠道回执、对账异常与查单记录。后台不提供手工标记已付款操作。
                    </p>
                  </div>
                  <UBadge
                    :color="data.payments.needsReconciliation ? 'warning' : 'neutral'"
                    variant="soft"
                  >
                    {{ data.payments.needsReconciliation ? '需要核对' : '无待核对异常' }}
                  </UBadge>
                </header>

                <UAlert
                  v-if="data.payments.needsReconciliation"
                  class="mb-4"
                  color="warning"
                  variant="subtle"
                  icon="i-lucide-shield-alert"
                  title="存在待核对支付事件"
                  description="系统已保留服务商事件和实际收款回执。请先核对交易号、金额和订单状态；此页面不能伪造付款或自动履约。"
                />

                <UAlert
                  v-if="!data.payments.attempts.length"
                  color="neutral"
                  variant="subtle"
                  title="尚无在线支付尝试"
                  description="此订单目前没有建立在线支付尝试。"
                />

                <ol
                  v-else
                  class="space-y-4"
                >
                  <li
                    v-for="attempt in data.payments.attempts"
                    :key="attempt.id"
                    class="min-w-0 rounded-xl border border-default bg-elevated p-4 shadow-2xs sm:p-5"
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
                        <dt class="text-xs text-muted">
                          应付金额
                        </dt>
                        <dd class="mt-1 font-semibold tabular-nums text-highlighted">
                          ¥{{ attempt.expectedAmount }}
                        </dd>
                      </div>
                      <div class="min-w-0">
                        <dt class="text-xs text-muted">
                          已验证实收
                        </dt>
                        <dd class="mt-1 font-semibold tabular-nums text-highlighted">
                          {{ attempt.actualAmount ? `¥${attempt.actualAmount}` : '尚无回执' }}
                        </dd>
                      </div>
                      <div class="min-w-0">
                        <dt class="text-xs text-muted">
                          平台交易号
                        </dt>
                        <dd class="mt-1 break-all font-mono text-xs text-highlighted">
                          {{ attempt.providerTransactionId ?? attempt.providerOrderId ?? '尚未返回' }}
                        </dd>
                      </div>
                      <div class="min-w-0">
                        <dt class="text-xs text-muted">
                          商户订单号
                        </dt>
                        <dd class="mt-1 break-all font-mono text-xs text-highlighted">
                          {{ attempt.merchantOrderNo ?? '—' }}
                        </dd>
                      </div>
                      <div class="min-w-0">
                        <dt class="text-xs text-muted">
                          支付创建时间
                        </dt>
                        <dd class="mt-1 text-xs text-highlighted">
                          {{ formatDate(attempt.createdAt) }}
                        </dd>
                      </div>
                      <div class="min-w-0">
                        <dt class="text-xs text-muted">
                          支付完成时间
                        </dt>
                        <dd class="mt-1 text-xs text-highlighted">
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

                    <!-- 对账案例核验操作 -->
                    <div
                      v-if="attempt.reconciliationCases.length"
                      class="mt-3 grid gap-2"
                    >
                      <div
                        v-for="reconciliationCase in attempt.reconciliationCases"
                        :key="reconciliationCase.id"
                        class="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm"
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
                        <p class="mt-1 text-xs text-muted">
                          只有新的认证查单与既有查单及实际回执一致时才会解除异常；此操作不会手工标记付款。
                        </p>
                        <p
                          v-if="reconciliationCase.state === 'resolved'"
                          class="mt-1 break-all text-xs text-muted"
                        >
                          {{ reconciliationCase.resolvedAt ? formatDate(reconciliationCase.resolvedAt) : '' }} · 管理员 {{ reconciliationCase.resolvedByAdminId ?? '未知' }} · 查单 SHA-256 {{ reconciliationCase.resolutionQueryEventSha256 ?? '未知' }}
                        </p>
                      </div>
                    </div>

                    <!-- 折叠的服务商底层事件 -->
                    <details
                      v-if="attempt.events.length"
                      class="mt-4 border-t border-default pt-3"
                    >
                      <summary class="min-h-11 cursor-pointer content-center text-xs font-medium text-primary flex items-center justify-between">
                        <span>查看服务商底层事件（{{ attempt.events.length }} 条）</span>
                        <UIcon
                          name="i-lucide-chevron-down"
                          class="size-4"
                        />
                      </summary>
                      <ol class="mt-2.5 grid gap-2">
                        <li
                          v-for="event in attempt.events"
                          :key="event.id"
                          class="min-w-0 rounded-lg bg-default/60 border border-default/70 p-3 text-xs"
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
                          <p class="mt-1 break-all font-mono text-[11px] text-dimmed">
                            事件 SHA-256 {{ event.eventSha256 }}
                          </p>
                        </li>
                      </ol>
                    </details>
                  </li>
                </ol>
              </section>

              <!-- 章节 4：退款与售后管理 -->
              <section
                v-if="refunds"
                id="refunds"
                aria-labelledby="admin-order-refunds-title"
                class="scroll-mt-16 rounded-2xl border border-default bg-elevated/40 p-5 shadow-xs sm:p-6"
              >
                <header class="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-default pb-4">
                  <div>
                    <div class="flex items-center gap-2">
                      <UIcon
                        name="i-lucide-rotate-ccw"
                        class="size-5 text-primary"
                      />
                      <h2
                        id="admin-order-refunds-title"
                        class="text-lg font-semibold text-highlighted"
                      >
                        退款管理与售后凭证
                      </h2>
                    </div>
                    <p class="mt-1 text-xs text-muted">
                      退款状态由实际回执、预留和不可变账本流水推导，不会改写成交或履约状态。
                    </p>
                  </div>
                  <UBadge
                    :color="refunds.refundStatus === 'refunded' ? 'success' : refunds.refundStatus === 'partially_refunded' ? 'warning' : refunds.refundStatus === 'requested_or_processing' ? 'primary' : 'neutral'"
                    variant="soft"
                  >
                    {{ refunds.refundStatus === 'refunded' ? '全额已退' : refunds.refundStatus === 'partially_refunded' ? '部分已退' : refunds.refundStatus === 'requested_or_processing' ? '审核或退款处理中' : '尚无成功退款' }}
                  </UBadge>
                </header>

                <!-- 退款资金分布统计条 -->
                <dl class="grid grid-cols-2 gap-3 rounded-xl border border-default/70 bg-default/40 p-3.5 text-xs sm:grid-cols-4">
                  <div>
                    <dt class="text-muted">
                      确认实收
                    </dt>
                    <dd class="mt-1 text-base font-bold tabular-nums text-highlighted">
                      ¥{{ refunds.confirmedReceiptAmount }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted">
                      当前可退款
                    </dt>
                    <dd class="mt-1 text-base font-bold tabular-nums text-highlighted">
                      ¥{{ refunds.refundableAmount }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted">
                      已退款金额
                    </dt>
                    <dd class="mt-1 text-base font-bold tabular-nums text-highlighted">
                      ¥{{ refunds.refundedAmount }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted">
                      来源预留
                    </dt>
                    <dd class="mt-1 text-base font-bold tabular-nums text-highlighted">
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
                  v-if="!refunds.items.length"
                  class="mt-4"
                  color="neutral"
                  variant="subtle"
                  title="尚无退款申请"
                  description="顾客提交申请后，会在此显示金额、原因、资金来源和审核操作。"
                />

                <ol
                  v-else
                  class="mt-4 space-y-4"
                >
                  <li
                    v-for="refund in refunds.items"
                    :key="refund.id"
                    class="min-w-0 rounded-xl border border-default bg-elevated p-4 shadow-2xs sm:p-5"
                  >
                    <header class="flex flex-wrap items-start justify-between gap-3">
                      <div class="min-w-0">
                        <p class="break-all font-mono text-xs text-muted">
                          退款申请 {{ refund.id }}
                        </p>
                        <p class="mt-1 text-base font-bold tabular-nums text-highlighted">
                          申请 ¥{{ refund.amount }} · 已成功 ¥{{ refund.succeededAmount }} · 预留 ¥{{ refund.reservedAmount }}
                        </p>
                        <p class="mt-1 break-words text-xs text-muted">
                          申请原因：{{ refund.reason }}
                        </p>
                        <p
                          v-if="refund.rejectionReason"
                          class="mt-1 break-words text-xs font-medium text-error"
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

                    <dl class="mt-3 grid grid-cols-1 gap-2 border-t border-default pt-3 text-xs text-muted sm:grid-cols-3">
                      <div>
                        <dt>申请时间</dt>
                        <dd class="mt-1 text-highlighted">
                          {{ formatDate(refund.createdAt) }}
                        </dd>
                      </div>
                      <div>
                        <dt>审核人</dt>
                        <dd class="mt-1 break-all text-highlighted">
                          {{ refund.reviewedByAdminId ?? '尚未审核' }}
                        </dd>
                      </div>
                      <div>
                        <dt>审核时间</dt>
                        <dd class="mt-1 text-highlighted">
                          {{ refund.reviewedAt ? formatDate(refund.reviewedAt) : '—' }}
                        </dd>
                      </div>
                    </dl>

                    <!-- 退款审核表单区 -->
                    <div
                      v-if="refund.status === 'requested'"
                      class="mt-4 grid gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
                    >
                      <p
                        v-if="data.order.status !== 'completed'"
                        class="text-xs text-muted sm:col-span-2"
                      >
                        未完成订单只能审核通过退还全部剩余金额的申请。
                      </p>
                      <UFormField label="拒绝原因">
                        <UTextarea
                          v-model="rejectionDrafts[refund.id]"
                          :rows="2"
                          :maxlength="500"
                          :disabled="Boolean(refundActionKey)"
                          placeholder="拒绝时必填；审核通过时不会使用此内容"
                          class="w-full text-xs"
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

                    <!-- 退款分配与人工原路退款操作 -->
                    <div
                      v-if="refund.allocations.length"
                      class="mt-4 grid gap-3"
                    >
                      <section
                        v-for="allocation in refund.allocations"
                        :key="allocation.id"
                        class="min-w-0 rounded-xl bg-default/60 border border-default/70 p-3.5"
                        :aria-labelledby="`refund-allocation-${allocation.id}`"
                      >
                        <div class="flex flex-wrap items-start justify-between gap-2">
                          <div class="min-w-0">
                            <h3
                              :id="`refund-allocation-${allocation.id}`"
                              class="font-medium text-highlighted text-sm"
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
                            <p class="mt-1 break-all font-mono text-[11px] text-dimmed">
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
                          class="mt-3.5"
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
                          <p class="mt-1.5 text-xs text-muted">
                            此按钮只登记人工操作并保留资金，不会调用支付宝/微信或发起转账。
                          </p>
                        </div>

                        <!-- 既有人工退款记录及凭证录入表单 -->
                        <ol
                          v-if="allocation.manualAttempts.length"
                          class="mt-3 grid gap-3"
                        >
                          <li
                            v-for="attempt in allocation.manualAttempts"
                            :key="attempt.id"
                            class="min-w-0 rounded-lg border border-default bg-elevated p-3.5"
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
                              class="mt-2.5 grid gap-2 rounded-lg bg-default/40 p-2.5 text-xs sm:grid-cols-2"
                            >
                              <div>
                                <dt class="text-muted">
                                  实际退款流水号
                                </dt>
                                <dd class="mt-1 break-all font-mono text-highlighted">
                                  {{ attempt.providerReference }}
                                </dd>
                              </div>
                              <div>
                                <dt class="text-muted">
                                  真实金额与时间
                                </dt>
                                <dd class="mt-1 tabular-nums text-highlighted">
                                  ¥{{ attempt.amount }} · {{ attempt.actualRefundedAt ? formatDate(attempt.actualRefundedAt) : '—' }}
                                </dd>
                              </div>
                              <div class="sm:col-span-2">
                                <dt class="text-muted">
                                  证据摘要
                                </dt>
                                <dd class="mt-1 break-words text-highlighted">
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

                            <!-- 填写凭证表单 -->
                            <div
                              v-if="refund.payoutMode === 'manual_original_source' && (attempt.status === 'started' || attempt.status === 'unknown')"
                              class="mt-3.5 grid gap-3 border-t border-default pt-3.5"
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
                      class="mt-3.5"
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

                    <!-- 退款审计记录折叠展示 -->
                    <details
                      v-if="refund.auditEvents.length"
                      class="mt-4 border-t border-default pt-3"
                    >
                      <summary class="min-h-11 cursor-pointer content-center text-xs font-medium text-primary flex items-center justify-between">
                        <span>操作与状态审计（{{ refund.auditEvents.length }} 条）</span>
                        <UIcon
                          name="i-lucide-chevron-down"
                          class="size-4"
                        />
                      </summary>
                      <ol class="mt-2.5 grid gap-2">
                        <li
                          v-for="event in refund.auditEvents"
                          :key="event.id"
                          class="min-w-0 rounded-lg bg-default/60 border border-default/70 p-3 text-xs"
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

              <!-- 章节 5：外部供应商交付操作 -->
              <section
                v-if="data.supplierOperations.length"
                id="supplier-operations"
                aria-labelledby="supplier-operations-title"
                class="scroll-mt-16 rounded-2xl border border-default bg-elevated/40 p-5 shadow-xs sm:p-6"
              >
                <header class="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-default pb-4">
                  <div>
                    <div class="flex items-center gap-2">
                      <UIcon
                        name="i-lucide-cloud-cog"
                        class="size-5 text-primary"
                      />
                      <h2
                        id="supplier-operations-title"
                        class="text-lg font-semibold text-highlighted"
                      >
                        外部供应商交付操作
                      </h2>
                    </div>
                    <p class="mt-1 max-w-3xl text-xs leading-5 text-muted">
                      每件商品使用独立持久化操作与稳定幂等键。未知结果只能查询原操作；系统不会因此再次创建交付。
                    </p>
                  </div>
                  <UBadge
                    color="neutral"
                    variant="soft"
                  >
                    {{ data.supplierOperations.length }} 个单位
                  </UBadge>
                </header>

                <ol class="space-y-4">
                  <li
                    v-for="operation in data.supplierOperations"
                    :key="operation.id"
                    class="min-w-0 rounded-xl border border-default bg-elevated p-4 shadow-2xs sm:p-5"
                  >
                    <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
                      <div class="min-w-0">
                        <p class="font-medium text-highlighted">
                          第 {{ operation.unitIndex }} 件 · {{ operation.supplierName }} · {{ supplierOperationStatusLabel(operation.state) }}
                        </p>
                        <p class="mt-1 break-all font-mono text-xs text-muted">
                          操作 {{ operation.operationId }} · 商品 {{ operation.supplierProductId }}
                        </p>
                        <p class="mt-0.5 break-all font-mono text-xs text-dimmed">
                          幂等键 {{ operation.idempotencyKey }}
                        </p>
                      </div>
                      <UBadge
                        :color="operation.state === 'succeeded' ? 'success' : operation.state === 'failed' ? 'error' : operation.state === 'unknown' || operation.state === 'manual_review' ? 'warning' : 'info'"
                        variant="soft"
                      >
                        {{ supplierOperationStatusLabel(operation.state) }}
                      </UBadge>
                    </div>

                    <dl class="mt-3 grid gap-2 border-t border-default pt-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
                      <div>
                        <dt class="text-muted">
                          供应商操作 ID
                        </dt>
                        <dd class="mt-1 break-all font-mono text-highlighted">
                          {{ operation.providerOperationId ?? '尚未返回' }}
                        </dd>
                      </div>
                      <div>
                        <dt class="text-muted">
                          创建请求
                        </dt>
                        <dd class="mt-1 text-highlighted">
                          {{ operation.createRequestedAt ? formatDate(operation.createRequestedAt) : '尚未发出' }} · {{ operation.createAttemptCount }} 次
                        </dd>
                      </div>
                      <div>
                        <dt class="text-muted">
                          最近查单
                        </dt>
                        <dd class="mt-1 text-highlighted">
                          {{ operation.lastQueryAt ? formatDate(operation.lastQueryAt) : '尚未查询' }} · {{ operation.queryAttemptCount }} 次
                        </dd>
                      </div>
                      <div>
                        <dt class="text-muted">
                          HTTP / 分类 / 错误
                        </dt>
                        <dd class="mt-1 break-words text-highlighted">
                          {{ operation.lastHttpStatus ?? '—' }} · {{ operation.lastFailureClass ?? '—' }} · {{ operation.lastErrorCode ?? '—' }}
                        </dd>
                      </div>
                    </dl>

                    <p
                      v-if="operation.nextActionAt"
                      class="mt-2 text-xs text-warning"
                    >
                      下次恢复检查：{{ formatDate(operation.nextActionAt) }}
                    </p>

                    <!-- 折叠的供应商状态事件 -->
                    <details
                      v-if="operation.events.length"
                      class="mt-3 border-t border-default pt-3"
                    >
                      <summary class="min-h-11 cursor-pointer content-center text-xs font-medium text-primary flex items-center justify-between">
                        <span>最近状态事件（{{ Math.min(6, operation.events.length) }} 条）</span>
                        <UIcon
                          name="i-lucide-chevron-down"
                          class="size-4"
                        />
                      </summary>
                      <ul class="mt-2 grid gap-1 text-xs text-muted sm:grid-cols-2">
                        <li
                          v-for="event in operation.events.slice(-6).reverse()"
                          :key="`${event.eventType}-${event.createdAt}`"
                          class="flex min-w-0 flex-wrap gap-x-2 rounded-md bg-default/40 p-2"
                        >
                          <time :datetime="event.createdAt">{{ formatDate(event.createdAt) }}</time>
                          <span>{{ event.eventType }}</span>
                          <span>{{ event.classification ?? '' }}</span>
                          <span>{{ event.httpStatus ?? '' }}</span>
                          <span
                            v-if="event.errorCode"
                            class="text-warning"
                          >{{ event.errorCode }}</span>
                        </li>
                      </ul>
                    </details>

                    <div class="mt-3 flex flex-wrap gap-2">
                      <UButton
                        v-if="!['succeeded', 'failed', 'create_in_flight', 'query_in_flight'].includes(operation.state)"
                        size="sm"
                        color="neutral"
                        variant="outline"
                        icon="i-lucide-search"
                        :loading="supplierActionId === operation.id"
                        :disabled="Boolean(supplierActionId)"
                        @click="runSupplierAction(operation.id, 'query')"
                      >
                        查询同一供应商操作
                      </UButton>
                      <UButton
                        v-if="operation.state === 'failed' && operation.lastFailureClass === 'supplier_rejected' && data.order.status === 'processing'"
                        size="sm"
                        color="warning"
                        variant="outline"
                        icon="i-lucide-rotate-cw"
                        :loading="supplierActionId === operation.id"
                        :disabled="Boolean(supplierActionId)"
                        @click="runSupplierAction(operation.id, 'retry')"
                      >
                        恢复明确拒绝的单位
                      </UButton>
                    </div>
                  </li>
                </ol>
              </section>

              <!-- 章节 6：库存预留与事件明细 -->
              <section
                id="inventory-audit"
                aria-labelledby="inventory-audit-title"
                class="scroll-mt-16 rounded-2xl border border-default bg-elevated/40 p-5 shadow-xs sm:p-6"
              >
                <header class="mb-4 flex items-center justify-between border-b border-default pb-3">
                  <div class="flex items-center gap-2">
                    <UIcon
                      name="i-lucide-boxes"
                      class="size-5 text-primary"
                    />
                    <h2
                      id="inventory-audit-title"
                      class="font-semibold text-highlighted"
                    >
                      库存预留与变动记录
                    </h2>
                  </div>
                  <UBadge
                    color="neutral"
                    variant="soft"
                    size="xs"
                  >
                    {{ data.inventory.length }} 项库存单元
                  </UBadge>
                </header>

                <ul class="space-y-3">
                  <li
                    v-for="entry in data.inventory"
                    :key="entry.orderItemId"
                    class="min-w-0 rounded-xl border border-default bg-elevated p-3.5"
                  >
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <p class="break-all font-mono text-xs text-muted">
                        订单项 {{ entry.orderItemId }}
                      </p>
                      <UBadge
                        color="neutral"
                        variant="subtle"
                        size="xs"
                      >
                        当前预留 {{ entry.reservedQuantity }} 件
                      </UBadge>
                    </div>
                    <p
                      v-if="!entry.reservationId"
                      class="mt-1 text-xs text-muted"
                    >
                      unlimited 模式，不建立数量库存预留。
                    </p>
                    <ol
                      v-if="entry.events.length"
                      class="mt-2.5 space-y-1.5 text-xs text-muted border-t border-default/70 pt-2"
                    >
                      <li
                        v-for="(event, index) in entry.events"
                        :key="`${event.createdAt}-${index}`"
                        class="flex flex-wrap justify-between gap-2"
                      >
                        <span class="font-medium text-highlighted">{{ stateLabel(event.action) }} {{ event.quantity }} 件</span>
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

              <!-- 章节 7：人工与自动履约审计 & 订单状态历史 -->
              <section
                id="fulfillment-audit"
                aria-labelledby="fulfillment-attempts-title"
                class="scroll-mt-16 rounded-2xl border border-default bg-elevated/40 p-5 shadow-xs sm:p-6"
              >
                <header class="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-default pb-4">
                  <div>
                    <div class="flex items-center gap-2">
                      <UIcon
                        name="i-lucide-history"
                        class="size-5 text-primary"
                      />
                      <h2
                        id="fulfillment-attempts-title"
                        class="text-lg font-semibold text-highlighted"
                      >
                        履约与订单状态审计
                      </h2>
                    </div>
                    <p class="mt-1 text-xs text-muted">
                      记录系统自动发卡与人工交付审计流水、校验摘要及状态变更生命周期。
                    </p>
                  </div>
                </header>

                <!-- 履约审计 -->
                <div>
                  <h3 class="text-sm font-semibold text-highlighted">
                    人工与自动履约审计
                  </h3>
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
                    class="mt-3 divide-y divide-default rounded-xl border border-default bg-elevated px-4"
                  >
                    <li
                      v-for="attempt in data.fulfillmentAttempts"
                      :key="attempt.id"
                      class="flex flex-wrap items-start justify-between gap-3 py-3.5 text-sm"
                    >
                      <div class="min-w-0">
                        <p class="break-all font-mono text-xs text-muted">
                          履约 {{ attempt.id }}
                        </p>
                        <p class="mt-1 font-medium text-highlighted">
                          {{ attempt.quantity }} 件 · {{ attempt.deliveryCount }} 条交付 · {{ attempt.deliverySource === 'code_pool' ? '系统自动发卡' : `管理员 ${attempt.administratorId ?? '未知'}` }}
                        </p>
                        <p
                          v-if="attempt.failureCode"
                          class="mt-1 text-xs text-warning"
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
                        <UBadge
                          :color="attempt.status === 'succeeded' ? 'success' : attempt.status === 'failed' ? 'error' : 'warning'"
                          variant="soft"
                          size="xs"
                        >
                          {{ fulfillmentAttemptStatusLabel(attempt.status) }}
                        </UBadge>
                        <p class="mt-1">
                          <time :datetime="attempt.createdAt">{{ formatDate(attempt.createdAt) }}</time>
                        </p>
                        <p
                          v-if="attempt.retryAfter"
                          class="mt-1 text-warning"
                        >
                          下次自动重试 {{ formatDate(attempt.retryAfter) }}
                        </p>
                      </div>
                    </li>
                  </ul>
                </div>

                <!-- 订单状态历史事件 -->
                <div class="mt-6 border-t border-default pt-5">
                  <h3
                    id="admin-order-events-title"
                    class="text-sm font-semibold text-highlighted"
                  >
                    订单状态流转历史
                  </h3>
                  <ol
                    v-if="data.order.statusEvents.length"
                    class="mt-3 divide-y divide-default rounded-xl border border-default bg-elevated px-4"
                  >
                    <li
                      v-for="(event, index) in data.order.statusEvents"
                      :key="`${event.createdAt}-${index}`"
                      class="flex flex-wrap justify-between gap-2 py-3 text-xs"
                    >
                      <span class="font-medium text-highlighted">{{ event.previousStatus }} → {{ event.nextStatus }}</span>
                      <time
                        class="text-muted"
                        :datetime="event.createdAt"
                      >{{ formatDate(event.createdAt) }}</time>
                    </li>
                  </ol>
                  <p
                    v-else
                    class="mt-2 text-xs text-muted"
                  >
                    当前订单处于初始状态。
                  </p>
                </div>
              </section>
            </div>

            <!-- 右侧桌面端侧边导航与核验快速面板 (Sticky Desktop Sidebar) -->
            <aside class="hidden lg:block">
              <div class="sticky top-6 space-y-4">
                <div class="rounded-2xl border border-default bg-elevated/70 p-4 shadow-xs backdrop-blur-xs">
                  <div class="flex items-center justify-between border-b border-default pb-3">
                    <span class="text-xs font-semibold uppercase tracking-wider text-muted">章节快捷导航</span>
                    <UBadge
                      v-if="pendingActionCount > 0"
                      color="warning"
                      variant="subtle"
                      size="xs"
                    >
                      {{ pendingActionCount }} 项待处理
                    </UBadge>
                    <UBadge
                      v-else
                      color="neutral"
                      variant="subtle"
                      size="xs"
                    >
                      暂无待处理
                    </UBadge>
                  </div>

                  <nav
                    aria-label="页面内章节导航"
                    class="mt-3 space-y-1"
                  >
                    <button
                      v-for="item in navSections"
                      :key="item.id"
                      type="button"
                      class="group flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-xs transition-all text-left"
                      :class="activeSection === item.id ? 'bg-primary/10 text-primary font-medium' : 'text-muted hover:bg-muted/50 hover:text-highlighted'"
                      @click="scrollToSection(item.id)"
                    >
                      <span class="flex items-center gap-2 truncate">
                        <UIcon
                          :name="item.icon"
                          class="size-3.5 shrink-0 transition-colors"
                          :class="activeSection === item.id ? 'text-primary' : 'text-dimmed group-hover:text-muted'"
                        />
                        <span class="truncate">{{ item.label }}</span>
                      </span>
                      <span class="shrink-0 ml-2">
                        <span
                          v-if="item.hasWarning"
                          class="size-1.5 rounded-full bg-warning animate-pulse inline-block"
                        />
                        <span
                          v-else-if="item.badge"
                          class="text-[10px] text-dimmed group-hover:text-muted font-mono"
                        >
                          {{ item.badge }}
                        </span>
                      </span>
                    </button>
                  </nav>
                </div>

                <!-- 经营核验要点卡片 -->
                <div class="rounded-2xl border border-default bg-elevated/40 p-4 text-xs shadow-2xs">
                  <h4 class="font-semibold text-highlighted flex items-center gap-1.5">
                    <UIcon
                      name="i-lucide-shield-check"
                      class="size-4 text-success"
                    />
                    <span>履约安全保障</span>
                  </h4>
                  <ul class="mt-2.5 space-y-1.5 text-muted text-[11px] leading-relaxed">
                    <li>• 人工交付逐行记录并校验当前剩余件数。</li>
                    <li>• 支付对账核验走服务商正式接口，不伪造状态。</li>
                    <li>• 未知退款结果持续预留资金，防重复发起。</li>
                    <li>• 供应商接口具备独立幂等保护，仅对原单查单。</li>
                  </ul>
                </div>
              </div>
            </aside>
          </div>
        </template>
      </main>
    </template>
  </UDashboardPanel>
</template>
