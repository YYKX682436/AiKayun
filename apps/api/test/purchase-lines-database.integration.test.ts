import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Migrator } from 'kysely/migration'
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely'
import { Pool } from 'pg'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
let db: Kysely<Database>
let oldCustomerId: string
let oldSkuId: string
let oldOrderId: string
let oldOrderItemId: string

function noFormIdentity(skuId: string): string {
  return createHash('sha256').update(JSON.stringify({
    normalizationVersion: null,
    skuId,
    templateVersionId: null,
    values: null,
  })).digest('hex')
}

async function customer(): Promise<string> {
  const id = randomUUID()
  await db.insertInto('customers').values({
    id, username: `purchase-line-${id.slice(0, 8)}`,
    password_hash: 'integration-only-hash', status: 'active',
  }).execute()
  return id
}

async function catalog(stock: number | null, perOrderLimit: number | null = null, price = '1.00'): Promise<{
  productId: string; skuId: string; name: string; skuCode: string; price: string
}> {
  const productId = randomUUID()
  const skuId = randomUUID()
  const name = `购买行测试-${productId.slice(0, 8)}`
  const skuCode = `LINE-${skuId.slice(0, 8)}`
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('products').values({
      id: productId, name, description: '', product_type: 'digital', status: 'active',
    }).execute()
    await trx.insertInto('product_variants').values({
      id: skuId, product_id: productId, sku_code: skuCode, combination_key: '',
      sale_price: price, enabled: true, retired_at: null,
      inventory_mode: stock === null ? 'unlimited' : 'quantity',
      purchase_limit_per_order: perOrderLimit,
    }).execute()
    if (stock !== null) {
      await trx.insertInto('product_variant_quantity_inventory').values({
        product_id: productId, product_variant_id: skuId, stocked: stock, reserved: 0,
      }).execute()
    }
    await trx.insertInto('product_variant_fulfillment').values({
      product_variant_id: skuId, method: 'manual', manual_delivery_ready: true,
    }).execute()
  })
  return { productId, skuId, name, skuCode, price }
}

async function templateVersion(): Promise<string> {
  const adminId = randomUUID()
  const templateId = randomUUID()
  const versionId = randomUUID()
  await db.insertInto('admin_users').values({
    id: adminId, email: `lines-${adminId.slice(0, 8)}@example.test`,
    password_hash: 'integration-only-hash',
  }).execute()
  await db.insertInto('purchase_form_templates').values({
    id: templateId, name: '测试模板', definition: { fields: [] },
    created_by_admin_id: adminId, updated_by_admin_id: adminId,
  }).execute()
  await db.insertInto('purchase_form_template_versions').values({
    id: versionId, template_id: templateId, version_number: 1,
    name: '测试模板 v1', definition: { fields: [] },
    sha256: 'e'.repeat(64), created_by_admin_id: adminId,
  }).execute()
  return versionId
}

async function draft(customerId: string, versionId: string): Promise<string> {
  const draftId = randomUUID()
  await db.insertInto('purchase_drafts').values({
    id: draftId, customer_id: customerId, guest_order_session_id: null,
    claimed_from_guest_order_session_id: null, template_version_id: versionId,
    encrypted_payload: Buffer.from([1]), payload_nonce: Buffer.alloc(12),
    payload_auth_tag: Buffer.alloc(16), encryption_key_id: 'test-key',
    expires_at: new Date(Date.now() + 60_000),
  }).execute()
  return draftId
}

async function insertOrderLines(
  trx: Transaction<Database>, customerId: string,
  product: { productId: string; skuId: string; name: string; skuCode: string; price: string },
  quantities: number[], options: {
    quantityInventory?: boolean; snapshots?: boolean; noFormIdentityOverride?: string
  } = {},
): Promise<{ orderId: string; itemIds: string[] }> {
  const orderId = randomUUID()
  await trx.insertInto('orders').values({
    id: orderId, customer_id: customerId, guest_order_session_id: null,
    idempotency_key: randomUUID(), request_sha256: 'a'.repeat(64),
    total_amount: (Number(product.price) * quantities.reduce((sum, quantity) => sum + quantity, 0)).toFixed(2),
    unpaid_expires_at: new Date(Date.now() + 60_000),
    history_hidden_at: null, history_hidden_by_admin_id: null, history_hidden_reason: null,
  }).execute()
  const itemIds: string[] = []
  for (const quantity of quantities) {
    const itemId = randomUUID()
    itemIds.push(itemId)
    await trx.insertInto('order_items').values({
      id: itemId, order_id: orderId, purchase_line_id: randomUUID(),
      product_id: product.productId, product_variant_id: product.skuId,
      product_name_snapshot: product.name, product_type_snapshot: 'digital',
      sku_code_snapshot: product.skuCode, sku_snapshot: '[]',
      inventory_mode_snapshot: options.quantityInventory ? 'quantity' : 'unlimited',
      fulfillment_method_snapshot: 'manual', fulfillment_content_version_id: null,
      unit_price: product.price, quantity, line_amount: (Number(product.price) * quantity).toFixed(2),
    }).execute()
    if (options.snapshots !== false) {
      await trx.insertInto('order_item_purchase_snapshots').values({
        order_item_id: itemId, template_version_id: null, normalization_version: null,
        content_identity: options.noFormIdentityOverride ?? noFormIdentity(product.skuId),
        encrypted_values: null, values_nonce: null, values_auth_tag: null,
        encryption_key_id: null, attachment_ids: [],
      }).execute()
    }
    if (options.quantityInventory) {
      await trx.insertInto('order_inventory_reservations').values({
        id: randomUUID(), order_item_id: itemId,
        product_id: product.productId, product_variant_id: product.skuId, quantity,
      }).execute()
    }
  }
  await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', orderId).execute()
  return { orderId, itemIds }
}

