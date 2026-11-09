import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  PublicStorefrontFeaturedProductsSchema,
  StorefrontFeaturedProductsSchema,
  UpdateStorefrontFeaturedProductsBodySchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  PublicStorefrontFeaturedProducts,
  StorefrontFeaturedProduct,
  UpdateStorefrontFeaturedProductsBody,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import { loadPublicProductCardsByIdOrder } from './public-products.js'

type AdminFeaturedProductRow = {
  id: string
  name: string
  product_type: StorefrontFeaturedProduct['productType']
  status: StorefrontFeaturedProduct['status']
  cover_image_id: string | null
  cover_created_at: Date | null
  cover_sort_order: number | null
  cover_width: number | null
  cover_height: number | null
}

async function readAdminFeaturedProducts(db: Kysely<Database>): Promise<StorefrontFeaturedProduct[]> {
  const result = await sql<AdminFeaturedProductRow>`
    SELECT
      product.id,
      product.name,
      product.product_type,
      product.status,
      cover.media_id AS cover_image_id,
      cover.created_at AS cover_created_at,
      cover.sort_order AS cover_sort_order,
      cover.width AS cover_width,
      cover.height AS cover_height
    FROM storefront_featured_products AS featured
    INNER JOIN products AS product ON product.id = featured.product_id
    LEFT JOIN LATERAL (
      SELECT media.id AS media_id, media.created_at, reference.sort_order, image.width, image.height
      FROM product_media_references AS reference
      INNER JOIN product_media AS media ON media.id = reference.media_id
      INNER JOIN product_media_variants AS image ON image.media_id = media.id AND image.variant = 'detail'
      WHERE reference.product_id = product.id AND reference.source = 'gallery'
      ORDER BY reference.sort_order, media.id
      LIMIT 1
    ) AS cover ON TRUE
    ORDER BY featured.position
  `.execute(db)

  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    productType: row.product_type,
    status: row.status,
    coverImage: row.cover_image_id && row.cover_created_at && row.cover_width !== null && row.cover_height !== null
      ? {
          id: row.cover_image_id,
          sortOrder: row.cover_sort_order ?? 0,
          width: row.cover_width,
          height: row.cover_height,
          thumbnailUrl: `/api/v1/media/${row.cover_image_id}/thumbnail.webp`,
          cardUrl: `/api/v1/media/${row.cover_image_id}/card.webp`,
          detailUrl: `/api/v1/media/${row.cover_image_id}/detail.webp`,
          createdAt: row.cover_created_at.toISOString(),
        }
      : null,
  }))
}

type SaveResult =
  | { items: StorefrontFeaturedProduct[] }
  | { status: 400 | 404 | 409; code: string; message: string }

async function saveFeaturedProducts(
  db: Kysely<Database>,
  productIds: string[],
): Promise<SaveResult> {
  if (productIds.length > 8 || new Set(productIds).size !== productIds.length) {
    return {
      status: 400,
      code: 'STOREFRONT_FEATURED_PRODUCTS_INVALID',
      message: '首页推荐最多可选 8 件商品，且不能重复选择。',
    }
  }

  return await db.transaction().execute(async (trx) => {
    const products = productIds.length
      ? await trx.selectFrom('products')
          .select(['id', 'status'])
          .where('id', 'in', productIds)
          .orderBy('id')
          .forUpdate()
          .execute()
      : []
    if (products.length !== productIds.length) {
      return {
        status: 404,
        code: 'STOREFRONT_FEATURED_PRODUCT_NOT_FOUND',
        message: '所选商品已不存在，请刷新后重新选择。',
      } as const
    }

    // Lock after products in stable order to avoid deadlocks with product deletion cascades.
    // Re-read the existing list only after the lock so concurrent saves validate against committed state.
    await sql`LOCK TABLE storefront_featured_products IN EXCLUSIVE MODE`.execute(trx)
    const currentRows = await trx.selectFrom('storefront_featured_products')
      .select('product_id')
      .execute()
    const previouslyFeatured = new Set(currentRows.map(row => row.product_id))

    if (products.some(product => product.status !== 'active' && !previouslyFeatured.has(product.id))) {
      return {
        status: 409,
        code: 'STOREFRONT_FEATURED_PRODUCT_NOT_ACTIVE',
        message: '只能新增正在销售的商品。已暂停或归档的既有推荐会保留，但不会在商城公开展示。',
      } as const
    }

    await trx.deleteFrom('storefront_featured_products').execute()
    if (productIds.length) {
      await trx.insertInto('storefront_featured_products').values(
        productIds.map((productId, index) => ({ position: index + 1, product_id: productId })),
      ).execute()
    }

    return { items: await readAdminFeaturedProducts(trx) }
  })
}

export function registerStorefrontFeaturedProductRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: AppConfig,
): void {
  app.get('/api/v1/public/storefront/featured-products', {
    schema: {
      tags: ['public-storefront'],
      summary: 'Read ordered active storefront featured products',
      response: { 200: ApiSuccessSchemaOf(PublicStorefrontFeaturedProductsSchema) },
    },
  }, async (request, reply) => {
    const response: PublicStorefrontFeaturedProducts = await db.transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        const rows = await trx.selectFrom('storefront_featured_products')
          .select('product_id')
          .orderBy('position')
          .execute()
        return {
          products: await loadPublicProductCardsByIdOrder(trx, rows.map(row => row.product_id)),
        }
      })
    reply.header('cache-control', 'no-store')
    return success(response, request.id)
  })

  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  app.get('/api/v1/admin/storefront/featured-products', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Read ordered homepage featured products',
      response: {
        200: ApiSuccessSchemaOf(StorefrontFeaturedProductsSchema),
        401: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const response = { items: await readAdminFeaturedProducts(db) }
    reply.header('cache-control', 'no-store')
    return success(response, request.id)
  })

  app.put('/api/v1/admin/storefront/featured-products', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Atomically replace ordered homepage featured products',
      body: UpdateStorefrontFeaturedProductsBodySchema,
      response: {
        200: ApiSuccessSchemaOf(StorefrontFeaturedProductsSchema),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as UpdateStorefrontFeaturedProductsBody
    const result = await saveFeaturedProducts(db, body.productIds)
    reply.header('cache-control', 'no-store')
    if ('status' in result) {
      return reply.code(result.status).send(failure(result.code, result.message, request.id))
    }
    return success({ items: result.items }, request.id)
  })
}
