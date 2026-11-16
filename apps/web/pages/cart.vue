<script setup lang="ts">
// Old cart entry safely redirects to storefront home
await navigateTo('/', { replace: true, redirectCode: 302 })
</script>

<template>
  <div />
</template>
