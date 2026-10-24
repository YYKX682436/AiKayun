<script setup lang="ts">
import type { PurchaseFormDefinition, PurchaseFormValues } from '@aikayun/contracts'
import { normalizePurchaseFormAnswers } from '@aikayun/contracts'

const props = defineProps<{
  definition: PurchaseFormDefinition
  readonly?: boolean
  title?: string
}>()
const values = ref<PurchaseFormValues>({})
const checked = ref(false)
const errors = ref(new Map<string, string>())
const incompleteIds = ref<string[]>([])
watch(() => props.definition, () => {
  values.value = {}
  errors.value = new Map()
  incompleteIds.value = []
  checked.value = false
}, { deep: true })

function setValue(id: string, value: unknown) {
  if (props.readonly) return
  values.value = { ...values.value, [id.toLowerCase()]: value }
  if (checked.value) validate()
}

function validate() {
  const result = normalizePurchaseFormAnswers(props.definition, values.value, { requireComplete: true, attachmentIds: new Set() })
  const nextErrors = new Map<string, string>()
  if (!result.ok) {
    for (const issue of result.issues) if (issue.fieldId) nextErrors.set(issue.fieldId.toLowerCase(), issue.code)
  }
  errors.value = nextErrors
  incompleteIds.value = result.ok ? result.incompleteFieldIds : []
  checked.value = true
}

function displayError(id: string) {
  const code = errors.value.get(id.toLowerCase())
  if (!code) return incompleteIds.value.some(fieldId => fieldId.toLowerCase() === id.toLowerCase()) ? '此项尚未填写。' : undefined
  if (code.includes('CASCADE') || code.includes('OPTION')) return '请选择有效的选项路径。'
  if (code.includes('ATTACHMENT')) return '图片尚未上传或不属于此字段。'
  return '请检查此字段的填写内容。'
}
</script>

<template>
  <section
    class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
    aria-labelledby="purchase-form-preview-title"
  >
    <header class="mb-4">
      <div class="flex items-start gap-3">
        <span class="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><UIcon
          name="i-lucide-eye"
          aria-hidden="true"
        /></span>
        <div class="min-w-0">
          <h2
            id="purchase-form-preview-title"
            class="font-semibold text-highlighted"
          >
            {{ title ?? '交互预览' }}
          </h2>
          <p class="mt-1 text-xs leading-5 text-muted">
            预览使用本地字段、级联路径与同一份规范化校验；不连接顾客数据或上传服务。
          </p>
        </div>
      </div>
    </header>
    <div
      v-if="checked && (incompleteIds.length || errors.size)"
      class="mb-4 rounded-lg border border-warning/30 bg-warning/5 p-3"
      role="status"
      aria-live="polite"
    >
      <p class="text-sm font-medium text-highlighted">
        还有 {{ incompleteIds.length + errors.size }} 项需要检查
      </p>
      <ul class="mt-2 space-y-1 text-xs text-muted">
        <li
          v-for="id in incompleteIds"
          :key="`incomplete-${id}`"
        >
          必填或级联路径未完成：<code>{{ id }}</code>
        </li>
        <li
          v-for="id in errors.keys()"
          :key="`error-${id}`"
        >
          格式或选项无效：<code>{{ id }}</code>
        </li>
      </ul>
    </div>
    <UAlert
      v-else-if="checked"
      color="success"
      variant="soft"
      icon="i-lucide-check-circle-2"
      title="填写完整，当前仅为后台预览。"
      class="mb-4"
    />

    <div
      v-if="definition.fields.length"
      class="space-y-4"
    >
      <template
        v-for="field in definition.fields"
        :key="field.id"
      >
        <AdminPurchaseFormPreviewField
          v-if="field.type !== 'cascade'"
          :field="field"
          :model-value="values[field.id.toLowerCase()]"
          :error="displayError(field.id)"
          @update:model-value="setValue(field.id, $event)"
        />
        <AdminPurchaseFormCascadePreview
          v-else
          :field="field"
          :model-value="values[field.id.toLowerCase()]"
          :errors="new Set([...(errors.keys()), ...incompleteIds])"
          :readonly="readonly"
          @update:model-value="setValue(field.id, $event)"
        />
      </template>
    </div>
    <UEmpty
      v-else
      icon="i-lucide-list-checks"
      title="预览区等待字段"
      description="添加字段后，可以在此测试填写和级联交互。"
      size="sm"
    />

    <UButton
      v-if="!readonly"
      class="mt-5 w-full justify-center"
      color="neutral"
      variant="outline"
      icon="i-lucide-list-checks"
      @click="validate"
    >
      检查填写完整性
    </UButton>
  </section>
</template>
