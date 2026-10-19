import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'
import { captureBrowserDiagnostics, expectClientMounted } from './browser-diagnostics'

type Product = {
  id: string
  name: string
  revision: number
  variants: Array<{ id: string }>
}

const guestCartKey = 'aikayun-guest-cart-v2'
const customerIdentityRevisionKey = 'aikayun-customer-identity-revision-v1'
const testPassword = 'Cart-Browser-Password-2026!'
let loginRequestSequence = 0
let quoteRequestSequence = 0

test.beforeEach(async ({ page }) => {
  const ip = `198.51.100.${(quoteRequestSequence++ % 250) + 1}`
  await page.route('**/api/v1/checkout/quote', route => route.continue({
    headers: { ...route.request().headers(), 'x-forwarded-for': ip },
  }))
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

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
  await withIsolatedCustomerAuthIp(page, '/api/v1/customer/auth/register', async () => {
    await page.getByRole('button', { name: '创建账户' }).click()
    await expect(page).toHaveURL(/\/account$/)
  })
}

async function loginCustomer(page: Page, username: string): Promise<void> {
  await page.goto('/login')
  await expect(page.locator('[data-customer-login-ready="true"]')).toBeAttached()
  await page.getByLabel('用户名').fill(username)
  await page.locator('input[autocomplete="current-password"]').fill(testPassword)
  await withIsolatedCustomerAuthIp(page, '/api/v1/customer/auth/login', async () => {
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/\/account$/)
  })
}

async function openAccount(page: Page, username: string): Promise<void> {
  await page.getByRole('link', { name: `顾客账户，${username}` }).click()
  await expect(page.getByRole('heading', { name: '个人账户' })).toBeVisible()
}

async function logoutCustomer(page: Page): Promise<void> {
  if (new URL(page.url()).pathname !== '/account') {
    await page.getByRole('link', { name: /^顾客账户，/u }).click()
  }
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL('/')
}

async function loginCustomerInApp(page: Page, username: string): Promise<void> {
  await page.getByRole('link', { name: '顾客登录' }).click()
  await expect(page).toHaveURL(/\/login$/u)
  await expect(page.locator('[data-customer-login-ready="true"]')).toBeAttached()
  await page.getByLabel('用户名').fill(username)
  await page.locator('input[autocomplete="current-password"]').fill(testPassword)
  await withIsolatedCustomerAuthIp(page, '/api/v1/customer/auth/login', async () => {
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/\/account$/u)
  })
}

async function withIsolatedCustomerAuthIp(page: Page, path: string, action: () => Promise<void>): Promise<void> {
  const ip = `192.0.2.${(loginRequestSequence++ % 250) + 1}`
  const routePath = `**${path}`
  const handler = (route: import('@playwright/test').Route) => route.continue({
    headers: { ...route.request().headers(), 'x-forwarded-for': ip },
  })
  await page.route(routePath, handler)
  try {
    await action()
  } finally {
    await page.unroute(routePath, handler)
  }
}

async function openCartInApp(page: Page): Promise<void> {
  await page.getByRole('link', { name: /^购物车，/u }).click()
  await expect(page).toHaveURL(/\/cart$/u)
}

