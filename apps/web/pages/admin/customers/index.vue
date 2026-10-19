<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { AdminCustomerList, AdminCustomerListItem } from '@aikayun/contracts'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '顾客管理' })

const route = useRoute()
const router = useRouter()
const { request } = useAdminApi()
const customers = ref<AdminCustomerListItem[]>([])
const total = ref(0)
const totalPages = ref(0)
const loading = ref(true)
const errorMessage = ref('')
const searchInput = ref(String(route.query.search ?? ''))
const successMessage = computed(() => route.query.notice === 'deleted' ? '顾客已删除，历史交易与审计记录仍保留。' : '')
let searchTimer: ReturnType<typeof setTimeout> | undefined
let requestSequence = 0

const page = computed(() => Math.max(1, Math.min(100_000, Number(route.query.page) || 1)))
const pageSize = computed(() => [20, 50, 100].includes(Number(route.query.pageSize)) ? Number(route.query.pageSize) : 20)
const search = computed(() => String(route.query.search ?? '').trim())
const status = computed(() => String(route.query.status ?? 'all'))
const sortOrder = computed(() => route.query.sortOrder === 'asc' ? 'asc' : 'desc')

const columns: TableColumn<AdminCustomerListItem>[] = [
  { accessorKey: 'username', header: '用户名' },
  { id: 'contact', header: '联系方式' },
  { accessorKey: 'status', header: '账户状态' },
  { accessorKey: 'createdAt', header: '注册时间' },
  { id: 'actions', header: '管理' },
]

const statusOptions = [
  { label: '全部顾客', value: 'all' },
  { label: '正常', value: 'active' },
  { label: '已禁用', value: 'disabled' },
  { label: '已删除', value: 'deleted' },
]
const sortOptions = [
  { label: '最新注册', value: 'desc' },
  { label: '最早注册', value: 'asc' },
]
const pageSizeOptions = [
  { label: '20 条 / 页', value: 20 },
  { label: '50 条 / 页', value: 50 },
  { label: '100 条 / 页', value: 100 },
]

function updateQuery(patch: Record<string, string | number | undefined>) {
  const next: Record<string, string> = {}
  const values = {
    search: search.value,
    status: status.value,
    sortOrder: sortOrder.value,
    page: page.value,
    pageSize: pageSize.value,
    ...patch,
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '' && value !== null) next[key] = String(value)
  }
  const current = Object.fromEntries(Object.entries(route.query)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  if (JSON.stringify(Object.entries(current).sort()) !== JSON.stringify(Object.entries(next).sort())) {
    void router.replace({ query: next })
  }
}

async function loadCustomers() {
  if (!import.meta.client) return
  const sequence = ++requestSequence
  loading.value = true
  errorMessage.value = ''
  const query = new URLSearchParams({
    page: String(page.value),
    pageSize: String(pageSize.value),
    status: status.value,
    sortOrder: sortOrder.value,
  })
  if (search.value) query.set('search', search.value)
  try {
    const result = await request<AdminCustomerList>(`/api/v1/admin/customers?${query.toString()}`)
    if (sequence !== requestSequence) return
    customers.value = result.items
    total.value = result.total
    totalPages.value = result.totalPages
  } catch (error) {
    if (sequence !== requestSequence) return
    errorMessage.value = error instanceof Error ? error.message : '顾客列表暂时无法加载。'
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

watch([page, pageSize, search, status, sortOrder], () => { void loadCustomers() }, { immediate: true })
watch(() => String(route.query.search ?? ''), (value) => {
  if (searchInput.value !== value) searchInput.value = value
})
watch(searchInput, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => updateQuery({ search: value.trim(), page: 1 }), 350)
})
onBeforeUnmount(() => {
  requestSequence++
  if (searchTimer) clearTimeout(searchTimer)
})

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function statusLabel(value: AdminCustomerListItem['status']) {
  return value === 'active' ? '正常' : value === 'disabled' ? '已禁用' : '已删除'
}

function statusColor(value: AdminCustomerListItem['status']) {
  return value === 'active' ? 'success' : value === 'disabled' ? 'warning' : 'neutral'
}
</script>

