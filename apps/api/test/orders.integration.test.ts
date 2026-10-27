import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
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
import { startCodePoolDeliveryWorker } from '../src/commerce/code-pool-delivery-worker.js'
import type { AppConfig } from '../src/config.js'
import { codePoolFingerprint, decryptCodePoolContent } from '../src/commerce/code-pool-crypto.js'
import { insertNoFormPurchaseSnapshot } from './fixtures/purchase-line.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const testOrigin = 'http://localhost:3000'
const password = 'Order-Integration-Password-2026!'
const digest = 'a'.repeat(64)

let app: FastifyInstance
let db: Kysely<Database>
let appConfig: AppConfig
let initialCodePoolKeyRing: AppConfig['codePoolEncryptionKeyRing']
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

function injectInto(target: FastifyInstance, options: InjectOptions) {
  return target.inject({ ...options, remoteAddress: remoteAddress() })
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
  await db.updateTable('payment_attempts').set({ status: 'succeeded' }).where('id', '=', attemptId).execute()
  const reviewingAdminId = (await db.selectFrom('admin_users').select('id').executeTakeFirstOrThrow()).id
  await db.insertInto('order_refunds').values({
    id: refundId, order_id: orderId, idempotency_key: randomUUID(), request_sha256: digest, amount,
  }).execute()
  await db.updateTable('order_refunds').set({ status: 'approved', reviewed_by_admin_id: reviewingAdminId })
    .where('id', '=', refundId).execute()
  await db.insertInto('order_refund_allocations').values({
    id: allocationId, refund_id: refundId, source_payment_receipt_id: receiptId,
    operation_id: randomUUID(), request_sha256: digest, destination: 'cash_balance', amount,
  }).execute()
  await db.updateTable('order_refunds').set({ status: 'processing' }).where('id', '=', refundId).execute()
  await db.updateTable('order_refund_allocations').set({
    status: 'succeeded',
  }).where('id', '=', allocationId).execute()
  await db.updateTable('order_refunds').set({ status: 'succeeded' }).where('id', '=', refundId).execute()
}

async function refundExistingReceipt(orderId: string, receiptId: string, amount: string): Promise<void> {
  const refundId = randomUUID()
  const allocationId = randomUUID()
  const reviewingAdminId = (await db.selectFrom('admin_users').select('id').executeTakeFirstOrThrow()).id
  await db.insertInto('order_refunds').values({
    id: refundId, order_id: orderId, idempotency_key: randomUUID(), request_sha256: digest, amount,
  }).execute()
  await db.updateTable('order_refunds').set({ status: 'approved', reviewed_by_admin_id: reviewingAdminId })
    .where('id', '=', refundId).execute()
  await db.insertInto('order_refund_allocations').values({
    id: allocationId, refund_id: refundId, source_payment_receipt_id: receiptId,
    operation_id: randomUUID(), request_sha256: digest, destination: 'cash_balance', amount,
  }).execute()
  await db.updateTable('order_refunds').set({ status: 'processing' }).where('id', '=', refundId).execute()
  await db.updateTable('order_refund_allocations').set({ status: 'succeeded' }).where('id', '=', allocationId).execute()
  await db.updateTable('order_refunds').set({ status: 'succeeded' }).where('id', '=', refundId).execute()
}

async function insertDirectPurchaseOrder(
  trx: Transaction<Database>,
  customerId: string,
  catalog: Catalog,
  orderId: string,
) {
  const itemId = randomUUID()
  const lineId = randomUUID()
  await trx.insertInto('orders').values({
    id: orderId, customer_id: customerId, guest_order_session_id: null,
    idempotency_key: randomUUID(), request_sha256: digest, total_amount: catalog.price,
    unpaid_expires_at: new Date(Date.now() + 60 * 60_000),
    history_hidden_at: null, history_hidden_by_admin_id: null, history_hidden_reason: null,
  }).execute()
  await sql`
    INSERT INTO order_items (
      id, order_id, purchase_line_id, product_id, product_variant_id, product_name_snapshot, product_type_snapshot,
      sku_code_snapshot, sku_snapshot, inventory_mode_snapshot, fulfillment_method_snapshot,
      unit_price, quantity, line_amount
    )
    SELECT ${itemId}::uuid, ${orderId}::uuid, ${lineId}::uuid, product.id, variant.id, product.name,
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
  await insertNoFormPurchaseSnapshot(trx, itemId, catalog.skuId)
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

async function setCodePoolReadiness(catalog: Catalog, admin: Admin, enabled: boolean) {
  const revisions = await db.selectFrom('product_variants')
    .select(['revision', 'inventory_revision']).where('id', '=', catalog.skuId).executeTakeFirstOrThrow()
  return inject({
    method: 'PUT',
    url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/code-pool/readiness`,
    headers: adminHeaders(admin),
    payload: {
      enabled,
      expectedSkuRevision: revisions.revision,
      expectedInventoryRevision: revisions.inventory_revision,
    },
  })
}

async function importCodePool(catalog: Catalog, admin: Admin, sourceText: string, operationId = randomUUID()) {
  return importCodePoolInto(app, catalog, admin, sourceText, operationId)
}

