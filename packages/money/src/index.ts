import { Decimal } from 'decimal.js'

const ExactDecimal = Decimal.clone({
  precision: 50,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -100,
  toExpPos: 100,
})

const unitAmountPattern = /^-?(?:0|[1-9]\d{0,12})(?:\.\d{1,5})?$/
// A unit value (NUMERIC(18,5)) multiplied by a safe integer can have up to
// 29 integer digits. Keep intermediate operations within that derived bound.
const intermediateAmountPattern = /^-?(?:0|[1-9]\d{0,28})(?:\.\d{1,5})?$/
const maxSettledIntegerDigits = 16
const walletAmountPattern = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/
const percentagePattern = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/
const pricingMarkupPattern = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/
const databaseUnitAmountMax = new ExactDecimal('9999999999999.99999')
const databaseSalePriceMax = new ExactDecimal('9999999999999.99')

function parseWalletAmount(value: string): Decimal {
  if (!walletAmountPattern.test(value)) {
    throw new TypeError('Wallet amounts must be non-negative decimal strings with up to 16 integer and 2 fractional digits')
  }
  return new ExactDecimal(value)
}

export function normalizeWalletAmount(value: string): string {
  return parseWalletAmount(value).toFixed(2)
}

/**
 * Parses a signed NUMERIC(18,5) amount for generic accounting arithmetic.
 * Product sale-price validation must separately reject negative values.
 */
export function parseUnitAmount(value: string): Decimal {
  if (!unitAmountPattern.test(value)) {
    throw new TypeError('Amount must be a decimal string with up to 13 integer and 5 fractional digits')
  }
  return new ExactDecimal(value)
}

function parseIntermediateAmount(value: string): Decimal {
  if (!intermediateAmountPattern.test(value)) {
    throw new TypeError('Intermediate amount must be a decimal string with up to 29 integer and 5 fractional digits')
  }
  return new ExactDecimal(value)
}

export function addUnitAmounts(left: string, right: string): string {
  const result = parseUnitAmount(left).plus(parseUnitAmount(right))
  const fixed = result.toFixed(5)
  parseIntermediateAmount(fixed)
  return fixed
}

export function multiplyUnitAmount(unitAmount: string, quantity: number): string {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new TypeError('Quantity must be a non-negative safe integer')
  }
  const quantityDecimal = new ExactDecimal(quantity.toString())
  const result = parseUnitAmount(unitAmount).times(quantityDecimal).toFixed(5)
  parseIntermediateAmount(result)
  return result
}

