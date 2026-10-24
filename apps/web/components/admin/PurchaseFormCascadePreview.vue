<script setup lang="ts">
import type { PurchaseFormCascadeOption, PurchaseFormField, PurchaseFormLeafField } from '@aikayun/contracts'

const props = defineProps<{
  field: Extract<PurchaseFormField, { type: 'cascade' }>
  modelValue: unknown
  errors: ReadonlySet<string>
  readonly?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>()

type CascadeValue = { path: string[]; expanded: Record<string, unknown> }
function currentValue(): CascadeValue {
  if (!props.modelValue || typeof props.modelValue !== 'object' || Array.isArray(props.modelValue)) return { path: [], expanded: {} }
  const candidate = props.modelValue as { path?: unknown; expanded?: unknown }
  return {
    path: Array.isArray(candidate.path) ? candidate.path.filter((value): value is string => typeof value === 'string') : [],
    expanded: candidate.expanded && typeof candidate.expanded === 'object' && !Array.isArray(candidate.expanded)
      ? candidate.expanded as Record<string, unknown>
      : {},
  }
}

const selectedPath = computed(() => currentValue().path)
const levels = computed(() => {
  const result: Array<{ level: number; options: PurchaseFormCascadeOption[] }> = []
  let options = props.field.options
  for (let level = 0; level < 5 && options.length; level += 1) {
    result.push({ level, options })
    const selectedId = selectedPath.value[level]
    const selected = options.find(option => option.id.toLowerCase() === selectedId?.toLowerCase())
    if (!selected || !selected.children?.length) break
    options = selected.children
  }
  return result
})
const activeExpandedFields = computed(() => {
  const result: PurchaseFormLeafField[] = []
  let options = props.field.options
  for (const optionId of selectedPath.value) {
    const option = options.find(candidate => candidate.id.toLowerCase() === optionId.toLowerCase())
    if (!option) break
    result.push(...(option.expandedFields ?? []))
    options = option.children ?? []
  }
  return result
})
function updateLevel(level: number, rawValue: string) {
  const current = currentValue()
  const path = current.path.slice(0, level)
  if (rawValue) path.push(rawValue)
  const nextActive = new Set<string>()
  let options = props.field.options
  for (const optionId of path) {
    const option = options.find(candidate => candidate.id.toLowerCase() === optionId.toLowerCase())
    if (!option) break
    for (const field of option.expandedFields ?? []) nextActive.add(field.id.toLowerCase())
    options = option.children ?? []
  }
  const expanded = Object.fromEntries(Object.entries(current.expanded).filter(([id]) => nextActive.has(id.toLowerCase())))
  emit('update:modelValue', { path, expanded })
}

function updateExpanded(id: string, value: unknown) {
  const current = currentValue()
  emit('update:modelValue', { ...current, expanded: { ...current.expanded, [id.toLowerCase()]: value } })
}
</script>

<template>
  <div class="space-y-3">
    <UFormField
      :label="field.label"
      :required="field.required"
      :error="errors.has(field.id.toLowerCase()) ? '请选择完整路径。' : undefined"
      :hint="field.helpText"
    >
      <div class="grid gap-3 sm:grid-cols-2">
        <UFormField
          v-for="row in levels"
          :key="row.level"
          :label="`第 ${row.level + 1} 层`"
          :required="field.required"
        >
          <USelect
            :model-value="selectedPath[row.level]"
            :items="row.options.map(option => ({ label: option.label, value: option.id }))"
            class="w-full"
            :disabled="readonly"
            :aria-label="`${field.label}第 ${row.level + 1} 层`"
            @update:model-value="updateLevel(row.level, String($event ?? ''))"
          />
        </UFormField>
      </div>
    </UFormField>
    <div
      v-if="activeExpandedFields.length"
      class="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3 sm:p-4"
    >
      <p class="text-xs font-medium text-muted">
        当前分支附加资料
      </p>
      <AdminPurchaseFormPreviewField
        v-for="expanded in activeExpandedFields"
        :key="expanded.id"
        :field="expanded"
        :model-value="currentValue().expanded[expanded.id.toLowerCase()]"
        :error="errors.has(expanded.id.toLowerCase()) ? '请检查此字段。' : undefined"
        @update:model-value="updateExpanded(expanded.id, $event)"
      />
    </div>
  </div>
</template>
