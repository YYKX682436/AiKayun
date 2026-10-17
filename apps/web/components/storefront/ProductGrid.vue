<script setup lang="ts">
import type { PublicProductCard } from '@aikayun/contracts'

defineProps<{ products: PublicProductCard[] }>()
</script>

<template>
  <ul class="grid min-w-0 grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
    <li
      v-for="(product, index) in products"
      :key="product.id"
      class="min-w-0"
    >
      <StorefrontProductCard
        :product="product"
        :priority="index === 0"
      />
    </li>
  </ul>
</template>
