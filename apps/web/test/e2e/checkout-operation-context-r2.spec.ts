import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'

type Product = { id: string; revision: number; name: string; variants: Array<{ id: string }> }
type Line = { lineId: string; skuId: string; quantity: number }
type Policy = {
  requireEmail: boolean; requirePhone: boolean; guestCheckoutEnabled: boolean
  guestFreeClaimEnabled: boolean; unpaidOrderTimeoutMinutes: 5 | 15 | 30
}
type Cleanup = { productIds: string[]; policy?: Policy }
type Gate = { promise: Promise<void>; open: () => void }
type Intent = {
  state: 'pending' | 'rejected' | 'completed'
  ownerId: string
  selectionId: string | null
  selectionAliases?: string[]
  idempotencyKey: string
  quoteToken?: string
  items?: Line[]
  orderId?: string
}

const intentKey = 'aikayun-order-intents-v2'
const selectionKey = 'aikayun-checkout-selections-v2'
const submissionLock = 'aikayun:order-submission:v2'
const identityLock = 'aikayun:customer-identity:v1'
let testIpSequence = 1

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `198.18.3.${testIpSequence++}` })
})

function gate(): Gate {
  let open!: () => void
  const promise = new Promise<void>((resolvePromise) => { open = resolvePromise })
  return { promise, open: () => open() }
}

async function adminHeaders(page: Page) {
  const response = await page.request.get('/api/v1/admin/auth/csrf')
  expect(response.status()).toBe(200)
  return { origin: new URL(page.url()).origin, 'x-csrf-token': (await response.json()).data.csrfToken as string }
}

async function prepareProducts(page: Page, cleanup: Cleanup): Promise<[Product, Product]> {
  await page.goto('/cart')
  await page.context().addCookies([{
    name: 'aikayun_admin_session', value: createBrowserAdminSession(),
    url: new URL(page.url()).origin, httpOnly: true, sameSite: 'Lax',
  }])
  const policyResponse = await page.request.get('/api/v1/admin/storefront/customer-policy')
  expect(policyResponse.status()).toBe(200)
  const current = (await policyResponse.json()).data as Policy
  cleanup.policy = {
    requireEmail: current.requireEmail, requirePhone: current.requirePhone,
    guestCheckoutEnabled: current.guestCheckoutEnabled, guestFreeClaimEnabled: current.guestFreeClaimEnabled,
    unpaidOrderTimeoutMinutes: current.unpaidOrderTimeoutMinutes,
  }
  const enabled = await page.request.put('/api/v1/admin/storefront/customer-policy', {
    headers: await adminHeaders(page), data: { ...cleanup.policy, guestCheckoutEnabled: true },
  })
  expect(enabled.status()).toBe(200)

  const products: Product[] = []
  for (const [label, price] of [['A', '4.00'], ['B', '7.00']] as const) {
    const created = await page.request.post('/api/v1/admin/products', {
      headers: await adminHeaders(page),
      data: {
        name: `R2上下文${label}-${randomUUID().slice(0, 8)}`,
        description: 'R2 checkout operation context regression',
        productType: 'digital', defaultSku: { salePrice: price },
      },
    })
    expect(created.status(), await created.text()).toBe(201)
    let product = (await created.json()).data as Product
    cleanup.productIds.push(product.id)
    const active = await page.request.patch(`/api/v1/admin/products/${product.id}/lifecycle`, {
      headers: await adminHeaders(page), data: { expectedRevision: product.revision, status: 'active' },
    })
    expect(active.status()).toBe(200)
    product = (await active.json()).data as Product
    const inventoryResponse = await page.request.get(`/api/v1/admin/products/${product.id}/inventory`)
    expect(inventoryResponse.status()).toBe(200)
    const inventory = (await inventoryResponse.json()).data as {
      productRevision: number
      variants: Array<{ skuId: string; skuRevision: number; inventoryRevision: number }>
    }
    const sku = inventory.variants[0]!
    const mode = await page.request.put(`/api/v1/admin/products/${product.id}/variants/${sku.skuId}/inventory-mode`, {
      headers: await adminHeaders(page), data: {
        expectedRevision: inventory.productRevision, expectedSkuRevision: sku.skuRevision,
        expectedInventoryRevision: sku.inventoryRevision, inventoryMode: 'quantity',
      },
    })
    expect(mode.status()).toBe(200)
    const latest = (await (await page.request.get(`/api/v1/admin/products/${product.id}/inventory`)).json()).data as {
      variants: Array<{ skuId: string; inventoryRevision: number }>
    }
    const stock = latest.variants[0]!
    const adjusted = await page.request.post(`/api/v1/admin/products/${product.id}/variants/${stock.skuId}/inventory/adjustments`, {
      headers: await adminHeaders(page), data: {
        expectedInventoryRevision: stock.inventoryRevision, operationId: randomUUID(), action: 'increase',
        quantity: 10, reason: 'R2 isolated checkout context regression',
      },
    })
    expect(adjusted.status()).toBe(201)
    const fulfillment = await page.request.put(`/api/v1/admin/products/${product.id}/variants/${sku.skuId}/manual-fulfillment`, {
      headers: await adminHeaders(page), data: { enabled: true },
    })
    expect(fulfillment.status()).toBe(200)
    products.push(product)
  }
  return [products[0]!, products[1]!]
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
}

