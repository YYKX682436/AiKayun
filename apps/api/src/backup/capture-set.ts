import { lstat, readdir, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { readBackupDatabaseMetadata } from './database-metadata.js'
import type { readBackupKeyReferences } from './key-references.js'
import type { BackupPendingSummary } from './pending-summary.js'
import type { ReadonlyTrustBundleInspection } from '../licensing/trust/trust-bundle-store.js'
import { backupArtifacts, checksumBackupArtifacts, type BackupArtifact } from './manifest.js'
import { verifyStateArchivePair } from './state-archive-pair.js'
import { verifyDeploymentArchiveKeyRings } from './deployment-keyring-pair.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'

type Metadata = Awaited<ReturnType<typeof readBackupDatabaseMetadata>>
type Keys = Awaited<ReturnType<typeof readBackupKeyReferences>>
type Artifact = { size: number; sha256: string }
export interface CaptureSetEvidence {
  database: Metadata
  /** SHA-256 of the exact identity.json bytes verified against the DB binding. */
  identityFileSha256: string
  keys: Keys
  unresolved: BackupPendingSummary
  trustBundle: ReadonlyTrustBundleInspection
}
export interface CaptureSetOperations {
  /** Must prove both the deployment lock and ongoing absence of all writers. */
  assertFence(): Promise<void>
  /** Must prove staging is private memory-backed or encrypted storage. */
  assertSecureStaging(): Promise<void>
  /** Collects DB migrations/binding, source identity pairing, key references,
   * and pending transactions while fenced; never returns secret material. */
  readEvidence(): Promise<CaptureSetEvidence>
  captureDump(): Promise<Artifact & { pgDumpVersion: string }>
  /** Independently decodes the captured custom dump's binding and migrations. */
  verifyDumpBinding(metadata: Metadata): Promise<void>
  captureVolume(kind: 'state' | 'caddy-data' | 'caddy-config'): Promise<Artifact>
  captureDeployment(): Promise<Artifact>
}
export interface CaptureSetInput {
  backupSetId: string
  stagingDirectory: string
  tarBinary: string
  createdAt: string
  signal?: AbortSignal | undefined
  operations: CaptureSetOperations
}

/** An unpublished staging set. It is not a complete manifest or restic snapshot. */
export interface UnpublishedBackupSet {
  backupSetId: string
  createdAt: string
  quiescedAt: string
  evidence: CaptureSetEvidence
  pgDumpVersion: string
  artifacts: Record<BackupArtifact, Artifact>
}

/** Call only inside the coordinator's quiesced capture callback. Each capture
 * callback must write its fixed filename with create-exclusive semantics. */
export async function captureUnpublishedSet(input: CaptureSetInput): Promise<UnpublishedBackupSet> {
  const { stagingDirectory: root, operations: op } = input
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.backupSetId) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.createdAt) ||
      !Number.isFinite(Date.parse(input.createdAt)) || new Date(input.createdAt).toISOString() !== input.createdAt ||
      !isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root) throw new Error('BACKUP_SET_INPUT_INVALID')
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o777) !== 0o700 ||
      rootInfo.uid !== process.getuid?.()) throw new Error('BACKUP_SET_STAGING_INVALID')
  await op.assertSecureStaging()
  if ((await readdir(root)).length !== 0) throw new Error('BACKUP_SET_STAGING_NOT_EMPTY')
  const fence = async () => {
    if (input.signal?.aborted) throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED')
    try { await op.assertFence() } catch { throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED') }
  }
  let complete = false
  let failure: unknown
  let result: UnpublishedBackupSet | undefined
  try {
    await fence()
    const quiescedAt = new Date().toISOString()
    if (quiescedAt < input.createdAt) throw new Error('BACKUP_SET_TIME_INVALID')
    const evidence = await op.readEvidence()
    if (!/^[a-f0-9]{64}$/.test(evidence.identityFileSha256) || evidence.keys.contentVerification !== 'not_verified' ||
        !evidence.trustBundle || !['uninitialized', 'accepted'].includes(evidence.trustBundle.status)) throw new Error('BACKUP_SET_EVIDENCE_INVALID')
    const baseline = JSON.stringify(evidence)
    await fence()
    const dump = await op.captureDump()
    if (!/^18(?:\.\d+){0,2}$/.test(dump.pgDumpVersion)) throw new Error('BACKUP_SET_PGDUMP_VERSION_INVALID')
    await fence()
    await op.verifyDumpBinding(evidence.database)
    await fence()
    const state = await op.captureVolume('state')
    await fence()
    const deployment = await op.captureDeployment()
    await fence()
    const caddyData = await op.captureVolume('caddy-data')
    await fence()
    const caddyConfig = await op.captureVolume('caddy-config')
    await fence()
    await verifyStateArchivePair(root, input.tarBinary, evidence.database, evidence.identityFileSha256, input.signal)
    await fence()
    await verifyDeploymentArchiveKeyRings(root, input.tarBinary, evidence.keys, input.signal)
    await fence()
    const repeated = await op.readEvidence()
    if (JSON.stringify(repeated) !== baseline || JSON.stringify(evidence) !== baseline) throw new Error('BACKUP_SET_EVIDENCE_CHANGED')
    for (const name of backupArtifacts) {
      const stat = await lstat(join(root, name))
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('BACKUP_SET_ARTIFACT_UNSAFE')
    }
    const actual = await checksumBackupArtifacts(root, input.signal)
    const expected: Record<BackupArtifact, Artifact> = { 'database.dump': dump, 'state.tar': state, 'deployment.tar': deployment,
      'caddy-data.tar': caddyData, 'caddy-config.tar': caddyConfig }
    for (const name of backupArtifacts) {
      if (actual[name].size !== expected[name].size || actual[name].sha256 !== expected[name].sha256) throw new Error('BACKUP_SET_ARTIFACT_MISMATCH')
    }
    if ((await readdir(root)).sort().join(',') !== [...backupArtifacts].sort().join(',')) throw new Error('BACKUP_SET_STAGING_UNEXPECTED')
    await fence()
    result = { backupSetId: input.backupSetId, createdAt: input.createdAt, quiescedAt, evidence, pgDumpVersion: dump.pgDumpVersion, artifacts: actual }
    complete = true
  } catch (error) { failure = error }
  if (!complete) {
    // A lost writer fence or an unverified subprocess can still have an open
    // descriptor or unknown work in flight. Preserve every owned artifact for
    // explicit inspection; never unlink merely because the directory was empty.
    if (failure instanceof UnsafeMaintenanceRecoveryError) throw failure
    // Do not remove pre-existing or unrecognized data. This directory was empty
    // before capture; any unfamiliar entry makes cleanup unverifiable.
    try { await fence() } catch { throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED') }
    let unsafe = false
    try {
      const after = await lstat(root)
      if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== rootInfo.dev || after.ino !== rootInfo.ino || await realpath(root) !== root) throw new Error('unsafe')
      const names = await readdir(root)
      if (names.some(name => !backupArtifacts.includes(name as BackupArtifact))) throw new Error('unsafe')
      for (const name of names) {
        await fence()
        const stat = await lstat(join(root, name))
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error('unsafe')
        await unlink(join(root, name))
      }
    } catch { unsafe = true }
    if (unsafe) throw new UnsafeMaintenanceRecoveryError('SET_CLEANUP_UNVERIFIED')
    // If inspection of the writer fence is impossible, restoration is unsafe.
    try { await fence() } catch { throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED') }
    throw failure
  }
  if (!result) throw new Error('BACKUP_SET_CAPTURE_FAILED')
  return result
}
