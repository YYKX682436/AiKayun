import { randomUUID, createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { hashPassword } from '../src/auth/password.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { createDatabase } from '../src/db/pool.js'
import type { Database } from '../src/db/types.js'
import { createZpaySignature } from '../src/payments/zpay-epay.js'
import { expireDueUnpaidOrders } from '../src/commerce/orders.js'
import { startZpayHttpFixture } from './fixtures/zpay-http-server.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? 'postgresql://aikayun:local-test-password@127.0.0.1:5432/aikayun_test'
const testOrigin = 'http://localhost:3000'
const adminPassword = 'Payments-Integration-Password-2026!'
const customerPassword = 'Payments-Customer-Password-2026!'
const digest = 'a'.repeat(64)
const merchantId = 'fixture-merchant-001'
const merchantKey = 'fixture-only-merchant-secret-never-returned'
const encryptionKeyA = randomBytes(32)
const encryptionKeyB = randomBytes(32)

let app: FastifyInstance
let secondApp: FastifyInstance
let db: Kysely<Database>
let secondDb: Kysely<Database>
let config: ReturnType<typeof readConfig>
let fixture: Awaited<ReturnType<typeof startZpayHttpFixture>>
let api2BaseUrl: string
let nextIp = 1
let admin: { id: string; cookie: string; csrfCookie: string; csrfToken: string }
let channelId: string

type Customer = { id: string; cookie: string; csrfCookie: string; csrfToken: string }
type Owner = Customer | { id: string; cookie: string; csrfCookie: string; csrfToken: string; guest: true }

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
  return cookie.split(';', 1)[0]!
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
  const username = `payment-${randomUUID().replaceAll('-', '').slice(0, 20)}`
  const response = await inject({
    method: 'POST', url: '/api/v1/customer/auth/register',
    headers: { origin: testOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.token },
    payload: { username, password: customerPassword },
  })
  expect(response.statusCode).toBe(201)
  return {
    id: response.json().data.customer.id as string,
    cookie: cookieFrom(response, 'aikayun_customer_session'),
    csrfToken: csrf.token,
    csrfCookie: csrf.cookie,
  }
}

function customerHeaders(owner: Owner, includeCsrf = true): Record<string, string> {
  return {
    origin: testOrigin,
    cookie: [owner.cookie, owner.csrfCookie].filter(Boolean).join('; '),
    ...(includeCsrf ? { 'x-csrf-token': owner.csrfToken } : {}),
  }
}

function adminHeaders() {
  return {
    origin: testOrigin,
    cookie: `${admin.cookie}; ${admin.csrfCookie}`,
    'x-csrf-token': admin.csrfToken,
  }
}

async function createAdmin() {
  const id = randomUUID()
  const email = `payments-${id.slice(0, 8)}@example.test`
  await db.insertInto('admin_users').values({ id, email, password_hash: await hashPassword(adminPassword) }).execute()
  const csrf = await inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
  const csrfToken = csrf.json().data.csrfToken as string
  const csrfCookie = cookieFrom(csrf, 'aikayun_admin_csrf')
  const login = await inject({
    method: 'POST', url: '/api/v1/admin/auth/login',
    headers: { origin: testOrigin, cookie: csrfCookie, 'x-csrf-token': csrfToken },
    payload: { email, password: adminPassword },
  })
  expect(login.statusCode).toBe(200)
  return { id, csrfToken, csrfCookie, cookie: cookieFrom(login, 'aikayun_admin_session') }
}

async function createGuestSession(): Promise<Owner> {
  const csrf = await customerCsrf()
  const response = await inject({
    method: 'POST', url: '/api/v1/guest/session',
    headers: { origin: testOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.token },
  })
  expect([200, 201]).toContain(response.statusCode)
  const cookie = cookieFrom(response, 'aikayun_guest_order_session')
  const token = cookie.slice(cookie.indexOf('=') + 1)
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const session = await db.selectFrom('guest_order_sessions').select('id').where('token_hash', '=', tokenHash).executeTakeFirstOrThrow()
  return { id: session.id, guest: true, cookie, csrfCookie: csrf.cookie, csrfToken: csrf.token }
}

async function createOrder(
  owner: Owner,
  name = `支付集成商品-${randomUUID().slice(0, 8)}`,
  options: { amount?: string; quantityStock?: number } = {},
): Promise<string> {
  const productId = randomUUID()
  const variantId = randomUUID()
  const orderId = randomUUID()
  const itemId = randomUUID()
  const amount = options.amount ?? '5.00'
  const inventoryMode = options.quantityStock === undefined ? 'unlimited' : 'quantity'
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('products').values({
      id: productId, name, description: 'Payment integration fixture', product_type: 'digital', status: 'active',
    }).execute()
    await trx.insertInto('product_variants').values({
      id: variantId, product_id: productId, sku_code: `PAY-${variantId.slice(0, 8)}`,
      combination_key: '', sale_price: amount, compare_at_price: null, cost_price: null,
      enabled: true, retired_at: null, inventory_mode: inventoryMode,
    }).execute()
    if (options.quantityStock !== undefined) {
      await trx.insertInto('product_variant_quantity_inventory').values({
        product_id: productId, product_variant_id: variantId, stocked: options.quantityStock, reserved: 0,
      }).execute()
    }
    await trx.insertInto('product_variant_fulfillment').values({
      product_variant_id: variantId, method: 'manual', manual_delivery_ready: true,
    }).execute()
    await trx.insertInto('orders').values({
      id: orderId,
      customer_id: 'guest' in owner && owner.guest ? null : owner.id,
      guest_order_session_id: 'guest' in owner && owner.guest ? owner.id : null,
      idempotency_key: randomUUID(), request_sha256: digest, total_amount: amount,
      unpaid_expires_at: new Date(Date.now() + 15 * 60_000),
      history_hidden_at: null, history_hidden_by_admin_id: null, history_hidden_reason: null,
    }).execute()
    await trx.insertInto('order_items').values({
      id: itemId, order_id: orderId, product_id: productId, product_variant_id: variantId,
      product_name_snapshot: name, product_type_snapshot: 'digital', sku_code_snapshot: `PAY-${variantId.slice(0, 8)}`,
      sku_snapshot: JSON.stringify([]), inventory_mode_snapshot: inventoryMode, fulfillment_method_snapshot: 'manual',
      unit_price: amount, quantity: 1, line_amount: amount,
    }).execute()
    if (options.quantityStock !== undefined) {
      await trx.insertInto('order_inventory_reservations').values({
        id: randomUUID(), order_item_id: itemId, product_id: productId,
        product_variant_id: variantId, quantity: 1,
      }).execute()
    }
    await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', orderId).execute()
  })
  return orderId
}

async function createPayment(orderId: string, owner: Owner, options: {
  paymentMethod?: 'alipay' | 'wechat'
  channelId?: string
  idempotencyKey?: string
  walletAmount?: string
} = {}) {
  return await inject({
    method: 'POST', url: `/api/v1/orders/${orderId}/payments`,
    headers: customerHeaders(owner),
    payload: {
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      channelId: options.channelId ?? channelId,
      paymentMethod: options.paymentMethod ?? 'alipay',
      ...(options.walletAmount ? { walletAmount: options.walletAmount } : {}),
    },
  })
}

async function createWalletTopUp(owner: Customer, options: {
  amount: string
  idempotencyKey?: string
  paymentMethod?: 'alipay' | 'wechat'
}): Promise<{ response: Awaited<ReturnType<typeof inject>>; attemptId: string }> {
  const response = await inject({
    method: 'POST', url: '/api/v1/customer/wallet/top-ups', headers: customerHeaders(owner),
    payload: {
      idempotencyKey: options.idempotencyKey ?? randomUUID(), amount: options.amount,
      channelId, paymentMethod: options.paymentMethod ?? 'alipay',
    },
  })
  const attemptId = response.statusCode < 300
    ? response.json().data.items[0].id as string : ''
  return { response, attemptId }
}

async function creditGiftFixture(owner: Customer, amount: string): Promise<void> {
  const operationId = randomUUID()
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('wallet_operations').values({
      id: operationId, customer_id: owner.id, order_id: null, resolves_operation_id: null,
      operation_type: 'gift', request_sha256: createHash('sha256').update(`${owner.id}:${operationId}`).digest('hex'),
      actor_admin_id: admin.id,
    }).execute()
    await trx.insertInto('wallet_ledger_entries').values({
      id: randomUUID(), wallet_operation_id: operationId, line_no: 1, customer_id: owner.id,
      bucket: 'gift', action: 'credit_available', amount, payment_attempt_id: null,
      refund_allocation_id: null, withdrawal_id: null,
    }).execute()
  })
}

