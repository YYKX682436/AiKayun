import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { parseUnitAmount } from '@aikayun/money'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  ProductAuditHistoryPageSchema,
  ProductAuditHistoryQuerySchema,
  ProductDeleteResultSchema,
  ProductExpectedRevisionBodySchema,
  ProductIdParamsSchema,
  ProductVariantIdParamsSchema,
  ProductListQuerySchema,
  ProductListResponseSchema,
  ProductDetailSchema,
  UpdateProductBodySchema,
  UpdateProductLifecycleBodySchema,
  UpdateProductPurchaseLimitsBodySchema,
  UpdateSkuPurchaseLimitsBodySchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  ProductAuditHistoryQuery,
  ProductAuditSnapshot,
  ProductDetail,
  ProductListQuery,
  ProductListResponse,
  ProductManagementAuditEvent,
  ProductManagementOperation,
  ProductStatus,
  ProductType,
  UpdateProductBody,
  UpdateProductLifecycleBody,
  UpdateProductPurchaseLimitsBody,
  UpdateSkuPurchaseLimitsBody,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { Database } from '../db/types.js'
import { CatalogError, sendCatalogError } from './errors.js'
import { appendProductAudit, type ProductAuditData } from './product-audit.js'
import { assertProductNotArchived, lockProductAtRevision } from './admin-product-guards.js'
import type { LockedProduct } from './admin-product-guards.js'
import { defaultProductIdentityFactory, loadProduct } from './admin-products.js'
import type { ProductIdentityFactory } from './admin-products.js'
import { validateProductRichContent } from '../media/rich-content.js'

const defaultPageSize = 20

function descriptionLength(value: string): number {
  return Array.from(value).length
}

function auditSnapshot(
  product: Pick<LockedProduct, 'name' | 'description' | 'product_type' | 'status' | 'revision'>,
  extra: Partial<Pick<ProductAuditSnapshot,
    'description' | 'changedFields' | 'descriptionChanged' | 'skuCount' | 'sourceProductId'
      | 'galleryCount' | 'galleryMediaIds' | 'richContentSummary'
  >> = {},
): ProductAuditSnapshot {
  return {
    name: product.name,
    productType: product.product_type,
    status: product.status,
    revision: product.revision,
    descriptionLength: descriptionLength(product.description),
    ...extra,
  }
}

function normalizedProductName(value: string): string {
  const name = value.trim()
  if (!name) throw new CatalogError(400, 'INVALID_PRODUCT_NAME', 'Product name must not be empty')
  if (descriptionLength(name) > 200) {
    throw new CatalogError(400, 'INVALID_PRODUCT_NAME', 'Product name must be at most 200 characters')
  }
  return name
}

function validProductType(value: string): value is ProductType {
  return value === 'physical' || value === 'digital' || value === 'service'
}

async function assertProductTypeCanChange(db: Kysely<Database>, product: LockedProduct): Promise<void> {
  if (product.status !== 'draft' && product.status !== 'paused') {
    throw new CatalogError(409, 'PRODUCT_TYPE_CHANGE_REQUIRES_DRAFT_OR_PAUSED', 'Take the product out of sale before changing its type')
  }

  const orderReference = await db.selectFrom('order_items').select('id')
    .where('product_id', '=', product.id).limit(1).executeTakeFirst()
  if (orderReference) {
    throw new CatalogError(409, 'PRODUCT_TYPE_CHANGE_BLOCKED', 'Product type cannot change after an order references the product')
  }

  // Keep the same parent -> SKU -> inventory lock order as D2/D3 writers.
  const variants = await db.selectFrom('product_variants')
    .select(['id', 'retired_at', 'inventory_mode'])
    .where('product_id', '=', product.id).orderBy('id').forUpdate().execute()
  if (variants.some((variant) => variant.retired_at !== null || variant.inventory_mode !== null)) {
    throw new CatalogError(409, 'PRODUCT_TYPE_CHANGE_BLOCKED', 'Product type cannot change after a SKU has been retired or inventory mode has been configured')
  }

  const quantityState = await db.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
    .where('product_id', '=', product.id).limit(1).executeTakeFirst()
  if (quantityState) {
    throw new CatalogError(409, 'PRODUCT_TYPE_CHANGE_BLOCKED', 'Product type cannot change while inventory state exists')
  }

  const adjustment = await db.selectFrom('product_variant_inventory_adjustments').select('id')
    .where('product_id', '=', product.id).limit(1).executeTakeFirst()
  if (adjustment) {
    throw new CatalogError(409, 'PRODUCT_TYPE_CHANGE_BLOCKED', 'Product type cannot change after inventory history exists')
  }
}

