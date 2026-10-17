import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const adminEmail = 'browser-test@example.com'
const adminPassword = 'Only-For-E2E-Tests-2026!!'

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/admin/login')
  await expect(page.getByLabel('管理员邮箱')).toBeEnabled()
  await page.getByLabel('管理员邮箱').fill(adminEmail)
  await page.getByLabel('密码').fill(adminPassword)
  await page.getByRole('button', { name: '安全登录' }).click()
  await expect(page).toHaveURL(/\/admin$/)
}

test('admin manages a real product through category, SKU, price, media, rich text, stock and lifecycle', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)

  const productName = `D6 浏览器商品 ${randomUUID().slice(0, 8)}`
  await page.goto('/admin/products/new')
  await expect(page.getByLabel('商品名称')).toBeEnabled()
  await page.getByLabel('商品名称').fill(productName)
  await page.getByLabel('默认 SKU 销售价（人民币）').fill('18.90')
  await page.getByRole('button', { name: '保存为草稿' }).click()
  await expect(page).toHaveURL(/\/admin\/products\/[0-9a-f-]+$/)
  await expect(page.getByRole('heading', { level: 1, name: productName })).toBeVisible()
  const productId = page.url().split('/').at(-1)!
  const initialSku = await page.evaluate(async (id) => {
    const result = await fetch(`/api/v1/admin/products/${id}`).then(response => response.json()) as { data: { variants: Array<{ id: string; skuCode: string }> } }
    const variant = result.data.variants[0]
    if (!variant) throw new Error('The created draft must have its default SKU')
    return variant
  }, productId)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: productName })).toBeVisible()

  const categoryName = `D6 分类 ${randomUUID().slice(0, 6)}`
  await page.locator('#categories').getByRole('button', { name: '管理分类' }).click()
  const categoryDialog = page.getByRole('dialog', { name: '分类管理' })
  await categoryDialog.getByLabel('分类名称').fill(categoryName)
  await categoryDialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(categoryDialog.getByRole('status')).toContainText('分类已创建')
  await page.keyboard.press('Escape')
  const categoriesSection = page.locator('#categories')
  await categoriesSection.getByRole('combobox').first().click()
  await page.getByRole('option', { name: categoryName }).click()
  await categoriesSection.getByRole('button', { name: '保存分类' }).click()
  await expect(categoriesSection.getByRole('status')).toContainText('商品分类已保存')

  const matrix = page.locator('#variants')
  await matrix.getByRole('button', { name: '添加规格组' }).click()
  await page.getByLabel('规格组 1 名称').fill('套餐版本')
  await page.getByLabel('套餐版本 的选项 1').fill('月卡')
  await matrix.getByRole('button', { name: '添加规格值' }).click()
  await page.getByLabel('套餐版本 的选项 2').fill('年卡')
  await page.getByLabel('新增 SKU 默认售价（人民币）').fill('29.90')
  await matrix.getByRole('button', { name: '自动生成全部组合' }).click()
  page.once('dialog', dialog => dialog.accept())
  const defaultSkuRow = matrix.locator('li').filter({ hasText: initialSku.skuCode }).first()
  await defaultSkuRow.getByRole('button', { name: '永久退役' }).click()
  await expect(matrix.getByText('待保存永久退役')).toBeVisible()
  await matrix.getByRole('button', { name: '预览 SKU 差异' }).click()
  await expect(matrix.getByRole('heading', { name: '保存预览' })).toBeVisible()
  await matrix.getByLabel('我已查看移除、改配和退役影响，确认提交此差异').check()
  await matrix.getByRole('button', { name: '保存规格与 SKU' }).click()
  await expect(matrix.getByRole('status')).toContainText('规格组和 SKU 矩阵已保存')
  await expect(matrix.getByText('共 3 个')).toBeVisible()
  const retainedSkuIds = await page.evaluate(async (id) => {
    const result = await fetch(`/api/v1/admin/products/${id}`).then(response => response.json()) as { data: { variants: Array<{ id: string; skuCode: string; retiredAt: string | null }> } }
    return result.data.variants
  }, productId)
  expect(retainedSkuIds.find(variant => variant.id === initialSku.id)?.retiredAt).not.toBeNull()
  const activeSku = retainedSkuIds.find(variant => variant.retiredAt === null)
  expect(activeSku).toBeDefined()

  const prices = page.locator('#prices')
  await prices.locator('article input:enabled').first().fill('17.80')
  await prices.getByRole('button', { name: '原子保存本页价格' }).click()
  await expect(prices.getByRole('status')).toContainText('已原子保存')

  const png = readFileSync(new URL('../fixtures/d6-upload.png', import.meta.url))
  const uploadRequestPromise = page.waitForRequest(request => request.url().includes('/api/v1/admin/media') && request.method() === 'POST')
  const gallery = page.locator('#gallery')
  await gallery.getByLabel('上传商品图片').setInputFiles({ name: 'd6-browser.png', mimeType: 'image/png', buffer: png })
  await expect(gallery.getByRole('status')).toContainText('图片已上传并加入待保存相册')
  const uploadRequest = await uploadRequestPromise
  const uploadContentLength = (await uploadRequest.allHeaders())['content-length'] ?? ''
  expect(Number(uploadContentLength)).toBeGreaterThan(0)
  await gallery.getByRole('button', { name: '保存相册' }).click()
  await expect(gallery.getByRole('status').filter({ hasText: '商品相册顺序与引用已保存' })).toBeVisible()
  await expect(gallery.getByRole('status').filter({ hasText: '图片已上传并加入待保存相册' })).toHaveCount(0)
  await expect(gallery.locator('img')).toHaveCount(1)

  const failedUploadHandler = async (route: import('@playwright/test').Route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'MEDIA_TEMPORARILY_UNAVAILABLE', message: 'Image processing is temporarily unavailable' } }),
  })
  await page.route('**/api/v1/admin/media', failedUploadHandler)
  await gallery.getByLabel('上传商品图片').setInputFiles({ name: 'd6-upload-rejected.png', mimeType: 'image/png', buffer: png })
  await expect(gallery.getByRole('status').filter({ hasText: '服务器暂时无法处理此请求' })).toBeVisible()
  await expect(gallery.locator('img')).toHaveCount(1)
  await page.unroute('**/api/v1/admin/media', failedUploadHandler)

  const rich = page.locator('#rich-content')
  const editor = rich.locator('[contenteditable="true"]').first()
  await editor.fill('图文说明在刷新后仍然可编辑。')
  await rich.getByRole('button', { name: '插入图片' }).click()
  await expect(editor.locator('img[data-media-id]')).toHaveCount(1)
  const richContentPath = `**/api/v1/admin/products/${productId}/rich-content`
  const rejectRichContent = async (route: import('@playwright/test').Route) => route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'INVALID_PRODUCT_RICH_CONTENT', message: '富文本内容未通过服务器结构校验。' } }),
  })
  await page.route(richContentPath, rejectRichContent)
  await rich.getByRole('button', { name: '保存图文详情' }).click()
  await expect(rich.getByRole('alert')).toContainText('富文本内容未通过服务器结构校验')
  await expect(editor).toContainText('图文说明在刷新后仍然可编辑。')
  await page.unroute(richContentPath, rejectRichContent)
  await rich.getByRole('button', { name: '保存图文详情' }).click()
  await expect(rich.getByRole('status')).toContainText('图文详情已保存')
  await page.reload()
  await expect(page.locator('#rich-content [contenteditable="true"]')).toContainText('图文说明在刷新后仍然可编辑。')
  await expect(page.locator('#rich-content img[data-media-id]')).toHaveCount(1)

  const inventory = page.locator('#inventory')
  const inventoryRow = inventory.locator('li').filter({ hasText: activeSku!.skuCode }).first()
  const inventoryMode = inventoryRow.getByRole('combobox')
  page.once('dialog', dialog => dialog.accept())
  await inventoryMode.click()
  await page.getByRole('option', { name: '按数量管理' }).click()
  await expect(inventoryRow.getByText('实际 0 · 预留 0 · 可售 0')).toBeVisible()
  await inventoryRow.getByRole('button', { name: '查看调整历史' }).click()
  await inventory.getByLabel('变更数量').fill('4')
  await inventory.getByLabel('调整原因').fill('D6 浏览器到货验收')
  let loseAdjustmentResponse = true
  await page.route('**/inventory/adjustments', async (route) => {
    if (route.request().method() === 'POST' && loseAdjustmentResponse) {
      loseAdjustmentResponse = false
      const committedResponse = await route.fetch()
      expect(committedResponse.status()).toBe(201)
      await route.abort('failed')
      return
    }
    await route.continue()
  })
  await inventory.getByRole('button', { name: '提交库存调整' }).click()
  await expect(inventory.getByRole('status').filter({ hasText: '操作结果暂不确定' })).toBeVisible()
  await inventory.getByRole('button', { name: '先核验并安全重试' }).click()
  await expect(inventory.getByRole('status').filter({ hasText: '操作已完成：库存 0 → 4' })).toBeVisible()
  await expect(inventoryRow.getByText('实际 4 · 预留 0 · 可售 4')).toBeVisible()
  await inventory.locator('summary').filter({ hasText: '库存调整历史（服务端分页）' }).click()
  await expect(inventory.getByText('D6 浏览器到货验收', { exact: false })).toHaveCount(1)

  const advanced = page.locator('#advanced')
  await advanced.getByRole('button', { name: '发布商品' }).click()
  await expect(page.getByText('销售中', { exact: true }).first()).toBeVisible()
  await advanced.getByRole('button', { name: '暂停销售' }).click()
  await expect(page.getByText('已暂停', { exact: true }).first()).toBeVisible()
  await advanced.getByRole('button', { name: '重新上架' }).click()
  await expect(page.getByText('销售中', { exact: true }).first()).toBeVisible()
  page.once('dialog', dialog => dialog.accept())
  await advanced.getByRole('button', { name: '归档', exact: true }).click()
  await expect(page.getByText('商品已归档，经营配置为只读。')).toBeVisible()
  await expect(page.locator('#basic').getByLabel('商品名称')).toBeDisabled()
  page.once('dialog', dialog => dialog.accept())
  await advanced.getByRole('button', { name: '恢复为草稿' }).click()
  await expect(page.locator('#basic').getByLabel('商品名称')).toBeEnabled()

  const copyResponse = page.waitForResponse(response =>
    response.url().includes(`/api/v1/admin/products/${productId}/copy`) && response.request().method() === 'POST',
  )
  await advanced.getByRole('button', { name: '复制商品' }).click()
  expect((await copyResponse).status()).toBe(201)
  await expect(page).toHaveURL(url => {
    const copiedId = url.pathname.split('/').at(-1)
    return url.pathname.startsWith('/admin/products/') && copiedId !== productId
  })
  const copyId = page.url().split('/').at(-1)!
  expect(copyId).not.toBe(productId)
  await expect(page.locator('#gallery').locator('img')).toHaveCount(1)
  await expect(page.locator('#inventory').getByText('库存尚未配置。')).toHaveCount(2)
  page.once('dialog', dialog => dialog.accept())
  await page.locator('#advanced').getByRole('button', { name: '永久删除商品' }).click()
  await expect(page).toHaveURL(/\/admin\/products$/)
})

