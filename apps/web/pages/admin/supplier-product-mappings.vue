<script setup lang="ts">
import {
  previewSupplierProductMapping,
  type PurchaseFormCascadeOption,
  type PurchaseFormDefinition,
  type PurchaseFormField,
  type PurchaseFormLeafField,
  type PurchaseTemplateVersion,
  type SupplierCatalogPage,
  type SupplierCatalogProduct,
  type SupplierConnection,
  type SupplierMappingCatalogSku,
  type SupplierMappingFieldRule,
  type SupplierMappingPath,
  type SupplierMappingRules,
  type SupplierProductMapping,
  type SupplierProductMappingHistory,
  type SupplierProductMappingIssue,
  type SupplierProductMappingObservation,
  type SupplierProductMappingRefreshObservation,
  type SupplierProductMappingVersion,
  type SupplierPurchaseField,
} from '@aikayun/contracts'
import { useAdminApi } from '~/composables/useAdminApi'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '供应商商品映射 · 管理后台' })
useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

type CatalogResult = { items: SupplierMappingCatalogSku[]; purchaseFormsStatus: 'preparing' | 'active' | 'paused' }
type UpstreamFieldChoice = { path: SupplierMappingPath; key: string; label: string; type: number | null }
type UpstreamOptionChoice = { path: SupplierMappingPath; key: string; label: string; value: string; depth: number }
type UpstreamStructureRow = { key: string; kind: 'field' | 'option'; path: SupplierMappingPath; label: string; detail: string }
type LocalFieldRow = { field: PurchaseFormField | PurchaseFormLeafField; branch: string }
type LocalOptionRow = { option: { id: string; meaningKey: string; label: string }; parentId: string | null; branch: string }
type ApiMappingList = { items: SupplierProductMapping[] }
type RefreshResult = { mapping: SupplierProductMapping; observation: SupplierProductMappingRefreshObservation | null; issues: SupplierProductMappingIssue[]; structureChanged: boolean; configurationChanged: boolean; templateChanged: boolean; identityChanged: boolean }
type EditorObservation = SupplierProductMappingObservation | SupplierProductMappingRefreshObservation

const { request } = useAdminApi()
const localSkus = shallowRef<SupplierMappingCatalogSku[]>([])
const connections = shallowRef<SupplierConnection[]>([])
const mappings = shallowRef<SupplierProductMapping[]>([])
const selectedSkuId = ref('')
const selectedConnectionId = ref('')
const search = ref('')
const catalog = shallowRef<SupplierCatalogPage | null>(null)
const upstreamProduct = shallowRef<SupplierCatalogProduct | null>(null)
const selectedUpstreamSku = ref('')
const observation = shallowRef<EditorObservation | null>(null)
const mapping = shallowRef<SupplierProductMapping | null>(null)
const appliedTemplate = shallowRef<PurchaseTemplateVersion | null>(null)
const rules = shallowRef<SupplierMappingRules>({ version: 1, fields: [] })
const history = shallowRef<SupplierProductMappingHistory | null>(null)
const loading = ref(true)
const reading = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const refreshMessage = ref('')
const listPage = ref(1)
let generation = 0
let skuGeneration = 0

const root = '/api/v1/admin/supplier-product-mappings'
const kayixinConnections = computed(() => connections.value.filter(item => item.providerType === 'kayixin_customer_v3'))
const connectionOptions = computed(() => kayixinConnections.value.map(item => ({
  label: `${item.name} · 配置 v${item.currentVersion.versionNumber}`,
  value: item.id,
})))
const selectedConnection = computed(() => kayixinConnections.value.find(item => item.id === selectedConnectionId.value) ?? null)
const selectedSku = computed(() => localSkus.value.find(item => item.skuId === selectedSkuId.value) ?? null)
const localSkuOptions = computed(() => localSkus.value.map(item => ({
  label: `${item.productName} · ${item.skuCode}${item.mapping ? ` · ${statusLabel(item.mapping.status)}` : ''}`,
  value: item.skuId,
})))
const upstreamItems = computed(() => (catalog.value?.items ?? []).filter(item =>
  !search.value.trim() || item.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())
  || item.upstreamProductId.includes(search.value.trim())))
const upstreamSkuOptions = computed(() => {
  if (!upstreamProduct.value) return []
  if (upstreamProduct.value.skuType === 0) return [{ label: '无规格商品 · 以商品编号对应', value: '__none__' }]
  if (upstreamProduct.value.skuType !== 1 && upstreamProduct.value.skuType !== 2) return []
  return upstreamProduct.value.variants.map(variant => ({
    label: `${variant.combination.map(part => `${part.title}：${part.value}`).join(' / ') || '规格组合不完整'} · SKU ${variant.upstreamSku}`,
    value: variant.upstreamSku,
  }))
})
const selectedUpstreamVariant = computed(() => upstreamProduct.value?.variants.find(item => item.upstreamSku === selectedUpstreamSku.value) ?? null)
const observedFields = computed(() => {
  const currentObservation = observation.value
  const observed = currentObservation && 'structureSnapshot' in currentObservation
    ? currentObservation.structureSnapshot.purchaseFields : null
  return observed ?? mapping.value?.structureSnapshot.purchaseFields ?? null
})
const sourceFieldChoices = computed(() => flattenUpstreamFields(observedFields.value))
const sourceStructureRows = computed(() => flattenUpstreamStructure(observedFields.value))
const localFieldRows = computed(() => flattenLocalFields(currentDefinition.value))
const currentDefinition = computed<PurchaseFormDefinition | null>(() =>
  (appliedTemplate.value?.definition ?? mapping.value?.templateDefinition ?? null) as unknown as PurchaseFormDefinition | null)
const mappingForSelectedSku = computed(() => mappings.value.find(item => item.skuId === selectedSkuId.value) ?? null)
const sourceVersionLabel = computed(() => observation.value
  ? `${observation.value.source.configurationVersionNumber} · ${formatDate(observation.value.observedAt)}`
  : mapping.value ? `${mapping.value.configurationVersionNumber} · ${formatDate(mapping.value.observedAt)}` : '尚未读取')
