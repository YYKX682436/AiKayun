import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'

type Product = { id: string; revision: number; variants: Array<{ id: string }> }
type SessionResponse = { data: { sessionId: string } }
type FixtureCleanup = { productId?: string; policy?: Record<string, unknown> }
const guestCookieName = 'aikayun_guest_order_session'
const intentKey = 'aikayun-order-intents-v2'
let testIpSequence = 1

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `198.18.1.${testIpSequence++}` })
})

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

async function setupProduct(page: Page, cleanup: FixtureCleanup) {
  await page.goto('/cart')
  await page.context().addCookies([{
    name: 'aikayun_admin_session', value: createBrowserAdminSession(),
    url: new URL(page.url()).origin, httpOnly: true, sameSite: 'Lax',
  }])
  const policyResponse = await page.request.get('/api/v1/admin/storefront/customer-policy')
  const { updatedAt: _updatedAt, ...policy } = (await policyResponse.json()).data
  cleanup.policy = policy
  expect((await page.request.put('/api/v1/admin/storefront/customer-policy', {
    headers: await adminHeaders(page), data: { ...policy, guestCheckoutEnabled: true },
  })).status()).toBe(200)
  const created = await page.request.post('/api/v1/admin/products', {
    headers: await adminHeaders(page),
    data: { name: `游客主体R1-${randomUUID().slice(0, 8)}`, description: '游客原请求绑定回归', productType: 'digital', defaultSku: { salePrice: '4.00' } },
  })
  expect(created.status()).toBe(201)
  let product = (await created.json()).data as Product
  cleanup.productId = product.id
  const active = await page.request.patch(`/api/v1/admin/products/${product.id}/lifecycle`, {
    headers: await adminHeaders(page), data: { expectedRevision: product.revision, status: 'active' },
  })
  expect(active.status()).toBe(200)
  product = (await active.json()).data as Product
  const inventory = (await (await page.request.get(`/api/v1/admin/products/${product.id}/inventory`)).json()).data
  const variant = inventory.variants[0]
  expect((await page.request.put(`/api/v1/admin/products/${product.id}/variants/${variant.skuId}/inventory-mode`, {
    headers: await adminHeaders(page), data: {
      expectedRevision: inventory.productRevision, expectedSkuRevision: variant.skuRevision,
      expectedInventoryRevision: variant.inventoryRevision, inventoryMode: 'quantity',
    },
  })).status()).toBe(200)
  const latest = (await (await page.request.get(`/api/v1/admin/products/${product.id}/inventory`)).json()).data
  const stock = latest.variants[0]
  const adjusted = await page.request.post(`/api/v1/admin/products/${product.id}/variants/${stock.skuId}/inventory/adjustments`, {
    headers: await adminHeaders(page), data: {
      expectedInventoryRevision: stock.inventoryRevision, operationId: randomUUID(), action: 'increase',
      quantity: 10, reason: 'R1 isolated checkout test',
    },
  })
  expect(adjusted.status(), await adjusted.text()).toBe(201)
  expect((await page.request.put(`/api/v1/admin/products/${product.id}/variants/${stock.skuId}/manual-fulfillment`, {
    headers: await adminHeaders(page), data: { enabled: true },
  })).status()).toBe(200)
  return { product, policy }
}

function databaseState(idempotencyKey: string) {
  const output = execFileSync('pnpm', ['--filter', '@aikayun/api', 'exec', 'node', 'test/fixtures/checkout-guest-r1-state.mjs', idempotencyKey], {
    cwd: resolve(import.meta.dirname, '../../../..'), env: process.env, encoding: 'utf8',
  })
  return JSON.parse(output) as { orders: Array<{ id: string; guest_order_session_id: string }>; reservations: Array<{ id: string; quantity: number }> }
}