async function assertProductPublishable(db: Kysely<Database>, product: LockedProduct): Promise<void> {
  if (!product.name.trim() || product.name !== product.name.trim() || descriptionLength(product.name) > 200) {
    throw new CatalogError(409, 'PRODUCT_PUBLICATION_DATA_INVALID', 'Set a valid product name before publishing')
  }
  if (!validProductType(product.product_type)) {
    throw new CatalogError(409, 'PRODUCT_PUBLICATION_DATA_INVALID', 'Set a supported product type before publishing')
  }

  const state = await sql<{ sku_count: number; invalid_enabled_sku: boolean }>`
    SELECT
      (SELECT count(*)::integer FROM product_variants AS variant WHERE variant.product_id = ${product.id}::uuid) AS sku_count,
      EXISTS (
        SELECT 1
        FROM product_variants AS variant
        WHERE variant.product_id = ${product.id}::uuid AND variant.enabled
          AND (
            ((SELECT count(*) FROM product_option_groups AS option_group
              WHERE option_group.product_id = variant.product_id AND option_group.enabled) = 0
              AND EXISTS (
                SELECT 1 FROM product_variant_option_values AS selected
                WHERE selected.product_id = variant.product_id AND selected.product_variant_id = variant.id
              ))
            OR (
              (SELECT count(*) FROM product_option_groups AS option_group
               WHERE option_group.product_id = variant.product_id AND option_group.enabled) > 0
              AND (
                (SELECT count(*) FROM product_variant_option_values AS selected
                 WHERE selected.product_id = variant.product_id AND selected.product_variant_id = variant.id)
                  <> (SELECT count(*) FROM product_option_groups AS option_group
                      WHERE option_group.product_id = variant.product_id AND option_group.enabled)
                OR EXISTS (
                  SELECT 1
                  FROM product_variant_option_values AS selected
                  JOIN product_option_groups AS option_group
                    ON option_group.product_id = selected.product_id AND option_group.id = selected.option_group_id
                  JOIN product_option_values AS option_value
                    ON option_value.product_id = selected.product_id
                    AND option_value.option_group_id = selected.option_group_id
                    AND option_value.id = selected.option_value_id
                  WHERE selected.product_id = variant.product_id
                    AND selected.product_variant_id = variant.id
                    AND (NOT option_group.enabled OR NOT option_value.enabled)
                )
                OR EXISTS (
                  SELECT 1 FROM product_option_groups AS option_group
                  WHERE option_group.product_id = variant.product_id AND option_group.enabled
                    AND NOT EXISTS (
                      SELECT 1 FROM product_variant_option_values AS selected
                      WHERE selected.product_id = variant.product_id
                        AND selected.product_variant_id = variant.id
                        AND selected.option_group_id = option_group.id
                    )
                )
              )
            )
          )
      ) AS invalid_enabled_sku
  `.execute(db)
  const catalogState = state.rows[0]
  if (!catalogState || catalogState.sku_count < 1) {
    throw new CatalogError(409, 'PRODUCT_SKU_REQUIRED', 'A product must have at least one SKU before publishing')
  }
  if (catalogState.invalid_enabled_sku) {
    throw new CatalogError(409, 'PRODUCT_SPECIFICATION_INVALID', 'Fix enabled SKU specification combinations before publishing')
  }
}

function lifecycleOperation(from: ProductStatus, to: ProductStatus): ProductManagementOperation | undefined {
  if (from === 'draft' && to === 'active') return 'published'
  if (from === 'active' && to === 'paused') return 'paused'
  if (from === 'paused' && to === 'active') return 'relisted'
  if ((from === 'draft' || from === 'active' || from === 'paused') && to === 'archived') return 'archived'
  if (from === 'archived' && to === 'draft') return 'restored'
  return undefined
}

