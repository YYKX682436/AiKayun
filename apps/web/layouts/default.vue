<template>
  <div class="min-h-screen bg-default">
    <header class="border-b border-default bg-elevated">
      <UContainer class="flex h-16 items-center justify-between gap-6">
        <NuxtLink
          to="/"
          class="flex items-center gap-3 rounded-sm font-semibold tracking-tight text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          <span class="grid size-9 place-items-center rounded-xl bg-primary text-sm font-bold text-inverted">A</span>
          <span>AiKayun</span>
        </NuxtLink>
        <nav
          aria-label="主导航"
          class="flex items-center gap-2"
        >
          <NuxtLink
            to="/admin/login"
            class="rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
        <span>AiKayun · 独立部署的数字商品商城</span>
        <span>安全、清晰、可持续扩展</span>
      </UContainer>
    </footer>
  </div>
</template>
