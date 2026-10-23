import { randomUUID, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Migrator } from 'kysely/migration'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/password.js'
import { readConfig } from '../src/config.js'
import type { AppConfig } from '../src/config.js'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'
import { runDigitalDeliveryRecoveryPass } from '../src/commerce/code-pool-delivery-worker.js'
import { createHttpJsonV1Delivery, HttpJsonV1Error, resolvePinnedAddress, testHttpJsonV1Connection, validateSupplierBaseUrl, isPublicAddress } from '../src/commerce/http-json-v1.js'
import { startHttpJsonV1Fixture } from './fixtures/http-json-v1-server.js'
import { startZpayHttpFixture } from './fixtures/zpay-http-server.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? 'postgresql://aikayun:local-test-password@127.0.0.1:5432/aikayun_test'
const origin = 'http://localhost:3000'
const adminPassword = 'External-API-Integration-Password-2026!'
const customerPassword = 'External-API-Customer-Password-2026!'
const merchantId = 'external-api-test-merchant'
const merchantKey = 'external-api-test-payment-secret-never-returned'
const paymentKeyA = randomBytes(32)
const paymentKeyB = randomBytes(32)
const supplierTokenV1 = 'external-api-test-supplier-token-v1'
const supplierTokenV2 = 'external-api-test-supplier-token-v2'
let app: FastifyInstance
let db: Kysely<Database>
let config: AppConfig
let supplierFixture: Awaited<ReturnType<typeof startHttpJsonV1Fixture>>
let paymentFixture: Awaited<ReturnType<typeof startZpayHttpFixture>>
let paymentChannelId: string
let nextIp = 1

type Admin = { id: string; cookie: string; csrfToken: string; csrfCookie: string }
type Customer = { id: string; cookie: string; csrfToken: string; csrfCookie: string }
type Catalog = { productId: string; skuId: string; name: string; mode: 'quantity' | 'unlimited' }
type Supplier = { id: string; versionId: string }

function inject(options: InjectOptions) {
  return app.inject({ ...options, remoteAddress: `198.51.100.${(nextIp++ % 240) + 1}` })
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const values = response.headers['set-cookie']
  const rows = Array.isArray(values) ? values : values ? [values] : []
  const row = rows.find(value => value.startsWith(`${name}=`))
  if (!row) throw new Error(`Expected ${name} cookie`)
  return row.split(';', 1)[0]!
}

async function csrf(kind: 'admin' | 'customer' = 'customer') {
  const response = await inject({ method: 'GET', url: `/api/v1/${kind}/auth/csrf` })
  expect(response.statusCode, response.body).toBe(200)
  const name = kind === 'admin' ? 'aikayun_admin_csrf' : 'aikayun_customer_csrf'
  return { token: response.json().data.csrfToken as string, cookie: cookieFrom(response, name) }
}

async function createAdmin(): Promise<Admin> {
  const id = randomUUID()
  const email = `external-api-${id.slice(0, 8)}@example.test`
  await db.insertInto('admin_users').values({ id, email, password_hash: await hashPassword(adminPassword) }).execute()
  const token = await csrf('admin')
  const response = await inject({
    method: 'POST', url: '/api/v1/admin/auth/login',
    headers: { origin, cookie: token.cookie, 'x-csrf-token': token.token },
    payload: { email, password: adminPassword },
  })
  expect(response.statusCode, response.body).toBe(200)
  return { id, csrfToken: token.token, csrfCookie: token.cookie, cookie: cookieFrom(response, 'aikayun_admin_session') }
}

function adminHeaders(admin: Admin) {
  return { origin, cookie: `${admin.cookie}; ${admin.csrfCookie}`, 'x-csrf-token': admin.csrfToken }
}

async function createCustomer(): Promise<Customer> {
  const token = await csrf()
  const username = `external-${randomUUID().replaceAll('-', '').slice(0, 18)}`
  const response = await inject({
    method: 'POST', url: '/api/v1/customer/auth/register',
    headers: { origin, cookie: token.cookie, 'x-csrf-token': token.token },
    payload: { username, password: customerPassword },
  })
  expect(response.statusCode, response.body).toBe(201)
  return {
    id: response.json().data.customer.id as string,
    cookie: cookieFrom(response, 'aikayun_customer_session'),
    csrfToken: token.token, csrfCookie: token.cookie,
  }
}

async function createGuest() {
  const token = await csrf()
  const response = await inject({
    method: 'POST', url: '/api/v1/guest/session',
    headers: { origin, cookie: token.cookie, 'x-csrf-token': token.token },
  })
  expect([200, 201], response.body).toContain(response.statusCode)
  return {
    cookie: cookieFrom(response, 'aikayun_guest_order_session'),
    csrfToken: token.token,
    csrfCookie: token.cookie,
  }
}

function customerHeaders(customer: Customer) {
  return { origin, cookie: `${customer.cookie}; ${customer.csrfCookie}`, 'x-csrf-token': customer.csrfToken }
}

