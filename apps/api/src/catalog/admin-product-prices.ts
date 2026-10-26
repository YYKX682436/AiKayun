import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely } from 'kysely'
import {
  AdminProductVariantPricesSchema,
  AdminProductVariantPricesBatchResultSchema,
  AdminProductVariantPricesPageSchema,
  AdminProductVariantPricesQuerySchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  ProductIdParamsSchema,
  ProductVariantIdParamsSchema,
  UpdateAdminProductVariantPricesBatchBodySchema,
  UpdateAdminProductVariantPricesBodySchema,
  success,
} from '@aikayun/contracts'
import type {
  AdminProductVariantPrices,
  AdminProductVariantPricesBatchResult,
  AdminProductVariantPricesPage,
  AdminProductVariantPricesQuery,
  UpdateAdminProductVariantPricesBatchBody,
  UpdateAdminProductVariantPricesBody,
} from '@aikayun/contracts'
import { parseUnitAmount } from '@aikayun/money'
import type { AppConfig } from '../config.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { Database } from '../db/types.js'
import { CatalogError, sendCatalogError } from './errors.js'
import { assertProductNotArchived, lockProductAtRevision } from './admin-product-guards.js'
import { appendProductAudit } from './product-audit.js'

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
  pricing_mode: 'manual' | 'fixed_profit' | 'percentage_markup'
  pricing_fixed_profit: string | null
  pricing_markup_rate: string | null
  pricing_rule_revision: number
  pricing_rule_status: 'manual' | 'pending' | 'applied' | 'stale'
}

async function selectPriceRow(db: Kysely<Database>, productId: string, skuId: string): Promise<PriceRow | undefined> {
  return db.selectFrom('product_variants as variant')
    .innerJoin('products as product', 'product.id', 'variant.product_id')
    .select([
      'product.id as product_id', 'product.revision as product_revision',
      'variant.id as sku_id', 'variant.sku_code', 'variant.revision as sku_revision',
      'variant.sale_price', 'variant.compare_at_price', 'variant.cost_price',
      'variant.retired_at', 'variant.updated_at',
      'variant.pricing_mode', 'variant.pricing_fixed_profit', 'variant.pricing_markup_rate',
      'variant.pricing_rule_revision', 'variant.pricing_rule_status',
    ])
    .where('variant.product_id', '=', productId)
    .where('variant.id', '=', skuId)
    .executeTakeFirst()
}

