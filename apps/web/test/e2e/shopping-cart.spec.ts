import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'
import { captureBrowserDiagnostics, expectClientMounted } from './browser-diagnostics'

type Product = {
  id: string
  name: string
  revision: number
  variants: Array<{ id: string; skuCode?: string }>
}

type CustomerPolicy = {
  requireEmail: boolean
  requirePhone: boolean
  guestCheckoutEnabled: boolean
  guestFreeClaimEnabled: boolean
  unpaidOrderTimeoutMinutes: 5 | 15 | 30
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
  const overflowingElements = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('body *')).map((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        element,
        tag: element.tagName,
        className: typeof element.className === 'string' ? element.className.slice(0, 100) : '',
        text: element.textContent?.trim().replace(/\s+/gu, ' ').slice(0, 56),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        position: style.position,
      }
    }).filter(element => element.right > document.documentElement.clientWidth + 1
      && element.position !== 'fixed')
    return candidates.filter(candidate => !Array.from(candidate.element.children).some((child) => {
      const rect = child.getBoundingClientRect()
      return rect.right > document.documentElement.clientWidth + 1
    })).map(({ element: _element, ...details }) => details).slice(0, 8)
  })
  expect(dimensions.page, `Horizontal overflow at ${width}px: ${JSON.stringify(overflowingElements)}`)
    .toBeLessThanOrEqual(dimensions.viewport)
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
  const latest = await page.request.get(`/api/v1/admin/products/${product.id}`)
  expect(latest.status()).toBe(200)
  const currentRevision = (await latest.json()).data.revision as number
  const response = await page.request.delete(`/api/v1/admin/products/${product.id}`, {
    headers: await adminHeaders(page),
    data: { expectedRevision: currentRevision },
  })
  expect(response.status()).toBe(200)
}

async function makeProductPurchasable(page: Page, product: Product): Promise<void> {
  const response = await page.request.get(`/api/v1/admin/products/${product.id}/inventory`)
  expect(response.status()).toBe(200)
  const inventory = (await response.json()).data as {
    productRevision: number
    variants: Array<{ skuId: string; skuRevision: number; inventoryRevision: number }>
  }
  const variant = inventory.variants.find(row => row.skuId === product.variants[0]?.id)
  expect(variant).toBeTruthy()
  const mode = await page.request.put(`/api/v1/admin/products/${product.id}/variants/${variant!.skuId}/inventory-mode`, {
    headers: await adminHeaders(page),
    data: {
      expectedRevision: inventory.productRevision,
      expectedSkuRevision: variant!.skuRevision,
      expectedInventoryRevision: variant!.inventoryRevision,
      inventoryMode: 'unlimited',
    },
  })
  expect(mode.status()).toBe(200)
  const fulfillment = await page.request.put(`/api/v1/admin/products/${product.id}/variants/${variant!.skuId}/manual-fulfillment`, {
    headers: await adminHeaders(page),
    data: { enabled: true },
  })
  expect(fulfillment.status()).toBe(200)
}

async function setGuestCheckout(page: Page, enabled: boolean): Promise<CustomerPolicy> {
  const current = await page.request.get('/api/v1/admin/storefront/customer-policy')
  expect(current.status()).toBe(200)
  const response = (await current.json()).data as CustomerPolicy & { updatedAt: string }
  const previous: CustomerPolicy = {
    requireEmail: response.requireEmail,
    requirePhone: response.requirePhone,
    guestCheckoutEnabled: response.guestCheckoutEnabled,
    guestFreeClaimEnabled: response.guestFreeClaimEnabled,
    unpaidOrderTimeoutMinutes: response.unpaidOrderTimeoutMinutes,
  }
  const updated = await page.request.put('/api/v1/admin/storefront/customer-policy', {
    headers: await adminHeaders(page),
    data: { ...previous, guestCheckoutEnabled: enabled },
  })
  expect(updated.status()).toBe(200)
  return previous
}

