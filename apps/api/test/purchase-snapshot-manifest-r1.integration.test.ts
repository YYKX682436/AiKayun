import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Migrator } from 'kysely/migration'
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely'
import sharp from 'sharp'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { purchaseSnapshotManifestR1Migration } from '../src/db/migrations/202610250002_purchase_snapshot_manifest_r1.js'
import type { Database } from '../src/db/types.js'
import { readConfig, type AppConfig } from '../src/config.js'
import { encryptPurchaseOrderValues } from '../src/commerce/purchase-form-crypto.js'
import { getOwnedOrderPurchaseSnapshot, readOwnedOrderPurchaseAttachment } from '../src/commerce/purchase-order-attachments.js'
import { PurchaseOrderAttachmentStorage } from '../src/media/purchase-order-attachment-storage.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const baselineOnly = process.env.PURCHASE_LINES_R1_BASELINE === '1'
let db: Kysely<Database>
let config: AppConfig
let privateRoot: string
let storage: PurchaseOrderAttachmentStorage
let customerId: string
let sessionId: string
let productId: string
let skuId: string
let versionId: string

interface FormOrderInput {
  normalizationVersion?: number | null
  attachmentIds?: string[]
  manifest?: RawBuilder<unknown>
  ordinals?: number[]
  persistedFiles?: boolean
}

function identity(): string {
  return createHash('sha256').update(JSON.stringify({
    normalizationVersion: null, skuId, templateVersionId: null, values: null,
  })).digest('hex')
}

async function fixtures() {
  customerId = randomUUID()
  sessionId = randomUUID()
  productId = randomUUID()
  skuId = randomUUID()
  versionId = randomUUID()
  const adminId = randomUUID()
  const templateId = randomUUID()
  await db.insertInto('customers').values({
    id: customerId, username: `r1-${customerId.slice(0, 8)}`,
    password_hash: 'integration-only', status: 'active',
  }).execute()
  await db.insertInto('customer_sessions').values({
    id: sessionId, customer_id: customerId, token_hash: 'a'.repeat(64),
    expires_at: new Date(Date.now() + 3_600_000), revoked_at: null,
  }).execute()
  await db.transaction().execute(async trx => {
    await trx.insertInto('products').values({
      id: productId, name: 'R1 快照约束商品', description: '', product_type: 'digital', status: 'active',
    }).execute()
    await trx.insertInto('product_variants').values({
      id: skuId, product_id: productId, sku_code: `R1-${skuId.slice(0, 8)}`,
      combination_key: '', sale_price: '1.00', enabled: true, inventory_mode: 'unlimited',
    }).execute()
    await trx.insertInto('product_variant_fulfillment').values({
      product_variant_id: skuId, method: 'manual', manual_delivery_ready: true,
    }).execute()
  })
  await db.insertInto('admin_users').values({
    id: adminId, email: `r1-${adminId.slice(0, 8)}@example.test`, password_hash: 'integration-only',
  }).execute()
  await db.insertInto('purchase_form_templates').values({
    id: templateId, name: 'R1 多图模板', definition: { fields: [] },
    created_by_admin_id: adminId, updated_by_admin_id: adminId,
  }).execute()
  await db.insertInto('purchase_form_template_versions').values({
    id: versionId, template_id: templateId, version_number: 1,
    name: 'R1 多图模板 v1', definition: { fields: [] }, sha256: 'e'.repeat(64),
    created_by_admin_id: adminId,
  }).execute()
}

async function insertItem(trx: Transaction<Database>, orderId: string, itemId: string) {
  await trx.insertInto('orders').values({
    id: orderId, customer_id: customerId, guest_order_session_id: null,
    idempotency_key: randomUUID(), request_sha256: 'b'.repeat(64), total_amount: '1.00',
    unpaid_expires_at: new Date(Date.now() + 3_600_000), history_hidden_at: null,
    history_hidden_by_admin_id: null, history_hidden_reason: null,
  }).execute()
  await trx.insertInto('order_items').values({
    id: itemId, order_id: orderId, purchase_line_id: randomUUID(),
    product_id: productId, product_variant_id: skuId,
    product_name_snapshot: 'R1 快照约束商品', product_type_snapshot: 'digital',
    sku_code_snapshot: `R1-${skuId.slice(0, 8)}`, sku_snapshot: '[]',
    inventory_mode_snapshot: 'unlimited', fulfillment_method_snapshot: 'manual',
    fulfillment_content_version_id: null, unit_price: '1.00', quantity: 1, line_amount: '1.00',
  }).execute()
}

