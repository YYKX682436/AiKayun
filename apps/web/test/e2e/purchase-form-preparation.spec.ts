import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'
import { expectClientMounted } from './browser-diagnostics'

type Product = { id: string; revision: number; variants: Array<{ id: string; skuCode: string; revision: number }> }

function responseGate() {
  let signal!: () => void
  let release!: () => void
  return {
    reached: new Promise<void>(resolve => { signal = resolve }),
    waiting: new Promise<void>(resolve => { release = resolve }),
    signal: () => signal(),
    release: () => release(),
  }
}

async function releaseAndSettle<T extends { status(): number }>(page: Page, gate: ReturnType<typeof responseGate>, response: Promise<T>): Promise<T> {
  gate.release()
  const delivered = await response
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  return delivered
}

async function attachAdmin(page: Page): Promise<void> {
  const token = createBrowserAdminSession()
  await page.context().addCookies([{
    name: 'aikayun_admin_session',
    value: token,
    url: new URL('/', process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin,
    httpOnly: true,
    sameSite: 'Lax',
  }])
  const session = await page.request.get('/api/v1/admin/session')
  expect(session.status(), await session.text()).toBe(200)
}

async function csrfToken(page: Page): Promise<string> {
  const response = await page.request.get('/api/v1/admin/auth/csrf')
  expect(response.status()).toBe(200)
  return (await response.json()).data.csrfToken as string
}

async function adminHeaders(page: Page) {
  const origin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin
  return { origin, 'x-csrf-token': await csrfToken(page) }
}

async function noHorizontalOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 })
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }))
  expect(dimensions.page, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(dimensions.viewport)
}

