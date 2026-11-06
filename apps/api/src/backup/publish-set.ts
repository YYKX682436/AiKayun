import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { backupArtifacts, validateBackupManifest, verifyBackupSet, type BackupManifest } from './manifest.js'
import { verifyStateArchivePair } from './state-archive-pair.js'
import { verifyDeploymentArchiveKeyRings } from './deployment-keyring-pair.js'
import { readMaintenanceJournal, type MaintenanceJournal } from './journal.js'
import { extractVerifiedBackup, removeExtractedBackup } from './read-only-extract.js'
import { LocalResticRepository, privateDirectory, within } from './restic-local.js'
import type { UnpublishedBackupSet } from './capture-set.js'
import type { readBackupDatabaseMetadata } from './database-metadata.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import { assertTrustBundleManifestMatch, inspectArchivedTrustStore, trustBundleManifestProjection } from './state-archive-trust.js'
import { verifyStateArchiveProtection } from './state-archive-protection.js'
import type { ReadonlyTrustBundleInspection } from '../licensing/trust/trust-bundle-store.js'

export interface PublishSetInput {
  staged: UnpublishedBackupSet
  stagingDirectory: string
  journalDirectory: string
  publicationDirectory: string
  scratchParent: string
  tarBinary: string
  releaseId: string
  images: BackupManifest['images']
  resticVersion: string
  repository: LocalResticRepository
  assertLock(): Promise<void>
  /** Lock and no detached writer are verified before scratch cleanup. */
  assertSafeCleanup(): Promise<void>
  signal?: AbortSignal | undefined
  /** Verifies journal deployment, actual original service/role state, and signed release metadata. */
  assertRestoredAndRelease(journal: MaintenanceJournal): Promise<void>
  /** Proves staging and scratch are memory-backed or encrypted. */
  assertSecureStorage(): Promise<void>
  /** Must parse the dump offline using the verified PG 18 helper and compare binding and migrations; never restore into production. */
  verifyDumpBinding(directory: string, metadata: Awaited<ReturnType<typeof readBackupDatabaseMetadata>>): Promise<void>
  inspectTrustStoreReadOnly?: ((directory: string) => Promise<ReadonlyTrustBundleInspection>) | undefined
}

async function verifyArchivedTrustStore(directory: string, inspectReadOnly: PublishSetInput['inspectTrustStoreReadOnly'],
  recorded: BackupManifest['trust_bundle']): Promise<void> {
  if (!inspectReadOnly) return
  const files = await verifyStateArchiveProtection(directory, 1000, true, 1000, true)
  if (!files) throw new Error('BACKUP_TRUST_STORE_INVALID')
  const inspection = await inspectArchivedTrustStore({ stagingDirectory: directory, files, inspectReadOnly })
  assertTrustBundleManifestMatch(inspection, recorded)
}

async function syncDirectory(path: string) {
  const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await dir.sync() } finally { await dir.close() }
}

/** Only authenticated, rechecked snapshots can be returned as verified. The
 * stored snapshot carries candidate status; ordinary readers must not present
 * it as complete without this publication record and a fresh full verification. */
