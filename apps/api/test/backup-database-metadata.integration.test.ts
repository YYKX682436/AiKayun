import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { Pool } from 'pg'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from '../src/db/types.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { readBackupDatabaseMetadata } from '../src/backup/database-metadata.js'
import { initializeInstallationIdentity } from '../src/licensing/installation-identity.js'

const url = process.env.TEST_DATABASE_URL
describe.skipIf(!url)('backup database metadata in isolated PostgreSQL', () => {
  let admin: Kysely<Database>
  let db: Kysely<Database>
  let schema: string
  let checksums: Buffer
  let release: { engine_major: number; migration_head: string; migration_checksums_sha256: string }
  let databaseId: string
  let instanceId: string
  let identityJkt: string
  let identityRoot: string
  let isolatedUrl: string
  const pendingKeyId = `lp-${'a'.repeat(32)}`
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('isolated test database required')
    admin = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }) })
    schema = `backup_metadata_${randomUUID().replaceAll('-', '')}`
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin)
    const isolated = new URL(url!)
    isolated.searchParams.set('options', `-csearch_path=${schema}`)
    isolatedUrl = isolated.toString()
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: isolatedUrl }) }) })
    const migration = await new Migrator({ db, provider: new AppMigrationProvider(), migrationTableSchema: schema }).migrateToLatest()
    if (migration.error) throw migration.error
    const names = Object.keys(await new AppMigrationProvider().getMigrations()).sort()
    // Synthetic checksum bytes: production separately verifies compiled bytes.
    checksums = Buffer.from(JSON.stringify({ schema: 1, migration_head: names.at(-1), migrations: names.map(name => ({ name, sha256: 'b'.repeat(64) })) }))
    release = { engine_major: 18, migration_head: names.at(-1)!, migration_checksums_sha256: createHash('sha256').update(checksums).digest('hex') }
  }, 60_000)
  afterAll(async () => {
    if (db) await db.destroy()
    if (admin && schema) await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin)
    if (admin) await admin.destroy()
    if (identityRoot) await rm(identityRoot, { recursive: true, force: true })
  })
  it('rejects a missing binding, then reads only validated public identifiers and pending-key binding', async () => {
    await expect(readBackupDatabaseMetadata(db, release, checksums, checksums)).rejects.toThrow('BACKUP_DATABASE_BINDING_INVALID')
    identityRoot = await mkdtemp(join(tmpdir(), 'aikayun-75a-meta-identity-'))
    const pool = new Pool({ connectionString: isolatedUrl })
    try { await initializeInstallationIdentity(pool, { identityRoot, mode: 'fresh' }) } finally { await pool.end() }
    await expect(readBackupDatabaseMetadata(db, release, checksums, checksums)).rejects.toThrow('BACKUP_DATABASE_BINDING_INVALID')
    await sql`UPDATE installation_binding SET pending_key_id = ${pendingKeyId}, pending_key_sha256 = ${'c'.repeat(64)} WHERE singleton`.execute(db)
    const row = (await sql<{ database_id: string; instance_id: string; identity_jkt: string }>`SELECT database_id::text, instance_id::text, identity_jkt FROM installation_binding`.execute(db)).rows[0]!
    databaseId = row.database_id
    instanceId = row.instance_id
    identityJkt = row.identity_jkt
    expect(await readBackupDatabaseMetadata(db, release, checksums, checksums)).toEqual({ databaseId, instanceId,
      identityJkt, pendingKeyId, pendingKeySha256: 'c'.repeat(64),
      migrationHead: release.migration_head, migrationChecksumsSha256: release.migration_checksums_sha256 })
  })
  it('rejects changed signed checksums, head, compiled checksums and actual database migration state', async () => {
    await expect(readBackupDatabaseMetadata(db, release, Buffer.from('changed'), checksums)).rejects.toThrow('BACKUP_MIGRATION_CHECKSUM_MISMATCH')
    await expect(readBackupDatabaseMetadata(db, release, checksums, Buffer.from('changed'))).rejects.toThrow('BACKUP_MIGRATION_CHECKSUM_MISMATCH')
    await expect(readBackupDatabaseMetadata(db, { ...release, migration_head: '202611030001_admin_setup_state' }, checksums, checksums)).rejects.toThrow('BACKUP_MIGRATION_MANIFEST_INVALID')
    await sql`UPDATE kysely_migration SET name = ${`${release.migration_head}_changed`} WHERE name = ${release.migration_head}`.execute(db)
    try { await expect(readBackupDatabaseMetadata(db, release, checksums, checksums)).rejects.toThrow('BACKUP_DATABASE_MIGRATIONS_MISMATCH') }
    finally { await sql`UPDATE kysely_migration SET name = ${release.migration_head} WHERE name = ${`${release.migration_head}_changed`}`.execute(db) }
    expect((await readBackupDatabaseMetadata(db, release, checksums, checksums)).databaseId).toBe(databaseId)
  })
})
