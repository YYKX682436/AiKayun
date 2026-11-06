import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { Pool } from 'pg'
import type { Database } from '../src/db/types.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { initializeInstallationIdentity } from '../src/licensing/installation-identity.js'
import { initializeTemporaryLicensePendingKey, loadLicensePendingKey } from '../src/licensing/pending-encryption-key.js'
import { verifyBackupIdentityPair } from '../src/backup/identity-pair.js'

const url = process.env.TEST_DATABASE_URL
describe.skipIf(!url)('backup identity and pending key pairing', () => {
  let admin: Kysely<Database>
  let db: Kysely<Database>
  let schema: string
  let identityRoot: string
  let pendingRoot: string
  let expected: Parameters<typeof verifyBackupIdentityPair>[3]
  let privatePath: string
  let pendingPath: string
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('isolated test database required')
    admin = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }) })
    schema = `backup_pair_${randomUUID().replaceAll('-', '')}`
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin)
    const isolated = new URL(url!)
    isolated.searchParams.set('options', `-csearch_path=${schema}`)
    const isolatedUrl = isolated.toString()
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: isolatedUrl }) }) })
    const migration = await new Migrator({ db, provider: new AppMigrationProvider(), migrationTableSchema: schema }).migrateToLatest()
    if (migration.error) throw migration.error
    identityRoot = await mkdtemp(join(tmpdir(), 'aikayun-75a-identity-'))
    pendingRoot = await mkdtemp(join(tmpdir(), 'aikayun-75a-pending-'))
    const pool = new Pool({ connectionString: isolatedUrl })
    try { await initializeInstallationIdentity(pool, { identityRoot, mode: 'fresh' }) } finally { await pool.end() }
    await initializeTemporaryLicensePendingKey(pendingRoot, 'test')
    const key = await loadLicensePendingKey(pendingRoot)
    const pendingKeySha256 = createHash('sha256').update(key.key).digest('hex')
    key.key.fill(0)
    await sql`UPDATE installation_binding SET pending_key_id = ${key.keyId}, pending_key_sha256 = ${pendingKeySha256} WHERE singleton`.execute(db)
    const binding = (await sql<{ database_id: string; instance_id: string; identity_jkt: string }>`
      SELECT database_id::text, instance_id::text, identity_jkt FROM installation_binding WHERE singleton
    `.execute(db)).rows[0]!
    expected = { databaseId: binding.database_id, instanceId: binding.instance_id, identityJkt: binding.identity_jkt,
      pendingKeyId: key.keyId, pendingKeySha256, migrationHead: 'fixture', migrationChecksumsSha256: 'a'.repeat(64) }
    privatePath = join(identityRoot, 'current', 'instance-private-key.pk8.pem')
    pendingPath = join(pendingRoot, 'license-pending-aes-256-gcm.json')
  }, 60_000)
  afterAll(async () => {
    if (db) await db.destroy()
    if (admin && schema) await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin)
    if (admin) await admin.destroy()
    if (identityRoot) await rm(identityRoot, { recursive: true, force: true })
    if (pendingRoot) await rm(pendingRoot, { recursive: true, force: true })
  })
  it('verifies pairing without changing the stored key files or binding', async () => {
    const watermark = join(pendingRoot, 'license-time-watermark.json')
    await writeFile(watermark, 'fixture-watermark-preserved', { mode: 0o600 })
    const beforeKey = await readFile(pendingPath)
    const beforeIdentity = await readFile(privatePath)
    const beforeDb = await sql`SELECT row_to_json(binding) AS value FROM installation_binding binding`.execute(db)
    const beforeEntries = await readdir(pendingRoot)
    const identityBytes = await readFile(join(identityRoot, 'current', 'identity.json'))
    await expect(verifyBackupIdentityPair(db, identityRoot, pendingRoot, expected)).resolves.toEqual({ identityFileSha256: createHash('sha256').update(identityBytes).digest('hex') })
    expect(await readFile(pendingPath)).toEqual(beforeKey)
    expect(await readFile(privatePath)).toEqual(beforeIdentity)
    expect(await readFile(watermark, 'utf8')).toBe('fixture-watermark-preserved')
    expect(await readdir(pendingRoot)).toEqual(beforeEntries)
    expect((await sql`SELECT row_to_json(binding) AS value FROM installation_binding binding`.execute(db)).rows).toEqual(beforeDb.rows)
    await expect(verifyBackupIdentityPair(db, identityRoot, pendingRoot, { ...expected, databaseId: randomUUID() })).rejects.toThrow('BACKUP_IDENTITY_BINDING_MISMATCH')
    await rm(watermark)
  })
  it('rejects missing, replaced, or staged pending key without repairing it', async () => {
    const original = await readFile(pendingPath)
    try {
      await rm(pendingPath)
      await expect(verifyBackupIdentityPair(db, identityRoot, pendingRoot, expected)).rejects.toThrow()
      expect(await readdir(pendingRoot)).toEqual([])
      const value = JSON.parse(original.toString('utf8')) as Record<string, unknown>
      value.key = randomBytes(32).toString('base64url')
      const replaced = Buffer.from(JSON.stringify(value))
      await writeFile(pendingPath, replaced, { mode: 0o600 })
      await expect(verifyBackupIdentityPair(db, identityRoot, pendingRoot, expected)).rejects.toThrow('BACKUP_PENDING_BINDING_MISMATCH')
      expect(await readFile(pendingPath)).toEqual(replaced)
      await writeFile(pendingPath, original)
      const staged = join(pendingRoot, `.pending-key-${randomUUID()}.tmp`)
      await writeFile(staged, 'fixture', { mode: 0o600 })
      await expect(verifyBackupIdentityPair(db, identityRoot, pendingRoot, expected)).rejects.toThrow('BACKUP_PENDING_STAGING_PRESENT')
      expect(await readFile(staged, 'utf8')).toBe('fixture')
      await rm(staged)
    } finally { await writeFile(pendingPath, original, { mode: 0o600 }) }
  })
  it('rejects missing or replaced identity private keys without recreating them', async () => {
    const original = await readFile(privatePath)
    try {
      await rm(privatePath)
      await expect(verifyBackupIdentityPair(db, identityRoot, pendingRoot, expected)).rejects.toThrow()
      expect((await readdir(join(identityRoot, 'current'))).includes('instance-private-key.pk8.pem')).toBe(false)
      const replacement = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
      await writeFile(privatePath, replacement, { mode: 0o600 })
      await expect(verifyBackupIdentityPair(db, identityRoot, pendingRoot, expected)).rejects.toThrow()
      expect(await readFile(privatePath, 'utf8')).toBe(replacement)
    } finally { await writeFile(privatePath, original, { mode: 0o600 }) }
    await expect(verifyBackupIdentityPair(db, identityRoot, pendingRoot, expected)).resolves.toHaveProperty('identityFileSha256')
  })
})
