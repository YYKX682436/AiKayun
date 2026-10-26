import { createHash, randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CheckoutQuoteBodySchema,
  CheckoutQuoteSchema,
  CustomerCartAddBodySchema,
  CustomerCartLineParamsSchema,
  CustomerCartReplacementDraftSchema,
  CustomerCartLinePurchaseFormBodySchema,
  CustomerCartLineQuantityBodySchema,
  CustomerCartMergeBodySchema,
  CustomerCartMutationSchema,
  CustomerCartSchema,
  CustomerCartUpdateBodySchema,
  ProductIdParamsSchema,
  failure,
  success,
} from '@aikayun/contracts'
import type {
  CartSkuQuantity,
  CheckoutQuoteBody,
  CustomerCartAddBody,
  CustomerCart,
  CustomerCartMergeBody,
  CustomerCartMutation,
} from '@aikayun/contracts'
import { multiplyUnitAmount, settleAmount } from '@aikayun/money'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { optionalCustomer, requireCustomer, type AuthenticatedCustomer, CUSTOMER_CSRF_COOKIE } from '../auth/customer.js'
import { hashToken, verifyDoubleSubmitCsrf } from '../auth/security.js'
import { PurchaseAttachmentStorage } from '../media/purchase-attachment-storage.js'
import { quoteCheckoutItems, quoteCheckoutPurchaseLines, normalizeCheckoutItems, CheckoutQuoteError } from './checkout-quote.js'
import { assertGuestSession, guestSessionCookie } from './orders.js'
import { PurchaseDraftServiceError, claimGuestPurchaseDraftsInTransaction,
  createPurchaseDraftInTransaction, savePurchaseDraftInTransaction,
  discardCartLineReplacementDraftsInTransaction, prepareCartReplacementAttachmentCopies,
  releaseUnreferencedPurchaseDraftAttachment, transferCartReplacementAttachmentsInTransaction,
  validatePurchaseDraftForPurchaseInTransaction, type PreparedCartReplacementAttachmentCopy } from './purchase-forms.js'
import { normalizePurchaseLineRequests, preparedPurchaseFormVersion, purchaseLineContentIdentity,
  purchaseLineRequestHash, PurchaseLineError, resolvePurchaseLinesInTransaction } from './purchase-lines.js'
import { effectivePurchaseFormForSku, readPurchaseFormsStatus } from './purchase-form-config.js'

const maxCartLines = 50
const maxLineQuantity = 99
const cartReplacementDraftRequestSchema = Type.Object({
  expectedLineRevision: Type.Integer({ minimum: 1 }),
  expectedDraftRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })
const cartReplacementDraftDeleteSchema = Type.Object({
  expectedLineRevision: Type.Integer({ minimum: 1 }),
  expectedDraftRevision: Type.Integer({ minimum: 1 }),
  expectedReplacementDraftRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })
const cartReplacementDraftSaveSchema = Type.Object({
  expectedLineRevision: Type.Integer({ minimum: 1 }),
  expectedDraftRevision: Type.Integer({ minimum: 1 }),
  expectedReplacementDraftRevision: Type.Integer({ minimum: 1 }),
  values: Type.Record(Type.String({ format: 'uuid' }), Type.Unknown()),
  omittedSourceAttachmentIds: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 10 }),
  replacements: Type.Optional(Type.Array(Type.Object({
    oldAttachmentId: Type.String({ format: 'uuid' }),
    newAttachmentId: Type.String({ format: 'uuid' }),
  }, { additionalProperties: false }), { maxItems: 10 })),
}, { additionalProperties: false })


class CartError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CartError'
  }
}

type Db = Kysely<Database> | Transaction<Database>

function emptyCart(): CustomerCart {
  return {
    items: [],
    itemCount: 0,
    totalQuantity: 0,
    pricedSubtotal: '0.00',
    totalAmount: '0.00',
    totalComplete: true,
    canContinue: false,
    policyReasons: [],
    quotedAt: new Date().toISOString(),
    currency: 'CNY',
  }
}

async function cartSnapshot(db: Db, customerId: string, config: AppConfig): Promise<CustomerCart> {
  const purchaseFormsStatus = await readPurchaseFormsStatus(db, 'share')
  const saved = await db.selectFrom('customer_cart_items')
    .select(['line_id', 'sku_id', 'quantity', 'revision', 'draft_id', 'draft_revision',
      'template_version_id', 'normalization_version', 'content_identity'])
    .where('customer_id', '=', customerId)
    .orderBy('updated_at', 'desc')
    .orderBy('sku_id')
    .execute()
  if (!saved.length) return emptyCart()

  const quantities = new Map<string, number>()
  for (const row of saved) quantities.set(row.sku_id, (quantities.get(row.sku_id) ?? 0) + row.quantity)
  const quote = await quoteCheckoutItems(db, [...quantities].map(([skuId, quantity]) => ({ skuId, quantity })),
    customerId, config, { skipPurchaseFormRequirement: true })
  const formVersions = new Map<string, string | null>()
  if (purchaseFormsStatus !== 'preparing') {
    for (const skuId of quantities.keys()) formVersions.set(skuId, await preparedPurchaseFormVersion(db, skuId))
  }
  const bySku = new Map(quote.items.map(item => [item.skuId, item]))
  const draftIds = saved.flatMap(row => row.draft_id ? [row.draft_id] : [])
  const draftRows = draftIds.length ? await db.selectFrom('purchase_drafts')
    .select(['id', 'revision', 'status', 'expires_at', 'template_version_id'])
    .where('id', 'in', draftIds).execute() : []
  const drafts = new Map(draftRows.map(row => [row.id, row]))
  const items = saved.map((row) => {
    const base = bySku.get(row.sku_id)
    if (!base) throw new Error('Saved cart SKU is missing from its quote')
    const draft = row.draft_id ? drafts.get(row.draft_id) : null
    const invalidDraft = row.draft_id !== null && (!draft || draft.status !== 'active'
      || draft.expires_at <= new Date() || draft.revision !== row.draft_revision
      || draft.template_version_id !== row.template_version_id)
    const requiredVersion = formVersions.get(row.sku_id) ?? null
    const formPaused = purchaseFormsStatus === 'paused' && requiredVersion !== null
    const formVersionChanged = requiredVersion !== null && row.template_version_id !== requiredVersion
    const formRequired = purchaseFormsStatus === 'active' && requiredVersion !== null
      && (!row.draft_id || formVersionChanged)
    return {
      ...base,
      lineId: row.line_id,
      lineRevision: row.revision,
      draftId: row.draft_id,
      draftRevision: row.draft_revision,
      templateVersionId: row.template_version_id,
      normalizationVersion: row.normalization_version,
      contentIdentity: row.content_identity,
      quantity: row.quantity,
      lineTotal: base.unitPrice === null ? null : settleAmount(multiplyUnitAmount(base.unitPrice, row.quantity)),
      canPurchase: base.canPurchase && !invalidDraft && !formRequired && !formPaused,
      reason: invalidDraft ? 'purchase_form_invalid' as const
        : formPaused ? 'purchase_forms_paused' as const
          : formVersionChanged ? 'purchase_form_version_changed' as const
            : formRequired ? 'purchase_form_required' as const : base.reason,
    }
  })
  return {
    items,
    itemCount: saved.length,
    totalQuantity: saved.reduce((total, row) => total + row.quantity, 0),
    pricedSubtotal: quote.pricedSubtotal,
    totalAmount: quote.totalAmount,
    totalComplete: quote.totalComplete,
    canContinue: quote.canContinue && items.every(item => item.canPurchase),
    policyReasons: quote.policyReasons,
    quotedAt: quote.quotedAt,
    currency: quote.currency,
  }
}

async function authenticatedCartSnapshot(
  db: Kysely<Database>, customer: AuthenticatedCustomer, config: AppConfig,
): Promise<CustomerCart> {
  return db.transaction().execute(async (trx) => {
    await lockCustomer(trx, customer, false)
    return cartSnapshot(trx, customer.id, config)
  })
}

