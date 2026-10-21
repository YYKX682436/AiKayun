<script setup lang="ts">
import type {
  AdminProductCategory,
  AdminProductInventorySummary,
  AdminProductVariantInventory,
  AdminProductVariantPrices,
  AdminProductVariantPricesPage,
  CodePoolBatchPage,
  CodePoolEntryPage,
  CodePoolFormat,
  CodePoolImportPreview,
  CodePoolMutationResult,
  CodePoolStatus,
  CreateInventoryAdjustmentBody,
  InventoryAdjustmentPage,
  ManualFulfillmentConfig,
  ManualFulfillmentConfigPage,
  ProductDetail,
  ProductGalleryImage,
  ProductInventoryMode,
  ProductMediaLibraryPage,
  ProductMediaMetadata,
  ProductRichContent,
  PurchaseLimitSettings,
  SkuPurchaseLimitSettings,
  ProductVariantMatrixBody,
  ProductVariantMatrixPreview,
  ProductVariantMatrixSaveResult,
} from '@aikayun/contracts'
import {
  EMPTY_PRODUCT_RICH_CONTENT,
  validateProductRichContent,
} from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

definePageMeta({ middleware: 'admin-auth', layout: 'admin' })

const noCategoryValue = '__no_category__'
const rootCategoryValue = '__root_category__'

const route = useRoute()
const router = useRouter()
const { request, upload } = useAdminApi()
const productId = computed(() => String(route.params.id))
const product = shallowRef<ProductDetail | null>(null)
const categories = ref<AdminProductCategory[]>([])
const loading = ref(true)
const loadError = ref('')
const sectionErrors = reactive<Record<string, string>>({})
const sectionSuccess = reactive<Record<string, string>>({})
const saving = ref('')
const dirty = reactive({ basic: false, categories: false, attributes: false, gallery: false, rich: false, matrix: false, prices: false, inventory: false })
const productPurchaseLimitDraft = reactive({ perOrder: '', lifetime: '', rolling24Hours: '' })
const skuPurchaseLimitDrafts = reactive<Record<string, { perOrder: string; lifetime: string; rolling24Hours: string }>>({})
const productPurchaseLimitDraftDirty = computed(() => {
  const current = product.value
  return Boolean(current && (['perOrder', 'lifetime', 'rolling24Hours'] as const).some(key => productPurchaseLimitDraft[key] !== String(current.purchaseLimits[key] ?? '')))
})
const skuPurchaseLimitDraftDirty = computed(() => {
  const current = product.value
  if (!current) return false
  const keys = ['perOrder', 'lifetime', 'rolling24Hours'] as const
  const productChanged = keys.some(key => productPurchaseLimitDraft[key] !== String(current.purchaseLimits[key] ?? ''))
  const skuChanged = current.variants.some(variant => {
    const draft = skuPurchaseLimitDrafts[variant.id]
    return draft && keys.some(key => draft[key] !== String(variant.purchaseLimits[key] ?? ''))
  })
  return productChanged || skuChanged
})
const hasUnsavedChanges = computed(() => Object.values(dirty).some(Boolean) || skuPurchaseLimitDraftDirty.value)
const conflictSection = ref('')
const conflictLatest = ref<ProductDetail | null>(null)
const conflictPrices = ref<AdminProductVariantPricesPage | null>(null)
const conflictInventory = ref<AdminProductInventorySummary | null>(null)
const conflictLoading = ref(false)
const conflictError = ref('')

const name = ref('')
const clientReady = ref(false)
const description = ref('')
const productType = ref<ProductDetail['productType']>('digital')
const categorySelection = ref<string[]>([])
const primaryCategoryId = ref('')
const attributesDraft = ref<Array<{ id?: string; name: string; value: string }>>([])
const galleryDraft = ref<ProductGalleryImage[]>([])
const richDraft = ref<ProductRichContent>(structuredClone(EMPTY_PRODUCT_RICH_CONTENT))

const pricePage = ref<AdminProductVariantPricesPage | null>(null)
const pricePageNumber = ref(1)
const priceDraft = reactive<Record<string, { salePrice: string; compareAtPrice: string; costPrice: string }>>({})
const bulkSalePrice = ref('')

const inventorySummary = shallowRef<AdminProductInventorySummary | null>(null)
const manualFulfillment = ref<ManualFulfillmentConfigPage>([])
const manualFulfillmentLoading = ref(false)
const codePoolSkuId = ref('')
const codePoolStatus = shallowRef<CodePoolStatus | null>(null)
const codePoolBatches = shallowRef<CodePoolBatchPage | null>(null)
const codePoolEntries = shallowRef<CodePoolEntryPage | null>(null)
const codePoolEntryFilter = ref<'all' | 'available' | 'reserved' | 'delivered' | 'revoked'>('available')
const codePoolFormat = ref<CodePoolFormat>('paste')
const codePoolSourceText = ref('')
const codePoolPreview = shallowRef<CodePoolImportPreview | null>(null)
const codePoolOperationId = ref('')
const codePoolSelectedEntryIds = ref<string[]>([])
const codePoolWithdrawalReason = ref('')
const codePoolWithdrawalConfirmation = ref('')
const codePoolError = ref('')
const codePoolMessage = ref('')
const codePoolLoading = ref(false)
const codePoolEntryPageNumber = ref(1)
const inventoryPageNumber = ref(1)
const inventoryPageSize = 20
const historySkuId = ref('')
const history = ref<InventoryAdjustmentPage | null>(null)
const historyLoading = ref(false)
const historyError = ref('')
const historyPageSize = 25
const adjustmentAction = ref<'increase' | 'decrease' | 'set'>('increase')
const adjustmentQuantity = ref('')
const adjustmentReason = ref('')
const adjustmentMessage = ref('')
const pendingAdjustment = ref<{ skuId: string; body: CreateInventoryAdjustmentBody } | null>(null)

type DraftGroup = { id: string; name: string; sortOrder: number; enabled: boolean; values: Array<{ id: string; name: string; sortOrder: number; enabled: boolean }> }
type MatrixCombination = { key: string; valueIds: string[]; optionNames: string[]; sku?: ProductDetail['variants'][number]; retired?: ProductDetail['variants'][number] }
const groupsDraft = ref<DraftGroup[]>([])
const matrixMode = ref<'all' | 'selected'>('selected')
const selectedMatrixKeys = ref<string[]>([])
const skuEnabledDraft = reactive<Record<string, boolean>>({})
const retireSkuIds = ref<string[]>([])
const newSkuPrice = ref('')
const newSkuEnabled = ref(true)
const matrixPreview = ref<ProductVariantMatrixPreview | null>(null)
const matrixPreviewBody = ref<ProductVariantMatrixBody | null>(null)
const confirmMatrixChanges = ref(false)
const skuPageNumber = ref(1)
const skuPageSize = 25
const matrixPageNumber = ref(1)
const matrixPageSize = 50

const uploadProgress = ref<number | null>(null)
const uploadMessage = ref('')
const mediaLibraryOpen = ref(false)
const mediaLibrary = ref<ProductMediaLibraryPage | null>(null)
const mediaLibraryPage = ref(1)
const mediaSearch = ref('')
const deletingMediaId = ref('')

const categoryManagerOpen = ref(false)
const newCategoryName = ref('')
const newCategoryParentId = ref(rootCategoryValue)
const categoryMessage = ref('')
const categoryNameDraft = reactive<Record<string, string>>({})
const categoryParentDraft = reactive<Record<string, string>>({})
const categoryOrderDraft = reactive<Record<string, string>>({})

const statusName = computed(() => ({ draft: '草稿', active: '销售中', paused: '已暂停', archived: '已归档' })[product.value?.status ?? 'draft'])
const isArchived = computed(() => product.value?.status === 'archived')
const productTypeItems = [
  { label: '数字商品', value: 'digital' },
  { label: '实物商品', value: 'physical' },
  { label: '服务', value: 'service' },
]
const inventoryModeItems = [
  { label: '未配置', value: 'null' },
  { label: '按数量管理', value: 'quantity' },
  { label: '资源池（未就绪）', value: 'resource_pool' },
  { label: '不限数量', value: 'unlimited' },
  { label: '外部供应商（未就绪）', value: 'external' },
]
const codePoolFormatItems = [
  { label: '粘贴文本', value: 'paste' },
  { label: 'TXT 文件', value: 'txt' },
  { label: 'CSV 文件', value: 'csv' },
]
const codePoolStatusItems = [
  { label: '全部状态', value: 'all' },
  { label: '未售可用', value: 'available' },
  { label: '已预留', value: 'reserved' },
  { label: '已交付', value: 'delivered' },
  { label: '已撤回', value: 'revoked' },
]

const categoryTree = computed(() => {
  const children = new Map<string | null, AdminProductCategory[]>()
  for (const category of categories.value) {
    const rows = children.get(category.parentId) ?? []
    rows.push(category)
    children.set(category.parentId, rows)
  }
  for (const rows of children.values()) rows.sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
  const flattened: Array<{ category: AdminProductCategory; depth: number; path: string }> = []
  function walk(parentId: string | null, depth: number, prefix: string) {
    for (const category of children.get(parentId) ?? []) {
      const path = prefix ? `${prefix} / ${category.name}` : category.name
      flattened.push({ category, depth, path })
      walk(category.id, depth + 1, path)
    }
  }
  walk(null, 0, '')
  return flattened
})
const categorySelectItems = computed(() => [{ label: '未分类', value: noCategoryValue }, ...categoryTree.value.map(({ category, depth, path }) => ({ label: `${'　'.repeat(depth)}${path.split(' / ').at(-1)} · ${path}`, value: category.id }))])
const selectedCategoryItems = computed(() => categoryTree.value.filter(({ category }) => category.isVisible || categorySelection.value.includes(category.id)))
const visibleSubcategoryItems = computed(() => selectedCategoryItems.value.filter(({ category }) => category.id !== primaryCategoryId.value))
const sortedCategoryManagerRows = computed(() => categoryTree.value)

const allCombinations = computed<MatrixCombination[]>(() => {
  const activeGroups = groupsDraft.value.filter(group => group.enabled)
  let combinations: Array<Array<{ id: string; name: string }>> = activeGroups.length ? [[]] : [[]]
  for (const group of activeGroups) {
    const values = group.values.filter(value => value.enabled && value.name.trim())
    combinations = combinations.flatMap(row => values.map(value => [...row, { id: value.id, name: value.name }]))
    if (combinations.length > 1000) break
  }
  const variants = product.value?.variants ?? []
  const keyFor = (ids: string[]) => ids.length ? `v1:${[...ids].map(id => id.toLowerCase()).sort().join('.')}` : ''
  const variantsByKey = new Map(variants.map(variant => [
    keyFor(variant.options.map(option => option.valueId)),
    variant,
  ]))
  return combinations.map(values => {
    const valueIds = values.map(value => value.id)
    const key = keyFor(valueIds)
    const matching = variantsByKey.get(key)
    return {
      key,
      valueIds,
      optionNames: values.map(value => value.name),
      ...(matching && matching.retiredAt === null ? { sku: matching } : {}),
      ...(matching && matching.retiredAt !== null ? { retired: matching } : {}),
    }
  })
})
const selectedMatrixKeySet = computed(() => new Set(selectedMatrixKeys.value))
const selectedCombinationCount = computed(() => matrixMode.value === 'all'
  ? allCombinations.value.length
  : allCombinations.value.filter(combination => selectedMatrixKeySet.value.has(combination.key)).length)
const matrixCombinationLimitExceeded = computed(() => allCombinations.value.length > 1000)
const visibleSkuRows = computed(() => {
  const rows = product.value?.variants ?? []
  const start = (skuPageNumber.value - 1) * skuPageSize
  return rows.slice(start, start + skuPageSize)
})
const visibleMatrixCombinations = computed(() => {
  const start = (matrixPageNumber.value - 1) * matrixPageSize
  return allCombinations.value.slice(start, start + matrixPageSize)
})
const matrixTotalPages = computed(() => Math.ceil(allCombinations.value.length / matrixPageSize))
const skuTotalPages = computed(() => Math.ceil((product.value?.variants.length ?? 0) / skuPageSize))
const visibleInventoryRows = computed(() => {
  const rows = inventorySummary.value?.variants ?? []
  const start = (inventoryPageNumber.value - 1) * inventoryPageSize
  return rows.slice(start, start + inventoryPageSize)
})
const codePoolSkuOptions = computed(() => (inventorySummary.value?.variants ?? []).map(row => ({
  label: `${row.skuCode} · ${row.inventory.mode === 'quantity' ? `数量库存 ${row.inventory.stocked}` : '需要 quantity 库存'}`,
  value: row.skuId,
})))
const codePoolInventoryRow = computed(() => inventoryForSku(codePoolSkuId.value))
const canConfigureCodePool = computed(() => product.value?.productType === 'digital'
  && Boolean(codePoolInventoryRow.value?.enabled && !codePoolInventoryRow.value.retiredAt
    && codePoolInventoryRow.value.inventory.mode === 'quantity'))
const codePoolReasonLabels: Record<Exclude<CodePoolImportPreview['rows'][number]['reason'], null>, string> = {
  duplicate_in_request: '本次内容重复', already_imported: '此 SKU 已存在', empty: '空白行',
  too_long: '单条内容超过 512 个字符', invalid_text: '文本含不支持的字符', invalid_csv_row: 'CSV 需为单列卡密',
}
const codePoolReasonLabel = (reason: CodePoolImportPreview['rows'][number]['reason']) => reason ? codePoolReasonLabels[reason] : ''
const inventoryTotalPages = computed(() => Math.ceil((inventorySummary.value?.variants.length ?? 0) / inventoryPageSize))
const matrixNeedsConfirmation = computed(() => matrixPreview.value?.changes.some(change => change.change === 'removed' || change.change === 'retired' || change.change === 'modified') ?? false)
const matrixBlockedChanges = computed(() => matrixPreview.value?.changes.filter(change => change.inventoryMutationBlocked || change.retirementBlocked) ?? [])
const legacyDefaultSkuNeedsRetirement = computed(() => groupsDraft.value.some(group => group.enabled)
  && (product.value?.variants.some(variant => variant.isDefault && !variant.retiredAt && variant.options.length === 0
    && !retireSkuIds.value.includes(variant.id)) ?? false))
const currentPriceItems = computed(() => pricePage.value?.items ?? [])

function clone<T>(value: T): T { return structuredClone(value) }

function resetDrafts(source: ProductDetail) {
  product.value = source
  name.value = source.name
  description.value = source.description
  productType.value = source.productType
  categorySelection.value = source.categories.map(category => category.categoryId)
  primaryCategoryId.value = source.categories.find(category => category.isPrimary)?.categoryId ?? ''
  attributesDraft.value = source.attributes.map(attribute => ({ id: attribute.id, name: attribute.name, value: attribute.value }))
  galleryDraft.value = clone(source.gallery)
  richDraft.value = clone(source.richContent ?? EMPTY_PRODUCT_RICH_CONTENT)
  for (const key of ['perOrder', 'lifetime', 'rolling24Hours'] as const) productPurchaseLimitDraft[key] = String(source.purchaseLimits[key] ?? '')
  for (const key of Object.keys(skuPurchaseLimitDrafts)) delete skuPurchaseLimitDrafts[key]
  for (const variant of source.variants) skuPurchaseLimitDrafts[variant.id] = purchaseLimitDraft(variant.purchaseLimits)
  groupsDraft.value = source.optionGroups.map(group => ({
    id: group.id, name: group.name, sortOrder: group.sortOrder, enabled: group.enabled,
    values: group.values.map(value => ({ id: value.id, name: value.name, sortOrder: value.sortOrder, enabled: value.enabled })),
  }))
  selectedMatrixKeys.value = source.variants.filter(variant => variant.retiredAt === null)
    .map(variant => variant.options.length ? `v1:${variant.options.map(option => option.valueId.toLowerCase()).sort().join('.')}` : '')
  for (const variant of source.variants) skuEnabledDraft[variant.id] = variant.enabled
  retireSkuIds.value = []
  newSkuPrice.value = source.variants.find(variant => variant.retiredAt === null)?.salePrice ?? source.variants[0]?.salePrice ?? '0.00'
  matrixPreview.value = null
  matrixPreviewBody.value = null
  confirmMatrixChanges.value = false
  for (const key of Object.keys(dirty)) dirty[key as keyof typeof dirty] = false
  for (const key of Object.keys(sectionErrors)) delete sectionErrors[key]
  for (const key of Object.keys(sectionSuccess)) delete sectionSuccess[key]
}

function purchaseLimitDraft(settings: PurchaseLimitSettings | SkuPurchaseLimitSettings) {
  return {
    perOrder: String(settings.perOrder ?? ''),
    lifetime: String(settings.lifetime ?? ''),
    rolling24Hours: String(settings.rolling24Hours ?? ''),
  }
}

function skuLimitDraft(variant: ProductDetail['variants'][number]) {
  return skuPurchaseLimitDrafts[variant.id] ?? (skuPurchaseLimitDrafts[variant.id] = purchaseLimitDraft(variant.purchaseLimits))
}

function hasSkuPurchaseLimitDraftChanges(variant: ProductDetail['variants'][number]) {
  const draft = skuLimitDraft(variant)
  return (['perOrder', 'lifetime', 'rolling24Hours'] as const).some(key => draft[key] !== String(variant.purchaseLimits[key] ?? ''))
}

