<script setup lang="ts">
import type {
  AdminProductPricingPreview,
  AdminProductPricingPreviewItem,
  AdminProductPricingRuleHistory,
  AdminProductPricingRuleHistoryItem,
  AdminProductPricingRuleItem,
  AdminProductPricingRulesBatchResult,
  AdminProductPricingRulesPage,
  ProductPricingMode,
  RestoreAdminProductPricingRuleResult,
} from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

const props = defineProps<{
  productId: string
  productRevision: number
  archived: boolean
}>()

const emit = defineEmits<{
  revisionChanged: [revision: number]
  pricesChanged: []
  dirtyChanged: [dirty: boolean]
}>()
const { request } = useAdminApi()

type RuleDraft = { mode: ProductPricingMode; fixedProfit: string; markupRate: string }
type PreviewContext = { productId: string; productRevision: number; page: number; inputGeneration: number; selectedIds: string[] }
type RestoreCandidate = { productId: string; skuId: string; skuCode: string; version: AdminProductPricingRuleHistoryItem }
const page = shallowRef<AdminProductPricingRulesPage | null>(null)
const preview = shallowRef<AdminProductPricingPreview | null>(null)
const previewContext = shallowRef<PreviewContext | null>(null)
const history = shallowRef<AdminProductPricingRuleHistory | null>(null)
const historySkuId = ref('')
const restoreCandidate = shallowRef<RestoreCandidate | null>(null)
const drafts = reactive<Record<string, RuleDraft>>({})
const selected = reactive<Record<string, boolean>>({})
const draftEditGenerations = reactive<Record<string, number>>({})
const loading = ref(false)
const working = ref('')
const pageNumber = ref(1)
const rulesRequestGeneration = ref(0)
const historyRequestGeneration = ref(0)
const operationGeneration = ref(0)
const previewRequestGeneration = ref(0)
const inputGeneration = ref(0)
const historyLoading = ref(false)
const error = ref('')
const message = ref('')
const historyError = ref('')
const historyOpen = ref(false)
const confirmationOpen = ref(false)
const restoreConfirmationOpen = ref(false)
const confirmedPreview = ref(false)
const confirmedRisks = ref(false)

const modeItems = [
  { label: '手动售价', value: 'manual' },
  { label: '成本 + 固定利润', value: 'fixed_profit' },
  { label: '按成本加价率', value: 'percentage_markup' },
]

const selectedIds = computed(() => (page.value?.items ?? [])
  .filter(row => selected[row.skuId] && row.retiredAt === null)
  .map(row => row.skuId))
const selectedIdsKey = computed(() => [...selectedIds.value].sort().join('|'))
function rowIsDirty(row: AdminProductPricingRuleItem) {
  const draft = drafts[row.skuId]
  if (!draft) return false
  return draft.mode !== row.mode
    || (draft.mode === 'fixed_profit' && draft.fixedProfit.trim() !== (row.fixedProfit ?? ''))
    || (draft.mode === 'percentage_markup' && draft.markupRate.trim() !== (row.markupRate ?? ''))
}
const dirty = computed(() => (page.value?.items ?? []).some((row) => {
  return rowIsDirty(row)
}))
const previewIsCurrent = computed(() => {
  const context = previewContext.value
  return Boolean(preview.value && context && !dirty.value
    && context.productId === props.productId
    && context.productRevision === page.value?.productRevision
    && context.page === pageNumber.value
    && context.inputGeneration === inputGeneration.value
    && context.selectedIds.join('|') === [...selectedIds.value].sort().join('|')
    && preview.value.productId === props.productId
    && preview.value.productRevision === context.productRevision
    && [...preview.value.items.map(item => item.skuId)].sort().join('|') === context.selectedIds.join('|'))
})
const requiresRiskAck = computed(() => (preview.value?.items ?? []).some(item =>
  item.risks.includes('NEGATIVE_PROFIT') || item.risks.includes('FREE_PRICE')))
const canConfirmApply = computed(() => previewIsCurrent.value && Boolean(preview.value?.items.length)
  && preview.value!.items.every(item => item.canApply)
  && confirmedPreview.value
  && (!requiresRiskAck.value || confirmedRisks.value)
  && !props.archived
  && !working.value)
const historyItems = computed(() => history.value?.productId === props.productId
  && history.value.skuId === historySkuId.value
  ? history.value.items
  : [])
const canConfirmRestore = computed(() => {
  const candidate = restoreCandidate.value
  return Boolean(candidate && candidate.productId === props.productId
    && candidate.skuId === historySkuId.value
    && history.value?.productId === candidate.productId
    && history.value.skuId === candidate.skuId
    && history.value.items.some(item => item.id === candidate.version.id && item.skuId === candidate.skuId)
    && !props.archived && !working.value)
})

