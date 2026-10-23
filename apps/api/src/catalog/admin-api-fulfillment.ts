import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  AdminProductVariantParamsSchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  ApiFulfillmentConfigSchema,
  ApiFulfillmentHistoryPageSchema,
  ApiFulfillmentMutationResultSchema,
  SaveApiFulfillmentVersionBodySchema,
  UpdateApiFulfillmentReadinessBodySchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  ApiFulfillmentConfig,
  ApiFulfillmentHistoryItem,
  ApiFulfillmentHistoryPage,
  ApiFulfillmentMutationResult,
  SaveApiFulfillmentVersionBody,
  UpdateApiFulfillmentReadinessBody,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { Database } from '../db/types.js'

type Db = Kysely<Database> | Transaction<Database>

class ApiFulfillmentAdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'ApiFulfillmentAdminError'
  }
}

interface ApiFulfillmentRow {
  product_id: string
  product_type: ApiFulfillmentConfig['productType']
  sku_id: string
  method: ApiFulfillmentConfig['method']
  automatic_delivery_ready: boolean
  configuration_revision: number
  updated_at: Date | null
  supplier_connection_id: string | null
  supplier_connection_name: string | null
  supplier_enabled: boolean
  supplier_connection_version_id: string | null
  supplier_connection_version_number: number | null
  supplier_product_id: string | null
  supplier_parameters: Record<string, string> | null
  current_version_id: string | null
}

function validateParameters(parameters: Record<string, string>): Record<string, string> {
  const entries = Object.entries(parameters)
  if (entries.length > 20) throw new ApiFulfillmentAdminError(400, 'API_PARAMETERS_INVALID', '交付参数最多允许 20 项。')
  for (const [name, value] of entries) {
    const containsControl = typeof value === 'string' && [...value].some((character) => {
      const code = character.codePointAt(0)!
      return code <= 0x1f || code === 0x7f
    })
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(name) || /(?:secret|token|password|credential|authorization|signature|private.?key)/iu.test(name)
      || typeof value !== 'string' || value.length > 500 || containsControl) {
      throw new ApiFulfillmentAdminError(400, 'API_PARAMETERS_INVALID', '交付参数名称或值无效；认证信息只能保存在供应商连接凭据中。')
    }
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))
}

function handleError(reply: FastifyReply, error: unknown, requestId: string) {
  if (error instanceof ApiFulfillmentAdminError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { constraint?: unknown; cause?: unknown }
    if (candidate.constraint === 'code_pool_fulfillment_history_immutable'
      || candidate.constraint === 'code_pool_inventory_mode_immutable') {
      return reply.code(409).send(failure('FULFILLMENT_METHOD_PROTECTED', '卡密池历史仍在使用，不能切换此 SKU 的履约方式。', requestId))
    }
    if (candidate.constraint === 'api_delivery_supplier_disabled' || candidate.constraint === 'supplier_connection_test_required') {
      return reply.code(409).send(failure('SUPPLIER_NOT_READY', '供应商当前版本必须通过测试并启用后才能启用自动销售。', requestId))
    }
    current = candidate.cause
  }
  throw error
}