async function lockCustomer(
  trx: Transaction<Database>,
  customer: AuthenticatedCustomer,
  write: boolean,
): Promise<void> {
  let ownerQuery = trx.selectFrom('customers').select(['id', 'status', 'username'])
    .where('id', '=', customer.id)
  ownerQuery = write ? ownerQuery.forUpdate() : ownerQuery.forShare()
  const owner = await ownerQuery.executeTakeFirst()
  if (!owner || owner.status !== 'active' || !owner.username) {
    throw new CartError(401, 'UNAUTHORIZED', '顾客登录状态已失效，请重新登录。')
  }

  const session = await trx.selectFrom('customer_sessions')
    .select(['id'])
    .where('id', '=', customer.sessionId)
    .where('customer_id', '=', customer.id)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date())
    .forShare()
    .executeTakeFirst()
  if (!session) throw new CartError(401, 'UNAUTHORIZED', '顾客登录状态已失效，请重新登录。')
}

async function lockExistingSkus(trx: Transaction<Database>, skuIds: string[]): Promise<Set<string>> {
  if (!skuIds.length) return new Set()
  const result = await sql<{ sku_id: string }>`
    SELECT variant.id AS sku_id
    FROM product_variants AS variant
    JOIN products AS product ON product.id = variant.product_id
    WHERE variant.id = ANY(${skuIds}::uuid[])
    ORDER BY product.id, variant.id
    FOR KEY SHARE OF product, variant
  `.execute(trx)
  return new Set(result.rows.map(row => row.sku_id))
}

function mergeDigest(items: CartSkuQuantity[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex')
}

async function discardPendingLineReplacements(trx: Transaction<Database>, lineIds: string[]): Promise<void> {
  await discardCartLineReplacementDraftsInTransaction(trx, lineIds)
}

type ReplacementSourceLine = {
  line_id: string
  customer_id: string
  revision: number
  draft_id: string | null
  draft_revision: number | null
  template_version_id: string | null
  content_identity: string
}

/** Keep the relation alive only when the bound source identity is unchanged. */
async function reconcileReplacementAfterCartLineUpdate(
  trx: Transaction<Database>,
  before: ReplacementSourceLine,
  after: ReplacementSourceLine,
): Promise<void> {
  const relation = await trx.selectFrom('customer_cart_line_replacement_drafts').selectAll()
    .where('line_id', '=', before.line_id).where('customer_id', '=', before.customer_id).forUpdate().executeTakeFirst()
  if (!relation) return
  const draftIds = [...new Set([relation.source_draft_id, relation.replacement_draft_id])].sort()
  const drafts = await trx.selectFrom('purchase_drafts').select(['id', 'status', 'expires_at', 'revision', 'template_version_id'])
    .where('id', 'in', draftIds).orderBy('id').forUpdate().execute()
  const target = drafts.find(draft => draft.id === relation.replacement_draft_id)
  const source = drafts.find(draft => draft.id === after.draft_id)
  const unchanged = before.draft_id !== null && before.draft_id === after.draft_id
    && before.template_version_id === after.template_version_id
    && before.draft_revision === after.draft_revision
    && before.content_identity === after.content_identity
  const relationStillMatches = relation.source_draft_id === before.draft_id
    && relation.source_line_revision === before.revision
    && relation.source_draft_revision === before.draft_revision
  const nextSourceValid = source?.status === 'active' && source.expires_at > new Date()
    && source.revision === after.draft_revision && source.template_version_id === after.template_version_id
  const targetValid = target?.status === 'active' && target.expires_at > new Date()
    && target.template_version_id === after.template_version_id
  if (unchanged && relationStillMatches && nextSourceValid && targetValid) {
    await trx.updateTable('customer_cart_line_replacement_drafts').set({
      source_line_revision: after.revision,
      source_draft_revision: after.draft_revision!,
    }).where('line_id', '=', before.line_id).execute()
    return
  }
  await discardPendingLineReplacements(trx, [before.line_id])
}

async function setCartLineQuantityInTransaction(
  trx: Transaction<Database>, before: ReplacementSourceLine, quantity: number,
): Promise<number> {
  const updated = await trx.updateTable('customer_cart_items').set({ quantity })
    .where('customer_id', '=', before.customer_id).where('line_id', '=', before.line_id)
    .returning('revision').executeTakeFirstOrThrow()
  await reconcileReplacementAfterCartLineUpdate(trx, before, { ...before, revision: updated.revision })
  return updated.revision
}

async function releaseUncommittedReplacementCopies(
  db: Kysely<Database>,
  storage: PurchaseAttachmentStorage,
  customer: AuthenticatedCustomer,
  copies: PreparedCartReplacementAttachmentCopy[],
): Promise<void> {
  for (const copy of copies) {
    try {
      const existing = await db.selectFrom('purchase_draft_attachments')
        .select(['draft_id', 'storage_key']).where('id', '=', copy.id).executeTakeFirst()
      if (!existing) {
        await storage.remove(copy.id, copy.storageKey)
        continue
      }
      // This helper is called only before finalization or after its callback
      // failed, when COMMIT was never requested. Keep the reference guard too.
      await releaseUnreferencedPurchaseDraftAttachment(db, storage,
        { kind: 'customer', customer }, existing.draft_id, copy.id)
    } catch { /* Keep uncertain copies for the private attachment reconciler. */ }
  }
}

type CartLineContent = {
  skuId: string
  quantity: number
  contentIdentity: string
  draftId: string | null
  draftRevision: number | null
  templateVersionId: string | null
  normalizationVersion: number | null
}

async function addCartLineInTransaction(
  trx: Transaction<Database>, customerId: string, line: CartLineContent,
): Promise<{ retainedLineId: string; changed: boolean }> {
  const currentRows = await trx.selectFrom('customer_cart_items')
    .select(['line_id', 'sku_id', 'quantity', 'revision', 'content_identity', 'draft_id', 'draft_revision', 'template_version_id'])
    .where('customer_id', '=', customerId).orderBy('line_id').execute()
  const skuTotal = currentRows.filter(row => row.sku_id === line.skuId)
    .reduce((total, row) => total + row.quantity, 0)
  if (skuTotal + line.quantity > maxLineQuantity) {
    throw new CartError(409, 'CART_QUANTITY_LIMIT', `同一 SKU 的购物车数量不能超过 ${maxLineQuantity}。`)
  }
  const existing = currentRows.find(row => row.sku_id === line.skuId && row.content_identity === line.contentIdentity)
  if (existing) {
    let replacement: Partial<Pick<Database['customer_cart_items'], 'draft_id' | 'draft_revision'
      | 'template_version_id' | 'normalization_version'>> = {}
    if (existing.draft_id) {
      const bound = await trx.selectFrom('purchase_drafts')
        .select(['revision', 'status', 'expires_at', 'template_version_id'])
        .where('id', '=', existing.draft_id).executeTakeFirst()
      const stale = !bound || bound.status !== 'active' || bound.expires_at <= new Date()
        || bound.revision !== existing.draft_revision || bound.template_version_id !== existing.template_version_id
      if (stale) {
        if (!line.draftId) throw new CartError(409, 'PURCHASE_DRAFT_INVALID', '原购物车填写资料已失效，请重新确认。')
        await discardPendingLineReplacements(trx, [existing.line_id])
        replacement = {
          draft_id: line.draftId, draft_revision: line.draftRevision,
          template_version_id: line.templateVersionId, normalization_version: line.normalizationVersion,
        }
      }
    }
    const updated = await trx.updateTable('customer_cart_items').set({ quantity: existing.quantity + line.quantity, ...replacement })
      .where('line_id', '=', existing.line_id).returning('revision').executeTakeFirstOrThrow()
    const after: ReplacementSourceLine = {
      line_id: existing.line_id, customer_id: customerId, revision: updated.revision,
      draft_id: replacement.draft_id ?? existing.draft_id,
      draft_revision: replacement.draft_revision ?? existing.draft_revision,
      template_version_id: replacement.template_version_id ?? existing.template_version_id,
      content_identity: existing.content_identity,
    }
    await reconcileReplacementAfterCartLineUpdate(trx, { ...existing, customer_id: customerId }, after)
    return { retainedLineId: existing.line_id, changed: true }
  }
  if (currentRows.length >= maxCartLines) {
    throw new CartError(409, 'CART_ITEM_LIMIT', `购物车最多包含 ${maxCartLines} 个购买行。`)
  }
  if (line.draftId && currentRows.some(row => row.draft_id === line.draftId)) {
    throw new CartError(409, 'PURCHASE_DRAFT_ALREADY_BOUND', '这份填写草稿已绑定另一购买行，请为新行另存草稿。')
  }
  const lineId = randomUUID()
  await trx.insertInto('customer_cart_items').values({
    line_id: lineId, customer_id: customerId, sku_id: line.skuId, quantity: line.quantity,
    content_identity: line.contentIdentity, draft_id: line.draftId,
    draft_revision: line.draftRevision, template_version_id: line.templateVersionId,
    normalization_version: line.normalizationVersion,
  }).execute()
  return { retainedLineId: lineId, changed: true }
}

function mapError(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof CartError || error instanceof CheckoutQuoteError
    || error instanceof PurchaseDraftServiceError || error instanceof PurchaseLineError) {
    return reply.code(error.status).send(failure(error.code, error.message, requestId))
  }
  if (error instanceof RangeError || error instanceof TypeError) {
    return reply.code(422).send(failure('QUOTE_AMOUNT_OUT_OF_RANGE', '报价金额超出当前结算金额范围。', requestId))
  }
  throw error
}

