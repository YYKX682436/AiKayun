import { expect, test } from '@playwright/test'
import { createStorefrontThemeStyle, defaultStoreBrand, normalizeHex, resolveStoreBrand } from '../../utils/store-brand'

test('the AiKayun deployment uses the default storefront name and brand blue', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('link', { name: /AiKayun 数字商城/ }).first()).toBeVisible()
  await expect(page.locator('header img')).toHaveCount(0)

  const brand = await page.evaluate(() => ({
    area: document.documentElement.dataset.aikayunArea,
    color: getComputedStyle(document.documentElement).getPropertyValue('--ui-color-primary-600').trim(),
  }))
  expect(brand).toEqual({ area: 'storefront', color: '#2563EB' })
})

test('valid HEX inputs normalize and invalid public brand config safely falls back', () => {
  expect(normalizeHex('#abc')).toBe('#AABBCC')
  expect(normalizeHex('rgb(255 0 0)')).toBeUndefined()
  expect(normalizeHex('red; background: url(javascript:alert(1))')).toBeUndefined()

  const brand = resolveStoreBrand({
    storeName: '  ',
    storeLogoUrl: 'javascript:alert(1)',
    storeBrandColor: 'red; --ui-primary: url(javascript:alert(1))',
  })
  expect(brand).toEqual(defaultStoreBrand)

  const style = createStorefrontThemeStyle(brand.storeBrandColor)
  expect(style).toContain('--ui-color-primary-600:#2563EB')
  expect(style).not.toMatch(/javascript|url\(|red;/i)
  expect(style.split(';')).toHaveLength(11)
})