async function loadConfig(db: Db, productId: string, skuId: string): Promise<ApiFulfillmentConfig | undefined> {
  const result = await sql<ApiFulfillmentRow>`
    SELECT product.id AS product_id, product.product_type, variant.id AS sku_id,
      fulfillment.method,
      COALESCE(fulfillment.automatic_delivery_ready, false) AS automatic_delivery_ready,
      COALESCE(fulfillment.configuration_revision, 0)::integer AS configuration_revision,
      fulfillment.updated_at,
      supplier_connection.id AS supplier_connection_id,
      supplier_version.display_name AS supplier_connection_name,
      COALESCE(supplier_connection.enabled, false) AS supplier_enabled,
      supplier_version.id AS supplier_connection_version_id,
      supplier_version.version_number AS supplier_connection_version_number,
      fulfillment_version.supplier_product_id,
      fulfillment_version.supplier_parameters,
      fulfillment_version.id AS current_version_id
    FROM products AS product
    JOIN product_variants AS variant ON variant.product_id = product.id
    LEFT JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
    LEFT JOIN product_variant_fulfillment_versions AS fulfillment_version
      ON fulfillment_version.id = fulfillment.current_content_version_id AND fulfillment_version.method = 'api'
    LEFT JOIN supplier_connection_versions AS supplier_version
      ON supplier_version.id = fulfillment_version.supplier_connection_version_id
    LEFT JOIN supplier_connections AS supplier_connection ON supplier_connection.id = supplier_version.supplier_connection_id
    WHERE product.id = ${productId}::uuid AND variant.id = ${skuId}::uuid
  `.execute(db)
  const row = result.rows[0]
  if (!row) return undefined
  return {
    productId: row.product_id,
    skuId: row.sku_id,
    productType: row.product_type,
    method: row.method,
    automaticDeliveryReady: row.automatic_delivery_ready,
    configurationRevision: row.configuration_revision,
    updatedAt: row.updated_at?.toISOString() ?? null,
    supplierConnectionId: row.supplier_connection_id,
    supplierConnectionName: row.supplier_connection_name,
    supplierEnabled: row.supplier_enabled,
    supplierConnectionVersionId: row.supplier_connection_version_id,
    supplierConnectionVersionNumber: row.supplier_connection_version_number,
    supplierProductId: row.supplier_product_id,
    parameters: row.supplier_parameters ?? {},
    currentVersionId: row.current_version_id,
  }
}

async function loadHistory(db: Db, productId: string, skuId: string): Promise<ApiFulfillmentHistoryPage | undefined> {
  const exists = await db.selectFrom('product_variants').select('id')
    .where('product_id', '=', productId).where('id', '=', skuId).executeTakeFirst()
  if (!exists) return undefined
  const rows = await sql<ApiFulfillmentHistoryItem>`
    SELECT version.id, version.version_number AS "versionNumber",
      supplier_connection.id AS "supplierConnectionId",
      supplier_version.display_name AS "supplierConnectionName",
      supplier_version.id AS "supplierConnectionVersionId",
      supplier_version.version_number AS "supplierConnectionVersionNumber",
      version.supplier_product_id AS "supplierProductId",
      version.supplier_parameters AS parameters,
      version.created_at AS "createdAt"
    FROM product_variant_fulfillment_versions AS version
    JOIN supplier_connection_versions AS supplier_version
      ON supplier_version.id = version.supplier_connection_version_id
    JOIN supplier_connections AS supplier_connection ON supplier_connection.id = supplier_version.supplier_connection_id
    WHERE version.product_variant_id = ${skuId}::uuid AND version.method = 'api'
    ORDER BY version.version_number DESC LIMIT 50
  `.execute(db)
  const audit = await sql<ApiFulfillmentHistoryPage['events'][number]>`
    SELECT audit.id, audit.administrator_id AS "administratorId", audit.action,
      audit.details, audit.created_at AS "createdAt"
    FROM api_fulfillment_audit_events AS audit
    WHERE audit.product_variant_id = ${skuId}::uuid
    ORDER BY audit.created_at DESC, audit.id DESC LIMIT 100
  `.execute(db)
  return { items: rows.rows.map(row => ({
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    parameters: row.parameters ?? {},
  })), total: rows.rows.length, page: 1, pageSize: 50,
  totalPages: rows.rows.length ? 1 : 0,
  events: audit.rows.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString() })) }
}

async function lockProductSkuAndConfig(trx: Transaction<Database>, productId: string, skuId: string) {
  const product = await trx.selectFrom('products').select(['id', 'product_type'])
    .where('id', '=', productId).forShare().executeTakeFirst()
  if (!product) throw new ApiFulfillmentAdminError(404, 'PRODUCT_NOT_FOUND', '商品不存在。')
  const sku = await trx.selectFrom('product_variants').select(['id', 'enabled', 'retired_at', 'inventory_mode'])
    .where('product_id', '=', productId).where('id', '=', skuId).forUpdate().executeTakeFirst()
  if (!sku) throw new ApiFulfillmentAdminError(404, 'SKU_NOT_FOUND', 'SKU 不属于此商品。')
  await trx.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
    .where('product_variant_id', '=', skuId).forUpdate().executeTakeFirst()
  const fulfillment = await trx.selectFrom('product_variant_fulfillment')
    .select(['method', 'automatic_delivery_ready', 'configuration_revision', 'current_content_version_id'])
    .where('product_variant_id', '=', skuId).forUpdate().executeTakeFirst()
  return { product, sku, fulfillment }
}

