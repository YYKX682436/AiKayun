<script setup lang="ts">
import type { PublicProductCard } from '@aikayun/contracts'

withDefaults(defineProps<{
  products: PublicProductCard[]
  priorityFirst?: boolean
}>(), {
  priorityFirst: true,
})
</script>

<template>
  <ul class="grid min-w-0 grid-cols-2 gap-3.5 sm:gap-4.5 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-5">
    <li
      v-for="(product, index) in products"
      :key="product.id"
      class="min-w-0"
    >
      <StorefrontProductCard
        :product="product"
        :priority="priorityFirst && index === 0"
      />
    </li>
  </ul>
</template>
