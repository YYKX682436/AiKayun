<script setup lang="ts">
import { zh_cn } from '@nuxt/ui/locale'
import { computed } from 'vue'
import { createStorefrontThemeStyle } from '~/utils/store-brand'

const route = useRoute()
const storeBrand = useStoreBrand()
const isAdminArea = computed(() => route.path.startsWith('/admin'))
const storeThemeStyle = computed(() => createStorefrontThemeStyle(storeBrand.value.storeBrandColor))
useHead(() => ({
  titleTemplate: (titleChunk) => {
    if (isAdminArea.value) return titleChunk ? `${titleChunk} · AiKayun` : 'AiKayun 管理后台'
    return titleChunk ? `${titleChunk} · ${storeBrand.value.storeName}` : storeBrand.value.storeName
  },
  htmlAttrs: {
    'data-aikayun-area': computed(() => isAdminArea.value ? 'admin' : 'storefront'),
    style: computed(() => isAdminArea.value ? undefined : storeThemeStyle.value),
  },
}))
</script>

<template>
  <UApp :locale="zh_cn">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
