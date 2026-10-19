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
