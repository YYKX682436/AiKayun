import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { AppMigrationProvider } from '../db/migration-provider.js'
import type { Database } from '../db/types.js'

export interface VerifiedReleaseDatabase {
  engine_major: number
  migration_head: string
  migration_checksums_sha256: string
}

/** Caller authenticates the release manifest and both checksum files before
 * invoking this function, and holds the maintenance writer fence. Registry
 * verification additionally checks compiled migration bytes in production. */
export async function readBackupDatabaseMetadata(db: Kysely<Database>, release: VerifiedReleaseDatabase,
  signedChecksums: Uint8Array, compiledChecksums: Uint8Array) {
  if (signedChecksums.byteLength > 1024 * 1024 || compiledChecksums.byteLength > 1024 * 1024) throw new Error('BACKUP_MIGRATION_CHECKSUM_MISMATCH')
  const digest = createHash('sha256').update(signedChecksums).digest('hex')
  if (release.engine_major !== 18 || !/^[a-f0-9]{64}$/.test(release.migration_checksums_sha256) ||
      digest !== release.migration_checksums_sha256 ||
      !Buffer.from(signedChecksums).equals(Buffer.from(compiledChecksums))) {
    throw new Error('BACKUP_MIGRATION_CHECKSUM_MISMATCH')
  }
  let manifest: unknown
  try { manifest = JSON.parse(Buffer.from(signedChecksums).toString('utf8')) as unknown }
  catch { throw new Error('BACKUP_MIGRATION_MANIFEST_INVALID') }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('BACKUP_MIGRATION_MANIFEST_INVALID')
  const record = manifest as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'migration_head,migrations,schema' || record.schema !== 1 ||
      record.migration_head !== release.migration_head || !Array.isArray(record.migrations) || record.migrations.length === 0) {
    throw new Error('BACKUP_MIGRATION_MANIFEST_INVALID')
  }
  const names: string[] = []
  for (const entry of record.migrations) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).sort().join(',') !== 'name,sha256' ||
        typeof entry.name !== 'string' || !/^\d{12}_[A-Za-z0-9_-]+$/.test(entry.name) ||
        typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        (names.length && names[names.length - 1]! >= entry.name)) throw new Error('BACKUP_MIGRATION_MANIFEST_INVALID')
    names.push(entry.name)
  }
  const compiledNames = Object.keys(await new AppMigrationProvider().getMigrations()).sort()
  if (names.at(-1) !== release.migration_head || names.length !== compiledNames.length ||
      names.some((name, index) => name !== compiledNames[index])) throw new Error('BACKUP_MIGRATION_REGISTRY_MISMATCH')
  return db.transaction().execute(async tx => {
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.execute(tx)
    const server = await sql<{ major: number }>`SELECT current_setting('server_version_num')::int / 10000 AS major`.execute(tx)
    if (server.rows[0]?.major !== 18) throw new Error('BACKUP_POSTGRES_VERSION_MISMATCH')
    const applied = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(tx)
    if (applied.rows.length !== names.length || applied.rows.some((row, index) => row.name !== names[index])) {
      throw new Error('BACKUP_DATABASE_MIGRATIONS_MISMATCH')
    }
    const binding = await sql<{ database_id: string; instance_id: string; identity_jkt: string; binding_state: string;
      pending_key_id: string | null; pending_key_sha256: string | null }>`
      SELECT database_id::text, instance_id::text, identity_jkt, binding_state, pending_key_id, pending_key_sha256
      FROM installation_binding WHERE singleton = true
    `.execute(tx)
    const row = binding.rows[0]
    if (binding.rows.length !== 1 || !row || row.binding_state !== 'ready' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.database_id) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.instance_id) ||
        !/^[A-Za-z0-9_-]{43}$/.test(row.identity_jkt) || !row.pending_key_id || !/^lp-[a-f0-9]{32}$/.test(row.pending_key_id) ||
        !row.pending_key_sha256 || !/^[a-f0-9]{64}$/.test(row.pending_key_sha256)) throw new Error('BACKUP_DATABASE_BINDING_INVALID')
    return { databaseId: row.database_id, instanceId: row.instance_id, identityJkt: row.identity_jkt,
      pendingKeyId: row.pending_key_id, pendingKeySha256: row.pending_key_sha256,
      migrationHead: release.migration_head, migrationChecksumsSha256: digest }
  })
}
