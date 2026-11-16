<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type {
  AdminProductCategories,
  ProductListItem,
  ProductListResponse,
} from '@aikayun/contracts'

definePageMeta({ middleware: 'admin-auth', layout: 'admin' })
useSeoMeta({ title: '商品管理' })

const route = useRoute()
const router = useRouter()
const { request } = useAdminApi()
const toast = useToast()
const allFilterValue = '__all__'
const items = ref<ProductListItem[]>([])
const categories = ref<AdminProductCategories['categories']>([])
const total = ref(0)
const totalPages = ref(0)
const loading = ref(true)
const errorMessage = ref('')
const categoryError = ref('')
const actionMessage = ref('')
const busyId = ref('')
const copiedProductId = ref('')
const searchInput = ref(String(route.query.search ?? ''))
let searchTimer: ReturnType<typeof setTimeout> | undefined

const page = computed(() => Math.max(1, Number(route.query.page) || 1))
const pageSize = computed(() => Math.min(100, Math.max(1, Number(route.query.pageSize) || 20)))
const status = computed(() => String(route.query.status ?? ''))
const productType = computed(() => String(route.query.productType ?? ''))
const categoryId = computed(() => String(route.query.categoryId ?? ''))
const sortBy = computed(() => String(route.query.sortBy ?? 'updatedAt'))
const sortOrder = computed(() => String(route.query.sortOrder ?? 'desc'))
const search = computed(() => String(route.query.search ?? ''))

type ProductListQuery = {
  page: number
  pageSize: number
  search: string
  status: string
  productType: string
  categoryId: string
  sortBy: string
  sortOrder: string
}

const productQuery = computed<ProductListQuery>(() => ({
  page: page.value,
  pageSize: pageSize.value,
  search: search.value,
  status: status.value,
  productType: productType.value,
  categoryId: categoryId.value,
  sortBy: sortBy.value,
  sortOrder: sortOrder.value,
}))

let latestProductRequest = 0
let routeSearchSync: string | null = null

const columns: TableColumn<ProductListItem>[] = [
  { id: 'coverImage', header: '封面' },
  { accessorKey: 'name', header: '商品' },
  { accessorKey: 'status', header: '状态' },
  { id: 'priceRange', header: '有效售价' },
  { accessorKey: 'skuCount', header: 'SKU' },
  { id: 'categories', header: '主分类' },
  { id: 'timestamps', header: '更新时间' },
  { id: 'actions', header: '操作' },
]

const categoryItems = computed(() => [
  { label: '全部分类', value: allFilterValue },
  ...categories.value.map(category => ({ label: category.name, value: category.id })),
])

const statusItems = [
  { label: '全部状态', value: allFilterValue },
  { label: '销售中', value: 'active' },
  { label: '草稿', value: 'draft' },
  { label: '已暂停', value: 'paused' },
  { label: '已归档', value: 'archived' },
]

const quickStatusTabs = [
  { label: '全部', value: allFilterValue, icon: 'i-lucide-boxes' },
  { label: '销售中', value: 'active', icon: 'i-lucide-play-circle' },
  { label: '草稿', value: 'draft', icon: 'i-lucide-file-edit' },
  { label: '已暂停', value: 'paused', icon: 'i-lucide-pause-circle' },
  { label: '已归档', value: 'archived', icon: 'i-lucide-archive' },
]

const currentStatusTab = computed(() => status.value || allFilterValue)

function selectStatusTab(val: string) {
  updateQuery({
    status: val === allFilterValue ? '' : val,
    page: 1,
  })
}

const typeItems = [
  { label: '全部性质', value: allFilterValue },
  { label: '数字商品', value: 'digital' },
  { label: '实物商品', value: 'physical' },
  { label: '服务', value: 'service' },
]

const sortItems = [
  { label: '最近更新', value: 'updatedAt:desc' },
  { label: '最早更新', value: 'updatedAt:asc' },
  { label: '最新创建', value: 'createdAt:desc' },
  { label: '最早创建', value: 'createdAt:asc' },
  { label: '价格从高到低', value: 'price:desc' },
  { label: '价格从低到高', value: 'price:asc' },
]

