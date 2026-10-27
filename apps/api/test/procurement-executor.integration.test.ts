import { randomBytes, randomUUID } from 'node:crypto'
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
import { PurchaseAttachmentStorage } from '../src/media/purchase-attachment-storage.js'
import { encryptSupplierCredentials } from '../src/commerce/supplier-api-crypto.js'
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
let skuA: Catalog

type Catalog = { productId: string; skuId: string; mappingId: string; versionId: string; price: string }

function cookie(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers['set-cookie']
  const rows = Array.isArray(value) ? value : [value ?? '']
  return rows.find(row => row.startsWith(`${name}=`))!.split(';')[0]!
}

async function catalog(price: string, quantityStock = false): Promise<Catalog> {
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
let checkoutSequence = 0
async function checkout(items: Line[]) {
  const checkoutApp = checkoutSequence++ % 2 === 0 ? app : secondApp
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
  skuA = await catalog('1.00')
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


import { createServer, type Server } from 'node:http'
import { prepareProcurementWithRisk, runProcurementFixturePass, type ProcurementFixtureRequest, type ProcurementFixtureResult } from '../src/commerce/procurement-executor.js'
import { initializeSyntheticProcurementRiskPolicy, readProcurementRisk, recordProcurementRiskFact, lockProcurementRiskPolicy } from '../src/commerce/procurement-risk-budget.js'
import { finalizeProcurementUnit } from '../src/commerce/procurement-finalization.js'

async function readyOperation(quantity = 1, sku = skuA) {
  selected.rows = [{ skuId: sku.skuId, mappingVersionId: sku.versionId }]
  const result = await checkout([line(sku, await draft(randomUUID()), quantity)])
  await pay(result.order.id)
  const item = result.order.items[0]!
  const requestId = randomUUID()
  const operation = await db.transaction().execute(trx => prepareProcurementWithRisk(trx, { requestId, orderId: result.order.id,
    orderItemId: item.id, unitIndices: Array.from({ length: quantity }, (_, i) => i + 1), currency: 'TST', maxAmountMinor: '10' }))
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

  it('fails closed on unavailable historic key and recovers using the frozen version after rotation', async () => {
    const op = await readyOperation(), version2 = randomUUID()
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
    let calls = 0
    const server = await fixtureServer(async request => { calls++; return { requestIdentity: request.requestIdentity,
      kind: 'pending', supplierOrderNumber: 'historic-key-fixture', responseDigest: digest } })
    try {
      expect(await runProcurementFixturePass(db, op.id, server.transport, async source => {
        expect(source.connectionVersionId).toBe(connectionVersionId); expect(source.credentialVersion).toBe(1)
        return false
      })).toBe(false)
      expect(calls).toBe(0)
      expect((await sql<{ count: string }>`SELECT count(*)::text count FROM procurement_request_intents WHERE operation_id=${op.id}::uuid`.execute(db)).rows[0]!.count).toBe('0')
      expect(await runProcurementFixturePass(db, op.id, server.transport, async source => source.credentialVersion === 1)).toBe(true)
      expect(calls).toBe(1)
    } finally { await server.close() }
  })


})