async function writeFormOrder(input: FormOrderInput = {}) {
  const orderId = randomUUID()
  const itemId = randomUUID()
  const attachmentIds = input.attachmentIds ?? []
  const archives = await Promise.all(attachmentIds.map(async (id, index) => {
    const objectId = randomUUID()
    const bytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 32 + index * 20, g: 90, b: 120 } },
    }).webp().toBuffer()
    return { id, objectId, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), fieldId: randomUUID() }
  }))
  for (const archive of archives) {
    if (input.persistedFiles) await storage.store(archive.objectId, archive.bytes, archive.sha256)
  }
  const values = Object.fromEntries(archives.map(archive => [archive.fieldId, { attachmentId: archive.id }]))
  const envelope = encryptPurchaseOrderValues(config, itemId, values)
  await db.transaction().execute(async trx => {
    await insertItem(trx, orderId, itemId)
    await trx.insertInto('order_item_purchase_snapshots').values({
      order_item_id: itemId, template_version_id: versionId,
      normalization_version: input.normalizationVersion === undefined ? 1 : input.normalizationVersion,
      content_identity: 'c'.repeat(64), encrypted_values: envelope.ciphertext,
      values_nonce: envelope.nonce, values_auth_tag: envelope.authTag,
      encryption_key_id: envelope.keyId, attachment_ids: input.manifest ?? attachmentIds,
    }).execute()
    for (let index = 0; index < archives.length; index += 1) {
      const archive = archives[index]!
      await trx.insertInto('purchase_order_attachment_objects').values({
        id: archive.objectId, source_draft_id: randomUUID(), source_attachment_id: archive.id,
        storage_key: storage.storageKey(archive.objectId), byte_size: archive.bytes.length,
        width: 4, height: 4, sha256: archive.sha256,
      }).execute()
      await trx.insertInto('order_item_purchase_attachments').values({
        order_item_id: itemId, source_attachment_id: archive.id, archive_object_id: archive.objectId,
        field_id: archive.fieldId, ordinal: input.ordinals?.[index] ?? index + 1,
        sha256: archive.sha256, byte_size: archive.bytes.length,
      }).execute()
      await trx.updateTable('purchase_order_attachment_objects').set({ status: 'retained' })
        .where('id', '=', archive.objectId).execute()
    }
    await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', orderId).execute()
  })
  return { orderId, itemId, archives, values }
}

async function counts() {
  const [orders, snapshots, references, objects, retained] = await Promise.all([
    db.selectFrom('orders').select(sql<number>`count(*)::int`.as('count')).executeTakeFirstOrThrow(),
    db.selectFrom('order_item_purchase_snapshots').select(sql<number>`count(*)::int`.as('count')).executeTakeFirstOrThrow(),
    db.selectFrom('order_item_purchase_attachments').select(sql<number>`count(*)::int`.as('count')).executeTakeFirstOrThrow(),
    db.selectFrom('purchase_order_attachment_objects').select(sql<number>`count(*)::int`.as('count')).executeTakeFirstOrThrow(),
    db.selectFrom('purchase_order_attachment_objects').select(sql<number>`count(*)::int`.as('count'))
      .where('status', '=', 'retained').executeTakeFirstOrThrow(),
  ])
  return { orders: orders.count, snapshots: snapshots.count, references: references.count, objects: objects.count, retained: retained.count }
}

async function durableRows() {
  const [orders, snapshots, references, objects] = await Promise.all([
    db.selectFrom('orders').selectAll().orderBy('id').execute(),
    db.selectFrom('order_item_purchase_snapshots').selectAll().orderBy('order_item_id').execute(),
    db.selectFrom('order_item_purchase_attachments').selectAll().orderBy('order_item_id').orderBy('ordinal').execute(),
    db.selectFrom('purchase_order_attachment_objects').selectAll().orderBy('id').execute(),
  ])
  return { orders, snapshots, references, objects }
}