async function installSelection(page: Page, skuId: string) {
  const line = { lineId: randomUUID(), skuId, quantity: 1 }
  const selectionId = randomUUID()
  await page.evaluate(({ line, selectionId }) => sessionStorage.setItem('aikayun-checkout-selections-v2', JSON.stringify([{
    id: selectionId, fingerprint: JSON.stringify([line]), items: [line],
  }])), { line, selectionId })
  return `/checkout?intent=${selectionId}`
}

test('concurrent initial v2 and legacy guest checkout bind lost-acknowledgment recovery to the actual cookie owner', async ({ page }) => {
  test.setTimeout(150_000)
  const context = page.context()
  const second = await context.newPage()
  const aSessionReady = gate()
  const aSessionRelease = gate()
  const bSessionReady = gate()
  const bSessionRelease = gate()
  const orderProbeReady = gate()
  const orderProbeRelease = gate()
  let aSessionId = ''
  let bSessionId = ''
  let lateSecondSession = false
  const keys: string[] = []
  const legacyKeys: string[] = []
  let committedOrderId = ''
  const cleanup: FixtureCleanup = {}
  try {
    const { product } = await setupProduct(page, cleanup)
    const checkoutUrl = await installSelection(page, product.variants[0]!.id)
    await page.goto(checkoutUrl)
    await second.goto(`/checkout?items=${encodeURIComponent(JSON.stringify([{ skuId: product.variants[0]!.id, quantity: 2 }]))}`)
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    await expect(second.getByRole('button', { name: '提交订单' })).toBeEnabled()
    expect((await context.cookies()).some(cookie => cookie.name === guestCookieName)).toBe(false)
    await page.route('**/api/v1/guest/session', async (route) => {
      const response = await route.fetch()
      const initialCreation = !aSessionId
      aSessionId = ((await response.json()) as SessionResponse).data.sessionId
      if (initialCreation) await context.clearCookies({ name: guestCookieName })
      aSessionReady.open()
      await aSessionRelease.promise
      await route.fulfill({ response })
    })
    await second.route('**/api/v1/guest/session', async (route) => {
      const response = await route.fetch()
      bSessionId = ((await response.json()) as SessionResponse).data.sessionId
      if (lateSecondSession) await context.clearCookies({ name: guestCookieName })
      bSessionReady.open()
      if (lateSecondSession) await bSessionRelease.promise
      await route.fulfill({ response })
    })
    await page.route('**/api/customer/session', async (route) => {
      const pending = await page.evaluate(key => localStorage.getItem(key), intentKey)
      if (pending && !committedOrderId) {
        orderProbeReady.open()
        await orderProbeRelease.promise
      }
      await route.continue()
    })
    await page.route('**/api/v1/checkout/orders', async (route) => {
      const body = route.request().postDataJSON() as { idempotencyKey: string }
      keys.push(body.idempotencyKey)
      const response = await route.fetch()
      expect([200, 201]).toContain(response.status())
      committedOrderId = (await response.json()).data.order.id
      await route.abort('failed')
    })
    await second.route('**/api/v1/checkout/orders', async (route) => {
      legacyKeys.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey)
      await route.abort('failed')
    })
    await page.getByRole('button', { name: '提交订单' }).click()
    await aSessionReady.promise
    lateSecondSession = true
    await second.getByRole('button', { name: '提交订单' }).click()
    const competitor = await Promise.race([
      bSessionReady.promise.then(() => 'session' as const),
      (async () => {
        await expect.poll(async () => second.evaluate(async () => (await navigator.locks.query()).pending?.some(lock => lock.name === 'aikayun:order-submission:v2') ?? false)).toBe(true)
        return 'lock' as const
      })().catch(() => 'not-queued' as const),
    ])
    aSessionRelease.open()
    await orderProbeReady.promise
    if (competitor === 'session') {
      const delivered = second.waitForResponse('**/api/v1/guest/session')
      bSessionRelease.open()
      await delivered
    } else lateSecondSession = false
    orderProbeRelease.open()
    await expect(page.getByRole('alert').filter({ hasText: '服务暂时无法处理此请求' })).toBeVisible()
    await bSessionReady.promise
    const pending = JSON.parse(await page.evaluate(key => localStorage.getItem(key), intentKey) ?? '[]') as Array<{ ownerId: string; idempotencyKey: string }>
    const resumed = await page.request.post('/api/v1/guest/session', {
      headers: { origin: new URL(page.url()).origin, 'x-csrf-token': (await context.cookies()).find(cookie => cookie.name === 'aikayun_customer_csrf')!.value },
    })
    const currentSessionId = ((await resumed.json()) as SessionResponse).data.sessionId
    const beforeReplay = databaseState(pending[0]!.idempotencyKey)
    console.info('R1 guest binding evidence', JSON.stringify({ pendingOwner: pending[0]!.ownerId, aSessionId, bSessionId, currentSessionId, orderOwner: beforeReplay.orders[0]?.guest_order_session_id, orders: beforeReplay.orders.length, reservations: beforeReplay.reservations.length }))
    expect(pending[0]!.ownerId).toBe(`guest:${currentSessionId}`)
    expect(beforeReplay.orders).toEqual([{ id: committedOrderId, guest_order_session_id: currentSessionId }])
    expect(beforeReplay.reservations).toEqual([{ id: expect.any(String), quantity: 1 }])
    await page.unroute('**/api/v1/checkout/orders')
    await page.route('**/api/v1/checkout/orders', async (route) => {
      keys.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey)
      await route.continue()
    })
    await page.reload()
    await expect(page).toHaveURL(new RegExp(`/orders/${committedOrderId}$`, 'u'))
    expect(keys).toEqual([pending[0]!.idempotencyKey, pending[0]!.idempotencyKey])
    expect(databaseState(pending[0]!.idempotencyKey)).toEqual(beforeReplay)
    await expect(second.getByRole('alert').filter({ hasText: '服务暂时无法处理此请求' })).toBeVisible()
    expect(legacyKeys).toHaveLength(1)
    const binding = await second.evaluate(() => sessionStorage.getItem('aikayun-order-intent-guest-owners-v1'))
    expect(JSON.parse(binding ?? '[]')).toEqual([{ idempotencyKey: legacyKeys[0], ownerId: `guest:${currentSessionId}` }])
    // A newly created legacy key also retains its real owner after a network
    // failure. A later genuine guest session cannot reuse that key as its own.
    await context.clearCookies({ name: guestCookieName })
    const changedSession = await page.request.post('/api/v1/guest/session', {
      headers: { origin: new URL(page.url()).origin, 'x-csrf-token': (await context.cookies()).find(cookie => cookie.name === 'aikayun_customer_csrf')!.value },
    })
    expect(changedSession.status()).toBe(201)
    expect(((await changedSession.json()) as SessionResponse).data.sessionId).not.toBe(currentSessionId)
    await second.getByRole('button', { name: '提交订单' }).click()
    await expect(second.getByRole('alert').filter({ hasText: '已有其他账户或游客会话的未确认订单' })).toBeVisible()
    expect(legacyKeys).toHaveLength(1)
    expect(await second.evaluate(() => sessionStorage.getItem('aikayun-order-intent-guest-owners-v1'))).toBe(binding)
    expect(databaseState(legacyKeys[0]!)).toEqual({ orders: [], reservations: [] })
  } finally {
    aSessionRelease.open(); bSessionRelease.open(); orderProbeRelease.open()
    try {
      try {
        if (cleanup.productId) await pauseProduct(page, cleanup.productId)
      } finally {
        if (cleanup.policy) expect((await page.request.put('/api/v1/admin/storefront/customer-policy', {
          headers: await adminHeaders(page), data: cleanup.policy,
        })).status()).toBe(200)
      }
    } finally {
      await second.close()
    }
  }
})

