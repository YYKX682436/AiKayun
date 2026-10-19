import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import type { Kysely, Transaction } from 'kysely'
import { Migrator } from 'kysely/migration'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database, FulfillmentMethod, OrderSkuOptionSnapshot, ProductInventoryMode, ProductType } from '../src/db/types.js'
import { recordWalletOrderPayment } from '../src/finance/wallet.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const digest = 'a'.repeat(64)
let db: Kysely<Database>
let adminId: string

interface CatalogFixture {
  productId: string
  variantId: string
  productName: string
  skuCode: string
  productType: ProductType
  salePrice: string
  inventoryMode: ProductInventoryMode
  fulfillmentMethod: FulfillmentMethod
  skuSnapshot: OrderSkuOptionSnapshot[]
}

interface OrderFixture {
  id: string
  itemId: string
  idempotencyKey: string
  totalAmount: string
}

async function createCustomer(suffix = randomUUID().slice(0, 8), overrides: {
  email?: string | null
  phone?: string | null
  status?: 'active' | 'disabled'
} = {}): Promise<string> {
  const id = randomUUID()
  await db.insertInto('customers').values({
    id,
    username: `customer-${suffix}`,
    password_hash: 'test-only-password-hash',
    email: overrides.email === undefined ? `customer-${suffix}@example.test` : overrides.email,
    email_verified_at: null,
    phone: overrides.phone ?? null,
    phone_verified_at: null,
    status: overrides.status ?? 'active',
  }).execute()
  return id
}

async function createCatalog(options: {
  name?: string
  salePrice?: string
  stock?: number
  inventoryMode?: ProductInventoryMode
  fulfillmentMethod?: FulfillmentMethod
  productType?: ProductType
} = {}): Promise<CatalogFixture> {
  const productId = randomUUID()
  const variantId = randomUUID()
  const productName = options.name ?? `交易测试商品-${productId.slice(0, 8)}`
  const skuCode = `SKU-${variantId.slice(0, 8)}`
  const salePrice = options.salePrice ?? '10.00'
  const inventoryMode = options.inventoryMode ?? 'quantity'
  const stock = options.stock ?? 5
  const fulfillmentMethod = options.fulfillmentMethod ?? 'manual'
  const productType = options.productType ?? 'digital'

  await db.transaction().execute(async (trx) => {
    await trx.insertInto('products').values({
      id: productId,
      name: productName,
      description: 'PostgreSQL commerce foundation fixture',
      product_type: productType,
      status: 'active',
    }).execute()
    await trx.insertInto('product_variants').values({
      id: variantId,
      product_id: productId,
      sku_code: skuCode,
      combination_key: '',
      sale_price: salePrice,
      compare_at_price: null,
      cost_price: null,
      enabled: true,
      retired_at: null,
      inventory_mode: null,
      inventory_revision: 0,
    }).execute()
    await trx.updateTable('product_variants').set({ inventory_mode: inventoryMode, inventory_revision: 1 })
      .where('id', '=', variantId).execute()
    if (inventoryMode === 'quantity') {
      await trx.insertInto('product_variant_quantity_inventory').values({
        product_id: productId,
        product_variant_id: variantId,
        stocked: stock,
        reserved: 0,
      }).execute()
      if (stock > 0) {
        await trx.insertInto('product_variant_inventory_adjustments').values({
          id: randomUUID(),
          product_id: productId,
          product_variant_id: variantId,
          operation_id: randomUUID(),
          administrator_id: adminId,
          action: 'increase',
          requested_quantity: stock,
          quantity_before: 0,
          quantity_after: stock,
          quantity_delta: stock,
          inventory_revision: 1,
          reason: 'Integration test fixture stock',
        }).execute()
      }
    }
    await trx.insertInto('product_variant_fulfillment').values({
      product_variant_id: variantId,
      method: fulfillmentMethod,
    }).execute()
  })

  return { productId, variantId, productName, skuCode, productType, salePrice, inventoryMode, fulfillmentMethod, skuSnapshot: [] }
}

async function createOrder(options: {
  catalog: CatalogFixture
  customerId?: string | null
  guestSessionId?: string | null
  quantity?: number
  totalAmount?: string
  idempotencyKey?: string
}): Promise<OrderFixture> {
  const id = randomUUID()
  const itemId = randomUUID()
  const idempotencyKey = options.idempotencyKey ?? randomUUID()
  const quantity = options.quantity ?? 1
  const totalAmount = options.totalAmount ?? options.catalog.salePrice
  const customerId = options.customerId ?? null
  const guestSessionId = options.guestSessionId ?? null
  const catalog = options.catalog
  if (catalog.inventoryMode !== 'quantity' && catalog.inventoryMode !== 'unlimited') {
    throw new Error('Fixture cannot create an order from an unready inventory mode')
  }

  await db.transaction().execute(async (trx) => {
    await trx.selectFrom('products').select('id').where('id', '=', catalog.productId).forUpdate().executeTakeFirstOrThrow()
    await trx.selectFrom('product_variants').select('id').where('id', '=', catalog.variantId).forUpdate().executeTakeFirstOrThrow()
    await trx.insertInto('orders').values({
      id,
      customer_id: customerId,
      guest_order_session_id: guestSessionId,
      idempotency_key: idempotencyKey,
      request_sha256: digest,
      total_amount: totalAmount,
      unpaid_expires_at: new Date(Date.now() + 60_000),
      history_hidden_at: null,
      history_hidden_by_admin_id: null,
      history_hidden_reason: null,
    }).execute()
    await trx.insertInto('order_items').values({
      id: itemId,
      order_id: id,
      product_id: catalog.productId,
      product_variant_id: catalog.variantId,
      product_name_snapshot: catalog.productName,
      product_type_snapshot: catalog.productType,
      sku_code_snapshot: catalog.skuCode,
      sku_snapshot: JSON.stringify(catalog.skuSnapshot),
      inventory_mode_snapshot: catalog.inventoryMode,
      fulfillment_method_snapshot: catalog.fulfillmentMethod,
      unit_price: catalog.salePrice,
      quantity,
      line_amount: totalAmount,
    }).execute()
    if (catalog.inventoryMode === 'quantity') {
      await trx.insertInto('order_inventory_reservations').values({
        id: randomUUID(),
        order_item_id: itemId,
        product_id: catalog.productId,
        product_variant_id: catalog.variantId,
        quantity,
      }).execute()
    }
    await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', id).execute()
  })
  return { id, itemId, idempotencyKey, totalAmount }
}

async function addWalletCredit(customerId: string, bucket: 'cash' | 'gift', amount: string): Promise<void> {
  const operationId = randomUUID()
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom('wallet_accounts').select('customer_id').where('customer_id', '=', customerId)
      .forUpdate().executeTakeFirstOrThrow()
    await trx.insertInto('wallet_operations').values({
      id: operationId,
      customer_id: customerId,
      operation_type: bucket === 'gift' ? 'gift' : 'adjustment',
      request_sha256: digest,
      actor_admin_id: adminId,
    }).execute()
    await trx.insertInto('wallet_ledger_entries').values({
      id: randomUUID(),
      wallet_operation_id: operationId,
      line_no: 1,
      customer_id: customerId,
      bucket,
      action: 'credit_available',
      amount,
      payment_attempt_id: null,
      refund_allocation_id: null,
      withdrawal_id: null,
    }).execute()
  })
}

async function createExternalAttempt(trx: Transaction<Database>, orderId: string, amount: string, options: {
  expiresAt?: Date
  providerTransactionId?: string
} = {}): Promise<{ attemptId: string; providerTransactionId: string }> {
  const attemptId = randomUUID()
  const providerTransactionId = options.providerTransactionId ?? `provider-txn-${randomUUID()}`
  await trx.insertInto('payment_attempts').values({
    id: attemptId,
    idempotency_key: randomUUID(),
    request_sha256: digest,
    order_id: orderId,
    topup_customer_id: null,
    source: 'external',
    amount,
    provider: 'epay-compatible',
    provider_payment_id: `provider-payment-${attemptId}`,
    wallet_operation_id: null,
    expires_at: options.expiresAt ?? new Date(Date.now() + 15 * 60_000),
    completed_at: null,
  }).execute()
  await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
  await trx.insertInto('payment_receipts').values({
    id: randomUUID(),
    payment_attempt_id: attemptId,
    source_bucket: 'external',
    provider: 'epay-compatible',
    provider_transaction_id: providerTransactionId,
    wallet_operation_id: null,
    wallet_line_no: null,
    amount,
  }).execute()
  return { attemptId, providerTransactionId }
}

beforeAll(async () => {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL must point to a dedicated PostgreSQL database ending in _test')
  const databaseUrl = new URL(testDatabaseUrl)
  if (!databaseUrl.pathname.slice(1).endsWith('_test')) {
    throw new Error('Refusing to run commerce integration tests unless TEST_DATABASE_URL names a database ending in _test')
  }
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`drop schema public cascade`.execute(db)
  await sql`create schema public`.execute(db)
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const migrated = await migrator.migrateToLatest()
  if (migrated.error) throw migrated.error
  adminId = randomUUID()
  await db.insertInto('admin_users').values({
    id: adminId,
    email: 'commerce-test-admin@example.test',
    password_hash: 'test-only-password-hash',
  }).execute()
})

afterAll(async () => {
  if (db) await db.destroy()
})

