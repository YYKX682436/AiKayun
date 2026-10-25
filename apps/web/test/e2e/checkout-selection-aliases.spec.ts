import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'

type Product = { id: string; revision: number; variants: Array<{ id: string }> }
type Line = { lineId: string; skuId: string; quantity: number }
type Intent = {
  state: 'pending' | 'rejected' | 'completed'
  selectionId: string | null
  selectionAliases?: string[]
  idempotencyKey: string
  orderId?: string
}
type Policy = {
  requireEmail: boolean; requirePhone: boolean; guestCheckoutEnabled: boolean
  guestFreeClaimEnabled: boolean; unpaidOrderTimeoutMinutes: 5 | 15 | 30
}
type FixtureCleanup = { productId?: string; policy?: Policy }
const intentStorageKey = 'aikayun-order-intents-v2'
let quoteIpSequence = 180

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

async function prepareProduct(page: Page, cleanup: FixtureCleanup): Promise<{ product: Product; policy: Policy }> {
  const token = createBrowserAdminSession()
  await page.context().addCookies([{
    name: 'aikayun_admin_session', value: token,
    url: new URL('/', process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin,
    httpOnly: true, sameSite: 'Lax',
  }])
  await page.goto('/admin/login')
  const current = await page.request.get('/api/v1/admin/storefront/customer-policy')
  expect(current.status()).toBe(200)
  const data = (await current.json()).data as Policy
  const policy: Policy = {
    requireEmail: data.requireEmail, requirePhone: data.requirePhone,
    guestCheckoutEnabled: data.guestCheckoutEnabled, guestFreeClaimEnabled: data.guestFreeClaimEnabled,
    unpaidOrderTimeoutMinutes: data.unpaidOrderTimeoutMinutes,
  }
  cleanup.policy = policy
  const enabled = await page.request.put('/api/v1/admin/storefront/customer-policy', {
    headers: await adminHeaders(page), data: { ...policy, guestCheckoutEnabled: true },
  })
  expect(enabled.status()).toBe(200)
  const created = await page.request.post('/api/v1/admin/products', {
    headers: await adminHeaders(page),
    data: { name: `R1结算链接-${randomUUID().slice(0, 8)}`, productType: 'digital', defaultSku: { salePrice: '4.00' } },
  })
  expect(created.status()).toBe(201)
  let product = (await created.json()).data as Product
  cleanup.productId = product.id
  const active = await page.request.patch(`/api/v1/admin/products/${product.id}/lifecycle`, {
    headers: await adminHeaders(page), data: { expectedRevision: product.revision, status: 'active' },
  })
  expect(active.status()).toBe(200)
  product = (await active.json()).data as Product
  const inventoryResponse = await page.request.get(`/api/v1/admin/products/${product.id}/inventory`)
  expect(inventoryResponse.status()).toBe(200)
  const inventory = (await inventoryResponse.json()).data as {
    productRevision: number; variants: Array<{ skuId: string; skuRevision: number; inventoryRevision: number }>
  }
  const sku = inventory.variants.find(item => item.skuId === product.variants[0]!.id)!
  const inventoryMode = await page.request.put(`/api/v1/admin/products/${product.id}/variants/${sku.skuId}/inventory-mode`, {
    headers: await adminHeaders(page), data: {
      expectedRevision: inventory.productRevision, expectedSkuRevision: sku.skuRevision,
      expectedInventoryRevision: sku.inventoryRevision, inventoryMode: 'unlimited',
    },
  })
  expect(inventoryMode.status()).toBe(200)
  const fulfillment = await page.request.put(`/api/v1/admin/products/${product.id}/variants/${sku.skuId}/manual-fulfillment`, {
    headers: await adminHeaders(page), data: { enabled: true },
  })
  expect(fulfillment.status()).toBe(200)
  return { product, policy }
}

async function changePrice(page: Page, product: Product): Promise<void> {
  const path = `/api/v1/admin/products/${product.id}/variants/${product.variants[0]!.id}/prices`
  const current = await page.request.get(path)
  expect(current.status()).toBe(200)
  const price = (await current.json()).data as { productRevision: number; skuRevision: number }
  const updated = await page.request.patch(path, {
    headers: await adminHeaders(page),
    data: { expectedRevision: price.productRevision, expectedSkuRevision: price.skuRevision, salePrice: '5.00' },
  })
  expect(updated.status()).toBe(200)
}

async function storeSelection(page: Page, selectionId: string, line: Line): Promise<void> {
  await page.goto('/cart')
  await page.evaluate(({ selectionId, line }) => {
    sessionStorage.setItem('aikayun-checkout-selections-v2', JSON.stringify([{
      id: selectionId, fingerprint: JSON.stringify([line]), items: [line],
    }]))
  }, { selectionId, line })
}

async function intents(page: Page): Promise<Intent[]> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]') as Intent[], intentStorageKey)
}

function selectionIds(intent: Intent): string[] {
  return [intent.selectionId, ...(intent.selectionAliases ?? [])].filter((id): id is string => id !== null).sort()
}

