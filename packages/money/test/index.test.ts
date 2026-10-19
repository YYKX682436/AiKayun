import { describe, expect, it } from 'vitest'
import { addSettlementAmounts, addUnitAmounts, allocateWalletOrderPayment, allocateWalletSpend, multiplyUnitAmount, parseUnitAmount, settleAmount } from '../src/index.ts'

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

  it('accepts NUMERIC(18,5) unit-price boundaries and keeps expanded intermediate results', () => {
    expect(parseUnitAmount('9999999999999.99999').toFixed(5)).toBe('9999999999999.99999')
    expect(() => parseUnitAmount('10000000000000')).toThrow(TypeError)
    expect(addUnitAmounts('9999999999999.99999', '9999999999999.99999'))
      .toBe('19999999999999.99998')
    expect(multiplyUnitAmount('9999999999999.99999', Number.MAX_SAFE_INTEGER))
      .toBe('90071992547409909909928007452.59009')
    expect(() => settleAmount(multiplyUnitAmount('9999999999999.99999', Number.MAX_SAFE_INTEGER)))
      .toThrow(RangeError)
  })

  it('rejects quantities that are not exact safe integers', () => {
    expect(() => multiplyUnitAmount('9999999999999.99999', Number.MAX_SAFE_INTEGER + 1))
      .toThrow(TypeError)
  })

  it('enforces NUMERIC(18,2) settlement limits after half-up rounding', () => {
    expect(settleAmount('9999999999999999.99499')).toBe('9999999999999999.99')
    expect(() => settleAmount('9999999999999999.995')).toThrow(RangeError)
    expect(settleAmount('-9999999999999999.99499')).toBe('-9999999999999999.99')
    expect(() => settleAmount('-9999999999999999.995')).toThrow(RangeError)
    expect(addSettlementAmounts('9999999999999999.98', '0.01')).toBe('9999999999999999.99')
    expect(() => addSettlementAmounts('9999999999999999.99', '0.01')).toThrow(TypeError)
  })

  it('supports signed generic arithmetic without treating negative values as valid sale prices', () => {
    expect(addUnitAmounts('-2.50000', '1.25000')).toBe('-1.25000')
    expect(multiplyUnitAmount('-2.50000', 2)).toBe('-5.00000')
    expect(settleAmount('-1.005')).toBe('-1.01')
  })

  it('spends gift balance before cash using exact decimal strings', () => {
    expect(allocateWalletSpend('50.00', '30', '80.00')).toEqual({ giftAmount: '30.00', cashAmount: '20.00' })
    expect(allocateWalletSpend('0.01', '0.01', '0.01')).toEqual({ giftAmount: '0.01', cashAmount: '0.00' })
    expect(() => allocateWalletSpend('100.01', '20.00', '80.00')).toThrow(RangeError)
    expect(() => allocateWalletSpend('1.001', '2.00', '2.00')).toThrow(TypeError)
    expect(() => allocateWalletSpend('1', '1e2', '1')).toThrow(TypeError)
  })

  it('keeps an unavailable wallet contribution due through the external payment leg', () => {
    expect(allocateWalletOrderPayment('100.00', '80.00', '30.00', '50.00')).toEqual({
      giftAmount: '30.00', cashAmount: '50.00', externalAmount: '20.00',
    })
    expect(allocateWalletOrderPayment('100.00', '100.00', '30.00', '50.00')).toEqual({
      giftAmount: '30.00', cashAmount: '50.00', externalAmount: '20.00',
    })
    expect(allocateWalletOrderPayment('100.00', '80.00', '10.00', '20.00')).toEqual({
      giftAmount: '10.00', cashAmount: '20.00', externalAmount: '70.00',
    })
    expect(() => allocateWalletOrderPayment('10.00', '10.01', '1.00', '1.00')).toThrow(RangeError)
  })
})
