<script setup lang="ts">
import type { PurchaseFormLeafField } from '@aikayun/contracts'

const props = defineProps<{
  field: PurchaseFormLeafField
  modelValue: unknown
  error?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>()
const selectItems = computed(() => props.field.type === 'select'
  ? props.field.options.map(option => ({ label: option.label, value: option.id }))
  : [])

function updateValue(value: unknown) { emit('update:modelValue', value) }
</script>

<template>
  <UFormField
    :label="field.label"
    :required="field.required"
    :error="error"
    :hint="field.helpText"
  >
    <UInput
      v-if="field.type === 'text'"
      :model-value="typeof modelValue === 'string' ? modelValue : ''"
      class="w-full"
      :maxlength="field.maxLength ?? 1000"
      :placeholder="field.placeholder"
      :aria-invalid="Boolean(error)"
      @update:model-value="updateValue(String($event))"
    />
    <UTextarea
      v-else-if="field.type === 'textarea'"
      :model-value="typeof modelValue === 'string' ? modelValue : ''"
      class="w-full"
      :rows="3"
      :maxlength="field.maxLength ?? 1000"
      :placeholder="field.placeholder"
      :aria-invalid="Boolean(error)"
      @update:model-value="updateValue(String($event))"
    />
    <UInput
      v-else-if="field.type === 'digits'"
      :model-value="typeof modelValue === 'string' ? modelValue : ''"
      class="w-full font-mono"
      inputmode="numeric"
      :maxlength="field.maxLength ?? 128"
      :placeholder="field.placeholder"
      :aria-invalid="Boolean(error)"
      @update:model-value="updateValue(String($event))"
    />
    <USelect
      v-else-if="field.type === 'select'"
      :model-value="typeof modelValue === 'string' ? modelValue : undefined"
      :items="selectItems"
      class="w-full"
      :aria-invalid="Boolean(error)"
      @update:model-value="updateValue(String($event))"
    />
    <div
      v-else
      class="rounded-lg border border-dashed border-default bg-muted/20 p-3"
    >
      <label class="flex min-h-11 cursor-not-allowed items-center justify-center gap-2 rounded-md border border-default px-3 text-sm text-muted">
        <UIcon
          name="i-lucide-image-plus"
          aria-hidden="true"
        />
        顾客图片上传本轮尚未开放
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled
          class="sr-only"
          :aria-label="`${field.label}图片上传预览（未启用）`"
        >
      </label>
      <p class="mt-2 text-xs text-muted">
        私有附件基础已实现；此处预览不创建附件或访问顾客数据。
      </p>
    </div>
  </UFormField>
</template>