function orderCount(skuId: string): number {
  const output = execFileSync('pnpm', ['--filter', '@aikayun/api', 'exec', 'node', 'test/fixtures/checkout-alias-r1-state.mjs', skuId], {
    cwd: resolve(import.meta.dirname, '../../../..'), env: process.env, encoding: 'utf8',
  })
  return (JSON.parse(output) as unknown[]).length
}

for (const confirmationLink of ['primary', 'alias', 'rejoined-pending', 'capacity'] as const) {
  test(`re-quoting from the ${confirmationLink} link retains every selection URL through a real price conflict`, async ({ page, context }) => {
    test.setTimeout(150_000)
    const ip = `203.0.113.${quoteIpSequence++}`
    await context.setExtraHTTPHeaders({ 'x-forwarded-for': ip })
    let secondPage: Page | undefined
    let thirdPage: Page | undefined
    const cleanup: FixtureCleanup = {}
    const attempts: string[] = []
    const results: Array<{ key: string; status: number; orderId?: string }> = []
    let allowBackend = false
    try {
      const prepared = await prepareProduct(page, cleanup)
      const line: Line = { lineId: randomUUID(), skuId: prepared.product.variants[0]!.id, quantity: 1 }
      const beforeCount = orderCount(line.skuId)
      const primaryId = randomUUID()
      const aliasId = randomUUID()
      secondPage = await context.newPage()
      await storeSelection(page, primaryId, line)
      await storeSelection(secondPage, aliasId, line)
      await Promise.all([
        page.goto(`/checkout?intent=${primaryId}`),
        secondPage.goto(`/checkout?intent=${aliasId}`),
      ])
      await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
      await expect(secondPage.getByRole('button', { name: '提交订单' })).toBeEnabled()
      await context.route('**/api/v1/checkout/orders', async (route) => {
        if (route.request().method() !== 'POST') return route.continue()
        const key = (route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey
        attempts.push(key)
        // Preserve a real browser pending request while no request reaches the
        // backend. The second tab then attaches its pre-existing opaque URL.
        if (!allowBackend) return route.abort('failed')
        const response = await route.fetch()
        const body = await response.json() as { data?: { order?: { id: string } } }
        results.push({ key, status: response.status(), ...(body.data?.order ? { orderId: body.data.order.id } : {}) })
        await route.fulfill({ response })
      })
      await page.getByRole('button', { name: '提交订单' }).click()
      await expect.poll(async () => (await intents(page)).length).toBe(1)
      await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
      // Remount the second tab so alias registration does not depend on
      // whether its first storage event arrived before its watcher was ready.
      await secondPage.reload()
      await expect.poll(async () => {
        const saved = await intents(page)
        return saved.length === 1 ? selectionIds(saved[0]!) : []
      }).toEqual([primaryId, aliasId].sort())
      await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
      await expect(secondPage.getByRole('button', { name: '提交订单' })).toBeEnabled()
      const originalPending = (await intents(page))[0]!
      expect(originalPending.state).toBe('pending')
      expect(new Set(attempts)).toEqual(new Set([originalPending.idempotencyKey]))
      expect(orderCount(line.skuId)).toBe(beforeCount)

      const confirmer = confirmationLink === 'alias' ? secondPage : page
      const other = confirmationLink === 'alias' ? page : secondPage
      const otherId = confirmationLink === 'alias' ? primaryId : aliasId
      const expectedSelectionIds = [primaryId, aliasId]
      let rejoinedKey: string | null = null
      // A user can leave the second checkout tab on another page. It must
      // still recover its original operation after returning to the old URL.
      await other.goto('/cart')
      await changePrice(page, prepared.product)
      allowBackend = true
      const rejected = confirmer.waitForResponse(response => response.url().endsWith('/api/v1/checkout/orders')
        && response.request().method() === 'POST' && response.status() === 409)
      await confirmer.getByRole('button', { name: '提交订单' }).click()
      await rejected
      await expect(confirmer.getByRole('alert').filter({ hasText: '已显示最新报价' })).toBeVisible()
      const rejectedIntent = (await intents(confirmer))[0]!
      expect(rejectedIntent.state).toBe('rejected')
      expect(selectionIds(rejectedIntent)).toEqual([primaryId, aliasId].sort())
      expect(results).toEqual([{ key: originalPending.idempotencyKey, status: 409 }])

      if (confirmationLink === 'rejoined-pending' || confirmationLink === 'capacity') {
        // A new tab can stage a request for the same content while the old
        // operation is known rejected. Rejoining must move the whole old URL
        // set to the durable pending request, without replacing its key.
        const thirdId = randomUUID()
        expectedSelectionIds.push(thirdId)
        thirdPage = await context.newPage()
        await storeSelection(thirdPage, thirdId, line)
        await thirdPage.goto(`/checkout?intent=${thirdId}`)
        await expect(thirdPage.getByRole('button', { name: '提交订单' })).toBeEnabled()
        allowBackend = false
        await thirdPage.getByRole('button', { name: '提交订单' }).click()
        await expect.poll(async () => (await intents(page)).filter(intent => intent.state === 'pending').length).toBe(1)
        await expect(thirdPage.getByRole('button', { name: '提交订单' })).toBeEnabled()
        const separatelyPending = (await intents(page)).find(intent => intent.state === 'pending')!
        expect(separatelyPending.selectionId).toBe(thirdId)
        rejoinedKey = separatelyPending.idempotencyKey
        await thirdPage.goto('/cart')
        allowBackend = true
      }
      if (confirmationLink === 'capacity') {
        await confirmer.evaluate((key) => {
          const saved = JSON.parse(localStorage.getItem(key) ?? '[]') as Intent[]
          const rejected = saved.find(intent => intent.state === 'rejected')!
          rejected.selectionAliases = [...(rejected.selectionAliases ?? []), ...Array.from({ length: 99 }, () => crypto.randomUUID())]
          localStorage.setItem(key, JSON.stringify(saved))
        }, intentStorageKey)
        const beforeRetry = await confirmer.evaluate(key => localStorage.getItem(key), intentStorageKey)
        const keysBeforeRetry = (await intents(confirmer)).map(intent => intent.idempotencyKey)
        await expect(confirmer.getByRole('button', { name: '提交订单' })).toBeEnabled()
        await confirmer.getByRole('button', { name: '提交订单' }).click()
        await expect(confirmer.getByRole('alert').filter({ hasText: '原订单请求关联过多结算链接' })).toBeVisible()
        expect(await confirmer.evaluate(key => localStorage.getItem(key), intentStorageKey)).toBe(beforeRetry)
        expect((await intents(confirmer)).map(intent => intent.idempotencyKey)).toEqual(keysBeforeRetry)
        expect(results).toEqual([{ key: originalPending.idempotencyKey, status: 409 }])
        expect(orderCount(line.skuId)).toBe(beforeCount)
        return
      }
      await expect(confirmer.getByRole('button', { name: '提交订单' })).toBeEnabled()
      await confirmer.getByRole('button', { name: '提交订单' }).click()
      await expect(confirmer).toHaveURL(/\/orders\/[0-9a-f-]{36}$/u)
      const firstOrderPath = new URL(confirmer.url()).pathname
      const completedBeforeReturn = await intents(confirmer)

      await other.goto(`/checkout?intent=${otherId}`)
      await expect.poll(() => other.evaluate(() => location.pathname.startsWith('/orders/')
        || Array.from(document.querySelectorAll('button')).some(button => button.textContent?.trim() === '提交订单'
          && !button.disabled)).catch(() => false)).toBe(true)
      // On the faulty baseline the lost alias exposes a fresh submit button;
      // exercising it proves the actual second-order consequence.
      if (!new URL(other.url()).pathname.startsWith('/orders/')) {
        await other.getByRole('button', { name: '提交订单' }).click()
        await expect(other).toHaveURL(/\/orders\/[0-9a-f-]{36}$/u)
      }
      const committed = results.filter(result => result.orderId)
      expect(committed, JSON.stringify({ confirmationLink, completedBeforeReturn, results }))
        .toHaveLength(1)
      if (rejoinedKey) expect(committed[0]!.key).toBe(rejoinedKey)
      expect(new URL(other.url()).pathname).toBe(firstOrderPath)
      expect(await intents(other)).toHaveLength(1)
      expect(selectionIds((await intents(other))[0]!)).toEqual(expectedSelectionIds.sort())
      expect(new Set(results.filter(result => result.orderId).map(result => result.key)).size).toBe(1)
      expect(orderCount(line.skuId)).toBe(beforeCount + 1)

      // An explicit new selection from the cart remains a normal repurchase.
      await other.goto('/cart')
      await other.evaluate(line => localStorage.setItem('aikayun-guest-cart-v2', JSON.stringify({
        version: 3, unclaimedItems: [line], pendingBatches: [],
      })), line)
      await other.reload()
      await other.getByRole('link', { name: '查看结算报价' }).click()
      const nextId = new URL(other.url()).searchParams.get('intent')
      expect(nextId).not.toBe(primaryId)
      expect(nextId).not.toBe(aliasId)
      await expect(other.getByRole('button', { name: '提交订单' })).toBeEnabled()
      await other.getByRole('button', { name: '提交订单' }).click()
      await expect(other).toHaveURL(/\/orders\/[0-9a-f-]{36}$/u)
      expect(new URL(other.url()).pathname).not.toBe(firstOrderPath)
      expect(new Set(results.filter(result => result.orderId).map(result => result.key)).size).toBe(2)
      expect(orderCount(line.skuId)).toBe(beforeCount + 2)
    } finally {
      try {
        try {
          if (cleanup.productId) await pauseProduct(page, cleanup.productId)
        } finally {
          if (cleanup.policy) {
            const restored = await page.request.put('/api/v1/admin/storefront/customer-policy', {
              headers: await adminHeaders(page), data: cleanup.policy,
            })
            expect(restored.status()).toBe(200)
          }
        }
      } finally {
        await Promise.all([secondPage?.close(), thirdPage?.close()])
      }
    }
  })
}
