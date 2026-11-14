<script setup lang="ts">
import type { ApiSuccess, PublicProductPage, PublicStorefrontFeaturedProducts } from '@aikayun/contracts'

const route = useRoute()
const siteUrl = usePublicSiteUrl()
useUncachedPublicPage()
const page = computed(() => {
  const value = Number(route.query.page)
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100_000) : 1
})
const asyncDataKey = computed(() => `public-storefront-home-${page.value}`)
const { data: fetchedData, error, status, refresh } = await useAsyncData(
  asyncDataKey,
  async (_nuxtApp, { signal }) => {
    try {
      const response = await $fetch<ApiSuccess<PublicProductPage>>('/api/v1/public/products', {
        query: { page: page.value, pageSize: 24, sort: 'newest' },
        signal,
      })
      return response.data
    }
    catch (cause) {
      return throwSafePublicApiError(cause, signal)
    }
  },
  { default: () => null, deep: false, getCachedData: (key, nuxtApp) => nuxtApp.isHydrating ? nuxtApp.payload.data[key] : undefined },
)

const featuredDataKey = computed(() => `public-storefront-home-featured-${page.value}`)
const { data: featuredData } = await useAsyncData(
  featuredDataKey,
  async (_nuxtApp, { signal }) => {
    if (page.value !== 1) return null
    try {
      const response = await $fetch<ApiSuccess<PublicStorefrontFeaturedProducts>>('/api/v1/public/storefront/featured-products', { signal })
      return response.data
    } catch {
      // Recommendations are optional: a failed request must not invent placeholder products.
      return null
    }
  },
  { default: () => null, deep: false, getCachedData: (key, nuxtApp) => nuxtApp.isHydrating ? nuxtApp.payload.data[key] : undefined },
)
const featuredProducts = computed(() => featuredData.value?.products ?? [])

const data = computed(() => fetchedData.value?.page === page.value ? fetchedData.value : null)
const products = computed(() => data.value?.items ?? [])
const siteBrand = useStoreBrand()
setPublicPageFailureStatus(error.value)
const canonical = computed(() => siteUrl(canonicalPagePath('/', page.value)))
useSeoMeta({
  title: '全部商品',
  description: `浏览 ${siteBrand.value.storeName} 当前公开销售的商品。`,
  ogTitle: `${siteBrand.value.storeName} · 全部商品`,
  ogDescription: `浏览 ${siteBrand.value.storeName} 当前公开销售的商品。`,
  ogUrl: canonical,
})
useHead(() => ({ link: [{ rel: 'canonical', href: canonical.value }] }))
</script>

<template>
  <main id="main-content" class="flex-1 pb-16">
    <UContainer class="pt-6 sm:pt-8 md:pt-10">
      <!-- 推荐精选专区 (仅在第一页且有推荐商品时优雅呈现) -->
      <section
        v-if="page === 1 && featuredProducts.length"
        class="mb-10 sm:mb-14"
        aria-labelledby="featured-products-title"
      >
        <div class="mb-4 flex items-center justify-between gap-3 sm:mb-5">
          <div class="flex items-center gap-2">
            <span class="inline-flex size-2 rounded-full bg-primary" aria-hidden="true" />
            <h2
              id="featured-products-title"
              class="text-lg font-semibold tracking-tight text-highlighted sm:text-xl md:text-2xl"
            >
              精选推荐
            </h2>
          </div>
        </div>
        <StorefrontProductGrid :products="featuredProducts" :priority-first="true" />
      </section>

      <!-- 全部商品分区 (核心浏览与选购) -->
      <section aria-labelledby="all-products-title">
        <div class="mb-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-default/50 pb-3 sm:mb-6">
          <div class="flex items-baseline gap-2.5">
            <h1
              id="all-products-title"
              class="text-xl font-semibold tracking-tight text-highlighted sm:text-2xl"
            >
              全部商品
            </h1>
          </div>
          <p
            v-if="data"
            class="text-xs text-dimmed sm:text-sm"
            aria-live="polite"
          >
            共 <span class="font-medium text-muted tabular-nums">{{ data.total }}</span> 件在售商品
          </p>
        </div>

        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          title="商品暂时无法加载"
          description="请检查网络后重试。"
          :actions="[{ label: '重试', onClick: () => refresh() }]"
          class="mb-6 rounded-xl"
        />

        <div
          v-if="status === 'pending' && !data"
          class="grid grid-cols-2 gap-3.5 sm:gap-4.5 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-5"
          aria-label="正在加载商品"
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

        <template v-else-if="data && products.length">
          <StorefrontProductGrid :products="products" :priority-first="!featuredProducts.length" />
          <StorefrontPagination
            v-if="data.totalPages > 1"
            :page="data.page"
            :total-pages="data.totalPages"
            :query="route.query"
            class="mt-8 sm:mt-10"
          />
        </template>

        <UEmpty
          v-else-if="data && products.length === 0"
          icon="i-lucide-package-open"
          title="暂无可展示的商品"
          description="店铺目前还没有公开销售的商品，请稍后再来看看。"
          variant="naked"
          size="lg"
          class="min-h-72"
        />
      </section>
    </UContainer>
  </main>
</template>
