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
const productType = computed(() => {
  const value = String(Array.isArray(route.query.productType) ? route.query.productType[0] ?? '' : route.query.productType ?? '')
  return ['physical', 'digital', 'service'].includes(value) ? value : ''
})
const sort = computed(() => {
  const value = String(Array.isArray(route.query.sort) ? route.query.sort[0] ?? '' : route.query.sort ?? '')
  return ['newest', 'price_asc', 'price_desc'].includes(value) ? value : 'default'
})
const page = computed(() => {
  const value = Number(route.query.page)
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100_000) : 1
})
const allCategories = '__all_categories__'
const allProductTypes = '__all_product_types__'
const categorySelectValue = computed(() => categoryId.value || allCategories)
const productTypeSelectValue = computed(() => productType.value || allProductTypes)

const requestQuery = computed(() => ({
  q: queryText.value.trim() || undefined,
  categoryId: categoryId.value || undefined,
  productType: productType.value || undefined,
  sort: sort.value,
  page: page.value,
  pageSize: 24,
}))
const requestIdentity = computed(() => JSON.stringify(requestQuery.value))
const searchInput = ref(queryText.value)
const { data: fetchedResult, error, status, refresh } = await useAsyncData(
  computed(() => `public-search-${requestIdentity.value}`),
  async (_nuxtApp, { signal }) => {
    const identity = requestIdentity.value
    try {
      const response = await $fetch<ApiSuccess<PublicProductPage>>('/api/v1/public/search', {
        query: requestQuery.value,
        signal,
      })
      return { identity, response: response.data }
    }
    catch (cause) {
      return throwSafePublicApiError(cause, signal)
    }
  },
  { default: () => null, deep: false, dedupe: 'cancel', getCachedData: (key, nuxtApp) => nuxtApp.isHydrating ? nuxtApp.payload.data[key] : undefined },
)
const results = computed(() => fetchedResult.value?.identity === requestIdentity.value && searchInput.value.trim() === queryText.value.trim()
  ? fetchedResult.value.response
  : null)
const inputPending = computed(() => searchInput.value.trim() !== queryText.value.trim())
const loading = computed(() => status.value === 'pending' || inputPending.value)
const failure = computed(() => status.value === 'error' && !inputPending.value)
let searchTimer: ReturnType<typeof setTimeout> | undefined

watch(queryText, () => {
  if (searchInput.value !== queryText.value) searchInput.value = queryText.value
}, { flush: 'post' })

function onSearchInput(value: string): void {
  searchInput.value = value
  if (!import.meta.client) return
  if (searchTimer) clearTimeout(searchTimer)
  if (value.trim() !== queryText.value.trim()) {
    searchTimer = setTimeout(() => updateQuery({ q: value.trim() || undefined }, true), 260)
    return
  }
  searchInput.value = queryText.value
  if (status.value === 'error') void refresh()
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
setPublicPageFailureStatus(error.value)
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
})
</script>

<template>
  <main id="main-content" class="flex-1 pb-16">
    <UContainer class="pt-6 sm:pt-8 md:pt-10">
      <div class="mb-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-default/50 pb-3 sm:mb-6">
        <div>
          <h1 class="text-xl font-semibold tracking-tight text-highlighted sm:text-2xl">
            搜索商品
          </h1>
        </div>
        <p
          v-if="results"
          class="text-xs text-dimmed sm:text-sm"
          aria-live="polite"
        >
          找到 <span class="font-medium text-muted tabular-nums">{{ results.total }}</span> 件商品
        </p>
      </div>

      <!-- 搜索与筛选控制栏：Apple 风格极简一体化控制栏 -->
      <div class="mb-6 rounded-2xl border border-default/70 bg-elevated/70 p-2.5 shadow-xs backdrop-blur-xs sm:p-3.5">
        <div class="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-[minmax(16rem,2fr)_repeat(3,minmax(8.5rem,1fr))]">
          <div class="relative sm:col-span-2 lg:col-span-1">
            <UIcon
              name="i-lucide-search"
              class="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-dimmed"
            />
            <input
              :value="searchInput"
              type="search"
              placeholder="搜索商品名称或描述"
              aria-label="搜索商品名称或描述"
              autocomplete="off"
              class="h-10 w-full rounded-xl border border-default/80 bg-default/60 py-2 pl-10 pr-3 text-sm text-highlighted transition-colors placeholder:text-dimmed focus:bg-default focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none"
              @input="onSearchInput(($event.target as HTMLInputElement).value)"
            >
          </div>
          <USelect
            :model-value="categorySelectValue"
            :items="categoryOptions"
            value-key="value"
            label-key="label"
            aria-label="按分类筛选"
            class="w-full"
            :ui="{ base: 'rounded-xl h-10' }"
            @update:model-value="value => updateQuery({ categoryId: String(value) === allCategories ? undefined : String(value), page: undefined })"
          />
          <USelect
            :model-value="productTypeSelectValue"
            :items="typeOptions"
            value-key="value"
            label-key="label"
            aria-label="按商品性质筛选"
            class="w-full"
            :ui="{ base: 'rounded-xl h-10' }"
            @update:model-value="value => updateQuery({ productType: String(value) === allProductTypes ? undefined : String(value), page: undefined })"
          />
          <USelect
            :model-value="sort"
            :items="sortOptions"
            value-key="value"
            label-key="label"
            aria-label="商品排序"
            class="w-full"
            :ui="{ base: 'rounded-xl h-10' }"
            @update:model-value="value => updateQuery({ sort: String(value), page: undefined })"
          />
        </div>
      </div>

      <div
        v-if="loading"
        class="grid grid-cols-2 gap-3.5 sm:gap-4.5 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-5"
        aria-label="正在搜索商品"
      >
        <div
          v-for="item in 10"
          :key="item"
          class="overflow-hidden rounded-2xl border border-default/60 bg-elevated"
        >
          <div class="aspect-square animate-pulse bg-muted/70 motion-reduce:animate-none" />
          <div class="space-y-2.5 p-3 sm:p-4">
            <div class="h-4 w-3/4 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div class="h-3 w-1/2 animate-pulse rounded bg-muted/60 motion-reduce:animate-none" />
            <div class="pt-2">
              <div class="h-5 w-1/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            </div>
          </div>
        </div>
      </div>
      <UAlert
        v-else-if="failure"
        color="error"
        variant="subtle"
        title="搜索暂时失败"
        description="请检查网络后重试。"
        :actions="[{ label: '重试', onClick: () => refresh() }]"
        class="mb-6 rounded-xl"
      />
      <template v-else-if="results?.items.length">
        <StorefrontProductGrid :products="results.items" />
        <StorefrontPagination
          v-if="results.totalPages > 1"
          :page="results.page"
          :total-pages="results.totalPages"
          :query="route.query"
          class="mt-8 sm:mt-10"
        />
      </template>
      <UEmpty
        v-else-if="results"
        icon="i-lucide-search-x"
        title="没有找到商品"
        description="试试更短的关键词，或调整分类和商品性质筛选。"
        variant="naked"
        size="lg"
        class="min-h-72"
      >
        <template #actions>
          <UButton
            color="neutral"
            variant="outline"
            class="rounded-xl"
            @click="updateQuery({ q: undefined, categoryId: undefined, productType: undefined, page: undefined })"
          >
            清除筛选
          </UButton>
        </template>
      </UEmpty>
    </UContainer>
  </main>
</template>
