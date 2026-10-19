import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql, type Kysely, type Transaction } from 'kysely'
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

type Customer = { id: string; username: string; cookie: string; csrfToken: string; csrfCookie: string }
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
  const username = `order-${randomUUID().replaceAll('-', '').slice(0, 20)}`
  const response = await inject({
    method: 'POST', url: '/api/v1/customer/auth/register',
    headers: { origin: testOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.token },
    payload: { username, password },
  })
  expect(response.statusCode).toBe(201)
  return {
    id: response.json().data.customer.id as string,
    username,
    cookie: cookieFrom(response, 'aikayun_customer_session'),
    csrfToken: csrf.token,
    csrfCookie: csrf.cookie,
  }
}

async function loginCustomerSession(customer: Customer): Promise<Customer> {
  const csrf = await customerCsrf()
  const response = await inject({
    method: 'POST', url: '/api/v1/customer/auth/login',
    headers: { origin: testOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.token },
    payload: { username: customer.username, password },
  })
  expect(response.statusCode).toBe(200)
  return {
    id: customer.id,
    username: customer.username,
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

async function addSiblingSku(catalog: Catalog): Promise<string> {
  const groupId = randomUUID()
  const firstValueId = randomUUID()
  const secondValueId = randomUUID()
  const skuId = randomUUID()
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('product_option_groups').values({
      id: groupId, product_id: catalog.productId, name: '颜色', sort_order: 0, enabled: true,
    }).execute()
    await trx.insertInto('product_option_values').values([
      { id: firstValueId, product_id: catalog.productId, option_group_id: groupId, name: '黑色', sort_order: 0, enabled: true },
      { id: secondValueId, product_id: catalog.productId, option_group_id: groupId, name: '白色', sort_order: 1, enabled: true },
    ]).execute()
    await trx.insertInto('product_variant_option_values').values({
      product_id: catalog.productId, product_variant_id: catalog.skuId,
      option_group_id: groupId, option_value_id: firstValueId,
    }).execute()
    await trx.updateTable('product_variants').set({ combination_key: `v1:${firstValueId}` })
      .where('id', '=', catalog.skuId).execute()
    await trx.insertInto('product_variants').values({
      id: skuId, product_id: catalog.productId, sku_code: `ORD-${skuId.slice(0, 8)}`,
      combination_key: `v1:${secondValueId}`, sale_price: catalog.price, enabled: true,
      retired_at: null, inventory_mode: catalog.mode,
    }).execute()
    await trx.insertInto('product_variant_option_values').values({
      product_id: catalog.productId, product_variant_id: skuId,
      option_group_id: groupId, option_value_id: secondValueId,
    }).execute()
    if (catalog.mode === 'quantity') {
      await trx.insertInto('product_variant_quantity_inventory').values({
        product_id: catalog.productId, product_variant_id: skuId, stocked: 5, reserved: 0,
      }).execute()
    }
    await trx.insertInto('product_variant_fulfillment').values({
      product_variant_id: skuId, method: 'manual', manual_delivery_ready: true,
    }).execute()
  })
  return skuId
}

async function setProductPurchaseLimits(productId: string, values: {
  perOrder?: number | null
  lifetime?: number | null
  rolling24Hours?: number | null
}) {
  await db.updateTable('products').set({
    ...(values.perOrder !== undefined ? { purchase_limit_per_order: values.perOrder } : {}),
    ...(values.lifetime !== undefined ? { purchase_limit_lifetime: values.lifetime } : {}),
    ...(values.rolling24Hours !== undefined ? { purchase_limit_24h: values.rolling24Hours } : {}),
  }).where('id', '=', productId).execute()
}

async function setSkuPurchaseLimits(skuId: string, values: {
  perOrder?: number | null
  lifetime?: number | null
  rolling24Hours?: number | null
}) {
  await db.updateTable('product_variants').set({
    ...(values.perOrder !== undefined ? { purchase_limit_per_order: values.perOrder } : {}),
    ...(values.lifetime !== undefined ? { purchase_limit_lifetime: values.lifetime } : {}),
    ...(values.rolling24Hours !== undefined ? { purchase_limit_24h: values.rolling24Hours } : {}),
  }).where('id', '=', skuId).execute()
}

async function setOrderCreatedAt(orderId: string, createdAt: Date) {
  await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
  try {
    await db.updateTable('orders').set({ created_at: createdAt }).where('id', '=', orderId).execute()
  } finally {
    await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
  }
}

async function settleAndRefundExternally(orderId: string, amount: string): Promise<void> {
  const attemptId = randomUUID()
  const receiptId = randomUUID()
  const refundId = randomUUID()
  const allocationId = randomUUID()
  await db.insertInto('payment_attempts').values({
    id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
    topup_customer_id: null, source: 'external', amount, status: 'created', provider: 'integration',
    provider_payment_id: `purchase-limit-${attemptId}`, wallet_operation_id: null, wallet_hold_operation_id: null,
    requested_wallet_amount: null, expires_at: new Date(Date.now() + 60 * 60_000), completed_at: null,
  }).execute()
  await db.insertInto('payment_receipts').values({
    id: receiptId, payment_attempt_id: attemptId, source_bucket: 'external', provider: 'integration',
    provider_transaction_id: `purchase-limit-receipt-${receiptId}`, wallet_operation_id: null,
    wallet_line_no: null, amount,
  }).execute()
  await db.insertInto('order_refunds').values({
    id: refundId, order_id: orderId, idempotency_key: randomUUID(), request_sha256: digest, amount,
  }).execute()
  await db.updateTable('order_refunds').set({ status: 'approved' }).where('id', '=', refundId).execute()
  await db.insertInto('order_refund_allocations').values({
    id: allocationId, refund_id: refundId, source_payment_receipt_id: receiptId,
    operation_id: randomUUID(), request_sha256: digest, destination: 'original_source', amount,
  }).execute()
  await db.updateTable('order_refunds').set({ status: 'processing' }).where('id', '=', refundId).execute()
  await db.updateTable('order_refund_allocations').set({
    status: 'succeeded', provider: 'integration', provider_refund_id: `refund-${allocationId}`,
  }).where('id', '=', allocationId).execute()
  await db.updateTable('order_refunds').set({ status: 'succeeded' }).where('id', '=', refundId).execute()
}

async function insertDirectPurchaseOrder(
  trx: Transaction<Database>,
  customerId: string,
  catalog: Catalog,
  orderId: string,
) {
  await trx.insertInto('orders').values({
    id: orderId, customer_id: customerId, guest_order_session_id: null,
    idempotency_key: randomUUID(), request_sha256: digest, total_amount: catalog.price,
    unpaid_expires_at: new Date(Date.now() + 60 * 60_000),
    history_hidden_at: null, history_hidden_by_admin_id: null, history_hidden_reason: null,
  }).execute()
  await sql`
    INSERT INTO order_items (
      id, order_id, product_id, product_variant_id, product_name_snapshot, product_type_snapshot,
      sku_code_snapshot, sku_snapshot, inventory_mode_snapshot, fulfillment_method_snapshot,
      unit_price, quantity, line_amount
    )
    SELECT gen_random_uuid(), ${orderId}::uuid, product.id, variant.id, product.name,
      product.product_type, variant.sku_code,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'groupId', option_group.id, 'groupName', option_group.name,
          'valueId', option_value.id, 'valueName', option_value.name
        ) ORDER BY option_group.sort_order, option_value.sort_order, option_group.id, option_value.id)
        FROM product_variant_option_values AS selected
        JOIN product_option_groups AS option_group
          ON option_group.product_id = selected.product_id AND option_group.id = selected.option_group_id
        JOIN product_option_values AS option_value
          ON option_value.product_id = selected.product_id
          AND option_value.option_group_id = selected.option_group_id
          AND option_value.id = selected.option_value_id
        WHERE selected.product_id = variant.product_id AND selected.product_variant_id = variant.id
      ), '[]'::jsonb), variant.inventory_mode, fulfillment.method,
      variant.sale_price, 1, variant.sale_price
    FROM products AS product
    JOIN product_variants AS variant ON variant.product_id = product.id
    JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
    WHERE product.id = ${catalog.productId}::uuid AND variant.id = ${catalog.skuId}::uuid
  `.execute(trx)
  await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', orderId).execute()
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

async function attachPendingPaymentWithoutExpiry(orderId: string, amount: string): Promise<string> {
  const attemptId = randomUUID()
  await db.transaction().execute(async (trx) => {
    await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_deadline_r1`.execute(trx)
    try {
      // Simulate a row that was valid under the frozen ④-1 schema before the
      // ④-5 deadline contract was introduced.
      await trx.insertInto('payment_attempts').values({
        id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
        topup_customer_id: null, source: 'external', amount, status: 'created', provider: 'integration',
        provider_payment_id: null, wallet_operation_id: null, wallet_hold_operation_id: null,
        requested_wallet_amount: null, expires_at: null, completed_at: null,
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
    } finally {
      await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_deadline_r1`.execute(trx)
    }
  })
  return attemptId
}

