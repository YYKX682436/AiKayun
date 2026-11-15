<script setup lang="ts">
import { toRaw } from 'vue'
import {
  normalizePurchaseFormAnswers,
  validatePurchaseFormDefinition,
  type ApiSuccess,
  type CheckoutQuote,
  type CheckoutQuoteItem,
  type CheckoutRequestLineV2,
  type PurchaseDraft,
  type PurchaseFormDefinition,
  type PurchaseFormField,
  type StorefrontPurchaseForm,
  type PublicInventorySummary,
  type PublicProductDetail,
  type PublicProductVariant,
} from '@aikayun/contracts'
import { saveCheckoutSelection } from '~/utils/checkoutSelection'

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
const customerApi = useCustomerApi()
const purchaseQuote = ref<CheckoutQuote | null>(null)
const purchaseQuoteError = ref('')
const purchaseQuoteBusy = ref(false)
let purchaseQuoteSequence = 0
const purchaseForm = ref<StorefrontPurchaseForm | null>(null)
const purchaseDraft = ref<PurchaseDraft | null>(null)
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

const isCustomer = computed(() => Boolean(customerApi.session.value?.customer.id))
const purchaseDefinition = computed<PurchaseFormDefinition | null>(() => {
  const definition = purchaseForm.value?.definition
  if (!definition) return null
  const validated = validatePurchaseFormDefinition(definition)
  return validated.ok ? validated.value : null
})
const availablePurchaseDraftRecoveries = computed(() => purchaseDraftRecoveries.value)

watch(product, (value) => {
  for (const key of Object.keys(selections)) delete selections[key]
  const requestedSkuId = typeof route.query.skuId === 'string' ? route.query.skuId.toLowerCase() : ''
  const requestedVariant = value?.variants.find(variant => variant.skuId.toLowerCase() === requestedSkuId)
  if (requestedVariant) {
    for (const option of requestedVariant.options) selections[option.groupId] = option.valueId
  }
  selectedImage.value = 0
  imageFailed.value = false
  const requestedQuantity = typeof route.query.quantity === 'string' ? Number(route.query.quantity) : 1
  quantity.value = Number.isSafeInteger(requestedQuantity) && requestedQuantity >= 1 && requestedQuantity <= 99 ? requestedQuantity : 1
}, { immediate: true })

watch(() => [route.query.skuId, route.query.draftId], () => {
  if (!storefrontInteractive.value) return
  purchaseFormGeneration++
  activePurchaseFormOperation = 0
  purchaseFormBusy.value = false
  purchaseForm.value = null
  purchaseDraft.value = null
  purchaseDraftRecoveries.value = []
  const skuId = selectedVariant.value?.skuId
  if (skuId) void loadPurchaseFormForSku(skuId, purchaseFormGeneration)
}, { flush: 'sync' })

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
  // proxies received from reactive draft answers.
  return JSON.parse(JSON.stringify(values)) as Record<string, unknown>
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
const selectedPurchaseLine = computed<CheckoutRequestLineV2 | null>(() => {
  const variant = selectedVariant.value
  if (!variant) return null
  if (purchaseForm.value?.required && purchaseDraft.value) {
    return {
      lineId: immediateLineId.value || purchaseDraft.value.id,
      skuId: variant.skuId,
      quantity: quantity.value,
      draftId: purchaseDraft.value.id,
      draftRevision: purchaseDraft.value.revision,
    }
  }
  return {
    lineId: immediateLineId.value || crypto.randomUUID(),
    skuId: variant.skuId,
    quantity: quantity.value,
  }
})

const selectedPurchaseQuote = computed<CheckoutQuoteItem | null>(() =>
  purchaseQuote.value?.items.find(item => item.skuId === selectedVariant.value?.skuId) ?? null,
)

const purchaseLoginPath = computed(() => {
  const line = selectedPurchaseLine.value
  if (!line) return '/login'
  const checkoutPath = saveCheckoutSelection([line])
  const claim = !isCustomer.value && 'draftId' in line && Boolean(line.draftId) ? '&claimGuestDraft=1' : ''
  const checkoutUrl = `${checkoutPath}${claim}`
  return `/login?redirect=${encodeURIComponent(checkoutUrl)}`
})

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

function getSelectedOptionValueName(groupId: string): string | null {
  const valueId = selections[groupId]
  if (!valueId || !product.value) return null
  const group = product.value.optionGroups.find(g => g.id === groupId)
  const val = group?.values.find(v => v.id === valueId)
  return val?.name ?? null
}