async function importCodePoolInto(target: FastifyInstance, catalog: Catalog, admin: Admin, sourceText: string, operationId = randomUUID()) {
  return injectInto(target, {
    method: 'POST',
    url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/code-pool/batches`,
    headers: adminHeaders(admin),
    payload: { operationId, format: 'paste', sourceText },
  })
}

async function waitForCodePoolOrder(orderId: string, itemId: string, expectedFulfilled: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [order, item, attempts] = await Promise.all([
      db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirst(),
      db.selectFrom('order_items').select(['fulfilled_quantity', 'fulfillment_status'])
        .where('id', '=', itemId).executeTakeFirst(),
      db.selectFrom('order_item_fulfillment_attempts').select(['status', 'failure_code'])
        .where('order_item_id', '=', itemId).where('delivery_source', '=', 'code_pool')
        .orderBy('created_at', 'desc').orderBy('id', 'desc').execute(),
    ])
    if (item?.fulfilled_quantity === expectedFulfilled && (expectedFulfilled === 0
      ? attempts.some(attempt => attempt.status === 'failed')
      : order?.status === 'completed' && item.fulfillment_status === 'completed')) {
      return { order, item, attempts }
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for code-pool order ${orderId} to fulfill ${expectedFulfilled} units`)
}

async function waitForFixedDeliveryOrder(
  orderId: string, itemId: string, expectedFulfilled: number, timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [order, item, attempts] = await Promise.all([
      db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirst(),
      db.selectFrom('order_items').select(['fulfilled_quantity', 'fulfillment_status'])
        .where('id', '=', itemId).executeTakeFirst(),
      db.selectFrom('order_item_fulfillment_attempts').select(['status', 'failure_code'])
        .where('order_item_id', '=', itemId).where('delivery_source', 'in', ['fixed_content', 'link'])
        .orderBy('created_at', 'desc').orderBy('id', 'desc').execute(),
    ])
    if (item?.fulfilled_quantity === expectedFulfilled && (expectedFulfilled === 0
      ? attempts.some(attempt => attempt.status === 'failed')
      : order?.status === 'completed' && item.fulfillment_status === 'completed')) {
      return { order, item, attempts }
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for fixed digital delivery ${orderId} to fulfill ${expectedFulfilled} units`)
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

async function waitForQueryBlockedBy(queryFragment: string, blockerPid: number): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const activity = await sql<{ pid: number; blocker_pids: number[] }>`
      SELECT pid, pg_blocking_pids(pid) AS blocker_pids
      FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'aikayun-api'
        AND state = 'active' AND wait_event_type = 'Lock' AND query ILIKE ${`%${queryFragment}%`}
    `.execute(db)
    const waiting = activity.rows.find(row => row.blocker_pids.includes(blockerPid))
    if (waiting) return waiting.pid
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`PostgreSQL query containing ${queryFragment} did not block on PID ${blockerPid}`)
}

async function holdSkuLock(skuId: string) {
  let release!: () => void
  let signalLocked!: (pid: number) => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const locked = new Promise<number>(resolve => { signalLocked = resolve })
  const transaction = db.transaction().execute(async trx => {
    const pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid
    await sql`SELECT id FROM product_variants WHERE id = ${skuId}::uuid FOR UPDATE`.execute(trx)
    signalLocked(pid)
    await gate
  })
  return { pid: await locked, release, transaction }
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
  appConfig = readConfig({
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: testOrigin,
    COOKIE_SECURE: 'false',
    CODE_POOL_ENCRYPTION_KEY_RING: JSON.stringify({
      activeKeyId: 'test-v1',
      keys: { 'test-v1': Buffer.alloc(32, 0x51).toString('base64') },
    }),
  })
  initialCodePoolKeyRing = appConfig.codePoolEncryptionKeyRing
  app = await createApp({ db, config: appConfig, logger: false })
  await app.ready()
})

afterEach(() => {
  if (appConfig) appConfig.codePoolEncryptionKeyRing = initialCodePoolKeyRing
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

  it('⑥-3C separates cost-only edits from price changes for mixed free and paid orders', async () => {
    const admin = await createAdmin()
    const firstCustomer = await createCustomer()
    const secondCustomer = await createCustomer()
    const paid = await createCatalog({ price: '5.00', mode: 'quantity', stock: 8 })
    const free = await createCatalog({ price: '0.00', mode: 'quantity', stock: 4 })
    await enableManual(paid, admin)
    await enableManual(free, admin)
    await setSkuPurchaseLimits(paid.skuId, { lifetime: 2 })
    const items = [{ skuId: paid.skuId, quantity: 2 }, { skuId: free.skuId, quantity: 1 }]

    const prices = async () => {
      const response = await inject({ method: 'GET', url: `/api/v1/admin/products/${paid.productId}/prices?page=1&pageSize=50`,
        headers: { cookie: admin.cookie } })
      expect(response.statusCode, response.body).toBe(200)
      return response.json().data as { productRevision: number; items: Array<{ skuId: string; skuRevision: number }> }
    }
    const quoteBeforeCost = await quote(items, firstCustomer)
    expect(quoteBeforeCost.statusCode).toBe(200)
    expect(quoteBeforeCost.json().data).toMatchObject({ canContinue: true, totalAmount: '10.00' })
    expect(quoteBeforeCost.json().data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ skuId: paid.skuId, unitPrice: '5.00', lineTotal: '10.00' }),
      expect.objectContaining({ skuId: free.skuId, unitPrice: '0.00', lineTotal: '0.00' }),
    ]))
    let page = await prices()
    let row = page.items.find(item => item.skuId === paid.skuId)!
    const costPreview = await inject({ method: 'POST', url: `/api/v1/admin/products/${paid.productId}/cost-preview`,
      headers: adminHeaders(admin), payload: { expectedRevision: page.productRevision,
        updates: [{ skuId: paid.skuId, expectedSkuRevision: row.skuRevision, costPrice: '2.34567' }] } })
    expect(costPreview.statusCode, costPreview.body).toBe(200)
    const cost = costPreview.json().data.items[0] as { skuRevision: number; inputDigest: string; newCostPrice: string }
    const confirmed = await inject({ method: 'PATCH', url: `/api/v1/admin/products/${paid.productId}/prices/batch`,
      headers: adminHeaders(admin), payload: { expectedRevision: page.productRevision,
        updates: [{ skuId: paid.skuId, expectedSkuRevision: cost.skuRevision,
          costPrice: cost.newCostPrice, costPreviewDigest: cost.inputDigest }] } })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    const quoteAfterCost = await quote(items, firstCustomer)
    expect(quoteAfterCost.json().data.quoteToken).toBe(quoteBeforeCost.json().data.quoteToken)
    expect(JSON.stringify(quoteAfterCost.json().data)).not.toMatch(/costPrice|fixedProfit|markupRate|2\.34567/u)
    const publicProduct = await inject({ method: 'GET', url: `/api/v1/public/products/${paid.productId}` })
    expect(publicProduct.statusCode).toBe(200)
    expect(publicProduct.body).not.toMatch(/costPrice|fixedProfit|markupRate|2\.34567/u)

    const firstKey = randomUUID()
    const first = await createOrder(items, quoteBeforeCost.json().data.quoteToken, firstCustomer, firstKey)
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json().data.order).toMatchObject({ totalAmount: '10.00', status: 'pending_payment', paymentStatus: 'unpaid' })
    const firstId = first.json().data.order.id as string

    const beforeIncrease = await quote(items, secondCustomer)
    page = await prices()
    row = page.items.find(item => item.skuId === paid.skuId)!
    const increase = await inject({ method: 'PATCH', url: `/api/v1/admin/products/${paid.productId}/variants/${paid.skuId}/prices`,
      headers: adminHeaders(admin), payload: { expectedRevision: page.productRevision,
        expectedSkuRevision: row.skuRevision, salePrice: '8.00' } })
    expect(increase.statusCode, increase.body).toBe(200)
    const rejectedIncrease = await createOrder(items, beforeIncrease.json().data.quoteToken, secondCustomer)
    expect(rejectedIncrease.statusCode).toBe(409)
    expect(rejectedIncrease.json().error).toMatchObject({ code: 'CHECKOUT_QUOTE_CHANGED', currentQuote: { totalAmount: '16.00' } })
    const beforeDecrease = await quote(items, secondCustomer)
    page = await prices()
    row = page.items.find(item => item.skuId === paid.skuId)!
    const decrease = await inject({ method: 'PATCH', url: `/api/v1/admin/products/${paid.productId}/variants/${paid.skuId}/prices`,
      headers: adminHeaders(admin), payload: { expectedRevision: page.productRevision,
        expectedSkuRevision: row.skuRevision, salePrice: '3.00' } })
    expect(decrease.statusCode, decrease.body).toBe(200)
    const rejectedDecrease = await createOrder(items, beforeDecrease.json().data.quoteToken, secondCustomer)
    expect(rejectedDecrease.statusCode).toBe(409)
    expect(rejectedDecrease.json().error).toMatchObject({ code: 'CHECKOUT_QUOTE_CHANGED', currentQuote: { totalAmount: '6.00' } })

    const current = await quote(items, secondCustomer)
    const second = await createOrder(items, current.json().data.quoteToken, secondCustomer)
    expect(second.statusCode, second.body).toBe(201)
    expect(second.json().data.order.totalAmount).toBe('6.00')
    const replay = await createOrder(items, '0'.repeat(64), firstCustomer, firstKey)
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data).toMatchObject({ created: false, order: { id: firstId, totalAmount: '10.00' } })
    const snapshots = await db.selectFrom('order_items').select(['product_variant_id', 'unit_price', 'line_amount'])
      .where('order_id', '=', firstId).execute()
    expect(snapshots).toEqual(expect.arrayContaining([
      { product_variant_id: paid.skuId, unit_price: '5.00', line_amount: '10.00' },
      { product_variant_id: free.skuId, unit_price: '0.00', line_amount: '0.00' },
    ]))
    const reservations = await db.selectFrom('order_inventory_reservations').select(['product_variant_id', 'quantity'])
      .where('order_item_id', 'in', (await db.selectFrom('order_items').select('id').where('order_id', '=', firstId).execute()).map(item => item.id)).execute()
    expect(reservations).toHaveLength(2)
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', paid.skuId).executeTakeFirstOrThrow()).reserved).toBe(4)
    const limitQuote = await quote([{ skuId: paid.skuId, quantity: 1 }], firstCustomer)
    expect(limitQuote.json().data.items[0].purchaseLimits.sku).toMatchObject({ lifetimePurchased: 2, exceeded: true })
    expect(await db.selectFrom('wallet_ledger_entries').select('id').where('customer_id', '=', firstCustomer.id).execute()).toHaveLength(0)

    const creditOperationId = randomUUID()
    await db.transaction().execute(async trx => {
      await trx.insertInto('wallet_operations').values({ id: creditOperationId, customer_id: firstCustomer.id,
        order_id: null, resolves_operation_id: null, operation_type: 'gift', request_sha256: digest,
        actor_admin_id: admin.id }).execute()
      await trx.insertInto('wallet_ledger_entries').values({ id: randomUUID(), wallet_operation_id: creditOperationId,
        line_no: 1, customer_id: firstCustomer.id, bucket: 'gift', action: 'credit_available', amount: '10.00',
        payment_attempt_id: null, refund_allocation_id: null, withdrawal_id: null }).execute()
    })
    const paymentKey = randomUUID()
    const pay = () => inject({ method: 'POST', url: `/api/v1/orders/${firstId}/payments`,
      headers: customerHeaders(firstCustomer), payload: { idempotencyKey: paymentKey, walletAmount: '10.00' } })
    const payment = await pay()
    expect(payment.statusCode, payment.body).toBe(201)
    expect(payment.json().data).toMatchObject({ totalAmount: '10.00', attempt: { source: 'wallet', amount: '10.00', status: 'succeeded' } })
    const attemptId = payment.json().data.attempt.id as string
    const paymentReplay = await pay()
    expect(paymentReplay.statusCode, paymentReplay.body).toBe(200)
    expect(paymentReplay.json().data.attempt.id).toBe(attemptId)
    expect(await db.selectFrom('payment_receipts').select('amount').where('payment_attempt_id', '=', attemptId).execute())
      .toEqual([{ amount: '10.00' }])
    expect(await db.selectFrom('wallet_ledger_entries').select(['bucket', 'action', 'amount'])
      .where('payment_attempt_id', '=', attemptId).execute()).toEqual([{ bucket: 'gift', action: 'debit_available', amount: '10.00' }])
    expect((await db.selectFrom('orders').select(['total_amount', 'status']).where('id', '=', firstId).executeTakeFirstOrThrow()))
      .toEqual({ total_amount: '10.00', status: 'processing' })
  })

  it('⑥-3C serializes cost confirmation, rule edits and SKU state with observed PostgreSQL blockers', async () => {
    const adminA = await createAdmin()
    const adminB = await createAdmin()
    const catalog = await createCatalog({ price: '5.00', mode: 'unlimited' })
    const priceResponse = await inject({ method: 'GET', url: `/api/v1/admin/products/${catalog.productId}/prices`,
      headers: { cookie: adminA.cookie } })
    const pricePage = priceResponse.json().data as { productRevision: number; items: Array<{ skuId: string; skuRevision: number }> }
    const priceRow = pricePage.items.find(item => item.skuId === catalog.skuId)!
    const costPreview = await inject({ method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/cost-preview`,
      headers: adminHeaders(adminA), payload: { expectedRevision: pricePage.productRevision,
        updates: [{ skuId: catalog.skuId, expectedSkuRevision: priceRow.skuRevision, costPrice: '2.00000' }] } })
    expect(costPreview.statusCode, costPreview.body).toBe(200)
    const cost = costPreview.json().data.items[0] as { skuRevision: number; inputDigest: string; newCostPrice: string }
    const costPayload = { expectedRevision: pricePage.productRevision,
      updates: [{ skuId: catalog.skuId, expectedSkuRevision: cost.skuRevision,
        costPrice: cost.newCostPrice, costPreviewDigest: cost.inputDigest }] }
    const rulePayload = { expectedRevision: pricePage.productRevision, updates: [{
      skuId: catalog.skuId, expectedSkuRevision: priceRow.skuRevision, expectedRuleRevision: 0,
      mode: 'fixed_profit', fixedProfit: '1.00000',
    }] }

    const firstGate = await holdSkuLock(catalog.skuId)
    const confirmation = inject({ method: 'PATCH', url: `/api/v1/admin/products/${catalog.productId}/prices/batch`,
      headers: adminHeaders(adminA), payload: costPayload })
    let saveRule!: ReturnType<typeof inject>
    try {
      const confirmationPid = await waitForQueryBlockedBy('product_variants', firstGate.pid)
      saveRule = inject({ method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules/batch`,
        headers: adminHeaders(adminB), payload: rulePayload })
      await waitForQueryBlockedBy('products', confirmationPid)
    } finally {
      firstGate.release()
    }
    await firstGate.transaction
    const confirmed = await confirmation
    const rejectedRule = await saveRule
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    expect(rejectedRule.statusCode, rejectedRule.body).toBe(409)
    expect(rejectedRule.json().error.code).toBe('PRODUCT_REVISION_CONFLICT')
    expect(await db.selectFrom('product_variant_pricing_rule_versions').select('id')
      .where('product_variant_id', '=', catalog.skuId).execute()).toHaveLength(0)
    // A lost successful response followed by the identical request must not
    // create another cost audit or silently confirm a different revision.
    const retry = await inject({ method: 'PATCH', url: `/api/v1/admin/products/${catalog.productId}/prices/batch`,
      headers: adminHeaders(adminA), payload: costPayload })
    expect(retry.statusCode).toBe(409)
    expect(await db.selectFrom('product_management_audit_events').select('id').where('product_id', '=', catalog.productId)
      .where('operation', '=', 'price_updated').execute()).toHaveLength(1)

    const rules = await inject({ method: 'GET', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules`,
      headers: { cookie: adminB.cookie } })
    const rulePage = rules.json().data as { productRevision: number; items: Array<{ skuId: string; skuRevision: number; ruleRevision: number }> }
    const current = rulePage.items.find(item => item.skuId === catalog.skuId)!
    const saved = await inject({ method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules/batch`,
      headers: adminHeaders(adminB), payload: { expectedRevision: rulePage.productRevision, updates: [{
        skuId: catalog.skuId, expectedSkuRevision: current.skuRevision, expectedRuleRevision: current.ruleRevision,
        mode: 'fixed_profit', fixedProfit: '1.00000',
      }] } })
    expect(saved.statusCode, saved.body).toBe(200)
    const previewResponse = await inject({ method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules/preview`,
      headers: adminHeaders(adminA), payload: { skuIds: [catalog.skuId] } })
    expect(previewResponse.statusCode, previewResponse.body).toBe(200)
    const preview = previewResponse.json().data as { productRevision: number; items: Array<{
      skuId: string; skuRevision: number; ruleRevision: number; inputDigest: string; suggestedSalePrice: string;
    }> }
    expect(preview.items[0]!.suggestedSalePrice).toBe('3.00')
    const applyPayload = { expectedRevision: preview.productRevision, confirmLossAndFreePrice: false,
      items: preview.items.map(item => ({ skuId: item.skuId, expectedSkuRevision: item.skuRevision,
        expectedRuleRevision: item.ruleRevision, inputDigest: item.inputDigest })) }
    const secondGate = await holdSkuLock(catalog.skuId)
    const applying = inject({ method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules/apply`,
      headers: adminHeaders(adminA), payload: applyPayload })
    let disabling!: ReturnType<typeof inject>
    try {
      const applyPid = await waitForQueryBlockedBy('product_variants', secondGate.pid)
      disabling = inject({ method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/variant-matrix`,
        headers: adminHeaders(adminB), payload: { expectedRevision: preview.productRevision, mode: 'selected', groups: [],
          combinations: [{ skuId: catalog.skuId, optionValueIds: [], enabled: false }] } })
      await waitForQueryBlockedBy('products', applyPid)
    } finally {
      secondGate.release()
    }
    await secondGate.transaction
    const applied = await applying
    const rejectedDisable = await disabling
    expect(applied.statusCode, applied.body).toBe(200)
    expect(rejectedDisable.statusCode, rejectedDisable.body).toBe(409)
    expect(rejectedDisable.json().error.code).toBe('PRODUCT_REVISION_CONFLICT')
    expect(await db.selectFrom('product_variants').select(['sale_price', 'cost_price', 'pricing_rule_status', 'enabled'])
      .where('id', '=', catalog.skuId).executeTakeFirstOrThrow()).toEqual({
      sale_price: '3.00000', cost_price: '2.00000', pricing_rule_status: 'applied', enabled: true,
    })
    const latest = await db.selectFrom('products').select('revision').where('id', '=', catalog.productId).executeTakeFirstOrThrow()
    const disabled = await inject({ method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/variant-matrix`,
      headers: adminHeaders(adminB), payload: { expectedRevision: latest.revision, mode: 'selected', groups: [],
        combinations: [{ skuId: catalog.skuId, optionValueIds: [], enabled: false }] } })
    expect(disabled.statusCode, disabled.body).toBe(200)
    const staleApply = await inject({ method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules/apply`,
      headers: adminHeaders(adminA), payload: applyPayload })
    expect(staleApply.statusCode).toBe(409)
    expect((await db.selectFrom('product_variants').select('enabled').where('id', '=', catalog.skuId).executeTakeFirstOrThrow()).enabled).toBe(false)
  })

  it('⑥-3C settles the catalog lock race between checkout and confirmed repricing in both orders', async () => {
    const admin = await createAdmin()
    const firstCustomer = await createCustomer()
    const secondCustomer = await createCustomer()
    const catalog = await createCatalog({ price: '4.00', mode: 'quantity', stock: 5 })
    await enableManual(catalog, admin)
    await setSkuPurchaseLimits(catalog.skuId, { lifetime: 1 })
    const priceResponse = await inject({ method: 'GET', url: `/api/v1/admin/products/${catalog.productId}/prices`,
      headers: { cookie: admin.cookie } })
    const pricePage = priceResponse.json().data as { productRevision: number; items: Array<{ skuId: string; skuRevision: number }> }
    const priceRow = pricePage.items.find(item => item.skuId === catalog.skuId)!
    const costPreview = await inject({ method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/cost-preview`,
      headers: adminHeaders(admin), payload: { expectedRevision: pricePage.productRevision,
        updates: [{ skuId: catalog.skuId, expectedSkuRevision: priceRow.skuRevision, costPrice: '1.00000' }] } })
    expect(costPreview.statusCode, costPreview.body).toBe(200)
    const cost = costPreview.json().data.items[0] as { skuRevision: number; inputDigest: string; newCostPrice: string }
    const confirmed = await inject({ method: 'PATCH', url: `/api/v1/admin/products/${catalog.productId}/prices/batch`,
      headers: adminHeaders(admin), payload: { expectedRevision: pricePage.productRevision, updates: [{
        skuId: catalog.skuId, expectedSkuRevision: cost.skuRevision,
        costPrice: cost.newCostPrice, costPreviewDigest: cost.inputDigest,
      }] } })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    const configureAndPreview = async (fixedProfit: string) => {
      const response = await inject({ method: 'GET', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules`,
        headers: { cookie: admin.cookie } })
      const page = response.json().data as { productRevision: number; items: Array<{ skuId: string; skuRevision: number; ruleRevision: number }> }
      const row = page.items.find(item => item.skuId === catalog.skuId)!
      const saved = await inject({ method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules/batch`,
        headers: adminHeaders(admin), payload: { expectedRevision: page.productRevision, updates: [{
          skuId: catalog.skuId, expectedSkuRevision: row.skuRevision, expectedRuleRevision: row.ruleRevision,
          mode: 'fixed_profit', fixedProfit,
        }] } })
      expect(saved.statusCode, saved.body).toBe(200)
      const previewResponse = await inject({ method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules/preview`,
        headers: adminHeaders(admin), payload: { skuIds: [catalog.skuId] } })
      expect(previewResponse.statusCode, previewResponse.body).toBe(200)
      const preview = previewResponse.json().data as { productRevision: number; items: Array<{
        skuId: string; skuRevision: number; ruleRevision: number; inputDigest: string;
      }> }
      return { expectedRevision: preview.productRevision, confirmLossAndFreePrice: false,
        items: preview.items.map(item => ({ skuId: item.skuId, expectedSkuRevision: item.skuRevision,
          expectedRuleRevision: item.ruleRevision, inputDigest: item.inputDigest })) }
    }
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const firstApplyPayload = await configureAndPreview('1.00000')
    const oldQuote = await quote(items, firstCustomer)
    const firstGate = await holdSkuLock(catalog.skuId)
    const applyingFirst = inject({ method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules/apply`,
      headers: adminHeaders(admin), payload: firstApplyPayload })
    let staleCheckout!: ReturnType<typeof createOrder>
    try {
      const applyPid = await waitForQueryBlockedBy('product_variants', firstGate.pid)
      staleCheckout = createOrder(items, oldQuote.json().data.quoteToken, firstCustomer)
      await waitForQueryBlockedBy('products', applyPid)
    } finally {
      firstGate.release()
    }
    await firstGate.transaction
    expect((await applyingFirst).statusCode).toBe(200)
    const rejected = await staleCheckout
    expect(rejected.statusCode, rejected.body).toBe(409)
    expect(rejected.json().error).toMatchObject({ code: 'CHECKOUT_QUOTE_CHANGED', currentQuote: { totalAmount: '2.00' } })
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(0)

    const firstQuote = await quote(items, firstCustomer)
    const firstOrder = await createOrder(items, firstQuote.json().data.quoteToken, firstCustomer)
    expect(firstOrder.statusCode, firstOrder.body).toBe(201)
    const secondApplyPayload = await configureAndPreview('2.00000')
    const secondQuote = await quote(items, secondCustomer)
    expect(secondQuote.json().data.totalAmount).toBe('2.00')
    const secondKey = randomUUID()
    const secondGate = await holdSkuLock(catalog.skuId)
    const ordering = createOrder(items, secondQuote.json().data.quoteToken, secondCustomer, secondKey)
    let applyingSecond!: ReturnType<typeof inject>
    try {
      const orderPid = await waitForQueryBlockedBy('product_variants', secondGate.pid)
      applyingSecond = inject({ method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules/apply`,
        headers: adminHeaders(admin), payload: secondApplyPayload })
      await waitForQueryBlockedBy('products', orderPid)
    } finally {
      secondGate.release()
    }
    await secondGate.transaction
    const ordered = await ordering
    const appliedAfterOrder = await applyingSecond
    expect(ordered.statusCode, ordered.body).toBe(201)
    expect(ordered.json().data.order.totalAmount).toBe('2.00')
    expect(appliedAfterOrder.statusCode, appliedAfterOrder.body).toBe(200)
    expect((await db.selectFrom('product_variants').select('sale_price').where('id', '=', catalog.skuId).executeTakeFirstOrThrow()).sale_price).toBe('3.00000')
    const replay = await createOrder(items, '0'.repeat(64), secondCustomer, secondKey)
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data).toMatchObject({ created: false, order: { id: ordered.json().data.order.id, totalAmount: '2.00' } })
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).reserved).toBe(2)
    expect(await db.selectFrom('order_inventory_reservations').select('id')
      .where('product_variant_id', '=', catalog.skuId).execute()).toHaveLength(2)
    const quota = await quote(items, secondCustomer)
    expect(quota.json().data.items[0].purchaseLimits.sku).toMatchObject({ lifetimePurchased: 1, exceeded: true })
  })

  it('invalidates old checkout quotes after a confirmed pricing rule and preserves replayed order amounts', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'unlimited' })
    await enableManual(catalog, admin)

    const initialPrices = await inject({
      method: 'GET', url: `/api/v1/admin/products/${catalog.productId}/prices?page=1&pageSize=50`,
      headers: { cookie: admin.cookie },
    })
    expect(initialPrices.statusCode).toBe(200)
    const initialPricePage = initialPrices.json().data as {
      productRevision: number; items: Array<{ skuId: string; skuRevision: number }>;
    }
    const initialPrice = initialPricePage.items.find(item => item.skuId === catalog.skuId)!
    const costPreview = await inject({
      method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/cost-preview`, headers: adminHeaders(admin),
      payload: { expectedRevision: initialPricePage.productRevision, updates: [{
        skuId: catalog.skuId, expectedSkuRevision: initialPrice.skuRevision, costPrice: '1.00000',
      }] },
    })
    expect(costPreview.statusCode, costPreview.body).toBe(200)
    const previewItem = (costPreview.json().data as { items: Array<{ skuId: string; skuRevision: number; inputDigest: string; newCostPrice: string | null }> }).items[0]!
    const savedCost = await inject({
      method: 'PATCH', url: `/api/v1/admin/products/${catalog.productId}/prices/batch`, headers: adminHeaders(admin),
      payload: { expectedRevision: initialPricePage.productRevision, updates: [{
        skuId: previewItem.skuId, expectedSkuRevision: previewItem.skuRevision,
        costPrice: previewItem.newCostPrice, costPreviewDigest: previewItem.inputDigest,
      }] },
    })
    expect(savedCost.statusCode, savedCost.body).toBe(200)

    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const oldQuote = await quote(items, customer)
    expect(oldQuote.json().data.items[0].unitPrice).toBe('1.20')
    const oldKey = randomUUID()
    const originalOrder = await createOrder(items, oldQuote.json().data.quoteToken, customer, oldKey)
    expect(originalOrder.statusCode).toBe(201)
    const originalOrderId = originalOrder.json().data.order.id as string

    const currentRules = await inject({
      method: 'GET', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules?page=1&pageSize=50`,
      headers: { cookie: admin.cookie },
    })
    expect(currentRules.statusCode, currentRules.body).toBe(200)
    const rulePage = currentRules.json().data as {
      productRevision: number; items: Array<{ skuId: string; skuRevision: number; ruleRevision: number }>;
    }
    const ruleRow = rulePage.items.find(item => item.skuId === catalog.skuId)!
    const ruleSave = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules/batch`, headers: adminHeaders(admin),
      payload: { expectedRevision: rulePage.productRevision, updates: [{
        skuId: catalog.skuId, expectedSkuRevision: ruleRow.skuRevision,
        expectedRuleRevision: ruleRow.ruleRevision, mode: 'fixed_profit', fixedProfit: '1.00000',
      }] },
    })
    expect(ruleSave.statusCode, ruleSave.body).toBe(200)
    const previewResponse = await inject({
      method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules/preview`, headers: adminHeaders(admin),
      payload: { skuIds: [catalog.skuId] },
    })
    expect(previewResponse.statusCode, previewResponse.body).toBe(200)
    const preview = previewResponse.json().data as {
      productRevision: number; items: Array<{
        skuId: string; skuRevision: number; ruleRevision: number; inputDigest: string; suggestedSalePrice: string;
      }>;
    }
    expect(preview.items[0]?.suggestedSalePrice).toBe('2.00')
    const applyResponse = await inject({
      method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/pricing-rules/apply`, headers: adminHeaders(admin),
      payload: { expectedRevision: preview.productRevision, confirmLossAndFreePrice: false,
        items: preview.items.map(item => ({ skuId: item.skuId, expectedSkuRevision: item.skuRevision,
          expectedRuleRevision: item.ruleRevision, inputDigest: item.inputDigest })) },
    })
    expect(applyResponse.statusCode, applyResponse.body).toBe(200)

    const staleKey = randomUUID()
    const staleCheckout = await createOrder(items, oldQuote.json().data.quoteToken, customer, staleKey)
    expect(staleCheckout.statusCode).toBe(409)
    expect(staleCheckout.json().error).toMatchObject({
      code: 'CHECKOUT_QUOTE_CHANGED', currentQuote: { items: [{ unitPrice: '2.00' }] },
    })
    expect(await db.selectFrom('orders').select('id').where('idempotency_key', '=', staleKey).execute()).toHaveLength(0)

    const replay = await createOrder(items, '0'.repeat(64), customer, oldKey)
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data).toMatchObject({ created: false, order: { id: originalOrderId, totalAmount: '1.20' } })
    expect((await db.selectFrom('orders').select('total_amount').where('id', '=', originalOrderId).executeTakeFirstOrThrow()).total_amount).toBe('1.20')
    expect((await db.selectFrom('order_items').select('unit_price').where('order_id', '=', originalOrderId).executeTakeFirstOrThrow()).unit_price).toBe('1.20')

    const currentPrices = await inject({ method: 'GET', url: `/api/v1/admin/products/${catalog.productId}/prices?page=1&pageSize=50`, headers: { cookie: admin.cookie } })
    const currentPricePage = currentPrices.json().data as { productRevision: number; items: Array<{ skuId: string; skuRevision: number }> }
    const currentSku = currentPricePage.items.find(item => item.skuId === catalog.skuId)!
    const postOrderCostPreview = await inject({ method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/cost-preview`, headers: adminHeaders(admin),
      payload: { expectedRevision: currentPricePage.productRevision, updates: [{ skuId: catalog.skuId,
        expectedSkuRevision: currentSku.skuRevision, costPrice: '1.50000' }] } })
    expect(postOrderCostPreview.statusCode, postOrderCostPreview.body).toBe(200)
    const postOrderPreviewItem = (postOrderCostPreview.json().data as { items: Array<{ skuId: string; skuRevision: number; inputDigest: string; newCostPrice: string }> }).items[0]!
    const postOrderCostSaved = await inject({ method: 'PATCH', url: `/api/v1/admin/products/${catalog.productId}/prices/batch`, headers: adminHeaders(admin),
      payload: { expectedRevision: currentPricePage.productRevision, updates: [{ skuId: postOrderPreviewItem.skuId,
        expectedSkuRevision: postOrderPreviewItem.skuRevision, costPrice: postOrderPreviewItem.newCostPrice,
        costPreviewDigest: postOrderPreviewItem.inputDigest }] } })
    expect(postOrderCostSaved.statusCode, postOrderCostSaved.body).toBe(200)
    const replayAfterCostChange = await createOrder(items, '0'.repeat(64), customer, oldKey)
    expect(replayAfterCostChange.statusCode).toBe(200)
    expect(replayAfterCostChange.json().data).toMatchObject({ created: false, order: { id: originalOrderId, totalAmount: '1.20' } })
    const originalOrderItem = await db.selectFrom('order_items').select(['unit_price', 'line_amount'])
      .where('order_id', '=', originalOrderId).executeTakeFirstOrThrow()
    expect(originalOrderItem).toEqual({ unit_price: '1.20', line_amount: '1.20' })

    const renewedQuote = await quote(items, customer)
    expect(renewedQuote.json().data.items[0].unitPrice).toBe('2.00')
    const renewedOrder = await createOrder(items, renewedQuote.json().data.quoteToken, customer)
    expect(renewedOrder.statusCode).toBe(201)
    expect(renewedOrder.json().data.order.totalAmount).toBe('2.00')
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

