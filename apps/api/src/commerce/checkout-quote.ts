import { createHash } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  type CartSkuQuantity,
  type CheckoutQuote,
  type CheckoutQuoteItem,
  type CheckoutQuoteReason,
} from '@aikayun/contracts'
import {
  addSettlementAmounts,
  multiplyUnitAmount,
  parseUnitAmount,
  settleAmount,
} from '@aikayun/money'
import type { Database, ProductInventoryMode, ProductStatus, ProductType } from '../db/types.js'
import { variantOptionCombinationValid } from '../catalog/public-products.js'

const maxCartLines = 50
const maxLineQuantity = 99

export class CheckoutQuoteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'CheckoutQuoteError'
  }
}

type Db = Kysely<Database> | Transaction<Database>

type QuoteSkuRow = {
  sku_id: string
  quantity: number
  product_id: string | null
  product_name: string | null
  product_type: ProductType | null
  product_status: ProductStatus | null
  sku_code: string | null
  sale_price: string | null
  sku_enabled: boolean | null
  retired_at: Date | null
  inventory_mode: ProductInventoryMode | null
  inventory_row_exists: boolean
  available_quantity: number | null
  fulfillment_method: string | null
  manual_delivery_ready: boolean
  code_pool_delivery_ready: boolean
  code_pool_inventory_consistent: boolean
  combination_valid: boolean | null
  options: CheckoutQuoteItem['options']
  product_limit_per_order: number | null
  product_limit_lifetime: number | null
  product_limit_24h: number | null
  sku_limit_per_order: number | null
  sku_limit_lifetime: number | null
  sku_limit_24h: number | null
  product_lifetime_purchased: number | null
  product_24h_purchased: number | null
  sku_lifetime_purchased: number | null
  sku_24h_purchased: number | null
  guest_checkout_enabled: boolean
  guest_free_claim_enabled: boolean
}

export function normalizeCheckoutItems(items: CartSkuQuantity[]): CartSkuQuantity[] {
  const quantities = new Map<string, number>()
  for (const item of items) {
    const quantity = (quantities.get(item.skuId) ?? 0) + item.quantity
    if (quantity > maxLineQuantity) {
      throw new CheckoutQuoteError(400, 'CART_QUANTITY_LIMIT', `同一 SKU 的数量不能超过 ${maxLineQuantity}。`)
    }
    quantities.set(item.skuId, quantity)
  }
  return [...quantities].sort(([left], [right]) => left.localeCompare(right))
    .map(([skuId, quantity]) => ({ skuId, quantity }))
}

export function checkoutRequestHash(items: CartSkuQuantity[]): string {
  return createHash('sha256').update(JSON.stringify(normalizeCheckoutItems(items))).digest('hex')
}

function formatSalePrice(value: string): string {
  const amount = parseUnitAmount(value)
  if (amount.isNegative() || amount.decimalPlaces() > 2) {
    throw new Error('Stored product sale price violates the storefront amount contract')
  }
  return amount.toFixed(2)
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
  if (row.fulfillment_method === 'code_pool' && !row.code_pool_inventory_consistent) {
    return 'code_pool_inventory_inconsistent'
  }
  if (row.product_type !== 'digital'
    || (row.fulfillment_method === 'manual' && !row.manual_delivery_ready)
    || (row.fulfillment_method === 'code_pool'
      && (row.inventory_mode !== 'quantity' || !row.code_pool_delivery_ready))
    || (row.fulfillment_method !== 'manual' && row.fulfillment_method !== 'code_pool')) {
    return 'fulfillment_not_ready'
  }
  return null
}

function purchaseLimitStatus(options: {
  perOrderLimit: number | null
  lifetimeLimit: number | null
  rolling24HourLimit: number | null
  lifetimePurchased: number | null
  rolling24HoursPurchased: number | null
  requestedQuantity: number
  customerAuthenticated: boolean
}): CheckoutQuoteItem['purchaseLimits']['product'] {
  const available: number[] = []
  if (options.perOrderLimit !== null) available.push(options.perOrderLimit)
  if (options.customerAuthenticated && options.lifetimeLimit !== null) {
    available.push(Math.max(0, options.lifetimeLimit - (options.lifetimePurchased ?? 0)))
  }
  if (options.customerAuthenticated && options.rolling24HourLimit !== null) {
    available.push(Math.max(0, options.rolling24HourLimit - (options.rolling24HoursPurchased ?? 0)))
  }
  const maxAvailable = available.length ? Math.min(...available) : null
  return {
    perOrderLimit: options.perOrderLimit,
    lifetimeLimit: options.lifetimeLimit,
    rolling24HourLimit: options.rolling24HourLimit,
    lifetimePurchased: options.customerAuthenticated ? options.lifetimePurchased ?? 0 : null,
    rolling24HoursPurchased: options.customerAuthenticated ? options.rolling24HoursPurchased ?? 0 : null,
    maxAvailable,
    exceeded: maxAvailable !== null && options.requestedQuantity > maxAvailable,
  }
}

