import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { createApp } from '../src/app.js'
import { hashToken } from '../src/auth/security.js'
import { readConfig, type AppConfig } from '../src/config.js'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'
import { createPurchaseDraft, savePurchaseDraft, uploadPurchaseDraftAttachment } from '../src/commerce/purchase-forms.js'
import { readOwnedOrderPurchaseAttachment } from '../src/commerce/purchase-order-attachments.js'
import { encryptPurchaseOrderValues } from '../src/commerce/purchase-form-crypto.js'
import { PurchaseAttachmentStorage } from '../src/media/purchase-attachment-storage.js'
import { PurchaseOrderAttachmentStorage } from '../src/media/purchase-order-attachment-storage.js'
import { allocateProcurementIdentity, procurementPreparationEligibility } from '../src/commerce/procurement-identity.js'
import { decryptSupplierCredentials, encryptSupplierCredentials } from '../src/commerce/supplier-api-crypto.js'
import { recordWalletOrderPayment } from '../src/finance/wallet.js'

const selected = vi.hoisted(() => ({ rows: [] as Array<{ skuId: string; mappingVersionId: string }>, fail: false }))
vi.mock('../src/commerce/procurement-source-selection.js', () => ({
  selectCheckoutProcurementSources: () => {
    if (selected.fail) throw new Error('selector must not run on idempotent replay')
    return selected.rows
  },
}))

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const origin = 'http://localhost:3000'
const adminId = randomUUID(), customerId = randomUUID(), sessionId = randomUUID()
const customerToken = randomBytes(32).toString('base64url')
const connectionId = randomUUID(), connectionVersionId = randomUUID()
const templateId = randomUUID(), templateVersionId = randomUUID()
const accountField = randomUUID(), imageField = randomUUID()
const templateHash = 'a'.repeat(64), structureHash = 'b'.repeat(64), rulesHash = 'c'.repeat(64)
const digest = 'd'.repeat(64)
const credentials = { providerType: 'kayixin_customer_v3' as const, appId: '12345', appSecret: 'synthetic-only-secret' }
const owner = { kind: 'customer' as const, customer: { id: customerId, sessionId } }
let db: Kysely<Database>, secondDb: Kysely<Database>, config: AppConfig
let app: FastifyInstance, secondApp: FastifyInstance, privateRoot: string
let headers: Record<string, string>
let skuA: Catalog, skuB: Catalog, skuZero: Catalog
let savedOrder: { id: string; itemId: string; body: Record<string, unknown>; itemIds: string[]; attachmentId: string }
let ordinaryOrder: { id: string; body: Record<string, unknown> }
let raceOrders: Array<{ id: string; itemId: string }> = []
let oldSources: unknown[]

type Catalog = { productId: string; skuId: string; mappingId: string; versionId: string; price: string }

function cookie(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers['set-cookie']
  const rows = Array.isArray(value) ? value : [value ?? '']
  return rows.find(row => row.startsWith(`${name}=`))!.split(';')[0]!
}

async function catalog(price: string): Promise<Catalog> {
  const productId = randomUUID(), skuId = randomUUID(), mappingId = randomUUID(), versionId = randomUUID()
  const code = `PROC-${skuId.slice(0, 8)}`
  await db.transaction().execute(async trx => {
    await trx.insertInto('products').values({ id: productId, name: `Procurement fixture ${code}`,
      description: '', product_type: 'digital', status: 'active' }).execute()
    await trx.insertInto('product_variants').values({ id: skuId, product_id: productId, sku_code: code,
      combination_key: '', sale_price: price, enabled: true, inventory_mode: 'unlimited' }).execute()
    await trx.insertInto('product_variant_fulfillment').values({ product_variant_id: skuId,
      method: 'manual', manual_delivery_ready: true }).execute()
    await trx.insertInto('product_purchase_form_settings').values({ product_id: productId,
      mode: 'template', template_version_id: templateVersionId, applied_mode: 'template',
      applied_template_version_id: templateVersionId, updated_by_admin_id: adminId }).execute()
    await sql`INSERT INTO supplier_product_mapping_heads
      (id, product_id, product_variant_id, supplier_connection_id, supplier_connection_version_id,
       upstream_product_id, upstream_product_name, upstream_sku_type, upstream_sku_code, upstream_combination,
       upstream_structure_snapshot, upstream_structure_sha256, upstream_observed_at, template_id, template_version_id,
       template_sha256, normalization_version, rules, rules_sha256, created_by_admin_id, updated_by_admin_id)
      VALUES (${mappingId}::uuid, ${productId}::uuid, ${skuId}::uuid, ${connectionId}::uuid, ${connectionVersionId}::uuid,
        '123456', 'synthetic good', 0, NULL, '[]'::jsonb, '{}'::jsonb, ${structureHash}, now(),
        ${templateId}::uuid, ${templateVersionId}::uuid, ${templateHash}, 1, '{"version":1,"fields":[]}'::jsonb,
        ${rulesHash}, ${adminId}::uuid, ${adminId}::uuid)`.execute(trx)
    await sql`INSERT INTO supplier_product_mapping_versions
      (id, mapping_id, version_number, product_id, product_variant_id, supplier_connection_id, supplier_connection_version_id,
       provider_type, upstream_product_id, upstream_product_name, upstream_sku_type, upstream_sku_code, upstream_combination,
       upstream_structure_snapshot, upstream_structure_sha256, upstream_observed_at, template_id, template_version_id,
       template_sha256, normalization_version, rules_version, rules, rules_sha256, administrator_id)
      SELECT ${versionId}::uuid, id, 1, product_id, product_variant_id, supplier_connection_id, supplier_connection_version_id,
        provider_type, upstream_product_id, upstream_product_name, upstream_sku_type, upstream_sku_code, upstream_combination,
        upstream_structure_snapshot, upstream_structure_sha256, upstream_observed_at, template_id, template_version_id,
        template_sha256, normalization_version, rules_version, rules, rules_sha256, ${adminId}::uuid
      FROM supplier_product_mapping_heads WHERE id = ${mappingId}::uuid`.execute(trx)
    await trx.updateTable('supplier_product_mapping_heads').set({ status: 'reviewed', revision: 2,
      latest_review_version_id: versionId, latest_version_number: 1 }).where('id', '=', mappingId).execute()
  })
  return { productId, skuId, mappingId, versionId, price }
}

