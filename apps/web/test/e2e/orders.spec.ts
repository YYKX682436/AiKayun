import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'
import { expectClientMounted } from './browser-diagnostics'

type Product = {
  id: string
  name: string
  revision: number
  variants: Array<{ id: string }>
}

const customerPassword = 'Order-Browser-Password-2026!'

async function noHorizontalOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 })
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }))
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

async function attachAdmin(page: Page): Promise<void> {
  const token = await createBrowserAdminSession()
  await page.context().addCookies([{
    name: 'aikayun_admin_session',
    value: token,
    url: new URL('/', process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin,
    httpOnly: true,
    sameSite: 'Lax',
  }])
  await page.goto('/admin/login')
}

async function createProduct(page: Page, name: string, price: string): Promise<Product> {
  const created = await page.request.post('/api/v1/admin/products', {
    headers: await adminHeaders(page),
    data: { name, description: '真实订单浏览器验收数字商品。', productType: 'digital', defaultSku: { salePrice: price } },
  })
  expect(created.status()).toBe(201)
  let product = (await created.json()).data as Product
  const active = await page.request.patch(`/api/v1/admin/products/${product.id}/lifecycle`, {
    headers: await adminHeaders(page),
    data: { expectedRevision: product.revision, status: 'active' },
  })
  expect(active.status()).toBe(200)
  product = (await active.json()).data as Product
  return product
}

async function setUnlimitedInventory(page: Page, product: Product): Promise<void> {
  const inventoryResponse = await page.request.get(`/api/v1/admin/products/${product.id}/inventory`)
  expect(inventoryResponse.status()).toBe(200)
  const inventory = (await inventoryResponse.json()).data
  const variant = inventory.variants.find((row: { skuId: string }) => row.skuId === product.variants[0]!.id)
  expect(variant).toBeTruthy()
  const changed = await page.request.put(`/api/v1/admin/products/${product.id}/variants/${variant.skuId}/inventory-mode`, {
    headers: await adminHeaders(page),
    data: {
      expectedRevision: inventory.productRevision,
      expectedSkuRevision: variant.skuRevision,
      expectedInventoryRevision: variant.inventoryRevision,
      inventoryMode: 'unlimited',
    },
  })
  expect(changed.status()).toBe(200)
}

async function setQuantityInventory(page: Page, product: Product): Promise<void> {
  const inventoryResponse = await page.request.get(`/api/v1/admin/products/${product.id}/inventory`)
  expect(inventoryResponse.status()).toBe(200)
  const inventory = (await inventoryResponse.json()).data
  const variant = inventory.variants.find((row: { skuId: string }) => row.skuId === product.variants[0]!.id)
  expect(variant).toBeTruthy()
  const changed = await page.request.put(`/api/v1/admin/products/${product.id}/variants/${variant.skuId}/inventory-mode`, {
    headers: await adminHeaders(page),
    data: {
      expectedRevision: inventory.productRevision,
      expectedSkuRevision: variant.skuRevision,
      expectedInventoryRevision: variant.inventoryRevision,
      inventoryMode: 'quantity',
    },
  })
  expect(changed.status()).toBe(200)
}

async function enableManualDeliveryInAdmin(page: Page, product: Product): Promise<void> {
  await page.goto(`/admin/products/${product.id}`)
  await expect(page.getByRole('heading', { name: 'SKU 数字履约方式' })).toBeVisible()
  const method = page.getByRole('combobox', { name: /履约方式/u }).first()
  await method.click()
  await page.getByRole('option', { name: '人工交付' }).click()
  await expect(method).toContainText('人工交付')
  await expect(page.getByText('人工交付 · 销售已暂停')).toBeVisible()
  const enable = page.getByRole('button', { name: '明确开启' }).first()
  await expect(enable).toBeEnabled()
  page.once('dialog', dialog => dialog.accept())
  await enable.click()
  await expect(page.getByRole('status')).toContainText('已明确开启人工数字交付')
  await expect(page.getByText('人工交付 · 销售已启用')).toBeVisible()
}

async function registerCustomer(page: Page, username: string): Promise<void> {
  await page.goto('/register')
  await expect(page.locator('[data-customer-register-ready="true"]')).toBeAttached()
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(customerPassword)
  await page.getByLabel('确认密码').fill(customerPassword)
  await page.getByRole('button', { name: '创建账户' }).click()
  await expect(page).toHaveURL(/\/account$/u)
}

async function addProductToCart(page: Page, product: Product): Promise<void> {
  await page.goto(`/products/${product.id}`)
  await expectClientMounted(page, '[data-storefront-ready="true"]')
  await expect(page.getByRole('heading', { name: product.name })).toBeVisible()
  await page.getByLabel('购买数量').fill('1')
  await page.getByRole('button', { name: '加入购物车' }).click()
  await expect(page.getByRole('status')).toContainText('已加入购物车。')
}

test('creates a zero-value order, completes actual private delivery, and cancels a positive unpaid order', async ({ page }) => {
  test.setTimeout(180_000)
  const zeroName = `订单零元交付-${randomUUID().slice(0, 8)}`
  const paidName = `订单待付款取消-${randomUUID().slice(0, 8)}`
  const username = `orders-${randomUUID().replaceAll('-', '').slice(0, 18)}`

  await attachAdmin(page)
  const zeroProduct = await createProduct(page, zeroName, '0.00')
  await setUnlimitedInventory(page, zeroProduct)
  await enableManualDeliveryInAdmin(page, zeroProduct)

  const paidProduct = await createProduct(page, paidName, '8.80')
  await setUnlimitedInventory(page, paidProduct)
  await enableManualDeliveryInAdmin(page, paidProduct)

  await registerCustomer(page, username)
  await addProductToCart(page, zeroProduct)
  await page.goto('/cart')
  await expect(page.getByRole('heading', { name: zeroName })).toBeVisible()
  await page.getByRole('link', { name: '查看结算报价' }).click()
  await expect(page.getByRole('heading', { name: '确认订单' })).toBeVisible()
  await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
  await page.getByRole('button', { name: '提交订单' }).click()
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/iu)
  const zeroOrderUrl = page.url()
  const zeroOrderId = zeroOrderUrl.split('/').at(-1)!
  await expect(page.getByText('零元订单，等待商家交付')).toBeVisible()
  await expect(page.getByText('零元订单，无需付款')).toBeVisible()
  await expect(page.getByRole('heading', { name: zeroName })).toBeVisible()
  await page.reload()
  await expect(page.getByText('零元订单，等待商家交付')).toBeVisible()

  await page.goto(`/admin/orders/${zeroOrderId}`)
  await expect(page.getByRole('heading', { name: zeroOrderId })).toBeVisible()
  const deliveryEntry = page.getByRole('textbox', { name: `${zeroName}实际交付内容，每行一件` })
  await deliveryEntry.fill('E2E-REAL-DIGITAL-DELIVERY-2026')
  await page.getByRole('button', { name: '确认实际交付' }).click()
  await expect(page.getByText('已完成', { exact: true })).toBeVisible()
  await expect(page.getByText('E2E-REAL-DIGITAL-DELIVERY-2026')).toBeVisible()
  await expect(page.getByRole('heading', { name: '人工与自动履约审计' })).toBeVisible()
  await expect(page.getByText(/1 件 · 1 条交付 · 管理员/u)).toBeVisible()
  await expect(page.getByText(/SHA-256/u)).toBeVisible()

  await page.goto(zeroOrderUrl)
  await expect(page.getByText('订单已完成')).toBeVisible()
  await expect(page.getByText('E2E-REAL-DIGITAL-DELIVERY-2026')).toBeVisible()
  await page.reload()
  await expect(page.getByText('E2E-REAL-DIGITAL-DELIVERY-2026')).toBeVisible()

  await page.goto('/cart')
  if (await page.getByRole('button', { name: '清空购物车' }).isVisible()) {
    await page.getByRole('button', { name: '清空购物车' }).click()
  }
  await addProductToCart(page, paidProduct)
  await page.goto('/cart')
  await page.getByRole('link', { name: '查看结算报价' }).click()
  await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
  await page.getByRole('button', { name: '提交订单' }).click()
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/iu)
  const paidOrderUrl = page.url()
  await expect(page.locator('[data-slot="title"]').filter({ hasText: '等待付款' })).toBeVisible()
  await expect(page.getByText('暂时没有可用支付通道')).toBeVisible()
  await expect(page.getByRole('button', { name: '付款', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-slot="title"]').filter({ hasText: '等待付款' })).toBeVisible()
  await page.getByRole('button', { name: '取消未付款订单' }).click()
  await page.getByRole('button', { name: '确认取消' }).click()
  await expect(page.getByText('已关闭', { exact: true })).toBeVisible()

  await page.goto('/orders')
  await expect(page.getByRole('heading', { name: '我的订单' })).toBeVisible()
  await expect(page.getByRole('link', { name: '订单详情' })).toHaveCount(2)
  await expect(page.getByText('已关闭')).toBeVisible()
  await expect(page.getByText('已完成')).toBeVisible()
  expect(paidOrderUrl).toContain('/orders/')

  for (const width of [320, 390, 768, 1440]) await noHorizontalOverflow(page, width)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(zeroOrderUrl)
  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: '深色' }).click()
  await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true)
  await page.reload()
  await expect(page.getByText('E2E-REAL-DIGITAL-DELIVERY-2026')).toBeVisible()
  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: '浅色' }).click()
  await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('light'))).toBe(true)
})

