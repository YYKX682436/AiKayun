<script setup lang="ts">
useSeoMeta({
  title: '数字商品商城',
  description: '为卡密、软件授权和虚拟商品打造的独立部署商城。',
})

const capabilities = [
  { number: '01', title: '数字商品优先', description: '围绕卡密、软件授权与虚拟商品设计，让数字交付流程保持清楚、可靠。' },
  { number: '02', title: '交付方式灵活', description: '为 API 自动发货和人工交付留出明确边界，逐步扩展实际需要的能力。' },
  { number: '03', title: '独立部署', description: '商城、管理后台与数据由商家自己掌控，适合面向客户部署和持续经营。' },
]
</script>

<template>
  <section class="overflow-hidden">
    <UContainer class="grid min-h-[620px] items-center gap-14 py-16 lg:grid-cols-[1.15fr_0.85fr] lg:py-24">
      <div class="max-w-2xl">
        <div class="mb-7 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-elevated px-3 py-1.5 text-sm font-medium text-primary shadow-sm">
          <span
            class="size-2 rounded-full bg-emerald-500"
            aria-hidden="true"
          />
          独立部署 · 数字商品专注
        </div>
        <h1 class="text-5xl font-semibold leading-[1.08] tracking-[-0.045em] text-slate-950 sm:text-6xl lg:text-7xl">
          让数字商品，<br>
          <span class="text-primary">轻松开始销售。</span>
        </h1>
        <p class="mt-7 max-w-xl text-lg leading-8 text-slate-600">
          AiKayun 为卡密、软件授权与虚拟商品提供清晰的商城基础。用自己的部署环境经营业务，从可靠的商品展示与交付开始。
        </p>
        <div class="mt-9 flex flex-wrap gap-3">
          <UButton
            to="/admin/login"
            size="lg"
            trailing-icon="i-lucide-arrow-right"
          >
            进入管理后台
          </UButton>
          <a
            href="/api/docs"
            class="inline-flex h-11 items-center rounded-lg border border-default bg-elevated px-5 text-sm font-medium text-toned transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            查看 API 文档
          </a>
        </div>
        <div class="mt-12 flex flex-wrap gap-x-8 gap-y-3 border-t border-slate-200 pt-6 text-sm text-slate-500">
          <span>TypeScript 严格模式</span>
          <span>PostgreSQL 数据持久化</span>
          <span>前后端共享 API 契约</span>
        </div>
      </div>

      <div class="relative mx-auto w-full max-w-md">
        <UCard class="relative overflow-hidden border border-default">
          <template #header>
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-semibold text-slate-900">
                  工程基础
                </p>
                <p class="mt-1 text-xs text-slate-500">
                  为数字商品业务准备
                </p>
              </div>
              <span class="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">阶段 01</span>
            </div>
          </template>
          <div class="grid grid-cols-2 gap-3">
            <div class="rounded-2xl bg-primary/10 p-4">
              <p class="text-xs font-medium text-primary">
                页面渲染
              </p>
              <p class="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                SSR
              </p>
            </div>
            <div class="rounded-2xl bg-muted p-4">
              <p class="text-xs font-medium text-toned">
                应用架构
              </p>
              <p class="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                模块化单体
              </p>
            </div>
          </div>
          <div class="mt-4 rounded-2xl border border-slate-200 p-4">
            <div class="mb-4 flex items-center justify-between">
              <p class="text-sm font-medium text-slate-800">
                基础能力
              </p>
              <span class="text-xs text-slate-400">首个版本</span>
            </div>
            <div class="grid gap-3">
              <div
                v-for="item in ['共享 OpenAPI 契约', '管理员会话验证', 'PG18 + Kysely 迁移']"
                :key="item"
                class="flex items-center gap-3 text-sm text-slate-600"
              >
                <span
                  class="grid size-6 place-items-center rounded-full bg-success/10 text-success"
                  aria-hidden="true"
                >✓</span>
                {{ item }}
              </div>
            </div>
          </div>
          <template #footer>
            <div class="flex items-center justify-between text-xs text-slate-500">
              <span>当前阶段：工程基础搭建</span>
              <span>v0.1</span>
            </div>
          </template>
        </UCard>
      </div>
    </UContainer>
  </section>

  <section class="border-y border-slate-200 bg-white py-16 sm:py-20">
    <UContainer>
      <div class="mb-10 max-w-2xl">
        <p class="text-sm font-semibold uppercase tracking-[0.15em] text-indigo-600">
          为实际经营打基础
        </p>
        <h2 class="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
          从清晰、可靠的商城核心开始。
        </h2>
      </div>
      <div class="grid gap-4 md:grid-cols-3">
        <article
          v-for="capability in capabilities"
          :key="capability.number"
          class="rounded-2xl border border-slate-200 bg-slate-50/70 p-6"
        >
          <p class="text-sm font-semibold text-indigo-600">
            {{ capability.number }}
          </p>
          <h3 class="mt-6 text-lg font-semibold text-slate-950">
            {{ capability.title }}
          </h3>
          <p class="mt-3 text-sm leading-6 text-slate-600">
            {{ capability.description }}
          </p>
        </article>
      </div>
    </UContainer>
  </section>
</template>