async function draft(account: string, withImage = false) {
  const created = await createPurchaseDraft(db, config, owner, templateVersionId)
  let attachmentId: string | null = null
  if (withImage) {
    const storage = new PurchaseAttachmentStorage(privateRoot)
    const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#6482a0' } }).png().toBuffer()
    const uploaded = await uploadPurchaseDraftAttachment(db, config, storage, owner, {
      draftId: created.id, expectedRevision: created.revision, fieldId: imageField,
      claimedMimeType: 'image/png', stream: Readable.from([image]),
    })
    attachmentId = uploaded.attachmentId
  }
  const saved = await savePurchaseDraft(db, config, owner, { draftId: created.id,
    expectedRevision: created.revision, values: { [accountField]: account, [imageField]: attachmentId ? [attachmentId] : [] } })
  return { id: created.id, revision: saved.revision, attachmentId }
}

type Line = { lineId: string; skuId: string; quantity: number; draftId: string; draftRevision: number }
function line(sku: Catalog, saved: Awaited<ReturnType<typeof draft>>, quantity = 1): Line {
  return { lineId: randomUUID(), skuId: sku.skuId, quantity, draftId: saved.id, draftRevision: saved.revision }
}
async function checkout(items: Line[]) {
  const quote = await app.inject({ method: 'POST', url: '/api/v1/checkout/quote', headers, payload: { version: 2, items } })
  expect(quote.statusCode, quote.body).toBe(200)
  expect(quote.json().data.canContinue, quote.body).toBe(true)
  const body = { version: 2, items, idempotencyKey: randomUUID(), quoteToken: quote.json().data.quoteToken as string }
  const result = await app.inject({ method: 'POST', url: '/api/v1/checkout/orders', headers, payload: body })
  expect(result.statusCode, result.body).toBe(201)
  return { order: result.json().data.order as { id: string; items: Array<{ id: string; skuId: string; quantity: number }> }, body }
}

async function pay(orderId: string) {
  const amount = (await db.selectFrom('orders').select('total_amount').where('id', '=', orderId).executeTakeFirstOrThrow()).total_amount
  const operationId = randomUUID()
  await db.transaction().execute(async trx => {
    await trx.insertInto('wallet_operations').values({ id: operationId, customer_id: customerId,
      operation_type: 'gift', request_sha256: digest, actor_admin_id: adminId }).execute()
    await trx.insertInto('wallet_ledger_entries').values({ id: randomUUID(), wallet_operation_id: operationId,
      line_no: 1, customer_id: customerId, bucket: 'gift', action: 'credit_available', amount,
      payment_attempt_id: null, refund_allocation_id: null, withdrawal_id: null }).execute()
  })
  await db.transaction().execute(trx => recordWalletOrderPayment(trx, { customerId, orderId,
    operationId: randomUUID(), requestSha256: digest, amount }))
}

function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

async function waitForBlockedBy(blockerPid: number): Promise<boolean> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const row = await sql<{ blocked: boolean }>`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
    ) AS blocked`.execute(db)
    if (row.rows[0]!.blocked) return true
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return false
}

