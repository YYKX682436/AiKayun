import { createHash, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import { verifyInstallationIdentityInTransaction } from '../licensing/installation-identity.js'
import { loadLicensePendingKey } from '../licensing/pending-encryption-key.js'
import type { readBackupDatabaseMetadata } from './database-metadata.js'

type ExpectedMetadata = Awaited<ReturnType<typeof readBackupDatabaseMetadata>>

/** Strictly read-only: never uses the production pending-key verifier because
 * that verifier can repair/remove interrupted staging files. Caller must hold
 * the writer fence and supply metadata from the same quiescent set. */
export async function verifyBackupIdentityPair(db: Kysely<Database>, identityRoot: string, pendingRoot: string,
  expected: ExpectedMetadata, forbiddenRoots: string[] = []): Promise<{ identityFileSha256: string }> {
  return db.transaction().execute(async tx => {
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.execute(tx)
    const identity = await verifyInstallationIdentityInTransaction(tx, identityRoot)
    if (identity.databaseId !== expected.databaseId || identity.instanceId !== expected.instanceId ||
        identity.identityJkt !== expected.identityJkt) throw new Error('BACKUP_IDENTITY_BINDING_MISMATCH')
    const result = await sql<{ pending_key_id: string | null; pending_key_sha256: string | null }>`
      SELECT pending_key_id, pending_key_sha256 FROM installation_binding WHERE singleton = true
    `.execute(tx)
    const bound = result.rows[0]
    if (result.rows.length !== 1 || !bound?.pending_key_id || !bound.pending_key_sha256 ||
        bound.pending_key_id !== expected.pendingKeyId || bound.pending_key_sha256 !== expected.pendingKeySha256 ||
        !/^[a-f0-9]{64}$/.test(bound.pending_key_sha256)) throw new Error('BACKUP_PENDING_BINDING_MISMATCH')
    const names = await readdir(pendingRoot)
    if (names.some(name => /^\.pending-key-.*\.tmp$/.test(name))) throw new Error('BACKUP_PENDING_STAGING_PRESENT')
    const key = await loadLicensePendingKey(pendingRoot, [identityRoot, ...forbiddenRoots])
    try {
      const actual = createHash('sha256').update(key.key).digest()
      const expectedDigest = Buffer.from(bound.pending_key_sha256, 'hex')
      if (key.keyId !== bound.pending_key_id || !timingSafeEqual(actual, expectedDigest)) throw new Error('BACKUP_PENDING_BINDING_MISMATCH')
    } finally { key.key.fill(0) }
    const path = join(identityRoot, 'current', 'identity.json')
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > 16384 ||
        (before.mode & 0o777) !== 0o600 || before.uid !== process.getuid?.()) throw new Error('BACKUP_IDENTITY_FILE_INVALID')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await file.stat()
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw new Error('BACKUP_IDENTITY_FILE_INVALID')
      const bytes = Buffer.alloc(opened.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      const after = await file.stat()
      if (offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('BACKUP_IDENTITY_FILE_INVALID')
      const value: unknown = JSON.parse(bytes.subarray(0, offset).toString('utf8'))
      if (!value || typeof value !== 'object' || !('database_id' in value) || !('instance_id' in value) || !('identity_jkt' in value) ||
          value.database_id !== identity.databaseId || value.instance_id !== identity.instanceId || value.identity_jkt !== identity.identityJkt) throw new Error('BACKUP_IDENTITY_BINDING_MISMATCH')
      return { identityFileSha256: createHash('sha256').update(bytes.subarray(0, offset)).digest('hex') }
    } finally { await file.close() }
  })
}
