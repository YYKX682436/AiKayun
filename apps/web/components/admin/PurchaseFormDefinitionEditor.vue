<script setup lang="ts">
import type { PurchaseFormDefinition, PurchaseFormField, PurchaseFormLeafField } from '@aikayun/contracts'

const props = defineProps<{
  modelValue: PurchaseFormDefinition
  persistedIds?: ReadonlySet<string>
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [definition: PurchaseFormDefinition] }>()
const fieldType = ref('text')
const addFieldItems = [
  { label: '单行文本', value: 'text' },
  { label: '多行文本', value: 'textarea' },
  { label: '数字字符', value: 'digits' },
  { label: '单项选择', value: 'select' },
  { label: '级联选择', value: 'cascade' },
  { label: '私有图片', value: 'image' },
]
const persisted = computed(() => props.persistedIds ?? new Set<string>())

function updateField(index: number, field: PurchaseFormField) {
  const fields = [...props.modelValue.fields]
  fields[index] = field
  emit('update:modelValue', { fields })
}
function removeField(index: number) {
  emit('update:modelValue', { fields: props.modelValue.fields.filter((_, fieldIndex) => fieldIndex !== index) })
}
function moveField(index: number, delta: -1 | 1) {
  const nextIndex = index + delta
  if (nextIndex < 0 || nextIndex >= props.modelValue.fields.length) return
  const fields = [...props.modelValue.fields]
  ;[fields[index], fields[nextIndex]] = [fields[nextIndex]!, fields[index]!]
  emit('update:modelValue', { fields })
}
function addField() {
  if (props.modelValue.fields.length >= 30) return
  const id = crypto.randomUUID()
  const common = { id, meaningKey: `field_${id.slice(0, 8)}`, label: '新字段', required: false }
  let field: PurchaseFormField
  if (fieldType.value === 'cascade') {
    const optionId = crypto.randomUUID()
    field = { ...common, type: 'cascade', options: [{ id: optionId, meaningKey: `option_${optionId.slice(0, 8)}`, label: '一级选项' }] }
  } else if (fieldType.value === 'select') {
    const optionId = crypto.randomUUID()
    field = { ...common, type: 'select', options: [{ id: optionId, meaningKey: `option_${optionId.slice(0, 8)}`, label: '选项一' }] }
  } else if (fieldType.value === 'image') {
    field = { ...common, type: 'image', maxCount: 1 }
  } else {
    const type = fieldType.value as 'text' | 'textarea' | 'digits'
    field = { ...common, type, maxLength: type === 'digits' ? 128 : 1000 }
  }
  emit('update:modelValue', { fields: [...props.modelValue.fields, field as PurchaseFormLeafField] })
}
</script>

<template>
  <section
    aria-labelledby="purchase-form-fields-title"
    class="space-y-3"
  >
    <header class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2
          id="purchase-form-fields-title"
          class="text-lg font-semibold text-highlighted"
        >
          字段定义
        </h2>
        <p class="mt-1 text-sm leading-6 text-muted">
          字段和选项使用独立 ID。改标题或顺序会保留身份；业务含义改变时请删除后新建。
        </p>
      </div>
      <div class="flex gap-2">
        <USelect
          v-model="fieldType"
          :items="addFieldItems"
          class="min-w-36"
          :disabled="disabled || modelValue.fields.length >= 30"
        />
        <UButton
          icon="i-lucide-plus"
          :disabled="disabled || modelValue.fields.length >= 30"
          @click="addField"
        >
          添加字段
        </UButton>
      </div>
    </header>

    <UEmpty
      v-if="modelValue.fields.length === 0"
      icon="i-lucide-list-plus"
      title="还没有字段"
      description="添加字段后，可在右侧预览真实填写交互。"
    />
    <div
      v-else
      class="space-y-3"
    >
      <div
        v-for="(field, index) in modelValue.fields"
        :key="field.id"
        class="min-w-0 space-y-2"
      >
        <div class="flex justify-end gap-1">
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-arrow-up"
            :aria-label="`字段 ${index + 1} 上移`"
            :disabled="disabled || index === 0"
            @click="moveField(index, -1)"
          />
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-arrow-down"
            :aria-label="`字段 ${index + 1} 下移`"
            :disabled="disabled || index === modelValue.fields.length - 1"
            @click="moveField(index, 1)"
          />
        </div>
        <AdminPurchaseFormFieldEditor
          :field="field"
          :index="index"
          :persisted-ids="persisted"
          :disabled="disabled"
          @update:field="updateField(index, $event)"
          @remove="removeField(index)"
        />
      </div>
    </div>
    <p class="text-xs leading-5 text-muted">
      上限：30 个顶层字段、60 个总字段、每层 20 个选项、级联最多 5 层；模板定义最大 48 KiB。
    </p>
  </section>
</template>
