import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { captureBrowserDiagnostics, expectClientMounted } from './browser-diagnostics'

const adminEmail = 'browser-test@example.com'
const adminPassword = 'Only-For-E2E-Tests-2026!!'
let authenticatedCookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>>['cookies'] | null = null

test.beforeEach(async ({ page }) => {
  captureBrowserDiagnostics(page)
})

async function signIn(page: import('@playwright/test').Page) {
  if (authenticatedCookies) {
    await page.context().addCookies(authenticatedCookies)
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin$/)
    return
  }
  await page.goto('/admin/login')
  await expectClientMounted(page, '[data-admin-login-ready="true"]')
  await expect(page.getByLabel('管理员邮箱')).toBeEnabled()
  await page.getByLabel('管理员邮箱').fill(adminEmail)
  await page.getByLabel('密码').fill(adminPassword)
  await page.getByRole('button', { name: '安全登录' }).click()
  await expect(page).toHaveURL(/\/admin$/)
  authenticatedCookies = (await page.context().storageState()).cookies
}

async function continueToCreatedProduct(page: import('@playwright/test').Page) {
  await expect.poll(async () => {
    if (/\/admin\/products\/[0-9a-f-]+$/.test(page.url())) return true
    return await page.getByRole('link', { name: '继续编辑商品' }).count() > 0
  }).toBe(true)
  if (/\/admin\/products\/new(?:\?.*)?$/.test(page.url())) {
    await expect.poll(async () => {
      if (/\/admin\/products\/[0-9a-f-]+$/.test(page.url())) return true
      return await page.getByRole('button', { name: '继续编辑商品' }).isEnabled().catch(() => false)
    }, { timeout: 30_000 }).toBe(true)
    if (/\/admin\/products\/new(?:\?.*)?$/.test(page.url())) {
      await page.getByRole('link', { name: '继续编辑商品' }).click({ timeout: 3000 }).catch(() => undefined)
    }
  }
  await expect(page).toHaveURL(/\/admin\/products\/[0-9a-f-]+$/, { timeout: 30000 })
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('aikayun-admin-product-create-v1'))).toBeNull()
}

function skuListRow(matrix: import('@playwright/test').Locator, skuCode: string) {
  return matrix.getByText(skuCode, { exact: true }).locator('xpath=ancestor::li[1]')
}

async function runPricingRuleFlow(
  page: import('@playwright/test').Page,
  viewport: { width: number; height: number },
  mode: 'fixed_profit' | 'percentage_markup',
  expectedSalePrice: string,
) {
  await page.setViewportSize(viewport)
  await signIn(page)
  const productName = `D6-3A 定价规则 ${randomUUID().slice(0, 8)}`
  await page.goto('/admin/products/new')
  await expect(page.getByLabel('商品名称')).toBeEnabled()
  await page.getByLabel('商品名称').fill(productName)
  await page.getByLabel('默认 SKU 销售价（人民币）').fill('15.00')
  await page.getByRole('button', { name: '保存为草稿' }).click()
  await continueToCreatedProduct(page)

  const prices = page.locator('#prices')
  const priceRow = prices.locator('article').first()
  await priceRow.getByLabel('划线价（¥）').fill('30.00')
  await priceRow.getByLabel('成本价（¥）').fill('10.12345')
  await prices.getByRole('button', { name: '原子保存本页价格' }).click()
  await expect(prices.getByRole('status')).toContainText('已原子保存')

  const pricing = page.locator('#pricing-rules')
  await expect(pricing.getByText('精确定价规则')).toBeVisible()
  await pricing.getByLabel('定价模式').click()
  await page.getByRole('option', { name: mode === 'fixed_profit' ? '成本 + 固定利润' : '按成本加价率' }).click()
  if (mode === 'fixed_profit') {
    await pricing.getByLabel('每件固定利润（¥）').fill('0.87655')
  } else {
    await pricing.getByLabel('按成本加价率（%）').fill('25')
  }
  await pricing.getByRole('button', { name: '保存本页规则版本' }).click()
  await expect(pricing.getByRole('status')).toContainText('售价尚未更改')
  await pricing.getByRole('button', { name: '预览所选 SKU（1）' }).click()
  await expect(pricing.getByRole('heading', { name: '调价预览' })).toBeVisible()
  await expect(pricing.getByText(`建议 ¥${expectedSalePrice}`, { exact: true })).toBeVisible()
  await expect(pricing.getByText('成本：¥10.12345', { exact: true })).toBeVisible()
  await expect(pricing.getByText('当前毛利润 / 毛利率：¥4.87655 / 32.5103%')).toBeVisible()

  await pricing.getByRole('button', { name: '确认应用本批建议售价' }).click()
  const confirmation = page.getByRole('dialog', { name: '确认应用调价建议' })
  await confirmation.getByLabel('我已逐项核对当前售价、建议售价、毛利润和毛利率，并确认应用此批结果。').check()
  const applyResponsePromise = page.waitForResponse(response =>
    response.url().endsWith('/pricing-rules/apply') && response.request().method() === 'POST',
  )
  await confirmation.getByRole('button', { name: '确认并原子应用' }).click()
  const applyResponse = await applyResponsePromise
  expect(applyResponse.status()).toBe(200)
  const applyBody = await applyResponse.json() as { data: { items: Array<{ salePrice: string; costPrice: string; compareAtPrice: string }> } }
  expect(applyBody.data.items).toEqual([expect.objectContaining({
    salePrice: expectedSalePrice, costPrice: '10.12345', compareAtPrice: '30.00',
  })])
  await expect(pricing.getByRole('status')).toContainText('已确认应用 1 个 SKU')
  await expect(priceRow.getByLabel('销售价（¥）')).toHaveValue(expectedSalePrice)
  await expect(priceRow.getByLabel('成本价（¥）')).toHaveValue('10.12345')
  await expect(priceRow.getByLabel('划线价（¥）')).toHaveValue('30.00')
}

