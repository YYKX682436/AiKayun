import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  PURCHASE_FORM_NORMALIZATION_VERSION,
  SupplierMappingCatalogSchema,
  SupplierProductMappingCreateBodySchema,
  SupplierProductMappingHistoryQuerySchema,
  SupplierProductMappingHistorySchema,
  SupplierProductMappingIdParamsSchema,
  SupplierProductMappingListSchema,
  SupplierProductMappingObserveBodySchema,
  SupplierProductMappingObservationSchema,
  SupplierProductMappingRefreshOutcomeSchema,
  SupplierProductMappingRestoreBodySchema,
  SupplierProductMappingRevisionBodySchema,
  SupplierProductMappingReviewOutcomeSchema,
  SupplierProductMappingSchema,
  SupplierProductMappingUpdateBodySchema,
  canonicalSupplierMappingJson,
  failure,
  success,
  supplierProductStructureSnapshot,
  validateSupplierProductMapping,
} from '@aikayun/contracts'
import type {
  SupplierMappingCatalogSku,
  SupplierMappingStatus,
  SupplierProductMapping,
  SupplierProductMappingCreateBody,
  SupplierProductMappingIssue,
  SupplierProductMappingObservation,
  SupplierProductMappingObserveBody,
  SupplierProductMappingRestoreBody,
  SupplierProductMappingUpdateBody,
  SupplierProductMappingVersion,
  SupplierMappingRules,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { Database, SupplierProductMappingHeadsTable, SupplierProductMappingObservationsTable, SupplierProductMappingVersionsTable } from '../db/types.js'
import { KayixinV3Error } from '../commerce/kayixin-customer-v3.js'
import { SupplierCredentialKeyUnavailableError } from '../commerce/supplier-api-crypto.js'
import { effectivePurchaseFormForSku } from '../commerce/purchase-form-config.js'
import { readCurrentKayixinGoodDetail, SupplierAdminError } from './admin-supplier-connections.js'

const pageSizeDefault = 50
const observationTtlMs = 30 * 60 * 1000

class MappingAdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'MappingAdminError'
  }
}

type MappingDb = Kysely<Database> | Transaction<Database>
type MappingHeadRow = Selectable<SupplierProductMappingHeadsTable>
type MappingObservationRow = Selectable<SupplierProductMappingObservationsTable>
type MappingVersionRow = Selectable<SupplierProductMappingVersionsTable>
type LocalTemplate = {
  id: string
  templateId: string
  name: string
  versionNumber: number
  sha256: string
  normalizationVersion: number
  definition: Record<string, unknown>
}
type ReadMapping = MappingHeadRow & {
  connection_name: string
  current_configuration_version_id: string
  configuration_version_number: number
  template_name: string
  template_version_number: number
  template_definition: Record<string, unknown>
  loaded_template_id: string
  loaded_template_sha256: string
}
type SelectedUpstreamSku = {
  skuType: 0 | 1 | 2
  skuCode: string | null
  combination: Array<{ title: string; value: string }>
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalSupplierMappingJson(value), 'utf8').digest('hex')
}

function normalizeRules(rules: SupplierMappingRules): SupplierMappingRules {
  return {
    version: 1,
    fields: [...rules.fields]
      .map(rule => ({ ...rule, localFieldId: rule.localFieldId.toLowerCase(),
        options: [...rule.options].map(option => ({ ...option, localOptionId: option.localOptionId.toLowerCase() }))
          .sort((a, b) => a.localOptionId.localeCompare(b.localOptionId)) }))
      .sort((a, b) => a.localFieldId.localeCompare(b.localFieldId)),
  }
}

function selectedUpstreamSku(product: Awaited<ReturnType<typeof readCurrentKayixinGoodDetail>>,
  skuType: number, skuCode: string | null): SelectedUpstreamSku {
  if (product.skuType !== skuType || ![0, 1, 2].includes(skuType)) {
    throw new MappingAdminError(409, 'UPSTREAM_SKU_IDENTITY_CHANGED', '上游规格类型与所选身份不一致，请重新读取商品详情。')
  }
  if (skuType === 0) {
    if (skuCode !== null || product.variants.length || product.specificationGroups.length) {
      throw new MappingAdminError(409, 'UPSTREAM_SKU_IDENTITY_AMBIGUOUS', '无规格商品返回了规格数据，无法确认上游商品身份。')
    }
    return { skuType: 0, skuCode: null, combination: [] }
  }
  if (!skuCode) throw new MappingAdminError(400, 'UPSTREAM_SKU_CODE_REQUIRED', '多规格商品必须选择明确的上游 SKU 编码。')
  const matching = product.variants.filter(item => item.upstreamSku === skuCode)
  if (matching.length !== 1) {
    throw new MappingAdminError(409, 'UPSTREAM_SKU_IDENTITY_AMBIGUOUS', '上游 SKU 编码缺失或不唯一，请重新读取并选择规格。')
  }
  const variant = matching[0]!
  if (!variant.combination.length || variant.combination.some(item => !item.title || !item.value)) {
    throw new MappingAdminError(409, 'UPSTREAM_SKU_SPECIFICATION_UNKNOWN', '上游 SKU 规格组合不完整，不能建立身份映射。')
  }
  const pairKeys = variant.combination.map(item => `${item.title}\u0000${item.value}`)
  if (new Set(pairKeys).size !== pairKeys.length) {
    throw new MappingAdminError(409, 'UPSTREAM_SKU_SPECIFICATION_AMBIGUOUS', '上游 SKU 规格组合存在重复项，不能建立身份映射。')
  }
  return { skuType: skuType as 1 | 2, skuCode, combination: variant.combination.map(item => ({ title: item.title, value: item.value })) }
}

function safeIssues(product: Awaited<ReturnType<typeof readCurrentKayixinGoodDetail>>,
  template: LocalTemplate, snapshot: ReturnType<typeof supplierProductStructureSnapshot>, rules: SupplierMappingRules): SupplierProductMappingIssue[] {
  const checked = validateSupplierProductMapping(template.definition, snapshot.purchaseFields as never, rules)
  const issues = [...checked.issues]
  if (![1, 3].includes(product.goodsType)) issues.push({ code: 'UPSTREAM_GOODS_TYPE_UNKNOWN', localFieldId: null, localOptionId: null, upstreamPath: null, blocking: true })
  if (![1, 2, 3].includes(product.status)) issues.push({ code: 'UPSTREAM_GOODS_STATUS_UNKNOWN', localFieldId: null, localOptionId: null, upstreamPath: null, blocking: true })
  return [...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()]
}

function headSourceDiffersFromVersion(head: MappingHeadRow, version: MappingVersionRow): boolean {
  return head.supplier_connection_id !== version.supplier_connection_id
    || head.supplier_connection_version_id !== version.supplier_connection_version_id
    || head.upstream_product_id !== version.upstream_product_id
    || head.upstream_sku_type !== version.upstream_sku_type
    || head.upstream_sku_code !== version.upstream_sku_code
    || digest(head.upstream_combination) !== digest(version.upstream_combination)
    || head.upstream_structure_sha256 !== version.upstream_structure_sha256
    || head.template_id !== version.template_id
    || head.template_version_id !== version.template_version_id
    || head.template_sha256 !== version.template_sha256
    || head.normalization_version !== version.normalization_version
}

async function currentTemplate(db: MappingDb, skuId: string): Promise<LocalTemplate | null> {
  const effective = await effectivePurchaseFormForSku(db, skuId)
  if (!effective.templateVersionId || !effective.templateId || !effective.definition) return null
  const row = await db.selectFrom('purchase_form_template_versions')
    .selectAll().where('id', '=', effective.templateVersionId).forShare().executeTakeFirst()
  if (!row || row.template_id !== effective.templateId) throw new MappingAdminError(409, 'LOCAL_TEMPLATE_CHANGED', '本地已应用模板版本已变化，请重新读取 SKU。')
  return { id: row.id, templateId: row.template_id, name: row.name, versionNumber: row.version_number,
    sha256: row.sha256, normalizationVersion: PURCHASE_FORM_NORMALIZATION_VERSION,
    definition: row.definition as Record<string, unknown> }
}