async function writeLegacyOrder() {
  const orderId = randomUUID()
  const itemId = randomUUID()
  await db.transaction().execute(async trx => {
    await trx.insertInto('orders').values({
      id: orderId, customer_id: customerId, guest_order_session_id: null,
      idempotency_key: randomUUID(), request_sha256: 'f'.repeat(64), total_amount: '1.00',
      unpaid_expires_at: new Date(Date.now() + 3_600_000), history_hidden_at: null,
      history_hidden_by_admin_id: null, history_hidden_reason: null,
    }).execute()
    await trx.insertInto('order_items').values({
      id: itemId, order_id: orderId, product_id: productId, product_variant_id: skuId,
      product_name_snapshot: 'R1 快照约束商品', product_type_snapshot: 'digital',
      sku_code_snapshot: `R1-${skuId.slice(0, 8)}`, sku_snapshot: '[]',
      inventory_mode_snapshot: 'unlimited', fulfillment_method_snapshot: 'manual',
      fulfillment_content_version_id: null, unit_price: '1.00', quantity: 1, line_amount: '1.00',
    }).execute()
    await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', orderId).execute()
  })
  return { orderId, itemId }
}

async function reset(target: string) {
  await sql`DROP SCHEMA public CASCADE`.execute(db)
  await sql`CREATE SCHEMA public`.execute(db)
  const result = await new Migrator({ db, provider: new AppMigrationProvider() }).migrateTo(target)
  if (result.error) throw result.error
  await fixtures()
}

async function upgradeToLatest() {
  const result = await new Migrator({ db, provider: new AppMigrationProvider() }).migrateToLatest()
  if (result.error) throw result.error
  return result
}

function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

beforeAll(async () => {
  if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.slice(1).endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must name an isolated PostgreSQL database ending in _test')
  }
  process.env.DATABASE_URL = testDatabaseUrl
  db = createDatabase()
  config = { ...readConfig(), paymentCredentialKeyRing: { activeKeyId: 'r1', keys: { r1: Buffer.alloc(32, 0x73) } } }
  privateRoot = await mkdtemp(join(tmpdir(), 'aikayun-r1-manifest-'))
  storage = new PurchaseOrderAttachmentStorage(privateRoot)
  await storage.ensureReady()
  await reset('202610250001_purchase_lines')
  if (!baselineOnly) await upgradeToLatest()
})

afterAll(async () => {
  if (db) await db.destroy()
  if (privateRoot) await rm(privateRoot, { recursive: true, force: true })
})

