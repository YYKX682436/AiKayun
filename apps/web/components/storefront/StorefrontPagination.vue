<script setup lang="ts">
import type { LocationQueryRaw } from 'vue-router'

const props = defineProps<{
  page: number
  totalPages: number
  query: LocationQueryRaw
}>()

const route = useRoute()

function pageTo(page: number): { path: string; query: LocationQueryRaw } {
  const query: LocationQueryRaw = { ...props.query }
  delete query.page
  if (page > 1) query.page = String(page)
  return { path: route.path, query }
}
</script>

<template>
  <nav
    v-if="totalPages > 1"
    class="flex flex-wrap items-center justify-between gap-3 border-t border-default/60 pt-5 sm:pt-6"
    aria-label="商品分页"
  >
    <p
      class="text-xs text-dimmed sm:text-sm"
      aria-live="polite"
    >
      第 <span class="font-medium text-highlighted tabular-nums">{{ page }}</span> / <span class="tabular-nums">{{ totalPages }}</span> 页
    </p>
    <div class="flex items-center gap-2">
      <UButton
        :to="page > 1 ? pageTo(page - 1) : undefined"
        color="neutral"
        variant="outline"
        class="min-h-10 rounded-xl px-3 sm:px-4 text-xs sm:text-sm"
        :disabled="page <= 1"
        rel="prev"
      >
        上一页
      </UButton>
      <UButton
        :to="page < totalPages ? pageTo(page + 1) : undefined"
        color="neutral"
        variant="outline"
        class="min-h-10 rounded-xl px-3 sm:px-4 text-xs sm:text-sm"
        :disabled="page >= totalPages"
        rel="next"
      >
        下一页
      </UButton>
    </div>
  </nav>
</template>
