<template>
  <div class="min-h-screen bg-slate-50">
    <header class="border-b border-slate-200 bg-white">
      <UContainer class="flex h-16 items-center justify-between gap-4">
        <NuxtLink
          to="/admin"
          class="flex items-center gap-3 font-semibold text-slate-950"
        >
          <span class="grid size-9 place-items-center rounded-xl bg-indigo-600 text-sm font-bold text-white">A</span>
          <span>AiKayun <span class="font-normal text-slate-400">/ 管理后台</span></span>
        </NuxtLink>
        <NuxtLink
          to="/"
          class="text-sm font-medium text-slate-600 hover:text-slate-950"
        >
          返回商城
        </NuxtLink>
      </UContainer>
    </header>
    <div class="mx-auto grid min-h-[calc(100vh-4rem)] max-w-7xl lg:grid-cols-[220px_1fr]">
      <aside class="border-b border-slate-200 bg-white p-4 lg:border-r lg:border-b-0 lg:p-5">
        <p class="mb-3 px-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
          工作区
        </p>
        <nav
          aria-label="后台导航"
          class="grid gap-1"
        >
          <NuxtLink
            to="/admin"
            class="rounded-lg bg-indigo-50 px-3 py-2.5 text-sm font-semibold text-indigo-800"
          >
            概览
          </NuxtLink>
          <span
            aria-disabled="true"
            class="rounded-lg px-3 py-2.5 text-sm text-slate-400"
          >商品管理 · 即将开放</span>
          <span
            aria-disabled="true"
            class="rounded-lg px-3 py-2.5 text-sm text-slate-400"
          >订单管理 · 即将开放</span>
        </nav>
      </aside>
      <main class="p-5 sm:p-8 lg:p-10">
        <slot />
      </main>
    </div>
  </div>
</template>