<template>
  <UDashboardPanel id="admin-main">
    <template #header>
      <UDashboardNavbar title="顾客管理">
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
          <p class="text-sm font-medium text-primary">
            账户与服务
          </p>
          <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
            顾客管理
          </h1>
          <p class="mt-2 max-w-3xl text-sm leading-6 text-muted">
            搜索顾客账户、查看验证状态与历史订单。删除账户会清除身份资料，并保留必要的交易关联。
          </p>
        </header>

        <UAlert
          v-if="successMessage"
          class="mb-4"
          color="success"
          variant="soft"
          :title="successMessage"
          role="status"
          aria-live="polite"
        />
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
              @click="loadCustomers"
            >
              重试
            </UButton>
          </template>
        </UAlert>

        <UCard
          :ui="{ body: 'p-4 sm:p-5' }"
          class="min-w-0"
        >
          <div class="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(16rem,1fr)_12rem_12rem_10rem] lg:items-end">
            <UFormField
              label="搜索顾客"
              name="customerSearch"
            >
              <UInput
                id="customer-search"
                v-model="searchInput"
                class="w-full"
                icon="i-lucide-search"
                placeholder="用户名、邮箱或手机号前缀"
                autocomplete="off"
                aria-label="搜索用户名、邮箱或手机号"
              />
            </UFormField>
            <UFormField
              label="账户状态"
              name="customerStatus"
            >
              <USelect
                id="customer-status-filter"
                :model-value="status"
                :items="statusOptions"
                value-key="value"
                class="w-full"
                aria-label="按账户状态筛选"
                @update:model-value="value => updateQuery({ status: String(value), page: 1 })"
              />
            </UFormField>
            <UFormField
              label="注册时间"
              name="customerSort"
            >
              <USelect
                id="customer-sort-order"
                :model-value="sortOrder"
                :items="sortOptions"
                value-key="value"
                class="w-full"
                aria-label="注册时间排序"
                @update:model-value="value => updateQuery({ sortOrder: String(value), page: 1 })"
              />
            </UFormField>
            <UFormField
              label="每页数量"
              name="customerPageSize"
            >
              <USelect
                id="customer-page-size"
                :model-value="pageSize"
                :items="pageSizeOptions"
                value-key="value"
                class="w-full"
                aria-label="每页显示数量"
                @update:model-value="value => updateQuery({ pageSize: Number(value), page: 1 })"
              />
            </UFormField>
          </div>

          <div class="mt-4 flex min-h-8 flex-wrap items-center justify-between gap-2 border-b border-muted pb-3 text-sm text-muted">
            <p aria-live="polite">
              {{ loading ? '正在读取顾客…' : `共 ${total.toLocaleString('zh-CN')} 位顾客` }}
            </p>
            <p
              v-if="status === 'deleted'"
              class="text-xs"
            >
              已删除身份仅供查看历史关联，不能恢复。
            </p>
            <p
              v-else
              class="text-xs"
            >
              已删除账户默认隐藏；搜索使用前缀匹配。
            </p>
          </div>

          <div
            v-if="loading"
            class="grid gap-3 py-4"
            aria-label="正在加载顾客列表"
            aria-busy="true"
          >
            <div
              v-for="row in 4"
              :key="row"
              class="h-16 animate-pulse rounded-lg bg-elevated"
            />
          </div>

          <template v-else-if="customers.length">
            <div class="hidden overflow-hidden md:block">
              <UTable
                :data="customers"
                :columns="columns"
                class="min-w-0"
              >
                <template #username-cell="{ row }">
                  <span class="font-medium text-highlighted">{{ row.original.username ?? '已删除顾客' }}</span>
                </template>
                <template #contact-cell="{ row }">
                  <div class="grid min-w-0 gap-0.5 text-sm">
                    <span class="break-all text-highlighted">{{ row.original.email || '未填写邮箱' }}</span>
                    <span class="break-all text-muted">{{ row.original.phone || '未填写手机号' }}</span>
                  </div>
                </template>
                <template #status-cell="{ row }">
                  <UBadge
                    :color="statusColor(row.original.status)"
                    variant="subtle"
                  >
                    {{ statusLabel(row.original.status) }}
                  </UBadge>
                </template>
                <template #createdAt-cell="{ row }">
                  <time
                    class="whitespace-nowrap text-sm text-muted"
                    :datetime="row.original.createdAt"
                  >
                    {{ formatDate(row.original.createdAt) }}
                  </time>
                </template>
                <template #actions-cell="{ row }">
                  <UButton
                    :to="`/admin/customers/${row.original.id}`"
                    color="primary"
                    variant="ghost"
                    trailing-icon="i-lucide-arrow-right"
                    size="sm"
                  >
                    查看详情
                  </UButton>
                </template>
              </UTable>
            </div>

            <ul
              class="grid gap-3 py-4 md:hidden"
              aria-label="顾客列表"
            >
              <li
                v-for="customer in customers"
                :key="customer.id"
              >
                <UCard
                  :ui="{ body: 'p-4' }"
                  class="min-w-0"
                >
                  <div class="flex min-w-0 items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="break-all font-semibold text-highlighted">
                        {{ customer.username ?? '已删除顾客' }}
                      </p>
                      <p class="mt-2 break-all text-sm text-highlighted">
                        {{ customer.email || '未填写邮箱' }}
                      </p>
                      <p class="mt-1 break-all text-sm text-muted">
                        {{ customer.phone || '未填写手机号' }}
                      </p>
                    </div>
                    <UBadge
                      :color="statusColor(customer.status)"
                      variant="subtle"
                      class="shrink-0"
                    >
                      {{ statusLabel(customer.status) }}
                    </UBadge>
                  </div>
                  <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-muted pt-3">
                    <time
                      class="text-xs text-muted"
                      :datetime="customer.createdAt"
                    >注册于 {{ formatDate(customer.createdAt) }}</time>
                    <UButton
                      :to="`/admin/customers/${customer.id}`"
                      color="primary"
                      variant="soft"
                      size="sm"
                    >
                      查看详情
                    </UButton>
                  </div>
                </UCard>
              </li>
            </ul>
          </template>

          <UEmpty
            v-else
            class="py-10"
            icon="i-lucide-users-round"
            :title="search ? '没有找到匹配的顾客' : '当前筛选下没有顾客'"
            :description="search ? '检查用户名、邮箱或手机号前缀，或清空搜索条件。' : '顾客注册后会显示在这里。'"
          >
            <template
              v-if="search"
              #actions
            >
              <UButton
                color="neutral"
                variant="outline"
                @click="searchInput = ''; updateQuery({ search: '', page: 1 })"
              >
                清空搜索
              </UButton>
            </template>
          </UEmpty>

          <div
            v-if="totalPages > 1"
            class="flex flex-col gap-3 border-t border-muted pt-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <p class="text-sm text-muted">
              第 {{ page }} / {{ totalPages }} 页
            </p>
            <UPagination
              :page="page"
              :total="total"
              :items-per-page="pageSize"
              :sibling-count="1"
              show-edges
              aria-label="顾客列表分页"
              @update:page="value => updateQuery({ page: value })"
            />
          </div>
        </UCard>
      </main>
    </template>
  </UDashboardPanel>
</template>
