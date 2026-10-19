<script setup lang="ts">
import type { OrderPage } from '@aikayun/contracts'
import { CustomerApiError, useCustomerApi } from '~/composables/useCustomerApi'

const customerApi = useCustomerApi()
const page = shallowRef<OrderPage | null>(null)
const pageNumber = ref(1)
const loading = ref(false)
const errorMessage = ref('')
const mounted = ref(false)
let sequence = 0

useSeoMeta({ title: '我的订单', description: '查看顾客账户或当前游客会话中的订单。', robots: 'noindex, nofollow' })
useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const isCustomer = computed(() => Boolean(customerApi.session.value?.customer.id))

function statusLabel(status: OrderPage['items'][number]['status'], total: string): string {
  if (status === 'pending_payment') return '等待付款'
  if (status === 'processing') return total === '0.00' ? '等待发货' : '付款成功 · 等待发货'
  if (status === 'completed') return '已完成'
  return '已关闭'
}

function paymentLabel(paymentStatus: OrderPage['items'][number]['paymentStatus']): string {
  if (paymentStatus === 'not_required') return '零元订单，无需付款'
  if (paymentStatus === 'unpaid') return '尚未付款'
  return '已确认付款'
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

async function loadOrders(nextPage = pageNumber.value) {
  const currentSequence = ++sequence
  const identityAtStart = customerApi.identityVersion.value
  loading.value = true
  errorMessage.value = ''
  try {
    const path = isCustomer.value ? '/api/v1/customer/orders' : '/api/v1/guest/orders'
    const result = await customerApi.request<OrderPage>(`${path}?page=${nextPage}&pageSize=20`)
    if (currentSequence !== sequence || identityAtStart !== customerApi.identityVersion.value) return
    page.value = result
    pageNumber.value = nextPage
  } catch (error) {
    if (currentSequence !== sequence || identityAtStart !== customerApi.identityVersion.value) return
    if (error instanceof CustomerApiError && error.code === 'GUEST_SESSION_REQUIRED') {
      page.value = { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 }
    } else {
      errorMessage.value = error instanceof Error ? error.message : '订单暂时无法加载。'
    }
  } finally {
    if (currentSequence === sequence) loading.value = false
  }
}

onMounted(() => {
  mounted.value = true
  void loadOrders(1)
})

watch(() => customerApi.identityVersion.value, () => {
  if (!mounted.value) return
  page.value = null
  pageNumber.value = 1
  void loadOrders(1)
}, { flush: 'sync' })
</script>

<template>
  <UContainer class="py-7 sm:py-10">
    <main
      id="main-content"
      class="mx-auto w-full max-w-5xl"
    >
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-medium text-primary">
            交易记录
          </p>
          <h1 class="mt-1 text-2xl font-semibold tracking-tight text-highlighted sm:text-3xl">
            我的订单
          </h1>
          <p class="mt-2 text-sm text-muted">
            {{ isCustomer ? `顾客账户：${customerApi.session.value?.customer.username}` : '当前浏览器的游客订单会话' }}
          </p>
        </div>
        <UButton
          to="/search"
          color="neutral"
          variant="outline"
          icon="i-lucide-shopping-bag"
        >
          继续选购
        </UButton>
      </header>

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
            @click="loadOrders()"
          >
            重试
          </UButton>
        </template>
      </UAlert>

      <div
        v-if="loading && !page"
        class="mt-6 space-y-3"
        aria-label="正在加载订单"
        aria-busy="true"
      >
        <div
          v-for="index in 3"
          :key="index"
          class="h-28 animate-pulse rounded-xl border border-default bg-elevated motion-reduce:animate-none"
        />
      </div>

      <UAlert
        v-else-if="page && !page.items.length"
        class="mt-6"
        color="neutral"
        variant="subtle"
        icon="i-lucide-receipt-text"
        title="暂无订单"
        :description="isCustomer ? '此顾客账户还没有订单。' : '此浏览器当前没有可恢复的游客订单。完成游客结算后，订单会保存在当前安全会话中。'"
      >
        <template #actions>
          <UButton
            to="/search"
            color="primary"
            variant="soft"
          >
            浏览商品
          </UButton>
        </template>
      </UAlert>

      <section
        v-else-if="page"
        class="mt-6 space-y-3"
        aria-label="订单列表"
        :aria-busy="loading"
      >
        <article
          v-for="order in page.items"
          :key="order.id"
          class="grid min-w-0 gap-4 rounded-xl border border-default bg-elevated p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="font-mono text-sm font-semibold text-highlighted">
                订单 {{ order.id }}
              </h2>
              <UBadge
                :color="order.status === 'completed' ? 'success' : order.status === 'closed' ? 'neutral' : order.status === 'pending_payment' ? 'warning' : 'primary'"
                variant="soft"
              >
                {{ statusLabel(order.status, order.totalAmount) }}
              </UBadge>
            </div>
            <p class="mt-2 text-sm text-muted">
              {{ formatDate(order.createdAt) }} · {{ order.itemCount }} 个订单项 · {{ paymentLabel(order.paymentStatus) }}
            </p>
            <p
              v-if="order.status === 'pending_payment' && order.unpaidExpiresAt"
              class="mt-1 text-sm text-muted"
            >
              未付款订单将于 {{ formatDate(order.unpaidExpiresAt) }} 自动关闭。
            </p>
          </div>
          <div class="flex items-center justify-between gap-3 sm:justify-end">
            <span class="text-lg font-semibold tabular-nums text-highlighted">¥{{ order.totalAmount }}</span>
            <UButton
              :to="`/orders/${order.id}`"
              color="primary"
              variant="outline"
            >
              订单详情
            </UButton>
          </div>
        </article>

        <nav
          v-if="page.totalPages > 1"
          class="flex flex-wrap items-center justify-between gap-3 pt-2"
          aria-label="订单分页"
        >
          <UButton
            color="neutral"
            variant="outline"
            :disabled="loading || pageNumber <= 1"
            @click="loadOrders(pageNumber - 1)"
          >
            上一页
          </UButton>
          <span class="text-sm text-muted">第 {{ pageNumber }} / {{ page.totalPages }} 页 · 共 {{ page.total }} 笔</span>
          <UButton
            color="neutral"
            variant="outline"
            :disabled="loading || pageNumber >= page.totalPages"
            @click="loadOrders(pageNumber + 1)"
          >
            下一页
          </UButton>
        </nav>
      </section>
    </main>
  </UContainer>
</template>
