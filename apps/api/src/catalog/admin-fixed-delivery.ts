import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  AdminProductVariantParamsSchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  FixedDeliveryConfigSchema,
  FixedDeliveryVersionSchema,
  FixedDeliveryVersionsQuerySchema,
  FixedDeliveryVersionsPageSchema,
  SaveFixedDeliveryVersionBodySchema,
  UpdateFixedDeliveryReadinessBodySchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  FixedDeliveryConfig,
  FixedDeliveryMethod,
  FixedDeliveryVersion,
  FixedDeliveryVersionsPage,
  FixedDeliveryVersionsQuery,
  SaveFixedDeliveryVersionBody,
  UpdateFixedDeliveryReadinessBody,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf as verifyAdminCsrf } from '../auth/admin.js'
import type { Database } from '../db/types.js'
import {
  decryptFixedDeliveryPayload,
  encryptFixedDeliveryPayload,
  fixedDeliveryPayloadDigest,
  FixedDeliveryDecryptionError,
  FixedDeliveryKeyUnavailableError,
  FixedDeliveryValidationError,
  fixedDeliveryVersionContext,
  normalizeFixedDeliveryUrl,
  validateFixedDeliveryPayload,
  type FixedDeliveryPayload,
} from '../commerce/fixed-delivery-crypto.js'

type Db = Kysely<Database> | Transaction<Database>

class FixedDeliveryAdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'FixedDeliveryAdminError'
  }
}

interface VersionRow {
  id: string
  version_number: number
  method: FixedDeliveryMethod
  product_variant_id: string
  encrypted_content: Buffer
  content_nonce: Buffer
  content_auth_tag: Buffer
  encryption_key_id: string
  created_at: Date
}

function decryptVersion(config: AppConfig, row: VersionRow): FixedDeliveryVersion {
  const payload = decryptFixedDeliveryPayload(
    config,
    fixedDeliveryVersionContext(row.product_variant_id, row.id, row.method),
    row.method,
    {
      keyId: row.encryption_key_id,
      nonce: row.content_nonce,
      ciphertext: row.encrypted_content,
      authTag: row.content_auth_tag,
    },
  )
  return {
    id: row.id,
    versionNumber: row.version_number,
    method: row.method,
    content: payload.method === 'fixed_content' ? payload.content : payload.url,
    title: payload.method === 'link' ? payload.title : null,
    accessInstructions: payload.method === 'link' ? payload.accessInstructions : null,
    createdAt: row.created_at.toISOString(),
  }
}

interface ConfigRow {
  product_id: string
  product_type: FixedDeliveryConfig['productType']
  sku_id: string
  method: FixedDeliveryConfig['method']
  automatic_delivery_ready: boolean
  configuration_revision: number
  updated_at: Date | null
  version_id: string | null
  version_number: number | null
  version_method: FixedDeliveryMethod | null
  version_product_variant_id: string | null
  encrypted_content: Buffer | null
  content_nonce: Buffer | null
  content_auth_tag: Buffer | null
  encryption_key_id: string | null
  version_created_at: Date | null
}

async function currentConfig(db: Db, productId: string, skuId: string, config: AppConfig): Promise<FixedDeliveryConfig | undefined> {
  const result = await sql<ConfigRow>`
    SELECT product.id AS product_id, product.product_type, variant.id AS sku_id,
      fulfillment.method,
      COALESCE(fulfillment.automatic_delivery_ready, false) AS automatic_delivery_ready,
      COALESCE(fulfillment.configuration_revision, 0)::integer AS configuration_revision,
      fulfillment.updated_at,
      version.id AS version_id, version.version_number, version.method AS version_method,
      version.product_variant_id AS version_product_variant_id, version.encrypted_content,
      version.content_nonce, version.content_auth_tag, version.encryption_key_id,
      version.created_at AS version_created_at
    FROM products AS product
    JOIN product_variants AS variant ON variant.product_id = product.id
    LEFT JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
    LEFT JOIN product_variant_fulfillment_versions AS version
      ON version.id = fulfillment.current_content_version_id
    WHERE product.id = ${productId}::uuid AND variant.id = ${skuId}::uuid
  `.execute(db)
  const row = result.rows[0]
  if (!row) return undefined
  let version: FixedDeliveryVersion | null = null
  if (row.version_id && row.version_number !== null && row.version_method && row.version_product_variant_id
    && row.encrypted_content && row.content_nonce && row.content_auth_tag && row.encryption_key_id && row.version_created_at) {
    version = decryptVersion(config, {
      id: row.version_id,
      version_number: row.version_number,
      method: row.version_method,
      product_variant_id: row.version_product_variant_id,
      encrypted_content: row.encrypted_content,
      content_nonce: row.content_nonce,
      content_auth_tag: row.content_auth_tag,
      encryption_key_id: row.encryption_key_id,
      created_at: row.version_created_at,
    })
  }
  return {
    productId: row.product_id,
    skuId: row.sku_id,
    productType: row.product_type,
    method: row.method,
    automaticDeliveryReady: row.automatic_delivery_ready,
    configurationRevision: row.configuration_revision,
    updatedAt: row.updated_at?.toISOString() ?? null,
    currentVersion: version,
  }
}