function draftFromServer(row: AdminProductPricingRuleItem) {
  drafts[row.skuId] = { mode: row.mode, fixedProfit: row.fixedProfit ?? '', markupRate: row.markupRate ?? '' }
}

function syncDraftsFromPage(
  items: AdminProductPricingRuleItem[],
  editGenerationsAtStart: Record<string, number>,
  dirtyIdsAtStart: Set<string>,
) {
  for (const row of items) {
    const changedWhileLoading = (draftEditGenerations[row.skuId] ?? 0) !== (editGenerationsAtStart[row.skuId] ?? 0)
    if (!dirtyIdsAtStart.has(row.skuId) && !changedWhileLoading) draftFromServer(row)
    if (selected[row.skuId] === undefined) selected[row.skuId] = row.retiredAt === null
  }
}

function invalidatePreview() {
  previewRequestGeneration.value += 1
  if (working.value === 'preview') working.value = ''
  preview.value = null
  previewContext.value = null
  confirmationOpen.value = false
  confirmedPreview.value = false
  confirmedRisks.value = false
}

function onDraftEdited(skuId: string) {
  draftEditGenerations[skuId] = (draftEditGenerations[skuId] ?? 0) + 1
  inputGeneration.value += 1
  invalidatePreview()
  message.value = ''
}

function onSelectionChanged() {
  inputGeneration.value += 1
  invalidatePreview()
}

async function loadRules(pageToLoad = pageNumber.value) {
  const requestGeneration = ++rulesRequestGeneration.value
  const targetProductId = props.productId
  const previousPage = pageNumber.value
  pageNumber.value = pageToLoad
  const editGenerationsAtStart = { ...draftEditGenerations }
  const dirtyIdsAtStart = new Set((page.value?.items ?? []).filter(rowIsDirty).map(row => row.skuId))
  invalidatePreview()
  loading.value = true
  error.value = ''
  try {
    const result = await request<AdminProductPricingRulesPage>(`/api/v1/admin/products/${targetProductId}/pricing-rules?page=${pageToLoad}&pageSize=50`)
    if (requestGeneration !== rulesRequestGeneration.value || targetProductId !== props.productId) return
    if (result.productId !== targetProductId) return
    page.value = result
    pageNumber.value = result.page
    syncDraftsFromPage(result.items, editGenerationsAtStart, dirtyIdsAtStart)
    if (!result.items.some(row => row.skuId === historySkuId.value)) {
      historySkuId.value = result.items.find(row => row.retiredAt === null)?.skuId ?? ''
    }
    if (result.productRevision > props.productRevision) emit('revisionChanged', result.productRevision)
  } catch (cause) {
    if (requestGeneration === rulesRequestGeneration.value && targetProductId === props.productId) {
      pageNumber.value = previousPage
      error.value = cause instanceof Error ? cause.message : '定价规则读取失败。'
    }
  } finally {
    if (requestGeneration === rulesRequestGeneration.value && targetProductId === props.productId) loading.value = false
  }
}

function ruleUpdate(row: AdminProductPricingRuleItem) {
  const draft = drafts[row.skuId]!
  return {
    skuId: row.skuId,
    expectedSkuRevision: row.skuRevision,
    expectedRuleRevision: row.ruleRevision,
    mode: draft.mode,
    ...(draft.mode === 'fixed_profit' ? { fixedProfit: draft.fixedProfit.trim() } : {}),
    ...(draft.mode === 'percentage_markup' ? { markupRate: draft.markupRate.trim() } : {}),
  }
}

async function saveRules() {
  if (!page.value || props.archived || !dirty.value || working.value) return
  const updates = page.value.items.filter((row) => {
    const draft = drafts[row.skuId]
    return draft && (draft.mode !== row.mode
      || (draft.mode === 'fixed_profit' && draft.fixedProfit.trim() !== (row.fixedProfit ?? ''))
      || (draft.mode === 'percentage_markup' && draft.markupRate.trim() !== (row.markupRate ?? '')))
  }).map(ruleUpdate)
  if (!updates.length) return
  const targetProductId = props.productId
  const targetPage = page.value.page
  const editGenerationsAtStart = Object.fromEntries(updates.map(item => [item.skuId, draftEditGenerations[item.skuId] ?? 0]))
  const operation = ++operationGeneration.value
  working.value = 'save'
  error.value = ''
  message.value = ''
  invalidatePreview()
  try {
    const result = await request<AdminProductPricingRulesBatchResult>(`/api/v1/admin/products/${targetProductId}/pricing-rules/batch`, {
      method: 'PUT', body: { expectedRevision: page.value.productRevision, updates },
    })
    if (operation !== operationGeneration.value || targetProductId !== props.productId || result.productId !== targetProductId) return
    if (!mergeRuleItems(result.productRevision, result.items, new Map(Object.entries(editGenerationsAtStart)))) {
      void loadRules(targetPage)
      return
    }
    emit('revisionChanged', result.productRevision)
    message.value = `已为 ${updates.length} 个 SKU 保存新的规则版本；售价尚未更改。`
  } catch (cause) {
    if (operation !== operationGeneration.value || targetProductId !== props.productId) return
    error.value = cause instanceof Error ? cause.message : '规则保存失败。'
    if (cause instanceof AdminApiError && cause.code.includes('REVISION')) await loadRules(targetPage)
  } finally {
    if (operation === operationGeneration.value && targetProductId === props.productId) working.value = ''
  }
}