async function attachExpiredPendingPayment(orderId: string, amount: string): Promise<string> {
  const attemptId = randomUUID()
  await db.transaction().execute(async (trx) => {
    await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_deadline_r1`.execute(trx)
    try {
      await trx.insertInto('payment_attempts').values({
        id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
        topup_customer_id: null, source: 'external', amount, status: 'created', provider: 'integration',
        provider_payment_id: null, wallet_operation_id: null, wallet_hold_operation_id: null,
        requested_wallet_amount: null, created_at: new Date(Date.now() - 2 * 60 * 60_000),
        expires_at: new Date(Date.now() - 60 * 60_000), completed_at: null,
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
    } finally {
      await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_deadline_r1`.execute(trx)
    }
  })
  return attemptId
}

async function attachExpiredCreatedPayment(orderId: string, amount: string): Promise<string> {
  const attemptId = randomUUID()
  await db.transaction().execute(async (trx) => {
    await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_deadline_r1`.execute(trx)
    try {
      await trx.insertInto('payment_attempts').values({
        id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
        topup_customer_id: null, source: 'external', amount, status: 'created', provider: 'integration',
        provider_payment_id: null, wallet_operation_id: null, wallet_hold_operation_id: null,
        requested_wallet_amount: null, created_at: new Date(Date.now() - 2 * 60 * 60_000),
        expires_at: new Date(Date.now() - 60 * 60_000), completed_at: null,
      }).execute()
    } finally {
      await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_deadline_r1`.execute(trx)
    }
  })
  return attemptId
}

async function attachExpiredWalletHold(options: {
  orderId: string
  customerId: string
  adminId: string
  externalAmount: string
  walletAmount: string
}): Promise<string> {
  const attemptId = randomUUID()
  const holdOperationId = randomUUID()
  const creditOperationId = randomUUID()
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('wallet_operations').values({
      id: creditOperationId, customer_id: options.customerId, operation_type: 'gift',
      request_sha256: digest, actor_admin_id: options.adminId,
    }).execute()
    await trx.insertInto('wallet_ledger_entries').values({
      id: randomUUID(), wallet_operation_id: creditOperationId, line_no: 1,
      customer_id: options.customerId, bucket: 'gift', action: 'credit_available', amount: options.walletAmount,
      payment_attempt_id: null, refund_allocation_id: null, withdrawal_id: null,
    }).execute()
    await trx.insertInto('wallet_operations').values({
      id: holdOperationId, customer_id: options.customerId, order_id: options.orderId,
      requested_amount: options.walletAmount, operation_type: 'order_payment_hold',
      request_sha256: digest, actor_admin_id: null,
    }).execute()
    await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_deadline_r1`.execute(trx)
    try {
      // This models an attempt created before ④-5 required a deadline on new attempts.
      await trx.insertInto('payment_attempts').values({
        id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: options.orderId,
        topup_customer_id: null, source: 'external', amount: options.externalAmount, status: 'created',
        provider: 'integration', provider_payment_id: null, wallet_operation_id: null,
        wallet_hold_operation_id: holdOperationId, requested_wallet_amount: options.walletAmount,
        created_at: new Date(Date.now() - 2 * 60 * 60_000),
        expires_at: new Date(Date.now() - 60 * 60_000), completed_at: null,
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
    } finally {
      await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_deadline_r1`.execute(trx)
    }
    await trx.insertInto('wallet_ledger_entries').values({
      id: randomUUID(), wallet_operation_id: holdOperationId, line_no: 1,
      customer_id: options.customerId, bucket: 'gift', action: 'freeze', amount: options.walletAmount,
      payment_attempt_id: attemptId, refund_allocation_id: null, withdrawal_id: null,
    }).execute()
  })
  return attemptId
}

async function waitForPostgresLockWait(applicationName: string): Promise<{
  holdsAdvisory: boolean
  holdsTransactionId: boolean
  blockerPids: number[]
  waitEvent: string | null
}> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const activity = await sql<{
      wait_event_type: string | null
      wait_event: string | null
      blocker_pids: number[]
      holds_advisory: boolean
      holds_transaction_id: boolean
    }>`
      SELECT activity.wait_event_type, activity.wait_event, pg_blocking_pids(activity.pid) AS blocker_pids,
        EXISTS (SELECT 1 FROM pg_locks WHERE pid = activity.pid AND locktype = 'advisory' AND granted)
          AS holds_advisory,
        EXISTS (SELECT 1 FROM pg_locks WHERE pid = activity.pid AND locktype = 'transactionid'
          AND mode = 'ExclusiveLock' AND granted) AS holds_transaction_id
      FROM pg_stat_activity AS activity WHERE activity.application_name = ${applicationName}
    `.execute(db)
    const waiting = activity.rows.find(row => row.wait_event_type === 'Lock' && row.blocker_pids.length > 0)
    if (waiting) return {
      holdsAdvisory: waiting.holds_advisory,
      holdsTransactionId: waiting.holds_transaction_id,
      blockerPids: waiting.blocker_pids,
      waitEvent: waiting.wait_event,
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`PostgreSQL session ${applicationName} did not enter an observable lock wait`)
}