function adminFixedDeliveryError(reply: FastifyReply, error: unknown, requestId: string) {
  if (error instanceof FixedDeliveryAdminError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  if (error instanceof FixedDeliveryKeyUnavailableError) {
    return reply.code(503).send(failure('FIXED_DELIVERY_KEY_UNAVAILABLE', '数字交付密钥暂不可用，已阻止读取或启用。', requestId))
  }
  if (error instanceof FixedDeliveryDecryptionError) {
    return reply.code(503).send(failure('FIXED_DELIVERY_DECRYPTION_FAILED', '历史数字交付内容校验失败，已阻止读取或启用。', requestId))
  }
  if (error instanceof FixedDeliveryValidationError) {
    return reply.code(400).send(failure('FIXED_DELIVERY_CONTENT_INVALID', error.message, requestId))
  }
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { constraint?: unknown; cause?: unknown }
    if (candidate.constraint === 'code_pool_fulfillment_history_immutable'
      || candidate.constraint === 'code_pool_inventory_mode_immutable') {
      return reply.code(409).send(failure('FULFILLMENT_METHOD_PROTECTED', '卡密池历史仍在使用，不能切换此 SKU 的履约方式。', requestId))
    }
    current = candidate.cause
  }
  throw error
}

async function lockProductSkuAndConfig(
  trx: Transaction<Database>, productId: string, skuId: string,
): Promise<{
  productType: FixedDeliveryConfig['productType']
  enabled: boolean
  retiredAt: Date | null
  inventoryMode: string | null
  revision: number
  method: string | null
  currentVersionId: string | null
}> {
  const product = await trx.selectFrom('products').select(['id', 'product_type'])
    .where('id', '=', productId).forUpdate().executeTakeFirst()
  if (!product) throw new FixedDeliveryAdminError(404, 'PRODUCT_NOT_FOUND', '商品不存在。')
  const sku = await trx.selectFrom('product_variants')
    .select(['id', 'enabled', 'retired_at', 'inventory_mode'])
    .where('product_id', '=', productId).where('id', '=', skuId).forUpdate().executeTakeFirst()
  if (!sku) throw new FixedDeliveryAdminError(404, 'SKU_NOT_FOUND', 'SKU 不属于此商品。')
  await trx.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
    .where('product_variant_id', '=', skuId).forUpdate().executeTakeFirst()
  const fulfillment = await trx.selectFrom('product_variant_fulfillment')
    .select(['method', 'configuration_revision', 'current_content_version_id'])
    .where('product_variant_id', '=', skuId).forUpdate().executeTakeFirst()
  return {
    productType: product.product_type,
    enabled: sku.enabled,
    retiredAt: sku.retired_at,
    inventoryMode: sku.inventory_mode,
    revision: fulfillment?.configuration_revision ?? 0,
    method: fulfillment?.method ?? null,
    currentVersionId: fulfillment?.current_content_version_id ?? null,
  }
}

function assertRevision(expected: number, current: number): void {
  if (expected !== current) {
    throw new FixedDeliveryAdminError(409, 'FULFILLMENT_REVISION_CONFLICT', 'SKU 履约配置已被其他管理员修改。已保留当前编辑内容，请刷新历史版本后再决定是否重做保存。')
  }
}

