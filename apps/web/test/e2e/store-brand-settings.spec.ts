import { expect, test } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100'
const deploymentDefaults = {
  storeName: 'AiKayun 数字商城',
  storeLogoUrl: '',
  storeBrandColor: '#2563EB',
}

test('admin settings persist and render in storefront SSR without changing admin theme', async ({ page }) => {
  const sessionToken = createBrowserAdminSession()
  await page.context().addCookies([{
    name: 'aikayun_admin_session', value: sessionToken, url: baseURL, httpOnly: true, sameSite: 'Lax',
  }])
  await page.route('**/store-logo.svg', route => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#7C3AED"/></svg>',
  }))

  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/admin/storefront/brand')
    await expect(page.getByRole('heading', { name: '店铺设置', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-aikayun-area', 'admin')
    await expect(page.getByRole('link', { name: '店铺设置' })).toBeVisible()

    await page.getByLabel('店铺名称').fill('青屿数字商店')
    await page.getByLabel('店铺 Logo 地址').fill('/store-logo.svg')
    await page.getByLabel('品牌主色 HEX 值').fill('#7C3AED')
    await expect(page.getByText('青屿数字商店', { exact: true }).last()).toBeVisible()
    await expect(page.getByText('品牌链接示例')).toBeVisible()
    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByRole('status')).toContainText('店铺品牌已保存')

    const publicSettings = await page.request.get(`${baseURL}/api/v1/public/storefront/brand`)
    expect(publicSettings.status()).toBe(200)
    expect((await publicSettings.json()).data.brand).toEqual({
      storeName: '青屿数字商店', storeLogoUrl: '/store-logo.svg', storeBrandColor: '#7C3AED',
    })

    const storefront = await page.goto('/')
    expect(await storefront?.text()).toContain('<title>全部商品 · 青屿数字商店</title>')
    await expect(page).toHaveTitle('全部商品 · 青屿数字商店')
    await expect(page.getByRole('link', { name: /青屿数字商店/ }).first()).toBeVisible()
    await expect(page.locator('header img')).toHaveAttribute('src', '/store-logo.svg')
    await expect(page.locator('html')).toHaveAttribute('data-aikayun-area', 'storefront')
    const modeButton = page.getByRole('button', { name: '显示模式' })
    await expect(modeButton).toBeEnabled()
    await modeButton.click()
    await page.getByRole('option', { name: '浅色' }).click()
    const lightPrimary = await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--ui-primary').trim())
    expect(lightPrimary).toMatch(/^#[\da-f]{6}$/i)

    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await modeButton.click()
    await page.getByRole('option', { name: '深色' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    const darkPrimary = await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--ui-primary').trim())
    expect(darkPrimary).toMatch(/^#[\da-f]{6}$/i)
    expect(darkPrimary).not.toBe(lightPrimary)

    await page.goto('/admin/storefront/brand')
    await expect(page.locator('html')).toHaveAttribute('data-aikayun-area', 'admin')
    const adminTheme = await page.locator('html').evaluate(element => ({
      style: element.getAttribute('style') ?? '',
      primary: getComputedStyle(element).getPropertyValue('--ui-color-primary-600').trim(),
    }))
    expect(adminTheme.style).not.toContain('--ui-color-primary-600')
    expect(adminTheme.primary).not.toBe(darkPrimary)
  } finally {
    const csrfResponse = await page.request.get(`${baseURL}/api/v1/admin/auth/csrf`)
    const csrfToken = (await csrfResponse.json()).data.csrfToken as string
    const setCookie = csrfResponse.headers()['set-cookie'] ?? ''
    const csrfCookie = setCookie.split(';', 1)[0] ?? ''
    const reset = await page.request.put(`${baseURL}/api/v1/admin/storefront/brand`, {
      headers: {
        origin: new URL(baseURL).origin,
        cookie: `aikayun_admin_session=${sessionToken}; ${csrfCookie}`,
        'x-csrf-token': csrfToken,
      },
      data: deploymentDefaults,
    })
    expect(reset.status()).toBe(200)
  }
})
