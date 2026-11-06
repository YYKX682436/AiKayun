import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { Pool } from 'pg'
import type { Database } from '../src/db/types.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { readConfig } from '../src/config.js'
import { decryptPaymentConfig, encryptPaymentConfig } from '../src/payments/credentials.js'
import { assertPendingKeyReferences, readBackupKeyReferences } from '../src/backup/key-references.js'

const url = process.env.TEST_DATABASE_URL
describe.skipIf(!url)('backup historical key references', () => {
  let admin: Kysely<Database>
  let db: Kysely<Database>
  let schema: string
  let root: string
  let paymentFile: string
  let deliveryFile: string
  const oldPayment = randomBytes(32).toString('base64')
  const newPayment = randomBytes(32).toString('base64')
  const oldDelivery = randomBytes(32).toString('base64')
  const newDelivery = randomBytes(32).toString('base64')
  const config = () => readConfig({ NODE_ENV: 'test', PAYMENT_CREDENTIAL_KEY_RING_FILE: paymentFile, CODE_POOL_ENCRYPTION_KEY_RING_FILE: deliveryFile })
  const putRing = (path: string, keys: Record<string, string>) => writeFile(path, JSON.stringify({ activeKeyId: 'current', keys }), { mode: 0o600 })
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('isolated test database required')
    admin = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }) })
    schema = `backup_keys_${randomUUID().replaceAll('-', '')}`
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin)
    const isolated = new URL(url!)
    isolated.searchParams.set('options', `-csearch_path=${schema}`)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: isolated.toString() }) }) })
    const result = await new Migrator({ db, provider: new AppMigrationProvider(), migrationTableSchema: schema }).migrateToLatest()
    if (result.error) throw result.error
    root = await mkdtemp(join(tmpdir(), 'aikayun-75a-keyring-'))
    paymentFile = join(root, 'payment')
    deliveryFile = join(root, 'delivery')
    await putRing(paymentFile, { current: newPayment, history: oldPayment })
    await putRing(deliveryFile, { current: newDelivery, history: oldDelivery })
  }, 60_000)
  afterAll(async () => {
    if (db) await db.destroy()
    if (admin && schema) await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin)
    if (admin) await admin.destroy()
    if (root) await rm(root, { recursive: true, force: true })
  })
  it('rejects missing historical references and malformed ring files without claiming decryption', async () => {
    const original = config()
    const secret = Buffer.from('private-fixture-content')
    const envelope = encryptPaymentConfig(original, 'fixture-only', secret, 'history')
    const actor = randomUUID()
    const product = randomUUID()
    const variant = randomUUID()
    await sql`INSERT INTO admin_users (id, email, password_hash) VALUES (${actor}::uuid, ${`${actor}@example.invalid`}, 'fixture')`.execute(db)
    await db.transaction().execute(async tx => {
      await sql`SELECT set_config('aikayun.admin_id', ${actor}, true)`.execute(tx)
      await sql`INSERT INTO payment_channels (id, provider_type, name, config_ciphertext, config_nonce, config_auth_tag, config_key_id, credential_version, created_by_admin_id, updated_by_admin_id)
        VALUES (${randomUUID()}::uuid, 'zpay_epay_v1', 'fixture', ${envelope.ciphertext}, ${envelope.nonce}, ${envelope.authTag}, ${envelope.keyId}, 1, ${actor}::uuid, ${actor}::uuid)`.execute(tx)
      await sql`INSERT INTO products (id, name, product_type, status) VALUES (${product}::uuid, 'fixture', 'digital', 'draft')`.execute(tx)
      await sql`INSERT INTO product_variants (id, product_id, sku_code, combination_key, sale_price) VALUES (${variant}::uuid, ${product}::uuid, ${randomUUID()}, '', 1)`.execute(tx)
      await sql`INSERT INTO product_variant_fulfillment_versions (id, product_variant_id, version_number, method, encrypted_content, content_nonce, content_auth_tag, encryption_key_id, content_sha256, created_by_admin_id)
        VALUES (${randomUUID()}::uuid, ${variant}::uuid, 1, 'fixed_content', decode('01','hex'), decode(repeat('00',12),'hex'), decode(repeat('00',16),'hex'), 'history', ${'a'.repeat(64)}, ${actor}::uuid)`.execute(tx)
    })
    const verified = await readBackupKeyReferences(db, original.paymentCredentialKeyRing, original.codePoolEncryptionKeyRing)
    expect(verified).toMatchObject({ paymentKeyIds: ['current', 'history'], deliveryKeyIds: ['current', 'history'],
      paymentReferencedKeyIds: ['history'], deliveryReferencedKeyIds: ['history'], paymentActiveKeyId: 'current', deliveryActiveKeyId: 'current', contentVerification: 'not_verified' })
    expect(JSON.stringify(verified)).not.toContain(secret.toString())
    await putRing(paymentFile, { current: newPayment })
    const noPaymentHistory = config()
    await expect(readBackupKeyReferences(db, noPaymentHistory.paymentCredentialKeyRing, noPaymentHistory.codePoolEncryptionKeyRing)).rejects.toThrow('BACKUP_HISTORICAL_KEY_MISSING')
    await putRing(paymentFile, { current: newPayment, history: oldPayment })
    await putRing(deliveryFile, { current: newDelivery })
    const noDeliveryHistory = config()
    await expect(readBackupKeyReferences(db, noDeliveryHistory.paymentCredentialKeyRing, noDeliveryHistory.codePoolEncryptionKeyRing)).rejects.toThrow('BACKUP_HISTORICAL_KEY_MISSING')
    await writeFile(deliveryFile, '{broken', { mode: 0o600 })
    expect(config).toThrow('CODE_POOL_ENCRYPTION_KEY_RING must be valid JSON')
    await putRing(deliveryFile, { current: newDelivery, history: oldDelivery })
    await putRing(paymentFile, { current: newPayment, history: randomBytes(32).toString('base64') })
    const wrongMaterial = config()
    expect((await readBackupKeyReferences(db, wrongMaterial.paymentCredentialKeyRing, wrongMaterial.codePoolEncryptionKeyRing)).contentVerification).toBe('not_verified')
    expect(() => decryptPaymentConfig(wrongMaterial, 'fixture-only', envelope)).toThrow()
  })
  it('rejects historical licensing payload and request key IDs outside the bound Pending Key', async () => {
    const key = `lp-${'a'.repeat(32)}`, other = `lp-${'b'.repeat(32)}`
    const operationId = randomUUID(), digest = 'a'.repeat(43)
    const operation = async (tx: typeof db, payloadKey: string) => sql`INSERT INTO local_license_operations
      (operation_id, kind, intent_digest, license_id, database_id, instance_id, identity_jkt, payload_key_id, encrypted_intent_payload)
      VALUES (${operationId}::uuid, 'activation', ${digest}, ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        ${digest}, ${payloadKey}, decode('01','hex'))`.execute(tx)
    await expect(assertPendingKeyReferences(db, 'invalid')).rejects.toThrow('BACKUP_PENDING_KEY_REFERENCE_INVALID')
    await assertPendingKeyReferences(db, key)
    await expect(db.transaction().execute(async tx => {
      await operation(tx, other)
      await expect(assertPendingKeyReferences(tx, key)).rejects.toThrow('BACKUP_PENDING_HISTORICAL_KEY_MISSING')
      throw new Error('rollback fixture')
    })).rejects.toThrow('rollback fixture')
    await expect(db.transaction().execute(async tx => {
      await operation(tx, key)
      await assertPendingKeyReferences(tx, key)
      await sql`INSERT INTO local_license_operation_attempts
        (operation_id, attempt_no, purpose, intent_digest, client_nonce_hash, request_nonce_hash, request_body_digest,
         identity_jkt, signing_key_id, signature_created_at, request_key_id, encrypted_request_envelope)
        VALUES (${operationId}::uuid, 1, 'activation', ${digest}, ${digest}, ${digest}, ${digest}, ${digest},
          'fixture', clock_timestamp(), ${other}, decode('01','hex'))`.execute(tx)
      await expect(assertPendingKeyReferences(tx, key)).rejects.toThrow('BACKUP_PENDING_HISTORICAL_KEY_MISSING')
      throw new Error('rollback fixture')
    })).rejects.toThrow('rollback fixture')
    await assertPendingKeyReferences(db, key)
  })
  it('checks every Pending Key reference field using isolated PostgreSQL temporary tables', async () => {
    const key = `lp-${'a'.repeat(32)}`, other = `lp-${'b'.repeat(32)}`
    await db.transaction().execute(async tx => {
      await sql`CREATE TEMP TABLE local_license_operations (payload_key_id text, center_evidence_key_id text) ON COMMIT DROP`.execute(tx)
      await sql`CREATE TEMP TABLE local_license_operation_attempts (request_key_id text, response_key_id text, result_key_id text) ON COMMIT DROP`.execute(tx)
      await sql`CREATE TEMP TABLE instance_license_state (credential_encryption_key_id text, refusal_encryption_key_id text) ON COMMIT DROP`.execute(tx)
      for (const [table, column] of [
        ['local_license_operations', 'payload_key_id'], ['local_license_operations', 'center_evidence_key_id'],
        ['local_license_operation_attempts', 'request_key_id'], ['local_license_operation_attempts', 'response_key_id'],
        ['local_license_operation_attempts', 'result_key_id'], ['instance_license_state', 'credential_encryption_key_id'],
        ['instance_license_state', 'refusal_encryption_key_id'],
      ] as const) {
        await sql`INSERT INTO ${sql.table(table)} (${sql.ref(column)}) VALUES (${other})`.execute(tx)
        await expect(assertPendingKeyReferences(tx, key)).rejects.toThrow('BACKUP_PENDING_HISTORICAL_KEY_MISSING')
        await sql`UPDATE ${sql.table(table)} SET ${sql.ref(column)} = ${key}`.execute(tx)
        await assertPendingKeyReferences(tx, key)
        await sql`DELETE FROM ${sql.table(table)}`.execute(tx)
      }
    })
  })
})
