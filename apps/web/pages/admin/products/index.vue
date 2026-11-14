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
  { label: '草稿', value: 'draft' },
  { label: '销售中', value: 'active' },
  { label: '已暂停', value: 'paused' },
  { label: '已归档', value: 'archived' },
]
const typeItems = [
  { label: '全部性质', value: allFilterValue },
  { label: '实物商品', value: 'physical' },
  { label: '数字商品', value: 'digital' },
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
  if (!product.priceRange) return '无有效价格'
  if (product.priceRange.min === product.priceRange.max) return `¥${product.priceRange.min}`
  return `¥${product.priceRange.min} – ¥${product.priceRange.max}`
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function allowedTransition(current: ProductListItem['status']) {
  if (current === 'draft') return [{ label: '发布', status: 'active' as const }, { label: '归档', status: 'archived' as const }]
  if (current === 'active') return [{ label: '暂停销售', status: 'paused' as const }, { label: '归档', status: 'archived' as const }]
  if (current === 'paused') return [{ label: '重新上架', status: 'active' as const }, { label: '归档', status: 'archived' as const }]
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
      icon: 'i-lucide-copy-check',
    })
    setTimeout(() => {
      if (copiedProductId.value === id) copiedProductId.value = ''
    }, 2000)
  } catch {
    toast.add({
      title: '复制失败，请手动复制',
      color: 'error',
    })
  }
}

