<script setup lang="ts">
import type { ProductDetail, PurchaseTemplateSummary } from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

type Variant = Pick<ProductDetail['variants'][number], 'id' | 'skuCode' | 'retiredAt'>
type AssignmentVersion = { id: string; templateId: string; templateName: string; versionNumber: number }
type ProductAssignment = { productId: string; productRevision: number; mode: 'not_configured' | 'none' | 'template'; templateVersion: AssignmentVersion | null; appliedMode: 'none' | 'template' | null; appliedTemplateVersion: AssignmentVersion | null; pendingApply: boolean }
type SkuAssignment = { productId: string; variantId: string; productRevision: number; mode: 'product_default' | 'none' | 'template'; templateVersion: AssignmentVersion | null; productDefault: ProductAssignment; appliedMode: 'inherit' | 'none' | 'template' | null; appliedTemplateVersion: AssignmentVersion | null; pendingApply: boolean }
type VersionOption = { id: string; templateId: string; versionNumber: number; name: string; createdAt: string }
type ListResponse<T> = { items: T[]; total: number; page: number; pageSize: number }
type VersionResponse = { items: VersionOption[]; total: number; page: number; pageSize: number }
type Lifecycle = { status: 'preparing' | 'active' | 'paused' }

const props = defineProps<{
  productId: string
  productRevision: number
  variants: Variant[]
  disabled?: boolean
}>()
const emit = defineEmits<{ revision: [revision: number] }>()
const { request } = useAdminApi()
const loading = ref(true)
const skuLoading = ref(false)
const saving = ref('')
const errorMessage = ref('')
const successMessage = ref('')
const staleRevision = ref(false)
const templates = ref<PurchaseTemplateSummary[]>([])
const lifecycleStatus = ref<Lifecycle['status']>('preparing')
const selectedVariantId = ref('')
const productAssignment = shallowRef<ProductAssignment | null>(null)
const skuAssignment = shallowRef<SkuAssignment | null>(null)

const productMode = ref<ProductAssignment['mode']>('not_configured')
const productTemplateId = ref('')
const productVersionId = ref('')
const productVersions = ref<VersionOption[]>([])
const productVersionTotal = ref(0)
const productVersionPage = ref(1)
const productVersionsLoading = ref(false)
const skuMode = ref<SkuAssignment['mode']>('product_default')
const skuTemplateId = ref('')
const skuVersionId = ref('')
const skuVersions = ref<VersionOption[]>([])
const skuVersionTotal = ref(0)
const skuVersionPage = ref(1)
const skuVersionsLoading = ref(false)
const activeVariants = computed(() => props.variants.filter(variant => !variant.retiredAt))
const selectedVariant = computed(() => props.variants.find(variant => variant.id === selectedVariantId.value) ?? null)
const skuAssignmentMatchesSelection = computed(() => Boolean(skuAssignment.value
  && skuAssignment.value.productId === props.productId
  && skuAssignment.value.variantId === selectedVariantId.value))
const skuFieldsDisabled = computed(() => props.disabled || staleRevision.value || skuLoading.value || !skuAssignmentMatchesSelection.value)
const skuSaving = computed(() => saving.value.startsWith(`sku:${selectedVariantId.value}:`))
const templateItems = computed(() => templates.value.map(template => ({ label: `${template.name} · ${template.latestVersionNumber} 个版本`, value: template.id })))
const productVersionItems = computed(() => productVersions.value.map(version => ({ label: `v${version.versionNumber} · ${version.name}`, value: version.id })))
const skuVersionItems = computed(() => skuVersions.value.map(version => ({ label: `v${version.versionNumber} · ${version.name}`, value: version.id })))
const productModes = [
  { label: '暂未指定模板', value: 'not_configured' },
  { label: '明确不使用模板', value: 'none' },
  { label: '关联模板版本（准备）', value: 'template' },
]
const skuModes = [
  { label: '跟随商品默认', value: 'product_default' },
  { label: '明确不使用模板', value: 'none' },
  { label: '使用 SKU 覆盖版本（准备）', value: 'template' },
]
function appliedSummary(mode: string | null, version: AssignmentVersion | null): string {
  if (mode === null) return '未应用（继承商品默认）'
  if (mode === 'none') return '已应用：不要求填写'
  return version ? `已应用：${version.templateName} v${version.versionNumber}` : '已应用模板'
}
let generation = 0
let skuRequestGeneration = 0
let skuSaveGeneration = 0
let locallyEmittedRevision: number | null = null
let highestObservedProductRevision = props.productRevision
let productVersionRequest = 0
let skuVersionRequest = 0