test('configures and safely delivers an encrypted fixed Markdown version through the browser', async ({ page }) => {
  test.setTimeout(180_000)
  const productName = `固定文本自动交付 ${randomUUID().slice(0, 8)}`
  const username = `fixed-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  const secretText = 'BROWSER-FIXED-CONTENT-2026'
  const content = `# 授权教程\n\n**${secretText}**\n\n<img src=x onerror=alert(1)>\n\n[不安全链接](javascript:alert(1))`

  await attachAdmin(page)
  const product = await createProduct(page, productName, '0.00')
  await setUnlimitedInventory(page, product)
  await page.goto(`/admin/products/${product.id}`)
  await expectClientMounted(page, '[data-admin-product-ready="true"]')
  const editor = page.getByRole('region', { name: '固定文本与固定链接' })
  await expect(editor).toBeVisible()
  await editor.getByLabel('固定文本（Markdown）').fill(content)
  await editor.getByRole('button', { name: '预览展示' }).click()
  const preview = editor.locator('article.secure-markdown')
  await expect(preview.getByText(secretText)).toBeVisible()
  await expect(preview.locator('img, script, a[href^="javascript:"]')).toHaveCount(0)
  await expect(preview).toContainText('<img src=x onerror=alert(1)>')

  await editor.getByRole('button', { name: '保存为新版本' }).click()
  await expect(editor.getByRole('status')).toContainText('版本 1 已保存')
  await expect(editor.getByText('固定文本 · v1')).toBeVisible()
  page.once('dialog', dialog => dialog.accept())
  await editor.getByRole('button', { name: '明确启用自动交付' }).click()
  await expect(editor.getByRole('status')).toContainText('自动交付已启用')
  await expect(editor.getByText('自动交付已启用', { exact: true })).toBeVisible()

  await registerCustomer(page, username)
  await addProductToCart(page, product)
  await page.goto('/cart')
  await page.getByRole('link', { name: '查看结算报价' }).click()
  await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
  await page.getByRole('button', { name: '提交订单' }).click()
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/iu)
  const orderUrl = page.url()
  const orderId = orderUrl.split('/').at(-1)!
  await expect(page.getByText(secretText)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('heading', { name: '已完成的数字交付' })).toBeVisible()
  const deliveredMarkdown = page.locator('.secure-markdown').filter({ hasText: secretText })
  await expect(deliveredMarkdown.locator('strong')).toContainText(secretText)
  await expect(deliveredMarkdown.locator('script, img, a[href^="javascript:"]')).toHaveCount(0)

  const publicHtml = await page.request.get(`/products/${product.id}`)
  expect(publicHtml.status()).toBe(200)
  expect(await publicHtml.text()).not.toContain(secretText)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('button', { name: '复制第 1 件交付内容' }).click()
  await expect(page.getByRole('status')).toContainText('交付内容已复制')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(secretText)
  const detailResponse = await page.reload()
  expect(detailResponse?.headers()['cache-control']).toContain('private')
  await expect(page.getByText(secretText)).toBeVisible()
  expect(orderId).toMatch(/^[0-9a-f-]{36}$/iu)

  for (const width of [320, 390, 768, 1440]) await noHorizontalOverflow(page, width)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: '深色' }).click()
  await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true)
  await page.reload()
  await expect(page.getByText(secretText)).toBeVisible()
  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: '浅色' }).click()
  await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('light'))).toBe(true)
})

