<script setup lang="ts">
import type { PurchaseFormDefinition, PurchaseTemplateSummary, PurchaseTemplateVersion } from '@aikayun/contracts'
import { validatePurchaseFormDefinition } from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })

type TemplateDetail = {
  template: PurchaseTemplateSummary
  definition: PurchaseFormDefinition
  latestVersion: PurchaseTemplateVersion | null
}
type TemplateVersion = Omit<PurchaseTemplateVersion, 'definition'> & { definition: PurchaseFormDefinition }
type VersionSummary = { id: string; templateId: string; versionNumber: number; name: string; createdAt: string }
type VersionPage = { items: VersionSummary[]; total: number; page: number; pageSize: number }
const route = useRoute()
const { request } = useAdminApi()
const templateId = computed(() => String(route.params.id))
const template = shallowRef<PurchaseTemplateSummary | null>(null)
const persistedDefinition = shallowRef<PurchaseFormDefinition>({ fields: [] })
const definition = ref<PurchaseFormDefinition>({ fields: [] })
const name = ref('')
const persistedIds = ref<Set<string>>(new Set())
const versions = ref<VersionSummary[]>([])
const versionsTotal = ref(0)
const historyPage = ref(1)
const historyLoading = ref(false)
const historyReadLoading = ref(false)
const selectedHistory = shallowRef<TemplateVersion | null>(null)
const selectedHistoryTargetId = ref('')
const loading = ref(true)
const saving = ref(false)
const freezing = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const historyError = ref('')
const isDirty = computed(() => Boolean(template.value && (name.value !== template.value.name || JSON.stringify(definition.value) !== JSON.stringify(persistedDefinition.value))))
const editorBusy = computed(() => saving.value || freezing.value)
const definitionValidation = computed(() => validatePurchaseFormDefinition(definition.value))
const dateLabel = (value: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
let generation = 0
let historyReadGeneration = 0

function collectIds(source: PurchaseFormDefinition) {
  const ids = new Set<string>()
  for (const field of source.fields) {
    ids.add(field.id.toLowerCase())
    if (field.type === 'select') for (const option of field.options) ids.add(option.id.toLowerCase())
    if (field.type !== 'cascade') continue
    const stack = [...field.options]
    while (stack.length) {
      const option = stack.pop()!
      ids.add(option.id.toLowerCase())
      for (const expanded of option.expandedFields ?? []) ids.add(expanded.id.toLowerCase())
      stack.push(...(option.children ?? []))
    }
  }
  return ids
}

async function load(targetId = templateId.value) {
  const current = ++generation
  loading.value = true
  saving.value = false
  freezing.value = false
  errorMessage.value = ''
  successMessage.value = ''
  historyError.value = ''
  historyReadGeneration++
  historyReadLoading.value = false
  selectedHistoryTargetId.value = ''
  selectedHistory.value = null
  versions.value = []
  versionsTotal.value = 0
  historyPage.value = 1
  try {
    const result = await request<TemplateDetail>(`/api/v1/admin/purchase-form-templates/${targetId}`)
    if (generation !== current || targetId !== templateId.value) return
    template.value = result.template
    name.value = result.template.name
    definition.value = structuredClone(result.definition)
    persistedDefinition.value = structuredClone(result.definition)
    persistedIds.value = collectIds(result.definition)
    await loadVersions(targetId, current)
  } catch (error) {
    if (generation !== current) return
    errorMessage.value = error instanceof Error ? error.message : '模板读取失败。'
  } finally {
    if (generation === current) loading.value = false
  }
}

async function loadVersions(targetId = templateId.value, current = generation, page = 1, append = false) {
  historyError.value = ''
  historyLoading.value = true
  try {
    const result = await request<VersionPage>(`/api/v1/admin/purchase-form-templates/${targetId}/versions?page=${page}&pageSize=100`)
    if (generation !== current || targetId !== templateId.value) return
    versions.value = append
      ? [...versions.value, ...result.items.filter(item => !versions.value.some(existing => existing.id === item.id))]
      : result.items
    versionsTotal.value = result.total
    historyPage.value = result.page
  } catch (error) {
    if (generation !== current) return
    historyError.value = error instanceof Error ? error.message : '版本历史暂时无法读取。'
  } finally {
    if (generation === current) historyLoading.value = false
  }
}

async function loadMoreVersions() {
  if (historyLoading.value || versions.value.length >= versionsTotal.value) return
  await loadVersions(templateId.value, generation, historyPage.value + 1, true)
}

async function saveDraft(allowFreeze = false): Promise<boolean> {
  if (!template.value || saving.value || (freezing.value && !allowFreeze) || !definitionValidation.value.ok) return false
  const currentId = templateId.value
  const currentGeneration = generation
  saving.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const result = await request<{ template: PurchaseTemplateSummary; definition: PurchaseFormDefinition }>(`/api/v1/admin/purchase-form-templates/${currentId}`, {
      method: 'PUT',
      body: { expectedRevision: template.value.revision, name: name.value, definition: definition.value },
    })
    if (generation !== currentGeneration || currentId !== templateId.value) return false
    template.value = result.template
    name.value = result.template.name
    definition.value = structuredClone(result.definition)
    persistedDefinition.value = structuredClone(result.definition)
    persistedIds.value = collectIds(result.definition)
    successMessage.value = '编辑草稿已保存；此变更仍未应用到顾客购买。'
    return true
  } catch (error) {
    if (generation === currentGeneration) errorMessage.value = error instanceof AdminApiError && error.status === 409
      ? `${error.message}请重新读取后合并修改。`
      : error instanceof Error ? error.message : '模板保存失败。'
    return false
  } finally {
    if (generation === currentGeneration) saving.value = false
  }
}