function acceptResponseRevision(revision: number, productId: string, currentGeneration: number): boolean {
  if (generation !== currentGeneration || props.productId !== productId || !Number.isSafeInteger(revision)) return false
  const announcedRevision = Math.max(highestObservedProductRevision, props.productRevision)
  // A loaded assignment may know a newer shared revision before the parent does.
  // Reject older bodies, while still announcing a successful write at that revision.
  const knownRevision = Math.max(
    announcedRevision,
    productAssignment.value?.productRevision ?? 0,
    skuAssignment.value?.productRevision ?? 0,
  )
  if (revision < knownRevision) return false
  if (revision > announcedRevision) {
    highestObservedProductRevision = revision
    locallyEmittedRevision = revision
    emit('revision', revision)
  } else highestObservedProductRevision = announcedRevision
  return true
}

function applyObservedRevision(revision: number) {
  if (productAssignment.value) {
    productAssignment.value = { ...productAssignment.value, productRevision: Math.max(productAssignment.value.productRevision, revision) }
  }
  if (skuAssignment.value) {
    skuAssignment.value = { ...skuAssignment.value, productRevision: Math.max(skuAssignment.value.productRevision, revision) }
  }
}

function ensureVersionOption(target: VersionOption[], assignment: AssignmentVersion | null) {
  if (!assignment || target.some(version => version.id === assignment.id)) return target
  return [{ id: assignment.id, templateId: assignment.templateId, versionNumber: assignment.versionNumber, name: assignment.templateName, createdAt: '' }, ...target]
}

async function loadVersions(kind: 'product' | 'sku', templateId: string, current = generation, page = 1, append = false) {
  const requestId = kind === 'product' ? ++productVersionRequest : ++skuVersionRequest
  const isCurrent = () => generation === current
    && requestId === (kind === 'product' ? productVersionRequest : skuVersionRequest)
    && templateId === (kind === 'product' ? productTemplateId.value : skuTemplateId.value)
  if (!templateId) {
    if (kind === 'product') { productVersions.value = []; productVersionTotal.value = 0; productVersionPage.value = 1; productVersionsLoading.value = false }
    else { skuVersions.value = []; skuVersionTotal.value = 0; skuVersionPage.value = 1; skuVersionsLoading.value = false }
    return
  }
  if (kind === 'product') productVersionsLoading.value = true
  else skuVersionsLoading.value = true
  try {
    const result = await request<VersionResponse>(`/api/v1/admin/purchase-form-templates/${templateId}/versions?page=${page}&pageSize=100`)
    if (!isCurrent()) return
    const currentItems = kind === 'product' ? productVersions.value : skuVersions.value
    const items = append
      ? [...currentItems, ...result.items.filter(item => !currentItems.some(existing => existing.id === item.id))]
      : result.items
    if (kind === 'product') {
      productVersions.value = ensureVersionOption(items, productAssignment.value?.templateVersion?.templateId === templateId ? productAssignment.value.templateVersion : null)
      productVersionTotal.value = result.total
      productVersionPage.value = result.page
    } else {
      skuVersions.value = ensureVersionOption(items, skuAssignment.value?.templateVersion?.templateId === templateId ? skuAssignment.value.templateVersion : null)
      skuVersionTotal.value = result.total
      skuVersionPage.value = result.page
    }
  } catch (error) {
    if (isCurrent()) errorMessage.value = error instanceof Error ? error.message : '模板版本列表读取失败。'
  } finally {
    if (isCurrent()) {
      if (kind === 'product') productVersionsLoading.value = false
      else skuVersionsLoading.value = false
    }
  }
}

