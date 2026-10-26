<script setup lang="ts">
import { toRaw } from 'vue'
import { normalizePurchaseFormAnswers, validatePurchaseFormDefinition, type ApiSuccess, type CustomerCartReplacementDraft, type CheckoutQuote, type CheckoutQuoteItem, type PurchaseDraft, type PurchaseFormDefinition, type PurchaseFormField, type StorefrontPurchaseForm, type PublicInventorySummary, type PublicProductDetail, type PublicProductVariant } from '@aikayun/contracts'

const route = useRoute()
const siteUrl = usePublicSiteUrl()
useUncachedPublicPage()
const id = computed(() => String(route.params.id ?? ''))
const asyncDataKey = computed(() => `public-product-detail-${id.value}`)
const { data: fetchedData, error, status, refresh } = await useAsyncData(
  asyncDataKey,
  async (_nuxtApp, { signal }) => {
    try {
      return (await $fetch<ApiSuccess<PublicProductDetail>>(`/api/v1/public/products/${encodeURIComponent(id.value)}`, { signal })).data
    }
    catch (cause) {
      // FetchError.data contains the upstream body; keep it out of Nuxt payloads.
      return throwSafePublicApiError(cause, signal)
    }
  },
  { default: () => null, deep: false, getCachedData: (key, nuxtApp) => nuxtApp.isHydrating ? nuxtApp.payload.data[key] : undefined },
)
const product = computed(() => fetchedData.value?.id === id.value ? fetchedData.value : null)
const responseStatus = computed(() => Number((error.value as { statusCode?: number; status?: number } | null)?.statusCode ?? (error.value as { status?: number } | null)?.status ?? 0))
const isValidProductId = computed(() => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id.value))
const notFound = computed(() => responseStatus.value === 404 || (!isValidProductId.value && Boolean(id.value)))
const productTypeLabels = { physical: '实物商品', digital: '数字商品', service: '服务商品' } as const
const selections = reactive<Record<string, string>>({})
const selectedImage = ref(0)
const imageFailed = ref(false)
const quantity = ref(1)
const shoppingCart = useShoppingCart()
const customerApi = useCustomerApi()
const cartFeedback = ref('')
const purchaseQuote = ref<CheckoutQuote | null>(null)
const purchaseQuoteError = ref('')
const purchaseQuoteBusy = ref(false)
let purchaseQuoteSequence = 0
const purchaseForm = ref<StorefrontPurchaseForm | null>(null)
const purchaseDraft = ref<PurchaseDraft | null>(null)
const cartReplacementSourceDraft = ref<PurchaseDraft | null>(null)
const purchaseValues = ref<Record<string, unknown>>({})
const purchaseDraftDirty = ref(false)
const purchaseDraftComplete = ref(false)
const purchaseFormBusy = ref(false)
const purchaseFormMessage = ref('')
const purchaseFormError = ref('')
const purchaseFormErrors = ref<Record<string, string>>({})
const purchaseFormResetKey = ref(0)
const immediateLineId = ref('')
const storefrontInteractive = ref(false)
let purchaseFormGeneration = 0
let purchaseFormLoadSequence = 0
let purchaseFormOperationSequence = 0
let activePurchaseFormOperation = 0
let purchaseFormDisposed = false
let installingPurchaseDraft = false
type PurchaseDraftRecovery = {
  id: string
  templateVersionId: string
  revision: number
  expiresAt: string
  updatedAt: string
  templateChanged: boolean
}
const purchaseDraftRecoveries = ref<PurchaseDraftRecovery[]>([])
type PurchaseFormOperationContext = {
  skuId: string
  draftId: string
  draftRevision: number
  identityVersion: number
  generation: number
  operationId: number
}
type CartEditContext = {
  sourceVerified: boolean
  lineId: string
  skuId: string
  lineRevision: number | null
  expectedDraftRevision: number | null
  draftId: string | null
  replacementDraftId: string | null
  omittedSourceAttachmentIds: string[]
  quantity: number
}
const cartEdit = ref<CartEditContext | null>(null)
cartEdit.value = parseCartEditContext()
const isCustomer = computed(() => Boolean(customerApi.session.value?.customer.id))
const purchaseDefinition = computed<PurchaseFormDefinition | null>(() => {
  const definition = purchaseForm.value?.definition
  if (!definition) return null
  const validated = validatePurchaseFormDefinition(definition)
  return validated.ok ? validated.value : null
})
const availablePurchaseDraftRecoveries = computed(() => {
  const bound = new Set(shoppingCart.guestItems.value.flatMap(item =>
    'draftId' in item && item.draftId ? [item.draftId] : []))
  return purchaseDraftRecoveries.value.filter(candidate => !bound.has(candidate.id))
})

watch(product, (value) => {
  for (const key of Object.keys(selections)) delete selections[key]
  const requestedSkuId = typeof route.query.skuId === 'string' ? route.query.skuId.toLowerCase() : ''
  const requestedVariant = value?.variants.find(variant => variant.skuId.toLowerCase() === requestedSkuId)
  if (requestedVariant) {
    for (const option of requestedVariant.options) selections[option.groupId] = option.valueId
  }
  if (value?.optionGroups.length === 0 && value.variants.length === 1) {
    // A single no-spec SKU is unambiguous and may be selected automatically.
  }
  selectedImage.value = 0
  imageFailed.value = false
  quantity.value = cartEdit.value?.skuId.toLowerCase() === requestedSkuId ? cartEdit.value.quantity : 1
}, { immediate: true })

function parseCartEditContext(): CartEditContext | null {
  const query = route.query
  const lineId = typeof query.editLineId === 'string' ? query.editLineId : ''
  const skuId = typeof query.skuId === 'string' ? query.skuId : ''
  const quantityValue = typeof query.quantity === 'string' ? Number(query.quantity) : 1
  const lineRevisionValue = typeof query.lineRevision === 'string' ? Number(query.lineRevision) : null
  const expectedDraftRevisionValue = typeof query.expectedDraftRevision === 'string' ? Number(query.expectedDraftRevision) : null
  const draftId = typeof query.draftId === 'string' ? query.draftId : null
  const replacementDraftId = typeof query.replacementDraftId === 'string' ? query.replacementDraftId : null
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
  if (!uuid.test(lineId) || !uuid.test(skuId)
    || (lineRevisionValue !== null && (!Number.isSafeInteger(lineRevisionValue) || lineRevisionValue < 1))
    || (expectedDraftRevisionValue !== null && (!Number.isSafeInteger(expectedDraftRevisionValue) || expectedDraftRevisionValue < 1))
    || (draftId !== null && !uuid.test(draftId))
    || (replacementDraftId !== null && !uuid.test(replacementDraftId))
    || !Number.isSafeInteger(quantityValue) || quantityValue < 1 || quantityValue > 99) return null
  return { sourceVerified: false, lineId: lineId.toLowerCase(), skuId: skuId.toLowerCase(), lineRevision: lineRevisionValue,
    expectedDraftRevision: expectedDraftRevisionValue, draftId: draftId?.toLowerCase() ?? null,
    replacementDraftId: replacementDraftId?.toLowerCase() ?? null, omittedSourceAttachmentIds: [], quantity: quantityValue }
}

watch(() => [route.query.editLineId, route.query.skuId, route.query.lineRevision, route.query.expectedDraftRevision, route.query.draftId, route.query.replacementDraftId, route.query.quantity], () => {
  const parsed = parseCartEditContext()
  const current = cartEdit.value
  cartEdit.value = parsed && current?.sourceVerified && sameCartEditSource(parsed, current)
    ? { ...parsed, sourceVerified: true, lineRevision: current.lineRevision, quantity: current.quantity }
    : parsed
}, { immediate: true, flush: 'sync' })
const isEditingCartLine = computed(() => Boolean(cartEdit.value && cartEdit.value.skuId === selectedVariant.value?.skuId.toLowerCase()))
const hasCartReplacementDraft = computed(() => Boolean(isEditingCartLine.value && cartEdit.value?.replacementDraftId
  && purchaseDraft.value?.id === cartEdit.value.replacementDraftId))

function sameCartEditSource(a: CartEditContext, b: CartEditContext): boolean {
  return a.lineId === b.lineId && a.skuId === b.skuId && a.draftId === b.draftId
    && a.expectedDraftRevision === b.expectedDraftRevision
}

function adoptCartEditSource(edit: CartEditContext, source: Pick<CustomerCartReplacementDraft,
  'lineId' | 'skuId' | 'quantity' | 'sourceDraftId' | 'sourceLineRevision' | 'sourceDraftRevision' | 'templateVersionId'>): boolean {
  const current = cartEdit.value
  if (!current || !sameCartEditSource(current, edit) || source.lineId !== edit.lineId || source.skuId !== edit.skuId
    || source.sourceDraftId !== edit.draftId || source.sourceDraftRevision !== edit.expectedDraftRevision
    || source.templateVersionId !== purchaseForm.value?.templateVersionId) {
    purchaseFormError.value = '购物车来源资料已变化；原购买资料仍保留，请返回购物车重新确认。'
    return false
  }
  let lineRevision = source.sourceLineRevision
  let lineQuantity = source.quantity
  const row = shoppingCart.cartView.value?.items.find(item => item.lineId === edit.lineId)
  if (row?.lineRevision !== null && row?.lineRevision !== undefined && row.lineRevision >= lineRevision) {
    if (row.skuId !== edit.skuId || row.draftId !== edit.draftId || row.draftRevision !== edit.expectedDraftRevision
      || row.templateVersionId !== source.templateVersionId) {
      purchaseFormError.value = '购物车来源资料已变化；请返回购物车重新确认。'
      return false
    }
    lineRevision = row.lineRevision
    lineQuantity = row.quantity
  }
  if (current.sourceVerified && current.lineRevision !== null && current.lineRevision > lineRevision) {
    lineRevision = current.lineRevision
    lineQuantity = current.quantity
  }
  cartEdit.value = { ...current, sourceVerified: true, lineRevision, quantity: lineQuantity }
  quantity.value = lineQuantity
  return true
}

function installPurchaseDraft(draft: PurchaseDraft, newPurchaseSelection = false) {
  installingPurchaseDraft = true
  purchaseDraft.value = draft
  purchaseValues.value = clonePurchaseRecord(draft.values)
  purchaseDraftDirty.value = false
  purchaseDraftComplete.value = false
  purchaseFormErrors.value = {}
  if (newPurchaseSelection || !immediateLineId.value) immediateLineId.value = crypto.randomUUID()
  purchaseFormResetKey.value++
  nextTick(() => { installingPurchaseDraft = false })
}

function clonePurchaseRecord(values: Record<string, unknown>): Record<string, unknown> {
  // Draft answers are JSON by contract; JSON cloning also unwraps nested Vue
  // proxies received from a reactive cart draft.
  return JSON.parse(JSON.stringify(values)) as Record<string, unknown>
}

