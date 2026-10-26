import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBrowserAdminSession } from './browser-admin-session'

const password = 'Purchase-R3-Browser-2026!'
const { Pool } = createRequire(new URL('../../../api/package.json', import.meta.url))('pg')
let ip = 1

type Line = { lineId: string; lineRevision: number; draftId: string; draftRevision: number; quantity: number }

async function setupEdit(page: Page) {
  page.setDefaultTimeout(20_000)
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': `198.18.7.${ip++}` })
  const origin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin
  await page.context().addCookies([{ name: 'aikayun_admin_session', value: createBrowserAdminSession(),
    url: origin, httpOnly: true, sameSite: 'Lax' }])
  const adminCsrf = await page.request.get('/api/v1/admin/auth/csrf')
  const adminHeaders = { origin, 'x-csrf-token': (await adminCsrf.json()).data.csrfToken as string }
  const fieldId = randomUUID()
  const templateResponse = await page.request.post('/api/v1/admin/purchase-form-templates', {
    headers: adminHeaders, data: { name: `R3 编辑恢复 ${randomUUID()}`, definition: { fields: [
      { id: fieldId, meaningKey: 'account', type: 'text', label: 'R3 账号', required: true, maxLength: 80 },
    ] } },
  })
  expect(templateResponse.status(), await templateResponse.text()).toBe(201)
  const template = (await templateResponse.json()).data.template
  const frozen = await page.request.post(`/api/v1/admin/purchase-form-templates/${template.id}/versions`, {
    headers: adminHeaders, data: { expectedRevision: template.revision },
  })
  expect(frozen.status()).toBe(201)
  const versionId = (await frozen.json()).data.id as string
  const productResponse = await page.request.post('/api/v1/admin/products', { headers: adminHeaders,
    data: { name: `R3 商品 ${randomUUID()}`, description: '', productType: 'digital', defaultSku: { salePrice: '2.00' } } })
  expect(productResponse.status()).toBe(201)
  let product = (await productResponse.json()).data
  const productId = product.id as string
  const skuId = product.variants[0].id as string
  expect((await page.request.patch(`/api/v1/admin/products/${productId}/lifecycle`, {
    headers: adminHeaders, data: { expectedRevision: product.revision, status: 'active' },
  })).status()).toBe(200)
  const inventory = (await (await page.request.get(`/api/v1/admin/products/${productId}/inventory`)).json()).data
  const sku = inventory.variants.find((row: { skuId: string }) => row.skuId === skuId)
  expect((await page.request.put(`/api/v1/admin/products/${productId}/variants/${skuId}/inventory-mode`, {
    headers: adminHeaders, data: { expectedRevision: inventory.productRevision, expectedSkuRevision: sku.skuRevision,
      expectedInventoryRevision: sku.inventoryRevision, inventoryMode: 'unlimited' },
  })).status()).toBe(200)
  expect((await page.request.put(`/api/v1/admin/products/${productId}/variants/${skuId}/manual-fulfillment`, {
    headers: adminHeaders, data: { enabled: true },
  })).status()).toBe(200)
  product = (await (await page.request.get(`/api/v1/admin/products/${productId}`)).json()).data
  expect((await page.request.put(`/api/v1/admin/products/${productId}/purchase-form`, {
    headers: adminHeaders, data: { expectedRevision: product.revision, mode: 'template', templateVersionId: versionId },
  })).status()).toBe(200)
  const state = (await (await page.request.get('/api/v1/admin/storefront/purchase-forms')).json()).data
  if (state.status === 'preparing') {
    expect((await page.request.post('/api/v1/admin/storefront/purchase-forms/transition', { headers: adminHeaders,
      data: { expectedStatus: 'preparing', nextStatus: 'active', expectedImpactHash: state.impactHash },
    })).status()).toBe(200)
  } else {
    product = (await (await page.request.get(`/api/v1/admin/products/${productId}`)).json()).data
    expect((await page.request.post(`/api/v1/admin/products/${productId}/purchase-form/apply`, {
      headers: adminHeaders, data: { expectedRevision: product.revision, expectedMode: 'template', expectedTemplateVersionId: versionId },
    })).status()).toBe(200)
  }
  const csrf = await page.request.get('/api/v1/customer/auth/csrf')
  const headers = { origin, 'x-csrf-token': (await csrf.json()).data.csrfToken as string }
  const registered = await page.request.post('/api/v1/customer/auth/register', { headers,
    data: { username: `r3-${randomUUID().slice(0, 15)}`, password } })
  expect(registered.status(), await registered.text()).toBe(201)
  const created = (await (await page.request.post('/api/v1/storefront/purchase-drafts', { headers, data: { skuId } })).json()).data
  const values = { [fieldId]: 'account-A' }
  const savedResponse = await page.request.put(`/api/v1/storefront/purchase-drafts/${created.id}`, {
    headers, data: { skuId, expectedRevision: created.revision, values },
  })
  expect(savedResponse.status()).toBe(200)
  const saved = (await savedResponse.json()).data
  const add = () => page.request.post('/api/v1/customer/cart/items', { headers,
    data: { version: 2, skuId, quantity: 1, draftId: created.id, draftRevision: saved.revision } })
  const added = await add()
  expect(added.status(), await added.text()).toBe(200)
  const line = (await added.json()).data.cart.items.find((row: Line) => row.draftId === created.id) as Line
  const path = `/api/v1/customer/cart/lines/${line.lineId}/purchase-form/replacement-draft`
  const started = await page.request.post(path, { headers,
    data: { expectedLineRevision: line.lineRevision, expectedDraftRevision: line.draftRevision } })
  expect(started.status(), await started.text()).toBe(201)
  const replacement = (await started.json()).data
  const query = new URLSearchParams({ editLineId: line.lineId, skuId, draftId: line.draftId,
    expectedDraftRevision: String(line.draftRevision), lineRevision: String(line.lineRevision), quantity: '1' })
  return { line, path, oldLink: `/products/${productId}?${query}`, add, headers, skuId, fieldId, replacement, values }
}