const canSave = computed(() => Boolean(canEditTarget.value && selectedSku.value?.appliedTemplateVersion && selectedConnection.value && observation.value && rules.value.version === 1 && !saving.value))
const canEditTarget = computed(() => Boolean(selectedSku.value && selectedSku.value.productStatus !== 'archived' && !selectedSku.value.skuRetiredAt))
const preview = computed(() => {
  if (!currentDefinition.value) return null
  return previewSupplierProductMapping({ definition: currentDefinition.value, upstreamFields: observedFields.value, rules: rules.value })
})
const blockingIssues = computed(() => preview.value?.issues.filter(issue => issue.blocking) ?? [])
const fieldTypeLabel = (type: string) => ({ text: '单行文本', digits: '数字字符', textarea: '多行文本', select: '单选', cascade: '级联', image: '图片' }[type] ?? type)
const upstreamTypeLabel = (type: number | null) => ({ 0: '文本（0）', 1: '图片（1）', 13: '数字字符（13）', 14: '单选（14）', 15: '多行文本（15）', 16: '级联（16）' }[type ?? -1] ?? `未知类型（${type ?? '缺失'}）`)
const statusLabel = (status: string) => ({ draft: '草稿', reviewed: '已审核', stale: '需重新审核' }[status] ?? status)
const issueLabel = (code: string) => ({
  UPSTREAM_PURCHASE_FIELDS_MISSING: '上游未返回购买字段结构', UPSTREAM_FIELD_TYPE_UNKNOWN: '上游字段类型未知',
  UPSTREAM_REQUIRED_SEMANTICS_UNKNOWN: '上游必填语义未知', UPSTREAM_FIELD_DUPLICATE_AMBIGUOUS: '上游字段结构重复，无法唯一定位',
  UPSTREAM_FIELD_TITLE_DUPLICATE: '上游存在同名字段，需检查结构定位', UPSTREAM_OPTION_VALUE_DUPLICATE: '上游选项原始 value 重复',
  UPSTREAM_REQUIRED_FIELD_UNMAPPED: '上游必填字段没有来源', LOCAL_FIELD_UNMAPPED: '本地字段尚未对应',
  FIELD_TYPE_INCOMPATIBLE: '本地与上游字段类型不兼容', LOCAL_REQUIREDNESS_TOO_WEAK: '上游必填字段对应到本地非必填字段',
  UPSTREAM_REQUIRED_SOURCE_CONDITIONAL: '上游条件必填分支与本地分支不一致', IMAGE_ENCODING_UNVERIFIED: '图片来源已对应，但数量与编码语义仍未验证',
  LOCAL_OPTION_UNMAPPED: '本地选项尚未对应上游原始 value', UPSTREAM_OPTION_LOCATOR_MISSING: '上游选项路径不存在',
  CASCADE_OPTION_SOURCE_MISMATCH: '级联选项层级不匹配', SELECT_OPTION_SOURCE_MISMATCH: '单选选项不属于所选上游字段',
  UPSTREAM_FIELD_LOCATOR_MISSING: '上游字段路径不存在', UPSTREAM_FIELD_LOCATOR_INVALID: '上游字段路径无效',
  UPSTREAM_FIELD_OPTIONS_UNVERIFIED: '此上游字段带有未验证选项结构', UPSTREAM_BRANCH_SEMANTICS_UNVERIFIED: '上游分支语义未验证',
}[code] ?? code)

function formatDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) }
function pathKey(path: SupplierMappingPath) { return JSON.stringify(path) }
function pathFromKey(key: string): SupplierMappingPath { try { return JSON.parse(key) as SupplierMappingPath } catch { return [] } }
function pathLabel(path: SupplierMappingPath) {
  return path.map(segment => `${({ field: '字段', option: '选项', child: '子选项', expand: '扩展字段' }[segment.kind])} ${segment.index + 1}`).join(' › ')
}
function localFieldRowsFromDefinition(definition: PurchaseFormDefinition | null): LocalFieldRow[] {
  if (!definition) return []
  const rows: LocalFieldRow[] = []
  const visitOption = (option: PurchaseFormCascadeOption, branch: string) => {
    for (const field of option.expandedFields ?? []) rows.push({ field, branch: `${branch} / ${option.label} 的扩展字段` })
    for (const child of option.children ?? []) visitOption(child, `${branch} / ${option.label}`)
  }
  for (const field of definition.fields) {
    rows.push({ field, branch: '' })
    if (field.type === 'cascade') for (const option of field.options) visitOption(option, field.label)
  }
  return rows
}
function flattenLocalFields(definition: PurchaseFormDefinition | null) { return localFieldRowsFromDefinition(definition) }
function localOptions(field: PurchaseFormField | PurchaseFormLeafField): LocalOptionRow[] {
  if (field.type === 'select') return field.options.map(option => ({ option, parentId: null, branch: '' }))
  if (field.type !== 'cascade') return []
  const rows: LocalOptionRow[] = []
  const visit = (options: PurchaseFormCascadeOption[], branch: string, parentId: string | null): void => {
    for (const option of options) {
      rows.push({ option, parentId, branch })
      visit(option.children ?? [], `${branch} / ${option.label}`, option.id)
    }
  }
  visit(field.options, '', null)
  return rows
}
function flattenUpstreamFields(fields: SupplierPurchaseField[] | null): UpstreamFieldChoice[] {
  if (!fields) return []
  const rows: UpstreamFieldChoice[] = []
  const visitFields = (items: SupplierPurchaseField[], prefix: SupplierMappingPath, branch: string) => {
    items.forEach((field, index) => {
      const path = [...prefix, { kind: prefix.length ? 'expand' as const : 'field' as const, index }] as SupplierMappingPath
      const title = field.title?.trim() || '未命名字段'
      rows.push({ path, key: pathKey(path), type: field.type, label: `${pathLabel(path)} · ${title} · ${upstreamTypeLabel(field.type)}` })
      const visitOptions = (options: SupplierPurchaseField['options'], parent: SupplierMappingPath, optionBranch: string) => {
        options.forEach((option, optionIndex) => {
          const optionPath = [...parent, { kind: parent.at(-1)?.kind === 'option' || parent.at(-1)?.kind === 'child' ? 'child' as const : 'option' as const, index: optionIndex }] as SupplierMappingPath
          const label = `${optionBranch} / ${option.name || '未命名选项'} · 原始 value=${JSON.stringify(option.value)} · ${pathLabel(optionPath)}`
          visitFields(option.expand, optionPath, label)
          visitOptions(option.children, optionPath, label)
        })
      }
      if (field.options.length) visitOptions(field.options, path, `${branch}${branch ? ' / ' : ''}${title}`)
    })
  }
  visitFields(fields, [], '')
  return rows
}
function flattenUpstreamStructure(fields: SupplierPurchaseField[] | null): UpstreamStructureRow[] {
  if (!fields) return []
  const rows: UpstreamStructureRow[] = []
  const visitFields = (items: SupplierPurchaseField[], prefix: SupplierMappingPath) => {
    items.forEach((field, index) => {
      const path = [...prefix, { kind: prefix.length ? 'expand' as const : 'field' as const, index }] as SupplierMappingPath
      const title = field.title?.trim() || '未命名字段'
      rows.push({ key: `${pathKey(path)}:field`, kind: 'field', path,
        label: `${pathLabel(path)} · ${title} · ${upstreamTypeLabel(field.type)}`,
        detail: `required=${JSON.stringify(field.required)}${field.regex ? ' · 含未执行的上游 regex' : ''}` })
      const visitOptions = (options: SupplierPurchaseField['options'], parent: SupplierMappingPath, branch: string) => {
        options.forEach((option, optionIndex) => {
          const kind = parent.at(-1)?.kind === 'option' || parent.at(-1)?.kind === 'child' ? 'child' as const : 'option' as const
          const optionPath = [...parent, { kind, index: optionIndex }] as SupplierMappingPath
          rows.push({ key: `${pathKey(optionPath)}:option`, kind: 'option', path: optionPath,
            label: `${branch ? `${branch} / ` : ''}${option.name || '未命名选项'} · 原始 value=${JSON.stringify(option.value)}`,
            detail: `${pathLabel(optionPath)} · 子选项 ${option.children.length} · 扩展字段 ${option.expand.length}` })
          visitFields(option.expand, optionPath)
          visitOptions(option.children, optionPath, `${branch ? `${branch} / ` : ''}${option.name || '未命名选项'}`)
        })
      }
      visitOptions(field.options, path, title)
    })
  }
  visitFields(fields, [])
  return rows
}
function upstreamOptionChoices(fieldPath: SupplierMappingPath, cascading: boolean): UpstreamOptionChoice[] {
  const source = observedFields.value
  if (!source) return []
  const field = resolveFieldAtPath(source, fieldPath)
  if (!field) return []
  const rows: UpstreamOptionChoice[] = []
  const visit = (options: SupplierPurchaseField['options'], parent: SupplierMappingPath, branch: string, depth: number) => {
    options.forEach((option, index) => {
      const kind = parent.at(-1)?.kind === 'option' || parent.at(-1)?.kind === 'child' ? 'child' as const : 'option' as const
      const path = [...parent, { kind, index }] as SupplierMappingPath
      rows.push({ path, key: pathKey(path), value: option.value, depth,
        label: `${branch ? `${branch} › ` : ''}${option.name || '未命名选项'} · value=${JSON.stringify(option.value)} · ${pathLabel(path)}` })
      if (cascading) visit(option.children, path, option.name, depth + 1)
    })
  }
  visit(field.options, fieldPath, '', 0)
  return rows
}
function resolveFieldAtPath(fields: SupplierPurchaseField[], path: SupplierMappingPath): SupplierPurchaseField | null {
  let current = fields
  let field: SupplierPurchaseField | null = null
  let options: SupplierPurchaseField['options'] | null = null
  for (const segment of path) {
    if (segment.kind === 'field' || segment.kind === 'expand') {
      field = current[segment.index] ?? null
      if (!field) return null
      options = field.options
    } else if (segment.kind === 'option' || segment.kind === 'child') {
      const option = options?.[segment.index] as SupplierPurchaseField['options'][number] | undefined
      if (!option) return null
      current = option.expand
      options = option.children
    }
  }
  return field
}
function blankRules(definition: PurchaseFormDefinition | null): SupplierMappingRules {
  return { version: 1, fields: flattenLocalFields(definition).map(({ field }) => ({
    localFieldId: field.id, localMeaningKey: field.meaningKey, upstreamPath: [],
    options: localOptions(field).map(({ option }) => ({ localOptionId: option.id, localMeaningKey: option.meaningKey, upstreamPath: [] })),
  })) }
}
function findRule(fieldId: string): SupplierMappingFieldRule | undefined { return rules.value.fields.find(rule => rule.localFieldId.toLowerCase() === fieldId.toLowerCase()) }
function updateFieldPath(fieldId: string, key: string) {
  const path = key ? pathFromKey(key) : []
  rules.value = { ...rules.value, fields: rules.value.fields.map(rule => rule.localFieldId.toLowerCase() === fieldId.toLowerCase() ? { ...rule, upstreamPath: path } : rule) }
}
function updateOptionPath(fieldId: string, optionId: string, key: string) {
  const path = key ? pathFromKey(key) : []
  rules.value = { ...rules.value, fields: rules.value.fields.map(rule => rule.localFieldId.toLowerCase() === fieldId.toLowerCase()
    ? { ...rule, options: rule.options.map(option => option.localOptionId.toLowerCase() === optionId.toLowerCase() ? { ...option, upstreamPath: path } : option) } : rule) }
}
function setRulesForSelection() {
  const definition = currentDefinition.value
  const matching = mappingForSelectedSku.value
  mapping.value = matching ?? null
  rules.value = matching && matching.templateVersion.id === selectedSku.value?.appliedTemplateVersion?.id
    ? structuredClone(matching.rules)
    : blankRules(definition)
  observation.value = null
  upstreamProduct.value = null
  selectedUpstreamSku.value = ''
  refreshMessage.value = ''
  history.value = null
}