function mergeReplacementDraftForDisplay(
  target: PurchaseDraft,
  source: PurchaseDraft,
  omittedSourceAttachmentIds: string[],
  definition: PurchaseFormDefinition,
): PurchaseDraft {
  const values = clonePurchaseRecord(target.revision === 1 ? source.values : target.values)
  const replacedIds = new Set(target.attachments.flatMap(attachment => attachment.replacesAttachmentId
    ? [attachment.replacesAttachmentId.toLowerCase()] : []))
  const excludedIds = new Set([...omittedSourceAttachmentIds.map(id => id.toLowerCase()), ...replacedIds])
  const mergeImageList = (current: unknown, previous: unknown): string[] => {
    const next = Array.isArray(current) ? current.filter((value): value is string => typeof value === 'string') : []
    const old = Array.isArray(previous) ? previous.filter((value): value is string => typeof value === 'string') : []
    return [...old.filter(id => !excludedIds.has(id.toLowerCase()) && !next.includes(id)), ...next]
  }

  for (const field of definition.fields) {
    const fieldId = field.id.toLowerCase()
    if (field.type === 'image') {
      const merged = mergeImageList(values[fieldId], source.values[fieldId])
      if (merged.length) values[fieldId] = merged
      else delete values[fieldId]
      continue
    }
    if (field.type !== 'cascade') continue
    const sourceRaw = source.values[fieldId]
    const targetRaw = values[fieldId]
    const sourceCascade = sourceRaw && typeof sourceRaw === 'object' && !Array.isArray(sourceRaw)
      ? sourceRaw as { path?: unknown; expanded?: unknown } : null
    const targetCascade = targetRaw && typeof targetRaw === 'object' && !Array.isArray(targetRaw)
      ? targetRaw as { path?: unknown; expanded?: unknown } : null
    const sourcePath = Array.isArray(sourceCascade?.path) ? sourceCascade.path.filter((id): id is string => typeof id === 'string') : []
    const targetPath = Array.isArray(targetCascade?.path) ? targetCascade.path.filter((id): id is string => typeof id === 'string') : []
    const path = target.revision === 1 ? sourcePath : targetPath
    if (!path.length || (sourcePath.length && path.length !== sourcePath.length)
      || (sourcePath.length && path.some((id, index) => id.toLowerCase() !== sourcePath[index]?.toLowerCase()))) continue
    const targetExpanded = targetCascade?.expanded && typeof targetCascade.expanded === 'object' && !Array.isArray(targetCascade.expanded)
      ? targetCascade.expanded as Record<string, unknown> : {}
    const sourceExpanded = sourceCascade?.expanded && typeof sourceCascade.expanded === 'object' && !Array.isArray(sourceCascade.expanded)
      ? sourceCascade.expanded as Record<string, unknown> : {}
    const expanded = { ...sourceExpanded, ...targetExpanded }
    let options = field.options
    for (const optionId of path) {
      const selected = options.find(option => option.id.toLowerCase() === optionId.toLowerCase())
      if (!selected) break
      for (const expandedField of selected.expandedFields ?? []) {
        if (expandedField.type !== 'image') continue
        const expandedId = expandedField.id.toLowerCase()
        const merged = mergeImageList(targetExpanded[expandedId], sourceExpanded[expandedId])
        if (merged.length) expanded[expandedId] = merged
        else delete expanded[expandedId]
      }
      options = selected.children ?? []
    }
    values[fieldId] = { path, expanded }
  }
  const referenced = new Set<string>()
  const collect = (raw: unknown) => {
    if (Array.isArray(raw)) {
      for (const id of raw) if (typeof id === 'string') referenced.add(id.toLowerCase())
    }
    else if (raw && typeof raw === 'object') {
      for (const nested of Object.values(raw as Record<string, unknown>)) collect(nested)
    }
  }
  collect(values)
  const sourceAttachments = source.attachments.filter(attachment => referenced.has(attachment.id.toLowerCase())
    && !excludedIds.has(attachment.id.toLowerCase()))
  return { ...target, values, attachments: [...target.attachments, ...sourceAttachments] }
}

function stripSourceImageAnswers(
  rawValues: Record<string, unknown>,
  definition: PurchaseFormDefinition,
  sourceAttachmentIds: ReadonlySet<string>,
): Record<string, unknown> {
  const values = clonePurchaseRecord(rawValues)
  const strip = (raw: unknown) => Array.isArray(raw)
    ? raw.filter(id => typeof id !== 'string' || !sourceAttachmentIds.has(id.toLowerCase()))
    : raw
  for (const field of definition.fields) {
    const fieldId = field.id.toLowerCase()
    if (field.type === 'image') {
      const kept = strip(values[fieldId])
      if (Array.isArray(kept) && kept.length) values[fieldId] = kept
      else delete values[fieldId]
      continue
    }
    if (field.type !== 'cascade') continue
    const raw = values[fieldId]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const cascade = raw as { path?: unknown; expanded?: unknown }
    if (!Array.isArray(cascade.path) || !cascade.expanded || typeof cascade.expanded !== 'object' || Array.isArray(cascade.expanded)) continue
    const expanded = { ...(cascade.expanded as Record<string, unknown>) }
    let options = field.options
    for (const optionId of cascade.path) {
      if (typeof optionId !== 'string') break
      const selected = options.find(option => option.id.toLowerCase() === optionId.toLowerCase())
      if (!selected) break
      for (const expandedField of selected.expandedFields ?? []) {
        if (expandedField.type !== 'image') continue
        const expandedId = expandedField.id.toLowerCase()
        const kept = strip(expanded[expandedId])
        if (Array.isArray(kept) && kept.length) expanded[expandedId] = kept
        else delete expanded[expandedId]
      }
      options = selected.children ?? []
    }
    values[fieldId] = { ...cascade, expanded }
  }
  return values
}

function isCompleteUsingDisplayedAttachments(values: Record<string, unknown>, attachments: PurchaseDraft['attachments']): boolean {
  const definition = purchaseDefinition.value
  if (!definition) return false
  const ids = new Set(attachments.map(attachment => attachment.id.toLowerCase()))
  const fieldIds = new Map(attachments.map(attachment => [attachment.id.toLowerCase(), attachment.fieldId.toLowerCase()]))
  const result = normalizePurchaseFormAnswers(definition, values, { requireComplete: true, attachmentIds: ids, attachmentFieldIds: fieldIds })
  return result.ok && result.incompleteFieldIds.length === 0
}

function clonePurchaseValues(): Record<string, unknown> {
  // Values are JSON-shaped and nested cascade objects may be Vue proxies even
  // after their root object is unwrapped; JSON cloning removes every proxy.
  return JSON.parse(JSON.stringify(toRaw(purchaseValues.value))) as Record<string, unknown>
}

watch(purchaseValues, () => {
  if (!installingPurchaseDraft && purchaseDraft.value) {
    purchaseDraftDirty.value = true
    purchaseDraftComplete.value = false
    purchaseFormErrors.value = {}
    purchaseFormMessage.value = '有尚未保存的填写内容。'
  }
}, { deep: true })

const selectedVariant = computed<PublicProductVariant | null>(() => {
  const current = product.value
  if (!current) return null
  if (current.optionGroups.length === 0) return current.variants.length === 1 ? current.variants[0]! : null
  if (!current.optionGroups.every(group => selections[group.id])) return null
  return current.variants.find(variant => current.optionGroups.every((group) => {
    const option = variant.options.find(candidate => candidate.groupId === group.id)
    return option?.valueId === selections[group.id]
  })) ?? null
})
watch(() => [route.query.editLineId, route.query.skuId, route.query.lineRevision,
  route.query.expectedDraftRevision, route.query.draftId, route.query.replacementDraftId], () => {
  if (!storefrontInteractive.value) return
  purchaseFormGeneration++
  activePurchaseFormOperation = 0
  purchaseFormBusy.value = false
  purchaseForm.value = null
  purchaseDraft.value = null
  cartReplacementSourceDraft.value = null
  purchaseDraftRecoveries.value = []
  const skuId = selectedVariant.value?.skuId
  if (skuId) void loadPurchaseFormForSku(skuId, purchaseFormGeneration)
}, { flush: 'sync' })
const selectedPurchaseQuote = computed<CheckoutQuoteItem | null>(() =>
  purchaseQuote.value?.items.find(item => item.skuId === selectedVariant.value?.skuId) ?? null,
)
const selectedPurchaseItems = computed(() => {
  const variant = selectedVariant.value
  if (!variant) return []
  if (purchaseForm.value?.required && purchaseDraft.value) return [{
    lineId: immediateLineId.value || purchaseDraft.value.id, skuId: variant.skuId, quantity: quantity.value,
    draftId: purchaseDraft.value.id, draftRevision: purchaseDraft.value.revision,
  }]
  return [{ skuId: variant.skuId, quantity: quantity.value }]
})
const purchaseLoginPath = computed(() => {
  const draftId = selectedPurchaseItems.value[0] && 'draftId' in selectedPurchaseItems.value[0]
    ? selectedPurchaseItems.value[0].draftId : undefined
  const intent = directPurchasePath(shoppingCart.checkoutPath(selectedPurchaseItems.value), draftId)
  return `/login?redirect=${encodeURIComponent(intent)}`
})

function directPurchasePath(path: string, draftId?: string): string {
  if (isCustomer.value || isEditingCartLine.value || !draftId || path === '/cart') return path
  const [pathname, query = ''] = path.split('?', 2)
  const params = new URLSearchParams(query)
  params.set('claimGuestDraft', '1')
  return `${pathname}?${params.toString()}`
}

function optionHasVariant(groupId: string, valueId: string): boolean {
  const current = product.value
  if (!current) return false
  const candidate = { ...selections, [groupId]: valueId }
  const matchesCurrentSelection = current.variants.some(variant => current.optionGroups.every((group) => {
    const requested = candidate[group.id]
    if (!requested) return true
    return variant.options.some(option => option.groupId === group.id && option.valueId === requested)
  }))
  if (matchesCurrentSelection) return true
  // Let customers change an already selected group; dependent selections will be cleared if needed.
  return Boolean(selections[groupId]) && current.variants.some(variant =>
    variant.options.some(option => option.groupId === groupId && option.valueId === valueId),
  )
}

function selectOption(groupId: string, valueId: string): void {
  const current = product.value
  if (!current) return
  const candidate = { ...selections, [groupId]: valueId }
  const completeCombinationExists = current.variants.some(variant => current.optionGroups.every((group) => {
    const requested = candidate[group.id]
    return !requested || variant.options.some(option => option.groupId === group.id && option.valueId === requested)
  }))

  if (!completeCombinationExists) {
    for (const selectedGroupId of Object.keys(selections)) delete selections[selectedGroupId]
  }
  selections[groupId] = valueId
}

function inventoryLabel(inventory: PublicInventorySummary | undefined): string {
  if (!inventory) return '请选择规格'
  if (inventory.mode === 'quantity') return inventory.status === 'in_stock' ? '有货' : '暂时缺货'
  if (inventory.mode === 'resource_pool' || inventory.mode === 'external') return '供货能力尚未就绪'
  if (inventory.mode === 'unlimited') return '数量不限，交付能力尚未开放'
  return '库存尚未配置'
}

async function refreshPurchaseQuote(): Promise<void> {
  const sequence = ++purchaseQuoteSequence
  const variant = selectedVariant.value
  purchaseQuote.value = null
  purchaseQuoteError.value = ''
  // Wait until the SKU's applied form has loaded before quoting. Calling this
  // from the initial mount while the form is still unknown sends a quote on
  // every passive product visit, even when the active form still needs data.
  if (!variant || !import.meta.client || !purchaseForm.value
    || (purchaseForm.value.required && !purchaseDraftComplete.value)) {
    purchaseQuoteBusy.value = false
    return
  }
  purchaseQuoteBusy.value = true
  try {
    const result = await shoppingCart.quote(selectedPurchaseItems.value)
    if (sequence === purchaseQuoteSequence) purchaseQuote.value = result
  } catch (error) {
    if (sequence === purchaseQuoteSequence) {
      purchaseQuoteError.value = error instanceof Error ? error.message : '限购额度暂时无法读取。'
    }
  } finally {
    if (sequence === purchaseQuoteSequence) purchaseQuoteBusy.value = false
  }
}

