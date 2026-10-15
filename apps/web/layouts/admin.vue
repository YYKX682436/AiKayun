<template>
  <div class="min-h-screen bg-default">
    <header class="border-b border-default bg-elevated">
      <UContainer class="flex h-16 items-center justify-between gap-4">
        <NuxtLink
          to="/admin"
          class="flex items-center gap-3 font-semibold text-highlighted"
        >
          <span class="grid size-9 place-items-center rounded-xl bg-primary text-sm font-bold text-inverted">A</span>
          <span>AiKayun <span class="font-normal text-dimmed">/ 管理后台</span></span>
        </NuxtLink>
        <NuxtLink
          to="/"
          class="text-sm font-medium text-muted hover:text-highlighted"
        >
          返回商城
        </NuxtLink>
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
