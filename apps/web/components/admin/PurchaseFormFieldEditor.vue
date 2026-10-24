<script setup lang="ts">
import type { PurchaseFormCascadeOption, PurchaseFormField, PurchaseFormLeafField } from '@aikayun/contracts'

const props = defineProps<{
  field: PurchaseFormField
  index: number
  persistedIds: ReadonlySet<string>
  disabled?: boolean
}>()
const emit = defineEmits<{
  'update:field': [field: PurchaseFormField]
  remove: []
}>()
const cascadeLocked = computed(() => props.disabled || props.persistedIds.has(props.field.id.toLowerCase()))

function update(patch: Record<string, unknown>) {
  if (props.disabled) return
  emit('update:field', { ...props.field, ...patch } as PurchaseFormField)
}
function updateOption(index: number, option: PurchaseFormCascadeOption) {
  if (props.disabled || props.field.type !== 'cascade') return
  const options = [...props.field.options]
  options[index] = option
  update({ options })
}
function removeOption(index: number) {
  if (props.disabled || props.field.type !== 'cascade' || props.field.options.length <= 1) return
  update({ options: props.field.options.filter((_, optionIndex) => optionIndex !== index) })
}
function addOption() {
  if (props.disabled || props.field.type !== 'cascade' || props.field.options.length >= 20) return
  const id = crypto.randomUUID()
  update({ options: [...props.field.options, { id, meaningKey: `option_${id.slice(0, 8)}`, label: `选项 ${props.field.options.length + 1}` }] })
}
</script>

<template>
  <div v-if="field.type !== 'cascade'">
    <AdminPurchaseFormLeafFieldEditor
      :field="field as PurchaseFormLeafField"
      :index="index"
      :persisted-ids="persistedIds"
      :disabled="disabled"
      @update:field="emit('update:field', $event)"
      @remove="emit('remove')"
    />
  </div>
  <article
    v-else
    class="min-w-0 rounded-xl border border-default bg-elevated p-3 sm:p-4"
  >
    <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
      <UFormField
        :label="`级联字段 ${index + 1} 名称`"
        required
      >
        <UInput
          :model-value="field.label"
          class="w-full"
          maxlength="120"
          :disabled="disabled"
          @update:model-value="update({ label: String($event) })"
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
          aria-label="删除级联字段"
          :disabled="disabled"
          @click="emit('remove')"
        />
      </div>
    </div>
    <div class="mt-3 grid gap-3 sm:grid-cols-2">
      <UFormField
        label="稳定业务标识"
        :hint="cascadeLocked ? '已保存身份不可更名。' : '首次保存后锁定。'"
      >
        <UInput
          :model-value="field.meaningKey"
          class="w-full font-mono"
          maxlength="64"
          :disabled="cascadeLocked"
          @update:model-value="update({ meaningKey: String($event).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, 'field_').slice(0, 64) })"
        />
      </UFormField>
      <UFormField
        label="字段身份"
        hint="选择顺序和标题可修改，身份保持不变。"
      >
        <code class="flex min-h-10 items-center rounded-md border border-default bg-muted/30 px-3 text-xs text-muted">{{ field.id }}</code>
      </UFormField>
    </div>
    <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
      <h4 class="text-sm font-semibold text-highlighted">
        级联选项与分支字段
      </h4>
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-plus"
        :disabled="disabled || field.options.length >= 20"
        @click="addOption"
      >
        添加一级选项
      </UButton>
    </div>
    <div class="mt-3 space-y-3">
      <AdminPurchaseFormCascadeOptionEditor
        v-for="(option, optionIndex) in field.options"
        :key="option.id"
        :option="option"
        :persisted-ids="persistedIds"
        :depth="1"
        :disabled="disabled"
        @update:option="updateOption(optionIndex, $event)"
        @remove="removeOption(optionIndex)"
      />
    </div>
  </article>
</template>