/**
 * The shared storefront quote and order eligibility calculation. Order creation
 * calls this inside its transaction after acquiring catalog and stock locks.
 */
export async function quoteCheckoutItems(
  db: Db,
  inputItems: CartSkuQuantity[],
  customerId: string | null,
): Promise<CheckoutQuote> {
  const customerAuthenticated = customerId !== null
  const items = normalizeCheckoutItems(inputItems)
  if (items.length > maxCartLines) {
    throw new CheckoutQuoteError(400, 'CART_ITEM_LIMIT', `一次报价最多包含 ${maxCartLines} 个 SKU。`)
  }
  const skuIds = items.map(item => item.skuId)
  const quantities = items.map(item => item.quantity)
  const combinationValid = variantOptionCombinationValid('variant')
  const customerPredicate = customerId
    ? sql`order_row.customer_id = ${customerId}::uuid`
    : sql`FALSE`
  const result = await sql<QuoteSkuRow>`
    WITH requested AS MATERIALIZED (
      SELECT request.sku_id, request.quantity
      FROM unnest(${skuIds}::uuid[], ${quantities}::integer[]) AS request(sku_id, quantity)
    ), eligible_purchase_orders AS MATERIALIZED (
      SELECT order_row.id, order_row.created_at
      FROM orders AS order_row
      WHERE ${customerPredicate} AND order_counts_as_purchase(order_row.id)
    ), target_products AS (
      SELECT DISTINCT variant.product_id
      FROM requested
      JOIN product_variants AS variant ON variant.id = requested.sku_id
    ), product_purchase_counts AS (
      SELECT item.product_id,
        LEAST(COALESCE(sum(item.quantity::numeric), 0), 2147483647)::integer AS lifetime_purchased,
        LEAST(COALESCE(sum(item.quantity::numeric) FILTER (
          WHERE prior_order.created_at > statement_timestamp() - interval '24 hours'
        ), 0), 2147483647)::integer AS recent_purchased
      FROM eligible_purchase_orders AS prior_order
      JOIN order_items AS item ON item.order_id = prior_order.id
      WHERE item.product_id IN (SELECT product_id FROM target_products)
      GROUP BY item.product_id
    ), sku_purchase_counts AS (
      SELECT item.product_variant_id,
        LEAST(COALESCE(sum(item.quantity::numeric), 0), 2147483647)::integer AS lifetime_purchased,
        LEAST(COALESCE(sum(item.quantity::numeric) FILTER (
          WHERE prior_order.created_at > statement_timestamp() - interval '24 hours'
        ), 0), 2147483647)::integer AS recent_purchased
      FROM eligible_purchase_orders AS prior_order
      JOIN order_items AS item ON item.order_id = prior_order.id
      WHERE item.product_variant_id = ANY(${skuIds}::uuid[])
      GROUP BY item.product_variant_id
    )
    SELECT
      requested.sku_id,
      requested.quantity,
      variant.product_id,
      product.name AS product_name,
      product.product_type,
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
      COALESCE(fulfillment.manual_delivery_ready, false) AS manual_delivery_ready,
      COALESCE(fulfillment.code_pool_delivery_ready, false) AS code_pool_delivery_ready,
      CASE WHEN fulfillment.method = 'code_pool'
        THEN assert_code_pool_inventory_consistency(variant.id)
        ELSE true
      END AS code_pool_inventory_consistent,
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
      product.purchase_limit_per_order AS product_limit_per_order,
      product.purchase_limit_lifetime AS product_limit_lifetime,
      product.purchase_limit_24h AS product_limit_24h,
      variant.purchase_limit_per_order AS sku_limit_per_order,
      variant.purchase_limit_lifetime AS sku_limit_lifetime,
      variant.purchase_limit_24h AS sku_limit_24h,
      product_purchase_counts.lifetime_purchased AS product_lifetime_purchased,
      product_purchase_counts.recent_purchased AS product_24h_purchased,
      sku_purchase_counts.lifetime_purchased AS sku_lifetime_purchased,
      sku_purchase_counts.recent_purchased AS sku_24h_purchased,
      policy.guest_checkout_enabled,
      policy.guest_free_claim_enabled
    FROM requested
    LEFT JOIN product_variants AS variant ON variant.id = requested.sku_id
    LEFT JOIN products AS product ON product.id = variant.product_id
    LEFT JOIN product_variant_quantity_inventory AS inventory
      ON inventory.product_id = variant.product_id AND inventory.product_variant_id = variant.id
    LEFT JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
    LEFT JOIN product_purchase_counts ON product_purchase_counts.product_id = product.id
    LEFT JOIN sku_purchase_counts ON sku_purchase_counts.product_variant_id = variant.id
    CROSS JOIN storefront_customer_policy AS policy
    WHERE policy.singleton
    ORDER BY requested.sku_id
  `.execute(db)

  if (result.rows.length !== items.length) throw new Error('The storefront customer policy row is missing')

  let subtotal = '0.00'
  const requestedProductQuantities = new Map<string, number>()
  for (const row of result.rows) {
    if (row.product_id) {
      requestedProductQuantities.set(row.product_id,
        (requestedProductQuantities.get(row.product_id) ?? 0) + row.quantity)
    }
  }
  const policyReasons = new Set<'guest_checkout_disabled' | 'guest_free_claim_disabled'>()
  const quoteLines: CheckoutQuoteItem[] = result.rows.map((row) => {
    const unitPrice = row.sale_price === null ? null : formatSalePrice(row.sale_price)
    const lineTotal = unitPrice === null
      ? null
      : settleAmount(multiplyUnitAmount(unitPrice, row.quantity))
    if (lineTotal !== null) subtotal = addSettlementAmounts(subtotal, lineTotal)

    const productLimits = purchaseLimitStatus({
      perOrderLimit: row.product_limit_per_order,
      lifetimeLimit: row.product_limit_lifetime,
      rolling24HourLimit: row.product_limit_24h,
      lifetimePurchased: row.product_lifetime_purchased,
      rolling24HoursPurchased: row.product_24h_purchased,
      requestedQuantity: row.product_id ? requestedProductQuantities.get(row.product_id) ?? row.quantity : row.quantity,
      customerAuthenticated,
    })
    const skuLimits = purchaseLimitStatus({
      perOrderLimit: row.sku_limit_per_order,
      lifetimeLimit: row.sku_limit_lifetime,
      rolling24HourLimit: row.sku_limit_24h,
      lifetimePurchased: row.sku_lifetime_purchased,
      rolling24HoursPurchased: row.sku_24h_purchased,
      requestedQuantity: row.quantity,
      customerAuthenticated,
    })
    const requiresLogin = !customerAuthenticated && (
      row.product_limit_lifetime !== null || row.product_limit_24h !== null
      || row.sku_limit_lifetime !== null || row.sku_limit_24h !== null
    )
    const item: CheckoutQuoteItem = {
      skuId: row.sku_id,
      productId: row.product_id,
      productName: row.product_name,
      productType: row.product_type,
      productStatus: row.product_status,
      skuCode: row.sku_code,
      options: row.options ?? [],
      unitPrice,
      quantity: row.quantity,
      lineTotal,
      inventoryMode: row.inventory_mode,
      fulfillmentMethod: row.fulfillment_method,
      availableQuantity: row.available_quantity,
      identityValid: row.product_id !== null && row.product_status !== null,
      purchaseLimits: {
        product: productLimits,
        sku: skuLimits,
        requiresLogin,
      },
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
    if (requiresLogin) reason ??= 'login_required_for_purchase_limit'
    else if (productLimits.exceeded || skuLimits.exceeded) reason ??= 'purchase_limit_exceeded'
    item.reason = reason
    item.canPurchase = reason === null
    return item
  })

  const totalComplete = quoteLines.every(item => item.lineTotal !== null)
  const guestCheckoutEnabled = result.rows[0]?.guest_checkout_enabled ?? false
  const guestFreeClaimEnabled = result.rows[0]?.guest_free_claim_enabled ?? false
  const stableQuote = {
    currency: 'CNY' as const,
    items: quoteLines,
    pricedSubtotal: subtotal,
    totalAmount: totalComplete ? subtotal : null,
    totalComplete,
    canContinue: totalComplete && quoteLines.length > 0 && quoteLines.every(item => item.canPurchase),
    customerAuthenticated,
    guestCheckoutEnabled,
    guestFreeClaimEnabled,
    policyReasons: [...policyReasons].sort(),
  }
  const quoteToken = createHash('sha256').update(JSON.stringify(stableQuote)).digest('hex')
  return {
    quotedAt: new Date().toISOString(),
    quoteToken,
    ...stableQuote,
  }
}