async function cleanupFixture(page: Page, cleanup: Cleanup): Promise<void> {
  try {
    for (const productId of cleanup.productIds) await pauseProduct(page, productId)
  } finally {
    if (cleanup.policy) {
      const restored = await page.request.put('/api/v1/admin/storefront/customer-policy', {
        headers: await adminHeaders(page), data: cleanup.policy,
      })
      expect(restored.status()).toBe(200)
    }
  }
}

function newSelection(skuId: string): { selectionId: string; line: Line } {
  return { selectionId: randomUUID(), line: { lineId: randomUUID(), skuId, quantity: 1 } }
}

async function installSelections(page: Page, selections: Array<{ selectionId: string; line: Line }>): Promise<void> {
  await page.evaluate(({ entries, key }) => sessionStorage.setItem(key, JSON.stringify(entries.map(({ selectionId, line }) => ({
    id: selectionId, fingerprint: JSON.stringify([line]), items: [line],
  })))), { entries: selections, key: selectionKey })
}

async function routeTo(page: Page, path: string): Promise<void> {
  await page.evaluate(async (destination) => {
    const root = document.getElementById('__nuxt') as (HTMLElement & {
      __vue_app__?: { config?: { globalProperties?: Record<string, unknown> } }
    }) | null
    const router = root?.__vue_app__?.config?.globalProperties?.$router as { push?: (to: string) => Promise<unknown> } | undefined
    if (typeof router?.push !== 'function') throw new Error('Nuxt router is not mounted')
    await router.push(destination)
  }, path)
  await expect.poll(() => page.evaluate(() => `${location.pathname}${location.search}`)).toBe(path)
}

async function installHistory(page: Page, selections: { s1: { selectionId: string; line: Line }; s2: { selectionId: string; line: Line } }) {
  await page.goto(`/checkout?intent=${selections.s2.selectionId}`)
  await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
  const marker = randomUUID()
  await page.evaluate(value => { (window as Window & { r2DocumentMarker?: string }).r2DocumentMarker = value }, marker)
  await routeTo(page, '/cart')
  await routeTo(page, `/checkout?intent=${selections.s1.selectionId}`)
  await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
  await expect(page.getByRole('heading', { name: /R2上下文A-/u })).toBeVisible()
  return marker
}

async function switchHistoryToS2(page: Page, selectionId: string, marker: string): Promise<void> {
  await page.evaluate(() => history.go(-2))
  await expect.poll(() => page.evaluate(() => `${location.pathname}${location.search}`))
    .toBe(`/checkout?intent=${selectionId}`)
  expect(await page.evaluate(() => (window as Window & { r2DocumentMarker?: string }).r2DocumentMarker)).toBe(marker)
  await expect(page.getByRole('heading', { name: /R2上下文B-/u })).toBeVisible()
}

async function holdSubmissionLock(page: Page): Promise<() => Promise<void>> {
  await page.evaluate((lockName) => {
    const state = window as Window & { r2LockReady?: boolean; r2ReleaseLock?: () => void }
    void navigator.locks.request(lockName, { mode: 'exclusive' }, async () => {
      state.r2LockReady = true
      await new Promise<void>((resolvePromise) => { state.r2ReleaseLock = resolvePromise })
    })
  }, submissionLock)
  await page.waitForFunction(() => (window as Window & { r2LockReady?: boolean }).r2LockReady === true)
  return async () => page.evaluate(() => (window as Window & { r2ReleaseLock?: () => void }).r2ReleaseLock?.())
}