async function assertSupplierVersionMaySell(db: Db, connectionVersionId: string): Promise<void> {
  const supplier = await db.selectFrom('supplier_connection_versions as version')
    .innerJoin('supplier_connections as connection', 'connection.id', 'version.supplier_connection_id')
    .select(['connection.id', 'connection.enabled', 'connection.current_version_id', 'connection.tested_version_id'])
    .where('version.id', '=', connectionVersionId).executeTakeFirst()
  if (!supplier) throw new ApiFulfillmentAdminError(404, 'SUPPLIER_VERSION_NOT_FOUND', '供应商配置版本不存在。')
  if (!supplier.enabled || supplier.current_version_id !== connectionVersionId
    || supplier.tested_version_id !== connectionVersionId) {
    throw new ApiFulfillmentAdminError(409, 'SUPPLIER_NOT_READY', '只有通过当前连接和查单测试并已启用的供应商版本可用于自动销售。')
  }
}

export function registerAdminApiFulfillmentRoutes(
  app: FastifyInstance, db: Kysely<Database>, _config: AppConfig,
): void {
  const requireAdministrator = requireAdmin(db, _config)
  const adminCsrf = verifyCsrf(_config)

  app.get('/api/v1/admin/products/:id/variants/:variantId/api-fulfillment', {
    preHandler: requireAdministrator,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Read API fulfillment configuration without supplier secrets',
      params: AdminProductVariantParamsSchema,
      response: { 200: ApiSuccessSchemaOf(ApiFulfillmentConfigSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { id: string; variantId: string }
    const value = await loadConfig(db, params.id, params.variantId)
    if (!value) return reply.code(404).send(failure('SKU_NOT_FOUND', 'SKU 不属于此商品。', request.id))
    reply.header('cache-control', 'private, no-store')
    return success(value, request.id)
  })

  app.get('/api/v1/admin/products/:id/variants/:variantId/api-fulfillment/versions', {
    preHandler: requireAdministrator,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Read API fulfillment versions and operation audit history',
      params: AdminProductVariantParamsSchema,
      response: { 200: ApiSuccessSchemaOf(ApiFulfillmentHistoryPageSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { id: string; variantId: string }
    const page = await loadHistory(db, params.id, params.variantId)
    if (!page) return reply.code(404).send(failure('SKU_NOT_FOUND', 'SKU 不属于此商品。', request.id))
    reply.header('cache-control', 'private, no-store')
    return success(page, request.id)
  })

  app.post('/api/v1/admin/products/:id/variants/:variantId/api-fulfillment/versions', {
    preHandler: [requireAdministrator, adminCsrf],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin', 'catalog'], summary: 'Save an immutable API fulfillment version; automatic sales remain paused',
      params: AdminProductVariantParamsSchema,
      body: SaveApiFulfillmentVersionBodySchema,
      response: { 200: ApiSuccessSchemaOf(ApiFulfillmentMutationResultSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; variantId: string }
      const body = request.body as SaveApiFulfillmentVersionBody
      const parameters = validateParameters(body.parameters)
      const versionId = randomUUID()
      const digest = createHash('sha256').update(JSON.stringify({
        method: 'api', supplierConnectionVersionId: body.supplierConnectionVersionId,
        supplierProductId: body.supplierProductId.trim(), parameters,
      })).digest('hex')
      const value = await db.transaction().execute(async (trx) => {
        const locked = await lockProductSkuAndConfig(trx, params.id, params.variantId)
        if (locked.product.product_type !== 'digital') throw new ApiFulfillmentAdminError(409, 'DIGITAL_PRODUCT_REQUIRED', '外部 API 交付仅适用于数字商品。')
        if (!['quantity', 'unlimited'].includes(locked.sku.inventory_mode ?? '')) throw new ApiFulfillmentAdminError(409, 'DIGITAL_INVENTORY_MODE_UNSUPPORTED', '请先将 SKU 库存设置为 quantity 或 unlimited。')
        const currentRevision = locked.fulfillment?.configuration_revision ?? 0
        if (body.expectedRevision !== currentRevision) throw new ApiFulfillmentAdminError(409, 'FULFILLMENT_REVISION_CONFLICT', 'SKU 履约配置已被其他管理员修改，请刷新后再保存。')
        await assertSupplierVersionMaySell(trx, body.supplierConnectionVersionId)
        const nextVersion = await trx.selectFrom('product_variant_fulfillment_versions')
          .select(sql<number>`COALESCE(max(version_number), 0)::integer + 1`.as('version_number'))
          .where('product_variant_id', '=', params.variantId).executeTakeFirstOrThrow()
        const supplierVersion = await trx.selectFrom('supplier_connection_versions as version')
          .innerJoin('supplier_connections as connection', 'connection.id', 'version.supplier_connection_id')
          .select(['version.supplier_connection_id', 'version.display_name'])
          .where('version.id', '=', body.supplierConnectionVersionId).executeTakeFirstOrThrow()
        await trx.insertInto('product_variant_fulfillment_versions').values({
          id: versionId, product_variant_id: params.variantId, version_number: nextVersion.version_number,
          method: 'api', encrypted_content: null, content_nonce: null, content_auth_tag: null,
          encryption_key_id: null, content_sha256: digest, private_file_object_id: null, display_filename: null,
          supplier_connection_version_id: body.supplierConnectionVersionId,
          supplier_product_id: body.supplierProductId.trim(), supplier_parameters: parameters,
          created_by_admin_id: request.admin!.id,
        }).execute()
        if (!locked.fulfillment) {
          await trx.insertInto('product_variant_fulfillment').values({
            product_variant_id: params.variantId, method: 'api', manual_delivery_ready: false,
            code_pool_delivery_ready: false, automatic_delivery_ready: false,
            current_content_version_id: versionId, configuration_revision: 1,
          }).execute()
        } else {
          await trx.updateTable('product_variant_fulfillment').set({
            method: 'api', manual_delivery_ready: false, code_pool_delivery_ready: false,
            automatic_delivery_ready: false, current_content_version_id: versionId,
          }).where('product_variant_id', '=', params.variantId).execute()
        }
        await trx.insertInto('api_fulfillment_audit_events').values({
          id: randomUUID(), product_variant_id: params.variantId, fulfillment_version_id: versionId,
          supplier_connection_id: supplierVersion.supplier_connection_id, administrator_id: request.admin!.id,
          action: 'version_saved', details: {
            versionNumber: nextVersion.version_number,
            supplierConnectionVersionId: body.supplierConnectionVersionId,
            supplierProductId: body.supplierProductId.trim(), parameterNames: Object.keys(parameters).sort(),
            automaticDeliveryReady: false,
          },
        }).execute()
        const configuration = await loadConfig(trx, params.id, params.variantId)
        if (!configuration) throw new ApiFulfillmentAdminError(404, 'SKU_NOT_FOUND', 'SKU 不属于此商品。')
        const currentVersion: ApiFulfillmentHistoryItem = {
          id: versionId,
          versionNumber: nextVersion.version_number,
          supplierConnectionId: supplierVersion.supplier_connection_id,
          supplierConnectionName: supplierVersion.display_name,
          supplierConnectionVersionId: body.supplierConnectionVersionId,
          supplierConnectionVersionNumber: (await trx.selectFrom('supplier_connection_versions').select('version_number').where('id', '=', body.supplierConnectionVersionId).executeTakeFirstOrThrow()).version_number,
          supplierProductId: body.supplierProductId.trim(), parameters,
          createdAt: new Date().toISOString(),
        }
        return { configuration, currentVersion }
      })
      reply.header('cache-control', 'private, no-store')
      return success(value, request.id)
    } catch (error) {
      return handleError(reply, error, request.id)
    }
  })

  app.put('/api/v1/admin/products/:id/variants/:variantId/api-fulfillment/readiness', {
    preHandler: [requireAdministrator, adminCsrf],
    schema: {
      tags: ['admin', 'catalog'], summary: 'Explicitly enable or pause API-backed SKU sales',
      params: AdminProductVariantParamsSchema,
      body: UpdateApiFulfillmentReadinessBodySchema,
      response: { 200: ApiSuccessSchemaOf(ApiFulfillmentMutationResultSchema), 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; variantId: string }
      const body = request.body as UpdateApiFulfillmentReadinessBody
      const result: ApiFulfillmentMutationResult = await db.transaction().execute(async (trx) => {
        const locked = await lockProductSkuAndConfig(trx, params.id, params.variantId)
        const revision = locked.fulfillment?.configuration_revision ?? 0
        if (body.expectedRevision !== revision) throw new ApiFulfillmentAdminError(409, 'FULFILLMENT_REVISION_CONFLICT', 'SKU 履约配置已被其他管理员修改。')
        if (!locked.fulfillment || locked.fulfillment.method !== 'api' || !locked.fulfillment.current_content_version_id) {
          throw new ApiFulfillmentAdminError(409, 'API_VERSION_REQUIRED', '请先保存 API 履约版本。')
        }
        if (body.enabled && (!locked.sku.enabled || locked.sku.retired_at || locked.product.product_type !== 'digital')) {
          throw new ApiFulfillmentAdminError(409, 'SKU_NOT_SELLABLE', '已停用或退役的 SKU 不能启用自动销售。')
        }
        const version = await trx.selectFrom('product_variant_fulfillment_versions')
          .innerJoin('supplier_connection_versions', 'supplier_connection_versions.id', 'product_variant_fulfillment_versions.supplier_connection_version_id')
          .select([
            'product_variant_fulfillment_versions.id',
            'product_variant_fulfillment_versions.supplier_connection_version_id',
            'product_variant_fulfillment_versions.supplier_product_id',
            'product_variant_fulfillment_versions.supplier_parameters',
            'product_variant_fulfillment_versions.version_number',
            'product_variant_fulfillment_versions.created_at',
            'supplier_connection_versions.supplier_connection_id',
          ])
          .where('product_variant_fulfillment_versions.id', '=', locked.fulfillment.current_content_version_id)
          .executeTakeFirst()
        if (!version || !version.supplier_connection_version_id) throw new ApiFulfillmentAdminError(409, 'API_VERSION_INVALID', 'API 履约版本不完整。')
        if (body.enabled) await assertSupplierVersionMaySell(trx, version.supplier_connection_version_id)
        await trx.updateTable('product_variant_fulfillment').set({ automatic_delivery_ready: body.enabled })
          .where('product_variant_id', '=', params.variantId).execute()
        await trx.insertInto('api_fulfillment_audit_events').values({
          id: randomUUID(), product_variant_id: params.variantId,
          fulfillment_version_id: locked.fulfillment.current_content_version_id,
          supplier_connection_id: version.supplier_connection_id,
          administrator_id: request.admin!.id,
          action: body.enabled ? 'automatic_delivery_enabled' : 'automatic_delivery_paused',
          details: { enabled: body.enabled, configurationRevision: revision + 1 },
        }).execute()
        const configuration = await loadConfig(trx, params.id, params.variantId)
        if (!configuration) throw new ApiFulfillmentAdminError(404, 'SKU_NOT_FOUND', 'SKU 不属于此商品。')
        const currentVersion: ApiFulfillmentHistoryItem = {
          id: version.id, versionNumber: version.version_number,
          supplierConnectionId: version.supplier_connection_id,
          supplierConnectionName: configuration.supplierConnectionName ?? '供应商',
          supplierConnectionVersionId: version.supplier_connection_version_id,
          supplierConnectionVersionNumber: (await trx.selectFrom('supplier_connection_versions').select('version_number').where('id', '=', version.supplier_connection_version_id).executeTakeFirstOrThrow()).version_number,
          supplierProductId: version.supplier_product_id!, parameters: version.supplier_parameters ?? {},
          createdAt: version.created_at.toISOString(),
        }
        return { configuration, currentVersion }
      })
      reply.header('cache-control', 'private, no-store')
      return success(result, request.id)
    } catch (error) {
      return handleError(reply, error, request.id)
    }
  })
}
