import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  CheckoutQuoteBodySchema,
  CheckoutQuoteSchema,
  CustomerCartAddBodySchema,
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
  CustomerCart,
  CustomerCartMergeBody,
  CustomerCartMutation,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { optionalCustomer, requireCustomer, type AuthenticatedCustomer, CUSTOMER_CSRF_COOKIE } from '../auth/customer.js'
import { verifyDoubleSubmitCsrf } from '../auth/security.js'
import { quoteCheckoutItems, normalizeCheckoutItems, CheckoutQuoteError } from './checkout-quote.js'

const maxCartLines = 50
const maxLineQuantity = 99

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
  const saved = await db.selectFrom('customer_cart_items')
    .select(['sku_id', 'quantity'])
    .where('customer_id', '=', customerId)
    .orderBy('updated_at', 'desc')
    .orderBy('sku_id')
    .execute()
  if (!saved.length) return emptyCart()

  const quote = await quoteCheckoutItems(db, saved.map(row => ({ skuId: row.sku_id, quantity: row.quantity })), customerId, config)
  return {
    items: quote.items,
    itemCount: saved.length,
    totalQuantity: saved.reduce((total, row) => total + row.quantity, 0),
    pricedSubtotal: quote.pricedSubtotal,
    totalAmount: quote.totalAmount,
    totalComplete: quote.totalComplete,
    canContinue: quote.canContinue,
    policyReasons: quote.policyReasons,
    quotedAt: quote.quotedAt,
    currency: quote.currency,
  }
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

