import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { hashPassword } from '../src/auth/password.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { createDatabase } from '../src/db/pool.js'
import type { Database, ProductInventoryMode, ProductStatus } from '../src/db/types.js'
import { expireDueUnpaidOrders } from '../src/commerce/orders.js'
import { startUnpaidOrderExpiryWorker } from '../src/commerce/unpaid-order-expiry.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const testOrigin = 'http://localhost:3000'
const password = 'Order-Integration-Password-2026!'
const digest = 'a'.repeat(64)

let app: FastifyInstance
let db: Kysely<Database>
let nextIp = 1

type Customer = { id: string; cookie: string; csrfToken: string; csrfCookie: string }
type Admin = { id: string; cookie: string; csrfToken: string; csrfCookie: string }
type Catalog = { productId: string; skuId: string; name: string; price: string; mode: ProductInventoryMode }

function remoteAddress(): string {
  const value = (nextIp++ % 250) + 1
  return `198.51.100.${value}`
}

function inject(options: InjectOptions) {
  return app.inject({ ...options, remoteAddress: remoteAddress() })
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const header = response.headers['set-cookie']
  const cookies = Array.isArray(header) ? header : header ? [header] : []
  const cookie = cookies.find(value => value.startsWith(`${name}=`))
  if (!cookie) throw new Error(`Expected ${name} cookie`)
  return cookie.split(';', 1)[0] ?? ''
}

async function customerCsrf() {
  const response = await inject({ method: 'GET', url: '/api/v1/customer/auth/csrf' })
  expect(response.statusCode).toBe(200)
  return {
    token: response.json().data.csrfToken as string,
    cookie: cookieFrom(response, 'aikayun_customer_csrf'),
  }
}

async function createCustomer(): Promise<Customer> {
  const csrf = await customerCsrf()
  const response = await inject({
    method: 'POST', url: '/api/v1/customer/auth/register',
    headers: { origin: testOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.token },
    payload: { username: `order-${randomUUID().replaceAll('-', '').slice(0, 20)}`, password },
  })
  expect(response.statusCode).toBe(201)
  return {
    id: response.json().data.customer.id as string,
    cookie: cookieFrom(response, 'aikayun_customer_session'),
    csrfToken: csrf.token,
    csrfCookie: csrf.cookie,
  }
}

function customerHeaders(customer: Customer, origin = testOrigin, includeCsrf = true): Record<string, string> {
  return {
    origin,
    cookie: [customer.cookie, customer.csrfCookie].filter(Boolean).join('; '),
    ...(includeCsrf ? { 'x-csrf-token': customer.csrfToken } : {}),
  }
}

async function createAdmin(): Promise<Admin> {
  const id = randomUUID()
  const email = `orders-${id.slice(0, 8)}@example.test`
  await db.insertInto('admin_users').values({ id, email, password_hash: await hashPassword(password) }).execute()
  const csrf = await inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
  const csrfToken = csrf.json().data.csrfToken as string
  const csrfCookie = cookieFrom(csrf, 'aikayun_admin_csrf')
  const login = await inject({
    method: 'POST', url: '/api/v1/admin/auth/login',
    headers: { origin: testOrigin, cookie: csrfCookie, 'x-csrf-token': csrfToken },
    payload: { email, password },
  })
  expect(login.statusCode).toBe(200)
  return { id, csrfToken, csrfCookie, cookie: cookieFrom(login, 'aikayun_admin_session') }
}

function adminHeaders(admin: Admin, origin = testOrigin, includeCsrf = true): Record<string, string> {
  return {
    origin,
    cookie: `${admin.cookie}; ${admin.csrfCookie}`,
    ...(includeCsrf ? { 'x-csrf-token': admin.csrfToken } : {}),
  }
}

