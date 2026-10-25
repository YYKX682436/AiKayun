<script setup lang="ts">
import type { PurchaseFormLeafField } from '@aikayun/contracts'

type Attachment = { id: string; fieldId: string; url: string; mimeType: string; byteSize: number }
const props = defineProps<{
  field: PurchaseFormLeafField
  modelValue: unknown
  errorText?: string
  attachments?: Attachment[]
  disabled?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: unknown]
  upload: [file: File, replaceAttachmentId?: string]
  remove: [attachmentId: string]
}>()

const attachmentIds = computed(() => Array.isArray(props.modelValue)
  ? props.modelValue.filter((value): value is string => typeof value === 'string') : [])
const fieldAttachments = computed(() => (props.attachments ?? []).filter(attachment =>
  attachment.fieldId.toLowerCase() === props.field.id.toLowerCase()
  && attachmentIds.value.includes(attachment.id),
))
const fileInput = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const uploading = ref(false)
const localPreview = ref('')
const replacementId = computed(() => {
  const field = props.field
  return field.type === 'image' && field.maxCount === 1 ? fieldAttachments.value[0]?.id : undefined
})
const replaceMode = computed(() => replacementId.value !== undefined)

watch(selectedFile, (file, oldFile) => {
  if (localPreview.value) URL.revokeObjectURL(localPreview.value)
  localPreview.value = file ? URL.createObjectURL(file) : ''
  if (oldFile && !file) uploading.value = false
})
onBeforeUnmount(() => { if (localPreview.value) URL.revokeObjectURL(localPreview.value) })

function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  if (file) selectedFile.value = file
}
function startUpload() {
  if (!selectedFile.value || uploading.value || props.disabled) return
  uploading.value = true
  emit('upload', selectedFile.value, replacementId.value)
}
watch(() => props.disabled, (disabled) => { if (!disabled) uploading.value = false })
</script>

<template>
  <UFormField
    :label="field.label"
    :required="field.required"
    :description="field.helpText"
    :error="errorText"
    :name="`purchase-${field.id}`"
    class="min-w-0"
  >
    <UInput
      v-if="field.type === 'text'"
      :model-value="typeof modelValue === 'string' ? modelValue : ''"
      class="w-full"
      :maxlength="field.maxLength ?? 4000"
      :placeholder="field.placeholder"
      :disabled="disabled"
      :aria-invalid="Boolean(errorText)"
      @update:model-value="emit('update:modelValue', String($event))"
    />
    <UTextarea
      v-else-if="field.type === 'textarea'"
      :model-value="typeof modelValue === 'string' ? modelValue : ''"
      class="w-full"
      :rows="4"
      :maxlength="field.maxLength ?? 4000"
      :placeholder="field.placeholder"
      :disabled="disabled"
      :aria-invalid="Boolean(errorText)"
      @update:model-value="emit('update:modelValue', String($event))"
    />
    <UInput
      v-else-if="field.type === 'digits'"
      :model-value="typeof modelValue === 'string' ? modelValue : ''"
      class="w-full font-mono"
      inputmode="numeric"
      autocomplete="off"
      :maxlength="field.maxLength ?? 4000"
      :placeholder="field.placeholder"
      :disabled="disabled"
      :aria-invalid="Boolean(errorText)"
      @update:model-value="emit('update:modelValue', String($event).replace(/[^0-9]/gu, ''))"
    />
    <USelect
      v-else-if="field.type === 'select'"
      :model-value="typeof modelValue === 'string' ? modelValue : undefined"
      :items="field.options.map(option => ({ label: option.label, value: option.id }))"
      class="w-full"
      :disabled="disabled"
      :aria-invalid="Boolean(errorText)"
      @update:model-value="emit('update:modelValue', String($event))"
    />
    <div
      v-else
      class="space-y-3 rounded-xl border border-default bg-muted/20 p-3"
    >
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <figure
          v-for="attachment in fieldAttachments"
          :key="attachment.id"
          class="relative overflow-hidden rounded-lg border border-default bg-default"
        >
          <img
            :src="attachment.url"
            :alt="`${field.label}已上传图片`"
            class="aspect-square w-full object-cover"
            loading="lazy"
            decoding="async"
          >
          <UButton
            type="button"
            color="neutral"
            variant="solid"
            size="xs"
            icon="i-lucide-x"
            :aria-label="`删除${field.label}图片`"
            class="absolute right-1 top-1 min-h-8 min-w-8 justify-center"
            :disabled="disabled"
            @click="emit('remove', attachment.id)"
          />
          <figcaption class="px-2 py-1 text-xs text-muted">
            {{ Math.ceil(attachment.byteSize / 1024) }} KB
          </figcaption>
        </figure>
        <figure
          v-if="localPreview"
          class="overflow-hidden rounded-lg border border-primary bg-default"
        >
          <img
            :src="localPreview"
            :alt="`${field.label}待上传预览`"
            class="aspect-square w-full object-cover"
          >
          <figcaption class="px-2 py-1 text-xs text-primary">
            待上传：{{ selectedFile?.name }}
          </figcaption>
        </figure>
      </div>
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label class="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-default bg-default px-3 text-sm font-medium text-highlighted hover:border-primary focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary">
          <UIcon
            name="i-lucide-image-plus"
            aria-hidden="true"
          />
          {{ replaceMode ? '选择替换图片' : '选择图片' }}
          <input
            ref="fileInput"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            class="sr-only"
            :disabled="disabled"
            :aria-label="`${field.label}上传图片`"
            @change="chooseFile"
          >
        </label>
        <UButton
          type="button"
          color="primary"
          variant="soft"
          icon="i-lucide-upload"
          class="min-h-11 justify-center"
          :loading="uploading"
          :disabled="disabled || !selectedFile"
          @click="startUpload"
        >
          上传并保存
        </UButton>
        <span class="text-xs leading-5 text-muted">JPEG、PNG 或 WebP，单张不超过 5 MB。上传内容会私密保存。</span>
      </div>
    </div>
  </UFormField>
</template>