async function changeLifecycle(product: ProductListItem, next: ProductListItem['status']) {
  const label = next === 'archived' ? '归档' : next === 'draft' ? '恢复为草稿' : next === 'active' ? '发布或重新上架' : '暂停销售'
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
      <main class="mx-auto w-full max-w-[90rem] min-w-0 px-4 py-5 sm:px-6 lg:px-8">
        <header class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 class="text-xl sm:text-2xl font-bold tracking-tight text-highlighted">
              商品管理
            </h1>
            <p class="mt-0.5 text-xs sm:text-sm text-muted">
              商品资料、规格、价格与销售生命周期
            </p>
          </div>
          <UButton
            to="/admin/products/new"
            icon="i-lucide-plus"
            color="primary"
            size="md"
            class="font-medium shrink-0 shadow-xs min-h-10 sm:min-h-9"
          >
            新建商品
          </UButton>
        </header>

        <UAlert
          v-if="actionMessage"
          class="mb-4"
          color="info"
          variant="soft"
          :title="actionMessage"
          role="status"
        />
        <UAlert
          v-if="errorMessage"
          class="mb-4"
          color="error"
          variant="soft"
          :title="errorMessage"
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
          class="mb-4"
          color="error"
          variant="soft"
          :title="`分类筛选暂不可用：${categoryError}`"
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

        <section
          aria-label="商品筛选"
          class="mb-4 rounded-xl border border-default bg-elevated p-3 sm:p-4 shadow-2xs space-y-3"
        >
          <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-2 lg:grid-cols-12">
            <div class="col-span-2 lg:col-span-4">
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
            <div class="col-span-1 lg:col-span-2">
              <USelect
                :model-value="status || allFilterValue"
                :items="statusItems"
                class="w-full"
                size="md"
                aria-label="商品状态筛选"
                @update:model-value="value => updateQuery({ status: String(value) === allFilterValue ? '' : String(value), page: 1 })"
              />
            </div>
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
            <div class="col-span-1 lg:col-span-2">
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

          <div
            v-if="hasActiveFilters"
            class="flex flex-wrap items-center gap-2 pt-2 border-t border-default/50 text-xs text-muted"
          >
            <span class="font-medium text-default">活跃筛选：</span>
            <UButton
              v-if="search"
              color="neutral"
              variant="subtle"
              size="xs"
              trailing-icon="i-lucide-x"
              :aria-label="`清除搜索筛选: ${search}`"
              class="font-normal"
              @click="searchInput = ''; updateQuery({ search: '', page: 1 })"
            >
              搜索: {{ search }}
            </UButton>
            <UButton
              v-if="status"
              color="neutral"
              variant="subtle"
              size="xs"
              trailing-icon="i-lucide-x"
              :aria-label="`清除状态筛选: ${statusItems.find(s => s.value === status)?.label}`"
              class="font-normal"
              @click="updateQuery({ status: '', page: 1 })"
            >
              状态: {{ statusItems.find(s => s.value === status)?.label }}
            </UButton>
            <UButton
              v-if="categoryId"
              color="neutral"
              variant="subtle"
              size="xs"
              trailing-icon="i-lucide-x"
              :aria-label="`清除分类筛选: ${categoryItems.find(c => c.value === categoryId)?.label}`"
              class="font-normal"
              @click="updateQuery({ categoryId: '', page: 1 })"
            >
              分类: {{ categoryItems.find(c => c.value === categoryId)?.label }}
            </UButton>
            <UButton
              v-if="productType"
              color="neutral"
              variant="subtle"
              size="xs"
              trailing-icon="i-lucide-x"
              :aria-label="`清除性质筛选: ${typeItems.find(t => t.value === productType)?.label}`"
              class="font-normal"
              @click="updateQuery({ productType: '', page: 1 })"
            >
              性质: {{ typeItems.find(t => t.value === productType)?.label }}
            </UButton>
            <UButton
              v-if="isNonDefaultSort"
              color="neutral"
              variant="subtle"
              size="xs"
              trailing-icon="i-lucide-x"
              :aria-label="`恢复默认排序: ${currentSortLabel}`"
              class="font-normal"
              @click="updateQuery({ sortBy: undefined, sortOrder: undefined, page: 1 })"
            >
              排序: {{ currentSortLabel }}
            </UButton>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              class="text-xs text-muted hover:text-highlighted font-normal"
              @click="resetAllFilters"
            >
              清空全部筛选
            </UButton>
          </div>
        </section>

        <div class="mb-3 flex min-h-7 items-center justify-between gap-3 text-xs sm:text-sm text-muted">
          <p aria-live="polite">
            {{ loading ? '正在加载商品…' : `共 ${total} 件商品` }}
          </p>
          <label class="flex min-h-10 items-center gap-2">
            <span>每页</span>
            <USelect
              :model-value="String(pageSize)"
              :items="[{ label: '20', value: '20' }, { label: '50', value: '50' }, { label: '100', value: '100' }]"
              aria-label="每页商品数"
              class="w-20"
              size="xs"
              @update:model-value="value => updateQuery({ pageSize: Number(value), page: 1 })"
            />
          </label>
        </div>

        <UCard
          v-if="!errorMessage && !loading && items.length === 0"
          class="border-default bg-elevated"
        >
          <UEmpty
            icon="i-lucide-package-search"
            title="没有找到商品"
            :description="search || status || productType || categoryId ? '调整筛选条件，或创建一个新商品。' : '商品创建后会显示在这里。'"
          >
            <template #actions>
              <UButton
                to="/admin/products/new"
                icon="i-lucide-plus"
              >
                新建商品
              </UButton>
            </template>
          </UEmpty>
        </UCard>

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
              th: 'px-3 py-2.5 text-xs font-semibold text-muted bg-muted/20 whitespace-nowrap',
              td: 'px-3 py-2.5 text-sm',
            }"
          >
            <template #coverImage-header>
              <span class="w-10 block text-center">封面</span>
            </template>
            <template #coverImage-cell="{ row }">
              <div class="relative size-10 overflow-hidden rounded-lg border border-default/60 bg-muted/20 shrink-0">
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

            <template #name-cell="{ row }">
              <div class="min-w-0 max-w-xs">
                <div class="flex items-center gap-1.5 min-w-0">
                  <NuxtLink
                    :to="`/admin/products/${row.original.id}`"
                    class="truncate font-semibold text-highlighted hover:text-primary transition-colors focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    {{ row.original.name }}
                  </NuxtLink>
                  <UBadge
                    color="neutral"
                    variant="subtle"
                    size="xs"
                    class="shrink-0 font-normal"
                  >
                    {{ productTypeName(row.original.productType) }}
                  </UBadge>
                </div>
                <div class="mt-0.5 flex items-center gap-1.5 text-xs text-dimmed font-mono">
                  <span class="truncate">{{ row.original.id }}</span>
                  <UButton
                    :icon="copiedProductId === row.original.id ? 'i-lucide-check' : 'i-lucide-copy'"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :aria-label="`复制商品 ID ${row.original.id}`"
                    class="size-5 p-0 text-muted hover:text-highlighted shrink-0"
                    @click.stop="copyProductId(row.original.id)"
                  />
                </div>
              </div>
            </template>

            <template #status-cell="{ row }">
              <UBadge
                :color="productStatusColor(row.original.status)"
                variant="subtle"
                size="sm"
                class="font-medium whitespace-nowrap"
              >
                {{ statusName(row.original.status) }}
              </UBadge>
            </template>

            <template #priceRange-cell="{ row }">
              <span
                class="tabular-nums whitespace-nowrap"
                :class="row.original.priceRange ? 'font-semibold text-highlighted' : 'text-xs text-muted'"
              >
                {{ priceRange(row.original) }}
              </span>
            </template>

            <template #skuCount-cell="{ row }">
              <span class="text-xs text-muted tabular-nums whitespace-nowrap">
                {{ row.original.skuCount }} 个
              </span>
            </template>

            <template #categories-cell="{ row }">
              <span class="text-xs text-default truncate max-w-[7rem] block whitespace-nowrap">
                {{ categoryName(row.original) }}
              </span>
            </template>

            <template #timestamps-cell="{ row }">
              <div class="flex flex-col text-xs text-muted leading-tight whitespace-nowrap">
                <time
                  :datetime="row.original.updatedAt"
                  class="text-highlighted font-medium"
                >{{ formatDate(row.original.updatedAt) }}</time>
                <time
                  :datetime="row.original.createdAt"
                  class="text-dimmed text-[11px] mt-0.5"
                >创建 {{ formatDate(row.original.createdAt) }}</time>
              </div>
            </template>

            <template #actions-header>
              <span class="w-20 block text-right">操作</span>
            </template>
            <template #actions-cell="{ row }">
              <div class="flex items-center justify-end gap-1 whitespace-nowrap">
                <UButton
                  :to="`/admin/products/${row.original.id}`"
                  size="xs"
                  color="primary"
                  variant="outline"
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

        <section
          v-if="loading && items.length === 0"
          class="grid gap-3 lg:hidden"
          aria-label="正在加载商品"
        >
          <USkeleton
            v-for="index in 3"
            :key="index"
            class="h-28 rounded-xl"
          />
        </section>

        <section
          v-else-if="items.length > 0"
          class="grid gap-3 lg:hidden"
          aria-label="商品列表"
        >
          <article
            v-for="product in items"
            :key="product.id"
            class="min-w-0 rounded-xl border border-default bg-elevated p-3.5 space-y-3 shadow-2xs"
          >
            <div class="flex min-w-0 gap-3">
              <div class="relative size-14 shrink-0 overflow-hidden rounded-lg border border-default/60 bg-muted/20">
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
                    class="block truncate font-semibold text-highlighted hover:text-primary transition-colors"
                  >
                    {{ product.name }}
                  </NuxtLink>
                  <UBadge
                    :color="productStatusColor(product.status)"
                    variant="subtle"
                    size="xs"
                    class="shrink-0 font-medium whitespace-nowrap"
                  >
                    {{ statusName(product.status) }}
                  </UBadge>
                </div>
                <p class="mt-0.5 truncate font-mono text-xs text-dimmed">
                  {{ product.id }}
                </p>
                <div class="mt-1.5 flex items-center justify-between text-xs">
                  <span class="font-semibold tabular-nums text-highlighted text-sm">
                    {{ priceRange(product) }}
                  </span>
                  <span class="text-muted">
                    {{ categoryName(product) }} · {{ product.skuCount }} SKU
                  </span>
                </div>
              </div>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-2 border-t border-default/60 pt-2.5 text-xs text-muted">
              <div class="grid gap-0.5">
                <time :datetime="product.createdAt">创建 {{ formatDate(product.createdAt) }}</time>
                <time :datetime="product.updatedAt">更新 {{ formatDate(product.updatedAt) }}</time>
              </div>
              <div class="flex items-center gap-2">
                <UButton
                  :to="`/admin/products/${product.id}`"
                  size="sm"
                  color="neutral"
                  variant="outline"
                >
                  编辑
                </UButton>
                <UDropdownMenu :items="productMenuItems(product)">
                  <UButton
                    icon="i-lucide-ellipsis"
                    color="neutral"
                    variant="outline"
                    size="sm"
                    :loading="busyId === product.id"
                    :aria-label="`更多操作：${product.name}`"
                  />
                </UDropdownMenu>
              </div>
            </div>
          </article>
        </section>

        <div
          v-if="!loading && totalPages > 1"
          class="mt-5 flex justify-center"
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