async function attachBrowserAdmin(page: Page): Promise<void> {
  const adminSessionToken = await createBrowserAdminSession()
  await page.context().addCookies([{
    name: 'aikayun_admin_session',
    value: adminSessionToken,
    url: new URL('/', process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin,
    httpOnly: true,
    sameSite: 'Lax',
  }])
  await page.goto('/admin/login')
}

async function createEmptyCustomer(page: Page, username: string): Promise<void> {
  await registerCustomer(page, username)
  await logoutCustomer(page)
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

async function addProductFromDetailInApp(page: Page, product: Product, quantity: number): Promise<void> {
  if (new URL(page.url()).pathname !== '/') {
    await page.getByRole('link', { name: /AiKayun 数字商城/u }).first().click()
  }
  await expect(page.getByRole('heading', { name: '全部商品' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(product.name, 'u') }).click()
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
  await attachBrowserAdmin(page)

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
      unclaimedItems: Array<{ skuId: string; quantity: number; [key: string]: unknown }>
      pendingBatches: unknown[]
      [key: string]: unknown
    }
    expect(Object.keys(guestEnvelope).sort()).toEqual(['pendingBatches', 'unclaimedItems', 'version'])
    expect(guestEnvelope.version).toBe(2)
    expect(guestEnvelope.pendingBatches).toEqual([])
    expect(guestEnvelope.unclaimedItems).toEqual([
      { skuId: productA.variants[0]!.id, quantity: 2 },
      { skuId: productB.variants[0]!.id, quantity: 1 },
    ])
    expect(guestEnvelope.unclaimedItems.every(item => Object.keys(item).sort().join(',') === 'quantity,skuId')).toBe(true)

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

test('a delayed customer cart read cannot cross logout and account switches', async ({ page }) => {
  test.setTimeout(120_000)
  const productName = `Cart竞态读取-${randomUUID().slice(0, 8)}`
  const firstUsername = `read-a-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  const secondUsername = `read-b-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  let product: Product | undefined
  const firstResponseGate = deferred()
  const firstReadStarted = deferred()
  let cartReads = 0

  try {
    await attachBrowserAdmin(page)
    product = await createProduct(page, productName, '12.50')
    await registerCustomer(page, firstUsername)
    await addProductFromDetail(page, product, 3)
    await logoutCustomer(page)
    await createEmptyCustomer(page, secondUsername)

    await page.route('**/api/v1/customer/cart', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }
      cartReads += 1
      if (cartReads === 1) {
        const response = await route.fetch()
        firstReadStarted.resolve()
        await firstResponseGate.promise
        await route.fulfill({ response })
        return
      }
      await route.continue()
    })

    await loginCustomer(page, firstUsername)
    await firstReadStarted.promise
    await logoutCustomer(page)
    await openCartInApp(page)
    await expect(page.getByRole('heading', { name: productName })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '购物车，0 件商品' })).toBeVisible()

    await loginCustomerInApp(page, secondUsername)
    await openCartInApp(page)
    await expect(page.getByRole('heading', { name: productName })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '购物车，0 件商品' })).toBeVisible()

    firstResponseGate.resolve()
    await expect(page.getByRole('heading', { name: productName })).toHaveCount(0)
    await expect.poll(() => cartReads).toBeGreaterThanOrEqual(2)
    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()
    await expect(page.getByRole('link', { name: '购物车，0 件商品' })).toBeVisible()

    await logoutCustomer(page)
    await loginCustomerInApp(page, firstUsername)
    await openCartInApp(page)
    await expect(page.getByRole('heading', { name: productName })).toBeVisible()
    await expect(page.getByRole('link', { name: '购物车，3 件商品' })).toBeVisible()
    await page.getByRole('button', { name: '清空购物车' }).click()
    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()
  }
  finally {
    firstResponseGate.resolve()
    if (!page.isClosed()) {
      await page.unroute('**/api/v1/customer/cart')
      if (product) await deleteProduct(page, product)
    }
  }
})