async function loadPurchaseFormForSku(skuId: string, generation: number): Promise<void> {
  const loadSequence = ++purchaseFormLoadSequence
  const identityVersion = customerApi.identityVersion.value
  const edit = cartEdit.value ? { ...cartEdit.value } : null
  const loadIsCurrent = () => purchasePageIsCurrent(skuId, generation)
    && loadSequence === purchaseFormLoadSequence && identityVersion === customerApi.identityVersion.value
    && (!edit || (cartEdit.value !== null && sameCartEditSource(edit, cartEdit.value)))
  purchaseForm.value = null
  purchaseDraft.value = null
  cartReplacementSourceDraft.value = null
  purchaseValues.value = {}
  purchaseDraftDirty.value = false
  purchaseDraftComplete.value = false
  purchaseFormErrors.value = {}
  purchaseDraftRecoveries.value = []
  purchaseFormMessage.value = ''
  purchaseFormError.value = ''
  purchaseQuote.value = null
  purchaseQuoteError.value = ''
  purchaseFormBusy.value = true
  try {
    const form = await customerApi.request<StorefrontPurchaseForm>(`/api/v1/storefront/skus/${encodeURIComponent(skuId)}/purchase-form`)
    if (!loadIsCurrent()) return
    purchaseForm.value = form
    if (!form.required) return
    const requestedDraftId = edit?.skuId === skuId ? edit.draftId
      : typeof route.query.draftId === 'string' ? route.query.draftId : null
    if (requestedDraftId) {
      try {
        const current = await customerApi.request<PurchaseDraft>(`/api/v1/storefront/purchase-drafts/${encodeURIComponent(requestedDraftId)}?skuId=${encodeURIComponent(skuId)}`)
        if (!loadIsCurrent()) return
        if (current.templateVersionId === form.templateVersionId && !current.templateChanged) {
          if (isCustomer.value && edit?.skuId === skuId) {
            if (edit.draftId !== current.id || edit.expectedDraftRevision !== current.revision) {
              purchaseFormError.value = '购物车来源资料已变化；原购买资料仍保留，请返回购物车重新确认。'
              return
            }
            try {
              const replacement = await customerApi.request<CustomerCartReplacementDraft>(`/api/v1/customer/cart/lines/${encodeURIComponent(edit.lineId)}/purchase-form/replacement-draft`)
              if (!loadIsCurrent()) return
              if (replacement.lineId !== edit.lineId || replacement.skuId !== skuId
                || replacement.sourceDraftId !== edit.draftId || replacement.sourceDraftRevision !== edit.expectedDraftRevision
                || replacement.sourceDraftId !== current.id || replacement.sourceDraftRevision !== current.revision
                || replacement.templateVersionId !== form.templateVersionId) {
                purchaseFormError.value = '购物车编辑草稿已变化；原购买资料仍保留，请返回购物车刷新后继续。'
                return
              }
              const target = await customerApi.request<PurchaseDraft>(`/api/v1/storefront/purchase-drafts/${encodeURIComponent(replacement.replacementDraftId)}?skuId=${encodeURIComponent(skuId)}`)
              if (!loadIsCurrent()) return
              if (target.id !== replacement.replacementDraftId || target.revision < replacement.replacementDraftRevision
                || target.templateVersionId !== form.templateVersionId || target.templateChanged) {
                purchaseFormError.value = '模板版本已变化；原购物车资料仍保留，请返回购物车重新确认。'
                return
              }
              if (!adoptCartEditSource(edit, replacement)) return
              cartReplacementSourceDraft.value = current
              cartEdit.value = { ...cartEdit.value!, replacementDraftId: target.id,
                omittedSourceAttachmentIds: replacement.omittedSourceAttachmentIds }
              installPurchaseDraft(mergeReplacementDraftForDisplay(target, current,
                replacement.omittedSourceAttachmentIds, purchaseDefinition.value!), true)
              purchaseDraftComplete.value = isCompleteUsingDisplayedAttachments(purchaseValues.value, purchaseDraft.value!.attachments)
              purchaseFormMessage.value = '已恢复这行购买资料的未完成编辑；购物车仍保留上次确认的资料。'
              return
            } catch (replacementError) {
              const status = Number((replacementError as { status?: number; statusCode?: number })?.status
                ?? (replacementError as { statusCode?: number })?.statusCode ?? 0)
              if (status !== 404) {
                if (loadIsCurrent()) purchaseFormError.value = replacementError instanceof Error
                  ? replacementError.message : '无法恢复购物车资料编辑。'
                return
              }
            }
          }
          if (isCustomer.value && edit?.skuId === skuId) {
            await shoppingCart.refresh()
            if (!loadIsCurrent()) return
            const row = shoppingCart.cartView.value?.items.find(item => item.lineId === edit.lineId)
            if (!row?.draftId || row.lineRevision === null || row.draftRevision === null || !row.templateVersionId
              || !adoptCartEditSource(edit, { lineId: edit.lineId, skuId: row.skuId, quantity: row.quantity,
                sourceDraftId: row.draftId, sourceDraftRevision: row.draftRevision,
                sourceLineRevision: row.lineRevision, templateVersionId: row.templateVersionId })) {
              purchaseFormError.value = '购物车来源资料已变化；原购买资料仍保留，请返回购物车重新确认。'
              return
            }
            cartEdit.value = { ...cartEdit.value!, replacementDraftId: null, omittedSourceAttachmentIds: [] }
          }
          cartReplacementSourceDraft.value = null
          installPurchaseDraft(current, true)
          const validation = await customerApi.request<{ revision: number; complete: boolean; incompleteFieldIds: string[] }>(`/api/v1/storefront/purchase-drafts/${encodeURIComponent(current.id)}/validate`, {
            method: 'POST', body: { expectedRevision: current.revision },
          })
          if (!loadIsCurrent() || !installedDraftMatches(current.id)) return
          purchaseDraftComplete.value = validation.complete
          if (!validation.complete) setIncompleteErrors(validation.incompleteFieldIds)
          return
        }
        purchaseFormMessage.value = '此草稿属于已更新的模板版本，原资料已保留。请新建当前版本资料后重新确认。'
        if (cartEdit.value?.draftId === requestedDraftId) {
          await createCurrentDraft(form, skuId, generation, true)
        }
        return
      } catch {
        if (!loadIsCurrent()) return
        if (cartEdit.value?.skuId === skuId) {
          if (isCustomer.value && edit) {
            await shoppingCart.refresh()
            if (!loadIsCurrent()) return
            const row = shoppingCart.cartView.value?.items.find(item => item.lineId === edit.lineId)
            if (!row || row.draftId !== edit.draftId || row.draftRevision !== edit.expectedDraftRevision
              || row.templateVersionId !== form.templateVersionId) {
              purchaseFormError.value = '购物车来源资料已变化或暂时无法核对；原购买行仍保留，请返回购物车重新确认。'
              return
            }
          }
          purchaseFormError.value = '原购买资料已过期或无法恢复；购物车仍保留原购买行。请重新填写后确认替换。'
          await createCurrentDraft(form, skuId, generation, true)
        } else purchaseFormError.value = '无法恢复这份草稿。它可能已过期、已删除或不属于当前账号；原购物车购买行未更改。'
        return
      }
    }
    const recoveries = await customerApi.request<PurchaseDraftRecovery[]>(`/api/v1/storefront/skus/${encodeURIComponent(skuId)}/purchase-drafts`)
    if (!loadIsCurrent()) return
    const boundGuestDrafts = new Set(shoppingCart.guestItems.value.flatMap(item => 'draftId' in item && item.draftId ? [item.draftId] : []))
    purchaseDraftRecoveries.value = recoveries.filter(candidate => !boundGuestDrafts.has(candidate.id))
  } catch (error) {
    if (loadIsCurrent()) purchaseFormError.value = error instanceof Error ? error.message : '无法读取当前 SKU 的填写模板。'
  } finally {
    if (loadIsCurrent()) {
      purchaseFormBusy.value = false
      if (purchaseForm.value && (!purchaseForm.value.required || purchaseDraftComplete.value)) {
        void refreshPurchaseQuote()
      }
    }
  }
}

function purchasePageIsCurrent(skuId: string, generation: number): boolean {
  return !purchaseFormDisposed && generation === purchaseFormGeneration
    && selectedVariant.value?.skuId === skuId
}

function installedDraftMatches(id: string, revision?: number): boolean {
  const installed = purchaseDraft.value
  return installed?.id === id && (revision === undefined || installed.revision === revision)
}

function draftUpdatedAtLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function purchaseOperationContext(operationId = activePurchaseFormOperation): PurchaseFormOperationContext | null {
  const draft = purchaseDraft.value
  const skuId = selectedVariant.value?.skuId
  if (!draft || !skuId || !operationId) return null
  return { skuId, draftId: draft.id, draftRevision: draft.revision,
    identityVersion: customerApi.identityVersion.value, generation: purchaseFormGeneration, operationId }
}

function beginPurchaseOperation(): number {
  const operationId = ++purchaseFormOperationSequence
  activePurchaseFormOperation = operationId
  purchaseFormBusy.value = true
  return operationId
}

function purchasePageContextIsCurrent(context: PurchaseFormOperationContext, checkRevision = true): boolean {
  const current = purchaseDraft.value
  return !purchaseFormDisposed && context.generation === purchaseFormGeneration
    && context.operationId === activePurchaseFormOperation
    && context.identityVersion === customerApi.identityVersion.value
    && selectedVariant.value?.skuId === context.skuId
    && current?.id === context.draftId
    && (!checkRevision || current.revision === context.draftRevision)
}

async function createCurrentDraft(form: StorefrontPurchaseForm, skuId: string, generation: number, changed = false): Promise<void> {
  await customerApi.refreshSession()
  if (!purchasePageIsCurrent(skuId, generation)) return
  // Session refresh can establish the page's first authoritative identity and
  // increment identityVersion. Start the draft operation from that resolved
  // identity instead of treating the normal initial session probe as stale.
  const identityVersion = customerApi.identityVersion.value
  if (!customerApi.session.value) await customerApi.request<{ sessionId: string; expiresAt: string }>('/api/v1/guest/session', { method: 'POST' })
  if (!purchasePageIsCurrent(skuId, generation) || identityVersion !== customerApi.identityVersion.value) return
  const created = await customerApi.request<{ id: string; revision: number; expiresAt: string; templateVersionId: string }>('/api/v1/storefront/purchase-drafts', {
    method: 'POST', body: { skuId },
  })
  if (!purchasePageIsCurrent(skuId, generation) || identityVersion !== customerApi.identityVersion.value) return
  const draft = await customerApi.request<PurchaseDraft>(`/api/v1/storefront/purchase-drafts/${encodeURIComponent(created.id)}?skuId=${encodeURIComponent(skuId)}`)
  if (!purchasePageIsCurrent(skuId, generation) || identityVersion !== customerApi.identityVersion.value) return
  installPurchaseDraft(draft, true)
  if (changed) purchaseFormMessage.value = '填写模板已更新。请按当前版本重新填写并确认。'
}

