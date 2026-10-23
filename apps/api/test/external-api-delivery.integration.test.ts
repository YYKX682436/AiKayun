import { randomUUID, randomBytes } from 'node:crypto'
import { appendFile, mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { runDigitalDeliveryRecoveryPass, startDigitalDeliveryWorker } from '../src/commerce/code-pool-delivery-worker.js'
import { createHttpJsonV1Delivery, HttpJsonV1Error, resolvePinnedAddress, testHttpJsonV1Connection, validateSupplierBaseUrl, isPublicAddress } from '../src/commerce/http-json-v1.js'
import { startHttpJsonV1Fixture } from './fixtures/http-json-v1-server.js'
import { startZpayHttpFixture } from './fixtures/zpay-http-server.js'
import { startCrashProcess } from './fixtures/crash-process.js'

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
let storageRoot: string

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

async function runStartupDeliveryWorkerPass() {
  const stop = startDigitalDeliveryWorker(db, config, app.log)
  await stop()
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
  price = '0.00', mode: 'quantity' | 'unlimited' = 'quantity', stock = 20,
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
      product_id: productId, product_variant_id: skuId, stocked: stock, reserved: 0,
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
    MEDIA_ROOT: join(storageRoot = await mkdtemp(join(tmpdir(), 'aikayun-api-acceptance-')), 'public'),
    PRIVATE_FILE_ROOT: join(storageRoot, 'private'),
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
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
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
    await runStartupDeliveryWorkerPass()
    operations = await pendingOperations(itemId)
    expect(operations[0]!.state).toBe('succeeded_pending_finalize')
    expect(supplierFixture.stats()).toMatchObject({
      createRequests: 1, executions: 1, queries: queryBaseline.queries + 1,
      idempotencyQueries: queryBaseline.idempotencyQueries + 1,
    })
    await runStartupDeliveryWorkerPass()
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
    let persisted: unknown
    let eventCount: number
    let leasedOperationId: string
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
      leasedOperationId = operation.id
      persisted = await db.selectFrom('supplier_api_delivery_operations').selectAll().where('id', '=', operation.id).executeTakeFirstOrThrow()
      eventCount = (await db.selectFrom('supplier_api_delivery_events').select('id').where('operation_id', '=', operation.id).execute()).length
      expect(supplierFixture.stats()).toMatchObject({
        createRequests: 1, executions: 1, queries: queryBaseline.queries + 1,
        providerIdQueries: queryBaseline.providerIdQueries,
        idempotencyQueries: queryBaseline.idempotencyQueries + 1,
      })
    } finally {
      gate.release()
      await firstWorker
    }
    expect(await db.selectFrom('supplier_api_delivery_operations').selectAll().where('id', '=', leasedOperationId).executeTakeFirstOrThrow()).toEqual(persisted)
    expect((await db.selectFrom('supplier_api_delivery_events').select('id').where('operation_id', '=', leasedOperationId).execute()).length).toBe(eventCount)
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
    for (const mode of ['identity_mismatch', 'wrong_amount', 'wrong_quantity', 'wrong_operation', 'wrong_idempotency', 'wrong_currency'] as const) {
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


async function configureFixed(catalog: Catalog, admin: Admin, method: 'fixed_content' | 'link') {
  const { encryptFixedDeliveryPayload, fixedDeliveryPayloadDigest, fixedDeliveryVersionContext } = await import('../src/commerce/fixed-delivery-crypto.js')
  const id = randomUUID()
  const payload = method === 'fixed_content' ? { method, content: 'private mixed-order text' }
    : { method, url: 'https://delivery.example/never-fetched', title: 'private mixed-order link', accessInstructions: null }
  const envelope = encryptFixedDeliveryPayload(config, fixedDeliveryVersionContext(catalog.skuId, id, method), payload)
  await db.transaction().execute(async trx => {
    await trx.insertInto('product_variant_fulfillment_versions').values({ id, product_variant_id: catalog.skuId, version_number: 1, method,
      encrypted_content: envelope.ciphertext, content_nonce: envelope.nonce, content_auth_tag: envelope.authTag,
      encryption_key_id: envelope.keyId, content_sha256: fixedDeliveryPayloadDigest(config, payload), created_by_admin_id: admin.id }).execute()
    await trx.updateTable('product_variant_fulfillment').set({ method, current_content_version_id: id, automatic_delivery_ready: true,
      manual_delivery_ready: false }).where('product_variant_id', '=', catalog.skuId).execute()
  })
}

async function configurePool(catalog: Catalog, admin: Admin, count = 5) {
  const base = `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/code-pool`
  const before = await db.selectFrom('product_variants').select(['revision', 'inventory_revision']).where('id', '=', catalog.skuId).executeTakeFirstOrThrow()
  expect((await inject({ method: 'PUT', url: `${base}/readiness`, headers: adminHeaders(admin), payload: {
    enabled: false, expectedSkuRevision: before.revision, expectedInventoryRevision: before.inventory_revision,
  } })).statusCode).toBe(200)
  const imported = await inject({ method: 'POST', url: `${base}/batches`, headers: adminHeaders(admin),
    payload: { operationId: randomUUID(), format: 'paste', sourceText: Array.from({ length: count }, (_, i) => `phase55-${catalog.skuId}-${i}`).join('\n') } })
  expect(imported.statusCode, imported.body).toBe(201)
  const sku = await db.selectFrom('product_variants').select(['revision', 'inventory_revision']).where('id', '=', catalog.skuId).executeTakeFirstOrThrow()
  const ready = await inject({ method: 'PUT', url: `${base}/readiness`, headers: adminHeaders(admin),
    payload: { enabled: true, expectedSkuRevision: sku.revision, expectedInventoryRevision: sku.inventory_revision } })
  expect(ready.statusCode, ready.body).toBe(200)
}

async function reconcileSkus(ids: string[]) {
  const query = await readFile(new URL('../../../scripts/reconcile-digital-fulfillment.sql', import.meta.url), 'utf8')
  return db.transaction().setIsolationLevel('repeatable read').execute(async trx => {
    await sql`SELECT set_config('aikayun.reconcile_skus', ${ids.join(',')}, true)`.execute(trx)
    return (await sql.raw(query).execute(trx)).rows
  })
}

async function paidApiOrder(mode = 'success') {
  supplierFixture.reset()
  const admin = await createAdmin()
  const customer = await createCustomer()
  const supplier = await createSupplier(admin)
  const catalog = await createCatalog('5.00')
  if (mode === 'manual') await db.updateTable('product_variant_fulfillment').set({ manual_delivery_ready: true }).where('product_variant_id', '=', catalog.skuId).execute()
  else {
    await saveApiVersion(catalog, admin, supplier, { mode, productId: `phase55-${randomUUID()}` })
    expect((await setApiReadiness(catalog, admin, true)).statusCode).toBe(200)
  }
  const created = await createOrder(customer, catalog, 1)
  expect(created.statusCode, created.body).toBe(201)
  const orderId = created.json().data.order.id as string
  const itemId = created.json().data.order.items[0].id as string
  const payment = await createPayment(orderId, customer)
  expect(payment.statusCode, payment.body).toBe(201)
  const paymentAttemptId = payment.json().data.attempt.id as string
  const paymentAttempt = await db.selectFrom('payment_attempts').select('merchant_order_no')
    .where('id', '=', paymentAttemptId).executeTakeFirstOrThrow()
  expect((await inject({ method: 'GET', url: callbackUrl(paymentFixture.setPaid(paymentAttempt.merchant_order_no!)) })).body).toBe('success')
  const receipt = await db.selectFrom('payment_receipts').selectAll().where('payment_attempt_id', '=', paymentAttemptId).executeTakeFirstOrThrow()
  return { admin, customer, supplier, catalog, orderId, itemId, paymentAttemptId, receipt }
}

async function recoverInRebuiltProcess() {
  const rebuilt = await startCrashProcess(config, 'none')
  try { await rebuilt.pass(); await rebuilt.pass(); await rebuilt.pass() } finally { await rebuilt.kill() }
}

async function assertPaidApiFacts(order: Awaited<ReturnType<typeof paidApiOrder>>, operationId: string) {
  await assertItemDelivered(order.orderId, order.itemId, 1)
  expect(await db.selectFrom('payment_receipts').selectAll().where('id', '=', order.receipt.id).executeTakeFirstOrThrow()).toEqual(order.receipt)
  expect((await pendingOperations(order.itemId)).map(row => row.id)).toEqual([operationId])
  expect(await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
    .where('product_variant_id', '=', order.catalog.skuId).executeTakeFirstOrThrow()).toEqual({ stocked: 19, reserved: 0 })
  expect(await db.selectFrom('order_inventory_events as event').innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
    .select(['event.action', 'event.quantity']).where('reservation.order_item_id', '=', order.itemId).orderBy('event.action').execute())
    .toEqual([{ action: 'consume', quantity: 1 }, { action: 'reserve', quantity: 1 }])
}

describe('⑤-5 real SIGKILL and cross-module database acceptance', () => {
  for (const checkpoint of ['operation_committed', 'lease_committed', 'response_received', 'result_committed']) {
    it(`SIGKILL at ${checkpoint} preserves payment and the original operation across service rebuild`, async () => {
      const order = await paidApiOrder()
      const process = await startCrashProcess(config, checkpoint)
      let operationId: string
      try {
        process.run()
        expect(await process.waitFor('checkpoint')).toBe(checkpoint)
        const operation = (await pendingOperations(order.itemId))[0]!
        operationId = operation.id
        expect(operation.state).toBe(checkpoint === 'operation_committed' ? 'create_pending'
          : checkpoint === 'result_committed' ? 'succeeded_pending_finalize' : 'create_in_flight')
        expect(supplierFixture.stats().executions).toBe(['operation_committed', 'lease_committed'].includes(checkpoint) ? 0 : 1)
        await process.kill()
        if (operation.state === 'create_in_flight') await db.updateTable('supplier_api_delivery_operations')
          .set({ lease_expires_at: new Date(0) }).where('id', '=', operationId).execute()
      } finally { await process.kill() }
      await recoverInRebuiltProcess()
      await assertPaidApiFacts(order, operationId!)
      expect(supplierFixture.stats()).toMatchObject({ createRequests: 1, executions: 1 })
    }, 30_000)
  }

  it('SIGKILL after API final delivery and inventory commit cannot finalize that unit twice', async () => {
    const order = await paidApiOrder()
    await runDigitalDeliveryRecoveryPass(db, config)
    const operationId = (await pendingOperations(order.itemId))[0]!.id
    const process = await startCrashProcess(config, 'delivery_committed')
    try { process.run(); await process.waitFor('checkpoint'); await process.kill() }
    finally { await process.kill() }
    await recoverInRebuiltProcess()
    await assertPaidApiFacts(order, operationId)
    expect(supplierFixture.stats()).toMatchObject({ createRequests: 1, executions: 1 })
  }, 30_000)

  it('SIGKILL after supplier execution before HTTP response queries the original key without another execution', async () => {
    const order = await paidApiOrder()
    const process = await startCrashProcess(config, 'none')
    const gate = supplierFixture.pauseNextCreateResponse()
    let operationId: string
    try {
      process.run()
      await gate.entered
      const operation = (await pendingOperations(order.itemId))[0]!
      operationId = operation.id
      expect(operation.state).toBe('create_in_flight')
      expect(supplierFixture.stats().executions).toBe(1)
      await process.kill()
      await db.updateTable('supplier_api_delivery_operations').set({ lease_expires_at: new Date(0) }).where('id', '=', operationId).execute()
    } finally { gate.release(); await process.kill() }
    await recoverInRebuiltProcess()
    await assertPaidApiFacts(order, operationId!)
    expect(supplierFixture.stats()).toMatchObject({ createRequests: 1, executions: 1 })
    expect(supplierFixture.stats().idempotencyQueries).toBeGreaterThan(1)
  }, 30_000)

  it('serializes duplicate supplier codes across different SKUs and different active encryption keys', async () => {
    supplierFixture.reset()
    const admin = await createAdmin()
    const customer = await createCustomer()
    const supplier = await createSupplier(admin)
    const productId = `rotation-duplicate-${randomUUID()}`
    const orders = []
    for (let index = 0; index < 2; index++) {
      const catalog = await createCatalog('0.00', 'unlimited')
      await saveApiVersion(catalog, admin, supplier, { productId, mode: 'duplicate' })
      expect((await setApiReadiness(catalog, admin, true)).statusCode).toBe(200)
      const created = await createOrder(customer, catalog, 1)
      orders.push({ orderId: created.json().data.order.id as string, itemId: created.json().data.order.items[0].id as string })
    }
    await runDigitalDeliveryRecoveryPass(db, config)
    const ids = await Promise.all(orders.map(async order => (await pendingOperations(order.itemId))[0]!.id))
    const ring = config.codePoolEncryptionKeyRing!
    const keys = { ...ring.keys, 'rotation-v2': randomBytes(32) }
    const first = await startCrashProcess({ ...config, codePoolEncryptionKeyRing: { activeKeyId: ring.activeKeyId, keys } }, 'duplicate_checked', ids[0])
    const second = await startCrashProcess({ ...config, codePoolEncryptionKeyRing: { activeKeyId: 'rotation-v2', keys } }, 'none', ids[1])
    try {
      first.run()
      await first.waitFor('checkpoint')
      second.run()
      // Wait for either the second contender's advisory wait or its committed
      // delivery. This is a database-observed interleaving, not a guessed delay.
      await expect.poll(async () => {
        const waiting = await sql<{ count: number }>`SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE application_name = 'aikayun-phase55-crash-test' AND wait_event = 'advisory'`.execute(db)
        const delivered = await db.selectFrom('order_item_fulfillment_deliveries').select('id').where('supplier_api_operation_id', '=', ids[1]!).execute()
        return waiting.rows[0]!.count > 0 || delivered.length > 0
      }, { timeout: 5000, intervals: [10, 25, 50] }).toBe(true)
      first.child.send('resume')
      await first.waitFor('done')
      await second.waitFor('done')
      const deliveries = await db.selectFrom('order_item_fulfillment_deliveries').select('id').where('supplier_api_operation_id', 'in', ids).execute()
      expect(deliveries).toHaveLength(1)
      expect((await db.selectFrom('supplier_api_delivery_operations').select('state').where('id', 'in', ids).execute()).map(row => row.state).sort())
        .toEqual(['manual_review', 'succeeded'])
    } finally { first.child.send('resume'); await Promise.all([first.kill(), second.kill()]) }
  }, 30_000)

  it('fails closed before another supplier create if a historical fingerprint key is missing', async () => {
    supplierFixture.reset()
    const admin = await createAdmin()
    const customer = await createCustomer()
    const supplier = await createSupplier(admin)
    const productId = `missing-history-key-${randomUUID()}`
    const firstCatalog = await createCatalog('0.00', 'unlimited')
    await saveApiVersion(firstCatalog, admin, supplier, { productId, mode: 'duplicate' })
    expect((await setApiReadiness(firstCatalog, admin, true)).statusCode).toBe(200)
    const firstOrder = await createOrder(customer, firstCatalog, 1)
    await runDigitalDeliveryRecoveryPass(db, config)
    await runDigitalDeliveryRecoveryPass(db, config)
    expect(firstOrder.statusCode).toBe(201)
    const secondCatalog = await createCatalog('0.00', 'unlimited')
    await saveApiVersion(secondCatalog, admin, supplier, { productId, mode: 'duplicate' })
    expect((await setApiReadiness(secondCatalog, admin, true)).statusCode).toBe(200)
    const created = await createOrder(customer, secondCatalog, 1)
    const itemId = created.json().data.order.items[0].id as string
    const retained = config.codePoolEncryptionKeyRing!
    retained.keys['history-key-v2'] = randomBytes(32)
    try {
      config.codePoolEncryptionKeyRing = { activeKeyId: 'history-key-v2', keys: { 'history-key-v2': retained.keys['history-key-v2']! } }
      await runDigitalDeliveryRecoveryPass(db, config)
      expect(supplierFixture.stats().createRequests).toBe(1)
      expect(await pendingOperations(itemId)).toEqual([])
      const failure = await db.selectFrom('order_item_fulfillment_attempts').select(['failure_code', 'retry_after']).where('order_item_id', '=', itemId).executeTakeFirstOrThrow()
      expect(failure.failure_code).toBe('API_DELIVERY_KEY_UNAVAILABLE')
      expect(failure.retry_after!.getTime()).toBeGreaterThan(Date.now())
      config.codePoolEncryptionKeyRing = retained
      await db.updateTable('order_item_fulfillment_attempts').set({ retry_after: new Date() }).where('order_item_id', '=', itemId).execute()
      await recoverInRebuiltProcess()
      expect((await pendingOperations(itemId))[0]!.state).toBe('manual_review')
      expect(supplierFixture.stats().createRequests).toBe(2)
    } finally { config.codePoolEncryptionKeyRing = retained }
  }, 30_000)

  it('does not starve a newer order behind twenty payment-protected API items', async () => {
    const blocked = []
    for (let index = 0; index < 20; index++) {
      const order = await paidApiOrder()
      const event = await db.selectFrom('payment_provider_events').select('id').where('payment_attempt_id', '=', order.paymentAttemptId).executeTakeFirstOrThrow()
      await db.insertInto('payment_provider_reconciliation_cases').values({
        id: randomUUID(), payment_attempt_id: order.paymentAttemptId, reason: 'provider_identity_conflict', opening_callback_event_id: event.id,
      }).execute()
      blocked.push(order)
    }
    const healthy = await paidApiOrder()
    await runDigitalDeliveryRecoveryPass(db, config)
    await runDigitalDeliveryRecoveryPass(db, config)
    await assertItemDelivered(healthy.orderId, healthy.itemId, 1)
    for (const order of blocked) expect(await pendingOperations(order.itemId)).toEqual([])
    expect(supplierFixture.stats().executions).toBe(1)
  }, 30_000)

  it('keeps database delivery progressing while a supplier HTTP response is held', async () => {
    const apiOrder = await paidApiOrder()
    const gate = supplierFixture.pauseNextCreateResponse()
    const stop = startDigitalDeliveryWorker(db, config, app.log)
    try {
      await gate.entered
      const catalog = await createCatalog()
      await db.updateTable('product_variant_fulfillment').set({ manual_delivery_ready: true }).where('product_variant_id', '=', catalog.skuId).execute()
      const fixedVersionId = randomUUID()
      const { encryptFixedDeliveryPayload, fixedDeliveryPayloadDigest, fixedDeliveryVersionContext } = await import('../src/commerce/fixed-delivery-crypto.js')
      const payload = { method: 'fixed_content' as const, content: 'independent local delivery' }
      const envelope = encryptFixedDeliveryPayload(config, fixedDeliveryVersionContext(catalog.skuId, fixedVersionId, 'fixed_content'), payload)
      await db.transaction().execute(async trx => {
        await trx.insertInto('product_variant_fulfillment_versions').values({
          id: fixedVersionId, product_variant_id: catalog.skuId, version_number: 1, method: 'fixed_content',
          encrypted_content: envelope.ciphertext, content_nonce: envelope.nonce, content_auth_tag: envelope.authTag,
          encryption_key_id: envelope.keyId, content_sha256: fixedDeliveryPayloadDigest(config, payload), created_by_admin_id: apiOrder.admin.id,
        }).execute()
        await trx.updateTable('product_variant_fulfillment').set({ method: 'fixed_content', manual_delivery_ready: false,
          current_content_version_id: fixedVersionId, automatic_delivery_ready: true }).where('product_variant_id', '=', catalog.skuId).execute()
      })
      const created = await createOrder(apiOrder.customer, catalog, 1)
      const id = created.json().data.order.id as string
      await expect.poll(async () => (await db.selectFrom('orders').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status,
        { timeout: 3000, intervals: [10, 25, 50] }).toBe('completed')
      expect((await pendingOperations(apiOrder.itemId))[0]!.state).toBe('create_in_flight')
    } finally { gate.release(); await stop() }
    await recoverInRebuiltProcess()
  }, 30_000)

  it('keeps a successful supplier operation unknown while the result key is unavailable and queries it without re-execution', async () => {
    const order = await paidApiOrder()
    const gate = supplierFixture.pauseNextCreateResponse()
    const savedRing = config.codePoolEncryptionKeyRing
    const pass = runDigitalDeliveryRecoveryPass(db, config)
    try {
      await gate.entered
      config.codePoolEncryptionKeyRing = undefined
      gate.release()
      await pass
      const operation = (await pendingOperations(order.itemId))[0]!
      expect(operation).toMatchObject({ state: 'unknown', attempt_status: 'unknown' })
      expect(await db.selectFrom('payment_receipts').selectAll().where('id', '=', order.receipt.id).executeTakeFirstOrThrow()).toEqual(order.receipt)
      config.codePoolEncryptionKeyRing = savedRing
      await db.updateTable('supplier_api_delivery_operations').set({ next_action_at: new Date() }).where('id', '=', operation.id).execute()
      await recoverInRebuiltProcess()
      await assertPaidApiFacts(order, operation.id)
      expect(supplierFixture.stats()).toMatchObject({ createRequests: 1, executions: 1 })
    } finally { config.codePoolEncryptionKeyRing = savedRing; gate.release(); await pass }
  }, 30_000)

  it('preserves a previously confirmed provider identity when its status endpoint later reports not_found', async () => {
    const order = await paidApiOrder('accepted')
    await runDigitalDeliveryRecoveryPass(db, config)
    const operation = (await pendingOperations(order.itemId))[0]!
    const before = await db.selectFrom('supplier_api_delivery_operations').selectAll().where('id', '=', operation.id).executeTakeFirstOrThrow()
    expect(before.provider_operation_id).toBeTruthy()
    supplierFixture.reset()
    await db.updateTable('supplier_api_delivery_operations').set({ next_action_at: new Date() }).where('id', '=', operation.id).execute()
    await runDigitalDeliveryRecoveryPass(db, config)
    const after = await db.selectFrom('supplier_api_delivery_operations').selectAll().where('id', '=', operation.id).executeTakeFirstOrThrow()
    expect(after).toMatchObject({ state: 'manual_review', provider_operation_id: before.provider_operation_id, last_error_code: 'supplier_known_operation_not_found' })
    expect(supplierFixture.stats().createRequests).toBe(0)
    for (const action of ['query', 'retry']) {
      const url = `/api/v1/admin/orders/${order.orderId}/supplier-operations/${operation.id}/${action}`
      expect((await inject({ method: 'POST', url })).statusCode).toBe(401)
      expect((await inject({ method: 'POST', url, headers: { origin, cookie: order.admin.cookie } })).statusCode).toBe(403)
      expect((await inject({ method: 'POST', url, headers: { ...adminHeaders(order.admin), origin: 'https://attacker.example' } })).statusCode).toBe(403)
      expect((await inject({ method: 'POST', url, headers: { cookie: order.customer.cookie } })).statusCode).toBe(401)
    }
    const retry = await inject({ method: 'POST', url: `/api/v1/admin/orders/${order.orderId}/supplier-operations/${operation.id}/retry`, headers: adminHeaders(order.admin) })
    expect(retry.statusCode).toBe(409)
    expect(await db.selectFrom('supplier_api_operations_admin_audit').select('id').where('operation_id', '=', operation.id).execute()).toEqual([])
    const authorized = await inject({ method: 'POST', url: `/api/v1/admin/orders/${order.orderId}/supplier-operations/${operation.id}/query`, headers: adminHeaders(order.admin) })
    expect(authorized.statusCode, authorized.body).toBe(200)
    expect(await db.selectFrom('supplier_api_operations_admin_audit').select(['administrator_id', 'action']).where('operation_id', '=', operation.id).execute())
      .toEqual([{ administrator_id: order.admin.id, action: 'query_requested' }])
    await runDigitalDeliveryRecoveryPass(db, config)
    expect((await pendingOperations(order.itemId))[0]!.state).toBe('manual_review')
  }, 30_000)

  for (const mode of ['http_429', 'http_500', 'interrupted']) {
    it(`preserves payment and backs off ${mode} without creating a new supplier operation`, async () => {
      const order = await paidApiOrder(mode)
      await runDigitalDeliveryRecoveryPass(db, config)
      const operation = (await pendingOperations(order.itemId))[0]!
      expect(operation).toMatchObject({ state: 'unknown', attempt_status: 'unknown' })
      const saved = await db.selectFrom('supplier_api_delivery_operations').selectAll().where('id', '=', operation.id).executeTakeFirstOrThrow()
      expect(saved.next_action_at!.getTime()).toBeGreaterThan(Date.now())
      await runDigitalDeliveryRecoveryPass(db, config)
      expect(supplierFixture.stats()).toMatchObject({ createRequests: 1, executions: 1 })
      await db.updateTable('supplier_api_delivery_operations').set({ next_action_at: new Date() }).where('id', '=', operation.id).execute()
      await recoverInRebuiltProcess()
      await assertPaidApiFacts(order, operation.id)
      expect(supplierFixture.stats()).toMatchObject({ createRequests: 1, executions: 1 })
    }, 30_000)
  }

  it('rejects direct SQL mutation of a persisted supplier unit identity', async () => {
    const order = await paidApiOrder()
    await runDigitalDeliveryRecoveryPass(db, config)
    const operation = (await pendingOperations(order.itemId))[0]!
    await expect(db.updateTable('supplier_api_delivery_operations').set({ unit_index: 2 }).where('id', '=', operation.id).execute())
      .rejects.toMatchObject({ code: '23514' })
    await runDigitalDeliveryRecoveryPass(db, config)
    await assertPaidApiFacts(order, operation.id)
  })

  it('rejects direct SQL duplicate units across manual attempts and terminal history appends', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog()
    await db.updateTable('product_variant_fulfillment').set({ manual_delivery_ready: true }).where('product_variant_id', '=', catalog.skuId).execute()
    const created = await createOrder(customer, catalog, 2)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    const first = await inject({ method: 'POST', url: `/api/v1/admin/orders/${orderId}/items/${itemId}/fulfillments`,
      headers: adminHeaders(admin), payload: { operationId: randomUUID(), deliveries: [{ content: 'manual-unit-one' }] } })
    expect(first.statusCode, first.body).toBe(200)
    const delivery = await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .selectAll('delivery').where('attempt.order_item_id', '=', itemId).executeTakeFirstOrThrow()
    const rejectsWrite = async (terminal: boolean) => db.transaction().execute(async trx => {
      const attemptId = terminal ? delivery.fulfillment_attempt_id : randomUUID()
      if (!terminal) await trx.insertInto('order_item_fulfillment_attempts').values({
        id: attemptId, order_item_id: itemId, operation_id: randomUUID(), quantity: 1, started_by_admin_id: admin.id,
      }).execute()
      await trx.insertInto('order_item_fulfillment_deliveries').values({ ...delivery, id: randomUUID(),
        fulfillment_attempt_id: attemptId, unit_index: terminal ? 2 : 1 }).execute()
    })
    await expect(rejectsWrite(false)).rejects.toMatchObject({ code: '23514' })
    await expect(rejectsWrite(true)).rejects.toMatchObject({ code: '23514' })
  })
  it('rejects direct SQL appending delivery content to a terminal attempt', async () => {
    const order = await paidApiOrder()
    await runDigitalDeliveryRecoveryPass(db, config)
    await runDigitalDeliveryRecoveryPass(db, config)
    const operation = (await pendingOperations(order.itemId))[0]!
    const delivery = await db.selectFrom('order_item_fulfillment_deliveries').selectAll()
      .where('supplier_api_operation_id', '=', operation.id).executeTakeFirstOrThrow()
    await expect(db.insertInto('order_item_fulfillment_deliveries').values({ ...delivery, id: randomUUID(), unit_index: 2 }).execute())
      .rejects.toMatchObject({ code: '23514' })
  })

  it('rechecks the attempt after a direct SQL delivery insert waits for the order lock', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog()
    await db.updateTable('product_variant_fulfillment').set({ manual_delivery_ready: true }).where('product_variant_id', '=', catalog.skuId).execute()
    const created = await createOrder(customer, catalog, 2)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    const attemptId = randomUUID()
    await db.insertInto('order_item_fulfillment_attempts').values({ id: attemptId, order_item_id: itemId,
      operation_id: randomUUID(), quantity: 1, started_by_admin_id: admin.id }).execute()
    let lockReady!: () => void
    let releaseLock!: () => void
    const ready = new Promise<void>(resolve => { lockReady = resolve })
    const release = new Promise<void>(resolve => { releaseLock = resolve })
    const finishing = db.transaction().execute(async trx => {
      await trx.selectFrom('orders').select('id').where('id', '=', orderId).forUpdate().execute()
      lockReady()
      await release
      await trx.updateTable('order_item_fulfillment_attempts').set({ status: 'failed' }).where('id', '=', attemptId).execute()
    })
    await ready
    let insertReady!: (pid: number) => void
    const insertingPid = new Promise<number>(resolve => { insertReady = resolve })
    const inserting = db.connection().execute(async connection => {
      const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(connection)
      insertReady(pid.rows[0]!.pid)
      return await connection.insertInto('order_item_fulfillment_deliveries').values({ id: randomUUID(),
        fulfillment_attempt_id: attemptId, started_by_admin_id: admin.id, unit_index: 1,
        content: 'must not append after attempt ends during lock wait', content_sha256: 'a'.repeat(64) }).execute()
    }).then(() => ({ code: 'accepted', constraint: '' }), (error: { code: string; constraint: string }) => error)
    try {
      const pid = await insertingPid
      const deadline = Date.now() + 5_000
      let waiting = false
      while (Date.now() < deadline) {
        const activity = await sql<{ waiting: boolean }>`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${pid}`.execute(db)
        if (activity.rows[0]?.waiting) { waiting = true; break }
        await new Promise<void>(resolve => { setImmediate(resolve) })
      }
      expect(waiting, 'insert must reach the real PostgreSQL order-lock barrier').toBe(true)
    } finally { releaseLock(); await finishing }
    expect(await inserting).toMatchObject({ code: '23514', constraint: 'digital_delivery_unit_invalid' })
    expect(await db.selectFrom('order_item_fulfillment_deliveries').select('id').where('fulfillment_attempt_id', '=', attemptId).execute()).toEqual([])
  })
})


describe('⑤-5 mixed digital orders and transactional rollback', () => {
  for (const inventoryMode of ['quantity', 'unlimited'] as const) {
    it(`completes all six methods in one ${inventoryMode} order, retains refund history and reconciles every unit`, async () => {
      supplierFixture.reset()
      const admin = await createAdmin()
      const customer = await createCustomer()
      const supplier = await createSupplier(admin)
      const catalogs = new Map<string, Catalog>()
      for (const method of ['manual', 'code_pool', 'fixed_content', 'link', 'file', 'api']) {
        const catalog = await createCatalog('1.00', method === 'code_pool' ? 'quantity' : inventoryMode, 0)
        catalogs.set(method, catalog)
        if (catalog.mode === 'quantity' && method !== 'code_pool') {
          const sku = await db.selectFrom('product_variants').select('inventory_revision').where('id', '=', catalog.skuId).executeTakeFirstOrThrow()
          const replenished = await inject({ method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/inventory/adjustments`,
            headers: adminHeaders(admin), payload: { operationId: randomUUID(), expectedInventoryRevision: sku.inventory_revision,
              action: 'increase', quantity: 5, reason: 'isolated phase55 opening stock' } })
          expect(replenished.statusCode, replenished.body).toBe(201)
        }
        if (method === 'manual') await db.updateTable('product_variant_fulfillment').set({ manual_delivery_ready: true }).where('product_variant_id', '=', catalog.skuId).execute()
        else if (method === 'code_pool') await configurePool(catalog, admin)
        else if (method === 'fixed_content' || method === 'link') await configureFixed(catalog, admin, method)
        else if (method === 'api') {
          await saveApiVersion(catalog, admin, supplier, { productId: `mixed-${randomUUID()}` })
          expect((await setApiReadiness(catalog, admin, true)).statusCode).toBe(200)
        } else {
          const root = `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/private-files`
          const boundary = `phase55-${randomUUID()}`
          const upload = await inject({ method: 'POST', url: `${root}/uploads`, headers: { ...adminHeaders(admin), 'content-type': `multipart/form-data; boundary=${boundary}` },
            payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="mixed.txt"\r\nContent-Type: text/plain\r\n\r\nprivate mixed file\r\n--${boundary}--\r\n`) })
          expect(upload.statusCode, upload.body).toBe(201)
          const current = await inject({ method: 'GET', url: root, headers: { cookie: admin.cookie } })
          const saved = await inject({ method: 'POST', url: `${root}/versions`, headers: adminHeaders(admin), payload: {
            expectedRevision: current.json().data.configurationRevision, uploadId: upload.json().data.uploadId, displayFilename: 'mixed.txt' } })
          expect(saved.statusCode, saved.body).toBe(200)
          const ready = await inject({ method: 'PUT', url: `${root}/readiness`, headers: adminHeaders(admin),
            payload: { expectedRevision: saved.json().data.configurationRevision, enabled: true } })
          expect(ready.statusCode, ready.body).toBe(200)
        }
      }
      const items = [...catalogs.values()].map(catalog => ({ skuId: catalog.skuId, quantity: 2 }))
      const quoted = await inject({ method: 'POST', url: '/api/v1/checkout/quote', headers: customerHeaders(customer), payload: { items } })
      expect(quoted.json().data.canContinue, quoted.body).toBe(true)
      const created = await inject({ method: 'POST', url: '/api/v1/checkout/orders', headers: customerHeaders(customer),
        payload: { idempotencyKey: randomUUID(), quoteToken: quoted.json().data.quoteToken, items } })
      expect(created.statusCode, created.body).toBe(201)
      const orderId = created.json().data.order.id as string
      const skuIds = items.map(item => item.skuId)
      expect(await reconcileSkus(skuIds)).toEqual([])
      await runDigitalDeliveryRecoveryPass(db, config)
      expect(supplierFixture.stats().executions).toBe(0)
      const payment = await createPayment(orderId, customer)
      const attemptId = payment.json().data.attempt.id as string
      const merchantNo = (await db.selectFrom('payment_attempts').select('merchant_order_no').where('id', '=', attemptId).executeTakeFirstOrThrow()).merchant_order_no!
      expect((await inject({ method: 'GET', url: callbackUrl(paymentFixture.setPaid(merchantNo)) })).body).toBe('success')
      // Two independent API instances and two workers share the same database.
      const otherDb = createDatabase()
      const otherApp = await createApp({ db: otherDb, config, logger: false })
      try {
        for (let round = 0; round < 10; round++) {
          await Promise.all([runDigitalDeliveryRecoveryPass(db, config), runDigitalDeliveryRecoveryPass(otherDb, config)])
          const remaining = await db.selectFrom('order_items').select('id').where('order_id', '=', orderId)
            .where('fulfillment_method_snapshot', '<>', 'manual').where('fulfilled_quantity', '<', 2).execute()
          if (!remaining.length) break
        }
        const partial = await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: customer.cookie } })
        expect(partial.json().data.status).toBe('processing')
        expect(partial.json().data.items.filter((item: { fulfillmentMethod: string }) => item.fulfillmentMethod !== 'manual')
          .every((item: { fulfilledQuantity: number }) => item.fulfilledQuantity === 2), partial.body).toBe(true)
        const manualItem = partial.json().data.items.find((item: { fulfillmentMethod: string }) => item.fulfillmentMethod === 'manual')
        const path = `/api/v1/admin/orders/${orderId}/items/${manualItem.id}/fulfillments`
        const firstBody = { operationId: randomUUID(), deliveries: [{ content: 'mixed manual first unit' }] }
        expect((await inject({ method: 'POST', url: path, headers: adminHeaders(admin), payload: firstBody })).json().data.order.status).toBe('processing')
        expect((await otherApp.inject({ method: 'POST', url: path, headers: adminHeaders(admin), payload: firstBody })).json().data.repeated).toBe(true)
        expect(await reconcileSkus(skuIds)).toEqual([])
        const complete = await inject({ method: 'POST', url: path, headers: adminHeaders(admin),
          payload: { operationId: randomUUID(), deliveries: [{ content: 'mixed manual second unit' }] } })
        expect(complete.json().data.order.status).toBe('completed')
        const histories = await db.selectFrom('order_item_fulfillment_deliveries as delivery')
          .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
          .innerJoin('order_items as item', 'item.id', 'attempt.order_item_id').selectAll('delivery').where('item.order_id', '=', orderId).orderBy('delivery.id').execute()
        expect(histories).toHaveLength(12)
        const refund = await inject({ method: 'POST', url: `/api/v1/customer/orders/${orderId}/refunds`, headers: customerHeaders(customer),
          payload: { idempotencyKey: randomUUID(), amount: '12.00', reason: 'phase55 historical delivery regression' } })
        expect(refund.statusCode, refund.body).toBe(201)
        const refundId = refund.json().data.refunds.items[0].id
        const approved = await inject({ method: 'POST', url: `/api/v1/admin/orders/${orderId}/refunds/${refundId}/approve`, headers: adminHeaders(admin),
          payload: { idempotencyKey: randomUUID() } })
        expect(approved.statusCode, approved.body).toBe(200)
        const fileItem = complete.json().data.order.items.find((item: { fulfillmentMethod: string }) => item.fulfillmentMethod === 'file')
        const historicalDownload = await inject({ method: 'GET', url: fileItem.deliveries[0].downloadUrl, headers: { cookie: customer.cookie } })
        expect(historicalDownload.statusCode, historicalDownload.body).toBe(200)
        expect(historicalDownload.rawPayload).toEqual(Buffer.from('private mixed file'))
        await runDigitalDeliveryRecoveryPass(db, config)
        expect(await db.selectFrom('order_item_fulfillment_deliveries').selectAll().where('id', 'in', histories.map(row => row.id)).orderBy('id').execute()).toEqual(histories)
        expect(await reconcileSkus(skuIds)).toEqual([])
        if (inventoryMode === 'quantity') {
          const switched = catalogs.get('fixed_content')!
          const sku = await db.selectFrom('product_variants').select('inventory_revision').where('id', '=', switched.skuId).executeTakeFirstOrThrow()
          const removed = await inject({ method: 'POST', url: `/api/v1/admin/products/${switched.productId}/variants/${switched.skuId}/inventory/adjustments`,
            headers: adminHeaders(admin), payload: { operationId: randomUUID(), expectedInventoryRevision: sku.inventory_revision,
              action: 'decrease', quantity: 3, reason: 'close remaining stock before switching to a code pool' } })
          expect(removed.statusCode, removed.body).toBe(201)
          await configurePool(switched, admin, 3)
          expect(await reconcileSkus(skuIds)).toEqual([])
          const historical = await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: customer.cookie } })
          expect(historical.json().data.items.find((item: { skuId: string }) => item.skuId === switched.skuId))
            .toMatchObject({ fulfillmentMethod: 'fixed_content', fulfilledQuantity: 2 })
          expect(await db.selectFrom('order_item_fulfillment_deliveries').selectAll().where('id', 'in', histories.map(row => row.id)).orderBy('id').execute()).toEqual(histories)
        }
        expect(supplierFixture.stats()).toMatchObject({ executions: 2, createRequests: 2 })
      } finally { await otherApp.close(); await otherDb.destroy() }
    }, 30_000)
  }

  it('redacts private delivery plaintext from unexpected PostgreSQL errors while retaining diagnostic codes', async () => {
    const order = await paidApiOrder('manual')
    const secret = 'phase55-private-delivery-never-log-this'
    await sql`ALTER TABLE order_item_fulfillment_deliveries ADD CONSTRAINT phase55_logging_failure CHECK (content IS DISTINCT FROM ${sql.lit(secret)})`.execute(db)
    const process = await startCrashProcess(config, 'capture_logs')
    try {
      const response = await fetch(`${process.origin}/api/v1/admin/orders/${order.orderId}/items/${order.itemId}/fulfillments`, {
        method: 'POST', headers: { ...adminHeaders(order.admin), 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: randomUUID(), deliveries: [{ content: secret }] }),
      })
      expect(response.status).toBe(500)
      expect(await response.text()).not.toContain(secret)
      await expect.poll(() => process.logs(), { timeout: 1000, intervals: [10, 20] }).toContain('request failed')
      expect(process.logs()).not.toContain(secret)
      expect(process.logs()).toContain('23514')
      expect(process.logs()).toContain('phase55_logging_failure')
    } finally {
      await process.kill()
      await sql`ALTER TABLE order_item_fulfillment_deliveries DROP CONSTRAINT phase55_logging_failure`.execute(db)
    }
  }, 30_000)

  it('blocks direct SQL manual success when reconciliation opens after delivery rows were prepared', async () => {
    const order = await paidApiOrder('manual')
    const id = randomUUID()
    await db.transaction().execute(async trx => {
      await trx.insertInto('order_item_fulfillment_attempts').values({ id, order_item_id: order.itemId, operation_id: randomUUID(), quantity: 1, started_by_admin_id: order.admin.id }).execute()
      await trx.insertInto('order_item_fulfillment_deliveries').values({ id: randomUUID(), fulfillment_attempt_id: id,
        started_by_admin_id: order.admin.id, unit_index: 1, content: 'prepared privately', content_sha256: 'a'.repeat(64) }).execute()
    })
    const event = await db.selectFrom('payment_provider_events').select('id').where('payment_attempt_id', '=', order.paymentAttemptId).executeTakeFirstOrThrow()
    await db.insertInto('payment_provider_reconciliation_cases').values({ id: randomUUID(), payment_attempt_id: order.paymentAttemptId,
      reason: 'provider_identity_conflict', opening_callback_event_id: event.id }).execute()
    await expect(db.updateTable('order_item_fulfillment_attempts').set({ status: 'succeeded', result_sha256: 'b'.repeat(64) }).where('id', '=', id).execute())
      .rejects.toMatchObject({ code: '23514', constraint: 'digital_delivery_payment_required' })
    expect(await db.selectFrom('payment_receipts').selectAll().where('id', '=', order.receipt.id).executeTakeFirstOrThrow()).toEqual(order.receipt)
  })

  it('SIGKILL after final manual delivery commit before HTTP response keeps receipt, inventory and idempotent replay', async () => {
    const order = await paidApiOrder('manual')
    const process = await startCrashProcess(config, 'delivery_committed')
    const payload = { operationId: randomUUID(), deliveries: [{ content: 'committed before lost HTTP response' }] }
    const path = `/api/v1/admin/orders/${order.orderId}/items/${order.itemId}/fulfillments`
    const request = fetch(`${process.origin}${path}`, { method: 'POST', headers: { ...adminHeaders(order.admin), 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(() => 'unexpected response', () => 'connection lost')
    try { expect(await process.waitFor('checkpoint')).toBe('delivery_committed'); await process.kill(); expect(await request).toBe('connection lost') }
    finally { await process.kill() }
    const rebuilt = await startCrashProcess(config, 'none')
    try {
      const replay = await fetch(`${rebuilt.origin}${path}`, { method: 'POST', headers: { ...adminHeaders(order.admin), 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      expect(replay.status).toBe(200)
      expect((await replay.json()).data).toMatchObject({ repeated: true, order: { status: 'completed' } })
      expect(await db.selectFrom('payment_receipts').selectAll().where('id', '=', order.receipt.id).executeTakeFirstOrThrow()).toEqual(order.receipt)
      expect(await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved']).where('product_variant_id', '=', order.catalog.skuId).executeTakeFirstOrThrow())
        .toEqual({ stocked: 19, reserved: 0 })
    } finally { await rebuilt.kill() }
  }, 30_000)

  it('SIGKILL rolls back real code reservation and delivery transactions without freeing delivered stock twice', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog('0.00', 'quantity', 0)
    await configurePool(catalog, admin, 3)
    const quoted = await quote(customer, catalog, 2)
    const payload = { idempotencyKey: randomUUID(), quoteToken: quoted.json().data.quoteToken, items: [{ skuId: catalog.skuId, quantity: 2 }] }
    const reservationProcess = await startCrashProcess(config, 'code_reserved_uncommitted')
    const lost = fetch(`${reservationProcess.origin}/api/v1/checkout/orders`, { method: 'POST', headers: { ...customerHeaders(customer), 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(() => false, () => true)
    try { await reservationProcess.waitFor('checkpoint'); await reservationProcess.kill(); expect(await lost).toBe(true) }
    finally { await reservationProcess.kill() }
    expect(await db.selectFrom('orders').select('id').where('idempotency_key', '=', payload.idempotencyKey).execute()).toEqual([])
    expect(await reconcileSkus([catalog.skuId])).toEqual([])
    const created = await inject({ method: 'POST', url: '/api/v1/checkout/orders', headers: customerHeaders(customer), payload })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    const deliveryProcess = await startCrashProcess(config, 'delivery_uncommitted')
    try { deliveryProcess.run(); await deliveryProcess.waitFor('checkpoint'); await deliveryProcess.kill() }
    finally { await deliveryProcess.kill() }
    expect(await db.selectFrom('order_item_fulfillment_attempts').select('id').where('order_item_id', '=', itemId).execute()).toEqual([])
    expect(await reconcileSkus([catalog.skuId])).toEqual([])
    await recoverInRebuiltProcess()
    await assertItemDelivered(id, itemId, 2)
    expect(await reconcileSkus([catalog.skuId])).toEqual([])
    expect((await db.selectFrom('code_pool_entries').select('state').where('product_variant_id', '=', catalog.skuId).execute()).map(row => row.state).sort())
      .toEqual(['available', 'delivered', 'delivered'])
  }, 30_000)
})


describe('⑤-5 bounded worker backlog', () => {
  it('drains one hundred pending fixed deliveries through two workers without deadlocks or leaked transactions', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog('0.00', 'unlimited')
    await configureFixed(catalog, admin, 'fixed_content')
    const ids: string[] = []
    for (let index = 0; index < 100; index++) {
      const created = await createOrder(customer, catalog, 1)
      expect(created.statusCode, created.body).toBe(201)
      ids.push(created.json().data.order.id as string)
    }
    const otherDb = createDatabase()
    const before = await sql<{ deadlocks: string }>`SELECT deadlocks::text FROM pg_stat_database WHERE datname = current_database()`.execute(db)
    const startedAt = performance.now()
    let rounds = 0
    try {
      while (rounds < 10) {
        rounds++
        await Promise.all([runDigitalDeliveryRecoveryPass(db, config), runDigitalDeliveryRecoveryPass(otherDb, config)])
        const remaining = await db.selectFrom('orders').select('id').where('id', 'in', ids).where('status', '<>', 'completed').execute()
        if (!remaining.length) break
      }
      expect(await db.selectFrom('orders').select('id').where('id', 'in', ids).where('status', '=', 'completed').execute()).toHaveLength(100)
      expect(await reconcileSkus([catalog.skuId])).toEqual([])
      const after = await sql<{ deadlocks: string }>`SELECT deadlocks::text FROM pg_stat_database WHERE datname = current_database()`.execute(db)
      expect(after.rows[0]!.deadlocks).toBe(before.rows[0]!.deadlocks)
      const idle = await sql<{ count: number }>`SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE application_name = 'aikayun-api' AND state = 'idle in transaction'`.execute(db)
      expect(idle.rows[0]!.count).toBe(0)
      const measurement = { benchmark: 'two-worker-backlog', orders: ids.length, rounds,
        elapsedMs: Math.round(performance.now() - startedAt), deadlocks: 0, idleTransactions: 0 }
      if (process.env.AIKAYUN_ACCEPTANCE_OUTPUT) await appendFile(process.env.AIKAYUN_ACCEPTANCE_OUTPUT, `${JSON.stringify(measurement)}\n`)
    } finally { await otherDb.destroy() }
  }, 30_000)
})


describe('⑤-5 refund and in-flight supplier crossing', () => {
  it('blocks refund requests while supplier execution is in-flight or unknown', async () => {
    const order = await paidApiOrder()
    const gate = supplierFixture.pauseNextCreateResponse()
    const pass = runDigitalDeliveryRecoveryPass(db, config)
    try {
      await gate.entered
      const refund = await inject({ method: 'POST', url: `/api/v1/customer/orders/${order.orderId}/refunds`, headers: customerHeaders(order.customer),
        payload: { idempotencyKey: randomUUID(), amount: '5.00', reason: 'supplier execution is not yet confirmed locally' } })
      expect(refund.statusCode, refund.body).toBe(409)
      const operation = (await pendingOperations(order.itemId))[0]!
      await expect(db.insertInto('order_refunds').values({ id: randomUUID(), order_id: order.orderId, idempotency_key: randomUUID(),
        request_sha256: 'a'.repeat(64), amount: '5.00', reason: 'direct SQL must respect supplier uncertainty' }).execute())
        .rejects.toMatchObject({ code: '23514', constraint: 'order_refund_fulfillment_unresolved' })
      expect(operation.state).toBe('create_in_flight')
    } finally { gate.release(); await pass }
    await recoverInRebuiltProcess()
  }, 30_000)

  it('does not begin new fulfillment after a full refund and releases only unused stock on safe closure', async () => {
    const order = await paidApiOrder()
    const refund = await inject({ method: 'POST', url: `/api/v1/customer/orders/${order.orderId}/refunds`, headers: customerHeaders(order.customer),
      payload: { idempotencyKey: randomUUID(), amount: '5.00', reason: 'refund before any external operation is submitted' } })
    expect(refund.statusCode, refund.body).toBe(201)
    const approved = await inject({ method: 'POST', url: `/api/v1/admin/orders/${order.orderId}/refunds/${refund.json().data.refunds.items[0].id}/approve`,
      headers: adminHeaders(order.admin), payload: { idempotencyKey: randomUUID() } })
    expect(approved.statusCode, approved.body).toBe(200)
    await runDigitalDeliveryRecoveryPass(db, config)
    await runDigitalDeliveryRecoveryPass(db, config)
    expect(supplierFixture.stats().createRequests).toBe(0)
    expect(await pendingOperations(order.itemId)).toEqual([])
    await db.updateTable('orders').set({ status: 'closed' }).where('id', '=', order.orderId).execute()
    await db.updateTable('orders').set({ status: 'closed' }).where('id', '=', order.orderId).execute()
    const receipt = await db.selectFrom('payment_receipts').selectAll().where('id', '=', order.receipt.id).executeTakeFirstOrThrow()
    expect(receipt).toMatchObject({ amount: '5.00', refunded_amount: '5.00', refund_reserved_amount: '0.00' })
    expect(await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved']).where('product_variant_id', '=', order.catalog.skuId).executeTakeFirstOrThrow())
      .toEqual({ stocked: 20, reserved: 0 })
  }, 30_000)
})


describe('⑤-5 multiple rejected supplier units', () => {
  it('retries any explicitly rejected unit once, queues replay idempotently and rejects replay after replacement', async () => {
    supplierFixture.reset()
    const admin = await createAdmin()
    const customer = await createCustomer()
    const supplier = await createSupplier(admin)
    const catalog = await createCatalog('0.00', 'quantity', 5)
    await saveApiVersion(catalog, admin, supplier, { productId: `multi-reject-${randomUUID()}`, mode: 'two_rejected_once' })
    expect((await setApiReadiness(catalog, admin, true)).statusCode).toBe(200)
    const created = await createOrder(customer, catalog, 2)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    await runDigitalDeliveryRecoveryPass(db, config)
    const rejected = await db.selectFrom('supplier_api_delivery_operations as operation')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'operation.fulfillment_attempt_id')
      .select(['operation.id', 'operation.unit_index', 'operation.state']).where('attempt.order_item_id', '=', itemId)
      .orderBy('attempt.created_at').orderBy('attempt.id').execute()
    expect(rejected.map(row => row.state)).toEqual(['failed', 'failed'])
    const retry = (id: string) => inject({ method: 'POST', url: `/api/v1/admin/orders/${orderId}/supplier-operations/${id}/retry`, headers: adminHeaders(admin) })
    expect((await retry(rejected[0]!.id)).statusCode).toBe(200)
    expect((await retry(rejected[0]!.id)).statusCode).toBe(200)
    const staleWorker = await startCrashProcess(config, 'candidate_selected')
    try {
      staleWorker.run()
      await staleWorker.waitFor('checkpoint')
      await runDigitalDeliveryRecoveryPass(db, config)
      await runDigitalDeliveryRecoveryPass(db, config)
      staleWorker.child.send('resume')
      await staleWorker.waitFor('done')
    } finally { staleWorker.child.send('resume'); await staleWorker.kill() }
    expect(supplierFixture.stats().createRequests).toBe(3)
    const consumedReplay = await retry(rejected[0]!.id)
    expect(consumedReplay.statusCode, consumedReplay.body).toBe(409)
    expect(await db.selectFrom('supplier_api_operations_admin_audit').select('id').where('operation_id', '=', rejected[0]!.id).where('action', '=', 'retry_requested').execute()).toHaveLength(1)
    expect((await retry(rejected[1]!.id)).statusCode).toBe(200)
    await recoverInRebuiltProcess()
    await assertItemDelivered(orderId, itemId, 2)
    expect(supplierFixture.stats()).toMatchObject({ createRequests: 4, executions: 2 })
    expect(await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved']).where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow())
      .toEqual({ stocked: 3, reserved: 0 })
  }, 30_000)
})
