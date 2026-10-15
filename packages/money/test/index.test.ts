import { describe, expect, it } from 'vitest'
import { addUnitAmounts, multiplyUnitAmount, parseUnitAmount, settleAmount } from '../src/index.ts'

describe('decimal monetary helpers', () => {
  it('adds decimal strings without binary floating point drift', () => {
    expect(addUnitAmounts('0.1', '0.2')).toBe('0.30000')
  })

  it('keeps unit price precision through multiplication and rounds settlement half up', () => {
    expect(multiplyUnitAmount('0.12345', 3)).toBe('0.37035')
    expect(settleAmount('0.37035')).toBe('0.37')
    expect(settleAmount('1.005')).toBe('1.01')
    expect(settleAmount('-1.005')).toBe('-1.01')
  })

  it('rejects floating-point values, exponent notation and excess precision', () => {
    expect(() => parseUnitAmount('1e-7')).toThrow(TypeError)
    expect(() => parseUnitAmount('1.123456')).toThrow(TypeError)
    expect(() => parseUnitAmount('9007199254740992')).toThrow(TypeError)
    expect(() => multiplyUnitAmount('1.00000', 1.5)).toThrow(TypeError)
  })
})
