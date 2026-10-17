import multipart from '@fastify/multipart'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { sql, type Kysely } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  MediaIdParamsSchema,
  MediaVariantParamsSchema,
  ProductGalleryResponseSchema,
  ProductIdParamsSchema,
  ProductMediaDeleteResponseSchema,
  ProductMediaLibraryPageSchema,
  ProductMediaLibraryQuerySchema,
  ProductMediaMetadataSchema,
  ProductRichContentResponseSchema,
  ReplaceProductGalleryBodySchema,
  SaveProductRichContentBodySchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  ProductMediaVariant,
  ProductMediaLibraryPage,
  ProductMediaLibraryQuery,
  ReplaceProductGalleryBody,
  SaveProductRichContentBody,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import { appendProductAudit } from '../catalog/product-audit.js'
import { assertProductNotArchived, lockProductAtRevision } from '../catalog/admin-product-guards.js'
import { CatalogError, sendCatalogError } from '../catalog/errors.js'
import type { Database } from '../db/types.js'
import { MediaStorage, MAX_UPLOAD_BYTES, MAX_UPLOAD_REQUEST_BYTES, imageMimeForStoredFormat } from './storage.js'
import type { StoredMediaVariant } from './storage.js'
import { loadProductGallery, loadProductMediaMetadata } from './queries.js'
import { validateProductRichContent } from './rich-content.js'

const multipartLimits = {
  fileSize: MAX_UPLOAD_BYTES,
  files: 1,
  fields: 0,
  fieldSize: 0,
  fieldNameSize: 32,
  parts: 1,
  headerPairs: 20,
}

let activeImageProcessing = 0
const maxConcurrentImageProcessing = 1

function fail(reply: FastifyReply, error: unknown, requestId: string) {
  if (error && typeof error === 'object' && 'statusCode' in error
    && (error as { statusCode?: number }).statusCode === 413) {
    return reply.code(413).send(failure('UPLOAD_LIMIT_EXCEEDED', 'The image upload exceeds the configured limits', requestId))
  }
  return sendCatalogError(reply, error, requestId)
}

function uploadRequestLength(request: FastifyRequest): number {
  const contentLength = request.headers['content-length']
  if (typeof contentLength !== 'string' || !/^\d+$/.test(contentLength)) {
    throw new CatalogError(411, 'UPLOAD_LENGTH_REQUIRED', 'Image uploads must include a bounded Content-Length')
  }
  const size = Number(contentLength)
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new CatalogError(400, 'INVALID_UPLOAD_LENGTH', 'The image upload length is invalid')
  }
  if (size > MAX_UPLOAD_REQUEST_BYTES) {
    throw new CatalogError(413, 'UPLOAD_LIMIT_EXCEEDED', 'The image upload exceeds the configured request limit')
  }
  return size
}

async function requestImage(request: FastifyRequest): Promise<{ bytes: Buffer; mimeType: string }> {
  uploadRequestLength(request)
  let found: { bytes: Buffer; mimeType: string } | undefined
  for await (const part of request.parts({ limits: multipartLimits })) {
    if (part.type !== 'file' || part.fieldname !== 'file' || found) {
      if (part.type === 'file') await part.toBuffer()
      throw new CatalogError(400, 'INVALID_MULTIPART_BODY', 'Upload exactly one image in the file field')
    }
    const bytes = await part.toBuffer()
    if (part.file.truncated) {
      throw new CatalogError(413, 'IMAGE_TOO_LARGE', 'Images must be 10 MB or smaller')
    }
    found = { bytes, mimeType: part.mimetype }
  }
  if (!found) throw new CatalogError(400, 'IMAGE_REQUIRED', 'Choose one JPEG, PNG, or WebP image to upload')
  if (found.bytes.length > MAX_UPLOAD_BYTES) throw new CatalogError(413, 'IMAGE_TOO_LARGE', 'Images must be 10 MB or smaller')
  return found
}

async function assertMediaReady(db: Kysely<Database>, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const media = await db.selectFrom('product_media').select('id').where('id', 'in', ids).execute()
  if (media.length !== ids.length) {
    throw new CatalogError(400, 'MEDIA_NOT_FOUND', 'One or more images do not exist or are no longer available')
  }
  const variants = await db.selectFrom('product_media_variants').select(['media_id', 'variant'])
    .where('media_id', 'in', ids).execute()
  const complete = new Map<string, Set<string>>()
  for (const row of variants) {
    const found = complete.get(row.media_id) ?? new Set<string>()
    found.add(row.variant)
    complete.set(row.media_id, found)
  }
  if (ids.some((id) => complete.get(id)?.size !== 3)) {
    throw new CatalogError(409, 'MEDIA_NOT_READY', 'One or more images are not fully processed')
  }
}