async function startAnotherPurchaseDraft(): Promise<void> {
  const form = purchaseForm.value
  const skuId = selectedVariant.value?.skuId
  if (!form?.required || !skuId || purchaseFormBusy.value || purchaseDraft.value) return
  const generation = purchaseFormGeneration
  purchaseFormBusy.value = true
  purchaseFormError.value = ''
  purchaseFormMessage.value = '正在创建本次购买资料…'
  try {
    await createCurrentDraft(form, skuId, generation)
    if (purchasePageIsCurrent(skuId, generation) && purchaseDraft.value) purchaseFormMessage.value = '已为本次购买准备独立资料。'
  } catch (error) {
    if (purchasePageIsCurrent(skuId, generation)) {
      purchaseFormError.value = error instanceof Error ? error.message : '暂时无法新建购买资料。'
      purchaseFormMessage.value = ''
    }
  } finally {
    if (purchasePageIsCurrent(skuId, generation)) purchaseFormBusy.value = false
  }
}

async function recoverPurchaseDraft(candidate: PurchaseDraftRecovery): Promise<void> {
  const skuId = selectedVariant.value?.skuId
  const form = purchaseForm.value
  if (!skuId || !form?.required || purchaseFormBusy.value || purchaseDraft.value) return
  const generation = purchaseFormGeneration
  const identityVersion = customerApi.identityVersion.value
  purchaseFormBusy.value = true
  purchaseFormError.value = ''
  purchaseFormMessage.value = '正在验证并恢复这份私有草稿…'
  try {
    const draft = await customerApi.request<PurchaseDraft>(`/api/v1/storefront/purchase-drafts/${encodeURIComponent(candidate.id)}?skuId=${encodeURIComponent(skuId)}`)
    if (!purchasePageIsCurrent(skuId, generation) || identityVersion !== customerApi.identityVersion.value) return
    if (draft.templateChanged || draft.templateVersionId !== form.templateVersionId) {
      purchaseFormMessage.value = '此草稿属于旧模板版本，原资料已保留。请新建当前版本资料后重新确认。'
      return
    }
    installPurchaseDraft(draft, true)
    const validation = await customerApi.request<{ revision: number; complete: boolean; incompleteFieldIds: string[] }>(
      `/api/v1/storefront/purchase-drafts/${encodeURIComponent(draft.id)}/validate`,
      { method: 'POST', body: { expectedRevision: draft.revision } },
    )
    if (!purchasePageIsCurrent(skuId, generation) || identityVersion !== customerApi.identityVersion.value
      || !installedDraftMatches(draft.id, draft.revision)) return
    purchaseDraftComplete.value = validation.complete
    if (!validation.complete) setIncompleteErrors(validation.incompleteFieldIds)
    else purchaseFormMessage.value = '已恢复这份已保存资料。'
  } catch (error) {
    if (purchasePageIsCurrent(skuId, generation) && identityVersion === customerApi.identityVersion.value) {
      purchaseFormError.value = error instanceof Error ? error.message : '无法恢复这份草稿。'
      purchaseFormMessage.value = ''
    }
  } finally {
    if (purchasePageIsCurrent(skuId, generation) && identityVersion === customerApi.identityVersion.value) purchaseFormBusy.value = false
  }
}

function setIncompleteErrors(fieldIds: string[]) {
  const labels = new Map<string, string>()
  const visit = (fields: PurchaseFormField[]) => {
    for (const field of fields) {
      labels.set(field.id.toLowerCase(), field.label)
      if (field.type === 'cascade') {
        const walk = (options: typeof field.options) => options.forEach((option) => {
          option.expandedFields?.forEach(expanded => labels.set(expanded.id.toLowerCase(), expanded.label))
          if (option.children) walk(option.children as typeof field.options)
        })
        walk(field.options)
      }
    }
  }
  if (purchaseDefinition.value) visit(purchaseDefinition.value.fields)
  purchaseFormErrors.value = Object.fromEntries(fieldIds.map(fieldId => [fieldId.toLowerCase(), '请填写此项。']))
  const names = fieldIds.map(fieldId => labels.get(fieldId.toLowerCase())).filter((name): name is string => Boolean(name))
  purchaseFormMessage.value = names.length ? `还需填写：${names.join('、')}` : '请完成所有必填项。'
}

async function startCartLineReplacementEdit(): Promise<void> {
  const edit = cartEdit.value ? { ...cartEdit.value } : null
  const source = purchaseDraft.value
  if (!edit || !source || !isCustomer.value || purchaseFormBusy.value || edit.lineRevision === null
    || edit.expectedDraftRevision === null || edit.draftId !== source.id) return
  if (edit.replacementDraftId) return
  const operationId = beginPurchaseOperation()
  const context = purchaseOperationContext(operationId)
  if (!context) { activePurchaseFormOperation = 0; purchaseFormBusy.value = false; return }
  purchaseFormError.value = ''
  purchaseFormMessage.value = '正在为此购物车行准备独立编辑草稿…'
  try {
    const replacement = await customerApi.request<CustomerCartReplacementDraft>(`/api/v1/customer/cart/lines/${encodeURIComponent(edit.lineId)}/purchase-form/replacement-draft`, {
      method: 'POST', body: { expectedLineRevision: edit.lineRevision, expectedDraftRevision: edit.expectedDraftRevision },
    })
    if (!purchasePageContextIsCurrent(context) || replacement.sourceDraftId !== source.id
      || replacement.sourceDraftRevision !== source.revision || replacement.templateVersionId !== purchaseForm.value?.templateVersionId) return
    const target = await customerApi.request<PurchaseDraft>(`/api/v1/storefront/purchase-drafts/${encodeURIComponent(replacement.replacementDraftId)}?skuId=${encodeURIComponent(context.skuId)}`)
    if (!purchasePageContextIsCurrent(context) || target.templateVersionId !== source.templateVersionId || target.templateChanged) return
    const definition = purchaseDefinition.value
    if (!definition) return
    if (!adoptCartEditSource(edit, replacement)) return
    cartReplacementSourceDraft.value = source
    cartEdit.value = { ...cartEdit.value!, replacementDraftId: target.id,
      omittedSourceAttachmentIds: replacement.omittedSourceAttachmentIds }
    const composite = mergeReplacementDraftForDisplay(target, source,
      replacement.omittedSourceAttachmentIds, definition)
    installPurchaseDraft(composite)
    purchaseValues.value = clonePurchaseRecord(composite.values)
    purchaseDraftDirty.value = true
    purchaseDraftComplete.value = isCompleteUsingDisplayedAttachments(purchaseValues.value, composite.attachments)
    purchaseFormMessage.value = '已准备独立编辑草稿。购物车仍使用上次确认的资料；保存可恢复的编辑后，完整校验时才替换购买行。'
  } catch (error) {
    if (purchasePageContextIsCurrent(context, false)) {
      purchaseFormError.value = error instanceof Error ? error.message : '无法开始安全编辑。购物车中的原资料仍保留。'
      purchaseFormMessage.value = ''
    }
  } finally { finishPurchaseOperation(context) }
}

async function cancelCartLineReplacementEdit(): Promise<void> {
  const edit = cartEdit.value ? { ...cartEdit.value } : null
  if (!edit?.replacementDraftId || edit.lineRevision === null || edit.expectedDraftRevision === null
    || !isCustomer.value || purchaseFormBusy.value) return
  const operationId = beginPurchaseOperation()
  const context = purchaseOperationContext(operationId)
  if (!context) { activePurchaseFormOperation = 0; purchaseFormBusy.value = false; return }
  purchaseFormError.value = ''
  try {
    await customerApi.request(`/api/v1/customer/cart/lines/${encodeURIComponent(edit.lineId)}/purchase-form/replacement-draft`, {
      method: 'DELETE', body: { expectedLineRevision: edit.lineRevision,
        expectedDraftRevision: edit.expectedDraftRevision, expectedReplacementDraftRevision: context.draftRevision },
    })
    if (purchasePageContextIsCurrent(context)) await navigateTo('/cart')
  } catch (error) {
    if (purchasePageContextIsCurrent(context)) purchaseFormError.value = error instanceof Error
      ? error.message : '暂时无法撤销编辑；购物车仍保留原购买资料。'
  } finally { finishPurchaseOperation(context) }
}

async function readCurrentDraft(context: PurchaseFormOperationContext): Promise<PurchaseDraft> {
  return customerApi.request<PurchaseDraft>(`/api/v1/storefront/purchase-drafts/${encodeURIComponent(context.draftId)}?skuId=${encodeURIComponent(context.skuId)}`)
}

function finishPurchaseOperation(context: PurchaseFormOperationContext): void {
  if (activePurchaseFormOperation !== context.operationId) return
  activePurchaseFormOperation = 0
  purchaseFormBusy.value = false
}