async function createSupplier(admin: Admin, name = `测试供应商 ${randomUUID().slice(0, 6)}`): Promise<Supplier> {
  const response = await inject({
    method: 'POST', url: '/api/v1/admin/supplier-connections', headers: adminHeaders(admin),
    payload: { name, providerType: 'http_json_v1', baseUrl: supplierFixture.baseUrl, bearerToken: supplierTokenV1 },
  })
  expect(response.statusCode, response.body).toBe(201)
  const connection = response.json().data[0]
  expect(connection).toMatchObject({ name, enabled: false, providerType: 'http_json_v1', credentialsConfigured: true })
  expect(response.body).not.toContain(supplierTokenV1)
  const versionId = connection.currentVersion.id as string
  const testResponse = await inject({ method: 'POST', url: `/api/v1/admin/supplier-connections/${connection.id}/test`, headers: adminHeaders(admin) })
  expect(testResponse.statusCode, testResponse.body).toBe(200)
  expect(testResponse.json().data).toMatchObject({ connectionOk: true, queryCapable: true })
  expect(supplierFixture.stats().capabilities).toBeGreaterThan(0)
  expect(supplierFixture.stats().idempotencyQueries).toBeGreaterThan(0)
  expect(supplierFixture.stats().providerIdQueries).toBeGreaterThan(0)
  const enabled = await inject({
    method: 'PUT', url: `/api/v1/admin/supplier-connections/${connection.id}/enabled`,
    headers: adminHeaders(admin), payload: { enabled: true },
  })
  expect(enabled.statusCode, enabled.body).toBe(200)
  return { id: connection.id as string, versionId }
}

async function rotateSupplier(admin: Admin, supplier: Supplier): Promise<Supplier> {
  const response = await inject({
    method: 'PUT', url: `/api/v1/admin/supplier-connections/${supplier.id}`,
    headers: adminHeaders(admin),
    payload: { name: '轮换后的测试供应商', baseUrl: supplierFixture.baseUrl, bearerToken: supplierTokenV2 },
  })
  expect(response.statusCode, response.body).toBe(200)
  const current = response.json().data[0]
  expect(current.enabled).toBe(false)
  expect(response.body).not.toContain(supplierTokenV2)
  const tested = await inject({ method: 'POST', url: `/api/v1/admin/supplier-connections/${supplier.id}/test`, headers: adminHeaders(admin) })
  expect(tested.json().data).toMatchObject({ connectionOk: true, queryCapable: true })
  const enabled = await inject({
    method: 'PUT', url: `/api/v1/admin/supplier-connections/${supplier.id}/enabled`,
    headers: adminHeaders(admin), payload: { enabled: true },
  })
  expect(enabled.statusCode, enabled.body).toBe(200)
  return { id: supplier.id, versionId: current.currentVersion.id as string }
}

async function createCatalog(
  price = '0.00', mode: 'quantity' | 'unlimited' = 'quantity',
): Promise<Catalog> {
  const productId = randomUUID()
  const skuId = randomUUID()
  const name = `API 履约商品 ${productId.slice(0, 8)}`
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('products').values({ id: productId, name, description: '', product_type: 'digital', status: 'active' }).execute()
    await trx.insertInto('product_variants').values({
      id: skuId, product_id: productId, sku_code: `API-${skuId.slice(0, 8)}`, combination_key: '',
      sale_price: price, enabled: true, retired_at: null, inventory_mode: mode,
    }).execute()
    if (mode === 'quantity') await trx.insertInto('product_variant_quantity_inventory').values({
      product_id: productId, product_variant_id: skuId, stocked: 20, reserved: 0,
    }).execute()
    await trx.insertInto('product_variant_fulfillment').values({
      product_variant_id: skuId, method: 'manual', manual_delivery_ready: false,
    }).execute()
  })
  return { productId, skuId, name, mode }
}