async function freezeVersion() {
  if (!template.value || freezing.value || !definitionValidation.value.ok) return
  const currentId = templateId.value
  const currentGeneration = generation
  freezing.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    if (isDirty.value && !(await saveDraft(true))) return
    if (generation !== currentGeneration || currentId !== templateId.value || !template.value) return
    await request<unknown>(`/api/v1/admin/purchase-form-templates/${currentId}/versions`, {
      method: 'POST',
      body: { expectedRevision: template.value.revision },
    })
    if (generation !== currentGeneration || currentId !== templateId.value) return
    await load(currentId)
    if (generation === currentGeneration + 1) successMessage.value = '不可变准备版本已保存；现行购买规则未改变，关联需单独应用。'
  } catch (error) {
    if (generation === currentGeneration) errorMessage.value = error instanceof AdminApiError && error.status === 409
      ? `${error.message}请重新读取后再保存版本。`
      : error instanceof Error ? error.message : '准备版本保存失败。'
  } finally {
    if (generation === currentGeneration) freezing.value = false
  }
}

async function readHistory(version: VersionSummary) {
  const currentId = templateId.value
  const currentGeneration = generation
  const requestId = ++historyReadGeneration
  const targetVersionId = version.id
  selectedHistoryTargetId.value = targetVersionId
  historyError.value = ''
  selectedHistory.value = null
  historyReadLoading.value = true
  const isCurrent = () => generation === currentGeneration && currentId === templateId.value
    && historyReadGeneration === requestId && selectedHistoryTargetId.value === targetVersionId
  try {
    const result = await request<TemplateVersion>(`/api/v1/admin/purchase-form-templates/${currentId}/versions/${targetVersionId}`)
    if (!isCurrent() || result.id !== targetVersionId || result.templateId !== currentId) return
    selectedHistory.value = result
  } catch (error) {
    if (isCurrent()) historyError.value = error instanceof Error ? error.message : '无法读取此历史版本。'
  } finally {
    if (isCurrent()) historyReadLoading.value = false
  }
}

watch(templateId, (nextId, previousId) => {
  if (nextId !== previousId) void load(nextId)
})
onMounted(() => { void load() })
onBeforeUnmount(() => { generation++ })
</script>