async function savePurchaseValues(
  allowBusy = false,
  valuesToSave: Record<string, unknown> = purchaseValues.value,
  replacements?: Array<{ oldAttachmentId: string; newAttachmentId: string }>,
  operationContext?: PurchaseFormOperationContext,
): Promise<boolean> {
  if (purchaseFormBusy.value && !allowBusy && !operationContext) return false
  const operationId = operationContext?.operationId ?? beginPurchaseOperation()
  const context = operationContext ?? purchaseOperationContext(operationId)
  if (!context || !purchasePageContextIsCurrent(context)) {
    if (!operationContext && activePurchaseFormOperation === operationId) {
      activePurchaseFormOperation = 0
      purchaseFormBusy.value = false
    }
    return false
  }
  const currentCartEdit = cartEdit.value ? { ...cartEdit.value } : null
  const editing = currentCartEdit?.skuId === context.skuId && currentCartEdit.draftId === context.draftId
  const editingReplacement = currentCartEdit?.skuId === context.skuId
    && currentCartEdit.replacementDraftId === context.draftId && Boolean(cartReplacementSourceDraft.value)
  const submittedValues = JSON.parse(JSON.stringify(toRaw(valuesToSave))) as Record<string, unknown>
  const sourceIds = new Set((cartReplacementSourceDraft.value?.attachments ?? []).map(attachment => attachment.id.toLowerCase()))
  const storedValues = editingReplacement && purchaseDefinition.value
    ? stripSourceImageAnswers(submittedValues, purchaseDefinition.value, sourceIds)
    : submittedValues
  const storedReplacements = editingReplacement
    ? replacements?.filter(replacement => !sourceIds.has(replacement.oldAttachmentId.toLowerCase()))
    : replacements
  if (purchasePageContextIsCurrent(context)) {
    purchaseFormError.value = ''
    purchaseFormMessage.value = '正在保存填写内容…'
  }
  try {
    let saved: { revision: number; complete: boolean; incompleteFieldIds: string[] }
    if (editingReplacement && customerApi.session.value?.customer.id) {
      const edit = currentCartEdit!
      if (edit.lineRevision === null || edit.expectedDraftRevision === null || !edit.replacementDraftId) {
        throw new Error('购物车编辑版本已变化，请返回购物车后重新打开。')
      }
      saved = await customerApi.request<{ replacementDraftRevision: number; complete: boolean; incompleteFieldIds: string[] }>(
        `/api/v1/customer/cart/lines/${encodeURIComponent(edit.lineId)}/purchase-form/replacement-draft`, {
          method: 'PUT', body: {
            expectedLineRevision: edit.lineRevision,
            expectedDraftRevision: edit.expectedDraftRevision,
            expectedReplacementDraftRevision: context.draftRevision,
            values: storedValues,
            omittedSourceAttachmentIds: edit.omittedSourceAttachmentIds,
            ...(storedReplacements?.length ? { replacements: storedReplacements } : {}),
          },
        }).then(result => ({ revision: result.replacementDraftRevision, complete: result.complete,
          incompleteFieldIds: result.incompleteFieldIds }))
    } else if (editing && customerApi.session.value?.customer.id) {
      const line = currentCartEdit!
      if (line.lineRevision === null || line.expectedDraftRevision === null) throw new Error('购物车购买行版本已变化，请返回购物车后重新打开。')
      const retainedLineId = await shoppingCart.editPurchaseFormLine(line.lineId, {
        expectedLineRevision: line.lineRevision,
        expectedDraftRevision: line.expectedDraftRevision,
        draftRevision: context.draftRevision,
        values: submittedValues,
        ...(replacements ? { replacements } : {}),
      })
      if (!retainedLineId) throw new Error(shoppingCart.errorMessage.value ?? '购买行资料暂时无法保存。')
      if (retainedLineId !== line.lineId) {
        if (purchasePageContextIsCurrent(context, false)) {
          purchaseFormMessage.value = '资料已保存，并与另一相同购买行合并。'
          await navigateTo('/cart')
        }
        return true
      }
      if (purchasePageContextIsCurrent(context, false)) {
        const row = shoppingCart.cartView.value?.items.find(item => item.lineId === line.lineId)
        if (row?.lineRevision !== null && row?.lineRevision !== undefined) {
          cartEdit.value = { ...line, sourceVerified: true, quantity: row.quantity, lineRevision: row.lineRevision, expectedDraftRevision: row.draftRevision }
          quantity.value = row.quantity
        }
      }
      saved = { revision: context.draftRevision + 1, complete: true, incompleteFieldIds: [] }
    } else {
      saved = await customerApi.request<{ revision: number; complete: boolean; incompleteFieldIds: string[] }>(`/api/v1/storefront/purchase-drafts/${encodeURIComponent(context.draftId)}`, {
        method: 'PUT', body: { skuId: context.skuId, expectedRevision: context.draftRevision, values: submittedValues,
          ...(replacements ? { replacements } : {}) },
      })
    }
    // The server may have committed while the customer switched SKU, account,
    // or page. Preserve that success but never write its result into the new UI.
    if (!purchasePageContextIsCurrent(context)) return true
    const current = await readCurrentDraft(context)
    if (!purchasePageContextIsCurrent(context)) return true
    const displayed = editingReplacement && cartReplacementSourceDraft.value && purchaseDefinition.value
      ? mergeReplacementDraftForDisplay(current, cartReplacementSourceDraft.value,
        currentCartEdit!.omittedSourceAttachmentIds, purchaseDefinition.value)
      : current
    installPurchaseDraft(displayed)
    const complete = editingReplacement
      ? isCompleteUsingDisplayedAttachments(displayed.values, displayed.attachments)
      : saved.complete
    purchaseDraftComplete.value = complete
    purchaseFormMessage.value = editingReplacement
      ? '已保存独立编辑草稿；购物车仍保留上次确认的资料。'
      : saved.complete ? '已保存，填写资料完整。' : '已保存部分内容；完成必填项后即可购买。'
    if (!complete && !editingReplacement) {
      setIncompleteErrors(saved.incompleteFieldIds)
      purchaseFormMessage.value = `已保存部分内容。${purchaseFormMessage.value}`
    } else if (!complete && editingReplacement) {
      const validation = normalizePurchaseFormAnswers(purchaseDefinition.value!, displayed.values, {
        requireComplete: true,
        attachmentIds: new Set(displayed.attachments.map(attachment => attachment.id.toLowerCase())),
        attachmentFieldIds: new Map(displayed.attachments.map(attachment => [attachment.id.toLowerCase(), attachment.fieldId.toLowerCase()])),
      })
      if (validation.ok) {
        const savedStatus = purchaseFormMessage.value
        setIncompleteErrors(validation.incompleteFieldIds)
        purchaseFormMessage.value = `${savedStatus}${purchaseFormMessage.value ? ` ${purchaseFormMessage.value}` : ''}`
      }
      purchaseFormMessage.value += '请补齐必填项后校验并替换购买行。'
    } else if (editingReplacement) {
      purchaseFormMessage.value += ' 当前资料完整，可校验后替换购买行。'
    }
    return true
  } catch (error) {
    if (!purchasePageContextIsCurrent(context, false)) return false
    purchaseFormError.value = error instanceof Error ? error.message : '填写内容保存失败。'
    purchaseFormMessage.value = ''
    if ((error as { status?: number }).status === 409 || (error as { statusCode?: number }).statusCode === 409) {
      try {
        const current = await readCurrentDraft(context)
        if (purchasePageContextIsCurrent(context, false) && current.id === context.draftId) installPurchaseDraft(current)
      } catch { /* Keep user-entered values visible if the latest draft is unavailable. */ }
      if (purchasePageContextIsCurrent(context, false)) purchaseFormError.value = '资料已在其他标签页变化。已读取最新保存版本，请核对后再编辑。'
    }
    return false
  } finally { if (!operationContext) finishPurchaseOperation(context) }
}

async function validatePurchaseValues(): Promise<boolean> {
  const skuId = selectedVariant.value?.skuId
  const form = purchaseForm.value
  if (!skuId || !form?.required || !purchaseDraft.value || purchaseFormBusy.value) return !form?.required
  const operationId = beginPurchaseOperation()
  const context = purchaseOperationContext(operationId)
  if (!context) { purchaseFormBusy.value = false; return false }
  try {
    const latest = await customerApi.request<StorefrontPurchaseForm>(`/api/v1/storefront/skus/${encodeURIComponent(skuId)}/purchase-form`)
    if (!purchasePageContextIsCurrent(context)) return false
    if (latest.templateVersionId !== form.templateVersionId || latest.status !== form.status) {
      const generation = ++purchaseFormGeneration
      purchaseForm.value = latest
      await createCurrentDraft(latest, skuId, generation, true)
      return false
    }
    if (purchaseDraftDirty.value && !await savePurchaseValues(true, purchaseValues.value, undefined, context)) return false
    const currentContext = purchaseOperationContext(operationId)
    if (!currentContext || !purchasePageContextIsCurrent(currentContext)) return false
    const draft = purchaseDraft.value!
    if (hasCartReplacementDraft.value && cartReplacementSourceDraft.value && purchaseDefinition.value) {
      const attachments = draft.attachments
      const validation = normalizePurchaseFormAnswers(purchaseDefinition.value, purchaseValues.value, {
        requireComplete: true,
        attachmentIds: new Set(attachments.map(attachment => attachment.id.toLowerCase())),
        attachmentFieldIds: new Map(attachments.map(attachment => [attachment.id.toLowerCase(), attachment.fieldId.toLowerCase()])),
      })
      const complete = validation.ok && validation.incompleteFieldIds.length === 0
      purchaseDraftComplete.value = complete
      if (!complete) {
        if (validation.ok) setIncompleteErrors(validation.incompleteFieldIds)
        else purchaseFormError.value = '有字段值或图片已失效，请检查并重新填写。'
        return false
      }
    } else {
      const result = await customerApi.request<{ revision: number; complete: boolean; incompleteFieldIds: string[] }>(`/api/v1/storefront/purchase-drafts/${encodeURIComponent(draft.id)}/validate`, {
        method: 'POST', body: { expectedRevision: currentContext.draftRevision },
      })
      if (!purchasePageContextIsCurrent(currentContext)) return false
      purchaseDraftComplete.value = result.complete
      if (!result.complete) { setIncompleteErrors(result.incompleteFieldIds); return false }
    }
    if (cartEdit.value && !await attachValidatedDraftToCart(draft, currentContext)) return false
    if (!purchasePageContextIsCurrent(currentContext)) return false
    purchaseFormErrors.value = {}
    purchaseFormMessage.value = '填写校验通过。'
    await refreshPurchaseQuote()
    if (!purchasePageContextIsCurrent(currentContext, false)) return false
    return true
  } catch (error) {
    if (purchasePageContextIsCurrent(context, false)) purchaseFormError.value = error instanceof Error ? error.message : '填写校验失败，请检查内容后重试。'
    return false
  } finally { finishPurchaseOperation(context) }
}

async function attachValidatedDraftToCart(draft: PurchaseDraft, context: PurchaseFormOperationContext): Promise<boolean> {
  const edit = cartEdit.value ? { ...cartEdit.value } : null
  if (!edit) return true
  if (isCustomer.value) {
    const current = shoppingCart.cartView.value?.items.find(item => item.lineId === edit.lineId)
    if (current?.draftId === draft.id && current.draftRevision === draft.revision) {
      if (current.lineRevision !== null) {
        cartEdit.value = { ...edit, sourceVerified: true, quantity: current.quantity, lineRevision: current.lineRevision, expectedDraftRevision: current.draftRevision }
        quantity.value = current.quantity
      }
      return true
    }
    if (edit.lineRevision === null) {
      purchaseFormError.value = '购物车购买行已变化，请返回购物车后重新打开填写。'
      return false
    }
    const retainedLineId = await shoppingCart.editPurchaseFormLine(edit.lineId, {
      expectedLineRevision: edit.lineRevision,
      expectedDraftRevision: edit.expectedDraftRevision,
      replacementDraft: { draftId: draft.id, draftRevision: draft.revision },
      ...(edit.replacementDraftId === draft.id ? { values: clonePurchaseRecord(purchaseValues.value) } : {}),
    })
    if (!purchasePageContextIsCurrent(context, false)) return true
    if (!retainedLineId) {
      purchaseFormError.value = shoppingCart.errorMessage.value ?? '填写资料已保存，但购物车购买行没有更新。'
      return false
    }
    if (retainedLineId !== edit.lineId) {
      purchaseFormMessage.value = '资料已更新，并与购物车中的相同购买行合并。'
      await navigateTo('/cart')
      return false
    }
    const row = shoppingCart.cartView.value?.items.find(item => item.lineId === retainedLineId)
    if (row?.lineRevision !== null && row?.lineRevision !== undefined) {
      cartEdit.value = { ...edit, draftId: draft.id, replacementDraftId: null, omittedSourceAttachmentIds: [],
        sourceVerified: true, quantity: row.quantity, lineRevision: row.lineRevision, expectedDraftRevision: row.draftRevision }
      quantity.value = row.quantity
    }
    // Finalizing an isolated cart edit writes the normalized values and copied
    // attachments once more in the same transaction as the line swap. Adopt
    // that authoritative revision before the caller validates or quotes again.
    const committedDraft = await readCurrentDraft(context)
    if (!purchasePageContextIsCurrent(context, false) || committedDraft.id !== context.draftId) return true
    installPurchaseDraft(committedDraft)
    context.draftRevision = committedDraft.revision
    purchaseDraftComplete.value = isCompleteUsingDisplayedAttachments(committedDraft.values, committedDraft.attachments)
    cartReplacementSourceDraft.value = null
    return true
  }
  const retainedLineId = await shoppingCart.replaceGuestPurchaseFormLine(
    edit.lineId, edit.draftId, edit.expectedDraftRevision, draft.id, draft.revision,
  )
  if (!purchasePageContextIsCurrent(context, false)) return true
  if (!retainedLineId) {
    purchaseFormError.value = shoppingCart.errorMessage.value ?? '游客购物车购买行已变化，资料仍保留在当前草稿。'
    return false
  }
  const resolvedLineId = shoppingCart.resolveLineKey(retainedLineId)
  if (resolvedLineId !== edit.lineId) {
    purchaseFormMessage.value = '资料已更新，并与购物车中的相同购买行合并。'
    await navigateTo('/cart')
    return false
  }
  cartEdit.value = { ...edit, draftId: draft.id, expectedDraftRevision: draft.revision }
  return true
}