afterEach(async () => {
  if (db) await db.updateTable('storefront_customer_policy').set({
    require_email: false,
    require_phone: false,
    guest_checkout_enabled: false,
    guest_free_claim_enabled: false,
    unpaid_order_timeout_minutes: 15,
  }).execute()
})

describe('Stage ④-1 commerce foundation with PostgreSQL 18', () => {
  it('keeps customer and guest identities separate and applies account and guest policies', async () => {
    const defaults = await db.selectFrom('storefront_customer_policy').selectAll().executeTakeFirstOrThrow()
    expect(defaults).toMatchObject({
      require_email: false,
      require_phone: false,
      guest_checkout_enabled: false,
      guest_free_claim_enabled: false,
      unpaid_order_timeout_minutes: 15,
    })
    await expect(db.deleteFrom('storefront_customer_policy').execute()).rejects.toBeDefined()
    await expect(sql`TRUNCATE TABLE storefront_customer_policy`.execute(db)).rejects.toBeDefined()
    const customerId = await createCustomer('identity-one')
    const account = await db.selectFrom('wallet_accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirst()
    expect(account).toMatchObject({ cash_available: '0.00', cash_frozen: '0.00', gift_available: '0.00', gift_frozen: '0.00' })
    await expect(db.insertInto('customers').values({
      id: randomUUID(), username: 'CUSTOMER-IDENTITY-ONE', password_hash: 'hash',
      email: 'different@example.test', email_verified_at: null, phone: null, phone_verified_at: null, status: 'active',
    }).execute()).rejects.toBeDefined()

    const free = await createCatalog({ name: '免费领取', salePrice: '0.00', inventoryMode: 'unlimited' })
    const sessionId = randomUUID()
    await db.insertInto('guest_order_sessions').values({
      id: sessionId,
      token_hash: 'b'.repeat(64),
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null,
    }).execute()
    await expect(createOrder({ catalog: free, guestSessionId: sessionId, totalAmount: '0.00' })).rejects.toBeDefined()
    await db.updateTable('storefront_customer_policy').set({ guest_free_claim_enabled: true }).execute()
    const guestFreeOrder = await createOrder({ catalog: free, guestSessionId: sessionId, totalAmount: '0.00' })
    expect((await db.selectFrom('orders').select(['status', 'unpaid_expires_at'])
      .where('id', '=', guestFreeOrder.id).executeTakeFirstOrThrow())).toEqual({ status: 'processing', unpaid_expires_at: null })
    await expect(db.insertInto('payment_attempts').values({
      id: randomUUID(), idempotency_key: randomUUID(), request_sha256: digest, order_id: guestFreeOrder.id,
      topup_customer_id: null, source: 'external', amount: '0.00', provider: 'epay-compatible',
      provider_payment_id: null, wallet_operation_id: null, expires_at: new Date(Date.now() + 60_000), completed_at: null,
    }).execute()).rejects.toBeDefined()

    await db.updateTable('storefront_customer_policy').set({ require_email: true, require_phone: true }).execute()
    await expect(createCustomer('missing-policy-data', { email: 'required@example.test' })).rejects.toBeDefined()
    const retained = await createCustomer('policy-complete', { email: 'required@example.test', phone: '+8613800000000' })
    await db.updateTable('customers').set({ status: 'deleted', username: null, password_hash: null, email: null, email_verified_at: null, phone: null, phone_verified_at: null })
      .where('id', '=', retained).execute()
    expect(await db.selectFrom('wallet_accounts').select('customer_id').where('customer_id', '=', retained).executeTakeFirst()).toBeDefined()
    await expect(db.updateTable('customers').set({ status: 'active', username: 'restored-account' })
      .where('id', '=', retained).execute()).rejects.toMatchObject({ constraint: 'customers_deleted_terminal' })
  })

  it('applies contact requirements only to new registrations and uniquely reserves verified contacts', async () => {
    const legacy = await createCustomer('legacy-no-contact', { email: null, phone: null })
    await db.updateTable('storefront_customer_policy').set({ require_email: true, require_phone: true }).execute()

    await expect(db.updateTable('customers').set({ status: 'disabled' }).where('id', '=', legacy).execute()).resolves.toBeDefined()
    await expect(db.updateTable('customers').set({ status: 'active' }).where('id', '=', legacy).execute()).resolves.toBeDefined()

    const sharedEmail = 'shared-unverified@example.test'
    const first = await createCustomer('unverified-email-one', { email: sharedEmail, phone: '+8613800000001' })
    const second = await createCustomer('unverified-email-two', { email: sharedEmail, phone: '+8613800000002' })
    const verifiedAt = new Date()
    await db.updateTable('customers').set({ email_verified_at: verifiedAt }).where('id', '=', first).execute()
    await expect(db.updateTable('customers').set({ email_verified_at: verifiedAt }).where('id', '=', second).execute()).rejects.toBeDefined()

    await db.updateTable('customers').set({ email: 'changed-contact@example.test' }).where('id', '=', first).execute()
    expect((await db.selectFrom('customers').select('email_verified_at').where('id', '=', first).executeTakeFirstOrThrow())
      .email_verified_at).toBeNull()
  })

  it('locks order snapshots to current catalog state and protects historical product and SKU references', async () => {
    const customerId = await createCustomer('snapshot')
    const catalog = await createCatalog({ name: '快照商品', salePrice: '12.50' })
    const order = await createOrder({ catalog, customerId, totalAmount: '12.50' })
    await db.updateTable('products').set({ name: '新商品名称' }).where('id', '=', catalog.productId).execute()
    await db.updateTable('product_variants').set({ sale_price: '99.00' }).where('id', '=', catalog.variantId).execute()
    const line = await db.selectFrom('order_items').selectAll().where('id', '=', order.itemId).executeTakeFirstOrThrow()
    expect(line).toMatchObject({ product_name_snapshot: '快照商品', unit_price: '12.50', line_amount: '12.50', sku_snapshot: [] })
    await expect(db.updateTable('products').set({ product_type: 'physical' }).where('id', '=', catalog.productId).execute()).rejects.toBeDefined()
    await expect(db.updateTable('order_items').set({ unit_price: '1.00' }).where('id', '=', order.itemId).execute()).rejects.toBeDefined()
    await expect(db.deleteFrom('product_variants').where('id', '=', catalog.variantId).execute()).rejects.toBeDefined()
    await expect(db.deleteFrom('products').where('id', '=', catalog.productId).execute()).rejects.toBeDefined()
    await expect(db.deleteFrom('orders').where('id', '=', order.id).execute()).rejects.toBeDefined()
    await expect(sql`TRUNCATE TABLE orders`.execute(db)).rejects.toBeDefined()
  })

  it('seals order items at transaction commit, including paid and zero-value orders', async () => {
    const customerId = await createCustomer('sealed-order-items')
    const catalog = await createCatalog({ name: '已付款订单', salePrice: '10.00' })
    const paidOrder = await createOrder({ catalog, customerId, totalAmount: '10.00' })
    await db.transaction().execute((trx) => createExternalAttempt(trx, paidOrder.id, '10.00'))
    const freeCatalog = await createCatalog({ name: '免费附加项', salePrice: '0.00', inventoryMode: 'unlimited' })

    await expect(db.transaction().execute(async (trx) => {
      await trx.insertInto('order_items').values({
        id: randomUUID(), order_id: paidOrder.id, product_id: freeCatalog.productId,
        product_variant_id: freeCatalog.variantId, product_name_snapshot: freeCatalog.productName,
        product_type_snapshot: freeCatalog.productType, sku_code_snapshot: freeCatalog.skuCode,
        sku_snapshot: JSON.stringify(freeCatalog.skuSnapshot), inventory_mode_snapshot: freeCatalog.inventoryMode,
        fulfillment_method_snapshot: freeCatalog.fulfillmentMethod, unit_price: '0.00', quantity: 1, line_amount: '0.00',
      }).execute()
    })).rejects.toBeDefined()

    const freeOrder = await createOrder({ catalog: freeCatalog, customerId, totalAmount: '0.00' })
    const anotherFreeCatalog = await createCatalog({ name: '另一免费附加项', salePrice: '0.00', inventoryMode: 'unlimited' })
    await expect(db.transaction().execute(async (trx) => {
      await trx.insertInto('order_items').values({
        id: randomUUID(), order_id: freeOrder.id, product_id: anotherFreeCatalog.productId,
        product_variant_id: anotherFreeCatalog.variantId, product_name_snapshot: anotherFreeCatalog.productName,
        product_type_snapshot: anotherFreeCatalog.productType, sku_code_snapshot: anotherFreeCatalog.skuCode,
        sku_snapshot: JSON.stringify(anotherFreeCatalog.skuSnapshot), inventory_mode_snapshot: anotherFreeCatalog.inventoryMode,
        fulfillment_method_snapshot: anotherFreeCatalog.fulfillmentMethod, unit_price: '0.00', quantity: 1, line_amount: '0.00',
      }).execute()
    })).rejects.toBeDefined()
  })

  it('requires unfulfilled order-item and unconfirmed payment-attempt initial states', async () => {
    const customerId = await createCustomer('initial-states')
    const catalog = await createCatalog({ name: '初始状态保护', salePrice: '10.00' })
    const orderId = randomUUID()
    const itemId = randomUUID()
    await expect(db.transaction().execute(async (trx) => {
      await trx.insertInto('orders').values({
        id: orderId, customer_id: customerId, guest_order_session_id: null,
        idempotency_key: randomUUID(), request_sha256: digest, total_amount: '10.00',
        unpaid_expires_at: new Date(Date.now() + 60_000), history_hidden_at: null,
        history_hidden_by_admin_id: null, history_hidden_reason: null,
      }).execute()
      await trx.insertInto('order_items').values({
        id: itemId, order_id: orderId, product_id: catalog.productId, product_variant_id: catalog.variantId,
        product_name_snapshot: catalog.productName, product_type_snapshot: catalog.productType,
        sku_code_snapshot: catalog.skuCode, sku_snapshot: JSON.stringify(catalog.skuSnapshot),
        inventory_mode_snapshot: catalog.inventoryMode, fulfillment_method_snapshot: catalog.fulfillmentMethod,
        unit_price: '10.00', quantity: 1, line_amount: '10.00', fulfillment_status: 'completed',
        fulfilled_quantity: 1, fulfillment_reserved_quantity: 0,
      }).execute()
    })).rejects.toMatchObject({ constraint: 'order_items_initial_fulfillment_state' })

    const order = await createOrder({ catalog, customerId, totalAmount: '10.00' })
    await expect(db.insertInto('payment_attempts').values({
      id: randomUUID(), idempotency_key: randomUUID(), request_sha256: digest,
      order_id: order.id, topup_customer_id: null, source: 'external', amount: '10.00',
      status: 'succeeded', provider: 'epay-compatible', provider_payment_id: 'forged-success',
      wallet_operation_id: null, expires_at: new Date(Date.now() + 60_000), completed_at: new Date(),
    }).execute()).rejects.toMatchObject({ constraint: 'payment_attempts_initial_state' })
  })

  it('snapshots the SKU option group and value labels as well as their identities', async () => {
    const customerId = await createCustomer('sku-options')
    const catalog = await createCatalog({ name: '规格快照商品', salePrice: '7.00' })
    const groupId = randomUUID()
    const valueId = randomUUID()
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('product_option_groups').values({
        id: groupId, product_id: catalog.productId, name: '版本', sort_order: 0, enabled: true,
      }).execute()
      await trx.insertInto('product_option_values').values({
        id: valueId, product_id: catalog.productId, option_group_id: groupId,
        name: '标准版', sort_order: 0, enabled: true,
      }).execute()
      await trx.insertInto('product_variant_option_values').values({
        product_id: catalog.productId, product_variant_id: catalog.variantId,
        option_group_id: groupId, option_value_id: valueId,
      }).execute()
      await trx.updateTable('product_variants').set({ combination_key: `v1:${valueId}` })
        .where('id', '=', catalog.variantId).execute()
    })
    catalog.skuSnapshot = [{ groupId, groupName: '版本', valueId, valueName: '标准版' }]
    const order = await createOrder({ catalog, customerId, totalAmount: '7.00' })
    await db.updateTable('product_option_groups').set({ name: '产品版本' }).where('id', '=', groupId).execute()
    await db.updateTable('product_option_values').set({ name: '高级版' }).where('id', '=', valueId).execute()
    expect((await db.selectFrom('order_items').select('sku_snapshot').where('id', '=', order.itemId)
      .executeTakeFirstOrThrow()).sku_snapshot).toEqual(catalog.skuSnapshot)
  })

  it('reserves quantity atomically, serializes concurrent buyers, and keeps D3 inventory revisions in sync', async () => {
    const customerId = await createCustomer('inventory')
    const catalog = await createCatalog({ name: '并发库存', salePrice: '10.00', stock: 5 })
    const initial = await db.selectFrom('product_variants').select('inventory_revision').where('id', '=', catalog.variantId).executeTakeFirstOrThrow()
    const attempts = await Promise.allSettled([
      createOrder({ catalog, customerId, quantity: 4, totalAmount: '40.00' }),
      createOrder({ catalog, customerId, quantity: 4, totalAmount: '40.00' }),
    ])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const stock = await db.selectFrom('product_variant_quantity_inventory').selectAll()
      .where('product_variant_id', '=', catalog.variantId).executeTakeFirstOrThrow()
    expect(stock).toMatchObject({ stocked: 5, reserved: 4 })
    let current = await db.selectFrom('product_variants').select('inventory_revision').where('id', '=', catalog.variantId).executeTakeFirstOrThrow()
    expect(current.inventory_revision).toBe(initial.inventory_revision + 1)
    await expect(db.updateTable('product_variant_quantity_inventory').set({ reserved: 5 })
      .where('product_variant_id', '=', catalog.variantId).execute()).rejects.toBeDefined()
    await expect(db.updateTable('product_variant_quantity_inventory').set({ stocked: 3 })
      .where('product_variant_id', '=', catalog.variantId).execute()).rejects.toBeDefined()

    await db.transaction().execute(async (trx) => {
      const variant = await trx.selectFrom('product_variants').select('inventory_revision')
        .where('id', '=', catalog.variantId).forUpdate().executeTakeFirstOrThrow()
      const inventory = await trx.selectFrom('product_variant_quantity_inventory').select('stocked')
        .where('product_variant_id', '=', catalog.variantId).forUpdate().executeTakeFirstOrThrow()
      const after = inventory.stocked + 1
      const revision = variant.inventory_revision + 1
      await trx.updateTable('product_variant_quantity_inventory').set({ stocked: after })
        .where('product_variant_id', '=', catalog.variantId).execute()
      await trx.updateTable('product_variants').set({ inventory_revision: revision })
        .where('id', '=', catalog.variantId).execute()
      await trx.insertInto('product_variant_inventory_adjustments').values({
        id: randomUUID(), product_id: catalog.productId, product_variant_id: catalog.variantId,
        operation_id: randomUUID(), administrator_id: adminId, action: 'increase', requested_quantity: 1,
        quantity_before: inventory.stocked, quantity_after: after, quantity_delta: 1,
        inventory_revision: revision, reason: 'Serialized inventory adjustment test',
      }).execute()
    })
    const winningOrder = attempts.find((result) => result.status === 'fulfilled')
    if (!winningOrder || winningOrder.status !== 'fulfilled') throw new Error('Expected one concurrent reservation to succeed')
    await db.updateTable('orders').set({ status: 'closed' }).where('id', '=', winningOrder.value.id).execute()
    await db.updateTable('orders').set({ status: 'closed' }).where('id', '=', winningOrder.value.id).execute()
    const released = await db.selectFrom('product_variant_quantity_inventory').selectAll()
      .where('product_variant_id', '=', catalog.variantId).executeTakeFirstOrThrow()
    expect(released).toMatchObject({ stocked: 6, reserved: 0 })
    current = await db.selectFrom('product_variants').select('inventory_revision').where('id', '=', catalog.variantId).executeTakeFirstOrThrow()
    expect(current.inventory_revision).toBe(initial.inventory_revision + 3)
    const reservation = await db.selectFrom('order_inventory_reservations').select('id')
      .where('order_item_id', '=', winningOrder.value.itemId).executeTakeFirstOrThrow()
    await expect(db.insertInto('order_inventory_events').values({
      id: randomUUID(), reservation_id: reservation.id, operation_id: randomUUID(), action: 'release', quantity: 4,
    }).execute()).rejects.toBeDefined()
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.variantId).executeTakeFirstOrThrow()).reserved).toBe(0)
  })

  it('records idempotent split-wallet payments with exact gift-first allocation and immutable receipts', async () => {
    const customerId = await createCustomer('wallet-pay')
    await addWalletCredit(customerId, 'gift', '30.00')
    await addWalletCredit(customerId, 'cash', '100.00')
    const catalog = await createCatalog({ name: '混合支付商品', salePrice: '100.00', stock: 2 })
    const order = await createOrder({ catalog, customerId, totalAmount: '100.00' })
    const operationId = randomUUID()
    const first = await db.transaction().execute((trx) => recordWalletOrderPayment(trx, {
      customerId, orderId: order.id, operationId, requestSha256: digest, amount: '80.00', externalProvider: 'epay-compatible',
    }))
    expect(first).toMatchObject({ giftAmount: '30.00', cashAmount: '50.00' })
    const replay = await db.transaction().execute((trx) => recordWalletOrderPayment(trx, {
      customerId, orderId: order.id, operationId, requestSha256: digest, amount: '80.00', externalProvider: 'epay-compatible',
    }))
    expect(replay).toEqual(first)
    await expect(db.transaction().execute((trx) => recordWalletOrderPayment(trx, {
      customerId, orderId: order.id, operationId, requestSha256: digest, amount: '79.00', externalProvider: 'epay-compatible',
    }))).rejects.toThrow('WALLET_PAYMENT_IDEMPOTENCY_CONFLICT')
    expect(await db.selectFrom('payment_attempts').select('id').where('idempotency_key', '=', operationId).execute()).toHaveLength(1)
    expect(await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', first.paymentAttemptId).execute()).toHaveLength(0)
    const account = await db.selectFrom('wallet_accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirstOrThrow()
    expect(account).toMatchObject({ cash_available: '50.00', gift_available: '0.00', cash_frozen: '50.00', gift_frozen: '30.00' })
    await expect(db.updateTable('wallet_accounts').set({ cash_available: '500.00' }).where('customer_id', '=', customerId).execute()).rejects.toBeDefined()
    await expect(db.updateTable('wallet_ledger_entries').set({ amount: '1.00' })
      .where('wallet_operation_id', '=', operationId).execute()).rejects.toBeDefined()
    await expect(sql`TRUNCATE TABLE wallet_ledger_entries`.execute(db)).rejects.toBeDefined()

    const externalTransactionId = `external-${randomUUID()}`
    await db.insertInto('payment_receipts').values({
      id: randomUUID(), payment_attempt_id: first.paymentAttemptId, source_bucket: 'external',
      provider: 'epay-compatible', provider_transaction_id: externalTransactionId,
      wallet_operation_id: null, wallet_line_no: null, amount: '20.00',
    }).execute()
    const payment = await db.selectFrom('order_financial_status').selectAll().where('order_id', '=', order.id).executeTakeFirstOrThrow()
    expect(payment).toMatchObject({ payment_status: 'paid', paid_amount: '100.00' })
    expect((await db.selectFrom('orders').select('status').where('id', '=', order.id).executeTakeFirstOrThrow()).status).toBe('processing')
    const walletSettlementAttemptId = (await sql<{ id: string }>`
      SELECT attempt.id FROM payment_attempts AS attempt
      JOIN wallet_operations AS operation ON operation.id = attempt.wallet_operation_id
      WHERE operation.resolves_operation_id = ${operationId}
        AND operation.operation_type = 'order_payment_settlement'
    `.execute(db)).rows[0]?.id
    if (!walletSettlementAttemptId) throw new Error('Expected the external success to settle the wallet hold')
    expect(await db.selectFrom('payment_receipts').select('id').where('payment_attempt_id', '=', walletSettlementAttemptId).execute())
      .toHaveLength(2)
    await expect(db.insertInto('payment_receipts').values({
      id: randomUUID(), payment_attempt_id: first.paymentAttemptId, source_bucket: 'external',
      provider: 'epay-compatible', provider_transaction_id: externalTransactionId,
      wallet_operation_id: null, wallet_line_no: null, amount: '20.00',
    }).execute()).rejects.toBeDefined()

    await expect(db.insertInto('order_refunds').values({
      id: randomUUID(), order_id: order.id, idempotency_key: randomUUID(), request_sha256: digest,
      amount: '1.00', status: 'succeeded',
    }).execute()).rejects.toMatchObject({ constraint: 'order_refunds_initial_state' })
    await expect(db.transaction().execute(async (trx) => {
      const giftReceipt = await trx.selectFrom('payment_receipts').select('id')
        .where('payment_attempt_id', '=', walletSettlementAttemptId).where('source_bucket', '=', 'gift').executeTakeFirstOrThrow()
      const forgedRefundId = randomUUID()
      await trx.insertInto('order_refunds').values({
        id: forgedRefundId, order_id: order.id, idempotency_key: randomUUID(), request_sha256: digest,
        amount: '1.00',
      }).execute()
      await trx.updateTable('order_refunds').set({ status: 'approved' }).where('id', '=', forgedRefundId).execute()
      await trx.updateTable('order_refunds').set({ status: 'processing' }).where('id', '=', forgedRefundId).execute()
      await trx.insertInto('order_refund_allocations').values({
        id: randomUUID(), refund_id: forgedRefundId, source_payment_receipt_id: giftReceipt.id,
        operation_id: randomUUID(), request_sha256: digest, destination: 'gift_balance', amount: '1.00',
        status: 'succeeded', provider: null, provider_refund_id: null, completed_at: new Date(),
      }).execute()
    })).rejects.toMatchObject({ constraint: 'order_refund_allocation_initial_state' })

    const refundId = randomUUID()
    const allocationId = randomUUID()
    await db.transaction().execute(async (trx) => {
      const giftReceipt = await trx.selectFrom('payment_receipts').select('id')
        .where('payment_attempt_id', '=', walletSettlementAttemptId).where('source_bucket', '=', 'gift').executeTakeFirstOrThrow()
      await trx.insertInto('order_refunds').values({
        id: refundId, order_id: order.id, idempotency_key: randomUUID(), request_sha256: digest, amount: '30.00',
      }).execute()
      await trx.updateTable('order_refunds').set({ status: 'approved' }).where('id', '=', refundId).execute()
      await trx.updateTable('order_refunds').set({ status: 'processing' }).where('id', '=', refundId).execute()
      await trx.insertInto('order_refund_allocations').values({
        id: allocationId, refund_id: refundId, source_payment_receipt_id: giftReceipt.id,
        operation_id: randomUUID(), request_sha256: digest, destination: 'gift_balance', amount: '30.00',
        provider: null, provider_refund_id: null, completed_at: null,
      }).execute()
      await trx.updateTable('order_refund_allocations').set({ status: 'succeeded' })
        .where('id', '=', allocationId).execute()
      await trx.updateTable('order_refunds').set({ status: 'succeeded' }).where('id', '=', refundId).execute()
    })
    const refundedAccount = await db.selectFrom('wallet_accounts').selectAll()
      .where('customer_id', '=', customerId).executeTakeFirstOrThrow()
    expect(refundedAccount).toMatchObject({ cash_available: '50.00', gift_available: '30.00' })
    expect((await db.selectFrom('order_financial_status').select(['refunded_amount', 'payment_status', 'refund_status'])
      .where('order_id', '=', order.id).executeTakeFirstOrThrow())).toMatchObject({
      refunded_amount: '30.00', payment_status: 'partially_refunded', refund_status: 'partially_refunded',
    })
    const excessRefundId = randomUUID()
    await expect(db.transaction().execute(async (trx) => {
      const giftReceipt = await trx.selectFrom('payment_receipts').select('id')
        .where('payment_attempt_id', '=', walletSettlementAttemptId).where('source_bucket', '=', 'gift').executeTakeFirstOrThrow()
      await trx.insertInto('order_refunds').values({
        id: excessRefundId, order_id: order.id, idempotency_key: randomUUID(), request_sha256: digest, amount: '1.00',
      }).execute()
      await trx.updateTable('order_refunds').set({ status: 'approved' }).where('id', '=', excessRefundId).execute()
      await trx.insertInto('order_refund_allocations').values({
        id: randomUUID(), refund_id: excessRefundId, source_payment_receipt_id: giftReceipt.id,
        operation_id: randomUUID(), request_sha256: digest, destination: 'cash_balance', amount: '1.00',
        provider: null, provider_refund_id: null, completed_at: null,
      }).execute()
    })).rejects.toBeDefined()
    await expect(db.transaction().execute(async (trx) => {
      const giftReceipt = await trx.selectFrom('payment_receipts').select('id')
        .where('payment_attempt_id', '=', walletSettlementAttemptId).where('source_bucket', '=', 'gift').executeTakeFirstOrThrow()
      const refundId = randomUUID()
      await trx.insertInto('order_refunds').values({
        id: refundId, order_id: order.id, idempotency_key: randomUUID(), request_sha256: digest, amount: '1.00',
      }).execute()
      await trx.updateTable('order_refunds').set({ status: 'approved' }).where('id', '=', refundId).execute()
      await trx.insertInto('order_refund_allocations').values({
        id: randomUUID(), refund_id: refundId, source_payment_receipt_id: giftReceipt.id,
        operation_id: randomUUID(), request_sha256: digest, destination: 'gift_balance', amount: '1.00',
        provider: null, provider_refund_id: null, completed_at: null,
      }).execute()
    })).rejects.toBeDefined()
  })

  it('freezes split wallet funds until an external attempt succeeds or fails', async () => {
    const customerId = await createCustomer('wallet-hold')
    await addWalletCredit(customerId, 'gift', '30.00')
    await addWalletCredit(customerId, 'cash', '50.00')
    const catalog = await createCatalog({ name: '待外部支付', salePrice: '100.00', stock: 2 })
    const order = await createOrder({ catalog, customerId, totalAmount: '100.00' })
    const operationId = randomUUID()
    const wallet = await db.transaction().execute((trx) => recordWalletOrderPayment(trx, {
      customerId, orderId: order.id, operationId, requestSha256: digest, amount: '80.00', externalProvider: 'epay-compatible',
    }))

    expect(await db.selectFrom('wallet_accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirstOrThrow())
      .toMatchObject({ gift_available: '0.00', cash_available: '0.00', gift_frozen: '30.00', cash_frozen: '50.00' })
    expect((await sql<{ source: string; amount: string; status: string; wallet_hold_operation_id: string | null }>`
      SELECT source, amount, status, wallet_hold_operation_id
      FROM payment_attempts WHERE idempotency_key = ${operationId}
    `.execute(db)).rows[0]).toMatchObject({
      source: 'external', amount: '20.00', status: 'pending', wallet_hold_operation_id: operationId,
    })

    await db.updateTable('payment_attempts').set({ status: 'failed' }).where('id', '=', wallet.paymentAttemptId).execute()
    await db.updateTable('payment_attempts').set({ status: 'failed' }).where('id', '=', wallet.paymentAttemptId).execute()
    expect(await db.selectFrom('wallet_accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirstOrThrow())
      .toMatchObject({ gift_available: '30.00', cash_available: '50.00', gift_frozen: '0.00', cash_frozen: '0.00' })
    expect(await db.selectFrom('wallet_ledger_entries').select('action').where('wallet_operation_id', '=', operationId).execute())
      .toHaveLength(2)
  })

  it('settles a split wallet hold once on external success and rejects a replayed receipt', async () => {
    const customerId = await createCustomer('wallet-hold-success')
    await addWalletCredit(customerId, 'gift', '30.00')
    await addWalletCredit(customerId, 'cash', '50.00')
    const catalog = await createCatalog({ name: '外部支付成功', salePrice: '100.00', stock: 2 })
    const order = await createOrder({ catalog, customerId, totalAmount: '100.00' })
    const operationId = randomUUID()
    const wallet = await db.transaction().execute((trx) => recordWalletOrderPayment(trx, {
      customerId, orderId: order.id, operationId, requestSha256: digest, amount: '80.00', externalProvider: 'epay-compatible',
    }))
    const before = await db.selectFrom('payment_attempts').select('id').where('idempotency_key', '=', operationId)
      .executeTakeFirstOrThrow()
    const externalAttemptId = wallet.paymentAttemptId === before.id ? before.id : wallet.paymentAttemptId

    await db.transaction().execute(async (trx) => {
      await trx.insertInto('payment_receipts').values({
        id: randomUUID(), payment_attempt_id: externalAttemptId, source_bucket: 'external',
        provider: 'epay-compatible', provider_transaction_id: `wallet-hold-success-${randomUUID()}`,
        wallet_operation_id: null, wallet_line_no: null, amount: '20.00',
      }).execute()
    })

    expect(await db.selectFrom('orders').select('status').where('id', '=', order.id).executeTakeFirstOrThrow())
      .toEqual({ status: 'processing' })
    expect(await db.selectFrom('wallet_accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirstOrThrow())
      .toMatchObject({ gift_available: '0.00', cash_available: '0.00', gift_frozen: '0.00', cash_frozen: '0.00' })
    const settlementAttemptId = (await sql<{ id: string }>`
      SELECT attempt.id FROM payment_attempts AS attempt
      JOIN wallet_operations AS operation ON operation.id = attempt.wallet_operation_id
      WHERE operation.resolves_operation_id = ${operationId}
        AND operation.operation_type = 'order_payment_settlement'
    `.execute(db)).rows[0]?.id
    if (!settlementAttemptId) throw new Error('Expected the external success to settle the wallet hold')
    expect(await db.selectFrom('wallet_ledger_entries').select('action').where('payment_attempt_id', '=', settlementAttemptId)
      .where('action', '=', 'debit_frozen').execute()).toHaveLength(2)
    expect(await db.selectFrom('order_financial_status').select('payment_status').where('order_id', '=', order.id)
      .executeTakeFirstOrThrow()).toEqual({ payment_status: 'paid' })
    await expect(db.updateTable('payment_attempts').set({ status: 'failed' }).where('id', '=', externalAttemptId).execute())
      .rejects.toBeDefined()
    await expect(db.insertInto('payment_receipts').values({
      id: randomUUID(), payment_attempt_id: externalAttemptId, source_bucket: 'external',
      provider: 'epay-compatible', provider_transaction_id: `wallet-hold-replay-${randomUUID()}`,
      wallet_operation_id: null, wallet_line_no: null, amount: '20.00',
    }).execute()).rejects.toBeDefined()
  })

  it('settles a fully wallet-funded order in the same transaction without an external attempt', async () => {
    const customerId = await createCustomer('wallet-direct-payment')
    await addWalletCredit(customerId, 'gift', '30.00')
    await addWalletCredit(customerId, 'cash', '50.00')
    const catalog = await createCatalog({ name: '全额余额付款', salePrice: '80.00' })
    const order = await createOrder({ catalog, customerId, totalAmount: '80.00' })
    const operationId = randomUUID()

    const result = await db.transaction().execute((trx) => recordWalletOrderPayment(trx, {
      customerId, orderId: order.id, operationId, requestSha256: digest, amount: '80.00',
    }))

    expect(result).toMatchObject({ giftAmount: '30.00', cashAmount: '50.00', externalAmount: '0.00' })
    expect(await db.selectFrom('orders').select('status').where('id', '=', order.id).executeTakeFirstOrThrow())
      .toEqual({ status: 'processing' })
    expect(await db.selectFrom('payment_attempts').select(['source', 'status'])
      .where('id', '=', result.paymentAttemptId).executeTakeFirstOrThrow()).toEqual({ source: 'wallet', status: 'succeeded' })
    expect(await db.selectFrom('payment_receipts').select('source_bucket')
      .where('payment_attempt_id', '=', result.paymentAttemptId).execute()).toEqual([
      { source_bucket: 'gift' }, { source_bucket: 'cash' },
    ])
    expect(await db.selectFrom('wallet_accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirstOrThrow())
      .toMatchObject({ gift_available: '0.00', cash_available: '0.00', gift_frozen: '0.00', cash_frozen: '0.00' })
  })

  it('serializes an external payment callback racing a split-wallet failure without stranding frozen funds', async () => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const customerId = await createCustomer(`wallet-hold-race-${iteration}`)
      await addWalletCredit(customerId, 'gift', '30.00')
      await addWalletCredit(customerId, 'cash', '50.00')
      const catalog = await createCatalog({ name: `外部支付回执并发-${iteration}`, salePrice: '100.00', stock: 2 })
      const order = await createOrder({ catalog, customerId, totalAmount: '100.00' })
      const operationId = randomUUID()
      const wallet = await db.transaction().execute((trx) => recordWalletOrderPayment(trx, {
        customerId, orderId: order.id, operationId, requestSha256: digest, amount: '80.00', externalProvider: 'epay-compatible',
      }))
      const outcomes = await Promise.allSettled([
        db.transaction().execute((trx) => trx.insertInto('payment_receipts').values({
          id: randomUUID(), payment_attempt_id: wallet.paymentAttemptId, source_bucket: 'external',
          provider: 'epay-compatible', provider_transaction_id: `wallet-hold-race-${randomUUID()}`,
          wallet_operation_id: null, wallet_line_no: null, amount: '20.00',
        }).execute()),
        db.updateTable('payment_attempts').set({ status: 'failed' }).where('id', '=', wallet.paymentAttemptId).execute(),
      ])

      expect(outcomes.flatMap((outcome) => outcome.status === 'rejected'
        && (outcome.reason as { code?: string }).code === '40P01'
        ? [{ message: (outcome.reason as Error).message, code: (outcome.reason as { code?: string }).code,
          detail: (outcome.reason as { detail?: string }).detail, where: (outcome.reason as { where?: string }).where }]
        : [])).toEqual([])
      const account = await db.selectFrom('wallet_accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirstOrThrow()
      expect(account.gift_frozen).toBe('0.00')
      expect(account.cash_frozen).toBe('0.00')
      expect([[account.gift_available, account.cash_available], ['0.00', '0.00']])
        .toContainEqual([account.gift_available, account.cash_available])
      expect((await sql<{ id: string }>`
        SELECT id FROM wallet_operations WHERE customer_id = ${customerId}
          AND operation_type IN ('order_payment_settlement', 'order_payment_release')
      `.execute(db)).rows).toHaveLength(1)
    }
  })

  it('unfreezes wallet funds atomically when a pending order is closed', async () => {
    const customerId = await createCustomer('wallet-hold-close')
    await addWalletCredit(customerId, 'gift', '15.00')
    const catalog = await createCatalog({ name: '关闭时释放冻结', salePrice: '20.00', stock: 2 })
    const order = await createOrder({ catalog, customerId, totalAmount: '20.00' })
    const operationId = randomUUID()
    const wallet = await db.transaction().execute((trx) => recordWalletOrderPayment(trx, {
      customerId, orderId: order.id, operationId, requestSha256: digest, amount: '15.00', externalProvider: 'epay-compatible',
    }))
    await db.updateTable('orders').set({ status: 'closed' }).where('id', '=', order.id).execute()
    expect(await db.selectFrom('wallet_accounts').select(['gift_available', 'gift_frozen'])
      .where('customer_id', '=', customerId).executeTakeFirstOrThrow()).toEqual({ gift_available: '15.00', gift_frozen: '0.00' })
    expect(await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.variantId).executeTakeFirstOrThrow()).toEqual({ reserved: 0 })
    await db.insertInto('payment_receipts').values({
      id: randomUUID(), payment_attempt_id: wallet.paymentAttemptId, source_bucket: 'external',
      provider: 'epay-compatible', provider_transaction_id: `wallet-hold-late-${randomUUID()}`,
      wallet_operation_id: null, wallet_line_no: null, amount: '5.00',
    }).execute()
    expect(await db.selectFrom('payment_receipts').select('disposition').where('payment_attempt_id', '=', wallet.paymentAttemptId)
      .executeTakeFirstOrThrow()).toEqual({ disposition: 'late' })
    expect(await db.selectFrom('wallet_accounts').select(['gift_available', 'gift_frozen'])
      .where('customer_id', '=', customerId).executeTakeFirstOrThrow()).toEqual({ gift_available: '15.00', gift_frozen: '0.00' })
  })

  it('does not close paid or in-flight fulfillment orders before their obligations resolve', async () => {
    const customerId = await createCustomer('paid-order-close')
    const catalog = await createCatalog({ name: '已付款不可直接关闭', salePrice: '10.00' })
    const paidOrder = await createOrder({ catalog, customerId, totalAmount: '10.00' })
    await db.transaction().execute((trx) => createExternalAttempt(trx, paidOrder.id, '10.00'))
    await expect(db.updateTable('orders').set({ status: 'closed' }).where('id', '=', paidOrder.id).execute())
      .rejects.toBeDefined()

    const freeCatalog = await createCatalog({ name: '发货进行中', salePrice: '0.00', inventoryMode: 'unlimited' })
    const freeOrder = await createOrder({ catalog: freeCatalog, customerId, totalAmount: '0.00' })
    await db.insertInto('order_item_fulfillment_attempts').values({
      id: randomUUID(), order_item_id: freeOrder.itemId, operation_id: randomUUID(), quantity: 1,
      status: 'processing', result_sha256: null, completed_at: null,
    }).execute()
    await expect(db.updateTable('orders').set({ status: 'closed' }).where('id', '=', freeOrder.id).execute())
      .rejects.toBeDefined()
  })

  it('permits closing a paid order only after every payment source is fully refunded', async () => {
    const customerId = await createCustomer('refund-before-close')
    const catalog = await createCatalog({ name: '退款后可关闭', salePrice: '10.00' })
    const order = await createOrder({ catalog, customerId, totalAmount: '10.00' })
    await db.transaction().execute((trx) => createExternalAttempt(trx, order.id, '10.00'))
    const receipt = await db.selectFrom('payment_receipts').select('id')
      .where('payment_attempt_id', '=', (await db.selectFrom('payment_attempts').select('id')
        .where('order_id', '=', order.id).executeTakeFirstOrThrow()).id).executeTakeFirstOrThrow()

    const refund = async (amount: string) => {
      const refundId = randomUUID()
      const allocationId = randomUUID()
      await db.transaction().execute(async (trx) => {
        await trx.insertInto('order_refunds').values({
          id: refundId, order_id: order.id, idempotency_key: randomUUID(), request_sha256: digest, amount,
        }).execute()
        await trx.updateTable('order_refunds').set({ status: 'approved' }).where('id', '=', refundId).execute()
        await trx.updateTable('order_refunds').set({ status: 'processing' }).where('id', '=', refundId).execute()
        await trx.insertInto('order_refund_allocations').values({
          id: allocationId, refund_id: refundId, source_payment_receipt_id: receipt.id,
          operation_id: randomUUID(), request_sha256: digest, destination: 'original_source', amount,
          provider: null, provider_refund_id: null, completed_at: null,
        }).execute()
        await trx.updateTable('order_refund_allocations').set({
          status: 'succeeded', provider: 'epay-compatible', provider_refund_id: `refund-${randomUUID()}`,
        }).where('id', '=', allocationId).execute()
        await trx.updateTable('order_refunds').set({ status: 'succeeded' }).where('id', '=', refundId).execute()
      })
    }

    await refund('5.00')
    await expect(db.updateTable('orders').set({ status: 'closed' }).where('id', '=', order.id).execute()).rejects.toBeDefined()
    await refund('5.00')
    expect(await db.selectFrom('order_financial_status').select(['paid_amount', 'refunded_amount', 'payment_status'])
      .where('order_id', '=', order.id).executeTakeFirstOrThrow()).toMatchObject({
      paid_amount: '10.00', refunded_amount: '10.00', payment_status: 'refunded',
    })
    await expect(db.updateTable('orders').set({ status: 'closed' }).where('id', '=', order.id).execute()).resolves.toBeDefined()
  })

  it('serializes concurrent balance debits so available funds cannot be overspent', async () => {
    const customerId = await createCustomer('wallet-race')
    await addWalletCredit(customerId, 'cash', '100.00')
    const debit = (operationId: string) => db.transaction().execute(async (trx) => {
      await trx.selectFrom('wallet_accounts').select('customer_id').where('customer_id', '=', customerId)
        .forUpdate().executeTakeFirstOrThrow()
      await trx.insertInto('wallet_operations').values({
        id: operationId, customer_id: customerId, operation_type: 'adjustment',
        request_sha256: digest, actor_admin_id: adminId,
      }).execute()
      await trx.insertInto('wallet_ledger_entries').values({
        id: randomUUID(), wallet_operation_id: operationId, line_no: 1, customer_id: customerId,
        bucket: 'cash', action: 'debit_available', amount: '70.00',
        payment_attempt_id: null, refund_allocation_id: null, withdrawal_id: null,
      }).execute()
    })
    const results = await Promise.allSettled([debit(randomUUID()), debit(randomUUID())])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await db.selectFrom('wallet_accounts').select(['cash_available', 'cash_frozen'])
      .where('customer_id', '=', customerId).executeTakeFirstOrThrow()).toEqual({ cash_available: '30.00', cash_frozen: '0.00' })
    expect(await db.selectFrom('wallet_ledger_entries').select('id').where('customer_id', '=', customerId).execute()).toHaveLength(2)
  })

  it('credits top-ups only from a confirmed external receipt and keeps source evidence', async () => {
    const customerId = await createCustomer('top-up')
    const attemptId = randomUUID()
    const receiptId = randomUUID()
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('payment_attempts').values({
        id: attemptId, idempotency_key: randomUUID(), request_sha256: digest,
        order_id: null, topup_customer_id: customerId, source: 'external', amount: '15.25',
        provider: 'epay-compatible', provider_payment_id: `topup-${attemptId}`, wallet_operation_id: null,
        expires_at: new Date(Date.now() + 15 * 60_000), completed_at: null,
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
      await trx.insertInto('payment_receipts').values({
        id: receiptId, payment_attempt_id: attemptId, source_bucket: 'external', provider: 'epay-compatible',
        provider_transaction_id: `topup-transaction-${attemptId}`, wallet_operation_id: null,
        wallet_line_no: null, amount: '15.25',
      }).execute()
    })
    expect(await db.selectFrom('wallet_accounts').select(['cash_available', 'gift_available'])
      .where('customer_id', '=', customerId).executeTakeFirstOrThrow()).toEqual({ cash_available: '15.25', gift_available: '0.00' })
    expect(await db.selectFrom('wallet_ledger_entries').select(['payment_attempt_id', 'amount', 'bucket'])
      .where('payment_attempt_id', '=', attemptId).execute()).toEqual([
      { payment_attempt_id: attemptId, amount: '15.25', bucket: 'cash' },
    ])
    await expect(db.deleteFrom('payment_attempts').where('id', '=', attemptId).execute()).rejects.toBeDefined()
    await expect(sql`TRUNCATE TABLE payment_receipts`.execute(db)).rejects.toBeDefined()
  })

  it('freezes withdrawal cash and prevents duplicate payout attempts while the result is uncertain', async () => {
    const customerId = await createCustomer('withdrawal')
    await addWalletCredit(customerId, 'cash', '100.00')
    await expect(db.transaction().execute(async (trx) => {
      const forgedOperationId = randomUUID()
      await trx.insertInto('wallet_operations').values({
        id: forgedOperationId, customer_id: customerId, operation_type: 'withdrawal_freeze',
        request_sha256: digest, actor_admin_id: null,
      }).execute()
      await trx.insertInto('withdrawals').values({
        id: randomUUID(), customer_id: customerId, idempotency_key: randomUUID(), request_sha256: digest,
        wallet_operation_id: forgedOperationId, amount: '10.00', fee_amount: '0.00', payout_amount: '10.00',
        payout_method: 'alipay', recipient_snapshot: { accountLast4: '0001' }, status: 'pending_transfer',
        reviewed_by_admin_id: adminId, reviewed_at: new Date(),
      }).execute()
    })).rejects.toMatchObject({ constraint: 'withdrawals_initial_review_state' })
    const withdrawalId = randomUUID()
    const freezeOperationId = randomUUID()
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('wallet_operations').values({
        id: freezeOperationId, customer_id: customerId, operation_type: 'withdrawal_freeze',
        request_sha256: digest, actor_admin_id: null,
      }).execute()
      await trx.insertInto('withdrawals').values({
        id: withdrawalId, customer_id: customerId, idempotency_key: randomUUID(), request_sha256: digest,
        wallet_operation_id: freezeOperationId, amount: '60.00', fee_amount: '5.00', payout_amount: '55.00',
        payout_method: 'bank_card', recipient_snapshot: { accountLast4: '1234', recipientName: 'Test' },
        reviewed_by_admin_id: null, reviewed_at: null,
      }).execute()
    })
    expect(await db.selectFrom('wallet_accounts').select(['cash_available', 'cash_frozen'])
      .where('customer_id', '=', customerId).executeTakeFirstOrThrow()).toEqual({ cash_available: '40.00', cash_frozen: '60.00' })
    await expect(db.deleteFrom('withdrawals').where('id', '=', withdrawalId).execute()).rejects.toBeDefined()

    await db.updateTable('withdrawals').set({
      status: 'pending_transfer', reviewed_by_admin_id: adminId, reviewed_at: new Date(),
    }).where('id', '=', withdrawalId).execute()
    await expect(db.insertInto('withdrawal_payout_attempts').values({
      id: randomUUID(), withdrawal_id: withdrawalId, operation_id: randomUUID(),
      started_by_admin_id: adminId, status: 'succeeded', provider_reference: 'forged-success', completed_at: new Date(),
    }).execute()).rejects.toMatchObject({ constraint: 'withdrawal_payout_attempts_initial_state' })
    expect((await db.selectFrom('withdrawals').select('status').where('id', '=', withdrawalId).executeTakeFirstOrThrow()).status)
      .toBe('pending_transfer')
    const firstAttemptId = randomUUID()
    await db.insertInto('withdrawal_payout_attempts').values({
      id: firstAttemptId, withdrawal_id: withdrawalId, operation_id: randomUUID(),
      started_by_admin_id: adminId, provider_reference: 'bank-transfer-1', completed_at: null,
    }).execute()
    await db.updateTable('withdrawal_payout_attempts').set({ status: 'unknown' }).where('id', '=', firstAttemptId).execute()
    expect((await db.selectFrom('withdrawals').select('status').where('id', '=', withdrawalId).executeTakeFirstOrThrow()).status)
      .toBe('transfer_uncertain')
    await expect(db.insertInto('withdrawal_payout_attempts').values({
      id: randomUUID(), withdrawal_id: withdrawalId, operation_id: randomUUID(),
      started_by_admin_id: adminId, provider_reference: 'bank-transfer-2', completed_at: null,
    }).execute()).rejects.toBeDefined()
    await expect(db.updateTable('withdrawal_payout_attempts').set({ status: 'failed' })
      .where('id', '=', firstAttemptId).execute()).rejects.toMatchObject({ constraint: 'withdrawal_payout_result_requires_evidence' })
    expect((await db.selectFrom('withdrawal_payout_attempts').select('status')
      .where('id', '=', firstAttemptId).executeTakeFirstOrThrow()).status).toBe('unknown')
    await db.updateTable('withdrawal_payout_attempts').set({
      status: 'failed', resolved_by_admin_id: adminId, result_sha256: digest,
    }).where('id', '=', firstAttemptId).execute()
    const secondAttemptId = randomUUID()
    await db.insertInto('withdrawal_payout_attempts').values({
      id: secondAttemptId, withdrawal_id: withdrawalId, operation_id: randomUUID(),
      started_by_admin_id: adminId, provider_reference: 'bank-transfer-3', completed_at: null,
    }).execute()
    await db.updateTable('withdrawal_payout_attempts').set({
      status: 'succeeded', resolved_by_admin_id: adminId, result_sha256: digest,
    }).where('id', '=', secondAttemptId).execute()
    expect((await db.selectFrom('withdrawals').select('status').where('id', '=', withdrawalId).executeTakeFirstOrThrow()).status)
      .toBe('completed')
    expect(await db.selectFrom('wallet_accounts').select(['cash_available', 'cash_frozen'])
      .where('customer_id', '=', customerId).executeTakeFirstOrThrow()).toEqual({ cash_available: '40.00', cash_frozen: '0.00' })
    expect(await db.selectFrom('wallet_ledger_entries').select('id').where('withdrawal_id', '=', withdrawalId)
      .where('action', '=', 'debit_frozen').execute()).toHaveLength(1)
  })

  it('records an expired payment as late, closes the order once, and releases its reservation', async () => {
    const customerId = await createCustomer('late-payment')
    const catalog = await createCatalog({ name: '超时付款', salePrice: '5.00', stock: 2 })
    await db.updateTable('storefront_customer_policy').set({ unpaid_order_timeout_minutes: 1 }).execute()
    const order = await createOrder({ catalog, customerId, totalAmount: '5.00' })
    const attemptId = randomUUID()
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('payment_attempts').values({
        id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: order.id,
        topup_customer_id: null, source: 'external', amount: '5.00', provider: 'epay-compatible',
        provider_payment_id: `provider-payment-${attemptId}`, wallet_operation_id: null,
        expires_at: new Date(Date.now() + 900), completed_at: null,
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
    })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('payment_receipts').values({
        id: randomUUID(), payment_attempt_id: attemptId, source_bucket: 'external', provider: 'epay-compatible',
        provider_transaction_id: `late-transaction-${attemptId}`, wallet_operation_id: null, wallet_line_no: null,
        amount: '5.00',
      }).execute()
    })
    expect(await db.selectFrom('orders').select('status').where('id', '=', order.id).executeTakeFirstOrThrow())
      .toEqual({ status: 'closed' })
    expect(await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow())
      .toEqual({ status: 'late_succeeded' })
    expect(await db.selectFrom('order_financial_status').select('payment_status')
      .where('order_id', '=', order.id).executeTakeFirstOrThrow()).toEqual({ payment_status: 'late_paid' })
    expect(await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.variantId).executeTakeFirstOrThrow()).toEqual({ reserved: 0 })

    const failedOrder = await createOrder({ catalog, customerId, totalAmount: '5.00' })
    const failedAttemptId = randomUUID()
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('payment_attempts').values({
        id: failedAttemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: failedOrder.id,
        topup_customer_id: null, source: 'external', amount: '5.00', provider: 'epay-compatible',
        provider_payment_id: `failed-payment-${failedAttemptId}`, wallet_operation_id: null,
        expires_at: new Date(Date.now() + 900), completed_at: null,
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', failedAttemptId).execute()
      await trx.updateTable('payment_attempts').set({ status: 'failed' }).where('id', '=', failedAttemptId).execute()
    })
    await db.insertInto('payment_receipts').values({
      id: randomUUID(), payment_attempt_id: failedAttemptId, source_bucket: 'external', provider: 'epay-compatible',
      provider_transaction_id: `failed-late-transaction-${failedAttemptId}`, wallet_operation_id: null,
      wallet_line_no: null, amount: '5.00',
    }).execute()
    expect(await db.selectFrom('orders').select('status').where('id', '=', failedOrder.id).executeTakeFirstOrThrow())
      .toEqual({ status: 'pending_payment' })
    expect(await db.selectFrom('payment_attempts').select('status').where('id', '=', failedAttemptId).executeTakeFirstOrThrow())
      .toEqual({ status: 'late_succeeded' })
    expect(await db.selectFrom('payment_receipts').select('disposition').where('payment_attempt_id', '=', failedAttemptId).executeTakeFirstOrThrow())
      .toEqual({ disposition: 'late' })
    await db.updateTable('storefront_customer_policy').set({ unpaid_order_timeout_minutes: 15 }).execute()
  })

  it('records a late receipt when prior funds prevent timeout closure, then closes after full refund', async () => {
    const customerId = await createCustomer('late-payment-existing-funds')
    const catalog = await createCatalog({ name: '已有收款的超时订单', salePrice: '10.00', stock: 2 })
    await db.updateTable('storefront_customer_policy').set({ unpaid_order_timeout_minutes: 1 }).execute()
    const order = await createOrder({ catalog, customerId, totalAmount: '10.00' })
    const mismatchAttemptId = randomUUID()
    const mismatchReceiptId = randomUUID()
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('payment_attempts').values({
        id: mismatchAttemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: order.id,
        topup_customer_id: null, source: 'external', amount: '5.00', provider: 'epay-compatible',
        provider_payment_id: `existing-funds-${mismatchAttemptId}`, wallet_operation_id: null,
        expires_at: new Date(Date.now() + 60_000), completed_at: null,
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', mismatchAttemptId).execute()
      await trx.insertInto('payment_receipts').values({
        id: mismatchReceiptId, payment_attempt_id: mismatchAttemptId, source_bucket: 'external',
        provider: 'epay-compatible', provider_transaction_id: `existing-funds-txn-${mismatchAttemptId}`,
        wallet_operation_id: null, wallet_line_no: null, amount: '4.00',
      }).execute()
    })
    const lateAttemptId = randomUUID()
    const lateReceiptId = randomUUID()
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('payment_attempts').values({
        id: lateAttemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: order.id,
        topup_customer_id: null, source: 'external', amount: '6.00', provider: 'epay-compatible',
        provider_payment_id: `late-existing-funds-${lateAttemptId}`, wallet_operation_id: null,
        expires_at: new Date(Date.now() + 900), completed_at: null,
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', lateAttemptId).execute()
    })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    await expect(db.transaction().execute(async (trx) => trx.insertInto('payment_receipts').values({
      id: lateReceiptId, payment_attempt_id: lateAttemptId, source_bucket: 'external',
      provider: 'epay-compatible', provider_transaction_id: `late-existing-funds-txn-${lateAttemptId}`,
      wallet_operation_id: null, wallet_line_no: null, amount: '6.00',
    }).execute())).resolves.toBeDefined()
    expect(await db.selectFrom('orders').select('status').where('id', '=', order.id).executeTakeFirstOrThrow())
      .toEqual({ status: 'pending_payment' })
    expect(await db.selectFrom('payment_receipts').select('disposition').where('id', '=', lateReceiptId).executeTakeFirstOrThrow())
      .toEqual({ disposition: 'late' })

    const refundId = randomUUID()
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('order_refunds').values({
        id: refundId, order_id: order.id, idempotency_key: randomUUID(), request_sha256: digest, amount: '10.00',
      }).execute()
      await trx.updateTable('order_refunds').set({ status: 'approved' }).where('id', '=', refundId).execute()
      await trx.updateTable('order_refunds').set({ status: 'processing' }).where('id', '=', refundId).execute()
      for (const [receiptId, amount] of [[mismatchReceiptId, '4.00'], [lateReceiptId, '6.00']] as const) {
        const allocationId = randomUUID()
        await trx.insertInto('order_refund_allocations').values({
          id: allocationId, refund_id: refundId, source_payment_receipt_id: receiptId,
          operation_id: randomUUID(), request_sha256: digest, destination: 'original_source', amount,
          provider: null, provider_refund_id: null, completed_at: null,
        }).execute()
        await trx.updateTable('order_refund_allocations').set({
          status: 'succeeded', provider: 'epay-compatible', provider_refund_id: `refund-${randomUUID()}`,
        }).where('id', '=', allocationId).execute()
      }
      await trx.updateTable('order_refunds').set({ status: 'succeeded' }).where('id', '=', refundId).execute()
    })
    expect(await db.selectFrom('orders').select('status').where('id', '=', order.id).executeTakeFirstOrThrow())
      .toEqual({ status: 'closed' })
    expect(await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', catalog.variantId).executeTakeFirstOrThrow()).toEqual({ reserved: 0 })
    await db.updateTable('storefront_customer_policy').set({ unpaid_order_timeout_minutes: 15 }).execute()
  })

  it('classifies a receipt against database wall time after waiting for an order lock', async () => {
    const customerId = await createCustomer('payment-timeout-race')
    const catalog = await createCatalog({ name: '支付超时并发', salePrice: '6.00', stock: 2 })
    const order = await createOrder({ catalog, customerId, totalAmount: '6.00' })
    const attemptId = randomUUID()
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('payment_attempts').values({
        id: attemptId, idempotency_key: randomUUID(), request_sha256: digest, order_id: order.id,
        topup_customer_id: null, source: 'external', amount: '6.00', provider: 'epay-compatible',
        provider_payment_id: `timeout-race-${attemptId}`, wallet_operation_id: null,
        expires_at: new Date(Date.now() + 400), completed_at: null,
      }).execute()
      await trx.updateTable('payment_attempts').set({ status: 'pending' }).where('id', '=', attemptId).execute()
    })

    let releaseOrderLock!: () => void
    let signalOrderLocked!: () => void
    const orderLockReady = new Promise<void>((resolve) => { signalOrderLocked = resolve })
    const holdOrderLock = new Promise<void>((resolve) => { releaseOrderLock = resolve })
    const lockTransaction = db.transaction().execute(async (trx) => {
      await trx.selectFrom('orders').select('id').where('id', '=', order.id).forUpdate().executeTakeFirstOrThrow()
      signalOrderLocked()
      await holdOrderLock
    })
    await orderLockReady

    let startReceiptInsert!: () => void
    const receiptTransactionReady = new Promise<void>((resolve) => { startReceiptInsert = resolve })
    const receiptTransaction = db.transaction().execute(async (trx) => {
      await sql`SELECT now()`.execute(trx)
      startReceiptInsert()
      await trx.insertInto('payment_receipts').values({
        id: randomUUID(), payment_attempt_id: attemptId, source_bucket: 'external', provider: 'epay-compatible',
        provider_transaction_id: `timeout-receipt-${attemptId}`, wallet_operation_id: null,
        wallet_line_no: null, amount: '6.00',
      }).execute()
    })
    await receiptTransactionReady
    await new Promise((resolve) => setTimeout(resolve, 700))
    releaseOrderLock()
    await Promise.all([lockTransaction, receiptTransaction])

    expect(await db.selectFrom('orders').select('status').where('id', '=', order.id).executeTakeFirstOrThrow())
      .toEqual({ status: 'closed' })
    expect(await db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow())
      .toEqual({ status: 'late_succeeded' })
    expect(await db.selectFrom('payment_receipts').select('disposition').where('payment_attempt_id', '=', attemptId).executeTakeFirstOrThrow())
      .toEqual({ disposition: 'late' })
  })

  it('upgrades the frozen Stage ③ schema without changing catalog or inventory history', async () => {
    await sql`DROP SCHEMA public CASCADE`.execute(db)
    await sql`CREATE SCHEMA public`.execute(db)
    const stage3Provider = {
      async getMigrations() {
        const migrations = await new AppMigrationProvider().getMigrations()
        return Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '202610180001_trade_foundation'))
      },
    }
    const stage3Migrator = new Migrator({ db, provider: stage3Provider })
    const stage3Result = await stage3Migrator.migrateToLatest()
    if (stage3Result.error) throw stage3Result.error

    let restoreError: unknown
    try {
      adminId = randomUUID()
      await db.insertInto('admin_users').values({
        id: adminId, email: 'stage3-upgrade-admin@example.test', password_hash: 'test-only-password-hash',
      }).execute()
      const productId = randomUUID()
      const variantId = randomUUID()
      const operationId = randomUUID()
      await db.transaction().execute(async (trx) => {
        await trx.insertInto('products').values({
          id: productId, name: '阶段③保留商品', description: '冻结迁移升级夹具',
          product_type: 'digital', status: 'active',
        }).execute()
        await trx.insertInto('product_variants').values({
          id: variantId, product_id: productId, sku_code: `SKU-${variantId.slice(0, 8)}`,
          combination_key: '', sale_price: '22.50', compare_at_price: null, cost_price: null,
          enabled: true, retired_at: null, inventory_mode: null, inventory_revision: 0,
        }).execute()
        await trx.updateTable('product_variants').set({ inventory_mode: 'quantity', inventory_revision: 1 })
          .where('id', '=', variantId).execute()
        await trx.insertInto('product_variant_quantity_inventory').values({
          product_id: productId, product_variant_id: variantId, stocked: 17, reserved: 0,
        }).execute()
        await trx.insertInto('product_variant_inventory_adjustments').values({
          id: randomUUID(), product_id: productId, product_variant_id: variantId, operation_id: operationId,
          administrator_id: adminId, action: 'increase', requested_quantity: 17,
          quantity_before: 0, quantity_after: 17, quantity_delta: 17, inventory_revision: 1,
          reason: 'Stage ③ upgrade preservation fixture',
        }).execute()
      })
      const before = {
        product: await db.selectFrom('products').select(['id', 'name', 'product_type', 'status', 'revision'])
          .where('id', '=', productId).executeTakeFirstOrThrow(),
        variant: await db.selectFrom('product_variants').select(['id', 'product_id', 'sku_code', 'sale_price', 'inventory_mode', 'inventory_revision'])
          .where('id', '=', variantId).executeTakeFirstOrThrow(),
        quantity: await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
          .where('product_variant_id', '=', variantId).executeTakeFirstOrThrow(),
        adjustments: await db.selectFrom('product_variant_inventory_adjustments').select(['operation_id', 'quantity_before', 'quantity_after', 'quantity_delta'])
          .where('product_variant_id', '=', variantId).execute(),
      }

      const currentMigrator = new Migrator({ db, provider: new AppMigrationProvider() })
      const upgradeResult = await currentMigrator.migrateToLatest()
      if (upgradeResult.error) throw upgradeResult.error
      expect(upgradeResult.results?.map((result) => result.migrationName)).toContain('202610180001_trade_foundation')
      expect(await db.selectFrom('products').select(['id', 'name', 'product_type', 'status', 'revision'])
        .where('id', '=', productId).executeTakeFirstOrThrow()).toEqual(before.product)
      expect(await db.selectFrom('product_variants').select(['id', 'product_id', 'sku_code', 'sale_price', 'inventory_mode', 'inventory_revision'])
        .where('id', '=', variantId).executeTakeFirstOrThrow()).toEqual(before.variant)
      expect(await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
        .where('product_variant_id', '=', variantId).executeTakeFirstOrThrow()).toEqual(before.quantity)
      expect(await db.selectFrom('product_variant_inventory_adjustments').select(['operation_id', 'quantity_before', 'quantity_after', 'quantity_delta'])
        .where('product_variant_id', '=', variantId).execute()).toEqual(before.adjustments)

      const rollbackMigrator = new Migrator({ db, provider: new AppMigrationProvider() })
      const customerManagementRollback = await rollbackMigrator.migrateDown()
      if (customerManagementRollback.error) throw customerManagementRollback.error
      expect(customerManagementRollback.results?.map((result) => result.migrationName)).toContain('202610190002_customer_management')
      const customerSessionRollback = await rollbackMigrator.migrateDown()
      if (customerSessionRollback.error) throw customerSessionRollback.error
      expect(customerSessionRollback.results?.map((result) => result.migrationName)).toContain('202610190001_customer_sessions')
      const rollbackResult = await rollbackMigrator.migrateDown()
      if (rollbackResult.error) throw rollbackResult.error
      expect(rollbackResult.results?.map((result) => result.migrationName)).toContain('202610180001_trade_foundation')
      const leftoverTradeFunctions = await sql<{
        reset_contact: boolean
        resolve_hold: boolean
        release_hold: boolean
      }>`SELECT
        to_regprocedure('reset_customer_contact_verification()') IS NOT NULL AS reset_contact,
        to_regprocedure('resolve_order_wallet_hold(uuid,character varying)') IS NOT NULL AS resolve_hold,
        to_regprocedure('release_failed_order_wallet_hold()') IS NOT NULL AS release_hold`.execute(db)
      expect(leftoverTradeFunctions.rows[0]).toEqual({ reset_contact: false, resolve_hold: false, release_hold: false })
      expect(await db.selectFrom('products').select(['id', 'name', 'product_type', 'status', 'revision'])
        .where('id', '=', productId).executeTakeFirstOrThrow()).toEqual(before.product)
      expect(await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
        .where('product_variant_id', '=', variantId).executeTakeFirstOrThrow()).toEqual(before.quantity)

      const recoveryMigrator = new Migrator({ db, provider: new AppMigrationProvider() })
      const recoveryResult = await recoveryMigrator.migrateToLatest()
      if (recoveryResult.error) throw recoveryResult.error
      expect(recoveryResult.results?.map((result) => result.migrationName)).toContain('202610180001_trade_foundation')
    } finally {
      const restoreMigrator = new Migrator({ db, provider: new AppMigrationProvider() })
      restoreError = (await restoreMigrator.migrateToLatest()).error
    }
    if (restoreError) throw restoreError
  })
})
