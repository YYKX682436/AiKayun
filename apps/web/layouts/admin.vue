<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const navigationItems: NavigationMenuItem[][] = [
  // 经营
  [
    { label: '经营', type: 'label' },
    {
      label: '概览',
      icon: 'i-lucide-layout-dashboard',
      to: '/admin',
    },
    {
      label: '订单管理',
      icon: 'i-lucide-receipt',
      to: '/admin/orders',
    },
    {
      label: '顾客管理',
      icon: 'i-lucide-users-round',
      to: '/admin/customers',
    },
  ],
  // 商品
  [
    { label: '商品', type: 'label' },
    {
      label: '商品管理',
      icon: 'i-lucide-package',
      to: '/admin/products',
    },
    {
      label: '购买填写模板',
      icon: 'i-lucide-list-checks',
      to: '/admin/purchase-form-templates',
    },
    {
      label: '供应商连接',
      icon: 'i-lucide-plug-zap',
      to: '/admin/supplier-connections',
    },
    {
      label: '供应商商品映射',
      icon: 'i-lucide-git-compare-arrows',
      to: '/admin/supplier-product-mappings',
    },
  ],
  // 资金
  [
    { label: '资金', type: 'label' },
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
  ],
  // 店铺
  [
    { label: '店铺', type: 'label' },
    {
      label: '店铺设置',
      icon: 'i-lucide-store',
      to: '/admin/storefront/brand',
    },
    {
      label: '首页推荐',
      icon: 'i-lucide-star',
      to: '/admin/storefront/featured',
    },
    {
      label: '顾客设置',
      icon: 'i-lucide-user-round-cog',
      to: '/admin/storefront/customer-policy',
    },
    {
      label: '客服设置',
      icon: 'i-lucide-headset',
      to: '/admin/storefront/support',
    },
  ],
  // 系统
  [
    { label: '系统', type: 'label' },
    {
      label: '运维中心',
      icon: 'i-lucide-activity',
      to: '/admin/operations',
    },
    {
      label: '授权管理',
      icon: 'i-lucide-key-round',
      to: '/admin/license',
    },
  ],
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
      collapsible
      resizable
      :toggle="false"
      :default-size="18"
      :min-size="14"
      :max-size="22"
      :collapsed-size="4"
      :menu="{
        side: 'left',
        title: '后台导航',
        description: '选择可用的管理区域或返回店铺。',
      }"
      :ui="{ content: 'w-[min(19rem,calc(100vw-1rem))] max-w-none' }"
      class="bg-elevated border-e border-default/70"
    >
      <template #header="{ collapsed, collapse }">
        <div class="flex h-full w-full items-center justify-between gap-2 overflow-hidden">
          <NuxtLink
            to="/admin"
            class="flex min-w-0 items-center gap-2.5 rounded-lg font-semibold text-highlighted transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            :title="collapsed ? 'AiKayun 管理后台' : undefined"
          >
            <BrandMark
              name="AiKayun"
              class="size-7 shrink-0"
            />
            <span
              v-if="!collapsed"
              class="min-w-0 leading-tight"
            >
              <span class="block truncate text-sm font-semibold tracking-tight">AiKayun</span>
              <span class="block text-xs font-normal text-muted">管理后台</span>
            </span>
          </NuxtLink>

          <UButton
            v-if="!collapsed"
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-lucide-panel-left-close"
            aria-label="折叠侧边栏"
            class="hidden lg:flex shrink-0 text-muted hover:text-highlighted"
            @click="collapse(true)"
          />
        </div>
      </template>

      <template #default="{ collapsed }">
        <div
          role="group"
          aria-label="后台导航"
          class="grid gap-3"
        >
          <UNavigationMenu
            :items="navigationItems"
            :collapsed="collapsed"
            orientation="vertical"
            highlight
            tooltip
            class="w-full"
          />
        </div>
      </template>

      <template #footer="{ collapsed, collapse }">
        <div class="flex flex-col gap-1 w-full">
          <UButton
            to="/"
            color="neutral"
            variant="ghost"
            icon="i-lucide-store"
            :label="collapsed ? undefined : '返回店铺'"
            :tooltip="collapsed ? '返回店铺' : undefined"
            block
            class="justify-start text-muted hover:text-highlighted"
          />
          <UButton
            color="neutral"
            variant="ghost"
            :icon="collapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'"
            :label="collapsed ? undefined : '折叠导航'"
            :tooltip="collapsed ? '展开导航' : undefined"
            aria-label="切换侧边栏展开状态"
            block
            class="hidden lg:flex justify-start text-muted hover:text-highlighted"
            @click="collapse(!collapsed)"
          />
        </div>
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
