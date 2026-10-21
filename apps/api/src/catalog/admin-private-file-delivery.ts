import multipart from '@fastify/multipart'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  AdminProductVariantParamsSchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  PrivateFileConfigSchema,
  PrivateFileUploadSchema,
  PrivateFileVersionSchema,
  PrivateFileVersionsPageSchema,
  PrivateFileVersionsQuerySchema,
  SavePrivateFileVersionBodySchema,
  UpdatePrivateFileReadinessBodySchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  PrivateFileConfig,
  PrivateFileIntegrityStatus,
  PrivateFileVersion,
  PrivateFileVersionsPage,
  PrivateFileVersionsQuery,
  SavePrivateFileVersionBody,
  UpdatePrivateFileReadinessBody,
} from '@aikayun/contracts'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { AppConfig } from '../config.js'
import type { Database, ProductType } from '../db/types.js'
import {
  PRIVATE_FILE_MAX_REQUEST_BYTES,
  PRIVATE_FILE_MAX_UPLOAD_BYTES,
  PRIVATE_FILE_STAGE_TTL_MS,
  PrivateFileError,
  PrivateFileStorage,
  newPrivateFileId,
  normalizeDisplayFilename,
  sanitizeUploadFilename,
} from '../media/private-file-storage.js'

type Db = Kysely<Database> | Transaction<Database>

class PrivateFileAdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'PrivateFileAdminError'
  }
}

interface FileObjectRow {
  id: string
  status: string
  media_type: string | null
  size_bytes: number | null
  sha256: string | null
}

interface FileVersionRow extends FileObjectRow {
  product_id: string
  product_type: ProductType
  sku_id: string
  method: string | null
  automatic_delivery_ready: boolean
  configuration_revision: number
  updated_at: Date | null
  version_id: string | null
  version_number: number | null
  display_filename: string | null
  version_created_at: Date | null
}

let activePrivateFileUploads = 0
const maxConcurrentPrivateFileUploads = 4
const multipartLimits = {
  fileSize: PRIVATE_FILE_MAX_UPLOAD_BYTES,
  files: 1,
  fields: 0,
  fieldSize: 0,
  fieldNameSize: 32,
  parts: 1,
  headerPairs: 20,
}

function errorResponse(reply: FastifyReply, error: unknown, requestId: string) {
  if (error instanceof PrivateFileAdminError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  if (error instanceof PrivateFileError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { constraint?: unknown; code?: unknown; cause?: unknown }
    if (candidate.constraint === 'fulfillment_configuration_revision_guard') {
      return reply.code(409).send(failure('FULFILLMENT_REVISION_CONFLICT', 'SKU 履约配置已变化，请刷新后重新确认。', requestId))
    }
    if (candidate.constraint === 'code_pool_fulfillment_history_immutable'
      || candidate.constraint === 'code_pool_inventory_mode_immutable') {
      return reply.code(409).send(failure('FULFILLMENT_METHOD_PROTECTED', 'SKU 的既有履约历史不允许切换到此方式。', requestId))
    }
    if (candidate.code === 'FST_REQ_FILE_TOO_LARGE' || candidate.code === 'FST_FILES_LIMIT') {
      return reply.code(413).send(failure('PRIVATE_FILE_TOO_LARGE', '数字商品文件不能超过 100 MiB。', requestId))
    }
    current = candidate.cause
  }
  return reply.code(500).send(failure('PRIVATE_FILE_OPERATION_FAILED', '私有文件操作暂时失败，请稍后重试。', requestId))
}

function requestLength(request: FastifyRequest): void {
  const value = request.headers['content-length']
  if (value === undefined) return
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    throw new PrivateFileAdminError(400, 'PRIVATE_FILE_LENGTH_INVALID', '上传长度无效。')
  }
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new PrivateFileAdminError(400, 'PRIVATE_FILE_LENGTH_INVALID', '上传长度无效。')
  }
  if (size > PRIVATE_FILE_MAX_REQUEST_BYTES) {
    throw new PrivateFileAdminError(413, 'PRIVATE_FILE_TOO_LARGE', '数字商品文件不能超过 100 MiB。')
  }
}