async function releaseUnreferencedUploadedImage(context: PurchaseFormOperationContext, attachmentId: string): Promise<boolean | null> {
  try {
    const result = await customerApi.request<{ released: boolean }>(
      `/api/v1/storefront/purchase-drafts/${encodeURIComponent(context.draftId)}/attachments/${encodeURIComponent(attachmentId)}/release`,
      { method: 'POST', body: {} },
    )
    return result.released
  } catch { return null }
}

async function reconcileUploadedImage(context: PurchaseFormOperationContext, attachmentId: string): Promise<'referenced' | 'released' | 'unknown'> {
  try {
    // Read the authoritative draft after an uncertain save, then let the API
    // perform the exact attachment-reference check and release under its
    // draft -> attachment lock order. Never infer image references by searching
    // serialized user-entered text for an attachment UUID.
    const actual = await readCurrentDraft(context)
    if (purchasePageContextIsCurrent(context, false)) installPurchaseDraft(actual)
    const released = await releaseUnreferencedUploadedImage(context, attachmentId)
    if (released === null) return 'unknown'
    // The release endpoint's locked reference check is authoritative. A later
    // read failure must not downgrade a confirmed release/reference result.
    try {
      const latest = await readCurrentDraft(context)
      if (purchasePageContextIsCurrent(context, false)) installPurchaseDraft(latest)
    } catch { /* The already-read authoritative draft and release result remain valid. */ }
    return released ? 'released' : 'referenced'
  } catch { return 'unknown' }
}

async function uploadPurchaseImage(fieldId: string, file: File, replaceAttachmentId?: string, cascadeId?: string) {
  if (purchaseFormBusy.value) return
  const operationId = beginPurchaseOperation()
  const context = purchaseOperationContext(operationId)
  if (!context) { finishPurchaseOperation({ operationId } as PurchaseFormOperationContext); return }
  const baseValues = clonePurchaseValues()
  const identityVersion = context.identityVersion
  if (purchasePageContextIsCurrent(context)) {
    purchaseFormError.value = ''
    purchaseFormMessage.value = '正在验证并私密保存图片…'
  }
  let uploadedAttachmentId: string | null = null
  try {
    const body = new FormData()
    body.append('skuId', context.skuId)
    body.append('expectedRevision', String(context.draftRevision))
    body.append('fieldId', fieldId)
    if (replaceAttachmentId) body.append('replaceAttachmentId', replaceAttachmentId)
    body.append('file', file)
    const uploaded = await customerApi.request<{ attachmentId: string }>(`/api/v1/storefront/purchase-drafts/${encodeURIComponent(context.draftId)}/attachments`, { method: 'POST', body })
    uploadedAttachmentId = uploaded.attachmentId
    if (!purchasePageContextIsCurrent(context)) {
      await releaseUnreferencedUploadedImage(context, uploaded.attachmentId)
      return
    }
    const nextValues = baseValues
    const putReference = (previous: unknown) => {
      const ids = Array.isArray(previous) ? previous.filter((entry): entry is string => typeof entry === 'string') : []
      return replaceAttachmentId ? ids.map(id => id === replaceAttachmentId ? uploaded.attachmentId : id) : [...ids, uploaded.attachmentId]
    }
    if (cascadeId) {
      const raw = nextValues[cascadeId.toLowerCase()]
      const cascade = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : { path: [], expanded: {} }
      const expanded = cascade.expanded && typeof cascade.expanded === 'object' && !Array.isArray(cascade.expanded) ? cascade.expanded as Record<string, unknown> : {}
      nextValues[cascadeId.toLowerCase()] = { ...cascade, expanded: { ...expanded, [fieldId.toLowerCase()]: putReference(expanded[fieldId.toLowerCase()]) } }
    } else nextValues[fieldId.toLowerCase()] = putReference(nextValues[fieldId.toLowerCase()])
    const saved = await savePurchaseValues(true, nextValues,
      replaceAttachmentId ? [{ oldAttachmentId: replaceAttachmentId, newAttachmentId: uploaded.attachmentId }] : undefined, context)
    if (!saved) {
      const recovery = await reconcileUploadedImage(context, uploaded.attachmentId)
      if (purchasePageContextIsCurrent(context, false)) {
        purchaseFormError.value = recovery === 'released'
          ? '图片上传成功，但保存遇到版本冲突；原图仍然有效，未引用的新图片已安全释放。请立即重新上传。'
          : recovery === 'referenced'
            ? ''
            : '图片上传成功，但无法确认保存结果；为保护已保存资料，未删除新图片。请刷新确认后重试。'
        purchaseFormMessage.value = recovery === 'referenced' ? '图片及填写资料已保存。' : ''
      }
      return
    }
    if (purchasePageContextIsCurrent(context, false)) {
      purchaseFormError.value = ''
      purchaseFormMessage.value = '图片已保存。'
    }
  } catch (error) {
    let recovery: 'referenced' | 'released' | 'unknown' | null = null
    if (uploadedAttachmentId) recovery = await reconcileUploadedImage(context, uploadedAttachmentId)
    if (purchasePageContextIsCurrent(context, false)) {
      purchaseFormError.value = recovery === 'released'
        ? '图片上传成功，但保存失败；原图仍然有效，未引用的新图片已安全释放。请立即重新上传。'
        : error instanceof Error ? error.message : '图片上传或保存失败；原图片及资料仍然保留。'
      purchaseFormMessage.value = recovery === 'referenced' ? '图片及填写资料已保存。' : ''
    }
  } finally { if (identityVersion === customerApi.identityVersion.value || activePurchaseFormOperation === operationId) finishPurchaseOperation(context) }
}

async function removePurchaseImage(fieldId: string, attachmentId: string, cascadeId?: string) {
  if (purchaseFormBusy.value) return
  const operationId = beginPurchaseOperation()
  const context = purchaseOperationContext(operationId)
  if (!context) { activePurchaseFormOperation = 0; purchaseFormBusy.value = false; return }
  if (hasCartReplacementDraft.value && cartEdit.value) {
    const removed = purchaseDraft.value?.attachments.find(attachment => attachment.id === attachmentId)
    const sourceId = cartReplacementSourceDraft.value?.attachments.some(attachment => attachment.id === attachmentId)
      ? attachmentId : removed?.replacesAttachmentId
    if (sourceId && !cartEdit.value.omittedSourceAttachmentIds.includes(sourceId)) {
      cartEdit.value = { ...cartEdit.value, omittedSourceAttachmentIds: [...cartEdit.value.omittedSourceAttachmentIds, sourceId] }
    }
  }
  const nextValues = clonePurchaseValues()
  const removeId = (previous: unknown) => Array.isArray(previous) ? previous.filter(entry => entry !== attachmentId) : []
  if (cascadeId) {
    const raw = nextValues[cascadeId.toLowerCase()]
    const cascade = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : { path: [], expanded: {} }
    const expanded = cascade.expanded && typeof cascade.expanded === 'object' && !Array.isArray(cascade.expanded) ? cascade.expanded as Record<string, unknown> : {}
    nextValues[cascadeId.toLowerCase()] = { ...cascade, expanded: { ...expanded, [fieldId.toLowerCase()]: removeId(expanded[fieldId.toLowerCase()]) } }
  } else nextValues[fieldId.toLowerCase()] = removeId(nextValues[fieldId.toLowerCase()])
  if (purchasePageContextIsCurrent(context)) purchaseValues.value = nextValues
  try { await savePurchaseValues(true, nextValues, undefined, context) }
  finally { finishPurchaseOperation(context) }
}

watch(() => selectedVariant.value?.skuId, (skuId) => {
  purchaseFormGeneration++
  activePurchaseFormOperation = 0
  purchaseForm.value = null
  purchaseDraft.value = null
  cartReplacementSourceDraft.value = null
  purchaseDraftRecoveries.value = []
  purchaseFormBusy.value = false
  if (skuId && storefrontInteractive.value) void loadPurchaseFormForSku(skuId, purchaseFormGeneration)
  if (storefrontInteractive.value) void refreshPurchaseQuote()
}, { immediate: true, flush: 'sync' })

watch(() => customerApi.identityVersion.value, () => {
  if (storefrontInteractive.value) purchaseFormCacheReset()
})

function purchaseFormCacheReset() {
  purchaseFormGeneration++
  activePurchaseFormOperation = 0
  purchaseFormBusy.value = false
  purchaseForm.value = null
  purchaseDraft.value = null
  cartReplacementSourceDraft.value = null
  purchaseDraftRecoveries.value = []
  const skuId = selectedVariant.value?.skuId
  if (skuId && import.meta.client) void loadPurchaseFormForSku(skuId, purchaseFormGeneration)
}

watch([quantity, () => customerApi.identityVersion.value, purchaseDraftComplete], () => {
  if (import.meta.client) void refreshPurchaseQuote()
})

onMounted(() => {
  purchaseFormDisposed = false
  storefrontInteractive.value = true
  const skuId = selectedVariant.value?.skuId
  if (skuId) void loadPurchaseFormForSku(skuId, purchaseFormGeneration)
  void refreshPurchaseQuote()
})
onBeforeUnmount(() => {
  purchaseFormDisposed = true
  purchaseFormGeneration++
  activePurchaseFormOperation = 0
})

const selectedImageItem = computed(() => product.value?.gallery[selectedImage.value] ?? null)
const pageTitle = computed(() => product.value?.name ?? '商品详情')
const pageDescription = computed(() => product.value?.description || `${product.value?.name ?? '商品'}的商品详情。`)
const primaryCategory = computed(() => product.value?.categories.find(category => category.isPrimary) ?? product.value?.categories[0])
const structuredData = computed(() => {
  const current = product.value
  if (!current) return ''
  const value = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: current.name,
    description: current.description || undefined,
    image: current.gallery.map(image => siteUrl(image.url)),
    category: primaryCategory.value?.path.map(item => item.name).join(' / '),
    additionalProperty: current.attributes.map(attribute => ({
      '@type': 'PropertyValue',
      name: attribute.name,
      value: attribute.value,
    })),
  }
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, character => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' })[character] ?? character)
})

useSeoMeta({
  title: pageTitle,
  description: pageDescription,
  ogTitle: pageTitle,
  ogDescription: pageDescription,
  ogImage: computed(() => selectedImageItem.value ? siteUrl(selectedImageItem.value.url) : undefined),
  ogUrl: computed(() => siteUrl(`/products/${encodeURIComponent(id.value)}`)),
  twitterCard: 'summary_large_image',
  robots: computed(() => product.value ? 'index, follow' : 'noindex, nofollow'),
})
useHead(() => ({
  link: [{ rel: 'canonical', href: siteUrl(`/products/${encodeURIComponent(id.value)}`) }],
  script: structuredData.value ? [{ type: 'application/ld+json', innerHTML: structuredData.value }] : [],
}))

if (import.meta.server && !isValidProductId.value) {
  await navigateTo('/', { redirectCode: 302, replace: true })
}
else if (import.meta.server && notFound.value) {
  await navigateTo('/', { redirectCode: 302, replace: true })
}
else if (import.meta.server && error.value) {
  setPublicPageFailureStatus(error.value)
}

let handledMissingId = ''
watch([id, notFound], async ([currentId, missing]) => {
  if (import.meta.client && missing && currentId !== handledMissingId) {
    handledMissingId = currentId
    await navigateTo('/', { replace: true })
  }
}, { flush: 'post' })

const galleryPath = computed(() => product.value?.gallery ?? [])
const typeLabel = computed(() => product.value ? productTypeLabels[product.value.productType] : '')

