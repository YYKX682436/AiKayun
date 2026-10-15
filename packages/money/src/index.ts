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
