import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'

type Product = { id: string; name: string; revision: number; variants: Array<{ id: string; skuCode: string; revision: number }> }

const password = 'Browser-Purchase-Form-Password-2026!'
let purchaseFormTestIp = 1

function nextPurchaseFormTestIp(): string {
  return `198.18.5.${purchaseFormTestIp++}`
}

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': nextPurchaseFormTestIp() })
})

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
  await form.getByRole('button', { name: '新建一组购买资料' }).click()
  await expect(form.getByLabel('账号编号')).toBeVisible()
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
  const rateLimitedRequests: string[] = []
  let observedDraftId = ''
  page.on('pageerror', error => runtimeErrors.push(error.message))
  page.on('response', async response => {
    const request = response.request()
    if (response.status() === 429) {
      const path = new URL(response.url()).pathname
      let code = 'unknown'
      try { code = (await response.json()).error?.code ?? code } catch { /* keep only the route and status */ }
      rateLimitedRequests.push(`${request.method()} ${path} (${code})`)
    }
    if (request.method() !== 'POST' || new URL(response.url()).pathname !== '/api/v1/storefront/purchase-drafts'
      || response.status() !== 201) return
    try { observedDraftId = (await response.json()).data.id as string } catch { /* no body is retained */ }
  })
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

  const secondProductResponse = await page.request.post('/api/v1/admin/products', {
    headers, data: { name: `异步状态归属商品 ${randomUUID().slice(0, 8)}`, description: '第二商品用于可控响应门闩。',
      productType: 'digital', defaultSku: { salePrice: '6.00' } },
  })
  expect(secondProductResponse.status(), await secondProductResponse.text()).toBe(201)
  let secondProduct = (await secondProductResponse.json()).data as Product
  const secondLifecycle = await page.request.patch(`/api/v1/admin/products/${secondProduct.id}/lifecycle`, {
    headers, data: { expectedRevision: secondProduct.revision, status: 'active' },
  })
  expect(secondLifecycle.status()).toBe(200)
  const secondInventoryResponse = await page.request.get(`/api/v1/admin/products/${secondProduct.id}/inventory`)
  const secondInventory = (await secondInventoryResponse.json()).data as {
    productRevision: number; variants: Array<{ skuId: string; skuRevision: number; inventoryRevision: number }>
  }
  const secondSku = secondProduct.variants[0]!
  const secondInventorySku = secondInventory.variants.find(variant => variant.skuId === secondSku.id)!
  const secondInventoryMode = await page.request.put(`/api/v1/admin/products/${secondProduct.id}/variants/${secondSku.id}/inventory-mode`, {
    headers, data: { expectedRevision: secondInventory.productRevision, expectedSkuRevision: secondInventorySku.skuRevision,
      expectedInventoryRevision: secondInventorySku.inventoryRevision, inventoryMode: 'unlimited' },
  })
  expect(secondInventoryMode.status()).toBe(200)
  expect((await page.request.put(`/api/v1/admin/products/${secondProduct.id}/variants/${secondSku.id}/manual-fulfillment`, {
    headers, data: { enabled: true },
  })).status()).toBe(200)
  const secondLatest = await page.request.get(`/api/v1/admin/products/${secondProduct.id}`)
  secondProduct = (await secondLatest.json()).data as Product
  const configuredSecondSku = secondProduct.variants[0]!
  const requiresLogin = await page.request.put(`/api/v1/admin/products/${secondProduct.id}/variants/${configuredSecondSku.id}/purchase-limits`, {
    headers, data: { expectedProductRevision: secondProduct.revision, expectedSkuRevision: configuredSecondSku.revision,
      purchaseLimits: { perOrder: null, lifetime: 1, rolling24Hours: null } },
  })
  expect(requiresLogin.status(), await requiresLogin.text()).toBe(200)
  secondProduct = (await requiresLogin.json()).data as Product
  expect((await page.request.put(`/api/v1/admin/products/${secondProduct.id}/purchase-form`, {
    headers, data: { expectedRevision: secondProduct.revision, mode: 'template', templateVersionId: version.id },
  })).status()).toBe(200)

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

  const guestCsrfResponse = await page.request.get('/api/v1/customer/auth/csrf')
  expect(guestCsrfResponse.status()).toBe(200)
  const guestOrigin = new URL(page.url()).origin
  const guestHeaders = { origin: guestOrigin,
    'x-csrf-token': (await guestCsrfResponse.json()).data.csrfToken as string }
  const guestSessionResponse = await page.request.post('/api/v1/guest/session', { headers: guestHeaders })
  expect([200, 201]).toContain(guestSessionResponse.status())
  const initialGuestCookie = (await page.context().cookies()).find(cookie => cookie.name === 'aikayun_guest_order_session')?.value
  expect(initialGuestCookie).toMatch(/^[A-Za-z0-9_-]{43}$/u)

  // A normal visit only reads the current form. It must not consume the
  // same guest owner's persistent 50-draft allowance before the customer
  // chooses to edit.
  let passiveDraftCreations = 0
  const countPassiveDraftCreate = (request: import('@playwright/test').Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/storefront/purchase-drafts') {
      passiveDraftCreations++
    }
  }
  page.on('request', countPassiveDraftCreate)
  for (let visit = 0; visit < 51; visit++) {
    await page.goto(`/products/${product.id}`)
    await expect(page.getByRole('heading', { name: /购买资料/u })).toBeVisible()
  }
  page.off('request', countPassiveDraftCreate)
  expect(passiveDraftCreations, 'ordinary product views must not create persistent drafts').toBe(0)
  expect((await page.context().cookies()).find(cookie => cookie.name === 'aikayun_guest_order_session')?.value)
    .toBe(initialGuestCookie)
  const stillEligible = await page.request.post('/api/v1/storefront/purchase-drafts', {
    headers: guestHeaders, data: { skuId: sku.id },
  })
  expect(stillEligible.status(), await stillEligible.text()).toBe(201)
  const eligibilityDraft = (await stillEligible.json()).data as { id: string; revision: number }
  const discardEligibilityDraft = await page.request.delete(`/api/v1/storefront/purchase-drafts/${eligibilityDraft.id}`, {
    headers: guestHeaders, data: { expectedRevision: eligibilityDraft.revision },
  })
  expect(discardEligibilityDraft.status(), await discardEligibilityDraft.text()).toBe(200)

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

  // Delay an actual stale 409 only after the server has returned it. While it
  // is paused, navigate to another form and hold that draft-creation response.
  // Releasing A must not paint an error or clear B's busy state.
  await page.goto(`/products/${product.id}`)
  const contextFormA = page.locator('section[aria-labelledby="purchase-form-title"]')
  await contextFormA.getByRole('button', { name: '新建一组购买资料' }).click()
  await expect(page.getByLabel('账号编号')).toBeVisible()
  await page.getByLabel('账号编号').fill('00000000000000000111')
  await contextFormA.getByRole('button', { name: '保存填写内容' }).click()
  await expect(contextFormA.getByRole('status')).toContainText('已保存部分内容')
  await expect.poll(() => observedDraftId).toMatch(/^[0-9a-f-]{36}$/u)
  const staleDraftId = observedDraftId
  await page.getByLabel('补充说明').fill('将触发一个可控的旧修订冲突')
  const staleDraftPath = `/api/v1/storefront/purchase-drafts/${staleDraftId}`
  const staleDraftUrl = new URL(staleDraftPath, new URL(page.url()).origin).toString()
  let releaseStaleResponse!: () => void
  let staleResponseReady!: () => void
  const staleReady = new Promise<void>(resolve => { staleResponseReady = resolve })
  const staleGate = new Promise<void>(resolve => { releaseStaleResponse = resolve })
  const delayedConflict = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'PUT') { await route.continue(); return }
    const current = await page.request.get(`${staleDraftPath}?skuId=${sku.id}`)
    const draft = (await current.json()).data as { revision: number; values: Record<string, unknown> }
    const advancedValues = { ...draft.values, [ids.notes]: '被控另一会话推进的修订' }
    const csrf = await page.request.get('/api/v1/customer/auth/csrf')
    const changed = await page.request.put(staleDraftPath, {
      headers: { origin: new URL(page.url()).origin, 'x-csrf-token': (await csrf.json()).data.csrfToken as string },
      data: { skuId: sku.id, expectedRevision: draft.revision, values: advancedValues },
    })
    expect(changed.status()).toBe(200)
    const response = await route.fetch()
    expect(response.status()).toBe(409)
    staleResponseReady()
    await staleGate
    await route.fulfill({ response })
  }
  await page.route(staleDraftUrl, delayedConflict)
  const saveStale = contextFormA.getByRole('button', { name: '保存填写内容' }).click()
  await staleReady
  await page.goto(`/products/${secondProduct.id}`)
  const contextFormB = page.locator('section[aria-labelledby="purchase-form-title"]')
  await expect(contextFormB).toBeVisible()
  let releaseBCreate!: () => void
  let bCreateReady!: () => void
  const bReady = new Promise<void>(resolve => { bCreateReady = resolve })
  const bCreateGate = new Promise<void>(resolve => { releaseBCreate = resolve })
  const delayedBCreate = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    const response = await route.fetch()
    expect(response.status()).toBe(201)
    bCreateReady()
    await bCreateGate
    await route.fulfill({ response })
  }
  const createUrl = new URL('/api/v1/storefront/purchase-drafts', new URL(page.url()).origin).toString()
  await page.route(createUrl, delayedBCreate)
  const createB = contextFormB.getByRole('button', { name: '新建一组购买资料' }).click()
  await bReady
  await expect(contextFormB.getByText('正在创建本次购买资料…', { exact: true })).toBeVisible()
  releaseStaleResponse()
  await saveStale
  await expect(contextFormB.getByRole('alert')).toHaveCount(0)
  // A's finally block must not clear B's busy indicator while B's create
  // response is still held at the browser boundary.
  await expect(contextFormB.getByText('正在创建本次购买资料…', { exact: true })).toBeVisible()
  await expect(page.getByLabel('账号编号')).toHaveCount(0)
  releaseBCreate()
  await createB
  await page.unroute(createUrl, delayedBCreate)
  await page.unroute(staleDraftUrl, delayedConflict)
  await expect(page.getByLabel('账号编号')).toBeVisible()

  // A late successful upload belongs to A's draft even after this SPA
  // component is unmounted and the customer opens SKU B. It must be released
  // from A, never installed into B's image field or busy state.
  await page.goto(`/products/${product.id}`)
  const lateUploadFormA = page.locator('section[aria-labelledby="purchase-form-title"]')
  const previousObservedDraftId = observedDraftId
  await lateUploadFormA.getByRole('button', { name: '新建一组购买资料' }).click()
  await expect(page.getByLabel('账号编号')).toBeVisible()
  await expect.poll(() => observedDraftId).not.toBe(previousObservedDraftId)
  const lateUploadDraftId = observedDraftId
  const lateUploadPath = `/api/v1/storefront/purchase-drafts/${lateUploadDraftId}/attachments`
  let releaseLateUpload!: () => void
  let signalLateUploadReady!: () => void
  let lateUploadAttachmentId = ''
  const lateUploadReady = new Promise<void>((resolve) => { signalLateUploadReady = resolve })
  const lateUploadGate = new Promise<void>((resolve) => { releaseLateUpload = resolve })
  const delayedSuccessfulUpload = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    const response = await route.fetch()
    expect(response.status()).toBe(201)
    lateUploadAttachmentId = (await response.json()).data.attachmentId as string
    signalLateUploadReady()
    await lateUploadGate
    await route.fulfill({ response })
  }
  const lateUploadUrl = new URL(lateUploadPath, new URL(page.url()).origin).toString()
  await page.route(lateUploadUrl, delayedSuccessfulUpload)
  await page.getByLabel('购买凭证上传图片').setInputFiles({ name: 'late-upload-a.png', mimeType: 'image/png', buffer: png })
  await lateUploadFormA.getByRole('button', { name: '上传并保存' }).click()
  await lateUploadReady
  await page.getByRole('link', { name: '全部商品' }).click()
  await expect(page.getByRole('heading', { name: '全部商品' })).toBeVisible()
  await page.getByRole('link', { name: `${secondProduct.name}，¥6.00` }).click()
  await expect(page).toHaveURL(`/products/${secondProduct.id}`)
  const lateUploadFormB = page.locator('section[aria-labelledby="purchase-form-title"]')
  await expect(lateUploadFormB).toBeVisible()
  const lateReleaseResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${lateUploadPath}/${lateUploadAttachmentId}/release`)
  releaseLateUpload()
  const lateRelease = await lateReleaseResponse
  expect(lateRelease.status()).toBe(200)
  expect((await lateRelease.json()).data).toMatchObject({ released: true })
  await page.unroute(lateUploadUrl, delayedSuccessfulUpload)
  await expect(lateUploadFormB.locator('img[alt="购买凭证已上传图片"]')).toHaveCount(0)
  await expect(lateUploadFormB.getByRole('alert')).toHaveCount(0)

  const productPath = `/products/${product.id}`
  const accounts = ['000012345678901234567890', '000000000000000000000042']
  const roles = ['same-sku-asia', 'same-sku-europe']
  const archivedOrderIds: string[] = []
  for (let index = 0; index < accounts.length; index++) {
    await noHorizontalOverflow(page, 390)
    await page.goto(productPath)
    await expect(page.getByRole('heading', { name: /购买资料/u })).toBeVisible()
    const formRegion = page.locator('section[aria-labelledby="purchase-form-title"]')
    await formRegion.getByRole('button', { name: '新建一组购买资料' }).click()
    await expect(page.getByLabel('账号编号')).toBeVisible()
    if (index === 0) {
      await page.getByLabel('账号编号').fill(accounts[index]!)
      await formRegion.getByRole('button', { name: '保存填写内容' }).click()
      await expect(formRegion.getByRole('status'), `rate limited: ${rateLimitedRequests.join(', ')}`).toContainText('已保存部分内容')
      await page.reload()
      await expect(formRegion.getByRole('button', { name: /继续填写/u }).first()).toBeVisible()
      await formRegion.getByRole('button', { name: /继续填写/u }).first().click()
      await expect(page.getByLabel('账号编号')).toHaveValue(accounts[index]!)
    }
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

      // Upload B to ready, advance the real draft revision while retaining A,
      // then let the browser's stale PUT receive its real 409 response.
      await expect.poll(() => observedDraftId).toMatch(/^[0-9a-f-]{36}$/u)
      const draftPath = `/api/v1/storefront/purchase-drafts/${observedDraftId}`
      const currentDraftResponse = await page.request.get(`${draftPath}?skuId=${sku.id}`)
      expect(currentDraftResponse.status()).toBe(200)
      const currentDraft = (await currentDraftResponse.json()).data as {
        revision: number; values: Record<string, unknown>
      }
      const customerCsrf = await page.request.get('/api/v1/customer/auth/csrf')
      expect(customerCsrf.status()).toBe(200)
      const customerCsrfToken = (await customerCsrf.json()).data.csrfToken as string
      const draftUrl = new URL(draftPath, new URL(page.url()).origin).toString()
      let conflictAttachmentId = ''
      const captureConflictUpload = async (route: import('@playwright/test').Route) => {
        if (route.request().method() !== 'POST') { await route.continue(); return }
        const response = await route.fetch()
        const body = await response.json() as { data?: { attachmentId?: string } }
        conflictAttachmentId = body.data?.attachmentId ?? ''
        await route.fulfill({ response })
      }
      await page.route(/\/api\/v1\/storefront\/purchase-drafts\/[^/]+\/attachments$/u, captureConflictUpload)
      const conflictReplacement = async (route: import('@playwright/test').Route) => {
        if (route.request().method() !== 'PUT') { await route.continue(); return }
        const competingValues = structuredClone(currentDraft.values)
        expect(conflictAttachmentId).toMatch(/^[0-9a-f-]{36}$/u)
        // This is ordinary customer text. It must not be mistaken for the
        // image attachment reference during failed-save cleanup.
        competingValues[ids.notes] = `普通备注提及附件ID ${conflictAttachmentId}`
        const advanced = await page.request.put(draftPath, {
          headers: { origin: new URL(page.url()).origin, 'x-csrf-token': customerCsrfToken },
          data: { skuId: sku.id, expectedRevision: currentDraft.revision, values: competingValues },
        })
        expect(advanced.status(), await advanced.text()).toBe(200)
        const response = await route.fetch()
        expect(response.status()).toBe(409)
        await route.fulfill({ response })
      }
      await page.route(draftUrl, conflictReplacement)
      const previousAfterConcurrentEdit = await uploadedImage.getAttribute('src')
      await imageInput.setInputFiles({ name: 'conflict-replacement.png', mimeType: 'image/png', buffer: png })
      await formRegion.getByRole('button', { name: '上传并保存' }).click()
      await expect(page.getByRole('alert')).toContainText('未引用的新图片已安全释放', { timeout: 20_000 })
      await expect(uploadedImage).toHaveAttribute('src', previousAfterConcurrentEdit!)
      const afterFailureDraft = await page.request.get(`${draftPath}?skuId=${sku.id}`)
      expect(afterFailureDraft.status()).toBe(200)
      expect((await afterFailureDraft.json()).data.values[ids.notes]).toContain(conflictAttachmentId)
      await page.unroute(/\/api\/v1\/storefront\/purchase-drafts\/[^/]+\/attachments$/u, captureConflictUpload)
      await page.unroute(draftUrl, conflictReplacement)

      await imageInput.setInputFiles({ name: 'immediate-retry.png', mimeType: 'image/png', buffer: png })
      await formRegion.getByRole('button', { name: '上传并保存' }).click()
      await expect(formRegion.getByRole('status')).toContainText('图片已保存', { timeout: 20_000 })
      await expect(uploadedImage).not.toHaveAttribute('src', previousAfterConcurrentEdit!)
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
    lineId: string; skuId: string; quantity: number; lineRevision: number; draftId: string; draftRevision: number
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
  await page.getByRole('button', { name: '开始安全编辑' }).click()
  await expect(page.getByLabel('账号编号')).toBeVisible()
  const editedAccountBefore = await page.getByLabel('账号编号').inputValue()
  const editedAccountIndex = accounts.indexOf(editedAccountBefore)
  expect(editedAccountIndex).toBeGreaterThanOrEqual(0)
  const editedAccountAfter = '000000000000000000000777'
  await page.getByLabel('账号编号').fill('')
  await page.getByRole('button', { name: '保存填写内容' }).click()
  await expect(page.getByRole('status')).toContainText('购物车仍保留上次确认的资料')
  await expect(page).toHaveURL(/editLineId=/u)
  const unchangedCartAfterPartial = await page.request.get('/api/v1/customer/cart')
  const unchangedLine = ((await unchangedCartAfterPartial.json()).data.items as Array<{
    lineId: string; draftId: string; draftRevision: number; lineRevision: number
  }>).find(item => item.lineId === (cartItems[0]?.lineId ?? ''))
  expect(unchangedLine?.draftRevision).toBe(cartItems[0]?.draftRevision)
  expect(unchangedLine?.lineRevision).toBe(cartItems[0]?.lineRevision)
  const unchangedDraft = await page.request.get(`/api/v1/storefront/purchase-drafts/${cartItems[0]!.draftId}?skuId=${sku.id}`)
  expect((await unchangedDraft.json()).data.values[ids.account]).toBe(editedAccountBefore)
  await page.reload()
  await expect(page.getByLabel('账号编号')).toHaveValue('')
  await expect(page.locator('section[aria-labelledby="purchase-form-title"]').getByRole('status'))
    .toContainText('恢复这行购买资料的未完成编辑')
  accounts[editedAccountIndex] = editedAccountAfter
  await page.getByLabel('账号编号').fill(editedAccountAfter)
  await page.getByRole('button', { name: '保存填写内容' }).click()
  await expect(page.locator('section[aria-labelledby="purchase-form-title"]').getByRole('status'))
    .toContainText('购物车仍保留上次确认的资料')
  await expect(page.getByRole('button', { name: '保存并返回购物车' })).toBeEnabled()
  const cartLineFormValidation = page.waitForResponse(response => {
    const request = response.request()
    return request.method() === 'GET'
      && new URL(response.url()).pathname === `/api/v1/storefront/skus/${sku.id}/purchase-form`
  })
  const cartLineReplacement = page.waitForResponse(response => {
    const request = response.request()
    return request.method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/v1/customer/cart/lines/${cartItems[0]!.lineId}/purchase-form`
  })
  await page.getByRole('button', { name: '校验完整性' }).click()
  expect((await cartLineFormValidation).status()).toBe(200)
  expect((await cartLineReplacement).status()).toBe(200)
  await expect(page.locator('section[aria-labelledby="purchase-form-title"]').getByRole('status'))
    .toContainText('填写校验通过')
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
  await directForm.getByRole('button', { name: '新建一组购买资料' }).click()
  await expect(page.getByLabel('账号编号')).toBeVisible()
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

  // Guest direct purchase with an account limit must carry only the selected
  // draft through login, claim it idempotently, then quote and order as customer.
  const selectedGuestContext = await browser.newContext({ viewport: { width: 390, height: 900 } })
  await selectedGuestContext.setExtraHTTPHeaders({ 'x-forwarded-for': nextPurchaseFormTestIp() })
  const selectedGuestPage = await selectedGuestContext.newPage()
  selectedGuestPage.setDefaultTimeout(12_000)
  let selectedGuestDraftId = ''
  let selectedDraftClaimResult: { draftId: string; revision: number; templateVersionId: string } | null = null
  selectedGuestPage.on('response', async response => {
    const request = response.request()
    const pathname = new URL(response.url()).pathname
    if (request.method() === 'POST' && pathname === '/api/v1/storefront/purchase-drafts' && response.status() === 201) {
      try { selectedGuestDraftId = (await response.json()).data.id as string } catch { /* no content is logged */ }
    }
    if (request.method() === 'POST' && pathname.endsWith('/claim-selected') && response.status() === 200) {
      try { selectedDraftClaimResult = (await response.json()).data } catch { /* checked below */ }
    }
  })
  const selectedGuestOrigin = new URL(page.url()).origin
  let unselectedGuestDraftId: string
  try {
    await selectedGuestPage.goto(new URL(`/products/${secondProduct.id}`, selectedGuestOrigin).toString())
    await expect(selectedGuestPage.getByRole('heading', { name: /购买资料/u })).toBeVisible()
    await fillPurchaseFormWithImage(selectedGuestPage, '00000000000000000888', 'selected-guest', '登录后继续的指定资料')
    await expect.poll(() => selectedGuestDraftId).toMatch(/^[0-9a-f-]{36}$/u)
    const guestCsrf = await selectedGuestPage.request.get('/api/v1/customer/auth/csrf')
    const guestCsrfToken = (await guestCsrf.json()).data.csrfToken as string
    const unrelatedDraft = await selectedGuestPage.request.post('/api/v1/storefront/purchase-drafts', {
      headers: { origin: selectedGuestOrigin, 'x-csrf-token': guestCsrfToken }, data: { skuId: secondSku.id },
    })
    expect(unrelatedDraft.status(), await unrelatedDraft.text()).toBe(201)
    unselectedGuestDraftId = (await unrelatedDraft.json()).data.id as string
    const guestCookie = (await selectedGuestContext.cookies()).find(cookie => cookie.name === 'aikayun_guest_order_session')?.value
    expect(guestCookie).toMatch(/^[A-Za-z0-9_-]{43}$/u)

    await selectedGuestPage.getByRole('link', { name: '登录后继续购买' }).click()
    await expect(selectedGuestPage).toHaveURL(/\/login\?/u)
    await selectedGuestPage.getByLabel('用户名').fill(username)
    await selectedGuestPage.getByLabel('密码', { exact: true }).fill(password)
    await Promise.all([
      selectedGuestPage.waitForURL(/\/checkout\?/u),
      selectedGuestPage.getByRole('button', { name: '登录' }).click(),
    ])
    await expect(selectedGuestPage).not.toHaveURL(/claimGuestDraft=1/u)
    await expect(selectedGuestPage.getByText('00000000000000000888', { exact: true })).toBeVisible()
    expect(selectedDraftClaimResult).toMatchObject({ draftId: selectedGuestDraftId, templateVersionId: version.id })
    const claimedDraftRevision = selectedDraftClaimResult!.revision
    const repeatedClaim = await selectedGuestPage.request.post(
      `/api/v1/customer/purchase-drafts/${selectedGuestDraftId}/claim-selected`, {
        headers: { origin: selectedGuestOrigin, 'x-csrf-token': (await (await selectedGuestPage.request.get('/api/v1/customer/auth/csrf')).json()).data.csrfToken as string },
        data: { skuId: secondSku.id, expectedRevision: claimedDraftRevision },
      },
    )
    expect(repeatedClaim.status(), await repeatedClaim.text()).toBe(200)
    expect((await repeatedClaim.json()).data.revision).toBe(claimedDraftRevision)
    expect((await selectedGuestPage.request.get(`/api/v1/customer/purchase-drafts/${selectedGuestDraftId}?skuId=${secondSku.id}`)).status()).toBe(404)
    expect((await selectedGuestPage.request.get(`/api/v1/storefront/purchase-drafts/${unselectedGuestDraftId}?skuId=${secondSku.id}`)).status()).toBe(404)

    await selectedGuestPage.getByRole('button', { name: '提交订单' }).click()
    await expect(selectedGuestPage).toHaveURL(/\/orders\/[0-9a-f-]+$/u)
    const claimedOrderId = new URL(selectedGuestPage.url()).pathname.split('/').at(-1)!
    expect((await selectedGuestPage.request.get(`/api/v1/customer/orders/${claimedOrderId}`)).status()).toBe(200)
    const guestVerifier = await browser.newContext()
    try {
      await guestVerifier.addCookies([{
        name: 'aikayun_guest_order_session', value: guestCookie!, url: selectedGuestOrigin,
        httpOnly: true, sameSite: 'Lax',
      }])
      expect((await guestVerifier.request.get(new URL(`/api/v1/storefront/purchase-drafts/${selectedGuestDraftId}?skuId=${secondSku.id}`, selectedGuestOrigin).toString())).status()).toBe(404)
      expect((await guestVerifier.request.get(new URL(`/api/v1/storefront/purchase-drafts/${unselectedGuestDraftId}?skuId=${secondSku.id}`, selectedGuestOrigin).toString())).status()).toBe(200)
      expect((await guestVerifier.request.get(new URL(`/api/v1/guest/orders/${claimedOrderId}`, selectedGuestOrigin).toString())).status()).toBe(404)
    } finally { await guestVerifier.close() }
  } finally { await selectedGuestContext.close() }

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
  await guestContext.setExtraHTTPHeaders({ 'x-forwarded-for': nextPurchaseFormTestIp() })
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