async function waitForQueuedSubmission(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async (lockName) =>
    (await navigator.locks.query()).pending?.some(lock => lock.name === lockName) ?? false, submissionLock)).toBe(true)
}

function ordersBySku(skuId: string): Array<{ id: string; idempotency_key: string }> {
  const output = execFileSync('pnpm', ['--filter', '@aikayun/api', 'exec', 'node', 'test/fixtures/checkout-alias-r1-state.mjs', skuId], {
    cwd: resolve(import.meta.dirname, '../../../..'), env: process.env, encoding: 'utf8',
  })
  return JSON.parse(output) as Array<{ id: string; idempotency_key: string }>
}

function orderState(key: string): { orders: Array<{ id: string; guest_order_session_id: string }>; reservations: Array<{ id: string; quantity: number }> } {
  const output = execFileSync('pnpm', ['--filter', '@aikayun/api', 'exec', 'node', 'test/fixtures/checkout-guest-r1-state.mjs', key], {
    cwd: resolve(import.meta.dirname, '../../../..'), env: process.env, encoding: 'utf8',
  })
  return JSON.parse(output) as { orders: Array<{ id: string; guest_order_session_id: string }>; reservations: Array<{ id: string; quantity: number }> }
}

async function readIntents(page: Page): Promise<Intent[]> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]') as Intent[], intentKey)
}

test('a lock-delayed S1 submit keeps its S1 link and leaves a same-SPA S2 selection usable', async ({ page, context }) => {
  test.setTimeout(150_000)
  const cleanup: Cleanup = { productIds: [] }
  const second = await context.newPage()
  let release: (() => Promise<void>) | undefined
  const postFinished = gate()
  let clicked = false
  const attempts: Array<{ key: string; items: Array<{ skuId: string }> }> = []
  try {
    const [productA, productB] = await prepareProducts(page, cleanup)
    const selections = { s1: newSelection(productA.variants[0]!.id), s2: newSelection(productB.variants[0]!.id) }
    await page.goto('/cart')
    await installSelections(page, [selections.s1, selections.s2])
    const marker = await installHistory(page, selections)
    await second.goto('/cart')
    release = await holdSubmissionLock(second)
    await page.route('**/api/v1/checkout/orders', async (route) => {
      const body = route.request().postDataJSON() as { idempotencyKey: string; items: Array<{ skuId: string }> }
      attempts.push({ key: body.idempotencyKey, items: body.items })
      try {
        const response = await route.fetch()
        if (![200, 201].includes(response.status())) console.info('R2 first order API response', response.status(), await response.text())
        expect([200, 201]).toContain(response.status())
        await route.fulfill({ response })
      } finally {
        postFinished.open()
      }
    })

    clicked = true
    await page.getByRole('button', { name: '提交订单' }).click()
    await waitForQueuedSubmission(page)
    await switchHistoryToS2(page, selections.s2.selectionId, marker)
    await release()
    release = undefined
    await postFinished.promise
    await expect.poll(async () => (await readIntents(page)).length).toBe(1)
    await expect.poll(() => page.evaluate(async (lockName) => {
      const locks = await navigator.locks.query()
      return [...(locks.held ?? []), ...(locks.pending ?? [])].filter(lock => lock.name === lockName).length
    }, submissionLock)).toBe(0)
    const committedA = (await readIntents(page))[0]!
    expect(committedA).toMatchObject({ state: 'completed', selectionId: selections.s1.selectionId })
    expect(committedA.selectionAliases ?? []).not.toContain(selections.s2.selectionId)
    expect(committedA.orderId).toBeTruthy()
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.items.map(item => item.skuId)).toEqual([productA.variants[0]!.id])
    await expect.poll(() => page.evaluate(() => `${location.pathname}${location.search}`))
      .toBe(`/checkout?intent=${selections.s2.selectionId}`)
    await expect(page.getByRole('heading', { name: new RegExp(productB.name) })).toBeVisible()
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()

    await page.getByRole('button', { name: '提交订单' }).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/u)
    const orderB = ordersBySku(productB.variants[0]!.id)
    expect(orderB).toHaveLength(1)
    expect(orderB[0]!.idempotency_key).toBe(attempts[1]?.key)
    const orderA = ordersBySku(productA.variants[0]!.id)
    expect(orderA).toHaveLength(1)
    expect(orderA[0]!.id).toBe(committedA.orderId)
    expect(attempts).toHaveLength(2)
    expect(orderState(attempts[0]!.key).reservations).toHaveLength(1)
    expect(orderState(attempts[1]!.key).reservations).toHaveLength(1)

    await routeTo(page, `/checkout?intent=${selections.s1.selectionId}`)
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/u)
    expect(new Set(attempts.map(attempt => attempt.key)).size).toBe(2)
    expect(ordersBySku(productA.variants[0]!.id)).toHaveLength(1)
    expect(ordersBySku(productB.variants[0]!.id)).toHaveLength(1)
  } finally {
    await release?.()
    if (clicked) await postFinished.promise
    try {
      await cleanupFixture(page, cleanup)
    } finally {
      await second.close()
    }
  }
})