async function addSelectedToCart() {
  if (!selectedVariant.value || !shoppingCart.canAddToCart.value || shoppingCart.busy.value) return
  cartFeedback.value = ''
  if (isEditingCartLine.value) {
    if (!await validatePurchaseValues()) return
    await navigateTo('/cart')
    return
  }
  if (purchaseForm.value?.required) {
    if (!await validatePurchaseValues() || !purchaseDraft.value) return
    const draftId = purchaseDraft.value.id
    const retainedLineId = await shoppingCart.addWithDraft(selectedVariant.value.skuId, quantity.value, draftId, purchaseDraft.value.revision)
    if (retainedLineId) {
      purchaseDraft.value = null
      cartReplacementSourceDraft.value = null
      purchaseValues.value = {}
      purchaseDraftDirty.value = false
      purchaseDraftComplete.value = false
      purchaseFormErrors.value = {}
      immediateLineId.value = ''
      purchaseDraftRecoveries.value = purchaseDraftRecoveries.value.filter(candidate => candidate.id !== draftId)
      purchaseFormMessage.value = '已加入购物车。可以新建另一组资料，再购买同款商品。'
      purchaseFormError.value = ''
    }
  } else await shoppingCart.add(selectedVariant.value.skuId, quantity.value)
  cartFeedback.value = shoppingCart.errorMessage.value ?? shoppingCart.noticeMessage.value ?? ''
}

async function buySelectedNow() {
  if (!selectedVariant.value || shoppingCart.busy.value) return
  cartFeedback.value = ''
  if (isEditingCartLine.value) {
    if (!await validatePurchaseValues() || !purchaseDraft.value || !cartEdit.value) return
    await navigateTo(shoppingCart.checkoutPath([{ lineId: cartEdit.value.lineId, skuId: selectedVariant.value.skuId,
      quantity: cartEdit.value.quantity, draftId: purchaseDraft.value.id, draftRevision: purchaseDraft.value.revision }]))
    return
  }
  if (purchaseForm.value?.required) {
    if (!await validatePurchaseValues() || !purchaseDraft.value) return
    const path = shoppingCart.checkoutPath([{ lineId: immediateLineId.value || purchaseDraft.value.id,
      skuId: selectedVariant.value.skuId, quantity: quantity.value, draftId: purchaseDraft.value.id,
      draftRevision: purchaseDraft.value.revision }])
    await navigateTo(directPurchasePath(path, purchaseDraft.value.id))
  } else await navigateTo(shoppingCart.checkoutPath([{ skuId: selectedVariant.value.skuId, quantity: quantity.value }]))
}
</script>