test('a delayed guest merge preserves new local changes and cannot leak into a second account', async ({ page }) => {
  test.setTimeout(120_000)
  const productAName = `Cart合并A-${randomUUID().slice(0, 8)}`
  const productBName = `Cart合并B-${randomUUID().slice(0, 8)}`
  const firstUsername = `merge-a-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  const secondUsername = `merge-b-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  const products: Product[] = []
  const mergeResponseGate = deferred()
  const mergeStarted = deferred()
  let mergeRequests = 0
  let firstMergeBody: { mergeId: string; items: Array<{ skuId: string; quantity: number }> } | undefined

  try {
    await attachBrowserAdmin(page)
    const productA = await createProduct(page, productAName, '8.00')
    const productB = await createProduct(page, productBName, '11.00')
    products.push(productA, productB)
    await createEmptyCustomer(page, firstUsername)
    await createEmptyCustomer(page, secondUsername)

    await addProductFromDetail(page, productA, 1)
    const originalGuestCart = await page.evaluate(key => localStorage.getItem(key), guestCartKey)
    expect(originalGuestCart).not.toBeNull()
    expect(JSON.parse(originalGuestCart!).unclaimedItems).toEqual([{ skuId: productA.variants[0]!.id, quantity: 1 }])
    await openCartInApp(page)
    await expect(page.getByRole('heading', { name: productAName })).toBeVisible()
    await page.route('**/api/v1/customer/cart/merge', async (route) => {
      if (route.request().method() === 'POST' && mergeRequests === 0) {
        mergeRequests += 1
        firstMergeBody = route.request().postDataJSON() as typeof firstMergeBody
        const response = await route.fetch()
        mergeStarted.resolve()
        await mergeResponseGate.promise
        try {
          await route.fulfill({ response })
        }
        catch {
          // Navigation can cancel the waiting browser request after server acceptance.
        }
        return
      }
      if (route.request().method() === 'POST') mergeRequests += 1
      await route.continue()
    })

    await loginCustomerInApp(page, firstUsername)
    await expect.poll(() => mergeRequests, { timeout: 10_000 }).toBe(1)
    await mergeStarted.promise
    await logoutCustomer(page)
    await addProductFromDetailInApp(page, productB, 2)
    const changedGuestCart = await page.evaluate(key => localStorage.getItem(key), guestCartKey)
    expect(changedGuestCart).not.toBe(originalGuestCart)
    const separatedGuestCart = JSON.parse(changedGuestCart ?? 'null') as {
      unclaimedItems: Array<{ skuId: string; quantity: number }>
      pendingBatches: Array<{ mergeId: string; items: Array<{ skuId: string; quantity: number }> }>
    }
    expect(separatedGuestCart.pendingBatches).toHaveLength(1)
    expect(separatedGuestCart.pendingBatches[0]).toMatchObject({
      mergeId: firstMergeBody?.mergeId,
      items: [{ skuId: productA.variants[0]!.id, quantity: 1 }],
    })
    expect(separatedGuestCart.unclaimedItems).toEqual([{ skuId: productB.variants[0]!.id, quantity: 2 }])

    await loginCustomerInApp(page, secondUsername)
    await openCartInApp(page)
    mergeResponseGate.resolve()
    await expect(page.getByRole('heading', { name: productBName })).toBeVisible()
    await expect(page.getByRole('heading', { name: productAName })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '购物车，2 件商品' })).toBeVisible()

    await expect(page.getByRole('heading', { name: productBName })).toBeVisible()
    await expect(page.getByRole('heading', { name: productAName })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '购物车，2 件商品' })).toBeVisible()
    await expect.poll(() => mergeRequests).toBe(2)
    await expect.poll(async () => {
      const raw = await page.evaluate(key => localStorage.getItem(key), guestCartKey)
      return raw ? (JSON.parse(raw) as { pendingBatches: unknown[] }).pendingBatches.length : 0
    }).toBe(1)
    await expect(page.getByText('游客购物车已合并到当前账户。')).toHaveCount(0)

    await logoutCustomer(page)
    await openCartInApp(page)
    await expect(page.getByRole('link', { name: '购物车，0 件商品' })).toBeVisible()
    await loginCustomerInApp(page, firstUsername)
    await openCartInApp(page)
    await expect(page.getByRole('heading', { name: productAName })).toBeVisible()
    await expect(page.getByRole('heading', { name: productBName })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '购物车，1 件商品' })).toBeVisible()
  }
  finally {
    mergeResponseGate.resolve()
    if (!page.isClosed()) {
      await page.unroute('**/api/v1/customer/cart/merge')
      for (const product of products) await deleteProduct(page, product)
    }
  }
})