test('an aborted real order acknowledgment stays recoverable under S1 after a lock-delayed route change', async ({ page, context }) => {
  test.setTimeout(150_000)
  const cleanup: Cleanup = { productIds: [] }
  const second = await context.newPage()
  let release: (() => Promise<void>) | undefined
  const committed = gate()
  const loseAcknowledgment = gate()
  const postFinished = gate()
  let clicked = false
  let postStarted = false
  const attempts: string[] = []
  let committedOrderId = ''
  try {
    const [productA, productB] = await prepareProducts(page, cleanup)
    const selections = { s1: newSelection(productA.variants[0]!.id), s2: newSelection(productB.variants[0]!.id) }
    await page.goto('/cart')
    await installSelections(page, [selections.s1, selections.s2])
    const marker = await installHistory(page, selections)
    await second.goto('/cart')
    release = await holdSubmissionLock(second)
    await page.route('**/api/v1/checkout/orders', async (route) => {
      postStarted = true
      attempts.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey)
      try {
        const response = await route.fetch()
        if (![200, 201].includes(response.status())) {
          console.info('R2 lost-ack order API response', response.status(), await response.text())
          committed.open()
          await route.fulfill({ response })
          return
        }
        committedOrderId = ((await response.json()) as { data: { order: { id: string } } }).data.order.id
        committed.open()
        if (attempts.length === 1) {
          await loseAcknowledgment.promise
          await route.abort('failed')
        } else {
          await route.fulfill({ response })
        }
      } finally {
        postFinished.open()
      }
    })

    clicked = true
    await page.getByRole('button', { name: '提交订单' }).click()
    await waitForQueuedSubmission(page)
    await switchHistoryToS2(page, selections.s2.selectionId, marker)
    await release()
    release = undefined
    await committed.promise
    const pending = (await readIntents(page)).find(intent => intent.state === 'pending')!
    const firstState = orderState(pending.idempotencyKey)
    console.info('R2 lost acknowledgment state', JSON.stringify({
      selectedS1: selections.s1.selectionId, selectedS2: selections.s2.selectionId,
      savedSelectionId: pending.selectionId, key: pending.idempotencyKey,
      committedOrderId, orders: firstState.orders.length, reservations: firstState.reservations.length,
    }))
    expect(firstState.orders).toEqual([{ id: committedOrderId, guest_order_session_id: expect.any(String) }])
    expect(firstState.reservations).toHaveLength(1)
    loseAcknowledgment.open()
    await postFinished.promise
    await expect.poll(() => page.evaluate(async (lockName) => {
      const locks = await navigator.locks.query()
      return [...(locks.held ?? []), ...(locks.pending ?? [])].filter(lock => lock.name === lockName).length
    }, submissionLock)).toBe(0)
    await page.evaluate(() => new Promise<void>(resolveFrames => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrames()))))
    await expect(page.getByRole('alert')).toHaveCount(0)
    const afterAbort = (await readIntents(page)).find(intent => intent.idempotencyKey === pending.idempotencyKey)!
    expect(afterAbort).toMatchObject({ state: 'pending', selectionId: selections.s1.selectionId })
    expect(afterAbort.items).toEqual([selections.s1.line])
    expect((await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? '[]'), selectionKey))
      .find((item: { id: string }) => item.id === selections.s2.selectionId).items).toEqual([selections.s2.line])

    const replayed = page.waitForResponse(response => response.url().endsWith('/api/v1/checkout/orders')
      && response.request().method() === 'POST')
    await page.evaluate(() => history.go(2))
    await expect.poll(() => page.evaluate(() => `${location.pathname}${location.search}`))
      .toBe(`/checkout?intent=${selections.s1.selectionId}`)
    const replayResponse = await replayed
    expect(replayResponse.status()).toBe(200)
    await expect(page).toHaveURL(new RegExp(`/orders/${committedOrderId}$`, 'u'))
    expect(attempts).toEqual([pending.idempotencyKey, pending.idempotencyKey])
    expect(orderState(pending.idempotencyKey)).toEqual(firstState)
    expect(ordersBySku(productA.variants[0]!.id)).toEqual([{ id: committedOrderId, idempotency_key: pending.idempotencyKey }])
    expect(ordersBySku(productB.variants[0]!.id)).toHaveLength(0)
  } finally {
    committed.open(); loseAcknowledgment.open()
    await release?.()
    if (clicked && postStarted) await postFinished.promise
    try {
      await cleanupFixture(page, cleanup)
    } finally {
      await second.close()
    }
  }
})