async function lockMappingTarget(db: MappingDb, ids: {
  productId: string; skuId: string; connectionId: string; configurationVersionId: string;
  templateVersionId: string; mappingId?: string; expectedRevision?: number; allowTemplateDrift?: boolean; allowSourceDrift?: boolean
}): Promise<{ template: LocalTemplate; appliedTemplate: LocalTemplate | null; mapping: MappingHeadRow | null; currentConfigurationVersionId: string }> {
  // Global write lock order: product -> SKU -> supplier connection -> template version -> mapping head.
  const product = await db.selectFrom('products').select(['id', 'status']).where('id', '=', ids.productId).forUpdate().executeTakeFirst()
  if (!product) throw new MappingAdminError(404, 'LOCAL_PRODUCT_NOT_FOUND', '本地商品不存在。')
  if (product.status === 'archived') throw new MappingAdminError(409, 'LOCAL_PRODUCT_ARCHIVED', '已归档商品不能修改供应商准备映射。')
  const sku = await db.selectFrom('product_variants').select(['id', 'product_id', 'retired_at'])
    .where('product_id', '=', ids.productId).where('id', '=', ids.skuId).forUpdate().executeTakeFirst()
  if (!sku) throw new MappingAdminError(404, 'LOCAL_SKU_NOT_FOUND', '本地 SKU 不存在。')
  if (sku.retired_at) throw new MappingAdminError(409, 'LOCAL_SKU_RETIRED', '已退役 SKU 不能修改供应商准备映射。')
  const connection = await db.selectFrom('supplier_connections')
    .select(['id', 'provider_type', 'current_version_id']).where('id', '=', ids.connectionId).forUpdate().executeTakeFirst()
  if (!connection) throw new MappingAdminError(404, 'SUPPLIER_CONNECTION_NOT_FOUND', '供应商连接不存在。')
  if (connection.provider_type !== 'kayixin_customer_v3') throw new MappingAdminError(400, 'SUPPLIER_PROTOCOL_NOT_SUPPORTED', '商品映射仅支持卡易信 V3 只读连接。')
  if (!connection.current_version_id) throw new MappingAdminError(409, 'SUPPLIER_CONFIGURATION_MISSING', '供应商连接尚无可读取配置版本。')
  if (!ids.allowSourceDrift && connection.current_version_id !== ids.configurationVersionId) {
    throw new MappingAdminError(409, 'SUPPLIER_VERSION_CHANGED', '上游读取期间配置版本已变化，请重新读取当前版本。')
  }
  const template = await db.selectFrom('purchase_form_template_versions').selectAll()
    .where('id', '=', ids.templateVersionId).forShare().executeTakeFirst()
  if (!template) throw new MappingAdminError(409, 'LOCAL_TEMPLATE_VERSION_MISSING', '本地冻结模板版本不存在。')
  const applied = await currentTemplate(db, ids.skuId)
  if (!ids.allowTemplateDrift && (!applied || applied.id !== ids.templateVersionId)) {
    throw new MappingAdminError(409, 'LOCAL_TEMPLATE_VERSION_CHANGED', 'SKU 当前已应用的冻结模板版本已变化，请重新选择并映射。')
  }
  let mapping: MappingHeadRow | null = null
  if (ids.mappingId) {
    mapping = await db.selectFrom('supplier_product_mapping_heads').selectAll()
      .where('id', '=', ids.mappingId).forUpdate().executeTakeFirst() ?? null
    if (!mapping) throw new MappingAdminError(404, 'SUPPLIER_MAPPING_NOT_FOUND', '供应商映射不存在或本地 SKU 已删除。')
    if (mapping.product_id !== ids.productId || mapping.product_variant_id !== ids.skuId) {
      throw new MappingAdminError(409, 'SUPPLIER_MAPPING_LOCAL_IDENTITY_CHANGED', '映射与本地商品或 SKU 身份不一致。')
    }
    if (ids.expectedRevision !== undefined && mapping.revision !== ids.expectedRevision) {
      throw new MappingAdminError(409, 'SUPPLIER_MAPPING_REVISION_CONFLICT', '映射已被其他管理员修改，请重新读取后再保存。')
    }
  }
  const fullTemplate = await db.selectFrom('purchase_form_template_versions').selectAll()
    .where('id', '=', template.id).executeTakeFirstOrThrow()
  return {
    template: { id: fullTemplate.id, templateId: fullTemplate.template_id, name: fullTemplate.name,
      versionNumber: fullTemplate.version_number, sha256: fullTemplate.sha256,
      normalizationVersion: PURCHASE_FORM_NORMALIZATION_VERSION,
      definition: fullTemplate.definition as Record<string, unknown> },
    appliedTemplate: applied,
    mapping,
    currentConfigurationVersionId: connection.current_version_id,
  }
}

async function insertObservation(db: MappingDb, administratorId: string, product: Awaited<ReturnType<typeof readCurrentKayixinGoodDetail>>,
  identity: SelectedUpstreamSku): Promise<string> {
  const snapshot = supplierProductStructureSnapshot(product, identity.skuCode)
  const fingerprint = digest(snapshot)
  const id = randomUUID()
  const observedAt = new Date(product.source.readAt)
  const expiresAt = new Date(Date.now() + observationTtlMs)
  await db.deleteFrom('supplier_product_mapping_observations').where('expires_at', '<', new Date()).execute()
  await db.insertInto('supplier_product_mapping_observations').values({
    id, administrator_id: administratorId, supplier_connection_id: product.source.connectionId,
    supplier_connection_version_id: product.source.configurationVersionId,
    upstream_product_id: product.upstreamProductId, upstream_product_name: product.name,
    upstream_sku_type: identity.skuType, upstream_sku_code: identity.skuCode,
    upstream_combination: JSON.stringify(identity.combination), upstream_structure_snapshot: snapshot as unknown as Record<string, unknown>,
    upstream_structure_sha256: fingerprint, upstream_observed_at: observedAt, expires_at: expiresAt,
  }).execute()
  return id
}

async function loadObservation(db: Kysely<Database>, id: string, administratorId: string): Promise<SupplierProductMappingObservation> {
  const row = await db.selectFrom('supplier_product_mapping_observations as observation')
    .innerJoin('supplier_connection_versions as version', 'version.id', 'observation.supplier_connection_version_id')
    .selectAll('observation')
    .select(['version.version_number as configuration_version_number'])
    .where('observation.id', '=', id).where('observation.administrator_id', '=', administratorId)
    .where('observation.expires_at', '>', new Date()).executeTakeFirst()
  if (!row) throw new MappingAdminError(409, 'SUPPLIER_OBSERVATION_EXPIRED', '上游观察已过期或不属于当前管理员，请重新读取详情。')
  const snapshot = row.upstream_structure_snapshot as unknown as ReturnType<typeof supplierProductStructureSnapshot>
  const combination = row.upstream_combination as Array<{ title: string; value: string }>
  return {
    id: row.id,
    source: { connectionId: row.supplier_connection_id, configurationVersionId: row.supplier_connection_version_id,
      configurationVersionNumber: row.configuration_version_number, protocol: 'kayixin_customer_v3', apiVersion: '3.0',
      readAt: row.upstream_observed_at.toISOString() },
    upstreamProductId: row.upstream_product_id, upstreamProductName: row.upstream_product_name,
    goodsType: snapshot.product.goodsType, status: snapshot.product.status,
    skuType: row.upstream_sku_type, skuCode: row.upstream_sku_code, combination,
    structureSnapshot: snapshot,
    structureFingerprint: row.upstream_structure_sha256, observedAt: row.upstream_observed_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }
}