async function createCatalog(options: {
  name?: string
  price?: string
  mode?: ProductInventoryMode
  stock?: number
  status?: ProductStatus
  skuId?: string
} = {}): Promise<Catalog> {
  const productId = randomUUID()
  const skuId = options.skuId ?? randomUUID()
  const name = options.name ?? `订单测试商品-${productId.slice(0, 8)}`
  const price = options.price ?? '1.20'
  const mode = options.mode ?? 'quantity'
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('products').values({
      id: productId, name, description: '', product_type: 'digital', status: options.status ?? 'active',
    }).execute()
    await trx.insertInto('product_variants').values({
      id: skuId,
      product_id: productId,
      sku_code: `ORD-${skuId.slice(0, 8)}`,
      combination_key: '',
      sale_price: price,
      enabled: true,
      retired_at: null,
      inventory_mode: mode,
    }).execute()
    if (mode === 'quantity') {
      await trx.insertInto('product_variant_quantity_inventory').values({
        product_id: productId,
        product_variant_id: skuId,
        stocked: options.stock ?? 5,
        reserved: 0,
      }).execute()
    }
    await trx.insertInto('product_variant_fulfillment').values({
      product_variant_id: skuId,
      method: 'manual',
      manual_delivery_ready: false,
    }).execute()
  })
  return { productId, skuId, name, price, mode }
}