export async function publishCapturedSet(input: PublishSetInput): Promise<{ snapshotId: string; status: 'verified' }> {
  const { staged } = input
  if (typeof input.assertSafeCleanup !== 'function' || typeof input.assertLock !== 'function') throw new Error('BACKUP_PUBLICATION_INVALID')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(staged.backupSetId)) throw new Error('BACKUP_PUBLICATION_INVALID')
  for (const path of [input.stagingDirectory, input.publicationDirectory, input.scratchParent, input.journalDirectory]) {
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('BACKUP_PUBLICATION_PATH_INVALID')
    await privateDirectory(path)
  }
  const dirs = [input.stagingDirectory, input.publicationDirectory, input.scratchParent, input.journalDirectory]
  for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
    if (within(dirs[i]!, dirs[j]!) || within(dirs[j]!, dirs[i]!)) throw new Error('BACKUP_PUBLICATION_PATH_INVALID')
  }
  await input.repository.assertSeparatedStorage(dirs)
  await input.assertSecureStorage()
  await input.assertLock()
  const journal = await readMaintenanceJournal(input.journalDirectory)
  if (!journal || journal.phase !== 'complete' || journal.backupSetId !== staged.backupSetId) throw new Error('BACKUP_MAINTENANCE_NOT_COMPLETE')
  await input.assertRestoredAndRelease(journal)
  const stageInfo = await lstat(input.stagingDirectory)
  const journalFile = join(input.publicationDirectory, `${staged.backupSetId}.json`)
  // A prior attempt, including a killed or uncertain upload, always blocks an
  // automatic retry of the same set. It must be inspected separately.
  try { await lstat(journalFile); throw new Error('BACKUP_PUBLICATION_ALREADY_ATTEMPTED') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if ((await readdir(input.stagingDirectory)).sort().join(',') !== [...backupArtifacts].sort().join(',')) throw new Error('BACKUP_STAGING_INVALID')
  const now = new Date().toISOString()
  const restarted = journal.services.some(item => item.running)
  const candidate: BackupManifest = { schema: 1, product: 'aikayun', status: 'candidate', backup_set_id: staged.backupSetId,
    created_at: staged.createdAt, quiesced_at: staged.quiescedAt,
    service_restoration: restarted ? 'restored' : 'not_needed', services_resumed_at: restarted ? journal.updatedAt : null,
    completed_at: now, release_id: input.releaseId, images: input.images,
    database: { id: staged.evidence.database.databaseId, schema_head: staged.evidence.database.migrationHead,
      migration_checksums_sha256: staged.evidence.database.migrationChecksumsSha256 },
    instance_identity_sha256: staged.evidence.identityFileSha256,
    binding: { instance_id: staged.evidence.database.instanceId, identity_jkt: staged.evidence.database.identityJkt,
      pending_key_sha256: staged.evidence.database.pendingKeySha256 },
    key_ids: { payment: staged.evidence.keys.paymentKeyIds, delivery: staged.evidence.keys.deliveryKeyIds,
      pending: staged.evidence.database.pendingKeyId },
    key_material_proofs: { payment_active: staged.evidence.keys.paymentActiveKeyId, delivery_active: staged.evidence.keys.deliveryActiveKeyId,
      payment: staged.evidence.keys.paymentKeyDigests, delivery: staged.evidence.keys.deliveryKeyDigests, ciphertext_verification: 'not_verified' },
    trust_bundle: trustBundleManifestProjection(staged.evidence.trustBundle),
    tools: { pg_dump: staged.pgDumpVersion, restic: input.resticVersion }, unresolved: staged.evidence.unresolved, artifacts: staged.artifacts }
  validateBackupManifest(candidate, true)
  let manifestOwned = false
  let snapshotId: string | undefined
  let result: { snapshotId: string; status: 'verified' } | undefined
  let failure: unknown
  try {
    const manifestFile = await open(join(input.stagingDirectory, 'manifest.json'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    manifestOwned = true
    try { await manifestFile.writeFile(`${JSON.stringify(candidate)}\n`); await manifestFile.sync() } finally { await manifestFile.close() }
    await syncDirectory(input.stagingDirectory)
    await verifyBackupSet(input.stagingDirectory, true, input.signal)
    await input.verifyDumpBinding(input.stagingDirectory, staged.evidence.database)
    await verifyStateArchivePair(input.stagingDirectory, input.tarBinary, staged.evidence.database, staged.evidence.identityFileSha256, input.signal)
    await verifyArchivedTrustStore(input.stagingDirectory, input.inspectTrustStoreReadOnly, candidate.trust_bundle)
    await verifyDeploymentArchiveKeyRings(input.stagingDirectory, input.tarBinary, staged.evidence.keys, input.signal)
    await input.assertLock()
    await input.assertRestoredAndRelease(journal)
    // The marker precedes the upload, making an interrupted or ambiguous write
    // visible and preventing an automatic duplicate upload under the same ID.
    const marker = await open(journalFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await marker.writeFile(`${JSON.stringify({ schema: 1, set: staged.backupSetId, state: 'uploading' })}\n`); await marker.sync() }
    finally { await marker.close() }
    await syncDirectory(input.publicationDirectory)
    snapshotId = await input.repository.backup(input.stagingDirectory, staged.backupSetId)
    await input.repository.check()
    const scratchName = `verify-${randomUUID()}`
    const checked = await extractVerifiedBackup(input.repository, staged.backupSetId, snapshotId,
      input.scratchParent, scratchName, Object.values(staged.artifacts).reduce((sum, item) => sum + item.size, 65536), true, input.assertSafeCleanup, input.signal)
    try {
      if (JSON.stringify(checked) !== JSON.stringify(candidate)) throw new Error('BACKUP_PUBLICATION_CHECK_FAILED')
      await input.verifyDumpBinding(join(input.scratchParent, scratchName), staged.evidence.database)
      await verifyStateArchivePair(join(input.scratchParent, scratchName), input.tarBinary, staged.evidence.database, staged.evidence.identityFileSha256, input.signal)
      await verifyArchivedTrustStore(join(input.scratchParent, scratchName), input.inspectTrustStoreReadOnly, candidate.trust_bundle)
      await verifyDeploymentArchiveKeyRings(join(input.scratchParent, scratchName), input.tarBinary, staged.evidence.keys, input.signal)
    } finally { await removeExtractedBackup(input.scratchParent, scratchName, input.assertSafeCleanup) }
    await input.assertLock()
    const current = await readMaintenanceJournal(input.journalDirectory)
    if (!current || JSON.stringify(current) !== JSON.stringify(journal)) throw new Error('BACKUP_MAINTENANCE_NOT_COMPLETE')
    await input.assertRestoredAndRelease(journal)
    result = { snapshotId, status: 'verified' }
  } catch (error) { failure = error }
  // Losing the lock or an uncertain helper leaves staging for inspection.
  // No automatic cleanup may run after the ownership proof is lost.
  if (failure instanceof UnsafeMaintenanceRecoveryError) throw failure
  try { await input.assertLock(); await input.assertSafeCleanup() } catch { throw new UnsafeMaintenanceRecoveryError('SET_CLEANUP_UNVERIFIED') }
  // Only unlink the exact owned staging files; never erase unknown entries.
  try {
    const after = await lstat(input.stagingDirectory)
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== stageInfo.dev || after.ino !== stageInfo.ino ||
        await realpath(input.stagingDirectory) !== input.stagingDirectory) throw new Error('unsafe')
    const names = await readdir(input.stagingDirectory)
    if (names.some(name => (name === 'manifest.json' && !manifestOwned) || (name !== 'manifest.json' && !backupArtifacts.includes(name as typeof backupArtifacts[number])))) throw new Error('unsafe')
    for (const name of names) {
      await input.assertLock()
      await input.assertSafeCleanup()
      const stat = await lstat(join(input.stagingDirectory, name))
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error('unsafe')
      await unlink(join(input.stagingDirectory, name))
    }
  } catch { throw new UnsafeMaintenanceRecoveryError('SET_CLEANUP_UNVERIFIED') }
  if (failure) throw new Error('BACKUP_PUBLICATION_INCOMPLETE_OR_UNKNOWN')
  if (!result) throw new Error('BACKUP_PUBLICATION_INCOMPLETE_OR_UNKNOWN')
  await input.assertLock()
  const current = await readMaintenanceJournal(input.journalDirectory)
  if (!current || JSON.stringify(current) !== JSON.stringify(journal)) throw new Error('BACKUP_MAINTENANCE_NOT_COMPLETE')
  await input.assertRestoredAndRelease(journal)
  const tmp = join(input.publicationDirectory, `.publication-${randomUUID()}.tmp`)
  try {
    const complete = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await complete.writeFile(`${JSON.stringify({ schema: 1, set: staged.backupSetId, state: 'verified', snapshot: result.snapshotId })}\n`); await complete.sync() }
    finally { await complete.close() }
    await input.assertLock()
    const original = await open(journalFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await original.stat()
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 1024 ||
          await original.readFile('utf8') !== `${JSON.stringify({ schema: 1, set: staged.backupSetId, state: 'uploading' })}\n`) {
        throw new Error('BACKUP_PUBLICATION_MARKER_CHANGED')
      }
    } finally { await original.close() }
    await rename(tmp, journalFile)
    await syncDirectory(input.publicationDirectory)
  } finally { await unlink(tmp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }) }
  return result
}

