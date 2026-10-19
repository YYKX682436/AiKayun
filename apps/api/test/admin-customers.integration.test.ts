import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import type { FastifyInstance } from 'fastify'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { hashPassword } from '../src/auth/password.js'
import { hashToken } from '../src/auth/security.js'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const origin = 'http://localhost:3000'
const digest = 'a'.repeat(64)
const adminEmail = 'customer-admin@example.test'
const adminPassword = 'Admin-Only-Password-2026!'
const customerPassword = 'Customer-Only-Password-2026!'
let app: FastifyInstance
let db: Kysely<Database>
let adminId: string
let nextIp = 40

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const header = response.headers['set-cookie']
  const cookies = Array.isArray(header) ? header : header ? [header] : []
  const cookie = cookies.find(value => value.startsWith(`${name}=`))
  if (!cookie) throw new Error(`Expected ${name} cookie`)
  return cookie.split(';', 1)[0] ?? ''
}

async function adminAuth() {
  const csrfResponse = await app.inject('/api/v1/admin/auth/csrf')
  const csrf = csrfResponse.json().data.csrfToken as string
  const csrfCookie = cookieFrom(csrfResponse, 'aikayun_admin_csrf')
  const login = await app.inject({
    method: 'POST', url: '/api/v1/admin/auth/login', remoteAddress: `192.0.2.${nextIp++}`,
    headers: { origin, cookie: csrfCookie, 'x-csrf-token': csrf },
    payload: { email: adminEmail, password: adminPassword },
  })
  expect(login.statusCode).toBe(200)
  return { session: cookieFrom(login, 'aikayun_admin_session'), csrf, csrfCookie }
}

function headers(auth: Awaited<ReturnType<typeof adminAuth>>, options: { origin?: string; csrf?: string } = {}) {
  return {
    origin: options.origin ?? origin,
    cookie: `${auth.session}; ${auth.csrfCookie}`,
    'x-csrf-token': options.csrf ?? auth.csrf,
  }
}

async function createCustomer(username: string, options: {
  email?: string | null
  phone?: string | null
  status?: 'active' | 'disabled'
  emailVerified?: boolean
  phoneVerified?: boolean
} = {}) {
  const id = randomUUID()
  await db.insertInto('customers').values({
    id, username, password_hash: await hashPassword(customerPassword),
    email: options.email === undefined ? `${username}@example.test` : options.email,
    email_verified_at: options.emailVerified ? new Date() : null,
    phone: options.phone?.replace(/[ ()-]/g, '') ?? null,
    phone_verified_at: options.phoneVerified ? new Date() : null,
    status: options.status ?? 'active',
  }).execute()
  return id
}

async function createCustomerSession(customerId: string) {
  const token = randomUUID().replaceAll('-', '').padEnd(43, 'x').slice(0, 43)
  const id = randomUUID()
  await db.insertInto('customer_sessions').values({
    id, customer_id: customerId, token_hash: hashToken(token),
    expires_at: new Date(Date.now() + 60 * 60_000), revoked_at: null,
  }).execute()
  return { id, cookie: `aikayun_customer_session=${token}` }
}

async function createCatalog() {
  const productId = randomUUID()
  const variantId = randomUUID()
  const productName = `Deletion fixture ${productId.slice(0, 8)}`
  await db.transaction().execute(async trx => {
    await trx.insertInto('products').values({
      id: productId, name: productName,
      description: 'Real PostgreSQL transaction fixture', product_type: 'digital', status: 'active',
    }).execute()
    await trx.insertInto('product_variants').values({
      id: variantId, product_id: productId, sku_code: `SKU-${variantId.slice(0, 8)}`,
      combination_key: '', sale_price: '10.00', compare_at_price: null, cost_price: null,
      enabled: true, retired_at: null, inventory_mode: null, inventory_revision: 0,
    }).execute()
    await trx.updateTable('product_variants').set({ inventory_mode: 'unlimited', inventory_revision: 1 })
      .where('id', '=', variantId).execute()
    await trx.insertInto('product_variant_fulfillment').values({
      product_variant_id: variantId, method: 'manual', manual_delivery_ready: true,
    }).execute()
  })
  return { productId, variantId, productName, skuCode: `SKU-${variantId.slice(0, 8)}` }
}

async function insertOrder(trx: Kysely<Database>, customerId: string, catalog: Awaited<ReturnType<typeof createCatalog>>) {
  const id = randomUUID()
  const itemId = randomUUID()
  await trx.insertInto('orders').values({
    id, customer_id: customerId, guest_order_session_id: null, idempotency_key: randomUUID(),
    request_sha256: digest, total_amount: '10.00', unpaid_expires_at: new Date(Date.now() + 60_000),
    history_hidden_at: null, history_hidden_by_admin_id: null, history_hidden_reason: null,
  }).execute()
  await trx.insertInto('order_items').values({
    id: itemId, order_id: id, product_id: catalog.productId, product_variant_id: catalog.variantId,
    product_name_snapshot: catalog.productName, product_type_snapshot: 'digital', sku_code_snapshot: catalog.skuCode,
    sku_snapshot: JSON.stringify([]), inventory_mode_snapshot: 'unlimited', fulfillment_method_snapshot: 'manual',
    unit_price: '10.00', quantity: 1, line_amount: '10.00',
  }).execute()
  await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', id).execute()
  return { id, itemId }
}

