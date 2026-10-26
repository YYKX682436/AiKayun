import { describe, expect, it } from 'vitest'
import { preserveSupplierReferenceAmount, subtractSupplierReferenceAmounts } from '../src/index.js'
describe('upstream reference quotes', () => {
  it('preserves all digits and scale without settlement rounding', () => {
    for (const value of ['0', '0.000000000000000001', '12.345678901234567890', '999999999999999999999999.000000000000000000']) expect(preserveSupplierReferenceAmount(value)).toBe(value)
  })
  it('rejects invalid or excessive precision rather than converting to free or rounded prices', () => {
    for (const value of ['', '-1', '-0', 'NaN', 'Infinity', '1e-3', ' 1', '01', '0.1234567890123456789', '1000000000000000000000000']) expect(() => preserveSupplierReferenceAmount(value)).toThrow()
  })
  it('compares reference values exactly without assigning a currency or cost meaning', () => {
    expect(subtractSupplierReferenceAmounts('12.3400', '9.7')).toBe('2.6400')
    expect(subtractSupplierReferenceAmounts('0', '999999999999999999999999')).toBe('-999999999999999999999999')
  })
})