function loadMoreVersions(kind: 'product' | 'sku') {
  if (kind === 'product') {
    if (productVersionsLoading.value || productVersions.value.length >= productVersionTotal.value) return
    void loadVersions(kind, productTemplateId.value, generation, productVersionPage.value + 1, true)
  } else {
    if (skuVersionsLoading.value || skuVersions.value.length >= skuVersionTotal.value) return
    void loadVersions(kind, skuTemplateId.value, generation, skuVersionPage.value + 1, true)
  }
}

async function loadSkuAssignment(variantId: string, current = generation) {
  const requestId = ++skuRequestGeneration
  skuSaveGeneration++
  const productId = props.productId
  const isCurrent = () => generation === current && skuRequestGeneration === requestId
    && props.productId === productId && selectedVariantId.value === variantId
  skuAssignment.value = null
  skuMode.value = 'product_default'
  skuTemplateId.value = ''
  skuVersionId.value = ''
  skuVersions.value = []
  skuVersionTotal.value = 0
  skuVersionPage.value = 1
  skuVersionRequest++
  if (!variantId) {
    skuLoading.value = false
    return
  }
  skuLoading.value = true
  try {
    const result = await request<SkuAssignment>(`/api/v1/admin/products/${productId}/variants/${variantId}/purchase-form`)
    if (!isCurrent()) return
    if (result.productId !== productId || result.variantId !== variantId) {
      throw new Error('SKU 准备关联响应与当前商品或 SKU 不一致。')
    }
    skuAssignment.value = result
    skuMode.value = result.mode
    skuTemplateId.value = result.templateVersion?.templateId ?? ''
    skuVersionId.value = result.templateVersion?.id ?? ''
    staleRevision.value ||= result.productRevision !== props.productRevision
    await loadVersions('sku', skuTemplateId.value, current)
  } catch (error) {
    if (isCurrent()) errorMessage.value = error instanceof Error ? error.message : 'SKU 模板准备关联读取失败。'
  } finally {
    if (isCurrent()) skuLoading.value = false
  }
}

async function load() {
  const current = ++generation
  skuRequestGeneration++
  skuSaveGeneration++
  skuVersionRequest++
  skuAssignment.value = null
  skuLoading.value = false
  const previousVariantId = selectedVariantId.value
  loading.value = true
  saving.value = ''
  errorMessage.value = ''
  successMessage.value = ''
  staleRevision.value = false
  try {
    const [assignment, templatePage, lifecycle] = await Promise.all([
      request<ProductAssignment>(`/api/v1/admin/products/${props.productId}/purchase-form`),
      request<ListResponse<PurchaseTemplateSummary>>('/api/v1/admin/purchase-form-templates?page=1&pageSize=100'),
      request<Lifecycle>('/api/v1/admin/storefront/purchase-forms'),
    ])
    if (generation !== current || props.productId !== assignment.productId) return
    productAssignment.value = assignment
    templates.value = templatePage.items
    lifecycleStatus.value = lifecycle.status
    productMode.value = assignment.mode
    productTemplateId.value = assignment.templateVersion?.templateId ?? ''
    productVersionId.value = assignment.templateVersion?.id ?? ''
    staleRevision.value = assignment.productRevision !== props.productRevision
    productVersions.value = productTemplateId.value ? ensureVersionOption([], assignment.templateVersion) : []
    selectedVariantId.value = activeVariants.value.some(variant => variant.id === previousVariantId)
      ? previousVariantId
      : activeVariants.value[0]?.id ?? props.variants[0]?.id ?? ''
    await Promise.all([
      loadVersions('product', productTemplateId.value, current),
      loadSkuAssignment(selectedVariantId.value, current),
    ])
  } catch (error) {
    if (generation !== current) return
    errorMessage.value = error instanceof Error ? error.message : '商品填写模板准备关联读取失败。'
  } finally {
    if (generation === current) loading.value = false
  }
}