async function recordAudit(db: MappingDb, args: {
  mappingId: string; productId: string; skuId: string; administratorId: string;
  operation: 'created' | 'draft_saved' | 'reviewed' | 'marked_stale' | 'restored';
  mappingVersionId?: string | null; revision: number; summary: Record<string, unknown>
}): Promise<void> {
  await db.insertInto('supplier_product_mapping_audit_events').values({
    id: randomUUID(), mapping_id: args.mappingId, product_id: args.productId,
    product_variant_id: args.skuId, administrator_id: args.administratorId,
    operation: args.operation, mapping_version_id: args.mappingVersionId ?? null,
    revision: args.revision, summary: args.summary,
  }).execute()
}

async function loadMapping(db: Kysely<Database>, id: string): Promise<SupplierProductMapping> {
  const loaded = await db.selectFrom('supplier_product_mapping_heads as head')
    .innerJoin('supplier_connections as connection', 'connection.id', 'head.supplier_connection_id')
    .innerJoin('supplier_connection_versions as connection_version', 'connection_version.id', 'head.supplier_connection_version_id')
    .innerJoin('purchase_form_template_versions as template_version', 'template_version.id', 'head.template_version_id')
    .selectAll('head')
    .select(['connection.display_name as connection_name', 'connection.current_version_id as current_configuration_version_id',
      'connection_version.version_number as configuration_version_number', 'template_version.name as template_name',
      'template_version.version_number as template_version_number', 'template_version.definition as template_definition',
      'template_version.template_id as loaded_template_id', 'template_version.sha256 as loaded_template_sha256'])
    .where('head.id', '=', id).executeTakeFirst() as ReadMapping | undefined
  if (!loaded) throw new MappingAdminError(404, 'SUPPLIER_MAPPING_NOT_FOUND', '供应商映射不存在或本地 SKU 已删除。')
  const latest = loaded.latest_review_version_id
    ? await db.selectFrom('supplier_product_mapping_versions').selectAll().where('id', '=', loaded.latest_review_version_id).executeTakeFirst()
    : null
  const applied = await effectivePurchaseFormForSku(db, loaded.product_variant_id)
  let status: SupplierMappingStatus = loaded.status
  const configurationChanged = loaded.current_configuration_version_id !== loaded.supplier_connection_version_id
  const templateChanged = applied.templateVersionId !== loaded.template_version_id
  const normalizationChanged = loaded.normalization_version !== PURCHASE_FORM_NORMALIZATION_VERSION
  if (status !== 'stale' && (configurationChanged || templateChanged || normalizationChanged)) status = 'stale'
  if (status !== 'stale' && latest && headSourceDiffersFromVersion(loaded, latest)) status = 'stale'

  const template: LocalTemplate = { id: loaded.template_version_id, templateId: loaded.loaded_template_id,
    name: loaded.template_name, versionNumber: loaded.template_version_number, sha256: loaded.loaded_template_sha256,
    normalizationVersion: loaded.normalization_version, definition: loaded.template_definition }
  const snapshot = loaded.upstream_structure_snapshot as unknown as ReturnType<typeof supplierProductStructureSnapshot>
  const rules = loaded.rules as unknown as SupplierMappingRules
  const pseudoProduct = { goodsType: snapshot.product.goodsType, status: snapshot.product.status } as Awaited<ReturnType<typeof readCurrentKayixinGoodDetail>>
  const issues = safeIssues(pseudoProduct, template, snapshot, rules)
  if (configurationChanged) issues.push({ code: 'SUPPLIER_CONFIGURATION_VERSION_CHANGED', localFieldId: null, localOptionId: null, upstreamPath: null, blocking: true })
  if (templateChanged) issues.push({ code: 'LOCAL_APPLIED_TEMPLATE_VERSION_CHANGED', localFieldId: null, localOptionId: null, upstreamPath: null, blocking: true })
  if (normalizationChanged) issues.push({ code: 'LOCAL_NORMALIZATION_VERSION_CHANGED', localFieldId: null, localOptionId: null, upstreamPath: null, blocking: true })
  return {
    id: loaded.id, productId: loaded.product_id, skuId: loaded.product_variant_id, revision: loaded.revision,
    status, connectionId: loaded.supplier_connection_id, connectionName: loaded.connection_name,
    configurationVersionId: loaded.supplier_connection_version_id,
    configurationVersionNumber: loaded.configuration_version_number,
    upstreamProductId: loaded.upstream_product_id, upstreamProductName: loaded.upstream_product_name,
    upstreamSkuType: loaded.upstream_sku_type, upstreamSkuCode: loaded.upstream_sku_code,
    upstreamCombination: loaded.upstream_combination as Array<{ title: string; value: string }>,
    structureSnapshot: snapshot, structureFingerprint: loaded.upstream_structure_sha256,
    observedAt: loaded.upstream_observed_at.toISOString(),
    templateVersion: { id: loaded.template_version_id, templateId: loaded.template_id,
      name: loaded.template_name, versionNumber: loaded.template_version_number,
      sha256: loaded.template_sha256, normalizationVersion: loaded.normalization_version },
    templateDefinition: loaded.template_definition as never,
    rules, rulesSha256: loaded.rules_sha256, reviewedVersionId: loaded.latest_review_version_id,
    issues, updatedAt: loaded.updated_at.toISOString(),
  }
}

async function markMappingStale(db: Kysely<Database>, id: string, expectedRevision: number, administratorId: string,
  issueCode: string): Promise<SupplierProductMapping> {
  const existing = await db.selectFrom('supplier_product_mapping_heads').selectAll().where('id', '=', id).executeTakeFirst()
  if (!existing) throw new MappingAdminError(404, 'SUPPLIER_MAPPING_NOT_FOUND', '供应商映射不存在。')
  if (existing.revision !== expectedRevision) throw new MappingAdminError(409, 'SUPPLIER_MAPPING_REVISION_CONFLICT', '映射已被其他管理员修改，请重新读取。')
  if (existing.status !== 'stale') {
    await db.transaction().execute(async trx => {
      const context = await lockMappingTarget(trx, {
        productId: existing.product_id, skuId: existing.product_variant_id,
        connectionId: existing.supplier_connection_id,
        configurationVersionId: existing.supplier_connection_version_id,
        templateVersionId: existing.template_version_id, mappingId: id,
        expectedRevision, allowTemplateDrift: true, allowSourceDrift: true,
      })
      const locked = context.mapping!
      if (locked.revision !== expectedRevision) throw new MappingAdminError(409, 'SUPPLIER_MAPPING_REVISION_CONFLICT', '映射已被其他管理员修改，请重新读取。')
      const revision = locked.revision + 1
      await trx.updateTable('supplier_product_mapping_heads').set({ status: 'stale', revision, updated_by_admin_id: administratorId })
        .where('id', '=', id).execute()
      await recordAudit(trx, { mappingId: id, productId: locked.product_id, skuId: locked.product_variant_id,
        administratorId, operation: 'marked_stale', revision, summary: { issueCode } })
    })
  }
  return loadMapping(db, id)
}

async function getObservationForBody(db: Kysely<Database>, administratorId: string, observationId: string) {
  const row = await db.selectFrom('supplier_product_mapping_observations').selectAll()
    .where('id', '=', observationId).where('administrator_id', '=', administratorId)
    .where('expires_at', '>', new Date()).executeTakeFirst()
  if (!row) throw new MappingAdminError(409, 'SUPPLIER_OBSERVATION_EXPIRED', '上游观察已过期或不属于当前管理员，请重新读取详情。')
  return row
}

