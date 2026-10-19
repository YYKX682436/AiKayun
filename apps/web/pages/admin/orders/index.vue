<script setup lang="ts">
import type { AdminOrderPage } from '@aikayun/contracts'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '订单管理' })
useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const { request } = useAdminApi()
const orders = ref<AdminOrderPage['items']>([])
const total = ref(0)
const totalPages = ref(0)
const page = ref(1)
const status = ref<'all' | 'pending_payment' | 'processing' | 'completed' | 'closed'>('all')
const loading = ref(false)
const errorMessage = ref('')
let sequence = 0

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
  try {
    const query = new URLSearchParams({ page: String(page.value), pageSize: '20', status: status.value })
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

watch([page, status], () => { void loadOrders() }, { immediate: true })
onBeforeUnmount(() => { sequence++ })

function setStatus(value: string) {
  if (value === 'all' || value === 'pending_payment' || value === 'processing' || value === 'completed' || value === 'closed') {
    status.value = value
    page.value = 1
  }
}
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
        <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
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
          <UFormField
            label="订单状态"
            class="w-full sm:w-48"
          >
            <USelect
              :model-value="status"
              :items="statusOptions"
              class="w-full"
              @update:model-value="setStatus(String($event))"
            />
          </UFormField>
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
          v-else-if="!orders.length"
          color="neutral"
          variant="subtle"
          icon="i-lucide-receipt-text"
          title="暂无订单"
          description="真实订单会在顾客提交后显示在此处。"
        />
        <section
          v-else
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
              @click="page--"
            >
              上一页
            </UButton>
            <span class="text-sm text-muted">第 {{ page }} / {{ totalPages }} 页 · 共 {{ total }} 笔</span>
            <UButton
              color="neutral"
              variant="outline"
              :disabled="loading || page >= totalPages"
              @click="page++"
            >
              下一页
            </UButton>
          </nav>
        </section>
      </main>
    </template>
  </UDashboardPanel>
</template>
