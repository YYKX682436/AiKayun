<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import type { PublicCategory } from '@aikayun/contracts'

const props = defineProps<{ categories: PublicCategory[] }>()
const route = useRoute()
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
  const visible = roots.value.slice(0, 5).map(navItem)
  const remaining = roots.value.slice(5).map(navItem)
  if (remaining.length > 0) visible.push({ label: '更多分类', children: remaining })
  return visible
})
</script>

<template>
  <UNavigationMenu
    v-if="desktopItems.length"
    :items="desktopItems"
    aria-label="商品分类"
    class="hidden min-w-0 lg:flex"
  />

  <UButton
    v-if="categories.length"
    color="neutral"
    variant="ghost"
    icon="i-lucide-list-tree"
    aria-label="浏览商品分类"
    class="min-h-11 min-w-9 px-1.5 lg:hidden"
    @click="drawerOpen = true"
  />

  <UDrawer
    v-model:open="drawerOpen"
    title="商品分类"
    description="按分类浏览店铺商品。"
    direction="right"
    :handle="false"
    :ui="{ content: 'w-[min(22rem,90vw)]', body: 'p-3' }"
  >
    <template #body>
      <nav aria-label="商品分类">
        <NuxtLink
          to="/"
          class="mb-2 flex min-h-11 items-center rounded-lg px-3 font-medium text-highlighted hover:bg-muted"
          @click="drawerOpen = false"
        >
          全部商品
        </NuxtLink>
        <StorefrontCategoryTreeLinks
          :categories="roots"
          :current-id="route.params.id?.toString()"
          @navigate="drawerOpen = false"
        />
      </nav>
    </template>
  </UDrawer>
</template>