async function lockProductSkuAndConfig(
  trx: Transaction<Database>, productId: string, skuId: string,
): Promise<{
  productType: ProductType
  enabled: boolean
  retiredAt: Date | null
  inventoryMode: string | null
  revision: number
  method: string | null
  currentVersionId: string | null
}> {
  const product = await trx.selectFrom('products').select(['id', 'product_type'])
    .where('id', '=', productId).forUpdate().executeTakeFirst()
  if (!product) throw new PrivateFileAdminError(404, 'PRODUCT_NOT_FOUND', '商品不存在。')
  const sku = await trx.selectFrom('product_variants')
    .select(['id', 'enabled', 'retired_at', 'inventory_mode'])
    .where('product_id', '=', productId).where('id', '=', skuId).forUpdate().executeTakeFirst()
  if (!sku) throw new PrivateFileAdminError(404, 'SKU_NOT_FOUND', 'SKU 不属于此商品。')
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
    throw new PrivateFileAdminError(409, 'FULFILLMENT_REVISION_CONFLICT', 'SKU 履约配置已变化，请刷新后重新确认。')
  }
}

async function inspectObject(
  db: Db,
  storage: PrivateFileStorage,
  row: FileObjectRow,
  currentSale?: { skuId: string; versionId: string },
): Promise<PrivateFileIntegrityStatus> {
  if (!row.media_type || !row.size_bytes || !row.sha256) return 'unknown'
  let status: PrivateFileIntegrityStatus = 'verified'
  try {
    const opened = await storage.openVerified(row.id, { sizeBytes: row.size_bytes, sha256: row.sha256.trim() })
    await opened.handle.close()
  } catch (error) {
    status = error instanceof PrivateFileError && error.code === 'PRIVATE_FILE_INTEGRITY_FAILED'
      ? 'corrupt'
      : error instanceof PrivateFileError && error.code === 'PRIVATE_FILE_UNAVAILABLE'
        ? 'missing'
        : 'unknown'
  }
  if (status !== 'unknown') {
    const nextState = status === 'verified' ? 'available' : status
    if (row.status !== nextState) {
      if (status !== 'verified' && currentSale) {
        await pauseBrokenCurrentSale(db, currentSale.skuId, currentSale.versionId, status)
      }
      await db.updateTable('private_file_objects').set({ status: nextState })
        .where('id', '=', row.id).where('status', 'in', ['available', 'missing', 'corrupt']).execute()
    }
  }
  return status
}

async function pauseBrokenCurrentSale(db: Db, skuId: string, versionId: string, integrity: PrivateFileIntegrityStatus): Promise<void> {
  if (integrity === 'verified') return
  await db.updateTable('product_variant_fulfillment').set({ automatic_delivery_ready: false })
    .where('product_variant_id', '=', skuId).where('method', '=', 'file')
    .where('current_content_version_id', '=', versionId).where('automatic_delivery_ready', '=', true).execute()
}

async function loadFileConfig(
  db: Db,
  productId: string,
  skuId: string,
  storage: PrivateFileStorage,
  preverifiedObjectId?: string,
): Promise<PrivateFileConfig | undefined> {
  const row = await sql<FileVersionRow>`
    SELECT product.id AS product_id, product.product_type, variant.id AS sku_id,
      fulfillment.method,
      COALESCE(fulfillment.automatic_delivery_ready, false) AS automatic_delivery_ready,
      COALESCE(fulfillment.configuration_revision, 0)::integer AS configuration_revision,
      fulfillment.updated_at,
      version.id AS version_id, version.version_number, version.display_filename,
      version.created_at AS version_created_at,
      object.id AS id, object.status, object.media_type, object.size_bytes, object.sha256
    FROM products AS product
    JOIN product_variants AS variant ON variant.product_id = product.id
    LEFT JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
    LEFT JOIN product_variant_fulfillment_versions AS version
      ON version.id = fulfillment.current_content_version_id AND version.method = 'file'
    LEFT JOIN private_file_objects AS object ON object.id = version.private_file_object_id
    WHERE product.id = ${productId}::uuid AND variant.id = ${skuId}::uuid
  `.execute(db).then(result => result.rows[0])
  if (!row) return undefined
  let integrityStatus: PrivateFileIntegrityStatus = 'unknown'
  let currentVersion: PrivateFileVersion | null = null
  if (row.version_id && row.version_number !== null && row.display_filename && row.version_created_at
    && row.id && row.media_type && row.size_bytes !== null && row.sha256) {
    integrityStatus = row.id === preverifiedObjectId && row.status === 'available'
      ? 'verified'
      : await inspectObject(db, storage, row, { skuId: row.sku_id, versionId: row.version_id })
    await pauseBrokenCurrentSale(db, row.sku_id, row.version_id, integrityStatus)
    currentVersion = {
      id: row.version_id,
      versionNumber: row.version_number,
      displayFilename: row.display_filename,
      fileSizeBytes: row.size_bytes,
      fileMediaType: row.media_type,
      sha256: row.sha256.trim(),
      createdAt: row.version_created_at.toISOString(),
      integrityStatus,
    }
  }
  return {
    productId: row.product_id,
    skuId: row.sku_id,
    productType: row.product_type,
    method: row.method as PrivateFileConfig['method'],
    automaticDeliveryReady: row.method === 'file' && row.automatic_delivery_ready && integrityStatus === 'verified',
    configurationRevision: row.configuration_revision,
    updatedAt: row.updated_at?.toISOString() ?? null,
    integrityStatus,
    currentVersion,
  }
}

