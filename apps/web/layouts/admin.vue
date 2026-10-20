<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const navigationItems: NavigationMenuItem[][] = [[
  {
    label: '概览',
    icon: 'i-lucide-layout-dashboard',
    to: '/admin',
  },
  {
    label: '商品管理',
    icon: 'i-lucide-package',
    to: '/admin/products',
  },
  {
    label: '顾客管理',
    icon: 'i-lucide-users-round',
    to: '/admin/customers',
  },
  {
    label: '订单管理',
    icon: 'i-lucide-receipt',
    to: '/admin/orders',
  },
  {
    label: '支付通道',
    icon: 'i-lucide-credit-card',
    to: '/admin/payment-channels',
  },
  {
    label: '钱包与充值',
    icon: 'i-lucide-wallet',
    to: '/admin/wallets',
  },
  {
    label: '提现管理',
    icon: 'i-lucide-banknote-arrow-up',
    to: '/admin/withdrawals',
  },
  {
    label: '顾客设置',
    icon: 'i-lucide-user-round-cog',
    to: '/admin/storefront/customer-policy',
  },
]]

const unavailableModules = [
  { label: '经营数据', icon: 'i-lucide-chart-no-axes-column-increasing' },
]
</script>

<template>
  <NuxtLink
    to="#admin-main"
    class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-elevated focus:px-4 focus:py-3 focus:text-highlighted focus:shadow-lg"
  >
    跳转到主要内容
  </NuxtLink>

  <UDashboardGroup
    storage="cookie"
    storage-key="aikayun-admin-workspace"
    class="bg-default"
  >
    <UDashboardSidebar
      id="admin-navigation"
      mode="slideover"
      :toggle="false"
      :default-size="17"
      :min-size="15"
      :max-size="20"
      :menu="{
        side: 'left',
        title: '后台导航',
        description: '选择可用的管理区域或返回店铺。',
      }"
      :ui="{ content: 'w-[min(19rem,calc(100vw-1rem))] max-w-none' }"
      class="bg-elevated"
    >
      <template #header>
        <NuxtLink
          to="/admin"
          class="flex min-h-11 min-w-0 items-center gap-3 rounded-sm font-semibold text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <BrandMark name="AiKayun" />
          <span class="min-w-0 leading-tight">
            <span class="block truncate">AiKayun</span>
            <span class="block text-xs font-normal text-muted">管理后台</span>
          </span>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <div
          role="group"
          aria-label="后台导航"
          class="grid gap-5"
        >
          <UNavigationMenu
            :items="navigationItems"
            :collapsed="collapsed"
            orientation="vertical"
            highlight
            class="w-full"
          />

          <section aria-labelledby="unavailable-modules-title">
            <h2
              id="unavailable-modules-title"
              class="px-2.5 py-1.5 text-xs font-medium text-dimmed"
            >
              尚未开放
            </h2>
            <ul class="grid gap-1">
              <li
                v-for="module in unavailableModules"
                :key="module.label"
                aria-disabled="true"
                class="flex min-h-10 min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-sm text-dimmed"
              >
                <UIcon
                  :name="module.icon"
                  class="size-4 shrink-0"
                  aria-hidden="true"
                />
                <span class="min-w-0 flex-1 truncate">{{ module.label }}</span>
                <UBadge
                  color="neutral"
                  variant="subtle"
                  size="xs"
                  class="shrink-0"
                >
                  未开放
                </UBadge>
              </li>
            </ul>
          </section>
        </div>
      </template>

      <template #footer>
        <UButton
          to="/"
          color="neutral"
          variant="ghost"
          icon="i-lucide-store"
          block
          class="justify-start"
        >
          返回店铺
        </UButton>
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
