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
  CheckoutQuote,
  CheckoutQuoteItem,
  CheckoutQuoteReason,
  CustomerCart,
  CustomerCartMergeBody,
  CustomerCartMutation,
} from '@aikayun/contracts'
import {
  addSettlementAmounts,
  multiplyUnitAmount,
  parseUnitAmount,
  settleAmount,
} from '@aikayun/money'
import type { AppConfig } from '../config.js'
import type { Database, ProductInventoryMode, ProductStatus } from '../db/types.js'
import { optionalCustomer, requireCustomer, type AuthenticatedCustomer, CUSTOMER_CSRF_COOKIE } from '../auth/customer.js'
import { verifyDoubleSubmitCsrf } from '../auth/security.js'
import { variantOptionCombinationValid } from '../catalog/public-products.js'

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

type QuoteSkuRow = {
  sku_id: string
  quantity: number
  product_id: string | null
  product_name: string | null
  product_status: ProductStatus | null
  sku_code: string | null
  sale_price: string | null
  sku_enabled: boolean | null
  retired_at: Date | null
  inventory_mode: ProductInventoryMode | null
  inventory_row_exists: boolean
  available_quantity: number | null
  fulfillment_method: string | null
  combination_valid: boolean | null
  options: CheckoutQuoteItem['options']
  guest_checkout_enabled: boolean
  guest_free_claim_enabled: boolean
}

function normalizeItems(items: CartSkuQuantity[]): CartSkuQuantity[] {
  const quantities = new Map<string, number>()
  for (const item of items) {
    const quantity = (quantities.get(item.skuId) ?? 0) + item.quantity
    if (quantity > maxLineQuantity) {
      throw new CartError(400, 'CART_QUANTITY_LIMIT', `同一 SKU 的数量不能超过 ${maxLineQuantity}。`)
    }
    quantities.set(item.skuId, quantity)
  }
  return [...quantities].sort(([left], [right]) => left.localeCompare(right))
    .map(([skuId, quantity]) => ({ skuId, quantity }))
}

function formatSalePrice(value: string): string {
  const amount = parseUnitAmount(value)
  if (amount.isNegative() || amount.decimalPlaces() > 2) {
    throw new Error('Stored product sale price violates the storefront amount contract')
  }
  return amount.toFixed(2)
}

function optionCombinationValidity(alias: string) {
  return variantOptionCombinationValid(alias)
}

function reasonForSku(row: QuoteSkuRow): CheckoutQuoteReason | null {
  if (!row.product_id || !row.product_status) return 'sku_not_found'
  if (row.product_status !== 'active') return 'product_not_active'
  if (row.retired_at) return 'sku_retired'
  if (!row.sku_enabled) return 'sku_disabled'
  if (!row.combination_valid) return 'specification_invalid'
  if (!row.inventory_mode) return 'inventory_not_configured'
  if (row.inventory_mode === 'resource_pool' || row.inventory_mode === 'external') return 'inventory_not_ready'
  if (row.inventory_mode === 'quantity') {
    if (!row.inventory_row_exists || row.available_quantity === null) return 'inventory_not_configured'
    if (row.available_quantity < row.quantity) return 'insufficient_inventory'
  }
  // A configured method name is only intent. This repository has no execution
  // path for manual, code-pool, fixed-content, link, file, or API delivery yet.
  if (row.fulfillment_method !== null) return 'fulfillment_not_ready'
  return 'fulfillment_not_ready'
}