async function makePreview() {
  if (props.archived || !selectedIds.value.length || working.value) return
  if (dirty.value) {
    invalidatePreview()
    error.value = '规则有未保存修改。请先保存规则，再重新预览和确认应用。'
    return
  }
  const targetProductId = props.productId
  const targetPage = page.value?.page ?? pageNumber.value
  const targetPageRevision = page.value?.productRevision
  const targetInputGeneration = inputGeneration.value
  const targetSkuIds = [...selectedIds.value]
  const requestGeneration = ++previewRequestGeneration.value
  working.value = 'preview'
  error.value = ''
  message.value = ''
  preview.value = null
  previewContext.value = null
  try {
    const result = await request<AdminProductPricingPreview>(`/api/v1/admin/products/${targetProductId}/pricing-rules/preview`, {
      method: 'POST', body: { skuIds: targetSkuIds },
    })
    if (requestGeneration !== previewRequestGeneration.value || targetProductId !== props.productId
      || targetInputGeneration !== inputGeneration.value || dirty.value || selectedIdsKey.value !== [...targetSkuIds].sort().join('|')) return
    if (result.productId !== targetProductId || result.productRevision !== targetPageRevision) {
      error.value = '商品或 SKU 数据已变化，规则已刷新；请重新预览后再确认。'
      void loadRules(targetPage)
      return
    }
    preview.value = result
    previewContext.value = {
      productId: targetProductId,
      productRevision: result.productRevision,
      page: targetPage,
      inputGeneration: targetInputGeneration,
      selectedIds: [...result.items.map(item => item.skuId)].sort(),
    }
    if (result.productRevision > props.productRevision) emit('revisionChanged', result.productRevision)
    confirmedPreview.value = false
    confirmedRisks.value = false
  } catch (cause) {
    if (requestGeneration === previewRequestGeneration.value && targetProductId === props.productId) {
      error.value = cause instanceof Error ? cause.message : '预览计算失败。'
    }
  } finally {
    if (requestGeneration === previewRequestGeneration.value && targetProductId === props.productId) working.value = ''
  }
}

async function applyPreview() {
  if (!preview.value || !previewIsCurrent.value || !canConfirmApply.value || working.value) {
    invalidatePreview()
    error.value = dirty.value
      ? '规则有未保存修改。请先保存规则，再重新预览和确认应用。'
      : '当前预览已失效，请重新预览后确认应用。'
    return
  }
  const targetProductId = props.productId
  const targetPage = page.value?.page ?? pageNumber.value
  const operation = ++operationGeneration.value
  const expectedPreview = preview.value
  working.value = 'apply'
  error.value = ''
  message.value = ''
  try {
    const result = await request<AdminProductPricingRulesBatchResult>(`/api/v1/admin/products/${targetProductId}/pricing-rules/apply`, {
      method: 'POST',
      body: {
        expectedRevision: expectedPreview.productRevision,
        confirmLossAndFreePrice: confirmedRisks.value,
        items: expectedPreview.items.map(item => ({
          skuId: item.skuId,
          expectedSkuRevision: item.skuRevision,
          expectedRuleRevision: item.ruleRevision,
          inputDigest: item.inputDigest,
        })),
      },
    })
    if (operation !== operationGeneration.value || targetProductId !== props.productId || result.productId !== targetProductId) return
    if (!mergeRuleItems(result.productRevision, result.items)) {
      void loadRules(targetPage)
      return
    }
    emit('revisionChanged', result.productRevision)
    emit('pricesChanged')
    message.value = `已确认应用 ${result.items.length} 个 SKU 的建议售价。`
    preview.value = null
    confirmationOpen.value = false
    confirmedPreview.value = false
    confirmedRisks.value = false
    if (historyOpen.value && historySkuId.value) await loadHistory(historySkuId.value)
  } catch (cause) {
    if (operation !== operationGeneration.value || targetProductId !== props.productId) return
    error.value = cause instanceof Error ? cause.message : '定价应用失败。'
    if (cause instanceof AdminApiError && cause.code.includes('STALE')) preview.value = null
  } finally {
    if (operation === operationGeneration.value && targetProductId === props.productId) working.value = ''
  }
}