async function saveProductAssignment() {
  if (!productAssignment.value || props.disabled || saving.value || staleRevision.value) return
  const current = generation
  const productId = props.productId
  saving.value = 'product'
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const result = await request<ProductAssignment>(`/api/v1/admin/products/${productId}/purchase-form`, {
      method: 'PUT',
      body: {
        expectedRevision: productAssignment.value.productRevision,
        mode: productMode.value,
        ...(productMode.value === 'template' ? { templateVersionId: productVersionId.value } : {}),
      },
    })
    if (generation !== current || props.productId !== productId || result.productId !== productId) return
    if (!acceptResponseRevision(result.productRevision, productId, current)) return
    productAssignment.value = result
    productMode.value = result.mode
    productTemplateId.value = result.templateVersion?.templateId ?? ''
    productVersionId.value = result.templateVersion?.id ?? ''
    staleRevision.value = false
    successMessage.value = '商品默认模板准备关联已保存；尚未应用到顾客购买。'
  } catch (error) {
    if (generation !== current) return
    errorMessage.value = error instanceof AdminApiError && error.status === 409 ? `${error.message}请重新读取商品后再保存。` : error instanceof Error ? error.message : '商品默认关联保存失败。'
    if (error instanceof AdminApiError && error.status === 409) staleRevision.value = true
  } finally { if (generation === current) saving.value = '' }
}

async function saveSkuAssignment() {
  if (!skuAssignmentMatchesSelection.value || !skuAssignment.value || !selectedVariant.value
    || skuLoading.value || props.disabled || saving.value || staleRevision.value) return
  const current = generation
  const productId = props.productId
  const variantId = selectedVariantId.value
  const requestId = ++skuSaveGeneration
  const saveToken = `sku:${variantId}:${requestId}`
  const isCurrent = () => generation === current && skuSaveGeneration === requestId
    && props.productId === productId && selectedVariantId.value === variantId
    && skuAssignment.value?.productId === productId && skuAssignment.value.variantId === variantId
  saving.value = saveToken
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const result = await request<SkuAssignment>(`/api/v1/admin/products/${productId}/variants/${variantId}/purchase-form`, {
      method: 'PUT',
      body: {
        expectedRevision: skuAssignment.value.productRevision,
        mode: skuMode.value,
        ...(skuMode.value === 'template' ? { templateVersionId: skuVersionId.value } : {}),
      },
    })
    if (result.productId !== productId || result.variantId !== variantId) return
    // A committed save for an older SKU still advances the shared product
    // revision while this product remains selected, but it must not update a
    // different product after navigation or a newer component load.
    if (!acceptResponseRevision(result.productRevision, productId, current)) return
    if (!isCurrent()) return
    skuAssignment.value = result
    skuMode.value = result.mode
    skuTemplateId.value = result.templateVersion?.templateId ?? ''
    skuVersionId.value = result.templateVersion?.id ?? ''
    staleRevision.value = false
    successMessage.value = `SKU ${selectedVariant.value.skuCode} 准备覆盖已保存；尚未应用到顾客购买。`
  } catch (error) {
    if (!isCurrent()) return
    errorMessage.value = error instanceof AdminApiError && error.status === 409 ? `${error.message}请重新读取商品后再保存。` : error instanceof Error ? error.message : 'SKU 覆盖保存失败。'
    if (error instanceof AdminApiError && error.status === 409) staleRevision.value = true
  } finally { if (saving.value === saveToken) saving.value = '' }
}

async function applyProductAssignment() {
  const assignment = productAssignment.value
  if (!assignment || lifecycleStatus.value === 'preparing' || !assignment.pendingApply || saving.value || staleRevision.value) return
  const detail = `商品默认规则会应用到未单独覆盖的 SKU。当前商品共有 ${activeVariants.value.length} 个有效 SKU；其中单独覆盖的 SKU 仍使用各自规则。已成交订单保持原快照。`
  if (!window.confirm(`确认应用商品购买填写规则？\n\n${detail}`)) return
  saving.value = 'apply-product'
  errorMessage.value = ''
  try {
    await request('/api/v1/admin/products/' + encodeURIComponent(props.productId) + '/purchase-form/apply', {
      method: 'POST', body: {
        expectedRevision: assignment.productRevision,
        expectedMode: assignment.mode,
        expectedTemplateVersionId: assignment.templateVersion?.id ?? null,
      },
    })
    await load()
    successMessage.value = '商品默认规则已应用到当前顾客购买。'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '应用商品购买规则失败。'
  } finally { saving.value = '' }
}

