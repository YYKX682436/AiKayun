import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { type Kysely, type Transaction } from 'kysely'
import {
  AdminProductPricingPreviewSchema,
  AdminProductPricingRuleHistorySchema,
  AdminProductPricingRulesBatchResultSchema,
  AdminProductPricingRulesPageSchema,
  AdminProductVariantPricesQuerySchema,
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  ApplyAdminProductPricingRulesBodySchema,
  PreviewAdminProductPricingRulesBodySchema,
  ProductIdParamsSchema,
  ProductVariantIdParamsSchema,
  RestoreAdminProductPricingRuleBodySchema,
  RestoreAdminProductPricingRuleResultSchema,
  UpdateAdminProductPricingRulesBatchBodySchema,
  success,
} from '@aikayun/contracts'
import type {
  AdminProductPricingPreviewItem,
  AdminProductPricingRuleHistory,
  AdminProductPricingRuleHistoryItem,
  AdminProductPricingRuleItem,
  AdminProductPricingRulesBatchResult,
  AdminProductPricingRulesPage,
  ApplyAdminProductPricingRulesBody,
  PreviewAdminProductPricingRulesBody,
  PricingPreviewRisk,
  ProductPricingMode,
  RestoreAdminProductPricingRuleBody,
  UpdateAdminProductPricingRulesBatchBody,
} from '@aikayun/contracts'
import {
  calculateSuggestedSalePriceDetailed,
  calculateUnitProfitMetrics,
  parseUnitAmount,
} from '@aikayun/money'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import type { AppConfig } from '../config.js'
import type { Database, ProductPricingMode as DbPricingMode, ProductPricingRuleStatus as DbPricingStatus } from '../db/types.js'
import { CatalogError, sendCatalogError } from './errors.js'
import { assertProductNotArchived, lockProductAtRevision } from './admin-product-guards.js'
import { appendProductAudit } from './product-audit.js'

const pricingRatePattern = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/u
const digestVersion = 'pricing-rule-input-v1'
type Db = Kysely<Database> | Transaction<Database>

type PricingRuleRow = {
  product_id: string
  product_revision: number
  product_status: string
  sku_id: string
  sku_code: string
  sku_revision: number
  rule_revision: number
  mode: DbPricingMode
  fixed_profit: string | null
  markup_rate: string | null
  rule_status: DbPricingStatus
  sale_price: string
  compare_at_price: string | null
  cost_price: string | null
  enabled: boolean
  retired_at: Date | null
}

type RuleHistoryDbRow = {
  id: string
  product_variant_id: string
  revision: number
  mode: DbPricingMode
  fixed_profit: string | null
  markup_rate: string | null
  change_type: 'configured' | 'restored'
  restored_from_revision: number | null
  administrator_id: string
  created_at: Date
}

function normalizeFixedProfit(value: string | null | undefined): string {
  if (value === undefined || value === null) throw new CatalogError(400, 'INVALID_PRICING_RULE', '固定利润模式需要填写每件固定利润。')
  let amount: ReturnType<typeof parseUnitAmount>
  try { amount = parseUnitAmount(value) } catch {
    throw new CatalogError(400, 'INVALID_PRICING_RULE', '固定利润须为最多 13 位整数和 5 位小数的非负金额。')
  }
  if (amount.isNegative()) throw new CatalogError(400, 'INVALID_PRICING_RULE', '固定利润不能为负数。')
  return amount.toFixed(5)
}

function normalizeMarkupRate(value: string | null | undefined): string {
  if (value === undefined || value === null || !pricingRatePattern.test(value)) {
    throw new CatalogError(400, 'INVALID_PRICING_RULE', '成本加价率须为 0 至 999999.9999 之间、最多 4 位小数的百分比。')
  }
  return parseUnitAmount(value).toFixed(4)
}

function normalizedRule(input: { mode: ProductPricingMode; fixedProfit?: string | null; markupRate?: string | null }) {
  if (input.mode === 'manual') return { mode: input.mode, fixedProfit: null, markupRate: null }
  if (input.mode === 'fixed_profit') return {
    mode: input.mode,
    fixedProfit: normalizeFixedProfit(input.fixedProfit),
    markupRate: null,
  }
  return { mode: input.mode, fixedProfit: null, markupRate: normalizeMarkupRate(input.markupRate) }
}

