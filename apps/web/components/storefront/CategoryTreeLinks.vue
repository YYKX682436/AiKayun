<script setup lang="ts">
import type { PublicCategory } from '@aikayun/contracts'

defineOptions({ name: 'CategoryTreeLinks' })

withDefaults(defineProps<{
  categories: PublicCategory[]
  currentId?: string
}>(), { currentId: '' })

defineEmits<{ navigate: [] }>()

const route = useRoute()
</script>

<template>
  <ul class="space-y-1">
    <li
      v-for="category in categories"
      :key="category.id"
    >
      <NuxtLink
        :to="`/categories/${category.id}`"
        class="flex min-h-11 items-center rounded-lg px-3 text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
        :class="route.path === `/categories/${category.id}` ? 'bg-primary/10 font-medium text-primary' : 'text-default'"
        :aria-current="route.path === `/categories/${category.id}` ? 'page' : undefined"
        @click="$emit('navigate')"
      >
        {{ category.name }}
      </NuxtLink>

      <div
        v-if="categories.some(child => child.parentId === category.id)"
        class="ml-3 border-l border-default pl-2"
      >
        <StorefrontCategoryTreeLinks
          :categories="categories.filter(child => child.parentId === category.id)"
          :current-id="currentId"
          @navigate="$emit('navigate')"
        />
      </div>
    </li>
  </ul>
</template>
