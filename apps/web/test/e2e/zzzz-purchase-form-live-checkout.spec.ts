import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'

type Product = { id: string; revision: number; variants: Array<{ id: string; skuCode: string; revision: number }> }

const password = 'Browser-Purchase-Form-Password-2026!'

async function attachAdmin(page: Page): Promise<void> {
  const token = createBrowserAdminSession()
  await page.context().addCookies([{
    name: 'aikayun_admin_session',
    value: token,
    url: new URL('/', process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin,
    httpOnly: true,
    sameSite: 'Lax',
  }])
  expect((await page.request.get('/api/v1/admin/session')).status()).toBe(200)
}

async function adminHeaders(page: Page) {
  const csrf = await page.request.get('/api/v1/admin/auth/csrf')
  expect(csrf.status()).toBe(200)
  const origin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin
  return { origin, 'x-csrf-token': (await csrf.json()).data.csrfToken as string }
}

async function noHorizontalOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 })
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }))
  expect(dimensions.page, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(dimensions.viewport)
}

async function fillPurchaseFormWithImage(page: Page, account: string, character: string, note: string): Promise<void> {
  const form = page.locator('section[aria-labelledby="purchase-form-title"]')
  await page.getByLabel('账号编号').fill(account)
  await page.getByLabel('登录平台').click()
  await page.getByRole('option', { name: '网页端' }).click()
  await page.getByLabel('区服第 1 级').click()
  await page.getByRole('option', { name: '亚洲' }).click()
  await page.getByLabel('区服第 2 级').click()
  await page.getByRole('option', { name: '亚洲一服' }).click()
  await page.getByLabel('亚洲角色名').fill(character)
  await page.getByLabel('补充说明').fill(note)
  await page.getByLabel('购买凭证上传图片').setInputFiles({ name: 'guest-proof.png', mimeType: 'image/png', buffer: png })
  await form.getByRole('button', { name: '上传并保存' }).click()
  await expect(form.getByRole('status')).toContainText('图片已保存', { timeout: 20_000 })
  await form.getByRole('button', { name: '校验完整性' }).click()
  await expect(form.getByRole('status')).toContainText('填写校验通过', { timeout: 20_000 })
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQYlWO4UGDwHx9mGBkKAEsYm8GF2oHfAAAAAElFTkSuQmCC', 'base64')

test('admin activation connects the live purchase form to cart, checkout, order snapshots and pause recovery', async ({ page, browser }) => {
  test.setTimeout(240_000)
  page.setDefaultTimeout(12_000)
  const runtimeErrors: string[] = []
  page.on('pageerror', error => runtimeErrors.push(error.message))
  await attachAdmin(page)
  const headers = await adminHeaders(page)

  const ids = {
    account: randomUUID(), server: randomUUID(), asia: randomUUID(), asiaServer: randomUUID(),
    asiaCharacter: randomUUID(), europe: randomUUID(), europeServer: randomUUID(),
    europeCharacter: randomUUID(), platform: randomUUID(), web: randomUUID(), android: randomUUID(),
    notes: randomUUID(), image: randomUUID(),
  }
  const definition = { fields: [
    { id: ids.account, meaningKey: 'account_id', type: 'digits', label: '账号编号', required: true, maxLength: 64 },
    { id: ids.server, meaningKey: 'server_path', type: 'cascade', label: '区服', required: true, options: [
      { id: ids.asia, meaningKey: 'asia', label: '亚洲', children: [{ id: ids.asiaServer, meaningKey: 'asia_1', label: '亚洲一服', expandedFields: [
        { id: ids.asiaCharacter, meaningKey: 'asia_character', type: 'text', label: '亚洲角色名', required: true, maxLength: 80 },
      ] }] },
      { id: ids.europe, meaningKey: 'europe', label: '欧洲', children: [{ id: ids.europeServer, meaningKey: 'europe_1', label: '欧洲一服', expandedFields: [
        { id: ids.europeCharacter, meaningKey: 'europe_character', type: 'text', label: '欧洲角色名', required: true, maxLength: 80 },
      ] }] },
    ] },
    { id: ids.platform, meaningKey: 'platform', type: 'select', label: '登录平台', required: true, options: [
      { id: ids.web, meaningKey: 'web', label: '网页端' }, { id: ids.android, meaningKey: 'android', label: '安卓端' },
    ] },
    { id: ids.notes, meaningKey: 'purchase_notes', type: 'textarea', label: '补充说明', required: false, maxLength: 300 },
    { id: ids.image, meaningKey: 'proof_image', type: 'image', label: '购买凭证', required: true, maxCount: 1 },
  ] }
  const createdTemplate = await page.request.post('/api/v1/admin/purchase-form-templates', {
    headers, data: { name: `正式购买填写 ${randomUUID().slice(0, 8)}`, definition },
  })
  expect(createdTemplate.status(), await createdTemplate.text()).toBe(201)
  const template = (await createdTemplate.json()).data.template as { id: string; revision: number }
  const frozen = await page.request.post(`/api/v1/admin/purchase-form-templates/${template.id}/versions`, {
    headers, data: { expectedRevision: template.revision },
  })
  expect(frozen.status(), await frozen.text()).toBe(201)
  const version = (await frozen.json()).data as { id: string }

  const createdProduct = await page.request.post('/api/v1/admin/products', {
    headers, data: {
      name: `正式购买流程商品 ${randomUUID().slice(0, 8)}`,
      description: 'E2E fixture for the locally enabled purchase form flow.',
      productType: 'digital', defaultSku: { salePrice: '6.00' },
    },
  })
  expect(createdProduct.status(), await createdProduct.text()).toBe(201)
  let product = (await createdProduct.json()).data as Product
  const initialRevision = product.revision
  const activatedProduct = await page.request.patch(`/api/v1/admin/products/${product.id}/lifecycle`, {
    headers, data: { expectedRevision: initialRevision, status: 'active' },
  })
  expect(activatedProduct.status(), await activatedProduct.text()).toBe(200)
  product = (await activatedProduct.json()).data as Product
  const sku = product.variants[0]!
  const inventoryResponse = await page.request.get(`/api/v1/admin/products/${product.id}/inventory`)
  expect(inventoryResponse.status()).toBe(200)
  const inventory = (await inventoryResponse.json()).data as {
    productRevision: number
    variants: Array<{ skuId: string; skuRevision: number; inventoryRevision: number }>
  }
  const inventorySku = inventory.variants.find(variant => variant.skuId === sku.id)!
  const inventoryMode = await page.request.put(`/api/v1/admin/products/${product.id}/variants/${sku.id}/inventory-mode`, {
    headers, data: { expectedRevision: inventory.productRevision, expectedSkuRevision: inventorySku.skuRevision,
      expectedInventoryRevision: inventorySku.inventoryRevision, inventoryMode: 'unlimited' },
  })
  expect(inventoryMode.status(), await inventoryMode.text()).toBe(200)
  const manual = await page.request.put(`/api/v1/admin/products/${product.id}/variants/${sku.id}/manual-fulfillment`, {
    headers, data: { enabled: true },
  })
  expect(manual.status(), await manual.text()).toBe(200)
  const latestProduct = await page.request.get(`/api/v1/admin/products/${product.id}`)
  expect(latestProduct.status()).toBe(200)
  product = (await latestProduct.json()).data as Product
  const assignment = await page.request.put(`/api/v1/admin/products/${product.id}/purchase-form`, {
    headers, data: { expectedRevision: product.revision, mode: 'template', templateVersionId: version.id },
  })
  expect(assignment.status(), await assignment.text()).toBe(200)

  const beforeActivation = await page.request.get('/api/v1/admin/storefront/purchase-forms')
  expect((await beforeActivation.json()).data).toMatchObject({ status: 'preparing', readyToActivate: true })
  await page.goto('/admin/purchase-form-templates')
  const lifecyclePanel = page.locator('section[aria-labelledby="purchase-form-lifecycle-title"]')
  await expect(lifecyclePanel.getByRole('heading', { name: '购买填写启用状态' })).toBeVisible()
  await expect(lifecyclePanel.getByText('首次启用将应用全部当前准备关联。')).toBeVisible()
  page.on('dialog', dialog => dialog.accept())
  await lifecyclePanel.getByRole('button', { name: '确认并首次启用' }).click()
  await expect(lifecyclePanel.getByRole('status')).toContainText('购买填写已首次启用')
  await expect(lifecyclePanel.getByText('已启用', { exact: true })).toBeVisible()

  const currentForm = await page.request.get(`/api/v1/storefront/skus/${sku.id}/purchase-form`)
  expect(currentForm.status()).toBe(200)
  expect((await currentForm.json()).data).toMatchObject({
    status: 'active', required: true, templateVersionId: version.id,
  })

  const currentAdminHeaders = await adminHeaders(page)
  const secondTemplateResponse = await page.request.post('/api/v1/admin/purchase-form-templates', {
    headers: currentAdminHeaders, data: { name: `正式购买填写改版 ${randomUUID().slice(0, 8)}`, definition },
  })
  expect(secondTemplateResponse.status(), await secondTemplateResponse.text()).toBe(201)
  const secondTemplate = (await secondTemplateResponse.json()).data.template as { id: string; revision: number }
  const secondVersionResponse = await page.request.post(`/api/v1/admin/purchase-form-templates/${secondTemplate.id}/versions`, {
    headers: currentAdminHeaders, data: { expectedRevision: secondTemplate.revision },
  })
  expect(secondVersionResponse.status(), await secondVersionResponse.text()).toBe(201)
  const secondVersion = (await secondVersionResponse.json()).data as { id: string }
  const latestProductForApply = await page.request.get(`/api/v1/admin/products/${product.id}`)
  product = (await latestProductForApply.json()).data as Product
  const stagedRevision = await page.request.put(`/api/v1/admin/products/${product.id}/purchase-form`, {
    headers: currentAdminHeaders, data: { expectedRevision: product.revision, mode: 'template', templateVersionId: secondVersion.id },
  })
  expect(stagedRevision.status(), await stagedRevision.text()).toBe(200)
  expect((await (await page.request.get(`/api/v1/storefront/skus/${sku.id}/purchase-form`)).json()).data.templateVersionId)
    .toBe(version.id)
  const pendingApplyProduct = (await (await page.request.get(`/api/v1/admin/products/${product.id}`)).json()).data as Product
  const applyResponse = await page.request.post(`/api/v1/admin/products/${product.id}/purchase-form/apply`, {
    headers: currentAdminHeaders, data: { expectedRevision: pendingApplyProduct.revision, expectedMode: 'template',
      expectedTemplateVersionId: secondVersion.id },
  })
  expect(applyResponse.status(), await applyResponse.text()).toBe(200)
  const publicProduct = await page.request.get(`/api/v1/public/products/${product.id}`)
  expect(publicProduct.status()).toBe(200)
  expect(await publicProduct.text()).not.toContain('购买凭证')

  const username = `buyer-${randomUUID().replaceAll('-', '').slice(0, 20)}`
  await page.goto('/register')
  await expect(page.locator('[data-customer-register-ready]')).toHaveAttribute('data-customer-register-ready', 'true')
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('邮箱').fill(`${username}@example.test`)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码').fill(password)
  await Promise.all([
    page.waitForURL(/\/account$/u),
    page.getByRole('button', { name: '创建账户' }).click(),
  ])
  await expect(page.getByRole('heading', { name: '个人账户' })).toBeVisible()
  await expect(page.locator('[data-storefront-ready]')).toHaveAttribute('data-storefront-ready', 'true')

  const productPath = `/products/${product.id}`
  const accounts = ['000012345678901234567890', '000000000000000000000042']
  const roles = ['same-sku-asia', 'same-sku-europe']
  const archivedOrderIds: string[] = []
  for (let index = 0; index < accounts.length; index++) {
    await noHorizontalOverflow(page, 390)
    await page.goto(productPath)
    await expect(page.getByRole('heading', { name: /购买资料/u })).toBeVisible()
    const formRegion = page.locator('section[aria-labelledby="purchase-form-title"]')
    await formRegion.getByRole('button', { name: '校验完整性' }).click()
    await expect(formRegion.getByRole('status')).toContainText('还需填写')

    await page.getByLabel('账号编号').fill(accounts[index]!)
    await page.getByLabel('登录平台').click()
    await page.getByRole('option', { name: index === 0 ? '网页端' : '安卓端' }).click()
    await page.getByLabel('区服第 1 级').click()
    await page.getByRole('option', { name: index === 0 ? '亚洲' : '欧洲' }).click()
    await page.getByLabel('区服第 2 级').click()
    await page.getByRole('option', { name: index === 0 ? '亚洲一服' : '欧洲一服' }).click()
    await page.getByLabel(index === 0 ? '亚洲角色名' : '欧洲角色名').fill(roles[index]!)
    if (index === 0) {
      await page.getByLabel('区服第 1 级').click()
      await page.getByRole('option', { name: '欧洲' }).click()
      await expect(page.getByLabel('亚洲角色名')).toHaveCount(0)
      await page.getByLabel('区服第 2 级').click()
      await page.getByRole('option', { name: '欧洲一服' }).click()
      await page.getByLabel('欧洲角色名').fill(roles[index]!)
    }
    await page.getByLabel('补充说明').fill(`请处理 ${roles[index]}`)
    await formRegion.getByRole('button', { name: '保存填写内容' }).click()
    await expect(formRegion.getByRole('status')).toContainText('已保存部分内容')

    const imageInput = page.getByLabel('购买凭证上传图片')
    await imageInput.setInputFiles({ name: `purchase-${index}.png`, mimeType: 'image/png', buffer: png })
    await formRegion.getByRole('button', { name: '上传并保存' }).click()
    await expect(formRegion.getByRole('status')).toContainText('图片已保存')
    const uploadedImage = page.locator('img[alt="购买凭证已上传图片"]')
    await expect(uploadedImage).toHaveCount(1)
    const originalSrc = await uploadedImage.getAttribute('src')

    if (index === 0) {
      await page.route(/\/api\/v1\/storefront\/purchase-drafts\/[^/]+\/attachments$/u, route => route.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INJECTED_UPLOAD_FAILURE', message: '本轮可控图片故障' } }),
      }))
      await imageInput.setInputFiles({ name: 'failed-replacement.png', mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.from([1])]) })
      await formRegion.getByRole('button', { name: '上传并保存' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(uploadedImage).toHaveAttribute('src', originalSrc!)
      await page.unroute(/\/api\/v1\/storefront\/purchase-drafts\/[^/]+\/attachments$/u)
      await imageInput.setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: png })
      await formRegion.getByRole('button', { name: '上传并保存' }).click()
      await expect(formRegion.getByRole('status')).toContainText('图片已保存')
      await expect(uploadedImage).not.toHaveAttribute('src', originalSrc!)
    }

    await formRegion.getByRole('button', { name: '校验完整性' }).click()
    await expect(formRegion.getByRole('status')).toContainText('填写校验通过')
    await expect(page).not.toHaveURL(new RegExp(accounts[index]!, 'u'))
    const persisted = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]
      .map(key => `${key}:${localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? ''}`).join('\n'))
    expect(persisted).not.toContain(accounts[index]!)
    await page.getByRole('button', { name: '加入购物车' }).click()
    await expect.poll(async () => {
      const response = await page.request.get('/api/v1/customer/cart')
      if (response.status() !== 200) return 0
      return (await response.json()).data.items.length as number
    }).toBe(index + 1)
  }

  const cart = await page.request.get('/api/v1/customer/cart')
  expect(cart.status()).toBe(200)
  const cartItems = (await cart.json()).data.items as Array<{
    lineId: string; skuId: string; quantity: number; draftId: string; draftRevision: number
  }>
  expect(cartItems).toHaveLength(2)
  expect(new Set(cartItems.map(item => item.lineId)).size).toBe(2)
  expect(new Set(cartItems.map(item => item.draftId)).size).toBe(2)
  expect(cartItems.every(item => item.skuId === sku.id && item.quantity === 1)).toBe(true)

  await page.goto('/cart')
  const cartLines = page.getByRole('region', { name: '购物车商品' }).getByRole('listitem')
  await expect(cartLines).toHaveCount(2)
  await noHorizontalOverflow(page, 1440)
  await cartLines.first().getByRole('link', { name: '编辑购买资料' }).click()
  await expect(page).toHaveURL(/editLineId=/u)
  const editedAccountBefore = await page.getByLabel('账号编号').inputValue()
  const editedAccountIndex = accounts.indexOf(editedAccountBefore)
  expect(editedAccountIndex).toBeGreaterThanOrEqual(0)
  const editedAccountAfter = '000000000000000000000777'
  accounts[editedAccountIndex] = editedAccountAfter
  await page.getByLabel('账号编号').fill(editedAccountAfter)
  await page.getByRole('button', { name: '保存并返回购物车' }).click()
  await expect(page).toHaveURL(/\/cart$/u)
  await expect(page.getByRole('region', { name: '购物车商品' }).getByRole('listitem')).toHaveCount(2)
  await page.getByRole('link', { name: '查看结算报价' }).click()
  await expect(page).toHaveURL(/\/checkout\?/u)
  await expect(page.getByText('本次购买资料')).toHaveCount(2)
  await expect(page.getByText(accounts[0]!, { exact: true })).toBeVisible()
  await expect(page.getByText(accounts[1]!, { exact: true })).toBeVisible()
  await expect(page).not.toHaveURL(new RegExp(accounts[0]!, 'u'))
  await noHorizontalOverflow(page, 390)
  await noHorizontalOverflow(page, 1440)
  await page.getByRole('button', { name: '提交订单' }).click()
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/u)
  const orderId = new URL(page.url()).pathname.split('/').at(-1)!
  archivedOrderIds.push(orderId)
  await expect(page.getByRole('region', { name: '成交时保存的购买资料' })).toHaveCount(2)
  await expect(page.getByText(accounts[0]!, { exact: true })).toBeVisible()
  await expect(page.getByText(accounts[1]!, { exact: true })).toBeVisible()
  const archivedCustomerImage = page.locator('img[alt="购买凭证成交附件"]').first()
  await expect(archivedCustomerImage).toBeVisible()
  const archivedImageUrl = await archivedCustomerImage.getAttribute('src')
  expect(archivedImageUrl).toContain(`/api/v1/customer/orders/${orderId}/items/`)
  const archivedImage = await page.request.get(archivedImageUrl!)
  expect(archivedImage.status()).toBe(200)
  expect(archivedImage.headers()['cache-control']).toContain('private')
  expect(archivedImage.headers()['x-content-type-options']).toBe('nosniff')

  await page.goto(productPath)
  const directForm = page.locator('section[aria-labelledby="purchase-form-title"]')
  await page.getByLabel('账号编号').fill('00000000000000000999')
  await page.getByLabel('登录平台').click()
  await page.getByRole('option', { name: '网页端' }).click()
  await page.getByLabel('区服第 1 级').click()
  await page.getByRole('option', { name: '亚洲' }).click()
  await page.getByLabel('区服第 2 级').click()
  await page.getByRole('option', { name: '亚洲一服' }).click()
  await page.getByLabel('亚洲角色名').fill('direct-purchase')
  await page.getByLabel('补充说明').fill('直接购买流程')
  await directForm.getByRole('button', { name: '保存填写内容' }).click()
  await expect(directForm.getByRole('status')).toContainText('已保存部分内容')
  await page.getByLabel('购买凭证上传图片').setInputFiles({ name: 'direct.png', mimeType: 'image/png', buffer: png })
  await directForm.getByRole('button', { name: '上传并保存' }).click()
  await expect(directForm.getByRole('status')).toContainText('图片已保存')
  await directForm.getByRole('button', { name: '校验完整性' }).click()
  await expect(directForm.getByRole('status')).toContainText('填写校验通过')
  const cartBeforeDirect = await page.request.get('/api/v1/customer/cart')
  expect((await cartBeforeDirect.json()).data.itemCount).toBe(2)
  await page.getByRole('button', { name: '立即购买' }).click()
  await expect(page).toHaveURL(/\/checkout\?/u)
  await expect(page.getByText('00000000000000000999', { exact: true })).toBeVisible()
  expect((await (await page.request.get('/api/v1/customer/cart')).json()).data.itemCount).toBe(2)
  await page.getByRole('button', { name: '提交订单' }).click()
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/u)
  const immediateOrderId = new URL(page.url()).pathname.split('/').at(-1)!
  expect((await page.request.get(`/api/v1/customer/orders/${immediateOrderId}`)).status()).toBe(200)

  await page.goto(`/admin/orders/${orderId}`)
  await expect(page.getByRole('region', { name: '成交时保存的购买资料' })).toHaveCount(2)
  const archivedAdminImage = page.locator('img[alt="购买凭证成交附件"]').first()
  await expect(archivedAdminImage).toBeVisible()
  const adminImageUrl = await archivedAdminImage.getAttribute('src')
  expect(adminImageUrl).toContain(`/api/v1/admin/orders/${orderId}/items/`)
  expect((await page.request.get(adminImageUrl!)).status()).toBe(200)

  const policyResponse = await page.request.get('/api/v1/admin/storefront/customer-policy')
  expect(policyResponse.status()).toBe(200)
  const { updatedAt: _updatedAt, ...originalPolicy } = (await policyResponse.json()).data
  const enabledGuestCheckout = await page.request.put('/api/v1/admin/storefront/customer-policy', {
    headers: await adminHeaders(page), data: { ...originalPolicy, guestCheckoutEnabled: true },
  })
  expect(enabledGuestCheckout.status(), await enabledGuestCheckout.text()).toBe(200)
  const origin = new URL(page.url()).origin
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 900 } })
  const guestPage = await guestContext.newPage()
  guestPage.setDefaultTimeout(12_000)
  let orphanDraftId = ''
  let guestCartDraftId = ''
  let guestSessionToken: string
  try {
    const guestAccount = '000000000000000000000888'
    await guestPage.goto(new URL(productPath, origin).toString())
    await expect(guestPage.getByRole('heading', { name: /购买资料/u })).toBeVisible()
    await fillPurchaseFormWithImage(guestPage, guestAccount, 'guest-direct', '游客正式购买资料')
    const guestPersisted = await guestPage.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]
      .map(key => `${key}:${localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? ''}`).join('\n'))
    expect(guestPersisted).not.toContain(guestAccount)
    await guestPage.getByRole('button', { name: '立即购买' }).click()
    await expect(guestPage).toHaveURL(/\/checkout\?/u)
    await expect(guestPage.getByText(guestAccount, { exact: true })).toBeVisible()
    await guestPage.getByRole('button', { name: '提交订单' }).click()
    await expect(guestPage).toHaveURL(/\/orders\/[0-9a-f-]+$/u)
    const guestOrderId = new URL(guestPage.url()).pathname.split('/').at(-1)!
    expect((await guestPage.request.get(`/api/v1/guest/orders/${guestOrderId}`)).status()).toBe(200)
    await expect(guestPage.getByRole('region', { name: '成交时保存的购买资料' })).toHaveCount(1)
    const guestArchivedImage = guestPage.locator('img[alt="购买凭证成交附件"]').first()
    await expect(guestArchivedImage).toBeVisible()
    const guestArchivedImageUrl = await guestArchivedImage.getAttribute('src')
    expect(guestArchivedImageUrl).toContain(`/api/v1/guest/orders/${guestOrderId}/items/`)
    const guestArchivedImageResponse = await guestPage.request.get(guestArchivedImageUrl!)
    expect(guestArchivedImageResponse.status()).toBe(200)
    expect(guestArchivedImageResponse.headers()['cache-control']).toContain('private')

    guestSessionToken = (await guestContext.cookies()).find(cookie => cookie.name === 'aikayun_guest_order_session')?.value ?? ''
    expect(guestSessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    await guestPage.goto(new URL(productPath, origin).toString())
    await expect(guestPage.getByRole('heading', { name: /购买资料/u })).toBeVisible()
    await fillPurchaseFormWithImage(guestPage, '000000000000000000000889', 'guest-cart', '仅认领购物车中的资料')
    await guestPage.getByRole('button', { name: '加入购物车' }).click()
    await expect.poll(async () => guestPage.evaluate(() => localStorage.getItem('aikayun-guest-cart-v2') ?? ''), { timeout: 20_000 })
      .toContain('"draftId"')
    const csrfResponse = await guestPage.request.get('/api/v1/customer/auth/csrf')
    expect(csrfResponse.status()).toBe(200)
    const csrfToken = (await csrfResponse.json()).data.csrfToken as string
    const orphanResponse = await guestPage.request.post('/api/v1/storefront/purchase-drafts', {
      headers: { origin, 'x-csrf-token': csrfToken }, data: { skuId: sku.id },
    })
    expect(orphanResponse.status(), await orphanResponse.text()).toBe(201)
    orphanDraftId = (await orphanResponse.json()).data.id as string
    const unclaimedStore = await guestPage.evaluate(() => JSON.parse(localStorage.getItem('aikayun-guest-cart-v2') ?? '{}')) as {
      unclaimedItems?: Array<{ draftId?: string }>
    }
    const guestCartDraftIds = unclaimedStore.unclaimedItems?.map(item => item.draftId).filter((id): id is string => Boolean(id)) ?? []
    guestCartDraftId = guestCartDraftIds[0] ?? ''
    expect(guestCartDraftIds).toHaveLength(1)
    expect(guestCartDraftId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(guestCartDraftId).not.toBe(orphanDraftId)

    await guestPage.goto(new URL('/login', origin).toString())
    await expect(guestPage.locator('[data-customer-login-ready]')).toHaveAttribute('data-customer-login-ready', 'true')
    await guestPage.getByLabel('用户名').fill(username)
    await guestPage.getByLabel('密码', { exact: true }).fill(password)
    await Promise.all([
      guestPage.waitForURL(/\/account$/u),
      guestPage.getByRole('button', { name: '登录' }).click(),
    ])
    await expect(guestPage.getByRole('heading', { name: '个人账户' })).toBeVisible()
    await expect.poll(async () => {
      const response = await guestPage.request.get('/api/v1/customer/cart')
      if (response.status() !== 200) return ''
      const data = (await response.json()).data
      const claimedDraftIds = data.items.map((item: { draftId?: string | null }) => item.draftId)
      return claimedDraftIds.includes(guestCartDraftId) && !claimedDraftIds.includes(orphanDraftId) ? 'merged' : ''
    }, { timeout: 20_000 }).toBe('merged')
    const inaccessibleOrphan = await guestPage.request.get(`/api/v1/storefront/purchase-drafts/${orphanDraftId}?skuId=${sku.id}`)
    expect(inaccessibleOrphan.status()).toBe(404)
    const guestVerifier = await browser.newContext()
    try {
      await guestVerifier.addCookies([{
        name: 'aikayun_guest_order_session', value: guestSessionToken, url: origin,
        httpOnly: true, sameSite: 'Lax',
      }])
      const retainedGuestDraft = await guestVerifier.request.get(new URL(
        `/api/v1/storefront/purchase-drafts/${orphanDraftId}?skuId=${sku.id}`, origin,
      ).toString())
      expect(retainedGuestDraft.status()).toBe(200)
    } finally { await guestVerifier.close() }
  } finally {
    await guestContext.close()
    const restoredPolicy = await page.request.put('/api/v1/admin/storefront/customer-policy', {
      headers: await adminHeaders(page), data: originalPolicy,
    })
    expect(restoredPolicy.status(), await restoredPolicy.text()).toBe(200)
  }

  await page.goto('/admin/purchase-form-templates')
  const lifecyclePanelAfterOrder = page.locator('section[aria-labelledby="purchase-form-lifecycle-title"]')
  await lifecyclePanelAfterOrder.getByRole('button', { name: '暂停新购买' }).click()
  await expect(lifecyclePanelAfterOrder.getByRole('status')).toContainText('购买填写已暂停')
  await expect(lifecyclePanelAfterOrder.getByText('已暂停', { exact: true })).toBeVisible()
  const pausedCart = await page.request.get('/api/v1/customer/cart')
  expect(pausedCart.status()).toBe(200)
  expect((await pausedCart.json()).data).toMatchObject({ canContinue: false })
  expect((await pausedCart.json()).data.items.every((item: { reason: string }) => item.reason === 'purchase_forms_paused')).toBe(true)
  await lifecyclePanelAfterOrder.getByRole('button', { name: '恢复新购买' }).click()
  await expect(lifecyclePanelAfterOrder.getByRole('status')).toContainText('购买填写已恢复运行')
  expect((await page.request.get(`/api/v1/customer/orders/${archivedOrderIds[0]}`)).status()).toBe(200)
  expect(runtimeErrors).toEqual([])
})
