import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from '../../../api/test/browser-admin-session.mjs'
import { captureBrowserDiagnostics, expectClientMounted } from './browser-diagnostics'

type Product = {
  id: string
  name: string
  revision: number
  variants: Array<{ id: string }>
}

const guestCartKey = 'aikayun-guest-cart-v1'
const testPassword = 'Cart-Browser-Password-2026!'

async function noHorizontalOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 })
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }))
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport)
}

async function csrfToken(page: Page): Promise<string> {
  const response = await page.request.get('/api/v1/admin/auth/csrf')
  expect(response.status()).toBe(200)
  return (await response.json()).data.csrfToken as string
}

async function adminHeaders(page: Page) {
  return { origin: new URL(page.url()).origin, 'x-csrf-token': await csrfToken(page) }
}

async function createProduct(page: Page, name: string, price: string): Promise<Product> {
  const headers = await adminHeaders(page)
  const created = await page.request.post('/api/v1/admin/products', {
    headers,
    data: { name, description: '购物车浏览器验收商品。', productType: 'digital', defaultSku: { salePrice: price } },
  })
  expect(created.status()).toBe(201)
  let product = await created.json().then(body => body.data as Product)
  const active = await page.request.patch(`/api/v1/admin/products/${product.id}/lifecycle`, {
    headers: await adminHeaders(page),
    data: { expectedRevision: product.revision, status: 'active' },
  })
  expect(active.status()).toBe(200)
  product = (await active.json()).data as Product
  return product
}

async function deleteProduct(page: Page, product: Product): Promise<void> {
  const response = await page.request.delete(`/api/v1/admin/products/${product.id}`, {
    headers: await adminHeaders(page),
    data: { expectedRevision: product.revision },
  })
  expect(response.status()).toBe(200)
}

async function registerCustomer(page: Page, username: string): Promise<void> {
  await page.goto('/register')
  await expect(page.locator('[data-customer-register-ready="true"]')).toBeAttached()
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(testPassword)
  await page.getByLabel('确认密码').fill(testPassword)
  await page.getByRole('button', { name: '创建账户' }).click()
  await expect(page).toHaveURL(/\/account$/)
}

async function loginCustomer(page: Page, username: string): Promise<void> {
  await page.goto('/login')
  await expect(page.locator('[data-customer-login-ready="true"]')).toBeAttached()
  await page.getByLabel('用户名').fill(username)
  await page.locator('input[autocomplete="current-password"]').fill(testPassword)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).toHaveURL(/\/account$/)
}

async function openAccount(page: Page, username: string): Promise<void> {
  await page.getByRole('link', { name: `顾客账户，${username}` }).click()
  await expect(page.getByRole('heading', { name: '个人账户' })).toBeVisible()
}

async function addProductFromDetail(page: Page, product: Product, quantity: number): Promise<void> {
  const response = await page.goto(`/products/${product.id}`)
  expect(response?.status()).toBe(200)
  const html = await response?.text()
  expect(html).toContain(product.name)
  await expectClientMounted(page, '[data-storefront-ready="true"]')
  await expect(page.getByRole('heading', { name: product.name })).toBeVisible()
  await page.getByLabel('购买数量').fill(String(quantity))
  await page.getByRole('button', { name: '加入购物车' }).click()
  await expect(page.getByRole('status')).toContainText('已加入购物车。')
}

