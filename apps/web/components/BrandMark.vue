<script setup lang="ts">
const props = defineProps<{
  name: string
  logoUrl?: string
}>()

const logoFailed = ref(false)

watch(() => props.logoUrl, () => {
  logoFailed.value = false
})
</script>

<template>
  <span
    class="grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-primary text-sm font-bold text-inverted"
    aria-hidden="true"
  >
    <img
      v-if="logoUrl && !logoFailed"
      :src="logoUrl"
      alt=""
      class="size-full object-contain"
      @error="logoFailed = true"
    >
    <span v-else>{{ name.slice(0, 1) }}</span>
  </span>
</template>
