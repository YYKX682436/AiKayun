<script setup lang="ts">
import type { PublicProductCard } from '@aikayun/contracts'

const props = withDefaults(defineProps<{ product: PublicProductCard; priority?: boolean }>(), { priority: false })
const imageFailed = ref(false)

watch(() => props.product.cover?.url, () => {
  imageFailed.value = false
})

const typeLabels = {
  physical: '实物商品',
  digital: '数字商品',
  service: '服务商品',
} as const

const priceLabel = computed(() => {
  const range = props.product.priceRange
  if (!range) return '暂无可选售价'
  return range.min === range.max ? `¥${range.min}` : `¥${range.min} 起`
})
</script>

<template>
  <NuxtLink
    :to="`/products/${product.id}`"
    class="storefront-card group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-default/70 bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    :aria-label="`${product.name}，${priceLabel}`"
  >
    <div class="relative aspect-square w-full overflow-hidden bg-muted/50">
      <img
        v-if="product.cover && !imageFailed"
        :src="product.cover.url"
        :alt="product.cover.alt || product.name"
        :width="product.cover.width"
        :height="product.cover.height"
        :loading="priority ? 'eager' : 'lazy'"
        :fetchpriority="priority ? 'high' : 'auto'"
        decoding="async"
        class="h-full w-full object-cover transition-transform duration-300 ease-out motion-reduce:transition-none group-hover:scale-105"
        @error="imageFailed = true"
      >
      <div
        v-else
        class="flex h-full w-full items-center justify-center text-dimmed"
        aria-hidden="true"
      >
        <UIcon
          name="i-lucide-package"
          class="size-8 stroke-[1.5] opacity-50 sm:size-10"
        />
      </div>

      <!-- Type badge floating on top right of image for clean look -->
      <div class="absolute right-2 top-2">
        <UBadge
          color="neutral"
          variant="subtle"
          size="xs"
          class="border border-default/50 bg-elevated/85 text-[11px] font-medium shadow-2xs backdrop-blur-sm"
        >
          {{ typeLabels[product.productType] }}
        </UBadge>
      </div>
    </div>

    <div class="flex flex-1 flex-col p-3 sm:p-4">
      <h2 class="line-clamp-2 min-h-10 text-[13px] font-medium leading-snug text-highlighted transition-colors group-hover:text-primary sm:min-h-11 sm:text-sm sm:leading-snug">
        {{ product.name }}
      </h2>

      <p
        v-if="product.description"
        class="mt-1 line-clamp-1 text-xs text-muted sm:text-[13px]"
      >
        {{ product.description }}
      </p>

      <div class="mt-auto flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1.5 pt-3">
        <div class="min-w-0">
          <span
            v-if="product.priceRange"
            class="text-xs font-medium text-primary sm:text-sm"
          >¥</span>
          <span
            class="min-w-0 text-base font-semibold tracking-tight tabular-nums sm:text-lg"
            :class="product.priceRange ? 'text-primary' : 'text-muted text-sm font-normal'"
          >
            {{ product.priceRange ? (product.priceRange.min === product.priceRange.max ? product.priceRange.min : `${product.priceRange.min} 起`) : '暂无可选售价' }}
          </span>
        </div>

        <UBadge
          v-if="product.selectionStatus === 'none'"
          color="neutral"
          variant="soft"
          size="xs"
          class="text-[11px]"
        >
          暂无可选规格
        </UBadge>
        <UBadge
          v-else-if="product.inventoryStatus === 'out_of_stock'"
          color="warning"
          variant="soft"
          size="xs"
          class="text-[11px]"
        >
          暂时缺货
        </UBadge>
        <UBadge
          v-else-if="product.inventoryStatus === 'unconfirmed'"
          color="neutral"
          variant="subtle"
          size="xs"
          class="text-[11px]"
        >
          供货状态待确认
        </UBadge>
      </div>
    </div>
  </NuxtLink>
</template>
