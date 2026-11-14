<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { AdminOrderPage } from '@aikayun/contracts'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '订单管理' })
useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const route = useRoute()
const router = useRouter()
const { request } = useAdminApi()
const toast = useToast()
const orders = ref<AdminOrderPage['items']>([])
const total = ref(0)
const totalPages = ref(0)
const searchInput = ref(typeof route.query.search === 'string' ? route.query.search : '')
const loading = ref(false)
const errorMessage = ref('')
const copiedOrderId = ref('')
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

const columns: TableColumn<AdminOrderPage['items'][number]>[] = [
  { id: 'id', header: '订单编号' },
  { id: 'status', header: '状态' },
  { id: 'owner', header: '顾客 / 账号' },
  { id: 'itemCount', header: '订单项' },
  { id: 'totalAmount', header: '金额' },
  { id: 'createdAt', header: '下单时间' },
  { id: 'actions', header: '操作' },
]

function stateLabel(order: AdminOrderPage['items'][number]): string {
  if (order.status === 'pending_payment') return '等待付款'
  if (order.status === 'processing') return order.paymentStatus === 'not_required' ? '等待交付' : '付款成功 · 等待交付'
  if (order.status === 'completed') return '已完成'
  return '已关闭'
}

function stateColor(order: AdminOrderPage['items'][number]) {
  if (order.status === 'completed') return 'success'
  if (order.status === 'closed') return 'neutral'
  if (order.status === 'pending_payment') return 'warning'
  return 'primary'
}

function stateIcon(order: AdminOrderPage['items'][number]) {
  if (order.status === 'completed') return 'i-lucide-check-circle-2'
  if (order.status === 'closed') return 'i-lucide-x-circle'
  if (order.status === 'pending_payment') return 'i-lucide-circle-alert'
  return 'i-lucide-clock'
}

