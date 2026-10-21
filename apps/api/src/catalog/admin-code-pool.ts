import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CodePoolBatchPageSchema,
  CodePoolEntryPageSchema,
  CodePoolImportBodySchema,
  CodePoolImportPreviewBodySchema,
  CodePoolImportPreviewSchema,
  CodePoolListQuerySchema,
  CodePoolMutationResultSchema,
  CodePoolReadinessBodySchema,
  CodePoolStatusSchema,
  CodePoolWithdrawalBodySchema,
  ProductVariantIdParamsSchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  CodePoolBatch,
  CodePoolFormat,
  CodePoolImportBody,
  CodePoolImportPreview,
  CodePoolReadinessBody,
  CodePoolStatus,
  CodePoolWithdrawalBody,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { CodePoolBatchKind, Database } from '../db/types.js'
import {
  CodePoolKeyUnavailableError,
  codePoolFingerprint,
  codePoolFingerprints,
  codePoolOperationFingerprints,
  encryptCodePoolContent,
  requiredCodePoolKeyRing,
} from '../commerce/code-pool-crypto.js'

const maxPoolQuantity = 2_147_483_647
const maxImportRows = 5000

class CodePoolError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'CodePoolError'
  }
}

type Db = Kysely<Database> | Transaction<Database>
type ParsedRow = { row: number; code: string; invalidReason: null } | { row: number; code: null; invalidReason: 'empty' | 'too_long' | 'invalid_text' | 'invalid_csv_row' }
type PreviewRow = CodePoolImportPreview['rows'][number]

function csvRows(sourceText: string): ParsedRow[] {
  const result: ParsedRow[] = []
  let recordStartLine = 1
  let line = 1
  let field = ''
  let fields: string[] = []
  let inQuotes = false
  let afterQuote = false
  let invalidRecord = false
  const endRecord = (nextRecordLine: number) => {
    fields.push(field)
    const isBlank = fields.length === 1 && fields[0] === ''
    if (!isBlank) {
      if (fields.length !== 1 || invalidRecord) {
        result.push({ row: recordStartLine, code: null, invalidReason: 'invalid_csv_row' })
      } else {
        result.push(validateRow(recordStartLine, fields[0]!))
      }
    }
    fields = []
    field = ''
    inQuotes = false
    afterQuote = false
    invalidRecord = false
    recordStartLine = nextRecordLine
  }

  for (let index = 0; index < sourceText.length; index += 1) {
    const character = sourceText[index]!
    const next = sourceText[index + 1]
    if (inQuotes) {
      if (character === '"') {
        if (next === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
          afterQuote = true
        }
      } else {
        field += character
        if (character === '\n') line += 1
      }
      continue
    }
    if (character === '"') {
      if (field.length > 0 || afterQuote) invalidRecord = true
      inQuotes = true
    } else if (character === ',') {
      fields.push(field)
      field = ''
      afterQuote = false
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && next === '\n') index += 1
      line += 1
      endRecord(line)
    } else if (afterQuote) {
      if (character !== ' ' && character !== '\t') invalidRecord = true
    } else {
      field += character
    }
  }
  if (inQuotes) invalidRecord = true
  if (fields.length > 0 || field.length > 0 || invalidRecord || sourceText.length === 0
    || !/[\r\n]$/u.test(sourceText)) {
    endRecord(line)
  }

  if (result[0]?.row === 1 && result[0].code !== null
    && ['code', '卡密'].includes(result[0].code.replace(/^\uFEFF/u, '').toLocaleLowerCase('zh-CN'))) {
    result.shift()
  }
  return result
}

function validateRow(row: number, code: string): ParsedRow {
  if (code.length === 0 || code.trim().length === 0) return { row, code: null, invalidReason: 'empty' }
  if ([...code].length > 512) return { row, code: null, invalidReason: 'too_long' }
  if (code.includes('\u0000')) return { row, code: null, invalidReason: 'invalid_text' }
  return { row, code, invalidReason: null }
}

function parseImportRows(format: CodePoolFormat, sourceText: string): ParsedRow[] {
  const rows = format === 'csv'
    ? csvRows(sourceText)
    : sourceText.split(/\r?\n/u).flatMap((code, index) => code === '' ? [] : [validateRow(index + 1, code)])
  if (rows.length > maxImportRows) {
    throw new CodePoolError(413, 'CODE_POOL_IMPORT_TOO_LARGE', `一次最多预检 ${maxImportRows} 条卡密。`)
  }
  if (rows.length === 0) throw new CodePoolError(400, 'CODE_POOL_IMPORT_EMPTY', '没有找到可导入的卡密记录。')
  return rows
}

