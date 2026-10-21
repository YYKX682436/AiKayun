<script setup lang="ts">
import { computed } from 'vue'
import { renderSecureMarkdown } from '~/utils/secure-markdown'

const props = defineProps<{ content: string }>()
const rendered = computed(() => renderSecureMarkdown(props.content))
</script>

<template>
  <!-- eslint-disable vue/no-v-html -->
  <article
    class="secure-markdown break-words text-sm leading-6 text-default [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-elevated [&_code]:px-1 [&_code]:py-0.5 [&_li]:ml-5 [&_li]:list-disc [&_ol_li]:list-decimal [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-default [&_pre]:bg-elevated [&_pre]:p-3 [&_ul]:my-2"
    v-html="rendered"
  />
  <!-- eslint-enable vue/no-v-html -->
</template>

<style scoped>
.secure-markdown :deep(p) { margin: 0.65rem 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.secure-markdown :deep(h1), .secure-markdown :deep(h2), .secure-markdown :deep(h3) {
  margin: 1rem 0 0.5rem;
  font-weight: 650;
  line-height: 1.35;
}
.secure-markdown :deep(h1) { font-size: 1.25rem; }
.secure-markdown :deep(h2) { font-size: 1.125rem; }
.secure-markdown :deep(h3) { font-size: 1rem; }
.secure-markdown :deep(hr) { margin: 1rem 0; border-color: var(--ui-border); }
.secure-markdown :deep(pre code) { background: transparent; padding: 0; }
</style>