export function settleAmount(value: string): string {
  const rounded = parseIntermediateAmount(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  if (rounded.abs().gte(new ExactDecimal(10).pow(maxSettledIntegerDigits))) {
    throw new RangeError('Settlement amount exceeds NUMERIC(18,2)')
  }
  return rounded.toFixed(2)
}

export function normalizeWithdrawalPercent(value: string): string {
  if (!percentagePattern.test(value)) {
    throw new TypeError('Withdrawal percentage must be a non-negative decimal string with at most 4 fractional digits')
  }
  const percentage = new ExactDecimal(value)
  if (percentage.gt(100)) throw new RangeError('Withdrawal percentage may not exceed 100 percent')
  return percentage.toFixed(4)
}

/** Calculates a withdrawal fee as amount * percentage / 100 + fixed fee.
 * The calculation stays in Decimal until the final half-up cent settlement.
 */
export function calculateWithdrawalFee(
  amount: string,
  percentage: string,
  fixedFee: string,
): { feeAmount: string; payoutAmount: string } {
  const base = parseWalletAmount(amount)
  const fixed = parseWalletAmount(fixedFee)
  const rate = new ExactDecimal(normalizeWithdrawalPercent(percentage))
  if (base.lte(0)) throw new RangeError('Withdrawal amount must be greater than zero')

  const fee = base.times(rate).div(100).plus(fixed).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  if (fee.gte(base)) throw new RangeError('Withdrawal fee must be less than the withdrawal amount')
  const feeAmount = fee.toFixed(2)
  const payoutAmount = base.minus(fee).toFixed(2)
  parseWalletAmount(feeAmount)
  parseWalletAmount(payoutAmount)
  return { feeAmount, payoutAmount }
}

/** Adds two already-settled non-negative amounts within NUMERIC(18,2). */
export function addSettlementAmounts(left: string, right: string): string {
  const result = parseWalletAmount(left).plus(parseWalletAmount(right))
  const normalized = result.toFixed(2)
  parseWalletAmount(normalized)
  return normalized
}

/** Allocates an order wallet debit from gift funds first, then cash funds. */
export function allocateWalletSpend(
  amount: string,
  giftAvailable: string,
  cashAvailable: string,
): { giftAmount: string; cashAmount: string } {
  const requested = parseWalletAmount(amount)
  const gift = parseWalletAmount(giftAvailable)
  const cash = parseWalletAmount(cashAvailable)
  if (requested.lte(0)) throw new RangeError('Wallet payment amount must be greater than zero')

  const giftAmount = ExactDecimal.min(requested, gift)
  const cashAmount = requested.minus(giftAmount)
  if (cashAmount.gt(cash)) throw new RangeError('Insufficient wallet balance')
  return { giftAmount: giftAmount.toFixed(2), cashAmount: cashAmount.toFixed(2) }
}

/**
 * Splits an order between a requested wallet contribution and external payment.
 * Available gift funds are used before cash; any unavailable requested wallet
 * amount stays due externally. All arithmetic remains in Decimal.
 */
export function allocateWalletOrderPayment(
  orderAmount: string,
  requestedWalletAmount: string,
  giftAvailable: string,
  cashAvailable: string,
): { giftAmount: string; cashAmount: string; externalAmount: string } {
  const order = parseWalletAmount(orderAmount)
  const requested = parseWalletAmount(requestedWalletAmount)
  const gift = parseWalletAmount(giftAvailable)
  const cash = parseWalletAmount(cashAvailable)
  if (order.lte(0) || requested.lte(0) || requested.gt(order)) {
    throw new RangeError('Wallet contribution must be greater than zero and no greater than the order amount')
  }

  const giftAmount = ExactDecimal.min(requested, gift)
  const cashAmount = ExactDecimal.min(requested.minus(giftAmount), cash)
  const externalAmount = order.minus(giftAmount).minus(cashAmount)
  return {
    giftAmount: giftAmount.toFixed(2),
    cashAmount: cashAmount.toFixed(2),
    externalAmount: externalAmount.toFixed(2),
  }
}

/** An upstream observation, never a settlement or a SKU sale price. Preserve all
 * supported digits and trailing zeros; reject unsupported precision, never round. */
export function preserveSupplierReferenceAmount(value: string): string {
  if (!/^(?:0|[1-9]\d{0,23})(?:\.\d{1,18})?$/.test(value)) {
    throw new TypeError('Supplier reference amount has an unsupported format or precision')
  }
  const amount = new ExactDecimal(value)
  if (!amount.isFinite() || amount.isNegative()) throw new TypeError('Invalid supplier reference amount')
  return value
}

/** Exact raw-reference arithmetic for same-source observations. This value has
 * no currency or procurement meaning and must never be used as an internal cost. */
export function subtractSupplierReferenceAmounts(left: string, right: string): string {
  preserveSupplierReferenceAmount(left)
  preserveSupplierReferenceAmount(right)
  const leftAmount = new ExactDecimal(left)
  const rightAmount = new ExactDecimal(right)
  const scale = Math.max(left.split('.')[1]?.length ?? 0, right.split('.')[1]?.length ?? 0)
  const formatted = leftAmount.minus(rightAmount).toFixed(scale)
  if (scale === 0) return formatted
  const [whole, fraction = ''] = formatted.split('.')
  return `${whole}.${fraction.padEnd(scale, '0')}`
}

export type UnitPricingRule =
  | { mode: 'fixed_profit'; fixedProfit: string }
  | { mode: 'percentage_markup'; markupRate: string }

export function calculateSuggestedSalePriceDetailed(costPrice: string, rule: UnitPricingRule): {
  salePrice: string
  unroundedPrice: string
  roundedToCents: boolean
} {
  const cost = parseUnitAmount(costPrice)
  if (cost.isNegative() || cost.decimalPlaces() > 5 || cost.gt(databaseUnitAmountMax)) {
    throw new RangeError('Cost price is outside NUMERIC(18,5) bounds')
  }

  let unrounded: Decimal
  if (rule.mode === 'fixed_profit') {
    const profit = parseUnitAmount(rule.fixedProfit)
    if (profit.isNegative() || profit.decimalPlaces() > 5 || profit.gt(databaseUnitAmountMax)) {
      throw new RangeError('Fixed profit is outside NUMERIC(18,5) bounds')
    }
    unrounded = cost.plus(profit)
  } else {
    if (!pricingMarkupPattern.test(rule.markupRate)) {
      throw new TypeError('Cost markup must be a non-negative decimal percentage with at most 6 integer and 4 fractional digits')
    }
    const rate = new ExactDecimal(rule.markupRate)
    unrounded = cost.times(new ExactDecimal(100).plus(rate)).div(100)
  }

  if (!unrounded.isFinite() || unrounded.isNegative() || unrounded.gt(databaseUnitAmountMax)) {
    throw new RangeError('Unrounded suggested price exceeds NUMERIC(18,5) bounds')
  }
  const rounded = unrounded.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  if (rounded.gt(databaseSalePriceMax)) {
    throw new RangeError('Suggested sale price exceeds NUMERIC(18,5) with two fractional digits')
  }
  return {
    salePrice: rounded.toFixed(2),
    unroundedPrice: unrounded.toFixed(),
    roundedToCents: unrounded.decimalPlaces() > 2,
  }
}

/**
 * Suggests a SKU sale price from an explicitly configured rule and a manual
 * unit cost. Markup is a percentage of cost (not gross margin). Inputs retain
 * their full supported decimal precision; only the suggested sale price is
 * rounded, once, to cents with ROUND_HALF_UP.
 */
export function calculateSuggestedSalePrice(costPrice: string, rule: UnitPricingRule): string {
  return calculateSuggestedSalePriceDetailed(costPrice, rule).salePrice
}

/** Computes per-unit gross profit and margin without binary floating point. */
export function calculateUnitProfitMetrics(salePrice: string, costPrice: string): {
  grossProfit: string
  grossMarginRate: string | null
} {
  const sale = parseUnitAmount(salePrice)
  const cost = parseUnitAmount(costPrice)
  if (sale.isNegative() || sale.decimalPlaces() > 2 || sale.gt(databaseSalePriceMax)) {
    throw new RangeError('Sale price is outside its NUMERIC(18,5) two-decimal bounds')
  }
  if (cost.isNegative() || cost.decimalPlaces() > 5 || cost.gt(databaseUnitAmountMax)) {
    throw new RangeError('Cost price is outside NUMERIC(18,5) bounds')
  }
  const grossProfit = sale.minus(cost).toFixed(5)
  const grossMarginRate = sale.isZero()
    ? null
    : sale.minus(cost).div(sale).times(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4)
  return { grossProfit, grossMarginRate }
}
