import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'
import { expectClientMounted } from './browser-diagnostics'

type Product = { id: string; revision: number; variants: Array<{ id: string }> }
const customerPassword = 'Private-File-Browser-Password-2026!'

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
}

async function createProduct(page: Page, name: string): Promise<Product> {
  const response = await page.request.post('/api/v1/admin/products', {
    headers: await adminHeaders(page),
    data: { name, description: '通过浏览器验证的私有文件数字商品。', productType: 'digital', defaultSku: { salePrice: '0.00' } },
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

test('uploads and enables through the admin UI, completes a customer order, and downloads verified bytes', async ({ page }) => {
  test.setTimeout(180_000)
  const productName = `私有文件自动交付 ${randomUUID().slice(0, 8)}`
  const username = `private-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  const filename = '顾客授权说明.txt'
  const fileBytes = Buffer.from('通过真实浏览器下载的数字商品文件。\n包含 UTF-8 内容和稳定的 SHA-256。\n')
  const expectedSha256 = createHash('sha256').update(fileBytes).digest('hex')
  let stagedUploadId = ''
  page.on('response', async (response) => {
    if (!response.url().includes('/private-files/uploads') || response.status() !== 201) return
    try { stagedUploadId = (await response.json()).data.uploadId as string } catch { /* keep browser diagnostics clean */ }
  })

  await page.goto('/admin/login')
  await attachAdmin(page)
  const product = await createProduct(page, productName)
  await setUnlimitedInventory(page, product)

  await page.goto(`/admin/products/${product.id}`)
  await expectClientMounted(page, '[data-admin-product-ready="true"]')
  const panel = page.getByRole('region', { name: '私有文件与自动交付' })
  await expect(panel).toBeVisible()
  await panel.locator('#private-file-input').setInputFiles({ name: filename, mimeType: 'text/plain', buffer: fileBytes })
  await panel.getByRole('button', { name: '上传并校验' }).click()
  await expect(panel.getByRole('status')).toContainText('文件已安全上传')
  await expect(panel.getByText(expectedSha256)).toBeVisible()
  await panel.getByRole('button', { name: '保存为新版本' }).click()
  await expect(panel.getByRole('status')).toContainText('版本 v1 已保存')
  await expect(panel.getByText('v1 · 顾客授权说明.txt', { exact: true })).toBeVisible()
  await expect(panel.getByText('新订单自动交付已暂停')).toBeVisible()

  page.once('dialog', dialog => dialog.accept())
  await panel.getByRole('button', { name: '明确启用自动交付' }).click()
  await expect(panel.getByText('新订单自动交付已启用')).toBeVisible()
  expect(stagedUploadId).toMatch(/^[0-9a-f-]{36}$/u)

  const publicProduct = await page.request.get(`/api/v1/public/products/${product.id}`)
  expect(publicProduct.status()).toBe(200)
  expect(await publicProduct.text()).not.toContain(filename)
  const guessedPublicPath = await page.request.get(`/private-files/${stagedUploadId}`)
  expect(guessedPublicPath.status()).toBe(404)
  const pageSource = await page.content()
  expect(pageSource).not.toContain(stagedUploadId)

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
  await expect(page.getByRole('heading', { name: productName })).toBeVisible()
  await expect(page.getByText(filename, { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('订单已完成')).toBeVisible()
  const downloadLink = page.locator('a[download]')
  await expect(downloadLink).toBeVisible()
  await expect(downloadLink).toHaveAttribute('href', /\/api\/v1\/customer\/orders\/.+\/file$/u)

  const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()])
  expect(download.suggestedFilename()).toBe(filename)
  const downloadedPath = await download.path()
  expect(downloadedPath).toBeTruthy()
  const downloadedBytes = await readFile(downloadedPath!)
  expect(downloadedBytes).toEqual(fileBytes)
  expect(createHash('sha256').update(downloadedBytes).digest('hex')).toBe(expectedSha256)
  await expect(downloadLink).toContainText('重新下载')
  const [retryDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }),
    downloadLink.click(),
  ])
  expect(retryDownload.suggestedFilename()).toBe(filename)
  const retryPath = await retryDownload.path()
  expect(await readFile(retryPath!)).toEqual(fileBytes)
  await expect(downloadLink).toBeVisible()

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: '深色' }).click()
  await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true)
  await page.reload()
  await expect(page.getByRole('link', { name: '下载文件' })).toBeVisible()
  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: '浅色' }).click()
  await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('light'))).toBe(true)
})
