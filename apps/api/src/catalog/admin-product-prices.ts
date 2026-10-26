import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely } from 'kysely'
import {
  AdminProductCostPreviewSchema,
  AdminProductCostPreviewRequestSchema,
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
  AdminProductCostPreview,
  AdminProductCostPreviewRequest,
  AdminProductVariantPrices,
  AdminProductVariantPricesBatchResult,
  AdminProductVariantPricesPage,
  AdminProductVariantPricesQuery,
  UpdateAdminProductVariantPricesBatchBody,
  UpdateAdminProductVariantPricesBody,
} from '@aikayun/contracts'
import { calculateSuggestedSalePriceDetailed, calculateUnitProfitMetrics, parseUnitAmount } from '@aikayun/money'
import { createHash } from 'node:crypto'
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
  product_status: string
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
  enabled: boolean
}

async function selectPriceRow(db: Kysely<Database>, productId: string, skuId: string): Promise<PriceRow | undefined> {
  return db.selectFrom('product_variants as variant')
    .innerJoin('products as product', 'product.id', 'variant.product_id')
    .select([
      'product.id as product_id', 'product.revision as product_revision', 'product.status as product_status',
      'variant.id as sku_id', 'variant.sku_code', 'variant.revision as sku_revision',
      'variant.sale_price', 'variant.compare_at_price', 'variant.cost_price',
      'variant.retired_at', 'variant.updated_at', 'variant.enabled',
      'variant.pricing_mode', 'variant.pricing_fixed_profit', 'variant.pricing_markup_rate',
      'variant.pricing_rule_revision', 'variant.pricing_rule_status',
    ])
    .where('variant.product_id', '=', productId)
    .where('variant.id', '=', skuId)
    .executeTakeFirst()
}

function fixedCost(value: string | null): string | null {
  return value === null ? null : parseUnitAmount(value).toFixed(5)
}