async function loadPage(options: { preserveSource?: boolean } = {}) {
  const current = ++generation
  const priorObservation = options.preserveSource ? observation.value : null
  const priorProduct = options.preserveSource ? upstreamProduct.value : null
  const priorSelectedSku = options.preserveSource ? selectedUpstreamSku.value : ''
  loading.value = true
  errorMessage.value = ''
  try {
    const [catalogResult, connectionResult, mappingResult] = await Promise.all([
      request<CatalogResult>(`${root}/catalog`),
      request<SupplierConnection[]>('/api/v1/admin/supplier-connections'),
      request<ApiMappingList>(root),
    ])
    if (current !== generation) return
    localSkus.value = catalogResult.items
    connections.value = connectionResult
    mappings.value = mappingResult.items
    if (!localSkus.value.some(item => item.skuId === selectedSkuId.value)) selectedSkuId.value = localSkus.value[0]?.skuId ?? ''
    if (!kayixinConnections.value.some(item => item.id === selectedConnectionId.value)) selectedConnectionId.value = kayixinConnections.value[0]?.id ?? ''
    mapping.value = mappingForSelectedSku.value
    await loadAppliedTemplate(current)
    if (options.preserveSource && current === generation) {
      observation.value = priorObservation
      upstreamProduct.value = priorProduct
      selectedUpstreamSku.value = priorSelectedSku
    }
  } catch (error) {
    if (current === generation) errorMessage.value = error instanceof Error ? error.message : '映射配置加载失败。'
  } finally { if (current === generation) loading.value = false }
}
async function loadAppliedTemplate(expectedGeneration = generation) {
  const sku = localSkus.value.find(item => item.skuId === selectedSkuId.value)
  const ref = sku?.appliedTemplateVersion
  const requestNumber = ++skuGeneration
  appliedTemplate.value = null
  if (!ref) {
    setRulesForSelection()
    return
  }
  try {
    const detail = await request<PurchaseTemplateVersion>(`/api/v1/admin/purchase-form-templates/${ref.templateId}/versions/${ref.id}`)
    if (expectedGeneration !== generation || requestNumber !== skuGeneration || selectedSkuId.value !== sku?.skuId) return
    appliedTemplate.value = detail
    setRulesForSelection()
  } catch (error) {
    if (expectedGeneration === generation && requestNumber === skuGeneration) {
      errorMessage.value = error instanceof Error ? error.message : '本地冻结模板版本读取失败。'
      setRulesForSelection()
    }
  }
}
async function readGoods() {
  if (!selectedConnection.value || reading.value) return
  const current = ++generation
  reading.value = true; errorMessage.value = ''; successMessage.value = ''; catalog.value = null; upstreamProduct.value = null; observation.value = null
  try {
    catalog.value = await request<SupplierCatalogPage>(`/api/v1/admin/supplier-connections/${selectedConnectionId.value}/catalog/goods`, {
      method: 'POST', body: { page: listPage.value, keyWord: search.value.trim() },
    })
    if (current !== generation) return
  } catch (error) { if (current === generation) errorMessage.value = error instanceof Error ? error.message : '上游商品读取失败。' }
  finally { if (current === generation) reading.value = false }
}
async function readDetail(goodsId: string) {
  if (!selectedConnection.value || reading.value) return
  const current = ++generation
  reading.value = true; errorMessage.value = ''; observation.value = null
  try {
    const detail = await request<SupplierCatalogProduct>(`/api/v1/admin/supplier-connections/${selectedConnectionId.value}/catalog/goods/${goodsId}`, { method: 'POST' })
    if (current !== generation) return
    upstreamProduct.value = detail
    selectedUpstreamSku.value = detail.skuType === 0 ? '__none__' : detail.variants[0]?.upstreamSku ?? ''
  } catch (error) { if (current === generation) errorMessage.value = error instanceof Error ? error.message : '上游商品详情读取失败。' }
  finally { if (current === generation) reading.value = false }
}
async function observeSelectedSku() {
  const product = upstreamProduct.value
  if (!product || !selectedConnection.value || reading.value) return
  const skuType = product.skuType
  if (skuType !== 0 && skuType !== 1 && skuType !== 2) { errorMessage.value = '上游规格类型未知，不能建立商品身份对应。'; return }
  const code = skuType === 0 ? null : selectedUpstreamSku.value
  if (skuType !== 0 && !code) { errorMessage.value = '请明确选择上游 SKU 编码和规格组合。'; return }
  const current = ++generation
  reading.value = true; errorMessage.value = ''; observation.value = null
  try {
    const result = await request<SupplierProductMappingObservation>(`${root}/observe`, { method: 'POST', body: {
      connectionId: selectedConnection.value.id, expectedConfigurationVersionId: selectedConnection.value.currentVersion.id,
      upstreamProductId: product.upstreamProductId, upstreamSkuType: skuType, upstreamSkuCode: code,
    } })
    if (current === generation) { observation.value = result; successMessage.value = '已保存带有效期的服务端只读结构观察；审核时会重新读取并校验。' }
  } catch (error) { if (current === generation) errorMessage.value = error instanceof Error ? error.message : '上游商品结构观察失败。' }
  finally { if (current === generation) reading.value = false }
}
async function saveDraft() {
  const sku = selectedSku.value
  const observed = observation.value
  if (!sku?.appliedTemplateVersion || !selectedConnection.value || !observed || saving.value) return
  saving.value = true; errorMessage.value = ''; successMessage.value = ''
  try {
    const body = { productId: sku.productId, skuId: sku.skuId, observationId: observed.id,
      templateVersionId: sku.appliedTemplateVersion.id, rules: structuredClone(rules.value) }
    const saved = mapping.value
      ? await request<SupplierProductMapping>(`${root}/${mapping.value.id}`, { method: 'PUT', body: { ...body, expectedRevision: mapping.value.revision } })
      : await request<SupplierProductMapping>(root, { method: 'POST', body })
    mapping.value = saved
    successMessage.value = '草稿已保存。草稿校验结果不等于审核通过或采购资格。'
    await loadPage({ preserveSource: true })
    mapping.value = mappings.value.find(item => item.id === saved.id) ?? saved
    rules.value = structuredClone(saved.rules)
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : '草稿保存失败。请刷新后检查修订号。' }
  finally { saving.value = false }
}
async function refreshStructure() {
  const currentMapping = mapping.value
  if (!currentMapping || saving.value) return
  saving.value = true; errorMessage.value = ''; successMessage.value = ''; refreshMessage.value = ''
  try {
    const result = await request<RefreshResult>(`${root}/${currentMapping.id}/refresh`, { method: 'POST', body: { expectedRevision: currentMapping.revision } })
    mapping.value = result.mapping
    observation.value = result.observation
    refreshMessage.value = [result.structureChanged ? '上游字段或规格结构变化' : '', result.configurationChanged ? '供应商配置版本变化' : '', result.templateChanged ? '本地应用模板版本变化' : '', result.identityChanged ? '上游商品/SKU 身份变化' : ''].filter(Boolean).join('；') || '结构指纹未变化。观察时间、报价、余额和库存不会改变字段结构身份。'
    successMessage.value = '已重新读取当前上游详情并更新结构检查。'
    await loadPage({ preserveSource: true })
    mapping.value = mappings.value.find(item => item.id === result.mapping.id) ?? result.mapping
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : '上游结构刷新失败。' }
  finally { saving.value = false }
}
async function reviewMapping() {
  if (!mapping.value || saving.value || blockingIssues.value.length) return
  saving.value = true; errorMessage.value = ''; successMessage.value = ''
  try {
    const result = await request<{ reviewed: boolean; mapping: SupplierProductMapping; issues: SupplierProductMappingIssue[] }>(`${root}/${mapping.value.id}/review`, {
      method: 'POST', body: { expectedRevision: mapping.value.revision },
    })
    mapping.value = result.mapping
    if (result.reviewed) successMessage.value = '结构映射审核版本已追加并冻结。此状态不代表自动采购资格。'
    else errorMessage.value = result.issues.map(issue => issueLabel(issue.code)).join('；') || '审核未通过，请检查校验结果。'
    await loadPage()
    mapping.value = mappings.value.find(item => item.id === result.mapping.id) ?? result.mapping
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : '审核请求失败。请重新读取当前版本。' }
  finally { saving.value = false }
}
async function loadHistory() {
  if (!mapping.value) return
  try { history.value = await request<SupplierProductMappingHistory>(`${root}/${mapping.value.id}/history?page=1&pageSize=50`) }
  catch (error) { errorMessage.value = error instanceof Error ? error.message : '映射历史加载失败。' }
}
async function restoreVersion(version: SupplierProductMappingVersion) {
  if (!mapping.value || saving.value) return
  saving.value = true; errorMessage.value = ''; successMessage.value = ''
  try {
    const restored = await request<SupplierProductMapping>(`${root}/${mapping.value.id}/restore`, {
      method: 'POST', body: { expectedRevision: mapping.value.revision, versionId: version.id },
    })
    mapping.value = restored; rules.value = structuredClone(restored.rules)
    successMessage.value = `历史审核版本 v${version.versionNumber} 已恢复为新草稿。`
    await loadPage()
    mapping.value = mappings.value.find(item => item.id === restored.id) ?? restored
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : '恢复草稿失败。请刷新后检查修订号。' }
  finally { saving.value = false }
}
watch(selectedSkuId, () => {
  if (loading.value) return
  generation++; reading.value = false; observation.value = null; upstreamProduct.value = null; selectedUpstreamSku.value = ''
  void loadAppliedTemplate()
})
watch(selectedConnectionId, () => {
  if (loading.value) return
  generation++; reading.value = false; catalog.value = null; upstreamProduct.value = null; observation.value = null
})
watch([selectedSkuId, mappings], () => {
  mapping.value = mappingForSelectedSku.value
  if (appliedTemplate.value) setRulesForSelection()
})
onMounted(() => { void loadPage() })
onBeforeUnmount(() => { generation++; skuGeneration++ })
</script>

