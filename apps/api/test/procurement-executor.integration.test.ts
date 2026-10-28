import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { canonicalPurchaseFormJson, canonicalSupplierMappingJson } from '@aikayun/contracts'
import { prepareOrderItemProcurement } from '../src/commerce/procurement-preparation.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
import { PurchaseAttachmentStorage } from '../src/media/purchase-attachment-storage.js'
import { encryptSupplierCredentials } from '../src/commerce/supplier-api-crypto.js'
import { recordWalletOrderPayment } from '../src/finance/wallet.js'
import { allocateProcurementIdentity } from '../src/commerce/procurement-identity.js'

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
const accountField = randomUUID(), imageField = randomUUID(), digitsField = randomUUID(), selectField = randomUUID(), cascadeField = randomUUID(), expandedField = randomUUID()
const selectOption = randomUUID(), cascadeOption = randomUUID(), cascadeChild = randomUUID()
const definition = { fields: [
  { id: accountField, meaningKey: 'account', type: 'text', label: 'Account', required: true, maxLength: 120 },
  { id: imageField, meaningKey: 'proof', type: 'image', label: 'Proof', required: false, maxCount: 1 },
  { id: digitsField, meaningKey: 'digits', type: 'digits', label: 'Digits', required: false },
  { id: selectField, meaningKey: 'choice', type: 'select', label: 'Choice', required: false,
    options: [{ id: selectOption, meaningKey: 'choice_one', label: 'One' }] },
  { id: cascadeField, meaningKey: 'cascade', type: 'cascade', label: 'Cascade', required: false,
    options: [{ id: cascadeOption, meaningKey: 'plan', label: 'Plan', expandedFields: [
      { id: expandedField, meaningKey: 'extra', type: 'text', label: 'Extra', required: false },
    ], children: [{ id: cascadeChild, meaningKey: 'region', label: 'Region' }] }] },
] }
const structure = { version: 1, product: { goodsId: '123456', goodsType: 1, status: 1, skuType: 0, skuCode: null, combination: [] }, purchaseFields: [
  { type: 0, title: 'Account', placeholder: null, required: true, regex: null, options: [] },
  { type: 1, title: 'Proof', placeholder: null, required: false, regex: null, options: [] },
  { type: 13, title: 'Digits', placeholder: null, required: false, regex: null, options: [] },
  { type: 14, title: 'Choice', placeholder: null, required: false, regex: null, options: [
    { name: 'One', value: '  original option  ', children: [], expand: [] },
  ] },
  { type: 16, title: 'Cascade', placeholder: null, required: false, regex: null, options: [
    { name: 'Plan', value: 'plan-value', children: [{ name: 'Region', value: 'region-value', children: [], expand: [] }],
      expand: [{ type: 0, title: 'Extra', placeholder: null, required: false, regex: null, options: [] }] },
  ] },
] }
const rules = { version: 1, fields: [
  { localFieldId: accountField, localMeaningKey: 'account', upstreamPath: [{ kind: 'field', index: 0 }], options: [] },
  { localFieldId: imageField, localMeaningKey: 'proof', upstreamPath: [{ kind: 'field', index: 1 }], options: [] },
  { localFieldId: digitsField, localMeaningKey: 'digits', upstreamPath: [{ kind: 'field', index: 2 }], options: [] },
  { localFieldId: selectField, localMeaningKey: 'choice', upstreamPath: [{ kind: 'field', index: 3 }], options: [
    { localOptionId: selectOption, localMeaningKey: 'choice_one', upstreamPath: [{ kind: 'field', index: 3 }, { kind: 'option', index: 0 }] },
  ] },
  { localFieldId: cascadeField, localMeaningKey: 'cascade', upstreamPath: [{ kind: 'field', index: 4 }], options: [
    { localOptionId: cascadeOption, localMeaningKey: 'plan', upstreamPath: [{ kind: 'field', index: 4 }, { kind: 'option', index: 0 }] },
    { localOptionId: cascadeChild, localMeaningKey: 'region', upstreamPath: [{ kind: 'field', index: 4 }, { kind: 'option', index: 0 }, { kind: 'child', index: 0 }] },
  ] },
  { localFieldId: expandedField, localMeaningKey: 'extra', upstreamPath: [{ kind: 'field', index: 4 }, { kind: 'option', index: 0 }, { kind: 'expand', index: 0 }], options: [] },
] }
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const templateHash = hash(canonicalPurchaseFormJson({ name: 'Synthetic template v1', definition }))
const structureHash = hash(canonicalSupplierMappingJson(structure)), rulesHash = hash(canonicalSupplierMappingJson(rules))
const digest = 'd'.repeat(64)
const credentials = { providerType: 'kayixin_customer_v3' as const, appId: '12345', appSecret: 'synthetic-only-secret' }
const owner = { kind: 'customer' as const, customer: { id: customerId, sessionId } }
let db: Kysely<Database>, secondDb: Kysely<Database>, config: AppConfig
let app: FastifyInstance, secondApp: FastifyInstance, thirdApp: FastifyInstance, fourthApp: FastifyInstance, privateRoot: string
let headers: Record<string, string>
let skuA: Catalog
let trackCrashFixtureDrafts = false
const crashFixtureDraftIds: string[] = []

type Catalog = { productId: string; skuId: string; mappingId: string; versionId: string; price: string }

function cookie(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers['set-cookie']
  const rows = Array.isArray(value) ? value : [value ?? '']
  return rows.find(row => row.startsWith(`${name}=`))!.split(';')[0]!
}

