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
    class="flex flex-wrap items-center justify-between gap-3 border-t border-default pt-4"
    aria-label="商品分页"
  >
    <p
      class="text-sm text-muted"
      aria-live="polite"
    >
      第 {{ page }} / {{ totalPages }} 页
    </p>
    <div class="flex items-center gap-2">
      <UButton
        :to="page > 1 ? pageTo(page - 1) : undefined"
        color="neutral"
        variant="outline"
        class="min-h-11"
        :disabled="page <= 1"
        rel="prev"
      >
        上一页
      </UButton>
      <UButton
        :to="page < totalPages ? pageTo(page + 1) : undefined"
        color="neutral"
        variant="outline"
        class="min-h-11"
        :disabled="page >= totalPages"
        rel="next"
      >
        下一页
      </UButton>
    </div>
  </nav>
</template>
