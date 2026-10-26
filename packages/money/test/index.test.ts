import { describe, expect, it } from 'vitest'
import { addSettlementAmounts, addUnitAmounts, allocateWalletOrderPayment, allocateWalletSpend, calculateSuggestedSalePrice, calculateSuggestedSalePriceDetailed, calculateUnitProfitMetrics, calculateWithdrawalFee, multiplyUnitAmount, normalizeWithdrawalPercent, parseUnitAmount, settleAmount } from '../src/index.ts'

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

  it('calculates withdrawal fees exactly and rounds the combined fee half up once', () => {
    expect(calculateWithdrawalFee('100.00', '1.25', '0.75')).toEqual({
      feeAmount: '2.00', payoutAmount: '98.00',
    })
    expect(calculateWithdrawalFee('0.03', '50', '0.00')).toEqual({
      feeAmount: '0.02', payoutAmount: '0.01',
    })
    expect(normalizeWithdrawalPercent('2.5')).toBe('2.5000')
    expect(() => calculateWithdrawalFee('10.00', '100', '0.00')).toThrow(RangeError)
    expect(() => calculateWithdrawalFee('0.01', '0', '0.01')).toThrow(RangeError)
    expect(() => normalizeWithdrawalPercent('100.0001')).toThrow(RangeError)
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

  it('calculates fixed-profit and cost-markup prices with exact half-up cent settlement', () => {
    expect(calculateSuggestedSalePrice('10.12345', { mode: 'fixed_profit', fixedProfit: '1.23455' })).toBe('11.36')
    expect(calculateSuggestedSalePrice('10.12345', { mode: 'percentage_markup', markupRate: '12.5000' })).toBe('11.39')
    expect(calculateSuggestedSalePrice('0.00500', { mode: 'fixed_profit', fixedProfit: '0' })).toBe('0.01')
    expect(calculateSuggestedSalePrice('0.00499', { mode: 'fixed_profit', fixedProfit: '0' })).toBe('0.00')
    expect(calculateSuggestedSalePriceDetailed('0.00499', { mode: 'fixed_profit', fixedProfit: '0' })).toEqual({
      salePrice: '0.00', unroundedPrice: '0.00499', roundedToCents: true,
    })
  })

  it('accepts zero cost and profit, rejects excess rule precision, and guards NUMERIC bounds', () => {
    expect(calculateSuggestedSalePrice('0', { mode: 'fixed_profit', fixedProfit: '0' })).toBe('0.00')
    expect(calculateSuggestedSalePrice('0', { mode: 'percentage_markup', markupRate: '999999.9999' })).toBe('0.00')
    expect(() => calculateSuggestedSalePrice('1.000001', { mode: 'fixed_profit', fixedProfit: '0' })).toThrow(TypeError)
    expect(() => calculateSuggestedSalePrice('1', { mode: 'percentage_markup', markupRate: '1.12345' })).toThrow(TypeError)
    expect(() => calculateSuggestedSalePrice('9999999999999.99999', { mode: 'fixed_profit', fixedProfit: '0.00001' })).toThrow(RangeError)
    expect(() => calculateSuggestedSalePrice('9999999999999.99999', { mode: 'percentage_markup', markupRate: '0.0001' })).toThrow(RangeError)
  })

  it('distinguishes markup from gross margin and reports free-price margin as undefined', () => {
    expect(calculateUnitProfitMetrics('12.50', '10.00000')).toEqual({ grossProfit: '2.50000', grossMarginRate: '20.0000' })
    expect(calculateUnitProfitMetrics('12.00', '10.00000').grossProfit).toBe('2.00000')
    expect(calculateUnitProfitMetrics('12.00', '10.00000').grossMarginRate).toBe('16.6667')
    expect(calculateUnitProfitMetrics('0', '0').grossMarginRate).toBeNull()
    expect(calculateUnitProfitMetrics('0.00', '0.00499').grossProfit).toBe('-0.00499')
  })
})