test('edits, freezes, previews, and prepares product/SKU references without exposing customer inputs', async ({ page }) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(10_000)
  await attachAdmin(page)
  await page.goto('/admin/purchase-form-templates')
  await expect(page.locator('#admin-main').getByRole('heading', { name: '购买填写模板', exact: true })).toBeVisible()
  await expect(page.locator('#admin-main')).toHaveAttribute('data-purchase-templates-ready', 'true')
  await expect(page.getByText('准备配置，尚未应用到顾客购买。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新建模板' }).click()
  await expect(page).toHaveURL(/\/admin\/purchase-form-templates\/[0-9a-f-]+$/u)
  await expect(page.getByRole('heading', { name: /新购买填写模板/u })).toBeVisible()
  await page.getByLabel('模板名称').fill('E2E 本地账号填写模板')

  const fields = page.getByRole('region', { name: '字段定义' })
  const fieldType = fields.getByRole('combobox').first()
  await fieldType.click()
  await page.getByRole('option', { name: '数字字符' }).click()
  await fields.getByRole('button', { name: '添加字段' }).click()
  await fields.getByLabel('字段 1名称').fill('账号编号')
  await fields.getByRole('checkbox', { name: '必填' }).first().check()

  await fieldType.click()
  await page.getByRole('option', { name: '级联选择' }).click()
  await fields.getByRole('button', { name: '添加字段' }).click()
  await fields.getByLabel('级联字段 2 名称').fill('区服')
  await fields.getByRole('checkbox', { name: '必填' }).last().check()
  await fields.getByRole('button', { name: '添加下一层' }).click()
  await fields.getByLabel('第 2 层选项名称').fill('东区')
  await fields.getByRole('button', { name: '添加所选分支字段' }).last().click()

  const expandedType = fields.getByRole('combobox', { name: '字段类型' }).last()
  await expandedType.click()
  await page.getByRole('option', { name: '单项选择' }).click()
  await expandedType.click()
  await page.getByRole('option', { name: '私有图片' }).click()
  await expandedType.click()
  await page.getByRole('option', { name: '单行文本' }).click()

  await fieldType.click()
  await page.getByRole('option', { name: '私有图片' }).click()
  await fields.getByRole('button', { name: '添加字段' }).click()
  await fields.getByLabel('字段 3名称').fill('图片证据')

  await fieldType.click()
  await page.getByRole('option', { name: '单行文本' }).click()
  await fields.getByRole('button', { name: '添加字段' }).click()
  const typeSwitchInput = fields.getByLabel('字段 4名称')
  await typeSwitchInput.fill('类型切换字段')
  const typeSwitch = fields.getByRole('combobox', { name: '字段类型' }).last()
  await typeSwitch.click()
  await page.getByRole('option', { name: '单项选择' }).click()
  await typeSwitch.click()
  await page.getByRole('option', { name: '私有图片' }).click()

  await page.getByRole('button', { name: '检查填写完整性' }).click()
  await expect(page.getByText(/还有 \d+ 项需要检查/u)).toBeVisible()
  await expect(page.getByText('此项尚未填写。').first()).toBeVisible()
  await page.getByLabel('账号编号').fill('000012345678901234567890')
  await page.getByLabel('区服第 1 层').click()
  await page.getByRole('option', { name: '一级选项' }).click()
  await page.getByLabel('区服第 2 层').click()
  await page.getByRole('option', { name: '东区' }).click()
  await page.getByLabel('扩展字段').fill('Player-A')
  await expect(page.getByLabel('图片证据图片上传预览（未启用）')).toBeDisabled()
  await expect(page.getByRole('button', { name: '检查填写完整性' })).toBeVisible()
  await page.getByRole('button', { name: '检查填写完整性' }).click()
  await expect(page.getByText('填写完整，当前仅为后台预览。')).toBeVisible()

  for (const width of [320, 390, 768, 1440]) await noHorizontalOverflow(page, width)
  await page.setViewportSize({ width: 1440, height: 900 })
  const templateId = new URL(page.url()).pathname.split('/').at(-1)!
  let saveGate: ReturnType<typeof responseGate> | null = null
  let freezeGate: ReturnType<typeof responseGate> | null = null
  await page.route(`**/api/v1/admin/purchase-form-templates/${templateId}`, async (route) => {
    if (route.request().method() === 'PUT' && saveGate) {
      const gate = saveGate
      saveGate = null
      const response = await route.fetch()
      gate.signal()
      await gate.waiting
      await route.fulfill({ response })
      return
    }
    await route.continue()
  })
  await page.route(`**/api/v1/admin/purchase-form-templates/${templateId}/versions`, async (route) => {
    if (route.request().method() === 'POST' && freezeGate) {
      const gate = freezeGate
      freezeGate = null
      const response = await route.fetch()
      gate.signal()
      await gate.waiting
      await route.fulfill({ response })
      return
    }
    await route.continue()
  })
  const saveResponseGate = responseGate()
  saveGate = saveResponseGate
  await page.getByRole('button', { name: '保存编辑草稿' }).click()
  await saveResponseGate.reached
  await expect(page.getByLabel('模板名称')).toBeDisabled()
  await expect(fields.getByRole('button', { name: '添加字段' })).toBeDisabled()
  await expect(typeSwitch).toBeDisabled()
  await expect(expandedType).toBeDisabled()
  await expect(fields.getByLabel('字段 4名称')).toHaveValue('类型切换字段')
  saveResponseGate.release()
  await expect(page.getByRole('status')).toContainText('编辑草稿已保存')
  await page.getByLabel('模板名称').fill('E2E 本地账号填写模板 v1')
  const freezeSaveGate = responseGate()
  const freezeVersionGate = responseGate()
  saveGate = freezeSaveGate
  freezeGate = freezeVersionGate
  await page.getByRole('button', { name: '保存为准备配置版本' }).click()
  await freezeSaveGate.reached
  await expect(page.getByLabel('模板名称')).toBeDisabled()
  await expect(fields.getByRole('button', { name: '添加字段' })).toBeDisabled()
  await expect(typeSwitch).toBeDisabled()
  freezeSaveGate.release()
  await freezeVersionGate.reached
  await expect(page.getByLabel('模板名称')).toBeDisabled()
  await expect(fields.getByRole('button', { name: '添加字段' })).toBeDisabled()
  await expect(expandedType).toBeDisabled()
  freezeVersionGate.release()
  await expect(page.getByText('不可变准备版本已保存；顾客购买填写仍未启用。')).toBeVisible()
  await expect(page.getByText(/E2E 本地账号填写模板 v1 · v1/u).first()).toBeVisible()
  await page.getByRole('button', { name: /E2E 本地账号填写模板 v1 · v1/u }).click()
  await expect(page.getByRole('heading', { name: '历史版本交互预览' })).toBeVisible()

  const savedTemplateResponse = await page.request.get(`/api/v1/admin/purchase-form-templates/${templateId}`)
  expect(savedTemplateResponse.status()).toBe(200)
  const savedDefinition = (await savedTemplateResponse.json()).data.definition as {
    fields: Array<Record<string, unknown> & {
      options?: Array<Record<string, unknown> & {
        children?: Array<Record<string, unknown> & { expandedFields?: Array<Record<string, unknown>> }>
      }>
    }>
  }
  const topLevelImage = savedDefinition.fields.find(field => field.label === '类型切换字段')!
  expect(topLevelImage.type).toBe('image')
  expect(Object.keys(topLevelImage).sort()).toEqual(['id', 'label', 'maxCount', 'meaningKey', 'required', 'type'])
  const cascadeDefinition = savedDefinition.fields.find(field => field.type === 'cascade')!
  const expandedDefinition = cascadeDefinition.options![0]!.children![0]!.expandedFields!
  expect(expandedDefinition[0]!.type).toBe('text')
  expect(Object.keys(expandedDefinition[0]!).sort()).toEqual(['id', 'label', 'maxLength', 'meaningKey', 'required', 'type'])

  const v1ButtonLabel = 'E2E 本地账号填写模板 v1 · v1'
  await page.getByLabel('模板名称').fill('E2E 本地账号填写模板 v2')
  await page.getByRole('button', { name: '保存为准备配置版本' }).click()
  await expect(page.getByText('不可变准备版本已保存；顾客购买填写仍未启用。')).toBeVisible()
  const versionsResponse = await page.request.get(`/api/v1/admin/purchase-form-templates/${templateId}/versions?page=1&pageSize=100`)
  const versions = (await versionsResponse.json()).data.items as Array<{ id: string; name: string; versionNumber: number }>
  const versionOne = versions.find(version => version.versionNumber === 1)!
  const versionTwo = versions.find(version => version.versionNumber === 2)!
  const firstHistoryGate = responseGate()
  let holdFirstHistory = true
  await page.route(`**/api/v1/admin/purchase-form-templates/${templateId}/versions/${versionOne.id}`, async (route) => {
    if (route.request().method() === 'GET' && holdFirstHistory) {
      holdFirstHistory = false
      const response = await route.fetch()
      firstHistoryGate.signal()
      await firstHistoryGate.waiting
      await route.fulfill({ response })
      return
    }
    await route.continue()
  })
  await page.getByRole('button', { name: v1ButtonLabel }).click()
  await firstHistoryGate.reached
  await page.getByRole('button', { name: `${versionTwo.name} · v2` }).click()
  const versionTwoPreview = page.getByRole('paragraph').filter({ hasText: `${versionTwo.name} · v2` })
  await expect(versionTwoPreview).toBeVisible()
  const firstHistoryDelivered = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/purchase-form-templates/${templateId}/versions/${versionOne.id}`
    && response.request().method() === 'GET')
  expect((await releaseAndSettle(page, firstHistoryGate, firstHistoryDelivered)).status()).toBe(200)
  await expect(versionTwoPreview).toBeVisible()

  const oldHistoryErrorGate = responseGate()
  let holdOldHistoryError = true
  await page.unroute(`**/api/v1/admin/purchase-form-templates/${templateId}/versions/${versionOne.id}`)
  await page.route(`**/api/v1/admin/purchase-form-templates/${templateId}/versions/${versionOne.id}`, async (route) => {
    if (route.request().method() === 'GET' && holdOldHistoryError) {
      holdOldHistoryError = false
      await route.fetch()
      oldHistoryErrorGate.signal()
      await oldHistoryErrorGate.waiting
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INJECTED_OLD_HISTORY_ERROR', message: 'old response' } }) })
      return
    }
    await route.continue()
  })
  await page.getByRole('button', { name: v1ButtonLabel }).click()
  await oldHistoryErrorGate.reached
  await page.getByRole('button', { name: `${versionTwo.name} · v2` }).click()
  await expect(versionTwoPreview).toBeVisible()
  const oldHistoryErrorDelivered = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/purchase-form-templates/${templateId}/versions/${versionOne.id}`
    && response.request().method() === 'GET')
  expect((await releaseAndSettle(page, oldHistoryErrorGate, oldHistoryErrorDelivered)).status()).toBe(500)
  await expect(versionTwoPreview).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)

  const created = await page.request.post('/api/v1/admin/products', {
    headers: await adminHeaders(page),
    data: {
      name: `填写准备关联商品-${randomUUID().slice(0, 8)}`,
      description: 'E2E preparation association fixture',
      productType: 'digital',
      defaultSku: { salePrice: '5.00' },
    },
  })
  expect(created.status(), await created.text()).toBe(201)
  const product = (await created.json()).data as Product
  await page.goto(`/admin/products/${product.id}`)
  await expectClientMounted(page, '#purchase-form-preparation')
  const assignment = page.locator('#purchase-form-preparation')
  await expect(assignment).toHaveAttribute('data-assignment-ready', 'true')
  await expect(assignment.getByText('准备配置，尚未应用', { exact: true })).toBeVisible()
  await assignment.getByRole('combobox', { name: '关联方式' }).click()
  await page.getByRole('option', { name: '关联模板版本（准备）' }).click()
  await assignment.getByRole('combobox', { name: '本地模板' }).click()
  await page.getByRole('option', { name: /E2E 本地账号填写模板/u }).click()
  await assignment.getByRole('combobox', { name: '冻结版本' }).click()
  await page.getByRole('option', { name: 'v1 · E2E 本地账号填写模板' }).click()
  await assignment.getByRole('button', { name: '保存商品准备关联' }).click()
  await expect(assignment.getByRole('status')).toContainText('尚未应用到顾客购买')
  await assignment.getByRole('combobox', { name: '覆盖方式' }).click()
  await page.getByRole('option', { name: '明确不使用模板' }).click()
  await assignment.getByRole('button', { name: /保存 SKU 准备覆盖/u }).click()
  await expect(assignment.getByRole('status')).toContainText('尚未应用到顾客购买')
  await expect(page.getByText('顾客填写、图片上传、购物车或结算入口。')).toBeVisible()
  for (const width of [320, 390, 768, 1440]) await noHorizontalOverflow(page, width)
})