async function completePaidOrder(customerId: string) {
  const catalog = await createCatalog()
  const order = await db.transaction().execute(trx => insertOrder(trx, customerId, catalog))
  const attemptId = randomUUID()
  await db.transaction().execute(async trx => {
    await trx.insertInto('payment_attempts').values({
      id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: order.id,
      topup_customer_id: null, source: 'external', amount: '10.00', provider: 'epay-compatible',
      provider_payment_id: `paid-${attemptId}`, wallet_operation_id: null,
      expires_at: new Date(Date.now() + 60_000), completed_at: null,
    }).execute()
    await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
    await trx.insertInto('payment_receipts').values({
      id: randomUUID(), payment_attempt_id: attemptId, source_bucket: 'external', provider: 'epay-compatible',
      provider_transaction_id: `transaction-${attemptId}`, wallet_operation_id: null, wallet_line_no: null, amount: '10.00',
    }).execute()
  })
  const fulfillmentId = randomUUID()
  await db.insertInto('order_item_fulfillment_attempts').values({
    id: fulfillmentId, order_item_id: order.itemId, operation_id: randomUUID(), quantity: 1,
    started_by_admin_id: adminId, status: 'processing', result_sha256: null, completed_at: null,
  }).execute()
  await db.insertInto('order_item_fulfillment_deliveries').values({
    id: randomUUID(), fulfillment_attempt_id: fulfillmentId, started_by_admin_id: adminId,
    unit_index: 1, content: 'integration-test-private-delivery', content_sha256: digest,
  }).execute()
  await db.updateTable('order_item_fulfillment_attempts').set({ status: 'succeeded', result_sha256: digest })
    .where('id', '=', fulfillmentId).execute()
  return order
}

async function createLateReceipt(customerId: string) {
  const catalog = await createCatalog()
  const order = await db.transaction().execute(trx => insertOrder(trx, customerId, catalog))
  const attemptId = randomUUID()
  const receiptId = randomUUID()
  await db.transaction().execute(async trx => {
    await trx.insertInto('payment_attempts').values({
      id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: order.id,
      topup_customer_id: null, source: 'external', amount: '10.00', provider: 'epay-compatible',
      provider_payment_id: `late-${attemptId}`, wallet_operation_id: null,
      expires_at: new Date(Date.now() + 900), completed_at: null,
    }).execute()
    await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
    await trx.updateTable('payment_attempts').set({ status: 'expired' }).where('id', '=', attemptId).execute()
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await trx.insertInto('payment_receipts').values({
      id: receiptId, payment_attempt_id: attemptId, source_bucket: 'external', provider: 'epay-compatible',
      provider_transaction_id: `late-receipt-${attemptId}`, wallet_operation_id: null, wallet_line_no: null, amount: '10.00',
    }).execute()
  })
  return { ...order, attemptId, receiptId }
}

async function createReceiptRefund(orderId: string, receiptId: string, amount: string, destination: 'original_source' | 'cash_balance' = 'original_source') {
  return createRefund(orderId, [{ receiptId, amount }], amount, destination)
}

async function createRefund(
  orderId: string,
  sources: Array<{ receiptId: string; amount: string }>,
  amount: string,
  destination: 'original_source' | 'cash_balance' = 'original_source',
) {
  const refundId = randomUUID()
  const allocationIds: string[] = []
  await db.transaction().execute(async trx => {
    await trx.insertInto('order_refunds').values({
      id: refundId, order_id: orderId, idempotency_key: randomUUID(), request_sha256: digest, amount,
    }).execute()
    await trx.updateTable('order_refunds').set({ status: 'approved' }).where('id', '=', refundId).execute()
    await trx.updateTable('order_refunds').set({ status: 'processing' }).where('id', '=', refundId).execute()
    for (const source of sources) {
      const allocationId = randomUUID()
      allocationIds.push(allocationId)
      await trx.insertInto('order_refund_allocations').values({
        id: allocationId, refund_id: refundId, source_payment_receipt_id: source.receiptId,
        operation_id: randomUUID(), request_sha256: digest, destination, amount: source.amount,
        provider: null, provider_refund_id: null, completed_at: null,
      }).execute()
      await trx.updateTable('order_refund_allocations').set(destination === 'original_source'
        ? { status: 'succeeded', provider: 'epay-compatible', provider_refund_id: `refund-${randomUUID()}` }
        : { status: 'succeeded' }).where('id', '=', allocationId).execute()
    }
    await trx.updateTable('order_refunds').set({ status: 'succeeded' }).where('id', '=', refundId).execute()
  })
  return { refundId, allocationIds }
}

async function createFullyRefundedLateOrder(customerId: string) {
  const late = await createLateReceipt(customerId)
  const refund = await createReceiptRefund(late.id, late.receiptId, '10.00')
  return { ...late, ...refund }
}