test('imports a per-SKU code pool in the admin UI and shows only the completed card to its customer', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const code = 'E2E-CODEPOOL  2026'
  const productName = `卡密自动发货 ${randomUUID().slice(0, 8)}`
  const username = `codepool-${randomUUID().replaceAll('-', '').slice(0, 18)}`

  await attachAdmin(page)
  const product = await createProduct(page, productName, '0.00')
  await setQuantityInventory(page, product)
  await page.goto(`/admin/products/${product.id}`)
  await expectClientMounted(page, '[data-admin-product-ready="true"]')
  const pool = page.getByRole('region', { name: 'SKU 卡密池与自动发货' })
  await expect(pool).toBeVisible()
  page.once('dialog', dialog => dialog.accept())
  await pool.getByRole('button', { name: '配置并保持暂停' }).click()
  await expect(pool.getByText('已配置并暂停新销售')).toBeVisible()
  await pool.getByLabel('卡密内容').fill(`${code}\n${code}`)
  await pool.getByRole('button', { name: '预检查导入内容' }).click()
  await expect(pool.getByText('共 2 行 · 可入库 1 · 重复 1 · 无效 0')).toBeVisible()
  await expect(pool.getByText('第 2 行 · 重复 · 本次内容重复')).toBeVisible()
  await expect(pool.getByText(code, { exact: true })).toHaveCount(0)
  page.once('dialog', dialog => dialog.accept())
  await pool.getByRole('button', { name: '确认加密入库 1 条' }).click()
  await expect(pool.getByRole('status')).toContainText('已入库 1 条')
  await expect(pool.getByText('SKU 库存：实存 1 · 预留 0 · 可售 1。')).toBeVisible()
  page.once('dialog', dialog => dialog.accept())
  await pool.getByRole('button', { name: '开启自动发货销售' }).click()
  await expect(pool.getByText('新订单自动发货已启用')).toBeVisible()

  await registerCustomer(page, username)
  await addProductToCart(page, product)
  await page.goto('/cart')
  await page.getByRole('link', { name: '查看结算报价' }).click()
  await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
  await page.getByRole('button', { name: '提交订单' }).click()
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/iu)
  const orderResponse = await page.reload()
  expect(orderResponse?.headers()['cache-control']).toContain('private')
  await expect(page.getByText(code, { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: '复制第 1 件交付内容' })).toBeVisible()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('button', { name: '复制第 1 件交付内容' }).click()
  await expect(page.getByRole('status')).toContainText('交付内容已复制到剪贴板。')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code)

  const publicHtml = await page.request.get(`/products/${product.id}`)
  expect(publicHtml.status()).toBe(200)
  expect(await publicHtml.text()).not.toContain(code)
  for (const width of [320, 390, 768, 1440]) await noHorizontalOverflow(page, width)
})