test('guest cart persists locally, merges safely into accounts, and stays private across sessions', async ({ page }) => {
  test.setTimeout(120_000)
  captureBrowserDiagnostics(page)
  const browserErrors: string[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('console', (message) => {
    if ((message.type() === 'error' && !/Failed to load resource: the server responded with a status of 401 \(Unauthorized\)/i.test(message.text()))
      || /hydration|mismatch/i.test(message.text())) browserErrors.push(message.text())
  })
  const productAName = `Cart商品A-${randomUUID().slice(0, 8)}`
  const productBName = `Cart商品B-${randomUUID().slice(0, 8)}`
  const firstUsername = `cart-${randomUUID().replaceAll('-', '').slice(0, 20)}`
  const secondUsername = `cart-${randomUUID().replaceAll('-', '').slice(0, 20)}`
  const createdProducts: Product[] = []

  await page.setViewportSize({ width: 390, height: 844 })
  const adminSessionToken = await createBrowserAdminSession()
  await page.context().addCookies([{
    name: 'aikayun_admin_session',
    value: adminSessionToken,
    url: new URL('/', process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin,
    httpOnly: true,
    sameSite: 'Lax',
  }])
  await page.goto('/admin/login')

  try {
    const productA = await createProduct(page, productAName, '19.90')
    createdProducts.push(productA)
    const productB = await createProduct(page, productBName, '25.00')
    createdProducts.push(productB)

    // Seed a server cart, then sign out so the browser builds a separate guest cart.
    await registerCustomer(page, firstUsername)
    await addProductFromDetail(page, productA, 1)
    await openAccount(page, firstUsername)
    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(page).toHaveURL('/')
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()
    await expect(page.getByText(productAName)).toHaveCount(0)

    await addProductFromDetail(page, productA, 2)
    // Immediate purchase quotes the requested SKU and quantity without changing local cart contents.
    const localBeforeBuy = await page.evaluate(key => localStorage.getItem(key), guestCartKey)
    await page.getByRole('button', { name: '立即购买' }).click()
    await expect(page.getByRole('heading', { name: '结算报价预览' })).toBeVisible()
    await expect(page.getByText('尚未创建订单')).toBeVisible()
    await expect(page.getByText('¥39.80').first()).toBeVisible()
    expect(await page.evaluate(key => localStorage.getItem(key), guestCartKey)).toBe(localBeforeBuy)
    await page.getByRole('link', { name: '返回购物车', exact: true }).click()
    await addProductFromDetail(page, productB, 1)
    const guestEnvelope = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), guestCartKey) as {
      version: number
      mergeId: string
      items: Array<{ skuId: string; quantity: number; [key: string]: unknown }>
      [key: string]: unknown
    }
    expect(Object.keys(guestEnvelope).sort()).toEqual(['items', 'mergeId', 'version'])
    expect(guestEnvelope.version).toBe(1)
    expect(guestEnvelope.items).toEqual([
      { skuId: productA.variants[0]!.id, quantity: 2 },
      { skuId: productB.variants[0]!.id, quantity: 1 },
    ])
    expect(guestEnvelope.items.every(item => Object.keys(item).sort().join(',') === 'quantity,skuId')).toBe(true)

    // Refresh preserves browser storage and the server re-quotes current product data.
    await page.goto('/cart')
    await page.reload()
    await expect(page.getByRole('heading', { name: productAName })).toBeVisible()
    await expect(page.getByRole('heading', { name: productBName })).toBeVisible()
    await expect(page.getByRole('link', { name: /购物车，3 件商品/ })).toBeVisible()

    // The selection checkbox is keyboard operable; selecting only A changes the quote.
    const selectB = page.getByRole('checkbox', { name: `选择${productBName}` })
    await selectB.focus()
    await page.keyboard.press('Space')
    await expect(selectB).not.toBeChecked()
    await expect(page.getByText('¥39.80').first()).toBeVisible()
    await page.getByRole('link', { name: '查看结算报价' }).click()
    await expect(page.getByRole('heading', { name: '结算报价预览' })).toBeVisible()
    await expect(page.getByRole('heading', { name: productAName })).toBeVisible()
    await expect(page.getByRole('heading', { name: productBName })).toHaveCount(0)
    await expect(page.getByText('尚未创建订单')).toBeVisible()
    await page.getByRole('link', { name: '返回购物车', exact: true }).click()

    for (const width of [320, 390, 768, 1440]) await noHorizontalOverflow(page, width)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '显示模式' }).click()
    await page.getByRole('option', { name: '深色' }).click()
    await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true)
    await page.reload()
    await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true)
    await page.getByRole('button', { name: '显示模式' }).click()
    await page.getByRole('option', { name: '浅色' }).click()
    await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('light'))).toBe(true)

    // Merge guest data into the existing account cart; clear local storage only after success.
    await loginCustomer(page, firstUsername)
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: productAName })).toBeVisible()
    await expect(page.getByRole('heading', { name: productBName })).toBeVisible()
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), guestCartKey)).toBeNull()
    await expect(page.getByText('¥84.70').first()).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: productAName })).toBeVisible()
    await expect(page.getByRole('heading', { name: productBName })).toBeVisible()

    const quantityControl = page.locator(`[aria-label="${productAName}购买数量"]`)
    await page.getByRole('button', { name: `增加${productAName}数量` }).click()
    await expect(quantityControl).toContainText('4')
    await page.getByRole('button', { name: `减少${productAName}数量` }).click()
    await expect(quantityControl).toContainText('3')
    const productBRow = page.getByRole('listitem').filter({ hasText: productBName })
    await productBRow.getByRole('button', { name: '移除' }).click()
    await expect(page.getByRole('heading', { name: productBName })).toHaveCount(0)
    await addProductFromDetail(page, productB, 1)
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: productBName })).toBeVisible()

    await openAccount(page, firstUsername)
    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(page).toHaveURL('/')
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()
    await expect(page.getByText(productAName)).toHaveCount(0)
    await expect(page.getByText(productBName)).toHaveCount(0)

    await registerCustomer(page, secondUsername)
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()
    await expect(page.getByText(productAName)).toHaveCount(0)
    await openAccount(page, secondUsername)
    await page.getByRole('button', { name: '退出登录' }).click()

    // The original account still owns its persisted cart after a later login.
    await loginCustomer(page, firstUsername)
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: productAName })).toBeVisible()
    await expect(page.getByRole('heading', { name: productBName })).toBeVisible()
    await page.getByRole('button', { name: '清空购物车' }).click()
    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()

    const orders = await page.request.post('/api/v1/orders', { data: {} })
    expect(orders.status()).toBe(404)
    await expectClientMounted(page, '[data-storefront-ready="true"]')
    expect(browserErrors).toEqual([])
  }
  finally {
    for (const product of createdProducts) await deleteProduct(page, product)
  }
})