async function saveApiVersion(
  catalog: Catalog, admin: Admin, supplier: Supplier, options: { productId?: string; mode?: string } = {},
) {
  const path = `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/api-fulfillment`
  const current = await inject({ method: 'GET', url: path, headers: { cookie: admin.cookie } })
  expect(current.statusCode, current.body).toBe(200)
  const response = await inject({
    method: 'POST', url: `${path}/versions`, headers: adminHeaders(admin),
    payload: {
      expectedRevision: current.json().data.configurationRevision,
      supplierConnectionVersionId: supplier.versionId,
      supplierProductId: options.productId ?? 'fixture-product-standard',
      parameters: options.mode ? { mode: options.mode } : {},
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().data as { configuration: { configurationRevision: number; currentVersionId: string; automaticDeliveryReady: boolean }; currentVersion: { id: string } }
}

async function setApiReadiness(catalog: Catalog, admin: Admin, enabled: boolean) {
  const path = `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/api-fulfillment`
  const current = await inject({ method: 'GET', url: path, headers: { cookie: admin.cookie } })
  expect(current.statusCode, current.body).toBe(200)
  return await inject({
    method: 'PUT', url: `${path}/readiness`, headers: adminHeaders(admin),
    payload: { expectedRevision: current.json().data.configurationRevision, enabled },
  })
}

async function quote(customer: Customer, catalog: Catalog, quantity: number) {
  return await inject({
    method: 'POST', url: '/api/v1/checkout/quote', headers: customerHeaders(customer),
    payload: { items: [{ skuId: catalog.skuId, quantity }] },
  })
}

async function createGuestOrder(guest: Awaited<ReturnType<typeof createGuest>>, catalog: Catalog, quantity: number) {
  const headers = {
    origin,
    cookie: `${guest.cookie}; ${guest.csrfCookie}`,
    'x-csrf-token': guest.csrfToken,
  }
  const quoteResponse = await inject({
    method: 'POST', url: '/api/v1/checkout/quote', headers,
    payload: { items: [{ skuId: catalog.skuId, quantity }] },
  })
  expect(quoteResponse.statusCode, quoteResponse.body).toBe(200)
  expect(quoteResponse.json().data.canContinue, quoteResponse.body).toBe(true)
  return await inject({
    method: 'POST', url: '/api/v1/checkout/orders', headers,
    payload: {
      idempotencyKey: randomUUID(), quoteToken: quoteResponse.json().data.quoteToken,
      items: [{ skuId: catalog.skuId, quantity }],
    },
  })
}

async function createOrder(customer: Customer, catalog: Catalog, quantity: number, token?: string) {
  const quoteResponse = token ? undefined : await quote(customer, catalog, quantity)
  if (quoteResponse) {
    expect(quoteResponse.statusCode, quoteResponse.body).toBe(200)
    expect(quoteResponse.json().data.canContinue, quoteResponse.body).toBe(true)
  }
  const quoteToken = token ?? quoteResponse!.json().data.quoteToken as string
  return await inject({
    method: 'POST', url: '/api/v1/checkout/orders', headers: customerHeaders(customer),
    payload: { idempotencyKey: randomUUID(), quoteToken, items: [{ skuId: catalog.skuId, quantity }] },
  })
}

async function createPayment(orderId: string, customer: Customer) {
  return await inject({
    method: 'POST', url: `/api/v1/orders/${orderId}/payments`, headers: customerHeaders(customer),
    payload: { idempotencyKey: randomUUID(), channelId: paymentChannelId, paymentMethod: 'alipay' },
  })
}

function callbackUrl(values: Record<string, string>): string {
  return `/api/v1/payments/callback/zpay?${new URLSearchParams(values).toString()}`
}

async function pendingOperations(itemId: string) {
  return await db.selectFrom('supplier_api_delivery_operations as operation')
    .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'operation.fulfillment_attempt_id')
    .select(['operation.id', 'operation.state', 'operation.next_action_at', 'operation.lease_token', 'attempt.status as attempt_status'])
    .where('attempt.order_item_id', '=', itemId).orderBy('operation.unit_index').execute()
}

async function assertItemDelivered(orderId: string, itemId: string, quantity: number) {
  const [order, item, deliveries] = await Promise.all([
    db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow(),
    db.selectFrom('order_items').select(['fulfilled_quantity', 'fulfillment_reserved_quantity', 'fulfillment_status'])
      .where('id', '=', itemId).executeTakeFirstOrThrow(),
    db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .select(['delivery.unit_index', 'delivery.content', 'delivery.encrypted_content', 'delivery.supplier_content_type'])
      .where('attempt.order_item_id', '=', itemId).where('attempt.status', '=', 'succeeded')
      .orderBy('delivery.unit_index').execute(),
  ])
  expect(order.status).toBe('completed')
  expect(item).toEqual({ fulfilled_quantity: quantity, fulfillment_reserved_quantity: 0, fulfillment_status: 'completed' })
  expect(deliveries).toHaveLength(quantity)
  expect(deliveries.map(row => row.unit_index)).toEqual(Array.from({ length: quantity }, (_, index) => index + 1))
  expect(deliveries.every(row => row.content === null)).toBe(true)
  expect(deliveries.every(row => row.encrypted_content || row.supplier_content_type === 'completed')).toBe(true)
}

beforeAll(async () => {
  if (!new URL(testDatabaseUrl).pathname.slice(1).endsWith('_test')) throw new Error('External API integration tests require an isolated PostgreSQL database ending in _test')
  supplierFixture = await startHttpJsonV1Fixture({ bearerTokens: [supplierTokenV1, supplierTokenV2] })
  paymentFixture = await startZpayHttpFixture({ merchantCredentials: { [merchantId]: merchantKey } })
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`DROP SCHEMA public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const migrated = await migrator.migrateToLatest()
  if (migrated.error) throw migrated.error
  const repeated = await migrator.migrateToLatest()
  if (repeated.error) throw repeated.error
  config = readConfig({
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    NODE_ENV: 'test', PUBLIC_ORIGIN: origin, COOKIE_SECURE: 'false',
    SUPPLIER_HTTP_TEST_ALLOWLIST: supplierFixture.baseUrl,
    PAYMENT_CREDENTIAL_KEY_RING: JSON.stringify({
      activeKeyId: 'supplier-test-a', keys: {
        'supplier-test-a': paymentKeyA.toString('base64'), 'supplier-test-b': paymentKeyB.toString('base64'),
      },
    }),
    CODE_POOL_ENCRYPTION_KEY_RING: JSON.stringify({
      activeKeyId: 'supplier-result-v1', keys: { 'supplier-result-v1': randomBytes(32).toString('base64') },
    }),
  })
  app = await createApp({ db, config, logger: false, paymentProviderBaseUrlForTests: paymentFixture.baseUrl })
  await app.ready()
  const admin = await createAdmin()
  const channel = await inject({
    method: 'POST', url: '/api/v1/admin/payment-channels', headers: adminHeaders(admin),
    payload: {
      providerType: 'zpay_epay_v1', name: '外部 API 支付测试通道', enabled: true,
      paymentMethods: ['alipay', 'wechat'], displayOrder: 1,
      merchantId, merchantKey,
    },
  })
  expect(channel.statusCode, channel.body).toBe(201)
  paymentChannelId = channel.json().data.channel.id as string
})

afterAll(async () => {
  if (app) await app.close()
  if (paymentFixture) await paymentFixture.close()
  if (supplierFixture) await supplierFixture.close()
  if (db) await db.destroy()
})

describe('external API delivery on real PostgreSQL and HTTP fixtures', () => {
  it('stores encrypted credentials, immutable connection and SKU versions, rejects stale quotes, and keeps old orders recoverable', async () => {
    supplierFixture.reset()
    const admin = await createAdmin()
    const customer = await createCustomer()
    const supplier = await createSupplier(admin)
    const catalog = await createCatalog('0.00', 'quantity')
    const version1 = await saveApiVersion(catalog, admin, supplier, { mode: 'success' })
    expect(version1.configuration.automaticDeliveryReady).toBe(false)
    const ready1 = await setApiReadiness(catalog, admin, true)
    expect(ready1.statusCode, ready1.body).toBe(200)
    expect(ready1.json().data.configuration.automaticDeliveryReady).toBe(true)

    const earlierQuote = await quote(customer, catalog, 1)
    expect(earlierQuote.json().data.canContinue).toBe(true)
    const created = await createOrder(customer, catalog, 1, earlierQuote.json().data.quoteToken as string)
    expect(created.statusCode, created.body).toBe(201)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    expect(created.json().data.order.status).toBe('processing')
    const snapshot = await db.selectFrom('order_items').select('fulfillment_content_version_id').where('id', '=', itemId).executeTakeFirstOrThrow()
    expect(snapshot.fulfillment_content_version_id).toBe(version1.currentVersion.id)

    const version2 = await saveApiVersion(catalog, admin, supplier, { mode: 'text' })
    expect(version2.configuration.automaticDeliveryReady).toBe(false)
    const staleCheckout = await createOrder(customer, catalog, 1, earlierQuote.json().data.quoteToken as string)
    expect(staleCheckout.statusCode).toBe(409)
    expect(staleCheckout.json().error.code).toBe('CHECKOUT_QUOTE_CHANGED')

    const credentialRow = await db.selectFrom('supplier_connection_credentials').select(['key_id', 'ciphertext'])
      .where('supplier_connection_id', '=', supplier.id).where('credential_version', '=', 1).executeTakeFirstOrThrow()
    expect(credentialRow.key_id).toBe('supplier-test-a')
    expect(credentialRow.ciphertext.toString('utf8')).not.toContain(supplierTokenV1)
    const supplierList = await inject({ method: 'GET', url: '/api/v1/admin/supplier-connections', headers: { cookie: admin.cookie } })
    expect(supplierList.statusCode).toBe(200)
    expect(supplierList.body).not.toContain(supplierTokenV1)
    expect(supplierList.body).not.toContain(merchantKey)

    config.paymentCredentialKeyRing!.activeKeyId = 'supplier-test-b'
    const rewrapped = await inject({
      method: 'POST', url: `/api/v1/admin/supplier-connections/${supplier.id}/rewrap-credentials`, headers: adminHeaders(admin),
    })
    expect(rewrapped.statusCode, rewrapped.body).toBe(200)
    expect(rewrapped.json().data.rewrappedCredentialVersions).toBe(1)
    expect((await db.selectFrom('supplier_connection_credentials').select('key_id')
      .where('supplier_connection_id', '=', supplier.id).where('credential_version', '=', 1).executeTakeFirstOrThrow()).key_id)
      .toBe('supplier-test-b')

    const rotated = await rotateSupplier(admin, supplier)
    const version3 = await saveApiVersion(catalog, admin, rotated, { mode: 'text' })
    expect(version3.configuration.automaticDeliveryReady).toBe(false)
    const ready3 = await setApiReadiness(catalog, admin, true)
    expect(ready3.statusCode, ready3.body).toBe(200)

    await runDigitalDeliveryRecoveryPass(db, config)
    await runDigitalDeliveryRecoveryPass(db, config)
    await assertItemDelivered(orderId, itemId, 1)
    expect(supplierFixture.stats().createRequests).toBe(1)
    expect(supplierFixture.stats().executions).toBe(1)
    const delivery = (await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .select('delivery.id').where('attempt.order_item_id', '=', itemId).executeTakeFirstOrThrow()).id
    const stranger = await createCustomer()
    const hidden = await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: stranger.cookie } })
    expect(hidden.statusCode).toBe(404)
    const customerView = await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: customer.cookie } })
    expect(customerView.statusCode).toBe(200)
    expect(customerView.json().data.items[0].deliveries[0]).toMatchObject({ contentFormat: 'plain_text' })
    expect(JSON.stringify(customerView.json())).not.toContain(supplierTokenV1)
    expect(JSON.stringify(customerView.json())).not.toContain(supplierTokenV2)
    expect(JSON.stringify(customerView.json())).not.toContain(merchantKey)
    expect(delivery).toMatch(/^[0-9a-f-]{36}$/u)

    const product = await db.selectFrom('products').select('revision').where('id', '=', catalog.productId).executeTakeFirstOrThrow()
    const copied = await inject({
      method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/copy`, headers: adminHeaders(admin),
      payload: { expectedRevision: product.revision },
    })
    expect(copied.statusCode, copied.body).toBe(201)
    const copiedSku = copied.json().data.variants[0].id as string
    expect(await db.selectFrom('product_variant_fulfillment_versions').select('id').where('product_variant_id', '=', copiedSku).execute()).toEqual([])
    expect(await db.selectFrom('product_variant_fulfillment').select('automatic_delivery_ready').where('product_variant_id', '=', copiedSku).execute()).toEqual([])
    const audit = await inject({ method: 'GET', url: `/api/v1/admin/supplier-connections/${supplier.id}/audit`, headers: { cookie: admin.cookie } })
    expect(audit.statusCode).toBe(200)
    expect(audit.body).not.toContain(supplierTokenV1)
    expect(audit.body).not.toContain(supplierTokenV2)
  }, 30_000)

  it('makes no supplier request for unpaid orders or orders with an open payment reconciliation case', async () => {
    supplierFixture.reset()
    const admin = await createAdmin()
    const customer = await createCustomer()
    const supplier = await createSupplier(admin)
    const catalog = await createCatalog('5.00', 'quantity')
    await saveApiVersion(catalog, admin, supplier)
    expect((await setApiReadiness(catalog, admin, true)).statusCode).toBe(200)
    const unpaid = await createOrder(customer, catalog, 1)
    expect(unpaid.statusCode).toBe(201)
    const unpaidId = unpaid.json().data.order.id as string
    const unpaidItemId = unpaid.json().data.order.items[0].id as string
    expect(unpaid.json().data.order.status).toBe('pending_payment')
    await runDigitalDeliveryRecoveryPass(db, config)
    expect(supplierFixture.stats().createRequests).toBe(0)
    expect(await pendingOperations(unpaidItemId)).toHaveLength(0)

    const payment = await createPayment(unpaidId, customer)
    expect(payment.statusCode, payment.body).toBe(201)
    const attemptId = payment.json().data.attempt.id as string
    const merchantOrderNo = (await db.selectFrom('payment_attempts').select('merchant_order_no')
      .where('id', '=', attemptId).executeTakeFirstOrThrow()).merchant_order_no!
    const callback = paymentFixture.setPaid(merchantOrderNo)
    const settled = await inject({ method: 'GET', url: callbackUrl(callback) })
    expect(settled.statusCode).toBe(200)
    expect(settled.body).toBe('success')
    const event = await db.selectFrom('payment_provider_events').select('id')
      .where('payment_attempt_id', '=', attemptId).executeTakeFirstOrThrow()
    await db.insertInto('payment_provider_reconciliation_cases').values({
      id: randomUUID(), payment_attempt_id: attemptId, reason: 'provider_identity_conflict',
      opening_callback_event_id: event.id, opening_query_event_id: null, state: 'open',
      resolved_at: null, resolved_by_admin_id: null, resolution_query_event_sha256: null,
      resolution_provider_transaction_id: null, resolution_payment_method: null,
      resolution_confirmed_amount: null, resolution_currency: null, resolution_payload: null,
    }).execute()
    expect((await db.selectFrom('orders').select('status').where('id', '=', unpaidId).executeTakeFirstOrThrow()).status).toBe('processing')
    const receipt = await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', attemptId).execute()
    expect(receipt).toHaveLength(1)
    await runDigitalDeliveryRecoveryPass(db, config)
    expect(supplierFixture.stats().createRequests).toBe(0)
    expect(await pendingOperations(unpaidItemId)).toHaveLength(0)
    expect((await db.selectFrom('order_items').select('fulfilled_quantity').where('id', '=', unpaidItemId).executeTakeFirstOrThrow()).fulfilled_quantity).toBe(0)
  }, 30_000)

  it('backs off when delivery encryption keys are unavailable and resumes after key restoration without sending early', async () => {
    supplierFixture.reset()
    const admin = await createAdmin()
    const customer = await createCustomer()
    const supplier = await createSupplier(admin)
    const catalog = await createCatalog('0.00', 'quantity')
    await saveApiVersion(catalog, admin, supplier)
    expect((await setApiReadiness(catalog, admin, true)).statusCode).toBe(200)
    const created = await createOrder(customer, catalog, 1)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    const resultKeyRing = config.codePoolEncryptionKeyRing

    config.codePoolEncryptionKeyRing = undefined
    await runDigitalDeliveryRecoveryPass(db, config)
    const failed = await db.selectFrom('order_item_fulfillment_attempts')
      .select(['status', 'failure_code', 'retry_after'])
      .where('order_item_id', '=', itemId).where('delivery_source', '=', 'api').executeTakeFirstOrThrow()
    expect(failed).toMatchObject({ status: 'failed', failure_code: 'API_DELIVERY_KEY_UNAVAILABLE' })
    expect(failed.retry_after?.getTime()).toBeGreaterThan(Date.now())
    expect(supplierFixture.stats().createRequests).toBe(0)

    config.codePoolEncryptionKeyRing = resultKeyRing
    await db.updateTable('order_item_fulfillment_attempts').set({ retry_after: new Date() })
      .where('order_item_id', '=', itemId).where('delivery_source', '=', 'api').execute()
    await runDigitalDeliveryRecoveryPass(db, config)
    await runDigitalDeliveryRecoveryPass(db, config)
    await assertItemDelivered(orderId, itemId, 1)
    expect(supplierFixture.stats()).toMatchObject({ createRequests: 1, executions: 1 })
  }, 30_000)

  it('queries the same stable operation after a lost response and finalizes only encrypted confirmed results', async () => {
    supplierFixture.reset()
    const admin = await createAdmin()
    const customer = await createCustomer()
    const supplier = await createSupplier(admin)
    const queryBaseline = supplierFixture.stats()
    const catalog = await createCatalog('0.00', 'unlimited')
    await saveApiVersion(catalog, admin, supplier, { mode: 'response_lost_after_execution' })
    expect((await setApiReadiness(catalog, admin, true)).statusCode).toBe(200)
    const created = await createOrder(customer, catalog, 1)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string

    await runDigitalDeliveryRecoveryPass(db, config)
    let operations = await pendingOperations(itemId)
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({ state: 'unknown', attempt_status: 'unknown' })
    const originalOperation = await db.selectFrom('supplier_api_delivery_operations').select(['idempotency_key', 'operation_id'])
      .where('id', '=', operations[0]!.id).executeTakeFirstOrThrow()
    expect(originalOperation.idempotency_key).toMatch(/^aikayun:[0-9a-f-]{36}$/u)
    expect(supplierFixture.stats()).toMatchObject({ createRequests: 1, executions: 1, queries: queryBaseline.queries })

    await db.updateTable('supplier_api_delivery_operations').set({ next_action_at: new Date() }).where('id', '=', operations[0]!.id).execute()
    await runDigitalDeliveryRecoveryPass(db, config)
    operations = await pendingOperations(itemId)
    expect(operations[0]!.state).toBe('succeeded_pending_finalize')
    expect(supplierFixture.stats()).toMatchObject({
      createRequests: 1, executions: 1, queries: queryBaseline.queries + 1,
      idempotencyQueries: queryBaseline.idempotencyQueries + 1,
    })
    await runDigitalDeliveryRecoveryPass(db, config)
    await assertItemDelivered(orderId, itemId, 1)

    const op = await db.selectFrom('supplier_api_delivery_operations').select(['result_ciphertext', 'state'])
      .where('id', '=', operations[0]!.id).executeTakeFirstOrThrow()
    expect(op.state).toBe('succeeded')
    expect(op.result_ciphertext).toBeTruthy()
    expect(op.result_ciphertext!.toString('utf8')).not.toContain(supplierTokenV1)
    const outsider = await createCustomer()
    const forbidden = await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: outsider.cookie } })
    expect(forbidden.statusCode).toBe(404)
    const own = await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: customer.cookie } })
    expect(own.statusCode).toBe(200)
    expect(own.json().data.items[0].deliveries[0].content).toBe(`fixture-code-${originalOperation.operation_id}`)
    expect(own.body).not.toContain(supplierTokenV1)
    expect(await db.selectFrom('order_inventory_events as event')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
      .select('event.id').where('reservation.order_item_id', '=', itemId).execute()).toEqual([])
  }, 30_000)

  it('keeps a timed-out create unknown after provider execution and recovers it by the same idempotency key', async () => {
    supplierFixture.reset()
    const admin = await createAdmin()
    const customer = await createCustomer()
    const supplier = await createSupplier(admin)
    const queryBaseline = supplierFixture.stats()
    const catalog = await createCatalog('0.00', 'unlimited')
    await saveApiVersion(catalog, admin, supplier)
    expect((await setApiReadiness(catalog, admin, true)).statusCode).toBe(200)
    const created = await createOrder(customer, catalog, 1)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string

    const gate = supplierFixture.pauseNextCreateResponse()
    let firstPassSettled = false
    const firstPass = runDigitalDeliveryRecoveryPass(db, config).finally(() => { firstPassSettled = true })
    try {
      await gate.entered
      expect(supplierFixture.stats()).toMatchObject({ createRequests: 1, executions: 1 })
      // The fixture has durably recorded success, but withholds the response
      // until the adapter's real eight-second request timeout fires.
      await firstPass
      const operation = (await pendingOperations(itemId))[0]!
      expect(operation).toMatchObject({ state: 'unknown', attempt_status: 'unknown' })
      expect(supplierFixture.stats()).toMatchObject({ createRequests: 1, executions: 1, queries: queryBaseline.queries })
      await db.updateTable('supplier_api_delivery_operations').set({ next_action_at: new Date() })
        .where('id', '=', operation.id).execute()
    } finally {
      gate.release()
      if (!firstPassSettled) await firstPass
    }

    await runDigitalDeliveryRecoveryPass(db, config)
    expect((await pendingOperations(itemId))[0]!.state).toBe('succeeded_pending_finalize')
    await runDigitalDeliveryRecoveryPass(db, config)
    await assertItemDelivered(orderId, itemId, 1)
    expect(supplierFixture.stats()).toMatchObject({
      createRequests: 1, executions: 1, queries: queryBaseline.queries + 1,
      idempotencyQueries: queryBaseline.idempotencyQueries + 1,
    })
  }, 30_000)

  it('delivers to a guest order session and isolates its private API delivery from customers and other guests', async () => {
    supplierFixture.reset()
    await db.updateTable('storefront_customer_policy').set({
      guest_checkout_enabled: true, guest_free_claim_enabled: true,
    }).execute()
    const admin = await createAdmin()
    const guest = await createGuest()
    const otherGuest = await createGuest()
    const customer = await createCustomer()
    const supplier = await createSupplier(admin)
    const catalog = await createCatalog('0.00', 'quantity')
    await saveApiVersion(catalog, admin, supplier)
    expect((await setApiReadiness(catalog, admin, true)).statusCode).toBe(200)

    const created = await createGuestOrder(guest, catalog, 1)
    expect(created.statusCode, created.body).toBe(201)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    await runDigitalDeliveryRecoveryPass(db, config)
    await runDigitalDeliveryRecoveryPass(db, config)

    const ownOrder = await inject({ method: 'GET', url: `/api/v1/guest/orders/${orderId}`, headers: { cookie: guest.cookie } })
    expect(ownOrder.statusCode, ownOrder.body).toBe(200)
    expect(ownOrder.json().data.items[0].deliveries[0].content).toMatch(/^fixture-code-[0-9a-f-]{36}$/u)
    expect((await inject({ method: 'GET', url: `/api/v1/guest/orders/${orderId}`, headers: { cookie: otherGuest.cookie } })).statusCode).toBe(404)
    expect((await inject({ method: 'GET', url: `/api/v1/guest/orders/${orderId}`, headers: { cookie: customer.cookie } })).statusCode).toBe(403)
    expect(await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .select('delivery.id').where('attempt.order_item_id', '=', itemId).execute()).toHaveLength(1)
    expect(supplierFixture.stats().executions).toBe(1)
  }, 30_000)

  it('uses leases for two concurrent workers and recovers an expired in-flight create through query', async () => {
    supplierFixture.reset()
    const admin = await createAdmin()
    const customer = await createCustomer()
    const supplier = await createSupplier(admin)
    const queryBaseline = supplierFixture.stats()
    const catalog = await createCatalog('0.00', 'quantity')
    await saveApiVersion(catalog, admin, supplier)
    expect((await setApiReadiness(catalog, admin, true)).statusCode).toBe(200)
    const created = await createOrder(customer, catalog, 1)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    const gate = supplierFixture.pauseNextCreateResponse()
    const firstWorker = runDigitalDeliveryRecoveryPass(db, config)
    try {
      await gate.entered
      let operation = (await pendingOperations(itemId))[0]!
      expect(operation.state).toBe('create_in_flight')
      await runDigitalDeliveryRecoveryPass(db, config)
      expect(supplierFixture.stats()).toMatchObject({ createRequests: 1, executions: 1, queries: queryBaseline.queries })

      await db.updateTable('supplier_api_delivery_operations').set({ lease_expires_at: new Date(Date.now() - 1) })
        .where('id', '=', operation.id).execute()
      await runDigitalDeliveryRecoveryPass(db, config)
      operation = (await pendingOperations(itemId))[0]!
      expect(operation.state).toBe('succeeded_pending_finalize')
      expect(supplierFixture.stats()).toMatchObject({
        createRequests: 1, executions: 1, queries: queryBaseline.queries + 1,
        providerIdQueries: queryBaseline.providerIdQueries,
        idempotencyQueries: queryBaseline.idempotencyQueries + 1,
      })
    } finally {
      gate.release()
      await firstWorker
    }
    await runDigitalDeliveryRecoveryPass(db, config)
    await assertItemDelivered(orderId, itemId, 1)
    expect(supplierFixture.stats().executions).toBe(1)
  }, 30_000)

  it('preserves partial success for quantity orders, retries only confirmed rejection, and blocks duplicate credentials', async () => {
    supplierFixture.reset()
    const admin = await createAdmin()
    const customer = await createCustomer()
    const supplier = await createSupplier(admin)
    const partialCatalog = await createCatalog('0.00', 'quantity')
    await saveApiVersion(partialCatalog, admin, supplier, { productId: 'partial-fixture-product', mode: 'partial' })
    expect((await setApiReadiness(partialCatalog, admin, true)).statusCode).toBe(200)
    const partialOrder = await createOrder(customer, partialCatalog, 5)
    const partialOrderId = partialOrder.json().data.order.id as string
    const partialItemId = partialOrder.json().data.order.items[0].id as string
    await runDigitalDeliveryRecoveryPass(db, config)
    let operations = await pendingOperations(partialItemId)
    expect(operations).toHaveLength(5)
    await runDigitalDeliveryRecoveryPass(db, config)
    const deliveredFirstBatch = await db.selectFrom('order_items').select(['fulfilled_quantity', 'fulfillment_reserved_quantity'])
      .where('id', '=', partialItemId).executeTakeFirstOrThrow()
    expect(deliveredFirstBatch).toEqual({ fulfilled_quantity: 3, fulfillment_reserved_quantity: 1 })
    operations = await pendingOperations(partialItemId)
    expect(operations.map(row => row.state).sort()).toEqual(['failed', 'processing', 'succeeded', 'succeeded', 'succeeded'])

    const processingOperation = operations.find(row => row.state === 'processing')!
    await db.updateTable('supplier_api_delivery_operations').set({ next_action_at: new Date() }).where('id', '=', processingOperation.id).execute()
    await runDigitalDeliveryRecoveryPass(db, config)
    await runDigitalDeliveryRecoveryPass(db, config)
    const partialItemAfterQuery = await db.selectFrom('order_items').select('fulfilled_quantity').where('id', '=', partialItemId).executeTakeFirstOrThrow()
    expect(partialItemAfterQuery.fulfilled_quantity).toBe(4)
    const failed = (await pendingOperations(partialItemId)).find(row => row.state === 'failed')!
    const retry = await inject({
      method: 'POST', url: `/api/v1/admin/orders/${partialOrderId}/supplier-operations/${failed.id}/retry`,
      headers: adminHeaders(admin),
    })
    expect(retry.statusCode, retry.body).toBe(200)
    await runDigitalDeliveryRecoveryPass(db, config)
    await runDigitalDeliveryRecoveryPass(db, config)
    await assertItemDelivered(partialOrderId, partialItemId, 5)
    const inventory = await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', partialCatalog.skuId).executeTakeFirstOrThrow()
    expect(inventory).toEqual({ stocked: 15, reserved: 0 })
    expect(await db.selectFrom('order_inventory_events as event').innerJoin('order_inventory_reservations as reservation',
      'reservation.id', 'event.reservation_id').select(['event.action', sql<number>`sum(event.quantity)::integer`.as('quantity')])
      .where('reservation.order_item_id', '=', partialItemId).groupBy('event.action').orderBy('event.action').execute())
      .toEqual([{ action: 'consume', quantity: 5 }, { action: 'reserve', quantity: 5 }])
    expect(supplierFixture.stats().createRequests).toBe(6)

    const firstCatalog = await createCatalog('0.00', 'unlimited')
    const secondCatalog = await createCatalog('0.00', 'unlimited')
    await saveApiVersion(firstCatalog, admin, supplier, { productId: 'duplicate-fixture-product', mode: 'duplicate' })
    await saveApiVersion(secondCatalog, admin, supplier, { productId: 'duplicate-fixture-product', mode: 'duplicate' })
    expect((await setApiReadiness(firstCatalog, admin, true)).statusCode).toBe(200)
    expect((await setApiReadiness(secondCatalog, admin, true)).statusCode).toBe(200)
    const firstOrder = await createOrder(customer, firstCatalog, 1)
    const firstItemId = firstOrder.json().data.order.items[0].id as string
    await runDigitalDeliveryRecoveryPass(db, config)
    await runDigitalDeliveryRecoveryPass(db, config)
    const firstItem = await db.selectFrom('order_items').select('fulfilled_quantity').where('id', '=', firstItemId).executeTakeFirstOrThrow()
    expect(firstItem.fulfilled_quantity).toBe(1)
    const secondOrder = await createOrder(customer, secondCatalog, 1)
    const secondItemId = secondOrder.json().data.order.items[0].id as string
    await runDigitalDeliveryRecoveryPass(db, config)
    await runDigitalDeliveryRecoveryPass(db, config)
    const secondOps = await pendingOperations(secondItemId)
    expect((await db.selectFrom('order_items').select('fulfilled_quantity').where('id', '=', secondItemId).executeTakeFirstOrThrow()).fulfilled_quantity).toBe(0)
    expect(secondOps.some(row => row.state === 'manual_review')).toBe(true)
    const secondId = secondOps.find(row => row.state === 'manual_review')!.id
    const fakeSuccess = await inject({
      method: 'POST', url: `/api/v1/admin/orders/${secondOrder.json().data.order.id}/supplier-operations/${secondId}/query`,
      headers: adminHeaders(admin),
    })
    expect(fakeSuccess.statusCode).toBe(409)
    expect((await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .select('delivery.id').where('attempt.order_item_id', 'in', [firstItemId, secondItemId]).execute())).toHaveLength(1)
  }, 40_000)

  it('places identity, amount, quantity, and duplicate-result mismatches into review without inventing deliveries', async () => {
    supplierFixture.reset()
    const admin = await createAdmin()
    const customer = await createCustomer()
    const supplier = await createSupplier(admin)
    for (const mode of ['identity_mismatch', 'wrong_amount', 'wrong_quantity'] as const) {
      const catalog = await createCatalog('0.00', 'quantity')
      await saveApiVersion(catalog, admin, supplier, { productId: `mismatch-${mode}`, mode })
      expect((await setApiReadiness(catalog, admin, true)).statusCode).toBe(200)
      const created = await createOrder(customer, catalog, 1)
      const itemId = created.json().data.order.items[0].id as string
      await runDigitalDeliveryRecoveryPass(db, config)
      const operations = await pendingOperations(itemId)
      expect(operations).toHaveLength(1)
      expect(operations[0]).toMatchObject({ state: 'manual_review', attempt_status: 'unknown' })
      expect(await db.selectFrom('order_item_fulfillment_deliveries as delivery')
        .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
        .select('delivery.id').where('attempt.order_item_id', '=', itemId).execute()).toHaveLength(0)
      const item = await db.selectFrom('order_items').select(['fulfilled_quantity', 'fulfillment_reserved_quantity'])
        .where('id', '=', itemId).executeTakeFirstOrThrow()
      expect(item).toEqual({ fulfilled_quantity: 0, fulfillment_reserved_quantity: 1 })
    }
  }, 30_000)

  it('blocks redirects, internal addresses, credential-bearing URLs, and DNS rebinding answers', async () => {
    supplierFixture.reset()
    expect(isPublicAddress('127.0.0.1')).toBe(false)
    expect(isPublicAddress('::1')).toBe(false)
    expect(isPublicAddress('fc00::1')).toBe(false)
    expect(isPublicAddress('fe80::1')).toBe(false)
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
    expect(() => validateSupplierBaseUrl(`${supplierFixture.baseUrl}/path?token=secret`, config)).toThrow(HttpJsonV1Error)
    expect(() => validateSupplierBaseUrl('http://127.0.0.1:12345', { ...config, nodeEnv: 'production' })).toThrow('supplier_https_required')

    const productionConfig = { ...config, nodeEnv: 'production' as const, supplierHttpTestAllowlist: [] }
    let lookupCount = 0
    const alternatingResolver = async () => {
      lookupCount += 1
      return lookupCount === 1
        ? [{ address: '93.184.216.34', family: 4 as const }]
        : [{ address: '10.20.0.4', family: 4 as const }]
    }
    const publicPin = await resolvePinnedAddress(new URL('https://supplier.example'), productionConfig, alternatingResolver)
    expect(publicPin).toEqual({ address: '93.184.216.34', family: 4 })
    await expect(resolvePinnedAddress(new URL('https://supplier.example'), productionConfig, alternatingResolver))
      .rejects.toMatchObject({ code: 'supplier_address_not_public' })
    expect(lookupCount).toBe(2)
    await expect(resolvePinnedAddress(new URL('https://supplier.example'), productionConfig, async () => [
      { address: '93.184.216.34', family: 4 }, { address: '10.20.0.4', family: 4 },
    ])).rejects.toMatchObject({ code: 'supplier_address_not_public' })

    await expect(createHttpJsonV1Delivery(productionConfig, {
      baseUrl: 'https://127.0.0.1:3101', bearerToken: supplierTokenV1,
    }, {
      operationId: randomUUID(), idempotencyKey: `aikayun:${randomUUID()}`,
      productId: 'ssrf-probe', unitAmount: '0.00', parameters: {},
    })).rejects.toMatchObject({ code: 'supplier_address_not_public' })

    const unavailableFixture = await startHttpJsonV1Fixture()
    const unavailableUrl = unavailableFixture.baseUrl
    await unavailableFixture.close()
    await expect(createHttpJsonV1Delivery({
      ...config, supplierHttpTestAllowlist: [unavailableUrl],
    }, {
      baseUrl: unavailableUrl, bearerToken: supplierTokenV1,
    }, {
      operationId: randomUUID(), idempotencyKey: `aikayun:${randomUUID()}`,
      productId: 'unavailable-probe', unitAmount: '0.00', parameters: {},
    })).rejects.toMatchObject({ classification: 'transport_unknown', code: 'supplier_connection_refused' })

    await expect(testHttpJsonV1Connection(config, {
      baseUrl: `${supplierFixture.baseUrl}/redirect`, bearerToken: supplierTokenV1,
    })).rejects.toMatchObject({ classification: 'redirect_rejected' })
    expect(supplierFixture.stats().redirects).toBe(1)
  }, 30_000)
})