async function duplicateFingerprints(db: Db, skuId: string, pairs: Array<{ keyId: string; fingerprint: string }>): Promise<Set<string>> {
  if (pairs.length === 0) return new Set()
  const keyIds = pairs.map(pair => pair.keyId)
  const fingerprints = pairs.map(pair => pair.fingerprint)
  const matches = await sql<{ fingerprint_key_id: string; content_fingerprint: string }>`
    WITH requested AS MATERIALIZED (
      SELECT pair.key_id, pair.fingerprint
      FROM unnest(${keyIds}::text[], ${fingerprints}::text[]) AS pair(key_id, fingerprint)
    )
    SELECT DISTINCT entry.fingerprint_key_id, entry.content_fingerprint
    FROM code_pool_entries AS entry
    JOIN requested ON requested.key_id = entry.fingerprint_key_id
      AND requested.fingerprint = entry.content_fingerprint
    WHERE entry.product_variant_id = ${skuId}::uuid
  `.execute(db)
  return new Set(matches.rows.map(row => `${row.fingerprint_key_id}:${row.content_fingerprint}`))
}

async function previewRows(
  db: Db,
  config: AppConfig,
  skuId: string,
  format: CodePoolFormat,
  sourceText: string,
): Promise<CodePoolImportPreview> {
  const parsed = parseImportRows(format, sourceText)
  const seen = new Set<string>()
  const fingerprints = new Map<number, Array<{ keyId: string; fingerprint: string }>>()
  for (const row of parsed) {
    if (row.code === null || seen.has(row.code)) continue
    seen.add(row.code)
    fingerprints.set(row.row, codePoolFingerprints(config, row.code))
  }
  const allPairs = [...fingerprints.values()].flat()
  const existing = await duplicateFingerprints(db, skuId, allPairs)
  const acceptedCodes = new Set<string>()
  const result: PreviewRow[] = parsed.map((row) => {
    if (row.code === null) return { row: row.row, status: 'invalid', reason: row.invalidReason }
    if (acceptedCodes.has(row.code)) return { row: row.row, status: 'duplicate', reason: 'duplicate_in_request' }
    acceptedCodes.add(row.code)
    const matches = fingerprints.get(row.row) ?? []
    if (matches.some(pair => existing.has(`${pair.keyId}:${pair.fingerprint}`))) {
      return { row: row.row, status: 'duplicate', reason: 'already_imported' }
    }
    return { row: row.row, status: 'accepted', reason: null }
  })
  return {
    rowCount: result.length,
    acceptedCount: result.filter(row => row.status === 'accepted').length,
    duplicateCount: result.filter(row => row.status === 'duplicate').length,
    invalidCount: result.filter(row => row.status === 'invalid').length,
    rows: result,
  }
}

async function assertCodePoolKeyHistoryAvailable(db: Db, config: AppConfig, skuId: string): Promise<void> {
  const ring = requiredCodePoolKeyRing(config)
  const result = await sql<{ encryption_key_id: string; fingerprint_key_id: string }>`
    SELECT DISTINCT encryption_key_id, fingerprint_key_id
    FROM code_pool_entries WHERE product_variant_id = ${skuId}::uuid
  `.execute(db)
  if (result.rows.some(row => !ring.keys[row.encryption_key_id] || !ring.keys[row.fingerprint_key_id])) {
    throw new CodePoolError(409, 'CODE_POOL_KEY_HISTORY_UNAVAILABLE', '密钥环缺少历史卡密所用密钥。恢复所有历史密钥后才能导入或开启销售。')
  }
}

function matchesOperationRequest(
  config: AppConfig,
  request: string,
  existing: { request_sha256: string; request_fingerprint_key_id: string | null },
): boolean {
  const ring = requiredCodePoolKeyRing(config)
  if (existing.request_fingerprint_key_id) {
    if (!ring.keys[existing.request_fingerprint_key_id]) {
      throw new CodePoolError(409, 'CODE_POOL_KEY_HISTORY_UNAVAILABLE', '密钥环缺少此历史批次操作摘要所用密钥，已阻止重放操作。')
    }
    return codePoolFingerprint(config, request, existing.request_fingerprint_key_id) === existing.request_sha256
  }

  // Legacy batches do not identify the HMAC key; verify their immutable digest
  // against each retained key rather than treating an unknown key as a match.
  return codePoolOperationFingerprints(config, request)
    .some(candidate => candidate.fingerprint === existing.request_sha256)
}

