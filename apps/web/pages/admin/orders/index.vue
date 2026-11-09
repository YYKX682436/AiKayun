<script setup lang="ts">
import type { AdminOrderPage } from '@aikayun/contracts'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '订单管理' })
useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const route = useRoute()
const router = useRouter()
const { request } = useAdminApi()
const orders = ref<AdminOrderPage['items']>([])
const total = ref(0)
const totalPages = ref(0)
const searchInput = ref(typeof route.query.search === 'string' ? route.query.search : '')
const loading = ref(false)
const errorMessage = ref('')
let sequence = 0

const validStatuses = ['all', 'pending_payment', 'processing', 'completed', 'closed'] as const
type AdminOrderStatusFilter = typeof validStatuses[number]

const page = computed(() => {
  const value = Number(route.query.page)
  return Number.isInteger(value) && value >= 1 && value <= 100_000 ? value : 1
})
const status = computed<AdminOrderStatusFilter>(() =>
  typeof route.query.status === 'string' && validStatuses.includes(route.query.status as AdminOrderStatusFilter)
    ? route.query.status as AdminOrderStatusFilter
    : 'all',
)
const search = computed(() => typeof route.query.search === 'string' ? route.query.search : '')

const statusOptions = [
  { label: '全部订单', value: 'all' },
  { label: '待付款', value: 'pending_payment' },
  { label: '处理中', value: 'processing' },
  { label: '已完成', value: 'completed' },
  { label: '已关闭', value: 'closed' },
]

function stateLabel(order: AdminOrderPage['items'][number]): string {
  if (order.status === 'pending_payment') return '等待付款'
  if (order.status === 'processing') return order.paymentStatus === 'not_required' ? '等待交付' : '付款成功 · 等待交付'
  if (order.status === 'completed') return '已完成'
  return '已关闭'
}