test('a failed guest merge retains local data and retries idempotently', async ({ page }) => {
  test.setTimeout(120_000)
  const productName = `Cart合并重试-${randomUUID().slice(0, 8)}`
  const username = `retry-${randomUUID().replaceAll('-', '').slice(0, 20)}`
  let product: Product | undefined
  const firstFailureDelivered = deferred()
  let mergeRequests = 0
  const mergeBodies: unknown[] = []

  try {
    await attachBrowserAdmin(page)
    product = await createProduct(page, productName, '5.25')
    await createEmptyCustomer(page, username)
    await addProductFromDetail(page, product, 2)
    const localCartBeforeLogin = await page.evaluate(key => localStorage.getItem(key), guestCartKey)
    expect(localCartBeforeLogin).not.toBeNull()
    expect(JSON.parse(localCartBeforeLogin!).unclaimedItems).toEqual([{ skuId: product.variants[0]!.id, quantity: 2 }])
    await openCartInApp(page)
    await expect(page.getByRole('heading', { name: productName })).toBeVisible()

    await page.route('**/api/v1/customer/cart/merge', async (route) => {
      if (route.request().method() === 'POST' && mergeRequests === 0) {
        mergeRequests += 1
        mergeBodies.push(route.request().postDataJSON())
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { code: 'TEMPORARY_ERROR', message: 'Retry this merge.' } }),
        })
        firstFailureDelivered.resolve()
        return
      }
      if (route.request().method() === 'POST') {
        mergeRequests += 1
        mergeBodies.push(route.request().postDataJSON())
      }
      await route.continue()
    })

    await loginCustomerInApp(page, username)
    await expect.poll(() => mergeRequests, { timeout: 10_000 }).toBe(1)
    await firstFailureDelivered.promise
    await openCartInApp(page)
    await expect(page.getByRole('alert')).toContainText('原始批次仍已保留')
    const pendingStore = JSON.parse(await page.evaluate(key => localStorage.getItem(key), guestCartKey) ?? 'null') as {
      unclaimedItems: unknown[]
      pendingBatches: Array<{ ownerId: string; mergeId: string; items: Array<{ skuId: string; quantity: number }> }>
    }
    expect(pendingStore.unclaimedItems).toEqual([])
    expect(pendingStore.pendingBatches).toHaveLength(1)
    expect(pendingStore.pendingBatches[0]?.items).toEqual([{ skuId: product.variants[0]!.id, quantity: 2 }])
    expect(JSON.parse(localCartBeforeLogin!).unclaimedItems).toEqual([{ skuId: product.variants[0]!.id, quantity: 2 }])

    await logoutCustomer(page)
    await page.reload()
    await loginCustomerInApp(page, username)
    await openCartInApp(page)
    await expect(page.getByRole('heading', { name: productName })).toBeVisible()
    await expect.poll(() => mergeRequests).toBe(2)
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), guestCartKey)).toBeNull()
    expect(mergeBodies[1]).toEqual(mergeBodies[0])
    await expect(page.getByRole('link', { name: '购物车，2 件商品' })).toBeVisible()
    await expect(page.getByRole('listitem').filter({ hasText: productName })).toContainText('2')
  }
  finally {
    if (!page.isClosed()) {
      await page.unroute('**/api/v1/customer/cart/merge')
      if (product) await deleteProduct(page, product)
    }
  }
})