function batchDto(row: {
  id: string; operation_id: string; kind: CodePoolBatchKind; requested_count: number; accepted_count: number;
  duplicate_count: number; invalid_count: number; reason: string | null; created_by_admin_id: string; created_at: Date
}): CodePoolBatch {
  return {
    id: row.id,
    operationId: row.operation_id,
    kind: row.kind,
    requestedCount: row.requested_count,
    acceptedCount: row.accepted_count,
    duplicateCount: row.duplicate_count,
    invalidCount: row.invalid_count,
    reason: row.reason,
    administratorId: row.created_by_admin_id,
    createdAt: row.created_at.toISOString(),
  }
}

async function lockCodePoolSku(
  trx: Transaction<Database>, productId: string, skuId: string,
  lock: 'share' | 'update' = 'update',
): Promise<{ sku: { revision: number; inventory_revision: number; inventory_mode: string | null; enabled: boolean; retired_at: Date | null }; productType: string; method: string | null; ready: boolean; inventory: { stocked: number; reserved: number } | undefined }> {
  const product = await trx.selectFrom('products').select(['id', 'product_type'])
    .where('id', '=', productId).forShare().executeTakeFirst()
  if (!product) throw new CodePoolError(404, 'PRODUCT_NOT_FOUND', '商品不存在。')
  let skuQuery = trx.selectFrom('product_variants').select([
    'id', 'revision', 'inventory_revision', 'inventory_mode', 'enabled', 'retired_at',
  ]).where('product_id', '=', productId).where('id', '=', skuId)
  skuQuery = lock === 'update' ? skuQuery.forUpdate() : skuQuery.forShare()
  const sku = await skuQuery.executeTakeFirst()
  if (!sku) throw new CodePoolError(404, 'SKU_NOT_FOUND', '此 SKU 不属于该商品。')
  const inventory = sku.inventory_mode === 'quantity'
    ? await trx.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_id', '=', productId).where('product_variant_id', '=', skuId)
      .forUpdate().executeTakeFirst()
    : undefined
  let fulfillmentQuery = trx.selectFrom('product_variant_fulfillment').select(['method', 'code_pool_delivery_ready'])
    .where('product_variant_id', '=', skuId)
  fulfillmentQuery = lock === 'update' ? fulfillmentQuery.forUpdate() : fulfillmentQuery.forShare()
  const fulfillment = await fulfillmentQuery.executeTakeFirst()
  return {
    sku,
    productType: product.product_type,
    method: fulfillment?.method ?? null,
    ready: fulfillment?.code_pool_delivery_ready ?? false,
    inventory,
  }
}

async function readCodePoolStatus(db: Db, productId: string, skuId: string): Promise<CodePoolStatus | undefined> {
  const result = await sql<{
    method: string | null; ready: boolean; inventory_consistent: boolean;
    stocked: number | null; reserved: number | null; available_count: number; reserved_count: number;
    delivered_count: number; revoked_count: number
  }>`
    SELECT fulfillment.method,
      COALESCE(fulfillment.code_pool_delivery_ready, false) AS ready,
      assert_code_pool_inventory_consistency(variant.id) AS inventory_consistent,
      inventory.stocked, inventory.reserved,
      (SELECT count(*)::integer FROM code_pool_entries AS entry
        WHERE entry.product_variant_id = variant.id AND entry.state = 'available') AS available_count,
      (SELECT count(*)::integer FROM code_pool_entries AS entry
        WHERE entry.product_variant_id = variant.id AND entry.state = 'reserved') AS reserved_count,
      (SELECT count(*)::integer FROM code_pool_entries AS entry
        WHERE entry.product_variant_id = variant.id AND entry.state = 'delivered') AS delivered_count,
      (SELECT count(*)::integer FROM code_pool_entries AS entry
        WHERE entry.product_variant_id = variant.id AND entry.state = 'revoked') AS revoked_count
    FROM product_variants AS variant
    LEFT JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
    LEFT JOIN product_variant_quantity_inventory AS inventory
      ON inventory.product_id = variant.product_id AND inventory.product_variant_id = variant.id
    WHERE variant.product_id = ${productId}::uuid AND variant.id = ${skuId}::uuid
  `.execute(db)
  const row = result.rows[0]
  if (!row) return undefined
  const stocked = row.stocked ?? 0
  const reserved = row.reserved ?? 0
  return {
    productId,
    skuId,
    enabled: row.ready,
    configured: row.method === 'code_pool',
    inventoryConsistent: row.inventory_consistent,
    counts: {
      available: row.available_count,
      reserved: row.reserved_count,
      delivered: row.delivered_count,
      revoked: row.revoked_count,
    },
    inventory: { stocked, reserved, available: stocked - reserved },
  }
}

