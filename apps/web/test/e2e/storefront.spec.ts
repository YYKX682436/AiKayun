import { expect, test } from '@playwright/test'
import { wcagContrast } from 'culori'

const viewportWidths = [320, 390, 768, 1440]

async function assertAdminVisuals(page: import('@playwright/test').Page, area: string, mode: 'light' | 'dark') {
  const measurements = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    bodyText: getComputedStyle(document.body).color,
    area: document.documentElement.dataset.aikayunArea,
    mode: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  }))

  expect(measurements.area).toBe(area)
  expect(measurements.mode).toBe(mode)
  expect(measurements.documentWidth).toBeLessThanOrEqual(measurements.width)
  expect(wcagContrast(measurements.bodyText, measurements.bodyBackground)).toBeGreaterThanOrEqual(4.5)

  if (await page.getByRole('button', { name: '安全登录' }).count()) {
    const formColors = await page.getByRole('button', { name: '安全登录' }).evaluate((button) => {
      const styles = getComputedStyle(button)
      return { background: styles.backgroundColor, foreground: styles.color }
    })
    expect(wcagContrast(formColors.background, formColors.foreground)).toBeGreaterThanOrEqual(4.5)
    const inputColors = await page.getByLabel('管理员邮箱').evaluate((input) => {
      const styles = getComputedStyle(input)
      return { background: styles.backgroundColor, foreground: styles.color }
    })
    expect(wcagContrast(inputColors.background, inputColors.foreground)).toBeGreaterThanOrEqual(4.5)
  }
}

test('renders the server-side storefront and its foundation capabilities', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { name: /让数字商品/ })).toBeVisible()
  await expect(page.getByText('PostgreSQL 数据持久化')).toBeVisible()
  await expect(page.getByRole('link', { name: '进入管理后台' })).toBeVisible()
})

test('blocks the admin page until login, then creates and ends a session', async ({ page }, testInfo) => {
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin\/login/)
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible()

  for (const mode of ['light', 'dark'] as const) {
    await page.getByRole('button', { name: '显示模式' }).click()
    await page.getByRole('option', { name: mode === 'light' ? '浅色' : '深色' }).click()

    for (const width of viewportWidths) {
      await page.setViewportSize({ width, height: 900 })
      await assertAdminVisuals(page, 'admin', mode)
      await page.screenshot({
        path: testInfo.outputPath(`admin-login-${mode}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      })
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 })

  await expect(page.getByRole('button', { name: '安全登录' })).toBeEnabled()
  await page.getByLabel('管理员邮箱').fill('browser-test@example.com')
  await page.getByLabel('密码').fill('Only-For-E2E-Tests-2026!!')
  await page.getByRole('button', { name: '安全登录' }).click()

  await expect(page).toHaveURL(/\/admin$/)
  expect(page.url()).not.toContain('Only-For-E2E-Tests-2026!!')
  await expect(page.getByRole('heading', { name: '管理概览' })).toBeVisible()
  await expect(page.getByText('browser-test@example.com')).toBeVisible()
  expect(await page.evaluate(() => ({
    area: document.documentElement.dataset.aikayunArea,
    primary: getComputedStyle(document.documentElement).getPropertyValue('--ui-color-primary-600').trim(),
  }))).toEqual({ area: 'admin', primary: '#2563eb' })

  for (const mode of ['light', 'dark'] as const) {
    await page.getByRole('button', { name: '显示模式' }).click()
    await page.getByRole('option', { name: mode === 'light' ? '浅色' : '深色' }).click()

    for (const width of viewportWidths) {
      await page.setViewportSize({ width, height: 900 })
      await assertAdminVisuals(page, 'admin', mode)
      await page.screenshot({
        path: testInfo.outputPath(`admin-overview-${mode}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      })
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  let logoutAttempts = 0
  await page.route('**/api/v1/admin/auth/logout', async (route) => {
    logoutAttempts += 1
    if (logoutAttempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: 503, statusMessage: 'Service Unavailable' }),
      })
      return
    }
    await route.continue()
  })

  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('alert')).toContainText('退出登录暂时失败，请重试。')
  await expect(page.getByRole('button', { name: '退出登录' })).toBeEnabled()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/admin\/login/)
  const protectedResponse = await page.request.get('/api/v1/admin/overview')
  expect(protectedResponse.status()).toBe(401)
  expect((await protectedResponse.json()).error.code).toBe('UNAUTHORIZED')
})

test('login announces an authentication error and blocks repeated submissions while pending', async ({ page }) => {
  let loginRequests = 0
  let releaseLogin!: () => void
  const loginResponse = new Promise<void>((resolve) => {
    releaseLogin = resolve
  })

  await page.route('**/api/v1/admin/auth/csrf', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { csrfToken: 'ui-test-token' } }),
  }))
  await page.route('**/api/v1/admin/auth/login', async (route) => {
    loginRequests += 1
    await loginResponse
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ statusCode: 401, statusMessage: 'Unauthorized' }),
    })
  })

  await page.goto('/admin/login')
  const submitButton = page.getByRole('button', { name: '安全登录' })
  await expect(submitButton).toBeEnabled()
  await page.getByLabel('管理员邮箱').fill('admin@example.com')
  await page.getByLabel('密码').fill('test-password')
  const form = page.locator('form')
  await page.getByLabel('密码').press('Enter')
  await expect(submitButton).toBeDisabled()
  await expect(page.getByLabel('管理员邮箱')).toBeDisabled()
  await expect(page.getByLabel('密码')).toBeDisabled()
  await form.evaluate(element => (element as HTMLFormElement).requestSubmit())
  await expect.poll(() => loginRequests, { timeout: 2_000 }).toBe(1)
  await page.waitForTimeout(100)
  expect(loginRequests).toBe(1)

  releaseLogin()
  await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确。')
  await expect(submitButton).toBeEnabled()
})

test('login fields stay disabled until client hydration completes', async ({ page }) => {
  await page.route('**/_nuxt/**', route => route.abort())
  await page.goto('/admin/login')

  await expect(page.getByLabel('管理员邮箱')).toBeDisabled()
  await expect(page.getByLabel('密码')).toBeDisabled()
  await expect(page.getByRole('button', { name: '安全登录' })).toBeDisabled()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/admin\/login$/)
})
