<template>
  <div class="min-h-screen bg-default">
    <header class="border-b border-default bg-elevated">
      <UContainer class="flex min-h-16 flex-wrap items-center justify-between gap-2 py-2">
        <NuxtLink
          to="/admin"
          class="flex items-center gap-3 font-semibold text-highlighted"
        >
          <BrandMark name="AiKayun" />
          <span>AiKayun <span class="hidden font-normal text-dimmed sm:inline">/ 管理后台</span></span>
        </NuxtLink>
        <nav class="flex items-center gap-2">
          <ThemeModeSelect />
          <NuxtLink
            to="/"
            class="text-sm font-medium text-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            返回商城
          </NuxtLink>
        </nav>
      </UContainer>
    </header>
    <div class="mx-auto grid min-h-[calc(100vh-4rem)] max-w-7xl lg:grid-cols-[220px_1fr]">
      <aside class="border-b border-default bg-elevated p-4 lg:border-r lg:border-b-0 lg:p-5">
        <p class="mb-3 px-3 text-xs font-semibold uppercase tracking-[0.16em] text-dimmed">
          工作区
        </p>
        <nav
          aria-label="后台导航"
          class="grid gap-1"
        >
          <NuxtLink
            to="/admin"
            class="rounded-lg bg-primary/10 px-3 py-2.5 text-sm font-semibold text-primary"
          >
            概览
          </NuxtLink>
          <span
            aria-disabled="true"
            class="rounded-lg px-3 py-2.5 text-sm text-dimmed"
          >商品管理 · 即将开放</span>
          <span
            aria-disabled="true"
            class="rounded-lg px-3 py-2.5 text-sm text-dimmed"
          >订单管理 · 即将开放</span>
        </nav>
      </aside>
      <main class="p-5 sm:p-8 lg:p-10">
        <slot />
      </main>
    </div>
  </div>
</template>
