import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'

type Policy = {
  requireEmail: boolean; requirePhone: boolean; guestCheckoutEnabled: boolean
  guestFreeClaimEnabled: boolean; unpaidOrderTimeoutMinutes: 5 | 15 | 30
}
const identityLock = 'aikayun:customer-identity:v1'

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

async function adminHeaders(page: Page) {
  const response = await page.request.get('/api/v1/admin/auth/csrf')
  expect(response.status()).toBe(200)
  return { origin: new URL(page.url()).origin, 'x-csrf-token': (await response.json()).data.csrfToken as string }
}

async function pauseProduct(page: Page, productId: string): Promise<void> {
  const response = await page.request.get(`/api/v1/admin/products/${productId}`)
  expect(response.status()).toBe(200)
  const product = (await response.json()).data as { revision: number; status: string }
  if (product.status !== 'active') return
  const paused = await page.request.patch(`/api/v1/admin/products/${productId}/lifecycle`, {
    headers: await adminHeaders(page), data: { expectedRevision: product.revision, status: 'paused' },
  })
  expect(paused.status()).toBe(200)
  expect((await paused.json()).data.status).toBe('paused')
}

test('checkout and a same-SPA profile save complete when CSRF renewal queues behind checkout identity', async ({ page, context }) => {
  test.setTimeout(90_000)
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': '198.18.2.201' })
  const probeReady = gate()
  const probeRelease = gate()
  let policy: Policy | undefined
  let productId: string | undefined
  let holdNextProbe = false
  let csrfRequests = 0
  let orderRequests = 0
  let profileRequests = 0
  await page.goto('/cart')
  await context.addCookies([{
    name: 'aikayun_admin_session', value: createBrowserAdminSession(),
    url: new URL(page.url()).origin, httpOnly: true, sameSite: 'Lax',
  }])
  try {
    const policyResponse = await page.request.get('/api/v1/admin/storefront/customer-policy')
    expect(policyResponse.status()).toBe(200)
    const data = (await policyResponse.json()).data as Policy
    policy = {
      requireEmail: data.requireEmail, requirePhone: data.requirePhone,
      guestCheckoutEnabled: data.guestCheckoutEnabled, guestFreeClaimEnabled: data.guestFreeClaimEnabled,
      unpaidOrderTimeoutMinutes: data.unpaidOrderTimeoutMinutes,
    }
    const policyUpdate = await page.request.put('/api/v1/admin/storefront/customer-policy', {
      headers: await adminHeaders(page), data: { ...policy, requireEmail: false, requirePhone: false },
    })
    expect(policyUpdate.status()).toBe(200)
    const created = await page.request.post('/api/v1/admin/products', {
      headers: await adminHeaders(page),
      data: { name: `R1身份锁-${randomUUID().slice(0, 8)}`, productType: 'digital', defaultSku: { salePrice: '4.00' } },
    })
    expect(created.status()).toBe(201)
    const product = (await created.json()).data as { id: string; revision: number; variants: Array<{ id: string }> }
    productId = product.id
    expect((await page.request.patch(`/api/v1/admin/products/${product.id}/lifecycle`, {
      headers: await adminHeaders(page), data: { expectedRevision: product.revision, status: 'active' },
    })).status()).toBe(200)
    const inventory = (await (await page.request.get(`/api/v1/admin/products/${product.id}/inventory`)).json()).data as {
      productRevision: number; variants: Array<{ skuId: string; skuRevision: number; inventoryRevision: number }>
    }
    const sku = inventory.variants[0]!
    expect((await page.request.put(`/api/v1/admin/products/${product.id}/variants/${sku.skuId}/inventory-mode`, {
      headers: await adminHeaders(page), data: {
        expectedRevision: inventory.productRevision, expectedSkuRevision: sku.skuRevision,
        expectedInventoryRevision: sku.inventoryRevision, inventoryMode: 'unlimited',
      },
    })).status()).toBe(200)
    expect((await page.request.put(`/api/v1/admin/products/${product.id}/variants/${sku.skuId}/manual-fulfillment`, {
      headers: await adminHeaders(page), data: { enabled: true },
    })).status()).toBe(200)

    const username = `r1lock_${randomUUID().slice(0, 8)}`
    await page.goto('/register')
    await expect(page.locator('[data-customer-register-ready="true"]')).toBeAttached()
    await page.getByLabel('用户名').fill(username)
    await page.getByLabel('密码', { exact: true }).fill('R1-Identity-Lock-Password-2026!')
    await page.getByLabel('确认密码').fill('R1-Identity-Lock-Password-2026!')
    await page.getByRole('button', { name: '创建账户' }).click()
    await expect(page).toHaveURL(/\/account$/u)

    const selectionId = randomUUID()
    const line = { lineId: randomUUID(), skuId: sku.skuId, quantity: 1 }
    await page.evaluate(({ selectionId, line }) => sessionStorage.setItem('aikayun-checkout-selections-v2', JSON.stringify([{
      id: selectionId, fingerprint: JSON.stringify([line]), items: [line],
    }])), { selectionId, line })
    await page.goto(`/checkout?intent=${selectionId}`)
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    const marker = randomUUID()
    await page.evaluate(marker => { (window as Window & { r1SpaMarker?: string }).r1SpaMarker = marker }, marker)
    await context.clearCookies({ name: 'aikayun_customer_csrf' })
    await page.route('**/api/customer/session', async (route) => {
      if (!holdNextProbe) return route.continue()
      holdNextProbe = false
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      probeReady.open()
      await probeRelease.promise
      await route.fulfill({ response })
    })
    await page.route('**/api/v1/customer/auth/csrf', async (route) => {
      csrfRequests += 1
      await route.continue()
    })
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/v1/checkout/orders')) orderRequests += 1
      if (request.method() === 'PATCH' && request.url().endsWith('/api/v1/customer/profile')) profileRequests += 1
    })
    holdNextProbe = true
    await page.getByRole('button', { name: '提交订单' }).click()
    await probeReady.promise
    expect(await page.evaluate(async lockName => (await navigator.locks.query()).held?.some(lock =>
      lock.name === lockName && lock.mode === 'exclusive'), identityLock)).toBe(true)

    // This client-side navigation retains the same Nuxt app and its shared
    // CSRF promise while the checkout callback is still holding identity.
    await page.getByRole('link', { name: `顾客账户，${username}` }).click()
    await expect(page).toHaveURL(/\/account$/u)
    expect(await page.evaluate(() => (window as Window & { r1SpaMarker?: string }).r1SpaMarker)).toBe(marker)
    await expect(page.getByRole('button', { name: '保存联系方式' })).toBeEnabled()
    const email = `${username}@example.com`
    await page.getByLabel('邮箱', { exact: true }).fill(email)
    const orderResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && response.url().endsWith('/api/v1/checkout/orders'), { timeout: 10_000 })
    const profileResponse = page.waitForResponse(response => response.request().method() === 'PATCH'
      && response.url().endsWith('/api/v1/customer/profile'), { timeout: 10_000 })
    await page.getByRole('button', { name: '保存联系方式' }).click()
    await expect.poll(() => page.evaluate(async lockName => (await navigator.locks.query()).pending?.some(lock =>
      lock.name === lockName && lock.mode === 'exclusive'), identityLock)).toBe(true)
    expect(csrfRequests).toBe(0)
    expect(orderRequests).toBe(0)
    expect(profileRequests).toBe(0)
    probeRelease.open()
    let responses
    try {
      responses = await Promise.all([orderResponse, profileResponse])
    } catch (error) {
      const locks = await page.evaluate(() => navigator.locks.query())
      throw new Error(`Checkout/profile did not finish: ${JSON.stringify({ csrfRequests, orderRequests, profileRequests, locks })}`, { cause: error })
    }
    expect(responses[0]!.status()).toBe(201)
    expect(responses[1]!.status()).toBe(200)
    expect(csrfRequests).toBe(1)
    expect(orderRequests).toBe(1)
    expect(profileRequests).toBe(1)
    const profile = await page.request.get('/api/v1/customer/profile')
    expect(profile.status()).toBe(200)
    expect((await profile.json()).data.email).toBe(email)
    const orders = execFileSync('pnpm', ['--filter', '@aikayun/api', 'exec', 'node', 'test/fixtures/checkout-alias-r1-state.mjs', sku.skuId], {
      cwd: resolve(import.meta.dirname, '../../../..'), env: process.env, encoding: 'utf8',
    })
    expect(JSON.parse(orders)).toHaveLength(1)
    await expect.poll(() => page.evaluate(async lockName => {
      const locks = await navigator.locks.query()
      return [...(locks.held ?? []), ...(locks.pending ?? [])].filter(lock => lock.name === lockName).length
    }, identityLock)).toBe(0)
  } finally {
    probeRelease.open()
    try {
      if (productId) await pauseProduct(page, productId)
    } finally {
      if (policy) {
        const restored = await page.request.put('/api/v1/admin/storefront/customer-policy', {
          headers: await adminHeaders(page), data: policy,
        })
        expect(restored.status()).toBe(200)
      }
    }
  }
})