beforeAll(async () => {
  if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.slice(1).endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must name an isolated PostgreSQL database ending in _test')
  }
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`DROP SCHEMA public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const prior = await migrator.migrateTo('202610240003_purchase_form_audit_product_identity')
  if (prior.error) throw prior.error

  oldCustomerId = await customer()
  oldSkuId = randomUUID() // A removed SKU was deliberately never an FK.
  const createdAt = new Date('2026-10-01T00:00:00.000Z')
  await db.insertInto('customer_cart_items').values({
    customer_id: oldCustomerId, sku_id: oldSkuId, quantity: 7,
    created_at: createdAt, updated_at: createdAt,
  } as never).execute()

  const oldCatalog = await catalog(null)
  oldOrderId = randomUUID()
  oldOrderItemId = randomUUID()
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('orders').values({
      id: oldOrderId, customer_id: oldCustomerId, guest_order_session_id: null,
      idempotency_key: randomUUID(), request_sha256: 'b'.repeat(64),
      total_amount: '1.00', unpaid_expires_at: new Date(Date.now() + 60_000),
      history_hidden_at: null, history_hidden_by_admin_id: null, history_hidden_reason: null,
    }).execute()
    await trx.insertInto('order_items').values({
      id: oldOrderItemId, order_id: oldOrderId, product_id: oldCatalog.productId,
      product_variant_id: oldCatalog.skuId, product_name_snapshot: oldCatalog.name,
      product_type_snapshot: 'digital', sku_code_snapshot: oldCatalog.skuCode,
      sku_snapshot: '[]', inventory_mode_snapshot: 'unlimited',
      fulfillment_method_snapshot: 'manual', fulfillment_content_version_id: null,
      unit_price: '1.00', quantity: 1, line_amount: '1.00',
    }).execute()
    await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', oldOrderId).execute()
  })

  const upgraded = await migrator.migrateToLatest()
  if (upgraded.error) throw upgraded.error
  const repeated = await migrator.migrateToLatest()
  if (repeated.error) throw repeated.error
})

afterAll(async () => { if (db) await db.destroy() })

describe('⑥-2B forward purchase data gates in PostgreSQL', () => {
  it('preserves old deleted-SKU cart and order facts without inventing form snapshots', async () => {
    expect(await db.selectFrom('storefront_customer_policy').select('purchase_forms_status')
      .executeTakeFirstOrThrow()).toMatchObject({ purchase_forms_status: 'preparing' })
    const oldLine = await db.selectFrom('customer_cart_items').selectAll()
      .where('customer_id', '=', oldCustomerId).executeTakeFirstOrThrow()
    expect(oldLine).toMatchObject({
      sku_id: oldSkuId, quantity: 7, revision: 1,
      content_identity: noFormIdentity(oldSkuId),
      draft_id: null, template_version_id: null,
    })
    expect(oldLine.created_at.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(oldLine.updated_at.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(await db.selectFrom('orders').select(['purchase_snapshot_version', 'request_sha256'])
      .where('id', '=', oldOrderId).executeTakeFirstOrThrow())
      .toMatchObject({ purchase_snapshot_version: 1, request_sha256: 'b'.repeat(64) })
    expect(await db.selectFrom('order_item_purchase_snapshots').select('order_item_id')
      .where('order_item_id', '=', oldOrderItemId).execute()).toEqual([])
    await expect(db.insertInto('order_item_purchase_snapshots').values({
      order_item_id: oldOrderItemId, template_version_id: null, normalization_version: null,
      content_identity: noFormIdentity(oldSkuId), encrypted_values: null, values_nonce: null,
      values_auth_tag: null, encryption_key_id: null, attachment_ids: [],
    }).execute()).rejects.toMatchObject({ constraint: 'order_purchase_snapshot_insert_invalid' })
  })

  it('deduplicates migrated no-form rows, increments line revision, and rejects forged old orders', async () => {
    const oldLine = await db.selectFrom('customer_cart_items').select(['line_id', 'revision', 'content_identity'])
      .where('customer_id', '=', oldCustomerId).executeTakeFirstOrThrow()
    await expect(db.insertInto('customer_cart_items').values({
      customer_id: oldCustomerId, sku_id: oldSkuId, quantity: 1,
      content_identity: oldLine.content_identity,
      draft_id: null, draft_revision: null, template_version_id: null, normalization_version: null,
    }).execute()).rejects.toMatchObject({ constraint: 'customer_cart_items_content_unique' })
    const updated = await db.updateTable('customer_cart_items').set({ quantity: 8 })
      .where('line_id', '=', oldLine.line_id).returning(['line_id', 'revision']).executeTakeFirstOrThrow()
    expect(updated).toMatchObject({ line_id: oldLine.line_id, revision: oldLine.revision + 1 })
    await expect(db.insertInto('orders').values({
      id: randomUUID(), customer_id: oldCustomerId, guest_order_session_id: null,
      idempotency_key: randomUUID(), request_sha256: 'a'.repeat(64),
      total_amount: '1.00', purchase_snapshot_version: 1,
      unpaid_expires_at: new Date(Date.now() + 60_000), history_hidden_at: null,
      history_hidden_by_admin_id: null, history_hidden_reason: null,
    }).execute()).rejects.toMatchObject({ constraint: 'orders_purchase_snapshot_version_required' })
  })

  it('allows only a coordinated draft payload edit and enforces cart content and draft uniqueness', async () => {
    const owner = await customer()
    const skuId = randomUUID()
    const versionId = await templateVersion()
    const draftA = await draft(owner, versionId)
    const draftB = await draft(owner, versionId)
    const lineA = await db.insertInto('customer_cart_items').values({
      customer_id: owner, sku_id: skuId, quantity: 1,
      content_identity: '1'.repeat(64), draft_id: draftA,
      draft_revision: 1, template_version_id: versionId, normalization_version: 1,
    }).returning(['line_id', 'revision']).executeTakeFirstOrThrow()
    await expect(db.insertInto('customer_cart_items').values({
      customer_id: owner, sku_id: skuId, quantity: 1,
      content_identity: '1'.repeat(64), draft_id: draftB,
      draft_revision: 1, template_version_id: versionId, normalization_version: 1,
    }).execute()).rejects.toMatchObject({ constraint: 'customer_cart_items_content_unique' })
    await expect(db.insertInto('customer_cart_items').values({
      customer_id: owner, sku_id: randomUUID(), quantity: 1,
      content_identity: '2'.repeat(64), draft_id: draftA,
      draft_revision: 1, template_version_id: versionId, normalization_version: 1,
    }).execute()).rejects.toMatchObject({ constraint: 'customer_cart_items_draft_unique' })
    await expect(db.updateTable('purchase_drafts').set({ encrypted_payload: Buffer.from([2]) })
      .where('id', '=', draftA).execute()).rejects.toMatchObject({
      constraint: 'purchase_draft_cart_payload_binding',
    })
    expect((await db.selectFrom('purchase_drafts').select('revision')
      .where('id', '=', draftA).executeTakeFirstOrThrow()).revision).toBe(1)
    await db.transaction().execute(async (trx) => {
      const changed = await trx.updateTable('purchase_drafts')
        .set({ encrypted_payload: Buffer.from([3]) }).where('id', '=', draftA)
        .returning('revision').executeTakeFirstOrThrow()
      await trx.updateTable('customer_cart_items').set({
        draft_revision: changed.revision, content_identity: '3'.repeat(64),
      }).where('line_id', '=', lineA.line_id).execute()
    })
    expect(await db.selectFrom('customer_cart_items').select(['revision', 'content_identity', 'draft_revision'])
      .where('line_id', '=', lineA.line_id).executeTakeFirstOrThrow()).toMatchObject({
      revision: lineA.revision + 1, content_identity: '3'.repeat(64), draft_revision: 2,
    })
  })

  it('rejects same-SKU split lines when their combined SKU limit or stock is exceeded', async () => {
    const owner = await customer()
    const limited = await catalog(null, 3)
    await expect(db.transaction().execute(async (trx) => {
      await insertOrderLines(trx, owner, limited, [2, 2])
    })).rejects.toMatchObject({ constraint: 'order_purchase_limit_exceeded' })
    expect(await db.selectFrom('orders').select('id').where('customer_id', '=', owner).execute()).toEqual([])

    const stocked = await catalog(5)
    await expect(db.transaction().execute(async (trx) => {
      await insertOrderLines(trx, owner, stocked, [3, 3], { quantityInventory: true })
    })).rejects.toBeDefined()
    const state = await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', stocked.skuId).executeTakeFirstOrThrow()
    expect(state.reserved).toBe(0)
    expect(await db.selectFrom('orders').select('id').where('customer_id', '=', owner).execute()).toEqual([])
  })

  it('aggregates split lines for SKU and product lifetime and rolling 24-hour limits', async () => {
    const owner = await customer()
    const product = await catalog(null)
    await db.transaction().execute(async (trx) => {
      await insertOrderLines(trx, owner, product, [1, 1])
    })
    for (const column of ['purchase_limit_lifetime', 'purchase_limit_24h'] as const) {
      await db.updateTable('product_variants').set({
        purchase_limit_lifetime: null, purchase_limit_24h: null, [column]: 3,
      }).where('id', '=', product.skuId).execute()
      await expect(db.transaction().execute(async (trx) => {
        await insertOrderLines(trx, owner, product, [1, 1])
      })).rejects.toMatchObject({ constraint: 'order_purchase_limit_exceeded' })
    }
    await db.updateTable('product_variants').set({
      purchase_limit_lifetime: null, purchase_limit_24h: null,
    }).where('id', '=', product.skuId).execute()
    for (const column of ['purchase_limit_lifetime', 'purchase_limit_24h'] as const) {
      await db.updateTable('products').set({
        purchase_limit_lifetime: null, purchase_limit_24h: null, [column]: 3,
      }).where('id', '=', product.productId).execute()
      await expect(db.transaction().execute(async (trx) => {
        await insertOrderLines(trx, owner, product, [1, 1])
      })).rejects.toMatchObject({ constraint: 'order_purchase_limit_exceeded' })
    }
    expect(await db.selectFrom('orders').select('id').where('customer_id', '=', owner).execute())
      .toHaveLength(1)
  })

  it('keeps per-item reservations and releases both split lines on safe unpaid close', async () => {
    const owner = await customer()
    const product = await catalog(5)
    const committed = await db.transaction().execute(async (trx) => {
      return insertOrderLines(trx, owner, product, [1, 2], { quantityInventory: true })
    })
    const reservations = await db.selectFrom('order_inventory_reservations as reservation')
      .innerJoin('order_items as item', 'item.id', 'reservation.order_item_id')
      .select(['reservation.order_item_id', 'reservation.quantity'])
      .where('item.order_id', '=', committed.orderId).orderBy('reservation.quantity').execute()
    expect(reservations.map(row => row.quantity)).toEqual([1, 2])
    expect(new Set(reservations.map(row => row.order_item_id)).size).toBe(2)
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', product.skuId).executeTakeFirstOrThrow()).reserved).toBe(3)
    await db.updateTable('orders').set({ status: 'closed' }).where('id', '=', committed.orderId).execute()
    expect((await db.selectFrom('product_variant_quantity_inventory').select('reserved')
      .where('product_variant_id', '=', product.skuId).executeTakeFirstOrThrow()).reserved).toBe(0)
    const events = await db.selectFrom('order_inventory_events as event')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
      .innerJoin('order_items as item', 'item.id', 'reservation.order_item_id')
      .select(['event.action', 'event.quantity', 'reservation.order_item_id'])
      .where('item.order_id', '=', committed.orderId).execute()
    expect(events.filter(event => event.action === 'reserve')).toHaveLength(2)
    expect(events.filter(event => event.action === 'release')).toHaveLength(2)
  })

  it('keeps equal unit indexes separate by order item during split-line partial delivery', async () => {
    const owner = await customer()
    const product = await catalog(null, null, '0.00')
    const adminId = randomUUID()
    await db.insertInto('admin_users').values({
      id: adminId, email: `line-delivery-${adminId.slice(0, 8)}@example.test`,
      password_hash: 'integration-only-hash',
    }).execute()
    const { orderId, itemIds } = await db.transaction().execute(async (trx) => {
      return insertOrderLines(trx, owner, product, [2, 2])
    })
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId)
      .executeTakeFirstOrThrow()).status).toBe('processing')

    async function deliverUnit(itemId: string, unitIndex: number, content: string) {
      await db.transaction().execute(async (trx) => {
        const attemptId = randomUUID()
        await trx.insertInto('order_item_fulfillment_attempts').values({
          id: attemptId, order_item_id: itemId, operation_id: randomUUID(),
          quantity: 1, started_by_admin_id: adminId, delivery_source: 'manual',
          status: 'processing', result_sha256: null, failure_code: null,
          retry_after: null, completed_at: null,
        }).execute()
        await trx.insertInto('order_item_fulfillment_deliveries').values({
          id: randomUUID(), fulfillment_attempt_id: attemptId,
          started_by_admin_id: adminId, unit_index: unitIndex, content,
          content_sha256: createHash('sha256').update(content).digest('hex'),
          delivery_source: 'manual', encrypted_content: null, content_nonce: null,
          content_auth_tag: null, encryption_key_id: null, code_pool_entry_id: null,
          fulfillment_content_version_id: null, supplier_api_operation_id: null,
          supplier_connection_id: null, supplier_product_id: null,
          supplier_content_type: null, supplier_fingerprint_key_id: null,
        }).execute()
        await trx.updateTable('order_item_fulfillment_attempts').set({
          status: 'succeeded',
          result_sha256: createHash('sha256').update(JSON.stringify([content])).digest('hex'),
        }).where('id', '=', attemptId).execute()
      })
    }

    await deliverUnit(itemIds[0]!, 1, 'first line, unit 1')
    await deliverUnit(itemIds[1]!, 1, 'second line, unit 1')
    const partial = await db.selectFrom('order_items').select(['id', 'fulfilled_quantity', 'fulfillment_status'])
      .where('order_id', '=', orderId).orderBy('id').execute()
    expect(partial).toHaveLength(2)
    expect(partial.map(item => item.fulfilled_quantity)).toEqual([1, 1])
    expect(partial.map(item => item.fulfillment_status)).toEqual(['partially_fulfilled', 'partially_fulfilled'])
    const deliveries = await db.selectFrom('order_item_fulfillment_deliveries as delivery')
      .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
      .select(['attempt.order_item_id', 'delivery.unit_index'])
      .where('attempt.order_item_id', 'in', itemIds).execute()
    expect(deliveries).toHaveLength(2)
    expect(deliveries.map(row => row.unit_index)).toEqual([1, 1])
    expect(new Set(deliveries.map(row => row.order_item_id)).size).toBe(2)
    await expect(deliverUnit(itemIds[0]!, 1, 'duplicate unit 1')).rejects.toMatchObject({
      constraint: 'digital_delivery_unit_duplicate',
    })
    await deliverUnit(itemIds[0]!, 2, 'first line, unit 2')
    await deliverUnit(itemIds[1]!, 2, 'second line, unit 2')
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId)
      .executeTakeFirstOrThrow()).status).toBe('completed')
  })

  it('retains a delivered line and consumed stock after a paid split-line refund and close', async () => {
    const owner = await customer()
    const product = await catalog(5)
    const adminId = randomUUID()
    await db.insertInto('admin_users').values({
      id: adminId, email: `line-refund-${adminId.slice(0, 8)}@example.test`,
      password_hash: 'integration-only-hash',
    }).execute()
    const { orderId, itemIds } = await db.transaction().execute(async (trx) => {
      return insertOrderLines(trx, owner, product, [1, 1], { quantityInventory: true })
    })
    const paymentId = randomUUID()
    const receiptId = randomUUID()
    await db.insertInto('payment_attempts').values({
      id: paymentId, idempotency_key: randomUUID(), request_sha256: 'a'.repeat(64),
      order_id: orderId, topup_customer_id: null, source: 'external', amount: '2.00',
      status: 'created', provider: 'integration', provider_payment_id: `split-line-${paymentId}`,
      wallet_operation_id: null, wallet_hold_operation_id: null, requested_wallet_amount: null,
      expires_at: new Date(Date.now() + 60_000), completed_at: null,
    }).execute()
    await db.insertInto('payment_receipts').values({
      id: receiptId, payment_attempt_id: paymentId, source_bucket: 'external',
      provider: 'integration', provider_transaction_id: `split-line-receipt-${receiptId}`,
      wallet_operation_id: null, wallet_line_no: null, amount: '2.00',
    }).execute()
    await db.updateTable('payment_attempts').set({ status: 'succeeded' })
      .where('id', '=', paymentId).execute()
    expect((await db.selectFrom('orders').select('status').where('id', '=', orderId)
      .executeTakeFirstOrThrow()).status).toBe('processing')

    const attemptId = randomUUID()
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('order_item_fulfillment_attempts').values({
        id: attemptId, order_item_id: itemIds[0]!, operation_id: randomUUID(),
        quantity: 1, started_by_admin_id: adminId, delivery_source: 'manual',
        status: 'processing', result_sha256: null, failure_code: null,
        retry_after: null, completed_at: null,
      }).execute()
      const content = 'delivered before refund'
      await trx.insertInto('order_item_fulfillment_deliveries').values({
        id: randomUUID(), fulfillment_attempt_id: attemptId, started_by_admin_id: adminId,
        unit_index: 1, content,
        content_sha256: createHash('sha256').update(content).digest('hex'),
        delivery_source: 'manual', encrypted_content: null, content_nonce: null,
        content_auth_tag: null, encryption_key_id: null, code_pool_entry_id: null,
        fulfillment_content_version_id: null, supplier_api_operation_id: null,
        supplier_connection_id: null, supplier_product_id: null,
        supplier_content_type: null, supplier_fingerprint_key_id: null,
      }).execute()
      await trx.updateTable('order_item_fulfillment_attempts').set({
        status: 'succeeded',
        result_sha256: createHash('sha256').update(JSON.stringify([content])).digest('hex'),
      }).where('id', '=', attemptId).execute()
    })
    expect((await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', product.skuId).executeTakeFirstOrThrow()))
      .toEqual({ stocked: 4, reserved: 1 })

    const refundId = randomUUID()
    const allocationId = randomUUID()
    await db.insertInto('order_refunds').values({
      id: refundId, order_id: orderId, idempotency_key: randomUUID(),
      request_sha256: 'a'.repeat(64), amount: '2.00',
    }).execute()
    await db.updateTable('order_refunds').set({ status: 'approved', reviewed_by_admin_id: adminId })
      .where('id', '=', refundId).execute()
    await db.insertInto('order_refund_allocations').values({
      id: allocationId, refund_id: refundId, source_payment_receipt_id: receiptId,
      operation_id: randomUUID(), request_sha256: 'a'.repeat(64),
      destination: 'cash_balance', amount: '2.00',
    }).execute()
    await db.updateTable('order_refunds').set({ status: 'processing' })
      .where('id', '=', refundId).execute()
    await db.updateTable('order_refund_allocations').set({ status: 'succeeded' })
      .where('id', '=', allocationId).execute()
    await db.updateTable('order_refunds').set({ status: 'succeeded' })
      .where('id', '=', refundId).execute()
    await db.updateTable('orders').set({ status: 'closed' }).where('id', '=', orderId).execute()

    expect((await db.selectFrom('product_variant_quantity_inventory').select(['stocked', 'reserved'])
      .where('product_variant_id', '=', product.skuId).executeTakeFirstOrThrow()))
      .toEqual({ stocked: 4, reserved: 0 })
    expect(await db.selectFrom('order_inventory_events as event')
      .innerJoin('order_inventory_reservations as reservation', 'reservation.id', 'event.reservation_id')
      .select(['reservation.order_item_id', 'event.action'])
      .where('reservation.order_item_id', 'in', itemIds).execute())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ order_item_id: itemIds[0], action: 'consume' }),
        expect.objectContaining({ order_item_id: itemIds[1], action: 'release' }),
      ]))
    expect(await db.selectFrom('order_item_fulfillment_deliveries').select('id')
      .where('fulfillment_attempt_id', '=', attemptId).execute()).toHaveLength(1)
    expect(await db.selectFrom('order_item_purchase_snapshots').select('order_item_id')
      .where('order_item_id', 'in', itemIds).execute()).toHaveLength(2)
    expect((await db.selectFrom('order_refunds').select('status')
      .where('id', '=', refundId).executeTakeFirstOrThrow()).status).toBe('succeeded')
  })

  it('requires every new line snapshot and keeps committed snapshots immutable', async () => {
    const owner = await customer()
    const product = await catalog(null)
    await expect(db.transaction().execute(async (trx) => {
      await insertOrderLines(trx, owner, product, [1], { snapshots: false })
    })).rejects.toMatchObject({ constraint: 'order_purchase_snapshot_required' })
    await expect(db.transaction().execute(async (trx) => {
      await insertOrderLines(trx, owner, product, [1], { noFormIdentityOverride: 'f'.repeat(64) })
    })).rejects.toMatchObject({ constraint: 'order_purchase_no_form_identity_invalid' })
    const successful = await db.transaction().execute(async (trx) => {
      return insertOrderLines(trx, owner, product, [1, 2])
    })
    const snapshots = await db.selectFrom('order_item_purchase_snapshots').selectAll()
      .where('order_item_id', 'in', successful.itemIds).execute()
    expect(snapshots).toHaveLength(2)
    await expect(db.updateTable('order_item_purchase_snapshots').set({ content_identity: 'c'.repeat(64) })
      .where('order_item_id', '=', successful.itemIds[0]!).execute())
      .rejects.toMatchObject({ constraint: 'order_purchase_data_immutable' })
    await expect(db.deleteFrom('order_item_purchase_snapshots')
      .where('order_item_id', '=', successful.itemIds[0]!).execute())
      .rejects.toMatchObject({ constraint: 'order_purchase_data_immutable' })
    await expect(sql`TRUNCATE order_item_purchase_snapshots`.execute(db)).rejects.toMatchObject({ code: '0A000' })
    await expect(sql`TRUNCATE order_item_purchase_snapshots CASCADE`.execute(db))
      .rejects.toMatchObject({ constraint: 'order_purchase_data_immutable' })
    expect(await db.selectFrom('order_items').select('id')
      .where('order_id', '=', successful.orderId).execute()).toHaveLength(2)
  })

  it('binds only retained independent attachment objects before sealing and protects them after commit', async () => {
    const owner = await customer()
    const product = await catalog(null)
    const versionId = await templateVersion()
    const sourceAttachmentId = randomUUID()
    const archiveObjectId = randomUUID()
    const fieldId = randomUUID()
    const checksum = 'd'.repeat(64)
    for (const status of ['retained', 'deleting'] as const) {
      const invalidId = randomUUID()
      await expect(db.insertInto('purchase_order_attachment_objects').values({
        id: invalidId, source_draft_id: randomUUID(), source_attachment_id: sourceAttachmentId,
        storage_key: `order-objects/${invalidId.slice(0, 2)}/${invalidId}.webp`,
        byte_size: 32, width: 4, height: 4, sha256: checksum, status,
      }).execute()).rejects.toMatchObject({ constraint: 'purchase_order_attachment_initial_state_invalid' })
    }
    await expect(db.insertInto('purchase_order_attachment_objects').values({
      id: randomUUID(), source_draft_id: randomUUID(), source_attachment_id: sourceAttachmentId,
      storage_key: `order-objects/${archiveObjectId.slice(0, 2)}/${archiveObjectId}.webp`,
      byte_size: 32, width: 4, height: 4, sha256: checksum,
    }).execute()).rejects.toMatchObject({ constraint: 'purchase_order_attachment_objects_storage_identity_check' })
    await db.insertInto('purchase_order_attachment_objects').values({
      id: archiveObjectId, source_draft_id: randomUUID(), source_attachment_id: sourceAttachmentId,
      storage_key: `order-objects/${archiveObjectId.slice(0, 2)}/${archiveObjectId}.webp`,
      byte_size: 32, width: 4, height: 4, sha256: checksum,
    }).execute()

    async function writeFormOrder(retain: boolean) {
      return db.transaction().execute(async (trx) => {
        const orderId = randomUUID()
        const itemId = randomUUID()
        await trx.insertInto('orders').values({
          id: orderId, customer_id: owner, guest_order_session_id: null,
          idempotency_key: randomUUID(), request_sha256: 'a'.repeat(64),
          total_amount: '1.00', unpaid_expires_at: new Date(Date.now() + 60_000),
          history_hidden_at: null, history_hidden_by_admin_id: null, history_hidden_reason: null,
        }).execute()
        await trx.insertInto('order_items').values({
          id: itemId, order_id: orderId, purchase_line_id: randomUUID(),
          product_id: product.productId, product_variant_id: product.skuId,
          product_name_snapshot: product.name, product_type_snapshot: 'digital',
          sku_code_snapshot: product.skuCode, sku_snapshot: '[]',
          inventory_mode_snapshot: 'unlimited', fulfillment_method_snapshot: 'manual',
          fulfillment_content_version_id: null, unit_price: '1.00', quantity: 1, line_amount: '1.00',
        }).execute()
        await trx.insertInto('order_item_purchase_snapshots').values({
          order_item_id: itemId, template_version_id: versionId, normalization_version: 1,
          content_identity: 'f'.repeat(64), encrypted_values: Buffer.from([1]),
          values_nonce: Buffer.alloc(12), values_auth_tag: Buffer.alloc(16),
          encryption_key_id: 'test-key', attachment_ids: [sourceAttachmentId],
        }).execute()
        await trx.insertInto('order_item_purchase_attachments').values({
          order_item_id: itemId, source_attachment_id: sourceAttachmentId,
          archive_object_id: archiveObjectId, field_id: fieldId, ordinal: 1,
          sha256: checksum, byte_size: 32,
        }).execute()
        if (retain) await trx.updateTable('purchase_order_attachment_objects')
          .set({ status: 'retained' }).where('id', '=', archiveObjectId).execute()
        await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', orderId).execute()
        return { orderId, itemId }
      })
    }

    await expect(writeFormOrder(false)).rejects.toMatchObject({
      constraint: 'order_purchase_attachment_manifest_invalid',
    })
    expect((await db.selectFrom('purchase_order_attachment_objects').select('status')
      .where('id', '=', archiveObjectId).executeTakeFirstOrThrow()).status).toBe('prepared')
    const committed = await writeFormOrder(true)
    await expect(db.insertInto('order_item_purchase_attachments').values({
      order_item_id: committed.itemId, source_attachment_id: randomUUID(),
      archive_object_id: randomUUID(), field_id: fieldId, ordinal: 2,
      sha256: checksum, byte_size: 32,
    }).execute()).rejects.toMatchObject({ constraint: 'order_purchase_attachment_insert_invalid' })
    await expect(db.updateTable('order_item_purchase_attachments').set({ ordinal: 2 })
      .where('order_item_id', '=', committed.itemId).execute())
      .rejects.toMatchObject({ constraint: 'order_purchase_data_immutable' })
    await expect(db.deleteFrom('order_item_purchase_attachments')
      .where('order_item_id', '=', committed.itemId).execute())
      .rejects.toMatchObject({ constraint: 'order_purchase_data_immutable' })
    await expect(sql`TRUNCATE order_item_purchase_attachments`.execute(db))
      .rejects.toMatchObject({ constraint: 'order_purchase_data_immutable' })
    await expect(db.updateTable('purchase_order_attachment_objects').set({ sha256: 'a'.repeat(64) })
      .where('id', '=', archiveObjectId).execute()).rejects.toMatchObject({
      constraint: 'purchase_order_attachment_metadata_immutable',
    })
    await expect(db.deleteFrom('purchase_order_attachment_objects')
      .where('id', '=', archiveObjectId).execute()).rejects.toMatchObject({
      constraint: 'purchase_order_attachment_delete_guard',
    })
  })

  it('preserves a legacy enabled storefront purchase-form flag as active on forward upgrade', async () => {
    // Newer migrations are intentionally forward-only. Recreate the actual old
    // schema in a separate PostgreSQL namespace instead of rolling the current
    // application schema backwards or deleting its migration history.
    const schema = `legacy_forms_${randomUUID().replaceAll('-', '')}`
    await sql.raw(`CREATE SCHEMA "${schema}"`).execute(db)
    const legacyDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({
      connectionString: testDatabaseUrl, options: `-c search_path=${schema}`,
    }) }) })
    try {
      const migrator = new Migrator({ db: legacyDb, provider: new AppMigrationProvider(), migrationTableSchema: schema })
      const original = await migrator.migrateTo('202610240003_purchase_form_audit_product_identity')
      if (original.error) throw original.error
      const productId = randomUUID(), skuId = randomUUID()
      await legacyDb.insertInto('customers').values({ id: oldCustomerId, username: `legacy-${oldCustomerId.slice(0, 8)}`,
        password_hash: 'integration-only-hash', status: 'active' }).execute()
      await legacyDb.transaction().execute(async trx => {
        await trx.insertInto('products').values({ id: productId, name: 'Legacy order fixture', description: '',
          product_type: 'digital', status: 'active' }).execute()
        await trx.insertInto('product_variants').values({ id: skuId, product_id: productId,
          sku_code: `LEGACY-${skuId.slice(0, 8)}`, combination_key: '', sale_price: '1.00', enabled: true,
          retired_at: null, inventory_mode: 'unlimited' }).execute()
        await trx.insertInto('product_variant_fulfillment').values({ product_variant_id: skuId,
          method: 'manual', manual_delivery_ready: true }).execute()
      })
      await legacyDb.transaction().execute(async trx => {
        await trx.insertInto('orders').values({ id: oldOrderId, customer_id: oldCustomerId, guest_order_session_id: null,
          idempotency_key: randomUUID(), request_sha256: 'b'.repeat(64), total_amount: '1.00',
          unpaid_expires_at: new Date(Date.now() + 60_000), history_hidden_at: null,
          history_hidden_by_admin_id: null, history_hidden_reason: null }).execute()
        await trx.insertInto('order_items').values({ id: oldOrderItemId, order_id: oldOrderId, product_id: productId,
          product_variant_id: skuId, product_name_snapshot: 'Legacy order fixture', product_type_snapshot: 'digital',
          sku_code_snapshot: `LEGACY-${skuId.slice(0, 8)}`, sku_snapshot: '[]', inventory_mode_snapshot: 'unlimited',
          fulfillment_method_snapshot: 'manual', fulfillment_content_version_id: null, unit_price: '1.00', quantity: 1,
          line_amount: '1.00' }).execute()
        await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', oldOrderId).execute()
      })
      const legacy = await migrator.migrateTo('202610250002_purchase_snapshot_manifest_r1')
      expect(legacy.error).toBeUndefined()
      await sql`UPDATE storefront_customer_policy SET purchase_forms_enabled = true WHERE singleton = true`.execute(legacyDb)
      const upgraded = await migrator.migrateToLatest()
      expect(upgraded.error).toBeUndefined()
      expect(await legacyDb.selectFrom('storefront_customer_policy').select('purchase_forms_status')
        .executeTakeFirstOrThrow()).toEqual({ purchase_forms_status: 'active' })
      expect(await legacyDb.selectFrom('orders').select('request_sha256').where('id', '=', oldOrderId)
        .executeTakeFirstOrThrow()).toEqual({ request_sha256: 'b'.repeat(64) })
      await expect(sql`SELECT purchase_forms_enabled FROM storefront_customer_policy`.execute(legacyDb))
        .rejects.toMatchObject({ code: '42703' })
    } finally {
      await legacyDb.destroy()
      await sql.raw(`DROP SCHEMA "${schema}" CASCADE`).execute(db)
    }
  })
})