async function expectWalletMatchesLedger(customerId: string): Promise<void> {
  const [account, rows] = await Promise.all([
    db.selectFrom('wallet_accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirstOrThrow(),
    sql<{ bucket: 'cash' | 'gift'; available: string; frozen: string }>`
      SELECT bucket,
        COALESCE(sum(CASE WHEN action IN ('credit_available', 'unfreeze') THEN amount
          WHEN action IN ('debit_available', 'freeze') THEN -amount ELSE 0 END), 0)::text AS available,
        COALESCE(sum(CASE WHEN action = 'freeze' THEN amount
          WHEN action IN ('unfreeze', 'debit_frozen') THEN -amount ELSE 0 END), 0)::text AS frozen
      FROM wallet_ledger_entries WHERE customer_id = ${customerId}::uuid GROUP BY bucket
    `.execute(db),
  ])
  for (const bucket of ['cash', 'gift'] as const) {
    const row = rows.rows.find(item => item.bucket === bucket)
    const normalize = (amount: string) => {
      const [whole, fraction = '00'] = amount.split('.')
      return `${BigInt(whole!)}.${fraction.padEnd(2, '0')}`
    }
    expect(normalize(row?.available ?? '0.00')).toBe(normalize(bucket === 'cash' ? account.cash_available : account.gift_available))
    expect(normalize(row?.frozen ?? '0.00')).toBe(normalize(bucket === 'cash' ? account.cash_frozen : account.gift_frozen))
  }
}

function callbackUrl(parameters: Record<string, string>): string {
  return `/api/v1/payments/callback/zpay?${new URLSearchParams(parameters).toString()}`
}

function signedConflictingCallback(merchantOrderNo: string): Record<string, string> {
  const callback = fixture.setPaid(merchantOrderNo, { amount: '100.00' })
  callback.money = '90.00'
  return resignCallback(callback)
}

function resignCallback(callback: Record<string, string>): Record<string, string> {
  const unsigned = Object.fromEntries(Object.entries(callback).filter(([key]) => key !== 'sign'))
  callback.sign = createZpaySignature(merchantKey, unsigned)
  return callback
}

async function createPaymentChannel(): Promise<string> {
  const response = await inject({
    method: 'POST', url: '/api/v1/admin/payment-channels', headers: adminHeaders(),
    payload: {
      providerType: 'zpay_epay_v1', name: '集成测试通道', enabled: true,
      paymentMethods: ['alipay', 'wechat'], displayOrder: 10,
      merchantId, merchantKey,
    },
  })
  expect(response.statusCode).toBe(201)
  return response.json().data.channel.id as string
}

beforeAll(async () => {
  const databaseUrl = new URL(testDatabaseUrl)
  if (!databaseUrl.pathname.slice(1).endsWith('_test')) {
    throw new Error('Refusing to run payment integration tests unless TEST_DATABASE_URL names a database ending in _test')
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
  await db.updateTable('storefront_customer_policy').set({ guest_checkout_enabled: true }).where('singleton', '=', true).execute()

  const ringJson = JSON.stringify({ activeKeyId: 'test-a', keys: { 'test-a': encryptionKeyA.toString('base64') } })
  config = readConfig({
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: testOrigin,
    COOKIE_SECURE: 'false',
    PAYMENT_CREDENTIAL_KEY_RING: ringJson,
  })
  fixture = await startZpayHttpFixture({ merchantCredentials: { [merchantId]: merchantKey } })
  app = await createApp({ db, config, logger: false, paymentProviderBaseUrlForTests: fixture.baseUrl })
  await app.ready()
  secondDb = createDatabase()
  secondApp = await createApp({ db: secondDb, config, logger: false, paymentProviderBaseUrlForTests: fixture.baseUrl })
  await secondApp.ready()
  const secondAddress = await secondApp.listen({ host: '127.0.0.1', port: 0 })
  api2BaseUrl = secondAddress

  admin = await createAdmin()
  channelId = await createPaymentChannel()
})

afterAll(async () => {
  if (secondApp) await secondApp.close()
  if (app) await app.close()
  if (fixture) await fixture.close()
  if (secondDb) await secondDb.destroy()
  if (db) await db.destroy()
})

describe('online payment settlement through a real local HTTP provider and PostgreSQL', () => {
  it('keeps merchant secrets out of admin and public API responses and audits channel changes', async () => {
    const adminList = await inject({ method: 'GET', url: '/api/v1/admin/payment-channels', headers: adminHeaders() })
    expect(adminList.statusCode).toBe(200)
    expect(adminList.body).not.toContain(merchantKey)
    expect(adminList.body).not.toContain(merchantId)
    expect(adminList.json().data.items[0]).toMatchObject({
      providerType: 'zpay_epay_v1', credentialsConfigured: true, providerAvailable: true,
    })

    const publicList = await inject({ method: 'GET', url: '/api/v1/public/payment-channels' })
    expect(publicList.statusCode).toBe(200)
    expect(publicList.body).not.toContain(merchantKey)
    expect(publicList.body).not.toContain(merchantId)
    expect(publicList.json().data.items[0]).toEqual({
      id: channelId, name: '集成测试通道', paymentMethods: ['alipay', 'wechat'],
    })

    const testResult = await inject({ method: 'POST', url: `/api/v1/admin/payment-channels/${channelId}/test`, headers: adminHeaders() })
    expect(testResult.statusCode).toBe(200)
    expect(testResult.json().data.valid).toBe(true)
    expect(fixture.stats().balanceChecks).toBe(1)

    const audit = await db.selectFrom('payment_channel_audit_events').select(['action', 'summary'])
      .where('payment_channel_id', '=', channelId).execute()
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit)).not.toContain(merchantKey)
  })

  it('uses server-owned order facts and reuses an active attempt on repeated clicks', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer)
    const requestKey = randomUUID()
    const first = await createPayment(orderId, customer, { idempotencyKey: requestKey, paymentMethod: 'wechat' })
    expect(first.statusCode).toBe(201)
    expect(first.json().data.totalAmount).toBe('5.00')
    expect(first.json().data.attempt).toMatchObject({
      status: 'pending', providerState: 'ready', paymentMethod: 'wechat', action: { type: 'qr_code' },
    })

    const replay = await createPayment(orderId, customer, { idempotencyKey: requestKey, paymentMethod: 'wechat' })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data.attempt.id).toBe(first.json().data.attempt.id)
    const secondClick = await createPayment(orderId, customer, { paymentMethod: 'alipay' })
    expect(secondClick.statusCode).toBe(200)
    expect(secondClick.json().data.attempt.id).toBe(first.json().data.attempt.id)

    const attempts = await db.selectFrom('payment_attempts').selectAll().where('order_id', '=', orderId).execute()
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.amount).toBe('5.00')
    expect(attempts[0]!.status).toBe('pending')
    expect(fixture.stats().creates).toBe(1)
    const encryptedSecret = await db.selectFrom('payment_attempt_secrets').select('ciphertext')
      .where('payment_attempt_id', '=', attempts[0]!.id).executeTakeFirstOrThrow()
    expect(encryptedSecret.ciphertext.toString('utf8')).not.toContain(merchantKey)
  })

  it('settles a verified callback that arrives before the provider create response', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer)
    const gate = fixture.pauseNextCreateResponse()
    const createPromise = createPayment(orderId, customer)
    try {
      await gate.entered
      const merchantOrderNo = fixture.orders().at(-1)!.merchantOrderNo
      const callback = fixture.setPaid(merchantOrderNo)
      const accepted = await inject({ method: 'GET', url: callbackUrl(callback) })
      expect(accepted.statusCode).toBe(200)
      expect(accepted.body).toBe('success')

      gate.release()
      const created = await createPromise
      expect(created.statusCode).toBe(201)
      expect(created.json().data.paymentStatus).toBe('paid')
      const attemptId = created.json().data.attempt.id as string
      expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
        .toBe('succeeded')
      expect(await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', attemptId).execute())
        .toHaveLength(1)
      expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
        .toBe('processing')
    } finally {
      gate.release()
    }
  })

  it('confirms signed callbacks with an authenticated query exactly once and advances only the protected order trigger', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer)
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    const merchantOrderNo = fixture.orders().at(-1)!.merchantOrderNo
    const callback = fixture.setPaid(merchantOrderNo)

    const accepted = await inject({ method: 'GET', url: callbackUrl(callback) })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.body).toBe('success')
    const duplicate = await inject({ method: 'GET', url: callbackUrl(callback) })
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.body).toBe('success')

    const attempt = await db.selectFrom('payment_attempts').select(['status', 'completed_at'])
      .where('id', '=', attemptId).executeTakeFirstOrThrow()
    const receipt = await db.selectFrom('payment_receipts').selectAll().where('payment_attempt_id', '=', attemptId).execute()
    const order = await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()
    expect(attempt.status).toBe('succeeded')
    expect(attempt.completed_at).toBeTruthy()
    expect(receipt).toHaveLength(1)
    expect(receipt[0]!.disposition).toBe('on_time')
    expect(order.status).toBe('processing')

    const current = await inject({
      method: 'GET', url: `/api/v1/orders/${orderId}/payment`, headers: customerHeaders(customer, false),
    })
    expect(current.statusCode).toBe(200)
    expect(current.json().data.paymentStatus).toBe('paid')
    expect(current.json().data.confirmedAmount).toBe('5.00')
  })

  it('reproduces verified callback/query conflicts without losing the provider-confirmed money', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer, `冲突资金持久化-${randomUUID().slice(0, 8)}`, {
      amount: '100.00', quantityStock: 1,
    })
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    const merchantOrderNo = fixture.orders().at(-1)!.merchantOrderNo
    const callback = signedConflictingCallback(merchantOrderNo)

    expect(callback.sign).toBe(createZpaySignature(merchantKey, Object.fromEntries(
      Object.entries(callback).filter(([key]) => key !== 'sign'),
    )))
    const accepted = await inject({ method: 'GET', url: callbackUrl(callback) })
    expect(accepted.statusCode).toBe(200)

    const receipt = await db.selectFrom('payment_receipts').select(['amount', 'disposition'])
      .where('payment_attempt_id', '=', attemptId).execute()
    expect(receipt).toEqual([{ amount: '100.00', disposition: 'on_time' }])
    const attempt = await db.selectFrom('payment_attempts').select('status')
      .where('id', '=', attemptId).executeTakeFirstOrThrow()
    const order = await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()
    const inventory = await db.selectFrom('product_variant_quantity_inventory')
      .innerJoin('order_inventory_reservations', 'order_inventory_reservations.product_variant_id', 'product_variant_quantity_inventory.product_variant_id')
      .innerJoin('order_items', 'order_items.id', 'order_inventory_reservations.order_item_id')
      .select(['product_variant_quantity_inventory.reserved', 'product_variant_quantity_inventory.product_variant_id'])
      .where('order_items.order_id', '=', orderId).executeTakeFirstOrThrow()

    expect(attempt.status).toBe('reconciliation_required')
    expect(order.status).toBe('pending_payment')
    expect(inventory.reserved).toBe(1)
  })

  it('does not let a later customer query bypass a persisted callback/query conflict', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer, `冲突查单隔离-${randomUUID().slice(0, 8)}`, { amount: '100.00' })
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    const callback = signedConflictingCallback(fixture.orders().at(-1)!.merchantOrderNo)
    expect((await inject({ method: 'GET', url: callbackUrl(callback) })).statusCode).toBe(200)

    await db.updateTable('payment_attempt_provider_state').set({ last_query_at: new Date(Date.now() - 11_000) })
      .where('payment_attempt_id', '=', attemptId).execute()
    const refreshed = await inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/payment/refresh`, headers: customerHeaders(customer),
    })
    expect(refreshed.statusCode).toBe(200)
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('reconciliation_required')
    expect(await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', attemptId).execute())
      .toHaveLength(1)
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('pending_payment')
  })

  it('keeps verified conflicting funds protected after both deadlines and blocks cancellation and timeout release', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer, `超时异常资金保护-${randomUUID().slice(0, 8)}`, {
      amount: '100.00', quantityStock: 1,
    })
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    const callback = signedConflictingCallback(fixture.orders().at(-1)!.merchantOrderNo)
    expect((await inject({ method: 'GET', url: callbackUrl(callback) })).statusCode).toBe(200)

    // Test-only clock advance: the production deadline triggers remain immutable.
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_guard`.execute(db)
    await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_deadline_r1`.execute(db)
    try {
      await db.updateTable('orders').set({ unpaid_expires_at: new Date(Date.now() - 2_000) })
        .where('id', '=', orderId).execute()
      await sql`UPDATE payment_attempts SET created_at = clock_timestamp() - interval '1 minute',
        expires_at = clock_timestamp() - interval '2 seconds' WHERE id = ${attemptId}::uuid`.execute(db)
    } finally {
      await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_deadline_r1`.execute(db)
      await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_guard`.execute(db)
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }

    await expireDueUnpaidOrders(db)
    const cancel = await inject({
      method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(customer),
    })
    expect(cancel.statusCode).toBe(409)
    const order = await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()
    const attempt = await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()
    const receipt = await db.selectFrom('payment_receipts').select(['amount', 'disposition'])
      .where('payment_attempt_id', '=', attemptId).executeTakeFirstOrThrow()
    const inventory = await db.selectFrom('product_variant_quantity_inventory as inventory')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.product_variant_id', 'inventory.product_variant_id')
      .innerJoin('order_items as item', 'item.id', 'reservation.order_item_id')
      .select(['inventory.reserved', sql<string>`(SELECT COALESCE(string_agg(event.action, ',' ORDER BY event.created_at), '')
        FROM order_inventory_events AS event WHERE event.reservation_id = reservation.id)`.as('actions')])
      .where('item.order_id', '=', orderId).executeTakeFirstOrThrow()
    expect(order.status).toBe('pending_payment')
    expect(attempt.status).toBe('reconciliation_required')
    expect(receipt).toEqual({ amount: '100.00', disposition: 'on_time' })
    expect(inventory.reserved).toBe(1)
    expect(inventory.actions).toBe('reserve')
  })

  it('protects a confirmed late query through reconciliation without inventing a refund or releasing stock', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer, `到期查单资金保护-${randomUUID().slice(0, 8)}`, {
      amount: '100.00', quantityStock: 1,
    })
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    fixture.setPaid(fixture.orders().at(-1)!.merchantOrderNo)

    // Model the provider result arriving after both deadlines, before the close worker runs.
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_guard`.execute(db)
    await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_deadline_r1`.execute(db)
    try {
      await db.updateTable('orders').set({ unpaid_expires_at: new Date(Date.now() - 2_000) })
        .where('id', '=', orderId).execute()
      await sql`UPDATE payment_attempts SET created_at = clock_timestamp() - interval '1 minute',
        expires_at = clock_timestamp() - interval '2 seconds' WHERE id = ${attemptId}::uuid`.execute(db)
    } finally {
      await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_deadline_r1`.execute(db)
      await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_guard`.execute(db)
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }

    const refreshed = await inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/payment/refresh`, headers: customerHeaders(customer),
    })
    expect(refreshed.statusCode).toBe(200)
    expect(await db.selectFrom('payment_provider_events').select(['source', 'verification', 'provider_status', 'disposition'])
      .where('payment_attempt_id', '=', attemptId).where('source', '=', 'query').execute())
      .toEqual([{ source: 'query', verification: 'verified', provider_status: 'paid', disposition: 'pending_confirmation' }])
    expect(await db.selectFrom('payment_receipts').select(['amount', 'disposition'])
      .where('payment_attempt_id', '=', attemptId).execute())
      .toEqual([{ amount: '100.00', disposition: 'late' }])
    expect(await db.selectFrom('payment_provider_reconciliation_cases').select(['reason', 'state'])
      .where('payment_attempt_id', '=', attemptId).execute())
      .toEqual([{ reason: 'late_confirmed_payment', state: 'open' }])

    await expireDueUnpaidOrders(db)
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('pending_payment')
    const inventoryBeforeResolution = await db.selectFrom('product_variant_quantity_inventory as inventory')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.product_variant_id', 'inventory.product_variant_id')
      .innerJoin('order_items as item', 'item.id', 'reservation.order_item_id')
      .select(['inventory.reserved', sql<string>`(SELECT COALESCE(string_agg(event.action, ',' ORDER BY event.created_at), '')
        FROM order_inventory_events AS event WHERE event.reservation_id = reservation.id)`.as('actions')])
      .where('item.order_id', '=', orderId).executeTakeFirstOrThrow()
    expect(inventoryBeforeResolution).toEqual({ reserved: 1, actions: 'reserve' })

    await db.updateTable('payment_attempt_provider_state').set({ last_query_at: new Date(Date.now() - 11_000) })
      .where('payment_attempt_id', '=', attemptId).execute()
    const resolved = await inject({
      method: 'POST', url: `/api/v1/admin/orders/${orderId}/payments/${attemptId}/reconcile`, headers: adminHeaders(),
    })
    expect(resolved.statusCode).toBe(200)
    expect(resolved.json().data.state).toBe('resolved')
    expect(await db.selectFrom('payment_receipts').select(['amount', 'disposition'])
      .where('payment_attempt_id', '=', attemptId).execute())
      .toEqual([{ amount: '100.00', disposition: 'late' }])
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('late_succeeded')

    await expireDueUnpaidOrders(db)
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('pending_payment')
    const inventoryAfterResolution = await db.selectFrom('product_variant_quantity_inventory as inventory')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.product_variant_id', 'inventory.product_variant_id')
      .innerJoin('order_items as item', 'item.id', 'reservation.order_item_id')
      .select(['inventory.reserved', sql<string>`(SELECT COALESCE(string_agg(event.action, ',' ORDER BY event.created_at), '')
        FROM order_inventory_events AS event WHERE event.reservation_id = reservation.id)`.as('actions')])
      .where('item.order_id', '=', orderId).executeTakeFirstOrThrow()
    expect(inventoryAfterResolution).toEqual({ reserved: 1, actions: 'reserve' })
    expect(await db.selectFrom('payment_receipts').select(['refunded_amount', 'refund_reserved_amount'])
      .where('payment_attempt_id', '=', attemptId).execute())
      .toEqual([{ refunded_amount: '0.00', refund_reserved_amount: '0.00' }])
  })

  it('does not let timeout or cancellation win while a signed paid callback awaits its provider query', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer, `回调查单间超时并发-${randomUUID().slice(0, 8)}`, {
      amount: '100.00', quantityStock: 1,
    })
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_guard`.execute(db)
    await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_deadline_r1`.execute(db)
    try {
      await db.updateTable('orders').set({ unpaid_expires_at: new Date(Date.now() - 2_000) })
        .where('id', '=', orderId).execute()
      await sql`UPDATE payment_attempts SET created_at = clock_timestamp() - interval '1 minute',
        expires_at = clock_timestamp() - interval '2 seconds' WHERE id = ${attemptId}::uuid`.execute(db)
    } finally {
      await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_deadline_r1`.execute(db)
      await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_guard`.execute(db)
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }

    const callback = signedConflictingCallback(fixture.orders().at(-1)!.merchantOrderNo)
    const gate = fixture.pauseNextQueryResponse()
    const callbackRequest = fetch(`${api2BaseUrl}${callbackUrl(callback)}`)
    try {
      await gate.entered
      await expireDueUnpaidOrders(db)
      const cancel = await inject({
        method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(customer),
      })
      expect(cancel.statusCode).toBe(409)
      expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
        .toBe('pending_payment')
    } finally {
      gate.release()
    }
    const callbackResponse = await callbackRequest
    expect(callbackResponse.status).toBe(200)
    const receipt = await db.selectFrom('payment_receipts').select(['amount', 'disposition'])
      .where('payment_attempt_id', '=', attemptId).executeTakeFirstOrThrow()
    const reconciliation = await db.selectFrom('payment_provider_reconciliation_cases').select('state')
      .where('payment_attempt_id', '=', attemptId).executeTakeFirstOrThrow()
    const inventory = await db.selectFrom('product_variant_quantity_inventory as inventory')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.product_variant_id', 'inventory.product_variant_id')
      .innerJoin('order_items as item', 'item.id', 'reservation.order_item_id')
      .select(['inventory.reserved', sql<string>`(SELECT COALESCE(string_agg(event.action, ',' ORDER BY event.created_at), '')
        FROM order_inventory_events AS event WHERE event.reservation_id = reservation.id)`.as('actions')])
      .where('item.order_id', '=', orderId).executeTakeFirstOrThrow()
    expect(receipt).toEqual({ amount: '100.00', disposition: 'late' })
    expect(reconciliation.state).toBe('open')
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('late_succeeded')
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('pending_payment')
    expect(inventory).toEqual({ reserved: 1, actions: 'reserve' })
  })

  it('keeps the confirmed query non-settleable when a mismatching signed callback arrives during a query', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer, `并发证据冲突-${randomUUID().slice(0, 8)}`, { amount: '100.00' })
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    const merchantOrderNo = fixture.orders().at(-1)!.merchantOrderNo
    const callback = signedConflictingCallback(merchantOrderNo)
    const gate = fixture.pauseNextQueryResponse()
    const refresh = inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/payment/refresh`, headers: customerHeaders(customer),
    })
    try {
      await gate.entered
      const callbackResponse = await fetch(`${api2BaseUrl}${callbackUrl(callback)}`)
      expect(callbackResponse.status).toBe(503)
      gate.release()
      expect((await refresh).statusCode).toBe(200)
    } finally {
      gate.release()
    }

    const receipt = await db.selectFrom('payment_receipts').select(['amount', 'disposition'])
      .where('payment_attempt_id', '=', attemptId).execute()
    const attempt = await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()
    const order = await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()
    const reconciliation = await db.selectFrom('payment_provider_reconciliation_cases').select(['reason', 'state'])
      .where('payment_attempt_id', '=', attemptId).execute()
    expect(receipt).toEqual([{ amount: '100.00', disposition: 'on_time' }])
    expect(attempt.status).toBe('reconciliation_required')
    expect(order.status).toBe('pending_payment')
    expect(reconciliation).toEqual([{ reason: 'callback_query_mismatch', state: 'open' }])
  })

  it('treats repeated identical authenticated queries as one event and one receipt', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer)
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    fixture.setPaid(fixture.orders().at(-1)!.merchantOrderNo)

    const first = await inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/payment/refresh`, headers: customerHeaders(customer),
    })
    expect(first.statusCode).toBe(200)
    await db.updateTable('payment_attempt_provider_state').set({ last_query_at: new Date(Date.now() - 11_000) })
      .where('payment_attempt_id', '=', attemptId).execute()
    const repeated = await inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/payment/refresh`, headers: customerHeaders(customer),
    })
    expect(repeated.statusCode).toBe(200)
    expect(await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', attemptId).execute())
      .toHaveLength(1)
    expect(await db.selectFrom('payment_provider_events').select('id')
      .where('payment_attempt_id', '=', attemptId).where('source', '=', 'query').execute()).toHaveLength(1)
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('succeeded')
  })

  it('retains transaction and payment-method conflicts as auditable evidence', async () => {
    const customer = await createCustomer()
    for (const conflict of ['transaction', 'method'] as const) {
      const orderId = await createOrder(customer, `交易身份冲突-${conflict}-${randomUUID().slice(0, 8)}`)
      const created = await createPayment(orderId, customer, { paymentMethod: 'alipay' })
      const attemptId = created.json().data.attempt.id as string
      const merchantOrderNo = fixture.orders().at(-1)!.merchantOrderNo
      const callback = fixture.setPaid(merchantOrderNo)
      if (conflict === 'transaction') callback.trade_no = `SIGNED-DIFFERENT-${randomUUID()}`
      else callback.type = 'wxpay'
      resignCallback(callback)

      expect((await inject({ method: 'GET', url: callbackUrl(callback) })).statusCode).toBe(200)
      const receipt = await db.selectFrom('payment_receipts').select(['provider_transaction_id', 'amount', 'disposition'])
        .where('payment_attempt_id', '=', attemptId).executeTakeFirstOrThrow()
      const attempt = await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()
      const order = await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()
      const providerOrder = fixture.orders().find(row => row.merchantOrderNo === merchantOrderNo)!
      const reconciliation = await db.selectFrom('payment_provider_reconciliation_cases').select('state')
        .where('payment_attempt_id', '=', attemptId).execute()
      expect(receipt).toEqual({ provider_transaction_id: providerOrder.providerOrderId, amount: '5.00', disposition: 'on_time' })
      expect(attempt.status).toBe('reconciliation_required')
      expect(order.status).toBe('pending_payment')
      expect(reconciliation).toEqual([{ state: 'open' }])
    }
  })

  it('resolves a callback conflict only after an administrator performs a matching provider query', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer, `认证查单解除异常-${randomUUID().slice(0, 8)}`, {
      amount: '100.00', quantityStock: 1,
    })
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    const callback = signedConflictingCallback(fixture.orders().at(-1)!.merchantOrderNo)
    expect((await inject({ method: 'GET', url: callbackUrl(callback) })).statusCode).toBe(200)
    await db.updateTable('payment_attempt_provider_state').set({ last_query_at: new Date(Date.now() - 11_000) })
      .where('payment_attempt_id', '=', attemptId).execute()

    const resolved = await inject({
      method: 'POST', url: `/api/v1/admin/orders/${orderId}/payments/${attemptId}/reconcile`, headers: adminHeaders(),
    })
    expect(resolved.statusCode).toBe(200)
    expect(resolved.json().data.state).toBe('resolved')
    const caseRow = await db.selectFrom('payment_provider_reconciliation_cases').selectAll()
      .where('payment_attempt_id', '=', attemptId).executeTakeFirstOrThrow()
    expect(caseRow).toMatchObject({
      state: 'resolved', resolved_by_admin_id: admin.id,
      resolution_provider_transaction_id: fixture.orders().at(-1)!.providerOrderId,
      resolution_confirmed_amount: '100.00', resolution_currency: 'CNY',
    })
    expect(caseRow.resolution_query_event_sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', attemptId).execute())
      .toHaveLength(1)
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('succeeded')
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('processing')
    expect((await db.selectFrom('product_variant_quantity_inventory as inventory')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.product_variant_id', 'inventory.product_variant_id')
      .innerJoin('order_items as item', 'item.id', 'reservation.order_item_id')
      .select('inventory.reserved').where('item.order_id', '=', orderId).executeTakeFirstOrThrow()).reserved).toBe(1)
  })

  it('holds manual fulfillment if a signed conflicting callback is discovered after an earlier settlement', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer)
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    const merchantOrderNo = fixture.orders().at(-1)!.merchantOrderNo
    fixture.setPaid(merchantOrderNo)
    await db.updateTable('payment_attempt_provider_state').set({ last_query_at: new Date(Date.now() - 11_000) })
      .where('payment_attempt_id', '=', attemptId).execute()
    expect((await inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/payment/refresh`, headers: customerHeaders(customer),
    })).statusCode).toBe(200)
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('processing')

    const callback = fixture.setPaid(merchantOrderNo)
    callback.money = '90.00'
    resignCallback(callback)
    expect((await inject({ method: 'GET', url: callbackUrl(callback) })).statusCode).toBe(200)
    const item = await db.selectFrom('order_items').select('id').where('order_id', '=', orderId).executeTakeFirstOrThrow()
    const fulfillment = await inject({
      method: 'POST', url: `/api/v1/admin/orders/${orderId}/items/${item.id}/fulfillments`,
      headers: adminHeaders(), payload: { operationId: randomUUID(), deliveries: [{ content: 'must-not-deliver' }] },
    })
    expect(fulfillment.statusCode).toBe(409)
    expect(fulfillment.json().error.code).toBe('ORDER_PAYMENT_RECONCILIATION_OPEN')
    expect(await db.selectFrom('order_item_fulfillment_deliveries').select('order_item_fulfillment_deliveries.id')
      .innerJoin('order_item_fulfillment_attempts', 'order_item_fulfillment_attempts.id', 'order_item_fulfillment_deliveries.fulfillment_attempt_id')
      .innerJoin('order_items', 'order_items.id', 'order_item_fulfillment_attempts.order_item_id')
      .where('order_items.order_id', '=', orderId).execute()).toHaveLength(0)
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('reconciliation_required')
  })

  it('rejects signature tampering, retains signed amount mismatches, and never auto-fulfills anomalous money', async () => {
    const customer = await createCustomer()
    const badOrderId = await createOrder(customer)
    const badCreated = await createPayment(badOrderId, customer)
    const badAttemptId = badCreated.json().data.attempt.id as string
    const badMerchantNo = fixture.orders().at(-1)!.merchantOrderNo
    const tampered = fixture.setPaid(badMerchantNo)
    tampered.money = '0.01'
    const rejected = await inject({ method: 'GET', url: callbackUrl(tampered) })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.body).toBe('fail')
    expect(await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', badAttemptId).execute()).toHaveLength(0)
    expect((await db.selectFrom('payment_provider_events').select('verification')
      .where('payment_attempt_id', '=', badAttemptId).execute()).some(row => row.verification === 'unverified')).toBe(true)

    for (const actualAmount of ['4.00', '6.00']) {
      const orderId = await createOrder(customer)
      const created = await createPayment(orderId, customer)
      const attemptId = created.json().data.attempt.id as string
      const merchantOrderNo = fixture.orders().at(-1)!.merchantOrderNo
      const callback = fixture.setPaid(merchantOrderNo, { amount: actualAmount })
      const accepted = await inject({ method: 'GET', url: callbackUrl(callback) })
      expect(accepted.statusCode).toBe(200)
      expect(accepted.body).toBe('success')

      const attempt = await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()
      const receipt = await db.selectFrom('payment_receipts').select(['amount', 'disposition'])
        .where('payment_attempt_id', '=', attemptId).executeTakeFirstOrThrow()
      const order = await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()
      const customerView = await inject({ method: 'GET', url: `/api/v1/orders/${orderId}/payment`, headers: customerHeaders(customer, false) })
      expect(attempt.status).toBe('reconciliation_required')
      expect(receipt.amount).toBe(actualAmount)
      // The frozen ④-1 receipt trigger classifies both over- and under-payment
      // against one attempt as amount_mismatch; cumulative excess remains a
      // separate disposition. In either case the actual receipt is preserved.
      expect(receipt.disposition).toBe('amount_mismatch')
      expect(order.status).toBe('pending_payment')
      expect(customerView.json().data.paymentStatus).toBe('reconciliation_required')
    }
  })

  it('serializes callback and active query races across two API instances without duplicate receipts', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer)
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    const merchantOrderNo = fixture.orders().at(-1)!.merchantOrderNo
    const callback = fixture.setPaid(merchantOrderNo)
    const headers = customerHeaders(customer)

    const callbackRequest = fetch(`${api2BaseUrl}${callbackUrl(callback)}`)
    const refreshRequest = app.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/payment/refresh`, headers,
      remoteAddress: remoteAddress(),
    })
    const [callbackResponse, refreshResponse] = await Promise.all([callbackRequest, refreshRequest])
    expect([200, 503]).toContain(callbackResponse.status)
    expect(refreshResponse.statusCode).toBe(200)

    const receipts = await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', attemptId).execute()
    const attempt = await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()
    const order = await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()
    expect(receipts).toHaveLength(1)
    expect(attempt.status).toBe('succeeded')
    expect(order.status).toBe('processing')
  })

  it('prevents a provider transaction from being attached to a second attempt across channels', async () => {
    const customer = await createCustomer()
    const firstOrderId = await createOrder(customer)
    const first = await createPayment(firstOrderId, customer)
    const firstAttemptId = first.json().data.attempt.id as string
    const firstMerchantNo = fixture.orders().at(-1)!.merchantOrderNo
    const sharedTransactionId = `ZPAY-SHARED-${randomUUID()}`
    const firstCallback = fixture.setPaid(firstMerchantNo, { providerOrderId: sharedTransactionId })
    const firstResult = await inject({ method: 'GET', url: callbackUrl(firstCallback) })
    expect(firstResult.statusCode).toBe(200)
    expect((await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', firstAttemptId).execute()))
      .toHaveLength(1)

    const otherChannelResponse = await inject({
      method: 'POST', url: '/api/v1/admin/payment-channels', headers: adminHeaders(),
      payload: {
        providerType: 'zpay_epay_v1', name: `第二个支付通道-${randomUUID().slice(0, 8)}`,
        enabled: true, paymentMethods: ['alipay', 'wechat'], displayOrder: 20, merchantId, merchantKey,
      },
    })
    expect(otherChannelResponse.statusCode).toBe(201)
    const secondChannelId = otherChannelResponse.json().data.channel.id as string
    const secondOrderId = await createOrder(customer)
    const second = await createPayment(secondOrderId, customer, { channelId: secondChannelId })
    const secondAttemptId = second.json().data.attempt.id as string
    const secondMerchantNo = fixture.orders().at(-1)!.merchantOrderNo
    const secondCallback = fixture.setPaid(secondMerchantNo, { providerOrderId: sharedTransactionId })
    const secondResult = await inject({ method: 'GET', url: callbackUrl(secondCallback) })
    expect(secondResult.statusCode).toBe(200)
    expect(secondResult.body).toBe('success')

    expect(await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', secondAttemptId).execute())
      .toHaveLength(0)
    expect(await db.selectFrom('payment_provider_reconciliation_cases').select(['reason', 'state'])
      .where('payment_attempt_id', '=', secondAttemptId).execute())
      .toEqual([{ reason: 'provider_transaction_conflict', state: 'open' }])
    const status = await inject({ method: 'GET', url: `/api/v1/orders/${secondOrderId}/payment`, headers: customerHeaders(customer, false) })
    expect(status.json().data.paymentStatus).toBe('reconciliation_required')
  })

  it('serializes a cancellation race against a signed success callback', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer)
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    const merchantOrderNo = fixture.orders().at(-1)!.merchantOrderNo
    const callback = fixture.setPaid(merchantOrderNo)
    const callbackRequest = fetch(`${api2BaseUrl}${callbackUrl(callback)}`)
    const cancellationRequest = inject({
      method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`,
      headers: customerHeaders(customer), remoteAddress: remoteAddress(),
    })
    const [callbackResponse, cancellationResponse] = await Promise.all([callbackRequest, cancellationRequest])
    expect(callbackResponse.status).toBe(200)
    expect([200, 409]).toContain(cancellationResponse.statusCode)

    const order = await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()
    const attempt = await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()
    const receipt = await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', attemptId).execute()
    expect(order.status).toBe('processing')
    expect(attempt.status).toBe('succeeded')
    expect(receipt).toHaveLength(1)
  })

  it('keeps unknown provider creates recoverable without creating a second external order', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer, `__unknown__${randomUUID().slice(0, 8)}`)
    const idempotencyKey = randomUUID()
    const createCountBefore = fixture.stats().creates
    const created = await createPayment(orderId, customer, { idempotencyKey })
    expect(created.statusCode).toBe(201)
    expect(created.json().data.attempt).toMatchObject({ status: 'created', providerState: 'unknown', action: null })

    const retry = await createPayment(orderId, customer, { idempotencyKey })
    expect(retry.statusCode).toBe(200)
    expect(retry.json().data.attempt.id).toBe(created.json().data.attempt.id)
    expect(retry.json().data.attempt.status).toBe('created')
    expect(await db.selectFrom('payment_attempts').select('id').where('order_id', '=', orderId).execute()).toHaveLength(1)
    expect(fixture.stats().creates).toBe(createCountBefore + 1)
  })

  it('isolates guest orders and does not expose another session payment state', async () => {
    const guest = await createGuestSession()
    const stranger = await createGuestSession()
    const orderId = await createOrder(guest, `游客支付隔离-${randomUUID().slice(0, 8)}`)
    const own = await inject({ method: 'GET', url: `/api/v1/orders/${orderId}/payment`, headers: customerHeaders(guest, false) })
    const other = await inject({ method: 'GET', url: `/api/v1/orders/${orderId}/payment`, headers: customerHeaders(stranger, false) })
    const anonymous = await inject({ method: 'GET', url: `/api/v1/orders/${orderId}/payment` })
    expect(own.statusCode).toBe(200)
    expect(other.statusCode).toBe(404)
    expect(anonymous.statusCode).toBe(401)
  })

  it('preserves a late receipt after expiry closure without reopening the order', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer)
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    const merchantOrderNo = fixture.orders().at(-1)!.merchantOrderNo

    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    try {
      await db.updateTable('orders').set({ unpaid_expires_at: new Date(Date.now() - 2_000) }).where('id', '=', orderId).execute()
    } finally {
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }
    // The provider has conclusively expired this attempt; keep its immutable
    // future deadline and move only through the allowed pending -> expired state.
    await db.updateTable('payment_attempts').set({ status: 'expired' }).where('id', '=', attemptId).execute()

    const callback = fixture.setPaid(merchantOrderNo)
    await Promise.all([
      expireDueUnpaidOrders(db),
      inject({ method: 'GET', url: callbackUrl(callback) }),
    ])

    const currentOrder = await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()
    const attempt = await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()
    const receipt = await db.selectFrom('payment_receipts').select('disposition').where('payment_attempt_id', '=', attemptId).executeTakeFirstOrThrow()
    expect(currentOrder.status).toBe('closed')
    expect(attempt.status).toBe('late_succeeded')
    expect(receipt.disposition).toBe('late')
  })

  it('re-encrypts channel credentials and historical attempt snapshots during key rotation', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer)
    const created = await createPayment(orderId, customer)
    const attemptId = created.json().data.attempt.id as string
    const merchantOrderNo = fixture.orders().at(-1)!.merchantOrderNo

    config.paymentCredentialKeyRing = {
      activeKeyId: 'test-b',
      keys: { 'test-a': encryptionKeyA, 'test-b': encryptionKeyB },
    }
    const rotated = await inject({ method: 'POST', url: '/api/v1/admin/payment-channels/reencrypt', headers: adminHeaders() })
    expect(rotated.statusCode).toBe(200)
    expect(rotated.json().data.activeKeyId).toBe('test-b')
    expect(rotated.json().data.channelsReencrypted).toBeGreaterThan(0)
    expect(rotated.json().data.attemptsReencrypted).toBeGreaterThan(0)

    const channel = await db.selectFrom('payment_channels').select('config_key_id').where('id', '=', channelId).executeTakeFirstOrThrow()
    const secret = await db.selectFrom('payment_attempt_secrets').select(['key_id', 'envelope_version'])
      .where('payment_attempt_id', '=', attemptId).orderBy('envelope_version', 'desc').executeTakeFirstOrThrow()
    expect(channel.config_key_id).toBe('test-b')
    expect(secret.key_id).toBe('test-b')
    expect(secret.envelope_version).toBe(2)

    const callback = fixture.setPaid(merchantOrderNo)
    const accepted = await inject({ method: 'GET', url: callbackUrl(callback) })
    expect(accepted.statusCode).toBe(200)
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('succeeded')
  })

  it('allows a definitive service provider rejection to fail without inventing a receipt', async () => {
    const customer = await createCustomer()
    const rejectedOrder = await createOrder(customer, `__reject__${randomUUID().slice(0, 8)}`)
    const rejected = await createPayment(rejectedOrder, customer)
    expect(rejected.statusCode).toBe(201)
    expect(rejected.json().data.attempt).toMatchObject({ status: 'failed', providerState: 'failed', action: null })
    expect(await db.selectFrom('payment_receipts').select('payment_receipts.id')
      .innerJoin('payment_attempts', 'payment_attempts.id', 'payment_receipts.payment_attempt_id')
      .where('payment_attempts.order_id', '=', rejectedOrder).execute()).toHaveLength(0)
  })

  it('creates customer-only top-ups and credits cash once from an exact provider receipt', async () => {
    await db.updateTable('storefront_customer_policy').set({
      wallet_top_up_enabled: true, wallet_top_up_min_amount: '1.00', wallet_top_up_max_amount: '1000.00',
    }).where('singleton', '=', true).execute()
    const customer = await createCustomer()
    const otherCustomer = await createCustomer()
    const before = await inject({ method: 'GET', url: '/api/v1/customer/wallet', headers: customerHeaders(customer, false) })
    expect(before.statusCode).toBe(200)
    expect(before.json().data).toMatchObject({
      cashAvailable: '0.00', cashFrozen: '0.00', giftAvailable: '0.00', giftFrozen: '0.00', totalAvailable: '0.00',
    })

    const idempotencyKey = randomUUID()
    const created = await createWalletTopUp(customer, { amount: '10.00', idempotencyKey })
    expect(created.response.statusCode).toBe(201)
    expect(created.response.json().data.items[0]).toMatchObject({ id: created.attemptId, amount: '10.00', status: 'pending' })
    const attemptTarget = await db.selectFrom('payment_attempts').select(['order_id', 'topup_customer_id', 'source', 'amount'])
      .where('id', '=', created.attemptId).executeTakeFirstOrThrow()
    expect(attemptTarget).toEqual({ order_id: null, topup_customer_id: customer.id, source: 'external', amount: '10.00' })
    expect(await db.selectFrom('orders').select('id').where('customer_id', '=', customer.id).execute()).toHaveLength(0)
    expect((await inject({ method: 'GET', url: '/api/v1/customer/wallet', headers: customerHeaders(customer, false) })).json().data.cashAvailable)
      .toBe('0.00')

    const replay = await createWalletTopUp(customer, { amount: '10.00', idempotencyKey })
    expect(replay.response.statusCode).toBe(200)
    expect(replay.attemptId).toBe(created.attemptId)
    const secondTopUp = await createWalletTopUp(customer, { amount: '10.00' })
    expect(secondTopUp.response.statusCode).toBe(409)
    expect(await db.selectFrom('payment_attempts').select('id').where('topup_customer_id', '=', customer.id).execute()).toHaveLength(1)

    const merchantNo = (await db.selectFrom('payment_attempts').select('merchant_order_no')
      .where('id', '=', created.attemptId).executeTakeFirstOrThrow()).merchant_order_no!
    const callback = fixture.setPaid(merchantNo)
    expect((await inject({ method: 'GET', url: callbackUrl(callback) })).body).toBe('success')
    expect((await inject({ method: 'GET', url: callbackUrl(callback) })).body).toBe('success')
    const after = await inject({ method: 'GET', url: '/api/v1/customer/wallet', headers: customerHeaders(customer, false) })
    expect(after.json().data).toMatchObject({ cashAvailable: '10.00', giftAvailable: '0.00', totalAvailable: '10.00' })
    expect(await db.selectFrom('wallet_ledger_entries').select('id')
      .where('payment_attempt_id', '=', created.attemptId).where('bucket', '=', 'cash').execute()).toHaveLength(1)
    expect(await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', created.attemptId).execute())
      .toHaveLength(1)
    await expectWalletMatchesLedger(customer.id)

    const otherWallet = await inject({ method: 'GET', url: '/api/v1/customer/wallet', headers: customerHeaders(otherCustomer, false) })
    expect(otherWallet.json().data.cashAvailable).toBe('0.00')
    expect((await inject({
      method: 'POST', url: `/api/v1/customer/wallet/top-ups/${created.attemptId}/refresh`, headers: customerHeaders(otherCustomer),
    })).statusCode).toBe(404)
    expect((await inject({
      method: 'GET', url: `/api/v1/admin/wallets/${customer.id}?page=1&pageSize=20`, headers: adminHeaders(),
    })).json().data.wallet.cashAvailable).toBe('10.00')
    expect((await inject({ method: 'PUT', url: `/api/v1/admin/wallets/${customer.id}`, headers: adminHeaders(), payload: { cashAvailable: '999.00' } })).statusCode)
      .toBe(404)
    await expect(db.updateTable('wallet_accounts').set({ cash_available: '999.00' }).where('customer_id', '=', customer.id).execute())
      .rejects.toThrow()
  })

  it('refuses top-ups outside merchant limits and does not credit amount mismatches', async () => {
    await db.updateTable('storefront_customer_policy').set({
      wallet_top_up_enabled: true, wallet_top_up_min_amount: '5.00', wallet_top_up_max_amount: '20.00',
    }).where('singleton', '=', true).execute()
    const customer = await createCustomer()
    expect((await createWalletTopUp(customer, { amount: '4.99' })).response.statusCode).toBe(400)
    expect((await createWalletTopUp(customer, { amount: '20.01' })).response.statusCode).toBe(400)
    expect(await db.selectFrom('payment_attempts').select('id').where('topup_customer_id', '=', customer.id).execute()).toHaveLength(0)

    const created = await createWalletTopUp(customer, { amount: '10.00' })
    expect(created.response.statusCode).toBe(201)
    const merchantNo = (await db.selectFrom('payment_attempts').select('merchant_order_no')
      .where('id', '=', created.attemptId).executeTakeFirstOrThrow()).merchant_order_no!
    const callback = fixture.setPaid(merchantNo, { amount: '8.00' })
    expect((await inject({ method: 'GET', url: callbackUrl(callback) })).body).toBe('success')
    const attempt = await db.selectFrom('payment_attempts').select('status').where('id', '=', created.attemptId).executeTakeFirstOrThrow()
    const receipt = await db.selectFrom('payment_receipts').select(['amount', 'disposition'])
      .where('payment_attempt_id', '=', created.attemptId).executeTakeFirstOrThrow()
    const wallet = await db.selectFrom('wallet_accounts').select(['cash_available', 'cash_frozen'])
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow()
    expect(attempt.status).toBe('reconciliation_required')
    expect(receipt).toEqual({ amount: '8.00', disposition: 'amount_mismatch' })
    expect(wallet).toEqual({ cash_available: '0.00', cash_frozen: '0.00' })
    expect(await db.selectFrom('wallet_ledger_entries').select('id').where('payment_attempt_id', '=', created.attemptId).execute())
      .toHaveLength(0)
    expect(await db.selectFrom('payment_provider_reconciliation_cases').select(['reason', 'state'])
      .where('payment_attempt_id', '=', created.attemptId).execute()).toEqual([{ reason: 'provider_amount_mismatch', state: 'open' }])
  })

  it('settles full wallet payments once, spends gift funds first, and serializes two devices', async () => {
    const customer = await createCustomer()
    await creditGiftFixture(customer, '5.00')
    const orderId = await createOrder(customer, `双端钱包全额支付-${randomUUID().slice(0, 8)}`)
    const [first, second] = await Promise.all([
      createPayment(orderId, customer, { walletAmount: '5.00', idempotencyKey: randomUUID() }),
      fetch(`${api2BaseUrl}/api/v1/orders/${orderId}/payments`, {
        method: 'POST', headers: { ...customerHeaders(customer), 'content-type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: randomUUID(), walletAmount: '5.00' }),
      }),
    ])
    const secondStatus = second instanceof Response ? second.status : second.statusCode
    expect([201, 409]).toContain(first.statusCode)
    expect([201, 409]).toContain(secondStatus)
    expect(Number(first.statusCode === 201) + Number(secondStatus === 201)).toBe(1)
    const attempts = await db.selectFrom('payment_attempts').select(['id', 'source', 'status', 'amount'])
      .where('order_id', '=', orderId).execute()
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ source: 'wallet', status: 'succeeded', amount: '5.00' })
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('processing')
    expect(await db.selectFrom('wallet_ledger_entries').select(['bucket', 'action', 'amount'])
      .where('payment_attempt_id', '=', attempts[0]!.id).orderBy('line_no').execute())
      .toEqual([{ bucket: 'gift', action: 'debit_available', amount: '5.00' }])
    expect(await db.selectFrom('payment_receipts').select('amount').where('payment_attempt_id', '=', attempts[0]!.id).execute())
      .toEqual([{ amount: '5.00' }])
  })

  it('freezes a gift-first combination and settles only after an exact on-time receipt without an open case', async () => {
    await db.updateTable('storefront_customer_policy').set({ wallet_top_up_enabled: true, wallet_top_up_min_amount: '1.00', wallet_top_up_max_amount: '1000.00' })
      .where('singleton', '=', true).execute()
    const customer = await createCustomer()
    await creditGiftFixture(customer, '20.00')
    const topUp = await createWalletTopUp(customer, { amount: '30.00' })
    expect(topUp.response.statusCode).toBe(201)
    const topUpNo = (await db.selectFrom('payment_attempts').select('merchant_order_no')
      .where('id', '=', topUp.attemptId).executeTakeFirstOrThrow()).merchant_order_no!
    expect((await inject({ method: 'GET', url: callbackUrl(fixture.setPaid(topUpNo)) })).body).toBe('success')

    const orderId = await createOrder(customer, `钱包余额与在线组合-${randomUUID().slice(0, 8)}`, { amount: '100.00' })
    const idem = randomUUID()
    const [first, concurrent] = await Promise.all([
      createPayment(orderId, customer, { walletAmount: '50.00', idempotencyKey: idem }),
      createPayment(orderId, customer, { walletAmount: '50.00', idempotencyKey: randomUUID() }),
    ])
    expect(first.statusCode).toBe(201)
    expect(concurrent.statusCode).toBe(200)
    expect(concurrent.json().data.attempt.id).toBe(first.json().data.attempt.id)
    const attemptId = first.json().data.attempt.id as string
    expect(first.json().data.attempt).toMatchObject({ source: 'external', amount: '50.00', walletGiftAmount: '20.00', walletCashAmount: '30.00' })
    const frozen = await db.selectFrom('wallet_accounts').select(['cash_available', 'cash_frozen', 'gift_available', 'gift_frozen'])
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow()
    expect(frozen).toEqual({ cash_available: '0.00', cash_frozen: '30.00', gift_available: '0.00', gift_frozen: '20.00' })
    expect(await db.selectFrom('wallet_ledger_entries').select('id').where('wallet_operation_id', '=', idem).where('action', '=', 'freeze').execute())
      .toHaveLength(2)
    expect(await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', attemptId).execute())
      .toHaveLength(0)

    const attempt = await db.selectFrom('payment_attempts').select('merchant_order_no')
      .where('id', '=', attemptId).executeTakeFirstOrThrow()
    expect((await inject({ method: 'GET', url: callbackUrl(fixture.setPaid(attempt.merchant_order_no!)) })).body).toBe('success')
    const wallet = await db.selectFrom('wallet_accounts').select(['cash_available', 'cash_frozen', 'gift_available', 'gift_frozen'])
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow()
    expect(wallet).toEqual({ cash_available: '0.00', cash_frozen: '0.00', gift_available: '0.00', gift_frozen: '0.00' })
    const receipts = await db.selectFrom('payment_receipts').select([
      'payment_receipts.source_bucket', 'payment_receipts.amount', 'payment_receipts.disposition',
    ])
      .innerJoin('payment_attempts', 'payment_attempts.id', 'payment_receipts.payment_attempt_id')
      .where('payment_attempts.order_id', '=', orderId).execute()
    expect(receipts.reduce((total, receipt) => total + Number(receipt.amount), 0)).toBe(100)
    expect(receipts.every(receipt => receipt.disposition === 'on_time')).toBe(true)
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('processing')
    expect(await db.selectFrom('wallet_operations').select('id').where('resolves_operation_id', '=', idem).execute())
      .toHaveLength(1)
    await expectWalletMatchesLedger(customer.id)
  })

  it('keeps combo funds frozen for an on-time receipt with an open R1 case, then resolves from an authenticated query', async () => {
    const customer = await createCustomer()
    await creditGiftFixture(customer, '3.00')
    const orderId = await createOrder(customer, `R1组合核对冻结-${randomUUID().slice(0, 8)}`, { amount: '10.00' })
    const created = await createPayment(orderId, customer, { walletAmount: '3.00' })
    expect(created.statusCode).toBe(201)
    const attemptId = created.json().data.attempt.id as string
    const merchantNo = (await db.selectFrom('payment_attempts').select('merchant_order_no')
      .where('id', '=', attemptId).executeTakeFirstOrThrow()).merchant_order_no!
    const mismatch = fixture.setPaid(merchantNo)
    mismatch.money = '6.00'
    resignCallback(mismatch)
    expect((await inject({ method: 'GET', url: callbackUrl(mismatch) })).body).toBe('success')

    const attempt = await db.selectFrom('payment_attempts').select(['status', 'amount', 'wallet_hold_operation_id'])
      .where('id', '=', attemptId).executeTakeFirstOrThrow()
    const receipt = await db.selectFrom('payment_receipts').select(['amount', 'disposition'])
      .where('payment_attempt_id', '=', attemptId).executeTakeFirstOrThrow()
    const wallet = await db.selectFrom('wallet_accounts').select(['gift_available', 'gift_frozen'])
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow()
    expect(attempt.status).toBe('reconciliation_required')
    expect(attempt.amount).toBe('7.00')
    expect(receipt).toEqual({ amount: '7.00', disposition: 'on_time' })
    expect(wallet).toEqual({ gift_available: '0.00', gift_frozen: '3.00' })
    expect(await db.selectFrom('wallet_operations').select('id').where('resolves_operation_id', '=', attempt.wallet_hold_operation_id!).execute())
      .toHaveLength(0)
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('pending_payment')

    await db.updateTable('payment_attempt_provider_state').set({ last_query_at: new Date(Date.now() - 11_000) })
      .where('payment_attempt_id', '=', attemptId).execute()
    const resolution = await inject({
      method: 'POST', url: `/api/v1/admin/orders/${orderId}/payments/${attemptId}/reconcile`, headers: adminHeaders(),
    })
    expect(resolution.statusCode).toBe(200)
    expect(resolution.json().data.state).toBe('resolved')
    expect((await db.selectFrom('wallet_accounts').select(['gift_available', 'gift_frozen'])
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow())).toEqual({ gift_available: '0.00', gift_frozen: '0.00' })
    expect(await db.selectFrom('wallet_operations').select('id').where('resolves_operation_id', '=', attempt.wallet_hold_operation_id!).execute())
      .toHaveLength(1)
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('processing')
  })

  it('releases combo funds after a definitive provider rejection and retains them for an unknown result', async () => {
    const customer = await createCustomer()
    await creditGiftFixture(customer, '4.00')
    const rejectedOrder = await createOrder(customer, `__reject__combo-${randomUUID().slice(0, 8)}`, { amount: '10.00' })
    const rejected = await createPayment(rejectedOrder, customer, { walletAmount: '4.00' })
    expect(rejected.statusCode).toBe(201)
    expect(rejected.json().data.attempt.status).toBe('failed')
    expect((await db.selectFrom('wallet_accounts').select(['gift_available', 'gift_frozen'])
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow())).toEqual({ gift_available: '4.00', gift_frozen: '0.00' })
    const holdId = (await db.selectFrom('payment_attempts').select('wallet_hold_operation_id')
      .where('order_id', '=', rejectedOrder).executeTakeFirstOrThrow()).wallet_hold_operation_id!
    expect(await db.selectFrom('wallet_operations').select(['operation_type', 'resolves_operation_id'])
      .where('resolves_operation_id', '=', holdId).execute()).toEqual([{ operation_type: 'order_payment_release', resolves_operation_id: holdId }])

    const unknownOrder = await createOrder(customer, `__unknown__combo-${randomUUID().slice(0, 8)}`, { amount: '10.00' })
    const unknownKey = randomUUID()
    const unknown = await createPayment(unknownOrder, customer, { walletAmount: '4.00', idempotencyKey: unknownKey })
    expect(unknown.statusCode).toBe(201)
    expect(unknown.json().data.attempt.providerState).toBe('unknown')
    expect(unknown.json().data.attempt.status).toBe('pending')
    const retry = await createPayment(unknownOrder, customer, { walletAmount: '4.00', idempotencyKey: randomUUID() })
    expect(retry.statusCode).toBe(200)
    expect(retry.json().data.attempt.id).toBe(unknown.json().data.attempt.id)
    expect((await db.selectFrom('wallet_accounts').select(['gift_available', 'gift_frozen'])
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow())).toEqual({ gift_available: '0.00', gift_frozen: '4.00' })
    const unknownHold = (await db.selectFrom('payment_attempts').select('wallet_hold_operation_id')
      .where('order_id', '=', unknownOrder).executeTakeFirstOrThrow()).wallet_hold_operation_id!
    expect(await db.selectFrom('wallet_operations').select('id').where('id', '=', unknownHold).execute()).toHaveLength(1)
    expect(await db.selectFrom('payment_attempts').select('id').where('order_id', '=', unknownOrder).execute()).toHaveLength(1)
  })

  it('does not allow guests, insufficient balances, or disabled customers to create wallet payment plans', async () => {
    const customer = await createCustomer()
    const orderId = await createOrder(customer)
    const insufficient = await createPayment(orderId, customer, { walletAmount: '5.00' })
    expect(insufficient.statusCode).toBe(409)
    expect(insufficient.json().error.code).toBe('WALLET_INSUFFICIENT_BALANCE')
    expect(await db.selectFrom('payment_attempts').select('id').where('order_id', '=', orderId).execute()).toHaveLength(0)

    const guest = await createGuestSession()
    const guestOrderId = await createOrder(guest)
    const guestPayment = await createPayment(guestOrderId, guest, { walletAmount: '5.00' })
    expect(guestPayment.statusCode).toBe(403)
    expect(guestPayment.json().error.code).toBe('WALLET_LOGIN_REQUIRED')

    await creditGiftFixture(customer, '5.00')
    const disabledOrder = await createOrder(customer, `钱包账户禁用-${randomUUID().slice(0, 8)}`)
    await db.updateTable('customers').set({ status: 'disabled' }).where('id', '=', customer.id).execute()
    const disabledPayment = await createPayment(disabledOrder, customer, { walletAmount: '5.00' })
    expect([401, 403]).toContain(disabledPayment.statusCode)
    expect(await db.selectFrom('payment_attempts').select('id').where('order_id', '=', disabledOrder).execute()).toHaveLength(0)
    const account = await db.selectFrom('wallet_accounts').select(['gift_available', 'gift_frozen'])
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow()
    expect(account).toEqual({ gift_available: '5.00', gift_frozen: '0.00' })
  })

  it('keeps an exact top-up receipt uncredited while R1 evidence is open, then credits once after admin query resolution', async () => {
    await db.updateTable('storefront_customer_policy').set({ wallet_top_up_enabled: true, wallet_top_up_min_amount: '1.00', wallet_top_up_max_amount: '1000.00' })
      .where('singleton', '=', true).execute()
    const customer = await createCustomer()
    const created = await createWalletTopUp(customer, { amount: '12.00' })
    expect(created.response.statusCode).toBe(201)
    const merchantNo = (await db.selectFrom('payment_attempts').select('merchant_order_no')
      .where('id', '=', created.attemptId).executeTakeFirstOrThrow()).merchant_order_no!
    const callback = fixture.setPaid(merchantNo)
    callback.money = '11.00'
    resignCallback(callback)
    expect((await inject({ method: 'GET', url: callbackUrl(callback) })).body).toBe('success')

    const held = await db.selectFrom('payment_attempts').select('status').where('id', '=', created.attemptId).executeTakeFirstOrThrow()
    const receipt = await db.selectFrom('payment_receipts').select(['amount', 'disposition'])
      .where('payment_attempt_id', '=', created.attemptId).executeTakeFirstOrThrow()
    const before = await db.selectFrom('wallet_accounts').select('cash_available')
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow()
    expect(held.status).toBe('reconciliation_required')
    expect(receipt).toEqual({ amount: '12.00', disposition: 'on_time' })
    expect(before.cash_available).toBe('0.00')
    expect(await db.selectFrom('wallet_ledger_entries').select('id')
      .where('payment_attempt_id', '=', created.attemptId).execute()).toHaveLength(0)
    expect(await db.selectFrom('payment_provider_reconciliation_cases').select(['reason', 'state'])
      .where('payment_attempt_id', '=', created.attemptId).execute())
      .toEqual([{ reason: 'callback_query_mismatch', state: 'open' }])

    await db.updateTable('payment_attempt_provider_state').set({ last_query_at: new Date(Date.now() - 11_000) })
      .where('payment_attempt_id', '=', created.attemptId).execute()
    const resolved = await inject({
      method: 'POST',
      url: `/api/v1/admin/wallets/${customer.id}/top-ups/${created.attemptId}/reconcile`,
      headers: adminHeaders(),
    })
    expect(resolved.statusCode).toBe(200)
    expect(resolved.json().data.state).toBe('resolved')
    const after = await db.selectFrom('wallet_accounts').select('cash_available')
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow()
    expect(after.cash_available).toBe('12.00')
    expect(await db.selectFrom('wallet_ledger_entries').select('id')
      .where('payment_attempt_id', '=', created.attemptId).execute()).toHaveLength(1)
    await expectWalletMatchesLedger(customer.id)
  })

  it('serializes a shared provider transaction across a top-up and combo attempt on two API instances', async () => {
    await db.updateTable('storefront_customer_policy').set({ wallet_top_up_enabled: true, wallet_top_up_min_amount: '1.00', wallet_top_up_max_amount: '1000.00' })
      .where('singleton', '=', true).execute()
    const customer = await createCustomer()
    await creditGiftFixture(customer, '2.00')
    const orderId = await createOrder(customer, `跨支付类型交易号竞争-${randomUUID().slice(0, 8)}`, { amount: '10.00' })
    const combo = await createPayment(orderId, customer, { walletAmount: '2.00' })
    expect(combo.statusCode).toBe(201)
    const comboAttemptId = combo.json().data.attempt.id as string
    const topUp = await createWalletTopUp(customer, { amount: '3.00' })
    expect(topUp.response.statusCode).toBe(201)
    const attempts = await db.selectFrom('payment_attempts').select(['id', 'merchant_order_no'])
      .where('id', 'in', [comboAttemptId, topUp.attemptId]).execute()
    const transactionId = `SHARED-${randomUUID()}`
    const callbacks = new Map<string, Record<string, string>>()
    for (const attempt of attempts) {
      const callback = fixture.setPaid(attempt.merchant_order_no!, { providerOrderId: transactionId })
      callbacks.set(attempt.id, callback)
    }

    const comboCallback = callbacks.get(comboAttemptId)!
    const topUpCallback = callbacks.get(topUp.attemptId)!
    const [comboResponse, topUpResponse] = await Promise.all([
      inject({ method: 'GET', url: callbackUrl(comboCallback) }),
      fetch(`${api2BaseUrl}${callbackUrl(topUpCallback)}`),
    ])
    expect(comboResponse.statusCode).toBe(200)
    expect(topUpResponse.status).toBe(200)
    const receipts = await db.selectFrom('payment_receipts').select(['payment_attempt_id', 'amount'])
      .where('provider_transaction_id', '=', transactionId).execute()
    expect(receipts).toHaveLength(1)
    const statuses = await db.selectFrom('payment_attempts').select(['id', 'status'])
      .where('id', 'in', [comboAttemptId, topUp.attemptId]).execute()
    expect(statuses.filter(attempt => attempt.status === 'succeeded')).toHaveLength(1)
    expect(statuses.filter(attempt => attempt.status === 'reconciliation_required')).toHaveLength(1)
    expect(await db.selectFrom('payment_provider_reconciliation_cases').select('reason')
      .where('payment_attempt_id', 'in', [comboAttemptId, topUp.attemptId]).where('state', '=', 'open').execute())
      .toEqual([{ reason: 'provider_transaction_conflict' }])
    await expectWalletMatchesLedger(customer.id)
  })

  it('closes an expired combo order on late receipt and releases its held wallet funds exactly once', async () => {
    const customer = await createCustomer()
    await creditGiftFixture(customer, '2.00')
    const orderId = await createOrder(customer, `组合付款迟到收款-${randomUUID().slice(0, 8)}`, { amount: '10.00', quantityStock: 1 })
    const created = await createPayment(orderId, customer, { walletAmount: '2.00' })
    expect(created.statusCode).toBe(201)
    const attemptId = created.json().data.attempt.id as string
    const merchantNo = (await db.selectFrom('payment_attempts').select('merchant_order_no')
      .where('id', '=', attemptId).executeTakeFirstOrThrow()).merchant_order_no!
    const callback = fixture.setPaid(merchantNo)

    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_guard`.execute(db)
    await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_deadline_r1`.execute(db)
    try {
      await db.updateTable('orders').set({ unpaid_expires_at: new Date(Date.now() - 2_000) }).where('id', '=', orderId).execute()
      await sql`UPDATE payment_attempts SET created_at = clock_timestamp() - interval '1 minute',
        expires_at = clock_timestamp() - interval '2 seconds' WHERE id = ${attemptId}::uuid`.execute(db)
    } finally {
      await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_deadline_r1`.execute(db)
      await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_guard`.execute(db)
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }

    await expireDueUnpaidOrders(db)
    const callbackResult = await inject({ method: 'GET', url: callbackUrl(callback) })
    expect(callbackResult.statusCode).toBe(200)
    expect((await db.selectFrom('payment_receipts').select('disposition')
      .where('payment_attempt_id', '=', attemptId).executeTakeFirstOrThrow()).disposition).toBe('late')
    expect((await db.selectFrom('payment_attempts').select('status')
      .where('id', '=', attemptId).executeTakeFirstOrThrow()).status).toBe('late_succeeded')
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('pending_payment')
    expect((await db.selectFrom('wallet_accounts').select(['gift_available', 'gift_frozen'])
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow())).toEqual({ gift_available: '2.00', gift_frozen: '0.00' })
    const holdId = (await db.selectFrom('payment_attempts').select('wallet_hold_operation_id')
      .where('id', '=', attemptId).executeTakeFirstOrThrow()).wallet_hold_operation_id!
    expect(await db.selectFrom('wallet_operations').select('id')
      .where('operation_type', '=', 'order_payment_release').where('resolves_operation_id', '=', holdId).execute())
      .toHaveLength(1)
    await expectWalletMatchesLedger(customer.id)

    await db.updateTable('payment_attempt_provider_state').set({ last_query_at: new Date(Date.now() - 11_000) })
      .where('payment_attempt_id', '=', attemptId).execute()
    const reconciled = await inject({
      method: 'POST', url: `/api/v1/admin/orders/${orderId}/payments/${attemptId}/reconcile`, headers: adminHeaders(),
    })
    expect(reconciled.statusCode).toBe(200)
    expect(reconciled.json().data.state).toBe('resolved')
    expect(await expireDueUnpaidOrders(db)).toBe(0)
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('pending_payment')
    const inventory = await db.selectFrom('product_variant_quantity_inventory as inventory')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.product_variant_id', 'inventory.product_variant_id')
      .innerJoin('order_items as item', 'item.id', 'reservation.order_item_id')
      .select('inventory.reserved').where('item.order_id', '=', orderId).executeTakeFirstOrThrow()
    expect(inventory.reserved).toBe(1)
  })
})
