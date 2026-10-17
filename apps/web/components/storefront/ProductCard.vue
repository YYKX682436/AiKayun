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
    class="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-default bg-elevated transition-colors duration-150 ease-out hover:border-primary/40 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    :aria-label="`${product.name}，${priceLabel}`"
  >
    <div class="relative aspect-[4/3] w-full overflow-hidden bg-muted">
      <img
        v-if="product.cover && !imageFailed"
        :src="product.cover.url"
        :alt="product.cover.alt || product.name"
        :width="product.cover.width"
        :height="product.cover.height"
        :loading="priority ? 'eager' : 'lazy'"
        :fetchpriority="priority ? 'high' : 'auto'"
        decoding="async"
        class="h-full w-full object-cover transition-transform duration-200 ease-out motion-reduce:transition-none group-hover:scale-[1.02]"
        @error="imageFailed = true"
      >
      <div
        v-else
        class="flex h-full w-full items-center justify-center text-muted"
        aria-hidden="true"
      >
        <UIcon
          name="i-lucide-image"
          class="size-8"
        />
      </div>
    </div>

    <div class="flex min-h-32 flex-1 flex-col p-3 sm:p-4">
      <div class="flex min-w-0 items-start justify-between gap-2">
        <h2 class="line-clamp-2 min-w-0 text-sm font-medium leading-6 text-highlighted sm:text-base">
          {{ product.name }}
        </h2>
        <UBadge
          color="neutral"
          variant="subtle"
          size="xs"
          class="shrink-0"
        >
          {{ typeLabels[product.productType] }}
        </UBadge>
      </div>

      <p
        v-if="product.description"
        class="mt-1 line-clamp-2 text-sm leading-5 text-muted"
      >
        {{ product.description }}
      </p>

      <div class="mt-auto flex flex-wrap items-end justify-between gap-x-2 gap-y-1 pt-3">
        <p
          class="min-w-0 break-all text-base font-semibold tabular-nums text-highlighted sm:text-lg"
          :class="product.priceRange ? 'text-primary' : 'text-muted'"
        >
          {{ priceLabel }}
        </p>
        <UBadge
          v-if="product.selectionStatus === 'none'"
          color="neutral"
          variant="soft"
          size="xs"
        >
          暂无可选规格
        </UBadge>
        <UBadge
          v-else-if="product.inventoryStatus === 'out_of_stock'"
          color="warning"
          variant="soft"
          size="xs"
        >
          暂时缺货
        </UBadge>
        <UBadge
          v-else-if="product.inventoryStatus === 'unconfirmed'"
          color="neutral"
          variant="subtle"
          size="xs"
        >
          供货状态待确认
        </UBadge>
      </div>
    </div>
  </NuxtLink>
</template>