function openApplyConfirmation() {
  if (!previewIsCurrent.value || dirty.value) {
    invalidatePreview()
    error.value = dirty.value
      ? '规则有未保存修改。请先保存规则，再重新预览和确认应用。'
      : '当前预览已失效，请重新预览后确认应用。'
    return
  }
  confirmedPreview.value = false
  confirmedRisks.value = false
  confirmationOpen.value = true
}

function riskLabel(risk: string) {
  const labels: Record<string, string> = {
    MANUAL_MODE: '手动售价，不生成建议',
    COST_MISSING: '成本缺失，无法计算',
    NEGATIVE_PROFIT: '按建议售价计算为负利润',
    FREE_PRICE: '建议售价为 ¥0.00',
    ROUNDING_TO_CENT: '结果按 ROUND_HALF_UP 舍入到分',
    ROUNDING_TO_ZERO: '成本/利润被舍入为 ¥0.00',
    PRICE_OVERFLOW: '计算结果超过数据库售价上限',
    INVALID_PRECISION: '金额精度不符合数据库边界',
    SKU_RETIRED: 'SKU 已永久退役，不能应用',
    SKU_DISABLED: 'SKU 暂停销售',
    COMPARE_AT_PRICE_CONFLICT: '建议售价不低于划线价；规则应用不会更改划线价',
  }
  return labels[risk] ?? risk
}

function statusLabel(status: string) {
  return ({ manual: '手动模式', pending: '待确认应用', applied: '与规则一致', stale: '价格或成本已变更' } as Record<string, string>)[status] ?? status
}

function deltaLabel(item: AdminProductPricingPreviewItem) {
  if (item.salePriceDelta === null) return '—'
  const positive = item.salePriceDelta.startsWith('-') ? '' : '+'
  return `${positive}¥${item.salePriceDelta}`
}

async function loadHistory(skuId = historySkuId.value) {
  const targetProductId = props.productId
  if (!skuId || skuId !== historySkuId.value || !historyOpen.value) return
  const requestGeneration = ++historyRequestGeneration.value
  history.value = null
  historyLoading.value = true
  historyError.value = ''
  try {
    const result = await request<AdminProductPricingRuleHistory>(`/api/v1/admin/products/${targetProductId}/variants/${skuId}/pricing-rules/history`)
    if (requestGeneration !== historyRequestGeneration.value || targetProductId !== props.productId
      || skuId !== historySkuId.value || !historyOpen.value
      || result.productId !== targetProductId || result.skuId !== skuId) return
    history.value = result
  } catch (cause) {
    if (requestGeneration === historyRequestGeneration.value && targetProductId === props.productId
      && skuId === historySkuId.value) {
      historyError.value = cause instanceof Error ? cause.message : '规则历史读取失败。'
    }
  } finally {
    if (requestGeneration === historyRequestGeneration.value && targetProductId === props.productId) historyLoading.value = false
  }
}

function versionLabel(version: AdminProductPricingRuleHistoryItem) {
  if (version.mode === 'manual') return '手动售价'
  if (version.mode === 'fixed_profit') return `成本 + ¥${version.fixedProfit}`
  return `成本加价 ${version.markupRate}%`
}

function previewRuleLabel(item: AdminProductPricingPreviewItem) {
  if (item.mode === 'fixed_profit') return `固定利润 ¥${item.fixedProfit}`
  if (item.mode === 'percentage_markup') return `成本加价 ${item.markupRate}%`
  return '手动售价'
}

function openRestoreConfirmation(version: AdminProductPricingRuleHistoryItem) {
  const skuId = historySkuId.value
  const historyForSku = history.value
  const row = page.value?.items.find(item => item.skuId === skuId)
  if (!historyOpen.value || !row || version.skuId !== skuId || !historyForSku
    || historyForSku.productId !== props.productId || historyForSku.skuId !== skuId
    || !historyForSku.items.some(item => item.id === version.id && item.skuId === skuId)
    || props.archived || row.retiredAt || working.value) return
  restoreCandidate.value = { productId: props.productId, skuId, skuCode: row.skuCode, version }
  restoreConfirmationOpen.value = true
}

