import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'
import { expectClientMounted } from './browser-diagnostics'

type Product = { id: string; revision: number; variants: Array<{ id: string }> }
const customerPassword = 'External-API-Browser-Password-2026!'
const supplierToken = 'playwright-only-supplier-token'

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
    name: 'aikayun_admin_session', value: token,
    url: new URL('/', process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin,
    httpOnly: true, sameSite: 'Lax',
  }])
  await page.goto('/admin/login')
}

async function createProduct(page: Page, name: string): Promise<Product> {
  const response = await page.request.post('/api/v1/admin/products', {
    headers: await adminHeaders(page),
    data: { name, description: '真实浏览器验证的外部 API 数字商品。', productType: 'digital', defaultSku: { salePrice: '0.00' } },
  })
  expect(response.status()).toBe(201)
  let product = (await response.json()).data as Product
  const active = await page.request.patch(`/api/v1/admin/products/${product.id}/lifecycle`, {
    headers: await adminHeaders(page), data: { expectedRevision: product.revision, status: 'active' },
  })
  expect(active.status()).toBe(200)
  product = (await active.json()).data as Product
  return product
}

async function setUnlimitedInventory(page: Page, product: Product): Promise<void> {
  const response = await page.request.get(`/api/v1/admin/products/${product.id}/inventory`)
  expect(response.status()).toBe(200)
  const inventory = (await response.json()).data
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

async function registerCustomer(page: Page, username: string): Promise<void> {
  await page.goto('/register')
  await expect(page.locator('[data-customer-register-ready="true"]')).toBeAttached()
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(customerPassword)
  await page.getByLabel('确认密码').fill(customerPassword)
  await page.getByRole('button', { name: '创建账户' }).click()
  await expect(page).toHaveURL(/\/account$/u)
}

test('configures a supplier and SKU in the browser, then completes and displays an external API order', async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true', 'The external Compose server does not include the isolated supplier fixture.')
  test.setTimeout(180_000)
  const productName = `外部 API 自动交付 ${randomUUID().slice(0, 8)}`
  const supplierName = `HTTP 夹具 ${randomUUID().slice(0, 8)}`
  const username = `supplier-${randomUUID().replaceAll('-', '').slice(0, 18)}`

  await attachAdmin(page)
  const product = await createProduct(page, productName)
  await setUnlimitedInventory(page, product)

  await page.goto('/admin/supplier-connections')
  await expect(page.getByRole('heading', { name: '外部供应商 API' })).toBeVisible()
  await page.getByLabel('供应商名称').fill(supplierName)
  await page.getByLabel('接口基础地址').fill('http://127.0.0.1:3101')
  await page.getByLabel('Bearer Token').fill(supplierToken)
  await page.getByRole('button', { name: '加密保存连接' }).click()
  await expect(page.getByRole('button', { name: new RegExp(supplierName, 'u') })).toBeVisible()
  await expect(page.getByLabel(/Bearer Token/u)).toHaveValue('')
  await expect(page.locator('body')).not.toContainText(supplierToken)

  await page.getByRole('button', { name: '测试连接与查单' }).click()
  await expect(page.getByRole('status')).toContainText('查单测试通过', { timeout: 20_000 })
  await page.getByRole('button', { name: '明确启用连接' }).click()
  await expect(page.getByRole('status')).toContainText('供应商连接已启用')

  await page.goto(`/admin/products/${product.id}`)
  await expectClientMounted(page, '[data-admin-product-ready="true"]')
  const panel = page.getByRole('region', { name: '外部 API 自动发货' })
  await expect(panel).toBeVisible()
  const supplierSelect = panel.getByRole('combobox', { name: '供应商连接版本' })
  await supplierSelect.click()
  await page.getByRole('option', { name: new RegExp(`${supplierName} · v1`, 'u') }).click()
  await panel.getByLabel('供应商商品标识').fill('browser-fixture-product')
  await panel.getByRole('button', { name: '保存新版本并暂停销售' }).click()
  await expect(panel.getByRole('status')).toContainText('新版本已保存')
  await expect(panel.getByText('自动销售已暂停', { exact: true })).toBeVisible()
  page.once('dialog', dialog => dialog.accept())
  await panel.getByRole('button', { name: '明确启用自动销售' }).click()
  await expect(panel.getByRole('status')).toContainText('已启用新订单自动销售')
  await expect(panel.getByText('自动销售已启用', { exact: true })).toBeVisible()

  await registerCustomer(page, username)
  await page.goto(`/products/${product.id}`)
  await expectClientMounted(page, '[data-storefront-ready="true"]')
  await expect(page.getByRole('heading', { name: productName })).toBeVisible()
  await page.getByLabel('购买数量').fill('1')
  await page.getByRole('button', { name: '加入购物车' }).click()
  await expect(page.getByRole('status')).toContainText('已加入购物车。')
  await page.goto('/cart')
  await page.getByRole('link', { name: '查看结算报价' }).click()
  await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
  await page.getByRole('button', { name: '提交订单' }).click()
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/iu)
  const orderId = page.url().split('/').at(-1)!
  await expect(page.getByText('订单已完成')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('外部供应商自动交付')).toBeVisible()
  await expect(page.getByText(/^fixture-code-/u)).toBeVisible()

  const statsResponse = await page.request.get('http://127.0.0.1:3101/__fixture/stats')
  expect(statsResponse.status()).toBe(200)
  const fixtureStats = await statsResponse.json()
  expect(fixtureStats.executions).toBe(1)
  expect(fixtureStats.createRequests).toBe(1)

  await page.goto(`/admin/orders/${orderId}`)
  await expect(page.getByRole('heading', { name: '外部供应商交付操作' })).toBeVisible()
  await expect(page.getByText('browser-fixture-product', { exact: false })).toBeVisible()
  await expect(page.getByText(/^fixture-.+$/u).last()).toBeVisible()
  await expect(page.locator('body')).not.toContainText(supplierToken)

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport)
  }
})