async function createExceptionalReceipt(customerId: string, kind: 'mismatch' | 'excess') {
  const catalog = await createCatalog()
  const order = await db.transaction().execute(trx => insertOrder(trx, customerId, catalog))
  const receiptIds: Array<{ receiptId: string; amount: string }> = []
  if (kind === 'excess') {
    const baseAttemptId = randomUUID()
    const baseReceiptId = randomUUID()
    await db.transaction().execute(async trx => {
      await trx.insertInto('payment_attempts').values({
        id: baseAttemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: order.id,
        topup_customer_id: null, source: 'external', amount: '6.00', provider: 'epay-compatible',
        provider_payment_id: `base-${baseAttemptId}`, wallet_operation_id: null,
        expires_at: new Date(Date.now() + 60_000), completed_at: null,
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', baseAttemptId).execute()
      await trx.insertInto('payment_receipts').values({
        id: baseReceiptId, payment_attempt_id: baseAttemptId, source_bucket: 'external', provider: 'epay-compatible',
        provider_transaction_id: `base-receipt-${baseAttemptId}`, wallet_operation_id: null, wallet_line_no: null,
        amount: '6.00',
      }).execute()
    })
    receiptIds.push({ receiptId: baseReceiptId, amount: '6.00' })
  }

  const attemptId = randomUUID()
  const receiptId = randomUUID()
  const expectedAmount = kind === 'mismatch' ? '10.00' : '5.00'
  const receivedAmount = kind === 'mismatch' ? '9.00' : '5.00'
  await db.transaction().execute(async trx => {
    await trx.insertInto('payment_attempts').values({
      id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: order.id,
      topup_customer_id: null, source: 'external', amount: expectedAmount, provider: 'epay-compatible',
      provider_payment_id: `exception-${attemptId}`, wallet_operation_id: null,
      expires_at: new Date(Date.now() + 900), completed_at: null,
    }).execute()
    await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
    await trx.insertInto('payment_receipts').values({
      id: receiptId, payment_attempt_id: attemptId, source_bucket: 'external', provider: 'epay-compatible',
      provider_transaction_id: `exception-receipt-${attemptId}`, wallet_operation_id: null, wallet_line_no: null,
      amount: receivedAmount,
    }).execute()
  })
  receiptIds.push({ receiptId, amount: receivedAmount })
  return { ...order, attemptId, receiptId, receivedAmount, receiptIds }
}

async function createFullyRefundedExceptionalOrder(customerId: string, kind: 'mismatch' | 'excess') {
  const exceptional = await createExceptionalReceipt(customerId, kind)
  await new Promise(resolve => setTimeout(resolve, 1_100))
  const total = exceptional.receiptIds.reduce((sum, receipt) => sum + Number(receipt.amount), 0).toFixed(2)
  const refund = await createRefund(exceptional.id, exceptional.receiptIds, total)
  return { ...exceptional, ...refund }
}

async function waitForLock(queryFragment: string) {
  await expect.poll(async () => {
    const result = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${`%${queryFragment}%`}
    `.execute(db)
    return Number(result.rows[0]?.count ?? 0)
  }, { timeout: 5000, intervals: [20, 50, 100] }).toBeGreaterThan(0)
}

beforeAll(async () => {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL must point to a dedicated PostgreSQL database ending in _test')
  const databaseUrl = new URL(testDatabaseUrl)
  if (!databaseUrl.pathname.slice(1).endsWith('_test')) {
    throw new Error('Refusing to run customer-management integration tests unless TEST_DATABASE_URL names a database ending in _test')
  }
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`DROP SCHEMA public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const migrated = await migrator.migrateToLatest()
  if (migrated.error) throw migrated.error
  adminId = randomUUID()
  await db.insertInto('admin_users').values({
    id: adminId, email: adminEmail, password_hash: await hashPassword(adminPassword),
  }).execute()
  app = await createApp({ db, config: readConfig({
    ...process.env, NODE_ENV: 'test', PUBLIC_ORIGIN: origin, COOKIE_SECURE: 'false',
    DATABASE_URL: testDatabaseUrl,
  }), logger: false })
})

afterAll(async () => {
  if (app) await app.close()
  if (db) await db.destroy()
})

describe('④-3 admin customer management on PostgreSQL', () => {
  it('uses administrator auth, Origin and CSRF and returns only safe paginated customer data', async () => {
    const first = await createCustomer('Search-Mira', { email: 'mira-search@example.test', phone: '+86 138-0000-1122' })
    const second = await createCustomer('Search-Nova', { email: 'nova@example.test', phone: '+86 139-0000-3344', status: 'disabled' })
    await createCustomer('Deleted-Legacy', { status: 'disabled' }).then(id => db.updateTable('customers')
      .set({ status: 'deleted', username: null, password_hash: null, email: null }).where('id', '=', id).execute())

    expect((await app.inject('/api/v1/admin/customers')).statusCode).toBe(401)
    const customerSession = await createCustomerSession(first)
    expect((await app.inject({ url: '/api/v1/admin/customers', headers: { cookie: customerSession.cookie } })).statusCode).toBe(401)
    const auth = await adminAuth()
    const list = await app.inject({ url: '/api/v1/admin/customers?page=1&pageSize=1&sortOrder=asc', headers: headers(auth) })
    expect(list.statusCode).toBe(200)
    expect(list.headers['cache-control']).toContain('no-store')
    expect(list.json().data).toMatchObject({ page: 1, pageSize: 1, total: 2, totalPages: 2 })
    expect(list.json().data.items).toHaveLength(1)

    for (const term of ['mira-search', 'MIRA-SEARCH@EXAMPLE', '+86 138']) {
      const result = await app.inject({ url: `/api/v1/admin/customers?search=${encodeURIComponent(term)}`, headers: headers(auth) })
      expect(result.statusCode).toBe(200)
      expect(result.json().data.items.map((item: { id: string }) => item.id)).toContain(first)
    }
    const disabled = await app.inject({ url: '/api/v1/admin/customers?status=disabled', headers: headers(auth) })
    expect(disabled.json().data.items.map((item: { id: string }) => item.id)).toContain(second)
    expect(disabled.json().data.items.map((item: { status: string }) => item.status)).not.toContain('deleted')
    const deleted = await app.inject({ url: '/api/v1/admin/customers?status=deleted', headers: headers(auth) })
    expect(deleted.json().data.items).toHaveLength(1)
    const malformed = await app.inject({ url: '/api/v1/admin/customers?page=0', headers: headers(auth) })
    expect(malformed.statusCode).toBe(400)

    const detail = await app.inject({ url: `/api/v1/admin/customers/${first}`, headers: headers(auth) })
    expect(detail.json().data.customer.emailVerifiedAt).toBeNull()
    expect(detail.json().data).not.toHaveProperty('customer.password_hash')
    expect(detail.body).not.toContain('test-only-password-hash')

    const noCsrf = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/customers/${first}/profile`,
      headers: { origin, cookie: `${auth.session}; ${auth.csrfCookie}` }, payload: { username: 'Search-Mira-Changed' },
    })
    expect(noCsrf.statusCode).toBe(403)
    const badOrigin = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/customers/${first}/profile`,
      headers: headers(auth, { origin: 'https://attacker.example' }), payload: { username: 'Search-Mira-Changed' },
    })
    expect(badOrigin.statusCode).toBe(403)
  })

  it('normalizes unique username conflicts, clears contact verification and records immutable non-secret audit', async () => {
    const one = await createCustomer('Profile-One', { email: 'old@example.test', phone: '+8613800000011', emailVerified: true, phoneVerified: true })
    const two = await createCustomer('Profile-Two')
    const auth = await adminAuth()
    const concurrent = await Promise.all([
      app.inject({ method: 'PATCH', url: `/api/v1/admin/customers/${one}/profile`, headers: headers(auth), payload: { username: 'Profile-Race' } }),
      app.inject({ method: 'PATCH', url: `/api/v1/admin/customers/${two}/profile`, headers: headers(auth), payload: { username: 'profile-race' } }),
    ])
    expect(concurrent.map(response => response.statusCode).sort()).toEqual([200, 409])
    const winner = concurrent[0]!.statusCode === 200 ? one : two
    const contact = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/customers/${one}/profile`, headers: headers(auth),
      payload: { email: 'NEW@Example.test', phone: '+86 (139) 0000-0012' },
    })
    expect(contact.statusCode).toBe(200)
    expect(contact.json().data.customer).toMatchObject({ email: 'new@example.test', phone: '+8613900000012', emailVerifiedAt: null, phoneVerifiedAt: null })
    const audits = await app.inject({ url: `/api/v1/admin/customers/${one}/audit`, headers: headers(auth) })
    expect(audits.json().data.items.map((entry: { action: string }) => entry.action)).toContain('contact_updated')
    expect(audits.json().data.items.every((entry: { administratorId: string; customerId: string }) => entry.administratorId === adminId && entry.customerId === one)).toBe(true)
    expect(audits.body).not.toContain('new@example.test')
    expect(audits.body).not.toContain(customerPassword)
    const auditId = audits.json().data.items[0].id as string
    await expect(db.deleteFrom('customer_management_audit').where('id', '=', auditId).execute()).rejects.toMatchObject({ constraint: 'customer_management_audit_immutable' })
    await expect(db.updateTable('customer_management_audit').set({ summary: { secret: 'x' } }).where('id', '=', auditId).execute()).rejects.toMatchObject({ constraint: 'customer_management_audit_immutable' })
    await expect(sql`TRUNCATE customer_management_audit`.execute(db)).rejects.toMatchObject({ constraint: 'customer_management_audit_immutable' })
    expect(winner).toBeDefined()
  })

  it('revokes every session on disable and password reset; restore never revives old sessions', async () => {
    const customerId = await createCustomer('Session-Owner')
    const sessionA = await createCustomerSession(customerId)
    await createCustomerSession(customerId)
    const auth = await adminAuth()
    const disabled = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/customers/${customerId}/status`, headers: headers(auth), payload: { status: 'disabled' },
    })
    expect(disabled.statusCode).toBe(200)
    expect((await app.inject({ url: '/api/v1/customer/profile', headers: { cookie: sessionA.cookie } })).statusCode).toBe(401)
    const restored = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/customers/${customerId}/status`, headers: headers(auth), payload: { status: 'active' },
    })
    expect(restored.statusCode).toBe(200)
    expect((await app.inject({ url: '/api/v1/customer/profile', headers: { cookie: sessionA.cookie } })).statusCode).toBe(401)

    const resetSessionA = await createCustomerSession(customerId)
    const resetSessionB = await createCustomerSession(customerId)
    const temporaryPassword = 'Temporary-Password-Only-2026!'
    const reset = await app.inject({
      method: 'PUT', url: `/api/v1/admin/customers/${customerId}/password-reset`, headers: headers(auth),
      payload: { temporaryPassword },
    })
    expect(reset.statusCode).toBe(200)
    expect(reset.json().data.revokedSessionCount).toBeGreaterThanOrEqual(2)
    expect(reset.body).not.toContain(temporaryPassword)
    expect((await app.inject({ url: '/api/v1/customer/profile', headers: { cookie: resetSessionA.cookie } })).statusCode).toBe(401)
    expect((await app.inject({ url: '/api/v1/customer/profile', headers: { cookie: resetSessionB.cookie } })).statusCode).toBe(401)
    const oldLoginCsrf = await app.inject('/api/v1/customer/auth/csrf')
    const oldToken = oldLoginCsrf.json().data.csrfToken as string
    const oldCookie = cookieFrom(oldLoginCsrf, 'aikayun_customer_csrf')
    const oldLogin = await app.inject({
      method: 'POST', url: '/api/v1/customer/auth/login', remoteAddress: `192.0.2.${nextIp++}`,
      headers: { origin, cookie: oldCookie, 'x-csrf-token': oldToken }, payload: { username: 'Session-Owner', password: customerPassword },
    })
    expect(oldLogin.statusCode).toBe(401)
    const newCsrf = await app.inject('/api/v1/customer/auth/csrf')
    const newToken = newCsrf.json().data.csrfToken as string
    const newCookie = cookieFrom(newCsrf, 'aikayun_customer_csrf')
    const newLogin = await app.inject({
      method: 'POST', url: '/api/v1/customer/auth/login', remoteAddress: `192.0.2.${nextIp++}`,
      headers: { origin, cookie: newCookie, 'x-csrf-token': newToken }, payload: { username: 'Session-Owner', password: temporaryPassword },
    })
    expect(newLogin.statusCode).toBe(200)
    const audit = await app.inject({ url: `/api/v1/admin/customers/${customerId}/audit`, headers: headers(auth) })
    expect(audit.body).not.toContain(temporaryPassword)
    expect(audit.json().data.items.map((entry: { action: string }) => entry.action)).toEqual(expect.arrayContaining(['disabled', 'restored', 'password_reset']))
  })

  it('serializes administrator reset against customer login and password change', async () => {
    const username = 'Password-Race-Owner'
    const customerId = await createCustomer(username)
    const customerSession = await createCustomerSession(customerId)
    const customerCsrfResponse = await app.inject('/api/v1/customer/auth/csrf')
    const customerCsrf = customerCsrfResponse.json().data.csrfToken as string
    const customerCsrfCookie = cookieFrom(customerCsrfResponse, 'aikayun_customer_csrf')
    const auth = await adminAuth()
    const temporaryPassword = 'Race-Temporary-Password-2026!'
    const selfServicePassword = 'Self-Service-Password-2026!'

    const [reset, login, passwordChange] = await Promise.all([
      app.inject({
        method: 'PUT', url: `/api/v1/admin/customers/${customerId}/password-reset`, headers: headers(auth),
        payload: { temporaryPassword },
      }),
      app.inject({
        method: 'POST', url: '/api/v1/customer/auth/login', remoteAddress: `192.0.2.${nextIp++}`,
        headers: { origin, cookie: `${customerSession.cookie}; ${customerCsrfCookie}`, 'x-csrf-token': customerCsrf },
        payload: { username, password: customerPassword },
      }),
      app.inject({
        method: 'PUT', url: '/api/v1/customer/password',
        headers: { origin, cookie: `${customerSession.cookie}; ${customerCsrfCookie}`, 'x-csrf-token': customerCsrf },
        payload: { currentPassword: customerPassword, newPassword: selfServicePassword },
      }),
    ])

    expect(reset.statusCode).toBe(200)
    expect([200, 401]).toContain(login.statusCode)
    expect([200, 400, 401]).toContain(passwordChange.statusCode)
    expect(reset.body).not.toContain(temporaryPassword)
    expect(passwordChange.body).not.toContain(selfServicePassword)
    expect(await db.selectFrom('customer_sessions').select('id')
      .where('customer_id', '=', customerId).where('revoked_at', 'is', null).execute()).toHaveLength(0)

    for (const password of [customerPassword, selfServicePassword]) {
      const csrfResponse = await app.inject('/api/v1/customer/auth/csrf')
      const csrfToken = csrfResponse.json().data.csrfToken as string
      const csrfCookie = cookieFrom(csrfResponse, 'aikayun_customer_csrf')
      const attempt = await app.inject({
        method: 'POST', url: '/api/v1/customer/auth/login', remoteAddress: `192.0.2.${nextIp++}`,
        headers: { origin, cookie: csrfCookie, 'x-csrf-token': csrfToken }, payload: { username, password },
      })
      expect(attempt.statusCode).toBe(401)
    }

    const finalCsrfResponse = await app.inject('/api/v1/customer/auth/csrf')
    const finalCsrfToken = finalCsrfResponse.json().data.csrfToken as string
    const finalCsrfCookie = cookieFrom(finalCsrfResponse, 'aikayun_customer_csrf')
    const finalLogin = await app.inject({
      method: 'POST', url: '/api/v1/customer/auth/login', remoteAddress: `192.0.2.${nextIp++}`,
      headers: { origin, cookie: finalCsrfCookie, 'x-csrf-token': finalCsrfToken },
      payload: { username, password: temporaryPassword },
    })
    expect(finalLogin.statusCode).toBe(200)
  })

  it('rechecks session revocation after acquiring the customer lock before a sensitive customer write', async () => {
    const customerId = await createCustomer('Race-Owner', { email: 'before@example.test' })
    const session = await createCustomerSession(customerId)
    const csrfResponse = await app.inject('/api/v1/customer/auth/csrf')
    const csrf = csrfResponse.json().data.csrfToken as string
    const csrfCookie = cookieFrom(csrfResponse, 'aikayun_customer_csrf')
    let releaseLock!: () => void
    let signalReady!: () => void
    const lockRelease = new Promise<void>(resolve => { releaseLock = resolve })
    const lockReady = new Promise<void>(resolve => { signalReady = resolve })
    const lock = db.transaction().execute(async trx => {
      await trx.selectFrom('customers').select('id').where('id', '=', customerId).forUpdate().executeTakeFirstOrThrow()
      signalReady()
      await lockRelease
    })
    await lockReady
    const write = app.inject({
      method: 'PATCH', url: '/api/v1/customer/profile',
      headers: { origin, cookie: `${session.cookie}; ${csrfCookie}`, 'x-csrf-token': csrf },
      payload: { email: 'after@example.test' },
    })
    try {
      await waitForLock('FROM "customers"')
      await db.updateTable('customer_sessions').set({ revoked_at: new Date() }).where('id', '=', session.id).execute()
      releaseLock()
      await lock
      const response = await write
      expect(response.statusCode).toBe(401)
      expect((await db.selectFrom('customers').select('email').where('id', '=', customerId).executeTakeFirstOrThrow()).email).toBe('before@example.test')
    } catch (error) {
      releaseLock()
      await lock.catch(() => undefined)
      throw error
    }
  })

  it('anonymizes an obligation-free customer once and preserves wallet identity and audit history', async () => {
    const customerId = await createCustomer('Delete-Eligible', { email: 'erase@example.test', phone: '13800009999', emailVerified: true, phoneVerified: true })
    const session = await createCustomerSession(customerId)
    const auth = await adminAuth()
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${customerId}`, headers: headers(auth) })
    expect(deleted.statusCode).toBe(200)
    const row = await db.selectFrom('customers').selectAll().where('id', '=', customerId).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ status: 'deleted', username: null, password_hash: null, email: null, email_verified_at: null, phone: null, phone_verified_at: null })
    expect(await db.selectFrom('wallet_accounts').select('customer_id').where('customer_id', '=', customerId).execute()).toHaveLength(1)
    expect((await db.selectFrom('customer_sessions').select('revoked_at').where('id', '=', session.id).executeTakeFirstOrThrow()).revoked_at).not.toBeNull()
    expect((await app.inject({ url: '/api/v1/customer/profile', headers: { cookie: session.cookie } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/customers/${customerId}/status`, headers: headers(auth), payload: { status: 'active' } })).statusCode).toBe(409)
    const list = await app.inject({ url: '/api/v1/admin/customers?status=deleted', headers: headers(auth) })
    expect(list.json().data.items).toContainEqual(expect.objectContaining({ id: customerId, username: null, email: null, phone: null, status: 'deleted' }))
    expect((await app.inject({ url: `/api/v1/admin/customers/${customerId}/audit`, headers: headers(auth) })).json().data.items.map((entry: { action: string }) => entry.action)).toContain('deleted')
    expect(await db.selectFrom('customer_management_audit').where('customer_id', '=', customerId).execute()).toHaveLength(1)
  })

  it('rejects deletion when a pending top-up, available balance or frozen withdrawal remains', async () => {
    const topupCustomer = await createCustomer('Delete-Topup')
    await db.insertInto('payment_attempts').values({
      id: randomUUID(), idempotency_key: randomUUID(), request_sha256: digest,
      order_id: null, topup_customer_id: topupCustomer, source: 'external', amount: '10.00',
      provider: 'epay-compatible', provider_payment_id: `pending-${randomUUID()}`, wallet_operation_id: null,
      expires_at: new Date(Date.now() + 60_000), completed_at: null,
    }).execute()
    const auth = await adminAuth()
    const paymentDelete = await app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${topupCustomer}`, headers: headers(auth) })
    expect(paymentDelete.statusCode).toBe(409)
    expect(paymentDelete.json().error.code).toBe('CUSTOMER_HAS_PENDING_PAYMENT')

    const exceptionalTopupCustomer = await createCustomer('Delete-Exceptional-Topup')
    const exceptionalAttemptId = randomUUID()
    await db.transaction().execute(async trx => {
      await trx.insertInto('payment_attempts').values({
        id: exceptionalAttemptId, idempotency_key: randomUUID(), request_sha256: digest,
        order_id: null, topup_customer_id: exceptionalTopupCustomer, source: 'external', amount: '10.00',
        provider: 'epay-compatible', provider_payment_id: `late-topup-${exceptionalAttemptId}`, wallet_operation_id: null,
        expires_at: new Date(Date.now() + 60_000), completed_at: null,
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', exceptionalAttemptId).execute()
      await trx.updateTable('payment_attempts').set({ status: 'failed' }).where('id', '=', exceptionalAttemptId).execute()
      await trx.insertInto('payment_receipts').values({
        id: randomUUID(), payment_attempt_id: exceptionalAttemptId, source_bucket: 'external', provider: 'epay-compatible',
        provider_transaction_id: `late-topup-receipt-${exceptionalAttemptId}`, wallet_operation_id: null,
        wallet_line_no: null, amount: '10.00',
      }).execute()
    })
    expect((await db.selectFrom('payment_receipts').select('disposition')
      .where('payment_attempt_id', '=', exceptionalAttemptId).executeTakeFirstOrThrow()).disposition).toBe('late')
    const exceptionalTopupDelete = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/customers/${exceptionalTopupCustomer}`, headers: headers(auth),
    })
    expect(exceptionalTopupDelete.statusCode).toBe(409)
    expect(exceptionalTopupDelete.json().error.code).toBe('CUSTOMER_HAS_PENDING_PAYMENT')

    const availableCustomer = await createCustomer('Delete-Available-Balance')
    const availableOperation = randomUUID()
    await db.transaction().execute(async trx => {
      await trx.insertInto('wallet_operations').values({
        id: availableOperation, customer_id: availableCustomer, operation_type: 'adjustment',
        request_sha256: digest, actor_admin_id: adminId,
      }).execute()
      await trx.insertInto('wallet_ledger_entries').values({
        id: randomUUID(), wallet_operation_id: availableOperation, line_no: 1, customer_id: availableCustomer,
        bucket: 'cash', action: 'credit_available', amount: '5.00', payment_attempt_id: null,
        refund_allocation_id: null, withdrawal_id: null,
      }).execute()
    })
    const availableDelete = await app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${availableCustomer}`, headers: headers(auth) })
    expect(availableDelete.statusCode).toBe(409)
    expect(availableDelete.json().error.code).toBe('CUSTOMER_HAS_WALLET_BALANCE')
    expect((await db.selectFrom('wallet_accounts').select('cash_available').where('customer_id', '=', availableCustomer).executeTakeFirstOrThrow()).cash_available).toBe('5.00')

    const withdrawalCustomer = await createCustomer('Delete-Withdrawal')
    const operationId = randomUUID()
    const withdrawalId = randomUUID()
    await db.transaction().execute(async trx => {
      await trx.insertInto('wallet_operations').values({
        id: operationId, customer_id: withdrawalCustomer, operation_type: 'adjustment',
        request_sha256: digest, actor_admin_id: adminId,
      }).execute()
      await trx.insertInto('wallet_ledger_entries').values({
        id: randomUUID(), wallet_operation_id: operationId, line_no: 1, customer_id: withdrawalCustomer,
        bucket: 'cash', action: 'credit_available', amount: '20.00', payment_attempt_id: null,
        refund_allocation_id: null, withdrawal_id: null,
      }).execute()
      const freezeOperation = randomUUID()
      await trx.insertInto('wallet_operations').values({
        id: freezeOperation, customer_id: withdrawalCustomer, operation_type: 'withdrawal_freeze',
        request_sha256: digest, actor_admin_id: null,
      }).execute()
      await trx.insertInto('withdrawals').values({
        id: withdrawalId, customer_id: withdrawalCustomer, idempotency_key: randomUUID(), request_sha256: digest,
        wallet_operation_id: freezeOperation, amount: '10.00', fee_amount: '0.00', payout_amount: '10.00',
        payout_method: 'bank_card', recipient_snapshot: { accountLast4: '0123' },
      }).execute()
    })
    const withdrawalDelete = await app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${withdrawalCustomer}`, headers: headers(auth) })
    expect(withdrawalDelete.statusCode).toBe(409)
    expect(withdrawalDelete.json().error.code).toBe('CUSTOMER_HAS_PENDING_WITHDRAWAL')
    expect((await db.selectFrom('wallet_accounts').select('cash_frozen').where('customer_id', '=', withdrawalCustomer).executeTakeFirstOrThrow()).cash_frozen).toBe('10.00')
  })

  it('blocks open orders and refunds, then permits anonymization after fulfilled history settles', async () => {
    const auth = await adminAuth()
    const openCustomer = await createCustomer('Delete-Open-Order')
    const openOrder = await db.transaction().execute(async trx => insertOrder(trx, openCustomer, await createCatalog()))
    const openDelete = await app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${openCustomer}`, headers: headers(auth) })
    expect(openDelete.statusCode).toBe(409)
    expect(openDelete.json().error.code).toBe('CUSTOMER_HAS_UNFINISHED_ORDERS')
    expect((await db.selectFrom('orders').select('status').where('id', '=', openOrder.id).executeTakeFirstOrThrow()).status).toBe('pending_payment')

    const refundCustomer = await createCustomer('Delete-Pending-Refund')
    const refundOrder = await completePaidOrder(refundCustomer)
    const refundId = randomUUID()
    await db.insertInto('order_refunds').values({
      id: refundId, order_id: refundOrder.id, idempotency_key: randomUUID(), request_sha256: digest, amount: '5.00',
    }).execute()
    const refundDelete = await app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${refundCustomer}`, headers: headers(auth) })
    expect(refundDelete.statusCode).toBe(409)
    expect(refundDelete.json().error.code).toBe('CUSTOMER_HAS_PENDING_REFUND')

    const historicalCustomer = await createCustomer('Delete-Historical-Only')
    const historicalSession = await createCustomerSession(historicalCustomer)
    const historicalOrder = await completePaidOrder(historicalCustomer)
    const history = await app.inject({ url: `/api/v1/admin/customers/${historicalCustomer}/orders`, headers: headers(auth) })
    expect(history.statusCode).toBe(200)
    expect(history.json().data.items).toContainEqual(expect.objectContaining({ id: historicalOrder.id, status: 'completed', paymentStatus: 'paid' }))
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${historicalCustomer}`, headers: headers(auth) })
    expect(deleted.statusCode).toBe(200)
    expect(await db.selectFrom('orders').select('id').where('id', '=', historicalOrder.id).execute()).toHaveLength(1)
    expect(await db.selectFrom('payment_receipts').innerJoin('payment_attempts', 'payment_attempts.id', 'payment_receipts.payment_attempt_id')
      .select('payment_receipts.id').where('payment_attempts.order_id', '=', historicalOrder.id).execute()).toHaveLength(1)
    expect((await app.inject({ url: '/api/v1/customer/profile', headers: { cookie: historicalSession.cookie } })).statusCode).toBe(401)
  })

  it('allows anonymization after an exceptional late receipt is fully refunded', async () => {
    const customerId = await createCustomer('Delete-Fully-Refunded-Late')
    const history = await createFullyRefundedLateOrder(customerId)
    const auth = await adminAuth()

    expect((await db.selectFrom('payment_receipts').select(['disposition', 'amount', 'refunded_amount'])
      .where('id', '=', history.receiptId).executeTakeFirstOrThrow()))
      .toEqual({ disposition: 'late', amount: '10.00', refunded_amount: '10.00' })
    expect((await db.selectFrom('order_financial_status').select(['payment_status', 'refund_status'])
      .where('order_id', '=', history.id).executeTakeFirstOrThrow()))
      .toEqual({ payment_status: 'refunded', refund_status: 'refunded' })

    const response = await app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${customerId}`, headers: headers(auth) })
    expect(response.statusCode).toBe(200)
    expect((await db.selectFrom('customers').select(['status', 'username', 'password_hash', 'email', 'phone'])
      .where('id', '=', customerId).executeTakeFirstOrThrow()))
      .toEqual({ status: 'deleted', username: null, password_hash: null, email: null, phone: null })
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', history.attemptId).executeTakeFirstOrThrow())
      .status).toBe('late_succeeded')
    expect(await db.selectFrom('payment_receipts').select('id').where('id', '=', history.receiptId).execute()).toHaveLength(1)
    expect(await db.selectFrom('orders').select('id').where('id', '=', history.id).execute()).toHaveLength(1)
    expect((await db.selectFrom('order_refunds').select('status').where('id', '=', history.refundId).executeTakeFirstOrThrow())
      .status).toBe('succeeded')
    expect((await db.selectFrom('order_refund_allocations').select(['status', 'amount'])
      .where('id', '=', history.allocationIds[0]!).executeTakeFirstOrThrow()))
      .toEqual({ status: 'succeeded', amount: '10.00' })
    expect(await db.selectFrom('customer_management_audit').select(['administrator_id', 'customer_id', 'action'])
      .where('customer_id', '=', customerId).execute())
      .toContainEqual({ administrator_id: adminId, customer_id: customerId, action: 'deleted' })
  })

  it('blocks anomalous receipts while any amount remains unpaid, and allows resolved mismatches or excess', async () => {
    const unpaidCustomer = await createCustomer('Delete-Late-Unpaid')
    await createLateReceipt(unpaidCustomer)
    const partialCustomer = await createCustomer('Delete-Late-Partial')
    const partial = await createLateReceipt(partialCustomer)
    await createReceiptRefund(partial.id, partial.receiptId, '4.00')

    const auth = await adminAuth()
    for (const customerId of [unpaidCustomer, partialCustomer]) {
      const response = await app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${customerId}`, headers: headers(auth) })
      expect(response.statusCode).toBe(409)
      expect(response.json().error.code).toBe('CUSTOMER_HAS_PENDING_PAYMENT')
    }

    for (const kind of ['mismatch', 'excess'] as const) {
      const customerId = await createCustomer(`Delete-${kind}-Unresolved`)
      const history = await createExceptionalReceipt(customerId, kind)
      expect((await db.selectFrom('payment_receipts').select('disposition').where('id', '=', history.receiptId).executeTakeFirstOrThrow())
        .disposition).toBe(kind === 'mismatch' ? 'amount_mismatch' : 'excess')
      const response = await app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${customerId}`, headers: headers(auth) })
      expect(response.statusCode).toBe(409)
      expect(response.json().error.code).toBe('CUSTOMER_HAS_UNFINISHED_ORDERS')
    }

    for (const kind of ['mismatch', 'excess'] as const) {
      const customerId = await createCustomer(`Delete-${kind}-Refunded`)
      const history = await createFullyRefundedExceptionalOrder(customerId, kind)
      const response = await app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${customerId}`, headers: headers(auth) })
      expect(response.statusCode).toBe(200)
      expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', history.attemptId).executeTakeFirstOrThrow())
        .status).toBe('reconciliation_required')
      expect((await db.selectFrom('payment_receipts').select(['disposition', 'refunded_amount'])
        .where('id', '=', history.receiptId).executeTakeFirstOrThrow()))
        .toEqual({ disposition: kind === 'mismatch' ? 'amount_mismatch' : 'excess', refunded_amount: history.receivedAmount })
      expect((await db.selectFrom('order_financial_status').select('payment_status').where('order_id', '=', history.id)
        .executeTakeFirstOrThrow()).payment_status).toBe('refunded')
    }
  })

  it('keeps a settled exceptional refund from allowing deletion when it credits a remaining wallet balance', async () => {
    const customerId = await createCustomer('Delete-Settled-Refund-Wallet')
    const history = await createLateReceipt(customerId)
    await createReceiptRefund(history.id, history.receiptId, '10.00', 'cash_balance')
    const auth = await adminAuth()

    const response = await app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${customerId}`, headers: headers(auth) })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('CUSTOMER_HAS_WALLET_BALANCE')
    expect((await db.selectFrom('wallet_accounts').select('cash_available').where('customer_id', '=', customerId)
      .executeTakeFirstOrThrow()).cash_available).toBe('10.00')
  })

  it('still blocks an exceptional refund that is settled when another refund allocation is reserved', async () => {
    const customerId = await createCustomer('Delete-Settled-Exception-Other-Refund')
    const late = await createLateReceipt(customerId)
    await createReceiptRefund(late.id, late.receiptId, '10.00')

    const order = await completePaidOrder(customerId)
    const receipt = await db.selectFrom('payment_receipts').innerJoin('payment_attempts', 'payment_attempts.id', 'payment_receipts.payment_attempt_id')
      .select('payment_receipts.id').where('payment_attempts.order_id', '=', order.id).executeTakeFirstOrThrow()
    const refundId = randomUUID()
    await db.transaction().execute(async trx => {
      await trx.insertInto('order_refunds').values({
        id: refundId, order_id: order.id, idempotency_key: randomUUID(), request_sha256: digest, amount: '1.00',
      }).execute()
      await trx.updateTable('order_refunds').set({ status: 'approved' }).where('id', '=', refundId).execute()
      await trx.updateTable('order_refunds').set({ status: 'processing' }).where('id', '=', refundId).execute()
      await trx.insertInto('order_refund_allocations').values({
        id: randomUUID(), refund_id: refundId, source_payment_receipt_id: receipt.id,
        operation_id: randomUUID(), request_sha256: digest, destination: 'original_source', amount: '1.00',
        provider: null, provider_refund_id: null, completed_at: null,
      }).execute()
    })

    const auth = await adminAuth()
    const response = await app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${customerId}`, headers: headers(auth) })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('CUSTOMER_HAS_PENDING_REFUND')
  })

  it('serializes deletion with a refund settlement that credits the wallet', async () => {
    const customerId = await createCustomer('Delete-Refund-Race')
    const order = await completePaidOrder(customerId)
    const receipt = await db.selectFrom('payment_receipts').innerJoin('payment_attempts', 'payment_attempts.id', 'payment_receipts.payment_attempt_id')
      .select('payment_receipts.id').where('payment_attempts.order_id', '=', order.id).executeTakeFirstOrThrow()
    const refundId = randomUUID()
    const allocationId = randomUUID()
    await db.transaction().execute(async trx => {
      await trx.insertInto('order_refunds').values({
        id: refundId, order_id: order.id, idempotency_key: randomUUID(), request_sha256: digest, amount: '10.00',
      }).execute()
      await trx.updateTable('order_refunds').set({ status: 'approved' }).where('id', '=', refundId).execute()
      await trx.updateTable('order_refunds').set({ status: 'processing' }).where('id', '=', refundId).execute()
      await trx.insertInto('order_refund_allocations').values({
        id: allocationId, refund_id: refundId, source_payment_receipt_id: receipt.id,
        operation_id: randomUUID(), request_sha256: digest, destination: 'cash_balance', amount: '10.00',
        provider: null, provider_refund_id: null, completed_at: null,
      }).execute()
    })

    let releaseUpdate!: () => void
    let signalOrderLock!: () => void
    const updateRelease = new Promise<void>(resolve => { releaseUpdate = resolve })
    const orderLockReady = new Promise<void>(resolve => { signalOrderLock = resolve })
    const refundUpdate = db.transaction().execute(async trx => {
      await trx.selectFrom('orders').select('id').where('id', '=', order.id).forUpdate().executeTakeFirstOrThrow()
      signalOrderLock()
      await updateRelease
      await trx.updateTable('order_refund_allocations').set({ status: 'succeeded' }).where('id', '=', allocationId).execute()
      await trx.updateTable('order_refunds').set({ status: 'succeeded' }).where('id', '=', refundId).execute()
    })
    await orderLockReady
    const auth = await adminAuth()
    const deletion = app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${customerId}`, headers: headers(auth) })
    try {
      await waitForLock('FROM "orders"')
      releaseUpdate()
      await refundUpdate
      const response = await deletion
      expect(response.statusCode).toBe(409)
      expect(response.json().error.code).toBe('CUSTOMER_HAS_WALLET_BALANCE')
      expect((await db.selectFrom('customers').select('status').where('id', '=', customerId).executeTakeFirstOrThrow()).status)
        .toBe('active')
    } catch (error) {
      releaseUpdate()
      await refundUpdate.catch(() => undefined)
      await deletion.catch(() => undefined)
      throw error
    }
  })

  it('serializes deletion with an order insert and rejects the new obligation after the creator commits', async () => {
    const customerId = await createCustomer('Delete-Order-Race')
    const catalog = await createCatalog()
    const auth = await adminAuth()
    let releaseCreator!: () => void
    let signalCreator!: () => void
    const creatorRelease = new Promise<void>(resolve => { releaseCreator = resolve })
    const creatorReady = new Promise<void>(resolve => { signalCreator = resolve })
    const creator = db.transaction().execute(async trx => {
      await trx.selectFrom('customers').select('id').where('id', '=', customerId).forKeyShare().executeTakeFirstOrThrow()
      signalCreator()
      await creatorRelease
      return insertOrder(trx, customerId, catalog)
    })
    await creatorReady
    const deletion = app.inject({ method: 'DELETE', url: `/api/v1/admin/customers/${customerId}`, headers: headers(auth) })
    try {
      await waitForLock('FROM "customers"')
      releaseCreator()
      const order = await creator
      const response = await deletion
      expect(response.statusCode).toBe(409)
      expect(response.json().error.code).toBe('CUSTOMER_HAS_UNFINISHED_ORDERS')
      expect((await db.selectFrom('orders').select('id').where('id', '=', order.id).execute()).length).toBe(1)
    } catch (error) {
      releaseCreator()
      await creator.catch(() => undefined)
      throw error
    }
  })
})
