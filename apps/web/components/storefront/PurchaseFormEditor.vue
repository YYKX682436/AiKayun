<script setup lang="ts">
import type { PurchaseFormDefinition, PurchaseFormField, PurchaseFormLeafField } from '@aikayun/contracts'

type Attachment = { id: string; fieldId: string; url: string; mimeType: string; byteSize: number; replacesAttachmentId?: string }
type CascadeValue = { path: string[]; expanded: Record<string, unknown> }
const props = defineProps<{
  definition: PurchaseFormDefinition
  modelValue: Record<string, unknown>
  attachments?: Attachment[]
  errors?: Record<string, string>
  disabled?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: Record<string, unknown>]
  upload: [fieldId: string, file: File, replaceAttachmentId?: string, cascadeId?: string]
  remove: [fieldId: string, attachmentId: string, cascadeId?: string]
}>()

function valueId(id: string) { return id.toLowerCase() }
function cascadeValue(field: PurchaseFormField): CascadeValue {
  const raw = props.modelValue[valueId(field.id)]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { path: [], expanded: {} }
  const value = raw as { path?: unknown; expanded?: unknown }
  return {
    path: Array.isArray(value.path) ? value.path.filter((entry): entry is string => typeof entry === 'string') : [],
    expanded: value.expanded && typeof value.expanded === 'object' && !Array.isArray(value.expanded)
      ? value.expanded as Record<string, unknown> : {},
  }
}
function cascadeNodes(field: PurchaseFormField) {
  if (field.type !== 'cascade') return []
  const value = cascadeValue(field)
  const nodes: Array<{ depth: number; options: typeof field.options; selected: string; expanded: PurchaseFormLeafField[] }> = []
  let options = field.options
  for (let depth = 0; depth < 5 && options.length; depth++) {
    const selected = value.path[depth] ?? ''
    const selectedOption = options.find(option => valueId(option.id) === valueId(selected))
    nodes.push({ depth, options, selected: selectedOption?.id ?? '', expanded: selectedOption?.expandedFields ?? [] })
    if (!selectedOption?.children?.length) break
    options = selectedOption.children as typeof field.options
  }
  return nodes
}
function setValue(fieldId: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [valueId(fieldId)]: value })
}
function setCascadePath(field: PurchaseFormField, depth: number, selectedId: string) {
  const current = cascadeValue(field)
  const path = current.path.slice(0, depth)
  if (selectedId) path.push(selectedId)
  // A branch change clears hidden extension values so old answers cannot be submitted.
  setValue(field.id, { path, expanded: {} } satisfies CascadeValue)
}
function setExpanded(field: PurchaseFormField, expandedFieldId: string, value: unknown) {
  const current = cascadeValue(field)
  setValue(field.id, { ...current, expanded: { ...current.expanded, [valueId(expandedFieldId)]: value } } satisfies CascadeValue)
}
</script>

<template>
  <div class="space-y-4">
    <template
      v-for="field in definition.fields"
      :key="field.id"
    >
      <StorefrontPurchaseFormLeafControl
        v-if="field.type !== 'cascade'"
        :field="field"
        :model-value="modelValue[valueId(field.id)]"
        :attachments="attachments"
        :error-text="errors?.[valueId(field.id)]"
        :disabled="disabled"
        @update:model-value="setValue(field.id, $event)"
        @upload="(file, oldId) => emit('upload', field.id, file, oldId)"
        @remove="attachmentId => emit('remove', field.id, attachmentId)"
      />
      <UFormField
        v-else
        :label="field.label"
        :required="field.required"
        :description="field.helpText"
        :error="errors?.[valueId(field.id)]"
        :name="`purchase-${field.id}`"
        class="min-w-0"
      >
        <div class="space-y-3">
          <USelect
            v-for="node in cascadeNodes(field)"
            :key="`${field.id}:${node.depth}`"
            :model-value="node.selected || undefined"
            :items="node.options.map(option => ({ label: option.label, value: option.id }))"
            :placeholder="node.depth === 0 ? '请选择' : `请选择第 ${node.depth + 1} 级`"
            class="w-full"
            :disabled="disabled || (node.depth > 0 && !cascadeNodes(field)[node.depth - 1]?.selected)"
            :aria-label="`${field.label}第 ${node.depth + 1} 级`"
            @update:model-value="setCascadePath(field, node.depth, String($event))"
          />
          <template
            v-for="node in cascadeNodes(field)"
            :key="`${field.id}:expanded:${node.depth}`"
          >
            <StorefrontPurchaseFormLeafControl
              v-for="expandedField in node.expanded"
              :key="expandedField.id"
              :field="expandedField"
              :model-value="cascadeValue(field).expanded[valueId(expandedField.id)]"
              :attachments="attachments"
              :error-text="errors?.[valueId(expandedField.id)]"
              :disabled="disabled"
              @update:model-value="setExpanded(field, expandedField.id, $event)"
              @upload="(file, oldId) => emit('upload', expandedField.id, file, oldId, field.id)"
              @remove="attachmentId => emit('remove', expandedField.id, attachmentId, field.id)"
            />
          </template>
        </div>
      </UFormField>
    </template>
  </div>
</template>