async function applySkuAssignment() {
  const assignment = skuAssignment.value
  const variant = selectedVariant.value
  if (!assignment || !variant || lifecycleStatus.value === 'preparing' || !assignment.pendingApply || saving.value || staleRevision.value) return
  const detail = `SKU ${variant.skuCode} 的购买填写规则将立即作用于新购买。已成交订单保持原快照。自动履约不会收到填写内容；如需处理，请由管理员在订单中查看。`
  if (!window.confirm(`确认应用此 SKU 的购买填写规则？\n\n${detail}`)) return
  saving.value = `apply-sku:${variant.id}`
  errorMessage.value = ''
  try {
    await request(`/api/v1/admin/products/${encodeURIComponent(props.productId)}/variants/${encodeURIComponent(variant.id)}/purchase-form/apply`, {
      method: 'POST', body: {
        expectedRevision: assignment.productRevision,
        expectedMode: assignment.mode,
        expectedTemplateVersionId: assignment.templateVersion?.id ?? null,
      },
    })
    await load()
    successMessage.value = `SKU ${variant.skuCode} 的购买规则已应用。`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '应用 SKU 购买规则失败。'
  } finally { saving.value = '' }
}

watch(() => props.productId, () => {
  highestObservedProductRevision = props.productRevision
  locallyEmittedRevision = null
  void load()
}, { flush: 'sync' })
watch(() => props.productRevision, (revision) => {
  if (revision < highestObservedProductRevision) return
  const previouslyObserved = highestObservedProductRevision
  highestObservedProductRevision = revision
  if (revision === locallyEmittedRevision) {
    locallyEmittedRevision = null
    applyObservedRevision(revision)
    staleRevision.value = false
    return
  }
  if (revision === previouslyObserved) return
  void load()
})
watch(selectedVariantId, (variantId, previous) => {
  if (variantId === previous) return
  skuRequestGeneration++
  skuSaveGeneration++
  skuAssignment.value = null
  skuMode.value = 'product_default'
  skuTemplateId.value = ''
  skuVersionId.value = ''
  skuVersions.value = []
  skuVersionTotal.value = 0
  skuVersionPage.value = 1
  skuVersionRequest++
  skuLoading.value = false
  if (saving.value.startsWith(`sku:${previous}:`)) saving.value = ''
  if (!variantId || loading.value) return
  const current = generation
  errorMessage.value = ''
  successMessage.value = ''
  void loadSkuAssignment(variantId, current)
}, { flush: 'sync' })
watch(productTemplateId, (value, previous) => {
  if (value === previous) return
  if (productAssignment.value?.templateVersion?.templateId !== value) productVersionId.value = ''
  productVersions.value = []
  productVersionTotal.value = 0
  productVersionPage.value = 1
  void loadVersions('product', value)
})
watch(skuTemplateId, (value, previous) => {
  if (value === previous) return
  if (skuAssignment.value?.templateVersion?.templateId !== value) skuVersionId.value = ''
  skuVersions.value = []
  skuVersionTotal.value = 0
  skuVersionPage.value = 1
  void loadVersions('sku', value)
})
onMounted(() => { void load() })
onBeforeUnmount(() => { generation++; skuRequestGeneration++; skuSaveGeneration++ })
</script>