describe('per-SKU encrypted code-pool fulfillment on PostgreSQL', () => {
  it('prechecks without returning card text, filters duplicates, preserves exact content, and copies no stock', async () => {
    const admin = await createAdmin()
    const catalog = await createCatalog({ price: '0.00', mode: 'quantity', stock: 0 })
    const configured = await setCodePoolReadiness(catalog, admin, false)
    expect(configured.statusCode).toBe(200)
    expect(configured.json().data).toMatchObject({ configured: true, enabled: false, inventoryConsistent: true })

    const original = '  ab  Cd 123  '
    const sourceText = `${original}\n${original}\n${'x'.repeat(513)}\n\0bad`
    const preview = await inject({
      method: 'POST',
      url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/code-pool/precheck`,
      headers: adminHeaders(admin),
      payload: { format: 'paste', sourceText },
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.headers['cache-control']).toContain('no-store')
    expect(preview.json().data).toMatchObject({
      rowCount: 4, acceptedCount: 1, duplicateCount: 1, invalidCount: 2,
      rows: [
        { status: 'accepted' },
        { status: 'duplicate', reason: 'duplicate_in_request' },
        { status: 'invalid', reason: 'too_long' },
        { status: 'invalid', reason: 'invalid_text' },
      ],
    })
    expect(JSON.stringify(preview.json())).not.toContain(original)

    const firstImport = await importCodePool(catalog, admin, sourceText)
    expect(firstImport.statusCode).toBe(201)
    expect(firstImport.json().data.batch).toMatchObject({ acceptedCount: 1, duplicateCount: 1, invalidCount: 2 })
    expect(firstImport.json().data.status).toMatchObject({
      enabled: false, counts: { available: 1, reserved: 0, delivered: 0 },
      inventory: { stocked: 1, reserved: 0, available: 1 },
    })
    const stored = await db.selectFrom('code_pool_entries')
      .select(['id', 'ciphertext', 'nonce', 'auth_tag', 'encryption_key_id'])
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()
    expect(Buffer.from(stored.ciphertext).includes(Buffer.from(original))).toBe(false)
    expect(decryptCodePoolContent(appConfig, `aikayun:code-pool:entry:v1:${catalog.skuId}:${stored.id}`, {
      keyId: stored.encryption_key_id,
      nonce: stored.nonce,
      ciphertext: stored.ciphertext,
      authTag: stored.auth_tag,
    })).toBe(original)

    const secondBatch = await importCodePool(catalog, admin, `${original}\nSECOND-BATCH`)
    expect(secondBatch.statusCode).toBe(201)
    expect(secondBatch.json().data.batch).toMatchObject({ acceptedCount: 1, duplicateCount: 1 })
    const concurrentImports = await Promise.all([
      importCodePool(catalog, admin, 'RACE-IMPORT-CODE'),
      importCodePool(catalog, admin, 'RACE-IMPORT-CODE'),
    ])
    expect(concurrentImports.map(response => response.statusCode)).toEqual([201, 201])
    expect(concurrentImports.reduce((sum, response) => sum + response.json().data.batch.acceptedCount, 0)).toBe(1)
    expect(concurrentImports.reduce((sum, response) => sum + response.json().data.batch.duplicateCount, 0)).toBe(1)
    expect((await inject({
      method: 'GET',
      url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/code-pool/entries?status=available`,
      headers: { cookie: admin.cookie },
    })).json()).not.toHaveProperty('data.items[0].content')
    const listed = await inject({
      method: 'GET',
      url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/code-pool/entries?status=available`,
      headers: { cookie: admin.cookie },
    })
    expect(JSON.stringify(listed.json())).not.toContain(original)
    expect(listed.json().data.items[0]).not.toHaveProperty('content')
    expect((await sql<{ consistent: boolean }>`
      SELECT assert_code_pool_inventory_consistency(${catalog.skuId}::uuid) AS consistent
    `.execute(db)).rows[0]?.consistent).toBe(true)

    const otherSku = await createCatalog({ price: '0.00', mode: 'quantity', stock: 0 })
    expect((await setCodePoolReadiness(otherSku, admin, false)).statusCode).toBe(200)
    const sameCodeOtherSku = await importCodePool(otherSku, admin, original)
    expect(sameCodeOtherSku.statusCode).toBe(201)
    expect(sameCodeOtherSku.json().data.batch.acceptedCount).toBe(1)

    const sourceRevision = await db.selectFrom('products').select('revision')
      .where('id', '=', catalog.productId).executeTakeFirstOrThrow()
    const copied = await inject({
      method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/copy`,
      headers: adminHeaders(admin), payload: { expectedRevision: sourceRevision.revision },
    })
    expect(copied.statusCode).toBe(201)
    const copiedSkuId = copied.json().data.variants[0].id as string
    expect(await db.selectFrom('product_variant_quantity_inventory').select('product_variant_id')
      .where('product_variant_id', '=', copiedSkuId).execute()).toHaveLength(0)
    expect(await db.selectFrom('code_pool_entries').select('id')
      .where('product_variant_id', '=', copiedSkuId).execute()).toHaveLength(0)
    expect(await db.selectFrom('product_variant_fulfillment').select('product_variant_id')
      .where('product_variant_id', '=', copiedSkuId).execute()).toHaveLength(0)

    const productRevision = await db.selectFrom('products').select('revision')
      .where('id', '=', catalog.productId).executeTakeFirstOrThrow()
    const archived = await inject({
      method: 'PATCH', url: `/api/v1/admin/products/${catalog.productId}/lifecycle`,
      headers: adminHeaders(admin), payload: { expectedRevision: productRevision.revision, status: 'archived' },
    })
    expect(archived.statusCode).toBe(200)
    expect((await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow())).toEqual({ stocked: 3, reserved: 0 })
    await expect(db.updateTable('product_variants').set({ inventory_mode: 'unlimited' })
      .where('id', '=', catalog.skuId).execute()).rejects.toMatchObject({ constraint: 'code_pool_inventory_mode_immutable' })
    await expect(db.updateTable('product_variant_fulfillment').set({ method: 'manual' })
      .where('product_variant_id', '=', catalog.skuId).execute()).rejects.toMatchObject({ constraint: 'code_pool_fulfillment_history_immutable' })
    await expect(db.deleteFrom('code_pool_entries').where('product_variant_id', '=', catalog.skuId).execute())
      .rejects.toMatchObject({ constraint: 'code_pool_entries_immutable' })
    await expect(db.deleteFrom('product_variant_quantity_inventory')
      .where('product_variant_id', '=', catalog.skuId).execute())
      .rejects.toMatchObject({ constraint: 'code_pool_stock_requires_inventory_event' })
    const archivedRevision = await db.selectFrom('products').select('revision')
      .where('id', '=', catalog.productId).executeTakeFirstOrThrow()
    const deleteArchived = await inject({
      method: 'DELETE', url: `/api/v1/admin/products/${catalog.productId}`,
      headers: adminHeaders(admin), payload: { expectedRevision: archivedRevision.revision },
    })
    expect(deleteArchived.statusCode).toBe(409)
    expect(deleteArchived.json().error.code).toBe('PRODUCT_HAS_CODE_POOL_HISTORY')
  })

  it('replays import and withdrawal batches after active-key rotation without repeating effects', async () => {
    const admin = await createAdmin()
    const catalog = await createCatalog({ price: '0.00', mode: 'quantity', stock: 0 })
    expect((await setCodePoolReadiness(catalog, admin, false)).statusCode).toBe(200)
    const originalRing = appConfig.codePoolEncryptionKeyRing!
    const keyA = originalRing.keys[originalRing.activeKeyId]!
    const keyB = Buffer.alloc(32, 0x62)
    const ring = (activeKeyId: string) => ({ activeKeyId, keys: { 'test-v1': keyA, 'test-v2': keyB } })
    const importOperationId = randomUUID()
    const importBody = 'ROTATION-IMPORT-CODE'
    const originalImport = await importCodePool(catalog, admin, importBody, importOperationId)
    expect(originalImport.statusCode).toBe(201)
    const importBatchId = originalImport.json().data.batch.id as string
    const originalImportBatch = await db.selectFrom('code_pool_batches').select(['request_sha256', 'request_fingerprint_key_id'])
      .where('id', '=', importBatchId).executeTakeFirstOrThrow()
    expect(originalImportBatch.request_fingerprint_key_id).toBe('test-v1')
    await expect(db.updateTable('code_pool_batches').set({ request_sha256: 'b'.repeat(64) })
      .where('id', '=', importBatchId).execute()).rejects.toMatchObject({ constraint: 'code_pool_batches_immutable' })
    await expect(db.updateTable('code_pool_batches').set({ request_fingerprint_key_id: 'test-v2' })
      .where('id', '=', importBatchId).execute()).rejects.toMatchObject({ constraint: 'code_pool_batches_immutable' })
    const importEventCount = await db.selectFrom('order_inventory_events').select(sql<number>`count(*)::integer`.as('count'))
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()
    const legacyOperationId = randomUUID()
    const legacyBatchId = randomUUID()
    const legacyRequest = JSON.stringify({ format: 'paste', sourceText: importBody })
    await db.insertInto('code_pool_batches').values({
      id: legacyBatchId,
      product_id: catalog.productId,
      product_variant_id: catalog.skuId,
      operation_id: legacyOperationId,
      kind: 'import',
      request_sha256: codePoolFingerprint(appConfig, legacyRequest),
      request_fingerprint_key_id: null,
      requested_count: 1,
      accepted_count: 0,
      duplicate_count: 1,
      invalid_count: 0,
      reason: null,
      created_by_admin_id: admin.id,
    }).execute()

    appConfig.codePoolEncryptionKeyRing = ring('test-v2')
    const repeatedImport = await importCodePool(catalog, admin, importBody, importOperationId)
    const repeatedLegacyImport = await importCodePool(catalog, admin, importBody, legacyOperationId)
    const changedImport = await importCodePool(catalog, admin, `${importBody}-CHANGED`, importOperationId)
    const duplicateAcrossKeys = await importCodePool(catalog, admin, importBody)
    expect(duplicateAcrossKeys.json().data.batch).toMatchObject({ acceptedCount: 0, duplicateCount: 1 })
    expect(await db.selectFrom('code_pool_batches').select(['request_sha256', 'request_fingerprint_key_id'])
      .where('id', '=', importBatchId).executeTakeFirstOrThrow()).toEqual(originalImportBatch)

    const withdrawalEntry = await db.selectFrom('code_pool_entries').select('id')
      .where('import_batch_id', '=', importBatchId).executeTakeFirstOrThrow()
    const withdrawalOperationId = randomUUID()
    const withdrawalBody = {
      operationId: withdrawalOperationId,
      entryIds: [withdrawalEntry.id],
      reason: '轮换后幂等回归',
      confirmation: 'REVOKE_UNSOLD_CODES',
    }
    const originalWithdrawal = await inject({
      method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/code-pool/withdrawals`,
      headers: adminHeaders(admin), payload: withdrawalBody,
    })
    expect(originalWithdrawal.statusCode).toBe(201)
    const withdrawalBatchId = originalWithdrawal.json().data.batch.id as string
    expect((await db.selectFrom('code_pool_batches').select('request_fingerprint_key_id')
      .where('id', '=', withdrawalBatchId).executeTakeFirstOrThrow()).request_fingerprint_key_id).toBe('test-v2')

    appConfig.codePoolEncryptionKeyRing = ring(originalRing.activeKeyId)
    const repeatedWithdrawal = await inject({
      method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/code-pool/withdrawals`,
      headers: adminHeaders(admin), payload: withdrawalBody,
    })
    const changedWithdrawal = await inject({
      method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/code-pool/withdrawals`,
      headers: adminHeaders(admin), payload: { ...withdrawalBody, reason: 'different request' },
    })

    expect({ import: repeatedImport.statusCode, withdrawal: repeatedWithdrawal.statusCode }).toEqual({ import: 200, withdrawal: 200 })
    expect(repeatedImport.json().data.batch.id).toBe(importBatchId)
    expect(repeatedLegacyImport.statusCode).toBe(200)
    expect(repeatedLegacyImport.json().data.batch.id).toBe(legacyBatchId)
    expect(repeatedWithdrawal.json().data.batch.id).toBe(withdrawalBatchId)
    expect(changedImport.statusCode).toBe(409)
    expect(changedImport.json().error.code).toBe('CODE_POOL_OPERATION_CONFLICT')
    expect(changedWithdrawal.statusCode).toBe(409)
    expect(changedWithdrawal.json().error.code).toBe('CODE_POOL_OPERATION_CONFLICT')
    appConfig.codePoolEncryptionKeyRing = { activeKeyId: 'test-v2', keys: { 'test-v2': keyB } }
    const missingImportKey = await importCodePool(catalog, admin, importBody, importOperationId)
    appConfig.codePoolEncryptionKeyRing = { activeKeyId: 'test-v1', keys: { 'test-v1': keyA } }
    const missingWithdrawalKey = await inject({
      method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/code-pool/withdrawals`,
      headers: adminHeaders(admin), payload: withdrawalBody,
    })
    expect(missingImportKey.statusCode).toBe(409)
    expect(missingImportKey.json().error.code).toBe('CODE_POOL_KEY_HISTORY_UNAVAILABLE')
    expect(missingWithdrawalKey.statusCode).toBe(409)
    expect(missingWithdrawalKey.json().error.code).toBe('CODE_POOL_KEY_HISTORY_UNAVAILABLE')

    appConfig.codePoolEncryptionKeyRing = ring('test-v1')
    const secondInstance = await createApp({
      db,
      config: { ...appConfig, codePoolEncryptionKeyRing: ring('test-v2') },
      logger: false,
    })
    await secondInstance.ready()
    const parallelOperationId = randomUUID()
    const [instanceA, instanceB] = await Promise.all([
      importCodePool(catalog, admin, 'MULTI-INSTANCE-ROTATION-CODE', parallelOperationId),
      importCodePoolInto(secondInstance, catalog, admin, 'MULTI-INSTANCE-ROTATION-CODE', parallelOperationId),
    ])
    expect([instanceA.statusCode, instanceB.statusCode].sort()).toEqual([200, 201])
    expect(instanceA.json().data.batch.id).toBe(instanceB.json().data.batch.id)
    const parallelBatchId = instanceA.json().data.batch.id as string
    expect(await db.selectFrom('code_pool_batches').select('id').where('operation_id', '=', parallelOperationId).execute()).toHaveLength(1)
    expect(await db.selectFrom('code_pool_entries').select('id').where('import_batch_id', '=', parallelBatchId).execute()).toHaveLength(1)
    expect((await db.selectFrom('order_inventory_events').select(sql<number>`count(*)::integer`.as('count'))
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).count).toBe(importEventCount.count + 2)
    expect((await sql<{ consistent: boolean }>`
      SELECT assert_code_pool_inventory_consistency(${catalog.skuId}::uuid) AS consistent
    `.execute(db)).rows[0]?.consistent).toBe(true)
    await secondInstance.close()
    expect(await db.selectFrom('code_pool_batches').select('id').where('operation_id', '=', importOperationId).execute()).toHaveLength(1)
    expect(await db.selectFrom('code_pool_batches').select('id').where('operation_id', '=', withdrawalOperationId).execute()).toHaveLength(1)
  })

  it('decrypts existing customer delivery history after rotating the active key', async () => {
    const originalRing = appConfig.codePoolEncryptionKeyRing!
    const keyA = originalRing.keys[originalRing.activeKeyId]!
    const keyB = Buffer.alloc(32, 0x63)
    try {
      const admin = await createAdmin()
      const catalog = await createCatalog({ price: '0.00', mode: 'quantity', stock: 0 })
      expect((await setCodePoolReadiness(catalog, admin, false)).statusCode).toBe(200)
      expect((await importCodePool(catalog, admin, 'PRE-ROTATION-DELIVERY')).statusCode).toBe(201)
      expect((await setCodePoolReadiness(catalog, admin, true)).statusCode).toBe(200)
      const customer = await createCustomer()
      const items = [{ skuId: catalog.skuId, quantity: 1 }]
      const currentQuote = await quote(items, customer)
      const created = await createOrder(items, currentQuote.json().data.quoteToken, customer)
      expect(created.statusCode).toBe(201)
      const orderId = created.json().data.order.id as string
      const itemId = created.json().data.order.items[0].id as string
      const stopWorker = startCodePoolDeliveryWorker(db, appConfig, app.log)
      await waitForCodePoolOrder(orderId, itemId, 1)
      await stopWorker()

      appConfig.codePoolEncryptionKeyRing = {
        activeKeyId: 'test-v2', keys: { 'test-v1': keyA, 'test-v2': keyB },
      }
      const detail = await inject({
        method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: customer.cookie },
      })
      expect(detail.statusCode).toBe(200)
      expect(detail.json().data.items[0].deliveries.map((delivery: { content: string }) => delivery.content))
        .toEqual(['PRE-ROTATION-DELIVERY'])
      expect((await sql<{ consistent: boolean }>`
        SELECT assert_code_pool_inventory_consistency(${catalog.skuId}::uuid) AS consistent
      `.execute(db)).rows[0]?.consistent).toBe(true)
    } finally {
      appConfig.codePoolEncryptionKeyRing = originalRing
    }
  })

  it('serializes last-code checkout against another order and safe withdrawal, and releases unpaid cancellation', async () => {
    const admin = await createAdmin()
    const catalog = await createCatalog({ price: '2.00', mode: 'quantity', stock: 0 })
    expect((await setCodePoolReadiness(catalog, admin, false)).statusCode).toBe(200)
    expect((await importCodePool(catalog, admin, 'LAST-CODE-001')).statusCode).toBe(201)
    expect((await setCodePoolReadiness(catalog, admin, true)).statusCode).toBe(200)
    const firstCustomer = await createCustomer()
    const secondCustomer = await createCustomer()
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const [firstQuote, secondQuote] = await Promise.all([quote(items, firstCustomer), quote(items, secondCustomer)])
    expect(firstQuote.json().data.canContinue).toBe(true)
    expect(secondQuote.json().data.canContinue).toBe(true)
    const racedOrders = await Promise.all([
      createOrder(items, firstQuote.json().data.quoteToken, firstCustomer),
      createOrder(items, secondQuote.json().data.quoteToken, secondCustomer),
    ])
    const winners = racedOrders.map((response, index) => ({ response, customer: index === 0 ? firstCustomer : secondCustomer }))
      .filter(item => item.response.statusCode === 201)
    expect(winners).toHaveLength(1)
    expect(racedOrders.filter(response => response.statusCode === 409)).toHaveLength(1)
    const winner = winners[0]!
    const orderId = winner.response.json().data.order.id as string
    const itemId = winner.response.json().data.order.items[0].id as string
    const pendingDetail = await inject({
      method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: winner.customer.cookie },
    })
    expect(pendingDetail.statusCode).toBe(200)
    expect(pendingDetail.json().data.items[0].deliveries).toEqual([])
    expect(JSON.stringify(pendingDetail.json())).not.toContain('LAST-CODE-001')
    const wrongOwner = winner.customer.id === firstCustomer.id ? secondCustomer : firstCustomer
    expect((await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: wrongOwner.cookie } })).statusCode)
      .toBe(404)
    const cancelled = await inject({
      method: 'POST', url: `/api/v1/customer/orders/${orderId}/cancel`, headers: customerHeaders(winner.customer),
    })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().data.status).toBe('closed')
    const afterRelease = await inject({
      method: 'GET', url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/code-pool`,
      headers: { cookie: admin.cookie },
    })
    expect(afterRelease.json().data).toMatchObject({
      counts: { available: 1, reserved: 0, delivered: 0 },
      inventory: { stocked: 1, reserved: 0, available: 1 },
    })

    const raceQuote = await quote(items, firstCustomer)
    const entryPage = await inject({
      method: 'GET',
      url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/code-pool/entries?status=available`,
      headers: { cookie: admin.cookie },
    })
    const entryId = entryPage.json().data.items[0].id as string
    const withdrawal = inject({
      method: 'POST',
      url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/code-pool/withdrawals`,
      headers: adminHeaders(admin),
      payload: {
        operationId: randomUUID(), entryIds: [entryId], reason: '并发撤回验证', confirmation: 'REVOKE_UNSOLD_CODES',
      },
    })
    const checkout = createOrder(items, raceQuote.json().data.quoteToken, firstCustomer)
    const [withdrawalResult, checkoutResult] = await Promise.all([withdrawal, checkout])
    expect([withdrawalResult.statusCode, checkoutResult.statusCode].filter(status => status === 201)).toHaveLength(1)
    const inventory = await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()
    const state = await db.selectFrom('code_pool_entries').select('state')
      .where('product_variant_id', '=', catalog.skuId).execute()
    if (withdrawalResult.statusCode === 201) {
      expect(checkoutResult.statusCode).toBe(409)
      expect(inventory).toEqual({ stocked: 0, reserved: 0 })
      expect(state.map(entry => entry.state)).toEqual(['revoked'])
    } else {
      expect(withdrawalResult.statusCode).toBe(409)
      expect(checkoutResult.statusCode).toBe(201)
      expect(inventory).toEqual({ stocked: 1, reserved: 1 })
      expect(state.map(entry => entry.state)).toEqual(['reserved'])
      const racedOrderId = checkoutResult.json().data.order.id as string
      expect((await inject({
        method: 'POST', url: `/api/v1/customer/orders/${racedOrderId}/cancel`, headers: customerHeaders(firstCustomer),
      })).statusCode).toBe(200)
    }
    expect((await sql<{ consistent: boolean }>`
      SELECT assert_code_pool_inventory_consistency(${catalog.skuId}::uuid) AS consistent
    `.execute(db)).rows[0]?.consistent).toBe(true)
    expect(await db.selectFrom('order_items').select('id').where('id', '=', itemId).execute()).toHaveLength(1)
  })

  it('retries zero-value multi-code delivery after restart, exposes only authorized history, and never restores refunded codes', async () => {
    const admin = await createAdmin()
    const catalog = await createCatalog({ price: '0.00', mode: 'quantity', stock: 0 })
    expect((await setCodePoolReadiness(catalog, admin, false)).statusCode).toBe(200)
    expect((await importCodePool(catalog, admin, 'UNIT-A 01\nUNIT-B 02\nGUEST-CODE')).statusCode).toBe(201)
    expect((await setCodePoolReadiness(catalog, admin, true)).statusCode).toBe(200)
    const customer = await createCustomer()
    const items = [{ skuId: catalog.skuId, quantity: 2 }]
    const currentQuote = await quote(items, customer)
    const created = await createOrder(items, currentQuote.json().data.quoteToken, customer)
    expect(created.statusCode).toBe(201)
    expect(created.json().data.order.status).toBe('processing')
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    const noDeliveryYet = await inject({
      method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: customer.cookie },
    })
    expect(noDeliveryYet.json().data.items[0].deliveries).toEqual([])

    const stopWithoutKey = startCodePoolDeliveryWorker(db, { ...appConfig, codePoolEncryptionKeyRing: null }, app.log)
    const failed = await waitForCodePoolOrder(orderId, itemId, 0)
    await stopWithoutKey()
    expect(failed.attempts.at(-1)).toMatchObject({ status: 'failed', failure_code: 'CODE_POOL_KEY_UNAVAILABLE' })
    expect(await db.selectFrom('order_item_fulfillment_deliveries').select('order_item_fulfillment_deliveries.id')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'order_item_fulfillment_deliveries.fulfillment_attempt_id')
      .where('attempt.order_item_id', '=', itemId).execute()).toHaveLength(0)
    expect((await db.selectFrom('order_items').select('fulfilled_quantity').where('id', '=', itemId).executeTakeFirstOrThrow())
      .fulfilled_quantity).toBe(0)

    const stopWorkerA = startCodePoolDeliveryWorker(db, appConfig, app.log)
    const stopWorkerB = startCodePoolDeliveryWorker(db, appConfig, app.log)
    await waitForCodePoolOrder(orderId, itemId, 2)
    await Promise.all([stopWorkerA(), stopWorkerB()])
    const attempts = await db.selectFrom('order_item_fulfillment_attempts').select(['status', 'failure_code'])
      .where('order_item_id', '=', itemId).where('delivery_source', '=', 'code_pool')
      .orderBy('created_at').orderBy('id').execute()
    expect(attempts).toMatchObject([
      { status: 'failed', failure_code: 'CODE_POOL_KEY_UNAVAILABLE' },
      { status: 'succeeded', failure_code: null },
    ])
    const deliveries = await db.selectFrom('order_item_fulfillment_deliveries')
      .select(['encrypted_content', 'content', 'unit_index'])
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'order_item_fulfillment_deliveries.fulfillment_attempt_id')
      .where('attempt.order_item_id', '=', itemId).where('attempt.status', '=', 'succeeded')
      .orderBy('unit_index').execute()
    expect(deliveries.map(delivery => delivery.unit_index)).toEqual([1, 2])
    expect(deliveries.every(delivery => delivery.content === null && delivery.encrypted_content !== null)).toBe(true)
    expect(deliveries.some(delivery => Buffer.from(delivery.encrypted_content!).includes(Buffer.from('UNIT-A 01')))).toBe(false)
    const inventory = await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()
    expect(inventory).toEqual({ stocked: 1, reserved: 0 })
    expect(await db.selectFrom('code_pool_entries').select('id')
      .where('product_variant_id', '=', catalog.skuId).where('state', '=', 'delivered').execute()).toHaveLength(2)
    expect(await db.selectFrom('order_inventory_events as event').select(['event.action', 'event.quantity'])
      .innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
      .where('reservation.order_item_id', '=', itemId).orderBy('event.action').execute()).toMatchObject([
      { action: 'consume', quantity: 2 }, { action: 'reserve', quantity: 2 },
    ])

    const ownerDetail = await inject({
      method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: customer.cookie },
    })
    expect(ownerDetail.statusCode).toBe(200)
    expect(ownerDetail.json().data.items[0].deliveries.map((delivery: { content: string }) => delivery.content))
      .toEqual(['UNIT-A 01', 'UNIT-B 02'])
    const unauthorizedCustomer = await createCustomer()
    expect((await inject({
      method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: unauthorizedCustomer.cookie },
    })).statusCode).toBe(404)
    const adminDetail = await inject({ method: 'GET', url: `/api/v1/admin/orders/${orderId}`, headers: { cookie: admin.cookie } })
    expect(adminDetail.statusCode).toBe(200)
    expect(adminDetail.json().data.fulfillmentAttempts.at(-1)).toMatchObject({
      deliverySource: 'code_pool', status: 'succeeded', deliveryCount: 2,
    })

    const stopAfterCompletion = startCodePoolDeliveryWorker(db, appConfig, app.log)
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await stopAfterCompletion()
    expect(await db.selectFrom('order_item_fulfillment_attempts').select('id')
      .where('order_item_id', '=', itemId).where('delivery_source', '=', 'code_pool').execute()).toHaveLength(2)

    await db.updateTable('storefront_customer_policy').set({
      guest_checkout_enabled: true, guest_free_claim_enabled: true,
    }).execute()
    const guest = await newGuestSession()
    const otherGuest = await newGuestSession()
    const guestItems = [{ skuId: catalog.skuId, quantity: 1 }]
    const guestQuote = await quote(guestItems, undefined, guest.cookie)
    const guestOwner = { cookie: guest.cookie, csrfToken: guest.csrfToken, csrfCookie: guest.csrfCookie }
    const guestCreated = await createOrder(guestItems, guestQuote.json().data.quoteToken, guestOwner)
    expect(guestCreated.statusCode).toBe(201)
    const guestOrderId = guestCreated.json().data.order.id as string
    const guestItemId = guestCreated.json().data.order.items[0].id as string
    const stopGuestDelivery = startCodePoolDeliveryWorker(db, appConfig, app.log)
    await waitForCodePoolOrder(guestOrderId, guestItemId, 1)
    await stopGuestDelivery()
    const guestDetail = await inject({ method: 'GET', url: `/api/v1/guest/orders/${guestOrderId}`, headers: { cookie: guest.cookie } })
    expect(guestDetail.statusCode).toBe(200)
    expect(guestDetail.json().data.items[0].deliveries[0].content).toBe('GUEST-CODE')
    expect((await inject({
      method: 'GET', url: `/api/v1/guest/orders/${guestOrderId}`, headers: { cookie: otherGuest.cookie },
    })).statusCode).toBe(404)
    expect((await inject({
      method: 'GET', url: `/api/v1/guest/orders/${guestOrderId}`, headers: { cookie: customer.cookie },
    })).statusCode).toBe(403)
    expect((await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow())).toEqual({ stocked: 0, reserved: 0 })
    expect(await db.selectFrom('code_pool_entries').select('id')
      .where('product_variant_id', '=', catalog.skuId).where('state', '=', 'delivered').execute()).toHaveLength(3)
  })

  it('commits a real payment receipt while delivery retries, then retains delivered codes after refund', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '2.50', mode: 'quantity', stock: 0 })
    expect((await setCodePoolReadiness(catalog, admin, false)).statusCode).toBe(200)
    expect((await importCodePool(catalog, admin, 'PAID-DELIVERY-CODE')).statusCode).toBe(201)
    expect((await setCodePoolReadiness(catalog, admin, true)).statusCode).toBe(200)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const currentQuote = await quote(items, customer)
    const created = await createOrder(items, currentQuote.json().data.quoteToken, customer)
    expect(created.statusCode).toBe(201)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    expect(created.json().data.order.status).toBe('pending_payment')
    const beforePayment = await inject({
      method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: customer.cookie },
    })
    expect(beforePayment.json().data.items[0].deliveries).toEqual([])
    expect(JSON.stringify(beforePayment.json())).not.toContain('PAID-DELIVERY-CODE')

    const attemptId = randomUUID()
    const receiptId = randomUUID()
    await db.insertInto('payment_attempts').values({
      id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
      topup_customer_id: null, source: 'external', amount: '2.50', status: 'created', provider: 'integration',
      provider_payment_id: `confirmed-${attemptId}`, wallet_operation_id: null, wallet_hold_operation_id: null,
      requested_wallet_amount: null, expires_at: new Date(Date.now() + 60 * 60_000), completed_at: null,
    }).execute()
    await db.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
    await db.insertInto('payment_receipts').values({
      id: receiptId, payment_attempt_id: attemptId, source_bucket: 'external', provider: 'integration',
      provider_transaction_id: `confirmed-receipt-${receiptId}`, wallet_operation_id: null,
      wallet_line_no: null, amount: '2.50',
    }).execute()
    const stopWithoutKey = startCodePoolDeliveryWorker(db, { ...appConfig, codePoolEncryptionKeyRing: null }, app.log)
    await db.updateTable('payment_attempts').set({ status: 'succeeded' }).where('id', '=', attemptId).execute()
    await waitForCodePoolOrder(orderId, itemId, 0)
    await stopWithoutKey()
    expect((await db.selectFrom('payment_receipts').select(['id', 'disposition'])
      .where('id', '=', receiptId).executeTakeFirstOrThrow()).disposition).toBe('on_time')
    expect((await db.selectFrom('payment_attempts').select('status')
      .where('id', '=', attemptId).executeTakeFirstOrThrow()).status).toBe('succeeded')
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status)
      .toBe('processing')
    expect((await db.selectFrom('order_item_fulfillment_attempts').select('failure_code')
      .where('order_item_id', '=', itemId).where('delivery_source', '=', 'code_pool')
      .executeTakeFirstOrThrow()).failure_code).toBe('CODE_POOL_KEY_UNAVAILABLE')

    const stopWithKey = startCodePoolDeliveryWorker(db, appConfig, app.log)
    await waitForCodePoolOrder(orderId, itemId, 1)
    await stopWithKey()
    expect((await db.selectFrom('code_pool_entries').select('state')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).state).toBe('delivered')
    await refundExistingReceipt(orderId, receiptId, '2.50')
    expect((await db.selectFrom('code_pool_entries').select('state')
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()).state).toBe('delivered')
    expect((await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow())).toEqual({ stocked: 0, reserved: 0 })
  })
})

describe('versioned fixed-content and link delivery on PostgreSQL', () => {
  it('binds immutable versions to orders, invalidates old quotes, consumes quantity stock once, and recovers across workers and key rotation', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '0.00', mode: 'quantity', stock: 5 })
    const configUrl = `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/fixed-delivery`
    const initialConfig = await inject({ method: 'GET', url: configUrl, headers: { cookie: admin.cookie } })
    expect(initialConfig.statusCode).toBe(200)
    expect(initialConfig.headers['cache-control']).toContain('no-store')
    const initialHistory = await inject({
      method: 'GET', url: `${configUrl}/versions?page=1&pageSize=20`, headers: { cookie: admin.cookie },
    })
    expect(initialHistory.statusCode).toBe(200)
    expect(initialHistory.json().data).toMatchObject({ items: [], page: 1, pageSize: 20, totalPages: 0 })
    const firstText = '**Version one**\n\n<script>PRIVATE-V1-XSS</script>\n[unsafe](javascript:alert(1))'
    const savedV1 = await inject({
      method: 'POST', url: `${configUrl}/versions`, headers: adminHeaders(admin),
      payload: { expectedRevision: initialConfig.json().data.configurationRevision, method: 'fixed_content', content: firstText },
    })
    expect(savedV1.statusCode).toBe(200)
    expect(savedV1.json().data).toMatchObject({ automaticDeliveryReady: false, currentVersion: { versionNumber: 1, content: firstText } })
    expect(savedV1.headers['cache-control']).toContain('no-store')
    const versionIdV1 = savedV1.json().data.currentVersion.id as string
    const storedVersionV1 = await db.selectFrom('product_variant_fulfillment_versions')
      .select(['encrypted_content', 'content_nonce', 'content_auth_tag', 'encryption_key_id'])
      .where('id', '=', versionIdV1).executeTakeFirstOrThrow()
    expect(Buffer.from(storedVersionV1.encrypted_content).includes(Buffer.from('PRIVATE-V1-XSS'))).toBe(false)
    expect(storedVersionV1.content_nonce).toHaveLength(12)
    expect(storedVersionV1.content_auth_tag).toHaveLength(16)

    const publicBeforeOrder = await inject({ method: 'GET', url: `/api/v1/public/products/${catalog.productId}` })
    expect(publicBeforeOrder.statusCode).toBe(200)
    expect(JSON.stringify(publicBeforeOrder.json())).not.toContain('PRIVATE-V1-XSS')
    expect(JSON.stringify(publicBeforeOrder.json())).not.toContain('Version one')

    const enabledV1 = await inject({
      method: 'PUT', url: `${configUrl}/readiness`, headers: adminHeaders(admin),
      payload: { expectedRevision: savedV1.json().data.configurationRevision, enabled: true },
    })
    expect(enabledV1.statusCode).toBe(200)
    expect(enabledV1.json().data.automaticDeliveryReady).toBe(true)

    const itemsV1 = [{ skuId: catalog.skuId, quantity: 2 }]
    const quoteV1 = await quote(itemsV1, customer)
    expect(quoteV1.json().data.canContinue).toBe(true)
    expect(quoteV1.json().data.items[0]).toMatchObject({ fulfillmentMethod: 'fixed_content', fulfillmentRevision: enabledV1.json().data.configurationRevision, fulfillmentVersionId: versionIdV1 })
    const createdV1 = await createOrder(itemsV1, quoteV1.json().data.quoteToken, customer)
    expect(createdV1.statusCode).toBe(201)
    const orderIdV1 = createdV1.json().data.order.id as string
    const itemIdV1 = createdV1.json().data.order.items[0].id as string
    expect(createdV1.json().data.order.status).toBe('processing')
    expect(createdV1.json().data.order.items[0].deliveries).toEqual([])
    expect((await db.selectFrom('order_items').select('fulfillment_content_version_id')
      .where('id', '=', itemIdV1).executeTakeFirstOrThrow()).fulfillment_content_version_id).toBe(versionIdV1)
    expect((await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderIdV1}`, headers: { cookie: customer.cookie } }))
      .json().data.items[0].deliveries).toEqual([])

    const staleQuote = await quote([{ skuId: catalog.skuId, quantity: 1 }], customer)
    const secondText = '## Version two\n\nNew authorization instructions.'
    const savedV2 = await inject({
      method: 'POST', url: `${configUrl}/versions`, headers: adminHeaders(admin),
      payload: { expectedRevision: enabledV1.json().data.configurationRevision, method: 'fixed_content', content: secondText },
    })
    expect(savedV2.statusCode).toBe(200)
    expect(savedV2.json().data).toMatchObject({ automaticDeliveryReady: false, currentVersion: { versionNumber: 2, content: secondText } })

    const sourceProductRevision = await db.selectFrom('products').select('revision')
      .where('id', '=', catalog.productId).executeTakeFirstOrThrow()
    const copiedProduct = await inject({
      method: 'POST', url: `/api/v1/admin/products/${catalog.productId}/copy`, headers: adminHeaders(admin),
      payload: { expectedRevision: sourceProductRevision.revision },
    })
    expect(copiedProduct.statusCode).toBe(201)
    expect(copiedProduct.json().data.status).toBe('draft')
    const copiedSkuId = copiedProduct.json().data.variants[0].id as string
    expect(copiedProduct.json().data.variants[0].enabled).toBe(false)
    expect(await db.selectFrom('product_variant_fulfillment_versions').select('id')
      .where('product_variant_id', '=', copiedSkuId).execute()).toEqual([])
    const copiedConfig = await inject({
      method: 'GET',
      url: `/api/v1/admin/products/${copiedProduct.json().data.id}/variants/${copiedSkuId}/fixed-delivery`,
      headers: { cookie: admin.cookie },
    })
    expect(copiedConfig.statusCode).toBe(200)
    expect(copiedConfig.json().data).toMatchObject({ method: null, automaticDeliveryReady: false, currentVersion: null })

    const oldQuoteOrder = await createOrder([{ skuId: catalog.skuId, quantity: 1 }], staleQuote.json().data.quoteToken, customer)
    expect(oldQuoteOrder.statusCode).toBe(409)
    expect(oldQuoteOrder.json().error.code).toBe('CHECKOUT_QUOTE_CHANGED')
    const enabledV2 = await inject({
      method: 'PUT', url: `${configUrl}/readiness`, headers: adminHeaders(admin),
      payload: { expectedRevision: savedV2.json().data.configurationRevision, enabled: true },
    })
    expect(enabledV2.statusCode).toBe(200)
    const quoteV2 = await quote([{ skuId: catalog.skuId, quantity: 1 }], customer)
    expect(quoteV2.json().data.canContinue).toBe(true)
    expect(quoteV2.json().data.items[0].fulfillmentVersionId).toBe(savedV2.json().data.currentVersion.id)
    const createdV2 = await createOrder([{ skuId: catalog.skuId, quantity: 1 }], quoteV2.json().data.quoteToken, customer)
    expect(createdV2.statusCode).toBe(201)
    const orderIdV2 = createdV2.json().data.order.id as string
    const itemIdV2 = createdV2.json().data.order.items[0].id as string

    const stopWorkerA = startCodePoolDeliveryWorker(db, appConfig, app.log)
    const stopWorkerB = startCodePoolDeliveryWorker(db, appConfig, app.log)
    await Promise.all([
      waitForFixedDeliveryOrder(orderIdV1, itemIdV1, 2),
      waitForFixedDeliveryOrder(orderIdV2, itemIdV2, 1),
    ])
    await Promise.all([stopWorkerA(), stopWorkerB()])

    const detailV1 = await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderIdV1}`, headers: { cookie: customer.cookie } })
    const detailV2 = await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderIdV2}`, headers: { cookie: customer.cookie } })
    expect(detailV1.statusCode).toBe(200)
    expect(detailV1.json().data.items[0].deliveries).toHaveLength(2)
    expect(detailV1.json().data.items[0].deliveries.map((row: { content: string; contentFormat: string }) => [row.content, row.contentFormat]))
      .toEqual([[firstText, 'markdown'], [firstText, 'markdown']])
    expect(detailV2.json().data.items[0].deliveries.map((row: { content: string }) => row.content)).toEqual([secondText])
    expect(detailV1.json().data.status).toBe('completed')
    expect(detailV2.json().data.status).toBe('completed')
    const stranger = await createCustomer()
    expect((await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderIdV1}`, headers: { cookie: stranger.cookie } })).statusCode).toBe(404)

    const storedDeliveries = await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .select(['attempt.order_item_id as item_id', 'delivery.content', 'delivery.encrypted_content', 'delivery.fulfillment_content_version_id', 'delivery.encryption_key_id'])
      .where('attempt.order_item_id', 'in', [itemIdV1, itemIdV2]).orderBy('delivery.unit_index').execute()
    expect(storedDeliveries).toHaveLength(3)
    expect(storedDeliveries.every(row => row.content === null && row.encrypted_content !== null)).toBe(true)
    expect(storedDeliveries.filter(row => row.item_id === itemIdV1).map(row => row.fulfillment_content_version_id)).toEqual([versionIdV1, versionIdV1])
    expect(storedDeliveries.filter(row => row.item_id === itemIdV2).map(row => row.fulfillment_content_version_id)).toEqual([savedV2.json().data.currentVersion.id])
    expect(storedDeliveries.some(row => Buffer.from(row.encrypted_content!).includes(Buffer.from('PRIVATE-V1-XSS')))).toBe(false)
    expect(await db.selectFrom('order_item_fulfillment_attempts').select('id').where('order_item_id', '=', itemIdV1).execute()).toHaveLength(1)
    expect(await db.selectFrom('order_item_fulfillment_attempts').select('id').where('order_item_id', '=', itemIdV2).execute()).toHaveLength(1)
    const inventory = await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow()
    expect(inventory).toEqual({ stocked: 2, reserved: 0 })
    expect(await db.selectFrom('order_inventory_events as event')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
      .innerJoin('order_items as item', 'item.id', 'reservation.order_item_id')
      .select(['event.action', sql<number>`sum(event.quantity)::integer`.as('quantity')])
      .where('item.product_variant_id', '=', catalog.skuId).groupBy('event.action').execute())
      .toEqual(expect.arrayContaining([{ action: 'reserve', quantity: 3 }, { action: 'consume', quantity: 3 }]))
    await expect(db.updateTable('product_variant_fulfillment_versions').set({ encrypted_content: Buffer.from('overwrite') })
      .where('id', '=', versionIdV1).execute()).rejects.toMatchObject({ constraint: 'fulfillment_content_version_immutable' })
    await expect(db.deleteFrom('product_variant_fulfillment_versions').where('id', '=', versionIdV1).execute())
      .rejects.toMatchObject({ constraint: 'fulfillment_content_version_immutable' })

    const originalRing = appConfig.codePoolEncryptionKeyRing!
    const oldKey = originalRing.keys[originalRing.activeKeyId]!
    const newKey = Buffer.alloc(32, 0x67)
    try {
      appConfig.codePoolEncryptionKeyRing = { activeKeyId: 'test-v2', keys: { 'test-v1': oldKey, 'test-v2': newKey } }
      expect((await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderIdV1}`, headers: { cookie: customer.cookie } })).statusCode).toBe(200)
      appConfig.codePoolEncryptionKeyRing = { activeKeyId: 'test-v2', keys: { 'test-v2': newKey } }
      const missingKey = await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderIdV1}`, headers: { cookie: customer.cookie } })
      expect(missingKey.statusCode).toBe(503)
      expect(missingKey.json().error.code).toBe('FIXED_DELIVERY_KEY_UNAVAILABLE')
      expect(JSON.stringify(missingKey.json())).not.toContain('PRIVATE-V1-XSS')
      appConfig.codePoolEncryptionKeyRing = { activeKeyId: 'test-v2', keys: { 'test-v1': oldKey, 'test-v2': newKey } }
      expect((await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderIdV1}`, headers: { cookie: customer.cookie } })).json().data.items[0].deliveries[0].content)
        .toBe(firstText)

      appConfig.codePoolEncryptionKeyRing = {
        activeKeyId: 'test-v1', keys: { 'test-v1': Buffer.alloc(32, 0x39), 'test-v2': newKey },
      }
      const invalidAuthenticationTag = await inject({
        method: 'GET', url: `/api/v1/customer/orders/${orderIdV1}`, headers: { cookie: customer.cookie },
      })
      expect(invalidAuthenticationTag.statusCode).toBe(503)
      expect(invalidAuthenticationTag.json().error.code).toBe('FIXED_DELIVERY_DECRYPTION_FAILED')
      expect(JSON.stringify(invalidAuthenticationTag.json())).not.toContain('PRIVATE-V1-XSS')
    } finally {
      appConfig.codePoolEncryptionKeyRing = originalRing
    }
  })

  it('serializes checkout against a concurrent content revision and never binds an unquoted version', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '0.00', mode: 'quantity', stock: 2 })
    const configUrl = `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/fixed-delivery`
    const initial = await inject({ method: 'GET', url: configUrl, headers: { cookie: admin.cookie } })
    const savedV1 = await inject({
      method: 'POST', url: `${configUrl}/versions`, headers: adminHeaders(admin),
      payload: { expectedRevision: initial.json().data.configurationRevision, method: 'fixed_content', content: 'RACE-VERSION-ONE' },
    })
    const enabled = await inject({
      method: 'PUT', url: `${configUrl}/readiness`, headers: adminHeaders(admin),
      payload: { expectedRevision: savedV1.json().data.configurationRevision, enabled: true },
    })
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteBeforeEdit = await quote(items, customer)
    const [checkout, edit] = await Promise.all([
      createOrder(items, quoteBeforeEdit.json().data.quoteToken, customer),
      inject({
        method: 'POST', url: `${configUrl}/versions`, headers: adminHeaders(admin),
        payload: {
          expectedRevision: enabled.json().data.configurationRevision,
          method: 'fixed_content', content: 'RACE-VERSION-TWO',
        },
      }),
    ])
    expect(edit.statusCode).toBe(200)
    expect(edit.json().data.automaticDeliveryReady).toBe(false)
    if (checkout.statusCode === 201) {
      const itemId = checkout.json().data.order.items[0].id as string
      expect((await db.selectFrom('order_items').select('fulfillment_content_version_id')
        .where('id', '=', itemId).executeTakeFirstOrThrow()).fulfillment_content_version_id)
        .toBe(savedV1.json().data.currentVersion.id)
    } else {
      expect(checkout.statusCode).toBe(409)
      expect(checkout.json().error.code).toBe('CHECKOUT_QUOTE_CHANGED')
      expect(await db.selectFrom('order_items').select('id').where('product_variant_id', '=', catalog.skuId).execute())
        .toHaveLength(0)
    }
  })

  it('blocks fixed delivery when an otherwise settled payment has an open provider reconciliation case', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    const configUrl = `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/fixed-delivery`
    const initial = await inject({ method: 'GET', url: configUrl, headers: { cookie: admin.cookie } })
    const saved = await inject({
      method: 'POST', url: `${configUrl}/versions`, headers: adminHeaders(admin),
      payload: { expectedRevision: initial.json().data.configurationRevision, method: 'fixed_content', content: 'RECONCILIATION-HOLD-SECRET' },
    })
    const enabled = await inject({
      method: 'PUT', url: `${configUrl}/readiness`, headers: adminHeaders(admin),
      payload: { expectedRevision: saved.json().data.configurationRevision, enabled: true },
    })
    expect(enabled.statusCode).toBe(200)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const quoteBeforePayment = await quote(items, customer)
    const created = await createOrder(items, quoteBeforePayment.json().data.quoteToken, customer)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    const attemptId = randomUUID()
    const receiptId = randomUUID()
    await db.insertInto('payment_attempts').values({
      id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
      topup_customer_id: null, source: 'external', amount: '1.20', status: 'created', provider: 'integration',
      provider_payment_id: `fixed-reconciliation-${attemptId}`, wallet_operation_id: null, wallet_hold_operation_id: null,
      requested_wallet_amount: null, expires_at: new Date(Date.now() + 60 * 60_000), completed_at: null,
    }).execute()
    await db.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
    await db.insertInto('payment_receipts').values({
      id: receiptId, payment_attempt_id: attemptId, source_bucket: 'external', provider: 'integration',
      provider_transaction_id: `fixed-reconciliation-receipt-${receiptId}`, wallet_operation_id: null,
      wallet_line_no: null, amount: '1.20',
    }).execute()
    await db.updateTable('payment_attempts').set({ status: 'succeeded' }).where('id', '=', attemptId).execute()
    const eventId = randomUUID()
    await db.insertInto('payment_provider_events').values({
      id: eventId, payment_attempt_id: attemptId, source: 'callback', event_sha256: digest,
      verification: 'verified', disposition: 'reconciliation_required', provider_status: 'paid',
      provider_transaction_id: `fixed-reconciliation-txn-${receiptId}`, reported_amount: '1.20',
      currency: 'CNY', provider_paid_at: new Date(), provider_time_text: null,
      payload: { outcome: 'conflicting_callback' }, error_code: 'CALLBACK_QUERY_MISMATCH',
    }).execute()
    await db.insertInto('payment_provider_reconciliation_cases').values({
      id: randomUUID(), payment_attempt_id: attemptId, reason: 'callback_query_mismatch',
      opening_callback_event_id: eventId, opening_query_event_id: null,
    }).execute()

    const stopWorker = startCodePoolDeliveryWorker(db, appConfig, app.log)
    await stopWorker()
    expect(await db.selectFrom('order_item_fulfillment_attempts').select('id').where('order_item_id', '=', itemId).execute()).toEqual([])
    expect((await db.selectFrom('payment_receipts').select('disposition').where('id', '=', receiptId).executeTakeFirstOrThrow()).disposition)
      .toBe('on_time')
    expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status)
      .toBe('succeeded')
    expect(await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .select('delivery.id').where('attempt.order_item_id', '=', itemId).execute()).toHaveLength(0)
  })

  it('rejects dangerous link schemes, delivers HTTPS instructions to an isolated guest, and leaves unlimited stock unreserved', async () => {
    const admin = await createAdmin()
    const catalog = await createCatalog({ price: '0.00', mode: 'unlimited' })
    const configUrl = `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/fixed-delivery`
    const initial = await inject({ method: 'GET', url: configUrl, headers: { cookie: admin.cookie } })
    for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd']) {
      const rejected = await inject({
        method: 'POST', url: `${configUrl}/versions`, headers: adminHeaders(admin),
        payload: { expectedRevision: initial.json().data.configurationRevision, method: 'link', url, title: '恶意链接', accessInstructions: 'PRIVATE-URL-SECRET' },
      })
      expect(rejected.statusCode).toBe(400)
      expect(JSON.stringify(rejected.json())).not.toContain('PRIVATE-URL-SECRET')
    }
    const url = 'https://downloads.example.test/private-guide?token=FIXED-LINK-SECRET'
    const saved = await inject({
      method: 'POST', url: `${configUrl}/versions`, headers: adminHeaders(admin),
      payload: { expectedRevision: initial.json().data.configurationRevision, method: 'link', url, title: '授权下载页面', accessInstructions: '访问说明 PRIVATE-ACCESS-INSTRUCTIONS' },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().data).toMatchObject({ method: 'link', automaticDeliveryReady: false, currentVersion: { method: 'link', content: url, title: '授权下载页面' } })
    const enabled = await inject({
      method: 'PUT', url: `${configUrl}/readiness`, headers: adminHeaders(admin),
      payload: { expectedRevision: saved.json().data.configurationRevision, enabled: true },
    })
    expect(enabled.statusCode).toBe(200)
    await db.updateTable('storefront_customer_policy').set({ guest_checkout_enabled: true, guest_free_claim_enabled: true })
      .where('singleton', '=', true).execute()
    const guest = await newGuestSession()
    const otherGuest = await newGuestSession()
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const guestQuote = await quote(items, undefined, guest.cookie)
    expect(guestQuote.json().data.canContinue).toBe(true)
    const guestOwner = { cookie: guest.cookie, csrfToken: guest.csrfToken, csrfCookie: guest.csrfCookie }
    const created = await createOrder(items, guestQuote.json().data.quoteToken, guestOwner)
    expect(created.statusCode).toBe(201)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    const stopWorker = startCodePoolDeliveryWorker(db, appConfig, app.log)
    await waitForFixedDeliveryOrder(orderId, itemId, 1)
    await stopWorker()

    const guestDetail = await inject({ method: 'GET', url: `/api/v1/guest/orders/${orderId}`, headers: { cookie: guest.cookie } })
    expect(guestDetail.statusCode).toBe(200)
    expect(guestDetail.json().data.items[0].deliveries).toMatchObject([{
      content: url, contentFormat: 'link', title: '授权下载页面', accessInstructions: '访问说明 PRIVATE-ACCESS-INSTRUCTIONS',
    }])
    expect((await inject({ method: 'GET', url: `/api/v1/guest/orders/${orderId}`, headers: { cookie: otherGuest.cookie } })).statusCode).toBe(404)
    const customer = await createCustomer()
    expect((await inject({ method: 'GET', url: `/api/v1/guest/orders/${orderId}`, headers: { cookie: customer.cookie } })).statusCode).toBe(403)
    expect(await db.selectFrom('order_inventory_reservations').select('id').where('order_item_id', '=', itemId).execute()).toHaveLength(0)
    expect(await db.selectFrom('order_inventory_events').select('id').where('product_variant_id', '=', catalog.skuId).execute()).toHaveLength(0)
    const publicProduct = await inject({ method: 'GET', url: `/api/v1/public/products/${catalog.productId}` })
    expect(JSON.stringify(publicProduct.json())).not.toContain('FIXED-LINK-SECRET')
    expect(JSON.stringify(publicProduct.json())).not.toContain('PRIVATE-ACCESS-INSTRUCTIONS')

    const switched = await inject({
      method: 'PUT', url: `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/manual-fulfillment`,
      headers: adminHeaders(admin), payload: { enabled: false },
    })
    expect(switched.statusCode).toBe(200)
    expect(switched.json().data.method).toBe('manual')
    const historyAfterSwitch = await inject({ method: 'GET', url: `/api/v1/guest/orders/${orderId}`, headers: { cookie: guest.cookie } })
    expect(historyAfterSwitch.json().data.items[0].deliveries[0]).toMatchObject({ content: url, title: '授权下载页面' })

    const productRevision = await db.selectFrom('products').select('revision')
      .where('id', '=', catalog.productId).executeTakeFirstOrThrow()
    const archived = await inject({
      method: 'PATCH', url: `/api/v1/admin/products/${catalog.productId}/lifecycle`, headers: adminHeaders(admin),
      payload: { expectedRevision: productRevision.revision, status: 'archived' },
    })
    expect(archived.statusCode).toBe(200)
    await db.updateTable('product_variants').set({ enabled: false, retired_at: new Date() })
      .where('id', '=', catalog.skuId).execute()
    const retiredHistory = await inject({
      method: 'GET', url: `/api/v1/guest/orders/${orderId}`, headers: { cookie: guest.cookie },
    })
    expect(retiredHistory.statusCode).toBe(200)
    expect(retiredHistory.json().data.items[0].deliveries[0]).toMatchObject({
      content: url, contentFormat: 'link', title: '授权下载页面',
    })
  })

  it('waits for confirmed payment and key recovery, then keeps delivered history after refund without rerunning', async () => {
    const admin = await createAdmin()
    const customer = await createCustomer()
    const catalog = await createCatalog({ price: '1.20', mode: 'quantity', stock: 2 })
    const configUrl = `/api/v1/admin/products/${catalog.productId}/variants/${catalog.skuId}/fixed-delivery`
    const initial = await inject({ method: 'GET', url: configUrl, headers: { cookie: admin.cookie } })
    const saved = await inject({
      method: 'POST', url: `${configUrl}/versions`, headers: adminHeaders(admin),
      payload: { expectedRevision: initial.json().data.configurationRevision, method: 'fixed_content', content: 'PAID-FIXED-DELIVERY-SECRET' },
    })
    const enabled = await inject({
      method: 'PUT', url: `${configUrl}/readiness`, headers: adminHeaders(admin),
      payload: { expectedRevision: saved.json().data.configurationRevision, enabled: true },
    })
    expect(enabled.statusCode).toBe(200)
    const items = [{ skuId: catalog.skuId, quantity: 1 }]
    const currentQuote = await quote(items, customer)
    const created = await createOrder(items, currentQuote.json().data.quoteToken, customer)
    expect(created.statusCode).toBe(201)
    const orderId = created.json().data.order.id as string
    const itemId = created.json().data.order.items[0].id as string
    expect(created.json().data.order.status).toBe('pending_payment')
    const pendingDetail = await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: customer.cookie } })
    expect(pendingDetail.json().data.items[0].deliveries).toEqual([])
    expect(JSON.stringify(pendingDetail.json())).not.toContain('PAID-FIXED-DELIVERY-SECRET')

    const attemptId = randomUUID()
    const receiptId = randomUUID()
    await db.insertInto('payment_attempts').values({
      id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: orderId,
      topup_customer_id: null, source: 'external', amount: '1.20', status: 'created', provider: 'integration',
      provider_payment_id: `fixed-delivery-payment-${attemptId}`, wallet_operation_id: null, wallet_hold_operation_id: null,
      requested_wallet_amount: null, expires_at: new Date(Date.now() + 60 * 60_000), completed_at: null,
    }).execute()
    await db.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
    await db.insertInto('payment_receipts').values({
      id: receiptId, payment_attempt_id: attemptId, source_bucket: 'external', provider: 'integration',
      provider_transaction_id: `fixed-delivery-receipt-${receiptId}`, wallet_operation_id: null, wallet_line_no: null, amount: '1.20',
    }).execute()
    const originalRing = appConfig.codePoolEncryptionKeyRing
    try {
      appConfig.codePoolEncryptionKeyRing = null
      await db.updateTable('payment_attempts').set({ status: 'succeeded' }).where('id', '=', attemptId).execute()
      expect((await db.selectFrom('orders').select('status').where('id', '=', orderId).executeTakeFirstOrThrow()).status).toBe('processing')
      const stopWithoutKey = startCodePoolDeliveryWorker(db, appConfig, app.log)
      const failed = await waitForFixedDeliveryOrder(orderId, itemId, 0)
      await stopWithoutKey()
      expect(failed.attempts.at(-1)).toMatchObject({ status: 'failed', failure_code: 'FIXED_DELIVERY_KEY_UNAVAILABLE' })
      expect((await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow()).status).toBe('succeeded')
      expect((await db.selectFrom('payment_receipts').select('disposition').where('id', '=', receiptId).executeTakeFirstOrThrow()).disposition).toBe('on_time')
      expect(await db.selectFrom('order_item_fulfillment_deliveries').select('order_item_fulfillment_deliveries.id')
        .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'order_item_fulfillment_deliveries.fulfillment_attempt_id')
        .where('attempt.order_item_id', '=', itemId).execute()).toHaveLength(0)

      appConfig.codePoolEncryptionKeyRing = originalRing
      const stopWithKey = startCodePoolDeliveryWorker(db, appConfig, app.log)
      await waitForFixedDeliveryOrder(orderId, itemId, 1)
      await stopWithKey()
      await refundExistingReceipt(orderId, receiptId, '1.20')
      const afterRefund = await inject({ method: 'GET', url: `/api/v1/customer/orders/${orderId}`, headers: { cookie: customer.cookie } })
      expect(afterRefund.statusCode).toBe(200)
      expect(afterRefund.json().data.items[0].deliveries[0].content).toBe('PAID-FIXED-DELIVERY-SECRET')
      const stopAfterRefund = startCodePoolDeliveryWorker(db, appConfig, app.log)
      await new Promise(resolve => setTimeout(resolve, 1_100))
      await stopAfterRefund()
      expect(await db.selectFrom('order_item_fulfillment_attempts').select('id')
        .where('order_item_id', '=', itemId).where('delivery_source', '=', 'fixed_content').execute()).toHaveLength(2)
      expect((await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
        .where('product_variant_id', '=', catalog.skuId).executeTakeFirstOrThrow())).toEqual({ stocked: 1, reserved: 0 })
    } finally {
      appConfig.codePoolEncryptionKeyRing = originalRing
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

    const spendCatalog = await createCatalog({ name: '退款现金正常消费', price: '1.25', mode: 'unlimited' })
    await enableManual(spendCatalog, admin)
    const spendItems = [{ skuId: spendCatalog.skuId, quantity: 1 }]
    const spendQuote = await quote(spendItems, customer)
    const spendOrder = await createOrder(spendItems, spendQuote.json().data.quoteToken, customer)
    expect(spendOrder.statusCode).toBe(201)
    const spendOrderId = spendOrder.json().data.order.id as string
    const walletPayment = await inject({
      method: 'POST', url: `/api/v1/orders/${spendOrderId}/payments`, headers: customerHeaders(customer),
      payload: { idempotencyKey: randomUUID(), walletAmount: '1.25' },
    })
    expect(walletPayment.statusCode).toBe(201)
    const spendItemId = spendOrder.json().data.order.items[0].id as string
    const delivered = await inject({
      method: 'POST', url: `/api/v1/admin/orders/${spendOrderId}/items/${spendItemId}/fulfillments`,
      headers: adminHeaders(admin), payload: { operationId: randomUUID(), deliveries: [{ content: 'legitimate-wallet-purchase' }] },
    })
    expect(delivered.statusCode).toBe(200)
    expect(delivered.json().data.order.status).toBe('completed')

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