test('a delayed add response cannot overwrite the newly logged-in customer cart', async ({ page }) => {
  test.setTimeout(120_000)
  const productAName = `Cart异步加入A-${randomUUID().slice(0, 8)}`
  const firstUsername = `add-a-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  const secondUsername = `add-b-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  const products: Product[] = []
  const addResponseGate = deferred()
  const addStarted = deferred()
  let addRequests = 0

  try {
    await attachBrowserAdmin(page)
    const productA = await createProduct(page, productAName, '9.00')
    products.push(productA)
    await createEmptyCustomer(page, secondUsername)
    await registerCustomer(page, firstUsername)

    await page.route('**/api/v1/customer/cart/items', async (route) => {
      if (route.request().method() === 'POST' && addRequests === 0) {
        addRequests += 1
        const response = await route.fetch()
        addStarted.resolve()
        await addResponseGate.promise
        await route.fulfill({ response })
        return
      }
      await route.continue()
    })

    await page.goto(`/products/${productA.id}`)
    await expectClientMounted(page, '[data-storefront-ready="true"]')
    await page.getByRole('button', { name: '加入购物车' }).click()
    await addStarted.promise
    await page.getByRole('link', { name: `顾客账户，${firstUsername}` }).click()
    await logoutCustomer(page)
    await loginCustomerInApp(page, secondUsername)
    await openCartInApp(page)
    addResponseGate.resolve()

    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()
    await expect(page.getByRole('heading', { name: productAName })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '购物车，0 件商品' })).toBeVisible()

    await logoutCustomer(page)
    await loginCustomerInApp(page, firstUsername)
    await openCartInApp(page)
    await expect(page.getByRole('heading', { name: productAName })).toBeVisible()
    await expect(page.getByRole('link', { name: '购物车，1 件商品' })).toBeVisible()
    await page.getByRole('button', { name: '清空购物车' }).click()
    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()
  }
  finally {
    addResponseGate.resolve()
    if (!page.isClosed()) {
      await page.unroute('**/api/v1/customer/cart/items')
      for (const product of products) await deleteProduct(page, product)
    }
  }
})

test('a committed guest merge remains owned by its original customer after reload', async ({ page }) => {
  test.setTimeout(120_000)
  const productName = `Cart持久归属-${randomUUID().slice(0, 8)}`
  const firstUsername = `claim-a-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  const secondUsername = `claim-b-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  const firstResponseGate = deferred()
  const firstMergeCommitted = deferred()
  const products: Product[] = []
  let mergeRequests = 0

  try {
    await attachBrowserAdmin(page)
    const product = await createProduct(page, productName, '7.50')
    products.push(product)
    await createEmptyCustomer(page, firstUsername)
    await createEmptyCustomer(page, secondUsername)
    await addProductFromDetail(page, product, 1)

    await page.route('**/api/v1/customer/cart/merge', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      mergeRequests += 1
      const response = await route.fetch()
      if (mergeRequests === 1) {
        expect(response.status()).toBe(200)
        firstMergeCommitted.resolve()
        await firstResponseGate.promise
      }
      try {
        await route.fulfill({ response })
      }
      catch {
        // A reload can cancel the browser side after the server has committed.
      }
    })

    await loginCustomer(page, firstUsername)
    await firstMergeCommitted.promise
    await logoutCustomer(page)
    await loginCustomerInApp(page, secondUsername)
    await openCartInApp(page)
    await expect(page.getByRole('link', { name: '购物车，0 件商品' })).toBeVisible()

    const secondCartRead = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v1/customer/cart'
      && response.status() === 200)
    await page.reload()
    const cartResponse = await secondCartRead
    const cartPayload = await cartResponse.json() as { data: { items: Array<{ skuId: string; quantity: number }> } }

    expect(cartPayload.data.items).toEqual([])
    expect(mergeRequests).toBe(1)
    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()
    await expect(page.getByRole('heading', { name: productName })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '购物车，0 件商品' })).toBeVisible()
  }
  finally {
    firstResponseGate.resolve()
    if (!page.isClosed()) {
      await page.unroute('**/api/v1/customer/cart/merge')
      for (const product of products) await deleteProduct(page, product)
    }
  }
})