async function assertVersionKeyHistoryAvailable(db: Db, config: AppConfig, skuId: string): Promise<void> {
  const ring = config.codePoolEncryptionKeyRing
  if (!ring) throw new FixedDeliveryKeyUnavailableError()
  const result = await sql<{ encryption_key_id: string }>`
    SELECT encryption_key_id FROM product_variant_fulfillment_versions
    WHERE product_variant_id = ${skuId}::uuid
    UNION
    SELECT delivery.encryption_key_id
    FROM order_item_fulfillment_deliveries AS delivery
    JOIN order_item_fulfillment_attempts AS attempt ON attempt.id = delivery.fulfillment_attempt_id
    JOIN order_items AS item ON item.id = attempt.order_item_id
    WHERE item.product_variant_id = ${skuId}::uuid
      AND delivery.delivery_source IN ('fixed_content', 'link')
  `.execute(db)
  if (result.rows.some(row => !ring.keys[row.encryption_key_id])) {
    throw new FixedDeliveryKeyUnavailableError()
  }
}

function parseSaveBody(body: SaveFixedDeliveryVersionBody): FixedDeliveryPayload {
  if (body.method === 'fixed_content') return validateFixedDeliveryPayload({
    method: 'fixed_content', content: body.content,
  })
  return validateFixedDeliveryPayload({
    method: 'link',
    url: normalizeFixedDeliveryUrl(body.url),
    title: body.title,
    accessInstructions: body.accessInstructions ?? null,
  })
}

