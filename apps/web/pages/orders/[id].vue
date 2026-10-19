<script setup lang="ts">
import type { OrderDetail } from '@aikayun/contracts'
import { CustomerApiError, useCustomerApi } from '~/composables/useCustomerApi'

const route = useRoute()
const customerApi = useCustomerApi()
const orderId = computed(() => String(route.params.id))
const order = shallowRef<OrderDetail | null>(null)
const loading = ref(false)
const cancelling = ref(false)
const confirmCancel = ref(false)
const errorMessage = ref('')
const mounted = ref(false)
let sequence = 0

useSeoMeta({ title: '订单详情', description: '查看订单状态、成交快照和已完成的数字交付。', robots: 'noindex, nofollow' })
useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const isCustomer = computed(() => Boolean(customerApi.session.value?.customer.id))
const canCancel = computed(() => order.value?.status === 'pending_payment')

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
    const result = await customerApi.request<OrderDetail>(path)
    if (currentSequence !== sequence || identityAtStart !== customerApi.identityVersion.value) return
    order.value = result
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
  } catch (error) {
    errorMessage.value = error instanceof CustomerApiError || error instanceof Error
      ? error.message
      : '订单暂时无法取消，请刷新后检查状态。'
  } finally {
    cancelling.value = false
  }
}

onMounted(() => {
  mounted.value = true
  void loadOrder()
})

watch(() => customerApi.identityVersion.value, () => {
  if (!mounted.value) return
  order.value = null
  confirmCancel.value = false
  void loadOrder()
}, { flush: 'sync' })
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
            description="当前尚未开放支付宝或微信支付。请勿向页面之外的账户付款；未付款订单会在截止时间后自动关闭并释放预留库存。"
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