test('a lost successful merge response retries the exact request after logout and reload', async ({ page }) => {
  test.setTimeout(120_000)
  const productName = `Cart响应丢失-${randomUUID().slice(0, 8)}`
  const username = `lost-${randomUUID().replaceAll('-', '').slice(0, 20)}`
  const firstResponseGate = deferred()
  const firstMergeCommitted = deferred()
  const firstResponseLost = deferred()
  const mergeBodies: unknown[] = []
  let mergeRequests = 0
  let product: Product | undefined

  try {
    await attachBrowserAdmin(page)
    product = await createProduct(page, productName, '6.25')
    await createEmptyCustomer(page, username)
    await addProductFromDetail(page, product, 2)

    await page.route('**/api/v1/customer/cart/merge', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      mergeRequests += 1
      mergeBodies.push(route.request().postDataJSON())
      if (mergeRequests === 1) {
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        firstMergeCommitted.resolve()
        await firstResponseGate.promise
        await route.abort('failed')
        firstResponseLost.resolve()
        return
      }
      await route.continue()
    })

    await loginCustomer(page, username)
    await firstMergeCommitted.promise
    firstResponseGate.resolve()
    await firstResponseLost.promise
    await logoutCustomer(page)
    await page.reload()
    await loginCustomerInApp(page, username)
    await expect.poll(() => mergeRequests).toBe(2)
    await openCartInApp(page)
    await expect(page.getByRole('heading', { name: productName })).toBeVisible()
    await expect(page.getByRole('link', { name: '购物车，2 件商品' })).toBeVisible()

    expect(mergeBodies).toHaveLength(2)
    expect(mergeBodies[1]).toEqual(mergeBodies[0])
    const response = await page.request.get('/api/v1/customer/cart')
    expect(response.status()).toBe(200)
    const cart = (await response.json()).data as { items: Array<{ skuId: string; quantity: number }> }
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0]).toMatchObject({ skuId: product.variants[0]!.id, quantity: 2 })
  }
  finally {
    firstResponseGate.resolve()
    if (!page.isClosed()) {
      await page.unroute('**/api/v1/customer/cart/merge')
      if (product) await deleteProduct(page, product)
    }
  }
})

test('guest cart add, quantity changes, removal, and clear persist only unclaimed items', async ({ page }) => {
  test.setTimeout(120_000)
  const productName = `Cart访客本地操作-${randomUUID().slice(0, 8)}`
  let product: Product | undefined

  try {
    await attachBrowserAdmin(page)
    product = await createProduct(page, productName, '4.00')
    await addProductFromDetail(page, product, 2)
    const store = JSON.parse(await page.evaluate(key => localStorage.getItem(key), guestCartKey) ?? 'null') as {
      unclaimedItems: Array<{ skuId: string; quantity: number }>
      pendingBatches: unknown[]
    }
    expect(store.unclaimedItems).toEqual([{ skuId: product.variants[0]!.id, quantity: 2 }])
    expect(store.pendingBatches).toEqual([])

    await openCartInApp(page)
    const quantity = page.locator(`[aria-label="${productName}购买数量"]`)
    await page.getByRole('button', { name: `增加${productName}数量` }).click()
    await expect(quantity).toContainText('3')
    await expect.poll(async () => {
      const raw = await page.evaluate(key => localStorage.getItem(key), guestCartKey)
      return raw ? (JSON.parse(raw) as typeof store).unclaimedItems[0]?.quantity : null
    }).toBe(3)
    await page.getByRole('button', { name: `减少${productName}数量` }).click()
    await expect(quantity).toContainText('2')
    await page.getByRole('listitem').filter({ hasText: productName }).getByRole('button', { name: '移除' }).click()
    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), guestCartKey)).toBeNull()

    await addProductFromDetail(page, product, 1)
    await openCartInApp(page)
    await page.getByRole('button', { name: '清空购物车' }).click()
    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), guestCartKey)).toBeNull()
    await expect(page.getByRole('link', { name: '购物车，0 件商品' })).toBeVisible()
  }
  finally {
    if (!page.isClosed() && product) await deleteProduct(page, product)
  }
})