async function verifyObject(storage: PrivateFileStorage, row: FileObjectRow, expectedStatus: 'staged' | 'available') {
  if (row.status !== expectedStatus || row.size_bytes === null || !row.sha256 || !row.media_type) {
    throw new PrivateFileAdminError(409, expectedStatus === 'staged' ? 'PRIVATE_FILE_UPLOAD_NOT_READY' : 'PRIVATE_FILE_OBJECT_UNAVAILABLE',
      expectedStatus === 'staged' ? '请先完成一个有效文件的上传。' : '当前文件尚未完成持久化与校验。')
  }
  try {
    return await storage.openVerified(row.id, { sizeBytes: row.size_bytes, sha256: row.sha256.trim() })
  } catch (error) {
    if (error instanceof PrivateFileError) {
      throw new PrivateFileAdminError(409, error.code, error.message)
    }
    throw error
  }
}

export async function registerAdminPrivateFileDeliveryRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: AppConfig,
): Promise<void> {
  const requireAdministrator = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)
  const storage = new PrivateFileStorage(config.privateFileRoot)

  await app.register(async (scope) => {
    await scope.register(multipart, { limits: multipartLimits, throwFileSizeLimit: false })

    scope.get('/api/v1/admin/products/:id/variants/:variantId/private-files', {
      preHandler: requireAdministrator,
      schema: {
        tags: ['admin', 'catalog'], summary: 'Read the private-file delivery configuration for one SKU',
        params: AdminProductVariantParamsSchema,
        response: { 200: ApiSuccessSchemaOf(PrivateFileConfigSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
      },
    }, async (request, reply) => {
      try {
        const params = request.params as { id: string; variantId: string }
        const result = await loadFileConfig(db, params.id, params.variantId, storage)
        if (!result) return reply.code(404).send(failure('SKU_NOT_FOUND', 'SKU 不属于此商品。', request.id))
        reply.header('cache-control', 'private, no-store')
        return success(result, request.id)
      } catch (error) {
        return errorResponse(reply, error, request.id)
      }
    })

    scope.get('/api/v1/admin/products/:id/variants/:variantId/private-files/versions', {
      preHandler: requireAdministrator,
      schema: {
        tags: ['admin', 'catalog'], summary: 'List immutable private-file delivery versions',
        params: AdminProductVariantParamsSchema,
        querystring: PrivateFileVersionsQuerySchema,
        response: { 200: ApiSuccessSchemaOf(PrivateFileVersionsPageSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
      },
    }, async (request, reply) => {
      const params = request.params as { id: string; variantId: string }
      const query = request.query as PrivateFileVersionsQuery
      const exists = await db.selectFrom('product_variants').select('id')
        .where('product_id', '=', params.id).where('id', '=', params.variantId).executeTakeFirst()
      if (!exists) return reply.code(404).send(failure('SKU_NOT_FOUND', 'SKU 不属于此商品。', request.id))
      const page = query.page ?? 1
      const pageSize = Math.min(query.pageSize ?? 20, 50)
      const count = await db.selectFrom('product_variant_fulfillment_versions')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('product_variant_id', '=', params.variantId).where('method', '=', 'file').executeTakeFirstOrThrow()
      const rows = await db.selectFrom('product_variant_fulfillment_versions as version')
        .innerJoin('private_file_objects as object', 'object.id', 'version.private_file_object_id')
        .select([
          'version.id', 'version.version_number', 'version.display_filename', 'version.created_at',
          'object.size_bytes', 'object.media_type', 'object.sha256',
        ])
        .where('version.product_variant_id', '=', params.variantId).where('version.method', '=', 'file')
        .orderBy('version.version_number', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute()
      const result: PrivateFileVersionsPage = {
        items: rows.map(row => ({
          id: row.id,
          versionNumber: row.version_number,
          displayFilename: row.display_filename!,
          fileSizeBytes: row.size_bytes!,
          fileMediaType: row.media_type!,
          sha256: row.sha256!.trim(),
          createdAt: row.created_at.toISOString(),
        })),
        total: count.count,
        page,
        pageSize,
        totalPages: count.count === 0 ? 0 : Math.ceil(count.count / pageSize),
      }
      reply.header('cache-control', 'private, no-store')
      return success(result, request.id)
    })

    scope.get('/api/v1/admin/products/:id/variants/:variantId/private-files/versions/:versionId', {
      preHandler: requireAdministrator,
      schema: {
        tags: ['admin', 'catalog'], summary: 'Read immutable private-file version metadata',
        params: {
          type: 'object', required: ['id', 'variantId', 'versionId'], additionalProperties: false,
          properties: {
            id: { type: 'string', format: 'uuid' }, variantId: { type: 'string', format: 'uuid' },
            versionId: { type: 'string', format: 'uuid' },
          },
        },
        response: { 200: ApiSuccessSchemaOf(PrivateFileVersionSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
      },
    }, async (request, reply) => {
      try {
        const params = request.params as { id: string; variantId: string; versionId: string }
        const row = await sql<FileVersionRow>`
          SELECT product.id AS product_id, product.product_type, variant.id AS sku_id,
            fulfillment.method, COALESCE(fulfillment.automatic_delivery_ready, false) AS automatic_delivery_ready,
            COALESCE(fulfillment.configuration_revision, 0)::integer AS configuration_revision,
            fulfillment.updated_at, version.id AS version_id, version.version_number,
            version.display_filename, version.created_at AS version_created_at,
            object.id, object.status, object.media_type, object.size_bytes, object.sha256
          FROM products AS product
          JOIN product_variants AS variant ON variant.product_id = product.id
          JOIN product_variant_fulfillment_versions AS version ON version.product_variant_id = variant.id
          JOIN private_file_objects AS object ON object.id = version.private_file_object_id
          LEFT JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
          WHERE product.id = ${params.id}::uuid AND variant.id = ${params.variantId}::uuid
            AND version.id = ${params.versionId}::uuid AND version.method = 'file'
        `.execute(db).then(result => result.rows[0])
        if (!row || !row.version_id || !row.version_created_at || !row.display_filename
          || !row.media_type || row.size_bytes === null || !row.sha256 || !row.id) {
          return reply.code(404).send(failure('PRIVATE_FILE_VERSION_NOT_FOUND', '找不到此 SKU 的文件版本。', request.id))
        }
        const integrityStatus = await inspectObject(db, storage, row, { skuId: row.sku_id, versionId: row.version_id! })
        await pauseBrokenCurrentSale(db, row.sku_id, row.version_id, integrityStatus)
        reply.header('cache-control', 'private, no-store')
        const result: PrivateFileVersion = {
          id: row.version_id,
          versionNumber: row.version_number!,
          displayFilename: row.display_filename,
          fileSizeBytes: row.size_bytes,
          fileMediaType: row.media_type,
          sha256: row.sha256.trim(),
          createdAt: row.version_created_at.toISOString(),
          integrityStatus,
        }
        return success(result, request.id)
      } catch (error) {
        return errorResponse(reply, error, request.id)
      }
    })

    scope.post('/api/v1/admin/products/:id/variants/:variantId/private-files/uploads', {
      preHandler: [requireAdministrator, csrfCheck],
      config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
      schema: {
        tags: ['admin', 'catalog'], summary: 'Stream one validated file into isolated private staging storage',
        consumes: ['multipart/form-data'],
        response: {
          201: ApiSuccessSchemaOf(PrivateFileUploadSchema), 400: ApiErrorSchema, 401: ApiErrorSchema,
          403: ApiErrorSchema, 411: ApiErrorSchema, 413: ApiErrorSchema, 429: ApiErrorSchema,
        },
      },
    }, async (request, reply) => {
      let uploadId: string | undefined
      let uploadRowCreated = false
      let ownsSlot = false
      try {
        requestLength(request)
        const params = request.params as { id: string; variantId: string }
        const sku = await db.selectFrom('products as product')
          .innerJoin('product_variants as variant', 'variant.product_id', 'product.id')
          .select(['product.product_type', 'variant.id'])
          .where('product.id', '=', params.id).where('variant.id', '=', params.variantId).executeTakeFirst()
        if (!sku) throw new PrivateFileAdminError(404, 'SKU_NOT_FOUND', 'SKU 不属于此商品。')
        if (sku.product_type !== 'digital') {
          throw new PrivateFileAdminError(409, 'DIGITAL_PRODUCT_REQUIRED', '私有文件自动交付仅适用于数字商品。')
        }
        if (activePrivateFileUploads >= maxConcurrentPrivateFileUploads) {
          throw new PrivateFileAdminError(429, 'PRIVATE_FILE_UPLOAD_BUSY', '当前有多个文件正在处理，请稍后重试。')
        }
        activePrivateFileUploads += 1
        ownsSlot = true
        const iterator = request.parts({ limits: multipartLimits })[Symbol.asyncIterator]()
        const first = await iterator.next()
        if (first.done || first.value.type !== 'file' || first.value.fieldname !== 'file') {
          throw new PrivateFileAdminError(400, 'PRIVATE_FILE_REQUIRED', '请选择一个 ZIP、PDF、文本、图片、MP3 或 MP4 文件。')
        }
        const part = first.value
        const uploadFilename = sanitizeUploadFilename(part.filename)
        uploadId = newPrivateFileId()
        await db.insertInto('private_file_objects').values({
          id: uploadId,
          uploaded_by_admin_id: request.admin!.id,
          upload_filename: uploadFilename,
          status: 'uploading',
          media_type: null,
          size_bytes: null,
          sha256: null,
          expires_at: new Date(Date.now() + PRIVATE_FILE_STAGE_TTL_MS),
        }).execute()
        uploadRowCreated = true

        if (part.mimetype.toLowerCase().includes('multipart')) {
          throw new PrivateFileAdminError(400, 'PRIVATE_FILE_PART_INVALID', '上传内容无效。')
        }
        const stored = await storage.storeUpload(uploadId, part.file, uploadFilename)
        if (part.file.truncated) throw new PrivateFileError('PRIVATE_FILE_TOO_LARGE', '数字商品文件不能超过 100 MiB。', 413)
        const extra = await iterator.next()
        if (!extra.done) {
          if (extra.value.type === 'file') extra.value.file.resume()
          throw new PrivateFileAdminError(400, 'PRIVATE_FILE_PART_INVALID', '一次只能上传一个文件。')
        }
        await db.updateTable('private_file_objects').set({
          status: 'staged', media_type: stored.mediaType, size_bytes: stored.sizeBytes, sha256: stored.sha256,
        }).where('id', '=', uploadId).where('status', '=', 'uploading').execute()
        reply.header('cache-control', 'private, no-store')
        return reply.code(201).send(success({
          uploadId,
          uploadFilename: stored.uploadFilename,
          fileSizeBytes: stored.sizeBytes,
          fileMediaType: stored.mediaType,
          sha256: stored.sha256,
          status: 'staged' as const,
        }, request.id))
      } catch (error) {
        if (uploadId) {
          await storage.removeStaging(uploadId).catch(() => undefined)
          await storage.removeObject(uploadId).catch(() => undefined)
          if (uploadRowCreated) {
            await db.updateTable('private_file_objects').set({ status: 'failed' })
              .where('id', '=', uploadId).where('status', '=', 'uploading').execute().catch(() => undefined)
          }
        }
        return errorResponse(reply, error, request.id)
      } finally {
        if (ownsSlot) activePrivateFileUploads -= 1
      }
    })

    scope.post('/api/v1/admin/products/:id/variants/:variantId/private-files/versions', {
      preHandler: [requireAdministrator, csrfCheck],
      schema: {
        tags: ['admin', 'catalog'], summary: 'Save a new immutable file version and keep automatic sales paused',
        params: AdminProductVariantParamsSchema,
        body: SavePrivateFileVersionBodySchema,
        response: {
          200: ApiSuccessSchemaOf(PrivateFileConfigSchema), 400: ApiErrorSchema, 401: ApiErrorSchema,
          403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 413: ApiErrorSchema,
        },
      },
    }, async (request, reply) => {
      let opened: Awaited<ReturnType<typeof storage.openVerified>> | undefined
      try {
        const params = request.params as { id: string; variantId: string }
        const body = request.body as SavePrivateFileVersionBody
        const staged = await db.selectFrom('private_file_objects').select(['id', 'status', 'media_type', 'size_bytes', 'sha256'])
          .where('id', '=', body.uploadId).where('uploaded_by_admin_id', '=', request.admin!.id).executeTakeFirst()
        if (!staged) throw new PrivateFileAdminError(404, 'PRIVATE_FILE_UPLOAD_NOT_FOUND', '上传文件不存在或不属于当前管理员。')
        opened = await verifyObject(storage, staged, 'staged')
        const displayFilename = normalizeDisplayFilename(body.displayFilename, staged.media_type!)
        const versionId = randomUUID()
        const result = await db.transaction().execute(async (trx) => {
          const locked = await lockProductSkuAndConfig(trx, params.id, params.variantId)
          assertRevision(body.expectedRevision, locked.revision)
          if (locked.productType !== 'digital') throw new PrivateFileAdminError(409, 'DIGITAL_PRODUCT_REQUIRED', '私有文件自动交付仅适用于数字商品。')
          if (locked.inventoryMode !== 'quantity' && locked.inventoryMode !== 'unlimited') {
            throw new PrivateFileAdminError(409, 'DIGITAL_INVENTORY_MODE_UNSUPPORTED', '请先将 SKU 库存设置为 quantity 或 unlimited。')
          }
          const object = await trx.selectFrom('private_file_objects').selectAll()
            .where('id', '=', body.uploadId).where('uploaded_by_admin_id', '=', request.admin!.id)
            .forUpdate().executeTakeFirst()
          if (!object || object.status !== 'staged' || object.expires_at <= new Date()
            || object.size_bytes !== staged.size_bytes || object.sha256?.trim() !== staged.sha256?.trim()
            || object.media_type !== staged.media_type) {
            throw new PrivateFileAdminError(409, 'PRIVATE_FILE_UPLOAD_NOT_READY', '上传文件已过期或状态已变化，请重新上传。')
          }
          const nextVersion = await trx.selectFrom('product_variant_fulfillment_versions')
            .select(sql<number>`COALESCE(max(version_number), 0)::integer + 1`.as('version_number'))
            .where('product_variant_id', '=', params.variantId).executeTakeFirstOrThrow()
          await trx.updateTable('private_file_objects').set({ status: 'available' })
            .where('id', '=', body.uploadId).where('status', '=', 'staged').execute()
          await trx.insertInto('product_variant_fulfillment_versions').values({
            id: versionId,
            product_variant_id: params.variantId,
            version_number: nextVersion.version_number,
            method: 'file',
            encrypted_content: null,
            content_nonce: null,
            content_auth_tag: null,
            encryption_key_id: null,
            content_sha256: object.sha256!,
            private_file_object_id: object.id,
            display_filename: displayFilename,
            created_by_admin_id: request.admin!.id,
          }).execute()
          if (locked.method === null) {
            await trx.insertInto('product_variant_fulfillment').values({
              product_variant_id: params.variantId,
              method: 'file',
              manual_delivery_ready: false,
              code_pool_delivery_ready: false,
              automatic_delivery_ready: false,
              current_content_version_id: versionId,
              configuration_revision: 1,
            }).execute()
          } else {
            await trx.updateTable('product_variant_fulfillment').set({
              method: 'file', manual_delivery_ready: false, code_pool_delivery_ready: false,
              automatic_delivery_ready: false, current_content_version_id: versionId,
            }).where('product_variant_id', '=', params.variantId).execute()
          }
          const configRow = await sql<FileVersionRow>`
            SELECT product.id AS product_id, product.product_type, variant.id AS sku_id,
              fulfillment.method, fulfillment.automatic_delivery_ready, fulfillment.configuration_revision,
              fulfillment.updated_at, version.id AS version_id, version.version_number,
              version.display_filename, version.created_at AS version_created_at,
              object.id, object.status, object.media_type, object.size_bytes, object.sha256
            FROM products AS product
            JOIN product_variants AS variant ON variant.product_id = product.id
            JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
            JOIN product_variant_fulfillment_versions AS version ON version.id = fulfillment.current_content_version_id
            JOIN private_file_objects AS object ON object.id = version.private_file_object_id
            WHERE product.id = ${params.id}::uuid AND variant.id = ${params.variantId}::uuid
          `.execute(trx).then(query => query.rows[0])
          if (!configRow || !configRow.version_id || !configRow.version_created_at || !configRow.display_filename
            || !configRow.media_type || configRow.size_bytes === null || !configRow.sha256) {
            throw new Error('Saved private file version could not be read')
          }
          const currentVersion: PrivateFileVersion = {
            id: configRow.version_id,
            versionNumber: configRow.version_number!,
            displayFilename: configRow.display_filename,
            fileSizeBytes: configRow.size_bytes,
            fileMediaType: configRow.media_type,
            sha256: configRow.sha256.trim(),
            createdAt: configRow.version_created_at.toISOString(),
            integrityStatus: 'verified',
          }
          return {
            productId: configRow.product_id,
            skuId: configRow.sku_id,
            productType: configRow.product_type,
            method: configRow.method,
            automaticDeliveryReady: false,
            configurationRevision: configRow.configuration_revision,
            updatedAt: configRow.updated_at?.toISOString() ?? null,
            integrityStatus: 'verified' as const,
            currentVersion,
          }
        })
        reply.header('cache-control', 'private, no-store')
        return success(result, request.id)
      } catch (error) {
        return errorResponse(reply, error, request.id)
      } finally {
        await opened?.handle.close().catch(() => undefined)
      }
    })

    scope.put('/api/v1/admin/products/:id/variants/:variantId/private-files/readiness', {
      preHandler: [requireAdministrator, csrfCheck],
      schema: {
        tags: ['admin', 'catalog'], summary: 'Explicitly enable or pause new file-delivery sales',
        params: AdminProductVariantParamsSchema,
        body: UpdatePrivateFileReadinessBodySchema,
        response: {
          200: ApiSuccessSchemaOf(PrivateFileConfigSchema), 400: ApiErrorSchema, 401: ApiErrorSchema,
          403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
        },
      },
    }, async (request, reply) => {
      let opened: Awaited<ReturnType<typeof storage.openVerified>> | undefined
      try {
        const params = request.params as { id: string; variantId: string }
        const body = request.body as UpdatePrivateFileReadinessBody
        let verified: { versionId: string; objectId: string } | undefined
        if (body.enabled) {
          const candidate = await sql<FileVersionRow>`
            SELECT product.id AS product_id, product.product_type, variant.id AS sku_id,
              fulfillment.method, COALESCE(fulfillment.automatic_delivery_ready, false) AS automatic_delivery_ready,
              COALESCE(fulfillment.configuration_revision, 0)::integer AS configuration_revision,
              fulfillment.updated_at, version.id AS version_id, version.version_number,
              version.display_filename, version.created_at AS version_created_at,
              object.id, object.status, object.media_type, object.size_bytes, object.sha256
            FROM products AS product
            JOIN product_variants AS variant ON variant.product_id = product.id
            JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
            JOIN product_variant_fulfillment_versions AS version ON version.id = fulfillment.current_content_version_id
            JOIN private_file_objects AS object ON object.id = version.private_file_object_id
            WHERE product.id = ${params.id}::uuid AND variant.id = ${params.variantId}::uuid
              AND fulfillment.method = 'file' AND version.method = 'file'
          `.execute(db).then(query => query.rows[0])
          if (!candidate?.version_id || !candidate.id || candidate.method !== 'file') {
            throw new PrivateFileAdminError(409, 'PRIVATE_FILE_NOT_CONFIGURED', '请先保存一个文件版本。')
          }
          assertRevision(body.expectedRevision, candidate.configuration_revision)
          if (candidate.status !== 'available' || candidate.size_bytes === null || !candidate.sha256 || !candidate.media_type) {
            throw new PrivateFileAdminError(409, 'PRIVATE_FILE_OBJECT_UNAVAILABLE', '当前文件尚未完成持久化与校验。')
          }
          try {
            opened = await storage.openVerified(candidate.id, {
              sizeBytes: candidate.size_bytes,
              sha256: candidate.sha256.trim(),
            })
          } catch (error) {
            if (error instanceof PrivateFileError) {
              const nextStatus = error.code === 'PRIVATE_FILE_INTEGRITY_FAILED' ? 'corrupt' : 'missing'
              await pauseBrokenCurrentSale(db, candidate.sku_id, candidate.version_id, 'corrupt').catch(() => undefined)
              await db.updateTable('private_file_objects').set({ status: nextStatus })
                .where('id', '=', candidate.id).where('status', '=', 'available').execute().catch(() => undefined)
            }
            throw error
          }
          verified = { versionId: candidate.version_id, objectId: candidate.id }
        }
        const result = await db.transaction().execute(async (trx) => {
          const locked = await lockProductSkuAndConfig(trx, params.id, params.variantId)
          assertRevision(body.expectedRevision, locked.revision)
          if (locked.method !== 'file' || !locked.currentVersionId) {
            throw new PrivateFileAdminError(409, 'PRIVATE_FILE_NOT_CONFIGURED', '请先保存一个文件版本。')
          }
          if (body.enabled && verified?.versionId !== locked.currentVersionId) {
            throw new PrivateFileAdminError(409, 'FULFILLMENT_REVISION_CONFLICT', '当前文件版本已变化，请刷新后重新确认。')
          }
          if (body.enabled) {
            if (locked.productType !== 'digital' || !locked.enabled || locked.retiredAt
              || (locked.inventoryMode !== 'quantity' && locked.inventoryMode !== 'unlimited')) {
              throw new PrivateFileAdminError(409, 'PRIVATE_FILE_SKU_NOT_SELLABLE', '只有启用、未退役且库存模式为 quantity 或 unlimited 的数字 SKU 才能开启自动销售。')
            }
            const version = await trx.selectFrom('product_variant_fulfillment_versions')
              .select(['id', 'private_file_object_id']).where('id', '=', locked.currentVersionId)
              .where('product_variant_id', '=', params.variantId).where('method', '=', 'file').executeTakeFirst()
            if (!version?.private_file_object_id || version.private_file_object_id !== verified?.objectId) {
              throw new PrivateFileAdminError(409, 'PRIVATE_FILE_VERSION_UNAVAILABLE', '当前文件版本记录不可用。')
            }
            const object = await trx.selectFrom('private_file_objects').select(['id', 'status', 'media_type', 'size_bytes', 'sha256'])
              .where('id', '=', version.private_file_object_id).forUpdate().executeTakeFirst()
            if (!object || object.status !== 'available') {
              throw new PrivateFileAdminError(409, 'PRIVATE_FILE_OBJECT_UNAVAILABLE', '当前文件尚未完成持久化与校验。')
            }
          }
          await trx.updateTable('product_variant_fulfillment').set({ automatic_delivery_ready: body.enabled })
            .where('product_variant_id', '=', params.variantId).where('method', '=', 'file')
            .where('current_content_version_id', '=', locked.currentVersionId).execute()
          return await loadFileConfig(trx, params.id, params.variantId, storage, verified?.objectId)
        })
        if (!result) return reply.code(404).send(failure('SKU_NOT_FOUND', 'SKU 不属于此商品。', request.id))
        reply.header('cache-control', 'private, no-store')
        return success(result, request.id)
      } catch (error) {
        return errorResponse(reply, error, request.id)
      } finally {
        await opened?.handle.close().catch(() => undefined)
      }
    })
  })
}