async function waitForLockWaitCount(applicationName: string, expectedCount: number, queryFragment: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const activity = await sql<{ waiting: number }>`
      SELECT count(*)::integer AS waiting
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND wait_event_type = 'Lock'
        AND query ILIKE ${`%${queryFragment}%`}
    `.execute(db)
    if ((activity.rows[0]?.waiting ?? 0) >= expectedCount) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Expected ${expectedCount} PostgreSQL lock waits for ${queryFragment}`)
}

async function waitForQueryBlockedBy(queryFragment: string, blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const activity = await sql<{ blocker_pids: number[] }>`
      SELECT pg_blocking_pids(pid) AS blocker_pids
      FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'aikayun-api'
        AND state = 'active' AND wait_event_type = 'Lock' AND query ILIKE ${`%${queryFragment}%`}
    `.execute(db)
    if (activity.rows.some(row => row.blocker_pids.includes(blockerPid))) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`PostgreSQL query containing ${queryFragment} did not block on PID ${blockerPid}`)
}

async function waitForOrderAdvisoryLockWait(): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const activity = await sql<{ pid: number; blocker_pids: number[] }>`
      SELECT pid, pg_blocking_pids(pid) AS blocker_pids
      FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'aikayun-api'
        AND state = 'active' AND wait_event_type = 'Lock' AND wait_event = 'advisory'
        AND query ILIKE '%pg_advisory_xact_lock%'
    `.execute(db)
    if (activity.rows.some(row => row.blocker_pids.length > 0)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('No expiry worker was observed waiting for the held order advisory lock')
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
  it('keeps payment-attempt insertion in order-first lock order against timeout closure', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const closeApplicationName = `r2-insert-close-${randomUUID()}`
    const insertApplicationName = `r2-insert-attempt-${randomUUID()}`

    let releaseClose!: () => void
    let closeHasOrderRow!: () => void
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
    const orderRowAcquired = new Promise<void>((resolve) => { closeHasOrderRow = resolve })
    const closing = db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('application_name', ${closeApplicationName}, true)`.execute(trx)
      await sql`SET LOCAL deadlock_timeout = '100ms'`.execute(trx)
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx)
      await sql`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`.execute(trx)
      closeHasOrderRow()
      await closeGate
      await trx.updateTable('orders').set({ status: 'closed' }).where('id', '=', orderId).execute()
    })
    await orderRowAcquired

    const attemptId = randomUUID()
    const insertion = db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('application_name', ${insertApplicationName}, true)`.execute(trx)
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx)
      await trx.insertInto('payment_attempts').values({
        id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
        topup_customer_id: null, source: 'external', amount: '1.20', status: 'created', provider: 'integration',
        provider_payment_id: null, wallet_operation_id: null, wallet_hold_operation_id: null,
        requested_wallet_amount: null, expires_at: new Date(Date.now() + 60 * 60_000), completed_at: null,
      }).execute()
    })
    let outcomes: PromiseSettledResult<unknown>[] = []
    let insertionWait: { holdsAdvisory: boolean; waitEvent: string | null } | undefined
    try {
      insertionWait = await waitForPostgresLockWait(insertApplicationName)
      releaseClose()
      outcomes = await Promise.allSettled([closing, insertion])
    } finally {
      releaseClose()
      if (outcomes.length === 0) outcomes = await Promise.allSettled([closing, insertion])
    }

    expect(insertionWait?.holdsAdvisory).toBe(false)
    expect(insertionWait?.waitEvent).toBe('transactionid')
    expect(outcomes[0]?.status).toBe('fulfilled')
    expect(outcomes[1]).toMatchObject({
      status: 'rejected', reason: { code: '23514', constraint: 'payment_attempts_order_payable' },
    })
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('closed')
    expect(await db.selectFrom('payment_attempts').select('id').where('id', '=', attemptId).execute()).toHaveLength(0)
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(0)
  })

  it('serializes expired payment completion with order closure without a lock cycle', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const attemptId = await attachExpiredPendingPayment(orderId, '1.20')
    const closeApplicationName = `r2-close-${randomUUID()}`
    const paymentApplicationName = `r2-payment-${randomUUID()}`

    let releaseClose!: () => void
    let closeHasAdvisory!: () => void
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
    const advisoryAcquired = new Promise<void>((resolve) => { closeHasAdvisory = resolve })
    const closing = db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('application_name', ${closeApplicationName}, true)`.execute(trx)
      await sql`SET LOCAL deadlock_timeout = '100ms'`.execute(trx)
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx)
      await sql`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`.execute(trx)
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${orderId}::text, 0))`.execute(trx)
      closeHasAdvisory()
      await closeGate
      await trx.updateTable('orders').set({ status: 'closed' }).where('id', '=', orderId).execute()
    })
    await advisoryAcquired

    const paymentTransition = db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('application_name', ${paymentApplicationName}, true)`.execute(trx)
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx)
      await trx.updateTable('payment_attempts').set({ status: 'failed' }).where('id', '=', attemptId).execute()
    })
    let outcomes: PromiseSettledResult<unknown>[] = []
    try {
      const paymentWait = await waitForPostgresLockWait(paymentApplicationName)
      expect(paymentWait.holdsTransactionId).toBe(true)
      expect(paymentWait.waitEvent).toBe('advisory')
      releaseClose()
      outcomes = await Promise.allSettled([closing, paymentTransition])
    } finally {
      releaseClose()
      if (outcomes.length === 0) outcomes = await Promise.allSettled([closing, paymentTransition])
    }

    const deadlocks = outcomes.filter((outcome): outcome is PromiseRejectedResult =>
      outcome.status === 'rejected' && typeof outcome.reason === 'object'
        && outcome.reason !== null && 'code' in outcome.reason && outcome.reason.code === '40P01')
    expect(deadlocks).toHaveLength(0)
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(2)
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('closed')
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('failed')
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(0)
    expect(await db.selectFrom('order_inventory_events as event')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
      .where('reservation.product_variant_id', '=', catalog.skuId)
      .select('event.action').execute()).toEqual([{ action: 'reserve' }, { action: 'release' }])
  })

  it('closes an expired created attempt through the worker while its cancellation waits safely', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const attemptId = await attachExpiredCreatedPayment(orderId, '1.20')
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    try {
      await sql`UPDATE orders SET unpaid_expires_at = clock_timestamp() - interval '1 second'
        WHERE id = ${orderId}::uuid`.execute(db)
    } finally {
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }
    await sql`CREATE TABLE r2_test_close_gate (id integer PRIMARY KEY)`.execute(db)
    await sql`INSERT INTO r2_test_close_gate (id) VALUES (1)`.execute(db)
    await sql`
      CREATE FUNCTION r2_test_pause_closed_order() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'closed' THEN
          PERFORM id FROM r2_test_close_gate WHERE id = 1 FOR UPDATE;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER zz_r2_test_pause_closed_order BEFORE UPDATE OF status ON orders
      FOR EACH ROW EXECUTE FUNCTION r2_test_pause_closed_order()`.execute(db)

    let releaseGate!: () => void
    let gateLocked!: (pid: number) => void
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    const gateReady = new Promise<number>((resolve) => { gateLocked = resolve })
    const gateHolder = db.transaction().execute(async (trx) => {
      const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
      await sql`SELECT id FROM r2_test_close_gate WHERE id = 1 FOR UPDATE`.execute(trx)
      gateLocked(pid.rows[0]!.pid)
      await gate
    })
    const gatePid = await gateReady
    const worker = expireDueUnpaidOrders(db, new Date(Date.now() + 60 * 60_000), 1)
    let paymentTransition: Promise<unknown> | undefined
    let outcomes: PromiseSettledResult<unknown>[] | undefined
    try {
      await waitForQueryBlockedBy('update "orders"', gatePid)
      const paymentApplicationName = `r2-created-${randomUUID()}`
      paymentTransition = db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('application_name', ${paymentApplicationName}, true)`.execute(trx)
        await sql`SET LOCAL statement_timeout = '5s'`.execute(trx)
        await trx.updateTable('payment_attempts').set({ status: 'cancelled' }).where('id', '=', attemptId).execute()
      })
      const paymentWait = await waitForPostgresLockWait(paymentApplicationName)
      expect(paymentWait.holdsTransactionId).toBe(true)
      expect(paymentWait.blockerPids.length).toBeGreaterThan(0)
      expect(paymentWait.waitEvent).toBe('advisory')
      releaseGate()
      outcomes = await Promise.allSettled([worker, paymentTransition])
    } finally {
      releaseGate()
      await gateHolder
      if (!outcomes) {
        outcomes = await Promise.allSettled([worker, ...(paymentTransition ? [paymentTransition] : [])])
      }
      await sql`DROP TRIGGER IF EXISTS zz_r2_test_pause_closed_order ON orders`.execute(db)
      await sql`DROP FUNCTION IF EXISTS r2_test_pause_closed_order()`.execute(db)
      await sql`DROP TABLE IF EXISTS r2_test_close_gate`.execute(db)
    }

    expect(outcomes?.every(outcome => outcome.status === 'fulfilled')).toBe(true)
    expect(outcomes?.[0]).toMatchObject({ status: 'fulfilled', value: 1 })
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('closed')
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('cancelled')
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(0)
    expect(await db.selectFrom('order_inventory_events as event')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
      .where('reservation.product_variant_id', '=', catalog.skuId)
      .select('event.action').execute()).toEqual([{ action: 'reserve' }, { action: 'release' }])
  })

  it('lets concurrent expiry workers skip a locked payment order and close the next safe order once', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 4 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const firstQuote = await quote(items, customer)
    const firstOrder = await createOrder(items, firstQuote.json().data.quoteToken, customer)
    const firstOrderId = firstOrder.json().data.order.id as string
    const attemptId = await attachExpiredPendingPayment(firstOrderId, '1.20')
    const nextQuote = await quote(items, customer)
    const nextOrder = await createOrder(items, nextQuote.json().data.quoteToken, customer)
    const nextOrderId = nextOrder.json().data.order.id as string
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    try {
      await sql`UPDATE orders SET unpaid_expires_at = CASE
        WHEN id = ${firstOrderId}::uuid THEN clock_timestamp() - interval '2 minutes'
        ELSE clock_timestamp() - interval '1 minute' END
        WHERE id IN (${firstOrderId}::uuid, ${nextOrderId}::uuid)`.execute(db)
    } finally {
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }

    let releaseAdvisory!: () => void
    let advisoryAcquired!: () => void
    const advisoryGate = new Promise<void>((resolve) => { releaseAdvisory = resolve })
    const acquired = new Promise<void>((resolve) => { advisoryAcquired = resolve })
    const advisoryHolder = db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${firstOrderId}::text, 0))`.execute(trx)
      advisoryAcquired()
      await advisoryGate
    })
    await acquired
    const firstWorker = expireDueUnpaidOrders(db, new Date(), 1)
    let nextWorkerCount: number
    let firstWorkerCount: number
    try {
      await waitForOrderAdvisoryLockWait()
      nextWorkerCount = await expireDueUnpaidOrders(db, new Date(), 1)
      expect(nextWorkerCount).toBe(1)
      expect((await db.selectFrom('orders').select('status').where('id', '=', nextOrderId).executeTakeFirstOrThrow()).status)
        .toBe('closed')
    } finally {
      releaseAdvisory()
      await advisoryHolder
      firstWorkerCount = await firstWorker
    }

    expect(firstWorkerCount).toBe(1)
    expect((await db.selectFrom('orders').select('status').where('id', '=', firstOrderId).executeTakeFirstOrThrow()).status)
      .toBe('closed')
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('pending')
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(0)
    expect(await db.selectFrom('order_inventory_events as event')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
      .where('reservation.product_variant_id', '=', catalog.skuId)
      .select(['reservation.order_item_id', 'event.action']).execute()).toHaveLength(4)
    expect(await expireDueUnpaidOrders(db, new Date(), 10)).toBe(0)
  })

  it('does not let a legacy pending payment with NULL expiry be cancelled by its owner', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    await attachPendingPaymentWithoutExpiry(orderId, '1.20')

    const cancelled = await inject({
      method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(customer),
    })
    expect(cancelled.statusCode).toBe(409)
    expect(cancelled.json().error.code).toBe('ORDER_HAS_UNRESOLVED_OBLIGATION')
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(1)
  })

  it('does not let the timeout worker close a legacy pending payment with NULL expiry', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    await attachPendingPaymentWithoutExpiry(orderId, '1.20')

    expect(await expireDueUnpaidOrders(db, new Date(Date.now() + 60 * 60_000))).toBe(0)
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('pending_payment')
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(1)
  })

  it('blocks direct database closure while a legacy pending payment has NULL expiry', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    await attachPendingPaymentWithoutExpiry(orderId, '1.20')

    await expect(db.updateTable('orders').set({ status: 'closed' }).where('id', '=', orderId).execute())
      .rejects.toMatchObject({ constraint: 'orders_close_payment_unresolved' })
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(1)
  })

  it('requires a live provider deadline before pending and treats created attempts as unresolved', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const attemptId = randomUUID()
    await expect(db.insertInto('payment_attempts').values({
      id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
      topup_customer_id: null, source: 'external', amount: '1.20', status: 'created', provider: 'integration',
      provider_payment_id: null, wallet_operation_id: null, wallet_hold_operation_id: null,
      requested_wallet_amount: null, expires_at: null, completed_at: null,
    }).execute()).rejects.toMatchObject({ constraint: 'payment_attempts_created_deadline_required' })
    // Simulate a legacy ④-1 row so NULL remains protected during migration-era cleanup.
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_deadline_r1`.execute(trx)
      try {
        await trx.insertInto('payment_attempts').values({
          id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
          topup_customer_id: null, source: 'external', amount: '1.20', status: 'created', provider: 'integration',
          provider_payment_id: null, wallet_operation_id: null, wallet_hold_operation_id: null,
          requested_wallet_amount: null, expires_at: null, completed_at: null,
        }).execute()
      } finally {
        await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_deadline_r1`.execute(trx)
      }
    })

    const createdCancel = await inject({
      method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(customer),
    })
    expect(createdCancel.statusCode).toBe(409)
    await expect(db.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute())
      .rejects.toMatchObject({ constraint: 'payment_attempts_pending_deadline_required' })
    await db.updateTable('payment_attempts').set({
      status: 'pending', expires_at: new Date(Date.now() + 60_000),
    }).where('id', '=', attemptId).execute()
    await expect(db.updateTable('payment_attempts').set({ expires_at: new Date(Date.now() + 120_000) })
      .where('id', '=', attemptId).execute())
      .rejects.toMatchObject({ constraint: 'payment_attempts_deadline_immutable' })
    const pendingCancel = await inject({
      method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(customer),
    })
    expect(pendingCancel.statusCode).toBe(409)
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(1)
  })

  it('R3 rejects standalone created deadline edits', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const attemptId = randomUUID()
    const deadline = new Date(Date.now() + 60_000)
    await db.insertInto('payment_attempts').values({
      id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
      topup_customer_id: null, source: 'external', amount: '1.20', status: 'created', provider: 'integration',
      provider_payment_id: null, wallet_operation_id: null, wallet_hold_operation_id: null,
      requested_wallet_amount: null, expires_at: deadline, completed_at: null,
    }).execute()

    await expect(db.updateTable('payment_attempts').set({
      expires_at: new Date(deadline.getTime() + 60_000),
    }).where('id', '=', attemptId).execute())
      .rejects.toMatchObject({ constraint: 'payment_attempts_deadline_immutable' })
    await expect(db.updateTable('payment_attempts').set({
      expires_at: new Date(Date.now() - 60_000),
    }).where('id', '=', attemptId).execute())
      .rejects.toMatchObject({ constraint: 'payment_attempts_deadline_immutable' })
    await expect(db.updateTable('orders').set({ status: 'closed' }).where('id', '=', orderId).execute())
      .rejects.toMatchObject({ constraint: 'orders_close_payment_unresolved' })

    let releaseShortening!: () => void
    let signalShortening!: () => void
    const shorteningGate = new Promise<void>((resolve) => { releaseShortening = resolve })
    const shorteningReady = new Promise<void>((resolve) => { signalShortening = resolve })
    const shortening = db.transaction().execute(async (trx) => {
      try {
        await trx.updateTable('payment_attempts').set({ expires_at: new Date(Date.now() - 60_000) })
          .where('id', '=', attemptId).execute()
        signalShortening()
        await shorteningGate
        return { changed: true }
      } catch (error) {
        signalShortening()
        return { changed: false, error }
      }
    })
    await shorteningReady
    try {
      await expect(db.updateTable('orders').set({ status: 'closed' }).where('id', '=', orderId).execute())
        .rejects.toMatchObject({ constraint: 'orders_close_payment_unresolved' })
    } finally {
      releaseShortening()
    }
    expect(await shortening).toMatchObject({
      changed: false,
      error: { constraint: 'payment_attempts_deadline_immutable' },
    })

    // The only deadline edit after creation is atomic with the protected
    // created -> pending transition. Pending deadlines remain immutable.
    await db.updateTable('payment_attempts').set({
      status: 'pending', expires_at: new Date(Date.now() + 120_000),
    }).where('id', '=', attemptId).execute()
    await expect(db.updateTable('payment_attempts').set({
      expires_at: new Date(Date.now() + 180_000),
    }).where('id', '=', attemptId).execute())
      .rejects.toMatchObject({ constraint: 'payment_attempts_deadline_immutable' })
    await db.updateTable('payment_attempts').set({ status: 'failed', completed_at: new Date() })
      .where('id', '=', attemptId).execute()
    await expect(db.updateTable('payment_attempts').set({
      expires_at: new Date(Date.now() + 240_000),
    }).where('id', '=', attemptId).execute())
      .rejects.toMatchObject({ constraint: 'payment_attempts_deadline_immutable' })
    await db.updateTable('orders').set({ status: 'closed' }).where('id', '=', orderId).execute()
  })

  it('R3 serializes an expired created deadline extension against timeout closure', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const attemptId = await attachExpiredCreatedPayment(orderId, '1.20')
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    try {
      await sql`UPDATE orders SET unpaid_expires_at = clock_timestamp() - interval '1 second'
        WHERE id = ${orderId}::uuid`.execute(db)
    } finally {
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }

    let releaseMutation!: () => void
    let signalMutation!: () => void
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve })
    const mutationReady = new Promise<void>((resolve) => { signalMutation = resolve })
    const mutation = db.transaction().execute(async (trx) => {
      try {
        await trx.updateTable('payment_attempts').set({ expires_at: new Date(Date.now() + 60_000) })
          .where('id', '=', attemptId).execute()
        signalMutation()
        await mutationGate
        return { changed: true }
      } catch (error) {
        signalMutation()
        return { changed: false, error }
      }
    })
    await mutationReady
    let closed!: number
    try {
      // On the old trigger this closes using the committed expired deadline
      // while the extension is still uncommitted, after which that extension
      // could commit on an already-closed order.
      closed = await expireDueUnpaidOrders(db, new Date(), 1)
    } finally {
      releaseMutation()
    }
    const mutationResult = await mutation
    expect(closed).toBe(1)
    expect(mutationResult).toMatchObject({
      changed: false,
      error: { constraint: 'payment_attempts_deadline_immutable' },
    })
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('closed')
    expect((await db.selectFrom('payment_attempts').select(['status', 'expires_at'])
      .where('id', '=', attemptId).executeTakeFirstOrThrow()).expires_at?.getTime())
      .toBeLessThan(Date.now())
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(0)
  })

  it('R3 cannot revive an expired created attempt after its order closes', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const attemptId = await attachExpiredCreatedPayment(orderId, '1.20')
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    try {
      await sql`UPDATE orders SET unpaid_expires_at = clock_timestamp() - interval '1 second'
        WHERE id = ${orderId}::uuid`.execute(db)
    } finally {
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }
    expect(await expireDueUnpaidOrders(db)).toBe(1)
    await expect(db.updateTable('payment_attempts').set({ expires_at: new Date(Date.now() + 60_000) })
      .where('id', '=', attemptId).execute())
      .rejects.toMatchObject({ constraint: 'payment_attempts_deadline_immutable' })
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('closed')
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(0)
  })

  it('rejects pending attempts inserted without a deadline and serializes payment updates against cancellation', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const attemptId = randomUUID()
    await expect(db.insertInto('payment_attempts').values({
      id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
      topup_customer_id: null, source: 'external', amount: '1.20', status: 'pending', provider: 'integration',
      provider_payment_id: null, wallet_operation_id: null, wallet_hold_operation_id: null,
      requested_wallet_amount: null, expires_at: null, completed_at: null,
    }).execute()).rejects.toMatchObject({ constraint: 'payment_attempts_pending_deadline_required' })

    await db.insertInto('payment_attempts').values({
      id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
      topup_customer_id: null, source: 'external', amount: '1.20', status: 'created', provider: 'integration',
      provider_payment_id: null, wallet_operation_id: null, wallet_hold_operation_id: null,
      requested_wallet_amount: null, expires_at: new Date(Date.now() + 60_000), completed_at: null,
    }).execute()

    let release!: () => void
    let updated!: () => void
    const waiting = new Promise<void>((resolve) => { updated = resolve })
    const hold = new Promise<void>((resolve) => { release = resolve })
    const paymentTransition = db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('application_name', ${`r2-pending-${randomUUID()}`}, true)`.execute(trx)
      await trx.updateTable('payment_attempts').set({
        status: 'pending', expires_at: new Date(Date.now() + 60_000),
      }).where('id', '=', attemptId).execute()
      updated()
      await hold
    })
    await waiting
    const cancellation = inject({
      method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(customer),
    })
    try {
      await waitForOrderAdvisoryLockWait()
    } finally {
      release()
    }
    await paymentTransition
    const cancelled = await cancellation

    expect(cancelled.statusCode).toBe(409)
    expect(cancelled.json().error.code).toBe('ORDER_HAS_UNRESOLVED_OBLIGATION')
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('pending_payment')
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(1)
  })

  it('allows confirmed failed, expired, or cancelled payment attempts to release stock', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 4 })
    await enableManual(catalog, admin)
    const terminalStates = ['failed', 'expired', 'cancelled'] as const

    for (const status of terminalStates) {
      const items = [{ skuId: catalog.skuId, quantity: 1 }]
      const quoteResult = await quote(items, customer)
      const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
      const orderId = created.json().data.order.id as string
      const attemptId = randomUUID()
      await db.insertInto('payment_attempts').values({
        id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
        topup_customer_id: null, source: 'external', amount: '1.20', status: 'created', provider: 'integration',
        provider_payment_id: null, wallet_operation_id: null, wallet_hold_operation_id: null,
        requested_wallet_amount: null, expires_at: new Date(Date.now() + 60_000), completed_at: null,
      }).execute()
      await db.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
      await db.updateTable('payment_attempts').set({ status }).where('id', '=', attemptId).execute()

      const cancelled = await inject({
        method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(customer),
      })
      expect(cancelled.statusCode).toBe(200)
      expect(cancelled.json().data.status).toBe('closed')
    }
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(0)
  })

  it('keeps reconciliation receipts and unresolved refunds from closing an order', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const attemptId = randomUUID()
    await db.insertInto('payment_attempts').values({
      id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
      topup_customer_id: null, source: 'external', amount: '1.20', status: 'created', provider: 'integration',
      provider_payment_id: `mismatch-${attemptId}`, wallet_operation_id: null, wallet_hold_operation_id: null,
      requested_wallet_amount: null, expires_at: new Date(Date.now() + 60_000), completed_at: null,
    }).execute()
    await db.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
    await db.insertInto('payment_receipts').values({
      id: randomUUID(), payment_attempt_id: attemptId, source_bucket: 'external', provider: 'integration',
      provider_transaction_id: `mismatch-receipt-${attemptId}`, wallet_operation_id: null, wallet_line_no: null,
      amount: '0.80',
    }).execute()
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('reconciliation_required')
    await expect(db.updateTable('orders').set({ status: 'closed' }).where('id', '=', orderId).execute())
      .rejects.toMatchObject({ constraint: 'orders_close_requires_full_refund' })
    const cancelled = await inject({
      method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(customer),
    })
    expect(cancelled.statusCode).toBe(409)

    await db.insertInto('order_refunds').values({
      id: randomUUID(), order_id: orderId, idempotency_key: randomUUID(), request_sha256: digest, amount: '0.80',
    }).execute()
    await expect(db.updateTable('orders').set({ status: 'closed' }).where('id', '=', orderId).execute())
      .rejects.toMatchObject({ constraint: 'orders_close_refund_unresolved' })
  })

  it('blocks closure while an expired external attempt still has an unresolved wallet hold', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '5.00', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const attemptId = await attachExpiredWalletHold({
      orderId, customerId: customer.id, adminId: admin.id, externalAmount: '4.00', walletAmount: '1.00',
    })
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    try {
      await sql`UPDATE orders SET unpaid_expires_at = clock_timestamp() - interval '1 second'
        WHERE id = ${orderId}::uuid`.execute(db)
    } finally {
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }

    expect(await db.selectFrom('wallet_accounts').select(['gift_available', 'gift_frozen'])
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow()).toEqual({
      gift_available: '0.00', gift_frozen: '1.00',
    })
    const paymentProtection = await sql<{ unresolved: boolean }>`
      SELECT order_has_unresolved_payment_attempts(${orderId}::uuid) AS unresolved
    `.execute(db)
    expect(paymentProtection.rows[0]?.unresolved).toBe(true)
    expect(await expireDueUnpaidOrders(db, new Date(Date.now() + 60 * 60_000))).toBe(0)
    await expect(db.updateTable('orders').set({ status: 'closed' }).where('id', '=', orderId).execute())
      .rejects.toMatchObject({ constraint: 'orders_close_payment_unresolved' })
    const rejectedCancel = await inject({
      method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(customer),
    })
    expect(rejectedCancel.statusCode).toBe(409)
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('pending')

    await db.updateTable('payment_attempts').set({ status: 'failed' }).where('id', '=', attemptId).execute()
    expect(await db.selectFrom('wallet_accounts').select(['gift_available', 'gift_frozen'])
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow()).toEqual({
      gift_available: '1.00', gift_frozen: '0.00',
    })
    const allowedCancel = await inject({
      method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(customer),
    })
    expect(allowedCancel.statusCode).toBe(200)
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('closed')
  })

  it('records a late receipt instead of losing it while an expired payment still has a wallet hold', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '5.00', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const attemptId = await attachExpiredWalletHold({
      orderId, customerId: customer.id, adminId: admin.id, externalAmount: '4.00', walletAmount: '1.00',
    })
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    try {
      await sql`UPDATE orders SET unpaid_expires_at = clock_timestamp() - interval '1 second'
        WHERE id = ${orderId}::uuid`.execute(db)
    } finally {
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }

    const receiptId = randomUUID()
    await db.insertInto('payment_receipts').values({
      id: receiptId, payment_attempt_id: attemptId, source_bucket: 'external', provider: 'integration',
      provider_transaction_id: `late-wallet-hold-${receiptId}`, wallet_operation_id: null,
      wallet_line_no: null, amount: '4.00',
    }).execute()

    expect((await db.selectFrom('payment_receipts').select('disposition').where('id', '=', receiptId)
      .executeTakeFirstOrThrow()).disposition).toBe('late')
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId)
      .executeTakeFirstOrThrow()).status).toBe('late_succeeded')
    expect(await db.selectFrom('wallet_accounts').select(['gift_available', 'gift_frozen'])
      .where('customer_id', '=', customer.id).executeTakeFirstOrThrow()).toEqual({
      gift_available: '1.00', gift_frozen: '0.00',
    })
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('pending_payment')
    expect(await expireDueUnpaidOrders(db, new Date(Date.now() + 60 * 60_000))).toBe(0)
    await expect(db.updateTable('orders').set({ status: 'closed' }).where('id', '=', orderId).execute())
      .rejects.toMatchObject({ constraint: 'orders_close_requires_full_refund' })
  })

  it('records a late receipt while timeout work skips the locked order and never releases twice', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteResult = await quote(items, customer)
    const created = await createOrder(items, quoteResult.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const attemptId = await attachExpiredPendingPayment(orderId, '1.20')
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    try {
      await sql`UPDATE orders SET unpaid_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${orderId}::uuid`.execute(db)
    } finally {
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }

    let unlock!: () => void
    let acquired!: () => void
    const locked = new Promise<void>((resolve) => { acquired = resolve })
    const hold = new Promise<void>((resolve) => { unlock = resolve })
    const receiptInsert = db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`.execute(trx)
      acquired()
      await hold
      await trx.insertInto('payment_receipts').values({
        id: randomUUID(), payment_attempt_id: attemptId, source_bucket: 'external', provider: 'integration',
        provider_transaction_id: `late-race-${attemptId}`, wallet_operation_id: null, wallet_line_no: null,
        amount: '1.20',
      }).execute()
    })
    await locked
    expect(await expireDueUnpaidOrders(db, new Date(Date.now() + 60 * 60_000))).toBe(0)
    unlock()
    await receiptInsert

    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('closed')
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('late_succeeded')
    expect(await db.selectFrom('payment_receipts').select('disposition').where('payment_attempt_id', '=', attemptId).execute())
      .toEqual([{ disposition: 'late' }])
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(0)
    expect(await db.selectFrom('order_inventory_events as event')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
      .where('reservation.product_variant_id', '=', catalog.skuId).select('event.action').execute())
      .toEqual([{ action: 'reserve' }, { action: 'release' }])
    expect(await expireDueUnpaidOrders(db, new Date(Date.now() + 60 * 60_000))).toBe(0)
  })

  it('skips a NULL-deadline payment order and processes a later due order in the same worker batch', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 4 })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const protectedQuote = await quote(items, customer)
    const protectedOrder = await createOrder(items, protectedQuote.json().data.quoteToken, customer)
    const protectedId = protectedOrder.json().data.order.id as string
    await attachPendingPaymentWithoutExpiry(protectedId, '1.20')
    const dueQuote = await quote(items, customer)
    const dueOrder = await createOrder(items, dueQuote.json().data.quoteToken, customer)
    const dueId = dueOrder.json().data.order.id as string
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`.execute(db)
    try {
      await sql`UPDATE orders SET unpaid_expires_at = clock_timestamp() - interval '1 second'
        WHERE id IN (${protectedId}::uuid, ${dueId}::uuid)`.execute(db)
    } finally {
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`.execute(db)
    }

    expect(await expireDueUnpaidOrders(db, new Date(Date.now() + 60 * 60_000), 1)).toBe(1)
    expect((await db.selectFrom('orders').select('status').where('id', '=', protectedId).executeTakeFirstOrThrow()).status)
      .toBe('pending_payment')
    expect((await db.selectFrom('orders').select('status').where('id', '=', dueId).executeTakeFirstOrThrow()).status)
      .toBe('closed')
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(1)
  })

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