async function catalog(price: string, quantityStock = false, supplier = { id: connectionId, versionId: connectionVersionId }): Promise<Catalog> {
  const productId = randomUUID(), skuId = randomUUID(), mappingId = randomUUID(), versionId = randomUUID()
  const code = `PROC-${skuId.slice(0, 8)}`
  await db.transaction().execute(async trx => {
    await trx.insertInto('products').values({ id: productId, name: `Procurement fixture ${code}`,
      description: '', product_type: 'digital', status: 'active' }).execute()
    await trx.insertInto('product_variants').values({ id: skuId, product_id: productId, sku_code: code,
      combination_key: '', sale_price: price, enabled: true, inventory_mode: quantityStock ? 'quantity' : 'unlimited' }).execute()
    if (quantityStock) await trx.insertInto('product_variant_quantity_inventory').values({
      product_id: productId, product_variant_id: skuId, stocked: 10, reserved: 0 }).execute()
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
      VALUES (${mappingId}::uuid, ${productId}::uuid, ${skuId}::uuid, ${supplier.id}::uuid, ${supplier.versionId}::uuid,
        '123456', 'synthetic good', 0, NULL, '[]'::jsonb, ${JSON.stringify(structure)}::jsonb, ${structureHash}, now(),
        ${templateId}::uuid, ${templateVersionId}::uuid, ${templateHash}, 1, ${JSON.stringify(rules)}::jsonb,
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
  if (trackCrashFixtureDrafts) crashFixtureDraftIds.push(created.id)
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

function beginCrashFixtureDraftTracking(): void {
  trackCrashFixtureDrafts = true
}

type Line = { lineId: string; skuId: string; quantity: number; draftId: string; draftRevision: number }
function line(sku: Catalog, saved: Awaited<ReturnType<typeof draft>>, quantity = 1): Line {
  return { lineId: randomUUID(), skuId: sku.skuId, quantity, draftId: saved.id, draftRevision: saved.revision }
}
let checkoutSequence = 0
async function checkout(items: Line[]) {
  const checkoutApp = [app, secondApp, thirdApp, fourthApp][checkoutSequence++ % 4]!
  const quote = await checkoutApp.inject({ method: 'POST', url: '/api/v1/checkout/quote', headers, payload: { version: 2, items } })
  expect(quote.statusCode, quote.body).toBe(200)
  expect(quote.json().data.canContinue, quote.body).toBe(true)
  const body = { version: 2, items, idempotencyKey: randomUUID(), quoteToken: quote.json().data.quoteToken as string }
  const result = await checkoutApp.inject({ method: 'POST', url: '/api/v1/checkout/orders', headers, payload: body })
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


async function waitForSupplierStats(
  supplier: Awaited<ReturnType<typeof startProcurementSupplierProcess>>,
  predicate: (stats: Awaited<ReturnType<typeof supplier.stats>>) => boolean,
) {
  const deadline = Date.now() + 15_000
  let stats = await supplier.stats()
  while (!predicate(stats) && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    stats = await supplier.stats()
  }
  if (!predicate(stats)) throw new Error('Timed out waiting for supplier fixture event: ' + JSON.stringify(stats))
  return stats
}

async function paidProcurementOrder(quantity = 1, sku = skuA) {
  selected.rows = [{ skuId: sku.skuId, mappingVersionId: sku.versionId }]
  const result = await checkout([line(sku, await draft(randomUUID()), quantity)])
  await pay(result.order.id)
  return { order: result.order, item: result.order.items[0]! }
}

async function ensureTestRiskPolicy() {
  await db.transaction().execute(trx => initializeSyntheticProcurementRiskPolicy(trx, { currency: 'TST', limits: {
    perOperationMinor: '100', globalDailyMinor: '10000', globalOutstandingMinor: '10000',
    supplierDailyMinor: '10000', supplierOutstandingMinor: '10000', skuDailyMinor: '10000', skuOutstandingMinor: '10000',
  } }))
}

async function currentCatalog(quantityStock = false): Promise<Catalog> {
  const connection = await db.selectFrom('supplier_connections').select('current_version_id')
    .where('id', '=', connectionId).executeTakeFirstOrThrow()
  if (!connection.current_version_id) throw new Error('Synthetic supplier has no current credential version')
  return catalog('1.00', quantityStock, { id: connectionId, versionId: connection.current_version_id })
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
  skuA = await catalog('1.00')
  await db.updateTable('storefront_customer_policy').set({ purchase_forms_status: 'active' }).where('singleton', '=', true).execute()
  app = await createApp({ db, config, logger: false }); await app.ready()
  secondDb = createDatabase()
  secondApp = await createApp({ db: secondDb, config, logger: false }); await secondApp.ready()
  thirdApp = await createApp({ db, config, logger: false }); await thirdApp.ready()
  fourthApp = await createApp({ db, config, logger: false }); await fourthApp.ready()
  const csrf = await app.inject({ method: 'GET', url: '/api/v1/customer/auth/csrf' })
  headers = { origin, cookie: `aikayun_customer_session=${customerToken}; ${cookie(csrf, 'aikayun_customer_csrf')}`,
    'x-csrf-token': csrf.json().data.csrfToken as string }
})

afterAll(async () => {
  await fourthApp?.close(); await thirdApp?.close(); await secondApp?.close(); await app?.close(); await secondDb?.destroy(); await db?.destroy()
  if (privateRoot) await rm(privateRoot, { recursive: true, force: true })
})

afterEach(async () => {
  if (!trackCrashFixtureDrafts) return
  trackCrashFixtureDrafts = false
  const ids = crashFixtureDraftIds.splice(0)
  if (!ids.length) return
  await sql`UPDATE purchase_drafts SET expires_at=created_at+interval '1 microsecond'
    WHERE id=ANY(${ids}::uuid[]) AND status='active'`.execute(db)
})


import { createServer, type Server } from 'node:http'
import { prepareProcurementWithRisk, runProcurementFixturePass, type ProcurementFixtureRequest, type ProcurementFixtureResult } from '../src/commerce/procurement-executor.js'
import { initializeSyntheticProcurementRiskPolicy, readProcurementRisk, recordProcurementRiskFact, lockProcurementRiskPolicy, reserveProcurementRisk } from '../src/commerce/procurement-risk-budget.js'
import { finalizeProcurementUnit } from '../src/commerce/procurement-finalization.js'
import { startProcurementCrashProcess, startProcurementSupplierProcess } from './fixtures/procurement-crash-tools.js'
import { createKayixinProcurementFixtureTransport } from './fixtures/kayixin-procurement-transport.js'
import { resolveKayixinFixtureSource } from './fixtures/kayixin-procurement-source.js'
import { runKayixinFixturePass } from './fixtures/kayixin-procurement-pass.js'
import { signKayixinV3 } from '../src/commerce/kayixin-customer-v3.js'

async function readyOperation(quantity = 1, sku = skuA, utcDay?: string) {
  selected.rows = [{ skuId: sku.skuId, mappingVersionId: sku.versionId }]
  const result = await checkout([line(sku, await draft(randomUUID()), quantity)])
  await pay(result.order.id)
  const item = result.order.items[0]!
  const requestId = randomUUID()
  const unitIndices = Array.from({ length: quantity }, (_, i) => i + 1)
  const operation = await db.transaction().execute(async trx => {
    if (!utcDay) return prepareProcurementWithRisk(trx, { requestId, orderId: result.order.id,
      orderItemId: item.id, unitIndices, currency: 'TST', maxAmountMinor: '10' })
    const identity = await allocateProcurementIdentity(trx, result.order.id, item.id, unitIndices)
    await reserveProcurementRisk(trx, { operationId: identity.id, currency: 'TST', maxAmountMinor: '10', utcDay })
    await sql`INSERT INTO procurement_preparation_requests(request_id,operation_id,order_id,order_item_id,unit_indices,currency,max_amount_minor)
      VALUES (${requestId}::uuid,${identity.id}::uuid,${result.order.id}::uuid,${item.id}::uuid,${unitIndices}::integer[],'TST',10)`.execute(trx)
    return identity
  })
  return { ...operation, requestId }
}

async function fixtureServer(handler: (request: ProcurementFixtureRequest) => Promise<ProcurementFixtureResult>) {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      void handler(JSON.parse(Buffer.concat(chunks).toString()) as ProcurementFixtureRequest).then(result => {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
      }).catch(() => { response.writeHead(500); response.end() })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable')
  const transport = async (request: ProcurementFixtureRequest): Promise<ProcurementFixtureResult> => {
    const response = await fetch(`http://127.0.0.1:${address.port}/fixture`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
    if (!response.ok) throw new Error('fixture unavailable')
    return await response.json() as ProcurementFixtureResult
  }
  return { transport, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

describe('⑥-4B-2 isolated procurement fixture', () => {
  it('prepares frozen order data independently and never grants purchasing eligibility', async () => {
    selected.rows = [{ skuId: skuA.skuId, mappingVersionId: skuA.versionId }]
    const a = await draft('  0000123  '), b = await draft('different', true)
    const result = await checkout([line(skuA, a, 2), line(skuA, b)])
    const prepare = (id: string) => db.transaction().execute(trx => prepareOrderItemProcurement(trx, config, id))
    const firstItem = result.order.items.find(item => item.quantity === 2)!
    const secondItem = result.order.items.find(item => item.quantity === 1)!
    const first = await prepare(firstItem.id)
    expect(first).toMatchObject({ kind: 'prepared', quantity: 2, paymentEligibility: 'order_not_processing', purchaseEligible: false,
      fields: [{ localFieldId: accountField, value: '  0000123  ' }] })
    await pay(result.order.id)
    const paid = await prepare(firstItem.id)
    expect(paid).toMatchObject({ kind: 'prepared', paymentEligibility: 'eligible', purchaseEligible: false })
    const second = await prepare(secondItem.id)
    expect(second).toMatchObject({ kind: 'prepared', quantity: 1, purchaseEligible: false,
      fields: [{ localFieldId: accountField, value: 'different' }, { localFieldId: imageField, attachments: [{ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] }] })
    expect(JSON.stringify(second)).not.toContain('storage_key')
    expect(JSON.stringify(second)).not.toContain(credentials.appSecret)
    expect(await db.selectFrom('procurement_operations').select('id').where('order_item_id', '=', firstItem.id).execute()).toHaveLength(0)
  })
  it('preserves numeric strings, option identities, conditional fields and frozen mapping on checkout replay', async () => {
    selected.rows = [{ skuId: skuA.skuId, mappingVersionId: skuA.versionId }]
    const created = await createPurchaseDraft(db, config, owner, templateVersionId)
    const saved = await savePurchaseDraft(db, config, owner, { draftId: created.id, expectedRevision: created.revision, values: {
      [accountField]: ' account ', [digitsField]: '000123', [selectField]: selectOption,
      [cascadeField]: { path: [cascadeOption, cascadeChild], expanded: { [expandedField]: '  extra  ' } },
    } })
    const result = await checkout([{ lineId: randomUUID(), skuId: skuA.skuId, quantity: 1, draftId: created.id, draftRevision: saved.revision }])
    const prepare = () => db.transaction().execute(trx => prepareOrderItemProcurement(trx, config, result.order.items[0]!.id))
    const first = await prepare()
    expect(first).toMatchObject({ kind: 'prepared', purchaseEligible: false })
    if (first.kind !== 'prepared') throw new Error(first.reason)
    expect(first.fields.find(field => field.localFieldId === digitsField)?.value).toBe('000123')
    expect(first.fields.find(field => field.localFieldId === selectField)?.options).toMatchObject([{ localOptionId: selectOption, value: '  original option  ' }])
    expect(first.fields.find(field => field.localFieldId === cascadeField)?.options).toMatchObject([{ localOptionId: cascadeOption, value: 'plan-value' }, { localOptionId: cascadeChild, value: 'region-value' }])
    expect(first.fields.find(field => field.localFieldId === expandedField)).toMatchObject({ value: '  extra  ', upstreamPath: [{ kind: 'field', index: 4 }, { kind: 'option', index: 0 }, { kind: 'expand', index: 0 }] })
    selected.fail = true
    try {
      const replay = await app.inject({ method: 'POST', url: '/api/v1/checkout/orders', headers, payload: result.body })
      expect(replay.statusCode).toBe(200)
    } finally { selected.fail = false }
    expect(await prepare()).toEqual(first)
    expect(await db.selectFrom('procurement_operations').select('id').where('order_item_id', '=', result.order.items[0]!.id).execute()).toHaveLength(0)
  })
  it('keeps mixed order items tied to their frozen mapping after the current mapping changes', async () => {
    const one = await catalog('1.00'), two = await catalog('2.00')
    selected.rows = [{ skuId: one.skuId, mappingVersionId: one.versionId }, { skuId: two.skuId, mappingVersionId: two.versionId }]
    const result = await checkout([line(one, await draft('first')), line(two, await draft('second'))])
    await pay(result.order.id)
    const itemOne = result.order.items.find(item => item.skuId === one.skuId)!
    const itemTwo = result.order.items.find(item => item.skuId === two.skuId)!
    const prepare = (id: string) => db.transaction().execute(trx => prepareOrderItemProcurement(trx, config, id))
    const before = await prepare(itemOne.id)
    expect(before).toMatchObject({ kind: 'prepared', mappingVersionId: one.versionId, fields: [{ value: 'first' }], purchaseEligible: false })
    expect(await prepare(itemTwo.id)).toMatchObject({ kind: 'prepared', mappingVersionId: two.versionId, fields: [{ value: 'second' }], purchaseEligible: false })
    const changedRules = { version: 1, fields: [] }
    await db.updateTable('supplier_product_mapping_heads').set({ status: 'draft', revision: 3, rules: changedRules,
      rules_sha256: hash(canonicalSupplierMappingJson(changedRules)) }).where('id', '=', one.mappingId).executeTakeFirstOrThrow()
    expect(await prepare(itemOne.id)).toEqual(before)
  })
  it('blocks ordinary orders without a frozen procurement source', async () => {
    selected.rows = []
    const result = await checkout([line(skuA, await draft('unmapped'))])
    expect(await db.transaction().execute(trx => prepareOrderItemProcurement(trx, config, result.order.items[0]!.id)))
      .toEqual({ kind: 'blocked', reason: 'source_missing', purchaseEligible: false })
  })

  it('connects the offline V3 adapter to the kernel without creating or completing a purchase', async () => {
    await ensureTestRiskPolicy()
    const op = await readyOperation()
    const seen: Array<{ path: string; body: string; signature: string }> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        seen.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString('utf8'),
          signature: String(request.headers['x-signature']) })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 1000, msg: 'ok', data: {
          outerNumber: 'fixture-outer', orderNumber: 'fixture-order', status: 3,
        } }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable')
    const wire: Parameters<typeof runKayixinFixturePass>[3] = async request => {
        const response = await fetch(`http://127.0.0.1:${address.port}${request.path}`, {
          method: 'POST', headers: request.headers, body: request.body,
        })
        return { status: response.status, body: await response.text() }
    }
    const outerNumber = (id: string, identity: string) => id === op.id && identity === op.localBusinessNumber ? 'fixture-outer' : null
    try {
      expect(await runKayixinFixturePass(db, { ...config, paymentCredentialKeyRing: null }, op.id, wire, outerNumber)).toBe(false)
      expect(await db.selectFrom('procurement_request_intents').select('id').where('operation_id', '=', op.id).execute()).toHaveLength(0)
      expect(await runKayixinFixturePass(db, config, op.id, wire, outerNumber)).toBe(true)
      expect(seen).toHaveLength(0)
      for (let i = 0; i < 2; i++) {
        await sql`UPDATE procurement_execution_leases SET next_action_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
        expect(await runKayixinFixturePass(db, config, op.id, wire, outerNumber)).toBe(true)
      }
      expect(seen.map(row => [row.path, JSON.parse(row.body)])).toEqual([
        ['/api/v3/order/getDetail', { outerNumber: 'fixture-outer' }],
        ['/api/v3/order/getDetail', { orderNumber: 'fixture-order' }],
      ])
      for (const row of seen) expect(row.signature).toBe(signKayixinV3(credentials.appId, credentials.appSecret, '1700000000', row.body))
      expect(await db.selectFrom('procurement_request_intents').select('action').where('operation_id', '=', op.id).orderBy('generation').execute())
        .toEqual([{ action: 'submit' }, { action: 'query' }, { action: 'query' }])
      expect(await db.selectFrom('procurement_operations').select(['state', 'supplier_order_number']).where('id', '=', op.id).executeTakeFirstOrThrow())
        .toEqual({ state: 'unknown', supplier_order_number: 'fixture-order' })
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, op.id)))?.outstandingMinor).toBe('10')
      expect(await finalizeProcurementUnit(db, op.id, 1)).toBe('not_ready')
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
  it('records an adapter identity conflict without trusting the conflicting supplier number', async () => {
    await ensureTestRiskPolicy()
    const op = await readyOperation()
    const transport = createKayixinProcurementFixtureTransport({
      supplier: { baseUrl: 'https://synthetic.example.test', appId: credentials.appId, appSecret: credentials.appSecret },
      timestamp: () => '1700000000', outerNumberForOperation: () => 'fixture-outer',
      wire: async () => ({ status: 200, body: JSON.stringify({ code: 1000, msg: 'ok', data: {
        outerNumber: 'different-outer', orderNumber: 'untrusted-number', status: 3,
      } }) }),
    })
    await runProcurementFixturePass(db, op.id, transport, async () => true)
    await sql`UPDATE procurement_execution_leases SET next_action_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
    await runProcurementFixturePass(db, op.id, transport, async () => true)
    expect(await db.selectFrom('procurement_operations').select(['state', 'supplier_order_number']).where('id', '=', op.id).executeTakeFirstOrThrow())
      .toEqual({ state: 'manual_review', supplier_order_number: null })
    expect(await db.selectFrom('procurement_execution_evidence').select(['kind', 'supplier_order_number']).where('operation_id', '=', op.id).orderBy('generation').execute())
      .toEqual([{ kind: 'unknown', supplier_order_number: null }, { kind: 'identity_conflict', supplier_order_number: null }])
    expect((await db.transaction().execute(trx => readProcurementRisk(trx, op.id)))?.outstandingMinor).toBe('10')
    expect(await runProcurementFixturePass(db, op.id, transport, async () => true)).toBe(false)
    expect(await finalizeProcurementUnit(db, op.id, 1)).toBe('not_ready')
  })
  it.each(['accepted', 'completed', 'rejected'] as const)('R1 prevents cross-operation supplier number collision after A is %s', async mode => {
    await db.transaction().execute(trx => initializeSyntheticProcurementRiskPolicy(trx, { currency: 'TST', limits: {
      perOperationMinor: '100', globalDailyMinor: '10000', globalOutstandingMinor: '10000',
      supplierDailyMinor: '10000', supplierOutstandingMinor: '10000', skuDailyMinor: '10000', skuOutstandingMinor: '10000',
    } }))
    const a = await readyOperation(1, skuA, mode === 'rejected' ? '2000-01-01' : undefined), b = await readyOperation(), requests: ProcurementFixtureRequest[] = []
    const number = `collision-${randomUUID()}`, bEntered = gate(), bResponse = gate()
    let concurrentReplacement: Awaited<ReturnType<typeof prepareProcurementWithRisk>> | undefined
    const server = await fixtureServer(async request => {
      requests.push(request)
      if (mode === 'rejected' && request.operationId === b.id) { bEntered.open(); await bResponse.promise }
      if (request.operationId === a.id && mode === 'completed') return { requestIdentity: request.requestIdentity, kind: 'success',
        supplierOrderNumber: number, unitIndices: [1], deliveryConfirmed: true, responseDigest: digest }
      if (request.operationId === a.id && mode === 'rejected' && request.action === 'query') return {
        requestIdentity: request.requestIdentity, kind: 'rejected', supplierOrderNumber: number, responseDigest: digest }
      return { requestIdentity: request.requestIdentity, kind: 'accepted', supplierOrderNumber: number, responseDigest: digest }
    })
    try {
      await runProcurementFixturePass(db, a.id, server.transport, async () => true)
      if (mode === 'completed') expect(await finalizeProcurementUnit(db, a.id, 1)).toBe('completed')
      if (mode === 'rejected') {
        await sql`UPDATE procurement_execution_leases SET next_action_at=clock_timestamp()-interval '1 second' WHERE operation_id=${a.id}::uuid`.execute(db)
        await runProcurementFixturePass(db, a.id, server.transport, async () => true)
        const evidenceId = randomUUID()
        await db.transaction().execute(async trx => {
          const source = (await sql<{ order_id: string; order_item_id: string; local_business_number: string }>`
            SELECT s.order_id,o.order_item_id,o.local_business_number FROM procurement_operations o
            JOIN order_item_procurement_sources s ON s.id=o.source_id WHERE o.id=${a.id}::uuid`.execute(trx)).rows[0]!
          await sql`SELECT id FROM orders WHERE id=${source.order_id}::uuid FOR UPDATE`.execute(trx)
          await sql`SELECT id FROM order_items WHERE id=${source.order_item_id}::uuid FOR UPDATE`.execute(trx)
          await lockProcurementRiskPolicy(trx, a.id)
          await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,response_digest,supplier_order_number,amount_minor,currency)
            VALUES (${evidenceId}::uuid,${a.id}::uuid,2,'query','rejected',${source.local_business_number},${digest},${number},10,'TST')`.execute(trx)
          await recordProcurementRiskFact(trx, { operationId: a.id, factId: randomUUID(), kind: 'release', amountMinor: '10', evidenceId })
          await sql`UPDATE procurement_operations SET state='rejected',revision=revision+1 WHERE id=${a.id}::uuid`.execute(trx)
          await sql`UPDATE procurement_operation_units SET state='rejected' WHERE operation_id=${a.id}::uuid`.execute(trx)
        })
      }
      if (mode === 'rejected') {
        const pending = runProcurementFixturePass(secondDb, b.id, server.transport, async () => true)
        await bEntered.promise
        const held = gate(), release = gate()
        let blockerPid = 0
        const collision = db.transaction().execute(async trx => {
          const info = (await sql<{ order_id: string; order_item_id: string; local_business_number: string }>`
            SELECT s.order_id,o.order_item_id,o.local_business_number FROM procurement_operations o
            JOIN order_item_procurement_sources s ON s.id=o.source_id WHERE o.id=${b.id}::uuid`.execute(trx)).rows[0]!
          await sql`SELECT id FROM orders WHERE id=${info.order_id}::uuid FOR UPDATE`.execute(trx)
          await sql`SELECT id FROM order_items WHERE id=${info.order_item_id}::uuid FOR UPDATE`.execute(trx)
          await lockProcurementRiskPolicy(trx, b.id)
          blockerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid
          await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,supplier_order_number,response_digest)
            VALUES (${randomUUID()}::uuid,${b.id}::uuid,1,'submit','accepted',${info.local_business_number},${number},${digest})`.execute(trx)
          held.open(); await release.promise
        })
        await held.promise
        const aOrder = (await sql<{ order_id: string }>`SELECT s.order_id FROM procurement_operations o
          JOIN order_item_procurement_sources s ON s.id=o.source_id WHERE o.id=${a.id}::uuid`.execute(db)).rows[0]!.order_id
        const aItem = (await sql<{ order_item_id: string }>`SELECT order_item_id FROM procurement_operations WHERE id=${a.id}::uuid`.execute(db)).rows[0]!.order_item_id
        const token = randomBytes(32).toString('base64url')
        await db.insertInto('admin_sessions').values({ id: randomUUID(), admin_user_id: adminId, token_hash: hashToken(token),
          expires_at: new Date(Date.now() + 60_000), revoked_at: null }).execute()
        const csrf = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
        const admin = { origin, cookie: `aikayun_admin_session=${token}; ${cookie(csrf, 'aikayun_admin_csrf')}`,
          'x-csrf-token': csrf.json().data.csrfToken as string }
        const refund = app.inject({ method: 'POST', url: `/api/v1/customer/orders/${aOrder}/refunds`, headers,
          payload: { idempotencyKey: randomUUID(), amount: '1.00', reason: 'concurrent supplier collision' } })
        const manual = secondApp.inject({ method: 'POST', url: `/api/v1/admin/orders/${aOrder}/items/${aItem}/fulfillments`, headers: admin,
          payload: { operationId: randomUUID(), deliveries: [{ content: 'must-not-be-delivered' }] } })
        const replacement = secondDb.transaction().execute(trx => prepareProcurementWithRisk(trx, { requestId: randomUUID(),
          orderId: aOrder, orderItemId: aItem, unitIndices: [1], currency: 'TST', maxAmountMinor: '10' }))
        let blocked = 0
        const deadline = Date.now() + 10000
        while (blocked < 3 && Date.now() < deadline) {
          blocked = (await sql<{ count: number }>`WITH RECURSIVE blocked(pid) AS (
            SELECT ${blockerPid}::integer UNION SELECT activity.pid FROM pg_stat_activity activity
            JOIN blocked parent ON parent.pid=ANY(pg_blocking_pids(activity.pid)))
            SELECT (count(*)-1)::integer AS count FROM blocked`.execute(db)).rows[0]!.count
          if (blocked < 3) await new Promise<void>(resolve => setImmediate(resolve))
        }
        release.open(); await collision
        const [refundResponse, manualResponse, replacementResult] = await Promise.all([refund, manual, replacement])
        concurrentReplacement = replacementResult
        expect(blocked).toBeGreaterThanOrEqual(3)
        expect(refundResponse.statusCode).toBe(409); expect(manualResponse.statusCode).toBe(409)
        bResponse.open(); await pending
      } else await runProcurementFixturePass(secondDb, b.id, server.transport, async () => true)
      if (mode === 'accepted') {
        await sql`UPDATE procurement_execution_leases SET next_action_at=clock_timestamp()-interval '1 second' WHERE operation_id=${a.id}::uuid`.execute(db)
        await runProcurementFixturePass(db, a.id, server.transport, async () => true)
      }
      const state = await sql<{ id: string; state: string; supplier_order_number: string | null }>`SELECT id,state,supplier_order_number
        FROM procurement_operations WHERE id IN (${a.id}::uuid,${b.id}::uuid)`.execute(db)
      const aState = state.rows.find(row => row.id === a.id)!, bState = state.rows.find(row => row.id === b.id)!
      const source = (await sql<{ order_id: string }>`SELECT order_id FROM order_item_procurement_sources s
        JOIN procurement_operations o ON o.source_id=s.id WHERE o.id=${a.id}::uuid`.execute(db)).rows[0]!
      const unresolved = (await sql<{ value: boolean }>`SELECT order_has_unresolved_fulfillment(${source.order_id}::uuid) AS value`.execute(db)).rows[0]!.value
      const conflicts = (await sql<{ operation_id: string }>`SELECT DISTINCT operation_id FROM procurement_execution_conflicts
        WHERE reason='supplier_number' AND operation_id IN (${a.id}::uuid,${b.id}::uuid)`.execute(db)).rows
      const evidence = (await sql<{ operation_id: string }>`SELECT DISTINCT operation_id FROM procurement_execution_evidence
        WHERE supplier_order_number=${number} AND operation_id IN (${a.id}::uuid,${b.id}::uuid)`.execute(db)).rows
      expect(new Set(evidence.map(row => row.operation_id))).toEqual(new Set([a.id,b.id]))
      const risk = await db.transaction().execute(trx => readProcurementRisk(trx, a.id))
      if (mode === 'accepted') {
        await expect(db.transaction().execute(async trx => {
          await sql`UPDATE procurement_execution_leases SET lease_token=${randomUUID()}::uuid,
            lease_expires_at=clock_timestamp()+interval '1 minute',request_generation=request_generation+1
            WHERE operation_id=${a.id}::uuid`.execute(trx)
          await sql`INSERT INTO procurement_request_intents(id,operation_id,generation,action,request_identity)
            SELECT ${randomUUID()}::uuid,operation_id,request_generation,'query',${a.localBusinessNumber}
            FROM procurement_execution_leases WHERE operation_id=${a.id}::uuid`.execute(trx)
        })).rejects.toMatchObject({ constraint: 'procurement_global_conflict' })
      }
      if (mode !== 'accepted') {
        const refund = await app.inject({ method: 'POST', url: `/api/v1/customer/orders/${source.order_id}/refunds`, headers,
          payload: { idempotencyKey: randomUUID(), amount: '1.00', reason: 'supplier number conflict' } })
        expect(refund.statusCode).toBe(409)
        const bEvidence = (await sql<{ request_identity: string }>`SELECT request_identity FROM procurement_request_intents
          WHERE operation_id=${b.id}::uuid AND action='submit'`.execute(db)).rows[0]!
        await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,supplier_order_number,response_digest)
          VALUES (${randomUUID()}::uuid,${b.id}::uuid,1,'submit','accepted',${bEvidence.request_identity},${number},${digest})`.execute(db)
        const ledger = await sql<{ kind: string }>`SELECT kind FROM procurement_risk_events WHERE operation_id=${a.id}::uuid`.execute(db)
        expect(ledger.rows.filter(row => row.kind === 'reinstate')).toHaveLength(mode === 'rejected' ? 1 : 0)
        expect(ledger.rows.filter(row => row.kind === 'debit')).toHaveLength(0)
        if (mode === 'completed') {
          expect(await finalizeProcurementUnit(db, a.id, 1)).toBe('already_completed')
          const delivered = await sql<{ count: string }>`SELECT count(*)::text AS count FROM order_item_fulfillment_deliveries d
            JOIN order_item_fulfillment_attempts attempt ON attempt.id=d.fulfillment_attempt_id
            WHERE attempt.procurement_operation_id=${a.id}::uuid AND attempt.status='succeeded'`.execute(db)
          expect(delivered.rows[0]!.count).toBe('1')
          expect((await db.selectFrom('orders').select('status').where('id', '=', source.order_id).executeTakeFirstOrThrow()).status).toBe('completed')
        }
        if (mode === 'rejected') {
          const item = (await sql<{ order_item_id: string }>`SELECT order_item_id FROM procurement_operations WHERE id=${a.id}::uuid`.execute(db)).rows[0]!
          await expect(sql`INSERT INTO order_item_fulfillment_attempts(id,order_item_id,operation_id,quantity,status,delivery_source,started_by_admin_id)
            VALUES (${randomUUID()}::uuid,${item.order_item_id}::uuid,${randomUUID()}::uuid,1,'processing','manual',${adminId}::uuid)`.execute(db))
            .rejects.toMatchObject({ constraint: 'procurement_fulfillment_conflict' })
          expect(concurrentReplacement).toBeDefined()
          expect(await runProcurementFixturePass(db, concurrentReplacement!.id, server.transport, async () => true)).toBe(false)
        }
      }
      const expectedRequests = mode === 'rejected' ? ['submit', 'query', 'submit'] : ['submit', 'submit']
      expect({ actions: requests.map(r => r.action), requestNumbers: requests.map(r => r.supplierOrderNumber), aState: aState.state,
        aNumber: aState.supplier_order_number, bState: bState.state, unresolved, risk: risk?.outstandingMinor,
        conflicts: new Set(conflicts.map(row => row.operation_id)).size }).toEqual({
        actions: expectedRequests, requestNumbers: mode === 'rejected' ? [null, number, null] : [null, null],
        aState: mode === 'accepted' ? 'manual_review' : mode, aNumber: number, bState: 'manual_review',
        unresolved: true, risk: '10', conflicts: 2,
      })
    } finally { bResponse.open(); await server.close() }
  })
  it('R1 permits the same number in different supplier connections and normal repeated lookup', async () => {
    const id = randomUUID(), versionId = randomUUID()
    const envelope = encryptSupplierCredentials(config, id, 1, credentials)
    await db.transaction().execute(async trx => {
      await trx.insertInto('supplier_connections').values({ id, display_name: 'Independent synthetic supplier', provider_type: 'kayixin_customer_v3',
        enabled: false, current_version_id: null, tested_version_id: null, created_by_admin_id: adminId }).execute()
      await trx.insertInto('supplier_connection_credentials').values({ supplier_connection_id: id, credential_version: 1,
        provider_type: 'kayixin_customer_v3', auth_scheme: 'app_signature_v3', key_id: envelope.keyId,
        nonce: envelope.nonce, ciphertext: envelope.ciphertext, auth_tag: envelope.authTag }).execute()
      await trx.insertInto('supplier_connection_versions').values({ id: versionId, supplier_connection_id: id, version_number: 1,
        display_name: 'Independent synthetic supplier', provider_type: 'kayixin_customer_v3', auth_scheme: 'app_signature_v3',
        base_url: 'https://another-synthetic.example.test', credential_version: 1, created_by_admin_id: adminId }).execute()
      await trx.updateTable('supplier_connections').set({ current_version_id: versionId }).where('id', '=', id).execute()
    })
    const a = await readyOperation(), b = await readyOperation(1, await catalog('1.00', false, { id, versionId }))
    const number = `independent-${randomUUID()}`, requests: ProcurementFixtureRequest[] = []
    const server = await fixtureServer(async request => {
      requests.push(request)
      return request.action === 'query' ? { requestIdentity: request.requestIdentity, kind: 'success', supplierOrderNumber: number,
        unitIndices: [1], deliveryConfirmed: true, responseDigest: digest }
        : { requestIdentity: request.requestIdentity, kind: 'accepted', supplierOrderNumber: number, responseDigest: digest }
    })
    try {
      await runProcurementFixturePass(db, a.id, server.transport, async () => true)
      await runProcurementFixturePass(secondDb, b.id, server.transport, async () => true)
      await sql`UPDATE procurement_execution_leases SET next_action_at=clock_timestamp()-interval '1 second'
        WHERE operation_id IN (${a.id}::uuid,${b.id}::uuid)`.execute(db)
      expect(await runProcurementFixturePass(db, a.id, server.transport, async () => true)).toBe(true)
      expect(await runProcurementFixturePass(secondDb, b.id, server.transport, async () => true)).toBe(true)
      expect(requests.map(r => [r.action, r.supplierOrderNumber])).toEqual([['submit',null],['submit',null],['query',number],['query',number]])
      expect(await finalizeProcurementUnit(db, a.id, 1)).toBe('completed')
      expect(await finalizeProcurementUnit(db, b.id, 1)).toBe('completed')
      const rows = await sql`SELECT 1 FROM procurement_execution_conflicts WHERE operation_id IN (${a.id}::uuid,${b.id}::uuid)`.execute(db)
      expect(rows.rows).toEqual([])
    } finally { await server.close() }
  })
  it('serializes two workers while the controlled supplier request is in flight', async () => {
    await db.transaction().execute(trx => initializeSyntheticProcurementRiskPolicy(trx, { currency: 'TST', limits: {
      perOperationMinor: '100', globalDailyMinor: '10000', globalOutstandingMinor: '10000',
      supplierDailyMinor: '10000', supplierOutstandingMinor: '10000', skuDailyMinor: '10000', skuOutstandingMinor: '10000',
    } }))
    const op = await readyOperation()
    await expect(sql`UPDATE procurement_operations SET state='rejected',revision=revision+1 WHERE id=${op.id}::uuid`.execute(db)).rejects.toThrow()
    const entered = gate(), release = gate(), requests: ProcurementFixtureRequest[] = []
    const server = await fixtureServer(async request => {
      requests.push(request); entered.open(); await release.promise
      return { requestIdentity: request.requestIdentity, kind: 'accepted', supplierOrderNumber: 'synthetic-1', responseDigest: digest }
    })
    try {
      const first = runProcurementFixturePass(db, op.id, server.transport, async () => true)
      await entered.promise
      expect(await runProcurementFixturePass(secondDb, op.id, server.transport, async () => true)).toBe(false)
      release.open(); expect(await first).toBe(true)
      expect(requests.map(row => row.action)).toEqual(['submit'])
      const row = await db.selectFrom('procurement_operations').selectAll().where('id', '=', op.id).executeTakeFirstOrThrow()
      expect(row.state).toBe('accepted_pending'); expect(row.supplier_order_number).toBe('synthetic-1')
      await expect(sql`UPDATE procurement_operations SET supplier_order_number='other-number',revision=revision+1 WHERE id=${op.id}::uuid`.execute(db)).rejects.toThrow()
    } finally { release.open(); await server.close() }
  })

  it('records late evidence and only queries after expiry, even after negative lookup', async () => {
    const op = await readyOperation()
    const entered = gate(), release = gate(), requests: ProcurementFixtureRequest[] = []
    const server = await fixtureServer(async request => {
      requests.push(request)
      if (request.action === 'submit') {
        entered.open(); await release.promise
        return { requestIdentity: request.requestIdentity, kind: 'success', supplierOrderNumber: 'late-synthetic', unitIndices: [1], responseDigest: digest }
      }
      return { requestIdentity: request.requestIdentity, kind: 'not_found', supplierOrderNumber: null, responseDigest: 'e'.repeat(64) }
    })
    try {
      const first = runProcurementFixturePass(db, op.id, server.transport, async () => true)
      await entered.promise
      await sql`UPDATE procurement_execution_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
      expect(await runProcurementFixturePass(secondDb, op.id, server.transport, async () => true)).toBe(true)
      release.open(); await first
      expect(requests.map(row => row.action)).toEqual(['submit', 'query'])
      const row = await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()
      expect(row.state).toBe('unknown')
      const facts = await sql<{ kind: string }>`SELECT kind FROM procurement_execution_evidence WHERE operation_id=${op.id}::uuid ORDER BY observed_at`.execute(db)
      expect(facts.rows.map(fact => fact.kind)).toEqual(['not_found', 'success'])
    } finally { release.open(); await server.close() }
  })

  it('finalizes only proven units through the original fulfillment records', async () => {
    const op = await readyOperation(2)
    const server = await fixtureServer(async request => ({ requestIdentity: request.requestIdentity, kind: 'success',
      supplierOrderNumber: 'partial-provider', unitIndices: request.action === 'submit' ? [1] : [2], deliveryConfirmed: true, responseDigest: digest }))
    try {
      expect(await runProcurementFixturePass(db, op.id, server.transport, async () => true)).toBe(true)
      expect(await finalizeProcurementUnit(db, op.id, 2)).toBe('not_ready')
      expect(await finalizeProcurementUnit(db, op.id, 1)).toBe('completed')
      expect(await finalizeProcurementUnit(secondDb, op.id, 1)).toBe('already_completed')
      const units = await db.selectFrom('procurement_operation_units').select(['unit_index', 'state'])
        .where('operation_id', '=', op.id).orderBy('unit_index').execute()
      expect(units).toEqual([{ unit_index: 1, state: 'completed' }, { unit_index: 2, state: 'allocated' }])
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, op.id)))?.outstandingMinor).toBe('10')
      const partial = await sql<{ amount: string; evidence_id: string | null }>`SELECT amount_minor::text AS amount,evidence_id
        FROM procurement_risk_events WHERE operation_id=${op.id}::uuid AND kind='partial'`.execute(db)
      expect(partial.rows).toHaveLength(1); expect(partial.rows[0]!.amount).toBe('0'); expect(partial.rows[0]!.evidence_id).not.toBeNull()
      await sql`UPDATE procurement_execution_leases SET next_action_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
      expect(await runProcurementFixturePass(secondDb, op.id, server.transport, async () => true)).toBe(true)
      expect(await finalizeProcurementUnit(db, op.id, 2)).toBe('completed')
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state).toBe('completed')
    } finally { await server.close() }
  })

  it('retains both provider-number observations and blocks both operations from delivery', async () => {
    const first = await readyOperation(), second = await readyOperation()
    const server = await fixtureServer(async request => ({ requestIdentity: request.requestIdentity, kind: 'success',
      supplierOrderNumber: 'colliding-provider', unitIndices: [1], deliveryConfirmed: true, responseDigest: digest }))
    try {
      await runProcurementFixturePass(db, first.id, server.transport, async () => true)
      await runProcurementFixturePass(secondDb, second.id, server.transport, async () => true)
      expect(await finalizeProcurementUnit(db, first.id, 1)).toBe('not_ready')
      expect(await finalizeProcurementUnit(db, second.id, 1)).toBe('not_ready')
      const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM procurement_execution_evidence
        WHERE supplier_order_number='colliding-provider' AND kind='success'`.execute(db)
      expect(facts.rows[0]?.count).toBe('2')
      const conflicts = await sql<{ operation_id: string }>`SELECT DISTINCT operation_id FROM procurement_execution_conflicts
        WHERE reason='supplier_number' AND operation_id IN (${first.id}::uuid,${second.id}::uuid)`.execute(db)
      expect(new Set(conflicts.rows.map(row => row.operation_id))).toEqual(new Set([first.id, second.id]))
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', second.id).executeTakeFirstOrThrow()).state).toBe('manual_review')
    } finally { await server.close() }
  })

  it('puts known-number negative lookup into review without submitting again', async () => {
    const op = await readyOperation(), actions: string[] = []
    const server = await fixtureServer(async request => {
      actions.push(request.action)
      return request.action === 'submit'
        ? { requestIdentity: request.requestIdentity, kind: 'pending', supplierOrderNumber: 'known-provider', responseDigest: digest }
        : { requestIdentity: request.requestIdentity, kind: 'not_found', supplierOrderNumber: null, responseDigest: digest }
    })
    try {
      await runProcurementFixturePass(db, op.id, server.transport, async () => true)
      await sql`UPDATE procurement_execution_leases SET next_action_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
      await runProcurementFixturePass(secondDb, op.id, server.transport, async () => true)
      expect(actions).toEqual(['submit', 'query'])
      const row = await db.selectFrom('procurement_operations').select(['state', 'supplier_order_number']).where('id', '=', op.id).executeTakeFirstOrThrow()
      expect(row).toEqual({ state: 'manual_review', supplier_order_number: 'known-provider' })
    } finally { await server.close() }
  })

  it.each(['rejected', 'identity_conflict', 'invalid_units', 'invalid_pending_units', 'malformed', 'server_error'] as const)(
    'conservatively records %s without exposing the supplier response', async scenario => {
      const op = await readyOperation()
      const server = await fixtureServer(async request => {
        if (scenario === 'server_error') throw new Error('sensitive-provider-credential')
        if (scenario === 'malformed') return { malformed: 'sensitive-provider-credential' } as unknown as ProcurementFixtureResult
        return { requestIdentity: scenario === 'identity_conflict' ? 'wrong-id' : request.requestIdentity,
          kind: scenario === 'rejected' ? 'rejected' : scenario === 'invalid_pending_units' ? 'pending' : 'success', supplierOrderNumber: 'fixture-' + op.id,
          unitIndices: scenario === 'invalid_units' || scenario === 'invalid_pending_units' ? [999] : [1], responseDigest: digest }
      })
      try {
        await runProcurementFixturePass(db, op.id, server.transport, async () => true)
        const row = await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()
        expect(row.state).toBe(['malformed', 'server_error'].includes(scenario) ? 'unknown' : 'manual_review')
        const facts = await sql`SELECT * FROM procurement_execution_evidence WHERE operation_id=${op.id}::uuid`.execute(db)
        expect(JSON.stringify(facts.rows)).not.toContain('sensitive-provider-credential')
        expect((await db.transaction().execute(trx => readProcurementRisk(trx, op.id)))?.outstandingMinor).toBe('10')
      } finally { await server.close() }
    })


  it('blocks a refund while the submitted result is unknown', async () => {
    const op = await readyOperation()
    const entered = gate(), release = gate()
    const server = await fixtureServer(async request => {
      entered.open(); await release.promise
      return { requestIdentity: request.requestIdentity, kind: 'unknown', supplierOrderNumber: null, responseDigest: digest }
    })
    try {
      const pending = runProcurementFixturePass(db, op.id, server.transport, async () => true)
      await entered.promise
      const source = await sql<{ order_id: string }>`SELECT s.order_id FROM procurement_operations o
        JOIN order_item_procurement_sources s ON s.id=o.source_id WHERE o.id=${op.id}::uuid`.execute(db)
      const refund = await secondApp.inject({ method: 'POST', url: `/api/v1/customer/orders/${source.rows[0]!.order_id}/refunds`, headers,
        payload: { idempotencyKey: randomUUID(), amount: '1.00', reason: 'isolated fixture refund' } })
      expect(refund.statusCode).toBe(409)
      release.open(); await pending
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state).toBe('unknown')
    } finally { release.open(); await server.close() }
  })

  it('reinstates previously released risk when later success contradicts a refusal', async () => {
    const op = await readyOperation(), entered = gate(), release = gate()
    const server = await fixtureServer(async request => {
      if (request.action === 'submit') {
        entered.open(); await release.promise
        return { requestIdentity: request.requestIdentity, kind: 'success', supplierOrderNumber: 'late-contradiction', unitIndices: [1], responseDigest: digest }
      }
      return { requestIdentity: request.requestIdentity, kind: 'rejected', supplierOrderNumber: null, responseDigest: digest }
    })
    try {
      const pending = runProcurementFixturePass(db, op.id, server.transport, async () => true)
      await entered.promise
      await sql`UPDATE procurement_execution_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
      await runProcurementFixturePass(secondDb, op.id, server.transport, async () => true)
      const evidenceId = randomUUID()
      await db.transaction().execute(async trx => {
        const link = await sql<{ order_id: string; order_item_id: string; local_business_number: string }>`
          SELECT s.order_id,o.order_item_id,o.local_business_number FROM procurement_operations o
          JOIN order_item_procurement_sources s ON s.id=o.source_id WHERE o.id=${op.id}::uuid`.execute(trx)
        const row = link.rows[0]!
        await sql`SELECT id FROM orders WHERE id=${row.order_id}::uuid FOR UPDATE`.execute(trx)
        await sql`SELECT id FROM order_items WHERE id=${row.order_item_id}::uuid FOR UPDATE`.execute(trx)
        await lockProcurementRiskPolicy(trx, op.id)
        await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,
          response_digest,amount_minor,currency) VALUES (${evidenceId}::uuid,${op.id}::uuid,2,'query','rejected',
          ${row.local_business_number},${digest},10,'TST')`.execute(trx)
        await recordProcurementRiskFact(trx, { operationId: op.id, factId: randomUUID(), kind: 'release', amountMinor: '10', evidenceId })
      })
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, op.id)))?.outstandingMinor).toBe('0')
      release.open(); await pending
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, op.id)))?.outstandingMinor).toBe('10')
      const facts = await sql<{ kind: string }>`SELECT kind FROM procurement_risk_events WHERE operation_id=${op.id}::uuid ORDER BY created_at`.execute(db)
      expect(facts.rows.map(row => row.kind)).toEqual(['reserve', 'review', 'release', 'reinstate'])
    } finally { release.open(); await server.close() }
  })


  it('consumes original quantity stock once per proven unit and excludes a competing manual attempt', async () => {
    const sku = await catalog('1.00', true), op = await readyOperation(2, sku)
    const link = (await sql<{ order_id: string; order_item_id: string }>`SELECT s.order_id,o.order_item_id FROM procurement_operations o
      JOIN order_item_procurement_sources s ON s.id=o.source_id WHERE o.id=${op.id}::uuid`.execute(db)).rows[0]!
    await expect(sql`INSERT INTO order_item_fulfillment_attempts(id,order_item_id,operation_id,quantity,status,delivery_source,started_by_admin_id)
      VALUES (${randomUUID()}::uuid,${link.order_item_id}::uuid,${randomUUID()}::uuid,1,'processing','manual',${adminId}::uuid)`.execute(db))
      .rejects.toMatchObject({ constraint: 'procurement_fulfillment_conflict' })
    const server = await fixtureServer(async request => ({ requestIdentity: request.requestIdentity, kind: 'success',
      supplierOrderNumber: 'inventory-fixture', unitIndices: request.action === 'submit' ? [1] : [2], deliveryConfirmed: true, responseDigest: digest }))
    try {
      await runProcurementFixturePass(db, op.id, server.transport, async () => true)
      expect(await finalizeProcurementUnit(db, op.id, 1)).toBe('completed')
      expect(await db.selectFrom('order_items').select('fulfilled_quantity').where('id', '=', link.order_item_id).executeTakeFirstOrThrow()).toEqual({ fulfilled_quantity: 1 })
      expect(await db.selectFrom('product_variant_quantity_inventory').select(['stocked','reserved']).where('product_variant_id', '=', sku.skuId).executeTakeFirstOrThrow()).toEqual({ stocked: 9, reserved: 1 })
      let events = await db.selectFrom('order_inventory_events as e').innerJoin('order_inventory_reservations as r', 'r.id', 'e.reservation_id')
        .select(['e.action', 'e.quantity']).where('r.order_item_id', '=', link.order_item_id).where('e.action', '=', 'consume').execute()
      expect(events).toEqual([{ action: 'consume', quantity: 1 }])
      await sql`UPDATE procurement_execution_leases SET next_action_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
      await runProcurementFixturePass(db, op.id, server.transport, async () => true)
      expect(await finalizeProcurementUnit(db, op.id, 2)).toBe('completed')
      expect(await db.selectFrom('product_variant_quantity_inventory').select(['stocked','reserved']).where('product_variant_id', '=', sku.skuId).executeTakeFirstOrThrow()).toEqual({ stocked: 8, reserved: 0 })
      events = await db.selectFrom('order_inventory_events as e').innerJoin('order_inventory_reservations as r', 'r.id', 'e.reservation_id')
        .select(['e.action', 'e.quantity']).where('r.order_item_id', '=', link.order_item_id).where('e.action', '=', 'consume').execute()
      expect(events).toHaveLength(2)
      expect((await db.selectFrom('orders').select('status').where('id', '=', link.order_id).executeTakeFirstOrThrow()).status).toBe('completed')
    } finally { await server.close() }
  })


  it('keeps successful purchase separate from a confirmed deliverable', async () => {
    const op = await readyOperation()
    const server = await fixtureServer(async request => ({ requestIdentity: request.requestIdentity, kind: 'success',
      supplierOrderNumber: 'no-delivery-proof', unitIndices: [1], deliveryConfirmed: request.action === 'query', responseDigest: digest }))
    try {
      await runProcurementFixturePass(db, op.id, server.transport, async () => true)
      expect(await finalizeProcurementUnit(db, op.id, 1)).toBe('not_ready')
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state).toBe('success_pending_finalize')
      await sql`UPDATE procurement_execution_leases SET next_action_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
      expect(await runProcurementFixturePass(secondDb, op.id, server.transport, async () => true)).toBe(true)
      expect(await finalizeProcurementUnit(db, op.id, 1)).toBe('completed')
    } finally { await server.close() }
  })


  it('blocks a replacement operation when the old rejected unit later reports success', async () => {
    const old = await readyOperation(), entered = gate(), release = gate()
    const server = await fixtureServer(async request => {
      if (request.operationId === old.id && request.action === 'submit') {
        entered.open(); await release.promise
        return { requestIdentity: request.requestIdentity, kind: 'success', supplierOrderNumber: 'old-late-executed', unitIndices: [1], responseDigest: digest }
      }
      return { requestIdentity: request.requestIdentity, kind: 'rejected', supplierOrderNumber: null, responseDigest: digest }
    })
    try {
      const pending = runProcurementFixturePass(db, old.id, server.transport, async () => true)
      await entered.promise
      await sql`UPDATE procurement_execution_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=${old.id}::uuid`.execute(db)
      await runProcurementFixturePass(secondDb, old.id, server.transport, async () => true)
      const source = (await sql<{ order_id: string; order_item_id: string; local_business_number: string }>`
        SELECT s.order_id,o.order_item_id,o.local_business_number FROM procurement_operations o
        JOIN order_item_procurement_sources s ON s.id=o.source_id WHERE o.id=${old.id}::uuid`.execute(db)).rows[0]!
      const evidenceId = randomUUID()
      await db.transaction().execute(async trx => {
        await sql`SELECT id FROM orders WHERE id=${source.order_id}::uuid FOR UPDATE`.execute(trx)
        await sql`SELECT id FROM order_items WHERE id=${source.order_item_id}::uuid FOR UPDATE`.execute(trx)
        await lockProcurementRiskPolicy(trx, old.id)
        await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,response_digest,amount_minor,currency)
          VALUES (${evidenceId}::uuid,${old.id}::uuid,2,'query','rejected',${source.local_business_number},${digest},10,'TST')`.execute(trx)
        await recordProcurementRiskFact(trx, { operationId: old.id, factId: randomUUID(), kind: 'release', amountMinor: '10', evidenceId })
        await sql`UPDATE procurement_operations SET state='rejected',revision=revision+1 WHERE id=${old.id}::uuid`.execute(trx)
        await sql`UPDATE procurement_operation_units SET state='rejected' WHERE operation_id=${old.id}::uuid`.execute(trx)
      })
      const replay = { requestId: old.requestId, orderId: source.order_id, orderItemId: source.order_item_id,
        unitIndices: [1], currency: 'TST', maxAmountMinor: '10' }
      expect(await db.transaction().execute(trx => prepareProcurementWithRisk(trx, replay))).toEqual({
        id: old.id, localBusinessNumber: old.localBusinessNumber, repeated: true })
      await expect(db.transaction().execute(trx => prepareProcurementWithRisk(trx, { ...replay, maxAmountMinor: '11' }))).rejects.toThrow()
      const next = await db.transaction().execute(trx => prepareProcurementWithRisk(trx, { requestId: randomUUID(), orderId: source.order_id,
        orderItemId: source.order_item_id, unitIndices: [1], currency: 'TST', maxAmountMinor: '10' }))
      await expect(db.transaction().execute(trx => prepareProcurementWithRisk(trx, { ...replay, requestId: randomUUID() }))).rejects.toThrow()
      await expect(sql`UPDATE procurement_operations SET state='unknown',revision=revision+1 WHERE id=${old.id}::uuid`.execute(db)).rejects.toThrow()
      release.open(); await pending
      expect(await runProcurementFixturePass(secondDb, next.id, server.transport, async () => true)).toBe(false)
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', next.id).executeTakeFirstOrThrow()).state).toBe('manual_review')
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, next.id)))?.outstandingMinor).toBe('10')
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, old.id)))?.outstandingMinor).toBe('10')
      const conflicts = await sql<{ operation_id: string }>`SELECT DISTINCT operation_id FROM procurement_execution_conflicts
        WHERE reason='prior_unit_execution' AND operation_id IN (${old.id}::uuid,${next.id}::uuid)`.execute(db)
      expect(new Set(conflicts.rows.map(row => row.operation_id))).toEqual(new Set([old.id, next.id]))
    } finally { release.open(); await server.close() }
  })


  it('uses the late known number for lookup and retains conflicting later observations', async () => {
    const op = await readyOperation(), entered = gate(), release = gate(), requests: ProcurementFixtureRequest[] = []
    const server = await fixtureServer(async request => {
      requests.push(request)
      if (request.action === 'submit') {
        entered.open(); await release.promise
        return { requestIdentity: request.requestIdentity, kind: 'accepted', supplierOrderNumber: 'late-number-one', responseDigest: digest }
      }
      return { requestIdentity: request.requestIdentity, kind: 'accepted', supplierOrderNumber: 'different-number-two', responseDigest: digest }
    })
    try {
      const pending = runProcurementFixturePass(db, op.id, server.transport, async () => true)
      await entered.promise
      await sql`UPDATE procurement_execution_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
      release.open(); await pending
      await runProcurementFixturePass(secondDb, op.id, server.transport, async () => true)
      expect(requests[1]?.supplierOrderNumber).toBe('late-number-one')
      const result = await db.selectFrom('procurement_operations').select(['state','supplier_order_number']).where('id', '=', op.id).executeTakeFirstOrThrow()
      expect(result).toEqual({ state: 'manual_review', supplier_order_number: null })
      const review = await sql<{ amount: string; operation_revision: number | null }>`SELECT amount_minor::text AS amount,operation_revision
        FROM procurement_risk_events WHERE operation_id=${op.id}::uuid AND kind='review'`.execute(db)
      expect(review.rows).toHaveLength(1); expect(review.rows[0]!.amount).toBe('0'); expect(review.rows[0]!.operation_revision).not.toBeNull()
      const evidence = await sql<{ supplier_order_number: string; kind: string }>`SELECT supplier_order_number,kind
        FROM procurement_execution_evidence WHERE operation_id=${op.id}::uuid ORDER BY observed_at`.execute(db)
      expect(evidence.rows).toEqual([{ supplier_order_number: 'late-number-one', kind: 'accepted' },
        { supplier_order_number: 'different-number-two', kind: 'identity_conflict' }])
    } finally { release.open(); await server.close() }
  })

  it('bounds a hanging transport and retains its eventual late result', async () => {
    const op = await readyOperation(), entered = gate(), release = gate()
    const server = await fixtureServer(async request => {
      entered.open(); await release.promise
      return { requestIdentity: request.requestIdentity, kind: 'accepted', supplierOrderNumber: 'timeout-late-number', responseDigest: digest }
    })
    try {
      const pending = runProcurementFixturePass(db, op.id, server.transport, async () => true, 1000, 50)
      await entered.promise
      expect(await pending).toBe(true)
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state).toBe('unknown')
      release.open()
      const deadline = Date.now() + 10_000
      let found = false
      while (!found && Date.now() < deadline) {
        found = (await sql<{ found: boolean }>`SELECT EXISTS (SELECT 1 FROM procurement_execution_evidence
          WHERE operation_id=${op.id}::uuid AND supplier_order_number='timeout-late-number') AS found`.execute(db)).rows[0]!.found
        if (!found) await new Promise<void>(resolve => setImmediate(resolve))
      }
      expect(found).toBe(true)
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state).toBe('unknown')
    } finally { release.open(); await server.close() }
  })


  it('reports a late evidence persistence failure after bounded retries', async () => {
    const op = await readyOperation(), entered = gate(), release = gate(), failed = gate()
    let reported: { operationId: string; generation: number } | undefined
    await sql`CREATE FUNCTION fixture_fail_late_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.supplier_order_number='fixture-blocked-late' THEN RAISE EXCEPTION 'hidden fixture secret'; END IF;
      RETURN NEW; END $$`.execute(db)
    await sql`CREATE TRIGGER fixture_fail_late_evidence BEFORE INSERT ON procurement_execution_evidence
      FOR EACH ROW EXECUTE FUNCTION fixture_fail_late_evidence()`.execute(db)
    const server = await fixtureServer(async request => {
      entered.open(); await release.promise
      return { requestIdentity: request.requestIdentity, kind: 'accepted', supplierOrderNumber: 'fixture-blocked-late', responseDigest: digest }
    })
    try {
      const pending = runProcurementFixturePass(db, op.id, server.transport, async () => true, 1000, 30, context => {
        reported = context; failed.open()
      })
      await entered.promise; expect(await pending).toBe(true); release.open(); await failed.promise
      expect(reported).toEqual({ operationId: op.id, generation: 1 })
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state).toBe('unknown')
    } finally {
      release.open(); await server.close()
      await sql`DROP TRIGGER fixture_fail_late_evidence ON procurement_execution_evidence`.execute(db)
      await sql`DROP FUNCTION fixture_fail_late_evidence()`.execute(db)
    }
  })

  it('replays one preparation identity concurrently without creating another operation', async () => {
    const op = await readyOperation()
    const request = (await sql<{ order_id: string; order_item_id: string; unit_indices: number[] }>`
      SELECT order_id,order_item_id,unit_indices FROM procurement_preparation_requests WHERE request_id=${op.requestId}::uuid`.execute(db)).rows[0]!
    const input = { requestId: op.requestId, orderId: request.order_id, orderItemId: request.order_item_id,
      unitIndices: request.unit_indices, currency: 'TST', maxAmountMinor: '10' }
    const results = await Promise.all([db.transaction().execute(trx => prepareProcurementWithRisk(trx, input)),
      secondDb.transaction().execute(trx => prepareProcurementWithRisk(trx, input))])
    expect(results).toEqual([0,1].map(() => ({ id: op.id, localBusinessNumber: op.localBusinessNumber, repeated: true })))
    const operations = await sql<{ count: string }>`SELECT count(*)::text AS count FROM procurement_operations WHERE order_item_id=${request.order_item_id}::uuid`.execute(db)
    expect(operations.rows[0]!.count).toBe('1')
  })


  it('blocks direct and authenticated manual delivery after a rejected operation later reports success', async () => {
    const op = await readyOperation(), entered = gate(), release = gate()
    const server = await fixtureServer(async request => {
      if (request.action === 'submit') {
        entered.open(); await release.promise
        return { requestIdentity: request.requestIdentity, kind: 'success', supplierOrderNumber: 'rejected-then-success', unitIndices: [1], responseDigest: digest }
      }
      return { requestIdentity: request.requestIdentity, kind: 'rejected', supplierOrderNumber: null, responseDigest: digest }
    })
    try {
      const pending = runProcurementFixturePass(db, op.id, server.transport, async () => true)
      await entered.promise
      await sql`UPDATE procurement_execution_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
      await runProcurementFixturePass(secondDb, op.id, server.transport, async () => true)
      const source = (await sql<{ order_id: string; order_item_id: string; local_business_number: string }>`
        SELECT s.order_id,o.order_item_id,o.local_business_number FROM procurement_operations o
        JOIN order_item_procurement_sources s ON s.id=o.source_id WHERE o.id=${op.id}::uuid`.execute(db)).rows[0]!
      const evidenceId = randomUUID()
      await db.transaction().execute(async trx => {
        await sql`SELECT id FROM orders WHERE id=${source.order_id}::uuid FOR UPDATE`.execute(trx)
        await sql`SELECT id FROM order_items WHERE id=${source.order_item_id}::uuid FOR UPDATE`.execute(trx)
        await lockProcurementRiskPolicy(trx, op.id)
        await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,response_digest,amount_minor,currency)
          VALUES (${evidenceId}::uuid,${op.id}::uuid,2,'query','rejected',${source.local_business_number},${digest},10,'TST')`.execute(trx)
        await recordProcurementRiskFact(trx, { operationId: op.id, factId: randomUUID(), kind: 'release', amountMinor: '10', evidenceId })
        await sql`UPDATE procurement_operations SET state='rejected',revision=revision+1 WHERE id=${op.id}::uuid`.execute(trx)
        await sql`UPDATE procurement_operation_units SET state='rejected' WHERE operation_id=${op.id}::uuid`.execute(trx)
      })
      release.open(); await pending
      expect((await db.selectFrom('procurement_operation_units').select('state').where('operation_id', '=', op.id).executeTakeFirstOrThrow()).state).toBe('rejected')
      expect((await sql<{ count: string }>`SELECT count(*)::text count FROM procurement_operations WHERE order_item_id=${source.order_item_id}::uuid`.execute(db)).rows[0]!.count).toBe('1')
      await expect(sql`INSERT INTO order_item_fulfillment_attempts(id,order_item_id,operation_id,quantity,status,delivery_source,started_by_admin_id)
        VALUES (${randomUUID()}::uuid,${source.order_item_id}::uuid,${randomUUID()}::uuid,1,'processing','manual',${adminId}::uuid)`.execute(db))
        .rejects.toMatchObject({ constraint: 'procurement_fulfillment_conflict' })
      const token = randomBytes(32).toString('base64url')
      await db.insertInto('admin_sessions').values({ id: randomUUID(), admin_user_id: adminId, token_hash: hashToken(token),
        expires_at: new Date(Date.now() + 60_000), revoked_at: null }).execute()
      const csrf = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
      const response = await app.inject({ method: 'POST', url: `/api/v1/admin/orders/${source.order_id}/items/${source.order_item_id}/fulfillments`,
        headers: { origin, cookie: `aikayun_admin_session=${token}; ${cookie(csrf, 'aikayun_admin_csrf')}`,
          'x-csrf-token': csrf.json().data.csrfToken as string },
        payload: { operationId: randomUUID(), deliveries: [{ content: 'must-not-be-delivered' }] } })
      expect(response.statusCode, response.body).toBe(409)
      expect(await db.selectFrom('order_item_fulfillment_attempts').select('id').where('order_item_id', '=', source.order_item_id).execute()).toEqual([])
      expect((await db.selectFrom('order_items').select('fulfilled_quantity').where('id', '=', source.order_item_id).executeTakeFirstOrThrow()).fulfilled_quantity).toBe(0)
    } finally { release.open(); await server.close() }
  })


  it('does not query by an unowned number from a late identity conflict', async () => {
    const op = await readyOperation(), entered = gate(), release = gate(), requests: ProcurementFixtureRequest[] = []
    const server = await fixtureServer(async request => {
      requests.push(request); entered.open(); await release.promise
      return { requestIdentity: 'wrong-synthetic-identity', kind: 'accepted', supplierOrderNumber: 'unowned-late-number', responseDigest: digest }
    })
    try {
      const pending = runProcurementFixturePass(db, op.id, server.transport, async () => true)
      await entered.promise
      await sql`UPDATE procurement_execution_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
      release.open(); await pending
      expect(await runProcurementFixturePass(secondDb, op.id, server.transport, async () => true)).toBe(false)
      expect(requests.map(request => request.action)).toEqual(['submit'])
      expect(await db.selectFrom('procurement_operations').select(['state','supplier_order_number']).where('id', '=', op.id).executeTakeFirstOrThrow())
        .toEqual({ state: 'manual_review', supplier_order_number: null })
      const facts = await sql<{ kind: string; supplier_order_number: string }>`SELECT kind,supplier_order_number FROM procurement_execution_evidence
        WHERE operation_id=${op.id}::uuid`.execute(db)
      expect(facts.rows).toEqual([{ kind: 'identity_conflict', supplier_order_number: 'unowned-late-number' }])
    } finally { release.open(); await server.close() }
  })

  it('records a later attributable number but routes an in-flight query to review after an old identity conflict', async () => {
    const op = await readyOperation(), submitEntered = gate(), submitRelease = gate(), queryEntered = gate(), queryRelease = gate()
    const requests: ProcurementFixtureRequest[] = []
    const server = await fixtureServer(async request => {
      requests.push(request)
      if (request.action === 'submit') {
        submitEntered.open(); await submitRelease.promise
        return { requestIdentity: 'wrong-synthetic-identity', kind: 'accepted', supplierOrderNumber: 'unowned-old-number', responseDigest: digest }
      }
      queryEntered.open(); await queryRelease.promise
      return { requestIdentity: request.requestIdentity, kind: 'accepted', supplierOrderNumber: 'attributable-new-number', responseDigest: digest }
    })
    try {
      const first = runProcurementFixturePass(db, op.id, server.transport, async () => true)
      await submitEntered.promise
      await sql`UPDATE procurement_execution_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
      const second = runProcurementFixturePass(secondDb, op.id, server.transport, async () => true)
      await queryEntered.promise
      expect(requests[1]!.supplierOrderNumber).toBeNull()
      submitRelease.open(); await first
      queryRelease.open(); await second
      expect(await db.selectFrom('procurement_operations').select(['state','supplier_order_number']).where('id', '=', op.id).executeTakeFirstOrThrow())
        .toEqual({ state: 'manual_review', supplier_order_number: null })
      const facts = await sql<{ kind: string; supplier_order_number: string }>`SELECT kind,supplier_order_number FROM procurement_execution_evidence
        WHERE operation_id=${op.id}::uuid ORDER BY observed_at`.execute(db)
      expect(facts.rows).toEqual([{ kind: 'identity_conflict', supplier_order_number: 'unowned-old-number' },
        { kind: 'accepted', supplier_order_number: 'attributable-new-number' }])
      await expect(sql`UPDATE procurement_operations SET supplier_order_number='attributable-new-number',revision=revision+1
        WHERE id=${op.id}::uuid`.execute(db)).rejects.toMatchObject({ constraint: 'procurement_number_evidence_conflict' })
    } finally { submitRelease.open(); queryRelease.open(); await server.close() }
  })


  it.each(['same', 'missing'] as const)('blocks finalization after a late identity conflict with %s supplier number', async numberKind => {
    const op = await readyOperation(), entered = gate(), release = gate()
    const server = await fixtureServer(async request => {
      if (request.action === 'submit') {
        entered.open(); await release.promise
        return { requestIdentity: 'wrong-synthetic-identity', kind: 'accepted',
          supplierOrderNumber: numberKind === 'same' ? 'trusted-known-number' : null, responseDigest: digest }
      }
      return { requestIdentity: request.requestIdentity, kind: 'success', supplierOrderNumber: 'trusted-known-number',
        unitIndices: [1], deliveryConfirmed: true, responseDigest: digest }
    })
    try {
      const pending = runProcurementFixturePass(db, op.id, server.transport, async () => true)
      await entered.promise
      await sql`UPDATE procurement_execution_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
      await runProcurementFixturePass(secondDb, op.id, server.transport, async () => true)
      release.open(); await pending
      expect(await finalizeProcurementUnit(db, op.id, 1)).toBe('not_ready')
      const row = await db.selectFrom('procurement_operations').select('order_item_id').where('id', '=', op.id).executeTakeFirstOrThrow()
      await expect(sql`INSERT INTO order_item_fulfillment_attempts
        (id,order_item_id,operation_id,quantity,status,delivery_source,started_by_admin_id,procurement_operation_id,procurement_unit_index)
        VALUES (${randomUUID()}::uuid,${row.order_item_id}::uuid,${randomUUID()}::uuid,1,'processing','procurement',NULL,${op.id}::uuid,1)`.execute(db)).rejects.toThrow()
      expect(await db.selectFrom('order_item_fulfillment_attempts').select('id').where('order_item_id', '=', row.order_item_id).execute()).toEqual([])
    } finally { release.open(); await server.close() }
  })


  it('rejects direct submission specifically on unresolved identity conflict', async () => {
    const op = await readyOperation()
    const source = (await sql<{ order_id: string; order_item_id: string; local_business_number: string }>`
      SELECT s.order_id,o.order_item_id,o.local_business_number FROM procurement_operations o
      JOIN order_item_procurement_sources s ON s.id=o.source_id WHERE o.id=${op.id}::uuid`.execute(db)).rows[0]!
    await db.transaction().execute(async trx => {
      await sql`SELECT id FROM orders WHERE id=${source.order_id}::uuid FOR UPDATE`.execute(trx)
      await sql`SELECT id FROM order_items WHERE id=${source.order_item_id}::uuid FOR UPDATE`.execute(trx)
      await lockProcurementRiskPolicy(trx, op.id)
      await sql`INSERT INTO procurement_execution_leases(operation_id,lease_token,lease_expires_at,request_generation)
        VALUES (${op.id}::uuid,${randomUUID()}::uuid,clock_timestamp()+interval '1 minute',1)`.execute(trx)
      await sql`INSERT INTO procurement_request_intents(id,operation_id,generation,action,request_identity)
        VALUES (${randomUUID()}::uuid,${op.id}::uuid,1,'submit',${source.local_business_number})`.execute(trx)
      // A savepoint proves the exact same update is legal before the conflict.
      await sql`SAVEPOINT before_conflict`.execute(trx)
      await sql`UPDATE procurement_operations SET state='submit_in_flight',revision=revision+1 WHERE id=${op.id}::uuid`.execute(trx)
      await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(trx)
      await sql`ROLLBACK TO SAVEPOINT before_conflict`.execute(trx)
      await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,response_digest)
        VALUES (${randomUUID()}::uuid,${op.id}::uuid,1,'submit','identity_conflict',${source.local_business_number},${digest})`.execute(trx)
    })
    await expect(sql`UPDATE procurement_operations SET state='submit_in_flight',revision=revision+1 WHERE id=${op.id}::uuid`.execute(db))
      .rejects.toMatchObject({ constraint: 'procurement_identity_conflict_unresolved' })
  })

  it('rejects direct completion specifically on unresolved identity conflict after all units are delivered', async () => {
    const op = await readyOperation(2)
    const server = await fixtureServer(async request => ({ requestIdentity: request.requestIdentity, kind: 'success',
      supplierOrderNumber: 'completion-guard-number', unitIndices: [1,2], deliveryConfirmed: true, responseDigest: digest }))
    try {
      await runProcurementFixturePass(db, op.id, server.transport, async () => true)
      expect(await finalizeProcurementUnit(db, op.id, 1)).toBe('completed')
      const source = (await sql<{ order_id: string; order_item_id: string; local_business_number: string }>`
        SELECT s.order_id,o.order_item_id,o.local_business_number FROM procurement_operations o
        JOIN order_item_procurement_sources s ON s.id=o.source_id WHERE o.id=${op.id}::uuid`.execute(db)).rows[0]!
      const attemptId = randomUUID()
      await db.transaction().execute(async trx => {
        await sql`SELECT id FROM orders WHERE id=${source.order_id}::uuid FOR UPDATE`.execute(trx)
        await sql`SELECT id FROM order_items WHERE id=${source.order_item_id}::uuid FOR UPDATE`.execute(trx)
        await sql`INSERT INTO order_item_fulfillment_attempts
          (id,order_item_id,operation_id,quantity,status,delivery_source,started_by_admin_id,procurement_operation_id,procurement_unit_index)
          VALUES (${attemptId}::uuid,${source.order_item_id}::uuid,${randomUUID()}::uuid,1,'processing','procurement',NULL,${op.id}::uuid,2)`.execute(trx)
        await sql`INSERT INTO order_item_fulfillment_deliveries(id,fulfillment_attempt_id,started_by_admin_id,unit_index,content,content_sha256,delivery_source)
          VALUES (${randomUUID()}::uuid,${attemptId}::uuid,NULL,2,NULL,${digest},'procurement')`.execute(trx)
        await trx.updateTable('order_item_fulfillment_attempts').set({ status: 'succeeded', result_sha256: digest }).where('id', '=', attemptId).execute()
        await trx.updateTable('procurement_operation_units').set({ state: 'completed' }).where('operation_id', '=', op.id).where('unit_index', '=', 2).execute()
        // All units are complete; absent conflict, completion is valid including deferred checks.
        await sql`SAVEPOINT before_conflict`.execute(trx)
        await sql`UPDATE procurement_operations SET state='completed',revision=revision+1 WHERE id=${op.id}::uuid`.execute(trx)
        await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(trx)
        await sql`ROLLBACK TO SAVEPOINT before_conflict`.execute(trx)
        await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,response_digest)
          VALUES (${randomUUID()}::uuid,${op.id}::uuid,1,'submit','identity_conflict',${source.local_business_number},${digest})`.execute(trx)
      })
      await expect(sql`UPDATE procurement_operations SET state='completed',revision=revision+1 WHERE id=${op.id}::uuid`.execute(db))
        .rejects.toMatchObject({ constraint: 'procurement_identity_conflict_unresolved' })
      expect((await db.selectFrom('procurement_operation_units').select('state').where('operation_id', '=', op.id).execute()).every(unit => unit.state === 'completed')).toBe(true)
    } finally { await server.close() }
  })


  it('reinstates risk and blocks refund, manual delivery and replacement after late identity conflict', async () => {
    const old = await readyOperation(), entered = gate(), release = gate(), requests: ProcurementFixtureRequest[] = []
    const server = await fixtureServer(async request => {
      requests.push(request)
      if (request.operationId === old.id && request.action === 'submit') {
        entered.open(); await release.promise
        return { requestIdentity: 'unowned-late-identity', kind: 'accepted', supplierOrderNumber: null, responseDigest: digest }
      }
      return { requestIdentity: request.requestIdentity, kind: 'rejected', supplierOrderNumber: null, responseDigest: digest }
    })
    try {
      const pending = runProcurementFixturePass(db, old.id, server.transport, async () => true)
      await entered.promise
      await sql`UPDATE procurement_execution_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=${old.id}::uuid`.execute(db)
      await runProcurementFixturePass(secondDb, old.id, server.transport, async () => true)
      const source = (await sql<{ order_id: string; order_item_id: string; local_business_number: string }>`
        SELECT s.order_id,o.order_item_id,o.local_business_number FROM procurement_operations o
        JOIN order_item_procurement_sources s ON s.id=o.source_id WHERE o.id=${old.id}::uuid`.execute(db)).rows[0]!
      const evidenceId = randomUUID()
      await db.transaction().execute(async trx => {
        await sql`SELECT id FROM orders WHERE id=${source.order_id}::uuid FOR UPDATE`.execute(trx)
        await sql`SELECT id FROM order_items WHERE id=${source.order_item_id}::uuid FOR UPDATE`.execute(trx)
        await lockProcurementRiskPolicy(trx, old.id)
        await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,response_digest,amount_minor,currency)
          VALUES (${evidenceId}::uuid,${old.id}::uuid,2,'query','rejected',${source.local_business_number},${digest},10,'TST')`.execute(trx)
        await recordProcurementRiskFact(trx, { operationId: old.id, factId: randomUUID(), kind: 'release', amountMinor: '10', evidenceId })
        await sql`UPDATE procurement_operations SET state='rejected',revision=revision+1 WHERE id=${old.id}::uuid`.execute(trx)
        await sql`UPDATE procurement_operation_units SET state='rejected' WHERE operation_id=${old.id}::uuid`.execute(trx)
      })
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, old.id)))?.outstandingMinor).toBe('0')
      const replacement = await db.transaction().execute(trx => prepareProcurementWithRisk(trx, { requestId: randomUUID(), orderId: source.order_id,
        orderItemId: source.order_item_id, unitIndices: [1], currency: 'TST', maxAmountMinor: '10' }))
      const dailyGross = async () => (await sql<{ scope_kind: string; gross_minor: string }>`
        SELECT daily.scope_kind,daily.gross_minor::text FROM procurement_risk_daily daily
        JOIN procurement_risk_reservations reservation ON reservation.operation_id=${old.id}::uuid
          AND daily.currency=reservation.currency AND daily.utc_day=reservation.utc_day
        WHERE (daily.scope_kind='global' AND daily.scope_key='*')
          OR (daily.scope_kind='supplier' AND daily.scope_key=reservation.supplier_connection_id::text)
          OR (daily.scope_kind='sku' AND daily.scope_key=reservation.product_variant_id::text)
        ORDER BY daily.scope_kind`.execute(db)).rows
      const grossBeforeConflict = await dailyGross()
      expect(grossBeforeConflict.map(row => row.scope_kind)).toEqual(['global','sku','supplier'])
      release.open(); await pending
      expect(await dailyGross()).toEqual(grossBeforeConflict)
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, old.id)))?.outstandingMinor).toBe('10')
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', old.id).executeTakeFirstOrThrow()).state).toBe('rejected')
      const unresolved = await sql<{ unresolved: boolean }>`SELECT order_has_unresolved_fulfillment(${source.order_id}::uuid) AS unresolved`.execute(db)
      expect(unresolved.rows[0]!.unresolved).toBe(true)
      const conflicts = await sql<{ operation_id: string }>`SELECT DISTINCT operation_id FROM procurement_execution_conflicts
        WHERE reason='prior_unit_execution' AND operation_id IN (${old.id}::uuid,${replacement.id}::uuid)`.execute(db)
      expect(new Set(conflicts.rows.map(row => row.operation_id))).toEqual(new Set([old.id, replacement.id]))
      const refund = await secondApp.inject({ method: 'POST', url: `/api/v1/customer/orders/${source.order_id}/refunds`, headers,
        payload: { idempotencyKey: randomUUID(), amount: '1.00', reason: 'identity conflict fixture' } })
      expect(refund.statusCode).toBe(409)
      await expect(db.insertInto('order_refunds').values({ id: randomUUID(),order_id: source.order_id,idempotency_key: randomUUID(),
        request_sha256: digest,amount: '1.00',status: 'requested',reason: 'identity conflict fixture' }).execute())
        .rejects.toMatchObject({ constraint: 'order_refund_fulfillment_unresolved' })
      await expect(sql`INSERT INTO order_item_fulfillment_attempts(id,order_item_id,operation_id,quantity,status,delivery_source,started_by_admin_id)
        VALUES (${randomUUID()}::uuid,${source.order_item_id}::uuid,${randomUUID()}::uuid,1,'processing','manual',${adminId}::uuid)`.execute(db))
        .rejects.toMatchObject({ constraint: 'procurement_fulfillment_conflict' })
      const token = randomBytes(32).toString('base64url')
      await db.insertInto('admin_sessions').values({ id: randomUUID(), admin_user_id: adminId, token_hash: hashToken(token),
        expires_at: new Date(Date.now() + 60_000), revoked_at: null }).execute()
      const csrf = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
      const manual = await app.inject({ method: 'POST', url: `/api/v1/admin/orders/${source.order_id}/items/${source.order_item_id}/fulfillments`,
        headers: { origin, cookie: `aikayun_admin_session=${token}; ${cookie(csrf, 'aikayun_admin_csrf')}`,
          'x-csrf-token': csrf.json().data.csrfToken as string },
        payload: { operationId: randomUUID(), deliveries: [{ content: 'must-not-be-delivered' }] } })
      expect(manual.statusCode).toBe(409)
      await expect(db.transaction().execute(async trx => {
        await sql`SELECT id FROM orders WHERE id=${source.order_id}::uuid FOR UPDATE`.execute(trx)
        await sql`SELECT id FROM order_items WHERE id=${source.order_item_id}::uuid FOR UPDATE`.execute(trx)
        await lockProcurementRiskPolicy(trx, replacement.id)
        await sql`INSERT INTO procurement_execution_leases(operation_id,lease_token,lease_expires_at,request_generation)
          VALUES (${replacement.id}::uuid,${randomUUID()}::uuid,clock_timestamp()+interval '1 minute',1)`.execute(trx)
        await sql`INSERT INTO procurement_request_intents(id,operation_id,generation,action,request_identity)
          VALUES (${randomUUID()}::uuid,${replacement.id}::uuid,1,'submit',${replacement.localBusinessNumber})`.execute(trx)
      })).rejects.toMatchObject({ constraint: 'procurement_global_conflict' })
      await expect(sql`UPDATE procurement_operations SET state='submit_in_flight',revision=revision+1 WHERE id=${replacement.id}::uuid`.execute(db))
        .rejects.toMatchObject({ constraint: 'procurement_identity_conflict_unresolved' })
      expect(await runProcurementFixturePass(secondDb, replacement.id, server.transport, async () => true)).toBe(false)
      expect(requests.map(row => row.action)).toEqual(['submit','query'])
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', replacement.id).executeTakeFirstOrThrow()).state).toBe('manual_review')
      expect(await finalizeProcurementUnit(db, replacement.id, 1)).toBe('not_ready')
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, replacement.id)))?.outstandingMinor).toBe('10')
    } finally { release.open(); await server.close() }
  })

  it('refuses a forged later rejection and release after an identity conflict', async () => {
    const op = await readyOperation()
    const server = await fixtureServer(async () => ({ requestIdentity: 'unowned-identity', kind: 'accepted',
      supplierOrderNumber: null, responseDigest: digest }))
    try {
      await runProcurementFixturePass(db, op.id, server.transport, async () => true)
      const row = await db.selectFrom('procurement_operations').select(['state','local_business_number']).where('id', '=', op.id).executeTakeFirstOrThrow()
      expect(row.state).toBe('manual_review')
      const evidenceId = randomUUID()
      await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,response_digest,amount_minor,currency)
        VALUES (${evidenceId}::uuid,${op.id}::uuid,1,'submit','rejected',${row.local_business_number},${digest},10,'TST')`.execute(db)
      await expect(db.transaction().execute(trx => recordProcurementRiskFact(trx, { operationId: op.id, factId: randomUUID(),
        kind: 'release', amountMinor: '10', evidenceId }))).rejects.toMatchObject({ constraint: 'procurement_identity_conflict_unresolved' })
      await expect(sql`UPDATE procurement_operations SET state='rejected',revision=revision+1 WHERE id=${op.id}::uuid`.execute(db))
        .rejects.toMatchObject({ constraint: 'procurement_identity_conflict_unresolved' })
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, op.id)))?.outstandingMinor).toBe('10')
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state).toBe('manual_review')
    } finally { await server.close() }
  })


  it('rechecks a committed identity conflict after waiting on the actual order lock', async () => {
    const op = await readyOperation(), entered = gate(), networkRelease = gate()
    const server = await fixtureServer(async request => {
      if (request.action === 'submit') {
        entered.open(); await networkRelease.promise
        return { requestIdentity: 'unowned-identity', kind: 'accepted', supplierOrderNumber: null, responseDigest: digest }
      }
      return { requestIdentity: request.requestIdentity, kind: 'rejected', supplierOrderNumber: null, responseDigest: digest }
    })
    try {
      const pending = runProcurementFixturePass(db, op.id, server.transport, async () => true)
      await entered.promise
      await sql`UPDATE procurement_execution_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=${op.id}::uuid`.execute(db)
      await runProcurementFixturePass(secondDb, op.id, server.transport, async () => true)
      const source = (await sql<{ order_id: string; order_item_id: string; local_business_number: string }>`
        SELECT s.order_id,o.order_item_id,o.local_business_number FROM procurement_operations o
        JOIN order_item_procurement_sources s ON s.id=o.source_id WHERE o.id=${op.id}::uuid`.execute(db)).rows[0]!
      const evidenceId = randomUUID()
      await db.transaction().execute(async trx => {
        await sql`SELECT id FROM orders WHERE id=${source.order_id}::uuid FOR UPDATE`.execute(trx)
        await sql`SELECT id FROM order_items WHERE id=${source.order_item_id}::uuid FOR UPDATE`.execute(trx)
        await lockProcurementRiskPolicy(trx, op.id)
        await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,response_digest,amount_minor,currency)
          VALUES (${evidenceId}::uuid,${op.id}::uuid,2,'query','rejected',${source.local_business_number},${digest},10,'TST')`.execute(trx)
        await recordProcurementRiskFact(trx, { operationId: op.id, factId: randomUUID(), kind: 'release', amountMinor: '10', evidenceId })
        await sql`UPDATE procurement_operations SET state='rejected',revision=revision+1 WHERE id=${op.id}::uuid`.execute(trx)
        await sql`UPDATE procurement_operation_units SET state='rejected' WHERE operation_id=${op.id}::uuid`.execute(trx)
      })
      const token = randomBytes(32).toString('base64url')
      await db.insertInto('admin_sessions').values({ id: randomUUID(), admin_user_id: adminId, token_hash: hashToken(token),
        expires_at: new Date(Date.now() + 60_000), revoked_at: null }).execute()
      const csrf = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' })
      const admin = { origin, cookie: `aikayun_admin_session=${token}; ${cookie(csrf, 'aikayun_admin_csrf')}`,
        'x-csrf-token': csrf.json().data.csrfToken as string }
      const held = gate(), unlock = gate()
      let blockerPid = 0
      const holder = db.transaction().execute(async trx => {
        blockerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid
        await sql`SELECT id FROM orders WHERE id=${source.order_id}::uuid FOR UPDATE`.execute(trx)
        await sql`SELECT id FROM order_items WHERE id=${source.order_item_id}::uuid FOR UPDATE`.execute(trx)
        await lockProcurementRiskPolicy(trx, op.id)
        await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,response_digest)
          VALUES (${randomUUID()}::uuid,${op.id}::uuid,1,'submit','identity_conflict',${source.local_business_number},${digest})`.execute(trx)
        held.open(); await unlock.promise
      })
      await held.promise
      const directRefund = secondDb.insertInto('order_refunds').values({ id: randomUUID(),order_id: source.order_id,idempotency_key: randomUUID(),
        request_sha256: digest,amount: '1.00',status: 'requested',reason: 'conflict lock fixture' }).execute().then(() => null, error => error)
      const directManual = sql`INSERT INTO order_item_fulfillment_attempts(id,order_item_id,operation_id,quantity,status,delivery_source,started_by_admin_id)
        VALUES (${randomUUID()}::uuid,${source.order_item_id}::uuid,${randomUUID()}::uuid,1,'processing','manual',${adminId}::uuid)`.execute(secondDb).then(() => null, error => error)
      const refund = secondApp.inject({ method: 'POST', url: `/api/v1/customer/orders/${source.order_id}/refunds`, headers,
        payload: { idempotencyKey: randomUUID(), amount: '1.00', reason: 'conflict lock fixture' } })
      const manual = app.inject({ method: 'POST', url: `/api/v1/admin/orders/${source.order_id}/items/${source.order_item_id}/fulfillments`,
        headers: admin, payload: { operationId: randomUUID(), deliveries: [{ content: 'must-not-be-delivered' }] } })
      try {
        const deadline = Date.now() + 10_000
        let blocked = 0
        while (blocked < 4 && Date.now() < deadline) {
          blocked = (await sql<{ count: number }>`WITH RECURSIVE blocked(pid) AS (
            SELECT ${blockerPid}::integer UNION SELECT activity.pid FROM pg_stat_activity activity
              JOIN blocked parent ON parent.pid=ANY(pg_blocking_pids(activity.pid)))
            SELECT (count(*)-1)::integer AS count FROM blocked`.execute(db)).rows[0]!.count
          if (blocked < 4) await new Promise<void>(resolve => setImmediate(resolve))
        }
        expect(blocked).toBeGreaterThanOrEqual(4)
      } finally { unlock.open() }
      await holder
      const [refundError, manualError, refundResponse, manualResponse] = await Promise.all([directRefund,directManual,refund,manual])
      expect(refundError).toMatchObject({ constraint: 'order_refund_fulfillment_unresolved' })
      expect(manualError).toMatchObject({ constraint: 'procurement_fulfillment_conflict' })
      expect(refundResponse.statusCode).toBe(409); expect(manualResponse.statusCode).toBe(409)
      networkRelease.open(); await pending
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, op.id)))?.outstandingMinor).toBe('10')
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state).toBe('rejected')
    } finally { networkRelease.open(); await server.close() }
  })

  it('fails closed on unavailable historic key and recovers using the frozen version after rotation', async () => {
    const op = await readyOperation(), version2 = randomUUID()
    const itemId = (await db.selectFrom('procurement_operations').select('order_item_id').where('id', '=', op.id).executeTakeFirstOrThrow()).order_item_id
    const beforeRotation = await db.transaction().execute(trx => prepareOrderItemProcurement(trx, config, itemId))
    expect(beforeRotation).toMatchObject({ kind: 'prepared', mappingVersionId: skuA.versionId, purchaseEligible: false })
    const envelope = encryptSupplierCredentials(config, connectionId, 2, credentials)
    await db.transaction().execute(async trx => {
      await trx.insertInto('supplier_connection_credentials').values({ supplier_connection_id: connectionId, credential_version: 2,
        provider_type: 'kayixin_customer_v3', auth_scheme: 'app_signature_v3', key_id: envelope.keyId,
        nonce: envelope.nonce, ciphertext: envelope.ciphertext, auth_tag: envelope.authTag }).execute()
      await trx.insertInto('supplier_connection_versions').values({ id: version2, supplier_connection_id: connectionId,
        version_number: 2, display_name: 'Synthetic rotation', provider_type: 'kayixin_customer_v3', auth_scheme: 'app_signature_v3',
        base_url: 'https://synthetic.example.test', credential_version: 2, created_by_admin_id: adminId }).execute()
      await trx.updateTable('supplier_connections').set({ current_version_id: version2 }).where('id', '=', connectionId).execute()
    })
    expect(await db.transaction().execute(trx => prepareOrderItemProcurement(trx, config, itemId))).toEqual(beforeRotation)
    let calls = 0
    const server = await fixtureServer(async request => { calls++; return { requestIdentity: request.requestIdentity,
      kind: 'pending', supplierOrderNumber: 'historic-key-fixture', responseDigest: digest } })
    try {
      expect(await runProcurementFixturePass(db, op.id, server.transport, async source => {
        expect(source.connectionVersionId).toBe(connectionVersionId); expect(source.credentialVersion).toBe(1)
        expect(await resolveKayixinFixtureSource(db, config, { ...source, credentialKeyId: 'wrong-key' })).toBeNull()
        expect(await resolveKayixinFixtureSource(db, config, { ...source, connectionVersionId: version2 })).toBeNull()
        expect(await resolveKayixinFixtureSource(db, config, source)).toEqual({ baseUrl: 'https://synthetic.example.test',
          appId: credentials.appId, appSecret: credentials.appSecret })
        return false
      })).toBe(false)
      expect(calls).toBe(0)
      expect((await sql<{ count: string }>`SELECT count(*)::text count FROM procurement_request_intents WHERE operation_id=${op.id}::uuid`.execute(db)).rows[0]!.count).toBe('0')
      expect(await runProcurementFixturePass(db, op.id, server.transport, async source => source.credentialVersion === 1)).toBe(true)
      expect(calls).toBe(1)
    } finally { await server.close() }
  })

  it('rolls back a real killed preparation transaction, then recreates the same paid order identity in a fresh process', async () => {
    beginCrashFixtureDraftTracking()
    await ensureTestRiskPolicy()
    const { order, item } = await paidProcurementOrder(1, await currentCatalog())
    const requestId = randomUUID()
    const input = { requestId, orderId: order.id, orderItemId: item.id, unitIndices: [1], currency: 'TST', maxAmountMinor: '10' }
    const killed = await startProcurementCrashProcess(config, 'preparation_uncommitted')
    killed.child.send({ action: 'prepare', input })
    await killed.waitFor('checkpoint')
    expect(await killed.kill()).toBe('SIGKILL')

    const rolledBack = await sql<{ operations: string; units: string; reservations: string; events: string; requests: string }>`
      SELECT (SELECT count(*)::text FROM procurement_operations WHERE order_item_id=${item.id}::uuid) AS operations,
        (SELECT count(*)::text FROM procurement_operation_units WHERE order_item_id=${item.id}::uuid) AS units,
        (SELECT count(*)::text FROM procurement_risk_reservations reservation JOIN procurement_operations operation
          ON operation.id=reservation.operation_id WHERE operation.order_item_id=${item.id}::uuid) AS reservations,
        (SELECT count(*)::text FROM procurement_risk_events event JOIN procurement_operations operation
          ON operation.id=event.operation_id WHERE operation.order_item_id=${item.id}::uuid) AS events,
        (SELECT count(*)::text FROM procurement_preparation_requests WHERE request_id=${requestId}::uuid) AS requests
    `.execute(db)
    expect(rolledBack.rows[0]).toEqual({ operations: '0', units: '0', reservations: '0', events: '0', requests: '0' })
    expect((await db.selectFrom('orders').select('status').where('id', '=', order.id).executeTakeFirstOrThrow()).status).toBe('processing')
    expect(await db.selectFrom('payment_receipts as receipt').innerJoin('payment_attempts as attempt', 'attempt.id', 'receipt.payment_attempt_id')
      .select('receipt.id').where('attempt.order_id', '=', order.id).execute()).toHaveLength(1)

    const restarted = await startProcurementCrashProcess(config)
    expect(restarted.ready.pid).not.toBe(killed.ready.pid)
    expect(restarted.ready.backendPid).not.toBe(killed.ready.backendPid)
    const prepared = await restarted.run({ action: 'prepare', input }) as { id: string; localBusinessNumber: string; repeated: boolean }
    expect(prepared.repeated).toBe(false)
    expect((await db.selectFrom('procurement_preparation_requests').select('request_id').where('request_id', '=', requestId).execute()))
      .toHaveLength(1)
    expect((await db.selectFrom('procurement_operation_units').select('unit_index').where('operation_id', '=', prepared.id).execute()))
      .toEqual([{ unit_index: 1 }])
  })

  it('commits submit intent before HTTP, then only queries after SIGKILL, not_found and query error', async () => {
    beginCrashFixtureDraftTracking()
    await ensureTestRiskPolicy()
    const op = await readyOperation(1, await currentCatalog())
    const supplier = await startProcurementSupplierProcess()
    await supplier.control({ kind: 'not_found', execute: false })
    try {
      const killed = await startProcurementCrashProcess(config, 'intent_committed')
      killed.child.send({ action: 'pass', operationId: op.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      await killed.waitFor('checkpoint')
      expect(await killed.kill()).toBe('SIGKILL')
      expect(await supplier.stats()).toMatchObject({ submitRequests: 0, queryRequests: 0, executions: 0 })
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state)
        .toBe('submit_in_flight')
      expect((await db.selectFrom('procurement_request_intents').select(['action', 'request_identity'])
        .where('operation_id', '=', op.id).execute())).toEqual([{ action: 'submit', request_identity: op.localBusinessNumber }])

      await new Promise<void>(resolve => setTimeout(resolve, 1_100))
      const restarted = await startProcurementCrashProcess(config)
      expect(restarted.ready.pid).not.toBe(killed.ready.pid)
      expect(restarted.ready.backendPid).not.toBe(killed.ready.backendPid)
      await restarted.run({ action: 'pass', operationId: op.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state)
        .toBe('unknown')
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, op.id)))?.outstandingMinor).toBe('10')
      expect((await supplier.stats())).toMatchObject({ submitRequests: 0, queryRequests: 1, executions: 0 })
      expect((await db.selectFrom('procurement_request_intents').select('action').where('operation_id', '=', op.id)
        .orderBy('generation').execute()).map(row => row.action)).toEqual(['submit', 'query'])

      await supplier.control({ queryError: true })
      await sql`UPDATE procurement_execution_leases SET next_action_at=clock_timestamp()-interval '1 second'
        WHERE operation_id=${op.id}::uuid`.execute(db)
      const afterError = await startProcurementCrashProcess(config)
      await afterError.run({ action: 'pass', operationId: op.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state)
        .toBe('unknown')
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, op.id)))?.outstandingMinor).toBe('10')
      expect(await supplier.stats()).toMatchObject({ submitRequests: 0, queryRequests: 2, executions: 0 })
      expect((await db.selectFrom('procurement_request_intents').select('action').where('operation_id', '=', op.id)
        .orderBy('generation').execute()).map(row => row.action)).toEqual(['submit', 'query', 'query'])
    } finally { await supplier.close() }
  })

  it('recovers a supplier execution after the response is lost with the killed process', async () => {
    beginCrashFixtureDraftTracking()
    await ensureTestRiskPolicy()
    const op = await readyOperation(1, await currentCatalog())
    const supplier = await startProcurementSupplierProcess()
    await supplier.control({ kind: 'success', execute: true, holdSubmit: true, unitIndices: [1] })
    try {
      const killed = await startProcurementCrashProcess(config)
      killed.child.send({ action: 'pass', operationId: op.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      const stats = await waitForSupplierStats(supplier, value => value.executions === 1)
      expect(stats.submitRequests).toBe(1)
      expect(stats.queryRequests).toBe(0)
      expect(await killed.kill()).toBe('SIGKILL')
      await supplier.release()
      await new Promise<void>(resolve => setTimeout(resolve, 1_100))

      const restarted = await startProcurementCrashProcess(config)
      expect(restarted.ready.pid).not.toBe(killed.ready.pid)
      expect(restarted.ready.backendPid).not.toBe(killed.ready.backendPid)
      await restarted.run({ action: 'pass', operationId: op.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      expect(await supplier.stats()).toMatchObject({ submitRequests: 1, queryRequests: 1, executions: 1 })
      expect((await db.selectFrom('procurement_operations').select(['state', 'supplier_order_number'])
        .where('id', '=', op.id).executeTakeFirstOrThrow()).state).toBe('success_pending_finalize')
      expect((await db.selectFrom('procurement_operations').select('local_business_number').where('id', '=', op.id)
        .executeTakeFirstOrThrow()).local_business_number).toBe(op.localBusinessNumber)
      expect((await db.selectFrom('procurement_request_intents').select(['action', 'request_identity'])
        .where('operation_id', '=', op.id).orderBy('generation').execute()).map(row => row)).toEqual([
        { action: 'submit', request_identity: op.localBusinessNumber },
        { action: 'query', request_identity: op.localBusinessNumber },
      ])
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, op.id)))?.outstandingMinor).toBe('10')
    } finally { await supplier.release(); await supplier.close() }
  })

  it('discards parsed-but-uncommitted supplier response after SIGKILL and reconstructs only from a fresh identity query', async () => {
    beginCrashFixtureDraftTracking()
    await ensureTestRiskPolicy()
    const op = await readyOperation(1, await currentCatalog())
    const supplier = await startProcurementSupplierProcess()
    await supplier.control({ kind: 'success', execute: true, unitIndices: [1] })
    try {
      const killed = await startProcurementCrashProcess(config, 'response_parsed')
      killed.child.send({ action: 'pass', operationId: op.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      await killed.waitFor('checkpoint')
      expect(await killed.kill()).toBe('SIGKILL')
      expect((await supplier.stats())).toMatchObject({ submitRequests: 1, queryRequests: 0, executions: 1 })
      expect(await db.selectFrom('procurement_execution_evidence').select('id').where('operation_id', '=', op.id).execute())
        .toHaveLength(0)
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state)
        .toBe('submit_in_flight')

      await new Promise<void>(resolve => setTimeout(resolve, 1_100))
      const restarted = await startProcurementCrashProcess(config)
      expect(restarted.ready.pid).not.toBe(killed.ready.pid)
      expect(restarted.ready.backendPid).not.toBe(killed.ready.backendPid)
      await restarted.run({ action: 'pass', operationId: op.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      expect(await supplier.stats()).toMatchObject({ submitRequests: 1, queryRequests: 1, executions: 1 })
      expect((await db.selectFrom('procurement_execution_evidence').select('kind').where('operation_id', '=', op.id)
        .orderBy('observed_at').execute()).map(row => row.kind)).toEqual(['success', 'delivery_confirmed'])
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state)
        .toBe('success_pending_finalize')
    } finally { await supplier.close() }
  })

  it('recovers committed success and finalization after two distinct SIGKILLs without double delivery or consume', async () => {
    beginCrashFixtureDraftTracking()
    await ensureTestRiskPolicy()
    const sku = await currentCatalog(true)
    const op = await readyOperation(2, sku)
    const supplier = await startProcurementSupplierProcess()
    await supplier.control({ kind: 'success', execute: true, unitIndices: [1] })
    try {
      const evidenceWorker = await startProcurementCrashProcess(config, 'evidence_committed')
      evidenceWorker.child.send({ action: 'pass', operationId: op.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      await evidenceWorker.waitFor('checkpoint')
      expect(await evidenceWorker.kill()).toBe('SIGKILL')
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', op.id).executeTakeFirstOrThrow()).state)
        .toBe('success_pending_finalize')
      expect((await db.selectFrom('procurement_execution_evidence').select('kind').where('operation_id', '=', op.id)
        .orderBy('observed_at').execute()).map(row => row.kind)).toEqual(['success', 'delivery_confirmed'])
      expect(await db.selectFrom('order_item_fulfillment_deliveries as delivery')
        .innerJoin('order_item_fulfillment_attempts as attempt', 'attempt.id', 'delivery.fulfillment_attempt_id')
        .select('delivery.id').where('attempt.procurement_operation_id', '=', op.id).execute()).toHaveLength(0)

      const finalizeWorker = await startProcurementCrashProcess(config, 'finalization_committed')
      finalizeWorker.child.send({ action: 'finalize', operationId: op.id, unitIndex: 1 })
      await finalizeWorker.waitFor('checkpoint')
      expect(await finalizeWorker.kill()).toBe('SIGKILL')
      const beforeRetry = await sql<{ attempts: string; deliveries: string; consume: string }>`
        SELECT (SELECT count(*)::text FROM order_item_fulfillment_attempts WHERE procurement_operation_id=${op.id}::uuid) AS attempts,
          (SELECT count(*)::text FROM order_item_fulfillment_deliveries delivery JOIN order_item_fulfillment_attempts attempt
            ON attempt.id=delivery.fulfillment_attempt_id WHERE attempt.procurement_operation_id=${op.id}::uuid) AS deliveries,
          (SELECT count(*)::text FROM order_inventory_events event JOIN order_inventory_reservations reservation
            ON reservation.id=event.reservation_id WHERE reservation.order_item_id=(SELECT order_item_id FROM procurement_operations WHERE id=${op.id}::uuid)
              AND event.action='consume') AS consume
      `.execute(db)
      expect(beforeRetry.rows[0]).toEqual({ attempts: '1', deliveries: '1', consume: '1' })

      const restarted = await startProcurementCrashProcess(config)
      expect(restarted.ready.pid).not.toBe(finalizeWorker.ready.pid)
      expect(restarted.ready.backendPid).not.toBe(finalizeWorker.ready.backendPid)
      expect(await restarted.run({ action: 'finalize', operationId: op.id, unitIndex: 1 })).toBe('already_completed')
      expect(await finalizeProcurementUnit(secondDb, op.id, 1)).toBe('already_completed')
      const afterRetry = await sql<{ attempts: string; deliveries: string; consume: string; stocked: number; reserved: number;
        fulfilled: number; quantity: number; item_state: string; unit_one: string; unit_two: string; operation_state: string }>`
        SELECT (SELECT count(*)::text FROM order_item_fulfillment_attempts WHERE procurement_operation_id=${op.id}::uuid) AS attempts,
          (SELECT count(*)::text FROM order_item_fulfillment_deliveries delivery JOIN order_item_fulfillment_attempts attempt
            ON attempt.id=delivery.fulfillment_attempt_id WHERE attempt.procurement_operation_id=${op.id}::uuid) AS deliveries,
          (SELECT count(*)::text FROM order_inventory_events event JOIN order_inventory_reservations reservation
            ON reservation.id=event.reservation_id WHERE reservation.order_item_id=item.id AND event.action='consume') AS consume,
          inventory.stocked,inventory.reserved,item.fulfilled_quantity AS fulfilled,item.quantity,item.fulfillment_status AS item_state,
          (SELECT state FROM procurement_operation_units WHERE operation_id=${op.id}::uuid AND unit_index=1) AS unit_one,
          (SELECT state FROM procurement_operation_units WHERE operation_id=${op.id}::uuid AND unit_index=2) AS unit_two,
          operation.state AS operation_state
        FROM procurement_operations operation JOIN order_items item ON item.id=operation.order_item_id
        JOIN product_variant_quantity_inventory inventory ON inventory.product_variant_id=item.product_variant_id WHERE operation.id=${op.id}::uuid
      `.execute(db)
      expect(afterRetry.rows[0]).toMatchObject({ attempts: '1', deliveries: '1', consume: '1', stocked: 9, reserved: 1,
        fulfilled: 1, quantity: 2, item_state: 'partially_fulfilled', unit_one: 'completed', unit_two: 'allocated',
        operation_state: 'success_pending_finalize' })
      expect(await finalizeProcurementUnit(db, op.id, 2)).toBe('not_ready')
      expect(await supplier.stats()).toMatchObject({ submitRequests: 1, queryRequests: 0, executions: 1 })
    } finally { await supplier.close() }
  })

  it.each(['accepted', 'completed'] as const)('rolls back and rebuilds a global supplier-number conflict after A is %s', async mode => {
    beginCrashFixtureDraftTracking()
    await ensureTestRiskPolicy()
    const sku = await currentCatalog()
    const a = await readyOperation(1, sku)
    const supplier = await startProcurementSupplierProcess()
    const number = 'global-conflict-' + randomUUID()
    try {
      await supplier.control({ kind: mode === 'completed' ? 'success' : 'accepted', execute: true,
        supplierOrderNumber: number, unitIndices: [1] })
      const aWorker = await startProcurementCrashProcess(config)
      await aWorker.run({ action: 'pass', operationId: a.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      if (mode === 'completed') expect(await finalizeProcurementUnit(db, a.id, 1)).toBe('completed')
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', a.id).executeTakeFirstOrThrow()).state)
        .toBe(mode === 'completed' ? 'completed' : 'accepted_pending')
      const b = await readyOperation(1, sku)
      const grossBefore = await sql<{ gross: string }>`SELECT COALESCE(sum(gross_minor),0)::text AS gross
        FROM procurement_risk_daily WHERE currency='TST' AND scope_kind='global'`.execute(db)
      const bucketBefore = await sql<{ global: string; supplier: string; sku: string }>`SELECT
        (SELECT outstanding_minor::text FROM procurement_risk_buckets WHERE currency='TST' AND scope_kind='global' AND scope_key='*') AS global,
        (SELECT outstanding_minor::text FROM procurement_risk_buckets bucket JOIN procurement_risk_reservations r
          ON bucket.scope_kind='supplier' AND bucket.scope_key=r.supplier_connection_id::text
          WHERE r.operation_id=${a.id}::uuid AND bucket.currency='TST') AS supplier,
        (SELECT outstanding_minor::text FROM procurement_risk_buckets bucket JOIN procurement_risk_reservations r
          ON bucket.scope_kind='sku' AND bucket.scope_key=r.product_variant_id::text
          WHERE r.operation_id=${a.id}::uuid AND bucket.currency='TST') AS sku`.execute(db)
      await supplier.control({ kind: 'accepted', execute: true, supplierOrderNumber: number })
      const killed = await startProcurementCrashProcess(config, 'evidence_uncommitted')
      killed.child.send({ action: 'pass', operationId: b.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      await killed.waitFor('checkpoint')
      expect(await killed.kill()).toBe('SIGKILL')
      expect((await sql<{ count: string }>`SELECT count(*)::text AS count FROM procurement_execution_conflicts
        WHERE operation_id IN (${a.id}::uuid,${b.id}::uuid)`.execute(db)).rows[0]!.count).toBe('0')
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, a.id)))?.outstandingMinor).toBe('10')
      expect((await supplier.stats())).toMatchObject({ submitRequests: 2, queryRequests: 0, executions: 2 })

      await new Promise<void>(resolve => setTimeout(resolve, 1_100))
      const restarted = await startProcurementCrashProcess(config)
      expect(restarted.ready.pid).not.toBe(killed.ready.pid)
      expect(restarted.ready.backendPid).not.toBe(killed.ready.backendPid)
      await restarted.run({ action: 'pass', operationId: b.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      const conflictRows = await sql<{ operation_id: string; other_operation_id: string }>`SELECT operation_id,other_operation_id
        FROM procurement_execution_conflicts WHERE reason='supplier_number'
          AND operation_id IN (${a.id}::uuid,${b.id}::uuid) ORDER BY operation_id`.execute(db)
      expect(conflictRows.rows.map(row => row.operation_id)).toEqual([a.id, b.id].sort())
      expect((await db.selectFrom('procurement_execution_evidence').select('supplier_order_number')
        .where('operation_id', '=', b.id).where('supplier_order_number', '=', number).execute())).toHaveLength(1)
      expect((await db.selectFrom('procurement_operations').select('state').where('id', '=', b.id).executeTakeFirstOrThrow()).state)
        .toBe('manual_review')
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, a.id)))?.outstandingMinor).toBe('10')
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, b.id)))?.outstandingMinor).toBe('10')
      const bucketAfter = await sql<{ global: string; supplier: string; sku: string }>`SELECT
        (SELECT outstanding_minor::text FROM procurement_risk_buckets WHERE currency='TST' AND scope_kind='global' AND scope_key='*') AS global,
        (SELECT outstanding_minor::text FROM procurement_risk_buckets bucket JOIN procurement_risk_reservations r
          ON bucket.scope_kind='supplier' AND bucket.scope_key=r.supplier_connection_id::text
          WHERE r.operation_id=${a.id}::uuid AND bucket.currency='TST') AS supplier,
        (SELECT outstanding_minor::text FROM procurement_risk_buckets bucket JOIN procurement_risk_reservations r
          ON bucket.scope_kind='sku' AND bucket.scope_key=r.product_variant_id::text
          WHERE r.operation_id=${a.id}::uuid AND bucket.currency='TST') AS sku`.execute(db)
      expect(bucketAfter.rows[0]).toEqual(bucketBefore.rows[0])
      expect((await sql<{ gross: string }>`SELECT COALESCE(sum(gross_minor),0)::text AS gross
        FROM procurement_risk_daily WHERE currency='TST' AND scope_kind='global'`.execute(db)).rows[0]!.gross).toBe(grossBefore.rows[0]!.gross)

      const beforeBlockedPass = await supplier.stats()
      const repeated = await startProcurementCrashProcess(config)
      expect(await repeated.run({ action: 'pass', operationId: b.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 }))
        .toBe(false)
      expect(await supplier.stats()).toMatchObject({ submitRequests: beforeBlockedPass.submitRequests,
        queryRequests: beforeBlockedPass.queryRequests, executions: beforeBlockedPass.executions })
      expect((await sql<{ count: string }>`SELECT count(*)::text AS count FROM procurement_risk_events
        WHERE operation_id=${a.id}::uuid AND kind='reinstate'`.execute(db)).rows[0]!.count).toBe('0')
      if (mode === 'completed') expect(await finalizeProcurementUnit(secondDb, a.id, 1)).toBe('already_completed')
      expect(await supplier.stats()).toMatchObject({ submitRequests: 2, queryRequests: 1, executions: 2 })
    } finally { await supplier.close() }
  })

  it('rolls back a killed rejected-operation number collision and reinstates released risk once after recovery', async () => {
    beginCrashFixtureDraftTracking()
    await ensureTestRiskPolicy()
    const sku = await currentCatalog()
    const a = await readyOperation(1, sku, '2000-01-01')
    const supplier = await startProcurementSupplierProcess()
    const number = 'released-risk-conflict-' + randomUUID()
    try {
      await supplier.control({ kind: 'rejected', execute: true, supplierOrderNumber: number })
      const rejected = await startProcurementCrashProcess(config)
      await rejected.run({ action: 'pass', operationId: a.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      const rejectionIntent = await db.selectFrom('procurement_request_intents').select(['generation', 'request_identity'])
        .where('operation_id', '=', a.id).where('action', '=', 'submit').executeTakeFirstOrThrow()
      const rejectionEvidence = randomUUID()
      await db.transaction().execute(async trx => {
        await lockProcurementRiskPolicy(trx, a.id)
        await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,
          supplier_order_number,response_digest,amount_minor,currency)
          VALUES (${rejectionEvidence}::uuid,${a.id}::uuid,${rejectionIntent.generation},'submit','rejected',
            ${rejectionIntent.request_identity},${number},${digest},10,'TST')`.execute(trx)
        await recordProcurementRiskFact(trx, { operationId: a.id, factId: randomUUID(), kind: 'release',
          amountMinor: '10', evidenceId: rejectionEvidence })
        await sql`UPDATE procurement_operations SET state='rejected',revision=revision+1 WHERE id=${a.id}::uuid`.execute(trx)
        await sql`UPDATE procurement_operation_units SET state='rejected' WHERE operation_id=${a.id}::uuid`.execute(trx)
      })
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, a.id)))?.outstandingMinor).toBe('0')
      const source = await db.selectFrom('procurement_operations as operation')
        .innerJoin('order_item_procurement_sources as source', 'source.id', 'operation.source_id')
        .select(['source.order_id', 'operation.order_item_id']).where('operation.id', '=', a.id).executeTakeFirstOrThrow()
      const replacement = await db.transaction().execute(trx => prepareProcurementWithRisk(trx, { requestId: randomUUID(),
        orderId: source.order_id, orderItemId: source.order_item_id, unitIndices: [1], currency: 'TST', maxAmountMinor: '10' }))
      const b = await readyOperation(1, sku)
      const grossBefore = await sql<{ gross: string }>`SELECT COALESCE(sum(gross_minor),0)::text AS gross
        FROM procurement_risk_daily WHERE currency='TST' AND scope_kind='global'`.execute(db)
      const bucketBefore = await sql<{ global: string; supplier: string; sku: string }>`SELECT
        (SELECT outstanding_minor::text FROM procurement_risk_buckets WHERE currency='TST' AND scope_kind='global' AND scope_key='*') AS global,
        (SELECT outstanding_minor::text FROM procurement_risk_buckets bucket JOIN procurement_risk_reservations r
          ON bucket.scope_kind='supplier' AND bucket.scope_key=r.supplier_connection_id::text
          WHERE r.operation_id=${a.id}::uuid AND bucket.currency='TST') AS supplier,
        (SELECT outstanding_minor::text FROM procurement_risk_buckets bucket JOIN procurement_risk_reservations r
          ON bucket.scope_kind='sku' AND bucket.scope_key=r.product_variant_id::text
          WHERE r.operation_id=${a.id}::uuid AND bucket.currency='TST') AS sku`.execute(db)
      await supplier.control({ kind: 'accepted', execute: true, supplierOrderNumber: number })
      const killed = await startProcurementCrashProcess(config, 'evidence_uncommitted')
      killed.child.send({ action: 'pass', operationId: b.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      await killed.waitFor('checkpoint')
      expect(await killed.kill()).toBe('SIGKILL')
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, a.id)))?.outstandingMinor).toBe('0')
      expect((await sql<{ count: string }>`SELECT count(*)::text AS count FROM procurement_execution_conflicts
        WHERE operation_id IN (${a.id}::uuid,${b.id}::uuid)`.execute(db)).rows[0]!.count).toBe('0')

      await new Promise<void>(resolve => setTimeout(resolve, 1_100))
      const restarted = await startProcurementCrashProcess(config)
      await restarted.run({ action: 'pass', operationId: b.id, fixtureUrl: supplier.url, leaseMs: 1_000, requestTimeoutMs: 900 })
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, a.id)))?.outstandingMinor).toBe('10')
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, replacement.id)))?.outstandingMinor).toBe('10')
      expect((await sql<{ count: string }>`SELECT count(*)::text AS count FROM procurement_risk_events
        WHERE operation_id=${a.id}::uuid AND kind='reinstate'`.execute(db)).rows[0]!.count).toBe('1')
      const bucketAfter = (await sql<{ global: string; supplier: string; sku: string }>`SELECT
        (SELECT outstanding_minor::text FROM procurement_risk_buckets WHERE currency='TST' AND scope_kind='global' AND scope_key='*') AS global,
        (SELECT outstanding_minor::text FROM procurement_risk_buckets bucket JOIN procurement_risk_reservations r
          ON bucket.scope_kind='supplier' AND bucket.scope_key=r.supplier_connection_id::text
          WHERE r.operation_id=${a.id}::uuid AND bucket.currency='TST') AS supplier,
        (SELECT outstanding_minor::text FROM procurement_risk_buckets bucket JOIN procurement_risk_reservations r
          ON bucket.scope_kind='sku' AND bucket.scope_key=r.product_variant_id::text
          WHERE r.operation_id=${a.id}::uuid AND bucket.currency='TST') AS sku`.execute(db)).rows[0]!
      for (const scope of ['global', 'supplier', 'sku'] as const) {
        expect(BigInt(bucketAfter[scope])).toBe(BigInt(bucketBefore.rows[0]![scope]) + 10n)
      }
      expect((await sql<{ gross: string }>`SELECT COALESCE(sum(gross_minor),0)::text AS gross FROM procurement_risk_daily
        WHERE currency='TST' AND scope_kind='global'`.execute(db)).rows[0]!.gross).toBe(grossBefore.rows[0]!.gross)
      const orderUnresolved = await sql<{ unresolved: boolean }>`SELECT order_has_unresolved_fulfillment(${source.order_id}::uuid) AS unresolved`.execute(db)
      expect(orderUnresolved.rows[0]!.unresolved).toBe(true)
      await expect(db.transaction().execute(trx => prepareProcurementWithRisk(trx, { requestId: randomUUID(), orderId: source.order_id,
        orderItemId: source.order_item_id, unitIndices: [1], currency: 'TST', maxAmountMinor: '10' }))).rejects.toThrow()
      expect(await finalizeProcurementUnit(db, replacement.id, 1)).toBe('not_ready')
      const beforeBlockedPass = await supplier.stats()
      const blocked = await startProcurementCrashProcess(config)
      expect(await blocked.run({ action: 'pass', operationId: replacement.id, fixtureUrl: supplier.url,
        leaseMs: 1_000, requestTimeoutMs: 900 })).toBe(false)
      expect(await supplier.stats()).toMatchObject({ submitRequests: beforeBlockedPass.submitRequests,
        queryRequests: beforeBlockedPass.queryRequests, executions: beforeBlockedPass.executions })
      expect((await sql<{ count: string }>`SELECT count(*)::text AS count FROM procurement_risk_events
        WHERE operation_id=${a.id}::uuid AND kind='reinstate'`.execute(db)).rows[0]!.count).toBe('1')
    } finally { await supplier.close() }
  })

  it('R1 restores released cross-day exposure above the cap without duplicating daily gross', async () => {
    await db.transaction().execute(trx => initializeSyntheticProcurementRiskPolicy(trx, { currency: 'TST', limits: {
      perOperationMinor: '100', globalDailyMinor: '10000', globalOutstandingMinor: '10000',
      supplierDailyMinor: '10000', supplierOutstandingMinor: '10000', skuDailyMinor: '10000', skuOutstandingMinor: '10000',
    } }))
    const versionId = (await db.selectFrom('supplier_connections').select('current_version_id').where('id', '=', connectionId).executeTakeFirstOrThrow()).current_version_id!
    const sku = await catalog('1.00', false, { id: connectionId, versionId })
    const a = await readyOperation(1, sku, '2000-01-01'), b = await readyOperation(1, sku)
    const number = `cap-${randomUUID()}`, requests: ProcurementFixtureRequest[] = []
    const server = await fixtureServer(async request => {
      requests.push(request)
      return { requestIdentity: request.requestIdentity, kind: request.operationId === a.id && request.action === 'query' ? 'rejected' : 'accepted',
        supplierOrderNumber: number, responseDigest: digest }
    })
    try {
      await runProcurementFixturePass(db, a.id, server.transport, async () => true)
      await sql`UPDATE procurement_execution_leases SET next_action_at=clock_timestamp()-interval '1 second' WHERE operation_id=${a.id}::uuid`.execute(db)
      await runProcurementFixturePass(db, a.id, server.transport, async () => true)
      const evidenceId = randomUUID()
      await db.transaction().execute(async trx => {
        const source = (await sql<{ order_id: string; order_item_id: string }>`SELECT s.order_id,o.order_item_id FROM procurement_operations o
          JOIN order_item_procurement_sources s ON s.id=o.source_id WHERE o.id=${a.id}::uuid`.execute(trx)).rows[0]!
        await sql`SELECT id FROM orders WHERE id=${source.order_id}::uuid FOR UPDATE`.execute(trx)
        await sql`SELECT id FROM order_items WHERE id=${source.order_item_id}::uuid FOR UPDATE`.execute(trx)
        await lockProcurementRiskPolicy(trx, a.id)
        await sql`INSERT INTO procurement_execution_evidence(id,operation_id,generation,action,kind,request_identity,response_digest,supplier_order_number,amount_minor,currency)
          VALUES (${evidenceId}::uuid,${a.id}::uuid,2,'query','rejected',${a.localBusinessNumber},${digest},${number},10,'TST')`.execute(trx)
        await recordProcurementRiskFact(trx, { operationId: a.id, factId: randomUUID(), kind: 'release', amountMinor: '10', evidenceId })
        await sql`UPDATE procurement_operations SET state='rejected',revision=revision+1 WHERE id=${a.id}::uuid`.execute(trx)
        await sql`UPDATE procurement_operation_units SET state='rejected' WHERE operation_id=${a.id}::uuid`.execute(trx)
      })
      const current = Number((await sql<{ outstanding: string }>`SELECT outstanding_minor::text AS outstanding FROM procurement_risk_buckets
        WHERE currency='TST' AND scope_kind='global' AND scope_key='*'`.execute(db)).rows[0]!.outstanding)
      let remaining = 10000 - current
      while (remaining > 0) {
        const count = Math.min(99, Math.ceil(remaining / 100))
        selected.rows = [{ skuId: sku.skuId, mappingVersionId: sku.versionId }]
        const result = await checkout([line(sku, await draft(randomUUID()), count)])
        await pay(result.order.id)
        const item = result.order.items[0]!
        await db.transaction().execute(async trx => {
          for (let index = 1; index <= count; index++) {
            const amount = Math.min(100, remaining)
            const op = await allocateProcurementIdentity(trx, result.order.id, item.id, [index])
            await reserveProcurementRisk(trx, { operationId: op.id, currency: 'TST', maxAmountMinor: String(amount), utcDay: '2000-01-02' })
            remaining -= amount
          }
        })
      }
      const before = (await sql<{ total: string; gross: string }>`SELECT
        (SELECT outstanding_minor::text FROM procurement_risk_buckets WHERE currency='TST' AND scope_kind='global' AND scope_key='*') AS total,
        (SELECT sum(gross_minor)::text FROM procurement_risk_daily WHERE currency='TST' AND scope_kind='global') AS gross`.execute(db)).rows[0]!
      expect(before.total).toBe('10000')
      await runProcurementFixturePass(secondDb, b.id, server.transport, async () => true)
      const after = (await sql<{ total: string; gross: string }>`SELECT
        (SELECT outstanding_minor::text FROM procurement_risk_buckets WHERE currency='TST' AND scope_kind='global' AND scope_key='*') AS total,
        (SELECT sum(gross_minor)::text FROM procurement_risk_daily WHERE currency='TST' AND scope_kind='global') AS gross`.execute(db)).rows[0]!
      expect(after).toEqual({ total: '10010', gross: before.gross })
      expect((await db.transaction().execute(trx => readProcurementRisk(trx, a.id)))?.outstandingMinor).toBe('10')
      expect(requests.map(row => row.action)).toEqual(['submit','query','submit'])
    } finally { await server.close() }
  }, 60000)




})
