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
  { accessorKey: 'productType', header: '性质' },
  { accessorKey: 'status', header: '状态' },
  { accessorKey: 'skuCount', header: 'SKU' },
  { id: 'priceRange', header: '有效售价' },
  { id: 'categories', header: '主分类' },
  { id: 'timestamps', header: '创建 / 更新' },
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
        <header class="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p class="text-sm font-medium text-primary">
              目录
            </p>
            <h1 class="mt-1 text-2xl font-semibold tracking-tight text-highlighted">
              商品管理
            </h1>
            <p class="mt-1 text-sm text-muted">
              管理商品资料、规格、价格与生命周期。
            </p>
          </div>
          <UButton
            to="/admin/products/new"
            icon="i-lucide-plus"
            size="lg"
            class="min-h-11 shrink-0"
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
          class="mb-4 grid gap-3 rounded-xl border border-default bg-elevated p-3 sm:grid-cols-2 lg:grid-cols-6 lg:p-4"
        >
          <UFormField
            label="搜索名称、商品 ID 或 SKU 编码"
            class="sm:col-span-2"
          >
            <UInput
              v-model="searchInput"
              aria-label="搜索商品"
              placeholder="输入名称、商品 ID 或 SKU 编码"
              icon="i-lucide-search"
              class="w-full"
              size="lg"
            />
          </UFormField>
          <UFormField label="商品状态">
            <USelect
              :model-value="status || allFilterValue"
              :items="statusItems"
              class="w-full"
              size="lg"
              aria-label="商品状态筛选"
              @update:model-value="value => updateQuery({ status: String(value) === allFilterValue ? '' : String(value), page: 1 })"
            />
          </UFormField>
          <UFormField label="商品性质">
            <USelect
              :model-value="productType || allFilterValue"
              :items="typeItems"
              class="w-full"
              size="lg"
              aria-label="商品性质筛选"
              @update:model-value="value => updateQuery({ productType: String(value) === allFilterValue ? '' : String(value), page: 1 })"
            />
          </UFormField>
          <UFormField label="商品分类">
            <USelect
              :model-value="categoryId || allFilterValue"
              :items="categoryItems"
              class="w-full"
              size="lg"
              aria-label="商品分类筛选"
              @update:model-value="value => updateQuery({ categoryId: String(value) === allFilterValue ? '' : String(value), page: 1 })"
            />
          </UFormField>
          <UFormField label="排序方式">
            <USelect
              :model-value="sortValue"
              :items="sortItems"
              class="w-full"
              size="lg"
              aria-label="商品排序方式"
              @update:model-value="value => { const [sortBy, sortOrder] = String(value).split(':'); updateQuery({ sortBy, sortOrder, page: 1 }) }"
            />
          </UFormField>
        </section>

        <div class="mb-3 flex min-h-7 items-center justify-between gap-3 text-sm text-muted">
          <p aria-live="polite">
            {{ loading ? '正在加载商品…' : `共 ${total} 件商品` }}
          </p>
          <label class="flex min-h-10 items-center gap-2">
            <span>每页</span>
            <USelect
              :model-value="String(pageSize)"
              :items="[{ label: '20', value: '20' }, { label: '50', value: '50' }, { label: '100', value: '100' }]"
              aria-label="每页商品数"
              class="w-24"
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
          class="hidden overflow-hidden rounded-xl border border-default bg-elevated lg:block"
        >
          <UTable
            :data="items"
            :columns="columns"
            :loading="loading"
            class="w-full"
          >
            <template #coverImage-cell="{ row }">
              <img
                v-if="row.original.coverImage"
                :src="row.original.coverImage.thumbnailUrl"
                alt=""
                class="size-12 rounded-md object-cover"
                loading="lazy"
              >
              <span
                v-else
                class="grid size-12 place-items-center rounded-md bg-muted text-muted"
              ><UIcon
                name="i-lucide-image"
                aria-hidden="true"
              /></span>
            </template>
            <template #name-cell="{ row }">
              <NuxtLink
                :to="`/admin/products/${row.original.id}`"
                class="block max-w-64 truncate font-medium text-highlighted hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
              >
                {{ row.original.name }}
              </NuxtLink>
              <span class="mt-1 block font-mono text-xs text-dimmed">{{ row.original.id }}</span>
            </template>
            <template #productType-cell="{ row }">
              {{ productTypeName(row.original.productType) }}
            </template>
            <template #status-cell="{ row }">
              <UBadge
                :color="row.original.status === 'active' ? 'success' : row.original.status === 'archived' ? 'neutral' : row.original.status === 'paused' ? 'warning' : 'info'"
                variant="subtle"
              >
                {{ statusName(row.original.status) }}
              </UBadge>
            </template>
            <template #priceRange-cell="{ row }">
              <span :class="row.original.priceRange ? 'font-medium text-highlighted' : 'text-muted'">{{ priceRange(row.original) }}</span>
            </template>
            <template #categories-cell="{ row }">
              {{ categoryName(row.original) }}
            </template>
            <template #timestamps-cell="{ row }">
              <div class="grid gap-1 text-xs text-muted">
                <time :datetime="row.original.createdAt">创建 {{ formatDate(row.original.createdAt) }}</time>
                <time :datetime="row.original.updatedAt">更新 {{ formatDate(row.original.updatedAt) }}</time>
              </div>
            </template>
            <template #actions-cell="{ row }">
              <div class="flex items-center gap-1">
                <UButton
                  :to="`/admin/products/${row.original.id}`"
                  size="sm"
                  color="primary"
                  variant="ghost"
                >
                  编辑
                </UButton>
                <UDropdownMenu :items="[[{ label: '复制商品', icon: 'i-lucide-copy', onSelect: () => copyProduct(row.original) }], allowedTransition(row.original.status).map(action => ({ label: action.label, icon: 'i-lucide-repeat-2', onSelect: () => changeLifecycle(row.original, action.status) }))]">
                  <UButton
                    icon="i-lucide-ellipsis"
                    color="neutral"
                    variant="ghost"
                    size="sm"
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
            class="h-36 rounded-xl"
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
            class="min-w-0 rounded-xl border border-default bg-elevated p-3"
          >
            <div class="flex min-w-0 gap-3">
              <img
                v-if="product.coverImage"
                :src="product.coverImage.cardUrl"
                alt=""
                class="size-16 shrink-0 rounded-lg object-cover"
                loading="lazy"
              >
              <span
                v-else
                class="grid size-16 shrink-0 place-items-center rounded-lg bg-muted text-muted"
              ><UIcon
                name="i-lucide-image"
                aria-hidden="true"
              /></span>
              <div class="min-w-0 flex-1">
                <NuxtLink
                  :to="`/admin/products/${product.id}`"
                  class="block truncate font-semibold text-highlighted"
                >
                  {{ product.name }}
                </NuxtLink>
                <p class="mt-1 truncate font-mono text-xs text-dimmed">
                  {{ product.id }}
                </p>
                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <UBadge
                    :color="product.status === 'active' ? 'success' : product.status === 'archived' ? 'neutral' : product.status === 'paused' ? 'warning' : 'info'"
                    variant="subtle"
                  >
                    {{ statusName(product.status) }}
                  </UBadge>
                  <span class="text-xs text-muted">{{ productTypeName(product.productType) }}</span>
                  <span class="text-xs text-muted">{{ product.skuCount }} 个 SKU</span>
                </div>
              </div>
            </div>
            <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-default pt-3 text-sm">
              <div>
                <dt class="text-xs text-dimmed">
                  有效售价
                </dt><dd class="mt-0.5 font-medium text-highlighted">
                  {{ priceRange(product) }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-dimmed">
                  主分类
                </dt><dd class="mt-0.5 truncate text-highlighted">
                  {{ categoryName(product) }}
                </dd>
              </div>
              <div class="col-span-2">
                <dt class="text-xs text-dimmed">
                  创建 / 更新时间
                </dt>
                <dd class="mt-0.5 grid gap-1 text-muted">
                  <time :datetime="product.createdAt">创建 {{ formatDate(product.createdAt) }}</time>
                  <time :datetime="product.updatedAt">更新 {{ formatDate(product.updatedAt) }}</time>
                </dd>
              </div>
            </dl>
            <div class="mt-3 flex gap-2 border-t border-default pt-3">
              <UButton
                :to="`/admin/products/${product.id}`"
                block
                size="lg"
              >
                编辑
              </UButton>
              <UDropdownMenu :items="[[{ label: '复制商品', icon: 'i-lucide-copy', onSelect: () => copyProduct(product) }], allowedTransition(product.status).map(action => ({ label: action.label, onSelect: () => changeLifecycle(product, action.status) }))]">
                <UButton
                  icon="i-lucide-ellipsis"
                  color="neutral"
                  variant="outline"
                  size="lg"
                  :aria-label="`更多操作：${product.name}`"
                />
              </UDropdownMenu>
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