function auditSummary(content: ReturnType<typeof validateProductRichContent>) {
  return { richContentSummary: content.summary }
}

async function saveGallery(
  db: Kysely<Database>,
  productId: string,
  administratorId: string,
  body: ReplaceProductGalleryBody,
) {
  return db.transaction().execute(async (trx) => {
    const product = await lockProductAtRevision(trx, productId, body.expectedRevision)
    assertProductNotArchived(product)
    const mediaIds = body.mediaIds.map((id) => id.toLowerCase())
    if (new Set(mediaIds).size !== mediaIds.length) {
      throw new CatalogError(400, 'DUPLICATE_PRODUCT_MEDIA', 'A product gallery cannot contain the same image twice')
    }
    await assertMediaReady(trx, mediaIds)
    const before = await trx.selectFrom('product_media_references').select('media_id')
      .where('product_id', '=', productId).where('source', '=', 'gallery')
      .orderBy('sort_order').execute()
    const currentIds = before.map((reference) => reference.media_id)
    if (JSON.stringify(currentIds) !== JSON.stringify(mediaIds)) {
      await trx.deleteFrom('product_media_references').where('product_id', '=', productId)
        .where('source', '=', 'gallery').execute()
      if (mediaIds.length > 0) {
        await trx.insertInto('product_media_references').values(mediaIds.map((mediaId, sortOrder) => ({
          product_id: productId,
          media_id: mediaId,
          source: 'gallery' as const,
          sort_order: sortOrder,
        }))).execute()
      }
      await trx.updateTable('products').set({ updated_at: new Date() }).where('id', '=', productId).execute()
      const updated = await trx.selectFrom('products').select('revision').where('id', '=', productId).executeTakeFirstOrThrow()
      await appendProductAudit(trx, {
        productId,
        administratorId,
        operation: 'gallery_updated',
        before: { galleryCount: currentIds.length, galleryMediaIds: currentIds },
        after: { galleryCount: mediaIds.length, galleryMediaIds: mediaIds },
      })
      return { revision: updated.revision }
    }
    return { revision: product.revision }
  })
}

async function saveRichContent(
  db: Kysely<Database>,
  productId: string,
  administratorId: string,
  body: SaveProductRichContentBody,
) {
  const newContent = validateProductRichContent(body.content)
  return db.transaction().execute(async (trx) => {
    const product = await lockProductAtRevision(trx, productId, body.expectedRevision)
    assertProductNotArchived(product)
    const existingContent = validateProductRichContent(product.rich_content)
    const oldReferences = await trx.selectFrom('product_media_references').select('media_id')
      .where('product_id', '=', productId).where('source', '=', 'rich_content').orderBy('media_id').execute()
    const oldIds = oldReferences.map((reference) => reference.media_id)
    const canonicalOldIds = [...existingContent.mediaIds].sort()
    if (JSON.stringify(oldIds) !== JSON.stringify(canonicalOldIds)) {
      throw new CatalogError(409, 'PRODUCT_MEDIA_REFERENCE_INCONSISTENT', 'The saved rich content media references are inconsistent')
    }
    await assertMediaReady(trx, newContent.mediaIds)
    const contentUnchanged = JSON.stringify(existingContent.document) === JSON.stringify(newContent.document)
    if (contentUnchanged) return { revision: product.revision, content: existingContent.document }

    await trx.deleteFrom('product_media_references').where('product_id', '=', productId)
      .where('source', '=', 'rich_content').execute()
    if (newContent.mediaIds.length > 0) {
      await trx.insertInto('product_media_references').values(newContent.mediaIds.map((mediaId) => ({
        product_id: productId,
        media_id: mediaId,
        source: 'rich_content' as const,
        sort_order: null,
      }))).execute()
    }
    const updated = await trx.updateTable('products').set({ rich_content: newContent.document })
      .where('id', '=', productId).returning('revision').executeTakeFirstOrThrow()
    await appendProductAudit(trx, {
      productId,
      administratorId,
      operation: 'rich_content_updated',
      before: auditSummary(existingContent),
      after: auditSummary(newContent),
    })
    return { revision: updated.revision, content: newContent.document }
  })
}

