import { Decimal } from 'decimal.js'

const ExactDecimal = Decimal.clone({
  precision: 50,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -100,
  toExpPos: 100,
})

const amountPattern = /^-?(?:0|[1-9]\d{0,12})(?:\.\d{1,5})?$/

export function parseUnitAmount(value: string): Decimal {
  if (!amountPattern.test(value)) {
    throw new TypeError('Amount must be a decimal string with up to 13 integer and 5 fractional digits')
  }
  return new ExactDecimal(value)
}

export function addUnitAmounts(left: string, right: string): string {
  return parseUnitAmount(left).plus(parseUnitAmount(right)).toFixed(5)
}

export function multiplyUnitAmount(unitAmount: string, quantity: number): string {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new TypeError('Quantity must be a non-negative safe integer')
  }
  return parseUnitAmount(unitAmount).times(quantity).toFixed(5)
}

export function settleAmount(value: string): string {
  return parseUnitAmount(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
}
