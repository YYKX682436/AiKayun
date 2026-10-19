<script setup lang="ts">
const storeBrand = useStoreBrand()
const { data: categoriesResponse } = await usePublicCategories()
const categories = computed(() => categoriesResponse.value?.data.categories ?? [])
const storefrontReady = ref(false)
const route = useRoute()
const customerApi = useCustomerApi()
const shoppingCart = useShoppingCart()

if (!customerApi.sessionResolved.value) {
  const sessionCookie = useCookie<string | null>('aikayun_customer_session')
  if (import.meta.server && !sessionCookie.value) customerApi.sessionResolved.value = true
  else await customerApi.refreshSession()
}

watch(() => route.path, () => {
  if (customerApi.session.value && route.path !== '/account') void customerApi.refreshSession()
})

watch(
  () => customerApi.sessionResolved.value ? customerApi.identityVersion.value : undefined,
  () => { if (import.meta.client) void shoppingCart.syncSession() },
  { flush: 'sync' },
)

onMounted(() => {
  storefrontReady.value = true
  void shoppingCart.syncSession()
})
</script>

<template>
  <div
    class="min-h-dvh bg-default"
    :data-storefront-ready="storefrontReady ? 'true' : 'false'"
  >
    <NuxtLink
      to="#main-content"
      class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-elevated focus:px-4 focus:py-3 focus:text-highlighted focus:shadow-lg"
    >
      跳转到主要内容
    </NuxtLink>

    <header class="border-b border-default bg-elevated">
      <UContainer class="flex min-h-16 items-center justify-between gap-2 py-2">
        <NuxtLink
          to="/"
          class="flex min-w-0 shrink items-center gap-2 rounded-sm font-semibold text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary sm:gap-2.5"
        >
          <BrandMark
            :name="storeBrand.storeName"
            :logo-url="storeBrand.storeLogoUrl"
          />
          <span class="max-w-[3.25rem] truncate text-sm sm:max-w-[12rem] sm:text-base">{{ storeBrand.storeName }}</span>
        </NuxtLink>

        <div class="flex shrink-0 items-center gap-0 sm:gap-1">
          <StorefrontCategoryNav :categories="categories" />
          <UButton
            to="/search"
            color="neutral"
            variant="ghost"
            icon="i-lucide-search"
            aria-label="搜索商品"
            class="min-h-11 min-w-9 px-1.5 sm:min-w-10 sm:px-2"
          >
            <span class="hidden xl:inline">搜索商品</span>
          </UButton>
          <NuxtLink
            to="/cart"
            class="relative flex min-h-11 min-w-10 items-center justify-center gap-1 rounded-lg px-2 text-sm font-medium text-muted transition-colors hover:bg-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:px-3"
            :aria-label="`购物车，${shoppingCart.currentQuantity.value} 件商品`"
          >
            <UIcon
              name="i-lucide-shopping-cart"
              class="size-4 shrink-0"
              aria-hidden="true"
            />
            <span class="hidden sm:inline">购物车</span>
            <UBadge
              v-if="shoppingCart.currentQuantity.value > 0"
              color="primary"
              size="xs"
              class="absolute -right-0.5 -top-0.5 min-w-5 justify-center px-1 tabular-nums"
              aria-hidden="true"
            >
              {{ shoppingCart.currentQuantity.value > 99 ? '99+' : shoppingCart.currentQuantity.value }}
            </UBadge>
          </NuxtLink>
          <NuxtLink
            to="/orders"
            class="hidden min-h-11 min-w-10 items-center justify-center rounded-lg px-2 text-muted transition-colors hover:bg-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary min-[360px]:flex"
            aria-label="我的订单"
            title="我的订单"
          >
            <UIcon
              name="i-lucide-receipt-text"
              class="size-4"
              aria-hidden="true"
            />
          </NuxtLink>
          <ThemeModeSelect />
          <NuxtLink
            :to="customerApi.session.value ? '/account' : '/login'"
            class="flex min-h-11 min-w-10 items-center justify-center gap-1 rounded-lg px-2 text-sm font-medium text-muted transition-colors hover:bg-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:px-3"
            :aria-label="customerApi.session.value ? `顾客账户，${customerApi.session.value.customer.username}` : '顾客登录'"
          >
            <UIcon
              :name="customerApi.session.value ? 'i-lucide-user-round-check' : 'i-lucide-user-round'"
              class="size-4 shrink-0"
              aria-hidden="true"
            />
            <span class="hidden max-w-28 truncate sm:inline">
              {{ customerApi.session.value?.customer.username ?? '登录' }}
            </span>
          </NuxtLink>
          <NuxtLink
            to="/admin/login"
            class="hidden min-h-11 items-center rounded-lg px-3 text-sm font-medium text-muted transition-colors hover:bg-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary lg:inline-flex"
          >
            管理入口
          </NuxtLink>
        </div>
      </UContainer>
    </header>

    <slot />

    <footer class="border-t border-default bg-elevated">
      <UContainer class="flex flex-wrap items-center justify-between gap-2 py-5 text-sm text-muted">
        <span>{{ storeBrand.storeName }}</span>
        <nav
          aria-label="商城辅助导航"
          class="flex flex-wrap items-center gap-2"
        >
          <NuxtLink
            to="/orders"
            class="min-h-11 content-center rounded-lg px-2 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            订单查询
          </NuxtLink>
          <NuxtLink
            to="/admin/login"
            class="min-h-11 content-center rounded-lg px-2 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            管理入口
          </NuxtLink>
        </nav>
      </UContainer>
    </footer>
  </div>
</template>
