<script setup lang="ts">
import type { ApiSuccess, PublicProductPage } from '@aikayun/contracts'

const route = useRoute()
const router = useRouter()
const siteUrl = usePublicSiteUrl()
useUncachedPublicPage()
const { data: categoriesResponse } = await usePublicCategories()
const categories = computed(() => categoriesResponse.value?.data.categories ?? [])
const queryText = computed(() => String(Array.isArray(route.query.q) ? route.query.q[0] ?? '' : route.query.q ?? ''))
const categoryId = computed(() => String(Array.isArray(route.query.categoryId) ? route.query.categoryId[0] ?? '' : route.query.categoryId ?? ''))
const productType = computed(() => String(Array.isArray(route.query.productType) ? route.query.productType[0] ?? '' : route.query.productType ?? ''))
const sort = computed(() => {
  const value = String(Array.isArray(route.query.sort) ? route.query.sort[0] ?? '' : route.query.sort ?? '')
  return ['newest', 'price_asc', 'price_desc'].includes(value) ? value : 'default'
})
const page = computed(() => {
  const value = Number(route.query.page)
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100_000) : 1
})
const searchInput = ref(queryText.value)
const allCategories = '__all_categories__'
const allProductTypes = '__all_product_types__'
const categorySelectValue = computed(() => categoryId.value || allCategories)
const productTypeSelectValue = computed(() => productType.value || allProductTypes)

function searchQuery() {
  return {
    q: queryText.value.trim() || undefined,
    categoryId: categoryId.value || undefined,
    productType: productType.value || undefined,
    sort: sort.value,
    page: page.value,
    pageSize: 24,
  }
}

const initial = await useAsyncData(
  'public-search-initial',
  async (_nuxtApp, { signal }) => {
    try {
      return (await $fetch<ApiSuccess<PublicProductPage>>('/api/v1/public/search', {
        query: searchQuery(),
        signal,
      })).data
    }
    catch (cause) {
      return throwSafePublicApiError(cause, signal)
    }
  },
  { default: () => null, deep: false },
)
const results = shallowRef<PublicProductPage | null>(initial.data.value ?? null)
const loading = ref(false)
const failure = ref(Boolean(initial.error.value))
let latestRequest = 0
let activeController: AbortController | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined

async function loadResults() {
  const requestId = ++latestRequest
  activeController?.abort()
  const controller = new AbortController()
  activeController = controller
  loading.value = true
  failure.value = false
  try {
    const response = await $fetch<ApiSuccess<PublicProductPage>>('/api/v1/public/search', {
      query: searchQuery(),
      signal: controller.signal,
    })
    if (requestId !== latestRequest) return
    results.value = response.data
  }
  catch (error) {
    if (requestId !== latestRequest || controller.signal.aborted) return
    failure.value = true
    void error
  }
  finally {
    if (requestId === latestRequest) {
      loading.value = false
      activeController = undefined
    }
  }
}

watch(() => route.fullPath, () => {
  if (searchInput.value !== queryText.value) searchInput.value = queryText.value
  if (import.meta.client) void loadResults()
}, { flush: 'post' })

function onSearchInput(value: string): void {
  searchInput.value = value
  if (!import.meta.client) return
  if (searchTimer) clearTimeout(searchTimer)
  if (value.trim() !== queryText.value.trim()) {
    latestRequest += 1
    activeController?.abort()
    activeController = undefined
    loading.value = true
    failure.value = false
    searchTimer = setTimeout(() => updateQuery({ q: value.trim() || undefined }, true), 260)
    return
  }
  searchInput.value = queryText.value
  if (!results.value && !loading.value) void loadResults()
}

function updateQuery(patch: Record<string, string | number | undefined>, replace = false) {
  if (searchTimer) clearTimeout(searchTimer)
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries({
    ...route.query,
    q: searchInput.value.trim() || undefined,
    ...patch,
    page: patch.page,
  })) {
    if (typeof value === 'string' && value.trim()) next[key] = value.trim()
    else if (typeof value === 'number' && Number.isInteger(value) && value > 1) next[key] = String(value)
  }
  const nextPath = router.resolve({ path: route.path, query: next }).fullPath
  if (nextPath === route.fullPath) return
  latestRequest += 1
  activeController?.abort()
  activeController = undefined
  loading.value = true
  failure.value = false
  if (replace) void router.replace({ query: next })
  else void router.push({ query: next })
}