const sortValue = computed(() => `${sortBy.value}:${sortOrder.value}`)
const isNonDefaultSort = computed(() => sortBy.value !== 'updatedAt' || sortOrder.value !== 'desc')
const currentSortLabel = computed(() => sortItems.find(s => s.value === sortValue.value)?.label ?? '自定义排序')

const hasActiveFilters = computed(() => {
  return Boolean(
    search.value ||
    status.value ||
    productType.value ||
    categoryId.value ||
    isNonDefaultSort.value,
  )
})

function updateQuery(patch: Record<string, string | number | undefined>) {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...route.query, ...patch })) {
    if (value !== undefined && value !== '' && value !== null) next[key] = String(value)
  }
  const stableEntries = (record: Record<string, string>) => JSON.stringify(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)))
  const current: Record<string, string> = {}
  for (const [key, value] of Object.entries(route.query)) {
    if (value !== undefined && value !== null && value !== '') current[key] = String(value)
  }
  if (stableEntries(current) !== stableEntries(next)) void router.push({ query: next })
}

function resetAllFilters() {
  searchInput.value = ''
  updateQuery({
    search: '',
    status: '',
    productType: '',
    categoryId: '',
    sortBy: undefined,
    sortOrder: undefined,
    page: 1,
  })
}

async function loadCategories() {
  categoryError.value = ''
  try {
    const result = await request<AdminProductCategories>('/api/v1/admin/categories')
    categories.value = result.categories
  } catch (error) {
    categoryError.value = error instanceof Error ? error.message : '分类列表加载失败。'
  }
}

async function loadProducts(queryState: ProductListQuery) {
  if (!import.meta.client) return
  const requestId = ++latestProductRequest
  loading.value = true
  errorMessage.value = ''
  items.value = []
  total.value = 0
  totalPages.value = 0
  const query = new URLSearchParams({ page: String(queryState.page), pageSize: String(queryState.pageSize) })
  for (const [key, value] of Object.entries({
    search: queryState.search,
    status: queryState.status,
    productType: queryState.productType,
    categoryId: queryState.categoryId,
    sortBy: queryState.sortBy,
    sortOrder: queryState.sortOrder,
  })) {
    if (value) query.set(key, value)
  }
  try {
    const result = await request<ProductListResponse>(`/api/v1/admin/products?${query.toString()}`)
    if (requestId !== latestProductRequest) return
    items.value = result.items
    total.value = result.total
    totalPages.value = result.totalPages
  } catch (error) {
    if (requestId !== latestProductRequest) return
    errorMessage.value = error instanceof Error ? error.message : '商品列表加载失败。'
  } finally {
    if (requestId === latestProductRequest) loading.value = false
  }
}

function reloadProducts() { void loadProducts({ ...productQuery.value }) }

watch(productQuery, (queryState) => {
  if (!import.meta.client) return
  const nextSearch = queryState.search
  if (searchInput.value !== nextSearch) {
    if (searchTimer) clearTimeout(searchTimer)
    routeSearchSync = nextSearch
    searchInput.value = nextSearch
  }
  void loadProducts({ ...queryState })
}, { immediate: true })

onMounted(() => {
  void loadCategories()
})

watch(searchInput, (value) => {
  if (routeSearchSync === value) {
    routeSearchSync = null
    return
  }
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => updateQuery({ search: value.trim(), page: 1 }), 350)
})

onBeforeUnmount(() => {
  latestProductRequest++
  if (searchTimer) clearTimeout(searchTimer)
})

function categoryName(product: ProductListItem) {
  return product.categories.find(category => category.isPrimary)?.name ?? '未分类'
}

function productTypeName(value: ProductListItem['productType']) {
  return value === 'physical' ? '实物商品' : value === 'digital' ? '数字商品' : '服务'
}

function productTypeBadgeColor(value: ProductListItem['productType']) {
  return value === 'digital' ? 'info' : value === 'physical' ? 'primary' : 'neutral'
}

function statusName(value: ProductListItem['status']) {
  return value === 'draft' ? '草稿' : value === 'active' ? '销售中' : value === 'paused' ? '已暂停' : '已归档'
}

