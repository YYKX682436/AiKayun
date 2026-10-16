<script setup lang="ts">
const storeBrand = useStoreBrand()
</script>

<template>
  <div class="min-h-screen bg-default">
    <header class="border-b border-default bg-elevated">
      <UContainer class="flex h-16 items-center justify-between gap-6">
        <NuxtLink
          to="/"
          class="flex min-w-0 items-center gap-3 rounded-sm font-semibold tracking-tight text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          <BrandMark
            :name="storeBrand.storeName"
            :logo-url="storeBrand.storeLogoUrl"
          />
          <span class="truncate">{{ storeBrand.storeName }}</span>
        </NuxtLink>
        <nav
          aria-label="主导航"
          class="flex shrink-0 items-center gap-2"
        >
          <ThemeModeSelect />
          <NuxtLink
            to="/admin/login"
            class="hidden rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:inline-flex"
          >
            管理后台
          </NuxtLink>
          <UButton
            to="/admin/login"
            color="primary"
            size="sm"
          >
            登录
          </UButton>
        </nav>
      </UContainer>
    </header>
    <main>
      <slot />
    </main>
    <footer class="border-t border-default bg-elevated">
      <UContainer class="flex flex-col gap-3 py-7 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
        <span>{{ storeBrand.storeName }} · 独立部署的数字商品商城</span>
        <span>安全、清晰、可持续扩展</span>
      </UContainer>
    </footer>
  </div>
</template>
