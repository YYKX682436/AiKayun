import { expect, test } from '@playwright/test'
import { wcagContrast } from 'culori'
import { addBrandContrastProbe } from './brand-probe'

test('an alternate deployment applies its logo and purple primary, then isolates the admin theme', async ({ page }, testInfo) => {
  const browserErrors: string[] = []
  let expectedBrokenLogoResourceError = false
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('console', message => {
    if (expectedBrokenLogoResourceError && message.text() === 'Failed to load resource: net::ERR_FAILED') {
      expectedBrokenLogoResourceError = false
      return
    }
    if (message.type() === 'error' || /hydration/i.test(message.text())) browserErrors.push(message.text())
  })

  await page.route('**/configured-logo.svg', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#7C3AED"/></svg>',
  }))

  await page.emulateMedia({ colorScheme: 'light' })
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  const serverHtml = await response?.text()
  expect(serverHtml).toContain('<title>全部商品 · 青屿数字商店</title>')
  expect(serverHtml).toContain('storeBrandColor:"#7C3AED"')
  expect(serverHtml).toMatch(/<html[^>]+style="--ui-color-primary-50:/)
  await expect(page).toHaveTitle('全部商品 · 青屿数字商店')
  await expect(page.getByRole('link', { name: /青屿数字商店/ }).first()).toBeVisible()
  await expect(page.locator('header img')).toHaveAttribute('src', '/configured-logo.svg')
  await expect.poll(() => page.locator('header img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(32)
  await addBrandContrastProbe(page)

  const storefrontColor = await page.evaluate(() => {
    const root = document.documentElement
    return {
      area: root.dataset.aikayunArea,
      primary: getComputedStyle(root).getPropertyValue('--ui-color-primary-600').trim(),
    }
  })
  expect(storefrontColor.area).toBe('storefront')
  expect(storefrontColor.primary).toMatch(/^#[\da-f]{6}$/i)
  expect(storefrontColor.primary.toUpperCase()).not.toBe('#2563EB')
  const lightBrandText = await page.evaluate(() => {
    const text = document.querySelector<HTMLElement>('#brand-color-text-probe')!
    return { background: getComputedStyle(document.body).backgroundColor, foreground: getComputedStyle(text).color }
  })
  expect(wcagContrast(lightBrandText.foreground, lightBrandText.background)).toBeGreaterThanOrEqual(4.5)
  await page.screenshot({ path: testInfo.outputPath('brand-purple-light.png'), fullPage: true, animations: 'disabled' })

  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: '深色' }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await addBrandContrastProbe(page)
  await expect(page.locator('#brand-color-text-probe')).toBeAttached()
  const storefrontContrast = await page.evaluate(() => {
    const text = document.querySelector<HTMLElement>('#brand-color-text-probe')!
    return { background: getComputedStyle(document.body).backgroundColor, foreground: getComputedStyle(text).color }
  })
  expect(wcagContrast(storefrontContrast.foreground, storefrontContrast.background)).toBeGreaterThanOrEqual(4.5)
  await page.screenshot({ path: testInfo.outputPath('brand-purple-dark.png'), fullPage: true, animations: 'disabled' })

  await page.route('**/broken-configured-logo.svg', route => route.abort())
  expectedBrokenLogoResourceError = true
  await page.locator('header img').evaluate((image: HTMLImageElement) => {
    image.src = '/broken-configured-logo.svg'
  })
  await expect(page.locator('header img')).toHaveCount(0)
  await expect(page.locator('header a').first().locator('[aria-hidden="true"]')).toHaveText('青')

  await page.goto('/admin/login')
  await expect(page.locator('html')).toHaveAttribute('data-aikayun-area', 'admin')
  await expect(page).toHaveTitle('管理员登录 · AiKayun')
  const adminTheme = await page.evaluate(() => ({
    primary: getComputedStyle(document.documentElement).getPropertyValue('--ui-color-primary-600').trim(),
    preference: localStorage.getItem('aikayun-color-mode'),
    dark: document.documentElement.classList.contains('dark'),
  }))
  expect(adminTheme).toEqual({ primary: '#2563eb', preference: 'dark', dark: true })

  await page.route('**/api/v1/admin/auth/csrf', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { csrfToken: 'theme-test-token' } }),
  }))
  await page.route('**/api/v1/admin/auth/login', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { admin: { email: 'theme-test@example.com' } } }),
  }))
  await page.route('**/api/v1/admin/session', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { admin: { email: 'theme-test@example.com' } } }),
  }))
  await expect(page.getByRole('button', { name: '安全登录' })).toBeEnabled({ timeout: 15_000 })
  await page.getByLabel('管理员邮箱').fill('theme-test@example.com')
  await page.getByLabel('密码').fill('theme-test-password')
  await expect(page.getByLabel('管理员邮箱')).toHaveValue('theme-test@example.com')
  await expect(page.getByLabel('密码')).toHaveValue('theme-test-password')
  await page.getByRole('button', { name: '安全登录' }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page).toHaveTitle('管理概览 · AiKayun')
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-color-primary-600').trim())).toBe('#2563eb')

  await page.getByRole('link', { name: '返回店铺' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-aikayun-area', 'storefront')
  await expect(page).toHaveTitle('全部商品 · 青屿数字商店')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-color-primary-600').trim())).not.toBe('#2563EB')
  await expect(page.locator('html')).toHaveClass(/dark/)

  expect(browserErrors).toEqual([])
})