test('blocks permanent deletion when inventory history exists and preserves the trail after archiving', async ({ page }) => {
  await signIn(page)
  const productName = `D6 库存历史商品 ${randomUUID().slice(0, 8)}`
  await page.goto('/admin/products/new')
  await expect(page.getByLabel('商品名称')).toBeEnabled()
  await page.getByLabel('商品名称').fill(productName)
  await page.getByLabel('默认 SKU 销售价（人民币）').fill('9.90')
  await page.getByRole('button', { name: '保存为草稿' }).click()
  await expect(page).toHaveURL(/\/admin\/products\/[0-9a-f-]+$/)

  const inventory = page.locator('#inventory')
  const row = inventory.locator('li').first()
  page.once('dialog', dialog => dialog.accept())
  await row.getByRole('combobox').click()
  await page.getByRole('option', { name: '按数量管理' }).click()
  await row.getByRole('button', { name: '查看调整历史' }).click()
  await inventory.getByLabel('变更数量').fill('2')
  await inventory.getByLabel('调整原因').fill('D6 删除阻止验证到货')
  await inventory.getByRole('button', { name: '提交库存调整' }).click()
  await expect(row.getByText('实际 2 · 预留 0 · 可售 2')).toBeVisible()

  await inventory.getByLabel('操作').click()
  await page.getByRole('option', { name: '减少库存' }).click()
  await inventory.getByLabel('变更数量').fill('2')
  await inventory.getByLabel('调整原因').fill('D6 删除阻止验证清零')
  await inventory.getByRole('button', { name: '提交库存调整' }).click()
  await expect(row.getByText('实际 0 · 预留 0 · 可售 0')).toBeVisible()

  const advanced = page.locator('#advanced')
  page.once('dialog', dialog => dialog.accept())
  await advanced.getByRole('button', { name: '永久删除商品' }).click()
  await expect(advanced.getByRole('alert')).toContainText('商品存在库存调整历史')
  await expect(page).toHaveURL(/\/admin\/products\/[0-9a-f-]+$/)

  page.once('dialog', dialog => dialog.accept())
  await advanced.getByRole('button', { name: '归档', exact: true }).click()
  await expect(advanced.getByRole('status')).toContainText('商品状态已更新为“已归档”')
  await inventory.locator('summary').filter({ hasText: '库存调整历史（服务端分页）' }).click()
  await expect(inventory.getByText('D6 删除阻止验证清零', { exact: false })).toBeVisible()
})