test('two tabs keep a claimed batch bound to its account while the shared session changes', async ({ page }) => {
  test.setTimeout(120_000)
  const productName = `Cart双标签归属-${randomUUID().slice(0, 8)}`
  const firstUsername = `tab-a-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  const secondUsername = `tab-b-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  const firstResponseGate = deferred()
  const firstMergeCommitted = deferred()
  const firstResponseReleased = deferred()
  const secondResponseGate = deferred()
  const secondMergeCommitted = deferred()
  const secondResponseReleased = deferred()
  const products: Product[] = []
  const secondPage = await page.context().newPage()
  let firstMergeBody: unknown
  const secondMergeBodies: unknown[] = []
  let firstMergeRequests = 0
  let secondMergeRequests = 0

  try {
    await attachBrowserAdmin(page)
    const product = await createProduct(page, productName, '3.75')
    products.push(product)
    await createEmptyCustomer(page, firstUsername)
    await createEmptyCustomer(page, secondUsername)
    await addProductFromDetail(page, product, 1)
    await secondPage.goto('/')
    await expectClientMounted(secondPage, '[data-storefront-ready="true"]')

    await page.route('**/api/v1/customer/cart/merge', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      firstMergeRequests += 1
      firstMergeBody = route.request().postDataJSON()
      const response = await route.fetch()
      const responseStatus = response.status()
      const responseBody = responseStatus === 200 ? undefined : await response.text()
      expect(responseStatus, responseBody).toBe(200)
      firstMergeCommitted.resolve()
      await firstResponseGate.promise
      try {
        await route.fulfill({ response })
      }
      catch {
        // The old tab may have navigated after the shared identity changed.
      }
      firstResponseReleased.resolve()
    })
    await secondPage.route('**/api/v1/customer/cart/merge', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      secondMergeRequests += 1
      secondMergeBodies.push(route.request().postDataJSON())
      const response = await route.fetch()
      const responseStatus = response.status()
      const responseBody = responseStatus === 200 ? undefined : await response.text()
      expect(responseStatus, responseBody).toBe(200)
      if (secondMergeRequests === 1) {
        secondMergeCommitted.resolve()
        await secondResponseGate.promise
        try {
          await route.fulfill({ response })
        }
        catch {
          // The tab may switch identity while the accepted response is held.
        }
        secondResponseReleased.resolve()
        return
      }
      await route.fulfill({ response })
    })

    await loginCustomer(page, firstUsername)
    await firstMergeCommitted.promise
    const firstSession = await page.request.get('/api/customer/session').then(response => response.json())
    const firstCustomerId = firstSession.data.customer.id as string
    await expect(secondPage.getByRole('link', { name: `顾客账户，${firstUsername}` })).toBeVisible()
    await secondMergeCommitted.promise
    await logoutCustomer(secondPage)
    await secondPage.evaluate((revisionKey) => {
      const realm = window as Window & { __originalStorageSetItem?: typeof Storage.prototype.setItem }
      realm.__originalStorageSetItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === revisionKey) throw new DOMException('Storage is full', 'QuotaExceededError')
        return realm.__originalStorageSetItem!.call(this, key, value)
      }
    }, customerIdentityRevisionKey)
    await loginCustomerInApp(secondPage, secondUsername)
    await openCartInApp(secondPage)
    await expect(secondPage.getByRole('link', { name: '购物车，0 件商品' })).toBeVisible()
    await expect(page.getByRole('link', { name: `顾客账户，${secondUsername}` })).toBeVisible()
    await openCartInApp(page)
    await expect(page.getByRole('link', { name: '购物车，0 件商品' })).toBeVisible()
    expect(firstMergeRequests).toBe(1)
    expect(secondMergeRequests).toBe(1)

    const firstCustomerCartRead = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v1/customer/cart'
      && response.status() === 200)
    firstResponseGate.resolve()
    secondResponseGate.resolve()
    await Promise.all([firstResponseReleased.promise, secondResponseReleased.promise, firstCustomerCartRead])
    expect(secondMergeRequests).toBe(1)

    const stored = JSON.parse(await page.evaluate(key => localStorage.getItem(key), guestCartKey) ?? 'null') as {
      pendingBatches: Array<{ ownerId: string; mergeId: string }>
    }
    expect(stored.pendingBatches).toHaveLength(1)
    expect(stored.pendingBatches[0]?.ownerId).toBe(firstCustomerId)
    await expect(page.getByRole('link', { name: '购物车，0 件商品' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()
    await expect(secondPage.getByRole('heading', { name: productName })).toHaveCount(0)

    await secondPage.evaluate(() => {
      const realm = window as Window & { __originalStorageSetItem?: typeof Storage.prototype.setItem }
      if (realm.__originalStorageSetItem) Storage.prototype.setItem = realm.__originalStorageSetItem
    })
    await logoutCustomer(secondPage)
    await loginCustomerInApp(secondPage, firstUsername)
    await openCartInApp(secondPage)
    await expect(secondPage.getByRole('heading', { name: productName })).toBeVisible()
    await expect.poll(() => secondMergeBodies.length).toBe(2)
    expect(secondMergeBodies[1]).toEqual(firstMergeBody)
    await expect(secondPage.getByRole('link', { name: '购物车，1 件商品' })).toBeVisible()
    const cart = await secondPage.request.get('/api/v1/customer/cart').then(response => response.json())
    expect(cart.data.items).toHaveLength(1)
    expect(cart.data.items[0]).toMatchObject({ skuId: product.variants[0]!.id, quantity: 1 })
  }
  finally {
    firstResponseGate.resolve()
    secondResponseGate.resolve()
    if (!page.isClosed()) await page.unroute('**/api/v1/customer/cart/merge')
    if (!secondPage.isClosed()) {
      await secondPage.unroute('**/api/v1/customer/cart/merge')
      await secondPage.close()
    }
    for (const product of products) await deleteProduct(page, product)
  }
})

