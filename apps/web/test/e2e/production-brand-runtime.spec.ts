import { expect, test } from '@playwright/test'
import { addBrandContrastProbe } from './brand-probe'

test('a prebuilt production server reads tenant branding from runtime environment variables', async ({ page }) => {
  const previewResponse = await page.request.get('/dev-preview')
  expect(previewResponse.status()).toBe(404)
  expect(await previewResponse.text()).not.toContain('品牌与语义颜色')

  const browserErrors: string[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' || /hydration/i.test(message.text())) browserErrors.push(message.text())
  })

  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  const serverHtml = await response?.text()
  expect(serverHtml).toContain('<title>全部商品 · 生产运行时商店</title>')
  expect(serverHtml).toContain('storeBrandColor:"#7C3AED"')
  expect(serverHtml).toMatch(/<html[^>]+style="--ui-color-primary-50:/)
  await expect(page).toHaveTitle('全部商品 · 生产运行时商店')
  await expect(page.getByRole('link', { name: /生产运行时商店/ }).first()).toBeVisible()
  await addBrandContrastProbe(page)

  const storefront = await page.evaluate(() => ({
    area: document.documentElement.dataset.aikayunArea,
    primary: getComputedStyle(document.documentElement).getPropertyValue('--ui-color-primary-600').trim(),
    foreground: getComputedStyle(document.querySelector('#brand-color-text-probe')!).color,
  }))
  expect(storefront.area).toBe('storefront')
  expect(storefront.primary).toMatch(/^#[\da-f]{6}$/i)
  expect(storefront.primary.toUpperCase()).not.toBe('#2563EB')
  expect(storefront.foreground).not.toBe('rgb(37, 99, 235)')

  await page.getByRole('banner').getByRole('link', { name: '管理入口', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/login$/)
  await expect(page).toHaveTitle('管理员登录 · AiKayun')
  expect(await page.evaluate(() => ({
    area: document.documentElement.dataset.aikayunArea,
    primary: getComputedStyle(document.documentElement).getPropertyValue('--ui-color-primary-600').trim(),
  }))).toEqual({ area: 'admin', primary: '#2563eb' })

  await page.getByRole('link', { name: 'AiKayun' }).click()
  await expect(page).toHaveTitle('全部商品 · 生产运行时商店')
  await expect(page.locator('html')).toHaveAttribute('data-aikayun-area', 'storefront')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-color-primary-600').trim())).toBe(storefront.primary)
  expect(browserErrors).toEqual([])
})
