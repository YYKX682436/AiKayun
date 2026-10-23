<script setup lang="ts">
import type { SupplierPurchaseOption } from '@aikayun/contracts'
defineProps<{ options: SupplierPurchaseOption[] }>()
</script>

<template>
  <ul class="space-y-2 border-l border-default pl-3 text-sm">
    <li
      v-for="(option, index) in options"
      :key="index"
      class="min-w-0 break-words"
    >
      <p>{{ option.name }} <span class="text-muted">值：{{ JSON.stringify(option.value) }}</span></p>
      <AdminSupplierPurchaseOptions
        v-if="option.children.length"
        :options="option.children"
        class="mt-2"
      />
      <div
        v-for="(field, fieldIndex) in option.expand"
        :key="fieldIndex"
        class="mt-2 rounded-md bg-muted/40 p-2"
      >
        <p>扩展填写项 {{ fieldIndex + 1 }} · 类型 {{ field.type ?? '未知' }} · {{ field.title ?? '未提供标题' }}</p>
        <AdminSupplierPurchaseOptions
          v-if="field.options.length"
          :options="field.options"
          class="mt-2"
        />
      </div>
    </li>
  </ul>
</template>