function metadataResponse(media: NonNullable<Awaited<ReturnType<typeof loadProductMediaMetadata>>>) {
  return {
    ...media,
    variants: media.variants.map((variant) => ({
      ...variant,
      contentType: imageMimeForStoredFormat('webp'),
    })),
  }
}

async function insertPublishedMedia(db: Kysely<Database>, media: { id: string; variants: StoredMediaVariant[] }) {
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('product_media').values({ id: media.id }).execute()
    await trx.insertInto('product_media_variants').values(media.variants.map((variant) => ({
      media_id: variant.mediaId,
      variant: variant.variant,
      storage_key: variant.storageKey,
      format: 'webp' as const,
      width: variant.width,
      height: variant.height,
      size_bytes: variant.sizeBytes,
      sha256: variant.sha256,
      processing_version: variant.processingVersion,
    }))).execute()
  })
}

export async function registerProductMediaRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: AppConfig,
): Promise<void> {
  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)
  const storage = new MediaStorage(config.mediaRoot)

  await app.register(async (scope) => {
    await scope.register(multipart, {
      limits: multipartLimits,
      throwFileSizeLimit: false,
    })

    scope.get('/api/v1/admin/media', {
      preHandler: authenticate,
      schema: {
        tags: ['admin', 'catalog'],
        summary: 'List processed product images with reference counts',
        querystring: ProductMediaLibraryQuerySchema,
        response: { 200: ApiSuccessSchemaOf(ProductMediaLibraryPageSchema), 400: ApiErrorSchema, 401: ApiErrorSchema },
      },
    }, async (request, reply) => {
      try {
        const query = request.query as ProductMediaLibraryQuery
        const page = query.page ?? 1
        const pageSize = query.pageSize ?? 20
        const offset = (page - 1) * pageSize
        const search = query.search?.trim()
        const predicate = search ? sql`WHERE media.id::text ILIKE ${`%${search}%`}` : sql``
        const total = await sql<{ total: number }>`
          SELECT count(*)::integer AS total FROM product_media AS media ${predicate}
        `.execute(db)
        type MediaRow = {
          id: string
          created_at: Date
          reference_count: number
          variants: Array<{
            variant: ProductMediaVariant
            width: number
            height: number
            sizeBytes: number
            sha256: string
            processingVersion: string
          }>
        }
        const rows = await sql<MediaRow>`
          SELECT media.id, media.created_at,
            COALESCE(media_refs.reference_count, 0)::integer AS reference_count,
            jsonb_agg(jsonb_build_object(
              'variant', image.variant,
              'width', image.width,
              'height', image.height,
              'sizeBytes', image.size_bytes,
              'sha256', trim(image.sha256),
              'processingVersion', image.processing_version
            ) ORDER BY CASE image.variant WHEN 'thumbnail' THEN 0 WHEN 'card' THEN 1 ELSE 2 END) AS variants
          FROM product_media AS media
          LEFT JOIN LATERAL (
            SELECT count(*) AS reference_count
            FROM product_media_references AS reference
            WHERE reference.media_id = media.id
          ) AS media_refs ON TRUE
          INNER JOIN product_media_variants AS image ON image.media_id = media.id
          ${predicate}
          GROUP BY media.id, media.created_at, media_refs.reference_count
          ORDER BY media.created_at DESC, media.id DESC
          LIMIT ${pageSize} OFFSET ${offset}
        `.execute(db)
        const result: ProductMediaLibraryPage = {
          page,
          pageSize,
          total: total.rows[0]?.total ?? 0,
          totalPages: (total.rows[0]?.total ?? 0) === 0 ? 0 : Math.ceil((total.rows[0]?.total ?? 0) / pageSize),
          items: rows.rows.map((row) => ({
            id: row.id,
            createdAt: row.created_at.toISOString(),
            referenceCount: row.reference_count,
            variants: row.variants.map((variant) => ({
              ...variant,
              url: `/api/v1/media/${row.id}/${variant.variant}.webp`,
              contentType: 'image/webp' as const,
            })),
          })),
        }
        return reply.send(success(result, request.id))
      } catch (error) {
        return fail(reply, error, request.id)
      }
    })

    scope.post('/api/v1/admin/media', {
      preHandler: [authenticate, csrfCheck],
      config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
      schema: {
        tags: ['admin', 'catalog'],
        summary: 'Upload a processed product image',
        consumes: ['multipart/form-data'],
        response: {
          201: ApiSuccessSchemaOf(ProductMediaMetadataSchema),
          400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema,
          411: ApiErrorSchema, 413: ApiErrorSchema, 429: ApiErrorSchema,
        },
      },
    }, async (request, reply) => {
      let media: { id: string; variants: StoredMediaVariant[] }
      let ownsProcessingSlot = false
      try {
        uploadRequestLength(request)
        if (activeImageProcessing >= maxConcurrentImageProcessing) {
          throw new CatalogError(429, 'IMAGE_PROCESSING_BUSY', 'Another image is being processed; retry shortly')
        }
        activeImageProcessing += 1
        ownsProcessingSlot = true
        const uploaded = await requestImage(request)
        media = await storage.publishImage(uploaded)
      } catch (error) {
        if (!(error instanceof CatalogError) && error && typeof error === 'object'
          && 'statusCode' in error && (error as { statusCode?: number }).statusCode === 400) {
          return reply.code(400).send(failure('INVALID_MULTIPART_BODY', 'Send exactly one supported image file', request.id))
        }
        if (!(error instanceof CatalogError)) request.log.error({ err: error }, 'product media upload processing failed')
        return fail(reply, error, request.id)
      } finally {
        if (ownsProcessingSlot) activeImageProcessing -= 1
      }

      try {
        await insertPublishedMedia(db, media)
      } catch (error) {
        const cleanup = await Promise.allSettled(media.variants.map((variant) =>
          storage.removePublished(media.id, variant.variant, variant.storageKey)))
        if (cleanup.some((result) => result.status === 'rejected')) {
          request.log.error({ mediaId: media.id }, 'published media cleanup is pending after metadata failure')
        }
        return fail(reply, error, request.id)
      }

      const metadata = await loadProductMediaMetadata(db, media.id)
      if (!metadata) throw new Error('Saved media metadata could not be read')
      return reply.code(201).send(success(metadataResponse(metadata), request.id))
    })

    scope.get('/api/v1/admin/media/:id', {
      preHandler: authenticate,
      schema: {
        tags: ['admin', 'catalog'],
        summary: 'Read product image metadata',
        params: MediaIdParamsSchema,
        response: { 200: ApiSuccessSchemaOf(ProductMediaMetadataSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
      },
    }, async (request, reply) => {
      const { id } = request.params as { id: string }
      const metadata = await loadProductMediaMetadata(db, id)
      if (!metadata) return reply.code(404).send(failure('MEDIA_NOT_FOUND', 'The image does not exist', request.id))
      return reply.send(success(metadataResponse(metadata), request.id))
    })

    scope.delete('/api/v1/admin/media/:id', {
      preHandler: [authenticate, csrfCheck],
      schema: {
        tags: ['admin', 'catalog'],
        summary: 'Delete a product image when it is not referenced',
        params: MediaIdParamsSchema,
        response: {
          200: ApiSuccessSchemaOf(ProductMediaDeleteResponseSchema),
          401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
        },
      },
    }, async (request, reply) => {
      const { id } = request.params as { id: string }
      try {
        const variants = await db.transaction().execute(async (trx) => {
          const media = await trx.selectFrom('product_media').select('id').where('id', '=', id).forUpdate().executeTakeFirst()
          if (!media) throw new CatalogError(404, 'MEDIA_NOT_FOUND', 'The image does not exist')
          const rows = await trx.selectFrom('product_media_variants').selectAll().where('media_id', '=', id).execute()
          await trx.deleteFrom('product_media').where('id', '=', id).execute()
          return rows
        })
        const cleanup = await Promise.allSettled(variants.map((variant) => storage.removePublished(
          id, variant.variant, variant.storage_key,
        )))
        const cleanupPending = cleanup.some((result) => result.status === 'rejected')
        if (cleanupPending) request.log.error({ mediaId: id }, 'deleted media has an orphaned storage object')
        return reply.send(success({ id, deleted: true as const, cleanupPending }, request.id))
      } catch (error) {
        return fail(reply, error, request.id)
      }
    })

    scope.get('/api/v1/admin/products/:id/media', {
      preHandler: authenticate,
      schema: {
        tags: ['admin', 'catalog'],
        summary: 'Read ordered product gallery images',
        params: ProductIdParamsSchema,
        response: { 200: ApiSuccessSchemaOf(ProductGalleryResponseSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
      },
    }, async (request, reply) => {
      const { id } = request.params as { id: string }
      const product = await db.selectFrom('products').select('revision').where('id', '=', id).executeTakeFirst()
      if (!product) return reply.code(404).send(failure('PRODUCT_NOT_FOUND', 'The product does not exist', request.id))
      return reply.send(success({ productId: id, revision: product.revision, images: await loadProductGallery(db, id) }, request.id))
    })

    scope.put('/api/v1/admin/products/:id/media', {
      preHandler: [authenticate, csrfCheck],
      schema: {
        tags: ['admin', 'catalog'],
        summary: 'Replace and order a product gallery',
        params: ProductIdParamsSchema,
        body: ReplaceProductGalleryBodySchema,
        response: {
          200: ApiSuccessSchemaOf(ProductGalleryResponseSchema),
          400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
        },
      },
    }, async (request, reply) => {
      const { id } = request.params as { id: string }
      try {
        const result = await saveGallery(db, id, request.admin!.id, request.body as ReplaceProductGalleryBody)
        const images = await loadProductGallery(db, id)
        return reply.send(success({ productId: id, revision: result.revision, images }, request.id))
      } catch (error) {
        return fail(reply, error, request.id)
      }
    })

    scope.put('/api/v1/admin/products/:id/rich-content', {
      bodyLimit: 320 * 1024,
      preHandler: [authenticate, csrfCheck],
      schema: {
        tags: ['admin', 'catalog'],
        summary: 'Validate and save Tiptap product rich content',
        params: ProductIdParamsSchema,
        body: SaveProductRichContentBodySchema,
        response: {
          200: ApiSuccessSchemaOf(ProductRichContentResponseSchema),
          400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
        },
      },
    }, async (request, reply) => {
      const { id } = request.params as { id: string }
      try {
        const result = await saveRichContent(db, id, request.admin!.id, request.body as SaveProductRichContentBody)
        return reply.send(success({ productId: id, revision: result.revision, content: result.content }, request.id))
      } catch (error) {
        return fail(reply, error, request.id)
      }
    })

    scope.route({
      method: ['GET', 'HEAD'],
      url: '/api/v1/media/:id/:variant.webp',
      schema: { params: MediaVariantParamsSchema },
      handler: async (request, reply) => {
        const { id, variant } = request.params as { id: string; variant: ProductMediaVariant }
        const row = await db.selectFrom('product_media_variants').selectAll()
          .where('media_id', '=', id).where('variant', '=', variant).executeTakeFirst()
        if (!row) return reply.code(404).send(failure('MEDIA_NOT_FOUND', 'The image does not exist', request.id))
        const etag = `"${row.sha256.trim()}"`
        const lastModified = row.created_at.toUTCString()
        reply.header('Content-Type', imageMimeForStoredFormat(row.format))
          .header('Content-Length', String(row.size_bytes))
          .header('Cache-Control', 'public, max-age=31536000, immutable')
          .header('ETag', etag)
          .header('Last-Modified', lastModified)
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Disposition', 'inline')

        const ifNoneMatch = request.headers['if-none-match']
        if (ifNoneMatch !== undefined) {
          const values = (Array.isArray(ifNoneMatch) ? ifNoneMatch : [ifNoneMatch]).flatMap((header) => header.split(','))
          if (values.some((value) => {
            const candidate = value.trim()
            return candidate === '*' || candidate === etag || candidate === `W/${etag}`
          })) return reply.code(304).send()
        } else if (request.headers['if-modified-since']) {
          const since = Date.parse(request.headers['if-modified-since'])
          if (Number.isFinite(since) && Math.floor(row.created_at.getTime() / 1000) <= Math.floor(since / 1000)) {
            return reply.code(304).send()
          }
        }

        let opened: Awaited<ReturnType<MediaStorage['openForRead']>>
        try {
          opened = await storage.openForRead(row.media_id, row.variant, row.storage_key, row.size_bytes)
        } catch (error) {
          request.log.error({ err: error, mediaId: id, variant }, 'published media file is missing or invalid')
          return reply.code(503).send(failure('MEDIA_FILE_UNAVAILABLE', 'The image file is temporarily unavailable', request.id))
        }
        if (request.method === 'HEAD') return reply.send()
        return reply.send(opened.stream)
      },
    })
  })
}