describe('⑥-2B R1 ordered purchase snapshot manifest gates', () => {
  it('rejects a filled snapshot without a normalization version and rolls its transaction back', async () => {
    const before = await counts()
    await expect(writeFormOrder({ normalizationVersion: null })).rejects.toMatchObject({
      constraint: 'order_item_purchase_snapshots_shape_check',
    })
    expect(await counts()).toEqual(before)
    await expect(writeFormOrder({ normalizationVersion: 2 })).rejects.toMatchObject({
      constraint: 'order_item_purchase_snapshots_shape_check',
    })
    expect(await counts()).toEqual(before)
  })

  it.each([
    { label: 'one image manifest [A] with A at ordinal 2', size: 1, ordinals: [2] },
    { label: 'two image manifest [A,B] with A at 3 and B at 2', size: 2, ordinals: [3, 2] },
    { label: 'two image manifest [A,B] with A at 2 and B at 1', size: 2, ordinals: [2, 1] },
  ])('rejects $label without leaving an order, reference or retained object', async ({ size, ordinals }) => {
    const before = await counts()
    await expect(writeFormOrder({ attachmentIds: Array.from({ length: size }, () => randomUUID()), ordinals }))
      .rejects.toMatchObject({ constraint: 'order_purchase_attachment_manifest_invalid' })
    expect(await counts()).toEqual(before)
  })

  it.each(['lower bound zero', 'two dimensions', 'null element', 'duplicate identity'])('rejects a manifest with %s', async mode => {
    const before = await counts()
    const id = randomUUID()
    let manifest: RawBuilder<unknown>
    let attachmentIds = [id]
    if (mode === 'lower bound zero') manifest = sql`array_fill(${id}::uuid, ARRAY[1], ARRAY[0])`
    else if (mode === 'two dimensions') manifest = sql`ARRAY[ARRAY[${id}::uuid]]`
    else if (mode === 'null element') { manifest = sql`ARRAY[NULL]::uuid[]`; attachmentIds = [] }
    else manifest = sql`ARRAY[${id}::uuid, ${id}::uuid]`
    await expect(writeFormOrder({ attachmentIds, manifest })).rejects.toMatchObject({ code: '23514' })
    expect(await counts()).toEqual(before)
  })

  it('seals a canonical empty filled snapshot and a no-form snapshot', async () => {
    const form = await writeFormOrder()
    const orderId = randomUUID()
    const itemId = randomUUID()
    await db.transaction().execute(async trx => {
      await insertItem(trx, orderId, itemId)
      await trx.insertInto('order_item_purchase_snapshots').values({
        order_item_id: itemId, template_version_id: null, normalization_version: null,
        content_identity: identity(), encrypted_values: null, values_nonce: null,
        values_auth_tag: null, encryption_key_id: null, attachment_ids: [],
      }).execute()
      await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', orderId).execute()
    })
    expect(await db.selectFrom('orders').select('id').where('id', 'in', [form.orderId, orderId])
      .where('items_sealed', '=', true).execute()).toHaveLength(2)
  })

  it('preserves ordered multi-image authorization, digests and sealed immutability', async () => {
    const fixture = await writeFormOrder({ attachmentIds: [randomUUID(), randomUUID()], persistedFiles: true })
    const owner = { kind: 'customer' as const, customer: { id: customerId, sessionId } }
    const result = await getOwnedOrderPurchaseSnapshot(db, config, owner, fixture.itemId)
    expect(result).toMatchObject({ state: 'filled', templateVersionId: versionId, normalizationVersion: 1, values: fixture.values })
    expect(result.attachments.map(row => row.attachmentId)).toEqual(fixture.archives.map(row => row.id))
    for (const archive of fixture.archives) {
      const image = await readOwnedOrderPurchaseAttachment(db, storage, owner, fixture.itemId, archive.id)
      expect(image.bytes).toEqual(archive.bytes)
      expect(image.sha256).toBe(archive.sha256)
    }
    const otherId = randomUUID()
    const otherSessionId = randomUUID()
    await db.insertInto('customers').values({
      id: otherId, username: `other-${otherId.slice(0, 8)}`, password_hash: 'integration-only', status: 'active',
    }).execute()
    await db.insertInto('customer_sessions').values({
      id: otherSessionId, customer_id: otherId, token_hash: createHash('sha256').update(otherId).digest('hex'),
      expires_at: new Date(Date.now() + 3_600_000), revoked_at: null,
    }).execute()
    const otherOwner = { kind: 'customer' as const, customer: { id: otherId, sessionId: otherSessionId } }
    await expect(getOwnedOrderPurchaseSnapshot(db, config, otherOwner, fixture.itemId))
      .rejects.toMatchObject({ status: 404, code: 'ORDER_ITEM_NOT_FOUND' })
    await expect(readOwnedOrderPurchaseAttachment(db, storage, otherOwner, fixture.itemId, fixture.archives[0]!.id))
      .rejects.toMatchObject({ status: 404, code: 'ORDER_ATTACHMENT_NOT_FOUND' })
    for (const query of [
      db.updateTable('order_item_purchase_snapshots').set({ normalization_version: 1 }).where('order_item_id', '=', fixture.itemId),
      db.deleteFrom('order_item_purchase_snapshots').where('order_item_id', '=', fixture.itemId),
      db.updateTable('order_item_purchase_attachments').set({ ordinal: 2 }).where('order_item_id', '=', fixture.itemId),
      db.deleteFrom('order_item_purchase_attachments').where('order_item_id', '=', fixture.itemId),
    ]) await expect(query.execute()).rejects.toMatchObject({ constraint: 'order_purchase_data_immutable' })
    // The procurement source's RESTRICT reference rejects a bare TRUNCATE
    // before PostgreSQL invokes the existing immutable-history trigger.
    await expect(sql`TRUNCATE order_item_purchase_snapshots`.execute(db)).rejects.toMatchObject({ code: '0A000' })
    await expect(sql`TRUNCATE order_item_purchase_snapshots CASCADE`.execute(db))
      .rejects.toMatchObject({ constraint: 'order_purchase_data_immutable' })
    await expect(sql`TRUNCATE order_item_purchase_attachments`.execute(db)).rejects.toMatchObject({ constraint: 'order_purchase_data_immutable' })
    await expect(db.insertInto('order_item_purchase_snapshots').values({
      order_item_id: fixture.itemId, template_version_id: null, normalization_version: null,
      content_identity: identity(), encrypted_values: null, values_nonce: null,
      values_auth_tag: null, encryption_key_id: null, attachment_ids: [],
    }).execute()).rejects.toMatchObject({ constraint: 'order_purchase_snapshot_insert_invalid' })
    await expect(db.insertInto('order_item_purchase_attachments').values({
      order_item_id: fixture.itemId, source_attachment_id: randomUUID(), archive_object_id: randomUUID(),
      field_id: randomUUID(), ordinal: 3, sha256: 'd'.repeat(64), byte_size: 4,
    }).execute()).rejects.toMatchObject({ constraint: 'order_purchase_attachment_insert_invalid' })
  })

  it.skipIf(baselineOnly)('upgrades the fixed baseline without changing valid snapshots, old request hashes or archive identities', async () => {
    await reset('202610240003_purchase_form_audit_product_identity')
    const legacy = await writeLegacyOrder()
    const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
    const base = await migrator.migrateTo('202610250001_purchase_lines')
    if (base.error) throw base.error
    const sample = await writeFormOrder({ attachmentIds: [randomUUID(), randomUUID()], persistedFiles: true })
    const before = await durableRows()
    const upgraded = await migrator.migrateToLatest()
    expect(upgraded.error).toBeUndefined()
    expect(upgraded.results).toEqual([expect.objectContaining({
      migrationName: '202610250002_purchase_snapshot_manifest_r1', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610250003_purchase_form_activation_state', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610250004_cart_replacement_drafts', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610260001_supplier_product_mappings', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610260002_product_pricing_rules', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610270001_supplier_quote_observations', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610270002_supplier_quote_source_consistency', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610270003_procurement_identity', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610270004_procurement_risk_budget', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610270005_procurement_execution', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610270006_procurement_identity_conflict_guard', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610270007_procurement_global_conflicts', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610290001_installation_identity', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610300001_local_license_operations', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610300002_single_initial_activation_attempt', status: 'Success',
    }), expect.objectContaining({
      migrationName: '202610300003_license_operation_result_archive', status: 'Success',
    })])
    expect(await durableRows()).toEqual(before)
    const repeated = await migrator.migrateToLatest()
    expect(repeated.error).toBeUndefined()
    expect(repeated.results).toEqual([])
    const downgrade = await migrator.migrateTo('202610250001_purchase_lines')
    expect(downgrade.error).toBeDefined()
    // Newer forward-only licensing migrations stop the migrator before older guards;
    // exercise the original migration's own guard directly as well.
    await expect(db.transaction().execute(trx => purchaseSnapshotManifestR1Migration.down!(trx)))
      .rejects.toMatchObject({ message: 'Cannot downgrade purchase snapshot gates while snapshots or archived objects exist' })
    expect(await durableRows()).toEqual(before)
    const owner = { kind: 'customer' as const, customer: { id: customerId, sessionId } }
    expect(await getOwnedOrderPurchaseSnapshot(db, config, owner, legacy.itemId)).toMatchObject({ state: 'legacy' })
    expect(await getOwnedOrderPurchaseSnapshot(db, config, owner, sample.itemId)).toMatchObject({
      state: 'filled', templateVersionId: versionId, normalizationVersion: 1, values: sample.values,
      attachments: sample.archives.map(archive => expect.objectContaining({ attachmentId: archive.id, sha256: archive.sha256 })),
    })
    for (const archive of sample.archives) {
      expect((await readOwnedOrderPurchaseAttachment(db, storage, owner, sample.itemId, archive.id)).bytes).toEqual(archive.bytes)
    }
  })

  it.skipIf(baselineOnly)('fails the forward migration on pre-existing abnormal data without repairing sealed history', async () => {
    const modes = ['missing version', 'single ordinal overflow', 'double ordinal overflow', 'lower bound zero', 'two dimensions']
    try {
      for (const mode of modes) {
        await reset('202610250001_purchase_lines')
        const id = randomUUID()
        let input: FormOrderInput
        if (mode === 'missing version') input = { normalizationVersion: null }
        else if (mode === 'single ordinal overflow') input = { attachmentIds: [id], ordinals: [2] }
        else if (mode === 'double ordinal overflow') input = { attachmentIds: [id, randomUUID()], ordinals: [3, 2] }
        else if (mode === 'lower bound zero') input = { attachmentIds: [id], manifest: sql`array_fill(${id}::uuid, ARRAY[1], ARRAY[0])` }
        else input = { attachmentIds: [id], manifest: sql`ARRAY[ARRAY[${id}::uuid]]` }
        const abnormal = await writeFormOrder(input)
        const before = await durableRows()
        expect(before.orders.find(row => row.id === abnormal.orderId)?.items_sealed, mode).toBe(true)
        const result = await new Migrator({ db, provider: new AppMigrationProvider() }).migrateToLatest()
        expect(result.error, mode).toMatchObject({
          code: '23514', constraint: mode === 'missing version'
            ? 'order_purchase_snapshot_existing_shape_invalid' : 'order_purchase_attachment_existing_manifest_invalid',
        })
        expect(await durableRows(), mode).toEqual(before)
        expect((await sql<{ count: number }>`SELECT count(*)::int AS count FROM kysely_migration
          WHERE name = '202610250002_purchase_snapshot_manifest_r1'`.execute(db)).rows[0]?.count, mode).toBe(0)
        expect((await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_constraint
          WHERE conname = 'order_item_purchase_snapshots_manifest_check'`.execute(db)).rows[0]?.count, mode).toBe(0)
      }
    } finally {
      await reset('202610250001_purchase_lines')
      await upgradeToLatest()
    }
  }, 60_000)

  it.skipIf(baselineOnly)('lets archive cleanup finish its object-then-reference lock sequence during both migration directions', async () => {
    for (const direction of ['up', 'down'] as const) {
      await reset('202610250001_purchase_lines')
      if (direction === 'down') await upgradeToLatest()
      const objectId = randomUUID()
      await db.insertInto('purchase_order_attachment_objects').values({
        id: objectId, source_draft_id: randomUUID(), source_attachment_id: randomUUID(),
        storage_key: storage.storageKey(objectId), byte_size: 4, width: 1, height: 1,
        sha256: 'd'.repeat(64), created_at: new Date(Date.now() - 25 * 3_600_000),
      }).execute()
      const objectLocked = gate()
      const inspectReferences = gate()
      const cleaner = db.transaction().execute(async trx => {
        await sql`SET LOCAL statement_timeout = '10s'`.execute(trx)
        // This is the real cleaner's critical SQL sequence. Keep its object
        // row lock while the migration reaches that same table lock.
        const object = await trx.selectFrom('purchase_order_attachment_objects').select('id')
          .where('id', '=', objectId).forUpdate().executeTakeFirstOrThrow()
        objectLocked.open()
        await inspectReferences.promise
        expect(await trx.selectFrom('order_item_purchase_attachments').select('archive_object_id')
          .where('archive_object_id', '=', object.id).execute(), direction).toEqual([])
        await trx.updateTable('purchase_order_attachment_objects').set({ status: 'deleting' })
          .where('id', '=', object.id).execute()
      })
      const cleanerOutcome = cleaner.then(() => ({ error: undefined as unknown }), error => ({ error }))
      await objectLocked.promise
      const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
      const migration = direction === 'up'
        ? migrator.migrateToLatest()
        : db.transaction().execute(trx => purchaseSnapshotManifestR1Migration.down!(trx))
          .then(() => ({ error: undefined as unknown }), error => ({ error }))
      try {
        await expect.poll(async () => {
          const waiting = await sql<{ waiting: boolean }>`SELECT EXISTS (
            SELECT 1 FROM pg_locks WHERE relation = 'purchase_order_attachment_objects'::regclass
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND mode = 'AccessExclusiveLock' AND NOT granted
          ) AS waiting`.execute(db)
          return waiting.rows[0]?.waiting
        }, { timeout: 5_000 }).toBe(true)
        inspectReferences.open()
        const [cleanup, result] = await Promise.all([cleanerOutcome, migration])
        expect(cleanup.error, direction).toBeUndefined()
        if (direction === 'up') expect(result.error, direction).toBeUndefined()
        else expect(result.error, direction).toMatchObject({
          message: 'Cannot downgrade purchase snapshot gates while snapshots or archived objects exist',
        })
        expect(await db.selectFrom('purchase_order_attachment_objects').select('status')
          .where('id', '=', objectId).executeTakeFirstOrThrow(), direction).toEqual({ status: 'deleting' })
      } finally {
        inspectReferences.open()
        await Promise.allSettled([cleanerOutcome, migration])
      }
    }
  }, 60_000)
})