async function restoreCustomerPolicy(page: Page, policy: CustomerPolicy): Promise<void> {
  const restored = await page.request.put('/api/v1/admin/storefront/customer-policy', {
    headers: await adminHeaders(page),
    data: policy,
  })
  expect(restored.status()).toBe(200)
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
  test.setTimeout(180_000)
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
  let originalPolicy: CustomerPolicy | undefined

  await page.setViewportSize({ width: 390, height: 844 })
  await attachBrowserAdmin(page)

  try {
    originalPolicy = await setGuestCheckout(page, true)
    const productA = await createProduct(page, productAName, '19.90')
    createdProducts.push(productA)
    await makeProductPurchasable(page, productA)
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
    await expect(page.getByRole('heading', { name: '确认订单' })).toBeVisible()
    await expect(page.getByText('下单前会重新验证')).toBeVisible()
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
    await expect(page.getByRole('heading', { name: '确认订单' })).toBeVisible()
    await expect(page.getByRole('heading', { name: productAName })).toBeVisible()
    await expect(page.getByRole('heading', { name: productBName })).toHaveCount(0)
    await expect(page.getByText('下单前会重新验证')).toBeVisible()
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

    // Signed-in checkout carries only an opaque selection ID in the URL;
    // the exact line references survive refresh in same-tab session storage.
    await page.getByRole('checkbox', { name: `选择${productBName}` }).uncheck()
    await page.getByRole('link', { name: '查看结算报价' }).click()
    await expect(page).toHaveURL(/\/checkout\?intent=[0-9a-f-]{36}$/u)
    expect(new URL(page.url()).searchParams.has('items')).toBe(false)
    const selectionKeys = await page.evaluate(() => Object.keys(sessionStorage)
      .filter(key => key.startsWith('aikayun-checkout-selections-v2')))
    expect(selectionKeys).toEqual(['aikayun-checkout-selections-v2'])
    await page.reload()
    await expect(page.getByRole('heading', { name: '确认订单' })).toBeVisible()
    await expect(page.getByRole('heading', { name: productAName })).toBeVisible()
    await page.getByRole('link', { name: '返回购物车', exact: true }).click()

    const cartBeforeLineMutation = await page.request.get('/api/v1/customer/cart')
    expect(cartBeforeLineMutation.status()).toBe(200)
    const cartLines = (await cartBeforeLineMutation.json()).data as { items: Array<{ lineId: string; skuId: string }> }
    const productALineId = cartLines.items.find(item => item.skuId === productA.variants[0]!.id)?.lineId
    expect(productALineId).toMatch(/^[0-9a-f-]{36}$/u)

    const quantityControl = page.locator(`[aria-label="${productAName}购买数量"]`)
    const linePatch = page.waitForRequest(request => request.method() === 'PATCH'
      && new URL(request.url()).pathname === `/api/v1/customer/cart/lines/${productALineId}`)
    await page.getByRole('button', { name: `增加${productAName}数量` }).click()
    expect((await linePatch).postDataJSON()).toMatchObject({ quantity: 4, expectedLineRevision: expect.any(Number) })
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
    if (originalPolicy) await restoreCustomerPolicy(page, originalPolicy)
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

test('guest v3 quote folds equal-content lines without changing old pending batches', async ({ page }) => {
  test.setTimeout(120_000)
  const productName = `Cart分行折叠-${randomUUID().slice(0, 8)}`
  let product: Product | undefined
  try {
    await attachBrowserAdmin(page)
    product = await createProduct(page, productName, '4.00')
    const skuId = product.variants[0]!.id
    const firstLineId = randomUUID()
    const secondLineId = randomUUID()
    const legacyPending = {
      ownerId: randomUUID(), mergeId: randomUUID(), items: [{ skuId, quantity: 1 }],
    }
    await page.goto('/cart')
    await page.evaluate(({ key, store }) => localStorage.setItem(key, JSON.stringify(store)), {
      key: guestCartKey,
      store: {
        version: 3,
        unclaimedItems: [
          { lineId: firstLineId, skuId, quantity: 1 },
          { lineId: secondLineId, skuId, quantity: 2 },
        ],
        pendingBatches: [legacyPending],
      },
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: productName })).toHaveCount(1)
    const quantityControl = page.locator(`[aria-label="${productName}购买数量"]`)
    await expect(quantityControl).toContainText('3')
    await expect.poll(async () => {
      const raw = await page.evaluate(key => localStorage.getItem(key), guestCartKey)
      const stored = JSON.parse(raw ?? 'null') as { unclaimedItems: Array<{ lineId: string; quantity: number }> }
      return stored.unclaimedItems.length
    }).toBe(1)
    const folded = JSON.parse(await page.evaluate(key => localStorage.getItem(key), guestCartKey) ?? 'null') as {
      version: number
      unclaimedItems: Array<{ lineId: string; skuId: string; quantity: number }>
      pendingBatches: unknown[]
    }
    expect(folded.version).toBe(3)
    expect(folded.unclaimedItems).toEqual([{
      lineId: [firstLineId, secondLineId].sort()[0], skuId, quantity: 3,
    }])
    expect(folded.pendingBatches).toEqual([legacyPending])

    await page.getByRole('button', { name: `增加${productName}数量` }).click()
    await expect(quantityControl).toContainText('4')
    await page.getByRole('listitem').filter({ hasText: productName }).getByRole('button', { name: '移除' }).click()
    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()
    const afterRemove = JSON.parse(await page.evaluate(key => localStorage.getItem(key), guestCartKey) ?? 'null') as {
      unclaimedItems: unknown[]; pendingBatches: unknown[]
    }
    expect(afterRemove.unclaimedItems).toEqual([])
    expect(afterRemove.pendingBatches).toEqual([legacyPending])
  } finally {
    if (product) await deleteProduct(page, product)
  }
})

test('v2 checkout never reuses an unresolved intent across account or guest-session changes', async ({ page }) => {
  test.setTimeout(120_000)
  const productName = `Cart未决归属-${randomUUID().slice(0, 8)}`
  let product: Product | undefined
  let orderPosts = 0
  try {
    await attachBrowserAdmin(page)
    product = await createProduct(page, productName, '4.00')
    const line = { lineId: randomUUID(), skuId: product.variants[0]!.id, quantity: 1 }
    const selectionId = randomUUID()
    const fingerprint = JSON.stringify([line])
    await page.goto('/cart')
    await page.route('**/api/v1/checkout/orders', async (route) => {
      if (route.request().method() === 'POST') orderPosts += 1
      await route.continue()
    })
    await page.evaluate(({ selectionId, fingerprint, line }) => {
      sessionStorage.setItem('aikayun-checkout-selections-v2', JSON.stringify([{
        id: selectionId, fingerprint, items: [line],
      }]))
      // A tab-local v2 request from the previous build migrates without
      // changing its key, quote token, or request body.
      sessionStorage.setItem('aikayun-order-intents-v2', JSON.stringify([{
        ownerId: crypto.randomUUID(), fingerprint, idempotencyKey: crypto.randomUUID(),
        quoteToken: '0'.repeat(64), items: [line],
      }]))
    }, { selectionId, fingerprint, line })
    await page.goto(`/checkout?intent=${selectionId}`)
    await expect(page.getByRole('alert').filter({ hasText: '已有其他账户或游客会话的未确认订单' })).toBeVisible()
    expect(orderPosts).toBe(0)
    const migrated = await page.evaluate(() => ({
      local: JSON.parse(localStorage.getItem('aikayun-order-intents-v2') ?? 'null'),
      old: sessionStorage.getItem('aikayun-order-intents-v2'),
    })) as { local: Array<{ state: string; idempotencyKey: string }>; old: string | null }
    expect(migrated.local).toHaveLength(1)
    expect(migrated.local[0]?.state).toBe('pending')
    expect(migrated.old).toBeNull()

    await page.evaluate((fingerprint) => {
      localStorage.setItem('aikayun-order-intents-v2', JSON.stringify([{
        state: 'pending', ownerId: `guest:${crypto.randomUUID()}`, fingerprint,
        selectionId: null, idempotencyKey: crypto.randomUUID(),
        quoteToken: '0'.repeat(64), items: JSON.parse(sessionStorage.getItem('aikayun-checkout-selections-v2')!)[0].items,
      }]))
    }, fingerprint)
    await page.reload()
    await expect(page.getByRole('alert').filter({ hasText: '已有其他账户或游客会话的未确认订单' })).toBeVisible()
    expect(orderPosts).toBe(0)
  } finally {
    await page.unroute('**/api/v1/checkout/orders')
    if (product) await deleteProduct(page, product)
  }
})

test('v2 lost order acknowledgment replays the same key after closing its tab and retains the completed receipt', async ({ page }) => {
  test.setTimeout(150_000)
  const productName = `Cart订单恢复-${randomUUID().slice(0, 8)}`
  let product: Product | undefined
  let originalPolicy: CustomerPolicy | undefined
  const selectionId = randomUUID()
  const firstCommitted = deferred()
  const postKeys: string[] = []
  let committedOrderId: string | null = null
  let secondPage: Page | undefined
  let thirdPage: Page | undefined
  try {
    await attachBrowserAdmin(page)
    originalPolicy = await setGuestCheckout(page, true)
    product = await createProduct(page, productName, '4.00')
    await makeProductPurchasable(page, product)
    const line = { lineId: randomUUID(), skuId: product.variants[0]!.id, quantity: 1 }
    const fingerprint = JSON.stringify([line])
    await page.goto('/cart')
    await page.evaluate(({ selectionId, fingerprint, line }) => {
      sessionStorage.setItem('aikayun-checkout-selections-v2', JSON.stringify([{
        id: selectionId, fingerprint, items: [line],
      }]))
    }, { selectionId, fingerprint, line })
    const checkoutUrl = `/checkout?intent=${selectionId}`
    await page.goto(checkoutUrl)
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    await page.route('**/api/v1/checkout/orders', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      postKeys.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey)
      const response = await route.fetch()
      expect([200, 201]).toContain(response.status())
      committedOrderId = ((await response.json()) as { data: { order: { id: string } } }).data.order.id
      firstCommitted.resolve()
      await route.abort('failed')
    })
    await page.getByRole('button', { name: '提交订单' }).click()
    await firstCommitted.promise
    await expect(page.getByRole('alert').filter({ hasText: '服务暂时无法处理此请求' })).toBeVisible()
    const pending = JSON.parse(await page.evaluate(() => localStorage.getItem('aikayun-order-intents-v2')) ?? 'null') as Array<{
      state: string; ownerId: string; idempotencyKey: string; items: unknown[]; selectionId: string
    }>
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ state: 'pending', selectionId, items: [line] })
    expect(pending[0]?.ownerId).toMatch(/^guest:[0-9a-f-]{36}$/u)
    expect(JSON.stringify(pending)).not.toContain(productName)
    expect(postKeys).toEqual([pending[0]!.idempotencyKey])

    await page.close()
    secondPage = await page.context().newPage()
    const secondSelectionId = randomUUID()
    await secondPage.route('**/api/v1/checkout/orders', async (route) => {
      if (route.request().method() === 'POST') postKeys.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey)
      await route.continue()
    })
    await secondPage.goto('/cart')
    await secondPage.evaluate(({ secondSelectionId, line }) => {
      sessionStorage.setItem('aikayun-checkout-selections-v2', JSON.stringify([{
        id: secondSelectionId, fingerprint: JSON.stringify([line]), items: [line],
      }]))
    }, { secondSelectionId, line })
    await secondPage.goto(`/checkout?intent=${secondSelectionId}`)
    await expect(secondPage).toHaveURL(new RegExp(`/orders/${committedOrderId}$`, 'u'))
    expect(postKeys).toEqual([pending[0]!.idempotencyKey, pending[0]!.idempotencyKey])
    const completed = JSON.parse(await secondPage.evaluate(() => localStorage.getItem('aikayun-order-intents-v2')) ?? 'null') as Array<{
      state: string; orderId: string; idempotencyKey: string; items?: unknown; quoteToken?: unknown
    }>
    expect(completed).toEqual([expect.objectContaining({
      state: 'completed', orderId: committedOrderId, idempotencyKey: pending[0]!.idempotencyKey,
    })])
    expect(completed[0]).not.toHaveProperty('items')
    expect(completed[0]).not.toHaveProperty('quoteToken')

    await secondPage.goto(`/checkout?intent=${secondSelectionId}`)
    await expect(secondPage).toHaveURL(new RegExp(`/orders/${committedOrderId}$`, 'u'))
    expect(postKeys).toHaveLength(2)

    // The first tab's session selection has disappeared; its original URL
    // still resolves the receipt and cannot create a new key.
    thirdPage = await page.context().newPage()
    await thirdPage.route('**/api/v1/checkout/orders', async (route) => {
      if (route.request().method() === 'POST') postKeys.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey)
      await route.continue()
    })
    await thirdPage.goto(checkoutUrl)
    await expect(thirdPage).toHaveURL(new RegExp(`/orders/${committedOrderId}$`, 'u'))
    expect(postKeys).toHaveLength(2)
  } finally {
    const cleanupPage = thirdPage ?? secondPage ?? page
    // A real order now references this product; the isolated E2E database is
    // reset on the next run and removed after this focused verification.
    if (originalPolicy) await restoreCustomerPolicy(cleanupPage, originalPolicy)
    await secondPage?.close()
    await thirdPage?.close()
  }
})

