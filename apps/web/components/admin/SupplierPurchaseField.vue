<script setup lang="ts">
import type { SupplierPurchaseField } from '@aikayun/contracts'
defineProps<{ field: SupplierPurchaseField; label?: string }>()
function fieldType(value: number | null): string {
  return value === null ? '未知类型' : ({ 0: '单行文本', 1: '图片', 13: '数字', 14: '单项选择', 15: '多行文本', 16: '级联选择' }[value] ?? `未知类型 ${value}`)
}
function fieldRequired(field: SupplierPurchaseField): string {
  return field.required === null ? '必填性未知' : field.required ? '必填' : '选填'
}
</script>

<template>
  <div class="min-w-0 break-words text-sm">
    <p class="font-medium">
      {{ label }}{{ field.title ?? '标题未提供' }} · {{ fieldType(field.type) }} · {{ fieldRequired(field) }}
    </p>
    <p
      v-if="field.placeholder"
      class="mt-1 text-muted"
    >
      提示：{{ field.placeholder }}
    </p>
    <p
      v-if="field.regex"
      class="mt-1 text-muted"
    >
      校验说明（不执行）：{{ field.regex }}
    </p>
    <AdminSupplierPurchaseOptions
      v-if="field.options.length"
      :options="field.options"
      class="mt-2"
    />
  </div>
</template>