async function readFreshObservation(db: Kysely<Database>, config: AppConfig, administratorId: string,
  observation: MappingObservationRow) {
  const product = await readCurrentKayixinGoodDetail(db, config, observation.supplier_connection_id,
    Number(observation.upstream_product_id), observation.supplier_connection_version_id)
  const selected = selectedUpstreamSku(product, observation.upstream_sku_type, observation.upstream_sku_code)
  const snapshot = supplierProductStructureSnapshot(product, selected.skuCode)
  if (digest(snapshot) !== observation.upstream_structure_sha256) {
    throw new MappingAdminError(409, 'SUPPLIER_OBSERVATION_STALE', '供应商字段或规格结构在编辑期间发生变化，请重新读取后核对。')
  }
  return { product, selected, snapshot, fingerprint: observation.upstream_structure_sha256 }
}

async function createMapping(db: Kysely<Database>, config: AppConfig, body: SupplierProductMappingCreateBody,
  administratorId: string): Promise<SupplierProductMapping> {
  const observation = await getObservationForBody(db, administratorId, body.observationId)
  const fresh = await readFreshObservation(db, config, administratorId, observation)
  const snapshot = supplierProductStructureSnapshot(fresh.product, fresh.selected.skuCode)
  const rules = normalizeRules(body.rules)
  const id = randomUUID()
  await db.transaction().execute(async trx => {
    const context = await lockMappingTarget(trx, {
      productId: body.productId, skuId: body.skuId, connectionId: observation.supplier_connection_id,
      configurationVersionId: observation.supplier_connection_version_id, templateVersionId: body.templateVersionId,
    })
    if (!context.template) throw new MappingAdminError(409, 'LOCAL_TEMPLATE_NOT_APPLIED', 'SKU 没有已应用的冻结购买模板，暂时不能审核供应商映射。')
    const currentTemplate = context.appliedTemplate
    if (!currentTemplate) throw new MappingAdminError(409, 'LOCAL_TEMPLATE_NOT_APPLIED', 'SKU 没有已应用的冻结购买模板，暂时不能审核供应商映射。')
    const checked = safeIssues(fresh.product, currentTemplate, snapshot, rules)
    const rulesHash = digest(rules)
    const revision = 1
    await trx.insertInto('supplier_product_mapping_heads').values({
      id, product_id: body.productId, product_variant_id: body.skuId, revision, status: 'draft',
      supplier_connection_id: observation.supplier_connection_id,
      supplier_connection_version_id: observation.supplier_connection_version_id,
      provider_type: 'kayixin_customer_v3', upstream_product_id: fresh.product.upstreamProductId,
      upstream_product_name: fresh.product.name, upstream_sku_type: fresh.selected.skuType,
      upstream_sku_code: fresh.selected.skuCode, upstream_combination: JSON.stringify(fresh.selected.combination),
      upstream_structure_snapshot: snapshot as unknown as Record<string, unknown>,
      upstream_structure_sha256: fresh.fingerprint, upstream_observed_at: new Date(fresh.product.source.readAt),
      template_id: currentTemplate.templateId, template_version_id: currentTemplate.id,
      template_sha256: currentTemplate.sha256, normalization_version: currentTemplate.normalizationVersion,
      rules_version: 1, rules: rules as unknown as Record<string, unknown>, rules_sha256: rulesHash,
      latest_review_version_id: null, latest_version_number: 0,
      created_by_admin_id: administratorId, updated_by_admin_id: administratorId,
    }).execute()
    await recordAudit(trx, { mappingId: id, productId: body.productId, skuId: body.skuId,
      administratorId, operation: 'created', revision,
      summary: { connectionId: observation.supplier_connection_id, configurationVersionId: observation.supplier_connection_version_id,
        upstreamProductId: fresh.product.upstreamProductId, upstreamSkuType: fresh.selected.skuType,
        ruleDigest: rulesHash, issueCodes: checked.map(issue => issue.code) } })
  })
  return loadMapping(db, id)
}

async function updateMapping(db: Kysely<Database>, config: AppConfig, id: string, body: SupplierProductMappingUpdateBody,
  administratorId: string): Promise<SupplierProductMapping> {
  const observation = await getObservationForBody(db, administratorId, body.observationId)
  const fresh = await readFreshObservation(db, config, administratorId, observation)
  const snapshot = supplierProductStructureSnapshot(fresh.product, fresh.selected.skuCode)
  const rules = normalizeRules(body.rules)
  await db.transaction().execute(async trx => {
    const prior = await trx.selectFrom('supplier_product_mapping_heads').selectAll().where('id', '=', id).executeTakeFirst()
    if (!prior) throw new MappingAdminError(404, 'SUPPLIER_MAPPING_NOT_FOUND', '供应商映射不存在。')
    if (prior.product_id !== body.productId || prior.product_variant_id !== body.skuId) {
      throw new MappingAdminError(409, 'SUPPLIER_MAPPING_LOCAL_IDENTITY_CHANGED', '映射不能改绑到其他本地商品或 SKU。')
    }
    const context = await lockMappingTarget(trx, {
      productId: body.productId, skuId: body.skuId, connectionId: observation.supplier_connection_id,
      configurationVersionId: observation.supplier_connection_version_id, templateVersionId: body.templateVersionId,
      mappingId: id, expectedRevision: body.expectedRevision,
    })
    const currentTemplate = context.appliedTemplate
    if (!currentTemplate) throw new MappingAdminError(409, 'LOCAL_TEMPLATE_NOT_APPLIED', 'SKU 没有已应用的冻结购买模板版本。')
    const checked = safeIssues(fresh.product, currentTemplate, snapshot, rules)
    const latest = context.mapping?.latest_review_version_id
      ? await trx.selectFrom('supplier_product_mapping_versions').selectAll().where('id', '=', context.mapping.latest_review_version_id).executeTakeFirst()
      : null
    const sourceChanged = Boolean(latest && (
      latest.supplier_connection_id !== observation.supplier_connection_id
      || latest.supplier_connection_version_id !== observation.supplier_connection_version_id
      || latest.upstream_product_id !== fresh.product.upstreamProductId
      || latest.upstream_sku_type !== fresh.selected.skuType
      || latest.upstream_sku_code !== fresh.selected.skuCode
      || latest.upstream_structure_sha256 !== fresh.fingerprint
      || latest.template_version_id !== currentTemplate.id
      || latest.template_sha256 !== currentTemplate.sha256
    ))
    const nextStatus: SupplierMappingStatus = sourceChanged ? 'stale' : 'draft'
    const revision = body.expectedRevision + 1
    const rulesHash = digest(rules)
    await trx.updateTable('supplier_product_mapping_heads').set({
      status: nextStatus, revision,
      supplier_connection_id: observation.supplier_connection_id,
      supplier_connection_version_id: observation.supplier_connection_version_id,
      provider_type: 'kayixin_customer_v3', upstream_product_id: fresh.product.upstreamProductId,
      upstream_product_name: fresh.product.name, upstream_sku_type: fresh.selected.skuType,
      upstream_sku_code: fresh.selected.skuCode, upstream_combination: JSON.stringify(fresh.selected.combination),
      upstream_structure_snapshot: snapshot as unknown as Record<string, unknown>,
      upstream_structure_sha256: fresh.fingerprint, upstream_observed_at: new Date(fresh.product.source.readAt),
      template_id: currentTemplate.templateId, template_version_id: currentTemplate.id,
      template_sha256: currentTemplate.sha256, normalization_version: currentTemplate.normalizationVersion,
      rules_version: 1, rules: rules as unknown as Record<string, unknown>, rules_sha256: rulesHash,
      updated_by_admin_id: administratorId,
    }).where('id', '=', id).execute()
    await recordAudit(trx, { mappingId: id, productId: body.productId, skuId: body.skuId,
      administratorId, operation: 'draft_saved', revision,
      summary: { status: nextStatus, configurationVersionId: observation.supplier_connection_version_id,
        upstreamProductId: fresh.product.upstreamProductId, upstreamSkuType: fresh.selected.skuType,
        ruleDigest: rulesHash, issueCodes: checked.map(issue => issue.code) } })
  })
  return loadMapping(db, id)
}