test('a stale checkout tab follows another tab’s completed v2 receipt without a new order key', async ({ page }) => {
  test.setTimeout(150_000)
  const productName = `Cart完成回执-${randomUUID().slice(0, 8)}`
  let product: Product | undefined
  let originalPolicy: CustomerPolicy | undefined
  let confirmingPage: Page | undefined
  const postKeys: string[] = []
  try {
    await attachBrowserAdmin(page)
    originalPolicy = await setGuestCheckout(page, true)
    product = await createProduct(page, productName, '4.00')
    await makeProductPurchasable(page, product)
    const line = { lineId: randomUUID(), skuId: product.variants[0]!.id, quantity: 1 }
    const selectionId = randomUUID()
    const checkoutUrl = `/checkout?intent=${selectionId}`
    await page.goto('/cart')
    await page.evaluate(({ selectionId, line }) => sessionStorage.setItem('aikayun-checkout-selections-v2', JSON.stringify([{
      id: selectionId, fingerprint: JSON.stringify([line]), items: [line],
    }])), { selectionId, line })
    await page.goto(checkoutUrl)
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    await page.route('**/api/v1/checkout/orders', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      postKeys.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey)
      const response = await route.fetch()
      expect([200, 201]).toContain(response.status())
      await route.abort('failed')
    })
    await page.getByRole('button', { name: '提交订单' }).click()
    await expect(page.getByRole('alert').filter({ hasText: '服务暂时无法处理此请求' })).toBeVisible()
    expect(postKeys).toHaveLength(1)

    confirmingPage = await page.context().newPage()
    await confirmingPage.route('**/api/v1/checkout/orders', async (route) => {
      if (route.request().method() === 'POST') postKeys.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey)
      await route.continue()
    })
    await confirmingPage.goto(checkoutUrl)
    await expect(confirmingPage).toHaveURL(/\/orders\/[0-9a-f-]{36}$/u)
    const originalOrderUrl = new URL(confirmingPage.url()).pathname
    await expect(page).toHaveURL(new RegExp(`${originalOrderUrl}$`, 'u'))
    expect(postKeys).toEqual([postKeys[0], postKeys[0]])

    await page.goto(checkoutUrl)
    await expect(page).toHaveURL(new RegExp(`${originalOrderUrl}$`, 'u'))
    expect(postKeys).toHaveLength(2)
  } finally {
    if (originalPolicy) await restoreCustomerPolicy(confirmingPage ?? page, originalPolicy)
    await confirmingPage?.close()
  }
})