function codePoolFailure(reply: FastifyReply, error: unknown, requestId: string) {
  if (error instanceof CodePoolError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  if (error instanceof CodePoolKeyUnavailableError) {
    return reply.code(503).send(failure('CODE_POOL_KEY_UNAVAILABLE', '卡密加密密钥未配置，请先恢复服务端密钥后重试。', requestId))
  }
  let candidate = error
  let constraint: unknown
  let sqlState: unknown
  for (let depth = 0; depth < 5 && candidate && typeof candidate === 'object'; depth += 1) {
    const current = candidate as { constraint?: unknown; code?: unknown; cause?: unknown }
    if (constraint === undefined && typeof current.constraint === 'string') constraint = current.constraint
    if (sqlState === undefined && typeof current.code === 'string') sqlState = current.code
    candidate = current.cause
  }
  if (constraint === 'order_inventory_insufficient_code_pool') {
    return reply.code(409).send(failure('CODE_POOL_CHANGED', '卡密库存刚刚发生变化，请刷新后重试。', requestId))
  }
  if (constraint === 'code_pool_stock_requires_inventory_event'
    || constraint === 'code_pool_fulfillment_history_immutable'
    || constraint === 'code_pool_inventory_mode_immutable') {
    return reply.code(409).send(failure('CODE_POOL_HISTORY_PROTECTED', '卡密池已有记录，不能通过普通库存或 SKU 操作改写。', requestId))
  }
  if (sqlState === '23505') {
    return reply.code(409).send(failure('CODE_POOL_CONFLICT', '卡密池操作发生并发冲突，请刷新状态后重试。', requestId))
  }
  if (sqlState === '40001' || sqlState === '40P01') {
    return reply.code(409).send(failure('CODE_POOL_CONCURRENT_CONFLICT', 'SKU 库存正在并发变化，请刷新状态后重试。', requestId))
  }
  throw error
}

export function registerAdminCodePoolRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  app.get('/api/v1/admin/products/:id/variants/:variantId/code-pool', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Read code-pool counts without exposing credential contents',
      params: ProductVariantIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(CodePoolStatusSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { id: string; variantId: string }
    const status = await readCodePoolStatus(db, params.id, params.variantId)
    if (!status) return reply.code(404).send(failure('SKU_NOT_FOUND', '此 SKU 不属于该商品。', request.id))
    reply.header('cache-control', 'no-store')
    return success(status, request.id)
  })

  app.put('/api/v1/admin/products/:id/variants/:variantId/code-pool/readiness', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'], summary: 'Explicitly enable or pause new code-pool sales for one SKU',
      params: ProductVariantIdParamsSchema,
      body: CodePoolReadinessBodySchema,
      response: { 200: ApiSuccessSchemaOf(CodePoolStatusSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { id: string; variantId: string }
    const body = request.body as CodePoolReadinessBody
    try {
      const status = await db.transaction().execute(async (trx) => {
        const locked = await lockCodePoolSku(trx, params.id, params.variantId)
        if (locked.productType !== 'digital') throw new CodePoolError(409, 'CODE_POOL_DIGITAL_ONLY', '卡密池只适用于数字商品。')
        if (locked.sku.revision !== body.expectedSkuRevision) throw new CodePoolError(409, 'SKU_REVISION_CONFLICT', 'SKU 已发生变化，请刷新后重试。')
        if (locked.sku.inventory_revision !== body.expectedInventoryRevision) throw new CodePoolError(409, 'INVENTORY_REVISION_CONFLICT', '库存已发生变化，请刷新后重试。')
        if (locked.sku.inventory_mode !== 'quantity' || !locked.inventory) {
          throw new CodePoolError(409, 'CODE_POOL_QUANTITY_MODE_REQUIRED', '请先将 SKU 设置为 quantity 数量库存。')
        }
        if (body.enabled) {
          if (locked.sku.retired_at || !locked.sku.enabled) {
            throw new CodePoolError(409, 'SKU_NOT_SELLABLE', '已停用或退役的 SKU 不能启用卡密发放。')
          }
          await assertCodePoolKeyHistoryAvailable(trx, config, params.variantId)
          if (locked.method !== 'code_pool'
            && (locked.inventory.stocked !== 0 || locked.inventory.reserved !== 0)) {
            throw new CodePoolError(409, 'CODE_POOL_REQUIRES_EMPTY_INVENTORY', '启用卡密池前，请先通过现有库存调整记录将 SKU 数量库存清零。')
          }
          const consistency = await sql<{ consistent: boolean }>`
            SELECT assert_code_pool_inventory_consistency(${params.variantId}::uuid) AS consistent
          `.execute(trx)
          if (consistency.rows[0]?.consistent !== true) {
            throw new CodePoolError(409, 'CODE_POOL_INVENTORY_INCONSISTENT', '库存与卡密状态不一致，已阻止开启新销售。')
          }
        }
        if (body.enabled) {
          await trx.insertInto('product_variant_fulfillment').values({
            product_variant_id: params.variantId,
            method: 'code_pool',
            manual_delivery_ready: false,
            code_pool_delivery_ready: true,
          }).onConflict(conflict => conflict.column('product_variant_id').doUpdateSet({
            method: 'code_pool', manual_delivery_ready: false, code_pool_delivery_ready: true,
          })).execute()
        } else if (locked.method === 'code_pool') {
          await trx.updateTable('product_variant_fulfillment').set({ code_pool_delivery_ready: false })
            .where('product_variant_id', '=', params.variantId).execute()
        } else {
          if (locked.inventory.stocked !== 0 || locked.inventory.reserved !== 0) {
            throw new CodePoolError(409, 'CODE_POOL_REQUIRES_EMPTY_INVENTORY', '配置卡密池前，请先通过现有库存调整记录将 SKU 数量库存清零。')
          }
          await trx.insertInto('product_variant_fulfillment').values({
            product_variant_id: params.variantId,
            method: 'code_pool',
            manual_delivery_ready: false,
            code_pool_delivery_ready: false,
          }).onConflict(conflict => conflict.column('product_variant_id').doUpdateSet({
            method: 'code_pool', manual_delivery_ready: false, code_pool_delivery_ready: false,
          })).execute()
        }
        const current = await readCodePoolStatus(trx, params.id, params.variantId)
        if (!current) throw new CodePoolError(404, 'SKU_NOT_FOUND', '此 SKU 不属于该商品。')
        return current
      })
      reply.header('cache-control', 'no-store')
      return success(status, request.id)
    } catch (error) {
      return codePoolFailure(reply, error, request.id)
    }
  })

  app.post('/api/v1/admin/products/:id/variants/:variantId/code-pool/precheck', {
    bodyLimit: 4_300_000,
    preHandler: [authenticate, csrfCheck],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin', 'catalog'], summary: 'Preview code-pool import counts and invalid rows without returning code text',
      params: ProductVariantIdParamsSchema,
      body: CodePoolImportPreviewBodySchema,
      response: { 200: ApiSuccessSchemaOf(CodePoolImportPreviewSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 413: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { id: string; variantId: string }
    const body = request.body as { format: CodePoolFormat; sourceText: string }
    try {
      requiredCodePoolKeyRing(config)
      const preview = await db.transaction().execute(async (trx) => {
        const locked = await lockCodePoolSku(trx, params.id, params.variantId, 'share')
        if (locked.method !== 'code_pool' || locked.sku.inventory_mode !== 'quantity' || locked.productType !== 'digital') {
          throw new CodePoolError(409, 'CODE_POOL_NOT_CONFIGURED', '请先为数字商品 SKU 配置 quantity 卡密池。')
        }
        await assertCodePoolKeyHistoryAvailable(trx, config, params.variantId)
        return previewRows(trx, config, params.variantId, body.format, body.sourceText)
      })
      reply.header('cache-control', 'no-store')
      return success(preview, request.id)
    } catch (error) {
      if (error instanceof CodePoolError) return codePoolFailure(reply, error, request.id)
      return codePoolFailure(reply, error, request.id)
    }
  })

  app.post('/api/v1/admin/products/:id/variants/:variantId/code-pool/batches', {
    bodyLimit: 4_300_000,
    preHandler: [authenticate, csrfCheck],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin', 'catalog'], summary: 'Import encrypted code-pool credentials as one auditable batch',
      params: ProductVariantIdParamsSchema,
      body: CodePoolImportBodySchema,
      response: { 200: ApiSuccessSchemaOf(CodePoolMutationResultSchema), 201: ApiSuccessSchemaOf(CodePoolMutationResultSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 413: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { id: string; variantId: string }
    const body = request.body as CodePoolImportBody
    const administratorId = request.admin?.id
    if (!administratorId) return reply.code(401).send(failure('UNAUTHORIZED', '需要管理员登录。', request.id))
    try {
      requiredCodePoolKeyRing(config)
      const result = await db.transaction().execute(async (trx) => {
        const locked = await lockCodePoolSku(trx, params.id, params.variantId)
        if (locked.method !== 'code_pool' || locked.sku.inventory_mode !== 'quantity' || locked.productType !== 'digital' || !locked.inventory) {
          throw new CodePoolError(409, 'CODE_POOL_NOT_CONFIGURED', '请先为数字商品 SKU 配置 quantity 卡密池。')
        }
        await assertCodePoolKeyHistoryAvailable(trx, config, params.variantId)
        const request = JSON.stringify({ format: body.format, sourceText: body.sourceText })
        const ring = requiredCodePoolKeyRing(config)
        const requestHash = codePoolFingerprint(config, request, ring.activeKeyId)
        const existing = await trx.selectFrom('code_pool_batches').selectAll()
          .where('product_variant_id', '=', params.variantId).where('operation_id', '=', body.operationId).executeTakeFirst()
        if (existing) {
          if (existing.kind !== 'import' || !matchesOperationRequest(config, request, existing)) {
            throw new CodePoolError(409, 'CODE_POOL_OPERATION_CONFLICT', '该操作标识已用于不同的卡密导入请求。')
          }
          const status = await readCodePoolStatus(trx, params.id, params.variantId)
          if (!status) throw new CodePoolError(404, 'SKU_NOT_FOUND', '此 SKU 不属于该商品。')
          return { repeated: true, batch: batchDto(existing), status }
        }
        const preview = await previewRows(trx, config, params.variantId, body.format, body.sourceText)
        if (locked.inventory.stocked + preview.acceptedCount > maxPoolQuantity) {
          throw new CodePoolError(409, 'CODE_POOL_QUANTITY_OUT_OF_RANGE', '导入数量超过 SKU 可记录的库存上限。')
        }
        const parsed = parseImportRows(body.format, body.sourceText)
        const accepted = parsed.filter((row) => row.code !== null && preview.rows.some((previewRow) => previewRow.row === row.row && previewRow.status === 'accepted'))
        const batchId = randomUUID()
        await trx.insertInto('code_pool_batches').values({
          id: batchId,
          product_id: params.id,
          product_variant_id: params.variantId,
          operation_id: body.operationId,
          kind: 'import',
          request_sha256: requestHash,
          request_fingerprint_key_id: ring.activeKeyId,
          requested_count: preview.rowCount,
          accepted_count: preview.acceptedCount,
          duplicate_count: preview.duplicateCount,
          invalid_count: preview.invalidCount,
          reason: null,
          created_by_admin_id: administratorId,
        }).execute()
        const activeKeyId = ring.activeKeyId
        const entryValues = accepted.map((row) => {
          const code = row.code!
          const entryId = randomUUID()
          const encrypted = encryptForEntry(config, params.variantId, entryId, code)
          return {
            id: entryId,
            product_id: params.id,
            product_variant_id: params.variantId,
            import_batch_id: batchId,
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce,
            auth_tag: encrypted.authTag,
            encryption_key_id: encrypted.keyId,
            content_fingerprint: codePoolFingerprints(config, code).find(pair => pair.keyId === activeKeyId)!.fingerprint,
            fingerprint_key_id: activeKeyId,
            state: 'staged' as const,
            order_item_id: null,
            withdrawal_batch_id: null,
            reserved_at: null,
            delivered_at: null,
            revoked_at: null,
          }
        })
        if (entryValues.length > 0) {
          await trx.insertInto('code_pool_entries').values(entryValues).execute()
        }
        if (preview.acceptedCount > 0) {
          await trx.insertInto('order_inventory_events').values({
            id: randomUUID(),
            reservation_id: null,
            product_variant_id: params.variantId,
            code_pool_batch_id: batchId,
            operation_id: randomUUID(),
            action: 'restock',
            quantity: preview.acceptedCount,
          }).execute()
        }
        const batch = await trx.selectFrom('code_pool_batches').selectAll().where('id', '=', batchId).executeTakeFirstOrThrow()
        const status = await readCodePoolStatus(trx, params.id, params.variantId)
        if (!status) throw new CodePoolError(404, 'SKU_NOT_FOUND', '此 SKU 不属于该商品。')
        return { repeated: false, batch: batchDto(batch), status }
      })
      reply.header('cache-control', 'no-store')
      return reply.code(result.repeated ? 200 : 201).send(success(result, request.id))
    } catch (error) {
      return codePoolFailure(reply, error, request.id)
    }
  })

  app.post('/api/v1/admin/products/:id/variants/:variantId/code-pool/withdrawals', {
    preHandler: [authenticate, csrfCheck],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin', 'catalog'], summary: 'Safely revoke only currently unsold code-pool entries',
      params: ProductVariantIdParamsSchema,
      body: CodePoolWithdrawalBodySchema,
      response: { 200: ApiSuccessSchemaOf(CodePoolMutationResultSchema), 201: ApiSuccessSchemaOf(CodePoolMutationResultSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { id: string; variantId: string }
    const body = request.body as CodePoolWithdrawalBody
    const administratorId = request.admin?.id
    if (!administratorId) return reply.code(401).send(failure('UNAUTHORIZED', '需要管理员登录。', request.id))
    if (new Set(body.entryIds).size !== body.entryIds.length) {
      return reply.code(400).send(failure('DUPLICATE_CODE_POOL_ENTRY', '撤回清单中有重复卡密条目。', request.id))
    }
    try {
      const result = await db.transaction().execute(async (trx) => {
        const locked = await lockCodePoolSku(trx, params.id, params.variantId)
        if (locked.method !== 'code_pool' || locked.sku.inventory_mode !== 'quantity' || !locked.inventory) {
          throw new CodePoolError(409, 'CODE_POOL_NOT_CONFIGURED', '此 SKU 尚未配置 quantity 卡密池。')
        }
        await assertCodePoolKeyHistoryAvailable(trx, config, params.variantId)
        const request = JSON.stringify({
          entryIds: [...body.entryIds].sort(), reason: body.reason.trim(), confirmation: body.confirmation,
        })
        const ring = requiredCodePoolKeyRing(config)
        const requestHash = codePoolFingerprint(config, request, ring.activeKeyId)
        const existing = await trx.selectFrom('code_pool_batches').selectAll()
          .where('product_variant_id', '=', params.variantId).where('operation_id', '=', body.operationId).executeTakeFirst()
        if (existing) {
          if (existing.kind !== 'withdrawal' || !matchesOperationRequest(config, request, existing)) {
            throw new CodePoolError(409, 'CODE_POOL_OPERATION_CONFLICT', '该操作标识已用于不同的卡密撤回请求。')
          }
          const status = await readCodePoolStatus(trx, params.id, params.variantId)
          if (!status) throw new CodePoolError(404, 'SKU_NOT_FOUND', '此 SKU 不属于该商品。')
          return { repeated: true, batch: batchDto(existing), status }
        }
        const entries = await trx.selectFrom('code_pool_entries').select(['id', 'state'])
          .where('product_variant_id', '=', params.variantId).where('id', 'in', body.entryIds)
          .orderBy('id').forUpdate().execute()
        if (entries.length !== body.entryIds.length || entries.some(entry => entry.state !== 'available')) {
          throw new CodePoolError(409, 'CODE_POOL_ENTRY_NOT_WITHDRAWABLE', '撤回已取消：所选条目已预留、已交付或已撤回。只有全部仍未售出的卡密可以撤回。')
        }
        if (locked.inventory.stocked - locked.inventory.reserved < entries.length) {
          throw new CodePoolError(409, 'CODE_POOL_INVENTORY_INCONSISTENT', '库存与未售卡密数量不一致，已阻止撤回。')
        }
        const batchId = randomUUID()
        await trx.insertInto('code_pool_batches').values({
          id: batchId,
          product_id: params.id,
          product_variant_id: params.variantId,
          operation_id: body.operationId,
          kind: 'withdrawal',
          request_sha256: requestHash,
          request_fingerprint_key_id: ring.activeKeyId,
          requested_count: entries.length,
          accepted_count: entries.length,
          duplicate_count: 0,
          invalid_count: 0,
          reason: body.reason.trim(),
          created_by_admin_id: administratorId,
        }).execute()
        await trx.insertInto('code_pool_withdrawal_entries').values(entries.map(entry => ({
          batch_id: batchId,
          product_id: params.id,
          product_variant_id: params.variantId,
          entry_id: entry.id,
        }))).execute()
        await trx.insertInto('order_inventory_events').values({
          id: randomUUID(),
          reservation_id: null,
          product_variant_id: params.variantId,
          code_pool_batch_id: batchId,
          operation_id: randomUUID(),
          action: 'withdraw',
          quantity: entries.length,
        }).execute()
        const batch = await trx.selectFrom('code_pool_batches').selectAll().where('id', '=', batchId).executeTakeFirstOrThrow()
        const status = await readCodePoolStatus(trx, params.id, params.variantId)
        if (!status) throw new CodePoolError(404, 'SKU_NOT_FOUND', '此 SKU 不属于该商品。')
        return { repeated: false, batch: batchDto(batch), status }
      })
      reply.header('cache-control', 'no-store')
      return reply.code(result.repeated ? 200 : 201).send(success(result, request.id))
    } catch (error) {
      return codePoolFailure(reply, error, request.id)
    }
  })

  app.get('/api/v1/admin/products/:id/variants/:variantId/code-pool/batches', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'], summary: 'List code-pool import and withdrawal batch history',
      params: ProductVariantIdParamsSchema,
      querystring: CodePoolListQuerySchema,
      response: { 200: ApiSuccessSchemaOf(CodePoolBatchPageSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { id: string; variantId: string }
    const query = request.query as { page?: number; pageSize?: number }
    const page = query.page ?? 1
    const pageSize = Math.min(query.pageSize ?? 20, 100)
    const sku = await db.selectFrom('product_variants').select('id')
      .where('product_id', '=', params.id).where('id', '=', params.variantId).executeTakeFirst()
    if (!sku) return reply.code(404).send(failure('SKU_NOT_FOUND', '此 SKU 不属于该商品。', request.id))
    const count = await db.selectFrom('code_pool_batches').select(sql<number>`count(*)::integer`.as('count'))
      .where('product_variant_id', '=', params.variantId).executeTakeFirstOrThrow()
    const rows = await db.selectFrom('code_pool_batches').selectAll()
      .where('product_variant_id', '=', params.variantId).orderBy('created_at', 'desc').orderBy('id', 'desc')
      .limit(pageSize).offset((page - 1) * pageSize).execute()
    reply.header('cache-control', 'no-store')
    return success({
      items: rows.map(batchDto), total: count.count, page, pageSize,
      totalPages: count.count === 0 ? 0 : Math.ceil(count.count / pageSize),
    }, request.id)
  })

  app.get('/api/v1/admin/products/:id/variants/:variantId/code-pool/entries', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'], summary: 'List code-pool state metadata without returning card contents',
      params: ProductVariantIdParamsSchema,
      querystring: CodePoolListQuerySchema,
      response: { 200: ApiSuccessSchemaOf(CodePoolEntryPageSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { id: string; variantId: string }
    const query = request.query as { page?: number; pageSize?: number; status?: string; batchId?: string }
    const page = query.page ?? 1
    const pageSize = Math.min(query.pageSize ?? 20, 100)
    const sku = await db.selectFrom('product_variants').select('id')
      .where('product_id', '=', params.id).where('id', '=', params.variantId).executeTakeFirst()
    if (!sku) return reply.code(404).send(failure('SKU_NOT_FOUND', '此 SKU 不属于该商品。', request.id))
    let countQuery = db.selectFrom('code_pool_entries as entry').select(sql<number>`count(*)::integer`.as('count'))
      .where('entry.product_variant_id', '=', params.variantId).where('entry.state', '!=', 'staged')
    let entriesQuery = db.selectFrom('code_pool_entries as entry')
      .leftJoin('order_items as item', 'item.id', 'entry.order_item_id')
      .select([
        'entry.id', 'entry.import_batch_id', 'entry.state', 'entry.created_at', 'entry.reserved_at',
        'entry.delivered_at', 'entry.revoked_at', 'item.order_id as order_id',
      ])
      .where('entry.product_variant_id', '=', params.variantId).where('entry.state', '!=', 'staged')
    if (query.status && query.status !== 'all') {
      countQuery = countQuery.where('entry.state', '=', query.status as 'available' | 'reserved' | 'delivered' | 'revoked')
      entriesQuery = entriesQuery.where('entry.state', '=', query.status as 'available' | 'reserved' | 'delivered' | 'revoked')
    }
    if (query.batchId) {
      countQuery = countQuery.where('entry.import_batch_id', '=', query.batchId)
      entriesQuery = entriesQuery.where('entry.import_batch_id', '=', query.batchId)
    }
    const count = await countQuery.executeTakeFirstOrThrow()
    const rows = await entriesQuery.orderBy('entry.created_at', 'desc').orderBy('entry.id', 'desc')
      .limit(pageSize).offset((page - 1) * pageSize).execute()
    reply.header('cache-control', 'no-store')
    return success({
      items: rows.map(row => ({
        id: row.id,
        importBatchId: row.import_batch_id,
        state: row.state,
        orderId: row.order_id,
        createdAt: row.created_at.toISOString(),
        reservedAt: row.reserved_at?.toISOString() ?? null,
        deliveredAt: row.delivered_at?.toISOString() ?? null,
        revokedAt: row.revoked_at?.toISOString() ?? null,
      })),
      total: count.count,
      page,
      pageSize,
      totalPages: count.count === 0 ? 0 : Math.ceil(count.count / pageSize),
    }, request.id)
  })
}

function encryptForEntry(config: AppConfig, skuId: string, entryId: string, code: string) {
  return encryptCodePoolContent(config, `aikayun:code-pool:entry:v1:${skuId}:${entryId}`, code)
}