test('isolates delayed SKU reads and saves by product/SKU request generation', async ({ page }) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(10_000)
  await attachAdmin(page)
  const headers = await adminHeaders(page)
  const templateIdField = randomUUID()
  const templateCreated = await page.request.post('/api/v1/admin/purchase-form-templates', {
    headers,
    data: {
      name: 'SKU 延迟请求回归模板',
      definition: { fields: [{
        id: templateIdField, meaningKey: 'account_id', type: 'text', label: '账号', required: true, maxLength: 120,
      }] },
    },
  })
  expect(templateCreated.status(), await templateCreated.text()).toBe(201)
  const template = (await templateCreated.json()).data.template as { id: string; revision: number }
  const frozen = await page.request.post(`/api/v1/admin/purchase-form-templates/${template.id}/versions`, {
    headers, data: { expectedRevision: template.revision },
  })
  expect(frozen.status(), await frozen.text()).toBe(201)

  const productCreated = await page.request.post('/api/v1/admin/products', {
    headers,
    data: {
      name: `SKU 延迟请求商品-${randomUUID().slice(0, 8)}`,
      description: 'Controlled response integration fixture',
      productType: 'digital',
      defaultSku: { salePrice: '6.00' },
    },
  })
  expect(productCreated.status(), await productCreated.text()).toBe(201)
  const createdProduct = (await productCreated.json()).data as Product
  const groupId = randomUUID()
  const optionA = randomUUID()
  const optionB = randomUUID()
  const matrix = await page.request.put(`/api/v1/admin/products/${createdProduct.id}/variant-matrix`, {
    headers,
    data: {
      expectedRevision: createdProduct.revision,
      mode: 'selected',
      groups: [{
        id: groupId, name: '套餐', sortOrder: 0, enabled: true,
        values: [
          { id: optionA, name: 'A', sortOrder: 0, enabled: true },
          { id: optionB, name: 'B', sortOrder: 1, enabled: true },
        ],
      }],
      combinations: [
        { optionValueIds: [optionA], salePrice: '6.00', enabled: true },
        { optionValueIds: [optionB], salePrice: '7.00', enabled: true },
      ],
    },
  })
  expect(matrix.status(), await matrix.text()).toBe(200)
  const productResponse = await page.request.get(`/api/v1/admin/products/${createdProduct.id}`)
  expect(productResponse.status()).toBe(200)
  const product = (await productResponse.json()).data as Product
  expect(product.variants).toHaveLength(2)
  const variantA = product.variants[0]!
  const variantB = product.variants[1]!

  let failedBRead: ReturnType<typeof responseGate> | null = null
  let delayedBRead: ReturnType<typeof responseGate> | null = null
  let delayedASave: ReturnType<typeof responseGate> | null = null
  let delayedASaveBeforeServer: ReturnType<typeof responseGate> | null = null
  let delayedBSaveResponse: ReturnType<typeof responseGate> | null = null
  let delayedProductSaveResponse: ReturnType<typeof responseGate> | null = null
  let delayedASaveExpectedRevision: number | null = null
  let delayedBSaveResult: { productRevision: number; mode: string } | null = null
  let delayedProductSaveResult: { productRevision: number; mode: string } | null = null
  await page.route('**/api/v1/admin/products/*/variants/*/purchase-form', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    const match = pathname.match(/\/variants\/([^/]+)\/purchase-form$/u)
    if (!match) return route.continue()
    const variantId = match[1]
    if (route.request().method() === 'GET' && variantId === variantB.id && failedBRead) {
      const gate = failedBRead
      failedBRead = null
      gate.signal()
      await gate.waiting
      await route.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'CONTROLLED_SKU_READ_FAILURE', message: 'controlled delayed-read error' } }),
      })
      return
    }
    if (route.request().method() === 'GET' && variantId === variantB.id && delayedBRead) {
      const gate = delayedBRead
      delayedBRead = null
      const response = await route.fetch()
      gate.signal()
      await gate.waiting
      await route.fulfill({ response })
      return
    }
    if (route.request().method() === 'PUT' && variantId === variantA.id && delayedASaveBeforeServer) {
      const gate = delayedASaveBeforeServer
      delayedASaveBeforeServer = null
      delayedASaveExpectedRevision = route.request().postDataJSON().expectedRevision as number
      gate.signal()
      await gate.waiting
      await route.continue()
      return
    }
    if (route.request().method() === 'PUT' && variantId === variantB.id && delayedBSaveResponse) {
      const gate = delayedBSaveResponse
      delayedBSaveResponse = null
      const response = await route.fetch()
      delayedBSaveResult = (await response.json()).data as { productRevision: number; mode: string }
      gate.signal()
      await gate.waiting
      await route.fulfill({ response })
      return
    }
    if (route.request().method() === 'PUT' && variantId === variantA.id && delayedASave) {
      const gate = delayedASave
      delayedASave = null
      const response = await route.fetch()
      gate.signal()
      await gate.waiting
      await route.fulfill({ response })
      return
    }
    await route.continue()
  })
  await page.route(url => new URL(url).pathname === `/api/v1/admin/products/${product.id}/purchase-form`, async (route) => {
    if (route.request().method() === 'PUT' && delayedProductSaveResponse) {
      const gate = delayedProductSaveResponse
      delayedProductSaveResponse = null
      const response = await route.fetch()
      delayedProductSaveResult = (await response.json()).data as { productRevision: number; mode: string }
      gate.signal()
      await gate.waiting
      await route.fulfill({ response })
      return
    }
    await route.continue()
  })

  await page.goto(`/admin/products/${product.id}`)
  await expectClientMounted(page, '#purchase-form-preparation')
  const assignment = page.locator('#purchase-form-preparation')
  const skuPicker = assignment.getByRole('combobox', { name: 'SKU' })
  const assignmentMode = assignment.getByRole('combobox', { name: '覆盖方式' })
  const saveSku = assignment.getByRole('button', { name: /保存 SKU 准备覆盖/u })
  await expect(assignment).toHaveAttribute('data-assignment-ready', 'true')
  expect(await skuPicker.textContent()).toContain(variantA.skuCode)

  await assignmentMode.click()
  await page.getByRole('option', { name: '明确不使用模板' }).click()
  await saveSku.click()
  await expect(assignment.getByRole('status')).toContainText(`SKU ${variantA.skuCode} 准备覆盖已保存`)

  const failureGate = responseGate()
  failedBRead = failureGate
  await skuPicker.click()
  await page.getByRole('option', { name: new RegExp(variantB.skuCode) }).click()
  await failureGate.reached
  await expect(saveSku).toBeDisabled()
  await expect(assignmentMode).toContainText('跟随商品默认')

  await skuPicker.click()
  await page.getByRole('option', { name: new RegExp(variantA.skuCode) }).click()
  await expect(assignmentMode).toContainText('明确不使用模板')
  await expect(saveSku).toBeEnabled()
  const failedSkuRead = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/products/${product.id}/variants/${variantB.id}/purchase-form`
    && response.request().method() === 'GET')
  expect((await releaseAndSettle(page, failureGate, failedSkuRead)).status()).toBe(500)
  await expect(assignmentMode).toContainText('明确不使用模板')
  await expect(assignment.getByRole('alert')).toHaveCount(0)
  await expect(assignment.getByRole('status')).toHaveCount(0)

  const bGate = responseGate()
  delayedBRead = bGate
  await skuPicker.click()
  await page.getByRole('option', { name: new RegExp(variantB.skuCode) }).click()
  await bGate.reached
  await expect(saveSku).toBeDisabled()
  await expect(assignmentMode).toContainText('跟随商品默认')
  await skuPicker.click()
  await page.getByRole('option', { name: new RegExp(variantA.skuCode) }).click()
  await expect(assignmentMode).toContainText('明确不使用模板')
  await expect(saveSku).toBeEnabled()
  const delayedSkuRead = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/products/${product.id}/variants/${variantB.id}/purchase-form`
    && response.request().method() === 'GET')
  expect((await releaseAndSettle(page, bGate, delayedSkuRead)).status()).toBe(200)
  await expect(assignmentMode).toContainText('明确不使用模板')
  await expect(saveSku).toBeEnabled()

  await skuPicker.click()
  await page.getByRole('option', { name: new RegExp(variantB.skuCode) }).click()
  await expect(assignmentMode).toContainText('跟随商品默认')
  await expect(saveSku).toBeEnabled()

  await skuPicker.click()
  await page.getByRole('option', { name: new RegExp(variantA.skuCode) }).click()
  await expect(assignmentMode).toContainText('明确不使用模板')
  await assignmentMode.click()
  await page.getByRole('option', { name: '使用 SKU 覆盖版本（准备）' }).click()
  await assignment.getByRole('combobox', { name: '本地模板' }).click()
  await page.getByRole('option', { name: /SKU 延迟请求回归模板/u }).click()
  await assignment.getByRole('combobox', { name: '冻结版本' }).click()
  await page.getByRole('option', { name: 'v1 · SKU 延迟请求回归模板' }).click()

  const aSaveGate = responseGate()
  delayedASave = aSaveGate
  await saveSku.click()
  await aSaveGate.reached
  await skuPicker.click()
  await page.getByRole('option', { name: new RegExp(variantB.skuCode) }).click()
  await expect(assignmentMode).toContainText('跟随商品默认')
  const delayedSkuSave = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/products/${product.id}/variants/${variantA.id}/purchase-form`
    && response.request().method() === 'PUT')
  expect((await releaseAndSettle(page, aSaveGate, delayedSkuSave)).status()).toBe(200)
  await expect(saveSku).toBeEnabled()
  await expect(assignmentMode).toContainText('跟随商品默认')
  await expect(assignment.getByRole('status')).toHaveCount(0)
  await expect(assignment.getByRole('alert')).toHaveCount(0)

  const savedA = await page.request.get(`/api/v1/admin/products/${product.id}/variants/${variantA.id}/purchase-form`)
  const savedB = await page.request.get(`/api/v1/admin/products/${product.id}/variants/${variantB.id}/purchase-form`)
  expect((await savedA.json()).data.mode).toBe('template')
  expect((await savedB.json()).data.mode).toBe('product_default')

  const beforeLateNoop = await page.request.get(`/api/v1/admin/products/${product.id}`)
  expect(beforeLateNoop.status()).toBe(200)
  const revisionBeforeLateNoop = ((await beforeLateNoop.json()).data as Product).revision
  await skuPicker.click()
  await page.getByRole('option', { name: new RegExp(variantA.skuCode) }).click()
  await expect(assignmentMode).toContainText('使用 SKU 覆盖版本（准备）')
  const noOpASaveGate = responseGate()
  delayedASave = noOpASaveGate
  await saveSku.click()
  await noOpASaveGate.reached

  await skuPicker.click()
  await page.getByRole('option', { name: new RegExp(variantB.skuCode) }).click()
  await expect(assignmentMode).toContainText('跟随商品默认')
  await assignmentMode.click()
  await page.getByRole('option', { name: '明确不使用模板' }).click()
  const changedBSave = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/products/${product.id}/variants/${variantB.id}/purchase-form`
    && response.request().method() === 'PUT')
  await saveSku.click()
  const changedBResponse = await changedBSave
  expect(changedBResponse.status()).toBe(200)
  expect(changedBResponse.request().postDataJSON().expectedRevision).toBe(revisionBeforeLateNoop)
  expect((await changedBResponse.json()).data.productRevision).toBe(revisionBeforeLateNoop + 1)
  await expect(assignment.getByRole('status')).toContainText(`SKU ${variantB.skuCode} 准备覆盖已保存`)
  await expect(page.getByText(new RegExp(`商品修订 ${revisionBeforeLateNoop + 1} ·`))).toBeVisible()

  const lateNoOpAResponse = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/products/${product.id}/variants/${variantA.id}/purchase-form`
    && response.request().method() === 'PUT')
  const lateNoOpA = await releaseAndSettle(page, noOpASaveGate, lateNoOpAResponse)
  expect(lateNoOpA.status()).toBe(200)
  expect((await lateNoOpA.json()).data.productRevision).toBe(revisionBeforeLateNoop)
  await expect(page.getByText(new RegExp(`商品修订 ${revisionBeforeLateNoop + 1} ·`))).toBeVisible()
  await expect(assignment.getByRole('status')).toContainText(`SKU ${variantB.skuCode} 准备覆盖已保存`)
  await expect(assignment.getByRole('alert')).toHaveCount(0)

  const unchangedBSave = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/products/${product.id}/variants/${variantB.id}/purchase-form`
    && response.request().method() === 'PUT')
  await saveSku.click()
  const unchangedBResponse = await unchangedBSave
  expect(unchangedBResponse.status()).toBe(200)
  expect(unchangedBResponse.request().postDataJSON().expectedRevision).toBe(revisionBeforeLateNoop + 1)
  expect((await unchangedBResponse.json()).data.productRevision).toBe(revisionBeforeLateNoop + 1)
  await expect(page.getByText(new RegExp(`商品修订 ${revisionBeforeLateNoop + 1} ·`))).toBeVisible()

  // A request can reach the API only after a newer, already-executed no-op
  // response has been held at the browser boundary. The stale full response
  // must not replace B's assignment revision after A advances the product.
  const beforeOldSkuResponse = await page.request.get(`/api/v1/admin/products/${product.id}`)
  expect(beforeOldSkuResponse.status()).toBe(200)
  const revisionBeforeOldSkuResponse = ((await beforeOldSkuResponse.json()).data as Product).revision
  await skuPicker.click()
  await page.getByRole('option', { name: new RegExp(variantA.skuCode) }).click()
  await expect(assignmentMode).toContainText('使用 SKU 覆盖版本（准备）')
  await assignmentMode.click()
  await page.getByRole('option', { name: '跟随商品默认' }).click()

  const aRequestGate = responseGate()
  delayedASaveBeforeServer = aRequestGate
  const aChangedResponse = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/products/${product.id}/variants/${variantA.id}/purchase-form`
    && response.request().method() === 'PUT')
  await saveSku.click()
  await aRequestGate.reached
  expect(delayedASaveExpectedRevision).toBe(revisionBeforeOldSkuResponse)

  await skuPicker.click()
  await page.getByRole('option', { name: new RegExp(variantB.skuCode) }).click()
  await expect(assignmentMode).toContainText('明确不使用模板')
  const bNoopResponseGate = responseGate()
  delayedBSaveResponse = bNoopResponseGate
  const bNoopResponse = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/products/${product.id}/variants/${variantB.id}/purchase-form`
    && response.request().method() === 'PUT')
  await saveSku.click()
  await bNoopResponseGate.reached
  expect(delayedBSaveResult).toMatchObject({ productRevision: revisionBeforeOldSkuResponse, mode: 'none' })

  const changedA = await releaseAndSettle(page, aRequestGate, aChangedResponse)
  expect(changedA.status()).toBe(200)
  expect(changedA.request().postDataJSON().expectedRevision).toBe(revisionBeforeOldSkuResponse)
  expect((await changedA.json()).data.productRevision).toBe(revisionBeforeOldSkuResponse + 1)
  await expect(page.getByText(new RegExp(`商品修订 ${revisionBeforeOldSkuResponse + 1} ·`))).toBeVisible()
  await expect(assignmentMode).toContainText('明确不使用模板')
  await expect(assignment.getByRole('alert')).toHaveCount(0)

  const oldBNoop = await releaseAndSettle(page, bNoopResponseGate, bNoopResponse)
  expect(oldBNoop.status()).toBe(200)
  expect((await oldBNoop.json()).data.productRevision).toBe(revisionBeforeOldSkuResponse)
  await expect(page.getByText(new RegExp(`商品修订 ${revisionBeforeOldSkuResponse + 1} ·`))).toBeVisible()
  await expect(assignmentMode).toContainText('明确不使用模板')
  await expect(assignment.getByRole('alert')).toHaveCount(0)
  const staleBStatus = assignment.getByRole('status')
  const staleBStatusCount = await staleBStatus.count()
  const staleBSuccessMessage = staleBStatusCount ? await staleBStatus.textContent() : null

  await assignmentMode.click()
  await page.getByRole('option', { name: '跟随商品默认' }).click()
  const bAfterOldResponse = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/products/${product.id}/variants/${variantB.id}/purchase-form`
    && response.request().method() === 'PUT')
  await saveSku.click()
  const bAfterOld = await bAfterOldResponse
  expect(bAfterOld.request().postDataJSON().expectedRevision).toBe(revisionBeforeOldSkuResponse + 1)
  expect(bAfterOld.status()).toBe(200)
  expect((await bAfterOld.json()).data.productRevision).toBe(revisionBeforeOldSkuResponse + 2)
  expect(staleBSuccessMessage).toBeNull()
  const savedBAfterOld = await page.request.get(`/api/v1/admin/products/${product.id}/variants/${variantB.id}/purchase-form`)
  expect((await savedBAfterOld.json()).data).toMatchObject({ mode: 'product_default', productRevision: revisionBeforeOldSkuResponse + 2 })
  await expect(assignment.getByRole('status')).toContainText(`SKU ${variantB.skuCode} 准备覆盖已保存`)
  await expect(page.getByText(new RegExp(`商品修订 ${revisionBeforeOldSkuResponse + 2} ·`))).toBeVisible()

  // Exercise the product-default response writeback with the same stale-revision
  // ordering: an A mutation advances the shared revision while a B no-op reply
  // is still waiting in the browser.
  await skuPicker.click()
  await page.getByRole('option', { name: new RegExp(variantA.skuCode) }).click()
  await expect(assignmentMode).toContainText('跟随商品默认')
  await assignmentMode.click()
  await page.getByRole('option', { name: '明确不使用模板' }).click()
  const beforeProductDefaultResponse = await page.request.get(`/api/v1/admin/products/${product.id}`)
  expect(beforeProductDefaultResponse.status()).toBe(200)
  const revisionBeforeProductDefaultResponse = ((await beforeProductDefaultResponse.json()).data as Product).revision

  const aProductRequestGate = responseGate()
  delayedASaveBeforeServer = aProductRequestGate
  const aProductChangedResponse = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/products/${product.id}/variants/${variantA.id}/purchase-form`
    && response.request().method() === 'PUT')
  await saveSku.click()
  await aProductRequestGate.reached
  expect(delayedASaveExpectedRevision).toBe(revisionBeforeProductDefaultResponse)
  await skuPicker.click()
  await page.getByRole('option', { name: new RegExp(variantB.skuCode) }).click()
  await expect(assignmentMode).toContainText('跟随商品默认')

  const productSaveGate = responseGate()
  delayedProductSaveResponse = productSaveGate
  const productNoopResponse = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/products/${product.id}/purchase-form`
    && response.request().method() === 'PUT')
  await assignment.getByRole('button', { name: '保存商品准备关联' }).click()
  await productSaveGate.reached
  expect(delayedProductSaveResult).toMatchObject({ productRevision: revisionBeforeProductDefaultResponse, mode: 'not_configured' })

  const changedAForProduct = await releaseAndSettle(page, aProductRequestGate, aProductChangedResponse)
  expect(changedAForProduct.status()).toBe(200)
  expect(changedAForProduct.request().postDataJSON().expectedRevision).toBe(revisionBeforeProductDefaultResponse)
  expect((await changedAForProduct.json()).data.productRevision).toBe(revisionBeforeProductDefaultResponse + 1)
  await expect(page.getByText(new RegExp(`商品修订 ${revisionBeforeProductDefaultResponse + 1} ·`))).toBeVisible()

  const oldProductNoop = await releaseAndSettle(page, productSaveGate, productNoopResponse)
  expect(oldProductNoop.status()).toBe(200)
  expect((await oldProductNoop.json()).data.productRevision).toBe(revisionBeforeProductDefaultResponse)
  await expect(page.getByText(new RegExp(`商品修订 ${revisionBeforeProductDefaultResponse + 1} ·`))).toBeVisible()
  await expect(assignment.getByRole('alert')).toHaveCount(0)
  await expect(assignment.getByRole('status')).toHaveCount(0)

  const productMode = assignment.getByRole('combobox', { name: '关联方式' })
  await productMode.click()
  await page.getByRole('option', { name: '明确不使用模板' }).click()
  const productAfterOldResponse = page.waitForResponse(response => new URL(response.url()).pathname
    === `/api/v1/admin/products/${product.id}/purchase-form`
    && response.request().method() === 'PUT')
  await assignment.getByRole('button', { name: '保存商品准备关联' }).click()
  const productAfterOld = await productAfterOldResponse
  expect(productAfterOld.status()).toBe(200)
  expect(productAfterOld.request().postDataJSON().expectedRevision).toBe(revisionBeforeProductDefaultResponse + 1)
  expect((await productAfterOld.json()).data.productRevision).toBe(revisionBeforeProductDefaultResponse + 2)
  const savedProductAfterOld = await page.request.get(`/api/v1/admin/products/${product.id}/purchase-form`)
  expect((await savedProductAfterOld.json()).data).toMatchObject({ mode: 'none', productRevision: revisionBeforeProductDefaultResponse + 2 })
  await expect(assignment.getByRole('status')).toContainText('商品默认模板准备关联已保存')
  await expect(page.getByText(new RegExp(`商品修订 ${revisionBeforeProductDefaultResponse + 2} ·`))).toBeVisible()
})