const inventoryStatusClass = computed(() => {
  const inv = selectedVariant.value?.inventory
  if (!inv) return 'text-muted'
  if (inv.mode === 'quantity' && inv.status === 'in_stock') return 'text-success'
  if (inv.mode === 'quantity' && inv.status === 'out_of_stock') return 'text-warning'
  return 'text-muted'
})

const inventoryStatusDotClass = computed(() => {
  const inv = selectedVariant.value?.inventory
  if (!inv) return 'bg-muted'
  if (inv.mode === 'quantity' && inv.status === 'in_stock') return 'bg-success'
  if (inv.mode === 'quantity' && inv.status === 'out_of_stock') return 'bg-warning'
  return 'bg-muted'
})

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
  const item = selectedPurchaseLine.value
  if (!item) {
    purchaseQuoteBusy.value = false
    return
  }
  purchaseQuoteBusy.value = true
  try {
    const result = await customerApi.request<CheckoutQuote>('/api/v1/checkout/quote', {
      method: 'POST',
      body: { version: 2, items: [item] },
    })
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
  const loadIsCurrent = () => purchasePageIsCurrent(skuId, generation)
    && loadSequence === purchaseFormLoadSequence && identityVersion === customerApi.identityVersion.value
  purchaseForm.value = null
  purchaseDraft.value = null
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
    const requestedDraftId = typeof route.query.draftId === 'string' ? route.query.draftId : null
    if (requestedDraftId) {
      try {
        const current = await customerApi.request<PurchaseDraft>(`/api/v1/storefront/purchase-drafts/${encodeURIComponent(requestedDraftId)}?skuId=${encodeURIComponent(skuId)}`)
        if (!loadIsCurrent()) return
        if (current.templateVersionId === form.templateVersionId && !current.templateChanged) {
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
        return
      } catch {
        if (!loadIsCurrent()) return
        purchaseFormError.value = '无法恢复这份草稿。它可能已过期、已删除或不属于当前账号。'
        return
      }
    }
    const recoveries = await customerApi.request<PurchaseDraftRecovery[]>(`/api/v1/storefront/skus/${encodeURIComponent(skuId)}/purchase-drafts`)
    if (!loadIsCurrent()) return
    purchaseDraftRecoveries.value = recoveries
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
  const submittedValues = JSON.parse(JSON.stringify(toRaw(valuesToSave))) as Record<string, unknown>
  if (purchasePageContextIsCurrent(context)) {
    purchaseFormError.value = ''
    purchaseFormMessage.value = '正在保存填写内容…'
  }
  try {
    const saved = await customerApi.request<{ revision: number; complete: boolean; incompleteFieldIds: string[] }>(
      `/api/v1/storefront/purchase-drafts/${encodeURIComponent(context.draftId)}`,
      {
        method: 'PUT',
        body: {
          skuId: context.skuId,
          expectedRevision: context.draftRevision,
          values: submittedValues,
          ...(replacements ? { replacements } : {}),
        },
      },
    )
    if (!purchasePageContextIsCurrent(context)) return true
    const current = await readCurrentDraft(context)
    if (!purchasePageContextIsCurrent(context)) return true
    installPurchaseDraft(current)
    purchaseDraftComplete.value = saved.complete
    purchaseFormMessage.value = saved.complete ? '已保存，填写资料完整。' : '已保存部分内容；完成必填项后即可购买。'
    if (!saved.complete) {
      setIncompleteErrors(saved.incompleteFieldIds)
      purchaseFormMessage.value = `已保存部分内容。${purchaseFormMessage.value}`
    } else {
      purchaseFormErrors.value = {}
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
  } finally {
    if (!operationContext) finishPurchaseOperation(context)
  }
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
    const result = await customerApi.request<{ revision: number; complete: boolean; incompleteFieldIds: string[] }>(
      `/api/v1/storefront/purchase-drafts/${encodeURIComponent(draft.id)}/validate`,
      { method: 'POST', body: { expectedRevision: currentContext.draftRevision } },
    )
    if (!purchasePageContextIsCurrent(currentContext)) return false
    purchaseDraftComplete.value = result.complete
    if (!result.complete) {
      setIncompleteErrors(result.incompleteFieldIds)
      return false
    }
    purchaseFormErrors.value = {}
    purchaseFormError.value = ''
    purchaseFormMessage.value = '填写校验通过。'
    await refreshPurchaseQuote()
    if (!purchasePageContextIsCurrent(currentContext, false)) return false
    return true
  } catch (error) {
    if (purchasePageContextIsCurrent(context, false)) purchaseFormError.value = error instanceof Error ? error.message : '填写校验失败，请检查内容后重试。'
    return false
  } finally {
    finishPurchaseOperation(context)
  }
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

async function buySelectedNow() {
  if (!selectedVariant.value || purchaseFormBusy.value) return
  if (purchaseForm.value?.required) {
    if (!await validatePurchaseValues() || !purchaseDraft.value) return
  }
  const line = selectedPurchaseLine.value
  if (!line) return
  const checkoutPath = saveCheckoutSelection([line])
  const claim = !isCustomer.value && 'draftId' in line && Boolean(line.draftId) ? '&claimGuestDraft=1' : ''
  await navigateTo(`${checkoutPath}${claim}`)
}
</script>

<template>
  <main id="main-content">
    <UContainer class="py-5 sm:py-8">
      <template v-if="product">
        <nav
          aria-label="面包屑"
          class="mb-6 min-w-0 overflow-x-auto text-xs sm:text-sm text-muted"
        >
          <ol class="flex min-w-max items-center gap-1.5 sm:gap-2">
            <li>
              <NuxtLink
                to="/"
                class="transition-colors hover:text-primary"
              >
                全部商品
              </NuxtLink>
            </li>
            <li
              v-if="primaryCategory"
              class="flex items-center gap-1.5 sm:gap-2"
            >
              <span
                aria-hidden="true"
                class="text-muted/40"
              >/</span>
              <NuxtLink
                :to="`/categories/${primaryCategory.id}`"
                class="transition-colors hover:text-primary"
              >
                {{ primaryCategory.name }}
              </NuxtLink>
            </li>
            <li class="flex items-center gap-1.5 sm:gap-2">
              <span
                aria-hidden="true"
                class="text-muted/40"
              >/</span>
              <span
                class="max-w-[48vw] truncate font-medium text-highlighted"
                aria-current="page"
              >{{ product.name }}</span>
            </li>
          </ol>
        </nav>

        <div class="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(21rem,0.85fr)] lg:gap-12 xl:gap-14">
          <section
            aria-label="商品图片"
            class="min-w-0 lg:sticky lg:top-20 lg:self-start"
          >
            <div class="relative flex aspect-square sm:aspect-[4/3] lg:aspect-square items-center justify-center overflow-hidden rounded-2xl border border-default/70 bg-elevated/40 p-3 shadow-xs backdrop-blur-xs transition-colors sm:p-5">
              <img
                v-if="selectedImageItem && !imageFailed"
                :src="selectedImageItem.url"
                :alt="selectedImageItem.alt || product.name"
                :width="selectedImageItem.width"
                :height="selectedImageItem.height"
                fetchpriority="high"
                decoding="async"
                class="h-full w-full object-contain transition-transform duration-300 ease-out"
                @error="imageFailed = true"
              >
              <div
                v-else
                class="flex flex-col items-center justify-center gap-2 p-6 text-center text-muted"
                aria-label="暂无可展示图片"
              >
                <UIcon
                  name="i-lucide-package"
                  class="size-12 stroke-[1.2] opacity-40 sm:size-16"
                />
                <span class="text-xs text-muted/60">暂无可展示图片</span>
              </div>
            </div>
            <div
              v-if="galleryPath.length > 1"
              class="mt-3.5 flex gap-2.5 overflow-x-auto pb-1.5 scroll-smooth"
              aria-label="选择商品图片"
            >
              <button
                v-for="(image, index) in galleryPath"
                :key="image.url"
                type="button"
                class="size-16 sm:size-18 shrink-0 overflow-hidden rounded-xl border p-1 transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                :class="selectedImage === index ? 'border-primary ring-2 ring-primary/25 bg-elevated shadow-xs' : 'border-default/60 hover:border-default hover:bg-muted/40 bg-muted/20 opacity-70 hover:opacity-100'"
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
                  class="h-full w-full rounded-lg object-cover"
                  @error="($event.target as HTMLImageElement).style.visibility = 'hidden'"
                >
              </button>
            </div>
          </section>

          <section class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <UBadge
                color="primary"
                variant="subtle"
                size="sm"
                class="rounded-full px-2.5 font-medium"
              >
                {{ typeLabel }}
              </UBadge>
              <UBadge
                v-if="product.selectionStatus === 'none'"
                color="neutral"
                variant="soft"
                size="sm"
                class="rounded-full px-2.5"
              >
                暂无可选规格
              </UBadge>
            </div>
            <h1 class="mt-3.5 break-words text-2xl font-semibold tracking-tight text-highlighted sm:text-3xl lg:text-3.5xl">
              {{ product.name }}
            </h1>
            <p
              v-if="product.description"
              class="mt-3 whitespace-pre-line break-words text-sm leading-relaxed text-muted sm:text-base"
            >
              {{ product.description }}
            </p>

            <div class="mt-6 rounded-2xl border border-default/80 bg-elevated/70 p-5 shadow-xs backdrop-blur-xs sm:p-6">
              <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p class="text-3xl font-semibold tracking-tight tabular-nums text-primary sm:text-4xl">
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
                  class="ml-2 text-base font-normal tabular-nums text-muted"
                >¥{{ selectedVariant.compareAtPrice }}</del>
              </div>

              <div
                v-if="product.optionGroups.length"
                class="mt-6 space-y-5"
              >
                <fieldset
                  v-for="group in product.optionGroups"
                  :key="group.id"
                  class="min-w-0"
                >
                  <legend class="mb-2.5 flex items-center justify-between text-sm font-medium text-highlighted">
                    <span>{{ group.name }}</span>
                    <span
                      v-if="getSelectedOptionValueName(group.id)"
                      class="text-xs font-normal text-muted"
                    >
                      已选：<span class="font-medium text-highlighted">{{ getSelectedOptionValueName(group.id) }}</span>
                    </span>
                  </legend>
                  <div class="flex flex-wrap gap-2 sm:gap-2.5">
                    <button
                      v-for="value in group.values"
                      :key="value.id"
                      type="button"
                      class="min-h-11 max-w-full rounded-xl border px-3.5 py-2 text-sm font-medium transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none"
                      :class="[
                        selections[group.id] === value.id
                          ? 'border-primary bg-primary/10 text-primary ring-1 ring-primary/40 shadow-xs'
                          : optionHasVariant(group.id, value.id)
                            ? 'border-default/80 bg-default text-highlighted hover:border-default hover:bg-muted/50'
                            : 'border-dashed border-default/50 bg-muted/20 text-muted/50 cursor-not-allowed opacity-40 line-through',
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
                  icon="i-lucide-rotate-ccw"
                  class="p-0 text-xs text-muted hover:text-highlighted"
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

              <div class="mt-5 border-t border-default/70 pt-4.5">
                <div class="flex items-center justify-between text-sm">
                  <span class="font-medium text-highlighted">供货状态</span>
                  <span
                    class="inline-flex items-center gap-1.5 font-medium tabular-nums"
                    :class="inventoryStatusClass"
                    aria-live="polite"
                  >
                    <span
                      class="size-2 rounded-full"
                      :class="inventoryStatusDotClass"
                      aria-hidden="true"
                    />
                    {{ inventoryLabel(selectedVariant?.inventory) }}
                  </span>
                </div>
              </div>
              <div
                v-if="selectedVariant"
                class="mt-5 grid gap-4"
              >
                <UFormField
                  label="购买数量"
                  name="quantity"
                >
                  <div class="inline-flex items-center overflow-hidden rounded-xl border border-default/80 bg-default shadow-xs">
                    <UButton
                      type="button"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-minus"
                      aria-label="减少数量"
                      class="min-h-11 min-w-11 justify-center rounded-none text-muted hover:bg-muted/60 hover:text-highlighted"
                      :disabled="quantity <= 1 || purchaseFormBusy || purchaseQuoteBusy"
                      @click="quantity = Math.max(1, quantity - 1)"
                    />
                    <UInput
                      v-model.number="quantity"
                      type="number"
                      min="1"
                      max="99"
                      inputmode="numeric"
                      aria-label="购买数量"
                      class="w-20 border-x border-default/60 text-center font-medium tabular-nums"
                      :disabled="purchaseFormBusy || purchaseQuoteBusy"
                      @change="quantity = Math.min(99, Math.max(1, Math.trunc(quantity || 1)))"
                    />
                    <UButton
                      type="button"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-plus"
                      aria-label="增加数量"
                      class="min-h-11 min-w-11 justify-center rounded-none text-muted hover:bg-muted/60 hover:text-highlighted"
                      :disabled="quantity >= 99 || purchaseFormBusy || purchaseQuoteBusy"
                      @click="quantity = Math.min(99, quantity + 1)"
                    />
                  </div>
                </UFormField>
                <section
                  v-if="purchaseForm?.required"
                  class="min-w-0 rounded-2xl border border-default/80 bg-muted/20 p-4 shadow-xs sm:p-5.5"
                  aria-labelledby="purchase-form-title"
                >
                  <div class="mb-4">
                    <div class="flex items-center gap-2">
                      <UIcon
                        name="i-lucide-clipboard-pen-line"
                        class="size-4.5 shrink-0 text-primary"
                      />
                      <h2
                        id="purchase-form-title"
                        class="text-base font-semibold text-highlighted"
                      >
                        {{ purchaseForm.templateName }} · 购买资料
                      </h2>
                    </div>
                    <p class="mt-1 text-xs leading-5 text-muted">
                      这组填写内容对应当前购买行的全部 {{ quantity }} 件商品。请核对后再立即购买。
                    </p>
                  </div>
                  <UAlert
                    v-if="purchaseForm.status === 'paused'"
                    color="warning"
                    variant="soft"
                    class="mb-4 rounded-xl"
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
                    v-if="purchaseDefinition && !purchaseDraft && !purchaseFormBusy"
                    class="mb-4 space-y-3.5 rounded-xl border border-default/80 bg-default p-3.5 shadow-xs sm:p-4.5"
                    aria-label="购买资料草稿恢复与创建"
                  >
                    <div
                      v-if="availablePurchaseDraftRecoveries.length"
                      class="space-y-2.5"
                    >
                      <p class="text-sm font-medium text-highlighted">
                        恢复一组已有草稿
                      </p>
                      <p class="text-xs leading-5 text-muted">
                        草稿归属和有效期会由服务器重新核验；不同账号请分别新建资料。
                      </p>
                      <div class="grid gap-2">
                        <UButton
                          v-for="candidate in availablePurchaseDraftRecoveries"
                          :key="candidate.id"
                          type="button"
                          color="neutral"
                          variant="outline"
                          icon="i-lucide-history"
                          class="min-h-11 justify-start whitespace-normal rounded-xl text-left"
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
                      class="min-h-11 w-full justify-center rounded-xl font-medium"
                      :disabled="purchaseFormBusy"
                      @click="startAnotherPurchaseDraft"
                    >
                      新建一组购买资料
                    </UButton>
                  </div>
                  <StorefrontPurchaseFormEditor
                    v-if="purchaseDefinition && purchaseDraft"
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
                  <div class="mt-4.5 flex flex-col gap-2.5 sm:flex-row">
                    <UButton
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-save"
                      class="min-h-11 justify-center rounded-xl font-medium"
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
                      class="min-h-11 justify-center rounded-xl font-medium"
                      :loading="purchaseFormBusy"
                      :disabled="!purchaseDraft || purchaseFormBusy"
                      @click="validatePurchaseValues"
                    >
                      校验完整性
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
                    class="mt-2 text-sm font-medium text-error"
                    role="alert"
                  >
                    {{ purchaseFormError }}
                  </p>
                </section>
                <p
                  v-else-if="purchaseFormError"
                  class="text-sm font-medium text-error"
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
                  class="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-4 hover:opacity-85"
                >
                  <UIcon
                    name="i-lucide-log-in"
                    class="size-4"
                  />
                  登录后继续购买
                </NuxtLink>
                <div class="space-y-3">
                  <UButton
                    color="primary"
                    icon="i-lucide-arrow-right"
                    size="lg"
                    class="min-h-12 w-full justify-center rounded-xl font-semibold shadow-xs hover:shadow-sm transition-all text-white"
                    :loading="purchaseFormBusy || purchaseQuoteBusy"
                    :disabled="!selectedVariant || quantity < 1 || quantity > 99 || purchaseFormBusy || purchaseQuoteBusy || (purchaseForm?.required && !purchaseDraftComplete) || (selectedPurchaseQuote !== null && !selectedPurchaseQuote.canPurchase)"
                    @click="buySelectedNow"
                  >
                    立即购买
                  </UButton>
                </div>
              </div>
              <UAlert
                color="neutral"
                variant="subtle"
                icon="i-lucide-info"
                title="报价会在提交时重新检查"
                description="商品、库存、填写模板和已配置的履约资格都会在结算事务中再次校验。可用的支付渠道以订单详情页实际显示为准。"
                class="mt-5.5 rounded-xl border border-default/50 bg-muted/20 text-xs"
              />
            </div>

            <section
              v-if="product.attributes.length"
              aria-labelledby="product-attributes-title"
              class="mt-8"
            >
              <h2
                id="product-attributes-title"
                class="flex items-center gap-2 text-base font-semibold text-highlighted"
              >
                <UIcon
                  name="i-lucide-list"
                  class="size-4 text-muted"
                />
                商品信息
              </h2>
              <dl class="mt-3 divide-y divide-default/70 overflow-hidden rounded-2xl border border-default/70 bg-elevated/50 shadow-xs">
                <div
                  v-for="attribute in product.attributes"
                  :key="`${attribute.name}:${attribute.value}`"
                  class="grid grid-cols-[minmax(5.5rem,0.7fr)_minmax(0,1.3fr)] gap-3 px-4 py-3 text-sm sm:px-5"
                >
                  <dt class="break-words font-medium text-muted">
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
                class="text-sm font-medium text-muted"
              >
                商品分类
              </h2>
              <div class="mt-2.5 flex flex-wrap gap-2">
                <NuxtLink
                  v-for="category in product.categories"
                  :key="category.id"
                  :to="`/categories/${category.id}`"
                  class="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-default/70 bg-muted/30 px-3 text-xs font-medium text-muted transition-colors hover:border-primary/50 hover:bg-muted/70 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <UIcon
                    name="i-lucide-folder"
                    class="size-3 opacity-60"
                  />
                  {{ category.path.map(item => item.name).join(' / ') }}
                </NuxtLink>
              </div>
            </section>
          </section>
        </div>

        <section
          v-if="product.richContentHtml"
          aria-labelledby="product-description-title"
          class="mt-12 border-t border-default/70 pt-8 sm:mt-16 sm:pt-10"
        >
          <div class="mb-5 flex items-center gap-2.5 sm:mb-6">
            <div
              class="size-2 rounded-full bg-primary"
              aria-hidden="true"
            />
            <h2
              id="product-description-title"
              class="text-xl font-semibold tracking-tight text-highlighted sm:text-2xl"
            >
              商品详情
            </h2>
          </div>
          <!-- eslint-disable vue/no-v-html -- Public HTML comes only from the shared validated D5 JSON converter. -->
          <div
            class="product-rich-content min-w-0 max-w-4xl break-words text-base leading-relaxed text-default"
            v-html="product.richContentHtml"
          />
          <!-- eslint-enable vue/no-v-html -->
        </section>
      </template>

      <div
        v-else-if="status === 'pending'"
        class="grid min-h-[32rem] gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)] lg:gap-12"
        aria-label="正在加载商品详情"
      >
        <div class="aspect-square animate-pulse rounded-2xl bg-muted/60 motion-reduce:animate-none sm:aspect-[4/3] lg:aspect-square" />
        <div class="space-y-5">
          <div class="h-6 w-24 animate-pulse rounded-full bg-muted/60 motion-reduce:animate-none" />
          <div class="h-9 w-3/4 animate-pulse rounded-xl bg-muted/60 motion-reduce:animate-none" />
          <div class="h-16 w-full animate-pulse rounded-xl bg-muted/60 motion-reduce:animate-none" />
          <div class="h-64 w-full animate-pulse rounded-2xl bg-muted/40 motion-reduce:animate-none" />
        </div>
      </div>
      <UAlert
        v-else-if="error && !notFound"
        color="error"
        variant="subtle"
        title="商品暂时无法加载"
        description="请检查网络后重试。"
        :actions="[{ label: '重试', onClick: () => refresh() }]"
        class="rounded-2xl"
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
  border-radius: 1rem;
  margin-block: 1.5rem;
  box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.05);
}

.dark .product-rich-content img {
  box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.35);
}

.product-rich-content p,
.product-rich-content ul,
.product-rich-content ol,
.product-rich-content blockquote,
.product-rich-content h2,
.product-rich-content h3 {
  margin-block: 1.25rem;
}

.product-rich-content h2 {
  font-size: 1.35rem;
  font-weight: 600;
  color: var(--ui-text-highlighted);
  margin-top: 2rem;
}

.product-rich-content h3 {
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--ui-text-highlighted);
  margin-top: 1.5rem;
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
  font-style: italic;
  margin-block: 1.25rem;
}

.product-rich-content a {
  color: var(--ui-primary);
  text-decoration: underline;
  text-underline-offset: 0.25em;
  transition: opacity 0.15s ease;
}

.product-rich-content a:hover {
  opacity: 0.8;
}
</style>