async function quoteItems(
  db: Db,
  inputItems: CartSkuQuantity[],
  customerAuthenticated: boolean,
): Promise<CheckoutQuote> {
  const items = normalizeItems(inputItems)
  if (items.length > maxCartLines) {
    throw new CartError(400, 'CART_ITEM_LIMIT', `一次报价最多包含 ${maxCartLines} 个 SKU。`)
  }
  const skuIds = items.map(item => item.skuId)
  const quantities = items.map(item => item.quantity)
  const combinationValid = optionCombinationValidity('variant')
  const rows = await sql<QuoteSkuRow>`
    SELECT
      requested.sku_id,
      requested.quantity,
      variant.product_id,
      product.name AS product_name,
      product.status AS product_status,
      variant.sku_code,
      variant.sale_price::text AS sale_price,
      variant.enabled AS sku_enabled,
      variant.retired_at,
      variant.inventory_mode,
      (inventory.product_variant_id IS NOT NULL) AS inventory_row_exists,
      CASE WHEN variant.inventory_mode = 'quantity'
        THEN COALESCE(inventory.stocked - inventory.reserved, 0)::integer
        ELSE NULL
      END AS available_quantity,
      fulfillment.method AS fulfillment_method,
      ${combinationValid} AS combination_valid,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'groupId', option_group.id,
          'groupName', option_group.name,
          'valueId', option_value.id,
          'valueName', option_value.name
        ) ORDER BY option_group.sort_order, option_value.sort_order, option_group.id, option_value.id)
        FROM product_variant_option_values AS selected
        JOIN product_option_groups AS option_group
          ON option_group.product_id = selected.product_id AND option_group.id = selected.option_group_id
        JOIN product_option_values AS option_value
          ON option_value.product_id = selected.product_id
          AND option_value.option_group_id = selected.option_group_id
          AND option_value.id = selected.option_value_id
        WHERE selected.product_id = variant.product_id
          AND selected.product_variant_id = variant.id
      ), '[]'::jsonb) AS options,
      policy.guest_checkout_enabled,
      policy.guest_free_claim_enabled
    FROM unnest(${skuIds}::uuid[], ${quantities}::integer[]) AS requested(sku_id, quantity)
    LEFT JOIN product_variants AS variant ON variant.id = requested.sku_id
    LEFT JOIN products AS product ON product.id = variant.product_id
    LEFT JOIN product_variant_quantity_inventory AS inventory
      ON inventory.product_id = variant.product_id AND inventory.product_variant_id = variant.id
    LEFT JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
    CROSS JOIN storefront_customer_policy AS policy
    WHERE policy.singleton
    ORDER BY requested.sku_id
  `.execute(db)

  if (rows.rows.length !== items.length) throw new Error('The storefront customer policy row is missing')

  let subtotal = '0.00'
  const policyReasons = new Set<'guest_checkout_disabled' | 'guest_free_claim_disabled'>()
  const quoteLines: CheckoutQuoteItem[] = rows.rows.map((row) => {
    const unitPrice = row.sale_price === null ? null : formatSalePrice(row.sale_price)
    const lineTotal = unitPrice === null
      ? null
      : settleAmount(multiplyUnitAmount(unitPrice, row.quantity))
    if (lineTotal !== null) subtotal = addSettlementAmounts(subtotal, lineTotal)

    const item: CheckoutQuoteItem = {
      skuId: row.sku_id,
      productId: row.product_id,
      productName: row.product_name,
      productStatus: row.product_status,
      skuCode: row.sku_code,
      options: row.options ?? [],
      unitPrice,
      quantity: row.quantity,
      lineTotal,
      inventoryMode: row.inventory_mode,
      availableQuantity: row.available_quantity,
      identityValid: row.product_id !== null && row.product_status !== null,
      canPurchase: false,
      reason: null,
    }
    let reason = reasonForSku(row)
    if (!customerAuthenticated && unitPrice !== null) {
      if (unitPrice === '0.00' && !row.guest_free_claim_enabled) {
        policyReasons.add('guest_free_claim_disabled')
        reason ??= 'guest_free_claim_disabled'
      } else if (unitPrice !== '0.00' && !row.guest_checkout_enabled) {
        policyReasons.add('guest_checkout_disabled')
        reason ??= 'guest_checkout_disabled'
      }
    }
    item.reason = reason
    item.canPurchase = reason === null
    return item
  })

  const totalComplete = quoteLines.every(item => item.lineTotal !== null)
  const pricedSubtotal = subtotal
  const guestCheckoutEnabled = rows.rows[0]?.guest_checkout_enabled ?? false
  const guestFreeClaimEnabled = rows.rows[0]?.guest_free_claim_enabled ?? false
  return {
    quotedAt: new Date().toISOString(),
    currency: 'CNY',
    items: quoteLines,
    pricedSubtotal,
    totalAmount: totalComplete ? pricedSubtotal : null,
    totalComplete,
    canContinue: totalComplete && quoteLines.length > 0 && quoteLines.every(item => item.canPurchase),
    customerAuthenticated,
    guestCheckoutEnabled,
    guestFreeClaimEnabled,
    policyReasons: [...policyReasons].sort(),
  }
}

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

async function cartSnapshot(db: Db, customerId: string): Promise<CustomerCart> {
  const saved = await db.selectFrom('customer_cart_items')
    .select(['sku_id', 'quantity'])
    .where('customer_id', '=', customerId)
    .orderBy('updated_at', 'desc')
    .orderBy('sku_id')
    .execute()
  if (!saved.length) return emptyCart()

  const quote = await quoteItems(db, saved.map(row => ({ skuId: row.sku_id, quantity: row.quantity })), true)
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
  if (error instanceof CartError) {
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
        return cartSnapshot(trx, customer.id)
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
        return cartSnapshot(trx, customer.id)
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
        return cartSnapshot(trx, customer.id)
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
        return { cart: await cartSnapshot(trx, customer.id), changed: deleted.numDeletedRows > 0n }
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
        return { changed: deleted.numDeletedRows > 0n, cart: await cartSnapshot(trx, customer.id) }
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
      const normalized = normalizeItems(body.items)
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
            cart: await cartSnapshot(trx, customer.id),
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
        return { changed: accepted.length > 0, skippedSkuIds, cart: await cartSnapshot(trx, customer.id) }
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
        return quoteItems(trx, items, request.customer !== null)
      })
      reply.header('cache-control', 'no-store')
      return success(quote, request.id)
    } catch (error) {
      return mapError(error, reply, request.id)
    }
  })
}
