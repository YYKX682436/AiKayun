import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Kysely } from 'kysely'
import {
  AdminProductVariantPricesSchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  ProductVariantIdParamsSchema,
  UpdateAdminProductVariantPricesBodySchema,
  success,
} from '@aikayun/contracts'
import type { AdminProductVariantPrices, UpdateAdminProductVariantPricesBody } from '@aikayun/contracts'
import { parseUnitAmount } from '@aikayun/money'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { Database } from '../db/types.js'
import { CatalogError, sendCatalogError } from './errors.js'
import { assertProductNotArchived, lockProductAtRevision } from './admin-product-guards.js'

const salePricePattern = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?(?![\s\S])/u
const costPricePattern = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,5})?(?![\s\S])/u

function normalizeSalePrice(value: string): string {
  if (!salePricePattern.test(value)) {
    throw new CatalogError(400, 'INVALID_SALE_PRICE', 'Sale price must be a non-negative CNY decimal with at most two fractional digits')
  }
  return parseUnitAmount(value).toFixed(2)
}

function normalizeOptionalPrice(value: string | null, kind: 'compare' | 'cost'): string | null {
  if (value === null) return null
  const pattern = kind === 'compare' ? salePricePattern : costPricePattern
  if (!pattern.test(value)) {
    const message = kind === 'compare'
      ? 'Compare-at price must be a non-negative CNY decimal with at most two fractional digits'
      : 'Cost price must be a non-negative CNY decimal with at most five fractional digits'
    throw new CatalogError(400, kind === 'compare' ? 'INVALID_COMPARE_AT_PRICE' : 'INVALID_COST_PRICE', message)
  }
  const amount = parseUnitAmount(value)
  if (amount.isNegative() || (kind === 'compare' && amount.decimalPlaces() > 2)) {
    throw new CatalogError(400, kind === 'compare' ? 'INVALID_COMPARE_AT_PRICE' : 'INVALID_COST_PRICE', 'The optional price does not match its supported precision')
  }
  return kind === 'compare' ? amount.toFixed(2) : amount.toFixed(5)
}

type PriceRow = {
  product_id: string
  product_revision: number
  sku_id: string
  sku_code: string
  sku_revision: number
  sale_price: string
  compare_at_price: string | null
  cost_price: string | null
  retired_at: Date | null
  updated_at: Date
}

async function selectPriceRow(db: Kysely<Database>, productId: string, skuId: string): Promise<PriceRow | undefined> {
  return db.selectFrom('product_variants as variant')
    .innerJoin('products as product', 'product.id', 'variant.product_id')
    .select([
      'product.id as product_id', 'product.revision as product_revision',
      'variant.id as sku_id', 'variant.sku_code', 'variant.revision as sku_revision',
      'variant.sale_price', 'variant.compare_at_price', 'variant.cost_price',
      'variant.retired_at', 'variant.updated_at',
    ])
    .where('variant.product_id', '=', productId)
    .where('variant.id', '=', skuId)
    .executeTakeFirst()
}

function toPriceContract(row: PriceRow): AdminProductVariantPrices {
  return {
    productId: row.product_id,
    productRevision: row.product_revision,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuRevision: row.sku_revision,
    salePrice: parseUnitAmount(row.sale_price).toFixed(2),
    compareAtPrice: row.compare_at_price === null ? null : parseUnitAmount(row.compare_at_price).toFixed(2),
    costPrice: row.cost_price === null ? null : parseUnitAmount(row.cost_price).toFixed(5),
    currency: 'CNY',
    retiredAt: row.retired_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  }
}

function fail(reply: FastifyReply, error: unknown, requestId: string) {
  return sendCatalogError(reply, error, requestId)
}

export function registerAdminProductPriceRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  app.get('/api/v1/admin/products/:id/variants/:variantId/prices', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Read internal pricing for one product SKU',
      params: ProductVariantIdParamsSchema,
      response: {
        200: ApiSuccessSchemaOf(AdminProductVariantPricesSchema),
        401: ApiErrorSchema, 404: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { id: productId, variantId } = request.params as { id: string; variantId: string }
    try {
      const row = await selectPriceRow(db, productId, variantId)
      if (!row) throw new CatalogError(404, 'SKU_NOT_FOUND', 'The SKU does not belong to this product')
      return reply.send(success(toPriceContract(row), request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })

  app.patch('/api/v1/admin/products/:id/variants/:variantId/prices', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Update CNY pricing for one product SKU',
      params: ProductVariantIdParamsSchema,
      body: UpdateAdminProductVariantPricesBodySchema,
      response: {
        200: ApiSuccessSchemaOf(AdminProductVariantPricesSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as UpdateAdminProductVariantPricesBody
    const { id: productId, variantId } = request.params as { id: string; variantId: string }
    try {
      const result = await db.transaction().execute(async (trx) => {
        const product = await lockProductAtRevision(trx, productId, body.expectedRevision)
        assertProductNotArchived(product)

        const variant = await trx.selectFrom('product_variants').selectAll()
          .where('product_id', '=', productId).where('id', '=', variantId).forUpdate().executeTakeFirst()
        if (!variant) throw new CatalogError(404, 'SKU_NOT_FOUND', 'The SKU does not belong to this product')
        if (variant.revision !== body.expectedSkuRevision) {
          throw new CatalogError(409, 'SKU_REVISION_CONFLICT', 'The SKU changed; reload its pricing and retry')
        }
        if (variant.retired_at !== null) {
          throw new CatalogError(409, 'SKU_PERMANENTLY_RETIRED', 'A permanently retired SKU cannot be repriced for sale')
        }

        const salePrice = Object.hasOwn(body, 'salePrice')
          ? normalizeSalePrice(body.salePrice!)
          : parseUnitAmount(variant.sale_price).toFixed(2)
        const compareAtPrice = Object.hasOwn(body, 'compareAtPrice')
          ? normalizeOptionalPrice(body.compareAtPrice!, 'compare')
          : variant.compare_at_price === null ? null : parseUnitAmount(variant.compare_at_price).toFixed(2)
        const costPrice = Object.hasOwn(body, 'costPrice')
          ? normalizeOptionalPrice(body.costPrice!, 'cost')
          : variant.cost_price === null ? null : parseUnitAmount(variant.cost_price).toFixed(5)

        if (compareAtPrice !== null && !parseUnitAmount(compareAtPrice).greaterThan(parseUnitAmount(salePrice))) {
          throw new CatalogError(400, 'INVALID_COMPARE_AT_PRICE', 'Compare-at price must be greater than the sale price')
        }

        await trx.updateTable('product_variants').set({
          sale_price: salePrice,
          compare_at_price: compareAtPrice,
          cost_price: costPrice,
        }).where('product_id', '=', productId).where('id', '=', variantId).execute()

        const updated = await selectPriceRow(trx, productId, variantId)
        if (!updated) throw new Error('Updated SKU pricing could not be read inside its transaction')
        return toPriceContract(updated)
      })
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })
}