async function confirmRestoreVersion() {
  const candidate = restoreCandidate.value
  if (!candidate || !canConfirmRestore.value || working.value) return
  const targetProductId = candidate.productId
  const targetSkuId = candidate.skuId
  const targetVersion = candidate.version
  const row = page.value?.items.find(item => item.skuId === targetSkuId)
  if (targetProductId !== props.productId || targetSkuId !== historySkuId.value
    || history.value?.productId !== targetProductId || history.value.skuId !== targetSkuId
    || !history.value.items.some(item => item.id === targetVersion.id && item.skuId === targetSkuId)
    || !row || props.archived || row.retiredAt) {
    restoreConfirmationOpen.value = false
    restoreCandidate.value = null
    historyError.value = '当前历史选择已变化，请重新选择 SKU 和规则版本。'
    return
  }
  const targetPage = page.value!.page
  const editGenerationAtStart = draftEditGenerations[targetSkuId] ?? 0
  const operation = ++operationGeneration.value
  working.value = 'restore'
  error.value = ''
  message.value = ''
  try {
    const result = await request<RestoreAdminProductPricingRuleResult>(`/api/v1/admin/products/${targetProductId}/variants/${targetSkuId}/pricing-rules/restore`, {
      method: 'POST', body: {
        expectedRevision: page.value!.productRevision,
        expectedSkuRevision: row.skuRevision,
        expectedRuleRevision: row.ruleRevision,
        sourceRevision: targetVersion.revision,
      },
    })
    if (operation !== operationGeneration.value || targetProductId !== props.productId || result.productId !== targetProductId) return
    if (!mergeRuleItems(result.productRevision, [result.item], new Map([[targetSkuId, editGenerationAtStart]]))) {
      void loadRules(targetPage)
      return
    }
    emit('revisionChanged', result.productRevision)
    message.value = `已从规则版本 v${result.restoredFromRevision} 恢复，并生成新的规则版本。售价未更改。`
    restoreConfirmationOpen.value = false
    restoreCandidate.value = null
    if (historySkuId.value === targetSkuId && historyOpen.value) await loadHistory(targetSkuId)
  } catch (cause) {
    if (operation !== operationGeneration.value || targetProductId !== props.productId) return
    error.value = cause instanceof Error ? cause.message : '恢复规则失败。'
  } finally {
    if (operation === operationGeneration.value && targetProductId === props.productId) working.value = ''
  }
}

function mergeRuleItems(
  productRevision: number,
  updatedItems: AdminProductPricingRuleItem[],
  editGenerationsAtStart = new Map(updatedItems.map(item => [item.skuId, draftEditGenerations[item.skuId] ?? 0])),
): boolean {
  const current = page.value
  if (!current || current.productId !== props.productId || productRevision < current.productRevision) return false
  const updatedById = new Map(updatedItems.map(item => [item.skuId, item]))
  page.value = {
    ...current,
    productRevision,
    items: current.items.map(row => ({ ...updatedById.get(row.skuId) ?? row, productRevision })),
  }
  for (const item of updatedItems) {
    if ((draftEditGenerations[item.skuId] ?? 0) === (editGenerationsAtStart.get(item.skuId) ?? 0)) draftFromServer(item)
  }
  invalidatePreview()
  return true
}

function invalidateHistorySelection() {
  historyRequestGeneration.value += 1
  history.value = null
  historyLoading.value = false
  historyError.value = ''
  restoreCandidate.value = null
  restoreConfirmationOpen.value = false
}

watch(() => props.productId, () => {
  rulesRequestGeneration.value += 1
  operationGeneration.value += 1
  invalidateHistorySelection()
  historyOpen.value = false
  historySkuId.value = ''
  loading.value = false
  working.value = ''
  page.value = null
  invalidatePreview()
  pageNumber.value = 1
  for (const skuId of Object.keys(drafts)) delete drafts[skuId]
  for (const skuId of Object.keys(selected)) delete selected[skuId]
  for (const skuId of Object.keys(draftEditGenerations)) delete draftEditGenerations[skuId]
  void loadRules(1)
}, { flush: 'sync' })

watch(() => props.productRevision, (revision) => {
  if (page.value && page.value.productId === props.productId && page.value.productRevision !== revision) {
    invalidatePreview()
    void loadRules(pageNumber.value)
  }
})

watch(historySkuId, (skuId) => {
  invalidateHistorySelection()
  if (skuId && historyOpen.value) void loadHistory(skuId)
}, { flush: 'sync' })

watch(historyOpen, (isOpen) => {
  if (isOpen && historySkuId.value) void loadHistory(historySkuId.value)
  if (!isOpen) {
    restoreCandidate.value = null
    restoreConfirmationOpen.value = false
  }
})

watch(dirty, (hasUncommittedRuleChanges) => {
  emit('dirtyChanged', hasUncommittedRuleChanges)
  if (hasUncommittedRuleChanges) invalidatePreview()
}, { immediate: true })

watch(() => props.archived, (archived) => {
  if (archived) invalidatePreview()
})

onBeforeUnmount(() => {
  rulesRequestGeneration.value += 1
  historyRequestGeneration.value += 1
  operationGeneration.value += 1
  invalidatePreview()
})

