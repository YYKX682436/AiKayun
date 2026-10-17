<script setup lang="ts">
import type { ApiSuccess, PublicProductPage } from '@aikayun/contracts'

const route = useRoute()
const siteUrl = usePublicSiteUrl()
const page = computed(() => {
  const value = Number(route.query.page)
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100_000) : 1
})
const asyncDataKey = computed(() => `public-storefront-home-${page.value}`)
const { data, error, status, refresh } = await useAsyncData(
  asyncDataKey,
  async (_nuxtApp, { signal }) => {
    const response = await $fetch<ApiSuccess<PublicProductPage>>('/api/v1/public/products', {
      query: { page: page.value, pageSize: 24, sort: 'newest' },
      signal,
    })
    return response.data
  },
  { default: () => null, deep: false, getCachedData: (key, nuxtApp) => nuxtApp.isHydrating ? nuxtApp.payload.data[key] : undefined },
)

const products = computed(() => data.value?.items ?? [])
const siteBrand = useStoreBrand()
useSeoMeta({
  title: '全部商品',
  description: `浏览 ${siteBrand.value.storeName} 当前公开销售的商品。`,
  ogTitle: `${siteBrand.value.storeName} · 全部商品`,
  ogDescription: `浏览 ${siteBrand.value.storeName} 当前公开销售的商品。`,
  ogUrl: siteUrl('/'),
})
useHead({ link: [{ rel: 'canonical', href: siteUrl('/') }] })
</script>

<template>
  <main id="main-content">
    <UContainer class="py-6 sm:py-9">
      <div class="mb-5 flex flex-wrap items-end justify-between gap-3 sm:mb-7">
        <div>
          <p class="text-sm font-medium text-muted">
            店铺商品
          </p>
          <h1 class="mt-1 text-2xl font-semibold text-highlighted sm:text-3xl">
            全部商品
          </h1>
        </div>
        <p
          v-if="data"
          class="text-sm text-muted"
          aria-live="polite"
        >
          共 {{ data.total }} 件商品
        </p>
      </div>

      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        title="商品暂时无法加载"
        description="请检查网络后重试。"
        :actions="[{ label: '重试', onClick: () => refresh() }]"
        class="mb-5"
      />

      <div
        v-if="status === 'pending' && !data"
        class="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5"
        aria-label="正在加载商品"
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

      <template v-else-if="data && products.length">
        <StorefrontProductGrid :products="products" />
        <StorefrontPagination
          v-if="data.totalPages > 1"
          :page="data.page"
          :total-pages="data.totalPages"
          :query="route.query"
          class="mt-7"
        />
      </template>

      <UEmpty
        v-else-if="data && products.length === 0"
        icon="i-lucide-package-open"
        title="暂无可展示的商品"
        description="店铺目前还没有公开销售的商品，请稍后再来看看。"
        variant="naked"
        size="lg"
        class="min-h-64"
      />
    </UContainer>
  </main>
</template>