async function readRuleRows(
  db: Db,
  productId: string,
  skuIds?: string[],
  pagination?: { limit: number; offset: number },
): Promise<PricingRuleRow[]> {
  let query = db.selectFrom('product_variants as variant')
    .innerJoin('products as product', 'product.id', 'variant.product_id')
    .select([
      'product.id as product_id', 'product.revision as product_revision', 'product.status as product_status',
      'variant.id as sku_id', 'variant.sku_code', 'variant.revision as sku_revision',
      'variant.pricing_rule_revision as rule_revision', 'variant.pricing_mode as mode',
      'variant.pricing_fixed_profit as fixed_profit', 'variant.pricing_markup_rate as markup_rate',
      'variant.pricing_rule_status as rule_status', 'variant.sale_price', 'variant.compare_at_price',
      'variant.cost_price', 'variant.enabled', 'variant.retired_at',
    ]).where('variant.product_id', '=', productId)
  if (skuIds) query = query.where('variant.id', 'in', skuIds)
  query = query.orderBy('variant.id')
  if (pagination) query = query.limit(pagination.limit).offset(pagination.offset)
  return query.execute() as Promise<PricingRuleRow[]>
}

function formatFixed(value: string | null): string | null {
  return value === null ? null : parseUnitAmount(value).toFixed(5)
}

function formatRate(value: string | null): string | null {
  return value === null ? null : parseUnitAmount(value).toFixed(4)
}

function toRuleItem(row: PricingRuleRow): AdminProductPricingRuleItem {
  return {
    productId: row.product_id,
    productRevision: row.product_revision,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuRevision: row.sku_revision,
    ruleRevision: row.rule_revision,
    mode: row.mode,
    fixedProfit: formatFixed(row.fixed_profit),
    markupRate: formatRate(row.markup_rate),
    ruleStatus: row.rule_status,
    salePrice: parseUnitAmount(row.sale_price).toFixed(2),
    compareAtPrice: row.compare_at_price === null ? null : parseUnitAmount(row.compare_at_price).toFixed(2),
    costPrice: formatFixed(row.cost_price),
    enabled: row.enabled,
    retiredAt: row.retired_at?.toISOString() ?? null,
    currency: 'CNY',
  }
}

