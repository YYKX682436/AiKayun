<script setup lang="ts">
import type { PurchaseFormLeafField } from '@aikayun/contracts'

const props = defineProps<{
  field: PurchaseFormLeafField
  persistedIds: ReadonlySet<string>
  disabled?: boolean
  index?: number
}>()
const emit = defineEmits<{
  'update:field': [field: PurchaseFormLeafField]
  remove: []
}>()

const locked = computed(() => props.disabled || props.persistedIds.has(props.field.id.toLowerCase()))
const fieldTypeItems = [
  { label: '单行文本', value: 'text' },
  { label: '多行文本', value: 'textarea' },
  { label: '数字字符', value: 'digits' },
  { label: '单项选择', value: 'select' },
  { label: '私有图片', value: 'image' },
]

function update(patch: Record<string, unknown>) {
  emit('update:field', { ...props.field, ...patch } as PurchaseFormLeafField)
}

function changeType(type: string) {
  const base = {
    id: props.field.id,
    meaningKey: props.field.meaningKey,
    label: props.field.label,
    required: props.field.required,
  }
  if (type === 'select') {
    update({ ...base, type, options: [{ id: crypto.randomUUID(), meaningKey: `option_${crypto.randomUUID().slice(0, 8)}`, label: '选项一' }] })
  } else if (type === 'image') {
    update({ ...base, type, maxCount: 1 })
  } else {
    update({ ...base, type, maxLength: type === 'digits' ? 128 : 1000 })
  }
}

function addOption() {
  if (props.field.type !== 'select' || props.field.options.length >= 20) return
  const options = [...props.field.options, { id: crypto.randomUUID(), meaningKey: `option_${crypto.randomUUID().slice(0, 8)}`, label: `选项 ${props.field.options.length + 1}` }]
  update({ options })
}

function updateOption(index: number, patch: Record<string, string>) {
  if (props.field.type !== 'select') return
  const options = [...props.field.options]
  options[index] = { ...options[index]!, ...patch }
  update({ options })
}

function removeOption(index: number) {
  if (props.field.type !== 'select' || props.field.options.length <= 1) return
  update({ options: props.field.options.filter((_, optionIndex) => optionIndex !== index) })
}
</script>

<template>
  <article class="min-w-0 rounded-xl border border-default bg-default p-3 sm:p-4">
    <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
      <UFormField
        :label="`字段${index !== undefined ? ` ${index + 1}` : ''}名称`"
        required
      >
        <UInput
          :model-value="field.label"
          class="w-full"
          maxlength="120"
          :disabled="disabled"
          @update:model-value="update({ label: $event })"
        />
      </UFormField>
      <UFormField label="字段类型">
        <USelect
          :model-value="field.type"
          :items="fieldTypeItems"
          class="w-full"
          :disabled="locked"
          @update:model-value="changeType(String($event))"
        />
      </UFormField>
      <div class="flex min-h-11 items-center gap-3">
        <UCheckbox
          :model-value="field.required"
          label="必填"
          :disabled="disabled"
          @update:model-value="update({ required: Boolean($event) })"
        />
        <UButton
          color="error"
          variant="ghost"
          icon="i-lucide-trash-2"
          :disabled="disabled"
          aria-label="删除字段"
          @click="emit('remove')"
        />
      </div>
    </div>

    <div class="mt-3 grid gap-3 sm:grid-cols-2">
      <UFormField
        label="稳定业务标识"
        :hint="locked ? '已保存身份不可更名；业务含义改变时请新建字段。' : '首次保存后锁定。'"
      >
        <UInput
          :model-value="field.meaningKey"
          class="w-full font-mono"
          maxlength="64"
          :disabled="locked"
          @update:model-value="update({ meaningKey: String($event).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, 'field_').slice(0, 64) })"
        />
      </UFormField>
      <UFormField
        label="字段身份"
        hint="改标题或排序不会改变此 ID。"
      >
        <code class="flex min-h-10 items-center rounded-md border border-default bg-muted/30 px-3 text-xs text-muted">{{ field.id }}</code>
      </UFormField>
    </div>

    <div
      v-if="field.type === 'text' || field.type === 'textarea' || field.type === 'digits'"
      class="mt-3 grid gap-3 sm:grid-cols-2"
    >
      <UFormField label="提示文字（可选）">
        <UInput
          :model-value="field.placeholder ?? ''"
          class="w-full"
          maxlength="180"
          :disabled="disabled"
          @update:model-value="update({ placeholder: String($event) || undefined })"
        />
      </UFormField>
      <UFormField
        label="最大字符数"
        hint="数字字符按原始字符串保存，不做数值转换。"
      >
        <UInput
          :model-value="String(field.maxLength ?? (field.type === 'digits' ? 128 : 1000))"
          type="number"
          min="1"
          max="4000"
          class="w-full"
          :disabled="disabled"
          @update:model-value="update({ maxLength: Number($event) })"
        />
      </UFormField>
    </div>

    <div
      v-if="field.type === 'select'"
      class="mt-4 space-y-2"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h4 class="text-sm font-medium text-highlighted">
          选项
        </h4>
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-plus"
          :disabled="disabled || field.options.length >= 20"
          @click="addOption"
        >
          添加选项
        </UButton>
      </div>
      <div
        v-for="(option, optionIndex) in field.options"
        :key="option.id"
        class="grid gap-2 rounded-lg border border-default p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
      >
        <UFormField
          :label="`选项 ${optionIndex + 1}`"
          required
        >
          <UInput
            :model-value="option.label"
            class="w-full"
            maxlength="120"
            :disabled="disabled"
            @update:model-value="updateOption(optionIndex, { label: String($event) })"
          />
        </UFormField>
        <UFormField label="稳定业务标识">
          <UInput
            :model-value="option.meaningKey"
            class="w-full font-mono"
            maxlength="64"
            :disabled="disabled || persistedIds.has(option.id.toLowerCase())"
            @update:model-value="updateOption(optionIndex, { meaningKey: String($event).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, 'option_').slice(0, 64) })"
          />
        </UFormField>
        <UButton
          color="error"
          variant="ghost"
          icon="i-lucide-x"
          :aria-label="`删除选项 ${optionIndex + 1}`"
          :disabled="disabled || field.options.length <= 1"
          @click="removeOption(optionIndex)"
        />
      </div>
    </div>

    <div
      v-if="field.type === 'image'"
      class="mt-3 grid gap-3 sm:grid-cols-2"
    >
      <UFormField
        label="最多图片数"
        hint="每字段最多 3 张；每张最多 5 MiB。"
      >
        <USelect
          :model-value="String(field.maxCount)"
          :items="[1, 2, 3].map(value => ({ label: `${value} 张`, value: String(value) }))"
          class="w-full"
          :disabled="disabled"
          @update:model-value="update({ maxCount: Number($event) })"
        />
      </UFormField>
      <p class="self-end text-sm leading-6 text-muted">
        此字段只建立私有图片准备能力。本轮没有开放顾客上传入口。
      </p>
    </div>
  </article>
</template>