/** Read the local record only; its presence does not prove snapshot health. */
export async function readVerifiedPublicationRecord(directory: string, set: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(set)) throw new Error('BACKUP_PUBLICATION_INVALID')
  if (!isAbsolute(directory) || resolve(directory) !== directory || await realpath(directory) !== directory) throw new Error('BACKUP_PUBLICATION_PATH_INVALID')
  await privateDirectory(directory)
  const file = await open(join(directory, `${set}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let snapshotId: string
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 1024) throw new Error('BACKUP_PUBLICATION_NOT_VERIFIED')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) { const result = await file.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead }
    const after = await file.stat()
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('BACKUP_PUBLICATION_NOT_VERIFIED')
    const record: unknown = JSON.parse(bytes.subarray(0, offset).toString('utf8'))
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).sort().join(',') !== 'schema,set,snapshot,state' ||
        !('schema' in record) || record.schema !== 1 || !('set' in record) || record.set !== set ||
        !('state' in record) || record.state !== 'verified' || !('snapshot' in record) || typeof record.snapshot !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.snapshot)) throw new Error('BACKUP_PUBLICATION_NOT_VERIFIED')
    snapshotId = record.snapshot
  } finally { await file.close() }
  return snapshotId
}

/** A marker alone is never proof of a complete backup. The public verifier
 * must re-read the authenticated snapshot, hash every artifact and recheck
 * the archived identity and pending key before returning verified status. */
export async function verifyPublishedSnapshot(input: {
  backupSetId: string
  publicationDirectory: string
  scratchParent: string
  tarBinary: string
  repository: LocalResticRepository
  maxExtractBytes: number
  assertSecureStorage(): Promise<void>
  assertSafeCleanup(): Promise<void>
  signal?: AbortSignal | undefined
  assertAuthenticatedManifest?: ((manifest: BackupManifest) => Promise<void>) | undefined
  verifyDumpBinding: PublishSetInput['verifyDumpBinding']
  inspectTrustStoreReadOnly?: ((directory: string) => Promise<ReadonlyTrustBundleInspection>) | undefined
}): Promise<{ snapshotId: string; status: 'verified'; manifest: BackupManifest }> {
  if (typeof input.assertSafeCleanup !== 'function' || typeof input.assertSecureStorage !== 'function') throw new Error('BACKUP_PUBLICATION_INVALID')
  for (const path of [input.publicationDirectory, input.scratchParent]) {
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('BACKUP_PUBLICATION_PATH_INVALID')
    await privateDirectory(path)
  }
  if (within(input.publicationDirectory, input.scratchParent) || within(input.scratchParent, input.publicationDirectory)) throw new Error('BACKUP_PUBLICATION_PATH_INVALID')
  await input.repository.assertSeparatedStorage([input.publicationDirectory, input.scratchParent])
  await input.assertSecureStorage()
  const snapshotId = await readVerifiedPublicationRecord(input.publicationDirectory, input.backupSetId)
  await input.repository.check()
  const name = `verify-${randomUUID()}`
  const manifest = await extractVerifiedBackup(input.repository, input.backupSetId, snapshotId, input.scratchParent, name, input.maxExtractBytes, true, input.assertSafeCleanup, input.signal)
  try {
    if (manifest.status !== 'candidate') throw new Error('BACKUP_PUBLICATION_NOT_VERIFIED')
    if (input.assertAuthenticatedManifest) await input.assertAuthenticatedManifest(manifest)
    const directory = join(input.scratchParent, name)
    const metadata = {
      databaseId: manifest.database.id, instanceId: manifest.binding.instance_id, identityJkt: manifest.binding.identity_jkt,
      pendingKeyId: manifest.key_ids.pending, pendingKeySha256: manifest.binding.pending_key_sha256,
      migrationHead: manifest.database.schema_head, migrationChecksumsSha256: manifest.database.migration_checksums_sha256,
    }
    await input.verifyDumpBinding(directory, metadata)
    await verifyStateArchivePair(directory, input.tarBinary, metadata, manifest.instance_identity_sha256, input.signal)
    await verifyArchivedTrustStore(directory, input.inspectTrustStoreReadOnly, manifest.trust_bundle)
    await verifyDeploymentArchiveKeyRings(directory, input.tarBinary, {
      paymentKeyIds: manifest.key_ids.payment, deliveryKeyIds: manifest.key_ids.delivery,
      paymentReferencedKeyIds: [], deliveryReferencedKeyIds: [],
      paymentActiveKeyId: manifest.key_material_proofs.payment_active, deliveryActiveKeyId: manifest.key_material_proofs.delivery_active,
      paymentKeyDigests: manifest.key_material_proofs.payment, deliveryKeyDigests: manifest.key_material_proofs.delivery,
      contentVerification: 'not_verified',
    }, input.signal)
    return { snapshotId, status: 'verified', manifest }
  } finally { await removeExtractedBackup(input.scratchParent, name, input.assertSafeCleanup) }
}
