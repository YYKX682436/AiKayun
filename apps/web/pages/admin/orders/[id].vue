<script setup lang="ts">
import type { AdminOrderDetail, ManualFulfillmentResult } from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '订单详情' })
useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const route = useRoute()
const orderId = computed(() => String(route.params.id))
const { request } = useAdminApi()
const data = shallowRef<AdminOrderDetail | null>(null)
const loading = ref(false)
const savingItemId = ref('')
const errorMessage = ref('')
const successMessage = ref('')
const deliveryDrafts = reactive<Record<string, string>>({})
let sequence = 0

function statusLabel(status: AdminOrderDetail['order']['status'], paymentStatus: AdminOrderDetail['order']['paymentStatus']): string {
  if (status === 'pending_payment') return '等待付款'
  if (status === 'processing') return paymentStatus === 'not_required' ? '等待人工交付' : '付款成功 · 等待人工交付'
  if (status === 'completed') return '已完成'
  return '已关闭'
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
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
    const result = await request<AdminOrderDetail>(`/api/v1/admin/orders/${orderId.value}`)
    if (currentSequence !== sequence) return
    data.value = result
  } catch (error) {
    if (currentSequence !== sequence) return
    errorMessage.value = error instanceof Error ? error.message : '订单详情暂时无法加载。'
  } finally {
    if (currentSequence === sequence) loading.value = false
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
                      SKU {{ item.skuCode }} · {{ item.inventoryMode }} · {{ item.fulfillmentMethod }}
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
              人工履约审计
            </h2>
            <UAlert
              v-if="!data.fulfillmentAttempts.length"
              class="mt-3"
              color="neutral"
              variant="subtle"
              title="尚无履约记录"
              description="录入实际交付内容后，订单项、操作管理员、数量和内容摘要会保存在审计记录中。"
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
                    {{ attempt.quantity }} 件 · {{ attempt.deliveryCount }} 条内容 · 管理员 {{ attempt.administratorId ?? '未知' }}
                  </p>
                  <p
                    v-if="attempt.resultSha256"
                    class="mt-1 break-all font-mono text-xs text-dimmed"
                  >
                    SHA-256 {{ attempt.resultSha256 }}
                  </p>
                </div>
                <div class="text-right text-xs text-muted">
                  <p>{{ attempt.status }}</p><time :datetime="attempt.createdAt">{{ formatDate(attempt.createdAt) }}</time>
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