test('a delayed real 409 from S1 cannot replace S2 quote, errors, or submit state', async ({ page }) => {
  test.setTimeout(150_000)
  const cleanup: Cleanup = { productIds: [] }
  const second = await page.context().newPage()
  const responseReady = gate()
  const deliverResponse = gate()
  let release: (() => Promise<void>) | undefined
  let clicked = false
  let postFinished = false
  let requestKey = ''
  let responseDelivered = false
  try {
    const [productA, productB] = await prepareProducts(page, cleanup)
    const selections = { s1: newSelection(productA.variants[0]!.id), s2: newSelection(productB.variants[0]!.id) }
    await page.goto('/cart')
    await installSelections(page, [selections.s1, selections.s2])
    await installHistory(page, selections)

    await second.goto('/cart')
    release = await holdSubmissionLock(second)
    await page.getByRole('button', { name: '提交订单' }).click()
    clicked = true
    await waitForQueuedSubmission(page)
    const marker = await page.evaluate(() => (window as Window & { r2DocumentMarker?: string }).r2DocumentMarker ?? '')
    await switchHistoryToS2(page, selections.s2.selectionId, marker)
    await expect(page.getByText('¥7.00', { exact: true }).first()).toBeVisible()

    const path = `/api/v1/admin/products/${productA.id}/variants/${productA.variants[0]!.id}/prices`
    const priceResponse = await page.request.get(path)
    expect(priceResponse.status()).toBe(200)
    const price = (await priceResponse.json()).data as { productRevision: number; skuRevision: number }
    const changed = await page.request.patch(path, {
      headers: await adminHeaders(page),
      data: { expectedRevision: price.productRevision, expectedSkuRevision: price.skuRevision, salePrice: '5.00' },
    })
    expect(changed.status()).toBe(200)

    await page.route('**/api/v1/checkout/orders', async (route) => {
      requestKey = (route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey
      const response = await route.fetch()
      expect(response.status()).toBe(409)
      responseReady.open()
      await deliverResponse.promise
      await route.fulfill({ response })
      responseDelivered = true
      postFinished = true
    })
    await release()
    release = undefined
    await responseReady.promise
    const delivered = page.waitForResponse(response => response.url().endsWith('/api/v1/checkout/orders')
      && response.request().method() === 'POST')
    deliverResponse.open()
    const response = await delivered
    expect(response.status()).toBe(409)
    await expect.poll(async () => (await readIntents(page)).find(intent => intent.idempotencyKey === requestKey)?.state).toBe('rejected')
    await page.evaluate(() => new Promise<void>(resolveFrames => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrames()))))
    expect(responseDelivered).toBe(true)
    await expect.poll(() => page.evaluate(() => `${location.pathname}${location.search}`))
      .toBe(`/checkout?intent=${selections.s2.selectionId}`)
    await expect(page.getByRole('heading', { name: new RegExp(productB.name) })).toBeVisible()
    await expect(page.getByText('¥7.00', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    expect(ordersBySku(productA.variants[0]!.id)).toHaveLength(0)
    expect(ordersBySku(productB.variants[0]!.id)).toHaveLength(0)
  } finally {
    responseReady.open(); deliverResponse.open()
    await release?.()
    if (clicked && requestKey) {
      await expect.poll(() => postFinished).toBe(true)
    }
    try {
      await cleanupFixture(page, cleanup)
    } finally {
      await second.close()
    }
  }
})

test('a successful S1 response after checkout unmount cannot navigate away from a new S2 instance', async ({ page, context }) => {
  test.setTimeout(180_000)
  const cleanup: Cleanup = { productIds: [] }
  const second = await context.newPage()
  const apiCommittedS1 = gate()
  const releaseS1Response = gate()
  const s1ResponseDelivered = gate()
  const s1RouteFinished = gate()
  let releaseSubmission: (() => Promise<void>) | undefined
  let s1RouteStarted = false
  let clickedS1 = false
  const attempts: Array<{ key: string; skuId: string }> = []
  let s1FirstState: ReturnType<typeof orderState> | undefined
  try {
    const [productA, productB] = await prepareProducts(page, cleanup)
    const selections = { s1: newSelection(productA.variants[0]!.id), s2: newSelection(productB.variants[0]!.id) }
    await page.goto('/cart')
    await installSelections(page, [selections.s1, selections.s2])
    await page.getByRole('heading', { name: '购物车', exact: true }).waitFor({ state: 'visible' })
    await page.waitForFunction(() => Boolean((document.getElementById('__nuxt') as (HTMLElement & {
      __vue_app__?: { config?: { globalProperties?: Record<string, unknown> } }
    }) | null)?.__vue_app__?.config?.globalProperties?.$router))
    await routeTo(page, `/checkout?intent=${selections.s1.selectionId}`)
    await expect(page.getByRole('heading', { name: new RegExp(productA.name) })).toBeVisible()
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    const marker = randomUUID()
    await page.evaluate(value => { (window as Window & { r3DocumentMarker?: string }).r3DocumentMarker = value }, marker)
    await second.goto('/cart')
    releaseSubmission = await holdSubmissionLock(second)

    await page.route('**/api/v1/checkout/orders', async (route) => {
      const body = route.request().postDataJSON() as { idempotencyKey: string; items: Array<{ skuId: string }> }
      const skuId = body.items[0]!.skuId
      attempts.push({ key: body.idempotencyKey, skuId })
      const response = await route.fetch()
      expect([200, 201]).toContain(response.status())
      if (skuId === productA.variants[0]!.id) {
        s1RouteStarted = true
        try {
          expect(response.status()).toBe(201)
          apiCommittedS1.open()
          await releaseS1Response.promise
          await route.fulfill({ response })
          s1ResponseDelivered.open()
        } finally {
          s1RouteFinished.open()
        }
        return
      }
      await route.fulfill({ response })
    })

    clickedS1 = true
    await page.getByRole('button', { name: '提交订单' }).click()
    await waitForQueuedSubmission(page)

    await page.getByRole('link', { name: '返回购物车调整' }).click()
    await expect(page).toHaveURL(/\/cart$/u)
    await expect(page.getByRole('heading', { name: '购物车', exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as Window & { r3DocumentMarker?: string }).r3DocumentMarker)).toBe(marker)
    await routeTo(page, `/checkout?intent=${selections.s2.selectionId}`)
    await expect(page.getByRole('heading', { name: new RegExp(productB.name) })).toBeVisible()
    await expect(page.getByText('¥7.00', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    expect(await page.evaluate(() => (window as Window & { r3DocumentMarker?: string }).r3DocumentMarker)).toBe(marker)
    expect(await second.evaluate(async lockName => (await navigator.locks.query()).held?.some(lock =>
      lock.name === lockName && lock.mode === 'exclusive'), submissionLock)).toBe(true)

    const orderResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/checkout/orders')
      && response.request().method() === 'POST')
    await releaseSubmission()
    releaseSubmission = undefined
    await apiCommittedS1.promise
    const pendingS1 = (await readIntents(page)).find(intent => intent.state === 'pending')!
    expect(pendingS1).toMatchObject({ state: 'pending', selectionId: selections.s1.selectionId, items: [selections.s1.line] })
    expect(pendingS1.quoteToken).toBeTruthy()
    const apiCommittedOrder = ordersBySku(productA.variants[0]!.id)
    expect(apiCommittedOrder).toHaveLength(1)
    expect(apiCommittedOrder[0]!.idempotency_key).toBe(pendingS1.idempotencyKey)
    s1FirstState = orderState(pendingS1.idempotencyKey)
    expect(s1FirstState.orders).toHaveLength(1)
    expect(s1FirstState.reservations).toHaveLength(1)
    releaseS1Response.open()
    expect((await orderResponse).status()).toBe(201)
    await s1ResponseDelivered.promise
    await s1RouteFinished.promise
    await expect.poll(async () => (await readIntents(page)).find(intent => intent.idempotencyKey === pendingS1.idempotencyKey)?.state)
      .toBe('completed')
    const completedS1 = (await readIntents(page)).find(intent => intent.idempotencyKey === pendingS1.idempotencyKey)!
    expect(completedS1).toMatchObject({ selectionId: selections.s1.selectionId })
    expect(completedS1.orderId).toBeTruthy()
    const completedOrderId = completedS1.orderId!
    await expect.poll(() => page.evaluate(async (lockNames: string[]) => {
      const locks = await navigator.locks.query()
      return [...(locks.held ?? []), ...(locks.pending ?? [])]
        .filter(lock => typeof lock.name === 'string' && lockNames.includes(lock.name)).length
    }, [submissionLock, identityLock])).toBe(0)
    await page.evaluate(() => new Promise<void>(resolveFrames => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrames()))))
    await expect(page).toHaveURL(`/checkout?intent=${selections.s2.selectionId}`)
    await expect(page.getByRole('heading', { name: new RegExp(productB.name) })).toBeVisible()
    await expect(page.getByText('¥7.00', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect((await readIntents(page)).some(intent => intent.selectionId === selections.s2.selectionId)).toBe(false)
    expect(attempts).toEqual([{ key: pendingS1.idempotencyKey, skuId: productA.variants[0]!.id }])
    expect(ordersBySku(productA.variants[0]!.id)).toEqual([{ id: completedOrderId, idempotency_key: pendingS1.idempotencyKey }])
    expect(orderState(pendingS1.idempotencyKey)).toEqual(s1FirstState)
    expect(ordersBySku(productB.variants[0]!.id)).toHaveLength(0)

    await page.getByRole('button', { name: '提交订单' }).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/u)
    const orderB = ordersBySku(productB.variants[0]!.id)
    expect(orderB).toHaveLength(1)
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toMatchObject({ key: orderB[0]!.idempotency_key, skuId: productB.variants[0]!.id })
    expect(orderState(attempts[1]!.key).reservations).toHaveLength(1)
    expect(ordersBySku(productA.variants[0]!.id)).toEqual([{ id: completedOrderId, idempotency_key: pendingS1.idempotencyKey }])
    expect(orderState(pendingS1.idempotencyKey)).toEqual(s1FirstState)

    await routeTo(page, `/checkout?intent=${selections.s1.selectionId}`)
    await expect(page).toHaveURL(`/orders/${completedOrderId}`)
    expect(attempts).toHaveLength(2)
    expect(ordersBySku(productA.variants[0]!.id)).toHaveLength(1)
    expect(ordersBySku(productB.variants[0]!.id)).toHaveLength(1)
  } finally {
    releaseS1Response.open()
    await releaseSubmission?.()
    if (s1RouteStarted) await s1RouteFinished.promise
    try {
      await cleanupFixture(page, cleanup)
    } finally {
      await second.close()
      if (clickedS1) {
        await expect.poll(() => page.evaluate(async (lockNames: string[]) => {
          const locks = await navigator.locks.query()
          return [...(locks.held ?? []), ...(locks.pending ?? [])]
            .filter(lock => typeof lock.name === 'string' && lockNames.includes(lock.name)).length
        }, [submissionLock, identityLock])).toBe(0).catch(() => {})
      }
    }
  }
})

test('a successful legacy V1 response after checkout unmount leaves the active cart page in place', async ({ page, context }) => {
  test.setTimeout(120_000)
  const cleanup: Cleanup = { productIds: [] }
  const second = await context.newPage()
  const apiCommitted = gate()
  const releaseResponse = gate()
  const responseDelivered = gate()
  const routeFinished = gate()
  let releaseSubmission: (() => Promise<void>) | undefined
  let orderRouteStarted = false
  let clicked = false
  let submitted: { idempotencyKey: string; items: Array<{ skuId: string; quantity: number }>; quoteToken: string } | undefined
  try {
    const [product] = await prepareProducts(page, cleanup)
    const skuId = product.variants[0]!.id
    const items = [{ skuId, quantity: 1 }]
    await page.goto('/cart')
    await page.getByRole('heading', { name: '购物车', exact: true }).waitFor({ state: 'visible' })
    await page.waitForFunction(() => Boolean((document.getElementById('__nuxt') as (HTMLElement & {
      __vue_app__?: { config?: { globalProperties?: Record<string, unknown> } }
    }) | null)?.__vue_app__?.config?.globalProperties?.$router))
    await routeTo(page, `/checkout?items=${encodeURIComponent(JSON.stringify(items))}`)
    await expect(page.getByRole('heading', { name: new RegExp(product.name) })).toBeVisible()
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    const marker = randomUUID()
    await page.evaluate(value => { (window as Window & { r3V1DocumentMarker?: string }).r3V1DocumentMarker = value }, marker)
    await second.goto('/cart')
    releaseSubmission = await holdSubmissionLock(second)
    await page.route('**/api/v1/checkout/orders', async (route) => {
      const body = route.request().postDataJSON() as typeof submitted
      expect(body).toBeTruthy()
      submitted = body!
      expect(Object.keys(body!).sort()).toEqual(['idempotencyKey', 'items', 'quoteToken'])
      expect(body!.items).toEqual(items)
      const response = await route.fetch()
      expect(response.status()).toBe(201)
      orderRouteStarted = true
      try {
        apiCommitted.open()
        await releaseResponse.promise
        await route.fulfill({ response })
        responseDelivered.open()
      } finally {
        routeFinished.open()
      }
    })

    clicked = true
    await page.getByRole('button', { name: '提交订单' }).click()
    await waitForQueuedSubmission(page)
    await page.getByRole('link', { name: '返回购物车调整' }).click()
    await expect(page).toHaveURL(/\/cart$/u)
    await expect(page.getByRole('heading', { name: '购物车', exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as Window & { r3V1DocumentMarker?: string }).r3V1DocumentMarker)).toBe(marker)

    const orderResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/checkout/orders')
      && response.request().method() === 'POST')
    await releaseSubmission()
    releaseSubmission = undefined
    await apiCommitted.promise
    expect(submitted).toBeTruthy()
    const rows = ordersBySku(skuId)
    expect(rows).toEqual([{ id: expect.any(String), idempotency_key: submitted!.idempotencyKey }])
    const state = orderState(submitted!.idempotencyKey)
    expect(state.orders).toHaveLength(1)
    expect(state.reservations).toHaveLength(1)
    releaseResponse.open()
    expect((await orderResponse).status()).toBe(201)
    await responseDelivered.promise
    await routeFinished.promise
    await expect.poll(() => page.evaluate(async (lockNames: string[]) => {
      const locks = await navigator.locks.query()
      return [...(locks.held ?? []), ...(locks.pending ?? [])]
        .filter(lock => typeof lock.name === 'string' && lockNames.includes(lock.name)).length
    }, [submissionLock, identityLock])).toBe(0)
    await page.evaluate(() => new Promise<void>(resolveFrames => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrames()))))
    await expect(page).toHaveURL(/\/cart$/u)
    await expect(page.getByRole('heading', { name: '购物车', exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as Window & { r3V1DocumentMarker?: string }).r3V1DocumentMarker)).toBe(marker)
    expect(ordersBySku(skuId)).toEqual([{ id: rows[0]!.id, idempotency_key: submitted!.idempotencyKey }])
    expect(orderState(submitted!.idempotencyKey)).toEqual(state)
  } finally {
    releaseResponse.open()
    await releaseSubmission?.()
    if (orderRouteStarted) await routeFinished.promise
    try {
      await cleanupFixture(page, cleanup)
    } finally {
      await second.close()
      if (clicked) {
        await expect.poll(() => page.evaluate(async (lockNames: string[]) => {
          const locks = await navigator.locks.query()
          return [...(locks.held ?? []), ...(locks.pending ?? [])]
            .filter(lock => typeof lock.name === 'string' && lockNames.includes(lock.name)).length
        }, [submissionLock, identityLock])).toBe(0).catch(() => {})
      }
    }
  }
})
