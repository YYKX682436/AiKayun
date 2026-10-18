<script setup lang="ts">
import type { ApiSuccess, PublicCategoryProductsResponse } from '@aikayun/contracts'

const route = useRoute()
const siteUrl = usePublicSiteUrl()
useUncachedPublicPage()
const id = computed(() => String(route.params.id ?? ''))
const page = computed(() => {
  const value = Number(route.query.page)
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100_000) : 1
})
const sort = computed(() => {
  const value = String(route.query.sort ?? 'default')
  return ['default', 'newest', 'price_asc', 'price_desc'].includes(value) ? value : 'default'
})
const requestIdentity = computed(() => JSON.stringify([id.value, page.value, sort.value]))
const asyncDataKey = computed(() => `public-category-products-${requestIdentity.value}`)
const { data: fetchedData, error, status, refresh } = await useAsyncData(
  asyncDataKey,
  async (_nuxtApp, { signal }) => {
    const identity = requestIdentity.value
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id.value)) {
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
    }
    try {
      const response = await $fetch<ApiSuccess<PublicCategoryProductsResponse>>(`/api/v1/public/categories/${encodeURIComponent(id.value)}/products`, {
        query: { page: page.value, pageSize: 24, sort: sort.value },
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

const data = computed(() => fetchedData.value?.identity === requestIdentity.value ? fetchedData.value.response : null)
const category = computed(() => data.value?.category)
const products = computed(() => data.value?.products.items ?? [])
const notFound = computed(() => Number((error.value as { statusCode?: number } | null)?.statusCode) === 404)
const title = computed(() => category.value?.name ?? '商品分类')
const description = computed(() => category.value
  ? `浏览 ${category.value.name} 及其可见子分类中的商品。`
  : '浏览店铺当前公开的分类商品。')
const canonical = computed(() => siteUrl(canonicalPagePath(`/categories/${encodeURIComponent(id.value)}`, page.value, sort.value, 'default')))
setPublicPageFailureStatus(error.value)
useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogUrl: canonical,
  robots: computed(() => data.value ? 'index, follow' : 'noindex, nofollow'),
})
useHead(() => ({ link: [{ rel: 'canonical', href: canonical.value }] }))

const routeQuery = computed(() => route.query)
</script>

<template>
  <main id="main-content">
    <UContainer class="py-6 sm:py-9">
      <template v-if="data">
        <nav
          aria-label="面包屑"
          class="mb-4 min-w-0 overflow-x-auto text-sm text-muted"
        >
          <ol class="flex min-w-max items-center gap-2">
            <li>
              <NuxtLink
                to="/"
                class="rounded-sm hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
              >
                全部商品
              </NuxtLink>
            </li>
            <li
              v-for="item in data.breadcrumbs"
              :key="item.id"
              class="flex items-center gap-2"
            >
              <span aria-hidden="true">/</span>
              <NuxtLink
                :to="`/categories/${item.id}`"
                class="rounded-sm hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
                :aria-current="item.id === category?.id ? 'page' : undefined"
              >
                {{ item.name }}
              </NuxtLink>
            </li>
          </ol>
        </nav>

        <div class="mb-5 flex flex-wrap items-end justify-between gap-3 sm:mb-7">
          <div>
            <h1 class="text-2xl font-semibold text-highlighted sm:text-3xl">
              {{ category?.name }}
            </h1>
            <p class="mt-1 text-sm text-muted">
              {{ data.products.total }} 件商品
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <NuxtLink
              v-if="category?.parentId"
              :to="`/categories/${category.parentId}`"
              class="inline-flex min-h-11 items-center gap-1 rounded-lg border border-default px-3 text-sm font-medium text-highlighted hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <UIcon name="i-lucide-arrow-up" />返回上级
            </NuxtLink>
            <NuxtLink
              to="/"
              class="inline-flex min-h-11 items-center rounded-lg border border-default px-3 text-sm font-medium text-highlighted hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              返回全部商品
            </NuxtLink>
          </div>
        </div>

        <nav
          v-if="data.children.length"
          aria-label="下级分类"
          class="mb-6 flex flex-wrap gap-2"
        >
          <NuxtLink
            v-for="child in data.children"
            :key="child.id"
            :to="`/categories/${child.id}`"
            class="inline-flex min-h-11 items-center rounded-full border border-default px-4 text-sm text-highlighted transition-colors hover:border-primary/40 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {{ child.name }}
          </NuxtLink>
        </nav>

        <StorefrontProductGrid
          v-if="products.length"
          :products="products"
        />
        <UEmpty
          v-else
          icon="i-lucide-package-open"
          title="此分类暂无商品"
          description="当前分类及其可见子分类中没有公开商品。"
          variant="naked"
          size="lg"
          class="min-h-64"
        />
        <StorefrontPagination
          v-if="data.products.totalPages > 1"
          :page="data.products.page"
          :total-pages="data.products.totalPages"
          :query="routeQuery"
          class="mt-7"
        />
      </template>

      <div
        v-else-if="status === 'pending'"
        class="min-h-64 animate-pulse rounded-xl bg-muted motion-reduce:animate-none"
        aria-label="正在加载分类"
      />
      <UAlert
        v-else-if="error && !notFound"
        color="error"
        variant="subtle"
        title="分类暂时无法加载"
        description="请检查网络后重试。"
        :actions="[{ label: '重试', onClick: () => refresh() }]"
      />
      <UEmpty
        v-else
        icon="i-lucide-folder-x"
        title="分类不存在或暂不可见"
        description="该分类目前无法公开浏览。"
        variant="naked"
        size="lg"
        class="min-h-64"
      >
        <template #actions>
          <UButton
            to="/"
            color="neutral"
            variant="outline"
          >
            返回全部商品
          </UButton>
        </template>
      </UEmpty>
    </UContainer>
  </main>
</template>