test('a late real guest Set-Cookie cannot submit a pending request under a different owner', async ({ page }) => {
  test.setTimeout(120_000)
  const context = page.context()
  const second = await context.newPage()
  const bSessionReady = gate()
  const bSessionRelease = gate()
  const probeReady = gate()
  const probeRelease = gate()
  let aSessionId = ''
  let bSessionId = ''
  let orderKey = ''
  let expectedOwnerHeader = ''
  const cleanup: FixtureCleanup = {}
  try {
    const { product } = await setupProduct(page, cleanup)
    await second.goto('/cart')
    const csrf = (await context.cookies()).find(cookie => cookie.name === 'aikayun_customer_csrf')
      ?? (await (await page.request.get('/api/v1/customer/auth/csrf')).json()).data.csrfToken
    const csrfValue = typeof csrf === 'string' ? csrf : csrf.value
    await second.route('**/api/v1/guest/session', async (route) => {
      const response = await route.fetch()
      bSessionId = ((await response.json()) as SessionResponse).data.sessionId
      await context.clearCookies({ name: guestCookieName })
      bSessionReady.open()
      await bSessionRelease.promise
      await route.fulfill({ response })
    })
    const lateCreation = second.evaluate(async (csrfToken) => {
      const response = await fetch('/api/v1/guest/session', {
        method: 'POST', headers: { 'x-csrf-token': csrfToken },
      })
      return response.status
    }, csrfValue)
    await bSessionReady.promise
    await page.route('**/api/v1/guest/session', async (route) => {
      const response = await route.fetch()
      aSessionId = ((await response.json()) as SessionResponse).data.sessionId
      await route.fulfill({ response })
    })
    await page.route('**/api/customer/session', async (route) => {
      if (await page.evaluate(key => localStorage.getItem(key), intentKey)) {
        probeReady.open()
        await probeRelease.promise
      }
      await route.continue()
    })
    await page.route('**/api/v1/checkout/orders', async (route) => {
      orderKey = (route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey
      expectedOwnerHeader = route.request().headers()['x-aikayun-guest-session-id'] ?? ''
      await route.continue()
    })
    const checkoutUrl = await installSelection(page, product.variants[0]!.id)
    await page.goto(checkoutUrl)
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    await page.getByRole('button', { name: '提交订单' }).click()
    await probeReady.promise
    bSessionRelease.open()
    expect(await lateCreation).toBe(201)
    const rejected = page.waitForResponse('**/api/v1/checkout/orders')
    probeRelease.open()
    const response = await rejected
    const responseBody = await response.json()
    const state = databaseState(orderKey)
    console.info('R1 late cookie evidence', JSON.stringify({ status: response.status(), aSessionId, bSessionId, expectedOwnerHeader, orders: state.orders.length, reservations: state.reservations.length }))
    expect(response.status()).toBe(409)
    expect(responseBody.error.code).toBe('GUEST_SESSION_CHANGED')
    expect(expectedOwnerHeader).toBe(aSessionId)
    expect(aSessionId).not.toBe(bSessionId)
    expect(state).toEqual({ orders: [], reservations: [] })
    const pending = JSON.parse(await page.evaluate(key => localStorage.getItem(key), intentKey) ?? '[]') as Array<{ state: string; ownerId: string; idempotencyKey: string }>
    expect(pending).toEqual([expect.objectContaining({ state: 'pending', ownerId: `guest:${aSessionId}`, idempotencyKey: orderKey })])
  } finally {
    bSessionRelease.open(); probeRelease.open()
    try {
      try {
        if (cleanup.productId) await pauseProduct(page, cleanup.productId)
      } finally {
        if (cleanup.policy) expect((await page.request.put('/api/v1/admin/storefront/customer-policy', {
          headers: await adminHeaders(page), data: cleanup.policy,
        })).status()).toBe(200)
      }
    } finally {
      await second.close()
    }
  }
})
