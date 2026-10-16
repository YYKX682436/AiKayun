<script setup lang="ts">
defineProps<{
  name: string
  logoUrl?: string
}>()
</script>

<template>
  <span
    class="grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-primary text-sm font-bold text-inverted"
    aria-hidden="true"
  >
    <img
      v-if="logoUrl"
      :src="logoUrl"
      alt=""
      class="size-full object-contain"
    >
    <span v-else>{{ name.slice(0, 1) }}</span>
  </span>
</template>