type ProductListDbRow = {
  id: string
  name: string
  product_type: ProductType
  status: ProductStatus
  cover_image_id: string | null
  cover_created_at: Date | null
  cover_sort_order: number | null
  cover_width: number | null
  cover_height: number | null
  sku_count: number
  min_sale_price: string | null
  max_sale_price: string | null
  categories: ProductListResponse['items'][number]['categories']
  revision: number
  created_at: Date
  updated_at: Date
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`)
}

async function listProducts(db: Kysely<Database>, query: ProductListQuery): Promise<ProductListResponse> {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? defaultPageSize
  const offset = (page - 1) * pageSize
  const predicates = [sql`TRUE`]
  if (query.status) predicates.push(sql`product.status = ${query.status}`)
  if (query.productType) predicates.push(sql`product.product_type = ${query.productType}`)
  if (query.categoryId) predicates.push(sql`EXISTS (
    SELECT 1 FROM product_category_assignments AS assignment
    WHERE assignment.product_id = product.id AND assignment.category_id = ${query.categoryId}::uuid
  )`)
  if (query.search !== undefined) {
    const search = query.search.trim()
    if (!search) throw new CatalogError(400, 'INVALID_PRODUCT_SEARCH', 'Product search must not be empty')
    const pattern = `%${escapeLike(search)}%`
    predicates.push(sql`(
      product.name ILIKE ${pattern} ESCAPE '\\'
      OR product.id::text ILIKE ${pattern} ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM product_variants AS searched_variant
        WHERE searched_variant.product_id = product.id
          AND searched_variant.sku_code ILIKE ${pattern} ESCAPE '\\'
      )
    )`)
  }
  const where = sql`WHERE ${sql.join(predicates, sql` AND `)}`
  const totalResult = await sql<{ total: number }>`
    SELECT count(*)::integer AS total FROM products AS product ${where}
  `.execute(db)
  const sortOrder = query.sortOrder ?? 'desc'
  const sortExpression = query.sortBy === 'createdAt'
    ? 'product.created_at'
    : query.sortBy === 'price'
      ? '(SELECT min(price_variant.sale_price) FROM product_variants AS price_variant WHERE price_variant.product_id = product.id AND price_variant.retired_at IS NULL)'
      : 'product.updated_at'
  const rows = await sql<ProductListDbRow>`
    SELECT
      product.id,
      product.name,
      product.product_type,
      product.status,
      cover.media_id AS cover_image_id,
      cover.created_at AS cover_created_at,
      cover.sort_order AS cover_sort_order,
      cover.width AS cover_width,
      cover.height AS cover_height,
      product.revision,
      product.created_at,
      product.updated_at,
      (SELECT count(*)::integer FROM product_variants AS variant WHERE variant.product_id = product.id) AS sku_count,
      (SELECT min(variant.sale_price)::text FROM product_variants AS variant
       WHERE variant.product_id = product.id AND variant.retired_at IS NULL) AS min_sale_price,
      (SELECT max(variant.sale_price)::text FROM product_variants AS variant
       WHERE variant.product_id = product.id AND variant.retired_at IS NULL) AS max_sale_price,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'categoryId', category.id,
          'name', category.name,
          'isPrimary', assignment.is_primary,
          'sortOrder', assignment.sort_order
        ) ORDER BY assignment.is_primary DESC, assignment.sort_order, category.id)
        FROM product_category_assignments AS assignment
        INNER JOIN product_categories AS category ON category.id = assignment.category_id
        WHERE assignment.product_id = product.id
      ), '[]'::jsonb) AS categories
    FROM products AS product
    LEFT JOIN LATERAL (
      SELECT media.id AS media_id, media.created_at, reference.sort_order, image.width, image.height
      FROM product_media_references AS reference
      INNER JOIN product_media AS media ON media.id = reference.media_id
      INNER JOIN product_media_variants AS image ON image.media_id = media.id AND image.variant = 'detail'
      WHERE reference.product_id = product.id AND reference.source = 'gallery'
      ORDER BY reference.sort_order, media.id
      LIMIT 1
    ) AS cover ON TRUE
    ${where}
    ORDER BY ${sql.raw(sortExpression)} ${sql.raw(sortOrder)} NULLS LAST, product.id ASC
    LIMIT ${pageSize} OFFSET ${offset}
  `.execute(db)

  const total = totalResult.rows[0]?.total ?? 0
  const items = rows.rows.map((row) => {
    if (row.sku_count < 1) {
      throw new Error('Product list encountered a product without a SKU')
    }
    if ((row.min_sale_price === null) !== (row.max_sale_price === null)) {
      throw new Error('Product list encountered an incomplete active SKU price range')
    }
    const priceRange = row.min_sale_price === null || row.max_sale_price === null
      ? null
      : {
          min: parseUnitAmount(row.min_sale_price).toFixed(2),
          max: parseUnitAmount(row.max_sale_price).toFixed(2),
          currency: 'CNY' as const,
        }
    return {
      id: row.id,
      name: row.name,
      productType: row.product_type,
      status: row.status,
      coverImage: row.cover_image_id === null || !row.cover_created_at || row.cover_width === null || row.cover_height === null ? null : {
        id: row.cover_image_id,
        sortOrder: row.cover_sort_order ?? 0,
        width: row.cover_width,
        height: row.cover_height,
        thumbnailUrl: `/api/v1/media/${row.cover_image_id}/thumbnail.webp`,
        cardUrl: `/api/v1/media/${row.cover_image_id}/card.webp`,
        detailUrl: `/api/v1/media/${row.cover_image_id}/detail.webp`,
        createdAt: row.cover_created_at.toISOString(),
      },
      skuCount: row.sku_count,
      priceRange,
      categories: row.categories,
      revision: row.revision,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }
  })
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  }
}

type ProductAuditDbRow = {
  id: string
  product_id: string
  administrator_id: string
  operation: ProductManagementOperation
  before_data: ProductAuditData
  after_data: ProductAuditData
  created_at: Date
  cursor_created_at: string
}

async function readProductHistory(
  db: Kysely<Database>,
  productId: string,
  query: ProductAuditHistoryQuery,
): Promise<{ events: ProductManagementAuditEvent[]; nextCursor: { createdAt: string; id: string } | null }> {
  const limit = query.limit ?? 50
  let statement = db.selectFrom('product_management_audit_events')
    .select([
      'id', 'product_id', 'administrator_id', 'operation', 'before_data', 'after_data', 'created_at',
      sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('cursor_created_at'),
    ])
    .where('product_id', '=', productId)
  if (query.beforeCreatedAt !== undefined || query.beforeId !== undefined) {
    if (!query.beforeCreatedAt || !query.beforeId) {
      throw new CatalogError(400, 'INVALID_AUDIT_CURSOR', 'Both audit cursor fields are required')
    }
    statement = statement.where(sql<boolean>`(
      created_at < ${query.beforeCreatedAt}::timestamptz
      OR (created_at = ${query.beforeCreatedAt}::timestamptz AND id < ${query.beforeId}::uuid)
    )`)
  }
  const rows = await statement.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute() as ProductAuditDbRow[]
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const events = pageRows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    administratorId: row.administrator_id,
    operation: row.operation,
    occurredAt: row.created_at.toISOString(),
    before: row.before_data as ProductAuditSnapshot | null,
    after: row.after_data as ProductAuditSnapshot | null,
  }))
  const last = pageRows.at(-1)
  return {
    events,
    nextCursor: hasMore && last ? { createdAt: last.cursor_created_at, id: last.id } : null,
  }
}

function fail(reply: FastifyReply, error: unknown, requestId: string) {
  return sendCatalogError(reply, error, requestId)
}

function requestAdministratorId(request: { admin: { id: string } | null }, reply: FastifyReply, requestId: string): string | undefined {
  if (request.admin) return request.admin.id
  void reply.code(401).send(failure('UNAUTHORIZED', 'Administrator authentication is required', requestId))
  return undefined
}

async function updateProduct(
  db: Kysely<Database>,
  productId: string,
  administratorId: string,
  body: UpdateProductBody,
) {
  return db.transaction().execute(async (trx) => {
    const product = await lockProductAtRevision(trx, productId, body.expectedRevision)
    assertProductNotArchived(product)
    const changes: { name?: string; description?: string; product_type?: ProductType } = {}
    if (Object.hasOwn(body, 'name')) {
      const name = normalizedProductName(body.name!)
      if (name !== product.name) changes.name = name
    }
    if (Object.hasOwn(body, 'description') && body.description !== product.description) {
      changes.description = body.description!
    }
    if (Object.hasOwn(body, 'productType') && body.productType !== product.product_type) {
      if (!validProductType(body.productType!)) {
        throw new CatalogError(400, 'INVALID_PRODUCT_TYPE', 'Product type is invalid')
      }
      await assertProductTypeCanChange(trx, product)
      changes.product_type = body.productType!
    }
    const changedFields = Object.keys(changes).map((field) => field === 'product_type' ? 'productType' : field) as Array<'name' | 'description' | 'productType'>
    if (changedFields.length === 0) {
      const unchanged = await loadProduct(trx, productId)
      if (!unchanged) throw new Error('Unchanged product could not be read inside its transaction')
      return unchanged
    }

    const updated = await trx.updateTable('products').set(changes)
      .where('id', '=', productId).returningAll().executeTakeFirstOrThrow()
    await appendProductAudit(trx, {
      productId,
      administratorId,
      operation: 'updated',
      before: auditSnapshot(product, {
        changedFields,
        descriptionChanged: changedFields.includes('description'),
        ...(changedFields.includes('description') ? { description: product.description } : {}),
      }),
      after: auditSnapshot(updated, {
        changedFields,
        descriptionChanged: changedFields.includes('description'),
        ...(changedFields.includes('description') ? { description: updated.description } : {}),
      }),
    })
    const detail = await loadProduct(trx, productId)
    if (!detail) throw new Error('Updated product could not be read inside its transaction')
    return detail
  })
}

async function transitionProduct(
  db: Kysely<Database>,
  productId: string,
  administratorId: string,
  body: UpdateProductLifecycleBody,
) {
  return db.transaction().execute(async (trx) => {
    const product = await lockProductAtRevision(trx, productId, body.expectedRevision)
    if (product.status === body.status) {
      const unchanged = await loadProduct(trx, productId)
      if (!unchanged) throw new Error('Unchanged product could not be read inside its transaction')
      return unchanged
    }
    const operation = lifecycleOperation(product.status, body.status)
    if (!operation) {
      throw new CatalogError(409, 'PRODUCT_LIFECYCLE_TRANSITION_INVALID', `Cannot move a ${product.status} product to ${body.status}`)
    }
    if (body.status === 'active') await assertProductPublishable(trx, product)

    const updated = await trx.updateTable('products').set({ status: body.status })
      .where('id', '=', productId).returningAll().executeTakeFirstOrThrow()
    await appendProductAudit(trx, {
      productId,
      administratorId,
      operation,
      before: auditSnapshot(product),
      after: auditSnapshot(updated),
    })
    const detail = await loadProduct(trx, productId)
    if (!detail) throw new Error('Updated product could not be read inside its transaction')
    return detail
  })
}

async function updateProductPurchaseLimits(
  db: Kysely<Database>,
  productId: string,
  administratorId: string,
  body: UpdateProductPurchaseLimitsBody,
): Promise<ProductDetail> {
  return db.transaction().execute(async (trx) => {
    const product = await lockProductAtRevision(trx, productId, body.expectedRevision)
    assertProductNotArchived(product)
    const beforeLimits = {
      perOrder: product.purchase_limit_per_order,
      lifetime: product.purchase_limit_lifetime,
      rolling24Hours: product.purchase_limit_24h,
    }
    const next = body.purchaseLimits
    if (beforeLimits.perOrder !== next.perOrder || beforeLimits.lifetime !== next.lifetime
      || beforeLimits.rolling24Hours !== next.rolling24Hours) {
      await trx.updateTable('products').set({
        purchase_limit_per_order: next.perOrder,
        purchase_limit_lifetime: next.lifetime,
        purchase_limit_24h: next.rolling24Hours,
      }).where('id', '=', productId).execute()
      await appendProductAudit(trx, {
        productId,
        administratorId,
        operation: 'updated',
        before: { revision: product.revision, purchaseLimits: beforeLimits },
        after: { revision: product.revision + 1, purchaseLimits: next },
      })
    }
    const detail = await loadProduct(trx, productId)
    if (!detail) throw new Error('Updated product purchase limits could not be read')
    return detail
  })
}

async function updateSkuPurchaseLimits(
  db: Kysely<Database>,
  productId: string,
  skuId: string,
  administratorId: string,
  body: UpdateSkuPurchaseLimitsBody,
): Promise<ProductDetail> {
  return db.transaction().execute(async (trx) => {
    const product = await lockProductAtRevision(trx, productId, body.expectedProductRevision)
    assertProductNotArchived(product)
    const variant = await trx.selectFrom('product_variants').selectAll()
      .where('product_id', '=', productId).where('id', '=', skuId)
      .forUpdate().executeTakeFirst()
    if (!variant) throw new CatalogError(404, 'PRODUCT_VARIANT_NOT_FOUND', 'The SKU does not belong to this product')
    if (variant.retired_at) {
      throw new CatalogError(409, 'PRODUCT_VARIANT_RETIRED', 'Purchase limits on a permanently retired SKU cannot be changed')
    }
    if (variant.revision !== body.expectedSkuRevision) {
      throw new CatalogError(409, 'PRODUCT_REVISION_CONFLICT', 'The product or SKU changed; reload it and retry')
    }
    const beforeLimits = {
      perOrder: variant.purchase_limit_per_order,
      lifetime: variant.purchase_limit_lifetime,
      rolling24Hours: variant.purchase_limit_24h,
    }
    const next = body.purchaseLimits
    if (beforeLimits.perOrder !== next.perOrder || beforeLimits.lifetime !== next.lifetime
      || beforeLimits.rolling24Hours !== next.rolling24Hours) {
      await trx.updateTable('product_variants').set({
        purchase_limit_per_order: next.perOrder,
        purchase_limit_lifetime: next.lifetime,
        purchase_limit_24h: next.rolling24Hours,
      }).where('product_id', '=', productId).where('id', '=', skuId).execute()
      await appendProductAudit(trx, {
        productId,
        administratorId,
        operation: 'updated',
        before: { skuId, skuRevision: variant.revision, purchaseLimits: beforeLimits },
        after: { skuId, skuRevision: variant.revision + 1, purchaseLimits: next },
      })
    }
    const detail = await loadProduct(trx, productId)
    if (!detail) throw new Error('Updated SKU purchase limits could not be read')
    return detail
  })
}

function copiedCombinationKey(optionValueIds: string[]): string {
  if (optionValueIds.length === 0) return ''
  return `v1:${optionValueIds.map((id) => id.toLowerCase()).sort().join('.')}`
}

async function copyProduct(
  db: Kysely<Database>,
  sourceProductId: string,
  administratorId: string,
  expectedRevision: number,
  identityFactory: ProductIdentityFactory,
) {
  return db.transaction().execute(async (trx) => {
    const source = await lockProductAtRevision(trx, sourceProductId, expectedRevision)
    const sourceVariants = await trx.selectFrom('product_variants').selectAll()
      .where('product_id', '=', sourceProductId).orderBy('id').forUpdate().execute()
    if (sourceVariants.length === 0) {
      throw new CatalogError(409, 'PRODUCT_SKU_REQUIRED', 'The source product has no SKU to copy')
    }
    const groups = await trx.selectFrom('product_option_groups').selectAll()
      .where('product_id', '=', sourceProductId).orderBy('sort_order').orderBy('id').execute()
    const values = await trx.selectFrom('product_option_values').selectAll()
      .where('product_id', '=', sourceProductId).orderBy('option_group_id').orderBy('sort_order').orderBy('id').execute()
    const attributes = await trx.selectFrom('product_attributes').selectAll()
      .where('product_id', '=', sourceProductId).orderBy('sort_order').orderBy('id').execute()
    const categories = await trx.selectFrom('product_category_assignments').selectAll()
      .where('product_id', '=', sourceProductId).orderBy('category_id').execute()
    const selections = await trx.selectFrom('product_variant_option_values').selectAll()
      .where('product_id', '=', sourceProductId).orderBy('product_variant_id').orderBy('option_group_id').execute()
    const mediaReferences = await trx.selectFrom('product_media_references').selectAll()
      .where('product_id', '=', sourceProductId).orderBy('source').orderBy('sort_order').orderBy('media_id').execute()
    const content = validateProductRichContent(source.rich_content)
    const sourceContentReferences = mediaReferences.filter((reference) => reference.source === 'rich_content')
      .map((reference) => reference.media_id).sort()
    if (JSON.stringify(sourceContentReferences) !== JSON.stringify([...content.mediaIds].sort())) {
      throw new CatalogError(409, 'PRODUCT_MEDIA_REFERENCE_INCONSISTENT', 'The source product rich content media references are inconsistent')
    }

    const productId = identityFactory.nextProductId()
    await trx.insertInto('products').values({
      id: productId,
      name: source.name,
      description: source.description,
      rich_content: content.document,
      product_type: source.product_type,
      status: 'draft',
    }).execute()

    const groupIds = new Map(groups.map((group) => [group.id, randomUUID()]))
    const valueIds = new Map(values.map((value) => [value.id, randomUUID()]))
    if (groups.length > 0) {
      await trx.insertInto('product_option_groups').values(groups.map((group) => ({
        id: groupIds.get(group.id)!, product_id: productId, name: group.name,
        sort_order: group.sort_order, enabled: group.enabled,
      }))).execute()
    }
    if (values.length > 0) {
      await trx.insertInto('product_option_values').values(values.map((value) => ({
        id: valueIds.get(value.id)!, product_id: productId,
        option_group_id: groupIds.get(value.option_group_id)!, name: value.name,
        sort_order: value.sort_order, enabled: value.enabled,
      }))).execute()
    }
    if (categories.length > 0) {
      await trx.insertInto('product_category_assignments').values(categories.map((assignment) => ({
        product_id: productId,
        category_id: assignment.category_id,
        is_primary: assignment.is_primary,
        sort_order: assignment.sort_order,
      }))).execute()
    }
    if (mediaReferences.length > 0) {
      await trx.insertInto('product_media_references').values(mediaReferences.map((reference) => ({
        product_id: productId,
        media_id: reference.media_id,
        source: reference.source,
        sort_order: reference.sort_order,
      }))).execute()
    }
    if (attributes.length > 0) {
      await trx.insertInto('product_attributes').values(attributes.map((attribute) => ({
        id: randomUUID(), product_id: productId, name: attribute.name,
        value: attribute.value, sort_order: attribute.sort_order,
      }))).execute()
    }

    const copiedVariants = sourceVariants.filter((variant) => variant.retired_at === null)
    const variantsToCopy = copiedVariants.length > 0 ? copiedVariants : [sourceVariants[0]!]
    const variantIds = new Map<string, string>()
    for (const sourceVariant of variantsToCopy) {
      const variantId = identityFactory.nextVariantId()
      variantIds.set(sourceVariant.id, variantId)
      const optionValueIds = copiedVariants.length === 0
        ? []
        : selections.filter((selection) => selection.product_variant_id === sourceVariant.id)
          .map((selection) => valueIds.get(selection.option_value_id)!)
      await trx.insertInto('product_variants').values({
        id: variantId,
        product_id: productId,
        sku_code: identityFactory.nextSkuCode(),
        combination_key: copiedVariants.length === 0 ? '' : copiedCombinationKey(optionValueIds),
        sale_price: sourceVariant.sale_price,
        compare_at_price: sourceVariant.compare_at_price,
        cost_price: sourceVariant.cost_price,
        enabled: copiedVariants.length === 0 ? false : sourceVariant.enabled,
        retired_at: null,
        inventory_mode: null,
        inventory_revision: 0,
      }).execute()
    }
    const copiedSelections = copiedVariants.length === 0 ? [] : selections.flatMap((selection) => {
      const newVariantId = variantIds.get(selection.product_variant_id)
      const newGroupId = groupIds.get(selection.option_group_id)
      const newValueId = valueIds.get(selection.option_value_id)
      if (!newVariantId || !newGroupId || !newValueId) return []
      return [{
        product_id: productId,
        product_variant_id: newVariantId,
        option_group_id: newGroupId,
        option_value_id: newValueId,
      }]
    })
    if (copiedSelections.length > 0) {
      await trx.insertInto('product_variant_option_values').values(copiedSelections).execute()
    }

    const created = await trx.selectFrom('products').selectAll().where('id', '=', productId).executeTakeFirstOrThrow()
    await appendProductAudit(trx, {
      productId,
      administratorId,
      operation: 'copied',
      before: null,
      after: auditSnapshot(created, {
        sourceProductId,
        skuCount: variantsToCopy.length,
        description: created.description,
        galleryCount: mediaReferences.filter((reference) => reference.source === 'gallery').length,
        galleryMediaIds: mediaReferences.filter((reference) => reference.source === 'gallery')
          .sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0)).map((reference) => reference.media_id),
        richContentSummary: content.summary,
      }),
    })
    const detail = await loadProduct(trx, productId)
    if (!detail) throw new Error('Copied product could not be read inside its transaction')
    return detail
  })
}

async function deleteProduct(
  db: Kysely<Database>,
  productId: string,
  administratorId: string,
  expectedRevision: number,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const product = await lockProductAtRevision(trx, productId, expectedRevision)
    const variants = await trx.selectFrom('product_variants').selectAll()
      .where('product_id', '=', productId).orderBy('id').forUpdate().execute()
    if (variants.length === 0) throw new CatalogError(409, 'PRODUCT_SKU_REQUIRED', 'The product has no SKU rows to delete safely')
    const codePoolHistory = await trx.selectFrom('code_pool_batches').select('id')
      .where('product_id', '=', productId).limit(1).executeTakeFirst()
    if (codePoolHistory) {
      throw new CatalogError(409, 'PRODUCT_HAS_CODE_POOL_HISTORY', 'A product with code-pool batch history cannot be deleted; archive it instead')
    }
    if (variants.some((variant) => variant.retired_at !== null)) {
      throw new CatalogError(409, 'PRODUCT_HAS_RETIRED_SKU', 'A product with permanently retired SKU identities cannot be deleted; archive it instead')
    }
    const orderReference = await trx.selectFrom('order_items').select('id')
      .where('product_id', '=', productId).limit(1).executeTakeFirst()
    if (orderReference) {
      throw new CatalogError(409, 'PRODUCT_HAS_ORDER_HISTORY', 'A product referenced by an order cannot be deleted; archive it instead')
    }
    if (variants.some((variant) => variant.inventory_mode === 'resource_pool' || variant.inventory_mode === 'external')) {
      throw new CatalogError(409, 'PRODUCT_HAS_BUSINESS_RESOURCES', 'A product connected to a resource pool or external source cannot be deleted; archive it instead')
    }

    const inventoryRows = await trx.selectFrom('product_variant_quantity_inventory').selectAll()
      .where('product_id', '=', productId).orderBy('product_variant_id').forUpdate().execute()
    if (inventoryRows.some((inventory) => inventory.stocked !== 0 || inventory.reserved !== 0)) {
      throw new CatalogError(409, 'PRODUCT_HAS_INVENTORY', 'A product with stocked or reserved quantity cannot be deleted; archive it instead')
    }
    const hasHistory = await trx.selectFrom('product_variant_inventory_adjustments').select('id')
      .where('product_id', '=', productId).limit(1).executeTakeFirst()
    if (hasHistory) {
      throw new CatalogError(409, 'PRODUCT_HAS_INVENTORY_HISTORY', 'A product with inventory adjustment history cannot be deleted; archive it instead')
    }

    const mediaReferences = await trx.selectFrom('product_media_references')
      .select(['media_id', 'source', 'sort_order'])
      .where('product_id', '=', productId).orderBy('source').orderBy('sort_order').orderBy('media_id').execute()
    const content = validateProductRichContent(product.rich_content)
    const contentReferenceIds = mediaReferences.filter((reference) => reference.source === 'rich_content')
      .map((reference) => reference.media_id).sort()
    if (JSON.stringify(contentReferenceIds) !== JSON.stringify([...content.mediaIds].sort())) {
      throw new CatalogError(409, 'PRODUCT_MEDIA_REFERENCE_INCONSISTENT', 'The saved rich content media references are inconsistent')
    }
    const galleryMediaIds = mediaReferences.filter((reference) => reference.source === 'gallery')
      .sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0)).map((reference) => reference.media_id)

    // Remove only empty quantity state and product-owned relations. The RESTRICT
    // foreign keys on SKU history/resources remain the final protection layer.
    await trx.deleteFrom('product_variant_quantity_inventory').where('product_id', '=', productId).execute()
    // Product deletion removes only its own reference rows. Media is shared and
    // remains protected by the RESTRICT foreign key while any product uses it.
    await trx.deleteFrom('product_media_references').where('product_id', '=', productId).execute()
    await trx.deleteFrom('product_variant_option_values').where('product_id', '=', productId).execute()
    await trx.deleteFrom('product_category_assignments').where('product_id', '=', productId).execute()
    await trx.deleteFrom('product_attributes').where('product_id', '=', productId).execute()
    await trx.deleteFrom('product_option_values').where('product_id', '=', productId).execute()
    await trx.deleteFrom('product_option_groups').where('product_id', '=', productId).execute()
    await trx.deleteFrom('product_variants').where('product_id', '=', productId).execute()

    await appendProductAudit(trx, {
      productId,
      administratorId,
      operation: 'deleted',
      before: auditSnapshot(product, {
        skuCount: variants.length,
        galleryCount: galleryMediaIds.length,
        galleryMediaIds,
        richContentSummary: content.summary,
      }),
      after: null,
    })
    await trx.deleteFrom('products').where('id', '=', productId).execute()
  })
}

export function registerAdminProductManagementRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: AppConfig,
  identityFactory: ProductIdentityFactory = defaultProductIdentityFactory,
): void {
  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  app.get('/api/v1/admin/products', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'List products for administration',
      querystring: ProductListQuerySchema,
      response: {
        200: ApiSuccessSchemaOf(ProductListResponseSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const query = request.query as ProductListQuery
      const result = await db.transaction().setIsolationLevel('repeatable read').execute((trx) => listProducts(trx, query))
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })

  app.patch('/api/v1/admin/products/:id', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Edit product name, basic description, or type',
      params: ProductIdParamsSchema,
      body: UpdateProductBodySchema,
      response: {
        200: ApiSuccessSchemaOf(ProductDetailSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const administratorId = requestAdministratorId(request, reply, request.id)
    if (!administratorId) return
    try {
      const params = request.params as { id: string }
      const result = await updateProduct(db, params.id, administratorId, request.body as UpdateProductBody)
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })

  app.put('/api/v1/admin/products/:id/purchase-limits', {
    preHandler: [authenticate, csrfCheck],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Set product-level per-order and customer purchase limits',
      params: ProductIdParamsSchema,
      body: UpdateProductPurchaseLimitsBodySchema,
      response: {
        200: ApiSuccessSchemaOf(ProductDetailSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const administratorId = requestAdministratorId(request, reply, request.id)
    if (!administratorId) return
    try {
      const result = await updateProductPurchaseLimits(db,
        (request.params as { id: string }).id,
        administratorId,
        request.body as UpdateProductPurchaseLimitsBody)
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })

  app.put('/api/v1/admin/products/:id/variants/:variantId/purchase-limits', {
    preHandler: [authenticate, csrfCheck],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Set purchase limits for one SKU belonging to a product',
      params: ProductVariantIdParamsSchema,
      body: UpdateSkuPurchaseLimitsBodySchema,
      response: {
        200: ApiSuccessSchemaOf(ProductDetailSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const administratorId = requestAdministratorId(request, reply, request.id)
    if (!administratorId) return
    try {
      const params = request.params as { id: string; variantId: string }
      const result = await updateSkuPurchaseLimits(db, params.id, params.variantId,
        administratorId, request.body as UpdateSkuPurchaseLimitsBody)
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })

  app.patch('/api/v1/admin/products/:id/lifecycle', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Change product lifecycle state',
      params: ProductIdParamsSchema,
      body: UpdateProductLifecycleBodySchema,
      response: {
        200: ApiSuccessSchemaOf(ProductDetailSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const administratorId = requestAdministratorId(request, reply, request.id)
    if (!administratorId) return
    try {
      const result = await transitionProduct(db, (request.params as { id: string }).id,
        administratorId, request.body as UpdateProductLifecycleBody)
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })

  app.post('/api/v1/admin/products/:id/copy', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Copy a product to a new draft with new identities',
      params: ProductIdParamsSchema,
      body: ProductExpectedRevisionBodySchema,
      response: {
        201: ApiSuccessSchemaOf(ProductDetailSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const administratorId = requestAdministratorId(request, reply, request.id)
    if (!administratorId) return
    try {
      const result = await copyProduct(db, (request.params as { id: string }).id,
        administratorId, (request.body as { expectedRevision: number }).expectedRevision, identityFactory)
      return reply.code(201).send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })

  app.delete('/api/v1/admin/products/:id', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Permanently delete a product only when it has no retained business references',
      params: ProductIdParamsSchema,
      body: ProductExpectedRevisionBodySchema,
      response: {
        200: ApiSuccessSchemaOf(ProductDeleteResultSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const administratorId = requestAdministratorId(request, reply, request.id)
    if (!administratorId) return
    try {
      const productId = (request.params as { id: string }).id
      const expectedRevision = (request.body as { expectedRevision: number }).expectedRevision
      await deleteProduct(db, productId, administratorId, expectedRevision)
      return reply.send(success({ productId, deleted: true as const }, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })

  app.get('/api/v1/admin/products/:id/history', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Read immutable product management audit history',
      params: ProductIdParamsSchema,
      querystring: ProductAuditHistoryQuerySchema,
      response: {
        200: ApiSuccessSchemaOf(ProductAuditHistoryPageSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const productId = (request.params as { id: string }).id
      const history = await readProductHistory(db, productId, request.query as ProductAuditHistoryQuery)
      return reply.send(success({ productId, ...history }, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })
}