test('管理员可在桌面端预览并确认应用固定利润定价', async ({ page }) => {
  await runPricingRuleFlow(page, { width: 1440, height: 1000 }, 'fixed_profit', '11.00')
})

test('管理员可在移动端预览并确认应用按成本计算的加价率', async ({ page }) => {
  await runPricingRuleFlow(page, { width: 390, height: 844 }, 'percentage_markup', '12.65')
})

test('admin manages a real product through category, SKU, price, media, rich text, stock and lifecycle', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const editorWarnings: string[] = []
  page.on('console', message => {
    if (message.type() === 'warning' && message.text().includes('TextSelection endpoint not pointing into a node with inline content')) {
      editorWarnings.push(message.text())
    }
  })
  await signIn(page)

  const productName = `D6 浏览器商品 ${randomUUID().slice(0, 8)}`
  await page.goto('/admin/products/new')
  await expect(page.getByLabel('商品名称')).toBeEnabled()
  await page.getByLabel('商品名称').fill(productName)
  await page.getByLabel('默认 SKU 销售价（人民币）').fill('18.90')
  await page.getByRole('button', { name: '保存为草稿' }).click()
  await continueToCreatedProduct(page)
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
  await matrix.getByRole('button', { name: '保留所选组合' }).click()
  await matrix.getByLabel('保留组合 月卡').check()
  await matrix.getByLabel('保留组合 年卡').check()
  await matrix.getByRole('button', { name: '预览 SKU 差异' }).click()
  await expect(matrix.getByRole('heading', { name: '保存预览' })).toBeVisible()
  await matrix.getByLabel('我已查看移除、改配和退役影响，确认提交此差异').check()
  await matrix.getByRole('button', { name: '保存规格与 SKU' }).click()
  await expect(matrix.getByRole('status')).toContainText('规格组和 SKU 矩阵已保存')
  await expect(matrix.getByText('共 3 个')).toBeVisible()
  const retainedSkuIds = await page.evaluate(async (id) => {
    const result = await fetch(`/api/v1/admin/products/${id}`).then(response => response.json()) as { data: { variants: Array<{
      id: string; skuCode: string; salePrice: string; enabled: boolean; retiredAt: string | null;
      options: Array<{ groupName: string; valueName: string }>
    }> } }
    return result.data.variants
  }, productId)
  expect(retainedSkuIds.find(variant => variant.id === initialSku.id)?.retiredAt).not.toBeNull()
  const activeSku = retainedSkuIds.find(variant => variant.retiredAt === null)
  expect(activeSku).toBeDefined()

  const selectedModeSku = retainedSkuIds.find(variant => variant.retiredAt === null && variant.id !== activeSku!.id)!
  const selectedModeRow = skuListRow(matrix, selectedModeSku.skuCode)
  await selectedModeRow.getByLabel('启用销售').uncheck()
  const selectedPreviewRequest = page.waitForRequest(request => request.url().endsWith(`/api/v1/admin/products/${productId}/variant-matrix/preview`))
  await matrix.getByRole('button', { name: '预览 SKU 差异' }).click()
  const selectedPreviewPayload = (await selectedPreviewRequest).postDataJSON() as {
    mode: string
    combinations: Array<{ skuId?: string; enabled?: boolean }>
  }
  expect(selectedPreviewPayload.mode).toBe('selected')
  expect(selectedPreviewPayload.combinations).toContainEqual(expect.objectContaining({ skuId: selectedModeSku.id, enabled: false }))
  await matrix.getByLabel('我已查看移除、改配和退役影响，确认提交此差异').check()
  const selectedSaveRequest = page.waitForRequest(request => request.url().endsWith(`/api/v1/admin/products/${productId}/variant-matrix`) && request.method() === 'PUT')
  await matrix.getByRole('button', { name: '保存规格与 SKU' }).click()
  expect((await selectedSaveRequest).postDataJSON()).toEqual(selectedPreviewPayload)
  await expect(matrix.getByRole('status')).toContainText('规格组和 SKU 矩阵已保存')
  await page.reload()
  await expect(skuListRow(matrix, selectedModeSku.skuCode).getByLabel('启用销售')).not.toBeChecked()
  const unchangedSku = { ...selectedModeSku, enabled: false }

  const allMode = matrix.getByRole('button', { name: '自动生成全部组合' })
  await allMode.click()
  await matrix.getByRole('button', { name: '添加规格值' }).click()
  await page.getByLabel('套餐版本 的选项 3').fill('两年卡')
  await matrix.getByLabel('新增 SKU 默认售价（人民币）').fill('1.00')
  await matrix.getByLabel('新 SKU 默认启用销售').uncheck()
  const changedSkuRow = matrix.locator('li').filter({ hasText: activeSku!.skuCode }).first()
  await changedSkuRow.getByLabel('启用销售').uncheck()

  const previewRequest = page.waitForRequest(request => request.url().endsWith(`/api/v1/admin/products/${productId}/variant-matrix/preview`))
  await matrix.getByRole('button', { name: '预览 SKU 差异' }).click()
  const previewPayload = (await previewRequest).postDataJSON() as Record<string, unknown>
  expect(previewPayload.mode).toBe('all')
  expect(previewPayload.combinations).toBeUndefined()
  expect(previewPayload.skuEnabledUpdates).toEqual([{ skuId: activeSku!.id, enabled: false }])
  const disabledPreviewRow = matrix.locator('section[aria-labelledby="matrix-preview-title"] li').filter({ hasText: activeSku!.skuCode })
  await expect(disabledPreviewRow).toContainText('保存后暂时停用')
  await matrix.getByLabel('我已查看移除、改配和退役影响，确认提交此差异').check()
  const saveRequest = page.waitForRequest(request => request.url().endsWith(`/api/v1/admin/products/${productId}/variant-matrix`) && request.method() === 'PUT')
  await matrix.getByRole('button', { name: '保存规格与 SKU' }).click()
  expect((await saveRequest).postDataJSON()).toEqual(previewPayload)
  await expect(matrix.getByRole('status')).toContainText('规格组和 SKU 矩阵已保存')

  const afterAllMode = await page.evaluate(async (id) => {
    const result = await fetch(`/api/v1/admin/products/${id}`).then(response => response.json()) as { data: { variants: Array<{
      id: string; skuCode: string; salePrice: string; enabled: boolean; retiredAt: string | null;
      options: Array<{ valueName: string }>
    }> } }
    return result.data.variants
  }, productId)
  expect(afterAllMode.find(variant => variant.id === activeSku!.id)).toMatchObject({
    skuCode: activeSku!.skuCode, salePrice: activeSku!.salePrice, enabled: false,
  })
  expect(afterAllMode.find(variant => variant.id === unchangedSku.id)).toMatchObject({
    skuCode: unchangedSku.skuCode, salePrice: unchangedSku.salePrice, enabled: unchangedSku.enabled,
  })
  expect(afterAllMode.find(variant => variant.options[0]?.valueName === '两年卡')).toMatchObject({ salePrice: '1.00', enabled: false })
  await page.reload()
  const refreshedChangedSku = skuListRow(matrix, activeSku!.skuCode)
  await expect(refreshedChangedSku.getByLabel('启用销售')).not.toBeChecked()
  await expect(skuListRow(matrix, initialSku.skuCode).getByText('永久退役')).toBeVisible()
  await expect(skuListRow(matrix, initialSku.skuCode).getByLabel('启用销售')).toHaveCount(0)

  await allMode.click()
  await refreshedChangedSku.getByLabel('启用销售').check()
  const restorePreview = page.waitForRequest(request => request.url().endsWith(`/api/v1/admin/products/${productId}/variant-matrix/preview`))
  await matrix.getByRole('button', { name: '预览 SKU 差异' }).click()
  expect((await restorePreview).postDataJSON()).toMatchObject({
    mode: 'all', skuEnabledUpdates: [{ skuId: activeSku!.id, enabled: true }],
  })
  await matrix.getByLabel('我已查看移除、改配和退役影响，确认提交此差异').check()
  await matrix.getByRole('button', { name: '保存规格与 SKU' }).click()
  await expect(matrix.getByRole('status')).toContainText('规格组和 SKU 矩阵已保存')
  await page.reload()
  await expect(skuListRow(matrix, activeSku!.skuCode).getByLabel('启用销售')).toBeChecked()

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
  await editor.type('图片后仍可继续输入。')
  await expect(editor).toContainText('图片后仍可继续输入。')
  await editor.press('ControlOrMeta+End')
  await editor.press('Enter')
  await editor.type('二级标题结构验收')
  await editor.press('ControlOrMeta+End')
  await rich.getByRole('button', { name: '标题二级' }).click()
  await expect(editor.locator('h2')).toContainText('二级标题结构验收')
  await editor.evaluate((element) => {
    const textNode = element.querySelector('h2')?.firstChild
    if (!(textNode instanceof Text)) throw new Error('Expected the heading to contain a text node')
    const textLength = textNode.textContent?.length ?? 0
    const range = element.ownerDocument.createRange()
    range.setStart(textNode, textLength - 2)
    range.setEnd(textNode, textLength)
    const selection = element.ownerDocument.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await expect.poll(() => editor.evaluate(element => element.ownerDocument.getSelection()?.toString())).toBe('验收')
  await rich.getByRole('button', { name: '加粗' }).click()
  await expect(editor.locator('h2 strong')).toContainText('验收')
  await rich.getByRole('button', { name: '撤销' }).click()
  await expect(editor.locator('h2 strong')).toHaveCount(0)
  await rich.getByRole('button', { name: '重做' }).click()
  await expect(editor.locator('h2 strong')).toContainText('验收')
  expect(editorWarnings).toEqual([])
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
  await expect(page.locator('#rich-content [contenteditable="true"]')).toContainText('图片后仍可继续输入。')
  await expect(page.locator('#rich-content h2 strong')).toContainText('验收')
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
  await expect(page.locator('#inventory').getByText('库存尚未配置。')).toHaveCount(3)
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
  await continueToCreatedProduct(page)

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
  await continueToCreatedProduct(page)
  const productId = page.url().split('/').at(-1)!
  const initialSku = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/admin/products/${id}`).then(result => result.json()) as { data: { variants: Array<{ id: string; skuCode: string }> } }
    return response.data.variants[0]!
  }, productId)

  const inventory = page.locator('#inventory')
  const inventoryRow = inventory.locator('li').filter({ hasText: initialSku.skuCode }).first()
  page.once('dialog', dialog => dialog.accept())
  await inventoryRow.getByRole('combobox').click()
  await page.getByRole('option', { name: '按数量管理' }).click()
  await expect(inventoryRow.getByText('实际 0 · 预留 0 · 可售 0')).toBeVisible()
  const revisionBeforeAdjustment = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/admin/products/${id}`).then(result => result.json()) as { data: { revision: number } }
    return response.data.revision
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
  await matrix.getByRole('button', { name: '保留所选组合' }).click()
  await matrix.getByLabel('保留组合 基础').check()
  await matrix.getByLabel('保留组合 扩展').check()
  await matrix.getByRole('button', { name: '预览 SKU 差异' }).click()
  await expect(matrix.getByRole('heading', { name: '保存预览' })).toBeVisible()
  await matrix.getByLabel('我已查看移除、改配和退役影响，确认提交此差异').check()

  await inventoryRow.getByRole('button', { name: '查看调整历史' }).click()
  await inventory.getByLabel('变更数量').fill('1')
  await inventory.getByLabel('调整原因').fill('D6 规格编辑并发到货')
  await inventory.getByRole('button', { name: '提交库存调整' }).click()
  await expect(inventoryRow.getByText('实际 1 · 预留 0 · 可售 1')).toBeVisible()
  const productRevision = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/admin/products/${id}`).then(result => result.json()) as { data: { revision: number } }
    return response.data.revision
  }, productId)
  expect(productRevision).toBe(revisionBeforeAdjustment)

  await matrix.getByRole('button', { name: '保存规格与 SKU' }).click()
  await expect(matrix.getByRole('alert')).toContainText('实际库存尚未清零')
  await expect(page.getByRole('heading', { name: '商品数据已变化，需要你决定如何处理' })).toHaveCount(0)
  expect(matrix.getByLabel('并发版本 的选项 2')).toHaveValue('扩展')
  await matrix.getByRole('button', { name: '预览 SKU 差异' }).click()
  await expect(matrix.getByLabel('并发版本 的选项 2')).toHaveValue('扩展')
  await expect(matrix.getByText('待保存永久退役')).toBeVisible()
  await expect(matrix.getByText('不能退役：实际库存未清零')).toBeVisible()
  await expect(matrix.getByRole('button', { name: '保存规格与 SKU' })).toBeDisabled()
})

test('protects SSR, resolves an independent-context revision conflict, and stays usable at 320px in both themes', async ({ page, browser }) => {
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
  await continueToCreatedProduct(page)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  const productId = page.url().split('/').at(-1)!

  const secondContext = await browser.newContext({ storageState: await page.context().storageState() })
  const secondPage = await secondContext.newPage()
  await secondPage.setViewportSize({ width: 768, height: 900 })
  await secondPage.goto(new URL(`/admin/products/${productId}`, page.url()).toString())
  await expect(secondPage.getByLabel('商品名称')).toHaveValue(productName)
  await expect.poll(() => secondPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  const otherContextName = `${productName} 另一会话版本`
  await secondPage.getByLabel('商品名称').fill(otherContextName)
  await secondPage.locator('#basic').getByRole('button', { name: '保存基本信息' }).click()
  await expect(secondPage.getByRole('heading', { level: 1, name: otherContextName })).toBeVisible()

  const nameField = page.locator('#basic').getByLabel('商品名称')
  const locallyRetainedName = `${productName} 本地版本`
  await nameField.fill(locallyRetainedName)
  await page.locator('#basic').getByRole('button', { name: '保存基本信息' }).click()
  await expect(page.getByRole('heading', { name: '商品数据已变化，需要你决定如何处理' })).toBeVisible()
  await expect(page.getByText('服务器修订', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '保留本地输入，确认后再保存' }).click()
  await page.locator('#basic').getByRole('button', { name: '保存基本信息' }).click()
  await expect(page.getByRole('heading', { level: 1, name: locallyRetainedName })).toBeVisible()
  await expect(secondPage.getByLabel('商品名称')).toHaveValue(otherContextName)
  await secondContext.close()

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

test('category UI reorders duplicate ranks, moves levels, toggles visibility and protects referenced deletes', async ({ page }) => {
  await signIn(page)
  await page.goto('/admin/products/new')
  await expect(page.getByLabel('商品名称')).toBeEnabled()
  await page.getByLabel('商品名称').fill(`D6 分类验收商品 ${randomUUID().slice(0, 8)}`)
  await page.getByLabel('默认 SKU 销售价（人民币）').fill('6.80')
  await page.getByRole('button', { name: '保存为草稿' }).click()
  await continueToCreatedProduct(page)

  const categoriesSection = page.locator('#categories')
  await categoriesSection.getByRole('button', { name: '管理分类' }).click()
  const dialog = page.getByRole('dialog', { name: '分类管理' })
  const names = ['D6 排序甲', 'D6 排序乙', 'D6 排序丙'].map(name => `${name} ${randomUUID().slice(0, 5)}`)
  for (const name of names) {
    await dialog.getByLabel('分类名称').fill(name)
    await dialog.getByRole('button', { name: '创建', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('分类已创建')
  }
  const readAllCategories = async () => page.evaluate(async () => {
    const result = await fetch('/api/v1/admin/categories').then(response => response.json()) as {
      data: { categories: Array<{ id: string; name: string; parentId: string | null; sortOrder: number; isVisible: boolean }> }
    }
    return result.data.categories
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
  })
  const readCategories = async () => (await readAllCategories()).filter(category => names.includes(category.name))
  const initial = await readCategories()
  expect(initial.map(category => category.sortOrder)).toEqual([0, 0, 0])
  const row = (name: string) => dialog.locator('article').filter({ hasText: name }).first()

  await row(names[2]!).getByRole('button', { name: '移到同级最前' }).click()
  await expect(dialog.getByRole('status')).toContainText('分类已移到同级最前')
  let rootOrder = (await readAllCategories()).filter(category => category.parentId === null)
  expect(rootOrder[0]?.name).toBe(names[2])
  expect(rootOrder.map(category => category.sortOrder)).toEqual(rootOrder.map((_, index) => index))

  await row(names[0]!).getByRole('button', { name: '移到同级最后' }).click()
  await expect(dialog.getByRole('status')).toContainText('分类已移到同级最后')
  const ordered = await readCategories()
  rootOrder = (await readAllCategories()).filter(category => category.parentId === null)
  expect(rootOrder[0]?.name).toBe(names[2])
  expect(rootOrder.at(-1)?.name).toBe(names[0])
  expect(rootOrder.map(category => category.sortOrder)).toEqual(rootOrder.map((_, index) => index))
  await page.reload()
  await page.locator('#categories').getByRole('button', { name: '管理分类' }).click()
  const reloadedDialog = page.getByRole('dialog', { name: '分类管理' })
  const reloadedNames = (await readCategories()).map(category => category.name)
  expect(reloadedNames).toEqual([names[2], names[1], names[0]])

  const middleRow = reloadedDialog.locator('article').filter({ hasText: names[1] }).first()
  await middleRow.getByRole('combobox').click()
  await page.getByRole('option', { name: names[2], exact: true }).click()
  await middleRow.getByRole('button', { name: '保存层级' }).click()
  await expect(reloadedDialog.getByRole('status')).toContainText('分类层级已更新')
  const movedCategory = (await readCategories()).find(category => category.name === names[1])!
  expect(movedCategory.parentId).toBe(ordered[0]!.id)

  const parentRow = reloadedDialog.locator('article').filter({ hasText: names[2] }).first()
  await parentRow.getByRole('button', { name: '隐藏分类' }).click()
  await expect(reloadedDialog.getByRole('status')).toContainText('分类已隐藏')
  expect((await readCategories()).find(category => category.name === names[2])?.isVisible).toBe(false)
  await parentRow.getByRole('button', { name: '显示分类' }).click()
  await expect(reloadedDialog.getByRole('status')).toContainText('分类已显示')

  page.once('dialog', browserDialog => browserDialog.accept())
  await parentRow.getByRole('button', { name: '删除' }).click()
  await expect(reloadedDialog.getByRole('status')).toContainText('先移动或删除子分类')

  const childRow = reloadedDialog.locator('article').filter({ hasText: names[1] }).first()
  await childRow.getByRole('combobox').click()
  await page.getByRole('option', { name: '顶层分类', exact: true }).click()
  await childRow.getByRole('button', { name: '保存层级' }).click()
  await expect(reloadedDialog.getByRole('status')).toContainText('分类层级已更新')
  page.once('dialog', browserDialog => browserDialog.accept())
  await childRow.getByRole('button', { name: '删除' }).click()
  await expect(reloadedDialog.getByRole('status')).toContainText('分类已删除')
  expect((await readCategories()).some(category => category.name === names[1])).toBe(false)

  await page.keyboard.press('Escape')
  await categoriesSection.getByRole('combobox').first().click()
  await page.getByRole('option', { name: names[0] }).click()
  await categoriesSection.getByRole('button', { name: '保存分类' }).click()
  await expect(categoriesSection.getByRole('status')).toContainText('商品分类已保存')
  await categoriesSection.getByRole('button', { name: '管理分类' }).click()
  const referencedRow = page.getByRole('dialog', { name: '分类管理' }).locator('article').filter({ hasText: names[0] }).first()
  page.once('dialog', browserDialog => browserDialog.accept())
  await referencedRow.getByRole('button', { name: '删除' }).click()
  await expect(page.getByRole('dialog', { name: '分类管理' }).getByRole('status'))
    .toContainText('商品仍将此分类用作主分类')
})

test('media sharing blocks physical deletion and preserves another product after gallery removal', async ({ page }) => {
  await signIn(page)
  const png = readFileSync(new URL('../fixtures/d6-upload.png', import.meta.url))
  const makeDraft = async (name: string) => {
    await page.goto('/admin/products/new')
    await expect(page.getByLabel('商品名称')).toBeEnabled({ timeout: 10_000 })
    await page.getByLabel('商品名称').fill(name)
    await page.getByLabel('默认 SKU 销售价（人民币）').fill('3.50')
    await page.getByRole('button', { name: '保存为草稿' }).click()
    await continueToCreatedProduct(page)
    return page.url().split('/').at(-1)!
  }
  const sourceId = await makeDraft(`D6 共用图片来源 ${randomUUID().slice(0, 8)}`)
  const sourceGallery = page.locator('#gallery')
  await sourceGallery.getByLabel('上传商品图片').setInputFiles({ name: 'shared-d6.png', mimeType: 'image/png', buffer: png })
  await expect(sourceGallery.getByRole('status')).toContainText('图片已上传并加入待保存相册')
  await sourceGallery.getByRole('button', { name: '保存相册' }).click()
  await expect(sourceGallery.getByRole('status')).toContainText('商品相册顺序与引用已保存')
  const sourceMediaId = await page.evaluate(async (id) => {
    const result = await fetch(`/api/v1/admin/products/${id}`).then(response => response.json()) as { data: { gallery: Array<{ id: string }> } }
    return result.data.gallery[0]!.id
  }, sourceId)

  const secondId = await makeDraft(`D6 共用图片复用 ${randomUUID().slice(0, 8)}`)
  const gallery = page.locator('#gallery')
  await gallery.getByRole('button', { name: '从图片库复用' }).click()
  const mediaDialog = page.getByRole('dialog', { name: '图片库' })
  await mediaDialog.getByLabel('按媒体 ID 搜索').fill(sourceMediaId)
  await mediaDialog.getByRole('button', { name: '搜索图片' }).click()
  const mediaCard = mediaDialog.locator('li').filter({ hasText: sourceMediaId })
  await expect(mediaCard).toBeVisible()
  await expect(mediaCard).toContainText('被引用 1 次')
  await mediaCard.getByRole('button', { name: '加入待保存相册' }).click()
  await page.keyboard.press('Escape')
  await gallery.getByRole('button', { name: '保存相册' }).click()
  await expect(gallery.getByRole('status')).toContainText('商品相册顺序与引用已保存')
  await gallery.getByRole('button', { name: '从图片库复用' }).click()
  const sharedCard = page.getByRole('dialog', { name: '图片库' }).locator('li').filter({ hasText: sourceMediaId })
  await expect(sharedCard).toContainText('被引用 2 次')
  await expect(sharedCard.getByRole('button', { name: '永久删除文件' })).toBeDisabled()
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto(`/admin/products/${sourceId}`)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  const sourceSection = page.locator('#gallery')
  await sourceSection.getByRole('button', { name: '从商品相册移除图片 1' }).click()
  await sourceSection.getByRole('button', { name: '保存相册' }).click()
  await expect(sourceSection.getByRole('status')).toContainText('商品相册顺序与引用已保存')
  const retained = await page.evaluate(async ({ productId, mediaId }) => {
    const product = await fetch(`/api/v1/admin/products/${productId}`).then(response => response.json()) as { data: { gallery: Array<{ id: string }> } }
    const image = await fetch(`/api/v1/media/${mediaId}/detail.webp`)
    return { galleryContainsMedia: product.data.gallery.some(item => item.id === mediaId), imageStatus: image.status }
  }, { productId: secondId, mediaId: sourceMediaId })
  expect(retained).toEqual({ galleryContainsMedia: true, imageStatus: 200 })
  await page.goto(`/admin/products/${secondId}`)
  await expect(page.locator('#gallery img')).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test('product list issues one initial request and ignores out-of-order search, filter, sort and page responses', async ({ page }) => {
  test.setTimeout(60000)
  await page.setViewportSize({ width: 320, height: 850 })
  await signIn(page)
  const productNames = [`D6 慢搜索 ${randomUUID().slice(0, 8)}`, `D6 快搜索 ${randomUUID().slice(0, 8)}`]
  for (const name of productNames) {
    await page.goto('/admin/products/new')
    await expect(page.getByLabel('商品名称')).toBeEnabled()
    await page.getByLabel('商品名称').fill(name)
    await page.getByLabel('默认 SKU 销售价（人民币）').fill('2.00')
    await page.getByRole('button', { name: '保存为草稿' }).click()
    await continueToCreatedProduct(page)
  }

  const listRequests: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/v1/admin/products' && url.search) listRequests.push(url.href)
  })
  const initialResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return response.request().method() === 'GET' && url.pathname === '/api/v1/admin/products'
  })
  await page.goto('/admin/products')
  await initialResponse
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name: '商品管理' })).toBeVisible()
  expect(listRequests).toHaveLength(1)

  let releaseOldSearch!: () => void
  let markOldSearchReady!: () => void
  let markOldSearchDone!: () => void
  const oldSearchReady = new Promise<void>(resolve => { markOldSearchReady = resolve })
  const oldSearchDone = new Promise<void>(resolve => { markOldSearchDone = resolve })
  const oldSearchGate = new Promise<void>(resolve => { releaseOldSearch = resolve })
  const holdOldSearch = async (route: import('@playwright/test').Route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('search') === productNames[0]) {
      const response = await route.fetch()
      markOldSearchReady()
      await oldSearchGate
      await route.fulfill({ response })
      markOldSearchDone()
      return
    }
    await route.continue()
  }
  await page.route('**/api/v1/admin/products?*', holdOldSearch)
  const search = page.getByRole('textbox', { name: '搜索商品' })
  await search.fill(productNames[0]!)
  await oldSearchReady
  await search.fill(productNames[1]!)
  await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe(productNames[1])
  const fastCard = page.locator('section[aria-label="商品列表"] article').filter({ hasText: productNames[1]! })
  await expect(fastCard).toBeVisible()
  releaseOldSearch()
  await oldSearchDone
  await expect(fastCard).toBeVisible()
  await expect(page.locator('section[aria-label="商品列表"] article').filter({ hasText: productNames[0]! })).toHaveCount(0)
  await page.goBack()
  await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe(productNames[0])
  await expect(page.locator('section[aria-label="商品列表"] article').filter({ hasText: productNames[0]! })).toBeVisible()
  await page.goForward()
  await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe(productNames[1])
  await expect(page.locator('section[aria-label="商品列表"] article').filter({ hasText: productNames[1]! })).toBeVisible()

  await page.unroute('**/api/v1/admin/products?*', holdOldSearch)
  await page.goto('/admin/products?pageSize=1&sortBy=createdAt&sortOrder=asc')
  await expect(page.locator('section[aria-label="商品列表"] article').first()).toBeVisible()
  let releaseOldFilter!: () => void
  let markOldFilterReady!: () => void
  let markOldFilterDone!: () => void
  const oldFilterReady = new Promise<void>(resolve => { markOldFilterReady = resolve })
  const oldFilterDone = new Promise<void>(resolve => { markOldFilterDone = resolve })
  const oldFilterGate = new Promise<void>(resolve => { releaseOldFilter = resolve })
  const holdOldFilter = async (route: import('@playwright/test').Route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'draft' && url.searchParams.get('sortBy') === 'createdAt'
      && url.searchParams.get('sortOrder') === 'asc' && url.searchParams.get('page') === '1') {
      const response = await route.fetch()
      markOldFilterReady()
      await oldFilterGate
      await route.fulfill({ response })
      markOldFilterDone()
      return
    }
    await route.continue()
  }
  await page.route('**/api/v1/admin/products?*', holdOldFilter)
  await page.getByRole('combobox', { name: '商品状态筛选' }).click()
  await page.getByRole('option', { name: '草稿', exact: true }).click()
  await oldFilterReady
  await page.getByRole('combobox', { name: '商品排序方式' }).click()
  await page.getByRole('option', { name: '最新创建', exact: true }).click()
  await expect(page).toHaveURL(/sortOrder=desc/)
  await expect(page.locator('section[aria-label="商品列表"] article').first()).toBeVisible()
  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page).toHaveURL(/page=2/)
  const expectedPage = await page.evaluate(async () => {
    const query = new URLSearchParams(location.search)
    query.set('page', '2')
    const response = await fetch(`/api/v1/admin/products?${query.toString()}`)
    const result = await response.json() as { data: { items: Array<{ name: string }> } }
    return result.data.items[0]?.name
  })
  await expect(page.locator('section[aria-label="商品列表"] article').first()).toContainText(expectedPage!)
  releaseOldFilter()
  await oldFilterDone
  await expect(page).toHaveURL(/page=2.*sortBy=createdAt.*sortOrder=desc|sortBy=createdAt.*sortOrder=desc.*page=2/)
  await expect(page.locator('section[aria-label="商品列表"] article').first()).toContainText(expectedPage!)
  await page.unroute('**/api/v1/admin/products?*', holdOldFilter)

  let releaseLateSuccess!: () => void
  let markLateSuccessReady!: () => void
  let markLateSuccessDone!: () => void
  const lateSuccessReady = new Promise<void>(resolve => { markLateSuccessReady = resolve })
  const lateSuccessDone = new Promise<void>(resolve => { markLateSuccessDone = resolve })
  const lateSuccessGate = new Promise<void>(resolve => { releaseLateSuccess = resolve })
  const routeFailingLatest = async (route: import('@playwright/test').Route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('search') === productNames[0]) {
      const response = await route.fetch()
      markLateSuccessReady()
      await lateSuccessGate
      await route.fulfill({ response })
      markLateSuccessDone()
      return
    }
    if (url.searchParams.get('search') === 'D6 最新请求失败') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEMPORARY', message: 'temporary' } }) })
      return
    }
    await route.continue()
  }
  await page.route('**/api/v1/admin/products?*', routeFailingLatest)
  await search.fill(productNames[0]!)
  await lateSuccessReady
  await search.fill('D6 最新请求失败')
  await expect(page.getByRole('alert').filter({ hasText: '服务器暂时无法处理此请求' })).toBeVisible()
  releaseLateSuccess()
  await lateSuccessDone
  await expect(page.getByRole('alert').filter({ hasText: '服务器暂时无法处理此请求' })).toBeVisible()
  await expect(page.locator('section[aria-label="商品列表"] article')).toHaveCount(0)
  await expect.poll(() => new URL(page.url()).searchParams.get('search')).toContain('D6 最新请求失败')
  await page.unroute('**/api/v1/admin/products?*', routeFailingLatest)
})