async function enableManual(catalog: Catalog, admin: Admin): Promise<void> {
  const response = await inject({
    method: 'PUT',
    url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/manual-fulfillment`,
    headers: adminHeaders(admin),
    payload: { enabled: true },
  })
  expect(response.statusCode).toBe(200)
  expect(response.json().data).toMatchObject({ skuId: catalog.skuId, productType: 'digital', enabled: true })
}

async function quote(items: Array<{ skuId: string; quantity: number }>, customer?: Customer, guestCookie?: string) {
  const csrf = customer ? { token: customer.csrfToken, cookie: customer.csrfCookie } : await customerCsrf()
  return inject({
    method: 'POST', url: '/api/v1/checkout/quote',
    headers: {
      origin: testOrigin,
      cookie: [customer?.cookie, guestCookie, csrf.cookie].filter(Boolean).join('; '),
      'x-csrf-token': csrf.token,
    },
    payload: { items },
  })
}

async function newGuestSession() {
  const csrf = await customerCsrf()
  const response = await inject({
    method: 'POST', url: '/api/v1/guest/session',
    headers: { origin: testOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.token },
  })
  expect([200, 201]).toContain(response.statusCode)
  const cookie = cookieFrom(response, 'aikayun_guest_order_session')
  const setCookie = response.headers['set-cookie']
  expect(String(setCookie)).toContain('HttpOnly')
  expect(response.json().data).not.toHaveProperty('token')
  return { cookie, csrfToken: csrf.token, csrfCookie: csrf.cookie }
}

async function createOrder(
  items: Array<{ skuId: string; quantity: number }>,
  quoteToken: string,
  owner: Customer | { cookie: string; csrfToken: string; csrfCookie: string },
  idempotencyKey = randomUUID(),
  extra: Record<string, unknown> = {},
) {
  return inject({
    method: 'POST', url: '/api/v1/checkout/orders',
    headers: {
      origin: testOrigin,
      cookie: [owner.cookie, owner.csrfCookie].filter(Boolean).join('; '),
      'x-csrf-token': owner.csrfToken,
    },
    payload: { idempotencyKey, quoteToken, items, ...extra },
  })
}

beforeAll(async () => {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL must point to a dedicated PostgreSQL database ending in _test')
  const databaseUrl = new URL(testDatabaseUrl)
  if (!databaseUrl.pathname.slice(1).endsWith('_test')) {
    throw new Error('Refusing to run order integration tests unless TEST_DATABASE_URL names a database ending in _test')
  }
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`DROP SCHEMA public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const migrated = await migrator.migrateToLatest()
  if (migrated.error) throw migrated.error
  const repeated = await migrator.migrateToLatest()
  if (repeated.error) throw repeated.error
  const config = readConfig({
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: testOrigin,
    COOKIE_SECURE: 'false',
  })
  app = await createApp({ db, config, logger: false })
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
  if (db) await db.destroy()
})

describe('real order creation and lifecycle on PostgreSQL', () => {
  it('creates multi-SKU customer orders from locked snapshots, reserves quantity stock, and makes idempotency owner-scoped', async () => {
    const admin = await createAdmin()
    const owner = await createCustomer()
    const other = await createCustomer()
    const quantitySku = await createCatalog({ price: '4.50', mode: 'quantity', stock: 5 })
    const unlimitedSku = await createCatalog({ price: '2.50', mode: 'unlimited' })
    await enableManual(quantitySku, admin)
    await enableManual(unlimitedSku, admin)

    const items = [{ skuId: quantitySku.skuId, quantity: 2 }, { skuId: unlimitedSku.skuId, quantity: 1 }]
    const current = await quote(items, owner)
    expect(current.statusCode).toBe(200)
    expect(current.json().data.canContinue).toBe(true)
    expect(current.json().data.totalAmount).toBe('11.50')

    const idempotencyKey = randomUUID()
    const created = await createOrder(items, current.json().data.quoteToken, owner, idempotencyKey)
    expect(created.statusCode).toBe(201)
    const orderId = created.json().data.order.id as string
    expect(created.json().data).toMatchObject({
      created: true,
      order: {
        id: orderId,
        status: 'pending_payment',
        paymentStatus: 'unpaid',
        totalAmount: '11.50',
        itemsSealed: true,
      },
    })
    expect(created.json().data.order.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: quantitySku.productId, skuId: quantitySku.skuId, productName: quantitySku.name, unitPrice: '4.50', quantity: 2, lineAmount: '9.00' }),
      expect.objectContaining({ productId: unlimitedSku.productId, skuId: unlimitedSku.skuId, productName: unlimitedSku.name, unitPrice: '2.50', quantity: 1, lineAmount: '2.50', inventoryMode: 'unlimited' }),
    ]))
    expect((await db.selectFrom('orders').select('customer_id').where('id', '=', orderId).executeTakeFirstOrThrow()).customer_id).toBe(owner.id)

    const stock = await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', quantitySku.skuId).executeTakeFirstOrThrow()
    expect(stock).toEqual({ stocked: 5, reserved: 2 })
    expect((await db.selectFrom('product_variants').select('inventory_revision').where('id', '=', quantitySku.skuId).executeTakeFirstOrThrow()).inventory_revision).toBe(1)
    expect(await db.selectFrom('order_inventory_reservations').select('id').where('product_variant_id', '=', quantitySku.skuId).execute()).toHaveLength(1)
    expect(await db.selectFrom('order_inventory_reservations').select('id').where('product_variant_id', '=', unlimitedSku.skuId).execute()).toHaveLength(0)

    const replay = await createOrder(items, '0'.repeat(64), owner, idempotencyKey)
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data).toMatchObject({ created: false, order: { id: orderId } })
    const conflictingReplay = await createOrder([{ skuId: quantitySku.skuId, quantity: 1 }], current.json().data.quoteToken, owner, idempotencyKey)
    expect(conflictingReplay.statusCode).toBe(409)
    expect(conflictingReplay.json().error.code).toBe('ORDER_IDEMPOTENCY_CONFLICT')

    const spoofed = await createOrder(items, current.json().data.quoteToken, owner, randomUUID(), { totalAmount: '0.01', customerId: other.id })
    expect(spoofed.statusCode).toBe(400)

    expect((await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: other.cookie } })).statusCode).toBe(404)
    const foreignCancel = await inject({ method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(other) })
    expect(foreignCancel.statusCode).toBe(404)
    const wrongOrigin = await inject({ method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(owner, 'https://attacker.example') })
    expect(wrongOrigin.statusCode).toBe(403)
    const missingCsrf = await inject({
      method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`,
      headers: { origin: testOrigin, cookie: owner.cookie },
    })
    expect(missingCsrf.statusCode).toBe(403)

    const cancelled = await inject({ method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(owner) })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().data.status).toBe('closed')
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved').where('product_variant_id', '=', quantitySku.skuId).executeTakeFirstOrThrow()).reserved).toBe(0)
    expect(await db.selectFrom('order_inventory_events as event')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
      .where('reservation.product_variant_id', '=', quantitySku.skuId).select('event.action').execute()).toEqual([
      { action: 'reserve' }, { action: 'release' },
    ])
    const repeatedCancel = await inject({ method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(owner) })
    expect(repeatedCancel.statusCode).toBe(200)
    expect(repeatedCancel.json().data.statusEvents).toHaveLength(1)
    expect(await db.selectFrom('order_inventory_events as event')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
      .where('reservation.product_variant_id', '=', quantitySku.skuId).select('event.action').execute()).toHaveLength(2)
  })

  it('returns fresh quotes when price, product state, SKU state, or available stock changes', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const priceSku = await createCatalog({ price: '0.25', mode: 'unlimited' })
    const productSku = await createCatalog({ price: '0.30', mode: 'unlimited' })
    const retiredSku = await createCatalog({ price: '0.35', mode: 'unlimited' })
    const stockSku = await createCatalog({ price: '0.40', mode: 'quantity', stock: 4 })
    for (const catalog of [priceSku, productSku, retiredSku, stockSku]) await enableManual(catalog, admin)

    const staleKeys = [randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const
    const priceQuote = await quote([{ skuId: priceSku.skuId, quantity: 1 }], customer)
    await db.updateTable('product_variants').set({ sale_price: '0.50' }).where('id', '=', priceSku.skuId).execute()
    const changedPrice = await createOrder([{ skuId: priceSku.skuId, quantity: 1 }], priceQuote.json().data.quoteToken, customer, staleKeys[0])
    expect(changedPrice.statusCode).toBe(409)
    expect(changedPrice.json().error).toMatchObject({ code: 'CHECKOUT_QUOTE_CHANGED', currentQuote: { items: [{ unitPrice: '0.50' }] } })

    const productQuote = await quote([{ skuId: productSku.skuId, quantity: 1 }], customer)
    await db.updateTable('products').set({ status: 'paused' }).where('id', '=', productSku.productId).execute()
    const changedProduct = await createOrder([{ skuId: productSku.skuId, quantity: 1 }], productQuote.json().data.quoteToken, customer, staleKeys[1])
    expect(changedProduct.statusCode).toBe(409)
    expect(changedProduct.json().error.currentQuote.items[0]).toMatchObject({ productStatus: 'paused', reason: 'product_not_active' })

    const skuQuote = await quote([{ skuId: retiredSku.skuId, quantity: 1 }], customer)
    await db.updateTable('product_variants').set({ enabled: false, retired_at: new Date() }).where('id', '=', retiredSku.skuId).execute()
    const changedSku = await createOrder([{ skuId: retiredSku.skuId, quantity: 1 }], skuQuote.json().data.quoteToken, customer, staleKeys[2])
    expect(changedSku.statusCode).toBe(409)
    expect(changedSku.json().error.currentQuote.items[0]).toMatchObject({ reason: 'sku_retired' })

    const stockQuote = await quote([{ skuId: stockSku.skuId, quantity: 1 }], customer)
    await db.updateTable('product_variant_quantity_inventory').set({ stocked: 3 }).where('product_variant_id', '=', stockSku.skuId).execute()
    const changedStock = await createOrder([{ skuId: stockSku.skuId, quantity: 1 }], stockQuote.json().data.quoteToken, customer, staleKeys[3])
    expect(changedStock.statusCode).toBe(409)
    expect(changedStock.json().error.currentQuote.items[0]).toMatchObject({ availableQuantity: 3, canPurchase: true })
    expect(await db.selectFrom('orders').select('id').where('idempotency_key', 'in', staleKeys).execute()).toHaveLength(0)
  })

  it('enforces guest policy, isolates secure guest sessions, completes zero-value manual delivery once, and protects content', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    await db.updateTable('storefront_customer_policy').set({ guest_checkout_enabled: true, guest_free_claim_enabled: false }).execute()
    const freeSku = await createCatalog({ price: '0.00', mode: 'quantity', stock: 2 })
    const paidSku = await createCatalog({ price: '3.25', mode: 'unlimited' })
    await enableManual(freeSku, admin)
    await enableManual(paidSku, admin)

    const deniedFree = await quote([{ skuId: freeSku.skuId, quantity: 1 }])
    expect(deniedFree.json().data.items[0].reason).toBe('guest_free_claim_disabled')
    expect(deniedFree.json().data.canContinue).toBe(false)
    const allowedPaid = await quote([{ skuId: paidSku.skuId, quantity: 1 }])
    expect(allowedPaid.json().data.canContinue).toBe(true)
    await db.updateTable('storefront_customer_policy').set({ guest_free_claim_enabled: true }).execute()
    const guest = await newGuestSession()
    const secondGuest = await newGuestSession()
    const csrfForGuest = { cookie: guest.cookie, csrfCookie: guest.csrfCookie, csrfToken: guest.csrfToken }

    const paidQuote = await quote([{ skuId: paidSku.skuId, quantity: 1 }], undefined, guest.cookie)
    const pending = await createOrder([{ skuId: paidSku.skuId, quantity: 1 }], paidQuote.json().data.quoteToken, csrfForGuest)
    expect(pending.statusCode).toBe(201)
    expect(pending.json().data.order).toMatchObject({ status: 'pending_payment', paymentStatus: 'unpaid' })
    const paidOrderId = pending.json().data.order.id as string
    const paidItemId = pending.json().data.order.items[0].id as string
    const noFakeDelivery = await inject({
      method: 'POST', url: `/api/v1/admin/orders/${paidOrderId}/items/${paidItemId}/fulfillments`,
      headers: adminHeaders(admin), payload: { operationId: randomUUID(), deliveries: [{ content: 'must-not-deliver' }] },
    })
    expect(noFakeDelivery.statusCode).toBe(409)
    expect(await db.selectFrom('order_item_fulfillment_attempts').select('id').where('order_item_id', '=', paidItemId).execute()).toHaveLength(0)
    expect((await inject({ method: 'GET', url: `/api/v1/guest/orders/${paidOrderId}`, headers: { cookie: secondGuest.cookie } })).statusCode).toBe(404)
    const guestCancel = await inject({
      method: 'POST', url: `/api/v1/guest/orders/${paidOrderId}/cancel`,
      headers: { origin: testOrigin, cookie: `${guest.cookie}; ${guest.csrfCookie}`, 'x-csrf-token': guest.csrfToken },
    })
    expect(guestCancel.statusCode).toBe(200)
    expect(guestCancel.json().data.status).toBe('closed')

    const freeQuote = await quote([{ skuId: freeSku.skuId, quantity: 1 }], undefined, guest.cookie)
    expect(freeQuote.json().data.canContinue).toBe(true)
    const freeOrder = await createOrder([{ skuId: freeSku.skuId, quantity: 1 }], freeQuote.json().data.quoteToken, csrfForGuest)
    expect(freeOrder.statusCode).toBe(201)
    expect(freeOrder.json().data.order).toMatchObject({ status: 'processing', paymentStatus: 'not_required', totalAmount: '0.00' })
    const freeOrderId = freeOrder.json().data.order.id as string
    const itemId = freeOrder.json().data.order.items[0].id as string
    expect(await db.selectFrom('payment_attempts').select('id').where('order_id', '=', freeOrderId).execute()).toHaveLength(0)
    expect((await inject({ method: 'GET', url: `/api/v1/guest/orders/${freeOrderId}`, headers: { cookie: customer.cookie } })).statusCode).toBe(403)

    const operationId = randomUUID()
    const deliveryBody = { operationId, deliveries: [{ content: 'ORDER-PRIVATE-DIGITAL-CONTENT-8472' }] }
    const wrongOrigin = await inject({
      method: 'POST', url: `/api/v1/admin/orders/${freeOrderId}/items/${itemId}/fulfillments`,
      headers: adminHeaders(admin, 'https://attacker.example'), payload: deliveryBody,
    })
    expect(wrongOrigin.statusCode).toBe(403)
    const missingCsrf = await inject({
      method: 'POST', url: `/api/v1/admin/orders/${freeOrderId}/items/${itemId}/fulfillments`,
      headers: adminHeaders(admin, testOrigin, false), payload: deliveryBody,
    })
    expect(missingCsrf.statusCode).toBe(403)
    const delivered = await inject({
      method: 'POST', url: `/api/v1/admin/orders/${freeOrderId}/items/${itemId}/fulfillments`,
      headers: adminHeaders(admin), payload: deliveryBody,
    })
    expect(delivered.statusCode).toBe(200)
    expect(delivered.json().data.order).toMatchObject({ status: 'completed', items: [{ fulfilledQuantity: 1, fulfillmentStatus: 'completed' }] })
    expect(delivered.json().data.order.items[0].deliveries).toMatchObject([{ content: 'ORDER-PRIVATE-DIGITAL-CONTENT-8472', unitIndex: 1 }])

    const replay = await inject({
      method: 'POST', url: `/api/v1/admin/orders/${freeOrderId}/items/${itemId}/fulfillments`,
      headers: adminHeaders(admin), payload: deliveryBody,
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data.repeated).toBe(true)
    expect(await db.selectFrom('order_item_fulfillment_attempts').select('id').where('order_item_id', '=', itemId).execute()).toHaveLength(1)
    expect(await db.selectFrom('order_item_fulfillment_deliveries').select(['content_sha256', 'started_by_admin_id'])
      .where('fulfillment_attempt_id', '=', (await db.selectFrom('order_item_fulfillment_attempts').select('id').where('order_item_id', '=', itemId).executeTakeFirstOrThrow()).id)
      .execute()).toMatchObject([{ content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u), started_by_admin_id: admin.id }])
    expect(await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', freeSku.skuId).executeTakeFirstOrThrow()).toEqual({ stocked: 1, reserved: 0 })
    expect(await db.selectFrom('order_inventory_events as event')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
      .where('reservation.product_variant_id', '=', freeSku.skuId).select('event.action').execute()).toEqual([
      { action: 'reserve' }, { action: 'consume' },
    ])
    const adminDetail = await inject({ method: 'GET', url: `/api/v1/admin/orders/${freeOrderId}`, headers: { cookie: `${admin.cookie}; ${admin.csrfCookie}` } })
    expect(adminDetail.statusCode).toBe(200)
    expect(adminDetail.json().data.fulfillmentAttempts[0]).toMatchObject({ administratorId: admin.id, deliveryCount: 1, resultSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) })
    expect(adminDetail.headers['cache-control']).toContain('no-store')

    const listed = await inject({ method: 'GET', url: '/api/v1/guest/orders?page=1&pageSize=20', headers: { cookie: guest.cookie } })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().data.items.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([paidOrderId, freeOrderId]))
    const hiddenFromOtherGuest = await inject({ method: 'GET', url: `/api/v1/guest/orders/${freeOrderId}`, headers: { cookie: secondGuest.cookie } })
    expect(hiddenFromOtherGuest.statusCode).toBe(404)

    await db.updateTable('guest_order_sessions').set({ revoked_at: new Date() })
      .where('token_hash', '=', (await import('../src/auth/security.js')).hashToken(guest.cookie.split('=')[1]!)).execute()
    const afterRevocation = await inject({ method: 'GET', url: '/api/v1/guest/orders', headers: { cookie: guest.cookie } })
    expect(afterRevocation.statusCode).toBe(401)
    expect((await db.selectFrom('orders').select('id').where('id', '=', freeOrderId).executeTakeFirst()).id).toBe(freeOrderId)
  })

  it('serializes concurrent stock writers, rolls back partial order work, and handles stale availability', async () => {
    const admin = await createAdmin()
    const firstCustomer = await createCustomer()
    const secondCustomer = await createCustomer()
    const scarce = await createCatalog({ price: '1.00', mode: 'quantity', stock: 1 })
    await enableManual(scarce, admin)
    const items = [{ skuId: scarce.skuId, quantity: 1 }]
    const [firstQuote, secondQuote] = await Promise.all([quote(items, firstCustomer), quote(items, secondCustomer)])
    const [first, second] = await Promise.all([
      createOrder(items, firstQuote.json().data.quoteToken, firstCustomer),
      createOrder(items, secondQuote.json().data.quoteToken, secondCustomer),
    ])
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409])
    expect((await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved']).where('product_variant_id', '=', scarce.skuId).executeTakeFirstOrThrow())).toEqual({ stocked: 1, reserved: 1 })
    const successful = first.statusCode === 201 ? first : second
    expect(successful.json().data.order).toBeDefined()
    expect(await db.selectFrom('orders').select('id').where('id', '=', successful.json().data.order.id).execute()).toHaveLength(1)

    const rollbackQuantity = await createCatalog({ name: 'ROLLBACK-A-quantity', mode: 'quantity', stock: 3, skuId: '10000000-0000-4000-8000-000000000001' })
    const rollbackSecond = await createCatalog({ name: 'ROLLBACK-B-failure', mode: 'unlimited', skuId: '20000000-0000-4000-8000-000000000002' })
    await enableManual(rollbackQuantity, admin)
    await enableManual(rollbackSecond, admin)
    const rollbackItems = [{ skuId: rollbackQuantity.skuId, quantity: 2 }, { skuId: rollbackSecond.skuId, quantity: 1 }]
    const rollbackQuote = await quote(rollbackItems, firstCustomer)
    const rollbackKey = randomUUID()
    await sql`
      CREATE FUNCTION test_fail_second_order_item() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.product_variant_id = '20000000-0000-4000-8000-000000000002'::uuid THEN
          RAISE EXCEPTION 'intentional transaction rollback fixture';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER zz_test_fail_second_order_item BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION test_fail_second_order_item()`.execute(db)
    try {
      const failed = await createOrder(rollbackItems, rollbackQuote.json().data.quoteToken, firstCustomer, rollbackKey)
      expect(failed.statusCode).toBe(500)
    } finally {
      await sql`DROP TRIGGER IF EXISTS zz_test_fail_second_order_item ON order_items`.execute(db)
      await sql`DROP FUNCTION IF EXISTS test_fail_second_order_item()`.execute(db)
    }
    expect(await db.selectFrom('orders').select('id').where('idempotency_key', '=', rollbackKey).execute()).toHaveLength(0)
    expect(await db.selectFrom('order_inventory_reservations').select('id').where('product_variant_id', '=', rollbackQuantity.skuId).execute()).toHaveLength(0)
    expect((await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved']).where('product_variant_id', '=', rollbackQuantity.skuId).executeTakeFirstOrThrow())).toEqual({ stocked: 3, reserved: 0 })
    expect(await db.selectFrom('order_inventory_events as event').innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id').where('reservation.product_variant_id', '=', rollbackQuantity.skuId).execute()).toHaveLength(0)
  })

  it('protects uncertain payment orders and closes due orders exactly once with restart recovery', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '2.00', mode: 'quantity', stock: 5 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const firstQuote = await quote(items, customer)
    const protectedOrder = await createOrder(items, firstQuote.json().data.quoteToken, customer)
    const protectedId = protectedOrder.json().data.order.id as string
    const attemptId = randomUUID()
    await db.insertInto('payment_attempts').values({
      id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: protectedId,
      topup_customer_id: null, source: 'external', amount: '2.00', status: 'created', provider: 'integration',
      provider_payment_id: null, wallet_operation_id: null, wallet_hold_operation_id: null,
      requested_wallet_amount: null, expires_at: new Date(Date.now() + 30 * 60_000), completed_at: null,
    }).execute()
    await db.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
    const protectedCancel = await inject({ method: 'POST', url: `/api/v1/customer/orders/${protectedId}/cancel`, headers: customerHeaders(customer) })
    expect(protectedCancel.statusCode).toBe(409)
    expect(protectedCancel.json().error.code).toBe('ORDER_HAS_UNRESOLVED_OBLIGATION')
    await expireDueUnpaidOrders(db, new Date(Date.now() + 60 * 60_000))
    expect((await db.selectFrom('orders').select('status').where('id', '=', protectedId).executeTakeFirstOrThrow()).status).toBe('pending_payment')
    await expect(db.updateTable('orders').set({ status: 'closed' }).where('id', '=', protectedId).execute()).rejects.toBeDefined()
    await db.updateTable('payment_attempts').set({ status: 'failed', completed_at: new Date() }).where('id', '=', attemptId).execute()
    const safeCancel = await inject({ method: 'POST', url: `/api/v1/customer/orders/${protectedId}/cancel`, headers: customerHeaders(customer) })
    expect(safeCancel.statusCode).toBe(200)
    expect(safeCancel.json().data.status).toBe('closed')

    const activeSku = await createCatalog({ price: '2.50', mode: 'quantity', stock: 4 })
    await enableManual(activeSku, admin)
    const activeItems = [{ skuId: activeSku.skuId, quantity: 1 }]
    const activeQuote = await quote(activeItems, customer)
    const activeOrder = await createOrder(activeItems, activeQuote.json().data.quoteToken, customer)
    const activeOrderId = activeOrder.json().data.order.id as string
    const activeAttemptId = randomUUID()
    await db.insertInto('payment_attempts').values({
      id: activeAttemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: activeOrderId,
      topup_customer_id: null, source: 'external', amount: '2.50', status: 'created', provider: 'integration',
      provider_payment_id: null, wallet_operation_id: null, wallet_hold_operation_id: null,
      requested_wallet_amount: null, expires_at: new Date(Date.now() + 30 * 60_000), completed_at: null,
    }).execute()
    await db.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', activeAttemptId).execute()
    const availableQuote = await quote(activeItems, customer)
    const availableOrder = await createOrder(activeItems, availableQuote.json().data.quoteToken, customer)
    expect(availableOrder.statusCode).toBe(201)
    const availableOrderId = availableOrder.json().data.order.id as string
    expect(await expireDueUnpaidOrders(db, new Date(Date.now() + 60 * 60_000), 1)).toBe(1)
    expect((await db.selectFrom('orders').select('status').where('id', '=', activeOrderId).executeTakeFirstOrThrow()).status).toBe('pending_payment')
    expect((await db.selectFrom('orders').select('status').where('id', '=', availableOrderId).executeTakeFirstOrThrow()).status).toBe('closed')

    const skipSku = await createCatalog({ price: '2.00', mode: 'quantity', stock: 2 })
    await enableManual(skipSku, admin)
    const skipQuote = await quote([{ skuId: skipSku.skuId, quantity: 1 }], customer)
    const skipOrder = await createOrder([{ skuId: skipSku.skuId, quantity: 1 }], skipQuote.json().data.quoteToken, customer)
    const skipId = skipOrder.json().data.order.id as string
    const dueAt = new Date(Date.now() + 20 * 60_000)
    let unlock!: () => void
    let acquired!: () => void
    const locked = new Promise<void>((resolve) => { acquired = resolve })
    const hold = new Promise<void>((resolve) => { unlock = resolve })
    const rowLock = db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM orders WHERE id = ${skipId}::uuid FOR UPDATE`.execute(trx)
      acquired()
      await hold
    })
    await locked
    expect(await expireDueUnpaidOrders(db, dueAt)).toBe(0)
    unlock()
    await rowLock
    expect(await expireDueUnpaidOrders(db, dueAt)).toBe(1)
    expect(await expireDueUnpaidOrders(db, dueAt)).toBe(0)
    expect((await db.selectFrom('orders').select('status').where('id', '=', skipId).executeTakeFirstOrThrow()).status).toBe('closed')
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved').where('product_variant_id', '=', skipSku.skuId).executeTakeFirstOrThrow()).reserved).toBe(0)
    expect(await db.selectFrom('order_inventory_events as event').innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id').where('reservation.product_variant_id', '=', skipSku.skuId).select('event.action').execute()).toEqual([
      { action: 'reserve' }, { action: 'release' },
    ])

    const recoverySku = await createCatalog({ price: '1.50', mode: 'quantity', stock: 2 })
    await enableManual(recoverySku, admin)
    const recoveryQuote = await quote([{ skuId: recoverySku.skuId, quantity: 1 }], customer)
    const recoveryOrder = await createOrder([{ skuId: recoverySku.skuId, quantity: 1 }], recoveryQuote.json().data.quoteToken, customer)
    const recoveryId = recoveryOrder.json().data.order.id as string
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    try {
      await sql`UPDATE orders SET unpaid_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${recoveryId}::uuid`.execute(db)
    } finally {
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }
    const stopWorker = startUnpaidOrderExpiryWorker(db, app.log)
    try {
      const deadline = Date.now() + 5_000
      let status = 'pending_payment'
      while (Date.now() < deadline && status !== 'closed') {
        await new Promise(resolve => setTimeout(resolve, 25))
        status = (await db.selectFrom('orders').select('status').where('id', '=', recoveryId).executeTakeFirstOrThrow()).status
      }
      expect(status).toBe('closed')
      expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved').where('product_variant_id', '=', recoverySku.skuId).executeTakeFirstOrThrow()).reserved).toBe(0)
    } finally {
      await stopWorker()
    }
  })
})