test('a failed localStorage write never sends an unpersisted merge request', async ({ page }) => {
  test.setTimeout(120_000)
  const productName = `Cart本地存储失败-${randomUUID().slice(0, 8)}`
  const username = `storage-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  let product: Product | undefined
  let mergeRequests = 0

  try {
    await attachBrowserAdmin(page)
    product = await createProduct(page, productName, '2.00')
    await createEmptyCustomer(page, username)
    await page.addInitScript((key) => {
      const originalSetItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (storageKey: string, value: string) {
        if (storageKey === key) throw new DOMException('Storage is full', 'QuotaExceededError')
        return originalSetItem.call(this, storageKey, value)
      }
    }, guestCartKey)
    await page.route('**/api/v1/customer/cart/merge', async (route) => {
      if (route.request().method() === 'POST') mergeRequests += 1
      await route.continue()
    })

    await page.goto(`/products/${product.id}`)
    await expectClientMounted(page, '[data-storefront-ready="true"]')
    await page.getByLabel('购买数量').fill('1')
    await page.getByRole('button', { name: '加入购物车' }).click()
    await expect(page.getByRole('status')).toContainText('无法写入浏览器存储')
    await loginCustomer(page, username)
    await openCartInApp(page)
    await expect(page.getByRole('link', { name: '购物车，0 件商品' })).toBeVisible()
    expect(mergeRequests).toBe(0)
    expect(await page.evaluate(key => localStorage.getItem(key), guestCartKey)).toBeNull()
  }
  finally {
    if (!page.isClosed()) {
      await page.unroute('**/api/v1/customer/cart/merge')
      if (product) await deleteProduct(page, product)
    }
  }
})