test('R3 resumes the original cart edit link after another tab adds quantity and saves with the authoritative revision', async ({ page, context }) => {
  test.setTimeout(90_000)
  const fixture = await setupEdit(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const otherTab = await context.newPage()
  try {
    const added = await otherTab.request.post('/api/v1/customer/cart/items', { headers: fixture.headers,
      data: { version: 2, skuId: fixture.skuId, quantity: 1, draftId: fixture.line.draftId, draftRevision: fixture.line.draftRevision } })
    expect(added.status()).toBe(200)
    const current = (await added.json()).data.cart.items.find((row: Line) => row.lineId === fixture.line.lineId) as Line
    expect(current).toMatchObject({ quantity: 2, lineRevision: fixture.line.lineRevision + 1 })
    await page.goto(fixture.oldLink)
    const form = page.locator('section[aria-labelledby="purchase-form-title"]')
    await expect(form.getByRole('status')).toContainText('已恢复这行购买资料', { timeout: 20_000 })
    await form.getByLabel('R3 账号').fill('account-B')
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === fixture.path
      && response.request().method() === 'PUT')
    await form.getByRole('button', { name: '保存填写内容', exact: true }).click()
    const response = await saving
    expect(response.status(), JSON.stringify({ body: response.request().postDataJSON(), result: await response.json() })).toBe(200)
    await expect(form).toContainText('全部 2 件商品')
    await page.screenshot({ path: join(tmpdir(), 'aikayun-r3-browser-evidence', 'desktop.png'), fullPage: true })
    const committing = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/customer/cart/lines/${fixture.line.lineId}/purchase-form`
      && response.request().method() === 'PATCH')
    const checkoutQuote = page.waitForRequest(request => request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/v1/checkout/quote'
      && new URL(request.frame().url()).pathname === '/checkout')
    await page.getByRole('button', { name: '更新资料并结算', exact: true }).click()
    const committed = await committing
    expect(committed.status(), await committed.text()).toBe(200)
    await expect(page).toHaveURL(/\/checkout\?/u)
    expect((await checkoutQuote).postDataJSON().items.find((row: { skuId: string }) => row.skuId === fixture.skuId).quantity).toBe(2)
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL })
    try {
      const actual = await pool.query('SELECT revision, quantity, draft_id FROM customer_cart_items WHERE line_id = $1', [fixture.line.lineId])
      expect(actual.rows[0]).toMatchObject({ revision: current.lineRevision + 1, quantity: 2,
        draft_id: fixture.replacement.replacementDraftId })
    } finally { await pool.end() }
  } finally { await otherTab.close() }
})

async function spaNavigate(page: Page, destination: string) {
  await page.evaluate(async to => {
    const root = document.querySelector('#__nuxt') as Element & {
      __vue_app__?: { config: { globalProperties: { $router?: { push: (to: string) => Promise<unknown> } } } }
    }
    const router = root?.__vue_app__?.config.globalProperties.$router
    if (!router) throw new Error('Nuxt router is not mounted')
    await router.push(to)
  }, destination)
}

test('R3 cancels a resumed edit using the updated quantity revision at mobile width', async ({ page }) => {
  test.setTimeout(90_000)
  const fixture = await setupEdit(page)
  const added = await fixture.add()
  expect(added.status()).toBe(200)
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto(fixture.oldLink)
  const form = page.locator('section[aria-labelledby="purchase-form-title"]')
  await expect(form.getByRole('status')).toContainText('已恢复这行购买资料')
  await expect(page.getByRole('spinbutton', { name: '购买数量' })).toHaveValue('2')
  await form.getByLabel('R3 账号').fill('local-uncommitted-edit')
  await page.screenshot({ path: join(tmpdir(), 'aikayun-r3-browser-evidence', 'mobile.png'), fullPage: true })
  const cancelling = page.waitForResponse(response => new URL(response.url()).pathname === fixture.path
    && response.request().method() === 'DELETE')
  await form.getByRole('button', { name: '撤销本次编辑' }).click()
  const response = await cancelling
  expect(response.request().postDataJSON().expectedLineRevision).toBe(fixture.line.lineRevision + 1)
  expect(response.status(), await response.text()).toBe(200)
  await expect(page).toHaveURL(/\/cart$/u)
  expect((await page.request.get(fixture.path)).status()).toBe(404)
  const cart = (await (await page.request.get('/api/v1/customer/cart')).json()).data
  expect(cart.items.find((row: Line) => row.lineId === fixture.line.lineId))
    .toMatchObject({ quantity: 2, draftId: fixture.line.draftId, draftRevision: fixture.line.draftRevision })
  const source = (await (await page.request.get(`/api/v1/storefront/purchase-drafts/${fixture.line.draftId}?skuId=${fixture.skuId}`)).json()).data
  expect(source.values).toEqual(fixture.values)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test('R3 rejects an old source binding after another tab changes real purchase data', async ({ page }) => {
  test.setTimeout(90_000)
  const fixture = await setupEdit(page)
  const changed = await page.request.patch(`/api/v1/customer/cart/lines/${fixture.line.lineId}/purchase-form`, {
    headers: fixture.headers, data: { expectedLineRevision: fixture.line.lineRevision,
      expectedDraftRevision: fixture.line.draftRevision, draftRevision: fixture.line.draftRevision,
      values: { [fixture.fieldId]: 'new-server-source' } },
  })
  expect(changed.status(), await changed.text()).toBe(200)
  let creations = 0
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/storefront/purchase-drafts') creations++
  })
  await page.goto(fixture.oldLink)
  const form = page.locator('section[aria-labelledby="purchase-form-title"]')
  await expect(form.getByRole('alert')).toContainText('来源资料已变化')
  await expect(form.getByLabel('R3 账号')).toHaveCount(0)
  expect(creations).toBe(0)
  const cart = (await (await page.request.get('/api/v1/customer/cart')).json()).data
  expect(cart.items.find((row: Line) => row.lineId === fixture.line.lineId))
    .toMatchObject({ draftId: fixture.line.draftId, draftRevision: fixture.line.draftRevision + 1, quantity: 1 })
  const source = (await (await page.request.get(`/api/v1/storefront/purchase-drafts/${fixture.line.draftId}?skuId=${fixture.skuId}`)).json()).data
  expect(source.values[fixture.fieldId]).toBe('new-server-source')
})

test('R3 ignores a delayed old relationship GET after a newer restore and local input', async ({ page, context }) => {
  test.setTimeout(90_000)
  const fixture = await setupEdit(page)
  await page.goto('/cart')
  await expect(page.getByRole('heading', { name: '购物车', exact: true })).toBeVisible()
  let open!: () => void
  let ready!: () => void
  const gate = new Promise<void>(resolve => { open = resolve })
  const reached = new Promise<void>(resolve => { ready = resolve })
  let gated = false
  let oldRevision = 0
  await page.route(`**${fixture.path}`, async route => {
    if (route.request().method() !== 'GET' || gated) { await route.continue(); return }
    gated = true
    const response = await route.fetch()
    oldRevision = (await response.json()).data.sourceLineRevision
    ready()
    await gate
    await route.fulfill({ response })
  })
  const other = await context.newPage()
  try {
    await spaNavigate(page, fixture.oldLink)
    await reached
    const added = await other.request.post('/api/v1/customer/cart/items', { headers: fixture.headers,
      data: { version: 2, skuId: fixture.skuId, quantity: 1, draftId: fixture.line.draftId, draftRevision: fixture.line.draftRevision } })
    expect(added.status()).toBe(200)
    const newest = new URL(fixture.oldLink, page.url())
    newest.searchParams.set('lineRevision', String(fixture.line.lineRevision + 1))
    await spaNavigate(page, `${newest.pathname}${newest.search}`)
    const form = page.locator('section[aria-labelledby="purchase-form-title"]')
    await expect(form.getByRole('status')).toContainText('已恢复这行购买资料')
    await form.getByLabel('R3 账号').fill('keep-local-after-newer-restore')
    const late = page.waitForResponse(response => new URL(response.url()).pathname === fixture.path
      && response.request().method() === 'GET')
    open()
    await late
    expect(oldRevision).toBe(fixture.line.lineRevision)
    await expect(form.getByLabel('R3 账号')).toHaveValue('keep-local-after-newer-restore')
    await expect(page.getByRole('spinbutton', { name: '购买数量' })).toHaveValue('2')
    const save = page.waitForResponse(response => new URL(response.url()).pathname === fixture.path
      && response.request().method() === 'PUT')
    await form.getByRole('button', { name: '保存填写内容', exact: true }).click()
    const saved = await save
    expect(saved.request().postDataJSON().expectedLineRevision).toBe(fixture.line.lineRevision + 1)
    expect(saved.status()).toBe(200)
  } finally { open(); await other.close() }
})