test('a fresh cart checkout can buy the same line again while older selection URLs stay bound to their orders', async ({ page }) => {
  test.setTimeout(150_000)
  const productName = `Cart正常复购-${randomUUID().slice(0, 8)}`
  let product: Product | undefined
  let originalPolicy: CustomerPolicy | undefined
  const orderKeys: string[] = []
  try {
    await attachBrowserAdmin(page)
    originalPolicy = await setGuestCheckout(page, true)
    product = await createProduct(page, productName, '4.00')
    await makeProductPurchasable(page, product)
    const line = { lineId: randomUUID(), skuId: product.variants[0]!.id, quantity: 1 }
    await page.goto('/cart')
    await page.evaluate(({ guestCartKey, line }) => localStorage.setItem(guestCartKey, JSON.stringify({
      version: 3, unclaimedItems: [line], pendingBatches: [],
    })), { guestCartKey, line })
    await page.route('**/api/v1/checkout/orders', async (route) => {
      if (route.request().method() === 'POST') {
        orderKeys.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey)
      }
      await route.continue()
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: productName })).toBeVisible()
    await page.getByRole('link', { name: '查看结算报价' }).click()
    await expect(page).toHaveURL(/\/checkout\?intent=[0-9a-f-]{36}$/u)
    const firstCheckoutUrl = page.url()
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    await page.getByRole('button', { name: '提交订单' }).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/u)
    const firstOrderUrl = page.url()

    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: productName })).toBeVisible()
    await page.getByRole('link', { name: '查看结算报价' }).click()
    await expect(page).toHaveURL(/\/checkout\?intent=[0-9a-f-]{36}$/u)
    const secondCheckoutUrl = page.url()
    expect(secondCheckoutUrl).not.toBe(firstCheckoutUrl)
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    await page.getByRole('button', { name: '提交订单' }).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/u)
    expect(page.url()).not.toBe(firstOrderUrl)
    expect(orderKeys).toHaveLength(2)
    expect(orderKeys[1]).not.toBe(orderKeys[0])

    await page.goto(firstCheckoutUrl)
    await expect(page).toHaveURL(firstOrderUrl)
    expect(orderKeys).toHaveLength(2)

    // Terminal receipts from the previous guest session do not block a new
    // guest's explicit cart checkout for the same stable purchase line.
    await page.context().clearCookies({ name: 'aikayun_guest_order_session' })
    await page.goto('/cart')
    await page.getByRole('link', { name: '查看结算报价' }).click()
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    await page.getByRole('button', { name: '提交订单' }).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/u)
    expect(orderKeys).toHaveLength(3)
    expect(new Set(orderKeys).size).toBe(3)

    await page.evaluate(() => {
      const key = 'aikayun-order-intents-v2'
      const receipts = JSON.parse(localStorage.getItem(key) ?? '[]') as Array<{ fingerprint: string }>
      const fingerprint = receipts[0]!.fingerprint
      localStorage.setItem(key, JSON.stringify([...receipts, {
        state: 'rejected', ownerId: `guest:${crypto.randomUUID()}`, fingerprint,
        selectionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
        quoteToken: '0'.repeat(64), items: JSON.parse(fingerprint),
      }]))
    })
    await page.goto('/cart')
    await page.getByRole('link', { name: '查看结算报价' }).click()
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    await page.getByRole('button', { name: '提交订单' }).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/u)
    expect(orderKeys).toHaveLength(4)
    expect(new Set(orderKeys).size).toBe(4)
  } finally {
    if (originalPolicy) await restoreCustomerPolicy(page, originalPolicy)
  }
})

