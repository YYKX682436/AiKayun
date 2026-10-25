import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  ApiErrorSchema, ApiSuccessSchemaOf, ProductPurchaseFormParamsSchema,
  ProductPurchaseFormApplyBodySchema, PurchaseFormsLifecycleSchema, PurchaseFormsTransitionBodySchema,
  SkuPurchaseFormApplyBodySchema,
  SkuPurchaseFormParamsSchema, failure, success,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database, PurchaseFormsStatus } from '../db/types.js'
import { requireAdmin, verifyCsrf } from '../auth/admin.js'
import { canonicalPurchaseFormJson, validatePurchaseFormDefinition } from '@aikayun/contracts'

type Db = Kysely<Database> | Transaction<Database>

class LifecycleError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function appliedProductMode(mode: 'not_configured' | 'none' | 'template'): 'none' | 'template' {
  return mode === 'template' ? 'template' : 'none'
}

function appliedSkuMode(mode: 'product_default' | 'none' | 'template'): 'none' | 'template' | null {
  return mode === 'product_default' ? null : mode
}

async function lifecycleSummary(db: Db) {
  const policy = await db.selectFrom('storefront_customer_policy').select('purchase_forms_status')
    .where('singleton', '=', true).executeTakeFirstOrThrow()
  const products = await db.selectFrom('products').select(['id', 'status']).orderBy('id').execute()
  const variants = await db.selectFrom('product_variants as variant')
    .leftJoin('product_variant_fulfillment as fulfillment', 'fulfillment.product_variant_id', 'variant.id')
    .select(['variant.id', 'variant.product_id', 'fulfillment.method as fulfillment_method'])
    .orderBy('variant.id').execute()
  const productAssignments = await db.selectFrom('product_purchase_form_settings')
    .select(['product_id', 'mode', 'template_version_id', 'applied_mode', 'applied_template_version_id'])
    .orderBy('product_id').execute()
  const skuAssignments = await db.selectFrom('sku_purchase_form_overrides')
    .select(['product_variant_id', 'mode', 'template_version_id', 'applied_mode', 'applied_template_version_id'])
    .orderBy('product_variant_id').execute()
  const productById = new Map(productAssignments.map(row => [row.product_id, row]))
  const skuById = new Map(skuAssignments.map(row => [row.product_variant_id, row]))
  const resolved = variants.map((variant) => {
    const override = skuById.get(variant.id)
    const product = productById.get(variant.product_id)
    const versionId = override?.mode === 'template'
      ? override.template_version_id
      : override?.mode === 'none'
        ? null
        : product?.mode === 'template' ? product.template_version_id : null
    return { skuId: variant.id, productId: variant.product_id, versionId,
      fulfillmentMethod: variant.fulfillment_method }
  })
  const versionIds = [...new Set(resolved.flatMap(item => item.versionId ? [item.versionId] : []))].sort()
  const versions = versionIds.length
    ? await db.selectFrom('purchase_form_template_versions')
      .select(['id', 'template_id', 'version_number', 'name', 'definition', 'sha256'])
      .where('id', 'in', versionIds).execute()
    : []
  const versionById = new Map(versions.map(row => [row.id, row]))
  let invalidTemplateVersionCount = 0
  for (const versionId of versionIds) {
    const version = versionById.get(versionId)
    const definition = version && validatePurchaseFormDefinition(version.definition)
    if (!version || !definition?.ok
      || createHash('sha256').update(canonicalPurchaseFormJson({ name: version.name, definition: definition.value }), 'utf8').digest('hex') !== version.sha256.trim()) {
      invalidTemplateVersionCount += 1
    }
  }
  const productRevisionRows = productAssignments.map(row => ({
    productId: row.product_id, mode: row.mode, templateVersionId: row.template_version_id,
  }))
  const skuRevisionRows = skuAssignments.map(row => ({
    skuId: row.product_variant_id, mode: row.mode, templateVersionId: row.template_version_id,
  }))
  const impactHash = createHash('sha256').update(canonicalPurchaseFormJson({
    status: policy.purchase_forms_status,
    products: products.map(row => ({ id: row.id, status: row.status })),
    skus: variants.map(row => ({ id: row.id, productId: row.product_id, fulfillmentMethod: row.fulfillment_method })),
    productAssignments: productRevisionRows,
    skuAssignments: skuRevisionRows,
  }), 'utf8').digest('hex')
  const manualHandlingSkuCount = resolved.filter(item => item.versionId && item.fulfillmentMethod === 'manual').length
  const automaticFulfillmentSkuCount = resolved.filter(item => item.versionId
    && ['code_pool', 'fixed_content', 'link', 'file', 'api'].includes(item.fulfillmentMethod ?? '')).length
  const pendingProductApplyCount = policy.purchase_forms_status === 'preparing' ? 0 : productAssignments.filter(row =>
    row.applied_mode !== appliedProductMode(row.mode)
    || row.applied_template_version_id !== (row.mode === 'template' ? row.template_version_id : null)).length
  const pendingSkuApplyCount = policy.purchase_forms_status === 'preparing' ? 0 : skuAssignments.filter(row =>
    row.applied_mode !== appliedSkuMode(row.mode)
    || row.applied_template_version_id !== (row.mode === 'template' ? row.template_version_id : null)).length
  return {
    status: policy.purchase_forms_status,
    impactHash,
    productCount: products.length,
    skuCount: variants.length,
    skuWithTemplateCount: resolved.filter(item => item.versionId !== null).length,
    templateVersionCount: versionIds.length,
    invalidTemplateVersionCount,
    manualHandlingSkuCount,
    automaticFulfillmentSkuCount,
    pendingProductApplyCount,
    pendingSkuApplyCount,
    readyToActivate: invalidTemplateVersionCount === 0,
  }
}

