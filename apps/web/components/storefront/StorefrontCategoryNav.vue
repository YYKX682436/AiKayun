<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import type { PublicCategory } from '@aikayun/contracts'

const props = defineProps<{ categories: PublicCategory[] }>()
const route = useRoute()
const customerApi = useCustomerApi()
const { data: support, status: supportStatus } = useStorefrontSupport()
const drawerOpen = ref(false)

watch(() => route.path, () => {
  drawerOpen.value = false
})

const roots = computed(() => props.categories.filter(category => category.parentId === null))

function navItem(category: PublicCategory): NavigationMenuItem {
  const children = props.categories
    .filter(child => child.parentId === category.id)
    .map(navItem)
  const currentCategory = props.categories.find(item => item.id === route.params.id)
  const active = currentCategory?.path.some(ancestor => ancestor.id === category.id) ?? false
  return {
    label: category.name,
    to: `/categories/${category.id}`,
    active,
    children: children.length > 0 ? children : undefined,
  }
}

const desktopItems = computed<NavigationMenuItem[]>(() => {
  const visible = roots.value.slice(0, 3).map(navItem)
  const remaining = roots.value.slice(3).map(navItem)
  if (remaining.length > 0) visible.push({ label: '更多分类', children: remaining })
  return visible
})
</script>

<template>
  <UNavigationMenu
    v-if="desktopItems.length"
    :items="desktopItems"
    aria-label="商品分类"
    class="hidden min-w-0 max-w-[24rem] xl:flex"
  />

  <UButton
    color="neutral"
    variant="ghost"
    icon="i-lucide-menu"
    aria-label="浏览商品分类"
    class="min-h-11 min-w-9 px-1.5 xl:hidden"
    @click="drawerOpen = true"
  />

  <UDrawer
    v-model:open="drawerOpen"
    title="商城菜单"
    description="浏览店铺商品与快捷服务。"
    direction="right"
    :handle="false"
    :ui="{
      overlay: 'storefront-drawer-overlay',
      content: 'storefront-glass-drawer ring-0 w-[min(22rem,90vw)]',
      body: 'p-4 flex flex-col gap-5 overflow-y-auto',
    }"
  >
    <template #body>
      <div>
        <p class="px-3 pb-1 text-xs font-medium text-dimmed">
          商品浏览
        </p>
        <nav aria-label="商品导航">
          <NuxtLink
            to="/"
            class="mb-1 flex min-h-11 items-center gap-2.5 rounded-lg px-3 font-medium text-highlighted transition-colors hover:bg-muted"
            @click="drawerOpen = false"
          >
            <UIcon
              name="i-lucide-package"
              class="size-4.5 text-muted"
            />
            <span>全部商品</span>
          </NuxtLink>
          <StorefrontCategoryTreeLinks
            v-if="roots.length"
            :categories="roots"
            :current-id="route.params.id?.toString()"
            @navigate="drawerOpen = false"
          />
        </nav>
      </div>

      <div class="border-t border-default/70 pt-4">
        <p class="px-3 pb-1 text-xs font-medium text-dimmed">
          商城服务
        </p>
        <nav
          aria-label="商城快捷导航"
          class="space-y-0.5"
        >
          <NuxtLink
            to="/orders"
            class="flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-highlighted transition-colors hover:bg-muted"
            @click="drawerOpen = false"
          >
            <UIcon
              name="i-lucide-receipt-text"
              class="size-4.5 text-muted"
            />
            <span>我的订单</span>
          </NuxtLink>
          <NuxtLink
            v-if="customerApi.session.value"
            to="/wallet"
            class="flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-highlighted transition-colors hover:bg-muted"
            @click="drawerOpen = false"
          >
            <UIcon
              name="i-lucide-wallet"
              class="size-4.5 text-muted"
            />
            <span>我的钱包</span>
          </NuxtLink>
          <NuxtLink
            v-if="supportStatus === 'success' && support?.channels.length"
            to="/support"
            class="flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-highlighted transition-colors hover:bg-muted"
            @click="drawerOpen = false"
          >
            <UIcon
              name="i-lucide-headset"
              class="size-4.5 text-muted"
            />
            <span>联系客服</span>
          </NuxtLink>
        </nav>
      </div>

      <div class="mt-auto border-t border-default/70 pt-4">
        <p class="px-3 pb-2 text-xs font-medium text-dimmed">
          外观设置
        </p>
        <div class="px-1">
          <ThemeModeSelect class="w-full" />
        </div>
      </div>
    </template>
  </UDrawer>
</template>