function ownerLabel(order: AdminOrderPage['items'][number]): string {
  return order.ownerType === 'customer'
    ? `顾客：${order.customerUsername ?? order.customerId ?? '已删除账户'}`
    : '游客会话'
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

async function loadOrders() {
  if (!import.meta.client) return
  const currentSequence = ++sequence
  loading.value = true
  errorMessage.value = ''
  orders.value = []
  total.value = 0
  totalPages.value = 0
  try {
    const query = new URLSearchParams({ page: String(page.value), pageSize: '20', status: status.value })
    if (search.value) query.set('search', search.value)
    const result = await request<AdminOrderPage>(`/api/v1/admin/orders?${query}`)
    if (currentSequence !== sequence) return
    orders.value = result.items
    total.value = result.total
    totalPages.value = result.totalPages
  } catch (error) {
    if (currentSequence !== sequence) return
    errorMessage.value = error instanceof Error ? error.message : '订单列表暂时无法加载。'
  } finally {
    if (currentSequence === sequence) loading.value = false
  }
}

function updateQuery(next: { search: string, status: AdminOrderStatusFilter, page: number }) {
  const query: Record<string, string> = {}
  if (next.search) query.search = next.search
  if (next.status !== 'all') query.status = next.status
  if (next.page > 1) query.page = String(next.page)
  void router.push({ path: '/admin/orders', query })
}

function submitSearch() {
  updateQuery({ search: searchInput.value.trim(), status: status.value, page: 1 })
}

function clearSearch() {
  searchInput.value = ''
  updateQuery({ search: '', status: status.value, page: 1 })
}

function setStatus(value: string) {
  if (validStatuses.includes(value as AdminOrderStatusFilter)) {
    updateQuery({ search: search.value, status: value as AdminOrderStatusFilter, page: 1 })
  }
}

function setPage(value: number) {
  updateQuery({ search: search.value, status: status.value, page: value })
}

watch([page, status, search], () => { void loadOrders() }, { immediate: true, flush: 'sync' })
watch(search, (value) => {
  if (searchInput.value !== value) searchInput.value = value
})
onBeforeUnmount(() => { sequence++ })
</script>

<template>
  <UDashboardPanel id="admin-main">
    <template #header>
      <UDashboardNavbar title="订单管理">
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
        <header class="mb-6">
          <div>
            <p class="text-sm font-medium text-primary">
              订单与履约
            </p>
            <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
              订单管理
            </h1>
            <p class="mt-2 max-w-3xl text-sm leading-6 text-muted">
              查看真实成交快照、顾客或游客归属、库存事件与人工数字交付记录。
            </p>
          </div>
        </header>

        <UCard
          :ui="{ body: 'p-4 sm:p-5' }"
          class="mb-5 min-w-0"
        >
          <form
            class="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end"
            role="search"
            @submit.prevent="submitSearch"
          >
            <UFormField
              label="搜索订单"
              name="orderSearch"
              hint="完整订单 UUID 或顾客完整用户名"
            >
              <UInput
                id="order-search"
                v-model="searchInput"
                class="w-full"
                icon="i-lucide-search"
                placeholder="输入订单 UUID 或用户名"
                autocomplete="off"
                aria-label="搜索完整订单 UUID 或顾客用户名"
              />
            </UFormField>
            <UFormField
              label="订单状态"
              name="orderStatus"
            >
              <USelect
                id="order-status-filter"
                :model-value="status"
                :items="statusOptions"
                value-key="value"
                class="w-full"
                aria-label="按订单状态筛选"
                @update:model-value="setStatus(String($event))"
              />
            </UFormField>
            <div class="flex flex-wrap gap-2 sm:justify-end">
              <UButton
                type="submit"
                icon="i-lucide-search"
                class="min-h-11"
              >
                搜索
              </UButton>
              <UButton
                v-if="search || searchInput"
                type="button"
                color="neutral"
                variant="outline"
                class="min-h-11"
                @click="clearSearch"
              >
                清空搜索
              </UButton>
            </div>
          </form>
        </UCard>

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
              @click="loadOrders"
            >
              重试
            </UButton>
          </template>
        </UAlert>

        <div
          v-if="loading && !orders.length"
          class="space-y-3"
          aria-label="正在加载订单"
          aria-busy="true"
        >
          <div
            v-for="index in 5"
            :key="index"
            class="h-24 animate-pulse rounded-xl border border-default bg-elevated motion-reduce:animate-none"
          />
        </div>
        <UAlert
          v-else-if="!loading && !errorMessage && !orders.length"
          color="neutral"
          variant="subtle"
          icon="i-lucide-receipt-text"
          title="没有找到符合条件的订单"
          description="请检查搜索内容或调整订单状态。"
          role="status"
          aria-live="polite"
        />
        <section
          v-else-if="orders.length"
          class="space-y-3"
          aria-label="后台订单列表"
          :aria-busy="loading"
        >
          <article
            v-for="order in orders"
            :key="order.id"
            class="grid min-w-0 gap-3 rounded-xl border border-default bg-elevated p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5"
          >
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="break-all font-mono text-sm font-semibold text-highlighted">
                  {{ order.id }}
                </h2>
                <UBadge
                  :color="order.status === 'completed' ? 'success' : order.status === 'closed' ? 'neutral' : order.status === 'pending_payment' ? 'warning' : 'primary'"
                  variant="soft"
                >
                  {{ stateLabel(order) }}
                </UBadge>
              </div>
              <p class="mt-2 text-sm text-muted">
                {{ ownerLabel(order) }} · {{ formatDate(order.createdAt) }} · {{ order.itemCount }} 个订单项
              </p>
              <p
                v-if="order.status === 'pending_payment'"
                class="mt-1 text-xs text-muted"
              >
                待付款订单不会显示支付成功操作。
              </p>
            </div>
            <div class="flex items-center justify-between gap-3 sm:justify-end">
              <span class="text-lg font-semibold tabular-nums text-highlighted">¥{{ order.totalAmount }}</span>
              <UButton
                :to="`/admin/orders/${order.id}`"
                color="primary"
                variant="outline"
              >
                查看详情
              </UButton>
            </div>
          </article>

          <nav
            v-if="totalPages > 1"
            class="flex flex-wrap items-center justify-between gap-3 pt-2"
            aria-label="后台订单分页"
          >
            <UButton
              color="neutral"
              variant="outline"
              :disabled="loading || page <= 1"
              @click="setPage(page - 1)"
            >
              上一页
            </UButton>
            <span class="text-sm text-muted">第 {{ page }} / {{ totalPages }} 页 · 共 {{ total }} 笔</span>
            <UButton
              color="neutral"
              variant="outline"
              :disabled="loading || page >= totalPages"
              @click="setPage(page + 1)"
            >
              下一页
            </UButton>
          </nav>
        </section>
      </main>
    </template>
  </UDashboardPanel>
</template>