export function registerCustomerCartRoutes(app: FastifyInstance, db: Kysely<Database>, config: AppConfig): void {
  const authenticateCustomer = requireCustomer(db, config)
  const authenticateOptionalCustomer = optionalCustomer(db, config)
  const csrfCheck = verifyDoubleSubmitCsrf(config, CUSTOMER_CSRF_COOKIE)
  const purchaseAttachmentStorage = new PurchaseAttachmentStorage(config.privateFileRoot)

  app.get('/api/v1/customer/cart', {
    preHandler: authenticateCustomer,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Read the signed-in customer cart with a fresh server quote',
      response: { 200: ApiSuccessSchemaOf(CustomerCartSchema), 401: ApiErrorSchema, 429: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const customer = request.customer!
      const cart = await db.transaction().execute(async (trx) => {
        await lockCustomer(trx, customer, false)
        return cartSnapshot(trx, customer.id, config)
      })
      reply.header('cache-control', 'no-store')
      return success(cart, request.id)
    } catch (error) {
      return mapError(error, reply, request.id)
    }
  })

  app.post('/api/v1/customer/cart/items', {
    preHandler: [authenticateCustomer, csrfCheck],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Add or increase one SKU in the signed-in customer cart',
      body: CustomerCartAddBodySchema,
      response: {
        200: ApiSuccessSchemaOf(CustomerCartMutationSchema), 400: ApiErrorSchema,
        401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body as CustomerCartAddBody
      const added = await db.transaction().execute(async (trx) => {
        const customer = request.customer!
        await lockCustomer(trx, customer, true)
        await readPurchaseFormsStatus(trx, 'share')
        const found = await lockExistingSkus(trx, [body.skuId])
        if (!found.has(body.skuId)) throw new CartError(404, 'SKU_NOT_FOUND', '所选商品规格已不存在。')
        if ('version' in body) {
          const draft = await validatePurchaseDraftForPurchaseInTransaction(trx, config,
            { kind: 'customer', customer }, { draftId: body.draftId, expectedRevision: body.draftRevision })
          const preparedVersion = await preparedPurchaseFormVersion(trx, body.skuId)
          if (draft.templateVersionId !== preparedVersion) {
            throw new CartError(409, 'PURCHASE_FORM_VERSION_CHANGED', '商品填写模板绑定已变化，请重新确认购买资料。')
          }
          return addCartLineInTransaction(trx, customer.id, {
            skuId: body.skuId, quantity: body.quantity,
            contentIdentity: purchaseLineContentIdentity(body.skuId, draft.templateVersionId,
              draft.normalizationVersion, draft.normalizedValues),
            draftId: draft.id, draftRevision: draft.revision,
            templateVersionId: draft.templateVersionId, normalizationVersion: draft.normalizationVersion,
          })
        }
        return addCartLineInTransaction(trx, customer.id, {
          skuId: body.skuId, quantity: body.quantity,
          contentIdentity: purchaseLineContentIdentity(body.skuId, null, null, null),
          draftId: null, draftRevision: null, templateVersionId: null, normalizationVersion: null,
        })
      })
      const cart = await authenticatedCartSnapshot(db, request.customer!, config)
      reply.header('cache-control', 'no-store')
      const result: CustomerCartMutation = { changed: added.changed, merged: false,
        skippedSkuIds: [], retainedLineId: added.retainedLineId, cart }
      return success(result, request.id)
    } catch (error) {
      return mapError(error, reply, request.id)
    }
  })

  app.patch('/api/v1/customer/cart/items/:id', {
    preHandler: [authenticateCustomer, csrfCheck],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Set the quantity of one SKU in the signed-in customer cart',
      params: ProductIdParamsSchema, body: CustomerCartUpdateBodySchema,
      response: {
        200: ApiSuccessSchemaOf(CustomerCartMutationSchema), 400: ApiErrorSchema,
        401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const { id: skuId } = request.params as { id: string }
      const { quantity } = request.body as { quantity: number }
      const retainedLineId = await db.transaction().execute(async (trx) => {
        const customer = request.customer!
        await lockCustomer(trx, customer, true)
        const noFormIdentity = purchaseLineContentIdentity(skuId, null, null, null)
        const other = await trx.selectFrom('customer_cart_items')
          .select(['line_id', 'quantity'])
          .where('customer_id', '=', customer.id).where('sku_id', '=', skuId)
          .where('content_identity', '!=', noFormIdentity).execute()
        if (other.reduce((total, row) => total + row.quantity, 0) + quantity > maxLineQuantity) {
          throw new CartError(409, 'CART_QUANTITY_LIMIT', `同一 SKU 的购物车数量不能超过 ${maxLineQuantity}。`)
        }
        const updated = await trx.updateTable('customer_cart_items')
          .set({ quantity })
          .where('customer_id', '=', customer.id)
          .where('sku_id', '=', skuId)
          .where('content_identity', '=', noFormIdentity)
          .returning('line_id')
          .executeTakeFirst()
        if (!updated) throw new CartError(404, 'CART_ITEM_NOT_FOUND', '购物车中没有该商品规格。')
        return updated.line_id
      })
      const cart = await authenticatedCartSnapshot(db, request.customer!, config)
      reply.header('cache-control', 'no-store')
      return success({ changed: true, merged: false, skippedSkuIds: [], retainedLineId, cart } satisfies CustomerCartMutation, request.id)
    } catch (error) {
      return mapError(error, reply, request.id)
    }
  })

  app.delete('/api/v1/customer/cart/items/:id', {
    preHandler: [authenticateCustomer, csrfCheck],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Remove one SKU from the signed-in customer cart',
      params: ProductIdParamsSchema,
      response: {
        200: ApiSuccessSchemaOf(CustomerCartMutationSchema), 401: ApiErrorSchema,
        403: ApiErrorSchema, 429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const { id: skuId } = request.params as { id: string }
      const changed = await db.transaction().execute(async (trx) => {
        const customer = request.customer!
        await lockCustomer(trx, customer, true)
        const lines = await trx.selectFrom('customer_cart_items').select('line_id')
          .where('customer_id', '=', customer.id).where('sku_id', '=', skuId)
          .where('content_identity', '=', purchaseLineContentIdentity(skuId, null, null, null))
          .orderBy('line_id').forUpdate().execute()
        await discardPendingLineReplacements(trx, lines.map(line => line.line_id))
        const deleted = await trx.deleteFrom('customer_cart_items')
          .where('customer_id', '=', customer.id)
          .where('sku_id', '=', skuId)
          .where('content_identity', '=', purchaseLineContentIdentity(skuId, null, null, null))
          .executeTakeFirst()
        return deleted.numDeletedRows > 0n
      })
      const cart = await authenticatedCartSnapshot(db, request.customer!, config)
      reply.header('cache-control', 'no-store')
      return success({ cart, changed, merged: false, skippedSkuIds: [], retainedLineId: null } satisfies CustomerCartMutation, request.id)
    } catch (error) {
      return mapError(error, reply, request.id)
    }
  })

  app.delete('/api/v1/customer/cart', {
    preHandler: [authenticateCustomer, csrfCheck],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Clear the signed-in customer cart',
      response: {
        200: ApiSuccessSchemaOf(CustomerCartMutationSchema), 401: ApiErrorSchema,
        403: ApiErrorSchema, 429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const result = await db.transaction().execute(async (trx) => {
        const customer = request.customer!
        await lockCustomer(trx, customer, true)
        const lines = await trx.selectFrom('customer_cart_items').select('line_id')
          .where('customer_id', '=', customer.id).orderBy('line_id').forUpdate().execute()
        await discardPendingLineReplacements(trx, lines.map(line => line.line_id))
        const deleted = await trx.deleteFrom('customer_cart_items')
          .where('customer_id', '=', customer.id).executeTakeFirst()
        return deleted.numDeletedRows > 0n
      })
      const cart = await authenticatedCartSnapshot(db, request.customer!, config)
      reply.header('cache-control', 'no-store')
      return success({ changed: result, cart, merged: false, skippedSkuIds: [], retainedLineId: null } satisfies CustomerCartMutation, request.id)
    } catch (error) {
      return mapError(error, reply, request.id)
    }
  })

  app.patch('/api/v1/customer/cart/lines/:lineId', {
    preHandler: [authenticateCustomer, csrfCheck],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Set quantity for one stable cart line',
      params: CustomerCartLineParamsSchema, body: CustomerCartLineQuantityBodySchema,
      response: { 200: ApiSuccessSchemaOf(CustomerCartMutationSchema), 401: ApiErrorSchema,
        403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const { lineId } = request.params as { lineId: string }
      const body = request.body as { quantity: number; expectedLineRevision: number }
      await db.transaction().execute(async (trx) => {
        const customer = request.customer!
        await lockCustomer(trx, customer, true)
        const line = await trx.selectFrom('customer_cart_items').selectAll()
          .where('customer_id', '=', customer.id).where('line_id', '=', lineId)
          .forUpdate().executeTakeFirst()
        if (!line) throw new CartError(404, 'CART_ITEM_NOT_FOUND', '购物车中没有该购买行。')
        if (line.revision !== body.expectedLineRevision) {
          throw new CartError(409, 'CART_LINE_REVISION_CONFLICT', '购买行已被其他操作修改，请刷新购物车。')
        }
        const other = await trx.selectFrom('customer_cart_items').select('quantity')
          .where('customer_id', '=', customer.id).where('sku_id', '=', line.sku_id)
          .where('line_id', '!=', lineId).execute()
        if (other.reduce((sum, row) => sum + row.quantity, body.quantity) > maxLineQuantity) {
          throw new CartError(409, 'CART_QUANTITY_LIMIT', `同一 SKU 的购物车数量不能超过 ${maxLineQuantity}。`)
        }
        await setCartLineQuantityInTransaction(trx, line, body.quantity)
      })
      const cart = await authenticatedCartSnapshot(db, request.customer!, config)
      reply.header('cache-control', 'no-store')
      return success({ changed: true, merged: false, skippedSkuIds: [], retainedLineId: lineId, cart } satisfies CustomerCartMutation, request.id)
    } catch (error) { return mapError(error, reply, request.id) }
  })

  app.post('/api/v1/customer/cart/lines/:lineId/purchase-form/replacement-draft', {
    logLevel: 'silent', preHandler: [authenticateCustomer, csrfCheck],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Start or resume the isolated edit draft for one valid cart line',
      params: CustomerCartLineParamsSchema, body: cartReplacementDraftRequestSchema,
      response: { 200: ApiSuccessSchemaOf(CustomerCartReplacementDraftSchema), 201: ApiSuccessSchemaOf(CustomerCartReplacementDraftSchema),
        400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const { lineId } = request.params as { lineId: string }
      const body = request.body as { expectedLineRevision: number; expectedDraftRevision: number }
      const customer = request.customer!
      const result = await db.transaction().execute(async trx => {
        await lockCustomer(trx, customer, true)
        const line = await trx.selectFrom('customer_cart_items').selectAll()
          .where('customer_id', '=', customer.id).where('line_id', '=', lineId).forUpdate().executeTakeFirst()
        if (!line || !line.draft_id || line.draft_revision === null) {
          throw new CartError(404, 'CART_ITEM_NOT_FOUND', '购物车中没有可编辑的资料购买行。')
        }
        if (line.revision !== body.expectedLineRevision || line.draft_revision !== body.expectedDraftRevision) {
          throw new CartError(409, 'CART_LINE_REVISION_CONFLICT', '购买行已变化，请刷新购物车后再编辑。')
        }
        const effective = await effectivePurchaseFormForSku(trx, line.sku_id, { lockStatus: 'share' })
        if (!effective.templateVersionId || effective.templateVersionId !== line.template_version_id) {
          await discardPendingLineReplacements(trx, [lineId])
          return { httpStatus: 409 as const, error: {
            code: 'PURCHASE_FORM_VERSION_CHANGED', message: '商品填写模板已变化，当前购买行仍保留原资料。',
          } }
        }
        const existing = await trx.selectFrom('customer_cart_line_replacement_drafts').selectAll()
          .where('line_id', '=', lineId).where('customer_id', '=', customer.id).forUpdate().executeTakeFirst()
        if (existing) {
          const target = await trx.selectFrom('purchase_drafts').select(['id', 'revision', 'status', 'expires_at', 'template_version_id'])
            .where('id', '=', existing.replacement_draft_id).forUpdate().executeTakeFirst()
          const relationCurrent = existing.source_draft_id === line.draft_id
            && existing.source_line_revision === line.revision
            && existing.source_draft_revision === line.draft_revision
          if (relationCurrent && target && target.status === 'active' && target.expires_at > new Date()
            && target.template_version_id === effective.templateVersionId) {
            return { httpStatus: 200 as const, value: {
              lineId, skuId: line.sku_id, quantity: line.quantity, sourceDraftId: line.draft_id, sourceLineRevision: line.revision,
              sourceDraftRevision: line.draft_revision, replacementDraftId: target.id,
              replacementDraftRevision: target.revision, templateVersionId: target.template_version_id,
              omittedSourceAttachmentIds: existing.omitted_source_attachment_ids,
            } }
          }
          // The source identity or target lifecycle changed. Commit invalidation
          // before creating a fresh isolated draft; never re-label stale data.
          await discardPendingLineReplacements(trx, [lineId])
        }
        const uploading = await trx.selectFrom('purchase_draft_attachments').select('id')
          .where('draft_id', '=', line.draft_id).where('status', '=', 'uploading').forShare().executeTakeFirst()
        if (uploading) throw new CartError(409, 'PURCHASE_ATTACHMENT_UPLOAD_IN_PROGRESS', '原图片仍在保存，请稍后再编辑购买资料。')
        const source = await trx.selectFrom('purchase_drafts').select(['id', 'revision', 'status', 'expires_at', 'template_version_id'])
          .where('id', '=', line.draft_id).where('customer_id', '=', customer.id).forUpdate().executeTakeFirst()
        if (!source || source.status !== 'active' || source.expires_at <= new Date()
          || source.revision !== line.draft_revision || source.template_version_id !== effective.templateVersionId) {
          throw new CartError(409, 'PURCHASE_DRAFT_REVISION_CONFLICT', '原购物车资料已过期或变化；请返回购物车重新确认。')
        }
        const created = await createPurchaseDraftInTransaction(trx, config,
          { kind: 'customer', customer }, effective.templateVersionId, new Date(), { replacementCreditDraftId: source.id })
        await trx.insertInto('customer_cart_line_replacement_drafts').values({
          line_id: lineId, customer_id: customer.id, source_draft_id: source.id,
          replacement_draft_id: created.id, source_line_revision: line.revision,
          source_draft_revision: line.draft_revision, omitted_source_attachment_ids: [],
        }).execute()
        return { httpStatus: 201 as const, value: {
          lineId, skuId: line.sku_id, quantity: line.quantity, sourceDraftId: source.id, sourceLineRevision: line.revision,
          sourceDraftRevision: line.draft_revision, replacementDraftId: created.id,
          replacementDraftRevision: created.revision, templateVersionId: effective.templateVersionId,
          omittedSourceAttachmentIds: [],
        } }
      })
      reply.header('cache-control', 'private, no-store')
      if ('error' in result) return reply.code(result.httpStatus).send(failure(result.error.code,
        result.error.message, request.id))
      return reply.code(result.httpStatus).send(success(result.value, request.id))
    } catch (error) { return mapError(error, reply, request.id) }
  })

  app.get('/api/v1/customer/cart/lines/:lineId/purchase-form/replacement-draft', {
    preHandler: [authenticateCustomer],
    schema: {
      tags: ['customer'], summary: 'Read safe metadata for one cart line replacement draft',
      params: CustomerCartLineParamsSchema,
      response: { 200: ApiSuccessSchemaOf(CustomerCartReplacementDraftSchema), 401: ApiErrorSchema,
        404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const { lineId } = request.params as { lineId: string }
      const customer = request.customer!
      const result = await db.transaction().execute(async trx => {
        await lockCustomer(trx, customer, false)
        const line = await trx.selectFrom('customer_cart_items').selectAll()
          .where('customer_id', '=', customer.id).where('line_id', '=', lineId).forShare().executeTakeFirst()
        if (!line || !line.draft_id || line.draft_revision === null) {
          throw new CartError(404, 'CART_REPLACEMENT_NOT_FOUND', '此购买行没有可恢复的编辑草稿。')
        }
        const relation = await trx.selectFrom('customer_cart_line_replacement_drafts').selectAll()
          .where('line_id', '=', lineId).where('customer_id', '=', customer.id).forShare().executeTakeFirst()
        if (!relation) throw new CartError(404, 'CART_REPLACEMENT_NOT_FOUND', '此购买行没有可恢复的编辑草稿。')
        if (line.draft_id !== relation.source_draft_id || line.revision !== relation.source_line_revision
          || line.draft_revision !== relation.source_draft_revision) {
          throw new CartError(409, 'CART_REPLACEMENT_CONFLICT', '购买行已变化；原购买资料仍保留。')
        }
        const effective = await effectivePurchaseFormForSku(trx, line.sku_id, { lockStatus: 'share' })
        const drafts = await trx.selectFrom('purchase_drafts').select([
          'id', 'revision', 'status', 'expires_at', 'template_version_id', 'customer_id', 'guest_order_session_id',
        ]).where('id', 'in', [relation.source_draft_id, relation.replacement_draft_id].sort())
          .orderBy('id').forShare().execute()
        const source = drafts.find(draft => draft.id === relation.source_draft_id)
        const target = drafts.find(draft => draft.id === relation.replacement_draft_id)
        if (!source || source.customer_id !== customer.id || source.guest_order_session_id !== null
          || source.status !== 'active' || source.expires_at <= new Date()
          || source.revision !== relation.source_draft_revision || source.template_version_id !== line.template_version_id
          || !effective.templateVersionId || effective.templateVersionId !== source.template_version_id) {
          throw new CartError(409, 'CART_REPLACEMENT_CONFLICT', '购买行来源或模板已变化；原购买资料仍保留，请重新确认。')
        }
        if (!target || target.status !== 'active' || target.expires_at <= new Date()) {
          throw new CartError(410, 'CART_REPLACEMENT_EXPIRED', '编辑草稿已过期；原购物车资料仍保留。')
        }
        if (target.customer_id !== customer.id || target.guest_order_session_id !== null
          || target.template_version_id !== source.template_version_id) {
          throw new CartError(409, 'CART_REPLACEMENT_CONFLICT', '购买行编辑资料已变化，请重新确认。')
        }
        return {
          lineId, skuId: line.sku_id, quantity: line.quantity, sourceDraftId: relation.source_draft_id, sourceLineRevision: relation.source_line_revision,
          sourceDraftRevision: relation.source_draft_revision, replacementDraftId: target.id,
          replacementDraftRevision: target.revision, templateVersionId: target.template_version_id,
          omittedSourceAttachmentIds: relation.omitted_source_attachment_ids,
        }
      })
      reply.header('cache-control', 'private, no-store')
      return success(result, request.id)
    } catch (error) { return mapError(error, reply, request.id) }
  })

  app.put('/api/v1/customer/cart/lines/:lineId/purchase-form/replacement-draft', {
    logLevel: 'silent', preHandler: [authenticateCustomer, csrfCheck],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Save a partial isolated draft without changing the valid cart binding',
      params: CustomerCartLineParamsSchema, body: cartReplacementDraftSaveSchema,
      response: { 200: ApiSuccessSchemaOf(Type.Object({
        replacementDraftRevision: Type.Integer({ minimum: 1 }),
        complete: Type.Boolean(),
        incompleteFieldIds: Type.Array(Type.String({ format: 'uuid' })),
      }, { additionalProperties: false })), 400: ApiErrorSchema, 401: ApiErrorSchema,
        404: ApiErrorSchema, 409: ApiErrorSchema, 413: ApiErrorSchema, 422: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const { lineId } = request.params as { lineId: string }
      const body = request.body as {
        expectedLineRevision: number
        expectedDraftRevision: number
        expectedReplacementDraftRevision: number
        values: Record<string, unknown>
        omittedSourceAttachmentIds: string[]
        replacements?: Array<{ oldAttachmentId: string; newAttachmentId: string }>
      }
      const customer = request.customer!
      const saved = await db.transaction().execute(async trx => {
        await lockCustomer(trx, customer, true)
        const line = await trx.selectFrom('customer_cart_items').selectAll()
          .where('customer_id', '=', customer.id).where('line_id', '=', lineId).forUpdate().executeTakeFirst()
        const relation = await trx.selectFrom('customer_cart_line_replacement_drafts').selectAll()
          .where('line_id', '=', lineId).where('customer_id', '=', customer.id).forUpdate().executeTakeFirst()
        if (!line || !relation || line.draft_id !== relation.source_draft_id) {
          throw new CartError(404, 'CART_REPLACEMENT_NOT_FOUND', '找不到此购物车行的编辑草稿。')
        }
        if (line.revision !== body.expectedLineRevision || line.draft_revision !== body.expectedDraftRevision
          || relation.source_line_revision !== line.revision || relation.source_draft_revision !== line.draft_revision) {
          throw new CartError(409, 'CART_REPLACEMENT_CONFLICT', '原购买行已变化；上次有效资料仍保留。')
        }
        const omitted = [...new Set(body.omittedSourceAttachmentIds.map(id => id.toLowerCase()))]
        if (omitted.length !== body.omittedSourceAttachmentIds.length) {
          throw new CartError(400, 'CART_REPLACEMENT_ATTACHMENT_INVALID', '图片编辑状态无效。')
        }
        if (omitted.length) {
          const referenced = await trx.selectFrom('purchase_draft_attachments as attachment')
            .innerJoin('purchase_draft_attachment_references as reference', join => join
              .onRef('reference.attachment_id', '=', 'attachment.id').onRef('reference.draft_id', '=', 'attachment.draft_id'))
            .select('attachment.id').where('attachment.draft_id', '=', relation.source_draft_id)
            .where('attachment.status', '=', 'ready').where('attachment.id', 'in', omitted).forShare().execute()
          if (referenced.length !== omitted.length) {
            throw new CartError(409, 'CART_REPLACEMENT_ATTACHMENT_INVALID', '原图片已变化，请刷新后重新编辑。')
          }
        }
        const effective = await effectivePurchaseFormForSku(trx, line.sku_id, { lockStatus: 'share' })
        if (!effective.templateVersionId || effective.templateVersionId !== line.template_version_id) {
          throw new CartError(409, 'PURCHASE_FORM_VERSION_CHANGED', '填写模板已变化；原购物车资料仍保留。')
        }
        const result = await savePurchaseDraftInTransaction(trx, config, { kind: 'customer', customer }, {
          draftId: relation.replacement_draft_id,
          expectedRevision: body.expectedReplacementDraftRevision,
          values: body.values,
        }, { expectedTemplateVersionId: effective.templateVersionId,
          ...(body.replacements ? { replacements: body.replacements } : {}) })
        await trx.updateTable('customer_cart_line_replacement_drafts')
          .set({ omitted_source_attachment_ids: omitted })
          .where('line_id', '=', lineId).execute()
        return { replacementDraftRevision: result.revision, complete: result.complete,
          incompleteFieldIds: result.incompleteFieldIds }
      })
      reply.header('cache-control', 'private, no-store')
      return success(saved, request.id)
    } catch (error) { return mapError(error, reply, request.id) }
  })

  app.delete('/api/v1/customer/cart/lines/:lineId/purchase-form/replacement-draft', {
    preHandler: [authenticateCustomer, csrfCheck],
    schema: {
      tags: ['customer'], summary: 'Discard the incomplete replacement draft for one cart line',
      params: CustomerCartLineParamsSchema, body: cartReplacementDraftDeleteSchema,
      response: { 200: ApiSuccessSchemaOf(Type.Object({ deleted: Type.Literal(true) }, { additionalProperties: false })),
        401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const { lineId } = request.params as { lineId: string }
      const body = request.body as { expectedLineRevision: number; expectedDraftRevision: number; expectedReplacementDraftRevision: number }
      const customer = request.customer!
      await db.transaction().execute(async trx => {
        await lockCustomer(trx, customer, true)
        const line = await trx.selectFrom('customer_cart_items').selectAll()
          .where('customer_id', '=', customer.id).where('line_id', '=', lineId).forUpdate().executeTakeFirst()
        const relation = await trx.selectFrom('customer_cart_line_replacement_drafts').selectAll()
          .where('line_id', '=', lineId).where('customer_id', '=', customer.id).forUpdate().executeTakeFirst()
        if (!line || !relation || line.draft_id !== relation.source_draft_id) {
          throw new CartError(404, 'CART_REPLACEMENT_NOT_FOUND', '找不到可撤销的资料编辑。')
        }
        if (line.revision !== body.expectedLineRevision || line.draft_revision !== body.expectedDraftRevision
          || relation.source_line_revision !== line.revision || relation.source_draft_revision !== line.draft_revision) {
          throw new CartError(409, 'CART_REPLACEMENT_CONFLICT', '购物车购买行已变化，请刷新后再撤销编辑。')
        }
        const target = await trx.selectFrom('purchase_drafts').select(['id', 'revision', 'status'])
          .where('id', '=', relation.replacement_draft_id).forUpdate().executeTakeFirst()
        if (!target || target.status !== 'active' || target.revision !== body.expectedReplacementDraftRevision) {
          throw new CartError(409, 'PURCHASE_DRAFT_REVISION_CONFLICT', '编辑资料已变化，请刷新后再撤销。')
        }
        await trx.deleteFrom('customer_cart_line_replacement_drafts').where('line_id', '=', lineId).execute()
        await trx.updateTable('purchase_drafts').set({ status: 'deleting' }).where('id', '=', target.id).execute()
        await trx.deleteFrom('purchase_draft_attachment_references').where('draft_id', '=', target.id).execute()
        await trx.updateTable('purchase_draft_attachments').set({ status: 'deleting', updated_at: new Date() })
          .where('draft_id', '=', target.id).where('status', 'in', ['uploading', 'ready', 'failed']).execute()
      })
      reply.header('cache-control', 'no-store')
      return success({ deleted: true }, request.id)
    } catch (error) { return mapError(error, reply, request.id) }
  })

  app.patch('/api/v1/customer/cart/lines/:lineId/purchase-form', {
    preHandler: [authenticateCustomer, csrfCheck],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Atomically edit a bound draft and its cart line',
      params: CustomerCartLineParamsSchema, body: CustomerCartLinePurchaseFormBodySchema,
      response: { 200: ApiSuccessSchemaOf(CustomerCartMutationSchema), 400: ApiErrorSchema,
        401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 422: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const preparedCopies: PreparedCartReplacementAttachmentCopy[] = []
    let finalTransactionStarted = false
    let finalCallbackCompleted = false
    try {
      const { lineId } = request.params as { lineId: string }
      const body = request.body as {
        expectedLineRevision: number
        expectedDraftRevision: number | null
        draftRevision?: number
        values?: Record<string, unknown>
        replacements?: Array<{ oldAttachmentId: string; newAttachmentId: string }>
        replacementDraft?: { draftId: string; draftRevision: number }
      }
      const customer = request.customer!
      if (body.replacementDraft && body.values) {
        if (body.expectedDraftRevision === null) {
          throw new CartError(409, 'CART_REPLACEMENT_CONFLICT', '原购物车资料已变化，请刷新后继续编辑。')
        }
        await prepareCartReplacementAttachmentCopies(db, { kind: 'customer', customer },
          purchaseAttachmentStorage, preparedCopies, {
            lineId, replacementDraftId: body.replacementDraft.draftId,
            replacementDraftRevision: body.replacementDraft.draftRevision,
            sourceLineRevision: body.expectedLineRevision,
            sourceDraftRevision: body.expectedDraftRevision,
            values: body.values,
          })
      }
      const mutateCart = async (trx: Transaction<Database>) => {
        await lockCustomer(trx, customer, true)
        const line = await trx.selectFrom('customer_cart_items').selectAll()
          .where('customer_id', '=', customer.id).where('line_id', '=', lineId)
          .forUpdate().executeTakeFirst()
        if (!line) throw new CartError(404, 'CART_ITEM_NOT_FOUND', '购物车中没有可编辑的填写购买行。')
        if (line.revision !== body.expectedLineRevision || line.draft_revision !== body.expectedDraftRevision) {
          throw new CartError(409, 'CART_LINE_REVISION_CONFLICT', '购买行或填写资料已变化，请刷新后再编辑。')
        }
        const effective = await effectivePurchaseFormForSku(trx, line.sku_id, { lockStatus: 'share' })
        await lockExistingSkus(trx, [line.sku_id])
        if (body.replacementDraft) {
          if (body.values) {
            if (!line.draft_id || body.expectedDraftRevision === null || !line.template_version_id
              || body.expectedDraftRevision !== line.draft_revision) {
              throw new CartError(409, 'CART_REPLACEMENT_CONFLICT', '原购物车资料已变化，请刷新后继续编辑。')
            }
            if (effective.templateVersionId !== line.template_version_id) {
              throw new CartError(409, 'PURCHASE_FORM_VERSION_CHANGED', '填写模板已变化，原购物车资料仍保留。')
            }
            const transferred = await transferCartReplacementAttachmentsInTransaction(trx, { kind: 'customer', customer },
              preparedCopies, {
              lineId, sourceDraftId: line.draft_id, sourceDraftRevision: body.expectedDraftRevision,
              replacementDraftId: body.replacementDraft.draftId,
              replacementDraftRevision: body.replacementDraft.draftRevision,
              sourceLineRevision: body.expectedLineRevision, values: body.values,
            })
            const saved = await savePurchaseDraftInTransaction(trx, config, { kind: 'customer', customer }, {
              draftId: body.replacementDraft.draftId,
              expectedRevision: body.replacementDraft.draftRevision,
              values: transferred.values,
            }, { expectedTemplateVersionId: effective.templateVersionId })
            if (!saved.complete) {
              throw new CartError(422, 'PURCHASE_FORM_INCOMPLETE', '资料尚未完整；购物车仍保留上次有效资料，已保存的编辑草稿可继续填写。')
            }
            const contentIdentity = purchaseLineContentIdentity(line.sku_id, line.template_version_id,
              line.normalization_version, saved.normalizedValues)
            const collision = await trx.selectFrom('customer_cart_items').select([
              'line_id', 'quantity', 'revision', 'draft_id', 'draft_revision', 'template_version_id', 'content_identity',
            ])
              .where('customer_id', '=', customer.id).where('sku_id', '=', line.sku_id)
              .where('content_identity', '=', contentIdentity).where('line_id', '!=', lineId)
              .forUpdate().executeTakeFirst()
            if (collision) {
              if (collision.quantity + line.quantity > maxLineQuantity) {
                throw new CartError(409, 'CART_QUANTITY_LIMIT', `同一 SKU 的购物车数量不能超过 ${maxLineQuantity}。`)
              }
              await trx.deleteFrom('customer_cart_items').where('line_id', '=', lineId).execute()
              const merged = await trx.updateTable('customer_cart_items').set({ quantity: collision.quantity + line.quantity })
                .where('line_id', '=', collision.line_id).returning('revision').executeTakeFirstOrThrow()
              await reconcileReplacementAfterCartLineUpdate(trx,
                { ...collision, customer_id: customer.id }, { ...collision, customer_id: customer.id, revision: merged.revision })
              await trx.deleteFrom('customer_cart_line_replacement_drafts').where('line_id', '=', lineId).execute()
              await trx.updateTable('purchase_drafts').set({ status: 'deleting' }).where('id', '=', line.draft_id).execute()
              await trx.updateTable('purchase_drafts').set({ status: 'deleting' })
                .where('id', '=', body.replacementDraft.draftId).execute()
              await trx.deleteFrom('purchase_draft_attachment_references')
                .where('draft_id', '=', body.replacementDraft.draftId).execute()
              await trx.updateTable('purchase_draft_attachments').set({ status: 'deleting', updated_at: new Date() })
                .where('draft_id', '=', body.replacementDraft.draftId).where('status', 'in', ['ready', 'failed']).execute()
              return collision.line_id
            }
            await trx.updateTable('customer_cart_items').set({
              draft_id: saved.id, draft_revision: saved.revision,
              template_version_id: line.template_version_id,
              normalization_version: line.normalization_version,
              content_identity: contentIdentity,
            }).where('line_id', '=', lineId).execute()
            await trx.deleteFrom('customer_cart_line_replacement_drafts').where('line_id', '=', lineId).execute()
            await trx.updateTable('purchase_drafts').set({ status: 'deleting' }).where('id', '=', line.draft_id).execute()
            return lineId
          }
          const duplicate = await trx.selectFrom('customer_cart_items').select('line_id')
            .where('customer_id', '=', customer.id).where('draft_id', '=', body.replacementDraft.draftId)
            .where('line_id', '!=', lineId).forUpdate().executeTakeFirst()
          if (duplicate) throw new CartError(409, 'PURCHASE_DRAFT_ALREADY_BOUND', '这份新填写资料已绑定其他购买行。')
          const [resolved] = await resolvePurchaseLinesInTransaction(trx, config, { kind: 'customer', customer }, [{
            lineId, skuId: line.sku_id, quantity: line.quantity,
            draftId: body.replacementDraft.draftId, draftRevision: body.replacementDraft.draftRevision,
          }], 'update')
          if (!resolved?.validatedDraft) throw new CartError(409, 'PURCHASE_FORM_REQUIRED', '请先完成当前 SKU 的填写资料。')
          const collision = await trx.selectFrom('customer_cart_items').select([
            'line_id', 'quantity', 'revision', 'draft_id', 'draft_revision', 'template_version_id', 'content_identity',
          ])
            .where('customer_id', '=', customer.id).where('sku_id', '=', line.sku_id)
            .where('content_identity', '=', resolved.contentIdentity).where('line_id', '!=', lineId)
            .forUpdate().executeTakeFirst()
          if (collision) {
            if (collision.quantity + line.quantity > maxLineQuantity) {
              throw new CartError(409, 'CART_QUANTITY_LIMIT', `同一 SKU 的购物车数量不能超过 ${maxLineQuantity}。`)
            }
            await discardPendingLineReplacements(trx, [lineId])
            await trx.deleteFrom('customer_cart_items').where('line_id', '=', lineId).execute()
            const merged = await trx.updateTable('customer_cart_items').set({ quantity: collision.quantity + line.quantity })
              .where('line_id', '=', collision.line_id).returning('revision').executeTakeFirstOrThrow()
            await reconcileReplacementAfterCartLineUpdate(trx,
              { ...collision, customer_id: customer.id }, { ...collision, customer_id: customer.id, revision: merged.revision })
            return collision.line_id
          }
          const updated = await trx.updateTable('customer_cart_items').set({
            draft_id: resolved.draftId, draft_revision: resolved.draftRevision,
            template_version_id: resolved.templateVersionId,
            normalization_version: resolved.normalizationVersion,
            content_identity: resolved.contentIdentity,
          }).where('line_id', '=', lineId).returning('revision').executeTakeFirstOrThrow()
          await reconcileReplacementAfterCartLineUpdate(trx, line, {
            ...line, revision: updated.revision, draft_id: resolved.draftId,
            draft_revision: resolved.draftRevision, template_version_id: resolved.templateVersionId,
            content_identity: resolved.contentIdentity,
          })
          return lineId
        }
        if (!line.draft_id || !body.values || body.expectedDraftRevision === null || !body.draftRevision) {
          throw new CartError(400, 'PURCHASE_DRAFT_INVALID', '请提供已保存的填写内容或新的草稿引用。')
        }
        const saved = await savePurchaseDraftInTransaction(trx, config, { kind: 'customer', customer }, {
          draftId: line.draft_id, expectedRevision: body.draftRevision, values: body.values,
        }, { coordinatedCartEdit: true, ...(effective.templateVersionId ? { expectedTemplateVersionId: effective.templateVersionId } : {}),
          ...(body.replacements ? { replacements: body.replacements } : {}) })
        if (!saved.complete) {
          // A cart binding and its draft must remain a valid pair at every
          // committed transaction boundary. Roll back this partial edit while
          // the customer continues editing locally, then atomically replace
          // the binding once the draft is complete.
          throw new CartError(422, 'PURCHASE_FORM_INCOMPLETE', '资料尚未完整；购物车仍保留上次已确认的购买资料，请补齐必填项后再保存。')
        }
        const prepared = effective.templateVersionId
        if (prepared !== line.template_version_id) {
          throw new CartError(409, 'PURCHASE_FORM_VERSION_CHANGED', '商品填写模板绑定已变化，请重新确认购买资料。')
        }
        const contentIdentity = purchaseLineContentIdentity(line.sku_id, line.template_version_id,
          line.normalization_version, saved.normalizedValues)
        const collision = await trx.selectFrom('customer_cart_items').select([
          'line_id', 'quantity', 'revision', 'draft_id', 'draft_revision', 'template_version_id', 'content_identity',
        ])
          .where('customer_id', '=', customer.id).where('sku_id', '=', line.sku_id)
          .where('content_identity', '=', contentIdentity).where('line_id', '!=', lineId)
          .forUpdate().executeTakeFirst()
        if (collision) {
          if (collision.quantity + line.quantity > maxLineQuantity) {
            throw new CartError(409, 'CART_QUANTITY_LIMIT', `同一 SKU 的购物车数量不能超过 ${maxLineQuantity}。`)
          }
          await discardPendingLineReplacements(trx, [lineId])
          await trx.deleteFrom('customer_cart_items').where('line_id', '=', lineId).execute()
          const merged = await trx.updateTable('customer_cart_items').set({ quantity: collision.quantity + line.quantity })
            .where('line_id', '=', collision.line_id).returning('revision').executeTakeFirstOrThrow()
          await reconcileReplacementAfterCartLineUpdate(trx,
            { ...collision, customer_id: customer.id }, { ...collision, customer_id: customer.id, revision: merged.revision })
          return collision.line_id
        }
        const updated = await trx.updateTable('customer_cart_items').set({
          draft_revision: saved.revision, content_identity: contentIdentity,
        }).where('line_id', '=', lineId).returning('revision').executeTakeFirstOrThrow()
        await reconcileReplacementAfterCartLineUpdate(trx, line, {
          ...line, revision: updated.revision, draft_revision: saved.revision, content_identity: contentIdentity,
        })
        return lineId
      }
      finalTransactionStarted = true
      const retainedLineId = await db.transaction().execute(async trx => {
        const retained = await mutateCart(trx)
        finalCallbackCompleted = true
        return retained
      })
      const cart = await authenticatedCartSnapshot(db, request.customer!, config)
      reply.header('cache-control', 'no-store')
      return success({ changed: true, merged: false, skippedSkuIds: [], retainedLineId, cart } satisfies CustomerCartMutation, request.id)
    } catch (error) {
      // Once the callback returned, COMMIT may still be running on PostgreSQL.
      // A separate connection seeing no row cannot prove rollback. Leave such
      // objects to the grace-period reconciler and its in-flight object fence.
      if (preparedCopies.length && (!finalTransactionStarted || !finalCallbackCompleted)) await releaseUncommittedReplacementCopies(
        db, purchaseAttachmentStorage, request.customer!, preparedCopies,
      )
      return mapError(error, reply, request.id)
    }
  })

  app.delete('/api/v1/customer/cart/lines/:lineId', {
    preHandler: [authenticateCustomer, csrfCheck],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Remove one stable cart line', params: CustomerCartLineParamsSchema,
      response: { 200: ApiSuccessSchemaOf(CustomerCartMutationSchema), 401: ApiErrorSchema,
        403: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    try {
      const { lineId } = request.params as { lineId: string }
      const changed = await db.transaction().execute(async (trx) => {
        const customer = request.customer!
        await lockCustomer(trx, customer, true)
        const line = await trx.selectFrom('customer_cart_items').select('line_id')
          .where('customer_id', '=', customer.id).where('line_id', '=', lineId).forUpdate().executeTakeFirst()
        if (line) await discardPendingLineReplacements(trx, [line.line_id])
        const result = await trx.deleteFrom('customer_cart_items')
          .where('customer_id', '=', customer.id).where('line_id', '=', lineId).executeTakeFirst()
        return result.numDeletedRows > 0n
      })
      const cart = await authenticatedCartSnapshot(db, request.customer!, config)
      reply.header('cache-control', 'no-store')
      return success({ changed, merged: false, skippedSkuIds: [], retainedLineId: null, cart } satisfies CustomerCartMutation, request.id)
    } catch (error) { return mapError(error, reply, request.id) }
  })

  app.post('/api/v1/customer/cart/merge', {
    preHandler: [authenticateCustomer, csrfCheck],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Idempotently merge guest cart items into the signed-in customer cart',
      body: CustomerCartMergeBodySchema,
      response: {
        200: ApiSuccessSchemaOf(CustomerCartMutationSchema), 400: ApiErrorSchema,
        401: ApiErrorSchema, 403: ApiErrorSchema, 409: ApiErrorSchema, 429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body as CustomerCartMergeBody
      const v2 = 'version' in body && body.version === 2
      const legacyItems = v2 ? null : normalizeCheckoutItems(body.items as CartSkuQuantity[])
      const lineItems = v2 ? normalizePurchaseLineRequests(body.items) : null
      const digest = v2 ? purchaseLineRequestHash(body.items) : mergeDigest(legacyItems!)
      const result = await db.transaction().execute(async (trx) => {
        const customer = request.customer!
        await lockCustomer(trx, customer, true)

        const previous = await trx.selectFrom('customer_cart_merge_requests')
          .select(['request_sha256', 'skipped_sku_ids'])
          .where('customer_id', '=', customer.id)
          .where('merge_id', '=', body.mergeId)
          .forUpdate()
          .executeTakeFirst()
        if (previous) {
          if (previous.request_sha256 !== digest) {
            throw new CartError(409, 'CART_MERGE_ID_REUSED', '购物车合并请求标识已用于不同内容，请刷新后重试。')
          }
          return { changed: false, skippedSkuIds: previous.skipped_sku_ids }
        }
        await readPurchaseFormsStatus(trx, 'share')
        if (v2 && lineItems!.some(item => item.draftId)) {
          const guestToken = request.cookies[guestSessionCookie]
          if (!guestToken || !/^[A-Za-z0-9_-]{43}$/u.test(guestToken)) {
            throw new CartError(401, 'GUEST_SESSION_REQUIRED', '原游客会话已不可用，请重新登录后处理此批次。')
          }
          const source = await trx.selectFrom('guest_order_sessions').select('id')
            .where('token_hash', '=', hashToken(guestToken)).where('revoked_at', 'is', null)
            .where('expires_at', '>', new Date()).forUpdate().executeTakeFirst()
          if (!source) throw new CartError(401, 'GUEST_SESSION_REQUIRED', '原游客会话已过期。')
        }
        const incoming = v2 ? lineItems! : legacyItems!
        const existingSkuIds = await lockExistingSkus(trx, incoming.map(item => item.skuId))
        const skippedSkuIds = [...new Set(incoming.filter(item => !existingSkuIds.has(item.skuId))
          .map(item => item.skuId))].sort()
        const accepted = incoming.filter(item => existingSkuIds.has(item.skuId))
        if (v2) {
          const acceptedV2 = lineItems!.filter(item => existingSkuIds.has(item.skuId))
          const drafted = acceptedV2.filter(item => item.draftId)
          let claimedRevisions: Record<string, number> = {}
          if (drafted.length) {
            const guestToken = request.cookies[guestSessionCookie]
            if (!guestToken) throw new CartError(401, 'GUEST_SESSION_REQUIRED', '原游客会话已不可用，请重新登录后处理此批次。')
            const claimed = await claimGuestPurchaseDraftsInTransaction(trx, customer, guestToken,
              drafted.map(item => ({ draftId: item.draftId!, expectedRevision: item.draftRevision! })))
            claimedRevisions = claimed.revisions
          }
          for (const item of acceptedV2) {
            if (!item.draftId) {
              await addCartLineInTransaction(trx, customer.id, {
                skuId: item.skuId, quantity: item.quantity,
                contentIdentity: purchaseLineContentIdentity(item.skuId, null, null, null),
                draftId: null, draftRevision: null, templateVersionId: null, normalizationVersion: null,
              })
              continue
            }
            const claimedRevision = claimedRevisions[item.draftId]
            if (!claimedRevision) throw new CartError(409, 'PURCHASE_DRAFT_REVISION_CONFLICT', '原游客填写资料已变化，请重新确认。')
            const draft = await validatePurchaseDraftForPurchaseInTransaction(trx, config,
              { kind: 'customer', customer }, { draftId: item.draftId, expectedRevision: claimedRevision })
            if (draft.revision !== claimedRevision) {
              throw new CartError(409, 'PURCHASE_DRAFT_REVISION_CONFLICT', '原游客填写资料已变化，请重新确认。')
            }
            const prepared = await preparedPurchaseFormVersion(trx, item.skuId)
            if (prepared !== draft.templateVersionId) {
              throw new CartError(409, 'PURCHASE_FORM_VERSION_CHANGED', '商品填写模板绑定已变化，请重新确认购买资料。')
            }
            await addCartLineInTransaction(trx, customer.id, {
              skuId: item.skuId, quantity: item.quantity,
              contentIdentity: purchaseLineContentIdentity(item.skuId, draft.templateVersionId,
                draft.normalizationVersion, draft.normalizedValues),
              draftId: draft.id, draftRevision: draft.revision,
              templateVersionId: draft.templateVersionId, normalizationVersion: draft.normalizationVersion,
            })
          }
        } else {
          for (const item of accepted) {
            await addCartLineInTransaction(trx, customer.id, {
              skuId: item.skuId, quantity: item.quantity,
              contentIdentity: purchaseLineContentIdentity(item.skuId, null, null, null),
              draftId: null, draftRevision: null, templateVersionId: null, normalizationVersion: null,
            })
          }
        }
        await trx.insertInto('customer_cart_merge_requests').values({
          customer_id: customer.id, merge_id: body.mergeId, request_sha256: digest,
          skipped_sku_ids: skippedSkuIds,
        }).execute()
        return { changed: accepted.length > 0, skippedSkuIds }
      })
      const cart = await authenticatedCartSnapshot(db, request.customer!, config)
      reply.header('cache-control', 'no-store')
      return success({ ...result, cart, merged: true, retainedLineId: null } satisfies CustomerCartMutation, request.id)
    } catch (error) {
      return mapError(error, reply, request.id)
    }
  })

  app.post('/api/v1/checkout/quote', {
    preHandler: [authenticateOptionalCustomer, csrfCheck],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['customer'], summary: 'Calculate a fresh multi-SKU checkout quote without creating an order',
      body: CheckoutQuoteBodySchema,
      response: {
        200: ApiSuccessSchemaOf(CheckoutQuoteSchema), 400: ApiErrorSchema,
        401: ApiErrorSchema, 403: ApiErrorSchema, 429: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body as CheckoutQuoteBody
      const quote = await db.transaction().execute(async (trx) => {
        // The draft validator takes the customer UPDATE lock. Acquire it first
        // for v2 so concurrent quotes never upgrade two SHARE locks in reverse.
        if (request.customer) await lockCustomer(trx, request.customer,
          'version' in body && body.version === 2)
        if (!request.customer && 'version' in body && body.version === 2
          && body.items.some(item => 'draftId' in item && item.draftId)) {
          await assertGuestSession(trx, request.cookies[guestSessionCookie], true)
        }
        if ('version' in body && body.version === 2) {
          const owner = request.customer
            ? { kind: 'customer' as const, customer: request.customer }
            : { kind: 'guest' as const, guestSessionToken: request.cookies[guestSessionCookie] ?? '' }
          return (await quoteCheckoutPurchaseLines(trx, body.items, owner, config)).quote
        }
        return quoteCheckoutItems(trx, body.items, request.customer?.id ?? null, config)
      })
      reply.header('cache-control', 'no-store')
      return success(quote, request.id)
    } catch (error) {
      return mapError(error, reply, request.id)
    }
  })
}