function mapError(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof CartError || error instanceof CheckoutQuoteError) {
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
      const body = request.body as CartSkuQuantity
      const cart = await db.transaction().execute(async (trx) => {
        const customer = request.customer!
        await lockCustomer(trx, customer, true)
        const found = await lockExistingSkus(trx, [body.skuId])
        if (!found.has(body.skuId)) throw new CartError(404, 'SKU_NOT_FOUND', '所选商品规格已不存在。')

        const current = await trx.selectFrom('customer_cart_items')
          .select(['quantity'])
          .where('customer_id', '=', customer.id)
          .where('sku_id', '=', body.skuId)
          .executeTakeFirst()
        const nextQuantity = (current?.quantity ?? 0) + body.quantity
        if (nextQuantity > maxLineQuantity) {
          throw new CartError(409, 'CART_QUANTITY_LIMIT', `同一 SKU 的购物车数量不能超过 ${maxLineQuantity}。`)
        }
        if (!current) {
          const lineCount = await trx.selectFrom('customer_cart_items')
            .select(eb => eb.fn.countAll<number>().as('total'))
            .where('customer_id', '=', customer.id)
            .executeTakeFirstOrThrow()
          if (lineCount.total >= maxCartLines) {
            throw new CartError(409, 'CART_ITEM_LIMIT', `购物车最多包含 ${maxCartLines} 个 SKU。`)
          }
        }

        await trx.insertInto('customer_cart_items').values({
          customer_id: customer.id,
          sku_id: body.skuId,
          quantity: nextQuantity,
          updated_at: new Date(),
        }).onConflict(oc => oc.columns(['customer_id', 'sku_id']).doUpdateSet({
          quantity: nextQuantity,
          updated_at: new Date(),
        })).execute()
        return cartSnapshot(trx, customer.id, config)
      })
      reply.header('cache-control', 'no-store')
      const result: CustomerCartMutation = { changed: true, merged: false, skippedSkuIds: [], cart }
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
      const cart = await db.transaction().execute(async (trx) => {
        const customer = request.customer!
        await lockCustomer(trx, customer, true)
        const updated = await trx.updateTable('customer_cart_items')
          .set({ quantity, updated_at: new Date() })
          .where('customer_id', '=', customer.id)
          .where('sku_id', '=', skuId)
          .returning('sku_id')
          .executeTakeFirst()
        if (!updated) throw new CartError(404, 'CART_ITEM_NOT_FOUND', '购物车中没有该商品规格。')
        return cartSnapshot(trx, customer.id, config)
      })
      reply.header('cache-control', 'no-store')
      return success({ changed: true, merged: false, skippedSkuIds: [], cart } satisfies CustomerCartMutation, request.id)
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
      const cart = await db.transaction().execute(async (trx) => {
        const customer = request.customer!
        await lockCustomer(trx, customer, true)
        const deleted = await trx.deleteFrom('customer_cart_items')
          .where('customer_id', '=', customer.id)
          .where('sku_id', '=', skuId)
          .executeTakeFirst()
        return { cart: await cartSnapshot(trx, customer.id, config), changed: deleted.numDeletedRows > 0n }
      })
      reply.header('cache-control', 'no-store')
      return success({ ...cart, merged: false, skippedSkuIds: [] } satisfies CustomerCartMutation, request.id)
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
        const deleted = await trx.deleteFrom('customer_cart_items')
          .where('customer_id', '=', customer.id).executeTakeFirst()
        return { changed: deleted.numDeletedRows > 0n, cart: await cartSnapshot(trx, customer.id, config) }
      })
      reply.header('cache-control', 'no-store')
      return success({ ...result, merged: false, skippedSkuIds: [] } satisfies CustomerCartMutation, request.id)
    } catch (error) {
      return mapError(error, reply, request.id)
    }
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
      const normalized = normalizeCheckoutItems(body.items)
      const digest = mergeDigest(normalized)
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
          return {
            changed: false,
            skippedSkuIds: previous.skipped_sku_ids,
            cart: await cartSnapshot(trx, customer.id, config),
          }
        }

        await trx.insertInto('customer_cart_merge_requests').values({
          customer_id: customer.id,
          merge_id: body.mergeId,
          request_sha256: digest,
          skipped_sku_ids: [],
        }).execute()

        const existingSkuIds = await lockExistingSkus(trx, normalized.map(item => item.skuId))
        const skippedSkuIds = normalized.filter(item => !existingSkuIds.has(item.skuId)).map(item => item.skuId)
        const accepted = normalized.filter(item => existingSkuIds.has(item.skuId))
        const currentRows = await trx.selectFrom('customer_cart_items')
          .select(['sku_id', 'quantity'])
          .where('customer_id', '=', customer.id)
          .execute()
        const current = new Map(currentRows.map(row => [row.sku_id, row.quantity]))
        const newLineCount = accepted.filter(item => !current.has(item.skuId)).length
        if (current.size + newLineCount > maxCartLines) {
          throw new CartError(409, 'CART_ITEM_LIMIT', `购物车最多包含 ${maxCartLines} 个 SKU，请先移除部分商品。`)
        }

        for (const item of accepted) {
          const quantity = (current.get(item.skuId) ?? 0) + item.quantity
          if (quantity > maxLineQuantity) {
            throw new CartError(409, 'CART_QUANTITY_LIMIT', `同一 SKU 的购物车数量不能超过 ${maxLineQuantity}，请先调整数量。`)
          }
          await trx.insertInto('customer_cart_items').values({
            customer_id: customer.id,
            sku_id: item.skuId,
            quantity,
            updated_at: new Date(),
          }).onConflict(oc => oc.columns(['customer_id', 'sku_id']).doUpdateSet({
            quantity,
            updated_at: new Date(),
          })).execute()
          current.set(item.skuId, quantity)
        }
        await trx.updateTable('customer_cart_merge_requests')
          .set({ skipped_sku_ids: skippedSkuIds })
          .where('customer_id', '=', customer.id)
          .where('merge_id', '=', body.mergeId)
          .execute()
        return { changed: accepted.length > 0, skippedSkuIds, cart: await cartSnapshot(trx, customer.id, config) }
      })

      reply.header('cache-control', 'no-store')
      return success({ ...result, merged: true } satisfies CustomerCartMutation, request.id)
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
      const items = (request.body as { items: CartSkuQuantity[] }).items
      const quote = await db.transaction().execute(async (trx) => {
        if (request.customer) await lockCustomer(trx, request.customer, false)
        return quoteCheckoutItems(trx, items, request.customer?.id ?? null, config)
      })
      reply.header('cache-control', 'no-store')
      return success(quote, request.id)
    } catch (error) {
      return mapError(error, reply, request.id)
    }
  })
}