function parsePurchaseLimit(value: string | number, maximum: number, label: string): number | null {
  const normalized = String(value).trim()
  if (normalized === '') return null
  if (!/^\d+$/.test(normalized)) throw new Error(`${label}必须是正整数，或留空表示不限制。`)
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label}范围为 1–${maximum}，或留空表示不限制。`)
  return parsed
}

function purchaseLimitsBody(draft: { perOrder: string; lifetime: string; rolling24Hours: string }, perOrderMaximum: number) {
  return {
    perOrder: parsePurchaseLimit(draft.perOrder, perOrderMaximum, '每笔订单限购'),
    lifetime: parsePurchaseLimit(draft.lifetime, 2_147_483_647, '账号累计限购'),
    rolling24Hours: parsePurchaseLimit(draft.rolling24Hours, 2_147_483_647, '账号 24 小时限购'),
  }
}

async function saveProductPurchaseLimits() {
  if (!product.value || isArchived.value || saving.value) return
  saving.value = 'purchase-limits'
  clearSectionStatus('purchaseLimits')
  try {
    const updated = await request<ProductDetail>(`/api/v1/admin/products/${productId.value}/purchase-limits`, {
      method: 'PUT',
      body: { expectedRevision: product.value.revision, purchaseLimits: purchaseLimitsBody(productPurchaseLimitDraft, 4950) },
    })
    product.value = updated
    for (const key of ['perOrder', 'lifetime', 'rolling24Hours'] as const) productPurchaseLimitDraft[key] = String(updated.purchaseLimits[key] ?? '')
    sectionSuccess.purchaseLimits = '商品购买限制已保存，新报价立即使用此规则。'
  } catch (error) { await handleSectionError('purchaseLimits', error) } finally { saving.value = '' }
}

async function saveSkuPurchaseLimits(variant: ProductDetail['variants'][number]) {
  if (!product.value || isArchived.value || variant.retiredAt || saving.value) return
  const section = `skuPurchaseLimits:${variant.id}`
  saving.value = section
  clearSectionStatus(section)
  try {
    const updated = await request<ProductDetail>(`/api/v1/admin/products/${productId.value}/variants/${variant.id}/purchase-limits`, {
      method: 'PUT',
      body: {
        expectedProductRevision: product.value.revision,
        expectedSkuRevision: variant.revision,
        purchaseLimits: purchaseLimitsBody(skuLimitDraft(variant), 99),
      },
    })
    product.value = updated
    const savedVariant = updated.variants.find(row => row.id === variant.id)
    if (savedVariant) skuPurchaseLimitDrafts[variant.id] = purchaseLimitDraft(savedVariant.purchaseLimits)
    sectionSuccess[section] = 'SKU 购买限制已保存，新报价立即使用此规则。'
  } catch (error) { await handleSectionError(section, error) } finally { saving.value = '' }
}

async function loadPricePage(page = pricePageNumber.value) {
  pricePageNumber.value = page
  pricePage.value = await request<AdminProductVariantPricesPage>(`/api/v1/admin/products/${productId.value}/prices?page=${page}&pageSize=50`)
  for (const row of pricePage.value.items) {
    if (!priceDraft[row.skuId]) {
      priceDraft[row.skuId] = {
        salePrice: row.salePrice,
        compareAtPrice: row.compareAtPrice ?? '',
        costPrice: row.costPrice ?? '',
      }
    }
  }
}

async function loadInventory() {
  inventorySummary.value = await request<AdminProductInventorySummary>(`/api/v1/admin/products/${productId.value}/inventory`)
}

async function loadManualFulfillment() {
  manualFulfillmentLoading.value = true
  try {
    manualFulfillment.value = await request<ManualFulfillmentConfigPage>(`/api/v1/admin/products/${productId.value}/manual-fulfillment`)
  } finally {
    manualFulfillmentLoading.value = false
  }
}

function manualFulfillmentForSku(skuId: string): ManualFulfillmentConfig | undefined {
  return manualFulfillment.value.find(row => row.skuId === skuId)
}

async function loadCodePoolEntries() {
  if (!codePoolSkuId.value) return
  const page = codePoolEntryPageNumber.value
  const filter = codePoolEntryFilter.value
  const suffix = `page=${page}&pageSize=50&status=${filter}`
  codePoolEntries.value = await request<CodePoolEntryPage>(`/api/v1/admin/products/${productId.value}/variants/${codePoolSkuId.value}/code-pool/entries?${suffix}`)
  codePoolSelectedEntryIds.value = []
}

async function loadCodePool() {
  if (!codePoolSkuId.value || product.value?.productType !== 'digital') return
  codePoolLoading.value = true
  codePoolError.value = ''
  try {
    const skuId = codePoolSkuId.value
    const [status, batches] = await Promise.all([
      request<CodePoolStatus>(`/api/v1/admin/products/${productId.value}/variants/${skuId}/code-pool`),
      request<CodePoolBatchPage>(`/api/v1/admin/products/${productId.value}/variants/${skuId}/code-pool/batches?page=1&pageSize=20`),
    ])
    if (skuId !== codePoolSkuId.value) return
    codePoolStatus.value = status
    codePoolBatches.value = batches
    await loadCodePoolEntries()
  } catch (error) {
    codePoolError.value = error instanceof Error ? error.message : '卡密池状态暂时无法读取。'
  } finally {
    codePoolLoading.value = false
  }
}

watch(inventorySummary, (summary) => {
  if (product.value?.productType !== 'digital' || !summary?.variants.length) return
  if (!summary.variants.some(row => row.skuId === codePoolSkuId.value)) {
    codePoolSkuId.value = summary.variants[0]!.skuId
  }
}, { immediate: true })
watch([codePoolSkuId, codePoolEntryFilter, codePoolEntryPageNumber], () => {
  codePoolPreview.value = null
  codePoolOperationId.value = ''
  codePoolSelectedEntryIds.value = []
  if (codePoolSkuId.value && !codePoolLoading.value) void loadCodePool()
})
watch([codePoolSourceText, codePoolFormat], () => {
  codePoolPreview.value = null
  codePoolOperationId.value = ''
})

function toggleCodePoolEntry(entryId: string, checked: boolean) {
  if (checked) {
    if (!codePoolSelectedEntryIds.value.includes(entryId)) codePoolSelectedEntryIds.value.push(entryId)
  } else {
    codePoolSelectedEntryIds.value = codePoolSelectedEntryIds.value.filter(id => id !== entryId)
  }
}

async function readCodePoolFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (file.size > 1_048_576) {
    codePoolError.value = '导入文件不能超过 1 MiB。'
    input.value = ''
    return
  }
  codePoolFormat.value = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'txt'
  try {
    codePoolSourceText.value = await file.text()
    codePoolError.value = ''
  } catch {
    codePoolError.value = '文件读取失败，请重新选择 UTF-8 TXT 或 CSV 文件。'
  } finally {
    input.value = ''
  }
}

async function precheckCodePoolImport() {
  if (!codePoolSkuId.value || !codePoolSourceText.value || codePoolLoading.value) return
  codePoolLoading.value = true
  codePoolError.value = ''
  codePoolMessage.value = ''
  codePoolPreview.value = null
  try {
    codePoolPreview.value = await request<CodePoolImportPreview>(`/api/v1/admin/products/${productId.value}/variants/${codePoolSkuId.value}/code-pool/precheck`, {
      method: 'POST', body: { format: codePoolFormat.value, sourceText: codePoolSourceText.value },
    })
    codePoolOperationId.value = crypto.randomUUID()
  } catch (error) {
    codePoolError.value = error instanceof Error ? error.message : '导入预检查失败。'
  } finally {
    codePoolLoading.value = false
  }
}

async function importCodePool() {
  const preview = codePoolPreview.value
  if (!preview?.acceptedCount || !codePoolOperationId.value || codePoolLoading.value) return
  if (!window.confirm(`确认将预检通过的 ${preview.acceptedCount} 条卡密加密入库？重复 ${preview.duplicateCount} 条、无效 ${preview.invalidCount} 条不会导入。`)) return
  codePoolLoading.value = true
  codePoolError.value = ''
  try {
    const result = await request<CodePoolMutationResult>(`/api/v1/admin/products/${productId.value}/variants/${codePoolSkuId.value}/code-pool/batches`, {
      method: 'POST', body: {
        operationId: codePoolOperationId.value,
        format: codePoolFormat.value,
        sourceText: codePoolSourceText.value,
      },
    })
    codePoolStatus.value = result.status
    codePoolMessage.value = result.repeated
      ? '已读取相同导入操作的原结果，库存没有重复增加。'
      : `批次 ${result.batch.id} 已入库 ${result.batch.acceptedCount} 条，库存由同一库存事件原子增加。`
    codePoolSourceText.value = ''
    codePoolPreview.value = null
    codePoolOperationId.value = ''
    await Promise.all([loadInventory(), loadCodePool()])
  } catch (error) {
    codePoolError.value = error instanceof Error ? error.message : '导入结果尚未确认。保留输入后再次提交可安全恢复相同操作。'
  } finally {
    codePoolLoading.value = false
  }
}

async function setCodePoolReadiness(enabled: boolean) {
  const row = codePoolInventoryRow.value
  if (!row || !codePoolSkuId.value || !canConfigureCodePool.value || codePoolLoading.value) return
  const action = enabled ? '开启此 SKU 的卡密自动发货销售资格' : '暂停此 SKU 的新订单卡密销售'
  if (!window.confirm(`确认${action}？已预留订单仍会继续自动交付。`)) return
  codePoolLoading.value = true
  codePoolError.value = ''
  codePoolMessage.value = ''
  try {
    codePoolStatus.value = await request<CodePoolStatus>(`/api/v1/admin/products/${productId.value}/variants/${codePoolSkuId.value}/code-pool/readiness`, {
      method: 'PUT', body: {
        enabled,
        expectedSkuRevision: row.skuRevision,
        expectedInventoryRevision: row.inventoryRevision,
      },
    })
    codePoolMessage.value = enabled ? '新销售资格已开启。' : '新销售资格已暂停，已有订单预留仍可自动交付。'
    await loadManualFulfillment()
  } catch (error) {
    codePoolError.value = error instanceof Error ? error.message : '卡密发货资格更新失败。'
  } finally {
    codePoolLoading.value = false
  }
}

async function withdrawCodePoolEntries() {
  const entries = codePoolSelectedEntryIds.value
  if (!entries.length || !codePoolSkuId.value || !codePoolWithdrawalReason.value.trim()
    || codePoolWithdrawalConfirmation.value !== 'REVOKE_UNSOLD_CODES' || codePoolLoading.value) return
  if (!window.confirm(`将撤回 ${entries.length} 条仍未预留的卡密并减少相同数量的 SKU 库存。此操作不可撤销。继续吗？`)) return
  codePoolLoading.value = true
  codePoolError.value = ''
  try {
    const result = await request<CodePoolMutationResult>(`/api/v1/admin/products/${productId.value}/variants/${codePoolSkuId.value}/code-pool/withdrawals`, {
      method: 'POST', body: {
        operationId: crypto.randomUUID(), entryIds: [...entries],
        reason: codePoolWithdrawalReason.value.trim(), confirmation: 'REVOKE_UNSOLD_CODES',
      },
    })
    codePoolStatus.value = result.status
    codePoolMessage.value = `已将 ${result.batch.acceptedCount} 条未售卡密安全撤回，数量库存已同步减少。`
    codePoolSelectedEntryIds.value = []
    codePoolWithdrawalReason.value = ''
    codePoolWithdrawalConfirmation.value = ''
    await Promise.all([loadInventory(), loadCodePool()])
  } catch (error) {
    codePoolError.value = error instanceof Error ? error.message : '撤回结果尚未确认，请刷新状态后核对批次记录。'
  } finally {
    codePoolLoading.value = false
  }
}

function canEnableManualFulfillment(skuId: string): boolean {
  const row = inventorySummary.value?.variants.find(variant => variant.skuId === skuId)
  return product.value?.productType === 'digital'
    && Boolean(row?.enabled && !row.retiredAt
      && (row.inventory.mode === 'quantity' || row.inventory.mode === 'unlimited'))
}

function manualFulfillmentReadinessText(row: AdminProductVariantInventory): string {
  if (product.value?.productType !== 'digital') return '仅数字商品支持人工数字交付。'
  if (row.retiredAt) return '此 SKU 已退役，不能开启人工交付。'
  if (!row.enabled) return '此 SKU 未启用，不能开启人工交付。'
  if (row.inventory.mode === 'quantity') return `按数量管理 · 当前可售 ${row.inventory.available} 件；需单独开启人工交付。`
  if (row.inventory.mode === 'unlimited') return '不限数量 · 需单独开启人工交付。'
  if (row.inventory.mode === 'resource_pool') return '资源池供货尚未就绪，不能开启人工交付。'
  if (row.inventory.mode === 'external') return '外部供应商尚未接入，不能开启人工交付。'
  return '请先配置按数量管理或不限数量库存，再开启人工交付。'
}

async function setManualFulfillment(skuId: string, enabled: boolean) {
  if (!product.value || saving.value || manualFulfillmentLoading.value) return
  const variant = product.value.variants.find(row => row.id === skuId)
  if (!variant) return
  if (enabled && !canEnableManualFulfillment(skuId)) {
    sectionErrors.inventory = '只有启用且未退役、库存模式为按数量或不限数量的数字商品 SKU 才能开启人工交付。'
    return
  }
  if (enabled && !window.confirm(`确认开启 SKU ${variant.skuCode} 的人工数字交付？请确保商家后台有人能为此商品实际录入并核对交付内容。`)) return
  clearSectionStatus('inventory')
  saving.value = `manual-fulfillment-${skuId}`
  try {
    const result = await request<ManualFulfillmentConfig>(`/api/v1/admin/products/${productId.value}/variants/${skuId}/manual-fulfillment`, {
      method: 'PUT',
      body: { enabled },
    })
    manualFulfillment.value = [
      ...manualFulfillment.value.filter(row => row.skuId !== skuId),
      result,
    ].sort((left, right) => left.skuId.localeCompare(right.skuId))
    sectionSuccess.inventory = enabled
      ? `SKU ${variant.skuCode} 已明确开启人工数字交付。顾客现在可以下单，商家需在订单后台实际录入交付内容。`
      : `SKU ${variant.skuCode} 已关闭人工数字交付。`
  } catch (error) {
    await handleSectionError('inventory', error)
    await loadManualFulfillment().catch(() => undefined)
  } finally {
    saving.value = ''
  }
}

async function loadCategories() {
  const result = await request<{ categories: AdminProductCategory[] }>('/api/v1/admin/categories')
  categories.value = result.categories
  for (const category of categories.value) {
    categoryNameDraft[category.id] = category.name
    categoryParentDraft[category.id] = category.parentId ?? rootCategoryValue
    categoryOrderDraft[category.id] = String(category.sortOrder)
  }
}

async function loadProduct() {
  loading.value = true
  loadError.value = ''
  try {
    const detail = await request<ProductDetail>(`/api/v1/admin/products/${productId.value}`)
    resetDrafts(detail)
    const createSessionKey = 'aikayun-admin-product-create-v1'
    try {
      const createSession = sessionStorage.getItem(createSessionKey)
      if (createSession && JSON.parse(createSession)?.productId === productId.value) {
        sessionStorage.removeItem(createSessionKey)
      }
    } catch {
      // Leave malformed recovery state for the create page to handle explicitly.
    }
    const results = await Promise.allSettled([loadCategories(), loadPricePage(1), loadInventory(), loadManualFulfillment()])
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') loadError.value = failed.reason instanceof Error ? failed.reason.message : '部分商品配置暂时不可用。'
    const pending = sessionStorage.getItem(`aikayun-admin-inventory-operation:${productId.value}`)
    if (pending) {
      try { pendingAdjustment.value = JSON.parse(pending) as typeof pendingAdjustment.value } catch { sessionStorage.removeItem(`aikayun-admin-inventory-operation:${productId.value}`) }
    }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '无法读取商品。'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  clientReady.value = true
  void loadProduct()
})

function beforeUnload(event: BeforeUnloadEvent) {
  if (!hasUnsavedChanges.value) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
onBeforeRouteLeave(() => {
  if (!hasUnsavedChanges.value || window.confirm('此商品仍有未保存的修改。确定离开并丢弃这些修改吗？')) return true
  return false
})

function clearSectionStatus(section: string) {
  delete sectionErrors[section]
  delete sectionSuccess[section]
}

async function refreshConflict(section: string) {
  conflictSection.value = section
  conflictLoading.value = true
  conflictError.value = ''
  try {
    const [latest, prices, inventory] = await Promise.all([
      request<ProductDetail>(`/api/v1/admin/products/${productId.value}`),
      request<AdminProductVariantPricesPage>(`/api/v1/admin/products/${productId.value}/prices?page=${pricePageNumber.value}&pageSize=50`),
      request<AdminProductInventorySummary>(`/api/v1/admin/products/${productId.value}/inventory`),
    ])
    conflictLatest.value = latest
    conflictPrices.value = prices
    conflictInventory.value = inventory
  } catch (error) {
    conflictError.value = error instanceof Error ? error.message : '无法读取服务器上的最新版本。'
  } finally {
    conflictLoading.value = false
  }
}

function resolveConflict(choice: 'discard' | 'keep') {
  if (!conflictLatest.value) return
  const latest = conflictLatest.value
  if (choice === 'discard') {
    resetDrafts(latest)
    if (conflictPrices.value) {
      pricePage.value = conflictPrices.value
      for (const row of conflictPrices.value.items) {
        priceDraft[row.skuId] = { salePrice: row.salePrice, compareAtPrice: row.compareAtPrice ?? '', costPrice: row.costPrice ?? '' }
      }
    }
    inventorySummary.value = conflictInventory.value
  } else {
    product.value = latest
    if (conflictPrices.value) pricePage.value = conflictPrices.value
    if (conflictInventory.value) inventorySummary.value = conflictInventory.value
    matrixPreview.value = null
    matrixPreviewBody.value = null
    confirmMatrixChanges.value = false
  }
  conflictLatest.value = null
  conflictPrices.value = null
  conflictInventory.value = null
  sectionErrors[conflictSection.value] = ''
  if (choice === 'keep') sectionErrors[conflictSection.value] = '本地输入已保留。再次保存会以服务器最新修订号提交，请先确认上方差异。'
  conflictSection.value = ''
}

async function handleSectionError(section: string, error: unknown) {
  sectionErrors[section] = error instanceof Error ? error.message : '操作失败，请重试。'
  if (error instanceof AdminApiError && error.code === 'PRODUCT_REVISION_CONFLICT') await refreshConflict(section)
}

function setProductRevision(revision: number) {
  if (product.value) product.value = { ...product.value, revision }
}

async function saveBasic() {
  if (!product.value || isArchived.value || saving.value) return
  saving.value = 'basic'
  clearSectionStatus('basic')
  try {
    const updated = await request<ProductDetail>(`/api/v1/admin/products/${productId.value}`, {
      method: 'PATCH',
      body: { expectedRevision: product.value.revision, name: name.value.trim(), description: description.value, productType: productType.value },
    })
    product.value = updated
    name.value = updated.name
    description.value = updated.description
    productType.value = updated.productType
    dirty.basic = false
    sectionSuccess.basic = '商品基础信息已保存。'
  } catch (error) { await handleSectionError('basic', error) } finally { saving.value = '' }
}

function setPrimaryCategory(id: string) {
  const categoryId = id === noCategoryValue ? '' : id
  primaryCategoryId.value = categoryId
  if (categoryId && !categorySelection.value.includes(categoryId)) categorySelection.value = [...categorySelection.value, categoryId]
  if (!categoryId) categorySelection.value = []
  dirty.categories = true
  clearSectionStatus('categories')
}

function toggleSecondaryCategory(id: string) {
  if (!primaryCategoryId.value) {
    primaryCategoryId.value = id
    categorySelection.value = [id]
  } else if (id === primaryCategoryId.value) return
  else if (categorySelection.value.includes(id)) categorySelection.value = categorySelection.value.filter(categoryId => categoryId !== id)
  else categorySelection.value = [...categorySelection.value, id]
  dirty.categories = true
  clearSectionStatus('categories')
}

async function saveCategories() {
  if (!product.value || isArchived.value || saving.value) return
  if (categorySelection.value.length && !categorySelection.value.includes(primaryCategoryId.value)) {
    sectionErrors.categories = '请设置一个主分类，或清空所有分类。'
    return
  }
  saving.value = 'categories'
  clearSectionStatus('categories')
  try {
    const assignments = categorySelection.value.map((categoryId, index) => ({
      categoryId,
      isPrimary: categoryId === primaryCategoryId.value,
      sortOrder: categoryId === primaryCategoryId.value ? 0 : index + 1,
    }))
    const updated = await request<ProductDetail>(`/api/v1/admin/products/${productId.value}/categories`, {
      method: 'PUT', body: { expectedRevision: product.value.revision, assignments },
    })
    product.value = updated
    categorySelection.value = updated.categories.map(category => category.categoryId)
    primaryCategoryId.value = updated.categories.find(category => category.isPrimary)?.categoryId ?? ''
    dirty.categories = false
    sectionSuccess.categories = '商品分类已保存。'
  } catch (error) { await handleSectionError('categories', error) } finally { saving.value = '' }
}

function addAttribute() {
  if (attributesDraft.value.length >= 30) return
  attributesDraft.value.push({ name: '', value: '' })
  dirty.attributes = true
}
function removeAttribute(index: number) {
  attributesDraft.value.splice(index, 1)
  dirty.attributes = true
}
async function saveAttributes() {
  if (!product.value || isArchived.value || saving.value) return
  saving.value = 'attributes'
  clearSectionStatus('attributes')
  try {
    const updated = await request<ProductDetail>(`/api/v1/admin/products/${productId.value}/attributes`, {
      method: 'PUT',
      body: {
        expectedRevision: product.value.revision,
        attributes: attributesDraft.value.map((attribute, index) => ({
          ...(attribute.id ? { id: attribute.id } : {}), name: attribute.name.trim(), value: attribute.value.trim(), sortOrder: index,
        })),
      },
    })
    product.value = updated
    attributesDraft.value = updated.attributes.map(attribute => ({ id: attribute.id, name: attribute.name, value: attribute.value }))
    dirty.attributes = false
    sectionSuccess.attributes = '商品属性已保存。'
  } catch (error) { await handleSectionError('attributes', error) } finally { saving.value = '' }
}

function markGalleryDirty() {
  dirty.gallery = true
  clearSectionStatus('gallery')
}
function galleryIds() { return galleryDraft.value.map(image => image.id) }
function moveGalleryImage(index: number, offset: -1 | 1) {
  const next = index + offset
  if (next < 0 || next >= galleryDraft.value.length) return
  const rows = [...galleryDraft.value]
  const [image] = rows.splice(index, 1)
  rows.splice(next, 0, image!)
  galleryDraft.value = rows.map((row, sortOrder) => ({ ...row, sortOrder }))
  markGalleryDirty()
}
function removeGalleryReference(id: string) {
  galleryDraft.value = galleryDraft.value.filter(image => image.id !== id).map((image, sortOrder) => ({ ...image, sortOrder }))
  markGalleryDirty()
}
function appendGalleryImage(media: ProductMediaMetadata | ProductMediaLibraryPage['items'][number]) {
  if (galleryDraft.value.some(image => image.id === media.id) || galleryDraft.value.length >= 20) return
  const detail = media.variants.find(variant => variant.variant === 'detail')!
  const thumbnail = media.variants.find(variant => variant.variant === 'thumbnail')!
  const card = media.variants.find(variant => variant.variant === 'card')!
  galleryDraft.value = [...galleryDraft.value, {
    id: media.id,
    sortOrder: galleryDraft.value.length,
    width: detail.width,
    height: detail.height,
    thumbnailUrl: thumbnail.url,
    cardUrl: card.url,
    detailUrl: detail.url,
    createdAt: media.createdAt,
  }]
  markGalleryDirty()
}

async function uploadImages(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  if (galleryDraft.value.length + files.length > 20) {
    uploadMessage.value = '商品相册最多保留 20 张图片。'
    return
  }
  for (const file of files) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      uploadMessage.value = `${file.name}：请选择 JPEG、PNG 或 WebP 图片。`
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      uploadMessage.value = `${file.name}：图片不能超过 10 MB。`
      return
    }
  }
  uploadMessage.value = '正在通过同源管理接口处理图片…'
  try {
    for (const file of files) {
      const media = await upload<ProductMediaMetadata>('/api/v1/admin/media', file, percent => { uploadProgress.value = percent })
      appendGalleryImage(media)
    }
    uploadMessage.value = '图片已上传并加入待保存相册。请保存相册后，图片才会关联到本商品。'
  } catch (error) {
    uploadMessage.value = error instanceof Error ? error.message : '图片上传失败。'
  } finally { uploadProgress.value = null }
}

async function saveGallery() {
  if (!product.value || isArchived.value || saving.value) return
  saving.value = 'gallery'
  clearSectionStatus('gallery')
  try {
    const result = await request<{ productId: string; revision: number; images: ProductGalleryImage[] }>(`/api/v1/admin/products/${productId.value}/media`, {
      method: 'PUT', body: { expectedRevision: product.value.revision, mediaIds: galleryIds() },
    })
    setProductRevision(result.revision)
    galleryDraft.value = result.images
    if (product.value) product.value = { ...product.value, gallery: result.images }
    dirty.gallery = false
    sectionSuccess.gallery = '商品相册顺序与引用已保存。'
    uploadMessage.value = ''
    if (mediaLibraryOpen.value) await loadMediaLibrary(mediaLibraryPage.value)
  } catch (error) { await handleSectionError('gallery', error) } finally { saving.value = '' }
}

async function loadMediaLibrary(page = 1) {
  mediaLibraryPage.value = page
  const query = new URLSearchParams({ page: String(page), pageSize: '24' })
  if (mediaSearch.value.trim()) query.set('search', mediaSearch.value.trim())
  try { mediaLibrary.value = await request<ProductMediaLibraryPage>(`/api/v1/admin/media?${query.toString()}`) }
  catch (error) { uploadMessage.value = error instanceof Error ? error.message : '图片库加载失败。' }
}
async function openMediaLibrary() {
  mediaLibraryOpen.value = true
  await loadMediaLibrary(1)
}
function mediaUsedInRichContent(value: unknown, mediaId: string): boolean {
  if (!value || typeof value !== 'object') return false
  const node = value as { type?: string; attrs?: { mediaId?: string }; content?: unknown[] }
  if (node.type === 'image' && node.attrs?.mediaId?.toLowerCase() === mediaId.toLowerCase()) return true
  return node.content?.some(child => mediaUsedInRichContent(child, mediaId)) ?? false
}
async function permanentlyDeleteMedia(mediaId: string) {
  if (galleryDraft.value.some(image => image.id === mediaId) || mediaUsedInRichContent(richDraft.value, mediaId)) {
    uploadMessage.value = '这张图片仍在当前编辑内容中，请先移除相册引用和正文图片，再保存关联变更。'
    return
  }
  const item = mediaLibrary.value?.items.find(image => image.id === mediaId)
  if (!item || item.referenceCount > 0) return
  if (!window.confirm('永久删除这份未引用的图片文件？此操作不可恢复。')) return
  deletingMediaId.value = mediaId
  try {
    await request(`/api/v1/admin/media/${mediaId}`, { method: 'DELETE' })
    await loadMediaLibrary(mediaLibraryPage.value)
  } catch (error) { uploadMessage.value = error instanceof Error ? error.message : '图片删除失败。' }
  finally { deletingMediaId.value = '' }
}

async function saveRichContent() {
  if (!product.value || isArchived.value || saving.value) return
  saving.value = 'rich'
  clearSectionStatus('rich')
  try {
    const content = validateProductRichContent(richDraft.value).document
    const result = await request<{ productId: string; revision: number; content: ProductRichContent }>(`/api/v1/admin/products/${productId.value}/rich-content`, {
      method: 'PUT', body: { expectedRevision: product.value.revision, content },
    })
    setProductRevision(result.revision)
    richDraft.value = result.content
    if (product.value) product.value = { ...product.value, richContent: result.content }
    dirty.rich = false
    sectionSuccess.rich = '图文详情已保存并通过结构校验。'
  } catch (error) { await handleSectionError('rich', error) } finally { saving.value = '' }
}

function matrixKey(ids: string[]) { return ids.length ? `v1:${[...ids].map(id => id.toLowerCase()).sort().join('.')}` : '' }
function markMatrixDirty() {
  dirty.matrix = true
  matrixPageNumber.value = 1
  matrixPreview.value = null
  matrixPreviewBody.value = null
  confirmMatrixChanges.value = false
  clearSectionStatus('matrix')
}
function addOptionGroup() {
  if (groupsDraft.value.length >= 5) return
  groupsDraft.value.push({
    id: crypto.randomUUID(), name: `规格${groupsDraft.value.length + 1}`, sortOrder: groupsDraft.value.length, enabled: true,
    values: [{ id: crypto.randomUUID(), name: '选项1', sortOrder: 0, enabled: true }],
  })
  markMatrixDirty()
}
function addOptionValue(group: DraftGroup) {
  if (group.values.length >= 50) return
  group.values.push({ id: crypto.randomUUID(), name: `选项${group.values.length + 1}`, sortOrder: group.values.length, enabled: true })
  markMatrixDirty()
}
function removeOptionGroup(groupId: string) {
  groupsDraft.value = groupsDraft.value.filter(group => group.id !== groupId).map((group, index) => ({ ...group, sortOrder: index }))
  markMatrixDirty()
}
function removeOptionValue(group: DraftGroup, valueId: string) {
  group.values = group.values.filter(value => value.id !== valueId).map((value, index) => ({ ...value, sortOrder: index }))
  markMatrixDirty()
}
function moveOptionGroup(index: number, offset: -1 | 1) {
  const next = index + offset
  if (next < 0 || next >= groupsDraft.value.length) return
  const rows = [...groupsDraft.value]
  const [group] = rows.splice(index, 1)
  rows.splice(next, 0, group!)
  groupsDraft.value = rows.map((row, sortOrder) => ({ ...row, sortOrder }))
  markMatrixDirty()
}
function moveOptionValue(group: DraftGroup, index: number, offset: -1 | 1) {
  const next = index + offset
  if (next < 0 || next >= group.values.length) return
  const rows = [...group.values]
  const [value] = rows.splice(index, 1)
  rows.splice(next, 0, value!)
  group.values = rows.map((row, sortOrder) => ({ ...row, sortOrder }))
  markMatrixDirty()
}
function toggleMatrixCombination(combination: MatrixCombination, selected: boolean) {
  selectedMatrixKeys.value = selected
    ? [...new Set([...selectedMatrixKeys.value, combination.key])]
    : selectedMatrixKeys.value.filter(key => key !== combination.key)
  markMatrixDirty()
}
function setSkuEnabled(variantId: string, enabled: boolean) {
  skuEnabledDraft[variantId] = enabled
  markMatrixDirty()
}
function requestRetirement(variant: ProductDetail['variants'][number]) {
  const inventory = inventorySummary.value?.variants.find(row => row.skuId === variant.id)
  const stocked = inventory?.inventory.stocked ?? 0
  const reserved = inventory?.inventory.reserved ?? 0
  if (!window.confirm(`永久退役 ${variant.skuCode}？这会永久停用该 SKU；当前库存 ${stocked}，预留 ${reserved}。库存未清零时后端会阻止退役。`)) return
  retireSkuIds.value = [...new Set([...retireSkuIds.value, variant.id])]
  selectedMatrixKeys.value = selectedMatrixKeys.value.filter(key => key !== matrixKey(variant.options.map(option => option.valueId)))
  markMatrixDirty()
}
function cancelRetirement(variant: ProductDetail['variants'][number]) {
  retireSkuIds.value = retireSkuIds.value.filter(id => id !== variant.id)
  const key = matrixKey(variant.options.map(option => option.valueId))
  if (key) selectedMatrixKeys.value = [...new Set([...selectedMatrixKeys.value, key])]
  markMatrixDirty()
}
function matrixBody(): ProductVariantMatrixBody {
  if (!product.value) throw new Error('Product is not loaded')
  const groups = groupsDraft.value.map(group => ({
    ...group,
    name: group.name.trim(),
    values: group.values.map(value => ({ ...value, name: value.name.trim() })),
  }))
  const defaultSku = product.value.variants.find(variant => variant.isDefault
    && !variant.retiredAt
    && !retireSkuIds.value.includes(variant.id)
    && variant.options.length === 0)
  if (matrixMode.value === 'all' && !defaultSku) {
    const skuEnabledUpdates = product.value.variants
      .filter(variant => variant.retiredAt === null
        && skuEnabledDraft[variant.id] !== undefined
        && skuEnabledDraft[variant.id] !== variant.enabled)
      .map(variant => ({ skuId: variant.id, enabled: skuEnabledDraft[variant.id]! }))
    return {
      mode: 'all',
      expectedRevision: product.value.revision,
      groups,
      newSkuDefaults: { salePrice: newSkuPrice.value.trim(), enabled: newSkuEnabled.value },
      ...(skuEnabledUpdates.length ? { skuEnabledUpdates } : {}),
      ...(retireSkuIds.value.length ? { retireSkuIds: [...retireSkuIds.value] } : {}),
    }
  }
  const requestedCombinations = allCombinations.value
    .filter(combination => matrixMode.value === 'all' || selectedMatrixKeySet.value.has(combination.key))
  const combinations = requestedCombinations
    .map(combination => combination.sku
      ? {
          skuId: combination.sku.id,
          optionValueIds: combination.valueIds,
          enabled: skuEnabledDraft[combination.sku.id] ?? combination.sku.enabled,
        }
      : { optionValueIds: combination.valueIds, salePrice: newSkuPrice.value.trim(), enabled: newSkuEnabled.value })
  return {
    mode: 'selected',
    expectedRevision: product.value.revision,
    groups,
    combinations,
    ...(retireSkuIds.value.length ? { retireSkuIds: [...retireSkuIds.value] } : {}),
  }
}
async function previewMatrix() {
  if (!product.value || isArchived.value || saving.value) return
  if (legacyDefaultSkuNeedsRetirement.value) {
    sectionErrors.matrix = 'D1 默认 SKU 不能直接改配到规格组合。请先在 SKU 清单中显式永久退役，保留其历史身份；库存未清时预览会阻止退役。'
    matrixPreview.value = null
    matrixPreviewBody.value = null
    return
  }
  if (matrixMode.value === 'all' && allCombinations.value.some(combination => combination.retired)) {
    sectionErrors.matrix = '全部组合包含永久退役 SKU。请选择要保留的组合，退役 SKU 不能重新生成。'
    matrixPreview.value = null
    matrixPreviewBody.value = null
    return
  }
  if (matrixMode.value === 'all' && retireSkuIds.value.length > 0) {
    sectionErrors.matrix = '自动生成全部组合会保留所有现有组合。若要永久退役 SKU，请切换为“保留所选组合”并预览差异。'
    matrixPreview.value = null
    matrixPreviewBody.value = null
    return
  }
  saving.value = 'matrix-preview'
  clearSectionStatus('matrix')
  const body = matrixBody()
  try {
    matrixPreview.value = await request<ProductVariantMatrixPreview>(`/api/v1/admin/products/${productId.value}/variant-matrix/preview`, {
      method: 'POST', body,
    })
    matrixPreviewBody.value = body
    confirmMatrixChanges.value = false
  } catch (error) {
    matrixPreview.value = null
    matrixPreviewBody.value = null
    await handleSectionError('matrix', error)
  } finally { saving.value = '' }
}
async function saveMatrix() {
  if (!product.value || !matrixPreview.value || !matrixPreviewBody.value || isArchived.value || saving.value) return
  if (matrixNeedsConfirmation.value && !confirmMatrixChanges.value) {
    sectionErrors.matrix = '请先查看差异并确认此规格变更。'
    return
  }
  if (matrixBlockedChanges.value.length) {
    sectionErrors.matrix = '当前差异包含有库存、预留或历史引用的 SKU，先处理这些 SKU 的库存与引用。'
    return
  }
  saving.value = 'matrix'
  clearSectionStatus('matrix')
  try {
    const result = await request<ProductVariantMatrixSaveResult>(`/api/v1/admin/products/${productId.value}/variant-matrix`, {
      method: 'PUT', body: matrixPreviewBody.value,
    })
    product.value = result.product
    for (const variant of result.product.variants) skuEnabledDraft[variant.id] = variant.enabled
    groupsDraft.value = result.product.optionGroups.map(group => ({
      id: group.id, name: group.name, sortOrder: group.sortOrder, enabled: group.enabled,
      values: group.values.map(value => ({ id: value.id, name: value.name, sortOrder: value.sortOrder, enabled: value.enabled })),
    }))
    selectedMatrixKeys.value = result.product.variants.filter(variant => variant.retiredAt === null)
      .map(variant => matrixKey(variant.options.map(option => option.valueId)))
    retireSkuIds.value = []
    matrixPreview.value = null
    matrixPreviewBody.value = null
    confirmMatrixChanges.value = false
    dirty.matrix = false
    sectionSuccess.matrix = '规格组和 SKU 矩阵已保存，已有 SKU 身份与价格已按后端差异结果保留。'
    await Promise.all([loadPricePage(1), loadInventory()])
  } catch (error) { await handleSectionError('matrix', error) } finally { saving.value = '' }
}

function priceChanged(row: AdminProductVariantPrices) {
  const draft = priceDraft[row.skuId]
  return Boolean(draft && (draft.salePrice.trim() !== row.salePrice
    || draft.compareAtPrice.trim() !== (row.compareAtPrice ?? '')
    || draft.costPrice.trim() !== (row.costPrice ?? '')))
}
function markPriceDirty() { dirty.prices = currentPriceItems.value.some(priceChanged) }
function applyBulkSalePrice() {
  if (!bulkSalePrice.value.trim()) return
  for (const row of currentPriceItems.value) {
    if (row.retiredAt === null && priceDraft[row.skuId]) priceDraft[row.skuId]!.salePrice = bulkSalePrice.value.trim()
  }
  markPriceDirty()
}
async function savePrices() {
  if (!product.value || isArchived.value || saving.value || !pricePage.value) return
  const updates = pricePage.value.items.filter(priceChanged).map(row => {
    const draft = priceDraft[row.skuId]!
    return {
      skuId: row.skuId,
      expectedSkuRevision: row.skuRevision,
      ...(draft.salePrice.trim() !== row.salePrice ? { salePrice: draft.salePrice.trim() } : {}),
      ...(draft.compareAtPrice.trim() !== (row.compareAtPrice ?? '') ? { compareAtPrice: draft.compareAtPrice.trim() || null } : {}),
      ...(draft.costPrice.trim() !== (row.costPrice ?? '') ? { costPrice: draft.costPrice.trim() || null } : {}),
    }
  })
  if (!updates.length) { dirty.prices = false; return }
  saving.value = 'prices'
  clearSectionStatus('prices')
  try {
    const result = await request<{ productId: string; productRevision: number; items: AdminProductVariantPrices[] }>(`/api/v1/admin/products/${productId.value}/prices/batch`, {
      method: 'PATCH', body: { expectedRevision: product.value.revision, updates },
    })
    setProductRevision(result.productRevision)
    pricePage.value = { ...pricePage.value, productRevision: result.productRevision,
      items: pricePage.value.items.map(row => result.items.find(updated => updated.skuId === row.skuId) ?? row) }
    for (const row of result.items) priceDraft[row.skuId] = { salePrice: row.salePrice, compareAtPrice: row.compareAtPrice ?? '', costPrice: row.costPrice ?? '' }
    dirty.prices = false
    sectionSuccess.prices = `已原子保存 ${result.items.length} 个 SKU 的价格。`
  } catch (error) { await handleSectionError('prices', error) } finally { saving.value = '' }
}
async function changePricePage(page: number) {
  if (dirty.prices && !window.confirm('本页价格尚未保存，切换页面会丢弃这些输入。继续吗？')) return
  if (dirty.prices && pricePage.value) {
    for (const row of pricePage.value.items) delete priceDraft[row.skuId]
    dirty.prices = false
  }
  try { await loadPricePage(page) } catch (error) { sectionErrors.prices = error instanceof Error ? error.message : '价格加载失败。' }
}

function inventoryModeLabel(mode: ProductInventoryMode | null) {
  return mode === null ? '未配置' : mode === 'quantity' ? '按数量管理' : mode === 'resource_pool' ? '资源池未就绪' : mode === 'external' ? '供应商未就绪' : '不限数量（非自动交付）'
}
function inventorySummaryText(row: AdminProductVariantInventory) {
  const inventory = row.inventory
  if (inventory.mode === 'quantity') return `实际 ${inventory.stocked} · 预留 ${inventory.reserved} · 可售 ${inventory.available}`
  if (inventory.mode === 'resource_pool') return '资源池未就绪，暂不可确认可售数量。'
  if (inventory.mode === 'external') return '供应商尚未接入，暂不可确认可售数量。'
  if (inventory.mode === 'unlimited') return '不限数量；需单独开启并人工完成数字交付。'
  return '库存尚未配置。'
}
async function changeInventoryMode(row: AdminProductVariantInventory, value: string) {
  if (!product.value || saving.value) return
  const inventoryMode = value === 'null' ? null : value as ProductInventoryMode
  if (inventoryMode === row.inventory.mode) return
  if (!window.confirm(`将 ${row.skuCode} 的库存模式从“${inventoryModeLabel(row.inventory.mode)}”切换为“${inventoryModeLabel(inventoryMode)}”？已有数量不会因切换而清除；若有库存或流水，服务端会拒绝不安全的切换。`)) {
    await loadInventory()
    return
  }
  saving.value = `inventory-mode-${row.skuId}`
  clearSectionStatus('inventory')
  try {
    const updated = await request<AdminProductVariantInventory>(`/api/v1/admin/products/${productId.value}/variants/${row.skuId}/inventory-mode`, {
      method: 'PUT', body: {
        expectedRevision: product.value.revision,
        expectedSkuRevision: row.skuRevision,
        expectedInventoryRevision: row.inventoryRevision,
        inventoryMode,
      },
    })
    setProductRevision(updated.productRevision)
    await loadInventory()
    sectionSuccess.inventory = `${row.skuCode} 的库存模式已更新。`
  } catch (error) { await handleSectionError('inventory', error); await loadInventory().catch(() => undefined) }
  finally { saving.value = '' }
}

async function submitAdjustment() {
  if (!product.value || !inventorySummary.value || saving.value) return
  if (!historySkuId.value) { adjustmentMessage.value = '请先选择一个 SKU。'; return }
  const inventory = inventorySummary.value.variants.find(row => row.skuId === historySkuId.value)
  if (!inventory || inventory.inventory.mode !== 'quantity') { adjustmentMessage.value = '只有按数量管理的 SKU 可以调整数量。'; return }
  if (!pendingAdjustment.value) {
    const quantity = Number(adjustmentQuantity.value)
    if (!Number.isSafeInteger(quantity) || quantity < (adjustmentAction.value === 'set' ? 0 : 1)) {
      adjustmentMessage.value = '数量必须是有效的非负整数。'
      return
    }
    if (!adjustmentReason.value.trim()) { adjustmentMessage.value = '请填写库存调整原因。'; return }
    const common = { operationId: crypto.randomUUID(), expectedInventoryRevision: inventory.inventoryRevision, reason: adjustmentReason.value.trim() }
    const body: CreateInventoryAdjustmentBody = adjustmentAction.value === 'set'
      ? { ...common, action: 'set', quantity }
      : { ...common, action: adjustmentAction.value, quantity }
    pendingAdjustment.value = { skuId: historySkuId.value, body }
    sessionStorage.setItem(`aikayun-admin-inventory-operation:${productId.value}`, JSON.stringify(pendingAdjustment.value))
  }
  const pending = pendingAdjustment.value
  if (!pending || pending.skuId !== historySkuId.value) { adjustmentMessage.value = '存在另一件商品的待核验库存操作，请先完成核验。'; return }
  saving.value = 'inventory-adjustment'
  adjustmentMessage.value = '正在核验并提交库存操作…'
  try {
    const lookup = await request<InventoryAdjustmentPage>(`/api/v1/admin/products/${productId.value}/variants/${pending.skuId}/inventory/adjustments?operationId=${pending.body.operationId}&limit=1`)
    const prior = lookup.adjustments[0]
    if (prior) {
      adjustmentMessage.value = `操作已完成：库存 ${prior.quantityBefore} → ${prior.quantityAfter}。`
    } else {
      const result = await request<{ operationId: string; quantityBefore: number; quantityAfter: number }>(`/api/v1/admin/products/${productId.value}/variants/${pending.skuId}/inventory/adjustments`, {
        method: 'POST', body: pending.body,
      })
      adjustmentMessage.value = `库存已更新：${result.quantityBefore} → ${result.quantityAfter}。`
    }
    pendingAdjustment.value = null
    sessionStorage.removeItem(`aikayun-admin-inventory-operation:${productId.value}`)
    await loadInventory()
    if (historySkuId.value) await loadInventoryHistory(false)
  } catch (error) {
    const status = error instanceof AdminApiError ? error.status : 0
    adjustmentMessage.value = status === 0 || status >= 500
      ? '操作结果暂不确定。再次点击会先按原 operationId 查询，再以相同 ID 安全重试。'
      : error instanceof Error ? error.message : '库存调整失败。'
    if (status > 0 && status < 500) {
      pendingAdjustment.value = null
      sessionStorage.removeItem(`aikayun-admin-inventory-operation:${productId.value}`)
      await loadInventory()
    }
  } finally { saving.value = '' }
}

async function loadInventoryHistory(append: boolean) {
  if (!historySkuId.value) return
  historyLoading.value = true
  historyError.value = ''
  const query = new URLSearchParams({ limit: String(historyPageSize) })
  if (append && history.value?.nextCursor) {
    query.set('beforeCreatedAt', history.value.nextCursor.createdAt)
    query.set('beforeId', history.value.nextCursor.id)
  }
  try {
    const result = await request<InventoryAdjustmentPage>(`/api/v1/admin/products/${productId.value}/variants/${historySkuId.value}/inventory/adjustments?${query.toString()}`)
    history.value = append && history.value
      ? { ...result, adjustments: [...history.value.adjustments, ...result.adjustments] }
      : result
  } catch (error) { historyError.value = error instanceof Error ? error.message : '库存流水加载失败。' }
  finally { historyLoading.value = false }
}
async function viewInventoryHistory(skuId: string) {
  historySkuId.value = skuId
  adjustmentMessage.value = ''
  await loadInventoryHistory(false)
}

function categoryDepth(categoryId: string): number {
  let depth = 0
  let current = categories.value.find(category => category.id === categoryId)
  const seen = new Set<string>()
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id)
    depth += 1
    current = categories.value.find(category => category.id === current!.parentId)
  }
  return depth
}
function categorySubtreeHeight(categoryId: string): number {
  const children = categories.value.filter(category => category.parentId === categoryId)
  return children.length ? 1 + Math.max(...children.map(category => categorySubtreeHeight(category.id))) : 0
}
function isDescendant(candidateId: string, parentId: string): boolean {
  let current = categories.value.find(category => category.id === candidateId)
  const seen = new Set<string>()
  while (current?.parentId && !seen.has(current.id)) {
    if (current.parentId === parentId) return true
    seen.add(current.id)
    current = categories.value.find(category => category.id === current!.parentId)
  }
  return false
}
function allowedCategoryParents(category?: AdminProductCategory) {
  return [
    { label: '顶层分类', value: rootCategoryValue },
    ...categoryTree.value
      .filter(({ category: candidate }) => {
        if (!category) return categoryDepth(candidate.id) < 3
        if (candidate.id === category.id || isDescendant(candidate.id, category.id)) return false
        return categoryDepth(candidate.id) + 1 + categorySubtreeHeight(category.id) <= 3
      })
      .map(({ category: candidate, depth, path }) => ({ label: `${'　'.repeat(depth)}${path}`, value: candidate.id })),
  ]
}
async function createCategory() {
  categoryMessage.value = ''
  if (!newCategoryName.value.trim()) { categoryMessage.value = '请输入分类名称。'; return }
  if (newCategoryParentId.value !== rootCategoryValue && categoryDepth(newCategoryParentId.value) >= 3) { categoryMessage.value = '分类最多四级。'; return }
  try {
    await request<AdminProductCategory>('/api/v1/admin/categories', {
      method: 'POST', body: { name: newCategoryName.value.trim(), parentId: newCategoryParentId.value === rootCategoryValue ? null : newCategoryParentId.value },
    })
    newCategoryName.value = ''
    newCategoryParentId.value = rootCategoryValue
    await loadCategories()
    categoryMessage.value = '分类已创建。'
  } catch (error) { categoryMessage.value = error instanceof Error ? error.message : '分类创建失败。' }
}
async function updateCategory(category: AdminProductCategory, change: Record<string, unknown>, message: string) {
  categoryMessage.value = ''
  try {
    await request<AdminProductCategory>(`/api/v1/admin/categories/${category.id}`, {
      method: 'PATCH', body: { expectedRevision: category.revision, ...change },
    })
    await loadCategories()
    categoryMessage.value = message
  } catch (error) { categoryMessage.value = error instanceof Error ? error.message : '分类更新失败。' }
}
async function renameCategory(category: AdminProductCategory) {
  await updateCategory(category, { name: categoryNameDraft[category.id]?.trim() }, '分类名称已保存。')
}
async function moveCategory(category: AdminProductCategory) {
  const parentId = categoryParentDraft[category.id] === rootCategoryValue ? null : categoryParentDraft[category.id] || null
  if (parentId && (parentId === category.id || isDescendant(parentId, category.id))) { categoryMessage.value = '不能移动到自身或其子分类。'; return }
  if (parentId && categoryDepth(parentId) + 1 + categorySubtreeHeight(category.id) > 3) { categoryMessage.value = '此移动会形成五级分类，请选择较浅的父级。'; return }
  await updateCategory(category, { parentId }, '分类层级已更新。')
}
async function reorderCategory(category: AdminProductCategory, direction: 'first' | 'last') {
  const target = direction === 'first' ? 0 : 1_000_000
  await updateCategory(category, { sortOrder: target }, direction === 'first' ? '分类已移到同级最前。' : '分类已移到同级最后。')
}
async function deleteCategory(category: AdminProductCategory) {
  if (!window.confirm(`删除分类“${category.name}”？有子分类或已关联商品时，服务端会阻止删除。`)) return
  try {
    await request(`/api/v1/admin/categories/${category.id}`, { method: 'DELETE', body: { expectedRevision: category.revision } })
    await loadCategories()
    categoryMessage.value = '分类已删除。'
  } catch (error) { categoryMessage.value = error instanceof Error ? error.message : '分类删除失败。' }
}

async function changeLifecycle(status: ProductDetail['status']) {
  if (!product.value || saving.value) return
  const confirmation = status === 'archived'
    ? '归档后商品经营配置变为只读，价格、库存、规格、图片和图文内容会保留。确认归档？'
    : status === 'draft' && product.value.status === 'archived'
      ? '恢复为草稿后可以继续编辑商品经营配置。确认恢复？'
      : ''
  if (confirmation && !window.confirm(confirmation)) return
  saving.value = 'lifecycle'
  try {
    const updated = await request<ProductDetail>(`/api/v1/admin/products/${productId.value}/lifecycle`, {
      method: 'PATCH', body: { expectedRevision: product.value.revision, status },
    })
    product.value = updated
    sectionSuccess.lifecycle = `商品状态已更新为“${({ draft: '草稿', active: '销售中', paused: '已暂停', archived: '已归档' })[updated.status]}”。`
  } catch (error) { await handleSectionError('lifecycle', error) } finally { saving.value = '' }
}
async function copyProduct() {
  if (!product.value || saving.value) return
  saving.value = 'copy'
  try {
    const copy = await request<ProductDetail>(`/api/v1/admin/products/${productId.value}/copy`, {
      method: 'POST', body: { expectedRevision: product.value.revision },
    })
    await navigateTo(`/admin/products/${copy.id}`)
  } catch (error) { sectionErrors.advanced = error instanceof Error ? error.message : '复制商品失败。' }
  finally { saving.value = '' }
}
async function deleteProduct() {
  if (!product.value || saving.value) return
  if (!window.confirm(`永久删除商品“${product.value.name}”？有库存或历史业务引用时，服务端会阻止删除；归档可以保留记录。`)) return
  saving.value = 'delete'
  try {
    await request(`/api/v1/admin/products/${productId.value}`, {
      method: 'DELETE', body: { expectedRevision: product.value.revision },
    })
    dirty.basic = false
    dirty.categories = false
    dirty.attributes = false
    dirty.gallery = false
    dirty.rich = false
    dirty.matrix = false
    dirty.prices = false
    dirty.inventory = false
    await router.replace('/admin/products')
  } catch (error) { sectionErrors.advanced = error instanceof Error ? error.message : '商品删除失败。' }
  finally { saving.value = '' }
}

function variantOptionsText(variant: ProductDetail['variants'][number]) {
  return variant.options.length ? variant.options.map(option => `${option.groupName}：${option.valueName}`).join(' / ') : '默认 SKU'
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
function priceForSku(skuId: string) { return pricePage.value?.items.find(row => row.skuId === skuId) }
function inventoryForSku(skuId: string) { return inventorySummary.value?.variants.find(row => row.skuId === skuId) }
</script>

<template>
  <UDashboardPanel id="admin-main">
    <template #header>
      <UDashboardNavbar title="商品编辑">
        <template #right>
          <ThemeModeSelect />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <main
        id="admin-main"
        class="mx-auto w-full max-w-[96rem] min-w-0 px-4 py-5 sm:px-6 lg:px-8"
        :data-admin-product-ready="clientReady"
      >
        <div
          v-if="loading"
          class="grid gap-5"
          aria-label="正在加载商品"
        >
          <USkeleton class="h-28 rounded-xl" />
          <USkeleton class="h-72 rounded-xl" />
          <USkeleton class="h-72 rounded-xl" />
        </div>
        <section
          v-else-if="loadError && !product"
          class="mx-auto max-w-2xl py-16"
        >
          <UAlert
            color="error"
            variant="soft"
            :title="loadError"
            role="alert"
          />
          <div class="mt-4 flex gap-2">
            <UButton @click="loadProduct">
              重试
            </UButton>
            <UButton
              to="/admin/products"
              color="neutral"
              variant="outline"
            >
              返回商品列表
            </UButton>
          </div>
        </section>
        <template v-else-if="product">
          <nav
            aria-label="面包屑"
            class="mb-4 text-sm text-muted"
          >
            <NuxtLink
              to="/admin/products"
              class="rounded-sm hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
            >
              商品管理
            </NuxtLink>
            <span
              aria-hidden="true"
              class="px-2"
            >/</span>
            <span class="text-highlighted">编辑商品</span>
          </nav>

          <header class="mb-5 flex min-w-0 flex-col gap-4 border-b border-default pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <UBadge
                  :color="product.status === 'active' ? 'success' : product.status === 'archived' ? 'neutral' : product.status === 'paused' ? 'warning' : 'info'"
                  variant="subtle"
                >
                  {{ statusName }}
                </UBadge>
                <UBadge
                  color="neutral"
                  variant="outline"
                >
                  {{ product.productType === 'digital' ? '数字商品' : product.productType === 'physical' ? '实物商品' : '服务' }}
                </UBadge>
                <span class="font-mono text-xs text-dimmed">{{ product.id }}</span>
              </div>
              <h1 class="mt-2 break-words text-2xl font-semibold tracking-tight text-highlighted sm:text-3xl">
                {{ product.name }}
              </h1>
              <p class="mt-1 text-sm text-muted">
                商品修订 {{ product.revision }} · 创建于 {{ formatDate(product.createdAt) }}
              </p>
            </div>
            <div class="flex flex-wrap gap-2 sm:justify-end">
              <UButton
                to="/admin/products"
                color="neutral"
                variant="outline"
                size="lg"
              >
                返回列表
              </UButton>
              <UButton
                icon="i-lucide-save"
                size="lg"
                :loading="saving === 'basic'"
                :disabled="isArchived || saving !== '' || !dirty.basic"
                @click="saveBasic"
              >
                保存基本资料
              </UButton>
            </div>
          </header>

          <UAlert
            v-if="loadError"
            class="mb-4"
            color="warning"
            variant="soft"
            :title="loadError"
          />
          <UAlert
            v-if="hasUnsavedChanges"
            class="mb-4"
            color="warning"
            variant="soft"
            title="有尚未保存的修改。"
          >
            <p class="mt-1 text-sm">
              离开本页前会提示确认。各分区分别保存，库存流水使用独立修订号。
            </p>
          </UAlert>
          <UAlert
            v-if="isArchived"
            class="mb-4"
            color="neutral"
            variant="soft"
            title="商品已归档，经营配置为只读。"
          >
            <p class="mt-1 text-sm">
              价格、规格、商品资料、图片和图文内容均已保留。库存历史维护仍由服务端业务规则决定。
            </p>
          </UAlert>

          <section
            v-if="conflictSection"
            class="mb-5 rounded-xl border border-warning/40 bg-warning/5 p-4"
            aria-labelledby="conflict-title"
          >
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2
                  id="conflict-title"
                  class="font-semibold text-highlighted"
                >
                  商品数据已变化，需要你决定如何处理
                </h2>
                <p class="mt-1 text-sm text-muted">
                  当前本地修改来自“{{ conflictSection }}”。不会自动覆盖服务器内容。
                </p>
                <p
                  v-if="conflictLatest"
                  class="mt-1 text-sm text-muted"
                >
                  服务器修订 {{ conflictLatest.revision }}；最新名称：{{ conflictLatest.name }}
                </p>
                <p
                  v-if="conflictError"
                  class="mt-1 text-sm text-error"
                >
                  {{ conflictError }}
                </p>
              </div>
              <UButton
                v-if="!conflictLatest"
                color="warning"
                variant="outline"
                :loading="conflictLoading"
                @click="refreshConflict(conflictSection)"
              >
                重新读取服务器
              </UButton>
            </div>
            <div
              v-if="conflictLatest"
              class="mt-3 flex flex-col gap-2 sm:flex-row"
            >
              <UButton
                color="neutral"
                variant="outline"
                @click="resolveConflict('discard')"
              >
                采用服务器版本并丢弃本地修改
              </UButton>
              <UButton
                color="warning"
                @click="resolveConflict('keep')"
              >
                保留本地输入，确认后再保存
              </UButton>
            </div>
          </section>

          <div class="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-10">
            <div class="min-w-0 divide-y divide-default">
              <section
                id="basic"
                aria-labelledby="basic-title"
                class="py-6 first:pt-0"
              >
                <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2
                      id="basic-title"
                      class="text-lg font-semibold text-highlighted"
                    >
                      基本信息
                    </h2>
                    <p class="mt-1 text-sm text-muted">
                      商品名称、说明和性质。
                    </p>
                  </div>
                  <UBadge
                    v-if="dirty.basic"
                    color="warning"
                    variant="subtle"
                  >
                    未保存
                  </UBadge>
                  <UBadge
                    v-else-if="sectionSuccess.basic"
                    color="success"
                    variant="subtle"
                  >
                    已保存
                  </UBadge>
                </header>
                <UAlert
                  v-if="sectionErrors.basic"
                  class="mb-3"
                  color="error"
                  variant="soft"
                  :title="sectionErrors.basic"
                  role="alert"
                />
                <UAlert
                  v-if="sectionSuccess.basic"
                  class="mb-3"
                  color="success"
                  variant="soft"
                  :title="sectionSuccess.basic"
                  role="status"
                />
                <div class="grid gap-4 sm:grid-cols-2">
                  <UFormField
                    label="商品名称"
                    required
                    hint="最多 200 个字符"
                  >
                    <UInput
                      v-model="name"
                      class="w-full"
                      size="lg"
                      maxlength="200"
                      :disabled="isArchived"
                      @update:model-value="dirty.basic = true; clearSectionStatus('basic')"
                    />
                  </UFormField>
                  <UFormField
                    label="商品性质"
                    required
                  >
                    <USelect
                      v-model="productType"
                      :items="productTypeItems"
                      class="w-full"
                      size="lg"
                      :disabled="isArchived"
                      @update:model-value="dirty.basic = true; clearSectionStatus('basic')"
                    />
                  </UFormField>
                  <UFormField
                    label="基础描述"
                    class="sm:col-span-2"
                    hint="用于管理识别和简要介绍，不等同于图文详情。"
                  >
                    <UTextarea
                      v-model="description"
                      class="w-full"
                      :rows="4"
                      :maxlength="20000"
                      :disabled="isArchived"
                      @update:model-value="dirty.basic = true; clearSectionStatus('basic')"
                    />
                  </UFormField>
                </div>
                <div class="mt-4 flex justify-end">
                  <UButton
                    :loading="saving === 'basic'"
                    :disabled="isArchived || saving !== '' || !dirty.basic"
                    @click="saveBasic"
                  >
                    保存基本信息
                  </UButton>
                </div>
              </section>

              <section
                id="purchase-limits"
                aria-labelledby="purchase-limits-title"
                class="py-6"
              >
                <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2
                      id="purchase-limits-title"
                      class="text-lg font-semibold text-highlighted"
                    >
                      购买限制
                    </h2>
                    <p class="mt-1 text-sm text-muted">
                      商品级规则汇总约束该商品下的所有 SKU。留空表示不限制；修改只影响新报价与新订单。
                    </p>
                  </div>
                  <UBadge
                    v-if="skuPurchaseLimitDraftDirty"
                    color="warning"
                    variant="subtle"
                  >
                    有未保存的购买限制
                  </UBadge>
                </header>
                <UAlert
                  v-if="sectionErrors.purchaseLimits"
                  class="mb-3"
                  color="error"
                  variant="soft"
                  :title="sectionErrors.purchaseLimits"
                  role="alert"
                />
                <UAlert
                  v-if="sectionSuccess.purchaseLimits"
                  class="mb-3"
                  color="success"
                  variant="soft"
                  :title="sectionSuccess.purchaseLimits"
                  role="status"
                />
                <div class="grid gap-4 sm:grid-cols-3">
                  <UFormField
                    label="每笔订单最多购买"
                    hint="1–4950 件；留空表示不限制"
                  >
                    <UInput
                      v-model="productPurchaseLimitDraft.perOrder"
                      type="number"
                      min="1"
                      max="4950"
                      step="1"
                      inputmode="numeric"
                      class="w-full"
                      :disabled="isArchived"
                      @update:model-value="clearSectionStatus('purchaseLimits')"
                    />
                  </UFormField>
                  <UFormField
                    label="每账号累计最多购买"
                    hint="1–2147483647 件；留空表示不限制"
                  >
                    <UInput
                      v-model="productPurchaseLimitDraft.lifetime"
                      type="number"
                      min="1"
                      max="2147483647"
                      step="1"
                      inputmode="numeric"
                      class="w-full"
                      :disabled="isArchived"
                      @update:model-value="clearSectionStatus('purchaseLimits')"
                    />
                  </UFormField>
                  <UFormField
                    label="每账号滚动 24 小时最多购买"
                    hint="1–2147483647 件；留空表示不限制"
                  >
                    <UInput
                      v-model="productPurchaseLimitDraft.rolling24Hours"
                      type="number"
                      min="1"
                      max="2147483647"
                      step="1"
                      inputmode="numeric"
                      class="w-full"
                      :disabled="isArchived"
                      @update:model-value="clearSectionStatus('purchaseLimits')"
                    />
                  </UFormField>
                </div>
                <div class="mt-4 flex justify-end">
                  <UButton
                    :loading="saving === 'purchase-limits'"
                    :disabled="isArchived || saving !== '' || !productPurchaseLimitDraftDirty"
                    @click="saveProductPurchaseLimits"
                  >
                    保存商品限制
                  </UButton>
                </div>
              </section>

              <section
                id="categories"
                aria-labelledby="categories-title"
                class="py-6"
              >
                <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2
                      id="categories-title"
                      class="text-lg font-semibold text-highlighted"
                    >
                      商品分类
                    </h2>
                    <p class="mt-1 text-sm text-muted">
                      主分类用于列表归类；可添加辅助分类，也可保持未分类。
                    </p>
                  </div>
                  <div class="flex gap-2">
                    <UButton
                      size="sm"
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-list-tree"
                      :disabled="isArchived"
                      @click="categoryManagerOpen = true"
                    >
                      管理分类
                    </UButton>
                    <UBadge
                      v-if="dirty.categories"
                      color="warning"
                      variant="subtle"
                    >
                      未保存
                    </UBadge>
                  </div>
                </header>
                <UAlert
                  v-if="sectionErrors.categories"
                  class="mb-3"
                  color="error"
                  variant="soft"
                  :title="sectionErrors.categories"
                  role="alert"
                />
                <UAlert
                  v-if="sectionSuccess.categories"
                  class="mb-3"
                  color="success"
                  variant="soft"
                  :title="sectionSuccess.categories"
                  role="status"
                />
                <div
                  v-if="categories.length === 0"
                  class="rounded-lg border border-dashed border-default px-4 py-5 text-sm text-muted"
                >
                  目前没有商品分类。可先创建分类，商品仍可保持未分类并正常保存。
                </div>
                <div
                  v-else
                  class="grid gap-4 sm:grid-cols-2"
                >
                  <UFormField label="主分类">
                    <USelect
                      :model-value="primaryCategoryId || noCategoryValue"
                      :items="categorySelectItems"
                      class="w-full"
                      size="lg"
                      :disabled="isArchived"
                      @update:model-value="value => setPrimaryCategory(String(value))"
                    />
                  </UFormField>
                  <div class="min-w-0">
                    <p class="mb-2 text-sm font-medium text-highlighted">
                      辅助分类
                    </p>
                    <div class="max-h-56 overflow-auto rounded-lg border border-default p-2">
                      <label
                        v-for="entry in visibleSubcategoryItems"
                        :key="entry.category.id"
                        class="flex min-h-11 items-center gap-3 rounded-md px-2 hover:bg-muted/50"
                        :style="{ paddingLeft: `${0.5 + entry.depth * 0.75}rem` }"
                      >
                        <UCheckbox
                          :model-value="categorySelection.includes(entry.category.id)"
                          :disabled="isArchived"
                          :aria-label="`辅助分类：${entry.path}`"
                          @update:model-value="toggleSecondaryCategory(entry.category.id)"
                        />
                        <span class="min-w-0 truncate text-sm text-highlighted">{{ entry.category.name }}</span>
                        <span
                          v-if="!entry.category.isVisible"
                          class="ml-auto text-xs text-dimmed"
                        >隐藏</span>
                      </label>
                      <p
                        v-if="visibleSubcategoryItems.length === 0"
                        class="px-2 py-3 text-sm text-muted"
                      >
                        选择主分类后可添加辅助分类。
                      </p>
                    </div>
                  </div>
                </div>
                <div class="mt-4 flex justify-end">
                  <UButton
                    :loading="saving === 'categories'"
                    :disabled="isArchived || saving !== '' || !dirty.categories"
                    @click="saveCategories"
                  >
                    保存分类
                  </UButton>
                </div>
              </section>

              <section
                id="gallery"
                aria-labelledby="gallery-title"
                class="py-6"
              >
                <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2
                      id="gallery-title"
                      class="text-lg font-semibold text-highlighted"
                    >
                      商品图片
                    </h2>
                    <p class="mt-1 text-sm text-muted">
                      最多 20 张。相册中的第一张图片作为封面；移除只解除相册引用。
                    </p>
                  </div>
                  <UBadge
                    v-if="dirty.gallery"
                    color="warning"
                    variant="subtle"
                  >
                    待保存关联
                  </UBadge>
                </header>
                <UAlert
                  v-if="sectionErrors.gallery"
                  class="mb-3"
                  color="error"
                  variant="soft"
                  :title="sectionErrors.gallery"
                  role="alert"
                />
                <UAlert
                  v-if="sectionSuccess.gallery"
                  class="mb-3"
                  color="success"
                  variant="soft"
                  :title="sectionSuccess.gallery"
                  role="status"
                />
                <UAlert
                  v-if="uploadMessage"
                  class="mb-3"
                  :color="uploadProgress === null ? 'info' : 'primary'"
                  variant="soft"
                  :title="uploadMessage"
                  role="status"
                />
                <progress
                  v-if="uploadProgress !== null"
                  class="mb-3 h-2 w-full accent-primary"
                  max="100"
                  :value="uploadProgress"
                  :aria-label="`图片上传进度 ${uploadProgress}%`"
                />
                <div class="mb-4 flex flex-wrap gap-2">
                  <label
                    v-if="!isArchived"
                    class="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary"
                  >
                    <UIcon
                      name="i-lucide-upload"
                      aria-hidden="true"
                    />
                    上传 JPEG / PNG / WebP
                    <input
                      class="sr-only"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      multiple
                      aria-label="上传商品图片"
                      :disabled="uploadProgress !== null"
                      @change="uploadImages"
                    >
                  </label>
                  <UButton
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-images"
                    :disabled="isArchived"
                    @click="openMediaLibrary"
                  >
                    从图片库复用
                  </UButton>
                  <span class="self-center text-xs text-muted">每张不超过 10 MB；上传成功后还需保存相册引用。</span>
                </div>
                <UEmpty
                  v-if="galleryDraft.length === 0"
                  icon="i-lucide-image"
                  title="尚未添加商品图片"
                  description="可上传新图片，也可从图片库中复用已有图片。"
                />
                <ol
                  v-else
                  class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
                >
                  <li
                    v-for="(image, index) in galleryDraft"
                    :key="image.id"
                    class="min-w-0 overflow-hidden rounded-lg border border-default bg-elevated"
                  >
                    <img
                      :src="image.cardUrl"
                      :alt="`商品图片 ${index + 1}`"
                      class="aspect-square w-full bg-muted object-cover"
                      loading="lazy"
                    >
                    <div class="flex min-h-11 items-center justify-between gap-2 px-2">
                      <span class="truncate text-xs font-medium text-highlighted">{{ index === 0 ? '封面' : `图片 ${index + 1}` }}</span>
                      <span class="shrink-0 font-mono text-[10px] text-dimmed">{{ image.id.slice(0, 8) }}</span>
                    </div>
                    <div class="flex flex-wrap gap-1 border-t border-default p-2">
                      <UButton
                        size="xs"
                        color="neutral"
                        variant="outline"
                        icon="i-lucide-arrow-left"
                        :aria-label="`将图片 ${index + 1} 左移`"
                        :disabled="isArchived || index === 0"
                        @click="moveGalleryImage(index, -1)"
                      />
                      <UButton
                        size="xs"
                        color="neutral"
                        variant="outline"
                        icon="i-lucide-arrow-right"
                        :aria-label="`将图片 ${index + 1} 右移`"
                        :disabled="isArchived || index === galleryDraft.length - 1"
                        @click="moveGalleryImage(index, 1)"
                      />
                      <UButton
                        size="xs"
                        color="error"
                        variant="ghost"
                        icon="i-lucide-x"
                        :aria-label="`从商品相册移除图片 ${index + 1}`"
                        :disabled="isArchived"
                        @click="removeGalleryReference(image.id)"
                      >
                        移除引用
                      </UButton>
                    </div>
                  </li>
                </ol>
                <div class="mt-4 flex justify-end">
                  <UButton
                    :loading="saving === 'gallery'"
                    :disabled="isArchived || saving !== '' || !dirty.gallery"
                    @click="saveGallery"
                  >
                    保存相册
                  </UButton>
                </div>
              </section>

              <section
                id="rich-content"
                aria-labelledby="rich-title"
                class="py-6"
              >
                <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2
                      id="rich-title"
                      class="text-lg font-semibold text-highlighted"
                    >
                      图文详情
                    </h2>
                    <p class="mt-1 text-sm text-muted">
                      使用 D5 的结构化 JSON；正文图片按 mediaId 关联，不保存 URL 作为图片身份。
                    </p>
                  </div>
                  <UBadge
                    v-if="dirty.rich"
                    color="warning"
                    variant="subtle"
                  >
                    未保存
                  </UBadge>
                </header>
                <UAlert
                  v-if="sectionErrors.rich"
                  class="mb-3"
                  color="error"
                  variant="soft"
                  :title="sectionErrors.rich"
                  role="alert"
                />
                <UAlert
                  v-if="sectionSuccess.rich"
                  class="mb-3"
                  color="success"
                  variant="soft"
                  :title="sectionSuccess.rich"
                  role="status"
                />
                <LazyAdminProductRichContentEditor
                  v-model="richDraft"
                  :gallery="galleryDraft"
                  :disabled="isArchived"
                  @update:model-value="dirty.rich = true; clearSectionStatus('rich')"
                />
                <p class="mt-2 text-xs leading-5 text-muted">
                  链接仅允许 HTTP、HTTPS、mailto、tel 或站内路径；保存时由共享契约与服务端再次校验。脚本、HTML 和未支持节点不会写入正文。
                </p>
                <div class="mt-4 flex justify-end">
                  <UButton
                    :loading="saving === 'rich'"
                    :disabled="isArchived || saving !== '' || !dirty.rich"
                    @click="saveRichContent"
                  >
                    保存图文详情
                  </UButton>
                </div>
              </section>

              <section
                id="variants"
                aria-labelledby="variants-title"
                class="py-6"
              >
                <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2
                      id="variants-title"
                      class="text-lg font-semibold text-highlighted"
                    >
                      规格与 SKU
                    </h2>
                    <p class="mt-1 text-sm text-muted">
                      最多 5 组规格、每组 50 个值、每件商品最多 1000 个 SKU。SKU 身份由组合键保持稳定。
                    </p>
                  </div>
                  <UBadge
                    v-if="dirty.matrix"
                    color="warning"
                    variant="subtle"
                  >
                    未保存
                  </UBadge>
                </header>
                <UAlert
                  v-if="sectionErrors.matrix"
                  class="mb-3"
                  color="error"
                  variant="soft"
                  :title="sectionErrors.matrix"
                  role="alert"
                />
                <UAlert
                  v-if="sectionSuccess.matrix"
                  class="mb-3"
                  color="success"
                  variant="soft"
                  :title="sectionSuccess.matrix"
                  role="status"
                />
                <div class="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 p-3">
                  <span class="mr-2 text-sm text-muted">保存方式</span>
                  <UButton
                    size="sm"
                    :color="matrixMode === 'selected' ? 'primary' : 'neutral'"
                    :variant="matrixMode === 'selected' ? 'soft' : 'outline'"
                    :disabled="isArchived"
                    @click="matrixMode = 'selected'; markMatrixDirty()"
                  >
                    保留所选组合
                  </UButton>
                  <UButton
                    size="sm"
                    :color="matrixMode === 'all' ? 'primary' : 'neutral'"
                    :variant="matrixMode === 'all' ? 'soft' : 'outline'"
                    :disabled="isArchived"
                    @click="matrixMode = 'all'; markMatrixDirty()"
                  >
                    自动生成全部组合
                  </UButton>
                  <span class="ml-auto text-xs text-muted">{{ selectedCombinationCount }} 个组合已选 · 当前 {{ allCombinations.length }} 个可能组合</span>
                </div>
                <UAlert
                  v-if="legacyDefaultSkuNeedsRetirement"
                  class="mb-4"
                  color="warning"
                  variant="subtle"
                  title="默认 SKU 不能改配到新规格"
                  description="D1 默认 SKU 没有关联规格组合。请在 SKU 清单中显式永久退役以保留原身份，再预览并生成新组合；有库存时后端会阻止退役。"
                />

                <div class="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <UFormField
                    label="新增 SKU 默认售价（人民币）"
                    hint="只应用于新建组合，不会覆盖已有 SKU 价格。"
                  >
                    <UInput
                      v-model="newSkuPrice"
                      class="w-full sm:max-w-xs"
                      inputmode="decimal"
                      :disabled="isArchived"
                      @update:model-value="markMatrixDirty"
                    />
                  </UFormField>
                  <UCheckbox
                    v-model="newSkuEnabled"
                    label="新 SKU 默认启用销售"
                    :disabled="isArchived"
                    @update:model-value="markMatrixDirty"
                  />
                </div>

                <div class="grid gap-3">
                  <article
                    v-for="(group, groupIndex) in groupsDraft"
                    :key="group.id"
                    class="min-w-0 rounded-lg border border-default p-3"
                  >
                    <div class="flex flex-wrap items-center gap-2">
                      <UFormField
                        :label="`规格组 ${groupIndex + 1}`"
                        class="min-w-40 flex-1"
                      >
                        <UInput
                          v-model="group.name"
                          :disabled="isArchived"
                          maxlength="80"
                          :aria-label="`规格组 ${groupIndex + 1} 名称`"
                          @update:model-value="markMatrixDirty"
                        />
                      </UFormField>
                      <UCheckbox
                        v-model="group.enabled"
                        label="参与组合"
                        :disabled="isArchived"
                        class="mt-5"
                        @update:model-value="markMatrixDirty"
                      />
                      <UButton
                        size="sm"
                        color="neutral"
                        variant="outline"
                        icon="i-lucide-arrow-up"
                        :aria-label="`规格组 ${groupIndex + 1} 上移`"
                        :disabled="isArchived || groupIndex === 0"
                        @click="moveOptionGroup(groupIndex, -1)"
                      />
                      <UButton
                        size="sm"
                        color="neutral"
                        variant="outline"
                        icon="i-lucide-arrow-down"
                        :aria-label="`规格组 ${groupIndex + 1} 下移`"
                        :disabled="isArchived || groupIndex === groupsDraft.length - 1"
                        @click="moveOptionGroup(groupIndex, 1)"
                      />
                      <UButton
                        size="sm"
                        color="error"
                        variant="ghost"
                        icon="i-lucide-trash-2"
                        :aria-label="`删除规格组 ${groupIndex + 1}`"
                        :disabled="isArchived"
                        @click="removeOptionGroup(group.id)"
                      >
                        删除组
                      </UButton>
                    </div>
                    <ul class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      <li
                        v-for="(value, valueIndex) in group.values"
                        :key="value.id"
                        class="flex min-w-0 items-center gap-2"
                      >
                        <UInput
                          v-model="value.name"
                          class="min-w-0 flex-1"
                          maxlength="80"
                          :aria-label="`${group.name || `规格组 ${groupIndex + 1}`} 的选项 ${valueIndex + 1}`"
                          :disabled="isArchived"
                          @update:model-value="markMatrixDirty"
                        />
                        <UCheckbox
                          v-model="value.enabled"
                          :aria-label="`启用选项 ${value.name}`"
                          :disabled="isArchived"
                          @update:model-value="markMatrixDirty"
                        />
                        <UButton
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          icon="i-lucide-arrow-up"
                          :aria-label="`选项 ${valueIndex + 1} 上移`"
                          :disabled="isArchived || valueIndex === 0"
                          @click="moveOptionValue(group, valueIndex, -1)"
                        />
                        <UButton
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          icon="i-lucide-arrow-down"
                          :aria-label="`选项 ${valueIndex + 1} 下移`"
                          :disabled="isArchived || valueIndex === group.values.length - 1"
                          @click="moveOptionValue(group, valueIndex, 1)"
                        />
                        <UButton
                          size="xs"
                          color="error"
                          variant="ghost"
                          icon="i-lucide-x"
                          :aria-label="`移除选项 ${value.name}`"
                          :disabled="isArchived"
                          @click="removeOptionValue(group, value.id)"
                        />
                      </li>
                    </ul>
                    <UButton
                      class="mt-3"
                      size="sm"
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-plus"
                      :disabled="isArchived || group.values.length >= 50"
                      @click="addOptionValue(group)"
                    >
                      添加规格值
                    </UButton>
                  </article>
                </div>
                <UButton
                  v-if="groupsDraft.length < 5"
                  class="mt-3"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-plus"
                  :disabled="isArchived"
                  @click="addOptionGroup"
                >
                  添加规格组
                </UButton>

                <div
                  v-if="matrixMode === 'selected'"
                  class="mt-5 border-t border-default pt-4"
                >
                  <h3 class="font-medium text-highlighted">
                    组合选择
                  </h3>
                  <p class="mt-1 text-sm text-muted">
                    取消勾选意味着请求移除该 SKU；有库存或历史引用的 SKU 会由预览明确标出并被后端阻止。
                  </p>
                  <UAlert
                    v-if="matrixCombinationLimitExceeded"
                    class="mt-3"
                    color="error"
                    variant="soft"
                    title="当前组合超过 1000 个，请减少规格值或使用更小的所选组合。"
                  />
                  <ul
                    v-else
                    class="mt-3 divide-y divide-default rounded-lg border border-default"
                  >
                    <li
                      v-for="combination in visibleMatrixCombinations"
                      :key="combination.key"
                      class="flex min-h-12 items-center gap-3 px-3 py-2"
                    >
                      <UCheckbox
                        :model-value="selectedMatrixKeySet.has(combination.key)"
                        :disabled="isArchived || Boolean(combination.retired)"
                        :aria-label="`保留组合 ${combination.optionNames.join(' / ') || '默认 SKU'}`"
                        @update:model-value="value => toggleMatrixCombination(combination, Boolean(value))"
                      />
                      <span class="min-w-0 flex-1 truncate text-sm text-highlighted">{{ combination.optionNames.join(' / ') || '默认 SKU' }}</span>
                      <span
                        v-if="combination.sku"
                        class="shrink-0 font-mono text-xs text-muted"
                      >{{ combination.sku.skuCode }}</span>
                      <UBadge
                        v-if="combination.retired"
                        color="neutral"
                        variant="subtle"
                      >
                        永久退役，组合保留
                      </UBadge>
                      <UBadge
                        v-else-if="combination.sku && !combination.sku.enabled"
                        color="warning"
                        variant="subtle"
                      >
                        暂时停用
                      </UBadge>
                    </li>
                  </ul>
                  <div
                    v-if="matrixTotalPages > 1"
                    class="mt-3 flex items-center justify-between gap-3"
                  >
                    <UButton
                      color="neutral"
                      variant="outline"
                      size="sm"
                      :disabled="matrixPageNumber <= 1"
                      @click="matrixPageNumber--"
                    >
                      上一页
                    </UButton>
                    <span class="text-sm text-muted">第 {{ matrixPageNumber }} / {{ matrixTotalPages }} 页，每页 50 个组合</span>
                    <UButton
                      color="neutral"
                      variant="outline"
                      size="sm"
                      :disabled="matrixPageNumber >= matrixTotalPages"
                      @click="matrixPageNumber++"
                    >
                      下一页
                    </UButton>
                  </div>
                </div>

                <div class="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-default pt-4">
                  <p class="max-w-xl text-xs leading-5 text-muted">
                    永久退役 SKU 无法恢复销售；临时停用只需重新启用。库存未清零或存在历史引用时，后端将阻止移除和退役。
                  </p>
                  <UButton
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-scan-search"
                    :loading="saving === 'matrix-preview'"
                    :disabled="isArchived || saving !== '' || !dirty.matrix || matrixCombinationLimitExceeded"
                    @click="previewMatrix"
                  >
                    预览 SKU 差异
                  </UButton>
                </div>
                <section
                  v-if="matrixPreview"
                  class="mt-4 rounded-lg border border-default bg-muted/20 p-3"
                  aria-labelledby="matrix-preview-title"
                >
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <h3
                      id="matrix-preview-title"
                      class="font-medium text-highlighted"
                    >
                      保存预览
                    </h3>
                    <span class="text-xs text-muted">{{ matrixPreview.changes.length }} 项 SKU 变更 · 最多 1000 个 SKU</span>
                  </div>
                  <ul class="mt-3 grid gap-2 text-sm">
                    <li
                      v-for="(change, index) in matrixPreview.changes.slice(0, 20)"
                      :key="`${change.skuId ?? 'new'}-${index}`"
                      class="rounded-md border border-default bg-elevated p-2"
                    >
                      <div class="flex flex-wrap items-center gap-2">
                        <UBadge
                          :color="change.change === 'added' ? 'success' : change.change === 'removed' || change.change === 'retired' ? 'warning' : 'neutral'"
                          variant="subtle"
                        >
                          {{ change.change === 'added' ? '新增' : change.change === 'retained' ? '保留' : change.change === 'modified' ? '修改' : change.change === 'retired' ? '永久退役' : '移除' }}
                        </UBadge>
                        <span class="font-mono text-xs text-muted">{{ change.skuCode ?? '新 SKU' }}</span>
                        <span class="text-highlighted">{{ change.options.map(option => `${option.groupName} ${option.valueName}`).join(' / ') || '默认 SKU' }}</span>
                      </div>
                      <p class="mt-1 text-xs text-muted">
                        售价 {{ change.salePrice === null ? '未设置' : `¥${change.salePrice}` }} · {{ change.enabled === null ? '该 SKU 将移除' : change.change === 'retired' ? '永久退役' : change.enabled ? '保存后启用销售' : '保存后暂时停用' }}
                      </p>
                      <p
                        v-if="change.inventoryMutationBlocked"
                        class="mt-1 text-xs text-error"
                      >
                        不能移除或改配：{{ change.inventoryMutationBlockReason === 'adjustment_history' ? '存在库存调整历史' : change.inventoryMutationBlockReason === 'reserved_quantity' ? '存在预留库存' : '实际库存未清零' }}。
                      </p>
                      <p
                        v-if="change.retirementBlocked"
                        class="mt-1 text-xs text-error"
                      >
                        不能退役：{{ change.retirementBlockReason === 'reserved_quantity' ? '存在预留库存' : '实际库存未清零' }}。
                      </p>
                    </li>
                  </ul>
                  <p
                    v-if="matrixPreview.changes.length > 20"
                    class="mt-2 text-xs text-muted"
                  >
                    另有 {{ matrixPreview.changes.length - 20 }} 项，完整差异已由服务端预览计数。
                  </p>
                  <UCheckbox
                    v-if="matrixNeedsConfirmation"
                    v-model="confirmMatrixChanges"
                    class="mt-3"
                    label="我已查看移除、改配和退役影响，确认提交此差异"
                    :disabled="isArchived"
                  />
                  <div class="mt-3 flex justify-end">
                    <UButton
                      :loading="saving === 'matrix'"
                      :disabled="isArchived || saving !== '' || (matrixNeedsConfirmation && !confirmMatrixChanges) || matrixBlockedChanges.length > 0"
                      @click="saveMatrix"
                    >
                      保存规格与 SKU
                    </UButton>
                  </div>
                </section>

                <div class="mt-6 border-t border-default pt-5">
                  <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h3 class="font-medium text-highlighted">
                        SKU 清单
                      </h3>
                      <p class="mt-1 text-sm text-muted">
                        已有 SKU 的编码、身份和库存归属保持稳定。永久退役记录只读保留。
                      </p>
                    </div>
                    <span class="text-xs text-muted">共 {{ product.variants.length }} 个</span>
                  </div>
                  <ul class="divide-y divide-default rounded-lg border border-default">
                    <li
                      v-for="variant in visibleSkuRows"
                      :key="variant.id"
                      class="flex min-w-0 flex-col gap-3 p-3"
                    >
                      <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div class="min-w-0 flex-1">
                          <p class="truncate font-mono text-sm font-medium text-highlighted">
                            {{ variant.skuCode }}
                          </p>
                          <p class="mt-0.5 truncate text-xs text-muted">
                            {{ variantOptionsText(variant) }}
                          </p>
                          <p class="mt-1 text-xs text-dimmed">
                            {{ priceForSku(variant.id)?.salePrice ? `售价 ¥${priceForSku(variant.id)?.salePrice}` : `售价 ¥${variant.salePrice}` }} · {{ inventoryForSku(variant.id) ? inventoryModeLabel(inventoryForSku(variant.id)!.inventory.mode) : '库存读取中' }}
                          </p>
                        </div>
                        <div class="flex flex-wrap items-center gap-2">
                          <UBadge
                            v-if="variant.retiredAt"
                            color="neutral"
                            variant="subtle"
                          >
                            永久退役
                          </UBadge>
                          <UBadge
                            v-else-if="retireSkuIds.includes(variant.id)"
                            color="warning"
                            variant="subtle"
                          >
                            待保存永久退役
                          </UBadge>
                          <UCheckbox
                            v-else
                            :model-value="skuEnabledDraft[variant.id] ?? variant.enabled"
                            label="启用销售"
                            :disabled="isArchived"
                            @update:model-value="value => setSkuEnabled(variant.id, Boolean(value))"
                          />
                          <UButton
                            v-if="!variant.retiredAt"
                            size="sm"
                            :color="retireSkuIds.includes(variant.id) ? 'neutral' : 'error'"
                            variant="ghost"
                            :disabled="isArchived"
                            @click="retireSkuIds.includes(variant.id) ? cancelRetirement(variant) : requestRetirement(variant)"
                          >
                            {{ retireSkuIds.includes(variant.id) ? '取消计划退役' : '永久退役' }}
                          </UButton>
                        </div>
                      </div>
                      <details class="min-w-0 rounded-lg border border-default p-3">
                        <summary class="cursor-pointer text-sm font-medium text-highlighted">
                          SKU 购买限制
                          <span class="ml-2 font-normal text-muted">留空表示不限制；与商品级限制同时生效</span>
                        </summary>
                        <UAlert
                          v-if="sectionErrors[`skuPurchaseLimits:${variant.id}`]"
                          class="mt-3"
                          color="error"
                          variant="soft"
                          :title="sectionErrors[`skuPurchaseLimits:${variant.id}`]"
                          role="alert"
                        />
                        <UAlert
                          v-if="sectionSuccess[`skuPurchaseLimits:${variant.id}`]"
                          class="mt-3"
                          color="success"
                          variant="soft"
                          :title="sectionSuccess[`skuPurchaseLimits:${variant.id}`]"
                          role="status"
                        />
                        <div class="mt-3 grid gap-3 sm:grid-cols-3">
                          <UFormField
                            label="每笔订单最多购买"
                            hint="1–99 件；留空表示不限制"
                          >
                            <UInput
                              v-model="skuLimitDraft(variant).perOrder"
                              type="number"
                              min="1"
                              max="99"
                              step="1"
                              inputmode="numeric"
                              class="w-full"
                              :disabled="isArchived || Boolean(variant.retiredAt)"
                              @update:model-value="clearSectionStatus(`skuPurchaseLimits:${variant.id}`)"
                            />
                          </UFormField>
                          <UFormField
                            label="每账号累计最多购买"
                            hint="1–2147483647 件；留空表示不限制"
                          >
                            <UInput
                              v-model="skuLimitDraft(variant).lifetime"
                              type="number"
                              min="1"
                              max="2147483647"
                              step="1"
                              inputmode="numeric"
                              class="w-full"
                              :disabled="isArchived || Boolean(variant.retiredAt)"
                              @update:model-value="clearSectionStatus(`skuPurchaseLimits:${variant.id}`)"
                            />
                          </UFormField>
                          <UFormField
                            label="每账号滚动 24 小时最多购买"
                            hint="1–2147483647 件；留空表示不限制"
                          >
                            <UInput
                              v-model="skuLimitDraft(variant).rolling24Hours"
                              type="number"
                              min="1"
                              max="2147483647"
                              step="1"
                              inputmode="numeric"
                              class="w-full"
                              :disabled="isArchived || Boolean(variant.retiredAt)"
                              @update:model-value="clearSectionStatus(`skuPurchaseLimits:${variant.id}`)"
                            />
                          </UFormField>
                        </div>
                        <div class="mt-3 flex justify-end">
                          <UButton
                            size="sm"
                            :loading="saving === `skuPurchaseLimits:${variant.id}`"
                            :disabled="isArchived || Boolean(variant.retiredAt) || saving !== '' || !hasSkuPurchaseLimitDraftChanges(variant)"
                            @click="saveSkuPurchaseLimits(variant)"
                          >
                            保存此 SKU 限制
                          </UButton>
                        </div>
                      </details>
                    </li>
                  </ul>
                  <div
                    v-if="skuTotalPages > 1"
                    class="mt-3 flex items-center justify-between gap-3"
                  >
                    <UButton
                      color="neutral"
                      variant="outline"
                      size="sm"
                      :disabled="skuPageNumber <= 1"
                      @click="skuPageNumber--"
                    >
                      上一页
                    </UButton>
                    <span class="text-sm text-muted">第 {{ skuPageNumber }} / {{ skuTotalPages }} 页，每页 {{ skuPageSize }} 个</span>
                    <UButton
                      color="neutral"
                      variant="outline"
                      size="sm"
                      :disabled="skuPageNumber >= skuTotalPages"
                      @click="skuPageNumber++"
                    >
                      下一页
                    </UButton>
                  </div>
                </div>
              </section>

              <section
                id="prices"
                aria-labelledby="prices-title"
                class="py-6"
              >
                <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2
                      id="prices-title"
                      class="text-lg font-semibold text-highlighted"
                    >
                      价格
                    </h2>
                    <p class="mt-1 text-sm text-muted">
                      销售价最多两位小数，划线价须高于销售价；成本价仅后台可见，最多五位小数。
                    </p>
                  </div>
                  <UBadge
                    v-if="dirty.prices"
                    color="warning"
                    variant="subtle"
                  >
                    未保存
                  </UBadge>
                </header>
                <UAlert
                  v-if="sectionErrors.prices"
                  class="mb-3"
                  color="error"
                  variant="soft"
                  :title="sectionErrors.prices"
                  role="alert"
                />
                <UAlert
                  v-if="sectionSuccess.prices"
                  class="mb-3"
                  color="success"
                  variant="soft"
                  :title="sectionSuccess.prices"
                  role="status"
                />
                <div class="mb-3 flex flex-col gap-2 rounded-lg bg-muted/40 p-3 sm:flex-row sm:items-end">
                  <UFormField
                    label="批量设置本页售价"
                    hint="只作用于本页最多 50 个未退役 SKU。"
                  >
                    <UInput
                      v-model="bulkSalePrice"
                      inputmode="decimal"
                      class="w-full sm:w-64"
                      :disabled="isArchived"
                    />
                  </UFormField>
                  <UButton
                    color="neutral"
                    variant="outline"
                    :disabled="isArchived || !bulkSalePrice.trim()"
                    @click="applyBulkSalePrice"
                  >
                    应用到本页
                  </UButton>
                </div>
                <div
                  v-if="!pricePage"
                  class="py-6 text-sm text-muted"
                >
                  正在读取 SKU 价格…
                </div>
                <div
                  v-else
                  class="grid gap-3"
                >
                  <article
                    v-for="row in currentPriceItems"
                    :key="row.skuId"
                    class="min-w-0 rounded-lg border border-default p-3"
                  >
                    <div class="mb-3 flex flex-wrap items-center gap-2">
                      <span class="font-mono text-sm font-medium text-highlighted">{{ row.skuCode }}</span>
                      <UBadge
                        v-if="row.retiredAt"
                        color="neutral"
                        variant="subtle"
                      >
                        永久退役，只读
                      </UBadge>
                      <UBadge
                        v-else-if="product.variants.find(variant => variant.id === row.skuId)?.enabled"
                        color="success"
                        variant="subtle"
                      >
                        启用销售
                      </UBadge>
                      <UBadge
                        v-else
                        color="warning"
                        variant="subtle"
                      >
                        暂时停用
                      </UBadge>
                      <span class="ml-auto text-xs text-dimmed">SKU 修订 {{ row.skuRevision }}</span>
                    </div>
                    <div class="grid gap-3 sm:grid-cols-3">
                      <UFormField
                        label="销售价（¥）"
                        required
                      >
                        <UInput
                          v-model="priceDraft[row.skuId]!.salePrice"
                          inputmode="decimal"
                          class="w-full"
                          :disabled="isArchived || Boolean(row.retiredAt)"
                          @update:model-value="markPriceDirty"
                        />
                      </UFormField>
                      <UFormField
                        label="划线价（¥）"
                        hint="可留空"
                      >
                        <UInput
                          v-model="priceDraft[row.skuId]!.compareAtPrice"
                          inputmode="decimal"
                          class="w-full"
                          :disabled="isArchived || Boolean(row.retiredAt)"
                          @update:model-value="markPriceDirty"
                        />
                      </UFormField>
                      <UFormField
                        label="成本价（¥）"
                        hint="仅后台展示，可留空"
                      >
                        <UInput
                          v-model="priceDraft[row.skuId]!.costPrice"
                          inputmode="decimal"
                          class="w-full"
                          :disabled="isArchived || Boolean(row.retiredAt)"
                          @update:model-value="markPriceDirty"
                        />
                      </UFormField>
                    </div>
                  </article>
                </div>
                <div
                  v-if="pricePage && pricePage.totalPages > 1"
                  class="mt-3 flex items-center justify-between gap-3"
                >
                  <UButton
                    color="neutral"
                    variant="outline"
                    size="sm"
                    :disabled="pricePageNumber <= 1"
                    @click="changePricePage(pricePageNumber - 1)"
                  >
                    上一页
                  </UButton>
                  <span class="text-sm text-muted">第 {{ pricePageNumber }} / {{ pricePage.totalPages }} 页 · {{ pricePage.total }} 个 SKU</span>
                  <UButton
                    color="neutral"
                    variant="outline"
                    size="sm"
                    :disabled="pricePageNumber >= pricePage.totalPages"
                    @click="changePricePage(pricePageNumber + 1)"
                  >
                    下一页
                  </UButton>
                </div>
                <div class="mt-4 flex justify-end">
                  <UButton
                    :loading="saving === 'prices'"
                    :disabled="isArchived || saving !== '' || !dirty.prices"
                    @click="savePrices"
                  >
                    原子保存本页价格
                  </UButton>
                </div>
              </section>

              <section
                id="inventory"
                aria-labelledby="inventory-title"
                class="py-6"
              >
                <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2
                      id="inventory-title"
                      class="text-lg font-semibold text-highlighted"
                    >
                      库存
                    </h2>
                    <p class="mt-1 text-sm text-muted">
                      商品模式使用 SKU 独立修订；库存数量调整使用 inventory_revision 与唯一 operationId。
                    </p>
                  </div>
                </header>
                <UAlert
                  v-if="sectionErrors.inventory"
                  class="mb-3"
                  color="error"
                  variant="soft"
                  :title="sectionErrors.inventory"
                  role="alert"
                />
                <UAlert
                  v-if="sectionSuccess.inventory"
                  class="mb-3"
                  color="success"
                  variant="soft"
                  :title="sectionSuccess.inventory"
                  role="status"
                />
                <UAlert
                  v-if="isArchived"
                  class="mb-3"
                  color="neutral"
                  variant="soft"
                  title="归档商品的经营配置为只读；后端允许的历史库存维护仍可继续。"
                />
                <div
                  v-if="!inventorySummary"
                  class="py-5 text-sm text-muted"
                >
                  正在读取服务端库存…
                </div>
                <template v-else>
                  <ul class="divide-y divide-default rounded-lg border border-default">
                    <li
                      v-for="row in visibleInventoryRows"
                      :key="row.skuId"
                      class="min-w-0 p-3"
                    >
                      <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div class="min-w-0">
                          <p class="truncate font-mono text-sm font-medium text-highlighted">
                            {{ row.skuCode }}
                          </p>
                          <p class="mt-1 text-sm text-muted">
                            {{ inventorySummaryText(row) }}
                          </p>
                          <div class="mt-2 flex flex-wrap gap-2 text-xs text-dimmed">
                            <span>SKU 修订 {{ row.skuRevision }}</span>
                            <span>库存修订 {{ row.inventoryRevision }}</span>
                            <span v-if="row.retiredAt">永久退役</span>
                          </div>
                        </div>
                        <UFormField
                          label="库存模式"
                          class="w-full sm:max-w-64"
                        >
                          <USelect
                            :model-value="row.inventory.mode ?? 'null'"
                            :items="inventoryModeItems"
                            class="w-full"
                            :disabled="isArchived || Boolean(row.retiredAt) || saving !== ''"
                            :aria-label="`${row.skuCode} 库存模式`"
                            @update:model-value="value => changeInventoryMode(row, String(value))"
                          />
                        </UFormField>
                      </div>
                      <div
                        v-if="row.inventory.mode === 'quantity'"
                        class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-default pt-3"
                      >
                        <p class="text-xs text-muted">
                          可以增加、减少或设置目标数量；库存历史会记录原因和前后数量。
                        </p>
                        <UButton
                          size="sm"
                          color="neutral"
                          variant="outline"
                          icon="i-lucide-history"
                          @click="viewInventoryHistory(row.skuId)"
                        >
                          查看调整历史
                        </UButton>
                      </div>
                    </li>
                  </ul>
                  <div
                    v-if="inventoryTotalPages > 1"
                    class="mt-3 flex items-center justify-between gap-3"
                  >
                    <UButton
                      color="neutral"
                      variant="outline"
                      size="sm"
                      :disabled="inventoryPageNumber <= 1"
                      @click="inventoryPageNumber--"
                    >
                      上一页
                    </UButton>
                    <span class="text-sm text-muted">第 {{ inventoryPageNumber }} / {{ inventoryTotalPages }} 页，每页 {{ inventoryPageSize }} 个</span>
                    <UButton
                      color="neutral"
                      variant="outline"
                      size="sm"
                      :disabled="inventoryPageNumber >= inventoryTotalPages"
                      @click="inventoryPageNumber++"
                    >
                      下一页
                    </UButton>
                  </div>
                </template>

                <section
                  class="mt-6 rounded-xl border border-primary/25 bg-primary/5 p-4 sm:p-5"
                  aria-labelledby="manual-delivery-title"
                >
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0">
                      <h3
                        id="manual-delivery-title"
                        class="font-semibold text-highlighted"
                      >
                        人工数字交付资格
                      </h3>
                      <p class="mt-1 max-w-3xl text-sm leading-6 text-muted">
                        默认关闭。只有商家确认此数字商品有可实际提供的内容，并且后台人员能在订单详情页录入交付内容后，才为对应 SKU 开启。开启后顾客即可下单；未配置的 SKU 仍不可购买。
                      </p>
                    </div>
                    <UBadge
                      v-if="product?.productType === 'digital'"
                      color="primary"
                      variant="soft"
                    >
                      数字商品
                    </UBadge>
                    <UBadge
                      v-else
                      color="warning"
                      variant="soft"
                    >
                      仅限数字商品
                    </UBadge>
                  </div>
                  <div
                    v-if="manualFulfillmentLoading"
                    class="mt-4 text-sm text-muted"
                    aria-busy="true"
                  >
                    正在读取交付资格…
                  </div>
                  <ul
                    v-else-if="inventorySummary"
                    class="mt-4 divide-y divide-default rounded-lg border border-default bg-elevated"
                  >
                    <li
                      v-for="row in visibleInventoryRows"
                      :key="`fulfillment-${row.skuId}`"
                      class="flex min-w-0 flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div class="min-w-0">
                        <p class="truncate font-mono text-sm font-medium text-highlighted">
                          {{ row.skuCode }}
                        </p>
                        <p class="mt-1 text-xs text-muted">
                          {{ manualFulfillmentReadinessText(row) }}
                        </p>
                      </div>
                      <div class="flex flex-wrap items-center gap-2 sm:justify-end">
                        <UBadge
                          :color="manualFulfillmentForSku(row.skuId)?.enabled ? 'success' : 'neutral'"
                          variant="soft"
                        >
                          {{ manualFulfillmentForSku(row.skuId)?.enabled ? '人工交付已就绪' : '未开启' }}
                        </UBadge>
                        <UButton
                          size="sm"
                          :color="manualFulfillmentForSku(row.skuId)?.enabled ? 'neutral' : 'primary'"
                          :variant="manualFulfillmentForSku(row.skuId)?.enabled ? 'outline' : 'solid'"
                          :disabled="Boolean(saving) || manualFulfillmentLoading || (product?.productType !== 'digital') || (!manualFulfillmentForSku(row.skuId)?.enabled && !canEnableManualFulfillment(row.skuId))"
                          :loading="saving === `manual-fulfillment-${row.skuId}`"
                          :aria-pressed="manualFulfillmentForSku(row.skuId)?.enabled ?? false"
                          @click="setManualFulfillment(row.skuId, !manualFulfillmentForSku(row.skuId)?.enabled)"
                        >
                          {{ manualFulfillmentForSku(row.skuId)?.enabled ? '关闭资格' : '明确开启' }}
                        </UButton>
                      </div>
                    </li>
                  </ul>
                  <p
                    v-if="inventorySummary && inventorySummary.variants.length > inventoryPageSize"
                    class="mt-2 text-xs text-muted"
                  >
                    请使用上方库存分页逐页配置 SKU。资格切换会立即保存。
                  </p>
                </section>

                <section
                  v-if="product?.productType === 'digital' && inventorySummary"
                  class="mt-6 rounded-xl border border-success/25 bg-success/5 p-4 sm:p-5"
                  aria-labelledby="code-pool-title"
                >
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0">
                      <h3
                        id="code-pool-title"
                        class="font-semibold text-highlighted"
                      >
                        SKU 卡密池与自动发货
                      </h3>
                      <p class="mt-1 max-w-3xl text-sm leading-6 text-muted">
                        每个 SKU 独立管理。卡密按原文加密保存；此列表和批次记录不会显示完整卡密。库存、预留、撤回与交付由订单库存事件同步。
                      </p>
                    </div>
                    <UBadge
                      :color="codePoolStatus?.enabled && codePoolStatus.inventoryConsistent ? 'success' : codePoolStatus?.configured ? 'warning' : 'neutral'"
                      variant="soft"
                    >
                      {{ codePoolStatus?.enabled ? '新订单自动发货已启用' : codePoolStatus?.configured ? '已配置并暂停新销售' : '尚未配置' }}
                    </UBadge>
                  </div>

                  <div class="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
                    <UFormField label="管理 SKU">
                      <USelect
                        v-model="codePoolSkuId"
                        :items="codePoolSkuOptions"
                        class="w-full"
                        :disabled="codePoolLoading"
                        aria-label="选择要管理的卡密池 SKU"
                      />
                    </UFormField>
                    <UButton
                      v-if="codePoolStatus?.configured"
                      :color="codePoolStatus.enabled ? 'warning' : 'success'"
                      :variant="codePoolStatus.enabled ? 'outline' : 'solid'"
                      :disabled="codePoolLoading || (!codePoolStatus.enabled && !canConfigureCodePool)"
                      :loading="codePoolLoading"
                      :aria-pressed="codePoolStatus.enabled"
                      @click="setCodePoolReadiness(!codePoolStatus.enabled)"
                    >
                      {{ codePoolStatus.enabled ? '暂停新销售' : '开启自动发货销售' }}
                    </UButton>
                    <UButton
                      v-else
                      color="neutral"
                      variant="outline"
                      :disabled="codePoolLoading || !canConfigureCodePool"
                      :loading="codePoolLoading"
                      @click="setCodePoolReadiness(false)"
                    >
                      配置并保持暂停
                    </UButton>
                    <UButton
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-refresh-cw"
                      :loading="codePoolLoading"
                      @click="loadCodePool"
                    >
                      刷新状态
                    </UButton>
                  </div>
                  <p
                    v-if="!canConfigureCodePool && !codePoolStatus?.configured"
                    class="mt-2 text-xs text-muted"
                  >
                    仅启用且未退役的数字商品 quantity SKU 可配置卡密池。配置卡密池前，请先将旧数量库存安全调整为 0。
                  </p>
                  <UAlert
                    v-if="codePoolError"
                    class="mt-3"
                    color="error"
                    variant="soft"
                    :title="codePoolError"
                    role="alert"
                  />
                  <UAlert
                    v-if="codePoolMessage"
                    class="mt-3"
                    color="success"
                    variant="soft"
                    :title="codePoolMessage"
                    role="status"
                  />
                  <UAlert
                    v-if="codePoolStatus && !codePoolStatus.inventoryConsistent"
                    class="mt-3"
                    color="error"
                    variant="soft"
                    title="SKU 数量库存与卡密状态不一致。系统已阻止新订单，请检查订单库存事件和卡密批次。"
                    role="alert"
                  />

                  <div
                    v-if="codePoolStatus"
                    class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"
                  >
                    <div class="rounded-lg border border-default bg-elevated p-3">
                      <p class="text-xs text-muted">
                        未售可用
                      </p>
                      <p class="mt-1 text-xl font-semibold tabular-nums text-highlighted">
                        {{ codePoolStatus.counts.available }}
                      </p>
                    </div>
                    <div class="rounded-lg border border-default bg-elevated p-3">
                      <p class="text-xs text-muted">
                        订单已预留
                      </p>
                      <p class="mt-1 text-xl font-semibold tabular-nums text-highlighted">
                        {{ codePoolStatus.counts.reserved }}
                      </p>
                    </div>
                    <div class="rounded-lg border border-default bg-elevated p-3">
                      <p class="text-xs text-muted">
                        已交付
                      </p>
                      <p class="mt-1 text-xl font-semibold tabular-nums text-highlighted">
                        {{ codePoolStatus.counts.delivered }}
                      </p>
                    </div>
                    <div class="rounded-lg border border-default bg-elevated p-3">
                      <p class="text-xs text-muted">
                        已撤回
                      </p>
                      <p class="mt-1 text-xl font-semibold tabular-nums text-highlighted">
                        {{ codePoolStatus.counts.revoked }}
                      </p>
                    </div>
                  </div>
                  <p
                    v-if="codePoolStatus"
                    class="mt-2 text-xs text-muted"
                  >
                    SKU 库存：实存 {{ codePoolStatus.inventory.stocked }} · 预留 {{ codePoolStatus.inventory.reserved }} · 可售 {{ codePoolStatus.inventory.available }}。启用时可售库存必须与未售卡密一致。
                  </p>

                  <form
                    v-if="codePoolStatus?.configured"
                    class="mt-5 grid gap-3 rounded-lg border border-default bg-elevated p-3 sm:p-4"
                    @submit.prevent="precheckCodePoolImport"
                  >
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h4 class="font-medium text-highlighted">
                          批量导入
                        </h4>
                        <p class="mt-1 text-xs text-muted">
                          支持粘贴或 UTF-8 TXT/单列 CSV，单次最多 5,000 条。会保留大小写及空格，只忽略空白行。
                        </p>
                      </div>
                      <UFormField label="来源格式">
                        <USelect
                          v-model="codePoolFormat"
                          :items="codePoolFormatItems"
                          class="w-36"
                          aria-label="卡密导入格式"
                        />
                      </UFormField>
                    </div>
                    <label class="grid gap-1 text-sm font-medium text-highlighted">
                      选择 TXT 或 CSV 文件
                      <input
                        class="block min-h-11 w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:font-medium file:text-primary"
                        type="file"
                        accept=".txt,.csv,text/plain,text/csv"
                        aria-label="选择卡密 TXT 或 CSV 文件"
                        @change="readCodePoolFile"
                      >
                    </label>
                    <UFormField
                      label="卡密内容"
                      hint="每行一条。CSV 可用 code 或 卡密 作为表头；预检查只返回行号和原因，不回显内容。"
                    >
                      <UTextarea
                        v-model="codePoolSourceText"
                        class="w-full"
                        :rows="6"
                        maxlength="1048576"
                        placeholder="在此粘贴卡密，每行一条"
                        autocomplete="off"
                        spellcheck="false"
                      />
                    </UFormField>
                    <div class="flex flex-wrap gap-2">
                      <UButton
                        type="submit"
                        :disabled="codePoolLoading || !codePoolSourceText"
                        :loading="codePoolLoading"
                        icon="i-lucide-scan-search"
                      >
                        预检查导入内容
                      </UButton>
                      <UButton
                        v-if="codePoolSourceText"
                        type="button"
                        color="neutral"
                        variant="outline"
                        :disabled="codePoolLoading"
                        @click="codePoolSourceText = ''; codePoolPreview = null; codePoolError = ''"
                      >
                        清除输入
                      </UButton>
                    </div>
                    <div
                      v-if="codePoolPreview"
                      class="rounded-lg border border-default bg-muted/20 p-3"
                    >
                      <p class="text-sm font-medium text-highlighted">
                        共 {{ codePoolPreview.rowCount }} 行 · 可入库 {{ codePoolPreview.acceptedCount }} · 重复 {{ codePoolPreview.duplicateCount }} · 无效 {{ codePoolPreview.invalidCount }}
                      </p>
                      <ul
                        v-if="codePoolPreview.rows.some(row => row.status !== 'accepted')"
                        class="mt-2 max-h-36 space-y-1 overflow-auto text-xs text-muted"
                        aria-label="重复及无效行"
                      >
                        <li
                          v-for="row in codePoolPreview.rows.filter(item => item.status !== 'accepted').slice(0, 100)"
                          :key="`${row.row}-${row.status}`"
                        >
                          第 {{ row.row }} 行 · {{ row.status === 'duplicate' ? '重复' : '无效' }} · {{ codePoolReasonLabel(row.reason) }}
                        </li>
                      </ul>
                      <p
                        v-if="codePoolPreview.rows.filter(row => row.status !== 'accepted').length > 100"
                        class="mt-2 text-xs text-muted"
                      >
                        仅显示前 100 条重复或无效行；其余行号已包含在预检查结果中。
                      </p>
                      <UButton
                        v-if="codePoolPreview.acceptedCount"
                        class="mt-3"
                        color="success"
                        :disabled="codePoolLoading"
                        :loading="codePoolLoading"
                        @click="importCodePool"
                      >
                        确认加密入库 {{ codePoolPreview.acceptedCount }} 条
                      </UButton>
                    </div>
                  </form>

                  <section
                    v-if="codePoolStatus?.configured"
                    class="mt-5 rounded-lg border border-default bg-elevated p-3 sm:p-4"
                    aria-labelledby="code-pool-entries-title"
                  >
                    <div class="flex flex-wrap items-end justify-between gap-3">
                      <div>
                        <h4
                          id="code-pool-entries-title"
                          class="font-medium text-highlighted"
                        >
                          卡密条目管理
                        </h4>
                        <p class="mt-1 text-xs text-muted">
                          列表只显示状态与追踪编号，不显示卡密内容。只有“未售可用”条目能撤回。
                        </p>
                      </div>
                      <UFormField label="状态筛选">
                        <USelect
                          v-model="codePoolEntryFilter"
                          :items="codePoolStatusItems"
                          class="w-36"
                          aria-label="卡密条目状态筛选"
                        />
                      </UFormField>
                    </div>
                    <div
                      v-if="codePoolEntries?.items.length"
                      class="mt-3 divide-y divide-default rounded-lg border border-default"
                    >
                      <article
                        v-for="entry in codePoolEntries.items"
                        :key="entry.id"
                        class="flex min-w-0 flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div class="flex min-w-0 items-start gap-3">
                          <UCheckbox
                            v-if="entry.state === 'available'"
                            :model-value="codePoolSelectedEntryIds.includes(entry.id)"
                            :aria-label="`选择未售卡密条目 ${entry.id} 撤回`"
                            @update:model-value="value => toggleCodePoolEntry(entry.id, Boolean(value))"
                          />
                          <div class="min-w-0">
                            <p class="break-all font-mono text-xs text-highlighted">
                              条目 {{ entry.id }}
                            </p>
                            <p class="mt-1 break-all font-mono text-[11px] text-dimmed">
                              导入批次 {{ entry.importBatchId }}
                            </p>
                            <p
                              v-if="entry.orderId"
                              class="mt-1 text-xs text-muted"
                            >
                              所属订单
                              <NuxtLink
                                :to="`/admin/orders/${entry.orderId}`"
                                class="text-primary underline underline-offset-2"
                              >
                                {{ entry.orderId }}
                              </NuxtLink>
                            </p>
                          </div>
                        </div>
                        <div class="flex flex-wrap items-center gap-2 text-xs text-muted sm:justify-end">
                          <UBadge
                            :color="entry.state === 'available' ? 'success' : entry.state === 'reserved' ? 'warning' : entry.state === 'delivered' ? 'primary' : 'neutral'"
                            variant="soft"
                          >
                            {{ entry.state === 'available' ? '未售可用' : entry.state === 'reserved' ? '已预留' : entry.state === 'delivered' ? '已交付' : '已撤回' }}
                          </UBadge>
                          <time :datetime="entry.createdAt">{{ formatDate(entry.createdAt) }}</time>
                        </div>
                      </article>
                    </div>
                    <UEmpty
                      v-else
                      class="mt-3 rounded-lg border border-dashed border-default p-4"
                      icon="i-lucide-key-round"
                      title="没有符合筛选条件的卡密条目"
                      description="导入批次和状态变化会保留在此追踪。"
                    />
                    <div
                      v-if="codePoolEntries && codePoolEntries.totalPages > 1"
                      class="mt-3 flex items-center justify-between gap-3"
                    >
                      <UButton
                        color="neutral"
                        variant="outline"
                        size="sm"
                        :disabled="codePoolEntryPageNumber <= 1 || codePoolLoading"
                        @click="codePoolEntryPageNumber--"
                      >
                        上一页
                      </UButton>
                      <span class="text-xs text-muted">第 {{ codePoolEntryPageNumber }} / {{ codePoolEntries.totalPages }} 页，共 {{ codePoolEntries.total }} 条</span>
                      <UButton
                        color="neutral"
                        variant="outline"
                        size="sm"
                        :disabled="codePoolEntryPageNumber >= codePoolEntries.totalPages || codePoolLoading"
                        @click="codePoolEntryPageNumber++"
                      >
                        下一页
                      </UButton>
                    </div>
                    <form
                      v-if="codePoolSelectedEntryIds.length"
                      class="mt-4 grid gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3"
                      @submit.prevent="withdrawCodePoolEntries"
                    >
                      <p class="text-sm font-medium text-highlighted">
                        已选择 {{ codePoolSelectedEntryIds.length }} 条未售可用卡密。撤回会永久标记这些条目，并通过库存事件同步减少 SKU 数量。
                      </p>
                      <UFormField
                        label="撤回原因"
                        required
                      >
                        <UInput
                          v-model="codePoolWithdrawalReason"
                          class="w-full"
                          maxlength="500"
                          placeholder="例如：供应商批次取消"
                        />
                      </UFormField>
                      <UFormField
                        label="输入确认词 REVOKE_UNSOLD_CODES"
                        hint="此操作不可撤销。已预留或已交付的卡密不能撤回。"
                      >
                        <UInput
                          v-model="codePoolWithdrawalConfirmation"
                          class="w-full sm:max-w-md"
                          autocomplete="off"
                          spellcheck="false"
                        />
                      </UFormField>
                      <UButton
                        type="submit"
                        color="warning"
                        variant="outline"
                        icon="i-lucide-archive-restore"
                        :disabled="codePoolLoading || !codePoolWithdrawalReason.trim() || codePoolWithdrawalConfirmation !== 'REVOKE_UNSOLD_CODES'"
                        :loading="codePoolLoading"
                      >
                        安全撤回未售卡密
                      </UButton>
                    </form>
                  </section>

                  <section
                    v-if="codePoolBatches?.items.length"
                    class="mt-5 rounded-lg border border-default bg-elevated p-3 sm:p-4"
                    aria-labelledby="code-pool-batches-title"
                  >
                    <h4
                      id="code-pool-batches-title"
                      class="font-medium text-highlighted"
                    >
                      最近导入与撤回批次
                    </h4>
                    <ul class="mt-3 divide-y divide-default rounded-lg border border-default">
                      <li
                        v-for="batch in codePoolBatches.items"
                        :key="batch.id"
                        class="grid gap-1 p-3 text-xs sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:gap-3"
                      >
                        <UBadge
                          :color="batch.kind === 'import' ? 'primary' : 'warning'"
                          variant="soft"
                        >
                          {{ batch.kind === 'import' ? '导入批次' : '撤回批次' }} · {{ batch.acceptedCount }} 条
                        </UBadge>
                        <span class="break-all font-mono text-dimmed">{{ batch.id }} · 管理员 {{ batch.administratorId }}</span>
                        <time
                          class="text-muted"
                          :datetime="batch.createdAt"
                        >{{ formatDate(batch.createdAt) }}</time>
                        <p
                          v-if="batch.reason"
                          class="text-muted sm:col-span-3"
                        >
                          撤回原因：{{ batch.reason }}
                        </p>
                        <p
                          v-if="batch.kind === 'import'"
                          class="text-muted sm:col-span-3"
                        >
                          请求 {{ batch.requestedCount }} · 重复 {{ batch.duplicateCount }} · 无效 {{ batch.invalidCount }}
                        </p>
                      </li>
                    </ul>
                  </section>
                </section>

                <section
                  v-if="historySkuId"
                  class="mt-5 rounded-lg border border-default p-3"
                  aria-labelledby="inventory-adjust-title"
                >
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3
                        id="inventory-adjust-title"
                        class="font-medium text-highlighted"
                      >
                        库存调整
                      </h3>
                      <p class="mt-1 text-sm text-muted">
                        SKU {{ product.variants.find(variant => variant.id === historySkuId)?.skuCode }} · 当前服务端库存为准
                      </p>
                    </div>
                    <UButton
                      size="sm"
                      color="neutral"
                      variant="ghost"
                      @click="historySkuId = ''; history = null"
                    >
                      关闭
                    </UButton>
                  </div>
                  <UAlert
                    v-if="adjustmentMessage"
                    class="my-3"
                    :color="pendingAdjustment ? 'warning' : 'info'"
                    variant="soft"
                    :title="adjustmentMessage"
                    role="status"
                  />
                  <div
                    v-if="pendingAdjustment"
                    class="my-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/5 p-3"
                  >
                    <p class="text-sm text-highlighted">
                      待核验 operationId：<span class="font-mono text-xs">{{ pendingAdjustment.body.operationId }}</span>
                    </p>
                    <UButton
                      color="warning"
                      :loading="saving === 'inventory-adjustment'"
                      @click="submitAdjustment"
                    >
                      先核验并安全重试
                    </UButton>
                  </div>
                  <form
                    v-else
                    class="mt-3 grid gap-3 sm:grid-cols-2"
                    @submit.prevent="submitAdjustment"
                  >
                    <UFormField label="操作">
                      <USelect
                        v-model="adjustmentAction"
                        :items="[{ label: '增加库存', value: 'increase' }, { label: '减少库存', value: 'decrease' }, { label: '设置目标数量', value: 'set' }]"
                        class="w-full"
                      />
                    </UFormField>
                    <UFormField
                      :label="adjustmentAction === 'set' ? '目标数量' : '变更数量'"
                      required
                    >
                      <UInput
                        v-model="adjustmentQuantity"
                        inputmode="numeric"
                        class="w-full"
                        required
                      />
                    </UFormField>
                    <UFormField
                      label="调整原因"
                      required
                      class="sm:col-span-2"
                    >
                      <UInput
                        v-model="adjustmentReason"
                        maxlength="500"
                        placeholder="例如：补充到货 20 件"
                        class="w-full"
                        required
                      />
                    </UFormField>
                    <div class="sm:col-span-2 flex justify-end">
                      <UButton
                        type="submit"
                        :loading="saving === 'inventory-adjustment'"
                      >
                        提交库存调整
                      </UButton>
                    </div>
                  </form>
                  <details class="mt-4 border-t border-default pt-3">
                    <summary class="min-h-11 cursor-pointer py-2 font-medium text-highlighted">
                      库存调整历史（服务端分页）
                    </summary>
                    <UAlert
                      v-if="historyError"
                      class="mb-3"
                      color="error"
                      variant="soft"
                      :title="historyError"
                      role="alert"
                    />
                    <p
                      v-if="historyLoading"
                      class="py-3 text-sm text-muted"
                    >
                      正在读取库存流水…
                    </p>
                    <UEmpty
                      v-else-if="history && history.adjustments.length === 0"
                      icon="i-lucide-history"
                      title="暂无库存调整记录"
                      description="首次调整后，流水会显示操作人、原因与数量变化。"
                    />
                    <ol
                      v-else-if="history"
                      class="divide-y divide-default"
                    >
                      <li
                        v-for="item in history.adjustments"
                        :key="item.id"
                        class="py-3 text-sm"
                      >
                        <div class="flex flex-wrap justify-between gap-2">
                          <span class="font-medium text-highlighted">{{ item.action === 'increase' ? '增加' : item.action === 'decrease' ? '减少' : '设置' }} {{ item.requestedQuantity }}</span><time
                            :datetime="item.createdAt"
                            class="text-xs text-muted"
                          >{{ formatDate(item.createdAt) }}</time>
                        </div>
                        <p class="mt-1 text-muted">
                          {{ item.quantityBefore }} → {{ item.quantityAfter }}（{{ item.quantityDelta > 0 ? '+' : '' }}{{ item.quantityDelta }}）· {{ item.reason }}
                        </p>
                        <p class="mt-1 font-mono text-[11px] text-dimmed">
                          operationId {{ item.operationId }} · inventory_revision {{ item.inventoryRevision }}
                        </p>
                      </li>
                    </ol>
                    <div
                      v-if="history?.nextCursor"
                      class="mt-3 flex justify-end"
                    >
                      <UButton
                        size="sm"
                        color="neutral"
                        variant="outline"
                        :loading="historyLoading"
                        @click="loadInventoryHistory(true)"
                      >
                        加载更早流水
                      </UButton>
                    </div>
                  </details>
                </section>
              </section>

              <section
                id="attributes"
                aria-labelledby="attributes-title"
                class="py-6"
              >
                <header class="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2
                      id="attributes-title"
                      class="text-lg font-semibold text-highlighted"
                    >
                      商品属性
                    </h2>
                    <p class="mt-1 text-sm text-muted">
                      可维护最多 30 条展示属性；不会生成虚构的销量或订单数据。
                    </p>
                  </div>
                  <UBadge
                    v-if="dirty.attributes"
                    color="warning"
                    variant="subtle"
                  >
                    未保存
                  </UBadge>
                </header>
                <UAlert
                  v-if="sectionErrors.attributes"
                  class="mb-3"
                  color="error"
                  variant="soft"
                  :title="sectionErrors.attributes"
                  role="alert"
                />
                <UAlert
                  v-if="sectionSuccess.attributes"
                  class="mb-3"
                  color="success"
                  variant="soft"
                  :title="sectionSuccess.attributes"
                  role="status"
                />
                <div class="grid gap-3">
                  <div
                    v-for="(attribute, index) in attributesDraft"
                    :key="attribute.id ?? `new-${index}`"
                    class="grid gap-2 sm:grid-cols-[1fr_1.5fr_auto]"
                  >
                    <UInput
                      v-model="attribute.name"
                      aria-label="属性名称"
                      placeholder="属性名称"
                      maxlength="80"
                      :disabled="isArchived"
                      @update:model-value="dirty.attributes = true; clearSectionStatus('attributes')"
                    />
                    <UInput
                      v-model="attribute.value"
                      aria-label="属性值"
                      placeholder="属性值"
                      maxlength="500"
                      :disabled="isArchived"
                      @update:model-value="dirty.attributes = true; clearSectionStatus('attributes')"
                    />
                    <UButton
                      color="error"
                      variant="ghost"
                      icon="i-lucide-x"
                      :aria-label="`删除属性 ${index + 1}`"
                      :disabled="isArchived"
                      @click="removeAttribute(index)"
                    />
                  </div>
                </div>
                <div class="mt-3 flex flex-wrap justify-between gap-2">
                  <UButton
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-plus"
                    :disabled="isArchived || attributesDraft.length >= 30"
                    @click="addAttribute"
                  >
                    添加属性
                  </UButton>
                  <UButton
                    :loading="saving === 'attributes'"
                    :disabled="isArchived || saving !== '' || !dirty.attributes"
                    @click="saveAttributes"
                  >
                    保存属性
                  </UButton>
                </div>
              </section>

              <section
                id="advanced"
                aria-labelledby="advanced-title"
                class="py-6"
              >
                <h2
                  id="advanced-title"
                  class="text-lg font-semibold text-highlighted"
                >
                  高级操作
                </h2>
                <p class="mt-1 text-sm text-muted">
                  生命周期、复制和安全删除。
                </p>
                <UAlert
                  v-if="sectionErrors.lifecycle || sectionErrors.advanced"
                  class="mt-3"
                  color="error"
                  variant="soft"
                  :title="sectionErrors.lifecycle || sectionErrors.advanced"
                  role="alert"
                />
                <UAlert
                  v-if="sectionSuccess.lifecycle"
                  class="mt-3"
                  color="success"
                  variant="soft"
                  :title="sectionSuccess.lifecycle"
                  role="status"
                />
                <div class="mt-4 flex flex-wrap gap-2">
                  <UButton
                    v-if="product.status === 'draft'"
                    :loading="saving === 'lifecycle'"
                    :disabled="saving !== ''"
                    @click="changeLifecycle('active')"
                  >
                    发布商品
                  </UButton>
                  <UButton
                    v-if="product.status === 'active'"
                    color="warning"
                    variant="outline"
                    :loading="saving === 'lifecycle'"
                    :disabled="saving !== ''"
                    @click="changeLifecycle('paused')"
                  >
                    暂停销售
                  </UButton>
                  <UButton
                    v-if="product.status === 'paused'"
                    :loading="saving === 'lifecycle'"
                    :disabled="saving !== ''"
                    @click="changeLifecycle('active')"
                  >
                    重新上架
                  </UButton>
                  <UButton
                    v-if="product.status !== 'archived'"
                    color="neutral"
                    variant="outline"
                    :loading="saving === 'lifecycle'"
                    :disabled="saving !== ''"
                    @click="changeLifecycle('archived')"
                  >
                    归档
                  </UButton>
                  <UButton
                    v-if="product.status === 'archived'"
                    :loading="saving === 'lifecycle'"
                    :disabled="saving !== ''"
                    @click="changeLifecycle('draft')"
                  >
                    恢复为草稿
                  </UButton>
                  <UButton
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-copy"
                    :loading="saving === 'copy'"
                    :disabled="saving !== ''"
                    @click="copyProduct"
                  >
                    复制商品
                  </UButton>
                </div>
                <div class="mt-5 border-t border-default pt-4">
                  <h3 class="font-medium text-highlighted">
                    永久删除
                  </h3>
                  <p class="mt-1 max-w-2xl text-sm text-muted">
                    删除会移除商品记录；若有库存流水或历史引用，服务端会阻止并保留记录。遇到此情况可归档商品。
                  </p>
                  <UButton
                    class="mt-3"
                    color="error"
                    variant="outline"
                    icon="i-lucide-trash-2"
                    :loading="saving === 'delete'"
                    :disabled="saving !== ''"
                    @click="deleteProduct"
                  >
                    永久删除商品
                  </UButton>
                </div>
              </section>
            </div>

            <aside class="min-w-0 lg:sticky lg:top-4 lg:self-start">
              <div class="rounded-xl border border-default bg-elevated p-4">
                <h2 class="font-semibold text-highlighted">
                  保存状态
                </h2>
                <p class="mt-1 text-xs leading-5 text-muted">
                  分区保存后更新商品修订号；库存数量单独维护库存修订。
                </p>
                <ul class="mt-4 grid gap-2 text-sm">
                  <li
                    v-for="[key, label] in [['basic', '基本信息'], ['categories', '分类'], ['gallery', '图片相册'], ['rich', '图文详情'], ['matrix', '规格与 SKU'], ['prices', '价格'], ['attributes', '商品属性']]"
                    :key="key"
                    class="flex items-center justify-between gap-2"
                  >
                    <span class="text-muted">{{ label }}</span>
                    <UBadge
                      :color="dirty[key as keyof typeof dirty] ? 'warning' : 'success'"
                      variant="subtle"
                    >
                      {{ dirty[key as keyof typeof dirty] ? '未保存' : '已保存' }}
                    </UBadge>
                  </li>
                </ul>
                <div class="mt-4 border-t border-default pt-4">
                  <p class="text-xs text-muted">
                    当前状态
                  </p>
                  <p class="mt-1 font-medium text-highlighted">
                    {{ statusName }}
                  </p>
                  <p class="mt-2 text-xs text-muted">
                    更新时间
                  </p>
                  <time
                    :datetime="product.updatedAt"
                    class="mt-1 block text-sm text-highlighted"
                  >{{ formatDate(product.updatedAt) }}</time>
                </div>
                <UButton
                  class="mt-4 w-full"
                  icon="i-lucide-save"
                  :loading="saving === 'basic'"
                  :disabled="isArchived || saving !== '' || !dirty.basic"
                  @click="saveBasic"
                >
                  保存基本资料
                </UButton>
              </div>
            </aside>
          </div>

          <UModal
            v-model:open="categoryManagerOpen"
            title="分类管理"
            description="最多四级；移动操作会显示完整层级路径并由服务端再次校验。"
            :scrollable="true"
            :ui="{ content: 'max-w-4xl' }"
          >
            <template #body>
              <div class="grid gap-4">
                <section
                  class="rounded-lg border border-default p-3"
                  aria-labelledby="new-category-title"
                >
                  <h3
                    id="new-category-title"
                    class="font-medium text-highlighted"
                  >
                    创建分类
                  </h3>
                  <div class="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <UFormField
                      label="分类名称"
                      required
                    >
                      <UInput
                        v-model="newCategoryName"
                        maxlength="120"
                        class="w-full"
                      />
                    </UFormField>
                    <UFormField label="父级分类">
                      <USelect
                        v-model="newCategoryParentId"
                        :items="allowedCategoryParents()"
                        class="w-full"
                      />
                    </UFormField>
                    <UButton
                      :loading="saving === 'category-create'"
                      @click="createCategory"
                    >
                      创建
                    </UButton>
                  </div>
                </section>
                <UAlert
                  v-if="categoryMessage"
                  color="info"
                  variant="soft"
                  :title="categoryMessage"
                  role="status"
                />
                <UEmpty
                  v-if="sortedCategoryManagerRows.length === 0"
                  icon="i-lucide-list-tree"
                  title="还没有分类"
                  description="创建分类后，可在商品分类区选择主分类和辅助分类。"
                />
                <div
                  v-else
                  class="divide-y divide-default rounded-lg border border-default"
                >
                  <article
                    v-for="entry in sortedCategoryManagerRows"
                    :key="entry.category.id"
                    class="min-w-0 p-3"
                  >
                    <div
                      class="mb-2 flex items-center gap-2"
                      :style="{ paddingLeft: `${entry.depth * 16}px` }"
                    >
                      <span class="text-xs text-dimmed">{{ entry.path }}</span>
                      <UBadge
                        :color="entry.category.isVisible ? 'success' : 'neutral'"
                        variant="subtle"
                      >
                        {{ entry.category.isVisible ? '显示' : '隐藏' }}
                      </UBadge>
                    </div>
                    <div class="grid min-w-0 gap-2 md:grid-cols-[1.2fr_1.4fr_auto_auto] md:items-end">
                      <UFormField label="名称">
                        <UInput
                          v-model="categoryNameDraft[entry.category.id]"
                          maxlength="120"
                          class="w-full"
                        />
                      </UFormField>
                      <UFormField label="移动到父级">
                        <USelect
                          v-model="categoryParentDraft[entry.category.id]"
                          :items="allowedCategoryParents(entry.category)"
                          class="w-full"
                        />
                      </UFormField>
                      <UButton
                        size="sm"
                        color="neutral"
                        variant="outline"
                        @click="renameCategory(entry.category)"
                      >
                        保存名称
                      </UButton>
                      <UButton
                        size="sm"
                        color="neutral"
                        variant="outline"
                        @click="moveCategory(entry.category)"
                      >
                        保存层级
                      </UButton>
                    </div>
                    <div class="mt-2 flex flex-wrap gap-2">
                      <UButton
                        size="sm"
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-arrow-up-to-line"
                        @click="reorderCategory(entry.category, 'first')"
                      >
                        移到同级最前
                      </UButton>
                      <UButton
                        size="sm"
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-arrow-down-to-line"
                        @click="reorderCategory(entry.category, 'last')"
                      >
                        移到同级最后
                      </UButton>
                      <UButton
                        size="sm"
                        color="neutral"
                        variant="ghost"
                        @click="updateCategory(entry.category, { isVisible: !entry.category.isVisible }, entry.category.isVisible ? '分类已隐藏。' : '分类已显示。')"
                      >
                        {{ entry.category.isVisible ? '隐藏分类' : '显示分类' }}
                      </UButton>
                      <UButton
                        size="sm"
                        color="error"
                        variant="ghost"
                        icon="i-lucide-trash-2"
                        @click="deleteCategory(entry.category)"
                      >
                        删除
                      </UButton>
                    </div>
                  </article>
                </div>
              </div>
            </template>
          </UModal>

          <UModal
            v-model:open="mediaLibraryOpen"
            title="图片库"
            description="可复用已处理图片。物理删除仅对未被任何商品或正文引用的媒体开放。"
            :scrollable="true"
            :ui="{ content: 'max-w-5xl' }"
          >
            <template #body>
              <div class="grid gap-4">
                <div class="flex flex-col gap-2 sm:flex-row">
                  <UInput
                    v-model="mediaSearch"
                    aria-label="按媒体 ID 搜索"
                    placeholder="媒体 ID"
                    icon="i-lucide-search"
                    class="w-full"
                    @keydown.enter="loadMediaLibrary(1)"
                  />
                  <UButton
                    color="neutral"
                    variant="outline"
                    @click="loadMediaLibrary(1)"
                  >
                    搜索图片
                  </UButton>
                </div>
                <UEmpty
                  v-if="mediaLibrary && mediaLibrary.items.length === 0"
                  icon="i-lucide-images"
                  title="没有找到图片"
                  description="上传图片后会显示在这里。"
                />
                <ul
                  v-else-if="mediaLibrary"
                  class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
                >
                  <li
                    v-for="media in mediaLibrary.items"
                    :key="media.id"
                    class="min-w-0 overflow-hidden rounded-lg border border-default"
                  >
                    <img
                      :src="media.variants.find(variant => variant.variant === 'card')?.url"
                      alt="商品图片预览"
                      class="aspect-square w-full bg-muted object-cover"
                      loading="lazy"
                    >
                    <div class="p-2">
                      <p class="truncate font-mono text-xs text-highlighted">
                        {{ media.id }}
                      </p>
                      <p class="mt-1 text-xs text-muted">
                        被引用 {{ media.referenceCount }} 次
                      </p>
                      <div class="mt-2 grid gap-2">
                        <UButton
                          size="sm"
                          :disabled="galleryDraft.length >= 20 || galleryDraft.some(image => image.id === media.id) || isArchived"
                          @click="appendGalleryImage(media)"
                        >
                          {{ galleryDraft.some(image => image.id === media.id) ? '已在当前相册' : '加入待保存相册' }}
                        </UButton>
                        <UButton
                          size="sm"
                          color="error"
                          variant="outline"
                          :loading="deletingMediaId === media.id"
                          :disabled="media.referenceCount > 0 || isArchived || galleryDraft.some(image => image.id === media.id) || mediaUsedInRichContent(richDraft, media.id)"
                          @click="permanentlyDeleteMedia(media.id)"
                        >
                          永久删除文件
                        </UButton>
                      </div>
                    </div>
                  </li>
                </ul>
                <div
                  v-if="mediaLibrary && mediaLibrary.totalPages > 1"
                  class="flex justify-center"
                >
                  <UPagination
                    :page="mediaLibraryPage"
                    :total="mediaLibrary.total"
                    :items-per-page="24"
                    show-controls
                    @update:page="loadMediaLibrary"
                  />
                </div>
              </div>
            </template>
          </UModal>
        </template>
      </main>
    </template>
  </UDashboardPanel>
</template>