<template>
  <section
    id="purchase-form-preparation"
    aria-labelledby="purchase-form-preparation-title"
    :data-assignment-ready="!loading"
    class="py-6"
  >
    <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="text-sm font-medium text-primary">
          阶段 ⑥-2C-1
        </p>
        <h2
          id="purchase-form-preparation-title"
          class="mt-1 text-lg font-semibold text-highlighted"
        >
          购买填写准备关联
        </h2>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-muted">
          准备关联指向冻结模板版本。保存只更新准备配置；点击“保存并应用”后才会改变新购买要求，已成交订单资料保持不变。
        </p>
      </div>
      <UBadge
        :color="lifecycleStatus === 'active' ? 'success' : lifecycleStatus === 'paused' ? 'warning' : 'neutral'"
        variant="soft"
      >
        {{ lifecycleStatus === 'preparing' ? '尚未首次启用' : lifecycleStatus === 'active' ? '购买填写已启用' : '购买填写已暂停' }}
      </UBadge>
    </header>
    <UAlert
      v-if="staleRevision"
      class="mb-4"
      color="warning"
      variant="soft"
      title="商品修订已变化。"
      description="重新读取最新商品与关联后再保存，避免覆盖其他商品配置。"
      role="alert"
    >
      <template #actions>
        <UButton
          size="sm"
          color="warning"
          variant="outline"
          :loading="loading"
          @click="load"
        >
          重新读取
        </UButton>
      </template>
    </UAlert>
    <UAlert
      v-if="errorMessage"
      class="mb-4"
      color="error"
      variant="soft"
      :title="errorMessage"
      role="alert"
    />
    <UAlert
      v-if="successMessage"
      class="mb-4"
      color="success"
      variant="soft"
      :title="successMessage"
      role="status"
    />
    <USkeleton
      v-if="loading"
      class="h-64 rounded-xl"
      aria-label="读取模板关联"
    />
    <div
      v-else
      class="grid min-w-0 gap-4 xl:grid-cols-2"
    >
      <article class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5">
        <h3 class="font-semibold text-highlighted">
          商品默认模板
        </h3>
        <p class="mt-1 text-sm leading-6 text-muted">
          SKU 选择“跟随商品默认”时使用这里应用的冻结版本。准备更改须明确应用后才会进入顾客购买。
        </p>
        <div class="mt-4 space-y-4">
          <UFormField label="关联方式">
            <USelect
              v-model="productMode"
              :items="productModes"
              class="w-full"
              :disabled="disabled || staleRevision"
            />
          </UFormField>
          <UFormField
            v-if="productMode === 'template'"
            label="本地模板"
          >
            <USelect
              v-model="productTemplateId"
              :items="templateItems"
              class="w-full"
              :disabled="disabled || staleRevision"
              placeholder="选择模板"
            />
          </UFormField>
          <UFormField
            v-if="productMode === 'template'"
            label="冻结版本"
          >
            <USelect
              v-model="productVersionId"
              :items="productVersionItems"
              class="w-full"
              :disabled="disabled || staleRevision || !productTemplateId"
              placeholder="选择版本"
            />
          </UFormField>
          <UButton
            v-if="productVersions.length < productVersionTotal"
            size="sm"
            color="neutral"
            variant="outline"
            class="w-full"
            :loading="productVersionsLoading"
            :disabled="disabled || staleRevision"
            @click="loadMoreVersions('product')"
          >
            加载更多商品版本
          </UButton>
          <p
            v-if="productAssignment?.templateVersion"
            class="break-words text-xs text-muted"
          >
            当前准备版本：{{ productAssignment.templateVersion.templateName }} · v{{ productAssignment.templateVersion.versionNumber }}
          </p>
          <p
            v-if="productAssignment"
            class="text-xs text-muted"
          >
            当前生效规则：{{ appliedSummary(productAssignment.appliedMode, productAssignment.appliedTemplateVersion) }}
          </p>
          <div class="flex justify-end">
            <UButton
              :loading="saving === 'product'"
              :disabled="disabled || staleRevision || !productAssignment || saving !== '' || (productMode === 'template' && (!productTemplateId || !productVersionId))"
              @click="saveProductAssignment"
            >
              保存商品准备关联
            </UButton>
          </div>
          <UButton
            v-if="lifecycleStatus !== 'preparing' && productAssignment?.pendingApply"
            color="primary"
            variant="soft"
            icon="i-lucide-check-check"
            class="w-full min-h-11"
            :loading="saving === 'apply-product'"
            :disabled="disabled || staleRevision || saving !== ''"
            @click="applyProductAssignment"
          >
            保存并应用到顾客购买
          </UButton>
        </div>
      </article>

      <article class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5">
        <h3 class="font-semibold text-highlighted">
          SKU 覆盖
        </h3>
        <p class="mt-1 text-sm leading-6 text-muted">
          无覆盖与“明确不使用模板”含义不同。购买资料会归档到订单，自动履约不会收到这些内容，也不会获得上游采购资格。
        </p>
        <div class="mt-4 space-y-4">
          <UFormField label="SKU">
            <USelect
              v-model="selectedVariantId"
              :items="variants.map(variant => ({ label: `${variant.skuCode}${variant.retiredAt ? ' · 已退役' : ''}`, value: variant.id }))"
              class="w-full"
              :disabled="disabled || variants.length === 0"
              placeholder="选择 SKU"
            />
          </UFormField>
          <UFormField label="覆盖方式">
            <USelect
              v-model="skuMode"
              :items="skuModes"
              class="w-full"
              :disabled="skuFieldsDisabled || !selectedVariant || Boolean(selectedVariant.retiredAt)"
            />
          </UFormField>
          <UFormField
            v-if="skuMode === 'template'"
            label="本地模板"
          >
            <USelect
              v-model="skuTemplateId"
              :items="templateItems"
              class="w-full"
              :disabled="skuFieldsDisabled || Boolean(selectedVariant?.retiredAt)"
              placeholder="选择模板"
            />
          </UFormField>
          <UFormField
            v-if="skuMode === 'template'"
            label="冻结版本"
          >
            <USelect
              v-model="skuVersionId"
              :items="skuVersionItems"
              class="w-full"
              :disabled="skuFieldsDisabled || !skuTemplateId || Boolean(selectedVariant?.retiredAt)"
              placeholder="选择版本"
            />
          </UFormField>
          <UButton
            v-if="skuVersions.length < skuVersionTotal"
            size="sm"
            color="neutral"
            variant="outline"
            class="w-full"
            :loading="skuVersionsLoading"
            :disabled="skuFieldsDisabled || Boolean(selectedVariant?.retiredAt)"
            @click="loadMoreVersions('sku')"
          >
            加载更多 SKU 版本
          </UButton>
          <p
            v-if="skuAssignmentMatchesSelection && skuMode === 'product_default' && productAssignment"
            class="text-xs text-muted"
          >
            当前继承商品默认：{{ productAssignment.mode === 'template' ? `${productAssignment.templateVersion?.templateName} · v${productAssignment.templateVersion?.versionNumber}` : productAssignment.mode === 'none' ? '明确不使用模板' : '暂未指定' }}
          </p>
          <p
            v-else-if="skuAssignmentMatchesSelection && skuAssignment?.templateVersion"
            class="break-words text-xs text-muted"
          >
            当前 SKU 准备版本：{{ skuAssignment.templateVersion.templateName }} · v{{ skuAssignment.templateVersion.versionNumber }}
          </p>
          <p
            v-if="skuAssignmentMatchesSelection && skuAssignment"
            class="text-xs text-muted"
          >
            当前生效规则：{{ appliedSummary(skuAssignment.appliedMode, skuAssignment.appliedTemplateVersion) }}
          </p>
          <div class="flex justify-end">
            <UButton
              :loading="skuSaving"
              :disabled="disabled || staleRevision || skuLoading || !skuAssignmentMatchesSelection || !skuAssignment || !selectedVariant || Boolean(selectedVariant.retiredAt) || saving !== '' || (skuMode === 'template' && (!skuTemplateId || !skuVersionId))"
              @click="saveSkuAssignment"
            >
              保存 SKU 准备覆盖
            </UButton>
          </div>
          <UButton
            v-if="lifecycleStatus !== 'preparing' && skuAssignmentMatchesSelection && skuAssignment?.pendingApply"
            color="primary"
            variant="soft"
            icon="i-lucide-check-check"
            class="w-full min-h-11"
            :loading="saving === `apply-sku:${selectedVariantId}`"
            :disabled="disabled || staleRevision || saving !== '' || skuLoading"
            @click="applySkuAssignment"
          >
            保存并应用此 SKU 规则
          </UButton>
        </div>
      </article>
    </div>
    <p class="mt-3 text-xs leading-5 text-muted">
      模板列表只用于管理员准备关联。公开商品接口不会返回这些关联，也不会打开顾客填写、图片上传、购物车或结算入口。
    </p>
  </section>
</template>