export function registerAdminFixedDeliveryRoutes(
  app: FastifyInstance, db: Kysely<Database>, config: AppConfig,
): void {
  const requireAdministrator = requireAdmin(db, config)
  const adminCsrf = verifyAdminCsrf(config)

  app.get('/api/v1/admin/products/:id/variants/:variantId/fixed-delivery', {
    preHandler: requireAdministrator,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Read private fixed-content or link configuration for one SKU',
      params: AdminProductVariantParamsSchema,
      response: { 200: ApiSuccessSchemaOf(FixedDeliveryConfigSchema), 401: ApiErrorSchema, 404: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; variantId: string }
      const result = await currentConfig(db, params.id, params.variantId, config)
      if (!result) return reply.code(404).send(failure('SKU_NOT_FOUND', 'SKU 不属于此商品。', request.id))
      reply.header('cache-control', 'private, no-store')
      return success(result, request.id)
    } catch (error) {
      return adminFixedDeliveryError(reply, error, request.id)
    }
  })

  app.get('/api/v1/admin/products/:id/variants/:variantId/fixed-delivery/versions', {
    preHandler: requireAdministrator,
    schema: {
      tags: ['admin', 'catalog'], summary: 'List immutable fixed-delivery version metadata',
      params: AdminProductVariantParamsSchema,
      querystring: FixedDeliveryVersionsQuerySchema,
      response: { 200: ApiSuccessSchemaOf(FixedDeliveryVersionsPageSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { id: string; variantId: string }
    const query = request.query as FixedDeliveryVersionsQuery
    const exists = await db.selectFrom('product_variants').select('id')
      .where('product_id', '=', params.id).where('id', '=', params.variantId).executeTakeFirst()
    if (!exists) return reply.code(404).send(failure('SKU_NOT_FOUND', 'SKU 不属于此商品。', request.id))
    const page = query.page ?? 1
    const pageSize = Math.min(query.pageSize ?? 20, 50)
    const count = await db.selectFrom('product_variant_fulfillment_versions')
      .select(sql<number>`count(*)::integer`.as('count'))
      .where('product_variant_id', '=', params.variantId)
      .where('method', 'in', ['fixed_content', 'link']).executeTakeFirstOrThrow()
    const rows = await db.selectFrom('product_variant_fulfillment_versions')
      .select(['id', 'version_number', 'method', 'created_at'])
      .where('product_variant_id', '=', params.variantId)
      .where('method', 'in', ['fixed_content', 'link'])
      .orderBy('version_number', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute()
    const totalPages = count.count === 0 ? 0 : Math.ceil(count.count / pageSize)
    const result: FixedDeliveryVersionsPage = {
      items: rows.map(row => ({
        id: row.id,
        versionNumber: row.version_number,
        method: row.method as FixedDeliveryMethod,
        createdAt: row.created_at.toISOString(),
      })),
      total: count.count,
      page,
      pageSize,
      totalPages,
    }
    reply.header('cache-control', 'private, no-store')
    return success(result, request.id)
  })

  app.get('/api/v1/admin/products/:id/variants/:variantId/fixed-delivery/versions/:versionId', {
    preHandler: requireAdministrator,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Read one private immutable fixed-delivery version',
      params: {
        type: 'object', required: ['id', 'variantId', 'versionId'], additionalProperties: false,
        properties: { id: { type: 'string', format: 'uuid' }, variantId: { type: 'string', format: 'uuid' }, versionId: { type: 'string', format: 'uuid' } },
      },
      response: { 200: ApiSuccessSchemaOf(FixedDeliveryVersionSchema), 401: ApiErrorSchema, 404: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; variantId: string; versionId: string }
      const row = await db.selectFrom('product_variant_fulfillment_versions as version')
        .innerJoin('product_variants as variant', 'variant.id', 'version.product_variant_id')
        .select([
          'version.id', 'version.version_number', 'version.method', 'version.product_variant_id',
          'version.encrypted_content', 'version.content_nonce', 'version.content_auth_tag',
          'version.encryption_key_id', 'version.created_at',
        ])
        .where('variant.product_id', '=', params.id).where('version.product_variant_id', '=', params.variantId)
        .where('version.id', '=', params.versionId).where('version.method', 'in', ['fixed_content', 'link']).executeTakeFirst()
      if (!row || (row.method !== 'fixed_content' && row.method !== 'link')
        || !row.encrypted_content || !row.content_nonce || !row.content_auth_tag || !row.encryption_key_id) {
        return reply.code(404).send(failure('FULFILLMENT_VERSION_NOT_FOUND', '找不到此 SKU 的履约版本。', request.id))
      }
      const version = decryptVersion(config, {
        ...row,
        method: row.method as FixedDeliveryMethod,
        encrypted_content: row.encrypted_content!,
        content_nonce: row.content_nonce!,
        content_auth_tag: row.content_auth_tag!,
        encryption_key_id: row.encryption_key_id!,
      })
      reply.header('cache-control', 'private, no-store')
      return success(version, request.id)
    } catch (error) {
      return adminFixedDeliveryError(reply, error, request.id)
    }
  })

  app.post('/api/v1/admin/products/:id/variants/:variantId/fixed-delivery/versions', {
    preHandler: [requireAdministrator, adminCsrf],
    schema: {
      tags: ['admin', 'catalog'], summary: 'Create a new encrypted immutable fixed-delivery content version',
      params: AdminProductVariantParamsSchema,
      body: SaveFixedDeliveryVersionBodySchema,
      response: { 200: ApiSuccessSchemaOf(FixedDeliveryConfigSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; variantId: string }
      const body = request.body as SaveFixedDeliveryVersionBody
      const payload = parseSaveBody(body)
      const versionId = randomUUID()
      const envelope = encryptFixedDeliveryPayload(
        config,
        fixedDeliveryVersionContext(params.variantId, versionId, payload.method),
        payload,
      )
      const digest = fixedDeliveryPayloadDigest(config, payload, envelope.keyId)
      const result = await db.transaction().execute(async (trx) => {
        const locked = await lockProductSkuAndConfig(trx, params.id, params.variantId)
        if (locked.productType !== 'digital') {
          throw new FixedDeliveryAdminError(409, 'DIGITAL_PRODUCT_REQUIRED', '固定文本与固定链接仅适用于数字商品。')
        }
        if (locked.inventoryMode !== 'quantity' && locked.inventoryMode !== 'unlimited') {
          throw new FixedDeliveryAdminError(409, 'DIGITAL_INVENTORY_MODE_UNSUPPORTED', '请先将 SKU 库存设置为 quantity 或 unlimited。')
        }
        assertRevision(body.expectedRevision, locked.revision)
        const nextVersion = await trx.selectFrom('product_variant_fulfillment_versions')
          .select(sql<number>`COALESCE(max(version_number), 0)::integer + 1`.as('version_number'))
          .where('product_variant_id', '=', params.variantId).executeTakeFirstOrThrow()
        await trx.insertInto('product_variant_fulfillment_versions').values({
          id: versionId,
          product_variant_id: params.variantId,
          version_number: nextVersion.version_number,
          method: payload.method,
          encrypted_content: envelope.ciphertext,
          content_nonce: envelope.nonce,
          content_auth_tag: envelope.authTag,
          encryption_key_id: envelope.keyId,
          content_sha256: digest,
          created_by_admin_id: request.admin!.id,
        }).execute()
        if (locked.method === null) {
          await trx.insertInto('product_variant_fulfillment').values({
            product_variant_id: params.variantId,
            method: payload.method,
            manual_delivery_ready: false,
            code_pool_delivery_ready: false,
            automatic_delivery_ready: false,
            current_content_version_id: versionId,
            configuration_revision: 1,
          }).execute()
        } else {
          await trx.updateTable('product_variant_fulfillment').set({
            method: payload.method,
            manual_delivery_ready: false,
            code_pool_delivery_ready: false,
            automatic_delivery_ready: false,
            current_content_version_id: versionId,
          }).where('product_variant_id', '=', params.variantId).execute()
        }
        const current = await currentConfig(trx, params.id, params.variantId, config)
        if (!current) throw new FixedDeliveryAdminError(404, 'SKU_NOT_FOUND', 'SKU 不属于此商品。')
        return current
      })
      reply.header('cache-control', 'private, no-store')
      return success(result, request.id)
    } catch (error) {
      return adminFixedDeliveryError(reply, error, request.id)
    }
  })

  app.put('/api/v1/admin/products/:id/variants/:variantId/fixed-delivery/readiness', {
    preHandler: [requireAdministrator, adminCsrf],
    schema: {
      tags: ['admin', 'catalog'], summary: 'Explicitly enable or pause new automatic fixed-content or link sales',
      params: AdminProductVariantParamsSchema,
      body: UpdateFixedDeliveryReadinessBodySchema,
      response: { 200: ApiSuccessSchemaOf(FixedDeliveryConfigSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; variantId: string }
      const body = request.body as UpdateFixedDeliveryReadinessBody
      const result = await db.transaction().execute(async (trx) => {
        const locked = await lockProductSkuAndConfig(trx, params.id, params.variantId)
        assertRevision(body.expectedRevision, locked.revision)
        if (locked.method !== 'fixed_content' && locked.method !== 'link') {
          throw new FixedDeliveryAdminError(409, 'FIXED_DELIVERY_NOT_CONFIGURED', '请先保存固定文本或固定链接版本。')
        }
        if (!locked.currentVersionId) {
          throw new FixedDeliveryAdminError(409, 'FIXED_DELIVERY_VERSION_REQUIRED', '请先保存可交付的当前内容版本。')
        }
        if (body.enabled) {
          if (locked.productType !== 'digital' || !locked.enabled || locked.retiredAt
            || (locked.inventoryMode !== 'quantity' && locked.inventoryMode !== 'unlimited')) {
            throw new FixedDeliveryAdminError(409, 'FIXED_DELIVERY_SKU_NOT_SELLABLE', '只有启用、未退役且库存模式为 quantity 或 unlimited 的数字 SKU 才能开启自动交付。')
          }
          await assertVersionKeyHistoryAvailable(trx, config, params.variantId)
          const current = await trx.selectFrom('product_variant_fulfillment_versions')
            .select([
              'id', 'version_number', 'method', 'product_variant_id', 'encrypted_content',
              'content_nonce', 'content_auth_tag', 'encryption_key_id', 'created_at',
            ]).where('id', '=', locked.currentVersionId).where('method', 'in', ['fixed_content', 'link']).executeTakeFirst()
          if (!current || (current.method !== 'fixed_content' && current.method !== 'link')
            || !current.encrypted_content || !current.content_nonce || !current.content_auth_tag || !current.encryption_key_id) {
            throw new FixedDeliveryAdminError(409, 'FIXED_DELIVERY_VERSION_UNAVAILABLE', '当前版本记录不可用，已阻止开启。')
          }
          decryptVersion(config, {
            ...current,
            method: current.method as FixedDeliveryMethod,
            encrypted_content: current.encrypted_content!,
            content_nonce: current.content_nonce!,
            content_auth_tag: current.content_auth_tag!,
            encryption_key_id: current.encryption_key_id!,
          })
        }
        await trx.updateTable('product_variant_fulfillment').set({
          automatic_delivery_ready: body.enabled,
        }).where('product_variant_id', '=', params.variantId).execute()
        const saved = await currentConfig(trx, params.id, params.variantId, config)
        if (!saved) throw new FixedDeliveryAdminError(404, 'SKU_NOT_FOUND', 'SKU 不属于此商品。')
        return saved
      })
      reply.header('cache-control', 'private, no-store')
      return success(result, request.id)
    } catch (error) {
      return adminFixedDeliveryError(reply, error, request.id)
    }
  })
}
