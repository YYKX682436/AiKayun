<script setup lang="ts">
import type { PurchaseFormCascadeOption, PurchaseFormLeafField } from '@aikayun/contracts'

defineOptions({ name: 'AdminPurchaseFormCascadeOptionEditor' })
const props = defineProps<{
  option: PurchaseFormCascadeOption
  persistedIds: ReadonlySet<string>
  depth: number
  disabled?: boolean
}>()
const emit = defineEmits<{
  'update:option': [option: PurchaseFormCascadeOption]
  remove: []
}>()
const locked = computed(() => props.disabled || props.persistedIds.has(props.option.id.toLowerCase()))

function update(patch: Partial<PurchaseFormCascadeOption>) {
  emit('update:option', { ...props.option, ...patch })
}
function addChild() {
  if (props.depth >= 5 || (props.option.children?.length ?? 0) >= 20) return
  const id = crypto.randomUUID()
  update({ children: [...(props.option.children ?? []), { id, meaningKey: `option_${id.slice(0, 8)}`, label: `子选项 ${(props.option.children?.length ?? 0) + 1}` }] })
}
function addExpandedField() {
  if ((props.option.expandedFields?.length ?? 0) >= 60) return
  const id = crypto.randomUUID()
  const field: PurchaseFormLeafField = { id, meaningKey: `field_${id.slice(0, 8)}`, type: 'text', label: '扩展字段', required: false, maxLength: 1000 }
  update({ expandedFields: [...(props.option.expandedFields ?? []), field] })
}
function updateExpanded(index: number, field: PurchaseFormLeafField) {
  const fields = [...(props.option.expandedFields ?? [])]
  fields[index] = field
  update({ expandedFields: fields })
}
function removeExpanded(index: number) {
  update({ expandedFields: (props.option.expandedFields ?? []).filter((_, fieldIndex) => fieldIndex !== index) })
}
function updateChild(index: number, option: PurchaseFormCascadeOption) {
  const children = [...(props.option.children ?? [])]
  children[index] = option
  update({ children })
}
function removeChild(index: number) {
  update({ children: (props.option.children ?? []).filter((_, optionIndex) => optionIndex !== index) })
}
</script>

<template>
  <article class="min-w-0 rounded-lg border border-default bg-muted/20 p-3">
    <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
      <UFormField
        :label="`第 ${depth} 层选项名称`"
        required
      >
        <UInput
          :model-value="option.label"
          class="w-full"
          maxlength="120"
          :disabled="disabled"
          @update:model-value="update({ label: String($event) })"
        />
      </UFormField>
      <UFormField
        label="稳定业务标识"
        :hint="locked ? '已保存身份不可更名。' : '首次保存后锁定。'"
      >
        <UInput
          :model-value="option.meaningKey"
          class="w-full font-mono"
          maxlength="64"
          :disabled="locked"
          @update:model-value="update({ meaningKey: String($event).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, 'option_').slice(0, 64) })"
        />
      </UFormField>
      <UButton
        color="error"
        variant="ghost"
        icon="i-lucide-trash-2"
        aria-label="删除此级联选项"
        :disabled="disabled"
        @click="emit('remove')"
      />
    </div>
    <p class="mt-2 break-all font-mono text-[11px] text-dimmed">
      ID {{ option.id }}
    </p>

    <div class="mt-3 flex flex-wrap gap-2">
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-list-plus"
        :disabled="disabled || depth >= 5 || (option.children?.length ?? 0) >= 20"
        @click="addChild"
      >
        添加下一层
      </UButton>
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-text-cursor-input"
        :disabled="disabled || (option.expandedFields?.length ?? 0) >= 60"
        @click="addExpandedField"
      >
        添加所选分支字段
      </UButton>
    </div>

    <div
      v-if="option.expandedFields?.length"
      class="mt-3 space-y-2 border-l-2 border-primary/30 pl-3"
    >
      <p class="text-xs font-medium text-muted">
        选择此项后显示的字段
      </p>
      <AdminPurchaseFormLeafFieldEditor
        v-for="(field, index) in option.expandedFields"
        :key="field.id"
        :field="field"
        :index="index"
        :persisted-ids="persistedIds"
        :disabled="disabled"
        @update:field="updateExpanded(index, $event)"
        @remove="removeExpanded(index)"
      />
    </div>

    <div
      v-if="option.children?.length"
      class="mt-3 space-y-2 border-l-2 border-default pl-3"
    >
      <p class="text-xs font-medium text-muted">
        子选项
      </p>
      <AdminPurchaseFormCascadeOptionEditor
        v-for="(child, index) in option.children"
        :key="child.id"
        :option="child"
        :persisted-ids="persistedIds"
        :depth="depth + 1"
        :disabled="disabled"
        @update:option="updateChild(index, $event)"
        @remove="removeChild(index)"
      />
    </div>
  </article>
</template>
