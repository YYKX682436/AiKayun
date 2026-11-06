import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { CaptureSetEvidence } from './capture-set.js'
import type { ReadonlyTrustBundleInspection } from '../licensing/trust/trust-bundle-store.js'
import type { readBackupDatabaseMetadata } from './database-metadata.js'
import type { readBackupKeyReferences } from './key-references.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'

type Database = Awaited<ReturnType<typeof readBackupDatabaseMetadata>>
type Keys = Awaited<ReturnType<typeof readBackupKeyReferences>>
type Dump = { size: number; sha256: string; pgDumpVersion: string }

export interface DirectCaptureSetOperations {
  assertFence(): Promise<void>
  assertSecureStaging(): Promise<void>
  readDatabaseEvidence(): Promise<{ database: Database; keys: Keys; unresolved: CaptureSetEvidence['unresolved'] }>
  captureDump(): Promise<Dump>
  verifyDumpBinding(metadata: Database): Promise<void>
  captureSourceSnapshot(backupSetId: string): Promise<string>
  inspectSourceSnapshot(input: { snapshot: string; dump: Dump; database: Database; keys: Keys }): Promise<{
    identityFileSha256: string; trustBundle: ReadonlyTrustBundleInspection
  }>
}

export interface DirectUnpublishedBackupSet {
  backupSetId: string
  createdAt: string
  quiescedAt: string
  sourceSnapshotId: string
  evidence: CaptureSetEvidence
  pgDumpVersion: string
  databaseDump: { size: number; sha256: string }
}

/** Capture the DB dump and raw source snapshot under the coordinator's writer
 * fence. No tar archive stands in for the state, deployment or Caddy volumes. */
export async function captureDirectUnpublishedSet(input: {
  backupSetId: string
  stagingDirectory: string
  createdAt: string
  operations: DirectCaptureSetOperations
  signal?: AbortSignal
}): Promise<DirectUnpublishedBackupSet> {
  const { stagingDirectory: root, operations: op } = input
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.backupSetId) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.createdAt) ||
      !Number.isFinite(Date.parse(input.createdAt)) || new Date(input.createdAt).toISOString() !== input.createdAt ||
      !isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root) throw new Error('BACKUP_SET_INPUT_INVALID')
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o777) !== 0o700 || rootInfo.uid !== process.getuid?.() ||
      (await readdir(root)).length !== 0) throw new Error('BACKUP_SET_STAGING_INVALID')
  const fence = async () => {
    if (input.signal?.aborted) throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED')
    try { await op.assertFence(); await op.assertSecureStaging() }
    catch { throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED') }
  }
  await fence()
  const quiescedAt = new Date().toISOString()
  if (quiescedAt < input.createdAt) throw new Error('BACKUP_SET_TIME_INVALID')
  const before = await op.readDatabaseEvidence()
  await fence()
  const dump = await op.captureDump()
  if (!Number.isSafeInteger(dump.size) || dump.size < 1 || !/^[a-f0-9]{64}$/.test(dump.sha256) || !/^18(?:\.\d+){0,2}$/.test(dump.pgDumpVersion)) {
    throw new Error('BACKUP_SET_DUMP_INVALID')
  }
  await fence()
  const dumpPath = join(root, 'database.dump')
  const dumpInfo = await lstat(dumpPath)
  if (!dumpInfo.isFile() || dumpInfo.isSymbolicLink() || dumpInfo.nlink !== 1 || dumpInfo.uid !== process.getuid?.() ||
      (dumpInfo.mode & 0o777) !== 0o600 || dumpInfo.size !== dump.size) throw new Error('BACKUP_SET_DUMP_INVALID')
  await op.verifyDumpBinding(before.database)
  await fence()
  const sourceSnapshotId = await op.captureSourceSnapshot(input.backupSetId)
  if (!/^[a-f0-9]{64}$/.test(sourceSnapshotId)) throw new Error('BACKUP_SOURCE_SNAPSHOT_INVALID')
  await fence()
  const direct = await op.inspectSourceSnapshot({ snapshot: sourceSnapshotId, dump, database: before.database, keys: before.keys })
  if (!/^[a-f0-9]{64}$/.test(direct.identityFileSha256) || !direct.trustBundle ||
      !['accepted', 'uninitialized'].includes(direct.trustBundle.status)) throw new Error('BACKUP_SET_EVIDENCE_INVALID')
  const after = await op.readDatabaseEvidence()
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('BACKUP_SET_EVIDENCE_CHANGED')
  await fence()
  if ((await readdir(root)).sort().join(',') !== 'database.dump') throw new Error('BACKUP_SET_STAGING_UNEXPECTED')
  const finalDump = await lstat(dumpPath)
  if (finalDump.dev !== dumpInfo.dev || finalDump.ino !== dumpInfo.ino || finalDump.size !== dumpInfo.size ||
      finalDump.mtimeMs !== dumpInfo.mtimeMs || finalDump.ctimeMs !== dumpInfo.ctimeMs) throw new Error('BACKUP_SET_DUMP_CHANGED')
  return { backupSetId: input.backupSetId, createdAt: input.createdAt, quiescedAt, sourceSnapshotId,
    evidence: { ...before, identityFileSha256: direct.identityFileSha256, trustBundle: direct.trustBundle },
    pgDumpVersion: dump.pgDumpVersion, databaseDump: { size: dump.size, sha256: dump.sha256 } }
}