<template>
  <UDashboardPanel id="admin-purchase-form-template-editor">
    <template #header>
      <UDashboardNavbar
        title="购买填写模板"
        :toggle="{ size: 'md', class: 'min-h-11 min-w-11' }"
      >
        <template #right>
          <ThemeModeSelect />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <main
        id="admin-main"
        tabindex="-1"
        class="mx-auto w-full max-w-7xl p-4 focus:outline-none sm:p-6 lg:p-8"
      >
        <NuxtLink
          to="/admin/purchase-form-templates"
          class="inline-flex min-h-11 items-center gap-2 text-sm text-muted hover:text-highlighted"
        >
          <UIcon
            name="i-lucide-arrow-left"
            aria-hidden="true"
          />返回模板列表
        </NuxtLink>
        <div
          v-if="loading"
          class="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]"
        >
          <USkeleton class="h-[34rem] rounded-xl" /><USkeleton class="h-[25rem] rounded-xl" />
        </div>
        <template v-else-if="template">
          <header class="mt-3 flex flex-col gap-4 border-b border-default pb-5 sm:flex-row sm:items-end sm:justify-between">
            <div class="min-w-0">
              <p class="text-sm font-medium text-primary">
                模板修订 {{ template.revision }} · {{ template.latestVersionNumber }} 个冻结版本
              </p>
              <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
                {{ template.name }}
              </h1>
              <p class="mt-2 text-sm leading-6 text-muted">
                编辑当前工作定义，并用交互预览检查字段、必填和级联规则。
              </p>
            </div>
            <div class="flex flex-col gap-2 sm:flex-row">
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-save"
                :loading="saving"
                :disabled="!isDirty || !definitionValidation.ok || freezing"
                class="min-h-11"
                @click="() => saveDraft()"
              >
                保存编辑草稿
              </UButton>
              <UButton
                icon="i-lucide-lock-keyhole"
                :loading="freezing"
                :disabled="!definitionValidation.ok || saving"
                class="min-h-11"
                @click="freezeVersion"
              >
                保存为准备配置版本
              </UButton>
            </div>
          </header>

          <UAlert
            class="mt-5"
            color="warning"
            variant="soft"
            icon="i-lucide-shield-alert"
            title="准备配置，尚未应用到顾客购买。"
            description="保存编辑草稿仅更新后台工作定义；保存为准备配置版本会冻结不可变历史。两者都不会启用购买必填要求或开放顾客上传。"
          />
          <UAlert
            v-if="errorMessage"
            class="mt-4"
            color="error"
            variant="soft"
            :title="errorMessage"
            role="alert"
          />
          <UAlert
            v-if="successMessage"
            class="mt-4"
            color="success"
            variant="soft"
            :title="successMessage"
            role="status"
          />
          <UAlert
            v-if="!definitionValidation.ok"
            class="mt-4"
            color="error"
            variant="soft"
            title="模板定义尚未通过结构校验。"
            description="检查字段身份、类型、选项归属及资源上限后再保存。"
            role="alert"
          />

          <div class="mt-6 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)]">
            <div class="min-w-0 space-y-6">
              <UCard>
                <UFormField
                  label="模板名称"
                  required
                  hint="最多 120 个字符；历史版本保留各自名称。"
                >
                  <UInput
                    v-model="name"
                    class="w-full"
                    maxlength="120"
                    :disabled="editorBusy"
                  />
                </UFormField>
              </UCard>
              <UCard>
                <AdminPurchaseFormDefinitionEditor
                  v-model="definition"
                  :persisted-ids="persistedIds"
                  :disabled="editorBusy"
                />
              </UCard>
            </div>
            <aside class="min-w-0 space-y-5 xl:sticky xl:top-4 xl:self-start">
              <AdminPurchaseFormPreview :definition="definition" />
              <UCard>
                <template #header>
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <h2 class="font-semibold text-highlighted">
                        历史版本
                      </h2><p class="mt-1 text-xs text-muted">
                        冻结后不可更改；草稿仍固定引用其版本。
                      </p>
                    </div>
                    <UBadge
                      color="neutral"
                      variant="subtle"
                    >
                      {{ versions.length }} / {{ versionsTotal }}
                    </UBadge>
                  </div>
                </template>
                <UAlert
                  v-if="historyError"
                  color="error"
                  variant="soft"
                  :title="historyError"
                  role="alert"
                />
                <UEmpty
                  v-else-if="!versions.length"
                  icon="i-lucide-history"
                  title="还没有冻结版本"
                  description="保存为准备配置版本后会出现在这里。"
                  size="sm"
                />
                <div
                  v-else
                  class="space-y-2"
                >
                  <button
                    v-for="version in versions"
                    :key="version.id"
                    type="button"
                    class="flex min-h-14 w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    :class="selectedHistory?.id === version.id ? 'border-primary bg-primary/5' : 'border-default hover:bg-muted/40'"
                    @click="readHistory(version)"
                  >
                    <span class="min-w-0"><span class="block font-medium text-highlighted">{{ version.name }} · v{{ version.versionNumber }}</span><span class="mt-1 block text-xs text-muted">{{ dateLabel(version.createdAt) }}</span></span>
                    <UIcon
                      :name="selectedHistory?.id === version.id ? 'i-lucide-check' : 'i-lucide-eye'"
                      class="shrink-0 text-muted"
                      aria-hidden="true"
                    />
                  </button>
                  <UButton
                    v-if="versions.length < versionsTotal"
                    color="neutral"
                    variant="outline"
                    size="sm"
                    block
                    :loading="historyLoading"
                    @click="loadMoreVersions"
                  >
                    加载更早版本
                  </UButton>
                </div>
                <p
                  v-if="historyReadLoading"
                  class="mt-3 text-sm text-muted"
                  role="status"
                >
                  正在读取所选历史版本…
                </p>
                <div
                  v-if="selectedHistory"
                  class="mt-4 border-t border-default pt-4"
                >
                  <p class="mb-3 text-sm font-medium text-highlighted">
                    {{ selectedHistory.name }} · v{{ selectedHistory.versionNumber }}
                  </p>
                  <p class="mb-3 break-all font-mono text-[10px] text-dimmed">
                    SHA-256 {{ selectedHistory.sha256 }}
                  </p>
                  <AdminPurchaseFormPreview
                    :definition="selectedHistory.definition"
                    :readonly="false"
                    title="历史版本交互预览"
                  />
                </div>
              </UCard>
            </aside>
          </div>
        </template>
        <UAlert
          v-else
          class="mt-5"
          color="error"
          variant="soft"
          :title="errorMessage || '模板不可用。'"
          role="alert"
        />
      </main>
    </template>
  </UDashboardPanel>
</template>
