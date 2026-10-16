<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const storeBrand = useStoreBrand()
const navigationItems: NavigationMenuItem[] = [{ label: '首页', to: '/' }]
</script>

<template>
  <div class="min-h-dvh bg-default">
    <NuxtLink
      to="#main-content"
      class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-elevated focus:px-4 focus:py-3 focus:text-highlighted focus:shadow-lg"
    >
      跳转到主要内容
    </NuxtLink>

    <header class="border-b border-default bg-elevated">
      <UContainer class="flex min-h-16 items-center justify-between gap-3 py-2">
        <NuxtLink
          to="/"
          class="flex min-w-0 items-center gap-2.5 rounded-sm font-semibold text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary sm:gap-3"
        >
          <BrandMark
            :name="storeBrand.storeName"
            :logo-url="storeBrand.storeLogoUrl"
          />
          <span class="max-w-[8rem] truncate sm:max-w-[16rem]">{{ storeBrand.storeName }}</span>
        </NuxtLink>

        <div class="flex shrink-0 items-center gap-1 sm:gap-2">
          <UNavigationMenu
            :items="navigationItems"
            aria-label="商城导航"
            class="hidden md:flex"
          />
          <ThemeModeSelect />
          <NuxtLink
            to="/admin/login"
            class="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-muted transition-colors hover:bg-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:px-3 sm:text-sm"
          >
            <span class="sm:hidden">管理</span>
            <span class="hidden sm:inline">管理入口</span>
          </NuxtLink>
        </div>
      </UContainer>
    </header>

    <slot />

    <footer class="border-t border-default bg-elevated">
      <UContainer class="py-5 text-sm text-muted">
        {{ storeBrand.storeName }}
      </UContainer>
    </footer>
  </div>
</template>