<template>
  <UDashboardPanel id="admin-supplier-product-mappings">
    <template #header>
      <UDashboardNavbar
        title="供应商商品映射"
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
        class="mx-auto w-full max-w-7xl min-w-0 p-4 focus:outline-none sm:p-6 lg:p-8"
      >
        <header class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div class="min-w-0">
            <p class="text-sm font-medium text-primary">
              商品经营 / 准备配置
            </p>
            <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
              供应商商品与购买字段映射
            </h1>
            <p class="mt-2 max-w-3xl text-sm leading-6 text-muted">
              按本地商品、SKU 与冻结购买模板版本，绑定卡易信 V3 上游商品、SKU 和字段结构。此处只做准备、校验和审核，不会采购。
            </p>
          </div>
          <UBadge
            color="neutral"
            variant="soft"
            class="min-h-8 self-start px-3 text-sm lg:self-auto"
          >
            采购资格：未开放
          </UBadge>
        </header>

        <UAlert
          class="mt-5"
          color="info"
          variant="soft"
          title="只读准备边界"
          description="只调用卡易信现有商品列表和详情读取接口。预览仅使用合成值；不会创建购买请求、上传图片、计算扣费或读取顾客订单填写资料。"
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
          v-if="refreshMessage"
          class="mt-4"
          color="warning"
          variant="soft"
          title="重新读取结果"
          :description="refreshMessage"
        />

        <div
          v-if="loading"
          class="mt-6 grid gap-3"
          aria-live="polite"
        >
          <USkeleton class="h-32 rounded-xl" /><USkeleton class="h-56 rounded-xl" />
        </div>
        <div
          v-else
          class="mt-6 grid min-w-0 gap-5"
        >
          <section
            aria-label="映射目标选择"
            class="grid min-w-0 gap-4 rounded-xl border border-default bg-elevated p-4 sm:p-5 lg:grid-cols-3"
          >
            <UFormField
              label="本地商品与 SKU"
              hint="已退役 SKU 只保留历史，不接受新映射编辑。"
            >
              <USelect
                v-model="selectedSkuId"
                :items="localSkuOptions"
                class="w-full"
                :disabled="!localSkuOptions.length"
              />
            </UFormField>
            <UFormField
              label="卡易信只读连接"
              hint="仅显示已保存的 Kayixin V3 连接；连接名称不用于商品身份匹配。"
            >
              <USelect
                v-model="selectedConnectionId"
                :items="connectionOptions"
                class="w-full"
                :disabled="!connectionOptions.length"
                placeholder="选择只读连接"
              />
            </UFormField>
            <div class="min-w-0 rounded-lg bg-default p-3 text-sm">
              <p class="font-medium text-highlighted">
                本地已应用冻结模板
              </p>
              <p
                v-if="selectedSku?.appliedTemplateVersion"
                class="mt-1 break-words"
              >
                {{ selectedSku.appliedTemplateVersion.name }} · v{{ selectedSku.appliedTemplateVersion.versionNumber }}
              </p>
              <p
                v-else
                class="mt-1 text-warning"
              >
                此 SKU 当前没有已应用的冻结模板。
              </p>
              <p
                v-if="selectedSku?.appliedTemplateVersion"
                class="mt-1 break-all text-xs text-dimmed"
              >
                模板版本 {{ selectedSku.appliedTemplateVersion.id }} · 规范化 v{{ selectedSku.appliedTemplateVersion.normalizationVersion }}
              </p>
            </div>
          </section>

          <div class="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <section
              aria-labelledby="upstream-read-title"
              class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2
                    id="upstream-read-title"
                    class="font-semibold text-highlighted"
                  >
                    读取上游商品
                  </h2><p class="mt-1 text-sm leading-5 text-muted">
                    只读列表和详情来自现有卡易信 V3 接口。
                  </p>
                </div>
                <UButton
                  icon="i-lucide-refresh-cw"
                  :loading="reading"
                  :disabled="!selectedConnection"
                  @click="readGoods"
                >
                  读取商品列表
                </UButton>
              </div>
              <div class="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <UInput
                  v-model="search"
                  aria-label="搜索上游商品名称或编号"
                  placeholder="商品名称或编号"
                  maxlength="120"
                />
                <UButton
                  color="neutral"
                  variant="outline"
                  :disabled="reading || !catalog || listPage <= 1"
                  @click="listPage--; readGoods()"
                >
                  上一页
                </UButton>
              </div>
              <p
                v-if="catalog"
                class="mt-2 text-xs text-muted"
              >
                配置 v{{ catalog.source.configurationVersionNumber }} · {{ formatDate(catalog.source.readAt) }} · 第 {{ catalog.requestedPage }} 页
              </p>
              <ul
                v-if="catalog"
                class="mt-3 max-h-72 space-y-2 overflow-auto"
                aria-label="可选上游商品"
              >
                <li
                  v-for="item in upstreamItems"
                  :key="item.upstreamProductId"
                >
                  <button
                    type="button"
                    class="flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-default bg-default p-3 text-left transition-colors hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-primary"
                    :disabled="reading"
                    @click="readDetail(item.upstreamProductId)"
                  >
                    <span class="min-w-0"><span class="block break-words font-medium text-highlighted">{{ item.name }}</span><span class="mt-1 block text-xs text-muted">编号 {{ item.upstreamProductId }} · skuType {{ item.skuType ?? '未知' }}</span></span>
                    <UIcon
                      name="i-lucide-chevron-right"
                      class="size-4 shrink-0 text-muted"
                      aria-hidden="true"
                    />
                  </button>
                </li>
                <li
                  v-if="!upstreamItems.length"
                  class="rounded-lg bg-default p-4 text-sm text-muted"
                >
                  此页没有匹配的上游商品。
                </li>
              </ul>
              <div
                v-if="upstreamProduct"
                class="mt-5 space-y-3 border-t border-default pt-4"
              >
                <div>
                  <h3 class="break-words font-semibold text-highlighted">
                    {{ upstreamProduct.name }}
                  </h3><p class="mt-1 break-all text-xs text-muted">
                    商品编号 {{ upstreamProduct.upstreamProductId }} · skuType {{ upstreamProduct.skuType ?? '未知' }} · {{ formatDate(upstreamProduct.source.readAt) }} · 配置 v{{ upstreamProduct.source.configurationVersionNumber }}
                  </p>
                </div>
                <UAlert
                  v-if="upstreamProduct.skuType !== 0 && upstreamProduct.skuType !== 1 && upstreamProduct.skuType !== 2"
                  color="warning"
                  variant="soft"
                  title="未知规格类型"
                  description="未知或缺失的 skuType 不能审核为已对应。"
                />
                <UFormField
                  v-if="upstreamProduct.skuType === 0 || upstreamProduct.skuType === 1 || upstreamProduct.skuType === 2"
                  label="上游 SKU 与规格组合"
                  :hint="upstreamProduct.skuType === 0 ? '明确选择无规格身份，不会从商品名猜测。' : '按上游 SKU 编码选择；规格名仅用于人工核对。'"
                >
                  <USelect
                    v-model="selectedUpstreamSku"
                    :items="upstreamSkuOptions"
                    class="w-full"
                    :disabled="upstreamProduct.skuType === 0 || !upstreamSkuOptions.length"
                    placeholder="选择明确的上游 SKU"
                  />
                </UFormField>
                <div
                  v-if="selectedUpstreamVariant"
                  class="rounded-lg bg-default p-3 text-sm"
                >
                  <p class="font-medium">
                    已选上游 SKU {{ selectedUpstreamVariant.upstreamSku }}
                  </p>
                  <p class="mt-1 break-words text-muted">
                    {{ selectedUpstreamVariant.combination.map(part => `${part.title}：${part.value}`).join(' / ') }}
                  </p>
                </div>
                <UButton
                  icon="i-lucide-scan-search"
                  :loading="reading"
                  :disabled="reading || !selectedConnection || ![0,1,2].includes(upstreamProduct.skuType ?? -1) || (upstreamProduct.skuType !== 0 && !selectedUpstreamSku)"
                  @click="observeSelectedSku"
                >
                  重新读取并固定本次结构观察
                </UButton>
              </div>
            </section>

            <section
              aria-labelledby="identity-title"
              class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2
                    id="identity-title"
                    class="font-semibold text-highlighted"
                  >
                    身份与版本
                  </h2><p class="mt-1 text-sm text-muted">
                    映射以本地 ID、连接配置版本和上游编码为身份。
                  </p>
                </div>
                <UBadge
                  v-if="mapping"
                  :color="mapping.status === 'reviewed' ? 'success' : mapping.status === 'stale' ? 'warning' : 'neutral'"
                  variant="soft"
                >
                  {{ statusLabel(mapping.status) }}
                </UBadge>
                <UBadge
                  v-else
                  color="neutral"
                  variant="subtle"
                >
                  尚未建立映射
                </UBadge>
              </div>
              <dl class="mt-4 grid gap-3 rounded-lg bg-default p-3 text-sm sm:grid-cols-2">
                <div>
                  <dt class="text-muted">
                    本地 productId
                  </dt><dd class="mt-1 break-all font-mono text-xs">
                    {{ selectedSku?.productId ?? '—' }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    本地 skuId
                  </dt><dd class="mt-1 break-all font-mono text-xs">
                    {{ selectedSku?.skuId ?? '—' }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    供应商连接 / 当前配置
                  </dt><dd class="mt-1 break-all">
                    {{ selectedConnection?.name ?? '—' }} · v{{ selectedConnection?.currentVersion.versionNumber ?? '—' }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    上游商品与规格
                  </dt><dd class="mt-1 break-all">
                    {{ observation?.upstreamProductId ?? mapping?.upstreamProductId ?? '—' }} · {{ observation?.skuType ?? mapping?.upstreamSkuType ?? '—' }} · {{ observation?.skuCode ?? mapping?.upstreamSkuCode ?? '无规格' }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    当前结构观察
                  </dt><dd class="mt-1">
                    {{ sourceVersionLabel }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    结构指纹
                  </dt><dd class="mt-1 break-all font-mono text-xs">
                    {{ observation?.structureFingerprint ?? mapping?.structureFingerprint ?? '—' }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    本地冻结模板
                  </dt><dd class="mt-1 break-words">
                    {{ appliedTemplate?.name ?? mapping?.templateVersion.name ?? '—' }} · v{{ appliedTemplate?.versionNumber ?? mapping?.templateVersion.versionNumber ?? '—' }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    映射版本 / 修订
                  </dt><dd class="mt-1">
                    审核版本 {{ mapping?.reviewedVersionId ? (history?.items.find(item => item.id === mapping?.reviewedVersionId)?.versionNumber ?? '已保存') : '无' }} · 修订 {{ mapping?.revision ?? '—' }}
                  </dd>
                </div>
              </dl>
              <p class="mt-3 text-xs leading-5 text-muted">
                指纹包含商品类型/状态、明确 SKU 编码/规格组合和完整购买字段树，不含商品展示名、报价、余额、库存及观察时间。
              </p>
            </section>
          </div>

          <section
            aria-labelledby="field-mapping-title"
            class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
          >
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2
                  id="field-mapping-title"
                  class="font-semibold text-highlighted"
                >
                  字段与选项对应
                </h2><p class="mt-1 max-w-3xl text-sm leading-5 text-muted">
                  使用冻结字段 UUID 与 meaningKey；上游定位由字段/选项/子选项/扩展字段路径和当前完整快照共同确定。
                </p>
              </div>
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-rotate-ccw"
                :disabled="!currentDefinition || !canEditTarget"
                @click="rules = blankRules(currentDefinition)"
              >
                清空并重新对应
              </UButton>
            </div>
            <UAlert
              v-if="mapping && selectedSku?.appliedTemplateVersion?.id !== mapping.templateVersion.id"
              class="mt-4"
              color="warning"
              variant="soft"
              title="本地模板版本已变化"
              description="当前映射保留旧模板审核历史。请按当前已应用冻结版本重新建立字段对应并保存为新草稿。"
            />
            <UEmpty
              v-if="!currentDefinition"
              class="mt-4"
              title="没有可编辑的本地冻结模板"
              description="先在 SKU 的购买填写设置中应用一个冻结模板版本，再返回建立供应商映射。"
            />
            <UEmpty
              v-else-if="!observedFields"
              class="mt-4"
              title="等待上游结构观察"
              description="先读取上游商品详情并明确选择商品/SKU；此页面不会按名称或数组位置自动匹配。"
            />
            <div
              v-else
              class="mt-4 space-y-3"
            >
              <article
                v-for="row in localFieldRows"
                :key="row.field.id"
                class="min-w-0 rounded-lg border border-default bg-default p-3 sm:p-4"
              >
                <div class="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <h3 class="break-words font-medium text-highlighted">
                        {{ row.field.label }}
                      </h3><UBadge
                        color="neutral"
                        variant="subtle"
                        size="xs"
                      >
                        {{ fieldTypeLabel(row.field.type) }}
                      </UBadge><UBadge
                        v-if="row.field.required"
                        color="warning"
                        variant="subtle"
                        size="xs"
                      >
                        本地必填
                      </UBadge>
                    </div>
                    <p
                      v-if="row.branch"
                      class="mt-1 break-words text-xs text-muted"
                    >
                      条件分支：{{ row.branch }}
                    </p>
                    <p class="mt-1 break-all font-mono text-xs text-dimmed">
                      UUID {{ row.field.id }} · meaningKey {{ row.field.meaningKey }}
                    </p>
                  </div>
                  <UFormField
                    label="对应的上游字段路径"
                    :name="`field-${row.field.id}`"
                  >
                    <USelect
                      :model-value="pathKey(findRule(row.field.id)?.upstreamPath ?? [])"
                      :items="[{ label: '未对应', value: '[]' }, ...sourceFieldChoices.filter(choice => choice.type === ({ text: 0, digits: 13, textarea: 15, select: 14, cascade: 16, image: 1 } as Record<string, number>)[row.field.type]).map(choice => ({ label: choice.label, value: choice.key }))]"
                      class="w-full"
                      @update:model-value="updateFieldPath(row.field.id, String($event ?? ''))"
                    />
                  </UFormField>
                </div>
                <div
                  v-if="localOptions(row.field).length"
                  class="mt-3 space-y-2 border-t border-default pt-3"
                >
                  <p class="text-xs font-medium text-muted">
                    本地选项 → 上游原始 value
                  </p>
                  <div
                    v-for="optionRow in localOptions(row.field)"
                    :key="optionRow.option.id"
                    class="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,0.65fr)_minmax(0,1.35fr)] sm:items-center"
                  >
                    <p class="min-w-0 break-words text-sm">
                      {{ optionRow.branch ? `${optionRow.branch} › ` : '' }}{{ optionRow.option.label }} <span class="font-mono text-xs text-dimmed">({{ optionRow.option.meaningKey }})</span>
                    </p>
                    <USelect
                      :model-value="pathKey(findRule(row.field.id)?.options.find(item => item.localOptionId.toLowerCase() === optionRow.option.id.toLowerCase())?.upstreamPath ?? [])"
                      :items="[{ label: '未对应', value: '[]' }, ...upstreamOptionChoices(findRule(row.field.id)?.upstreamPath ?? [], row.field.type === 'cascade').map(choice => ({ label: choice.label, value: choice.key }))]"
                      class="w-full"
                      :aria-label="`${row.field.label}选项 ${optionRow.option.label} 对应的上游原始 value`"
                      @update:model-value="updateOptionPath(row.field.id, optionRow.option.id, String($event ?? ''))"
                    />
                  </div>
                </div>
              </article>
            </div>
          </section>

          <details class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5">
            <summary class="cursor-pointer font-semibold text-highlighted">
              上游字段与选项完整结构 <span class="ml-2 text-xs font-normal text-muted">{{ sourceStructureRows.length }} 项 · 字段路径及原始 option value</span>
            </summary>
            <p class="mt-2 text-sm leading-5 text-muted">
              显示只读观察中的 required 规范化值、字段类型、选项 value、children 与 expand 路径。上游 regex 只标记存在，不会执行。
            </p>
            <UEmpty
              v-if="!sourceStructureRows.length"
              class="mt-3"
              title="等待上游结构"
              description="读取并固定商品 SKU 结构后，此处显示完整字段树。"
            />
            <ul
              v-else
              class="mt-3 max-h-[32rem] space-y-2 overflow-auto"
              aria-label="上游字段与选项结构"
            >
              <li
                v-for="row in sourceStructureRows"
                :key="row.key"
                class="min-w-0 rounded-lg bg-default p-3"
                :class="row.kind === 'option' ? 'ml-3 border-l-2 border-primary/30 sm:ml-6' : ''"
              >
                <p
                  class="break-words text-sm"
                  :class="row.kind === 'field' ? 'font-medium text-highlighted' : 'text-default'"
                >
                  {{ row.label }}
                </p>
                <p class="mt-1 break-words text-xs text-muted">
                  {{ row.detail }}
                </p>
              </li>
            </ul>
          </details>

          <div class="grid min-w-0 gap-5 xl:grid-cols-2">
            <section
              aria-labelledby="validation-title"
              class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h2
                  id="validation-title"
                  class="font-semibold text-highlighted"
                >
                  结构校验
                </h2><UBadge
                  :color="blockingIssues.length ? 'warning' : 'success'"
                  variant="soft"
                >
                  {{ blockingIssues.length ? `${blockingIssues.length} 项阻止审核` : '当前结构可审核' }}
                </UBadge>
              </div>
              <ul
                v-if="preview?.issues.length"
                class="mt-3 space-y-2"
                aria-label="结构问题列表"
              >
                <li
                  v-for="(issue, index) in preview.issues"
                  :key="`${issue.code}-${issue.localFieldId}-${issue.localOptionId}-${index}`"
                  class="rounded-lg border border-default bg-default p-3 text-sm"
                >
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <span>{{ issueLabel(issue.code) }}</span><UBadge
                      :color="issue.blocking ? 'error' : 'warning'"
                      variant="subtle"
                      size="xs"
                    >
                      {{ issue.blocking ? '阻止审核' : '未验证语义' }}
                    </UBadge>
                  </div>
                  <p
                    v-if="issue.upstreamPath?.length"
                    class="mt-1 break-all font-mono text-xs text-muted"
                  >
                    {{ pathLabel(issue.upstreamPath) }}
                  </p>
                  <p
                    v-if="issue.localFieldId"
                    class="mt-1 break-all font-mono text-xs text-muted"
                  >
                    localFieldId {{ issue.localFieldId }}{{ issue.localOptionId ? ` · localOptionId ${issue.localOptionId}` : '' }}
                  </p>
                </li>
              </ul>
              <UEmpty
                v-else-if="preview"
                class="mt-3"
                icon="i-lucide-circle-check"
                title="没有阻断项"
                description="服务端审核仍会重新读取上游并验证版本。"
              />
              <UEmpty
                v-else
                class="mt-3"
                title="等待字段结构"
                description="选择冻结模板并读取上游商品后显示结构校验。"
              />
            </section>

            <section
              aria-labelledby="preview-title"
              class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
            >
              <div class="flex items-center justify-between gap-2">
                <h2
                  id="preview-title"
                  class="font-semibold text-highlighted"
                >
                  安全预览
                </h2><UBadge
                  color="neutral"
                  variant="subtle"
                >
                  内部中间表示
                </UBadge>
              </div>
              <p class="mt-1 text-sm leading-5 text-muted">
                仅使用本地合成值，输出不是供应商购买请求。未运行上游正则、HTML、JavaScript 或表达式。
              </p>
              <pre
                v-if="preview"
                class="mt-3 max-h-72 overflow-auto rounded-lg bg-default p-3 text-xs leading-5"
              >{{ JSON.stringify(preview, null, 2) }}</pre>
              <UEmpty
                v-else
                class="mt-3"
                title="暂不可预览"
                description="需要本地冻结模板和上游结构观察。"
              />
              <p class="mt-3 text-xs leading-5 text-warning">
                图片只显示本地来源对象引用；图片数量、类型和上游编码要求仍未验证。
              </p>
            </section>
          </div>

          <section
            aria-label="映射版本操作"
            class="flex flex-col gap-3 rounded-xl border border-default bg-elevated p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:p-5"
          >
            <div class="min-w-0">
              <p class="font-medium text-highlighted">
                映射状态：{{ mapping ? statusLabel(mapping.status) : '未建立' }}
              </p><p class="mt-1 text-xs leading-5 text-muted">
                保存草稿可保留未完成对应；审核版本不可修改，恢复历史会创建新草稿。审核状态不授予采购资格。
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <UButton
                icon="i-lucide-save"
                :loading="saving"
                :disabled="!canSave"
                @click="saveDraft"
              >
                {{ mapping ? '保存草稿' : '创建草稿' }}
              </UButton>
              <UButton
                v-if="mapping"
                color="neutral"
                variant="outline"
                icon="i-lucide-refresh-cw"
                :loading="saving"
                :disabled="saving || !canEditTarget"
                @click="refreshStructure"
              >
                重新读取与识别漂移
              </UButton>
              <UButton
                v-if="mapping"
                color="success"
                variant="soft"
                icon="i-lucide-shield-check"
                :loading="saving"
                :disabled="saving || !canEditTarget || blockingIssues.length > 0"
                @click="reviewMapping"
              >
                审核并追加版本
              </UButton>
              <UButton
                v-if="mapping"
                color="neutral"
                variant="outline"
                icon="i-lucide-history"
                @click="loadHistory"
              >
                查看历史
              </UButton>
            </div>
          </section>

          <section
            v-if="history"
            aria-labelledby="history-title"
            class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
          >
            <div class="flex items-center justify-between gap-2">
              <h2
                id="history-title"
                class="font-semibold text-highlighted"
              >
                不可变审核历史
              </h2><span class="text-xs text-muted">共 {{ history.total }} 个审核版本</span>
            </div>
            <UEmpty
              v-if="!history.items.length"
              class="mt-3"
              title="还没有审核版本"
              description="通过结构审核后，系统会追加第一个不可变版本。"
            />
            <ul
              v-else
              class="mt-3 space-y-2"
            >
              <li
                v-for="version in history.items"
                :key="version.id"
                class="flex min-w-0 flex-col gap-3 rounded-lg border border-default bg-default p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div class="min-w-0">
                  <p class="font-medium text-highlighted">
                    审核版本 v{{ version.versionNumber }} · {{ formatDate(version.reviewedAt) }}
                  </p><p class="mt-1 break-all text-xs text-muted">
                    上游 {{ version.upstreamProductId }} / skuType {{ version.upstreamSkuType }} / {{ version.upstreamSkuCode ?? '无规格' }} · 配置 v{{ version.configurationVersionNumber }}
                  </p><p class="mt-1 break-all font-mono text-xs text-dimmed">
                    {{ version.structureFingerprint }}
                  </p>
                </div>
                <UButton
                  color="neutral"
                  variant="outline"
                  :disabled="saving"
                  @click="restoreVersion(version)"
                >
                  恢复为新草稿
                </UButton>
              </li>
            </ul>
            <details class="mt-4 rounded-lg border border-default p-3">
              <summary class="cursor-pointer text-sm font-medium">
                审核审计事件
              </summary><ul class="mt-3 space-y-2 text-xs text-muted">
                <li
                  v-for="event in history.events"
                  :key="event.id"
                  class="break-words"
                >
                  {{ formatDate(event.createdAt) }} · {{ event.operation }} · 修订 {{ event.revision }} · {{ JSON.stringify(event.summary) }}
                </li>
              </ul>
            </details>
          </section>
        </div>
      </main>
    </template>
  </UDashboardPanel>
</template>