onMounted(() => { void loadRules(1) })
</script>

<template>
  <div
    id="pricing-rules"
    class="mt-6 border-t border-default pt-6"
  >
    <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-base font-semibold text-highlighted">
          精确定价规则
        </h3>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-muted">
          规则只用于预览和管理员确认应用。固定利润以成本相加；加价率按采购成本计算。成本是人工记录，不代表实际采购扣费或利润保证。
        </p>
      </div>
      <UBadge
        v-if="dirty"
        color="warning"
        variant="subtle"
      >
        规则有未保存修改
      </UBadge>
    </header>

    <UAlert
      v-if="error"
      class="mb-3"
      color="error"
      variant="soft"
      :title="error"
      role="alert"
    />
    <UAlert
      v-if="message"
      class="mb-3"
      color="success"
      variant="soft"
      :title="message"
      role="status"
    />
    <UAlert
      v-if="archived"
      class="mb-3"
      color="warning"
      variant="soft"
      title="商品已归档，定价规则、预览和应用均不可修改。"
    />
    <UAlert
      class="mb-3"
      color="info"
      variant="soft"
    >
      <template #description>
        手动模式始终保留当前真实售价。成本为空时不以 0 代替；售价只会在确认后写入现有 sale_price。划线价和成本价不会被规则应用覆盖。
      </template>
    </UAlert>

    <div
      v-if="loading && !page"
      class="py-5 text-sm text-muted"
    >
      正在读取定价规则…
    </div>
    <template v-else-if="page">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 p-3">
        <p class="text-sm text-muted">
          勾选需要预览的 SKU。每次保存规则或应用售价都会生成新的商品/SKU 修订。
        </p>
        <div class="flex flex-wrap gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :loading="working === 'save'"
            :disabled="archived || !dirty || Boolean(working)"
            @click="saveRules"
          >
            保存本页规则版本
          </UButton>
          <UButton
            :loading="working === 'preview'"
            :disabled="archived || !selectedIds.length || Boolean(working)"
            @click="makePreview"
          >
            预览所选 SKU（{{ selectedIds.length }}）
          </UButton>
        </div>
      </div>

      <div class="grid gap-3">
        <article
          v-for="row in page.items"
          :key="row.skuId"
          class="min-w-0 rounded-lg border border-default p-3 sm:p-4"
        >
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <UCheckbox
              v-model="selected[row.skuId]"
              :disabled="archived || Boolean(row.retiredAt)"
              :aria-label="`选择 ${row.skuCode} 进行定价预览`"
              @update:model-value="onSelectionChanged"
            />
            <span class="font-mono text-sm font-semibold text-highlighted">{{ row.skuCode }}</span>
            <UBadge
              :color="row.ruleStatus === 'applied' ? 'success' : row.ruleStatus === 'stale' ? 'warning' : 'neutral'"
              variant="subtle"
            >
              {{ statusLabel(row.ruleStatus) }}
            </UBadge>
            <UBadge
              v-if="row.retiredAt"
              color="neutral"
              variant="subtle"
            >
              永久退役，只读
            </UBadge>
            <span class="ml-auto text-xs tabular-nums text-dimmed">规则 v{{ row.ruleRevision }} · SKU 修订 {{ row.skuRevision }}</span>
          </div>
          <div class="mb-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <p>当前售价：<span class="font-medium tabular-nums">¥{{ row.salePrice }}</span></p>
            <p>人工成本：<span class="font-medium tabular-nums">{{ row.costPrice === null ? '未填写' : `¥${row.costPrice}` }}</span></p>
            <p>划线价：<span class="font-medium tabular-nums">{{ row.compareAtPrice === null ? '未设置' : `¥${row.compareAtPrice}` }}</span></p>
          </div>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(12rem,1fr)_minmax(10rem,1fr)_minmax(10rem,1fr)]">
            <UFormField label="定价模式">
              <USelect
                v-model="drafts[row.skuId]!.mode"
                :items="modeItems"
                value-key="value"
                label-key="label"
                :disabled="archived || Boolean(row.retiredAt) || working === 'preview' || working === 'apply'"
                class="w-full"
                @update:model-value="onDraftEdited(row.skuId)"
              />
            </UFormField>
            <UFormField
              v-if="drafts[row.skuId]!.mode === 'fixed_profit'"
              label="每件固定利润（¥）"
              hint="0 至 13 位整数、最多 5 位小数"
            >
              <UInput
                v-model="drafts[row.skuId]!.fixedProfit"
                inputmode="decimal"
                :disabled="archived || Boolean(row.retiredAt) || working === 'preview' || working === 'apply'"
                class="w-full"
                @update:model-value="onDraftEdited(row.skuId)"
              />
            </UFormField>
            <UFormField
              v-else-if="drafts[row.skuId]!.mode === 'percentage_markup'"
              label="按成本加价率（%）"
              hint="按成本计算，不是按售价计算毛利率"
            >
              <UInput
                v-model="drafts[row.skuId]!.markupRate"
                inputmode="decimal"
                :disabled="archived || Boolean(row.retiredAt) || working === 'preview' || working === 'apply'"
                class="w-full"
                @update:model-value="onDraftEdited(row.skuId)"
              />
            </UFormField>
            <p
              v-else
              class="self-end pb-2 text-sm text-muted"
            >
              手动模式不会生成建议售价。
            </p>
            <div class="self-end pb-2 text-sm text-muted">
              当前成本/规则变化后，状态会显示为待预览或需重新预览。
            </div>
          </div>
        </article>
      </div>

      <div
        v-if="page.totalPages > 1"
        class="mt-3 flex items-center justify-between gap-3"
      >
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          :disabled="pageNumber <= 1 || dirty || loading || Boolean(working)"
          @click="loadRules(pageNumber - 1)"
        >
          上一页
        </UButton>
        <span class="text-sm text-muted">第 {{ page.page }} / {{ page.totalPages }} 页 · {{ page.total }} 个 SKU</span>
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          :disabled="pageNumber >= page.totalPages || dirty || loading || Boolean(working)"
          @click="loadRules(pageNumber + 1)"
        >
          下一页
        </UButton>
      </div>

      <section
        v-if="preview"
        class="mt-5 rounded-lg border border-primary/30 bg-primary/5 p-3 sm:p-4"
        aria-labelledby="pricing-preview-title"
      >
        <div class="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4
              id="pricing-preview-title"
              class="font-semibold text-highlighted"
            >
              调价预览
            </h4>
            <p class="mt-1 text-sm text-muted">
              预览只读。确认时会重新核验商品、SKU、规则修订和计算输入摘要。
            </p>
          </div>
          <UButton
            color="neutral"
            variant="outline"
            :disabled="Boolean(working) || !preview.items.every(item => item.canApply)"
            @click="openApplyConfirmation"
          >
            确认应用本批建议售价
          </UButton>
        </div>
        <div class="grid gap-3">
          <article
            v-for="item in preview.items"
            :key="item.skuId"
            class="rounded-md border border-default bg-default p-3"
          >
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-sm font-semibold">{{ item.skuCode }}</span>
              <span class="text-sm text-muted">当前 ¥{{ item.currentSalePrice }}</span>
              <span class="text-sm font-semibold tabular-nums">建议 {{ item.suggestedSalePrice === null ? '—' : `¥${item.suggestedSalePrice}` }}</span>
              <span class="text-sm tabular-nums text-muted">差额 {{ deltaLabel(item) }}</span>
            </div>
            <div class="mt-2 grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <p>成本：{{ item.costPrice === null ? '未填写' : `¥${item.costPrice}` }}</p>
              <p>当前毛利润 / 毛利率：{{ item.currentGrossProfit === null ? '无法计算' : `¥${item.currentGrossProfit} / ${item.currentGrossMarginRate ?? '—'}%` }}</p>
              <p>建议毛利润 / 毛利率：{{ item.suggestedGrossProfit === null ? '无法计算' : `¥${item.suggestedGrossProfit} / ${item.suggestedGrossMarginRate ?? '—'}%` }}</p>
            </div>
            <div
              v-if="item.risks.length"
              class="mt-2 flex flex-wrap gap-1.5"
            >
              <UBadge
                v-for="risk in item.risks"
                :key="risk"
                color="warning"
                variant="subtle"
              >
                {{ riskLabel(risk) }}
              </UBadge>
            </div>
          </article>
        </div>
        <UAlert
          v-if="!preview.items.every(item => item.canApply)"
          class="mt-3"
          color="warning"
          variant="soft"
          title="所选批次包含不可应用的行（如手动模式、缺少成本、划线价冲突、金额溢出或已退役 SKU）；请调整规则或选择后重新预览。"
        />
      </section>

      <section class="mt-5 border-t border-default pt-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 class="font-medium text-highlighted">
              策略版本历史
            </h4>
            <p class="mt-1 text-sm text-muted">
              恢复历史配置会新增一个规则版本，不会编辑旧记录或改动售价。
            </p>
          </div>
          <div class="flex w-full flex-wrap gap-2 sm:w-auto">
            <USelect
              v-model="historySkuId"
              :items="page.items.map(row => ({ label: row.skuCode, value: row.skuId }))"
              value-key="value"
              label-key="label"
              :disabled="working === 'restore'"
              class="min-w-48 flex-1 sm:flex-none"
              aria-label="选择查看规则历史的 SKU"
            />
            <UButton
              color="neutral"
              variant="outline"
              :disabled="!historySkuId || Boolean(working)"
              @click="historyOpen = !historyOpen"
            >
              {{ historyOpen ? '收起历史' : '查看历史' }}
            </UButton>
          </div>
        </div>
        <div
          v-if="historyOpen"
          class="mt-3"
        >
          <UAlert
            v-if="historyError"
            class="mb-3"
            color="error"
            variant="soft"
            :title="historyError"
          />
          <p
            v-if="historyLoading"
            class="py-3 text-sm text-muted"
            role="status"
          >
            正在读取所选 SKU 的规则历史…
          </p>
          <div
            v-if="historyItems.length"
            class="grid gap-2"
          >
            <article
              v-for="version in historyItems"
              :key="version.id"
              class="flex flex-col gap-2 rounded-md border border-default p-3 sm:flex-row sm:items-center"
            >
              <div class="min-w-0 flex-1">
                <p class="font-medium">
                  v{{ version.revision }} · {{ versionLabel(version) }}
                </p>
                <p class="mt-1 text-xs text-muted">
                  {{ version.changeType === 'restored' ? `恢复自 v${version.restoredFromRevision}` : '规则配置' }} · {{ new Date(version.createdAt).toLocaleString() }}
                </p>
              </div>
              <UButton
                color="neutral"
                variant="outline"
                size="sm"
                :aria-label="`恢复 SKU ${page.items.find(row => row.skuId === version.skuId)?.skuCode ?? version.skuId} 的规则 v${version.revision}`"
                :disabled="archived || Boolean(page.items.find(row => row.skuId === version.skuId)?.retiredAt) || Boolean(working) || historyLoading"
                @click="openRestoreConfirmation(version)"
              >
                恢复为新版本
              </UButton>
            </article>
          </div>
          <p
            v-else-if="!historyLoading"
            class="py-4 text-sm text-muted"
          >
            此 SKU 尚无策略版本历史。
          </p>
        </div>
      </section>
    </template>

    <UModal
      v-model:open="confirmationOpen"
      title="确认应用调价建议"
    >
      <template #body>
        <div class="space-y-4">
          <p class="text-sm leading-6 text-muted">
            将把 {{ preview?.items.length ?? 0 }} 个 SKU 的售价写入现有 sale_price。确认期间若商品、SKU、成本或规则发生变化，整批都会被拒绝。
          </p>
          <ul
            v-if="preview && previewIsCurrent"
            class="grid max-h-64 gap-2 overflow-y-auto rounded-lg border border-default p-3 text-sm"
            aria-label="本次确认应用的 SKU、规则版本和建议售价"
          >
            <li
              v-for="item in preview.items"
              :key="item.skuId"
              class="flex flex-wrap items-center justify-between gap-2"
            >
              <span class="font-mono font-medium">{{ item.skuCode }}</span>
              <span class="text-muted">规则 v{{ item.ruleRevision }} · {{ previewRuleLabel(item) }}</span>
              <span class="font-semibold tabular-nums">建议 {{ item.suggestedSalePrice === null ? '—' : `¥${item.suggestedSalePrice}` }}</span>
            </li>
          </ul>
          <UCheckbox
            v-model="confirmedPreview"
            label="我已逐项核对当前售价、建议售价、毛利润和毛利率，并确认应用此批结果。"
          />
          <UCheckbox
            v-if="requiresRiskAck"
            v-model="confirmedRisks"
            label="我明确接受本批负利润或免费售价风险。"
          />
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :disabled="Boolean(working)"
              @click="confirmationOpen = false"
            >
              返回预览
            </UButton>
            <UButton
              :loading="working === 'apply'"
              :disabled="!canConfirmApply"
              @click="applyPreview"
            >
              确认并原子应用
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
    <UModal
      v-model:open="restoreConfirmationOpen"
      title="确认恢复定价规则"
    >
      <template #body>
        <div class="space-y-4">
          <p class="text-sm leading-6 text-muted">
            即将为 SKU <span class="font-mono font-semibold text-highlighted">{{ restoreCandidate?.skuCode }}</span>
            恢复规则 v{{ restoreCandidate?.version.revision }}（{{ restoreCandidate ? versionLabel(restoreCandidate.version) : '' }}）。
            这会创建一个新规则版本，不会修改售价。
          </p>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :disabled="Boolean(working)"
              @click="restoreConfirmationOpen = false; restoreCandidate = null"
            >
              取消
            </UButton>
            <UButton
              :loading="working === 'restore'"
              :disabled="!canConfirmRestore"
              @click="confirmRestoreVersion"
            >
              确认恢复此 SKU 规则
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