<template>
  <main id="main-content">
    <UContainer class="py-5 sm:py-8">
      <template v-if="product">
        <nav
          aria-label="面包屑"
          class="mb-5 min-w-0 overflow-x-auto text-sm text-muted"
        >
          <ol class="flex min-w-max items-center gap-2">
            <li>
              <NuxtLink
                to="/"
                class="hover:text-primary"
              >
                全部商品
              </NuxtLink>
            </li>
            <li
              v-if="primaryCategory"
              class="flex items-center gap-2"
            >
              <span aria-hidden="true">/</span><NuxtLink
                :to="`/categories/${primaryCategory.id}`"
                class="hover:text-primary"
              >
                {{ primaryCategory.name }}
              </NuxtLink>
            </li>
            <li class="flex items-center gap-2">
              <span aria-hidden="true">/</span><span
                class="max-w-[60vw] truncate text-highlighted"
                aria-current="page"
              >{{ product.name }}</span>
            </li>
          </ol>
        </nav>

        <div class="grid min-w-0 gap-7 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)] lg:gap-10">
          <section
            aria-label="商品图片"
            class="min-w-0"
          >
            <div class="relative aspect-[4/3] overflow-hidden rounded-xl border border-default bg-muted sm:aspect-[5/4]">
              <img
                v-if="selectedImageItem && !imageFailed"
                :src="selectedImageItem.url"
                :alt="selectedImageItem.alt || product.name"
                :width="selectedImageItem.width"
                :height="selectedImageItem.height"
                fetchpriority="high"
                decoding="async"
                class="h-full w-full object-contain"
                @error="imageFailed = true"
              >
              <div
                v-else
                class="flex h-full items-center justify-center text-muted"
                aria-label="暂无可展示图片"
              >
                <UIcon
                  name="i-lucide-image"
                  class="size-12"
                />
              </div>
            </div>
            <div
              v-if="galleryPath.length > 1"
              class="mt-3 flex gap-2 overflow-x-auto pb-1"
              aria-label="选择商品图片"
            >
              <button
                v-for="(image, index) in galleryPath"
                :key="image.url"
                type="button"
                class="size-16 shrink-0 overflow-hidden rounded-lg border bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:size-20"
                :class="selectedImage === index ? 'border-primary ring-2 ring-primary/30' : 'border-default'"
                :aria-label="`查看第 ${index + 1} 张商品图片`"
                :aria-pressed="selectedImage === index"
                @click="selectedImage = index; imageFailed = false"
              >
                <img
                  :src="image.thumbnailUrl"
                  :alt="''"
                  width="80"
                  height="80"
                  loading="lazy"
                  decoding="async"
                  class="h-full w-full object-cover"
                  @error="($event.target as HTMLImageElement).style.visibility = 'hidden'"
                >
              </button>
            </div>
          </section>

          <section class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <UBadge
                color="primary"
                variant="soft"
              >
                {{ typeLabel }}
              </UBadge>
              <UBadge
                v-if="product.selectionStatus === 'none'"
                color="neutral"
                variant="soft"
              >
                暂无可选规格
              </UBadge>
            </div>
            <h1 class="mt-3 break-words text-2xl font-semibold leading-tight text-highlighted sm:text-3xl">
              {{ product.name }}
            </h1>
            <p
              v-if="product.description"
              class="mt-3 whitespace-pre-line break-words text-sm leading-6 text-muted sm:text-base"
            >
              {{ product.description }}
            </p>

            <div class="mt-5 rounded-xl border border-default bg-elevated p-4 sm:p-5">
              <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p class="text-2xl font-semibold tabular-nums text-primary sm:text-3xl">
                  <template v-if="selectedVariant">
                    ¥{{ selectedVariant.salePrice }}
                  </template>
                  <template v-else-if="product.priceRange">
                    ¥{{ product.priceRange.min }}<span
                      v-if="product.priceRange.min !== product.priceRange.max"
                      class="text-base font-medium text-muted"
                    > 起</span>
                  </template>
                  <span
                    v-else
                    class="text-base font-medium text-muted"
                  >暂无可选售价</span>
                </p>
                <del
                  v-if="selectedVariant?.compareAtPrice"
                  class="text-sm tabular-nums text-muted"
                >¥{{ selectedVariant.compareAtPrice }}</del>
              </div>

              <div
                v-if="product.optionGroups.length"
                class="mt-5 space-y-5"
              >
                <fieldset
                  v-for="group in product.optionGroups"
                  :key="group.id"
                  class="min-w-0"
                >
                  <legend class="mb-2 text-sm font-medium text-highlighted">
                    {{ group.name }}
                  </legend>
                  <div class="flex flex-wrap gap-2">
                    <button
                      v-for="value in group.values"
                      :key="value.id"
                      type="button"
                      class="min-h-11 max-w-full rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none"
                      :class="[
                        selections[group.id] === value.id ? 'border-primary bg-primary/10 text-highlighted' : 'border-default bg-default text-highlighted hover:bg-muted',
                        !optionHasVariant(group.id, value.id) ? 'cursor-not-allowed opacity-45' : '',
                      ]"
                      :disabled="!optionHasVariant(group.id, value.id)"
                      :aria-pressed="selections[group.id] === value.id"
                      @click="selectOption(group.id, value.id)"
                    >
                      {{ value.name }}
                    </button>
                  </div>
                </fieldset>
                <p
                  v-if="!selectedVariant"
                  class="text-sm text-muted"
                  aria-live="polite"
                >
                  请选择完整规格以查看对应价格和供货状态。
                </p>
                <UButton
                  v-if="Object.keys(selections).some(groupId => selections[groupId])"
                  color="neutral"
                  variant="link"
                  size="sm"
                  @click="Object.keys(selections).forEach(groupId => delete selections[groupId])"
                >
                  清除规格选择
                </UButton>
              </div>
              <div
                v-else
                class="mt-4 text-sm text-muted"
              >
                {{ selectedVariant ? '当前仅有一种规格。' : '暂无可选规格。' }}
              </div>

              <div class="mt-5 border-t border-default pt-4">
                <p class="text-sm font-medium text-highlighted">
                  供货状态
                </p>
                <p
                  class="mt-1 text-sm text-muted"
                  aria-live="polite"
                >
                  {{ inventoryLabel(selectedVariant?.inventory) }}
                </p>
              </div>
              <div
                v-if="selectedVariant"
                class="mt-4 grid gap-3"
              >
                <UFormField
                  label="购买数量"
                  name="quantity"
                  :hint="isEditingCartLine ? '数量以购物车当前购买行为准' : undefined"
                >
                  <div class="flex w-fit items-center rounded-lg border border-default">
                    <UButton
                      type="button"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-minus"
                      aria-label="减少数量"
                      class="min-h-11 min-w-11 justify-center"
                      :disabled="isEditingCartLine || quantity <= 1 || shoppingCart.busy.value"
                      @click="quantity = Math.max(1, quantity - 1)"
                    />
                    <UInput
                      v-model.number="quantity"
                      type="number"
                      min="1"
                      max="99"
                      inputmode="numeric"
                      aria-label="购买数量"
                      class="w-20 text-center tabular-nums"
                      :disabled="isEditingCartLine || shoppingCart.busy.value"
                      @change="quantity = Math.min(99, Math.max(1, Math.trunc(quantity || 1)))"
                    />
                    <UButton
                      type="button"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-plus"
                      aria-label="增加数量"
                      class="min-h-11 min-w-11 justify-center"
                      :disabled="isEditingCartLine || quantity >= 99 || shoppingCart.busy.value"
                      @click="quantity = Math.min(99, quantity + 1)"
                    />
                  </div>
                </UFormField>
                <section
                  v-if="purchaseForm?.required"
                  class="min-w-0 rounded-xl border border-default bg-muted/20 p-4 sm:p-5"
                  aria-labelledby="purchase-form-title"
                >
                  <div class="mb-4">
                    <h2
                      id="purchase-form-title"
                      class="text-base font-semibold text-highlighted"
                    >
                      {{ purchaseForm.templateName }} · 购买资料
                    </h2>
                    <p class="mt-1 text-xs leading-5 text-muted">
                      这组填写内容对应当前购买行的全部 {{ quantity }} 件商品。请核对后再加入购物车或立即购买。
                    </p>
                  </div>
                  <UAlert
                    v-if="purchaseForm.status === 'paused'"
                    color="warning"
                    variant="soft"
                    class="mb-4"
                    title="此填写商品已暂停新订单"
                    description="已有订单和履约不受影响。请勿继续创建新的购买订单。"
                  />
                  <p
                    v-if="purchaseFormBusy && !purchaseDraft"
                    class="mb-3 text-sm text-muted"
                    role="status"
                    aria-live="polite"
                  >
                    正在读取当前规格的填写规则…
                  </p>
                  <div
                    v-if="purchaseDefinition && purchaseDraft && isEditingCartLine && isCustomer && !hasCartReplacementDraft"
                    class="mb-4 rounded-lg border border-default bg-default p-4"
                  >
                    <p class="text-sm font-medium text-highlighted">安全编辑购物车资料</p>
                    <p class="mt-1 text-sm leading-6 text-muted">
                      先创建这行专属的编辑草稿。编辑过程中购物车仍保留最近一次有效资料；确认完整后才替换购买行。
                    </p>
                    <UButton
                      type="button"
                      color="primary"
                      variant="soft"
                      icon="i-lucide-file-pen-line"
                      class="mt-3 min-h-11 w-full justify-center"
                      :disabled="purchaseFormBusy || cartEdit?.lineRevision === null || cartEdit?.expectedDraftRevision === null"
                      @click="startCartLineReplacementEdit"
                    >
                      开始安全编辑
                    </UButton>
                  </div>
                  <div
                    v-if="purchaseDefinition && !purchaseDraft && !purchaseFormBusy && !isEditingCartLine"
                    class="mb-4 space-y-3 rounded-lg border border-default bg-default p-3 sm:p-4"
                    aria-label="购买资料草稿恢复与创建"
                  >
                    <div v-if="availablePurchaseDraftRecoveries.length" class="space-y-2">
                      <p class="text-sm font-medium text-highlighted">恢复一组已有草稿</p>
                      <p class="text-xs leading-5 text-muted">草稿归属和有效期会由服务器重新核验；不同账号请分别新建资料。</p>
                      <div class="grid gap-2">
                        <UButton
                          v-for="candidate in availablePurchaseDraftRecoveries"
                          :key="candidate.id"
                          type="button"
                          color="neutral"
                          variant="outline"
                          class="min-h-11 justify-start whitespace-normal text-left"
                          :disabled="purchaseFormBusy"
                          @click="recoverPurchaseDraft(candidate)"
                        >
                          {{ candidate.templateChanged ? '旧模板草稿 · ' : '继续填写 · ' }}{{ draftUpdatedAtLabel(candidate.updatedAt) }}
                        </UButton>
                      </div>
                    </div>
                    <UButton
                      type="button"
                      color="primary"
                      variant="soft"
                      icon="i-lucide-file-plus-2"
                      class="min-h-11 w-full justify-center"
                      :disabled="purchaseFormBusy"
                      @click="startAnotherPurchaseDraft"
                    >
                      新建一组购买资料
                    </UButton>
                  </div>
                  <StorefrontPurchaseFormEditor
                    v-if="purchaseDefinition && purchaseDraft && (!isEditingCartLine || !isCustomer || hasCartReplacementDraft)"
                    :key="`${purchaseDraft.id}:${purchaseFormResetKey}`"
                    :definition="purchaseDefinition"
                    :model-value="purchaseValues"
                    :attachments="purchaseDraft.attachments"
                    :errors="purchaseFormErrors"
                    :disabled="purchaseFormBusy"
                    @update:model-value="purchaseValues = $event"
                    @upload="uploadPurchaseImage"
                    @remove="removePurchaseImage"
                  />
                  <div class="mt-4 flex flex-col gap-2 sm:flex-row">
                    <UButton
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-save"
                      class="min-h-11 justify-center"
                      :loading="purchaseFormBusy"
                      :disabled="!purchaseDraft || !purchaseDraftDirty || purchaseFormBusy"
                      @click="savePurchaseValues()"
                    >
                      保存填写内容
                    </UButton>
                    <UButton
                      color="primary"
                      variant="soft"
                      icon="i-lucide-list-checks"
                      class="min-h-11 justify-center"
                      :loading="purchaseFormBusy"
                      :disabled="!purchaseDraft || purchaseFormBusy"
                      @click="validatePurchaseValues"
                    >
                      校验完整性
                    </UButton>
                    <UButton
                      v-if="hasCartReplacementDraft && isCustomer"
                      color="neutral"
                      variant="ghost"
                      class="min-h-11 justify-center"
                      :disabled="purchaseFormBusy"
                      @click="cancelCartLineReplacementEdit"
                    >
                      撤销本次编辑
                    </UButton>
                  </div>
                  <p
                    v-if="purchaseFormMessage"
                    class="mt-3 text-sm text-muted"
                    role="status"
                    aria-live="polite"
                  >
                    {{ purchaseFormMessage }}
                  </p>
                  <p
                    v-if="purchaseFormError"
                    class="mt-2 text-sm text-error"
                    role="alert"
                  >
                    {{ purchaseFormError }}
                  </p>
                </section>
                <p
                  v-else-if="purchaseFormError"
                  class="text-sm text-error"
                  role="alert"
                >
                  {{ purchaseFormError }}
                </p>
                <StorefrontPurchaseLimitNotice
                  :purchase-limits="selectedPurchaseQuote?.purchaseLimits"
                  :product-rules="product.purchaseLimits"
                  :sku-rules="selectedVariant.purchaseLimits"
                  :authenticated="isCustomer"
                />
                <p
                  v-if="purchaseQuoteBusy"
                  class="text-xs text-muted"
                  aria-live="polite"
                >
                  正在读取当前账号的限购额度…
                </p>
                <p
                  v-else-if="purchaseQuoteError"
                  class="text-sm text-warning"
                  role="status"
                >
                  {{ purchaseQuoteError }}
                </p>
                <NuxtLink
                  v-if="selectedPurchaseQuote?.purchaseLimits.requiresLogin || (!isCustomer && (product.purchaseLimits.lifetime || product.purchaseLimits.rolling24Hours || selectedVariant.purchaseLimits.lifetime || selectedVariant.purchaseLimits.rolling24Hours))"
                  :to="purchaseLoginPath"
                  class="inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-2"
                >
                  登录后继续购买
                </NuxtLink>
                <div class="grid gap-2 sm:grid-cols-2">
                  <p
                    v-if="!shoppingCart.canAddToCart.value"
                    class="text-sm text-muted sm:col-span-2"
                    role="status"
                    aria-live="polite"
                  >
                    正在安全确认购物车身份，请稍候再操作。
                  </p>
                  <p
                    v-else-if="!shoppingCart.ready.value && !isCustomer"
                    class="text-sm text-muted sm:col-span-2"
                  >
                    游客商品可先保存到本机购物车；结算前会重新核对报价。
                  </p>
                  <UButton
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-shopping-cart"
                    :loading="shoppingCart.busy.value"
                    :disabled="!selectedVariant || !shoppingCart.canAddToCart.value || quantity < 1 || quantity > 99 || shoppingCart.busy.value || purchaseFormBusy || (purchaseForm?.required && !purchaseDraftComplete)"
                    @click="addSelectedToCart"
                  >
                    {{ isEditingCartLine ? '保存并返回购物车' : '加入购物车' }}
                  </UButton>
                  <UButton
                    color="primary"
                    icon="i-lucide-arrow-right"
                    :disabled="!selectedVariant || !shoppingCart.canAddToCart.value || quantity < 1 || quantity > 99 || shoppingCart.busy.value || purchaseFormBusy || purchaseQuoteBusy || (purchaseForm?.required && !purchaseDraftComplete) || (selectedPurchaseQuote !== null && !selectedPurchaseQuote.canPurchase)"
                    @click="buySelectedNow"
                  >
                    {{ isEditingCartLine ? '更新资料并结算' : '立即购买' }}
                  </UButton>
                </div>
                <p
                  v-if="cartFeedback || shoppingCart.errorMessage.value"
                  class="text-sm text-warning"
                  role="status"
                  aria-live="polite"
                >
                  {{ cartFeedback || shoppingCart.errorMessage.value }}
                  <NuxtLink
                    to="/cart"
                    class="ml-1 font-medium text-primary underline underline-offset-2"
                  >
                    查看购物车
                  </NuxtLink>
                </p>
              </div>
              <UAlert
                color="neutral"
                variant="subtle"
                icon="i-lucide-info"
                title="报价会在提交时重新检查"
                description="商品、库存、填写模板和已配置的履约资格都会在结算事务中再次校验。可用的支付渠道以订单详情页实际显示为准。"
                class="mt-5"
              />
            </div>

            <section
              v-if="product.attributes.length"
              aria-labelledby="product-attributes-title"
              class="mt-6"
            >
              <h2
                id="product-attributes-title"
                class="text-base font-semibold text-highlighted"
              >
                商品信息
              </h2>
              <dl class="mt-3 divide-y divide-default rounded-xl border border-default">
                <div
                  v-for="attribute in product.attributes"
                  :key="`${attribute.name}:${attribute.value}`"
                  class="grid grid-cols-[minmax(5rem,0.7fr)_minmax(0,1.3fr)] gap-3 px-3 py-3 text-sm sm:px-4"
                >
                  <dt class="break-words text-muted">
                    {{ attribute.name }}
                  </dt>
                  <dd class="break-words text-highlighted">
                    {{ attribute.value }}
                  </dd>
                </div>
              </dl>
            </section>

            <section
              v-if="product.categories.length"
              aria-labelledby="product-categories-title"
              class="mt-6"
            >
              <h2
                id="product-categories-title"
                class="text-sm font-medium text-highlighted"
              >
                商品分类
              </h2>
              <div class="mt-2 flex flex-wrap gap-2">
                <NuxtLink
                  v-for="category in product.categories"
                  :key="category.id"
                  :to="`/categories/${category.id}`"
                  class="inline-flex min-h-10 items-center rounded-full border border-default px-3 text-sm text-muted hover:border-primary/40 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
                >
                  {{ category.path.map(item => item.name).join(' / ') }}
                </NuxtLink>
              </div>
            </section>
          </section>
        </div>

        <section
          v-if="product.richContentHtml"
          aria-labelledby="product-description-title"
          class="mt-10 border-t border-default pt-7 sm:mt-12 sm:pt-9"
        >
          <h2
            id="product-description-title"
            class="text-xl font-semibold text-highlighted"
          >
            商品详情
          </h2>
          <!-- eslint-disable vue/no-v-html -- Public HTML comes only from the shared validated D5 JSON converter. -->
          <div
            class="product-rich-content mt-5 min-w-0 max-w-4xl break-words text-base leading-7 text-default"
            v-html="product.richContentHtml"
          />
          <!-- eslint-enable vue/no-v-html -->
        </section>
      </template>

      <div
        v-else-if="status === 'pending'"
        class="grid min-h-[32rem] gap-6 lg:grid-cols-2"
        aria-label="正在加载商品详情"
      >
        <div class="aspect-[4/3] animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        <div class="space-y-4">
          <div class="h-8 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" /><div class="h-24 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        </div>
      </div>
      <UAlert
        v-else-if="error && !notFound"
        color="error"
        variant="subtle"
        title="商品暂时无法加载"
        description="请检查网络后重试。"
        :actions="[{ label: '重试', onClick: () => refresh() }]"
      />
    </UContainer>
  </main>
</template>

<style>
.product-rich-content {
  overflow-wrap: anywhere;
}

.product-rich-content img {
  max-width: 100%;
  height: auto;
  border-radius: 0.75rem;
}

.product-rich-content p,
.product-rich-content ul,
.product-rich-content ol,
.product-rich-content blockquote,
.product-rich-content h2,
.product-rich-content h3 {
  margin-block: 1rem;
}

.product-rich-content ul,
.product-rich-content ol {
  padding-inline-start: 1.5rem;
}

.product-rich-content ul { list-style: disc; }
.product-rich-content ol { list-style: decimal; }
.product-rich-content blockquote {
  border-inline-start: 3px solid var(--ui-primary);
  padding-inline-start: 1rem;
  color: var(--ui-text-muted);
}

.product-rich-content a {
  color: var(--ui-primary);
  text-decoration: underline;
  text-underline-offset: 0.2em;
}
</style>
