<script setup lang="ts">
import { validatePurchaseFormDefinition, type PurchaseFormDefinition, type PurchaseFormField } from '@aikayun/contracts'

type Attachment = { id: string; fieldId: string; url: string; byteSize?: number }
const props = defineProps<{
  definition: unknown
  values: Record<string, unknown> | null
  attachments?: Attachment[]
  title?: string
}>()

const parsedDefinition = computed<PurchaseFormDefinition | null>(() => {
  const result = validatePurchaseFormDefinition(props.definition)
  return result.ok ? result.value : null
})
const answer = computed(() => props.values ?? {})
const attachmentById = computed(() => new Map((props.attachments ?? []).map(item => [item.id.toLowerCase(), item])))

function display(field: Exclude<PurchaseFormField, { type: 'cascade' }>, value: unknown): string {
  if (field.type === 'image') return ''
  if (field.type === 'select') {
    const id = typeof value === 'string' ? value.toLowerCase() : ''
    return field.options.find(option => option.id.toLowerCase() === id)?.label ?? '（未填写）'
  }
  return typeof value === 'string' && value.length ? value : '（未填写）'
}

function cascadeValue(field: Extract<PurchaseFormField, { type: 'cascade' }>) {
  const raw = answer.value[field.id.toLowerCase()]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { path: [] as string[], expanded: {} as Record<string, unknown> }
  const value = raw as { path?: unknown; expanded?: unknown }
  return {
    path: Array.isArray(value.path) ? value.path.filter((entry): entry is string => typeof entry === 'string') : [],
    expanded: value.expanded && typeof value.expanded === 'object' && !Array.isArray(value.expanded) ? value.expanded as Record<string, unknown> : {},
  }
}

function cascadeRows(field: Extract<PurchaseFormField, { type: 'cascade' }>) {
  const value = cascadeValue(field)
  const pathLabels: string[] = []
  const expanded: Array<{ field: Exclude<PurchaseFormField, { type: 'cascade' }>; value: unknown }> = []
  let options = field.options
  for (const optionId of value.path) {
    const option = options.find(candidate => candidate.id.toLowerCase() === optionId.toLowerCase())
    if (!option) break
    pathLabels.push(option.label)
    for (const nested of option.expandedFields ?? []) {
      expanded.push({ field: nested, value: value.expanded[nested.id.toLowerCase()] })
    }
    options = (option.children ?? []) as typeof field.options
    if (!options.length) break
  }
  return { path: pathLabels.join(' / ') || '（未填写）', expanded }
}

function imagesFor(fieldId: string, value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((id) => {
    if (typeof id !== 'string') return []
    const attachment = attachmentById.value.get(id.toLowerCase())
    return attachment && attachment.fieldId.toLowerCase() === fieldId.toLowerCase() ? [attachment] : []
  })
}
</script>

<template>
  <section
    class="rounded-xl border border-default bg-default p-3 sm:p-4"
    aria-label="成交时保存的购买资料"
  >
    <h3 class="font-semibold text-highlighted">
      {{ title ?? '购买资料' }}
    </h3>
    <dl
      v-if="parsedDefinition && values"
      class="mt-3 space-y-3"
    >
      <template
        v-for="field in parsedDefinition.fields"
        :key="field.id"
      >
        <div
          v-if="field.type !== 'cascade' && field.type !== 'image'"
          class="grid gap-1 sm:grid-cols-[minmax(8rem,0.7fr)_minmax(0,1.3fr)] sm:gap-3"
        >
          <dt class="text-sm text-muted">
            {{ field.label }}
          </dt>
          <dd class="min-w-0 whitespace-pre-wrap break-words text-sm text-highlighted">
            {{ display(field, answer[field.id.toLowerCase()]) }}
          </dd>
        </div>
        <div
          v-else-if="field.type === 'image'"
          class="space-y-2"
        >
          <dt class="text-sm text-muted">
            {{ field.label }}
          </dt>
          <dd>
            <div
              v-if="imagesFor(field.id, answer[field.id.toLowerCase()]).length"
              class="grid grid-cols-2 gap-2 sm:grid-cols-3"
            >
              <a
                v-for="image in imagesFor(field.id, answer[field.id.toLowerCase()])"
                :key="image.id"
                :href="image.url"
                target="_blank"
                rel="noreferrer"
                class="block overflow-hidden rounded-lg border border-default focus-visible:outline-2 focus-visible:outline-primary"
              >
                <img
                  :src="image.url"
                  :alt="`${field.label}成交附件`"
                  class="aspect-square w-full object-contain"
                  loading="lazy"
                  decoding="async"
                >
              </a>
            </div>
            <span
              v-else
              class="text-sm text-highlighted"
            >（未填写）</span>
          </dd>
        </div>
        <div
          v-else
          class="space-y-2"
        >
          <div class="grid gap-1 sm:grid-cols-[minmax(8rem,0.7fr)_minmax(0,1.3fr)] sm:gap-3">
            <dt class="text-sm text-muted">
              {{ field.label }}
            </dt>
            <dd class="min-w-0 break-words text-sm text-highlighted">
              {{ cascadeRows(field).path }}
            </dd>
          </div>
          <div
            v-for="row in cascadeRows(field).expanded"
            :key="row.field.id"
            class="grid gap-1 sm:grid-cols-[minmax(8rem,0.7fr)_minmax(0,1.3fr)] sm:gap-3"
          >
            <dt class="text-sm text-muted">
              {{ row.field.label }}
            </dt>
            <dd
              v-if="row.field.type === 'image'"
              class="min-w-0"
            >
              <div
                v-if="imagesFor(row.field.id, row.value).length"
                class="grid grid-cols-2 gap-2 sm:grid-cols-3"
              >
                <a
                  v-for="image in imagesFor(row.field.id, row.value)"
                  :key="image.id"
                  :href="image.url"
                  target="_blank"
                  rel="noreferrer"
                  class="block overflow-hidden rounded-lg border border-default"
                >
                  <img
                    :src="image.url"
                    :alt="`${row.field.label}成交附件`"
                    class="aspect-square w-full object-contain"
                    loading="lazy"
                    decoding="async"
                  >
                </a>
              </div>
              <span
                v-else
                class="text-sm text-highlighted"
              >（未填写）</span>
            </dd>
            <dd
              v-else
              class="min-w-0 whitespace-pre-wrap break-words text-sm text-highlighted"
            >
              {{ display(row.field, row.value) }}
            </dd>
          </div>
        </div>
      </template>
    </dl>
    <p
      v-else
      class="mt-2 text-sm text-muted"
    >
      此购买行没有可显示的填写资料。
    </p>
  </section>
</template>
