import { randomUUID } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'

const fixtureSecret = 'fixture-V3-secret-only-never-real-2026!'

async function choose(page: Page, combo: Locator, text: RegExp) {
  await combo.click()
  await page.getByRole('option').filter({ hasText: text }).first().click()
}

test('prepares, previews, reviews and restores a supplier product mapping with the read-only V3 fixture', async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true', 'The external Compose server does not include the isolated V3 fixture.')
  test.setTimeout(120_000)
  page.setDefaultTimeout(20_000)
  const origin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin
  await page.context().addCookies([{ name: 'aikayun_admin_session', value: createBrowserAdminSession(),
    url: origin, httpOnly: true, sameSite: 'Lax' }])
  const csrfResponse = await page.request.get('/api/v1/admin/auth/csrf')
  const headers = { origin, 'x-csrf-token': (await csrfResponse.json()).data.csrfToken as string }

  const ids = Object.fromEntries(['account', 'image', 'digits', 'channel', 'channelOption', 'note', 'region', 'south', 'city',
    'verification', 'verificationOption', 'extraNote'].map(key => [key, randomUUID()])) as Record<string, string>
  const definition = { fields: [
    { id: ids.account, meaningKey: 'account_name', type: 'text', label: '账号', required: true, maxLength: 120 },
    { id: ids.image, meaningKey: 'proof_image', type: 'image', label: '凭证图片', required: false, maxCount: 2 },
    { id: ids.digits, meaningKey: 'member_number', type: 'digits', label: '会员编号', required: true, maxLength: 128 },
    { id: ids.channel, meaningKey: 'channel', type: 'select', label: '渠道', required: true,
      options: [{ id: ids.channelOption, meaningKey: 'default_channel', label: '默认渠道' }] },
    { id: ids.note, meaningKey: 'note', type: 'textarea', label: '备注', required: false, maxLength: 1000 },
    { id: ids.region, meaningKey: 'region', type: 'cascade', label: '地区与验证', required: true, options: [{
      id: ids.south, meaningKey: 'south_china', label: '广西',
      expandedFields: [
        { id: ids.verification, meaningKey: 'verification_code', type: 'select', label: '验证方式', required: true,
          options: [{ id: ids.verificationOption, meaningKey: 'identity_tail', label: '身份证后六位' }] },
        { id: ids.extraNote, meaningKey: 'extra_note', type: 'text', label: '扩展备注', required: false },
      ],
      children: [{ id: ids.city, meaningKey: 'nanning', label: '南宁市' }],
    }] },
  ] }

  const createdTemplate = await page.request.post('/api/v1/admin/purchase-form-templates', {
    headers, data: { name: `映射 UI 冻结模板 ${randomUUID().slice(0, 8)}`, definition },
  })
  expect(createdTemplate.status(), await createdTemplate.text()).toBe(201)
  const template = (await createdTemplate.json()).data.template as { id: string; revision: number }
  const frozenTemplate = await page.request.post(`/api/v1/admin/purchase-form-templates/${template.id}/versions`, {
    headers, data: { expectedRevision: template.revision },
  })
  expect(frozenTemplate.status(), await frozenTemplate.text()).toBe(201)
  const templateVersionId = (await frozenTemplate.json()).data.id as string

  const createdProduct = await page.request.post('/api/v1/admin/products', { headers, data: {
    name: `映射 UI 商品 ${randomUUID().slice(0, 8)}`, description: '', productType: 'digital', defaultSku: { salePrice: '1.00' },
  } })
  expect(createdProduct.status(), await createdProduct.text()).toBe(201)
  let product = (await createdProduct.json()).data
  const productId = product.id as string
  const skuId = product.variants[0].id as string
  const activated = await page.request.patch(`/api/v1/admin/products/${productId}/lifecycle`, {
    headers, data: { expectedRevision: product.revision, status: 'active' },
  })
  expect(activated.status(), await activated.text()).toBe(200)
  const inventory = (await (await page.request.get(`/api/v1/admin/products/${productId}/inventory`)).json()).data
  const inventorySku = inventory.variants.find((row: { skuId: string }) => row.skuId === skuId)
  const inventoryMode = await page.request.put(`/api/v1/admin/products/${productId}/variants/${skuId}/inventory-mode`, {
    headers, data: { expectedRevision: inventory.productRevision, expectedSkuRevision: inventorySku.skuRevision,
      expectedInventoryRevision: inventorySku.inventoryRevision, inventoryMode: 'unlimited' },
  })
  expect(inventoryMode.status(), await inventoryMode.text()).toBe(200)
  const manualFulfillment = await page.request.put(`/api/v1/admin/products/${productId}/variants/${skuId}/manual-fulfillment`, {
    headers, data: { enabled: true },
  })
  expect(manualFulfillment.status(), await manualFulfillment.text()).toBe(200)
  product = (await (await page.request.get(`/api/v1/admin/products/${productId}`)).json()).data
  const assigned = await page.request.put(`/api/v1/admin/products/${productId}/purchase-form`, {
    headers, data: { expectedRevision: product.revision, mode: 'template', templateVersionId },
  })
  expect(assigned.status(), await assigned.text()).toBe(200)
  const purchaseFormState = (await (await page.request.get('/api/v1/admin/storefront/purchase-forms')).json()).data
  if (purchaseFormState.status === 'preparing') {
    const transitioned = await page.request.post('/api/v1/admin/storefront/purchase-forms/transition', {
      headers, data: { expectedStatus: 'preparing', nextStatus: 'active', expectedImpactHash: purchaseFormState.impactHash },
    })
    expect(transitioned.status(), await transitioned.text()).toBe(200)
  } else {
    product = (await (await page.request.get(`/api/v1/admin/products/${productId}`)).json()).data
    const applied = await page.request.post(`/api/v1/admin/products/${productId}/purchase-form/apply`, {
      headers, data: { expectedRevision: product.revision, expectedMode: 'template', expectedTemplateVersionId: templateVersionId },
    })
    expect(applied.status(), await applied.text()).toBe(200)
  }

  const connectionResponse = await page.request.post('/api/v1/admin/supplier-connections', { headers, data: {
    name: `映射 UI 只读连接 ${randomUUID().slice(0, 8)}`, providerType: 'kayixin_customer_v3',
    baseUrl: 'http://127.0.0.1:3102', credentials: { appId: '602401', appSecret: fixtureSecret },
  } })
  expect(connectionResponse.status(), await connectionResponse.text()).toBe(201)
  const connectionName = (await connectionResponse.json()).data[0].name as string

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/admin/supplier-product-mappings')
  await expect(page.getByRole('heading', { name: '供应商商品与购买字段映射' })).toBeVisible()
  await choose(page, page.getByRole('combobox', { name: '本地商品与 SKU' }), /映射 UI 商品/)
  await choose(page, page.getByRole('combobox', { name: '卡易信只读连接' }), new RegExp(connectionName))
  await page.getByRole('button', { name: '读取商品列表', exact: true }).click()
  await page.getByLabel('搜索上游商品名称或编号').fill('201002')
  await page.getByRole('button', { name: '读取商品列表', exact: true }).click()
  const upstreamProductButton = page.getByRole('button', { name: /夹具多单规格/u })
  await expect(upstreamProductButton).toBeVisible()
  await upstreamProductButton.click()
  await choose(page, page.getByRole('combobox', { name: '上游 SKU 与规格组合' }), /月卡.*monthly/)
  await page.getByRole('button', { name: '重新读取并固定本次结构观察', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已保存带有效期的服务端只读结构观察')

  const structure = page.getByRole('list', { name: '上游字段与选项结构' })
  await page.locator('details').filter({ has: page.getByText('上游字段与选项完整结构') }).locator('summary').click()
  await expect(structure).toContainText('充值账号')
  await expect(structure).toContainText('原始 value="guangxi"')
  await expect(structure).toContainText('required=true')
  await expect(structure).toContainText('含未执行的上游 regex')

  const mappingSection = page.locator('section[aria-labelledby="field-mapping-title"]')
  const fieldRows = mappingSection.locator('article')
  const selectField = async (meaningKey: string, sourceTitle: RegExp) => {
    const row = fieldRows.filter({ hasText: `meaningKey ${meaningKey}` })
    await choose(page, row.getByRole('combobox').nth(0), sourceTitle)
  }
  await selectField('account_name', /充值账号/)
  await selectField('proof_image', /图片凭证/)
  await selectField('member_number', /数字编号/)
  await selectField('channel', / · 渠道 · 单选/)
  await selectField('note', / · 备注 · 多行文本/)
  await selectField('region', / · 地区与验证 · 级联/)
  await selectField('verification_code', /扩展验证编号/)
  await selectField('extra_note', /扩展备注/)
  await choose(page, fieldRows.filter({ hasText: 'meaningKey channel' }).getByRole('combobox').nth(1), /默认.*value=/)
  await choose(page, fieldRows.filter({ hasText: 'meaningKey region' }).getByRole('combobox').nth(1), /广西.*guangxi/)
  await choose(page, fieldRows.filter({ hasText: 'meaningKey region' }).getByRole('combobox').nth(2), /南宁市.*nanning/)
  await choose(page, fieldRows.filter({ hasText: 'meaningKey verification_code' }).getByRole('combobox').nth(1), /身份证后六位.*value=/)

  const preview = page.locator('section[aria-labelledby="preview-title"] pre')
  await expect(preview).toContainText('internal_mapping_preview')
  await expect(preview).toContainText('executedUpstreamCode')
  await expect(page.getByRole('button', { name: '创建草稿', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '创建草稿', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('草稿已保存')
  await expect(page.getByText('当前结构可审核')).toBeVisible()

  await page.getByRole('button', { name: '重新读取与识别漂移', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('已重新读取当前上游详情并更新结构检查')
  await page.getByRole('button', { name: '审核并追加版本', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('结构映射审核版本已追加并冻结')
  await page.getByRole('button', { name: '查看历史', exact: true }).click()
  await expect(page.getByRole('heading', { name: '不可变审核历史' })).toBeVisible()
  await expect(page.getByText(/审核版本 v1/u)).toBeVisible()
  await page.getByRole('button', { name: '恢复为新草稿', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已恢复为新草稿')
  await expect(page.getByText('状态：草稿')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(fixtureSecret)

  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const stats = await (await page.request.get('http://127.0.0.1:3102/__fixture/stats')).json()
  expect(stats.paths.length).toBeGreaterThan(4)
  expect(stats.paths.every((path: string) => ['/api/v3/user/getAccount', '/api/v3/goods/getList', '/api/v3/goods/getDetail'].includes(path))).toBe(true)
})
