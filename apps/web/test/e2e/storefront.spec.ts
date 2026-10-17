import { expect, test } from '@playwright/test'
import { wcagContrast } from 'culori'

const viewportWidths = [320, 390, 768, 1024, 1137, 1280, 1440]

async function assertAdminVisuals(page: import('@playwright/test').Page, area: string, mode: 'light' | 'dark') {
  await expect.poll(() => page.locator('meta[name="theme-color"]').getAttribute('content')).toBe(mode === 'dark' ? '#020617' : '#f8fafc')
  const measurements = await page.evaluate(() => ({
    width: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    bodyText: getComputedStyle(document.body).color,
    area: document.documentElement.dataset.aikayunArea,
    mode: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    themeColor: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content,
  }))

  expect(measurements.area).toBe(area)
  expect(measurements.mode).toBe(mode)
  expect(measurements.documentWidth).toBeLessThanOrEqual(measurements.clientWidth)
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

async function assertMobileAdminNavigation(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('heading', { name: '经营数据尚未开放' })).toBeVisible()

  const menuToggle = page.locator('[data-slot="toggle"]')
  await expect(menuToggle).toBeVisible()
  await expect(menuToggle.locator('[data-slot="leadingIcon"]')).toBeVisible()
  const toggleSize = await menuToggle.evaluate(element => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }))
  expect(toggleSize.width).toBeGreaterThanOrEqual(44)
  expect(toggleSize.height).toBeGreaterThanOrEqual(44)
  await menuToggle.focus()
  await page.keyboard.press('Enter')

  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  await expect(drawer).toHaveAttribute('aria-labelledby', /.+/)
  await expect(drawer.getByRole('link', { name: 'AiKayun' })).toBeVisible()
  await expect(drawer.locator('[aria-disabled="true"]')).toHaveCount(2)
  await expect.poll(() => drawer.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(menuToggle).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(drawer).toBeVisible()
  await drawer.getByRole('link', { name: '商品管理' }).click()
  await expect(page).toHaveURL(/\/admin\/products$/)
  await expect(drawer).toBeHidden()
  await expect(page.locator('main').getByRole('heading', { name: '商品管理' })).toBeVisible()

  await menuToggle.focus()
  await page.keyboard.press('Enter')
  await expect(drawer).toBeVisible()
  await drawer.getByRole('link', { name: '返回店铺' }).click()
  await expect(page).toHaveURL('/')
  await expect(drawer).toBeHidden()

  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: '管理概览' })).toBeVisible()
  for (const width of viewportWidths) {
    await page.setViewportSize({ width, height: 844 })
    const { documentWidth, clientWidth } = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(documentWidth).toBeLessThanOrEqual(clientWidth)
  }
}

test('renders real server-side storefront products or the honest empty state without unavailable transaction actions', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  const serverHtml = await response?.text()
  const catalogResponse = await page.request.get('/api/v1/public/products?page=1&pageSize=24&sort=newest')
  expect(catalogResponse.status()).toBe(200)
  const catalog = (await catalogResponse.json()).data as { items: Array<{ id: string; name: string; priceRange: { min: string; max: string } | null }> }

  await expect(page.getByRole('heading', { level: 1, name: '全部商品' })).toBeVisible()
  if (catalog.items.length === 0) {
    await expect(page.getByRole('heading', { name: '暂无可展示的商品' })).toBeVisible()
  }
  else {
    await expect(page.locator('a[href^="/products/"]')).toHaveCount(catalog.items.length)
    await expect(page.getByText(catalog.items[0]!.name, { exact: false })).toBeVisible()
    expect(serverHtml).toContain(catalog.items[0]!.name)
    if (catalog.items[0]!.priceRange) expect(serverHtml).toContain(catalog.items[0]!.priceRange!.min)
  }
  await expect(page.getByRole('banner').getByRole('link', { name: '管理入口' })).toHaveAttribute('href', '/admin/login')
  await expect(page.getByRole('link', { name: '搜索商品' })).toHaveAttribute('href', '/search')
  await expect(page.getByRole('link', { name: '登录' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '注册' })).toHaveCount(0)
  await expect(page.getByRole('search')).toHaveCount(0)
  await expect(page.locator('input[type="search"], a[href="/api/docs"], a[href="/cart"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /购买|加入购物车|立即购买/ })).toHaveCount(0)
  expect(serverHtml).not.toMatch(/TypeScript 严格模式|PostgreSQL 数据持久化|API 文档|工程基础搭建|阶段 01/)
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

  await assertMobileAdminNavigation(page)
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

test('development design preview composes existing components without business actions', async ({ page }) => {
  const response = await page.goto('/dev-preview')
  if (process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true') {
    expect(response?.status()).toBe(404)
    expect(await response?.text()).not.toContain('品牌与语义颜色')
    return
  }

  expect(response?.status()).toBe(200)
  await expect(page).toHaveTitle('设计系统预览 · AiKayun 数字商城')
  await expect(page.getByRole('heading', { name: '品牌与语义颜色' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '按钮与输入框' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '空状态样例' })).toBeVisible()
  await expect(page.getByRole('button', { name: '提交中' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '不可用' })).toBeDisabled()
  await expect(page.getByRole('link', { name: /购买|加入购物车/ })).toHaveCount(0)
})