function productStatusColor(value: ProductListItem['status']) {
  if (value === 'active') return 'success'
  if (value === 'paused') return 'warning'
  if (value === 'draft') return 'info'
  return 'neutral'
}

function productTransitionIcon(status: ProductListItem['status']) {
  if (status === 'active') return 'i-lucide-play'
  if (status === 'paused') return 'i-lucide-pause'
  if (status === 'archived') return 'i-lucide-archive'
  return 'i-lucide-undo'
}

function priceRange(product: ProductListItem) {
  if (!product.priceRange) return '未定价'
  if (product.priceRange.min === product.priceRange.max) return `¥${product.priceRange.min}`
  return `¥${product.priceRange.min} – ¥${product.priceRange.max}`
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function allowedTransition(current: ProductListItem['status']) {
  if (current === 'draft') return [{ label: '发布商品', status: 'active' as const }, { label: '归档商品', status: 'archived' as const }]
  if (current === 'active') return [{ label: '暂停销售', status: 'paused' as const }, { label: '归档商品', status: 'archived' as const }]
  if (current === 'paused') return [{ label: '重新上架', status: 'active' as const }, { label: '归档商品', status: 'archived' as const }]
  return [{ label: '恢复为草稿', status: 'draft' as const }]
}

function productMenuItems(product: ProductListItem) {
  return [
    [{
      label: '复制商品',
      icon: 'i-lucide-copy',
      onSelect: () => copyProduct(product),
    }],
    allowedTransition(product.status).map(action => ({
      label: action.label,
      icon: productTransitionIcon(action.status),
      onSelect: () => changeLifecycle(product, action.status),
    })),
  ]
}

async function copyProductId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    copiedProductId.value = id
    toast.add({
      title: '已复制商品 ID',
      description: id,
      color: 'success',
      icon: 'i-lucide-check',
    })
    setTimeout(() => {
      if (copiedProductId.value === id) copiedProductId.value = ''
    }, 2000)
  } catch {
    toast.add({
      title: '复制失败，请手动选择复制',
      color: 'error',
    })
  }
}

async function changeLifecycle(product: ProductListItem, next: ProductListItem['status']) {
  const label = next === 'archived' ? '归档' : next === 'draft' ? '恢复为草稿' : next === 'active' ? '发布上架' : '暂停销售'
  if ((next === 'archived' || next === 'draft') && !window.confirm(`确认${label}“${product.name}”？`)) return
  busyId.value = product.id
  actionMessage.value = ''
  try {
    await request(`/api/v1/admin/products/${product.id}/lifecycle`, {
      method: 'PATCH',
      body: { expectedRevision: product.revision, status: next },
    })
    actionMessage.value = `已${label}：${product.name}`
    await loadProducts({ ...productQuery.value })
  } catch (error) {
    actionMessage.value = error instanceof Error ? error.message : `${label}失败。`
  } finally {
    busyId.value = ''
  }
}

async function copyProduct(product: ProductListItem) {
  busyId.value = product.id
  actionMessage.value = ''
  try {
    const result = await request<{ product: { id: string } }>(`/api/v1/admin/products/${product.id}/copy`, {
      method: 'POST', body: { expectedRevision: product.revision },
    })
    const id = (result as unknown as { id?: string; product?: { id: string } }).product?.id ?? (result as unknown as { id?: string }).id
    if (!id) throw new Error('复制成功，但未返回新商品编号。')
    await navigateTo(`/admin/products/${id}`)
  } catch (error) {
    actionMessage.value = error instanceof Error ? error.message : '复制商品失败。'
  } finally {
    busyId.value = ''
  }
}
</script>