function digestFor(row: PricingRuleRow): string {
  const snapshot = {
    version: digestVersion,
    productId: row.product_id,
    productRevision: row.product_revision,
    productStatus: row.product_status,
    skuId: row.sku_id,
    skuRevision: row.sku_revision,
    ruleRevision: row.rule_revision,
    mode: row.mode,
    fixedProfit: formatFixed(row.fixed_profit),
    markupRate: formatRate(row.markup_rate),
    ruleStatus: row.rule_status,
    salePrice: parseUnitAmount(row.sale_price).toFixed(2),
    costPrice: formatFixed(row.cost_price),
    enabled: row.enabled,
    retiredAt: row.retired_at?.toISOString() ?? null,
  }
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

function safeCurrentMetrics(row: PricingRuleRow, risks: PricingPreviewRisk[]) {
  if (row.cost_price === null) return { grossProfit: null, grossMarginRate: null }
  try {
    const metrics = calculateUnitProfitMetrics(row.sale_price, row.cost_price)
    return { grossProfit: metrics.grossProfit, grossMarginRate: metrics.grossMarginRate }
  } catch {
    risks.push('INVALID_PRECISION')
    return { grossProfit: null, grossMarginRate: null }
  }
}

function makePreview(row: PricingRuleRow): AdminProductPricingPreviewItem {
  const risks: PricingPreviewRisk[] = []
  if (row.mode === 'manual') risks.push('MANUAL_MODE')
  if (row.cost_price === null && row.mode !== 'manual') risks.push('COST_MISSING')
  if (row.retired_at !== null) risks.push('SKU_RETIRED')
  if (!row.enabled) risks.push('SKU_DISABLED')

  const currentSalePrice = parseUnitAmount(row.sale_price).toFixed(2)
  const currentMetrics = safeCurrentMetrics(row, risks)
  let suggestedSalePrice: string | null = null
  let suggestedGrossProfit: string | null = null
  let suggestedGrossMarginRate: string | null = null
  let salePriceDelta: string | null = null
  if (row.mode !== 'manual' && row.cost_price !== null) {
    try {
      const rule = row.mode === 'fixed_profit'
        ? { mode: 'fixed_profit' as const, fixedProfit: formatFixed(row.fixed_profit)! }
        : { mode: 'percentage_markup' as const, markupRate: formatRate(row.markup_rate)! }
      const result = calculateSuggestedSalePriceDetailed(row.cost_price, rule)
      suggestedSalePrice = result.salePrice
      if (result.roundedToCents) risks.push('ROUNDING_TO_CENT')
      if (suggestedSalePrice === '0.00') {
        risks.push('FREE_PRICE')
        if (row.cost_price !== '0' && row.cost_price !== '0.00000'
          || (row.mode === 'fixed_profit' && row.fixed_profit !== '0' && row.fixed_profit !== '0.00000')) {
          risks.push('ROUNDING_TO_ZERO')
        }
      }
      const metrics = calculateUnitProfitMetrics(suggestedSalePrice, row.cost_price)
      suggestedGrossProfit = metrics.grossProfit
      suggestedGrossMarginRate = metrics.grossMarginRate
      if (parseUnitAmount(metrics.grossProfit).isNegative()) risks.push('NEGATIVE_PROFIT')
      salePriceDelta = parseUnitAmount(suggestedSalePrice).minus(parseUnitAmount(currentSalePrice)).toFixed(2)
      if (row.compare_at_price !== null
        && !parseUnitAmount(row.compare_at_price).greaterThan(parseUnitAmount(suggestedSalePrice))) {
        risks.push('COMPARE_AT_PRICE_CONFLICT')
      }
    } catch (error) {
      risks.push(error instanceof RangeError ? 'PRICE_OVERFLOW' : 'INVALID_PRECISION')
    }
  }

  const canApply = row.mode !== 'manual' && row.cost_price !== null && suggestedSalePrice !== null
    && row.retired_at === null && row.product_status !== 'archived'
    && !risks.includes('COMPARE_AT_PRICE_CONFLICT')
  return {
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuRevision: row.sku_revision,
    ruleRevision: row.rule_revision,
    inputDigest: digestFor(row),
    mode: row.mode,
    ruleStatus: row.rule_status,
    currentSalePrice,
    compareAtPrice: row.compare_at_price === null ? null : parseUnitAmount(row.compare_at_price).toFixed(2),
    costPrice: formatFixed(row.cost_price),
    fixedProfit: formatFixed(row.fixed_profit),
    markupRate: formatRate(row.markup_rate),
    suggestedSalePrice,
    currentGrossProfit: currentMetrics.grossProfit,
    currentGrossMarginRate: currentMetrics.grossMarginRate,
    suggestedGrossProfit,
    suggestedGrossMarginRate,
    salePriceDelta,
    risks: [...new Set(risks)],
    canApply,
  }
}

function auditState(row: PricingRuleRow) {
  return {
    skuId: row.sku_id,
    skuCode: row.sku_code,
    salePrice: parseUnitAmount(row.sale_price).toFixed(2),
    compareAtPrice: row.compare_at_price === null ? null : parseUnitAmount(row.compare_at_price).toFixed(2),
    costPrice: formatFixed(row.cost_price),
    pricingMode: row.mode,
    pricingRuleRevision: row.rule_revision,
    pricingRuleStatus: row.rule_status,
    fixedProfit: formatFixed(row.fixed_profit),
    markupRate: formatRate(row.markup_rate),
  }
}

function mapHistory(row: RuleHistoryDbRow): AdminProductPricingRuleHistoryItem {
  return {
    id: row.id,
    skuId: row.product_variant_id,
    revision: row.revision,
    mode: row.mode,
    fixedProfit: formatFixed(row.fixed_profit),
    markupRate: formatRate(row.markup_rate),
    changeType: row.change_type,
    restoredFromRevision: row.restored_from_revision,
    administratorId: row.administrator_id,
    createdAt: row.created_at.toISOString(),
  }
}

function fail(reply: FastifyReply, error: unknown, requestId: string) {
  return sendCatalogError(reply, error, requestId)
}

export function registerAdminProductPricingRuleRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  const authenticate = requireAdmin(db, config)
  const csrfCheck = verifyCsrf(config)

  app.get('/api/v1/admin/products/:id/pricing-rules', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Read SKU pricing rules and their current price inputs',
      params: ProductIdParamsSchema,
      querystring: AdminProductVariantPricesQuerySchema,
      response: { 200: ApiSuccessSchemaOf(AdminProductPricingRulesPageSchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const query = request.query as { page?: number; pageSize?: number }
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 50
    try {
      const count = await db.selectFrom('product_variants').select((eb) => eb.fn.countAll<number>().as('total'))
        .where('product_id', '=', productId).executeTakeFirstOrThrow()
      const total = Number(count.total)
      const product = await db.selectFrom('products').select(['id', 'revision'])
        .where('id', '=', productId).executeTakeFirst()
      if (!product) throw new CatalogError(404, 'PRODUCT_NOT_FOUND', '商品不存在。')
      const pageRows = await readRuleRows(db, productId, undefined, {
        limit: pageSize,
        offset: (page - 1) * pageSize,
      })
      const result: AdminProductPricingRulesPage = {
        productId,
        productRevision: pageRows[0]?.product_revision ?? product.revision,
        items: pageRows.map(toRuleItem),
        page,
        pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      }
      return reply.send(success(result, request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })

  app.put('/api/v1/admin/products/:id/pricing-rules/batch', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'], summary: 'Save immutable versioned pricing rules for up to 50 SKUs',
      params: ProductIdParamsSchema, body: UpdateAdminProductPricingRulesBatchBodySchema,
      response: { 200: ApiSuccessSchemaOf(AdminProductPricingRulesBatchResultSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const administratorId = request.admin?.id
    if (!administratorId) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: '需要管理员登录。' }, meta: { requestId: request.id } })
    const body = request.body as UpdateAdminProductPricingRulesBatchBody
    try {
      const result: AdminProductPricingRulesBatchResult = await db.transaction().execute(async (trx) => {
        const product = await lockProductAtRevision(trx, productId, body.expectedRevision)
        assertProductNotArchived(product)
        const ids = body.updates.map((item) => item.skuId.toLowerCase())
        if (new Set(ids).size !== ids.length) throw new CatalogError(400, 'DUPLICATE_SKU_PRICING_RULE', '批量规则中不能重复包含同一个 SKU。')
        const variants = await trx.selectFrom('product_variants').selectAll().where('product_id', '=', productId)
          .where('id', 'in', ids).orderBy('id').forUpdate().execute()
        if (variants.length !== ids.length) throw new CatalogError(404, 'SKU_NOT_FOUND', '部分 SKU 不属于此商品。')
        const byId = new Map(variants.map((row) => [row.id, row]))
        const rules = body.updates.map((input) => {
          const row = byId.get(input.skuId.toLowerCase())
          if (!row) throw new CatalogError(404, 'SKU_NOT_FOUND', 'SKU 不属于此商品。')
          if (row.revision !== input.expectedSkuRevision || row.pricing_rule_revision !== input.expectedRuleRevision) {
            throw new CatalogError(409, 'PRICING_RULE_REVISION_CONFLICT', `SKU ${row.sku_code} 或定价规则已变化，请刷新后重试。`)
          }
          if (row.retired_at !== null) throw new CatalogError(409, 'SKU_PERMANENTLY_RETIRED', `SKU ${row.sku_code} 已永久退役，不能修改定价规则。`)
          return { row, rule: normalizedRule(input) }
        })
        for (const { row, rule } of rules) {
          const unchanged = row.pricing_mode === rule.mode && row.pricing_fixed_profit === rule.fixedProfit
            && row.pricing_markup_rate === rule.markupRate
          if (unchanged) continue
          await trx.updateTable('product_variants').set({
            pricing_mode: rule.mode as DbPricingMode,
            pricing_fixed_profit: rule.fixedProfit,
            pricing_markup_rate: rule.markupRate,
          }).where('product_id', '=', productId).where('id', '=', row.id).execute()
          const updated = await trx.selectFrom('product_variants').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow()
          const after = await readRuleRows(trx, productId, [row.id])
          const afterRow = after[0]!
          await trx.insertInto('product_variant_pricing_rule_versions').values({
            id: randomUUID(), product_id: productId, product_variant_id: row.id,
            revision: updated.pricing_rule_revision, mode: rule.mode as DbPricingMode,
            fixed_profit: rule.fixedProfit, markup_rate: rule.markupRate,
            change_type: 'configured', restored_from_revision: null, administrator_id: administratorId,
          }).execute()
          await appendProductAudit(trx, {
            productId, administratorId, operation: 'rule_saved', before: auditState({ ...afterRow, ...{
              mode: row.pricing_mode, fixed_profit: row.pricing_fixed_profit, markup_rate: row.pricing_markup_rate,
              rule_revision: row.pricing_rule_revision, rule_status: row.pricing_rule_status,
              sku_revision: row.revision, sale_price: row.sale_price, compare_at_price: row.compare_at_price,
              cost_price: row.cost_price, product_id: row.product_id, product_revision: product.revision,
              product_status: product.status, sku_id: row.id, sku_code: row.sku_code, enabled: row.enabled, retired_at: row.retired_at,
            } }), after: auditState(afterRow),
          })
        }
        const current = await readRuleRows(trx, productId, ids)
        const currentProduct = await trx.selectFrom('products').select('revision').where('id', '=', productId).executeTakeFirstOrThrow()
        const result: AdminProductPricingRulesBatchResult = {
          productId, productRevision: currentProduct.revision,
          items: current.map((row) => toRuleItem({ ...row, product_revision: currentProduct.revision })),
        }
        return result
      })
      return reply.send(success(result, request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })

  app.post('/api/v1/admin/products/:id/pricing-rules/preview', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'], summary: 'Preview pricing suggestions without changing products',
      params: ProductIdParamsSchema, body: PreviewAdminProductPricingRulesBodySchema,
      response: { 200: ApiSuccessSchemaOf(AdminProductPricingPreviewSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const { skuIds } = request.body as PreviewAdminProductPricingRulesBody
    const ids = skuIds.map((id) => id.toLowerCase())
    if (new Set(ids).size !== ids.length) return reply.code(400).send({ error: { code: 'DUPLICATE_SKU_PRICING_RULE', message: '预览中不能重复包含同一个 SKU。' }, meta: { requestId: request.id } })
    try {
      const rows = await readRuleRows(db, productId, ids)
      if (rows.length !== ids.length) {
        const product = await db.selectFrom('products').select('id').where('id', '=', productId).executeTakeFirst()
        if (!product) throw new CatalogError(404, 'PRODUCT_NOT_FOUND', '商品不存在。')
        throw new CatalogError(404, 'SKU_NOT_FOUND', '部分 SKU 不属于此商品。')
      }
      const result = { productId, productRevision: rows[0]!.product_revision, items: rows.map(makePreview) }
      return reply.send(success(result, request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })

  app.post('/api/v1/admin/products/:id/pricing-rules/apply', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'], summary: 'Atomically confirm and apply a current pricing preview',
      params: ProductIdParamsSchema, body: ApplyAdminProductPricingRulesBodySchema,
      response: { 200: ApiSuccessSchemaOf(AdminProductPricingRulesBatchResultSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const administratorId = request.admin?.id
    if (!administratorId) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: '需要管理员登录。' }, meta: { requestId: request.id } })
    const body = request.body as ApplyAdminProductPricingRulesBody
    try {
      const result = await db.transaction().execute(async (trx) => {
        let product
        try {
          product = await lockProductAtRevision(trx, productId, body.expectedRevision)
        } catch (error) {
          if (error instanceof CatalogError && error.code === 'PRODUCT_REVISION_CONFLICT') {
            throw new CatalogError(409, 'PRICING_PREVIEW_STALE', '商品已变化，请重新预览后确认应用。')
          }
          throw error
        }
        assertProductNotArchived(product)
        const ids = body.items.map((item) => item.skuId.toLowerCase())
        if (new Set(ids).size !== ids.length) throw new CatalogError(400, 'DUPLICATE_SKU_PRICING_RULE', '批量应用中不能重复包含同一个 SKU。')
        const variants = await trx.selectFrom('product_variants').selectAll().where('product_id', '=', productId)
          .where('id', 'in', ids).orderBy('id').forUpdate().execute()
        if (variants.length !== ids.length) throw new CatalogError(404, 'SKU_NOT_FOUND', '部分 SKU 不属于此商品。')
        const byId = new Map(variants.map((row) => [row.id, row]))
        const rows = await readRuleRows(trx, productId, ids)
        const currentById = new Map(rows.map((row) => [row.sku_id, row]))
        const prepared = body.items.map((input) => {
          const variant = byId.get(input.skuId.toLowerCase())!
          if (variant.revision !== input.expectedSkuRevision || variant.pricing_rule_revision !== input.expectedRuleRevision) {
            throw new CatalogError(409, 'PRICING_PREVIEW_STALE', `SKU ${variant.sku_code} 或定价规则已变化，请重新预览。`)
          }
          if (variant.retired_at !== null) throw new CatalogError(409, 'SKU_PERMANENTLY_RETIRED', `SKU ${variant.sku_code} 已永久退役，不能重新定价。`)
          const row = currentById.get(variant.id)!
          const preview = makePreview(row)
          if (preview.inputDigest !== input.inputDigest) throw new CatalogError(409, 'PRICING_PREVIEW_STALE', `SKU ${variant.sku_code} 的计算输入已变化，请重新预览。`)
          if (!preview.canApply || preview.suggestedSalePrice === null) throw new CatalogError(409, 'PRICING_RULE_NOT_APPLICABLE', `SKU ${variant.sku_code} 当前没有可应用的定价建议。`)
          const risky = preview.risks.includes('NEGATIVE_PROFIT') || preview.risks.includes('FREE_PRICE')
          if (risky && !body.confirmLossAndFreePrice) {
            throw new CatalogError(400, 'PRICING_RISK_CONFIRMATION_REQUIRED', '请先明确确认负利润或免费价格风险。')
          }
          return { before: row, preview }
        })

        for (const { before, preview } of prepared) {
          await trx.updateTable('product_variants').set({
            sale_price: preview.suggestedSalePrice!,
            pricing_rule_status: 'applied',
          }).where('product_id', '=', productId).where('id', '=', before.sku_id).execute()
          const afterRows = await readRuleRows(trx, productId, [before.sku_id])
          const after = afterRows[0]!
          await appendProductAudit(trx, {
            productId, administratorId, operation: 'rule_applied',
            before: { ...auditState(before), inputDigest: preview.inputDigest },
            after: { ...auditState(after), inputDigest: preview.inputDigest, suggestedSalePrice: preview.suggestedSalePrice },
          })
        }
        const current = await readRuleRows(trx, productId, ids)
        const currentProduct = await trx.selectFrom('products').select('revision').where('id', '=', productId).executeTakeFirstOrThrow()
        return {
          productId, productRevision: currentProduct.revision,
          items: current.map((row) => toRuleItem({ ...row, product_revision: currentProduct.revision })),
        } satisfies AdminProductPricingRulesBatchResult
      })
      return reply.send(success(result, request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })

  app.get('/api/v1/admin/products/:id/variants/:variantId/pricing-rules/history', {
    preHandler: authenticate,
    schema: {
      tags: ['admin', 'catalog'], summary: 'Read immutable pricing rule versions for one SKU',
      params: ProductVariantIdParamsSchema,
      response: { 200: ApiSuccessSchemaOf(AdminProductPricingRuleHistorySchema), 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id: productId, variantId } = request.params as { id: string; variantId: string }
    try {
      const exists = await db.selectFrom('product_variants').select('id')
        .where('product_id', '=', productId).where('id', '=', variantId).executeTakeFirst()
      if (!exists) throw new CatalogError(404, 'SKU_NOT_FOUND', 'SKU 不属于此商品。')
      const rows = await db.selectFrom('product_variant_pricing_rule_versions').selectAll()
        .where('product_id', '=', productId).where('product_variant_id', '=', variantId)
        .orderBy('revision', 'desc').limit(100).execute() as RuleHistoryDbRow[]
      const result: AdminProductPricingRuleHistory = { productId, skuId: variantId, items: rows.map(mapHistory) }
      return reply.send(success(result, request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })

  app.post('/api/v1/admin/products/:id/variants/:variantId/pricing-rules/restore', {
    preHandler: [authenticate, csrfCheck],
    schema: {
      tags: ['admin', 'catalog'], summary: 'Restore a previous rule as a new immutable pricing rule version',
      params: ProductVariantIdParamsSchema, body: RestoreAdminProductPricingRuleBodySchema,
      response: { 200: ApiSuccessSchemaOf(RestoreAdminProductPricingRuleResultSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const { id: productId, variantId } = request.params as { id: string; variantId: string }
    const administratorId = request.admin?.id
    if (!administratorId) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: '需要管理员登录。' }, meta: { requestId: request.id } })
    const body = request.body as RestoreAdminProductPricingRuleBody
    try {
      const result = await db.transaction().execute(async (trx) => {
        const product = await lockProductAtRevision(trx, productId, body.expectedRevision)
        assertProductNotArchived(product)
        const variant = await trx.selectFrom('product_variants').selectAll()
          .where('product_id', '=', productId).where('id', '=', variantId).forUpdate().executeTakeFirst()
        if (!variant) throw new CatalogError(404, 'SKU_NOT_FOUND', 'SKU 不属于此商品。')
        if (variant.revision !== body.expectedSkuRevision || variant.pricing_rule_revision !== body.expectedRuleRevision) {
          throw new CatalogError(409, 'PRICING_RULE_REVISION_CONFLICT', 'SKU 或定价规则已变化，请刷新后重试。')
        }
        if (variant.retired_at !== null) throw new CatalogError(409, 'SKU_PERMANENTLY_RETIRED', '永久退役 SKU 不能恢复定价规则。')
        const source = await trx.selectFrom('product_variant_pricing_rule_versions').selectAll()
          .where('product_id', '=', productId).where('product_variant_id', '=', variantId)
          .where('revision', '=', body.sourceRevision).executeTakeFirst() as RuleHistoryDbRow | undefined
        if (!source) throw new CatalogError(404, 'PRICING_RULE_VERSION_NOT_FOUND', '找不到要恢复的定价规则版本。')
        const same = variant.pricing_mode === source.mode && variant.pricing_fixed_profit === source.fixed_profit
          && variant.pricing_markup_rate === source.markup_rate
        if (same) throw new CatalogError(409, 'PRICING_RULE_ALREADY_CURRENT', '所选历史版本已经是当前规则，无需恢复。')

        await trx.updateTable('product_variants').set({
          pricing_mode: source.mode,
          pricing_fixed_profit: source.fixed_profit,
          pricing_markup_rate: source.markup_rate,
        }).where('product_id', '=', productId).where('id', '=', variantId).execute()
        const updated = await trx.selectFrom('product_variants').selectAll().where('id', '=', variantId).executeTakeFirstOrThrow()
        const rows = await readRuleRows(trx, productId, [variantId])
        const row = rows[0]!
        await trx.insertInto('product_variant_pricing_rule_versions').values({
          id: randomUUID(), product_id: productId, product_variant_id: variantId,
          revision: updated.pricing_rule_revision, mode: source.mode,
          fixed_profit: source.fixed_profit, markup_rate: source.markup_rate,
          change_type: 'restored', restored_from_revision: source.revision, administrator_id: administratorId,
        }).execute()
        await appendProductAudit(trx, {
          productId, administratorId, operation: 'rule_restored',
          before: auditState({ ...row, mode: variant.pricing_mode, fixed_profit: variant.pricing_fixed_profit,
            markup_rate: variant.pricing_markup_rate, rule_revision: variant.pricing_rule_revision,
            rule_status: variant.pricing_rule_status, sku_revision: variant.revision,
            sale_price: variant.sale_price, compare_at_price: variant.compare_at_price, cost_price: variant.cost_price,
            product_revision: product.revision, product_status: product.status, sku_id: variant.id,
            sku_code: variant.sku_code, enabled: variant.enabled, retired_at: variant.retired_at }),
          after: { ...auditState(row), restoredFromRevision: source.revision },
        })
        const currentProduct = await trx.selectFrom('products').select('revision').where('id', '=', productId).executeTakeFirstOrThrow()
        return {
          productId,
          productRevision: currentProduct.revision,
          item: toRuleItem({ ...row, product_revision: currentProduct.revision }),
          restoredFromRevision: source.revision,
        }
      })
      return reply.send(success(result, request.id))
    } catch (error) { return fail(reply, error, request.id) }
  })
}