test('old guest cart rows upgrade before checkout while claimed v1 batches retain their original request', async ({ page }) => {
  test.setTimeout(150_000)
  const productName = `Cart旧版结算-${randomUUID().slice(0, 8)}`
  let product: Product | undefined
  let originalPolicy: CustomerPolicy | undefined
  let submittedBody: unknown = null
  try {
    await attachBrowserAdmin(page)
    originalPolicy = await setGuestCheckout(page, true)
    product = await createProduct(page, productName, '4.00')
    await makeProductPurchasable(page, product)
    const originalBatch = {
      ownerId: randomUUID(), mergeId: randomUUID(), items: [{ skuId: randomUUID(), quantity: 2 }],
    }
    await page.goto('/cart')
    await page.evaluate(({ guestCartKey, skuId, originalBatch }) => localStorage.setItem(guestCartKey, JSON.stringify({
      version: 2, unclaimedItems: [{ skuId, quantity: 1 }], pendingBatches: [originalBatch],
    })), { guestCartKey, skuId: product.variants[0]!.id, originalBatch })
    await page.route('**/api/v1/checkout/orders', async (route) => {
      if (route.request().method() === 'POST') submittedBody = route.request().postDataJSON()
      await route.continue()
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: productName })).toBeVisible()
    await page.getByRole('link', { name: '查看结算报价' }).click()
    await expect(page).toHaveURL(/\/checkout\?intent=[0-9a-f-]{36}$/u)
    expect(new URL(page.url()).searchParams.has('items')).toBe(false)
    const upgraded = JSON.parse(await page.evaluate(key => localStorage.getItem(key), guestCartKey) ?? 'null') as {
      version: number; unclaimedItems: Array<{ lineId: string; skuId: string; quantity: number }>
      pendingBatches: unknown[]
    }
    expect(upgraded.version).toBe(3)
    expect(upgraded.unclaimedItems).toEqual([{
      lineId: expect.stringMatching(/^[0-9a-f-]{36}$/u), skuId: product.variants[0]!.id, quantity: 1,
    }])
    expect(upgraded.pendingBatches).toEqual([originalBatch])
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    await page.getByRole('button', { name: '提交订单' }).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/u)
    expect(submittedBody).toMatchObject({ version: 2, items: upgraded.unclaimedItems })
  } finally {
    if (originalPolicy) await restoreCustomerPolicy(page, originalPolicy)
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

test('purchase limits save by product and SKU, prompt guests to log in, and fit narrow screens', async ({ page }) => {
  test.setTimeout(120_000)
  captureBrowserDiagnostics(page)
  const productName = `购买限制浏览器验收-${randomUUID().slice(0, 8)}`
  let product: Product | undefined

  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await attachBrowserAdmin(page)
    product = await createProduct(page, productName, '3.25')
    await page.goto(`/admin/products/${product.id}`)
    await expect(page.getByRole('heading', { name: productName })).toBeVisible()

    const productLimits = page.locator('#purchase-limits')
    await productLimits.getByLabel('每账号累计最多购买').fill('5')
    await productLimits.getByLabel('每账号滚动 24 小时最多购买').fill('4')
    await productLimits.getByRole('button', { name: '保存商品限制' }).click()
    await expect(productLimits.getByRole('status')).toContainText('新报价立即使用此规则')

    const skuCode = product.variants[0]?.skuCode
    expect(skuCode).toBeTruthy()
    const skuRow = page.locator('#variants li').filter({ hasText: skuCode! })
    const skuDetails = skuRow.locator('details')
    await skuDetails.locator('summary').click()
    await skuDetails.getByLabel('每账号累计最多购买').fill('2')
    await skuDetails.getByLabel('每账号滚动 24 小时最多购买').fill('1')
    await skuDetails.getByRole('button', { name: '保存此 SKU 限制' }).click()
    await expect(skuDetails.getByRole('status')).toContainText('新报价立即使用此规则')

    const adminProduct = await page.request.get(`/api/v1/admin/products/${product.id}`).then(response => response.json()).then(body => body.data)
    expect(adminProduct.purchaseLimits).toMatchObject({ lifetime: 5, rolling24Hours: 4 })
    expect(adminProduct.variants.find((variant: { id: string }) => variant.id === product!.variants[0]!.id).purchaseLimits)
      .toMatchObject({ lifetime: 2, rolling24Hours: 1 })

    await page.goto(`/products/${product.id}`)
    await expectClientMounted(page, '[data-storefront-ready="true"]')
    await expect(page.getByRole('heading', { name: productName })).toBeVisible()
    await expect(page.getByText('该商品需要登录后购买。')).toBeVisible()
    const loginLink = page.getByRole('link', { name: '登录后继续购买' })
    const redirect = new URL(await loginLink.getAttribute('href') ?? '', 'http://localhost').searchParams.get('redirect')
    expect(redirect).toMatch(/^\/checkout\?/u)

    for (const width of [320, 390, 768, 1440]) await noHorizontalOverflow(page, width)
    await page.setViewportSize({ width: 390, height: 844 })
    await loginLink.click()
    await expect(page).toHaveURL(/\/login\?redirect=/u)
    const loginRedirect = new URL(page.url()).searchParams.get('redirect')
    expect(loginRedirect).toBe(redirect)
    await expectClientMounted(page, '[data-customer-login-ready="true"]')
  }
  finally {
    if (!page.isClosed() && product) await deleteProduct(page, product)
  }
})