<template>
  <UDashboardPanel id="admin-main">
    <template #header>
      <UDashboardNavbar title="商品管理">
        <template #right>
          <ThemeModeSelect />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <main class="mx-auto w-full max-w-[90rem] min-w-0 px-4 py-5 sm:px-6 lg:px-8 space-y-4">
        <!-- 页面顶部标题与主要操作 -->
        <header class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pb-1">
          <div>
            <h1 class="text-xl sm:text-2xl font-bold tracking-tight text-highlighted">
              商品管理
            </h1>
            <p class="mt-0.5 text-xs sm:text-sm text-muted">
              管理商品资料、规格型号、销售价格与库存交付
            </p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <UButton
              color="neutral"
              variant="outline"
              size="md"
              icon="i-lucide-refresh-cw"
              :loading="loading"
              class="hidden sm:inline-flex"
              aria-label="刷新商品列表"
              @click="reloadProducts"
            >
              刷新
            </UButton>
            <UButton
              to="/admin/products/new"
              icon="i-lucide-plus"
              color="primary"
              size="md"
              class="font-medium shrink-0 shadow-xs min-h-10 sm:min-h-9"
            >
              新建商品
            </UButton>
          </div>
        </header>

        <!-- 状态反馈提示 -->
        <UAlert
          v-if="actionMessage"
          color="info"
          variant="soft"
          :title="actionMessage"
          icon="i-lucide-info"
          role="status"
          :close="true"
          @close="actionMessage = ''"
        />
        <UAlert
          v-if="errorMessage"
          color="error"
          variant="soft"
          :title="errorMessage"
          icon="i-lucide-alert-circle"
          role="alert"
        >
          <template #actions>
            <UButton
              size="sm"
              color="error"
              variant="outline"
              @click="reloadProducts"
            >
              重试
            </UButton>
          </template>
        </UAlert>
        <UAlert
          v-if="categoryError"
          color="error"
          variant="soft"
          :title="`分类筛选暂不可用：${categoryError}`"
          icon="i-lucide-alert-circle"
          role="alert"
        >
          <template #actions>
            <UButton
              size="sm"
              color="error"
              variant="outline"
              @click="loadCategories"
            >
              重试分类
            </UButton>
          </template>
        </UAlert>

        <!-- 快捷状态切换胶囊栏 (HiUI 风格快速标签) -->
        <nav
          aria-label="快捷状态分类"
          class="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar sm:pb-0"
        >
          <button
            v-for="tab in quickStatusTabs"
            :key="tab.value"
            type="button"
            class="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3.5 py-2 sm:min-h-9 sm:px-3 sm:py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all shrink-0 cursor-pointer"
            :class="currentStatusTab === tab.value
              ? 'bg-primary text-white shadow-xs font-semibold'
              : 'bg-elevated text-muted hover:text-highlighted border border-default hover:bg-muted/10'"
            @click="selectStatusTab(tab.value)"
          >
            <UIcon
              :name="tab.icon"
              class="size-3.5 sm:size-4"
            />
            <span>{{ tab.label }}</span>
          </button>
        </nav>

        <!-- 综合搜索与筛选控制面板 -->
        <section
          aria-label="商品筛选"
          class="rounded-xl border border-default bg-elevated p-3.5 sm:p-4 shadow-2xs space-y-3"
        >
          <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-2 lg:grid-cols-12 items-center">
            <!-- 搜索框 -->
            <div class="col-span-2 lg:col-span-6">
              <UInput
                v-model="searchInput"
                aria-label="搜索商品"
                placeholder="搜索商品名称、ID 或 SKU 编码"
                icon="i-lucide-search"
                class="w-full"
                size="md"
              >
                <template
                  v-if="searchInput"
                  #trailing
                >
                  <UButton
                    type="button"
                    icon="i-lucide-x"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    aria-label="清空搜索"
                    class="size-5 p-0 text-muted hover:text-highlighted"
                    @click="searchInput = ''; updateQuery({ search: '', page: 1 })"
                  />
                </template>
              </UInput>
            </div>

            <!-- 分类下拉 -->
            <div class="col-span-1 lg:col-span-2">
              <USelect
                :model-value="categoryId || allFilterValue"
                :items="categoryItems"
                class="w-full"
                size="md"
                aria-label="商品分类筛选"
                @update:model-value="value => updateQuery({ categoryId: String(value) === allFilterValue ? '' : String(value), page: 1 })"
              />
            </div>

            <!-- 性质下拉 -->
            <div class="col-span-1 lg:col-span-2">
              <USelect
                :model-value="productType || allFilterValue"
                :items="typeItems"
                class="w-full"
                size="md"
                aria-label="商品性质筛选"
                @update:model-value="value => updateQuery({ productType: String(value) === allFilterValue ? '' : String(value), page: 1 })"
              />
            </div>

            <!-- 排序下拉 -->
            <div class="col-span-2 sm:col-span-1 lg:col-span-2">
              <USelect
                :model-value="sortValue"
                :items="sortItems"
                class="w-full"
                size="md"
                aria-label="商品排序方式"
                @update:model-value="value => {
                  const [by, order] = String(value).split(':')
                  if (by === 'updatedAt' && order === 'desc') {
                    updateQuery({ sortBy: undefined, sortOrder: undefined, page: 1 })
                  } else {
                    updateQuery({ sortBy: by, sortOrder: order, page: 1 })
                  }
                }"
              />
            </div>
          </div>

          <!-- 活跃筛选标签与一键清除 -->
          <div
            v-if="hasActiveFilters"
            class="flex flex-wrap items-center gap-1.5 pt-2 border-t border-default/60 text-xs text-muted"
          >
            <span class="font-medium text-default flex items-center gap-1">
              <UIcon
                name="i-lucide-filter"
                class="size-3.5"
              />
              当前筛选：
            </span>
            <UBadge
              v-if="search"
              color="neutral"
              variant="subtle"
              size="sm"
              class="gap-1 font-normal cursor-pointer hover:bg-neutral-200 dark:hover:bg-neutral-800"
              :aria-label="`清除搜索筛选: ${search}`"
              @click="searchInput = ''; updateQuery({ search: '', page: 1 })"
            >
              <span>搜索: {{ search }}</span>
              <UIcon
                name="i-lucide-x"
                class="size-3"
              />
            </UBadge>
            <UBadge
              v-if="status"
              color="neutral"
              variant="subtle"
              size="sm"
              class="gap-1 font-normal cursor-pointer hover:bg-neutral-200 dark:hover:bg-neutral-800"
              :aria-label="`清除状态筛选: ${statusItems.find(s => s.value === status)?.label}`"
              @click="updateQuery({ status: '', page: 1 })"
            >
              <span>状态: {{ statusItems.find(s => s.value === status)?.label }}</span>
              <UIcon
                name="i-lucide-x"
                class="size-3"
              />
            </UBadge>
            <UBadge
              v-if="categoryId"
              color="neutral"
              variant="subtle"
              size="sm"
              class="gap-1 font-normal cursor-pointer hover:bg-neutral-200 dark:hover:bg-neutral-800"
              :aria-label="`清除分类筛选: ${categoryItems.find(c => c.value === categoryId)?.label}`"
              @click="updateQuery({ categoryId: '', page: 1 })"
            >
              <span>分类: {{ categoryItems.find(c => c.value === categoryId)?.label }}</span>
              <UIcon
                name="i-lucide-x"
                class="size-3"
              />
            </UBadge>
            <UBadge
              v-if="productType"
              color="neutral"
              variant="subtle"
              size="sm"
              class="gap-1 font-normal cursor-pointer hover:bg-neutral-200 dark:hover:bg-neutral-800"
              :aria-label="`清除性质筛选: ${typeItems.find(t => t.value === productType)?.label}`"
              @click="updateQuery({ productType: '', page: 1 })"
            >
              <span>性质: {{ typeItems.find(t => t.value === productType)?.label }}</span>
              <UIcon
                name="i-lucide-x"
                class="size-3"
              />
            </UBadge>
            <UBadge
              v-if="isNonDefaultSort"
              color="neutral"
              variant="subtle"
              size="sm"
              class="gap-1 font-normal cursor-pointer hover:bg-neutral-200 dark:hover:bg-neutral-800"
              :aria-label="`恢复默认排序: ${currentSortLabel}`"
              @click="updateQuery({ sortBy: undefined, sortOrder: undefined, page: 1 })"
            >
              <span>排序: {{ currentSortLabel }}</span>
              <UIcon
                name="i-lucide-x"
                class="size-3"
              />
            </UBadge>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              class="text-xs text-muted hover:text-highlighted font-normal ml-auto"
              @click="resetAllFilters"
            >
              清空全部筛选
            </UButton>
          </div>
        </section>

        <!-- 列表统计与分页设置栏 -->
        <div class="flex min-h-7 items-center justify-between gap-3 text-xs sm:text-sm text-muted px-0.5">
          <p
            aria-live="polite"
            class="flex items-center gap-1.5 font-medium"
          >
            <span
              v-if="loading"
              class="size-2 rounded-full bg-primary animate-pulse"
            />
            <span>{{ loading ? '正在载入商品数据…' : `共 ${total} 件商品` }}</span>
          </p>
          <label class="flex min-h-8 items-center gap-2">
            <span>每页显示</span>
            <USelect
              :model-value="String(pageSize)"
              :items="[{ label: '20 条', value: '20' }, { label: '50 条', value: '50' }, { label: '100 条', value: '100' }]"
              aria-label="每页商品数"
              class="w-24"
              size="xs"
              @update:model-value="value => updateQuery({ pageSize: Number(value), page: 1 })"
            />
          </label>
        </div>

        <!-- 空数据状态 -->
        <UCard
          v-if="!errorMessage && !loading && items.length === 0"
          class="border-default bg-elevated py-12"
        >
          <UEmpty
            icon="i-lucide-package-search"
            title="没有找到匹配的商品"
            :description="hasActiveFilters ? '当前筛选条件下暂无商品，可调整筛选或清空后重新查看。' : '还没有添加任何商品，现在就去创建第一件商品吧。'"
          >
            <template #actions>
              <div class="flex items-center gap-2.5">
                <UButton
                  v-if="hasActiveFilters"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-filter-x"
                  @click="resetAllFilters"
                >
                  清空筛选
                </UButton>
                <UButton
                  to="/admin/products/new"
                  icon="i-lucide-plus"
                  color="primary"
                >
                  新建商品
                </UButton>
              </div>
            </template>
          </UEmpty>
        </UCard>

        <!-- 桌面端表格视图 -->
        <div
          v-else
          class="hidden overflow-x-auto rounded-xl border border-default bg-elevated shadow-2xs lg:block"
        >
          <UTable
            :data="items"
            :columns="columns"
            :loading="loading"
            class="w-full"
            :ui="{
              th: 'px-4 py-3 text-xs font-semibold text-muted bg-muted/15 whitespace-nowrap border-b border-default',
              td: 'px-4 py-3 text-sm border-b border-default/50',
            }"
          >
            <!-- 封面缩略图 -->
            <template #coverImage-header>
              <span class="w-11 block text-center">封面</span>
            </template>
            <template #coverImage-cell="{ row }">
              <div class="relative size-11 overflow-hidden rounded-lg border border-default/70 bg-muted/20 shrink-0 shadow-2xs">
                <img
                  v-if="row.original.coverImage"
                  :src="row.original.coverImage.thumbnailUrl"
                  alt=""
                  class="size-full object-cover"
                  loading="lazy"
                >
                <div
                  v-else
                  class="grid size-full place-items-center text-muted"
                >
                  <UIcon
                    name="i-lucide-package"
                    class="size-5"
                  />
                </div>
              </div>
            </template>

            <!-- 商品名称与标识 -->
            <template #name-cell="{ row }">
              <div class="min-w-0 max-w-sm py-0.5">
                <div class="flex items-center gap-2 min-w-0">
                  <NuxtLink
                    :to="`/admin/products/${row.original.id}`"
                    class="truncate font-semibold text-highlighted hover:text-primary transition-colors text-sm focus-visible:outline-2 focus-visible:outline-primary"
                    :title="row.original.name"
                  >
                    {{ row.original.name }}
                  </NuxtLink>
                  <UBadge
                    :color="productTypeBadgeColor(row.original.productType)"
                    variant="subtle"
                    size="xs"
                    class="shrink-0 font-normal"
                  >
                    {{ productTypeName(row.original.productType) }}
                  </UBadge>
                </div>
                <div class="mt-1 flex items-center gap-1.5 text-xs text-dimmed font-mono">
                  <span class="truncate max-w-[13rem]">{{ row.original.id }}</span>
                  <UTooltip text="复制商品 ID">
                    <UButton
                      :icon="copiedProductId === row.original.id ? 'i-lucide-check' : 'i-lucide-copy'"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :aria-label="`复制商品 ID ${row.original.id}`"
                      class="size-5 p-0 text-muted hover:text-highlighted shrink-0"
                      @click.stop="copyProductId(row.original.id)"
                    />
                  </UTooltip>
                </div>
              </div>
            </template>

            <!-- 销售状态 -->
            <template #status-cell="{ row }">
              <UBadge
                :color="productStatusColor(row.original.status)"
                variant="subtle"
                size="sm"
                class="font-medium whitespace-nowrap gap-1 px-2.5 py-0.5"
              >
                <span
                  class="size-1.5 rounded-full"
                  :class="{
                    'bg-success': row.original.status === 'active',
                    'bg-warning': row.original.status === 'paused',
                    'bg-info': row.original.status === 'draft',
                    'bg-neutral-400': row.original.status === 'archived',
                  }"
                />
                <span>{{ statusName(row.original.status) }}</span>
              </UBadge>
            </template>

            <!-- 有效售价 -->
            <template #priceRange-cell="{ row }">
              <span
                class="tabular-nums whitespace-nowrap"
                :class="row.original.priceRange ? 'font-bold text-highlighted text-base' : 'text-xs text-muted'"
              >
                {{ priceRange(row.original) }}
              </span>
            </template>

            <!-- SKU 数量 -->
            <template #skuCount-cell="{ row }">
              <span class="text-xs text-muted tabular-nums whitespace-nowrap bg-muted/20 px-2 py-0.5 rounded">
                {{ row.original.skuCount }} 规格
              </span>
            </template>

            <!-- 所属分类 -->
            <template #categories-cell="{ row }">
              <span class="text-xs text-default truncate max-w-[8rem] block whitespace-nowrap">
                {{ categoryName(row.original) }}
              </span>
            </template>

            <!-- 时间戳 -->
            <template #timestamps-cell="{ row }">
              <div class="flex flex-col text-xs text-muted leading-tight whitespace-nowrap">
                <time
                  :datetime="row.original.updatedAt"
                  class="text-highlighted font-medium"
                >
                  {{ formatDate(row.original.updatedAt) }}
                </time>
                <time
                  :datetime="row.original.createdAt"
                  class="text-dimmed text-[11px] mt-0.5"
                >
                  建于 {{ formatDate(row.original.createdAt) }}
                </time>
              </div>
            </template>

            <!-- 操作按钮 -->
            <template #actions-header>
              <span class="w-24 block text-right">操作</span>
            </template>
            <template #actions-cell="{ row }">
              <div class="flex items-center justify-end gap-1.5 whitespace-nowrap">
                <UButton
                  :to="`/admin/products/${row.original.id}`"
                  size="xs"
                  color="primary"
                  variant="subtle"
                  class="font-medium"
                >
                  编辑
                </UButton>
                <UDropdownMenu :items="productMenuItems(row.original)">
                  <UButton
                    icon="i-lucide-ellipsis"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :loading="busyId === row.original.id"
                    :aria-label="`更多操作：${row.original.name}`"
                  />
                </UDropdownMenu>
              </div>
            </template>
          </UTable>
        </div>

        <!-- 移动端骨架加载 -->
        <section
          v-if="loading && items.length === 0"
          class="grid gap-3 lg:hidden"
          aria-label="正在加载商品"
        >
          <USkeleton
            v-for="index in 4"
            :key="index"
            class="h-36 rounded-xl"
          />
        </section>

        <!-- 移动端触屏卡片列表 -->
        <section
          v-else-if="items.length > 0"
          class="grid gap-3 lg:hidden"
          aria-label="商品列表"
        >
          <article
            v-for="product in items"
            :key="product.id"
            class="min-w-0 rounded-xl border border-default bg-elevated p-3.5 space-y-3 shadow-2xs transition-shadow hover:shadow-xs"
          >
            <!-- 头部：封面、标题与状态 -->
            <div class="flex min-w-0 gap-3">
              <div class="relative size-14 shrink-0 overflow-hidden rounded-lg border border-default/70 bg-muted/20">
                <img
                  v-if="product.coverImage"
                  :src="product.coverImage.cardUrl"
                  alt=""
                  class="size-full object-cover"
                  loading="lazy"
                >
                <div
                  v-else
                  class="grid size-full place-items-center text-muted"
                >
                  <UIcon
                    name="i-lucide-package"
                    class="size-6"
                  />
                </div>
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-start justify-between gap-2">
                  <NuxtLink
                    :to="`/admin/products/${product.id}`"
                    class="block truncate font-semibold text-highlighted hover:text-primary transition-colors text-base"
                  >
                    {{ product.name }}
                  </NuxtLink>
                  <UBadge
                    :color="productStatusColor(product.status)"
                    variant="subtle"
                    size="xs"
                    class="shrink-0 font-medium whitespace-nowrap gap-1"
                  >
                    <span
                      class="size-1.5 rounded-full"
                      :class="{
                        'bg-success': product.status === 'active',
                        'bg-warning': product.status === 'paused',
                        'bg-info': product.status === 'draft',
                        'bg-neutral-400': product.status === 'archived',
                      }"
                    />
                    <span>{{ statusName(product.status) }}</span>
                  </UBadge>
                </div>
                <div class="mt-1 flex items-center gap-1.5">
                  <UBadge
                    :color="productTypeBadgeColor(product.productType)"
                    variant="subtle"
                    size="xs"
                    class="font-normal shrink-0"
                  >
                    {{ productTypeName(product.productType) }}
                  </UBadge>
                  <span class="truncate font-mono text-xs text-dimmed">{{ product.id }}</span>
                </div>
              </div>
            </div>

            <!-- 价格与属性概要 -->
            <div class="flex items-center justify-between rounded-lg bg-muted/15 px-3 py-2 text-xs">
              <div class="flex items-baseline gap-1">
                <span class="text-xs text-muted">售价</span>
                <span class="font-bold tabular-nums text-highlighted text-base">
                  {{ priceRange(product) }}
                </span>
              </div>
              <div class="flex items-center gap-2 text-muted">
                <span>{{ categoryName(product) }}</span>
                <span>·</span>
                <span>{{ product.skuCount }} 规格</span>
              </div>
            </div>

            <!-- 底部操作与更新时间 -->
            <div class="flex items-center justify-between gap-2 border-t border-default/60 pt-2.5 text-xs text-muted">
              <time
                :datetime="product.updatedAt"
                class="text-xs text-dimmed"
              >
                {{ formatDate(product.updatedAt) }}
              </time>
              <div class="flex items-center gap-2">
                <UButton
                  :to="`/admin/products/${product.id}`"
                  size="md"
                  color="primary"
                  variant="subtle"
                  class="font-medium min-h-[44px] px-3.5 inline-flex items-center justify-center text-xs"
                >
                  编辑商品
                </UButton>
                <UDropdownMenu :items="productMenuItems(product)">
                  <UButton
                    icon="i-lucide-ellipsis"
                    color="neutral"
                    variant="outline"
                    size="md"
                    class="min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
                    :loading="busyId === product.id"
                    :aria-label="`更多操作：${product.name}`"
                  />
                </UDropdownMenu>
              </div>
            </div>
          </article>
        </section>

        <!-- 分页控制 -->
        <div
          v-if="!loading && totalPages > 1"
          class="mt-6 flex justify-center pb-4"
        >
          <UPagination
            :page="page"
            :total="total"
            :items-per-page="pageSize"
            show-controls
            @update:page="value => updateQuery({ page: value })"
          >
            <template #first>
              <UButton
                icon="i-lucide-chevrons-left"
                color="neutral"
                variant="outline"
                size="sm"
                aria-label="第一页"
              />
            </template>
            <template #prev>
              <UButton
                icon="i-lucide-chevron-left"
                color="neutral"
                variant="outline"
                size="sm"
                aria-label="上一页"
              />
            </template>
            <template #next>
              <UButton
                icon="i-lucide-chevron-right"
                color="neutral"
                variant="outline"
                size="sm"
                aria-label="下一页"
              />
            </template>
            <template #last>
              <UButton
                icon="i-lucide-chevrons-right"
                color="neutral"
                variant="outline"
                size="sm"
                aria-label="最后一页"
              />
            </template>
          </UPagination>
        </div>
      </main>
    </template>
  </UDashboardPanel>
</template>