beforeAll(async () => {
  if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.endsWith('_test')) throw new Error('Requires isolated _test database')
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  await sql`DROP SCHEMA public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
  const migration = await new Migrator({ db, provider: new AppMigrationProvider() }).migrateToLatest()
  if (migration.error) throw migration.error
  privateRoot = await mkdtemp(join(tmpdir(), 'aikayun-procurement-identity-'))
  config = readConfig({ ...process.env, DATABASE_URL: testDatabaseUrl, NODE_ENV: 'test', PUBLIC_ORIGIN: origin,
    COOKIE_SECURE: 'false', PRIVATE_FILE_ROOT: privateRoot,
    PAYMENT_CREDENTIAL_KEY_RING: JSON.stringify({ activeKeyId: 'fixture', keys: { fixture: Buffer.alloc(32, 0x31).toString('base64') } }),
  })
  await db.insertInto('admin_users').values({ id: adminId, email: 'procurement-fixture@example.test', password_hash: 'fixture' }).execute()
  await db.insertInto('customers').values({ id: customerId, username: `proc-${customerId.slice(0, 8)}`, password_hash: 'fixture', status: 'active' }).execute()
  await db.insertInto('customer_sessions').values({ id: sessionId, customer_id: customerId, token_hash: hashToken(customerToken),
    expires_at: new Date(Date.now() + 3_600_000), revoked_at: null }).execute()
  const definition = { fields: [
    { id: accountField, meaningKey: 'account', type: 'text', label: 'Account', required: true, maxLength: 120 },
    { id: imageField, meaningKey: 'proof', type: 'image', label: 'Proof', required: false, maxCount: 1 },
  ] }
  await db.insertInto('purchase_form_templates').values({ id: templateId, name: 'Synthetic template', definition,
    created_by_admin_id: adminId, updated_by_admin_id: adminId }).execute()
  await db.insertInto('purchase_form_template_versions').values({ id: templateVersionId, template_id: templateId,
    version_number: 1, name: 'Synthetic template v1', definition, sha256: templateHash, created_by_admin_id: adminId }).execute()
  const envelope = encryptSupplierCredentials(config, connectionId, 1, credentials)
  await db.transaction().execute(async trx => {
    await trx.insertInto('supplier_connections').values({ id: connectionId, display_name: 'Synthetic read-only',
      provider_type: 'kayixin_customer_v3', enabled: false, current_version_id: null, tested_version_id: null,
      created_by_admin_id: adminId }).execute()
    await trx.insertInto('supplier_connection_credentials').values({ supplier_connection_id: connectionId, credential_version: 1,
      provider_type: 'kayixin_customer_v3', auth_scheme: 'app_signature_v3', key_id: envelope.keyId,
      nonce: envelope.nonce, ciphertext: envelope.ciphertext, auth_tag: envelope.authTag }).execute()
    await trx.insertInto('supplier_connection_versions').values({ id: connectionVersionId, supplier_connection_id: connectionId,
      version_number: 1, display_name: 'Synthetic read-only', provider_type: 'kayixin_customer_v3',
      auth_scheme: 'app_signature_v3', base_url: 'https://synthetic.example.test', credential_version: 1, created_by_admin_id: adminId }).execute()
    await trx.updateTable('supplier_connections').set({ current_version_id: connectionVersionId }).where('id', '=', connectionId).execute()
  })
  skuA = await catalog('1.00'); skuB = await catalog('2.00'); skuZero = await catalog('0.00')
  await db.updateTable('storefront_customer_policy').set({ purchase_forms_status: 'active' }).where('singleton', '=', true).execute()
  app = await createApp({ db, config, logger: false }); await app.ready()
  secondDb = createDatabase()
  secondApp = await createApp({ db: secondDb, config, logger: false }); await secondApp.ready()
  const csrf = await app.inject({ method: 'GET', url: '/api/v1/customer/auth/csrf' })
  headers = { origin, cookie: `aikayun_customer_session=${customerToken}; ${cookie(csrf, 'aikayun_customer_csrf')}`,
    'x-csrf-token': csrf.json().data.csrfToken as string }
})

afterAll(async () => {
  await secondApp?.close(); await app?.close(); await secondDb?.destroy(); await db?.destroy()
  if (privateRoot) await rm(privateRoot, { recursive: true, force: true })
})

describe('⑥-4B-1 isolated procurement identities', () => {
  it('leaves ordinary reviewed-mapping orders without a procurement source or obligation', async () => {
    selected.rows = []
    const { order, body } = await checkout([line(skuA, await draft('ordinary-customer'))])
    ordinaryOrder = { id: order.id, body }
    expect(await db.selectFrom('order_item_procurement_sources').selectAll().where('order_id', '=', order.id).execute()).toEqual([])
    expect(await db.transaction().execute(trx => procurementPreparationEligibility(trx, order.id, order.items[0]!.id)))
      .toEqual({ eligible: false, reason: 'source_missing' })
    expect(await db.selectFrom('procurement_operations').selectAll().execute()).toEqual([])
  })

  it('separates frozen source from payment, reconciliation, refund and zero-value eligibility', async () => {
    selected.rows = [{ skuId: skuZero.skuId, mappingVersionId: skuZero.versionId }]
    const free = await checkout([line(skuZero, await draft('free-fixture'))])
    expect(await db.transaction().execute(trx => procurementPreparationEligibility(trx, free.order.id, free.order.items[0]!.id)))
      .toEqual({ eligible: false, reason: 'zero_amount' })

    selected.rows = [{ skuId: skuA.skuId, mappingVersionId: skuA.versionId }]
    const refundable = await checkout([line(skuA, await draft('refund-fixture'))])
    await pay(refundable.order.id)
    const refund = await app.inject({ method: 'POST', url: `/api/v1/customer/orders/${refundable.order.id}/refunds`, headers,
      payload: { idempotencyKey: randomUUID(), amount: '1.00', reason: 'fixture refund request' } })
    expect(refund.statusCode, refund.body).toBe(201)
    expect(await db.transaction().execute(trx => procurementPreparationEligibility(trx, refundable.order.id, refundable.order.items[0]!.id)))
      .toEqual({ eligible: false, reason: 'refund_conflict' })
    await expect(db.transaction().execute(trx => allocateProcurementIdentity(trx, refundable.order.id, refundable.order.items[0]!.id, [1])))
      .rejects.toMatchObject({ code: 'refund_conflict' })
    const refundId = refund.json().data.refunds.items[0].id as string
    const receipt = await db.selectFrom('payment_receipts as receipt').innerJoin('payment_attempts as attempt', 'attempt.id', 'receipt.payment_attempt_id')
      .select('receipt.id').where('attempt.order_id', '=', refundable.order.id).executeTakeFirstOrThrow()
    await db.transaction().execute(async trx => {
      await trx.updateTable('order_refunds').set({ status: 'approved', reviewed_by_admin_id: adminId }).where('id', '=', refundId).execute()
      await trx.insertInto('order_refund_allocations').values({ id: randomUUID(), refund_id: refundId,
        source_payment_receipt_id: receipt.id, operation_id: randomUUID(), request_sha256: digest,
        destination: 'gift_balance', amount: '1.00', status: 'reserved', provider: null, provider_refund_id: null }).execute()
      await trx.updateTable('order_refunds').set({ status: 'processing' }).where('id', '=', refundId).execute()
    })
    expect((await db.selectFrom('payment_receipts').select('refund_reserved_amount').where('id', '=', receipt.id).executeTakeFirstOrThrow())
      .refund_reserved_amount).toBe('1.00')
    expect(await db.transaction().execute(trx => procurementPreparationEligibility(trx, refundable.order.id, refundable.order.items[0]!.id)))
      .toEqual({ eligible: false, reason: 'refund_conflict' })

    const unsettled = await checkout([line(skuA, await draft('unsettled-fixture'))])
    await pay(unsettled.order.id)
    const attempt = await db.selectFrom('payment_attempts').select('id').where('order_id', '=', unsettled.order.id).executeTakeFirstOrThrow()
    const eventId = randomUUID()
    await db.insertInto('payment_provider_events').values({ id: eventId, payment_attempt_id: attempt.id, source: 'query',
      event_sha256: digest, verification: 'verified', disposition: 'reconciliation_required', provider_status: 'paid',
      provider_transaction_id: null, reported_amount: null, provider_paid_at: null, provider_time_text: null,
      payload: {}, error_code: null }).execute()
    const caseId = randomUUID()
    await db.insertInto('payment_provider_reconciliation_cases').values({ id: caseId, payment_attempt_id: attempt.id,
      reason: 'receipt_conflict', opening_callback_event_id: null, opening_query_event_id: eventId,
      resolved_at: null, resolved_by_admin_id: null, resolution_query_event_sha256: null,
      resolution_provider_transaction_id: null, resolution_payment_method: null, resolution_confirmed_amount: null,
      resolution_currency: null, resolution_payload: null }).execute()
    expect(await db.transaction().execute(trx => procurementPreparationEligibility(trx, unsettled.order.id, unsettled.order.items[0]!.id)))
      .toEqual({ eligible: false, reason: 'reconciliation_open' })
    await db.updateTable('payment_attempts').set({ status: 'reconciliation_required' }).where('id', '=', attempt.id).execute()
    await db.updateTable('payment_provider_reconciliation_cases').set({ state: 'resolved', resolved_at: new Date(),
      resolved_by_admin_id: adminId, resolution_query_event_sha256: digest, resolution_provider_transaction_id: 'synthetic-evidence',
      resolution_payment_method: 'alipay', resolution_confirmed_amount: '1.00', resolution_currency: 'CNY', resolution_payload: {} })
      .where('id', '=', caseId).execute()
    expect(await db.transaction().execute(trx => procurementPreparationEligibility(trx, unsettled.order.id, unsettled.order.items[0]!.id)))
      .toEqual({ eligible: false, reason: 'payment_unresolved' })
    expect(await db.selectFrom('procurement_operations').selectAll().execute()).toEqual([])
    raceOrders = []
    for (const name of ['procurement-first', 'refund-first', 'direct-refund']) {
      const race = await checkout([line(skuA, await draft(name))])
      await pay(race.order.id)
      raceOrders.push({ id: race.order.id, itemId: race.order.items[0]!.id })
    }
  })

  it('atomically freezes synthetic multi-SKU sources with per-content identities and private archive references', async () => {
    const same1 = await draft('identical'), same2 = await draft('identical')
    const different = await draft('private-account-value', true), other = await draft('other-sku')
    selected.rows = [skuA, skuB].map(sku => ({ skuId: sku.skuId, mappingVersionId: sku.versionId }))
    const result = await checkout([line(skuA, same1), line(skuA, same2), line(skuA, different), line(skuB, other)])
    expect(result.order.items).toHaveLength(3)
    expect(result.order.items.filter(item => item.skuId === skuA.skuId).map(item => item.quantity).sort()).toEqual([1, 2])
    const sources = await db.selectFrom('order_item_procurement_sources').selectAll().where('order_id', '=', result.order.id)
      .orderBy('order_item_id').execute()
    expect(sources).toHaveLength(3)
    expect(new Set(sources.map(source => source.order_item_id)).size).toBe(3)
    expect(sources.every(source => source.credential_version === 1 && source.supplier_connection_version_id === connectionVersionId
      && source.template_version_id === templateVersionId)).toBe(true)
    expect(JSON.stringify(sources)).not.toContain('private-account-value')
    expect(JSON.stringify(sources)).not.toContain(credentials.appSecret)
    const archive = await db.selectFrom('order_item_purchase_attachments').selectAll()
      .where('source_attachment_id', '=', different.attachmentId!).executeTakeFirstOrThrow()
    const image = await readOwnedOrderPurchaseAttachment(db, new PurchaseOrderAttachmentStorage(privateRoot), owner,
      archive.order_item_id, different.attachmentId!, result.order.id)
    expect(createHash('sha256').update(image.bytes).digest('hex')).toBe(archive.sha256)
    const otherId = randomUUID(), otherSession = randomUUID()
    await db.insertInto('customers').values({ id: otherId, username: `other-${otherId.slice(0, 8)}`, password_hash: 'fixture', status: 'active' }).execute()
    await db.insertInto('customer_sessions').values({ id: otherSession, customer_id: otherId, token_hash: 'f'.repeat(64),
      expires_at: new Date(Date.now() + 3_600_000), revoked_at: null }).execute()
    await expect(readOwnedOrderPurchaseAttachment(db, new PurchaseOrderAttachmentStorage(privateRoot),
      { kind: 'customer', customer: { id: otherId, sessionId: otherSession } }, archive.order_item_id, different.attachmentId!, result.order.id))
      .rejects.toMatchObject({ status: 404 })
    const multi = result.order.items.find(item => item.skuId === skuA.skuId && item.quantity === 2)!
    savedOrder = { id: result.order.id, itemId: multi.id, body: result.body,
      itemIds: result.order.items.map(item => item.id), attachmentId: different.attachmentId! }
    oldSources = sources
    expect(await db.transaction().execute(trx => procurementPreparationEligibility(trx, savedOrder.id, savedOrder.itemId)))
      .toEqual({ eligible: false, reason: 'order_not_processing' })
  })

  it('rolls back the entire checkout when a selected mapping becomes stale', async () => {
    const temporary = await catalog('1.00')
    const items = [line(temporary, await draft('rollback-sensitive-value')), line(skuA, await draft('valid-other-source'))]
    const quote = await app.inject({ method: 'POST', url: '/api/v1/checkout/quote', headers, payload: { version: 2, items } })
    expect(quote.statusCode, quote.body).toBe(200)
    selected.rows = [temporary, skuA].map(sku => ({ skuId: sku.skuId, mappingVersionId: sku.versionId }))
    await db.updateTable('supplier_product_mapping_heads').set({ status: 'stale', revision: 3 }).where('id', '=', temporary.mappingId).execute()
    const before = await db.selectFrom('orders').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()
    const snapshotsBefore = await db.selectFrom('order_item_purchase_snapshots').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()
    const response = await app.inject({ method: 'POST', url: '/api/v1/checkout/orders', headers,
      payload: { version: 2, items, idempotencyKey: randomUUID(), quoteToken: quote.json().data.quoteToken } })
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error.code).toBe('CHECKOUT_SOURCE_CHANGED')
    expect(await db.selectFrom('orders').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()).toEqual(before)
    expect(await db.selectFrom('order_item_purchase_snapshots').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow())
      .toEqual(snapshotsBefore)
  })

  it('rejects direct SQL cross-order, cross-SKU and wrong-version sources before sealing', async () => {
    const source = await db.selectFrom('order_item_procurement_sources').selectAll().where('order_id', '=', savedOrder.id)
      .where('product_variant_id', '=', skuA.skuId).executeTakeFirstOrThrow()
    for (const mode of ['order', 'sku', 'mapping', 'credential'] as const) {
      const orderId = randomUUID(), itemId = randomUUID()
      const target = mode === 'sku' ? skuB : skuA
      const code = `PROC-${target.skuId.slice(0, 8)}`
      const envelope = encryptPurchaseOrderValues(config, itemId, { [accountField]: 'synthetic' })
      const attempt = db.transaction().execute(async trx => {
        await trx.insertInto('orders').values({ id: orderId, customer_id: customerId, guest_order_session_id: null,
          idempotency_key: randomUUID(), request_sha256: digest, total_amount: target.price,
          unpaid_expires_at: new Date(Date.now() + 3_600_000), history_hidden_at: null,
          history_hidden_by_admin_id: null, history_hidden_reason: null }).execute()
        await trx.insertInto('order_items').values({ id: itemId, order_id: orderId, purchase_line_id: randomUUID(),
          product_id: target.productId, product_variant_id: target.skuId, product_name_snapshot: `Procurement fixture ${code}`,
          product_type_snapshot: 'digital', sku_code_snapshot: code, sku_snapshot: '[]', inventory_mode_snapshot: 'unlimited',
          fulfillment_method_snapshot: 'manual', fulfillment_content_version_id: null, unit_price: target.price,
          quantity: 1, line_amount: target.price }).execute()
        await trx.insertInto('order_item_purchase_snapshots').values({ order_item_id: itemId, template_version_id: templateVersionId,
          normalization_version: 1, content_identity: source.content_identity, encrypted_values: envelope.ciphertext,
          values_nonce: envelope.nonce, values_auth_tag: envelope.authTag, encryption_key_id: envelope.keyId, attachment_ids: [] }).execute()
        await trx.insertInto('order_item_procurement_sources').values({
          ...source, id: randomUUID(), order_id: mode === 'order' ? randomUUID() : orderId,
          order_item_id: itemId, product_id: target.productId, product_variant_id: target.skuId,
          mapping_version_id: mode === 'mapping' ? skuB.versionId : source.mapping_version_id,
          credential_version: mode === 'credential' ? 999 : source.credential_version,
          upstream_combination: JSON.stringify(source.upstream_combination),
        }).execute()
      })
      await expect(attempt).rejects.toMatchObject({ constraint: mode === 'order'
        ? 'procurement_source_order_identity_invalid' : 'procurement_source_version_mismatch' })
    }
  })

  it('preserves historical source, credential, attachments and original idempotent replay after rotation', async () => {
    await db.updateTable('supplier_product_mapping_heads').set({ status: 'stale', revision: 3 })
      .where('id', '=', skuA.mappingId).execute()
    const nextId = randomUUID()
    const rotated = { ...credentials, appSecret: 'different-synthetic-secret' }
    const encrypted = encryptSupplierCredentials(config, connectionId, 2, rotated)
    await db.transaction().execute(async trx => {
      await trx.insertInto('supplier_connection_credentials').values({ supplier_connection_id: connectionId, credential_version: 2,
        provider_type: 'kayixin_customer_v3', auth_scheme: 'app_signature_v3', key_id: encrypted.keyId,
        nonce: encrypted.nonce, ciphertext: encrypted.ciphertext, auth_tag: encrypted.authTag }).execute()
      await trx.insertInto('supplier_connection_versions').values({ id: nextId, supplier_connection_id: connectionId,
        version_number: 2, display_name: 'Rotated fixture', provider_type: 'kayixin_customer_v3',
        auth_scheme: 'app_signature_v3', base_url: 'https://synthetic.example.test', credential_version: 2, created_by_admin_id: adminId }).execute()
      await trx.updateTable('supplier_connections').set({ display_name: 'Rotated fixture', current_version_id: nextId })
        .where('id', '=', connectionId).execute()
    })
    expect(await db.selectFrom('order_item_procurement_sources').selectAll().where('order_id', '=', savedOrder.id)
      .orderBy('order_item_id').execute()).toEqual(oldSources)
    const historic = await db.selectFrom('supplier_connection_credentials').selectAll()
      .where('supplier_connection_id', '=', connectionId).where('credential_version', '=', 1).executeTakeFirstOrThrow()
    expect(decryptSupplierCredentials(config, connectionId, 1, 'kayixin_customer_v3', { keyId: historic.key_id,
      nonce: historic.nonce, ciphertext: historic.ciphertext, authTag: historic.auth_tag })).toEqual(credentials)
    selected.fail = true
    const replay = await app.inject({ method: 'POST', url: '/api/v1/checkout/orders', headers, payload: savedOrder.body })
    const ordinaryReplay = await app.inject({ method: 'POST', url: '/api/v1/checkout/orders', headers, payload: ordinaryOrder.body })
    selected.fail = false
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().data.order.id).toBe(savedOrder.id)
    expect(ordinaryReplay.statusCode, ordinaryReplay.body).toBe(200)
    expect(ordinaryReplay.json().data.order.id).toBe(ordinaryOrder.id)
    expect(await db.selectFrom('order_item_procurement_sources').selectAll().where('order_id', '=', ordinaryOrder.id).execute()).toEqual([])
    expect(await db.selectFrom('order_item_procurement_sources').selectAll().where('order_id', '=', savedOrder.id).execute()).toHaveLength(3)
    expect(await db.selectFrom('procurement_operations').selectAll().execute()).toEqual([])
  })

  it('serializes two instances on the order lock and permanently assigns each local unit once', async () => {
    await pay(savedOrder.id)
    expect(await db.transaction().execute(trx => procurementPreparationEligibility(trx, savedOrder.id, savedOrder.itemId)))
      .toMatchObject({ eligible: true })
    const held = gate(), release = gate(), secondStarted = gate()
    let secondPid = 0
    const first = db.transaction().execute(async trx => {
      const result = await allocateProcurementIdentity(trx, savedOrder.id, savedOrder.itemId, [2, 1])
      held.open(); await release.promise
      return result
    })
    await held.promise
    const second = secondDb.transaction().execute(async trx => {
      secondPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid
      secondStarted.open()
      return allocateProcurementIdentity(trx, savedOrder.id, savedOrder.itemId, [1, 2])
    })
    await secondStarted.promise
    let blocked = false
    try {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && !blocked) {
        blocked = (await sql<{ blocked: boolean }>`SELECT cardinality(pg_blocking_pids(${secondPid})) > 0 AS blocked`.execute(db)).rows[0]!.blocked
        if (!blocked) await new Promise<void>(resolve => setImmediate(resolve))
      }
      expect(blocked).toBe(true)
    } finally { release.open() }
    const [a, b] = await Promise.all([first, second])
    expect(a.repeated).toBe(false); expect(b).toEqual({ ...a, repeated: true })
    expect(await db.selectFrom('procurement_operation_units').select(['unit_index', 'state'])
      .where('operation_id', '=', a.id).orderBy('unit_index').execute()).toEqual([
      { unit_index: 1, state: 'allocated' }, { unit_index: 2, state: 'allocated' },
    ])
    await expect(db.transaction().execute(trx => allocateProcurementIdentity(trx, savedOrder.id, savedOrder.itemId, [1])))
      .rejects.toMatchObject({ code: 'unit_already_allocated' })
    await expect(db.transaction().execute(trx => allocateProcurementIdentity(trx, savedOrder.id, savedOrder.itemId, [3])))
      .rejects.toMatchObject({ constraint: 'procurement_unit_identity_invalid' })
    await expect(db.transaction().execute(trx => allocateProcurementIdentity(trx, savedOrder.id, savedOrder.itemId, [0])))
      .rejects.toMatchObject({ code: 'invalid_units' })
    const operations = await db.selectFrom('procurement_operations').selectAll().execute()
    expect(operations).toHaveLength(1)
    expect(operations[0]!.local_business_number).toBe(`local-procurement:${a.id}`)
    await expect(db.transaction().execute(async trx => {
      const duplicate = randomUUID()
      await trx.insertInto('procurement_operations').values({ id: duplicate, local_business_number: `local-procurement:${duplicate}`,
        source_id: operations[0]!.source_id, order_item_id: savedOrder.itemId }).execute()
      await trx.insertInto('procurement_operation_units').values({ operation_id: duplicate,
        order_item_id: savedOrder.itemId, unit_index: 1 }).execute()
    })).rejects.toMatchObject({ constraint: 'procurement_unit_one_obligation' })
    await expect(db.transaction().execute(async trx => {
      const incomplete = randomUUID()
      await trx.insertInto('procurement_operations').values({ id: incomplete, local_business_number: `local-procurement:${incomplete}`,
        source_id: operations[0]!.source_id, order_item_id: savedOrder.itemId }).execute()
    })).rejects.toMatchObject({ constraint: 'procurement_operation_units_incomplete' })
    await expect(db.transaction().execute(async trx => {
      const wrong = randomUUID()
      await trx.insertInto('procurement_operations').values({ id: wrong, local_business_number: `local-procurement:${wrong}`,
        source_id: operations[0]!.source_id, order_item_id: savedOrder.itemIds.find(id => id !== savedOrder.itemId)! }).execute()
    })).rejects.toMatchObject({ constraint: 'procurement_payment_ineligible' })
    await expect(db.updateTable('procurement_operations').set({ state: 'completed', revision: 2 }).where('id', '=', a.id).execute())
      .rejects.toMatchObject({ constraint: 'procurement_operation_state_transition' })
    await expect(db.updateTable('procurement_operation_units').set({ unit_index: 1 }).where('operation_id', '=', a.id)
      .where('unit_index', '=', 2).execute()).rejects.toMatchObject({ constraint: 'procurement_unit_transition_invalid' })
    await expect(sql`DELETE FROM procurement_operation_events WHERE operation_id = ${a.id}::uuid`.execute(db))
      .rejects.toMatchObject({ constraint: 'order_purchase_data_immutable' })
    const refund = await app.inject({ method: 'POST', url: `/api/v1/customer/orders/${savedOrder.id}/refunds`, headers,
      payload: { idempotencyKey: randomUUID(), amount: '1.00', reason: 'fixture refund request' } })
    expect(refund.statusCode, refund.body).toBe(409)
  })

  it('keeps historical unbudgeted identities non-executable and history append-only', async () => {
    const op = await db.selectFrom('procurement_operations').selectAll().executeTakeFirstOrThrow()
    await expect(db.updateTable('procurement_operations').set({ state: 'submit_in_flight', revision: 2 })
      .where('id', '=', op.id).execute()).rejects.toMatchObject({ constraint: 'procurement_submit_budget_required' })
    await expect(db.updateTable('procurement_operations').set({ state: 'rejected', revision: 2 })
      .where('id', '=', op.id).execute()).rejects.toMatchObject({ constraint: 'procurement_state_evidence_required' })
    expect(await db.selectFrom('procurement_operation_events').select('revision').where('operation_id', '=', op.id)
      .orderBy('revision').execute()).toEqual([0, 1].map(revision => ({ revision })))
    await expect(sql`UPDATE procurement_unit_events SET next_state = 'completed' WHERE operation_id = ${op.id}::uuid`.execute(db))
      .rejects.toMatchObject({ constraint: 'order_purchase_data_immutable' })
    await expect(sql`INSERT INTO procurement_operation_events(operation_id, previous_state, next_state, revision)
      VALUES (${op.id}::uuid, 'prepared', 'unknown', 2)`.execute(db))
      .rejects.toMatchObject({ constraint: 'procurement_history_insert_invalid' })
  })

  it('serializes refund and procurement in both orders using the actual order lock', async () => {
    const firstOrder = raceOrders[0]!
    const firstHeld = gate(), firstRelease = gate()
    let firstPid = 0
    const procurement = db.transaction().execute(async trx => {
      firstPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid
      const op = await allocateProcurementIdentity(trx, firstOrder.id, firstOrder.itemId, [1])
      firstHeld.open(); await firstRelease.promise
      return op
    })
    await firstHeld.promise
    const refund = secondApp.inject({ method: 'POST', url: `/api/v1/customer/orders/${firstOrder.id}/refunds`, headers,
      payload: { idempotencyKey: randomUUID(), amount: '1.00', reason: 'concurrent refund fixture' } })
    try { expect(await waitForBlockedBy(firstPid)).toBe(true) } finally { firstRelease.open() }
    const [, refundResponse] = await Promise.all([procurement, refund])
    expect(refundResponse.statusCode, refundResponse.body).toBe(409)
    expect(await db.selectFrom('order_refunds').select('id').where('order_id', '=', firstOrder.id).execute()).toEqual([])

    const secondOrder = raceOrders[1]!
    const refundHeld = gate(), refundRelease = gate()
    let refundPid = 0
    const refundFirst = db.transaction().execute(async trx => {
      refundPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid
      await trx.selectFrom('orders').select('id').where('id', '=', secondOrder.id).forUpdate().executeTakeFirstOrThrow()
      await trx.insertInto('order_refunds').values({ id: randomUUID(), order_id: secondOrder.id,
        idempotency_key: randomUUID(), request_sha256: digest, amount: '1.00', status: 'requested',
        reason: 'concurrent refund fixture' }).execute()
      refundHeld.open(); await refundRelease.promise
    })
    await refundHeld.promise
    const secondProcurement = secondDb.transaction().execute(trx =>
      allocateProcurementIdentity(trx, secondOrder.id, secondOrder.itemId, [1]))
      .then(value => ({ value, error: null }), error => ({ value: null, error }))
    try { expect(await waitForBlockedBy(refundPid)).toBe(true) } finally { refundRelease.open() }
    const [, result] = await Promise.all([refundFirst, secondProcurement])
    expect(result.error).toMatchObject({ code: 'refund_conflict' })
    expect(await db.selectFrom('procurement_operations').select('id').where('order_item_id', '=', secondOrder.itemId).execute()).toEqual([])

    const directOrder = raceOrders[2]!
    const directHeld = gate(), directRelease = gate()
    let directPid = 0
    const directProcurement = db.transaction().execute(async trx => {
      directPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid
      await allocateProcurementIdentity(trx, directOrder.id, directOrder.itemId, [1])
      directHeld.open(); await directRelease.promise
    })
    await directHeld.promise
    const directRefund = secondDb.transaction().execute(async trx => {
      await trx.insertInto('order_refunds').values({ id: randomUUID(), order_id: directOrder.id,
        idempotency_key: randomUUID(), request_sha256: digest, amount: '1.00', status: 'requested',
        reason: 'direct SQL refund fixture' }).execute()
    }).then(() => null, error => error)
    try { expect(await waitForBlockedBy(directPid)).toBe(true) } finally { directRelease.open() }
    const [, directError] = await Promise.all([directProcurement, directRefund])
    expect(directError).toMatchObject({ constraint: 'order_refund_fulfillment_unresolved' })
    expect(await db.selectFrom('order_refunds').select('id').where('order_id', '=', directOrder.id).execute()).toEqual([])
  })

  it('rejects retroactive binding and immutably retains source and operation history', async () => {
    const source = await db.selectFrom('order_item_procurement_sources').selectAll().where('order_id', '=', savedOrder.id).executeTakeFirstOrThrow()
    await expect(db.updateTable('order_item_procurement_sources').set({ mapping_version_id: skuB.versionId })
      .where('id', '=', source.id).execute()).rejects.toMatchObject({ constraint: 'order_purchase_data_immutable' })
    await expect(sql`INSERT INTO order_item_procurement_sources SELECT ${randomUUID()}::uuid, order_id, order_item_id,
      product_id, product_variant_id, mapping_version_id, supplier_connection_id, supplier_connection_version_id,
      credential_version, provider_type, template_version_id, template_sha256, normalization_version, content_identity,
      rules_sha256, structure_sha256, upstream_product_id, upstream_sku_type, upstream_sku_code, upstream_combination, created_at
      FROM order_item_procurement_sources WHERE id = ${source.id}::uuid`.execute(db))
      .rejects.toMatchObject({ constraint: 'procurement_source_order_identity_invalid' })
    const current = await db.selectFrom('supplier_connections').select('current_version_id').where('id', '=', connectionId).executeTakeFirstOrThrow()
    await expect(db.updateTable('supplier_connections').set({ enabled: true, tested_version_id: current.current_version_id })
      .where('id', '=', connectionId).execute())
      .rejects.toMatchObject({ constraint: 'supplier_protocol_readonly' })
  })
})
