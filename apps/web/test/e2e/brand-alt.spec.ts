import { expect, test } from '@playwright/test'
import { wcagContrast } from 'culori'

test('an alternate deployment applies its logo and purple primary, then isolates the admin theme', async ({ page }, testInfo) => {
  await page.route('**/configured-logo.svg', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#7C3AED"/></svg>',
  }))

  await page.emulateMedia({ colorScheme: 'light' })
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('link', { name: /青屿数字商店/ }).first()).toBeVisible()
  await expect(page.locator('header img')).toHaveAttribute('src', '/configured-logo.svg')
  await expect.poll(() => page.locator('header img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(32)

  const storefrontColor = await page.evaluate(() => {
    const root = document.documentElement
    return {
      area: root.dataset.aikayunArea,
      primary: getComputedStyle(root).getPropertyValue('--ui-color-primary-600').trim(),
    }
  })
  expect(storefrontColor).toEqual({ area: 'storefront', primary: '#7C3AED' })
  const lightButton = await page.evaluate(() => {
    const button = document.querySelector<HTMLAnchorElement>('main a[href="/admin/login"]')!
    const styles = getComputedStyle(button)
    return { background: styles.backgroundColor, foreground: styles.color }
  })
  expect(wcagContrast(lightButton.background, lightButton.foreground)).toBeGreaterThanOrEqual(4.5)
  await page.screenshot({ path: testInfo.outputPath('brand-purple-light.png'), fullPage: true, animations: 'disabled' })

  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: '深色' }).click()
  const storefrontContrast = await page.evaluate(() => {
    const button = document.querySelector<HTMLAnchorElement>('main a[href="/admin/login"]')!
    const styles = getComputedStyle(button)
    return { background: styles.backgroundColor, foreground: styles.color }
  })
  expect(wcagContrast(storefrontContrast.background, storefrontContrast.foreground)).toBeGreaterThanOrEqual(4.5)
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.screenshot({ path: testInfo.outputPath('brand-purple-dark.png'), fullPage: true, animations: 'disabled' })

  await page.goto('/admin/login')
  await expect(page.locator('html')).toHaveAttribute('data-aikayun-area', 'admin')
  const adminTheme = await page.evaluate(() => ({
    primary: getComputedStyle(document.documentElement).getPropertyValue('--ui-color-primary-600').trim(),
    preference: localStorage.getItem('aikayun-color-mode'),
    dark: document.documentElement.classList.contains('dark'),
  }))
  expect(adminTheme).toEqual({ primary: '#2563eb', preference: 'dark', dark: true })

  await page.getByRole('link', { name: 'AiKayun' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-aikayun-area', 'storefront')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-color-primary-600').trim())).toBe('#7C3AED')
  await expect(page.locator('html')).toHaveClass(/dark/)
})