function ownerLabel(order: AdminOrderPage['items'][number]): string {
  return order.ownerType === 'customer'
    ? `顾客：${order.customerUsername ?? order.customerId ?? '已删除账户'}`
    : '游客会话'
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

async function copyOrderId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    copiedOrderId.value = id
    toast.add({
      title: '已复制订单编号',
      description: id,
      color: 'success',
      icon: 'i-lucide-copy-check',
    })
    setTimeout(() => {
      if (copiedOrderId.value === id) copiedOrderId.value = ''
    }, 2000)
  } catch {
    // 忽略剪贴板写入失败
  }
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
        <header class="mb-5 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 class="text-xl sm:text-2xl font-bold tracking-tight text-highlighted">
              订单管理
            </h1>
            <p class="mt-0.5 text-xs sm:text-sm text-muted">
              查看真实成交快照、顾客归属与履约交付记录
            </p>
          </div>
        </header>

        <section
          aria-label="订单筛选"
          class="mb-4 rounded-xl border border-default bg-elevated p-3 sm:p-4 shadow-2xs"
        >
          <form
            class="flex flex-col gap-2.5 sm:grid sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-center"
            role="search"
            @submit.prevent="submitSearch"
          >
            <UInput
              id="order-search"
              v-model="searchInput"
              class="w-full"
              icon="i-lucide-search"
              placeholder="搜索订单 UUID 或顾客用户名"
              autocomplete="off"
              aria-label="搜索完整订单 UUID 或顾客用户名"
              size="md"
            >
              <template
                v-if="searchInput"
                #trailing
              >
                <UButton
                  icon="i-lucide-x"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  aria-label="清除搜索输入"
                  class="size-5 p-0 text-muted hover:text-highlighted"
                  @click="clearSearch"
                />
              </template>
            </UInput>
            <div class="grid grid-cols-[1fr_auto] gap-2 sm:contents">
              <USelect
                id="order-status-filter"
                :model-value="status"
                :items="statusOptions"
                value-key="value"
                class="w-full"
                size="md"
                aria-label="按订单状态筛选"
                @update:model-value="setStatus(String($event))"
              />
              <div class="flex items-center gap-2">
                <UButton
                  type="submit"
                  icon="i-lucide-search"
                  size="md"
                  class="min-h-9"
                >
                  搜索
                </UButton>
                <UButton
                  v-if="search || searchInput"
                  type="button"
                  color="neutral"
                  variant="outline"
                  size="md"
                  class="min-h-9"
                  @click="clearSearch"
                >
                  清空搜索
                </UButton>
              </div>
            </div>
          </form>
        </section>

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
              size="sm"
              :loading="loading"
              @click="loadOrders"
            >
              重试
            </UButton>
          </template>
        </UAlert>

        <div class="mb-3 flex items-center justify-between gap-3 text-xs sm:text-sm text-muted">
          <p aria-live="polite">
            {{ loading ? '正在加载订单…' : `共 ${total} 笔订单` }}
          </p>
          <div
            v-if="totalPages > 1"
            class="text-xs text-muted"
          >
            第 {{ page }} / {{ totalPages }} 页
          </div>
        </div>

        <div
          v-if="loading && !orders.length"
          class="space-y-3"
          aria-label="正在加载订单"
          aria-busy="true"
        >
          <div
            v-for="index in 5"
            :key="index"
            class="h-16 animate-pulse rounded-xl border border-default bg-elevated motion-reduce:animate-none"
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

        <div
          v-else-if="orders.length"
          class="space-y-4"
        >
          <!-- 桌面端表格视图 -->
          <div class="hidden overflow-x-auto rounded-xl border border-default bg-elevated shadow-2xs lg:block">
            <UTable
              :data="orders"
              :columns="columns"
              :loading="loading"
              class="w-full"
            >
              <template #id-cell="{ row }">
                <div class="flex items-center gap-1.5 min-w-0">
                  <UTooltip
                    :text="row.original.id"
                    :content="{ side: 'top' }"
                  >
                    <h2 class="font-mono text-xs font-semibold text-highlighted truncate max-w-[13rem]">
                      <NuxtLink
                        :to="`/admin/orders/${row.original.id}`"
                        class="hover:text-primary transition-colors focus-visible:outline-2 focus-visible:outline-primary"
                      >
                        {{ row.original.id }}
                      </NuxtLink>
                    </h2>
                  </UTooltip>
                  <UButton
                    :icon="copiedOrderId === row.original.id ? 'i-lucide-check' : 'i-lucide-copy'"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :aria-label="`复制订单编号 ${row.original.id}`"
                    class="size-6 p-0 text-muted hover:text-highlighted shrink-0"
                    @click.stop="copyOrderId(row.original.id)"
                  />
                </div>
              </template>

              <template #status-cell="{ row }">
                <UBadge
                  :color="stateColor(row.original)"
                  variant="subtle"
                  size="sm"
                  class="gap-1 font-medium whitespace-nowrap"
                >
                  <UIcon
                    :name="stateIcon(row.original)"
                    class="size-3.5"
                  />
                  <span>{{ stateLabel(row.original) }}</span>
                </UBadge>
              </template>

              <template #owner-cell="{ row }">
                <div class="flex items-center gap-1.5 text-xs sm:text-sm text-default">
                  <UIcon
                    :name="row.original.ownerType === 'customer' ? 'i-lucide-user' : 'i-lucide-user-x'"
                    class="size-4 shrink-0 text-muted"
                  />
                  <span class="truncate max-w-[11rem]">
                    {{ row.original.ownerType === 'customer' ? (row.original.customerUsername ?? row.original.customerId ?? '已删除账户') : '游客会话' }}
                  </span>
                </div>
              </template>

              <template #itemCount-cell="{ row }">
                <span class="text-xs text-muted tabular-nums whitespace-nowrap">
                  {{ row.original.itemCount }} 项商品
                </span>
              </template>

              <template #totalAmount-cell="{ row }">
                <div class="text-right">
                  <span class="font-semibold tabular-nums text-highlighted text-sm sm:text-base">
                    ¥{{ row.original.totalAmount }}
                  </span>
                </div>
              </template>

              <template #createdAt-cell="{ row }">
                <time
                  :datetime="row.original.createdAt"
                  class="text-xs text-muted block whitespace-nowrap"
                >
                  {{ formatDate(row.original.createdAt) }}
                </time>
              </template>

              <template #actions-cell="{ row }">
                <div class="flex items-center justify-end whitespace-nowrap">
                  <UButton
                    :to="`/admin/orders/${row.original.id}`"
                    size="xs"
                    :color="row.original.status === 'processing' ? 'primary' : 'neutral'"
                    :variant="row.original.status === 'processing' ? 'solid' : 'outline'"
                  >
                    查看详情
                  </UButton>
                </div>
              </template>
            </UTable>
          </div>

          <!-- 手机端卡片视图 -->
          <section
            class="space-y-3 lg:hidden"
            aria-label="后台订单列表"
            :aria-busy="loading"
          >
            <article
              v-for="order in orders"
              :key="order.id"
              class="rounded-xl border border-default bg-elevated p-3.5 space-y-3 shadow-2xs"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5 min-w-0">
                  <UTooltip :text="order.id">
                    <h2 class="font-mono text-xs font-semibold text-highlighted truncate max-w-[13rem]">
                      <NuxtLink
                        :to="`/admin/orders/${order.id}`"
                        class="hover:text-primary transition-colors"
                      >
                        {{ order.id }}
                      </NuxtLink>
                    </h2>
                  </UTooltip>
                  <UButton
                    :icon="copiedOrderId === order.id ? 'i-lucide-check' : 'i-lucide-copy'"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :aria-label="`复制订单编号 ${order.id}`"
                    class="size-6 p-0 text-muted hover:text-highlighted shrink-0"
                    @click.stop="copyOrderId(order.id)"
                  />
                </div>
                <UBadge
                  :color="stateColor(order)"
                  variant="subtle"
                  size="xs"
                  class="gap-1 shrink-0 font-medium whitespace-nowrap"
                >
                  <UIcon
                    :name="stateIcon(order)"
                    class="size-3"
                  />
                  <span>{{ stateLabel(order) }}</span>
                </UBadge>
              </div>

              <div class="flex items-center justify-between text-xs text-muted border-t border-default/60 pt-2.5">
                <div class="flex items-center gap-1 truncate max-w-[14rem]">
                  <UIcon
                    :name="order.ownerType === 'customer' ? 'i-lucide-user' : 'i-lucide-user-x'"
                    class="size-3.5 shrink-0"
                  />
                  <span class="truncate">{{ ownerLabel(order) }}</span>
                </div>
                <span class="shrink-0 tabular-nums">{{ order.itemCount }} 个订单项</span>
              </div>

              <p
                v-if="order.status === 'pending_payment'"
                class="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-md px-2 py-1"
              >
                待付款订单不会显示支付成功操作。
              </p>

              <div class="flex items-center justify-between border-t border-default/60 pt-2.5">
                <time
                  :datetime="order.createdAt"
                  class="text-xs text-muted block"
                >
                  {{ formatDate(order.createdAt) }}
                </time>
                <div class="flex items-center gap-3 shrink-0">
                  <span class="text-base font-semibold tabular-nums text-highlighted">¥{{ order.totalAmount }}</span>
                  <UButton
                    :to="`/admin/orders/${order.id}`"
                    size="sm"
                    :color="order.status === 'processing' ? 'primary' : 'neutral'"
                    :variant="order.status === 'processing' ? 'solid' : 'outline'"
                    class="whitespace-nowrap"
                  >
                    查看详情
                  </UButton>
                </div>
              </div>
            </article>
          </section>

          <!-- 分页器 -->
          <nav
            v-if="totalPages > 1"
            class="flex flex-wrap items-center justify-between gap-3 pt-2"
            aria-label="后台订单分页"
          >
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              :disabled="loading || page <= 1"
              @click="setPage(page - 1)"
            >
              上一页
            </UButton>
            <span class="text-sm text-muted">第 {{ page }} / {{ totalPages }} 页 · 共 {{ total }} 笔</span>
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              :disabled="loading || page >= totalPages"
              @click="setPage(page + 1)"
            >
              下一页
            </UButton>
          </nav>
        </div>
      </main>
    </template>
  </UDashboardPanel>
</template>