const categoryOptions = computed(() => [
  { label: '全部分类', value: allCategories },
  ...categories.value.map(category => ({ label: `${'　'.repeat(category.level)}${category.name}`, value: category.id })),
])
const typeOptions = [
  { label: '全部性质', value: allProductTypes },
  { label: '实物商品', value: 'physical' },
  { label: '数字商品', value: 'digital' },
  { label: '服务商品', value: 'service' },
]
const sortOptions = [
  { label: '默认排序', value: 'default' },
  { label: '最新商品', value: 'newest' },
  { label: '价格从低到高', value: 'price_asc' },
  { label: '价格从高到低', value: 'price_desc' },
]
const siteBrand = useStoreBrand()
setPublicPageFailureStatus(initial.error.value)
useSeoMeta({
  title: '搜索商品',
  description: `搜索并筛选 ${siteBrand.value.storeName} 当前公开的商品。`,
  robots: 'noindex, follow',
  ogTitle: `${siteBrand.value.storeName} · 搜索商品`,
  ogUrl: siteUrl('/search'),
})
useHead({ link: [{ rel: 'canonical', href: siteUrl('/search') }] })

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
  activeController?.abort()
})
</script>

<template>
  <main id="main-content">
    <UContainer class="py-6 sm:py-9">
      <div class="mb-5">
        <p class="text-sm font-medium text-muted">
          商城商品
        </p>
        <h1 class="mt-1 text-2xl font-semibold text-highlighted sm:text-3xl">
          搜索商品
        </h1>
      </div>

      <div class="grid gap-3 rounded-xl border border-default bg-elevated p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-[minmax(16rem,2fr)_repeat(3,minmax(9rem,1fr))]">
        <div class="relative sm:col-span-2 lg:col-span-1">
          <UIcon
            name="i-lucide-search"
            class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-dimmed"
          />
          <input
            :value="searchInput"
            type="search"
            placeholder="搜索商品名称或描述"
            aria-label="搜索商品名称或描述"
            autocomplete="off"
            class="h-11 w-full rounded-lg border border-default bg-default py-2 pl-10 pr-3 text-base text-highlighted transition-colors placeholder:text-dimmed focus-visible:outline-3 focus-visible:outline-primary/25 focus-visible:ring-3 focus-visible:ring-primary motion-reduce:transition-none md:text-sm"
            @input="onSearchInput(($event.target as HTMLInputElement).value)"
          >
        </div>
        <USelect
          :model-value="categorySelectValue"
          :items="categoryOptions"
          value-key="value"
          label-key="label"
          aria-label="按分类筛选"
          @update:model-value="value => updateQuery({ categoryId: String(value) === allCategories ? undefined : String(value), page: undefined })"
        />
        <USelect
          :model-value="productTypeSelectValue"
          :items="typeOptions"
          value-key="value"
          label-key="label"
          aria-label="按商品性质筛选"
          @update:model-value="value => updateQuery({ productType: String(value) === allProductTypes ? undefined : String(value), page: undefined })"
        />
        <USelect
          :model-value="sort"
          :items="sortOptions"
          value-key="value"
          label-key="label"
          aria-label="商品排序"
          @update:model-value="value => updateQuery({ sort: String(value), page: undefined })"
        />
      </div>

      <p
        v-if="results"
        class="my-4 text-sm text-muted"
        aria-live="polite"
      >
        找到 {{ results.total }} 件商品
      </p>
      <div
        v-if="loading"
        class="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5"
        aria-label="正在搜索商品"
      >
        <div
          v-for="item in 8"
          :key="item"
          class="overflow-hidden rounded-xl border border-default"
        >
          <div class="aspect-[4/3] animate-pulse bg-muted motion-reduce:animate-none" />
          <div class="space-y-2 p-4">
            <div class="h-4 w-3/4 animate-pulse rounded bg-muted motion-reduce:animate-none" /><div class="h-4 w-1/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        </div>
      </div>
      <UAlert
        v-else-if="failure"
        color="error"
        variant="subtle"
        title="搜索暂时失败"
        description="请检查网络后重试。"
        :actions="[{ label: '重试', onClick: loadResults }]"
        class="mt-4"
      />
      <template v-else-if="results?.items.length">
        <StorefrontProductGrid :products="results.items" />
        <StorefrontPagination
          v-if="results.totalPages > 1"
          :page="results.page"
          :total-pages="results.totalPages"
          :query="route.query"
          class="mt-7"
        />
      </template>
      <UEmpty
        v-else-if="results"
        icon="i-lucide-search-x"
        title="没有找到商品"
        description="试试更短的关键词，或调整分类和商品性质筛选。"
        variant="naked"
        size="lg"
        class="min-h-64"
      >
        <template #actions>
          <UButton
            color="neutral"
            variant="outline"
            @click="updateQuery({ q: undefined, categoryId: undefined, productType: undefined, page: undefined })"
          >
            清除筛选
          </UButton>
        </template>
      </UEmpty>
    </UContainer>
  </main>
</template>