async function lockAdminProduct(trx: Transaction<Database>, productId: string, expectedRevision: number) {
  const product = await trx.selectFrom('products').select(['id', 'revision', 'status'])
    .where('id', '=', productId).forUpdate().executeTakeFirst()
  if (!product) throw new LifecycleError(404, 'PRODUCT_NOT_FOUND', '找不到此商品。')
  if (product.revision !== expectedRevision) throw new LifecycleError(409, 'PRODUCT_REVISION_CONFLICT', '商品配置已变化，请刷新后重试。')
  if (product.status === 'archived') throw new LifecycleError(409, 'PRODUCT_ARCHIVED', '已归档商品不能修改购买填写配置。')
  return product
}

function failureReply(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof LifecycleError) return reply.code(error.status).send(failure(error.code, error.message, requestId))
  return reply.code(500).send(failure('INTERNAL_ERROR', '服务器暂时无法处理此请求。', requestId))
}

export function registerAdminPurchaseFormLifecycleRoutes(
  app: FastifyInstance, db: Kysely<Database>, config: AppConfig,
): void {
  const authenticate = requireAdmin(db, config)
  const protectedWrite = [authenticate, verifyCsrf(config)]

  app.get('/api/v1/admin/storefront/purchase-forms', {
    preHandler: authenticate,
    schema: { tags: ['admin'], summary: 'Read purchase form lifecycle and activation impact',
      response: { 200: ApiSuccessSchemaOf(PurchaseFormsLifecycleSchema), 401: ApiErrorSchema } },
  }, async (request, reply) => {
    try {
      const summary = await lifecycleSummary(db)
      reply.header('cache-control', 'no-store')
      return success(summary, request.id)
    } catch (error) { return failureReply(error, reply, request.id) }
  })

  app.post('/api/v1/admin/storefront/purchase-forms/transition', {
    preHandler: protectedWrite,
    schema: { tags: ['admin'], summary: 'Activate, pause or resume customer purchase forms',
      body: PurchaseFormsTransitionBodySchema,
      response: { 200: ApiSuccessSchemaOf(PurchaseFormsLifecycleSchema), 400: ApiErrorSchema,
        401: ApiErrorSchema, 403: ApiErrorSchema, 409: ApiErrorSchema } },
  }, async (request, reply) => {
    const body = request.body as { expectedStatus: PurchaseFormsStatus; nextStatus: 'active' | 'paused'; expectedImpactHash?: string }
    try {
      const result = await db.transaction().execute(async (trx) => {
        const current = await trx.selectFrom('storefront_customer_policy').select('purchase_forms_status')
          .where('singleton', '=', true).forUpdate().executeTakeFirstOrThrow()
        if (current.purchase_forms_status !== body.expectedStatus) {
          throw new LifecycleError(409, 'PURCHASE_FORMS_STATUS_CONFLICT', '购买填写状态已变化，请刷新后重新确认。')
        }
        if (!((body.expectedStatus === 'preparing' && body.nextStatus === 'active')
          || (body.expectedStatus === 'active' && body.nextStatus === 'paused')
          || (body.expectedStatus === 'paused' && body.nextStatus === 'active'))) {
          throw new LifecycleError(409, 'PURCHASE_FORMS_TRANSITION_INVALID', '购买填写状态不能按此方向切换。')
        }
        if (body.expectedStatus === 'preparing') {
          if (!body.expectedImpactHash) throw new LifecycleError(400, 'PURCHASE_FORMS_IMPACT_REQUIRED', '请先读取并确认本次启用影响范围。')
          await sql`SELECT id FROM products ORDER BY id FOR UPDATE`.execute(trx)
          await sql`SELECT id FROM product_variants ORDER BY id FOR UPDATE`.execute(trx)
          const latest = await lifecycleSummary(trx)
          if (latest.impactHash !== body.expectedImpactHash) {
            throw new LifecycleError(409, 'PURCHASE_FORMS_IMPACT_CHANGED', '商品或模板配置已变化，请重新核对启用影响范围。')
          }
          if (!latest.readyToActivate) {
            throw new LifecycleError(409, 'PURCHASE_FORMS_NOT_READY', '有冻结模板版本无法通过完整性检查，请修复后再启用。')
          }
          await trx.updateTable('product_purchase_form_settings').set((expression) => ({
            applied_mode: sql`CASE WHEN ${expression.ref('mode')} = 'template' THEN 'template' ELSE 'none' END`,
            applied_template_version_id: sql`CASE WHEN ${expression.ref('mode')} = 'template' THEN ${expression.ref('template_version_id')} ELSE NULL END`,
          })).execute()
          await trx.updateTable('sku_purchase_form_overrides').set((expression) => ({
            applied_mode: sql`CASE WHEN ${expression.ref('mode')} = 'product_default' THEN NULL ELSE ${expression.ref('mode')} END`,
            applied_template_version_id: sql`CASE WHEN ${expression.ref('mode')} = 'template' THEN ${expression.ref('template_version_id')} ELSE NULL END`,
          })).execute()
        }
        await trx.updateTable('storefront_customer_policy').set({ purchase_forms_status: body.nextStatus })
          .where('singleton', '=', true).execute()
        await trx.insertInto('purchase_form_audit_events').values({
          id: randomUUID(), administrator_id: request.admin!.id, operation: 'purchase_forms_status_changed',
          template_id: null, product_id: null, product_variant_id: null,
          summary: { previousStatus: body.expectedStatus, nextStatus: body.nextStatus },
        }).execute()
        return lifecycleSummary(trx)
      })
      reply.header('cache-control', 'no-store')
      return success(result, request.id)
    } catch (error) { return failureReply(error, reply, request.id) }
  })

  app.post('/api/v1/admin/products/:id/purchase-form/apply', {
    preHandler: protectedWrite,
    schema: { tags: ['admin', 'catalog'], summary: 'Apply the prepared product purchase form to inherited SKUs',
      params: ProductPurchaseFormParamsSchema, body: ProductPurchaseFormApplyBodySchema,
      response: { 200: ApiSuccessSchemaOf(PurchaseFormsLifecycleSchema), 401: ApiErrorSchema,
        403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema } },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { expectedRevision: number; expectedMode: 'not_configured' | 'none' | 'template'; expectedTemplateVersionId: string | null }
    try {
      const result = await db.transaction().execute(async (trx) => {
        const status = await trx.selectFrom('storefront_customer_policy').select('purchase_forms_status')
          .where('singleton', '=', true).forUpdate().executeTakeFirstOrThrow()
        if (status.purchase_forms_status === 'preparing') throw new LifecycleError(409, 'PURCHASE_FORMS_NOT_ACTIVE', '首次启用时会统一应用当前准备配置。')
        await lockAdminProduct(trx, id, body.expectedRevision)
        const setting = await trx.selectFrom('product_purchase_form_settings').selectAll()
          .where('product_id', '=', id).forUpdate().executeTakeFirst()
        if ((setting?.mode ?? 'not_configured') !== body.expectedMode
          || (setting?.template_version_id ?? null) !== body.expectedTemplateVersionId) {
          throw new LifecycleError(409, 'PURCHASE_FORM_ASSIGNMENT_CHANGED', '准备关联已变化，请刷新并重新确认要应用的规则。')
        }
        if (setting) await trx.updateTable('product_purchase_form_settings').set({
          applied_mode: appliedProductMode(setting.mode),
          applied_template_version_id: setting.mode === 'template' ? setting.template_version_id : null,
        }).where('product_id', '=', id).execute()
        await trx.insertInto('purchase_form_audit_events').values({
          id: randomUUID(), administrator_id: request.admin!.id, operation: 'product_assignment_applied',
          template_id: null, product_id: id, product_variant_id: null,
          summary: { mode: setting?.mode ?? 'not_configured', templateVersionId: setting?.template_version_id ?? null },
        }).execute()
        return lifecycleSummary(trx)
      })
      return reply.send(success(result, request.id))
    } catch (error) { return failureReply(error, reply, request.id) }
  })

  app.post('/api/v1/admin/products/:id/variants/:variantId/purchase-form/apply', {
    preHandler: protectedWrite,
    schema: { tags: ['admin', 'catalog'], summary: 'Apply a prepared SKU purchase form override',
      params: SkuPurchaseFormParamsSchema, body: SkuPurchaseFormApplyBodySchema,
      response: { 200: ApiSuccessSchemaOf(PurchaseFormsLifecycleSchema), 401: ApiErrorSchema,
        403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema } },
  }, async (request, reply) => {
    const { id, variantId } = request.params as { id: string; variantId: string }
    const body = request.body as { expectedRevision: number; expectedMode: 'product_default' | 'none' | 'template'; expectedTemplateVersionId: string | null }
    try {
      const result = await db.transaction().execute(async (trx) => {
        const status = await trx.selectFrom('storefront_customer_policy').select('purchase_forms_status')
          .where('singleton', '=', true).forUpdate().executeTakeFirstOrThrow()
        if (status.purchase_forms_status === 'preparing') throw new LifecycleError(409, 'PURCHASE_FORMS_NOT_ACTIVE', '首次启用时会统一应用当前准备配置。')
        await lockAdminProduct(trx, id, body.expectedRevision)
        const variant = await trx.selectFrom('product_variants').select('id').where('id', '=', variantId)
          .where('product_id', '=', id).forUpdate().executeTakeFirst()
        if (!variant) throw new LifecycleError(404, 'SKU_NOT_FOUND', '找不到此商品规格。')
        const setting = await trx.selectFrom('sku_purchase_form_overrides').selectAll()
          .where('product_id', '=', id).where('product_variant_id', '=', variantId).forUpdate().executeTakeFirst()
        if ((setting?.mode ?? 'product_default') !== body.expectedMode
          || (setting?.template_version_id ?? null) !== body.expectedTemplateVersionId) {
          throw new LifecycleError(409, 'PURCHASE_FORM_ASSIGNMENT_CHANGED', 'SKU 准备覆盖已变化，请刷新并重新确认要应用的规则。')
        }
        if (setting) await trx.updateTable('sku_purchase_form_overrides').set({
          applied_mode: appliedSkuMode(setting.mode),
          applied_template_version_id: setting.mode === 'template' ? setting.template_version_id : null,
        }).where('product_id', '=', id).where('product_variant_id', '=', variantId).execute()
        await trx.insertInto('purchase_form_audit_events').values({
          id: randomUUID(), administrator_id: request.admin!.id, operation: 'sku_override_applied',
          template_id: null, product_id: id, product_variant_id: variantId,
          summary: { mode: setting?.mode ?? 'product_default', templateVersionId: setting?.template_version_id ?? null },
        }).execute()
        return lifecycleSummary(trx)
      })
      return reply.send(success(result, request.id))
    } catch (error) { return failureReply(error, reply, request.id) }
  })
}
