<template>
  <div class="min-h-screen">
    <header class="border-b border-slate-200/80 bg-white/90">
      <UContainer class="flex h-16 items-center justify-between gap-6">
        <NuxtLink
          to="/"
          class="flex items-center gap-3 rounded-sm font-semibold tracking-tight text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-600"
        >
          <span class="grid size-9 place-items-center rounded-xl bg-indigo-600 text-sm font-bold text-white">A</span>
          <span>AiKayun</span>
        </NuxtLink>
        <nav
          aria-label="主导航"
          class="flex items-center gap-2"
        >
          <NuxtLink
            to="/admin/login"
            class="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
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
    <footer class="border-t border-slate-200 bg-white">
      <UContainer class="flex flex-col gap-3 py-7 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
        <span>AiKayun · 独立部署的数字商品商城</span>
        <span>安全、清晰、可持续扩展</span>
      </UContainer>
    </footer>
  </div>
</template>