function costPreviewDigest(row: PriceRow, newCostPrice: string | null): string {
  const snapshot = {
    version: 'manual-cost-preview-v1',
    productId: row.product_id,
    productRevision: row.product_revision,
    productStatus: row.product_status,
    skuId: row.sku_id,
    skuRevision: row.sku_revision,
    salePrice: parseUnitAmount(row.sale_price).toFixed(2),
    compareAtPrice: row.compare_at_price === null ? null : parseUnitAmount(row.compare_at_price).toFixed(2),
    currentCostPrice: fixedCost(row.cost_price),
    newCostPrice,
    pricingMode: row.pricing_mode,
    pricingFixedProfit: fixedCost(row.pricing_fixed_profit),
    pricingMarkupRate: row.pricing_markup_rate === null ? null : parseUnitAmount(row.pricing_markup_rate).toFixed(4),
    pricingRuleRevision: row.pricing_rule_revision,
    pricingRuleStatus: row.pricing_rule_status,
    enabled: row.enabled,
    retiredAt: row.retired_at?.toISOString() ?? null,
  }
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

function buildCostPreview(row: PriceRow, newCostPrice: string | null): AdminProductCostPreview['items'][number] {
  const risks: Array<AdminProductCostPreview['items'][number]['risks'][number]> = []
  if (row.cost_price === null) risks.push('COST_MISSING')
  if (row.pricing_mode === 'manual') risks.push('MANUAL_MODE')
  if (newCostPrice === null) risks.push('COST_MISSING')
  else if (parseUnitAmount(newCostPrice).isZero()) risks.push('ZERO_COST')
  if (row.retired_at !== null) risks.push('SKU_RETIRED')
  if (!row.enabled) risks.push('SKU_DISABLED')

  const salePrice = parseUnitAmount(row.sale_price).toFixed(2)
  let currentGrossProfit: string | null = null
  let currentGrossMarginRate: string | null = null
  if (row.cost_price !== null) {
    try {
      const metrics = calculateUnitProfitMetrics(salePrice, fixedCost(row.cost_price)!)
      currentGrossProfit = metrics.grossProfit
      currentGrossMarginRate = metrics.grossMarginRate
      if (parseUnitAmount(metrics.grossProfit).isNegative()) risks.push('NEGATIVE_PROFIT')
    } catch { risks.push('INVALID_PRECISION') }
  }

  let afterCostGrossProfit: string | null = null
  let afterCostGrossMarginRate: string | null = null
  if (newCostPrice !== null) {
    try {
      const metrics = calculateUnitProfitMetrics(salePrice, newCostPrice)
      afterCostGrossProfit = metrics.grossProfit
      afterCostGrossMarginRate = metrics.grossMarginRate
      if (parseUnitAmount(metrics.grossProfit).isNegative()) risks.push('NEGATIVE_PROFIT')
      if (parseUnitAmount(salePrice).isZero()) risks.push('FREE_PRICE')
    } catch { risks.push('INVALID_PRECISION') }
  }

  let suggestedSalePrice: string | null = null
  let suggestedGrossProfit: string | null = null
  let suggestedGrossMarginRate: string | null = null
  let salePriceDelta: string | null = null
  if (row.pricing_mode !== 'manual' && newCostPrice !== null) {
    try {
      const rule = row.pricing_mode === 'fixed_profit'
        ? { mode: 'fixed_profit' as const, fixedProfit: fixedCost(row.pricing_fixed_profit)! }
        : { mode: 'percentage_markup' as const, markupRate: parseUnitAmount(row.pricing_markup_rate!).toFixed(4) }
      const calculated = calculateSuggestedSalePriceDetailed(newCostPrice, rule)
      suggestedSalePrice = calculated.salePrice
      if (calculated.roundedToCents) risks.push('ROUNDING_TO_CENT')
      if (suggestedSalePrice === '0.00') {
        risks.push('FREE_PRICE')
        if (newCostPrice !== '0.00000' || (row.pricing_mode === 'fixed_profit' && fixedCost(row.pricing_fixed_profit) !== '0.00000')) {
          risks.push('ROUNDING_TO_ZERO')
        }
      }
      const metrics = calculateUnitProfitMetrics(suggestedSalePrice, newCostPrice)
      suggestedGrossProfit = metrics.grossProfit
      suggestedGrossMarginRate = metrics.grossMarginRate
      if (parseUnitAmount(metrics.grossProfit).isNegative()) risks.push('NEGATIVE_PROFIT')
      salePriceDelta = parseUnitAmount(suggestedSalePrice).minus(parseUnitAmount(salePrice)).toFixed(2)
      if (row.compare_at_price !== null
        && !parseUnitAmount(row.compare_at_price).greaterThan(parseUnitAmount(suggestedSalePrice))) {
        risks.push('COMPARE_AT_PRICE_CONFLICT')
      }
    } catch (error) { risks.push(error instanceof RangeError ? 'PRICE_OVERFLOW' : 'INVALID_PRECISION') }
  }

  const oldCost = fixedCost(row.cost_price)
  const costDelta = oldCost === null || newCostPrice === null
    ? null : parseUnitAmount(newCostPrice).minus(parseUnitAmount(oldCost)).toFixed(5)
  return {
    skuId: row.sku_id, skuCode: row.sku_code, skuRevision: row.sku_revision,
    ruleRevision: row.pricing_rule_revision, inputDigest: costPreviewDigest(row, newCostPrice),
    mode: row.pricing_mode, ruleStatus: row.pricing_rule_status,
    fixedProfit: row.pricing_fixed_profit === null ? null : fixedCost(row.pricing_fixed_profit),
    markupRate: row.pricing_markup_rate === null ? null : parseUnitAmount(row.pricing_markup_rate).toFixed(4),
    currentCostPrice: oldCost, newCostPrice, costDelta, salePrice,
    compareAtPrice: row.compare_at_price === null ? null : parseUnitAmount(row.compare_at_price).toFixed(2),
    currentGrossProfit, currentGrossMarginRate,
    afterCostGrossProfit, afterCostGrossMarginRate,
    suggestedSalePrice, suggestedGrossProfit, suggestedGrossMarginRate, salePriceDelta,
    risks: [...new Set(risks)], canConfirm: row.product_status !== 'archived' && row.retired_at === null,
  }
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

  app.post('/api/v1/admin/products/:id/cost-preview', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'],
      summary: 'Preview manual CNY cost changes and their pricing-rule impact without writing prices',
      params: ProductIdParamsSchema,
      body: AdminProductCostPreviewRequestSchema,
      response: { 200: ApiSuccessSchemaOf(AdminProductCostPreviewSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const body = request.body as AdminProductCostPreviewRequest
    const ids = body.updates.map(item => item.skuId.toLowerCase())
    if (new Set(ids).size !== ids.length) {
      return reply.code(400).send({ error: { code: 'DUPLICATE_SKU_PRICE_UPDATE', message: '成本预览中不能重复包含同一个 SKU。' }, meta: { requestId: request.id } })
    }
    try {
      const result = await db.transaction().setIsolationLevel('repeatable read').execute(async trx => {
        const product = await trx.selectFrom('products').select(['id', 'revision', 'status'])
          .where('id', '=', productId).executeTakeFirst()
        if (!product) throw new CatalogError(404, 'PRODUCT_NOT_FOUND', 'The product does not exist')
        if (product.revision !== body.expectedRevision) {
          throw new CatalogError(409, 'PRODUCT_REVISION_CONFLICT', '商品已变化，请重新载入后预览成本。')
        }
        const rows = await Promise.all(body.updates.map(item => selectPriceRow(trx, productId, item.skuId.toLowerCase())))
        if (rows.some(row => !row)) throw new CatalogError(404, 'SKU_NOT_FOUND', '部分 SKU 不属于此商品。')
        const byId = new Map(rows.map(row => [row!.sku_id, row!]))
        const items = body.updates.map(input => {
          const row = byId.get(input.skuId.toLowerCase())!
          if (row.sku_revision !== input.expectedSkuRevision) {
            throw new CatalogError(409, 'SKU_REVISION_CONFLICT', `SKU ${row.sku_code} 已变化，请重新载入后预览成本。`)
          }
          const costPrice = normalizeOptionalPrice(input.costPrice, 'cost')
          return buildCostPreview(row, costPrice)
        })
        return { productId, productRevision: product.revision, items } satisfies AdminProductCostPreview
      })
      return reply.send(success(result, request.id))
    } catch (error) { return fail(reply, error, request.id) }
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
          const currentSalePrice = parseUnitAmount(variant.sale_price).toFixed(2)
          const currentCompareAtPrice = variant.compare_at_price === null ? null : parseUnitAmount(variant.compare_at_price).toFixed(2)
          const currentCostPrice = variant.cost_price === null ? null : parseUnitAmount(variant.cost_price).toFixed(5)
          if (costPrice !== currentCostPrice) {
            if (salePrice !== currentSalePrice || compareAtPrice !== currentCompareAtPrice) {
              throw new CatalogError(400, 'COST_CHANGE_MUST_BE_SEPARATE', '请先单独保存售价或划线价，再预览并确认成本修改。')
            }
            const priceRow: PriceRow = {
              product_id: productId, product_revision: product.revision, product_status: product.status,
              sku_id: variant.id, sku_code: variant.sku_code, sku_revision: variant.revision,
              sale_price: variant.sale_price, compare_at_price: variant.compare_at_price,
              cost_price: variant.cost_price, retired_at: variant.retired_at, updated_at: variant.updated_at,
              pricing_mode: variant.pricing_mode, pricing_fixed_profit: variant.pricing_fixed_profit,
              pricing_markup_rate: variant.pricing_markup_rate, pricing_rule_revision: variant.pricing_rule_revision,
              pricing_rule_status: variant.pricing_rule_status, enabled: variant.enabled,
            }
            if (!update.costPreviewDigest || update.costPreviewDigest !== costPreviewDigest(priceRow, costPrice)) {
              throw new CatalogError(409, 'COST_PREVIEW_STALE', `SKU ${variant.sku_code} 的成本预览已过期，请重新预览后确认。`)
            }
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

        const currentSalePrice = parseUnitAmount(variant.sale_price).toFixed(2)
        const currentCompareAtPrice = variant.compare_at_price === null ? null : parseUnitAmount(variant.compare_at_price).toFixed(2)
        const currentCostPrice = variant.cost_price === null ? null : parseUnitAmount(variant.cost_price).toFixed(5)
        if (costPrice !== currentCostPrice) {
          if (salePrice !== currentSalePrice || compareAtPrice !== currentCompareAtPrice) {
            throw new CatalogError(400, 'COST_CHANGE_MUST_BE_SEPARATE', '请先单独保存售价或划线价，再预览并确认成本修改。')
          }
          const priceRow: PriceRow = {
            product_id: productId, product_revision: product.revision, product_status: product.status,
            sku_id: variant.id, sku_code: variant.sku_code, sku_revision: variant.revision,
            sale_price: variant.sale_price, compare_at_price: variant.compare_at_price,
            cost_price: variant.cost_price, retired_at: variant.retired_at, updated_at: variant.updated_at,
            pricing_mode: variant.pricing_mode, pricing_fixed_profit: variant.pricing_fixed_profit,
            pricing_markup_rate: variant.pricing_markup_rate, pricing_rule_revision: variant.pricing_rule_revision,
            pricing_rule_status: variant.pricing_rule_status, enabled: variant.enabled,
          }
          if (!body.costPreviewDigest || body.costPreviewDigest !== costPreviewDigest(priceRow, costPrice)) {
            throw new CatalogError(409, 'COST_PREVIEW_STALE', '成本预览已过期，请重新预览后确认。')
          }
        }

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