function mappingDataFromVersion(version: SupplierProductMappingVersion) {
  return {
    supplier_connection_id: version.connectionId, supplier_connection_version_id: version.configurationVersionId,
    provider_type: 'kayixin_customer_v3' as const, upstream_product_id: version.upstreamProductId,
    upstream_product_name: version.upstreamProductName, upstream_sku_type: version.upstreamSkuType,
    upstream_sku_code: version.upstreamSkuCode, upstream_combination: JSON.stringify(version.upstreamCombination),
    upstream_structure_snapshot: version.structureSnapshot as unknown as Record<string, unknown>,
    upstream_structure_sha256: version.structureFingerprint, upstream_observed_at: new Date(version.observedAt),
    template_id: version.templateVersion.templateId, template_version_id: version.templateVersion.id,
    template_sha256: version.templateVersion.sha256, normalization_version: version.templateVersion.normalizationVersion,
    rules_version: 1, rules: version.rules as unknown as Record<string, unknown>, rules_sha256: version.rulesSha256,
  }
}

export function registerAdminSupplierProductMappingRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  const authenticate = requireAdmin(db, config)
  const protectedWrite = [authenticate, verifyCsrf(config)]
  const errorSchemas = { 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema,
    409: ApiErrorSchema, 422: ApiErrorSchema, 502: ApiErrorSchema, 503: ApiErrorSchema }

  function sendError(reply: FastifyReply, error: unknown, requestId: string) {
    if (error instanceof MappingAdminError || error instanceof SupplierAdminError) {
      return reply.code(error.status).send(failure(error.code, error.message, requestId))
    }
    if (error instanceof KayixinV3Error) {
      return reply.code(502).send(failure(error.code.toUpperCase(), '卡易信只读商品详情读取或结构校验失败，请重新读取并核对站点字段。', requestId))
    }
    if (error instanceof SupplierCredentialKeyUnavailableError) {
      return reply.code(503).send(failure('SUPPLIER_CREDENTIAL_KEY_UNAVAILABLE', '供应商凭据或历史加密密钥暂不可用，读取已被阻止。', requestId))
    }
    let current: unknown = error
    for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
      const row = current as { constraint?: unknown; cause?: unknown }
      if (typeof row.constraint === 'string' && row.constraint.startsWith('supplier_mapping_')) {
        return reply.code(409).send(failure('SUPPLIER_MAPPING_CONFLICT', '映射身份、版本或审核状态与数据库约束冲突，请重新读取后重试。', requestId))
      }
      current = row.cause
    }
    throw error
  }

  app.get('/api/v1/admin/supplier-product-mappings/catalog', {
    preHandler: authenticate,
    schema: { tags: ['admin', 'catalog'], summary: 'List local SKUs, applied frozen form versions and mapping state',
      response: { 200: ApiSuccessSchemaOf(SupplierMappingCatalogSchema), ...errorSchemas } },
  }, async (request, reply) => {
    try {
      const rows = await sql<{
        product_id: string; product_name: string; product_status: string; product_revision: number;
        sku_id: string; sku_code: string; sku_enabled: boolean; sku_retired_at: Date | null;
        applied_template_id: string | null; applied_template_version_id: string | null; applied_template_name: string | null;
        applied_template_version_number: number | null; applied_template_sha256: string | null;
        mapping_id: string | null; mapping_status: SupplierMappingStatus | null; mapping_revision: number | null;
        mapping_connection_id: string | null; mapping_configuration_version_id: string | null;
        mapping_upstream_product_id: string | null; mapping_upstream_sku_type: number | null;
        mapping_upstream_sku_code: string | null; mapping_template_version_id: string | null; mapping_updated_at: Date | null;
      }>`
        SELECT product.id AS product_id, product.name AS product_name, product.status AS product_status,
          product.revision AS product_revision, sku.id AS sku_id, sku.sku_code, sku.enabled AS sku_enabled,
          sku.retired_at AS sku_retired_at,
          applied.template_id AS applied_template_id, applied.id AS applied_template_version_id,
          applied.name AS applied_template_name, applied.version_number AS applied_template_version_number,
          applied.sha256 AS applied_template_sha256,
          mapping.id AS mapping_id,
          CASE WHEN mapping.id IS NULL THEN NULL
            WHEN mapping.status = 'stale' OR supplier.current_version_id IS DISTINCT FROM mapping.supplier_connection_version_id
              OR applied.id IS DISTINCT FROM mapping.template_version_id THEN 'stale'
            ELSE mapping.status END AS mapping_status,
          mapping.revision AS mapping_revision, mapping.supplier_connection_id AS mapping_connection_id,
          mapping.supplier_connection_version_id AS mapping_configuration_version_id,
          mapping.upstream_product_id AS mapping_upstream_product_id, mapping.upstream_sku_type AS mapping_upstream_sku_type,
          mapping.upstream_sku_code AS mapping_upstream_sku_code,
          mapping.template_version_id AS mapping_template_version_id, mapping.updated_at AS mapping_updated_at
        FROM products AS product
        JOIN product_variants AS sku ON sku.product_id = product.id
        LEFT JOIN sku_purchase_form_overrides AS sku_form
          ON sku_form.product_id = product.id AND sku_form.product_variant_id = sku.id
        LEFT JOIN product_purchase_form_settings AS product_form ON product_form.product_id = product.id
        LEFT JOIN purchase_form_template_versions AS applied ON applied.id = CASE
          WHEN sku_form.applied_mode IS NOT NULL THEN
            CASE WHEN sku_form.applied_mode = 'template' THEN sku_form.applied_template_version_id ELSE NULL END
          WHEN product_form.applied_mode = 'template' THEN product_form.applied_template_version_id
          ELSE NULL END
        LEFT JOIN supplier_product_mapping_heads AS mapping
          ON mapping.product_id = product.id AND mapping.product_variant_id = sku.id
        LEFT JOIN supplier_connections AS supplier ON supplier.id = mapping.supplier_connection_id
        ORDER BY product.name, sku.sku_code, sku.id
        LIMIT 5000
      `.execute(db)
      const policy = await db.selectFrom('storefront_customer_policy').select('purchase_forms_status')
        .where('singleton', '=', true).executeTakeFirstOrThrow()
      const items: SupplierMappingCatalogSku[] = rows.rows.map(row => ({
        productId: row.product_id, productName: row.product_name, productStatus: row.product_status,
        productRevision: row.product_revision, skuId: row.sku_id, skuCode: row.sku_code,
        skuEnabled: row.sku_enabled, skuRetiredAt: row.sku_retired_at?.toISOString() ?? null,
        appliedTemplateVersion: row.applied_template_version_id && row.applied_template_id
          ? { id: row.applied_template_version_id, templateId: row.applied_template_id,
            name: row.applied_template_name ?? '', versionNumber: row.applied_template_version_number ?? 1,
            sha256: row.applied_template_sha256 ?? '0'.repeat(64), normalizationVersion: PURCHASE_FORM_NORMALIZATION_VERSION }
          : null,
        mapping: row.mapping_id ? {
          id: row.mapping_id, status: row.mapping_status ?? 'stale', revision: row.mapping_revision ?? 1,
          connectionId: row.mapping_connection_id!, configurationVersionId: row.mapping_configuration_version_id!,
          upstreamProductId: row.mapping_upstream_product_id!, upstreamSkuType: row.mapping_upstream_sku_type as 0 | 1 | 2,
          upstreamSkuCode: row.mapping_upstream_sku_code, templateVersionId: row.mapping_template_version_id!,
          updatedAt: row.mapping_updated_at!.toISOString(),
        } : null,
      }))
      return reply.send(success({ items, purchaseFormsStatus: policy.purchase_forms_status }, request.id))
    } catch (error) { return sendError(reply, error, request.id) }
  })

  app.post('/api/v1/admin/supplier-product-mappings/observe', {
    preHandler: protectedWrite,
    schema: { tags: ['admin', 'catalog'], summary: 'Read a selected Kayixin SKU identity and bounded field structure',
      body: SupplierProductMappingObserveBodySchema,
      response: { 200: ApiSuccessSchemaOf(SupplierProductMappingObservationSchema), ...errorSchemas } },
  }, async (request, reply) => {
    try {
      const body = request.body as SupplierProductMappingObserveBody
      const product = await readCurrentKayixinGoodDetail(db, config, body.connectionId, Number(body.upstreamProductId), body.expectedConfigurationVersionId)
      const selected = selectedUpstreamSku(product, body.upstreamSkuType, body.upstreamSkuCode)
      const id = await db.transaction().execute(async trx => {
        const connection = await trx.selectFrom('supplier_connections').select(['provider_type', 'current_version_id'])
          .where('id', '=', body.connectionId).forUpdate().executeTakeFirst()
        if (!connection || connection.provider_type !== 'kayixin_customer_v3') throw new MappingAdminError(404, 'SUPPLIER_CONNECTION_NOT_FOUND', '卡易信只读连接不存在。')
        if (connection.current_version_id !== product.source.configurationVersionId) throw new MappingAdminError(409, 'SUPPLIER_VERSION_CHANGED', '只读详情返回过迟，配置版本已变化，请重新读取。')
        return insertObservation(trx, request.admin!.id, product, selected)
      })
      return reply.send(success(await loadObservation(db, id, request.admin!.id), request.id))
    } catch (error) { return sendError(reply, error, request.id) }
  })

  app.get('/api/v1/admin/supplier-product-mappings', {
    preHandler: authenticate,
    schema: { tags: ['admin', 'catalog'], summary: 'List prepared supplier product mappings',
      response: { 200: ApiSuccessSchemaOf(SupplierProductMappingListSchema), ...errorSchemas } },
  }, async (request, reply) => {
    try {
      const ids = await db.selectFrom('supplier_product_mapping_heads').select('id').orderBy('updated_at', 'desc').limit(5000).execute()
      const items = await Promise.all(ids.map(item => loadMapping(db, item.id)))
      return reply.send(success({ items }, request.id))
    } catch (error) { return sendError(reply, error, request.id) }
  })

  app.post('/api/v1/admin/supplier-product-mappings', {
    preHandler: protectedWrite,
    schema: { tags: ['admin', 'catalog'], summary: 'Create a local draft supplier mapping from a server-observed SKU and field snapshot',
      body: SupplierProductMappingCreateBodySchema,
      response: { 201: ApiSuccessSchemaOf(SupplierProductMappingSchema), ...errorSchemas } },
  }, async (request, reply) => {
    try {
      const mapping = await createMapping(db, config, request.body as SupplierProductMappingCreateBody, request.admin!.id)
      return reply.code(201).send(success(mapping, request.id))
    } catch (error) { return sendError(reply, error, request.id) }
  })

  app.get('/api/v1/admin/supplier-product-mappings/:id', {
    preHandler: authenticate,
    schema: { tags: ['admin', 'catalog'], summary: 'Read a supplier mapping draft, audit status and structural validation',
      params: SupplierProductMappingIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(SupplierProductMappingSchema), ...errorSchemas } },
  }, async (request, reply) => {
    try { return reply.send(success(await loadMapping(db, (request.params as { id: string }).id), request.id)) }
    catch (error) { return sendError(reply, error, request.id) }
  })

  app.put('/api/v1/admin/supplier-product-mappings/:id', {
    preHandler: protectedWrite,
    schema: { tags: ['admin', 'catalog'], summary: 'Save a version-checked supplier mapping draft',
      params: SupplierProductMappingIdParamsSchema, body: SupplierProductMappingUpdateBodySchema,
      response: { 200: ApiSuccessSchemaOf(SupplierProductMappingSchema), ...errorSchemas } },
  }, async (request, reply) => {
    try {
      return reply.send(success(await updateMapping(db, config, (request.params as { id: string }).id,
        request.body as SupplierProductMappingUpdateBody, request.admin!.id), request.id))
    } catch (error) { return sendError(reply, error, request.id) }
  })

  app.post('/api/v1/admin/supplier-product-mappings/:id/refresh', {
    preHandler: protectedWrite,
    schema: { tags: ['admin', 'catalog'], summary: 'Re-read the same upstream SKU and detect structural/configuration drift',
      params: SupplierProductMappingIdParamsSchema, body: SupplierProductMappingRevisionBodySchema,
      response: { 200: ApiSuccessSchemaOf(SupplierProductMappingRefreshOutcomeSchema), ...errorSchemas } },
  }, async (request, reply) => {
    const id = (request.params as { id: string }).id
    const body = request.body as { expectedRevision: number }
    try {
      const before = await db.selectFrom('supplier_product_mapping_heads').selectAll().where('id', '=', id).executeTakeFirst()
      if (!before) throw new MappingAdminError(404, 'SUPPLIER_MAPPING_NOT_FOUND', '供应商映射不存在。')
      if (before.revision !== body.expectedRevision) throw new MappingAdminError(409, 'SUPPLIER_MAPPING_REVISION_CONFLICT', '映射已被其他管理员修改，请重新读取。')
      let product: Awaited<ReturnType<typeof readCurrentKayixinGoodDetail>>
      let identity: SelectedUpstreamSku
      try {
        product = await readCurrentKayixinGoodDetail(db, config, before.supplier_connection_id, Number(before.upstream_product_id))
        identity = selectedUpstreamSku(product, before.upstream_sku_type, before.upstream_sku_code)
      } catch (error) {
        if (!(error instanceof MappingAdminError) || !error.code.startsWith('UPSTREAM_SKU_')) throw error
        const mapping = await markMappingStale(db, id, body.expectedRevision, request.admin!.id, error.code)
        const issue: SupplierProductMappingIssue = { code: error.code, localFieldId: null, localOptionId: null, upstreamPath: null, blocking: true }
        return reply.send(success({ mapping, observation: null, issues: [issue], structureChanged: false,
          configurationChanged: false, templateChanged: false, identityChanged: true }, request.id))
      }
      const snapshot = supplierProductStructureSnapshot(product, identity.skuCode)
      const fingerprint = digest(snapshot)
      const structureChanged = before.upstream_structure_sha256 !== fingerprint
      const configurationChanged = before.supplier_connection_version_id !== product.source.configurationVersionId
      let templateChanged = false
      let observationId = ''
      await db.transaction().execute(async trx => {
        const locked = await lockMappingTarget(trx, {
          productId: before.product_id, skuId: before.product_variant_id,
          connectionId: before.supplier_connection_id, configurationVersionId: product.source.configurationVersionId,
          templateVersionId: before.template_version_id, mappingId: id, expectedRevision: body.expectedRevision,
          allowTemplateDrift: true,
        })
        templateChanged = locked.appliedTemplate?.id !== before.template_version_id
        const nextStatus: SupplierMappingStatus = structureChanged || configurationChanged || templateChanged
          ? 'stale' : locked.mapping!.status
        const shouldUpdate = structureChanged || configurationChanged || templateChanged
        if (shouldUpdate) {
          const revision = body.expectedRevision + 1
          await trx.updateTable('supplier_product_mapping_heads').set({
            status: nextStatus, revision,
            supplier_connection_version_id: product.source.configurationVersionId,
            upstream_product_name: product.name, upstream_sku_type: identity.skuType,
            upstream_sku_code: identity.skuCode, upstream_combination: JSON.stringify(identity.combination),
            upstream_structure_snapshot: snapshot as unknown as Record<string, unknown>,
            upstream_structure_sha256: fingerprint, upstream_observed_at: new Date(product.source.readAt),
            updated_by_admin_id: request.admin!.id,
          }).where('id', '=', id).execute()
          await recordAudit(trx, { mappingId: id, productId: before.product_id, skuId: before.product_variant_id,
            administratorId: request.admin!.id, operation: structureChanged || configurationChanged || templateChanged ? 'marked_stale' : 'draft_saved',
            revision, summary: { structureChanged, configurationChanged, templateChanged,
              oldFingerprint: before.upstream_structure_sha256, newFingerprint: fingerprint } })
        }
        observationId = await insertObservation(trx, request.admin!.id, product, identity)
      })
      const mapping = await loadMapping(db, id)
      const fullObservation = await loadObservation(db, observationId, request.admin!.id)
      const { structureSnapshot: _structureSnapshot, ...observation } = fullObservation
      return reply.send(success({ mapping, observation, issues: mapping.issues,
        structureChanged, configurationChanged, templateChanged, identityChanged: false }, request.id))
    } catch (error) { return sendError(reply, error, request.id) }
  })

  app.post('/api/v1/admin/supplier-product-mappings/:id/review', {
    preHandler: protectedWrite,
    schema: { tags: ['admin', 'catalog'], summary: 'Append an immutable reviewed mapping version after revalidation',
      params: SupplierProductMappingIdParamsSchema, body: SupplierProductMappingRevisionBodySchema,
      response: { 200: ApiSuccessSchemaOf(SupplierProductMappingReviewOutcomeSchema), ...errorSchemas } },
  }, async (request, reply) => {
    const id = (request.params as { id: string }).id
    const body = request.body as { expectedRevision: number }
    const administratorId = request.admin!.id
    try {
      const before = await db.selectFrom('supplier_product_mapping_heads').selectAll().where('id', '=', id).executeTakeFirst()
      if (!before) throw new MappingAdminError(404, 'SUPPLIER_MAPPING_NOT_FOUND', '供应商映射不存在。')
      if (before.revision !== body.expectedRevision) throw new MappingAdminError(409, 'SUPPLIER_MAPPING_REVISION_CONFLICT', '映射已被其他管理员修改，请重新读取。')
      const current = await currentTemplate(db, before.product_variant_id)
      if (!current || current.id !== before.template_version_id) {
        const mapping = await markMappingStale(db, id, body.expectedRevision, administratorId, 'LOCAL_APPLIED_TEMPLATE_VERSION_CHANGED')
        return reply.send(success({ reviewed: false, mapping, issues: mapping.issues }, request.id))
      }
      const product = await readCurrentKayixinGoodDetail(db, config, before.supplier_connection_id,
        Number(before.upstream_product_id), before.supplier_connection_version_id)
      const identity = selectedUpstreamSku(product, before.upstream_sku_type, before.upstream_sku_code)
      const snapshot = supplierProductStructureSnapshot(product, identity.skuCode)
      const fingerprint = digest(snapshot)
      if (fingerprint !== before.upstream_structure_sha256) {
        const refreshed = await db.transaction().execute(async trx => {
          const locked = await lockMappingTarget(trx, { productId: before.product_id, skuId: before.product_variant_id,
            connectionId: before.supplier_connection_id, configurationVersionId: product.source.configurationVersionId,
            templateVersionId: before.template_version_id, mappingId: id, expectedRevision: body.expectedRevision })
          const revision = body.expectedRevision + 1
          await trx.updateTable('supplier_product_mapping_heads').set({ status: 'stale', revision,
            upstream_product_name: product.name, upstream_sku_type: identity.skuType, upstream_sku_code: identity.skuCode,
            upstream_combination: JSON.stringify(identity.combination), upstream_structure_snapshot: snapshot as unknown as Record<string, unknown>,
            upstream_structure_sha256: fingerprint, upstream_observed_at: new Date(product.source.readAt),
            updated_by_admin_id: administratorId }).where('id', '=', id).execute()
          await recordAudit(trx, { mappingId: id, productId: before.product_id, skuId: before.product_variant_id,
            administratorId, operation: 'marked_stale', revision,
            summary: { issueCode: 'UPSTREAM_STRUCTURE_CHANGED', oldFingerprint: before.upstream_structure_sha256, newFingerprint: fingerprint } })
          return locked
        })
        void refreshed
        const mapping = await loadMapping(db, id)
        const issues = [...mapping.issues, { code: 'UPSTREAM_STRUCTURE_CHANGED', localFieldId: null, localOptionId: null, upstreamPath: null, blocking: true }]
        return reply.send(success({ reviewed: false, mapping: { ...mapping, issues }, issues }, request.id))
      }
      const rules = before.rules as unknown as SupplierMappingRules
      const issues = safeIssues(product, current, snapshot, rules)
      if (issues.some(issue => issue.blocking)) {
        const mapping = await loadMapping(db, id)
        return reply.send(success({ reviewed: false, mapping: { ...mapping, issues }, issues }, request.id))
      }
      await db.transaction().execute(async trx => {
        const context = await lockMappingTarget(trx, { productId: before.product_id, skuId: before.product_variant_id,
          connectionId: before.supplier_connection_id, configurationVersionId: product.source.configurationVersionId,
          templateVersionId: before.template_version_id, mappingId: id, expectedRevision: body.expectedRevision })
        const locked = context.mapping!
        const currentSnapshot = locked.upstream_structure_snapshot as unknown as ReturnType<typeof supplierProductStructureSnapshot>
        if (digest(currentSnapshot) !== fingerprint || locked.upstream_structure_sha256 !== fingerprint) {
          throw new MappingAdminError(409, 'UPSTREAM_STRUCTURE_CHANGED', '审核期间上游字段结构发生变化，请刷新并重新核对。')
        }
        const checked = safeIssues(product, context.template, currentSnapshot, locked.rules as unknown as SupplierMappingRules)
        if (checked.some(issue => issue.blocking)) throw new MappingAdminError(409, 'SUPPLIER_MAPPING_REVIEW_BLOCKED', '映射校验未通过，请处理缺失、冲突或未验证结构。')
        const versionId = randomUUID()
        const versionNumber = locked.latest_version_number + 1
        await trx.insertInto('supplier_product_mapping_versions').values({
          id: versionId, mapping_id: id, version_number: versionNumber,
          product_id: locked.product_id, product_variant_id: locked.product_variant_id,
          supplier_connection_id: locked.supplier_connection_id, supplier_connection_version_id: locked.supplier_connection_version_id,
          provider_type: 'kayixin_customer_v3', upstream_product_id: locked.upstream_product_id,
          upstream_product_name: locked.upstream_product_name, upstream_sku_type: locked.upstream_sku_type,
          upstream_sku_code: locked.upstream_sku_code, upstream_combination: JSON.stringify(locked.upstream_combination),
          upstream_structure_snapshot: locked.upstream_structure_snapshot,
          upstream_structure_sha256: locked.upstream_structure_sha256, upstream_observed_at: locked.upstream_observed_at,
          template_id: locked.template_id, template_version_id: locked.template_version_id,
          template_sha256: locked.template_sha256, normalization_version: locked.normalization_version,
          rules_version: 1, rules: locked.rules, rules_sha256: locked.rules_sha256,
          administrator_id: administratorId,
        }).execute()
        const revision = locked.revision + 1
        await trx.updateTable('supplier_product_mapping_heads').set({ status: 'reviewed', revision,
          latest_review_version_id: versionId, latest_version_number: versionNumber,
          updated_by_admin_id: administratorId }).where('id', '=', id).execute()
        await recordAudit(trx, { mappingId: id, productId: locked.product_id, skuId: locked.product_variant_id,
          administratorId, operation: 'reviewed', mappingVersionId: versionId, revision,
          summary: { versionNumber, rulesDigest: locked.rules_sha256,
            structureFingerprint: locked.upstream_structure_sha256, issueCodes: checked.map(issue => issue.code) } })
      })
      const mapping = await loadMapping(db, id)
      return reply.send(success({ reviewed: true, mapping, issues: mapping.issues }, request.id))
    } catch (error) { return sendError(reply, error, request.id) }
  })

  app.get('/api/v1/admin/supplier-product-mappings/:id/history', {
    preHandler: authenticate,
    schema: { tags: ['admin', 'catalog'], summary: 'Read immutable supplier mapping review versions and audit events',
      params: SupplierProductMappingIdParamsSchema, querystring: SupplierProductMappingHistoryQuerySchema,
      response: { 200: ApiSuccessSchemaOf(SupplierProductMappingHistorySchema), ...errorSchemas } },
  }, async (request, reply) => {
    try {
      const id = (request.params as { id: string }).id
      const query = request.query as { page?: number; pageSize?: number }
      const page = query.page ?? 1, pageSize = query.pageSize ?? pageSizeDefault
      const [rows, count, events] = await Promise.all([
        db.selectFrom('supplier_product_mapping_versions as history')
          .innerJoin('supplier_connection_versions as connection_version', 'connection_version.id', 'history.supplier_connection_version_id')
          .innerJoin('purchase_form_template_versions as template_version', 'template_version.id', 'history.template_version_id')
          .selectAll('history').select(['connection_version.version_number as configuration_version_number',
            'template_version.name as template_name', 'template_version.version_number as template_version_number',
            'template_version.definition as template_definition'])
          .where('history.mapping_id', '=', id).orderBy('history.version_number', 'desc')
          .limit(pageSize).offset((page - 1) * pageSize).execute(),
        db.selectFrom('supplier_product_mapping_versions').select(db.fn.countAll<number>().as('total'))
          .where('mapping_id', '=', id).executeTakeFirstOrThrow(),
        db.selectFrom('supplier_product_mapping_audit_events').selectAll().where('mapping_id', '=', id)
          .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(100).execute(),
      ])
      const items: SupplierProductMappingVersion[] = rows.map(row => ({
        id: row.id, mappingId: row.mapping_id, versionNumber: row.version_number,
        productId: row.product_id, skuId: row.product_variant_id,
        connectionId: row.supplier_connection_id, configurationVersionId: row.supplier_connection_version_id,
        configurationVersionNumber: row.configuration_version_number, upstreamProductId: row.upstream_product_id,
        upstreamProductName: row.upstream_product_name, upstreamSkuType: row.upstream_sku_type,
        upstreamSkuCode: row.upstream_sku_code,
        upstreamCombination: row.upstream_combination as Array<{ title: string; value: string }>,
        structureSnapshot: row.upstream_structure_snapshot as never, structureFingerprint: row.upstream_structure_sha256,
        observedAt: row.upstream_observed_at.toISOString(), templateVersion: { id: row.template_version_id,
          templateId: row.template_id, name: row.template_name, versionNumber: row.template_version_number,
          sha256: row.template_sha256, normalizationVersion: row.normalization_version },
        templateDefinition: row.template_definition as never, rules: row.rules as unknown as SupplierMappingRules,
        rulesSha256: row.rules_sha256, administratorId: row.administrator_id, reviewedAt: row.reviewed_at.toISOString(),
      }))
      return reply.send(success({ items, events: events.map(event => ({ id: event.id, operation: event.operation,
        administratorId: event.administrator_id, mappingVersionId: event.mapping_version_id, revision: event.revision,
        summary: event.summary, createdAt: event.created_at.toISOString() })), total: Number(count.total), page, pageSize }, request.id))
    } catch (error) { return sendError(reply, error, request.id) }
  })

  app.post('/api/v1/admin/supplier-product-mappings/:id/restore', {
    preHandler: protectedWrite,
    schema: { tags: ['admin', 'catalog'], summary: 'Restore an immutable reviewed version as a new draft',
      params: SupplierProductMappingIdParamsSchema, body: SupplierProductMappingRestoreBodySchema,
      response: { 200: ApiSuccessSchemaOf(SupplierProductMappingSchema), ...errorSchemas } },
  }, async (request, reply) => {
    const id = (request.params as { id: string }).id
    const body = request.body as SupplierProductMappingRestoreBody
    try {
      const version = await db.selectFrom('supplier_product_mapping_versions as history')
        .innerJoin('supplier_connection_versions as connection_version', 'connection_version.id', 'history.supplier_connection_version_id')
        .innerJoin('purchase_form_template_versions as template_version', 'template_version.id', 'history.template_version_id')
        .selectAll('history').select(['connection_version.version_number as configuration_version_number',
          'template_version.name as template_name', 'template_version.version_number as template_version_number',
          'template_version.definition as template_definition'])
        .where('history.id', '=', body.versionId).where('history.mapping_id', '=', id).executeTakeFirst()
      if (!version) throw new MappingAdminError(404, 'SUPPLIER_MAPPING_VERSION_NOT_FOUND', '目标审核版本不存在。')
      const typedVersion: SupplierProductMappingVersion = {
        id: version.id, mappingId: version.mapping_id, versionNumber: version.version_number,
        productId: version.product_id, skuId: version.product_variant_id, connectionId: version.supplier_connection_id,
        configurationVersionId: version.supplier_connection_version_id, configurationVersionNumber: version.configuration_version_number,
        upstreamProductId: version.upstream_product_id, upstreamProductName: version.upstream_product_name,
        upstreamSkuType: version.upstream_sku_type,
        upstreamSkuCode: version.upstream_sku_code, upstreamCombination: version.upstream_combination as Array<{ title: string; value: string }>,
        structureSnapshot: version.upstream_structure_snapshot as never, structureFingerprint: version.upstream_structure_sha256,
        observedAt: version.upstream_observed_at.toISOString(), templateVersion: { id: version.template_version_id,
          templateId: version.template_id, name: version.template_name, versionNumber: version.template_version_number,
          sha256: version.template_sha256, normalizationVersion: version.normalization_version },
        templateDefinition: version.template_definition as never, rules: version.rules as unknown as SupplierMappingRules,
        rulesSha256: version.rules_sha256, administratorId: version.administrator_id, reviewedAt: version.reviewed_at.toISOString(),
      }
      await db.transaction().execute(async trx => {
        const context = await lockMappingTarget(trx, { productId: typedVersion.productId, skuId: typedVersion.skuId,
          connectionId: typedVersion.connectionId, configurationVersionId: typedVersion.configurationVersionId,
          templateVersionId: typedVersion.templateVersion.id, mappingId: id, expectedRevision: body.expectedRevision,
          allowTemplateDrift: true, allowSourceDrift: true })
        const revision = body.expectedRevision + 1
        await trx.updateTable('supplier_product_mapping_heads').set({ ...mappingDataFromVersion(typedVersion),
          status: 'draft', revision, updated_by_admin_id: request.admin!.id }).where('id', '=', id).execute()
        await recordAudit(trx, { mappingId: id, productId: typedVersion.productId, skuId: typedVersion.skuId,
          administratorId: request.admin!.id, operation: 'restored', revision,
          summary: { restoredVersionId: typedVersion.id, restoredVersionNumber: typedVersion.versionNumber } })
        void context
      })
      return reply.send(success(await loadMapping(db, id), request.id))
    } catch (error) { return sendError(reply, error, request.id) }
  })
}