describe('purchase limit acceptance on PostgreSQL', () => {
  it('keeps unlimited checkout working, applies per-order limits to guests, and requires an account for account limits', async () => {
    const admin = await createAdmin()
    const catalog = await createCatalog({ price: '1.00', mode: 'quantity', stock: 5 })
    await enableManual(catalog, admin)
    await db.updateTable('storefront_customer_policy').set({
      guest_checkout_enabled: true, guest_free_claim_enabled: true,
    }).where('singleton', '=', true).execute()
    const guest = await newGuestSession()

    const unlimited = await quote([{ skuId: catalog.skuId, quantity: 2 }], undefined, guest.cookie)
    expect(unlimited.json().data.canContinue).toBe(true)
    expect(unlimited.json().data.items[0].purchaseLimits.requiresLogin).toBe(false)

    await setSkuPurchaseLimits(catalog.skuId, { perOrder: 2 })
    const withinLimit = await quote([{ skuId: catalog.skuId, quantity: 2 }], undefined, guest.cookie)
    expect(withinLimit.json().data.canContinue).toBe(true)
    const guestOrder = await createOrder(
      [{ skuId: catalog.skuId, quantity: 2 }], withinLimit.json().data.quoteToken, guest,
    )
    expect(guestOrder.statusCode).toBe(201)
    const overLimit = await quote([{ skuId: catalog.skuId, quantity: 3 }], undefined, guest.cookie)
    expect(overLimit.json().data.items[0].reason).toBe('purchase_limit_exceeded')
    expect(overLimit.json().data.items[0].purchaseLimits.sku.maxAvailable).toBe(2)

    await setSkuPurchaseLimits(catalog.skuId, { lifetime: 5 })
    const accountOnly = await quote([{ skuId: catalog.skuId, quantity: 1 }], undefined, guest.cookie)
    expect(accountOnly.json().data.items[0].reason).toBe('login_required_for_purchase_limit')
    expect(accountOnly.json().data.items[0].purchaseLimits.sku.lifetimePurchased).toBeNull()
    expect(accountOnly.json().data.canContinue).toBe(false)
  })

  it('combines product and SKU per-order rules across all selected SKUs', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.00', mode: 'unlimited' })
    await enableManual(catalog, admin)
    const secondSkuId = await addSiblingSku(catalog)
    await setProductPurchaseLimits(catalog.productId, { perOrder: 3 })
    await setSkuPurchaseLimits(catalog.skuId, { perOrder: 1 })

    const bothRules = await quote([
      { skuId: catalog.skuId, quantity: 2 },
      { skuId: secondSkuId, quantity: 2 },
    ], customer)
    expect(bothRules.json().data.canContinue).toBe(false)
    expect(bothRules.json().data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ skuId: catalog.skuId, purchaseLimits: expect.objectContaining({ product: expect.objectContaining({ exceeded: true }), sku: expect.objectContaining({ exceeded: true }) }) }),
      expect.objectContaining({ skuId: secondSkuId, purchaseLimits: expect.objectContaining({ product: expect.objectContaining({ exceeded: true }), sku: expect.objectContaining({ exceeded: false }) }) }),
    ]))

    await setProductPurchaseLimits(catalog.productId, { perOrder: null })
    const skuOnly = await quote([{ skuId: catalog.skuId, quantity: 2 }], customer)
    expect(skuOnly.json().data.items[0].purchaseLimits.product.exceeded).toBe(false)
    expect(skuOnly.json().data.items[0].purchaseLimits.sku.exceeded).toBe(true)
  })

  it('counts pending cross-SKU orders toward product and SKU lifetime caps', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.00', mode: 'unlimited' })
    await enableManual(catalog, admin)
    const secondSkuId = await addSiblingSku(catalog)
    await setProductPurchaseLimits(catalog.productId, { lifetime: 5 })
    await setSkuPurchaseLimits(catalog.skuId, { lifetime: 2 })

    const firstItems = [{ skuId: catalog.skuId, quantity: 2 }]
    const firstQuote = await quote(firstItems, customer)
    expect(firstQuote.json().data.canContinue).toBe(true)
    expect((await createOrder(firstItems, firstQuote.json().data.quoteToken, customer)).statusCode).toBe(201)

    const otherSkuItems = [{ skuId: secondSkuId, quantity: 3 }]
    const otherSkuQuote = await quote(otherSkuItems, customer)
    expect(otherSkuQuote.json().data.canContinue).toBe(true)
    expect(otherSkuQuote.json().data.items[0].purchaseLimits.product.lifetimePurchased).toBe(2)
    expect((await createOrder(otherSkuItems, otherSkuQuote.json().data.quoteToken, customer)).statusCode).toBe(201)

    const productExhausted = await quote([{ skuId: secondSkuId, quantity: 1 }], customer)
    expect(productExhausted.json().data.items[0].reason).toBe('purchase_limit_exceeded')
    expect(productExhausted.json().data.items[0].purchaseLimits.product.lifetimePurchased).toBe(5)
    const skuExhausted = await quote([{ skuId: catalog.skuId, quantity: 1 }], customer)
    expect(skuExhausted.json().data.items[0].purchaseLimits.sku.lifetimePurchased).toBe(2)
    expect(skuExhausted.json().data.items[0].purchaseLimits.sku.maxAvailable).toBe(0)
  })

  it('releases an unpaid closed order, but idempotent replay does not reserve a second quota', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.00', mode: 'quantity', stock: 3 })
    await enableManual(catalog, admin)
    await setProductPurchaseLimits(catalog.productId, { lifetime: 1 })
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const current = await quote(items, customer)
    const idempotencyKey = randomUUID()
    const created = await createOrder(items, current.json().data.quoteToken, customer, idempotencyKey)
    expect(created.statusCode).toBe(201)
    const orderId = created.json().data.order.id as string
    const replay = await createOrder(items, current.json().data.quoteToken, customer, idempotencyKey)
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data).toMatchObject({ created: false, order: { id: orderId } })
    expect(await db.selectFrom('orders').select('id').where('customer_id', '=', customer.id).execute()).toHaveLength(1)
    expect((await quote(items, customer)).json().data.items[0].purchaseLimits.product.maxAvailable).toBe(0)

    const cancelled = await inject({
      method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(customer),
    })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().data.status).toBe('closed')
    const afterClose = await quote(items, customer)
    expect(afterClose.json().data.canContinue).toBe(true)
    expect(afterClose.json().data.items[0].purchaseLimits.product.lifetimePurchased).toBe(0)
  })

  it('keeps paid and refunded history counted after a fully refunded order closes', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.25', mode: 'unlimited' })
    await enableManual(catalog, admin)
    await setSkuPurchaseLimits(catalog.skuId, { lifetime: 1 })
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const current = await quote(items, customer)
    const created = await createOrder(items, current.json().data.quoteToken, customer)
    expect(created.statusCode).toBe(201)
    const orderId = created.json().data.order.id as string
    await settleAndRefundExternally(orderId, '1.25')
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('processing')
    await db.updateTable('orders').set({ status: 'closed' }).where('id', '=', orderId).execute()
    expect((await sql<{ counts: boolean }>`SELECT order_counts_as_purchase(${orderId}::uuid) AS counts`.execute(db)).rows[0]?.counts)
      .toBe(true)

    const afterRefund = await quote(items, customer)
    expect(afterRefund.json().data.items[0].purchaseLimits.sku.lifetimePurchased).toBe(1)
    expect(afterRefund.json().data.items[0].purchaseLimits.sku.maxAvailable).toBe(0)
    expect(afterRefund.json().data.canContinue).toBe(false)
  })

  it('uses database order time and a strict rolling 24-hour boundary', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.00', mode: 'unlimited' })
    await enableManual(catalog, admin)
    await setSkuPurchaseLimits(catalog.skuId, { rolling24Hours: 1 })
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const current = await quote(items, customer)
    const created = await createOrder(items, current.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const generatedTime = (await db.selectFrom('orders').select('created_at').where('id', '=', orderId).executeTakeFirstOrThrow()).created_at
    expect(Math.abs(generatedTime.getTime() - Date.now())).toBeLessThan(5_000)

    const exactBoundary = await sql<{ quantity: string }>`
      SELECT prior_purchase_quantity(${customer.id}::uuid, ${catalog.productId}::uuid,
        ${catalog.skuId}::uuid, created_at, NULL)::text AS quantity
      FROM orders WHERE id = ${orderId}::uuid
    `.execute(db)
    expect(exactBoundary.rows[0]?.quantity).toBe('0')

    await setOrderCreatedAt(orderId, new Date(Date.now() - 24 * 60 * 60_000 - 2_000))
    const outsideWindow = await quote(items, customer)
    expect(outsideWindow.json().data.canContinue).toBe(true)
    expect(outsideWindow.json().data.items[0].purchaseLimits.sku.rolling24HoursPurchased).toBe(0)

    await setOrderCreatedAt(orderId, new Date(Date.now() - 24 * 60 * 60_000 + 2_000))
    const insideWindow = await quote(items, customer)
    expect(insideWindow.json().data.canContinue).toBe(false)
    expect(insideWindow.json().data.items[0].purchaseLimits.sku.rolling24HoursPurchased).toBe(1)
  })

  it('counts zero-value processing orders toward the same purchase limits', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '0.00', mode: 'unlimited' })
    await enableManual(catalog, admin)
    await setProductPurchaseLimits(catalog.productId, { lifetime: 1 })
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const current = await quote(items, customer)
    const created = await createOrder(items, current.json().data.quoteToken, customer)
    expect(created.statusCode).toBe(201)
    expect(created.json().data.order.status).toBe('processing')
    const afterFreeClaim = await quote(items, customer)
    expect(afterFreeClaim.json().data.items[0].purchaseLimits.product.lifetimePurchased).toBe(1)
    expect(afterFreeClaim.json().data.canContinue).toBe(false)
  })

  it('returns a fresh limit quote when two customer sessions race to use one account quota', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const secondDevice = await loginCustomerSession(customer)
    const catalog = await createCatalog({ price: '1.00', mode: 'unlimited' })
    await enableManual(catalog, admin)
    await setSkuPurchaseLimits(catalog.skuId, { lifetime: 1 })
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const current = await quote(items, customer)

    let releaseOwner!: () => void
    let signalLocked!: () => void
    const gate = new Promise<void>((resolve) => { releaseOwner = resolve })
    const ownerLocked = new Promise<void>((resolve) => { signalLocked = resolve })
    const blocker = db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM customers WHERE id = ${customer.id}::uuid FOR UPDATE`.execute(trx)
      signalLocked()
      await gate
    })
    await ownerLocked
    const first = createOrder(items, current.json().data.quoteToken, customer)
    const second = createOrder(items, current.json().data.quoteToken, secondDevice)
    try {
      await waitForLockWaitCount('aikayun-api', 2, 'customers')
    } finally {
      releaseOwner()
    }
    await blocker
    const results = await Promise.all([first, second])
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409])
    expect(results.find(result => result.statusCode === 409)?.json().error.code).toBe('CHECKOUT_QUOTE_CHANGED')
    expect(await db.selectFrom('orders').select('id').where('customer_id', '=', customer.id).execute()).toHaveLength(1)
    const latest = await quote(items, customer)
    expect(latest.json().data.items[0].purchaseLimits.sku.lifetimePurchased).toBe(1)
    expect(latest.json().data.items[0].purchaseLimits.sku.maxAvailable).toBe(0)
  })

  it('serializes same-product different-SKU orders against the shared product quota', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const secondDevice = await loginCustomerSession(customer)
    const catalog = await createCatalog({ price: '1.00', mode: 'unlimited' })
    await enableManual(catalog, admin)
    const otherSkuId = await addSiblingSku(catalog)
    await setProductPurchaseLimits(catalog.productId, { lifetime: 1 })
    const firstItems = [{ skuId: catalog.skuId, quantity: 1 }]
    const secondItems = [{ skuId: otherSkuId, quantity: 1 }]
    const [firstQuote, secondQuote] = await Promise.all([quote(firstItems, customer), quote(secondItems, secondDevice)])
    expect(firstQuote.json().data.canContinue).toBe(true)
    expect(secondQuote.json().data.canContinue).toBe(true)

    let releaseOwner!: () => void
    let signalLocked!: () => void
    const gate = new Promise<void>(resolve => { releaseOwner = resolve })
    const ownerLocked = new Promise<void>(resolve => { signalLocked = resolve })
    const blocker = db.transaction().execute(async trx => {
      await sql`SELECT id FROM customers WHERE id = ${customer.id}::uuid FOR UPDATE`.execute(trx)
      signalLocked()
      await gate
    })
    await ownerLocked
    const first = createOrder(firstItems, firstQuote.json().data.quoteToken, customer)
    const second = createOrder(secondItems, secondQuote.json().data.quoteToken, secondDevice)
    try {
      await waitForLockWaitCount('aikayun-api', 2, 'customers')
    } finally {
      releaseOwner()
    }
    await blocker
    const results = await Promise.all([first, second])
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409])
    expect(await db.selectFrom('orders').select('id').where('customer_id', '=', customer.id).execute()).toHaveLength(1)
    const remaining = await quote([{ skuId: catalog.skuId, quantity: 1 }], customer)
    expect(remaining.json().data.items[0].purchaseLimits.product).toMatchObject({ lifetimePurchased: 1, maxAvailable: 0 })
  })

  it('checks a multi-SKU order atomically against a concurrent single-SKU order', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const secondDevice = await loginCustomerSession(customer)
    const catalog = await createCatalog({ price: '1.00', mode: 'unlimited' })
    await enableManual(catalog, admin)
    const otherSkuId = await addSiblingSku(catalog)
    await setProductPurchaseLimits(catalog.productId, { lifetime: 2 })
    const combinedItems = [{ skuId: catalog.skuId, quantity: 1 }, { skuId: otherSkuId, quantity: 1 }]
    const singleItems = [{ skuId: catalog.skuId, quantity: 1 }]
    const [combinedQuote, singleQuote] = await Promise.all([quote(combinedItems, customer), quote(singleItems, secondDevice)])
    expect(combinedQuote.json().data.canContinue).toBe(true)
    expect(singleQuote.json().data.canContinue).toBe(true)

    let releaseOwner!: () => void
    let signalLocked!: () => void
    const gate = new Promise<void>(resolve => { releaseOwner = resolve })
    const ownerLocked = new Promise<void>(resolve => { signalLocked = resolve })
    const blocker = db.transaction().execute(async trx => {
      await sql`SELECT id FROM customers WHERE id = ${customer.id}::uuid FOR UPDATE`.execute(trx)
      signalLocked()
      await gate
    })
    await ownerLocked
    const combined = createOrder(combinedItems, combinedQuote.json().data.quoteToken, customer)
    const single = createOrder(singleItems, singleQuote.json().data.quoteToken, secondDevice)
    try {
      await waitForLockWaitCount('aikayun-api', 2, 'customers')
    } finally {
      releaseOwner()
    }
    await blocker
    const results = await Promise.all([combined, single])
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409])
    const orders = await db.selectFrom('orders').select('id').where('customer_id', '=', customer.id).execute()
    expect(orders).toHaveLength(1)
    const createdOrder = results.find(result => result.statusCode === 201)!.json().data.order
    const expectedQuantity = createdOrder.items.reduce((total: number, item: { quantity: number }) => total + item.quantity, 0)
    const purchased = await sql<{ quantity: string }>`
      SELECT prior_purchase_quantity(${customer.id}::uuid, ${catalog.productId}::uuid, NULL, NULL, NULL)::text AS quantity
    `.execute(db)
    expect(purchased.rows[0]?.quantity).toBe(String(expectedQuantity))
    expect([1, 2]).toContain(expectedQuantity)
  })

  it('rechecks stock and limit together and rolls back an ineligible order without a reservation', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.00', mode: 'quantity', stock: 1 })
    await enableManual(catalog, admin)
    await setSkuPurchaseLimits(catalog.skuId, { lifetime: 1 })
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const firstQuote = await quote(items, customer)
    const created = await createOrder(items, firstQuote.json().data.quoteToken, customer)
    expect(created.statusCode).toBe(201)

    const blockedQuote = await quote(items, customer)
    expect(blockedQuote.json().data.items[0]).toMatchObject({
      canPurchase: false,
      reason: 'insufficient_inventory',
      availableQuantity: 0,
      purchaseLimits: { sku: { exceeded: true, maxAvailable: 0 } },
    })
    const denied = await createOrder(items, blockedQuote.json().data.quoteToken, customer)
    expect(denied.statusCode).toBe(409)
    expect(denied.json().error.code).toBe('PURCHASE_LIMIT_EXCEEDED')
    expect(await db.selectFrom('orders').select('id').where('customer_id', '=', customer.id).execute()).toHaveLength(1)
    expect(await db.selectFrom('order_inventory_reservations').select('id').where('product_variant_id', '=', catalog.skuId).execute()).toHaveLength(1)
    expect((await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow())).toEqual({ stocked: 1, reserved: 1 })
  })

  it('rejects an old quote when a concurrent configuration edit commits before catalog locks', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.00', mode: 'unlimited' })
    await enableManual(catalog, admin)
    const items = [{ skuId: catalog.skuId, quantity: 2 }]
    const current = await quote(items, customer)
    expect(current.json().data.canContinue).toBe(true)

    let releaseEdit!: () => void
    let signalEditLocked!: () => void
    const gate = new Promise<void>(resolve => { releaseEdit = resolve })
    const editLocked = new Promise<void>(resolve => { signalEditLocked = resolve })
    const editor = db.transaction().execute(async trx => {
      await sql`SELECT id FROM products WHERE id = ${catalog.productId}::uuid FOR UPDATE`.execute(trx)
      await trx.updateTable('product_variants').set({ purchase_limit_lifetime: 1 })
        .where('id', '=', catalog.skuId).execute()
      signalEditLocked()
      await gate
    })
    await editLocked
    const pending = createOrder(items, current.json().data.quoteToken, customer)
    try {
      await waitForLockWaitCount('aikayun-api', 1, 'products')
    } finally {
      releaseEdit()
    }
    await editor
    const rejected = await pending
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json().error).toMatchObject({
      code: 'CHECKOUT_QUOTE_CHANGED',
      currentQuote: { items: [{ purchaseLimits: { sku: { exceeded: true, maxAvailable: 1 } } }] },
    })
    expect(await db.selectFrom('orders').select('id').where('customer_id', '=', customer.id).execute()).toHaveLength(0)
  })

  it('enforces quota in PostgreSQL for direct writers and deterministically serializes concurrent inserts', async () => {
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.00', mode: 'unlimited' })
    await setSkuPurchaseLimits(catalog.skuId, { lifetime: 1 })
    await db.updateTable('product_variant_fulfillment').set({ manual_delivery_ready: true })
      .where('product_variant_id', '=', catalog.skuId).execute()
    const firstOrderId = randomUUID()
    const secondOrderId = randomUUID()
    const firstApplication = `limit-direct-first-${randomUUID()}`
    const secondApplication = `limit-direct-second-${randomUUID()}`
    let releaseFirst!: () => void
    let signalFirstInserted!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstInserted = new Promise<void>((resolve) => { signalFirstInserted = resolve })
    const first = db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('application_name', ${firstApplication}, true)`.execute(trx)
      await insertDirectPurchaseOrder(trx, customer.id, catalog, firstOrderId)
      signalFirstInserted()
      await gate
    })
    await Promise.race([firstInserted, first.then(() => { throw new Error('First direct order ended before reaching its lock gate') })])
    const second = db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('application_name', ${secondApplication}, true)`.execute(trx)
      await insertDirectPurchaseOrder(trx, customer.id, catalog, secondOrderId)
    })
    try {
      const waiting = await waitForPostgresLockWait(secondApplication)
      expect(waiting.blockerPids.length).toBeGreaterThan(0)
    } finally {
      releaseFirst()
    }
    await first
    await expect(second).rejects.toMatchObject({ constraint: 'order_purchase_limit_exceeded' })
    expect(await db.selectFrom('orders').select('id').where('customer_id', '=', customer.id).execute()).toHaveLength(1)
    expect(await db.selectFrom('orders').select('id').where('id', '=', secondOrderId).execute()).toHaveLength(0)
  })

  it('aborts a stale repeatable-read direct writer after the account quota fence changes', async () => {
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.00', mode: 'unlimited' })
    await setSkuPurchaseLimits(catalog.skuId, { lifetime: 1 })
    await db.updateTable('product_variant_fulfillment').set({ manual_delivery_ready: true })
      .where('product_variant_id', '=', catalog.skuId).execute()
    const firstOrderId = randomUUID()
    const secondOrderId = randomUUID()
    const firstApplication = `limit-rr-first-${randomUUID()}`
    const secondApplication = `limit-rr-second-${randomUUID()}`
    let releaseFirst!: () => void
    let signalFirstInserted!: () => void
    let signalSecondSnapshot!: () => void
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    const firstInserted = new Promise<void>(resolve => { signalFirstInserted = resolve })
    const secondSnapshot = new Promise<void>(resolve => { signalSecondSnapshot = resolve })
    const first = db.transaction().execute(async trx => {
      await sql`SELECT set_config('application_name', ${firstApplication}, true)`.execute(trx)
      await insertDirectPurchaseOrder(trx, customer.id, catalog, firstOrderId)
      signalFirstInserted()
      await gate
    })
    await Promise.race([firstInserted, first.then(() => { throw new Error('First direct order ended before reaching its lock gate') })])
    const second = db.transaction().setIsolationLevel('repeatable read').execute(async trx => {
      await sql`SELECT set_config('application_name', ${secondApplication}, true)`.execute(trx)
      await trx.selectFrom('orders').select('id').where('customer_id', '=', customer.id).execute()
      signalSecondSnapshot()
      await insertDirectPurchaseOrder(trx, customer.id, catalog, secondOrderId)
    })
    await secondSnapshot
    try {
      const waiting = await waitForPostgresLockWait(secondApplication)
      expect(waiting.blockerPids.length).toBeGreaterThan(0)
    } finally {
      releaseFirst()
    }
    await first
    await expect(second).rejects.toMatchObject({ code: '40001' })
    expect(await db.selectFrom('orders').select('id').where('customer_id', '=', customer.id).execute()).toHaveLength(1)
    expect(await db.selectFrom('orders').select('id').where('id', '=', secondOrderId).execute()).toHaveLength(0)
  })

  it('retains refunded purchase history under the anonymized identity without assigning it to a new account', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.25', mode: 'unlimited' })
    await enableManual(catalog, admin)
    await setSkuPurchaseLimits(catalog.skuId, { lifetime: 1 })
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const current = await quote(items, customer)
    const created = await createOrder(items, current.json().data.quoteToken, customer)
    expect(created.statusCode).toBe(201)
    const orderId = created.json().data.order.id as string
    await settleAndRefundExternally(orderId, '1.25')
    await db.updateTable('orders').set({ status: 'closed' }).where('id', '=', orderId).execute()

    const deleted = await inject({ method: 'DELETE', url: `/api/v1/admin/customers/${customer.id}`, headers: adminHeaders(admin) })
    expect(deleted.statusCode).toBe(200)
    expect((await db.selectFrom('orders').select('customer_id').where('id', '=', orderId).executeTakeFirstOrThrow()).customer_id)
      .toBe(customer.id)
    expect((await db.selectFrom('customers').select(['status', 'username']).where('id', '=', customer.id).executeTakeFirstOrThrow()))
      .toEqual({ status: 'deleted', username: null })
    const historical = await sql<{ quantity: string }>`
      SELECT prior_purchase_quantity(${customer.id}::uuid, ${catalog.productId}::uuid,
        ${catalog.skuId}::uuid, NULL, NULL)::text AS quantity
    `.execute(db)
    expect(historical.rows[0]?.quantity).toBe('1')

    const csrf = await customerCsrf()
    const recreated = await inject({
      method: 'POST', url: '/api/v1/customer/auth/register',
      headers: { origin: testOrigin, cookie: csrf.cookie, 'x-csrf-token': csrf.token },
      payload: { username: customer.username, password },
    })
    expect(recreated.statusCode).toBe(201)
    const newCustomer: Customer = {
      id: recreated.json().data.customer.id,
      username: customer.username,
      cookie: cookieFrom(recreated, 'aikayun_customer_session'),
      csrfToken: csrf.token,
      csrfCookie: csrf.cookie,
    }
    expect(newCustomer.id).not.toBe(customer.id)
    const newAccountQuote = await quote(items, newCustomer)
    expect(newAccountQuote.json().data.items[0].purchaseLimits.sku).toMatchObject({ lifetimePurchased: 0, maxAvailable: 1 })
  })

  it('audits guarded merchant rule edits, rejects invalid values, and rejects stale revisions', async () => {
    const admin = await createAdmin()
    const catalog = await createCatalog({ price: '1.00', mode: 'unlimited' })
    const secondProduct = await createCatalog({ price: '1.00', mode: 'unlimited' })
    const initial = await db.selectFrom('products').select('revision').where('id', '=', catalog.productId).executeTakeFirstOrThrow()
    const saved = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/purchase-limits`,
      headers: adminHeaders(admin), payload: {
        expectedRevision: initial.revision,
        purchaseLimits: { perOrder: 10, lifetime: 20, rolling24Hours: null },
      },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().data.purchaseLimits).toEqual({ perOrder: 10, lifetime: 20, rolling24Hours: null })
    const skuRevision = await db.selectFrom('product_variants').select('revision').where('id', '=', catalog.skuId).executeTakeFirstOrThrow()
    const skuUpdated = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/purchase-limits`,
      headers: adminHeaders(admin), payload: {
        expectedProductRevision: saved.json().data.revision,
        expectedSkuRevision: skuRevision.revision,
        purchaseLimits: { perOrder: 2, lifetime: null, rolling24Hours: 3 },
      },
    })
    expect(skuUpdated.statusCode).toBe(200)
    expect(skuUpdated.json().data.variants.find((row: { id: string }) => row.id === catalog.skuId).purchaseLimits)
      .toEqual({ perOrder: 2, lifetime: null, rolling24Hours: 3 })
    expect(await db.selectFrom('product_management_audit_events').select('id').where('product_id', '=', catalog.productId).execute())
      .toHaveLength(2)

    const invalid = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/purchase-limits`,
      headers: adminHeaders(admin), payload: {
        expectedRevision: skuUpdated.json().data.revision,
        purchaseLimits: { perOrder: 0, lifetime: null, rolling24Hours: null },
      },
    })
    expect(invalid.statusCode).toBe(400)
    const wrongOwnerSku = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/variants/${secondProduct.skuId}/purchase-limits`,
      headers: adminHeaders(admin), payload: {
        expectedProductRevision: skuUpdated.json().data.revision,
        expectedSkuRevision: 1,
        purchaseLimits: { perOrder: 1, lifetime: null, rolling24Hours: null },
      },
    })
    expect(wrongOwnerSku.statusCode).toBe(404)
    const noCsrf = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/purchase-limits`,
      headers: adminHeaders(admin, testOrigin, false), payload: {
        expectedRevision: skuUpdated.json().data.revision,
        purchaseLimits: { perOrder: 1, lifetime: null, rolling24Hours: null },
      },
    })
    expect(noCsrf.statusCode).toBe(403)
    const stale = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/purchase-limits`,
      headers: adminHeaders(admin), payload: {
        expectedRevision: initial.revision,
        purchaseLimits: { perOrder: null, lifetime: null, rolling24Hours: null },
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('PRODUCT_REVISION_CONFLICT')
  })
})