test('rechecks inventory changed during SKU editing and preserves the local matrix draft', async ({ page }) => {
  await signIn(page)
  const productName = `D6 并发库存规格 ${randomUUID().slice(0, 8)}`
  await page.goto('/admin/products/new')
  await expect(page.getByLabel('商品名称')).toBeEnabled()
  await page.getByLabel('商品名称').fill(productName)
  await page.getByLabel('默认 SKU 销售价（人民币）').fill('12.90')
  await page.getByRole('button', { name: '保存为草稿' }).click()
  await expect(page).toHaveURL(/\/admin\/products\/[0-9a-f-]+$/)
  const productId = page.url().split('/').at(-1)!
  const initialSku = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/admin/products/${id}`).then(result => result.json()) as { data: { variants: Array<{ id: string; skuCode: string }> } }
    return response.data.variants[0]!
  }, productId)

  const matrix = page.locator('#variants')
  await matrix.getByRole('button', { name: '添加规格组' }).click()
  await page.getByLabel('规格组 1 名称').fill('并发版本')
  await page.getByLabel('并发版本 的选项 1').fill('基础')
  await matrix.getByRole('button', { name: '添加规格值' }).click()
  await page.getByLabel('并发版本 的选项 2').fill('扩展')
  await matrix.getByLabel('新增 SKU 默认售价（人民币）').fill('19.90')
  await matrix.getByRole('button', { name: '自动生成全部组合' }).click()
  page.once('dialog', dialog => dialog.accept())
  const defaultSkuRow = matrix.locator('li').filter({ hasText: initialSku.skuCode }).first()
  await defaultSkuRow.getByRole('button', { name: '永久退役' }).click()
  await matrix.getByRole('button', { name: '预览 SKU 差异' }).click()
  await expect(matrix.getByRole('heading', { name: '保存预览' })).toBeVisible()
  await matrix.getByLabel('我已查看移除、改配和退役影响，确认提交此差异').check()

  const inventory = page.locator('#inventory')
  const inventoryRow = inventory.locator('li').filter({ hasText: initialSku.skuCode }).first()
  page.once('dialog', dialog => dialog.accept())
  await inventoryRow.getByRole('combobox').click()
  await page.getByRole('option', { name: '按数量管理' }).click()
  await expect(inventoryRow.getByText('实际 0 · 预留 0 · 可售 0')).toBeVisible()
  await inventoryRow.getByRole('button', { name: '查看调整历史' }).click()
  await inventory.getByLabel('变更数量').fill('1')
  await inventory.getByLabel('调整原因').fill('D6 规格编辑并发到货')
  await inventory.getByRole('button', { name: '提交库存调整' }).click()
  await expect(inventoryRow.getByText('实际 1 · 预留 0 · 可售 1')).toBeVisible()

  await matrix.getByRole('button', { name: '保存规格与 SKU' }).click()
  await expect(page.getByRole('heading', { name: '商品数据已变化，需要你决定如何处理' })).toBeVisible()
  await expect(matrix.getByLabel('并发版本 的选项 2')).toHaveValue('扩展')
  await expect(matrix.getByText('待保存永久退役')).toBeVisible()
  await expect(matrix.getByRole('alert')).toContainText('实际库存尚未清零')
  await page.getByRole('button', { name: '保留本地输入，确认后再保存' }).click()
  await matrix.getByRole('button', { name: '预览 SKU 差异' }).click()
  await expect(matrix.getByText('不能退役：实际库存未清零')).toBeVisible()
  await expect(matrix.getByRole('button', { name: '保存规格与 SKU' })).toBeDisabled()
})

test('protects SSR, resolves a real stale revision conflict, and stays usable at 320px in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  const response = await page.goto('/admin/products')
  await expect(page).toHaveURL(/\/admin\/login/)
  expect(await response?.text()).not.toContain('商品修订')

  await signIn(page)
  const productName = `D6 冲突商品 ${randomUUID().slice(0, 8)}`
  await page.goto('/admin/products/new')
  await expect(page.getByLabel('商品名称')).toBeEnabled()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.getByLabel('商品名称').fill(productName)
  await page.getByLabel('默认 SKU 销售价（人民币）').fill('9.90')
  await page.getByRole('button', { name: '保存为草稿' }).click()
  await expect(page).toHaveURL(/\/admin\/products\/[0-9a-f-]+$/)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  const productId = page.url().split('/').at(-1)!

  const concurrentUpdate = await page.evaluate(async (id) => {
    const csrf = await fetch('/api/v1/admin/auth/csrf').then(response => response.json()) as { data: { csrfToken: string } }
    const current = await fetch(`/api/v1/admin/products/${id}`).then(response => response.json()) as { data: { revision: number } }
    const changed = await fetch(`/api/v1/admin/products/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.data.csrfToken },
      body: JSON.stringify({ expectedRevision: current.data.revision, name: '另一位管理员的版本' }),
    })
    return changed.status
  }, productId)
  expect(concurrentUpdate).toBe(200)

  const nameField = page.locator('#basic').getByLabel('商品名称')
  const locallyRetainedName = `${productName} 本地版本`
  await nameField.fill(locallyRetainedName)
  await page.locator('#basic').getByRole('button', { name: '保存基本信息' }).click()
  await expect(page.getByRole('heading', { name: '商品数据已变化，需要你决定如何处理' })).toBeVisible()
  await expect(page.getByText('服务器修订', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '保留本地输入，确认后再保存' }).click()
  await page.locator('#basic').getByRole('button', { name: '保存基本信息' }).click()
  await expect(page.getByRole('heading', { level: 1, name: locallyRetainedName })).toBeVisible()

  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: '浅色' }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await expect(page.locator('html')).toHaveAttribute('data-aikayun-area', 'admin')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-color-primary-600').trim())).toBe('#2563eb')

  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: '深色' }).click()
  await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

  await page.goto(`/admin/products?search=${encodeURIComponent(locallyRetainedName)}`)
  const productCard = page.locator('section[aria-label="商品列表"] article').filter({ hasText: locallyRetainedName })
  await expect(productCard).toBeVisible()
  await expect(productCard.locator('time')).toHaveCount(2)
  await expect(productCard.locator('time').nth(0)).toContainText('创建')
  await expect(productCard.locator('time').nth(1)).toContainText('更新')

  const unavailableProductList = async (route: import('@playwright/test').Route) => route.abort('failed')
  await page.route('**/api/v1/admin/products?**', unavailableProductList)
  await page.reload()
  await expect(page.getByRole('alert').filter({ hasText: '服务器暂时无法处理此请求' })).toBeVisible()
  await page.unroute('**/api/v1/admin/products?**', unavailableProductList)
  await page.getByRole('button', { name: '重试' }).click()
  const restoredProductCard = page.locator('section[aria-label="商品列表"] article').filter({ hasText: locallyRetainedName })
  await expect(restoredProductCard).toBeVisible()

  await restoredProductCard.getByRole('link', { name: locallyRetainedName }).click()
  const unsavedName = page.locator('#basic').getByLabel('商品名称')
  await unsavedName.fill(`${locallyRetainedName} 未保存`)
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('link', { name: '返回列表' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/products/${productId}$`))
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('link', { name: '返回列表' }).click()
  await expect(page).toHaveURL(/\/admin\/products(?:\?.*)?$/)
})
