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
  combination_valid: boolean | null
  options: CheckoutQuoteItem['options']
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
  if (row.product_type !== 'digital' || row.fulfillment_method !== 'manual' || !row.manual_delivery_ready) {
    return 'fulfillment_not_ready'
  }
  return null
}

/**
 * The shared storefront quote and order eligibility calculation. Order creation
 * calls this inside its transaction after acquiring catalog and stock locks.
 */
export async function quoteCheckoutItems(
  db: Db,
  inputItems: CartSkuQuantity[],
  customerAuthenticated: boolean,
): Promise<CheckoutQuote> {
  const items = normalizeCheckoutItems(inputItems)
  if (items.length > maxCartLines) {
    throw new CheckoutQuoteError(400, 'CART_ITEM_LIMIT', `一次报价最多包含 ${maxCartLines} 个 SKU。`)
  }
  const skuIds = items.map(item => item.skuId)
  const quantities = items.map(item => item.quantity)
  const combinationValid = variantOptionCombinationValid('variant')
  const result = await sql<QuoteSkuRow>`
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

  if (result.rows.length !== items.length) throw new Error('The storefront customer policy row is missing')

  let subtotal = '0.00'
  const policyReasons = new Set<'guest_checkout_disabled' | 'guest_free_claim_disabled'>()
  const quoteLines: CheckoutQuoteItem[] = result.rows.map((row) => {
    const unitPrice = row.sale_price === null ? null : formatSalePrice(row.sale_price)
    const lineTotal = unitPrice === null
      ? null
      : settleAmount(multiplyUnitAmount(unitPrice, row.quantity))
    if (lineTotal !== null) subtotal = addSettlementAmounts(subtotal, lineTotal)

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