function priceAuditState(row: Pick<PriceRow, 'sku_id' | 'sku_code' | 'sku_revision' | 'sale_price' | 'compare_at_price' | 'cost_price' | 'pricing_mode' | 'pricing_fixed_profit' | 'pricing_markup_rate' | 'pricing_rule_revision' | 'pricing_rule_status'>) {
  return {
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuRevision: row.sku_revision,
    salePrice: parseUnitAmount(row.sale_price).toFixed(2),
    compareAtPrice: row.compare_at_price === null ? null : parseUnitAmount(row.compare_at_price).toFixed(2),
    costPrice: row.cost_price === null ? null : parseUnitAmount(row.cost_price).toFixed(5),
    pricingMode: row.pricing_mode,
    pricingRuleRevision: row.pricing_rule_revision,
    pricingRuleStatus: row.pricing_rule_status,
    fixedProfit: row.pricing_fixed_profit === null ? null : parseUnitAmount(row.pricing_fixed_profit).toFixed(5),
    markupRate: row.pricing_markup_rate === null ? null : parseUnitAmount(row.pricing_markup_rate).toFixed(4),
  }
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

  app.get('/api/v1/admin/products/:id/prices', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Read a paginated page of SKU prices for a product',
      params: ProductIdParamsSchema,
      querystring: AdminProductVariantPricesQuerySchema,
      response: { 200: ApiSuccessSchemaOf(AdminProductVariantPricesPageSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const query = request.query as AdminProductVariantPricesQuery
    try {
      const page = query.page ?? 1
      const pageSize = query.pageSize ?? 50
      const offset = (page - 1) * pageSize
      const search = query.search?.trim()
      if (query.search !== undefined && !search) {
        throw new CatalogError(400, 'INVALID_SKU_SEARCH', 'SKU search must not be empty')
      }
      const filter = search
        ? sql`AND (variant.sku_code ILIKE ${`%${search}%`} OR variant.id::text ILIKE ${`%${search}%`})`
        : sql``
      const count = await sql<{ total: number }>`
        SELECT count(*)::integer AS total
        FROM product_variants AS variant
        WHERE variant.product_id = ${productId}::uuid ${filter}
      `.execute(db)
      const total = count.rows[0]?.total ?? 0
      if (total === 0) {
        const exists = await db.selectFrom('products').select('id').where('id', '=', productId).executeTakeFirst()
        if (!exists) throw new CatalogError(404, 'PRODUCT_NOT_FOUND', 'The product does not exist')
      }
      const rows = await sql<PriceRow>`
        SELECT product.id AS product_id, product.revision AS product_revision,
          variant.id AS sku_id, variant.sku_code, variant.revision AS sku_revision,
          variant.sale_price::text AS sale_price, variant.compare_at_price::text AS compare_at_price,
          variant.cost_price::text AS cost_price, variant.retired_at, variant.updated_at
          , variant.pricing_mode, variant.pricing_fixed_profit::text AS pricing_fixed_profit,
          variant.pricing_markup_rate::text AS pricing_markup_rate,
          variant.pricing_rule_revision, variant.pricing_rule_status
        FROM product_variants AS variant
        INNER JOIN products AS product ON product.id = variant.product_id
        WHERE variant.product_id = ${productId}::uuid ${filter}
        ORDER BY variant.created_at, variant.id
        LIMIT ${pageSize} OFFSET ${offset}
      `.execute(db)
      const result: AdminProductVariantPricesPage = {
        productId,
        productRevision: rows.rows[0]?.product_revision
          ?? (await db.selectFrom('products').select('revision').where('id', '=', productId).executeTakeFirstOrThrow()).revision,
        items: rows.rows.map(toPriceContract),
        page,
        pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      }
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })

  app.patch('/api/v1/admin/products/:id/prices/batch', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Atomically update prices for up to 50 product SKUs',
      params: ProductIdParamsSchema,
      body: UpdateAdminProductVariantPricesBatchBodySchema,
      response: {
        200: ApiSuccessSchemaOf(AdminProductVariantPricesBatchResultSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const body = request.body as UpdateAdminProductVariantPricesBatchBody
    try {
      const result: AdminProductVariantPricesBatchResult = await db.transaction().execute(async (trx) => {
        const product = await lockProductAtRevision(trx, productId, body.expectedRevision)
        assertProductNotArchived(product)
        const ids = body.updates.map((update) => update.skuId.toLowerCase())
        if (new Set(ids).size !== ids.length) {
          throw new CatalogError(400, 'DUPLICATE_SKU_PRICE_UPDATE', 'A SKU can appear only once in a batch price update')
        }
        const variants = await trx.selectFrom('product_variants').selectAll()
          .where('product_id', '=', productId).where('id', 'in', ids).orderBy('id').forUpdate().execute()
        if (variants.length !== ids.length) throw new CatalogError(404, 'SKU_NOT_FOUND', 'One or more SKUs do not belong to this product')
        const variantById = new Map(variants.map((variant) => [variant.id, variant]))
        const normalized = body.updates.map((update) => {
          const variant = variantById.get(update.skuId.toLowerCase())
          if (!variant) throw new CatalogError(404, 'SKU_NOT_FOUND', 'The SKU does not belong to this product')
          if (variant.revision !== update.expectedSkuRevision) {
            throw new CatalogError(409, 'SKU_REVISION_CONFLICT', `SKU ${variant.sku_code} changed; reload prices before saving`)
          }
          if (variant.retired_at !== null) {
            throw new CatalogError(409, 'SKU_PERMANENTLY_RETIRED', `SKU ${variant.sku_code} is permanently retired and cannot be repriced`)
          }
          const salePrice = Object.hasOwn(update, 'salePrice')
            ? normalizeSalePrice(update.salePrice!)
            : parseUnitAmount(variant.sale_price).toFixed(2)
          const compareAtPrice = Object.hasOwn(update, 'compareAtPrice')
            ? normalizeOptionalPrice(update.compareAtPrice!, 'compare')
            : variant.compare_at_price === null ? null : parseUnitAmount(variant.compare_at_price).toFixed(2)
          const costPrice = Object.hasOwn(update, 'costPrice')
            ? normalizeOptionalPrice(update.costPrice!, 'cost')
            : variant.cost_price === null ? null : parseUnitAmount(variant.cost_price).toFixed(5)
          if (compareAtPrice !== null && !parseUnitAmount(compareAtPrice).greaterThan(parseUnitAmount(salePrice))) {
            throw new CatalogError(400, 'INVALID_COMPARE_AT_PRICE', `Compare-at price for SKU ${variant.sku_code} must be greater than its sale price`)
          }
          return {
            variantId: variant.id, salePrice, compareAtPrice, costPrice,
            before: priceAuditState({
              sku_id: variant.id, sku_code: variant.sku_code, sku_revision: variant.revision,
              sale_price: variant.sale_price, compare_at_price: variant.compare_at_price,
              cost_price: variant.cost_price, pricing_mode: variant.pricing_mode,
              pricing_fixed_profit: variant.pricing_fixed_profit, pricing_markup_rate: variant.pricing_markup_rate,
              pricing_rule_revision: variant.pricing_rule_revision, pricing_rule_status: variant.pricing_rule_status,
            }),
            changed: salePrice !== parseUnitAmount(variant.sale_price).toFixed(2)
              || compareAtPrice !== (variant.compare_at_price === null ? null : parseUnitAmount(variant.compare_at_price).toFixed(2))
              || costPrice !== (variant.cost_price === null ? null : parseUnitAmount(variant.cost_price).toFixed(5)),
          }
        })

        for (const update of normalized) {
          await trx.updateTable('product_variants').set({
            sale_price: update.salePrice,
            compare_at_price: update.compareAtPrice,
            cost_price: update.costPrice,
          }).where('product_id', '=', productId).where('id', '=', update.variantId).execute()
        }
        const updatedRows = await Promise.all(normalized.map((update) => selectPriceRow(trx, productId, update.variantId)))
        if (updatedRows.some((row) => !row)) throw new Error('Batch price updates could not be read inside the transaction')
        const items = updatedRows.map((row) => toPriceContract(row!))
        for (const update of normalized) {
          if (!update.changed) continue
          const updated = updatedRows.find((row) => row?.sku_id === update.variantId)
          if (!updated) throw new Error('Updated SKU price audit row is missing')
          await appendProductAudit(trx, {
            productId, administratorId: request.admin!.id, operation: 'price_updated',
            before: update.before, after: priceAuditState(updated),
          })
        }
        return {
          productId,
          productRevision: items[0]!.productRevision,
          items,
        }
      })
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })

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

        const before = priceAuditState({
          sku_id: variant.id, sku_code: variant.sku_code, sku_revision: variant.revision,
          sale_price: variant.sale_price, compare_at_price: variant.compare_at_price,
          cost_price: variant.cost_price, pricing_mode: variant.pricing_mode,
          pricing_fixed_profit: variant.pricing_fixed_profit, pricing_markup_rate: variant.pricing_markup_rate,
          pricing_rule_revision: variant.pricing_rule_revision, pricing_rule_status: variant.pricing_rule_status,
        })
        const changed = salePrice !== parseUnitAmount(variant.sale_price).toFixed(2)
          || compareAtPrice !== (variant.compare_at_price === null ? null : parseUnitAmount(variant.compare_at_price).toFixed(2))
          || costPrice !== (variant.cost_price === null ? null : parseUnitAmount(variant.cost_price).toFixed(5))

        await trx.updateTable('product_variants').set({
          sale_price: salePrice,
          compare_at_price: compareAtPrice,
          cost_price: costPrice,
        }).where('product_id', '=', productId).where('id', '=', variantId).execute()

        const updated = await selectPriceRow(trx, productId, variantId)
        if (!updated) throw new Error('Updated SKU pricing could not be read inside its transaction')
        if (changed) {
          await appendProductAudit(trx, {
            productId, administratorId: request.admin!.id, operation: 'price_updated',
            before, after: priceAuditState(updated),
          })
        }
        return toPriceContract(updated)
      })
      return reply.send(success(result, request.id))
    } catch (error) {
      return fail(reply, error, request.id)
    }
  })
}
