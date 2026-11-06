import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import { readMaintenanceJournal, type MaintenanceJournal } from './journal.js'
import { privateDirectory, within, type LocalResticRepository } from './restic-local.js'
import { validateDirectBackupManifest, type DirectBackupManifest, type BackupManifest } from './manifest.js'
import { readSnapshotFile, verifyDirectSourceSnapshot } from './direct-source-inspection.js'
import { assertTrustBundleManifestMatch, trustBundleManifestProjection } from './state-archive-trust.js'
import type { DirectUnpublishedBackupSet } from './direct-capture-set.js'
import type { readBackupKeyReferences } from './key-references.js'
import type { ReadonlyTrustBundleInspection } from '../licensing/trust/trust-bundle-store.js'

type KeyReferences = Awaited<ReturnType<typeof readBackupKeyReferences>>
type PublicationRecord = { schema: 2; set: string; state: 'uploading' | 'verified'; source_snapshot: string; manifest_snapshot?: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const digest = /^[a-f0-9]{64}$/
const setTag = (set: string) => `aikayun-set-${set}`
const roleTag = (role: 'source' | 'manifest') => `aikayun-role-${role}`

function safePublicationFailureReason(error: unknown): string {
  if (error && typeof error === 'object' && 'operationCode' in error && typeof error.operationCode === 'string' &&
      /^RESTIC_[A-Z_]{1,32}_FAILED$/.test(error.operationCode)) return error.operationCode
  if (error instanceof Error && /^(BACKUP|RESTIC|POSTGRES|UNSAFE|MAINTENANCE)_[A-Z0-9_]{1,96}$/.test(error.message)) return error.message
  if (error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string' && ['EACCES', 'EEXIST', 'EIO', 'ENOENT', 'ENOSPC', 'EPERM'].includes(error.code)) {
    return `OS_${error.code}`
  }
  return 'UNCLASSIFIED'
}

export interface PublishDirectSetInput {
  staged: DirectUnpublishedBackupSet
  stagingDirectory: string
  manifestDirectory: string
  scratchDirectory: string
  journalDirectory: string
  publicationDirectory: string
  repository: LocalResticRepository
  releaseId: string
  images: BackupManifest['images']
  resticVersion: string
  assertLock(): Promise<void>
  assertSecureStorage(): Promise<void>
  assertRestoredAndRelease(journal: MaintenanceJournal): Promise<void>
  verifyDumpBinding(directory: string, metadata: {
    databaseId: string; instanceId: string; identityJkt: string; pendingKeyId: string; pendingKeySha256: string;
    migrationHead: string; migrationChecksumsSha256: string
  }): Promise<void>
  inspectTrustStorePersistedReadOnly(directory: string): Promise<ReadonlyTrustBundleInspection>
  signal?: AbortSignal
}

async function syncDirectory(path: string) {
  const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await dir.sync() } finally { await dir.close() }
}

function metadataFor(manifest: DirectBackupManifest) {
  return { databaseId: manifest.database.id, instanceId: manifest.binding.instance_id, identityJkt: manifest.binding.identity_jkt,
    pendingKeyId: manifest.key_ids.pending, pendingKeySha256: manifest.binding.pending_key_sha256,
    migrationHead: manifest.database.schema_head, migrationChecksumsSha256: manifest.database.migration_checksums_sha256 }
}

function keysFor(manifest: DirectBackupManifest): KeyReferences {
  return { paymentKeyIds: manifest.key_ids.payment, deliveryKeyIds: manifest.key_ids.delivery,
    paymentReferencedKeyIds: [], deliveryReferencedKeyIds: [], paymentActiveKeyId: manifest.key_material_proofs.payment_active,
    deliveryActiveKeyId: manifest.key_material_proofs.delivery_active, paymentKeyDigests: manifest.key_material_proofs.payment,
    deliveryKeyDigests: manifest.key_material_proofs.delivery, contentVerification: 'not_verified' }
}

function candidateFor(input: PublishDirectSetInput, journal: MaintenanceJournal): DirectBackupManifest {
  const staged = input.staged
  const restarted = journal.services.some(item => item.running)
  return { schema: 2, product: 'aikayun', status: 'candidate', backup_set_id: staged.backupSetId,
    created_at: staged.createdAt, quiesced_at: staged.quiescedAt,
    service_restoration: restarted ? 'restored' : 'not_needed', services_resumed_at: restarted ? journal.updatedAt : null,
    completed_at: new Date().toISOString(), release_id: input.releaseId, images: input.images,
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
    tools: { pg_dump: staged.pgDumpVersion, restic: input.resticVersion }, unresolved: staged.evidence.unresolved,
    source_snapshot_id: staged.sourceSnapshotId, database_dump: staged.databaseDump }
}

async function readRecord(directory: string, set: string): Promise<PublicationRecord> {
  if (!uuid.test(set) || !isAbsolute(directory) || resolve(directory) !== directory || await realpath(directory) !== directory) {
    throw new Error('BACKUP_PUBLICATION_INVALID')
  }
  await privateDirectory(directory)
  const file = await open(join(directory, `${set}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 1024) {
      throw new Error('BACKUP_PUBLICATION_INVALID')
    }
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) { const item = await file.read(bytes, offset, bytes.length - offset, offset); if (!item.bytesRead) break; offset += item.bytesRead }
    const after = await file.stat()
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('BACKUP_PUBLICATION_INVALID')
    }
    let value: unknown
    try { value = JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown } catch { throw new Error('BACKUP_PUBLICATION_INVALID') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BACKUP_PUBLICATION_INVALID')
    const item = value as Record<string, unknown>
    const keys = Object.keys(item).sort().join(',')
    if (item.schema !== 2 || item.set !== set || !['uploading', 'verified'].includes(String(item.state)) ||
        typeof item.source_snapshot !== 'string' || !digest.test(item.source_snapshot) ||
        (item.state === 'uploading' && keys !== 'schema,set,source_snapshot,state') ||
        (item.state === 'verified' && (keys !== 'manifest_snapshot,schema,set,source_snapshot,state' || typeof item.manifest_snapshot !== 'string' || !digest.test(item.manifest_snapshot)))) {
      throw new Error('BACKUP_PUBLICATION_INVALID')
    }
    return item as PublicationRecord
  } finally { await file.close() }
}

async function writeRecord(path: string, contents: PublicationRecord, expected?: string) {
  const temp = join(path, `.publication-${randomUUID()}.tmp`)
  const data = `${JSON.stringify(contents)}\n`
  try {
    if (expected === undefined) {
      const marker = await open(join(path, `${contents.set}.json`), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try { await marker.writeFile(data); await marker.sync() } finally { await marker.close() }
      await syncDirectory(path)
      return
    }
    const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(data); await file.sync() } finally { await file.close() }
    const target = join(path, `${contents.set}.json`)
    const current = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await current.stat()
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 ||
          info.size !== Buffer.byteLength(expected!) || await current.readFile('utf8') !== expected) throw new Error('BACKUP_PUBLICATION_CHANGED')
    } finally { await current.close() }
    await rename(temp, target)
    await syncDirectory(path)
  } finally { await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }) }
}

async function verifyDirectPair(input: {
  set: string; sourceSnapshot: string; manifestSnapshot: string; manifestDirectory: string; scratchDirectory: string
  repository: LocalResticRepository; databaseDump: { size: number; sha256: string }; assertLock(): Promise<void>
  inspectTrustStoreReadOnly(directory: string): Promise<ReadonlyTrustBundleInspection>; signal?: AbortSignal
  allowCandidate?: boolean; expectedManifest?: DirectBackupManifest
}): Promise<DirectBackupManifest> {
  await input.assertLock()
  const records = await input.repository.snapshotMetadata(input.set) as unknown
  if (!Array.isArray(records) || records.length !== 2) throw new Error('BACKUP_SNAPSHOT_PAIR_INVALID')
  const set = setTag(input.set)
  const sources = records.filter((item: unknown) => item && typeof item === 'object' && 'tags' in item && Array.isArray(item.tags) && item.tags.includes(roleTag('source')))
  const manifests = records.filter((item: unknown) => item && typeof item === 'object' && 'tags' in item && Array.isArray(item.tags) && item.tags.includes(roleTag('manifest')))
  if (sources.length !== 1 || manifests.length !== 1) throw new Error('BACKUP_SNAPSHOT_PAIR_INVALID')
  const source = sources[0] as { id?: unknown; time?: unknown; tags?: unknown; paths?: unknown[] }
  const metadata = manifests[0] as { id?: unknown; time?: unknown; tags?: unknown; paths?: unknown[] }
  if (source.id !== input.sourceSnapshot || metadata.id !== input.manifestSnapshot ||
      JSON.stringify([...(source.paths ?? [])].sort()) !== JSON.stringify(['/sources/caddy-config', '/sources/caddy-data', '/sources/deployment', '/sources/staging/payload', '/sources/state']) ||
      JSON.stringify([...(metadata.paths ?? [])].sort()) !== JSON.stringify([input.manifestDirectory]) ||
      !Array.isArray(source.tags) || source.tags.length !== 2 || !source.tags.includes(set) || !source.tags.includes(roleTag('source')) ||
      !Array.isArray(metadata.tags) || metadata.tags.length !== 2 || !metadata.tags.includes(set) || !metadata.tags.includes(roleTag('manifest'))) {
    throw new Error('BACKUP_SNAPSHOT_PAIR_INVALID')
  }
  const manifestPath = join(input.manifestDirectory, 'manifest.json')
  const manifestBytes = await readSnapshotFile({ repo: input.repository, snapshot: input.manifestSnapshot, scratch: input.scratchDirectory,
    path: manifestPath, maxBytes: 65536, owner: process.getuid?.() ?? -1, group: process.getgid?.() ?? -1, mode: 0o600, assertLock: input.assertLock })
  let parsed: unknown
  try { parsed = JSON.parse(manifestBytes.toString('utf8')) as unknown } catch { throw new Error('INVALID_BACKUP_MANIFEST') }
  finally { manifestBytes.fill(0) }
  validateDirectBackupManifest(parsed, input.allowCandidate)
  const sourceTime = typeof source.time === 'string' ? Date.parse(source.time) : Number.NaN
  const manifestTime = typeof metadata.time === 'string' ? Date.parse(metadata.time) : Number.NaN
  const sourceDeadline = Date.parse(parsed.services_resumed_at ?? parsed.completed_at)
  if (!Number.isFinite(sourceTime) || !Number.isFinite(manifestTime) || sourceTime < Date.parse(parsed.created_at) ||
      sourceTime > sourceDeadline || manifestTime < sourceDeadline) throw new Error('BACKUP_SNAPSHOT_TIME_INVALID')
  if (parsed.backup_set_id !== input.set || parsed.source_snapshot_id !== input.sourceSnapshot ||
      parsed.database_dump.size !== input.databaseDump.size || parsed.database_dump.sha256 !== input.databaseDump.sha256 ||
      parsed.status !== 'candidate') throw new Error('BACKUP_SNAPSHOT_PAIR_INVALID')
  if (input.expectedManifest && JSON.stringify(parsed) !== JSON.stringify(input.expectedManifest)) throw new Error('BACKUP_PUBLICATION_CHECK_FAILED')
  const evidence = await verifyDirectSourceSnapshot({ repo: input.repository, set: input.set, snapshot: input.sourceSnapshot,
    scratch: input.scratchDirectory, databaseDump: parsed.database_dump, database: metadataFor(parsed), keys: keysFor(parsed),
    appUid: 1000, appGid: 1000, inspectTrustStoreReadOnly: input.inspectTrustStoreReadOnly,
    assertLock: input.assertLock, ...(input.signal ? { signal: input.signal } : {}) })
  if (evidence.identityFileSha256 !== parsed.instance_identity_sha256) throw new Error('BACKUP_STATE_IDENTITY_MISMATCH')
  assertTrustBundleManifestMatch(evidence.trustBundle, parsed.trust_bundle)
  return parsed
}

export async function publishDirectCapturedSet(input: PublishDirectSetInput): Promise<{ snapshotId: string; sourceSnapshotId: string; status: 'verified' }> {
  const staged = input.staged
  if (!uuid.test(staged.backupSetId) || !digest.test(staged.sourceSnapshotId) || typeof input.assertLock !== 'function' ||
      typeof input.assertSecureStorage !== 'function') throw new Error('BACKUP_PUBLICATION_INVALID')
  for (const path of [input.stagingDirectory, input.scratchDirectory, input.publicationDirectory, input.journalDirectory]) {
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('BACKUP_PUBLICATION_PATH_INVALID')
    await privateDirectory(path)
  }
  if (!isAbsolute(input.manifestDirectory) || resolve(input.manifestDirectory) !== input.manifestDirectory ||
      await realpath(input.manifestDirectory) !== input.manifestDirectory) throw new Error('BACKUP_PUBLICATION_PATH_INVALID')
  await privateDirectory(input.manifestDirectory)
  const dirs = [input.stagingDirectory, input.manifestDirectory, input.scratchDirectory, input.publicationDirectory, input.journalDirectory]
  for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
    if (within(dirs[i]!, dirs[j]!) || within(dirs[j]!, dirs[i]!)) throw new Error('BACKUP_PUBLICATION_PATH_INVALID')
  }
  await input.repository.assertSeparatedStorage(dirs)
  await input.assertSecureStorage(); await input.assertLock()
  const journal = await readMaintenanceJournal(input.journalDirectory)
  if (!journal || journal.phase !== 'complete' || journal.backupSetId !== staged.backupSetId) throw new Error('BACKUP_MAINTENANCE_NOT_COMPLETE')
  await input.assertRestoredAndRelease(journal)
  const names = await readdir(input.stagingDirectory)
  if (names.join(',') !== 'database.dump') throw new Error('BACKUP_STAGING_INVALID')
  if ((await readdir(input.manifestDirectory)).length !== 0) throw new Error('BACKUP_STAGING_INVALID')
  try { await lstat(join(input.publicationDirectory, `${staged.backupSetId}.json`)); throw new Error('BACKUP_PUBLICATION_ALREADY_ATTEMPTED') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const candidate = candidateFor(input, journal)
  validateDirectBackupManifest(candidate, true)
  let failure: unknown
  let snapshotId: string | undefined
  const uploading: PublicationRecord = { schema: 2, set: staged.backupSetId, state: 'uploading', source_snapshot: staged.sourceSnapshotId }
  try {
    const manifestFile = await open(join(input.manifestDirectory, 'manifest.json'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await manifestFile.writeFile(`${JSON.stringify(candidate)}\n`); await manifestFile.sync() } finally { await manifestFile.close() }
    await syncDirectory(input.manifestDirectory)
    await input.verifyDumpBinding(input.stagingDirectory, metadataFor(candidate))
    await input.assertLock(); await input.assertRestoredAndRelease(journal)
    await writeRecord(input.publicationDirectory, uploading)
    snapshotId = await input.repository.backupRole(input.manifestDirectory, staged.backupSetId, 'manifest')
    await input.repository.check()
    const checked = await verifyDirectPair({ set: staged.backupSetId, sourceSnapshot: staged.sourceSnapshotId,
      manifestSnapshot: snapshotId, manifestDirectory: input.manifestDirectory, scratchDirectory: input.scratchDirectory,
      repository: input.repository, databaseDump: staged.databaseDump, assertLock: input.assertLock,
      inspectTrustStoreReadOnly: input.inspectTrustStorePersistedReadOnly, ...(input.signal ? { signal: input.signal } : {}), allowCandidate: true, expectedManifest: candidate })
    if (JSON.stringify(checked) !== JSON.stringify(candidate)) throw new Error('BACKUP_PUBLICATION_CHECK_FAILED')
    await input.assertLock()
    const current = await readMaintenanceJournal(input.journalDirectory)
    if (!current || JSON.stringify(current) !== JSON.stringify(journal)) throw new Error('BACKUP_MAINTENANCE_NOT_COMPLETE')
    await input.assertRestoredAndRelease(journal)
  } catch (error) { failure = error }
  if (failure instanceof UnsafeMaintenanceRecoveryError) throw failure
  if (failure) {
    const publicationError = new Error('BACKUP_PUBLICATION_INCOMPLETE_OR_UNKNOWN')
    Object.defineProperty(publicationError, 'reasonCode', { value: safePublicationFailureReason(failure), enumerable: true })
    throw publicationError
  }
  if (!snapshotId) throw new Error('BACKUP_PUBLICATION_INCOMPLETE_OR_UNKNOWN')
  const verified: PublicationRecord = { ...uploading, state: 'verified', manifest_snapshot: snapshotId }
  await input.assertLock()
  await writeRecord(input.publicationDirectory, verified, `${JSON.stringify(uploading)}\n`)
  await input.assertLock()
  return { snapshotId, sourceSnapshotId: staged.sourceSnapshotId, status: 'verified' }
}

export async function verifyDirectPublishedSet(input: {
  backupSetId: string; publicationDirectory: string; manifestDirectory: string; scratchDirectory: string
  repository: LocalResticRepository; assertLock(): Promise<void>; assertSecureStorage(): Promise<void>
  inspectTrustStoreReadOnly(directory: string): Promise<ReadonlyTrustBundleInspection>; signal?: AbortSignal
  assertAuthenticatedManifest?(manifest: DirectBackupManifest): Promise<void>
}): Promise<{ snapshotId: string; sourceSnapshotId: string; status: 'verified'; manifest: DirectBackupManifest }> {
  await input.assertLock(); await input.assertSecureStorage()
  if (within(input.scratchDirectory, input.manifestDirectory) || within(input.manifestDirectory, input.scratchDirectory) ||
      within(input.publicationDirectory, input.scratchDirectory) || within(input.scratchDirectory, input.publicationDirectory) ||
      within(input.publicationDirectory, input.manifestDirectory) || within(input.manifestDirectory, input.publicationDirectory)) {
    throw new Error('BACKUP_PUBLICATION_PATH_INVALID')
  }
  await input.repository.assertSeparatedStorage([input.publicationDirectory, input.scratchDirectory])
  const record = await readRecord(input.publicationDirectory, input.backupSetId)
  if (record.state !== 'verified' || !record.manifest_snapshot) throw new Error('BACKUP_PUBLICATION_NOT_VERIFIED')
  await input.repository.check()
  const metadata = await input.repository.snapshotMetadata(input.backupSetId) as unknown
  if (!Array.isArray(metadata) || metadata.length !== 2) throw new Error('BACKUP_SNAPSHOT_PAIR_INVALID')
  const manifestRecords = metadata.filter((item: unknown) => item && typeof item === 'object' && 'tags' in item &&
    Array.isArray(item.tags) && item.tags.includes(roleTag('manifest')))
  if (manifestRecords.length !== 1 || !('paths' in (manifestRecords[0] as object)) ||
      !Array.isArray((manifestRecords[0] as { paths?: unknown }).paths) || (manifestRecords[0] as { id?: unknown }).id !== record.manifest_snapshot) {
    throw new Error('BACKUP_SNAPSHOT_PAIR_INVALID')
  }
  const path = (manifestRecords[0] as { paths: unknown[] }).paths[0]
  if (typeof path !== 'string' || path !== input.manifestDirectory) throw new Error('BACKUP_SNAPSHOT_PAIR_INVALID')
  const manifestUid = process.getuid?.() ?? -1, manifestGid = process.getgid?.() ?? -1
  const manifestPath = join(path, 'manifest.json')
  const manifestNode = JSON.parse((await input.repository.listSnapshot(record.manifest_snapshot, manifestPath)).trim().split('\n').filter(Boolean).at(-1) ?? '{}') as Record<string, unknown>
  if (manifestNode.struct_type !== 'node' || manifestNode.path !== manifestPath || manifestNode.type !== 'file' ||
      manifestNode.uid !== manifestUid || manifestNode.gid !== manifestGid ||
      manifestNode.mode !== 0o600 || !Number.isSafeInteger(manifestNode.size) || (manifestNode.size as number) < 1 || (manifestNode.size as number) > 65536) {
    throw new Error('BACKUP_SNAPSHOT_PAIR_INVALID')
  }
  const manifestBytes = await readSnapshotFile({ repo: input.repository, snapshot: record.manifest_snapshot, scratch: input.scratchDirectory,
    path: manifestPath, maxBytes: 65536, owner: manifestUid, group: manifestGid, mode: 0o600, assertLock: input.assertLock })
  let parsed: unknown
  try { parsed = JSON.parse(manifestBytes.toString('utf8')) as unknown } catch { throw new Error('INVALID_BACKUP_MANIFEST') }
  finally { manifestBytes.fill(0) }
  validateDirectBackupManifest(parsed, true)
  const manifest = await verifyDirectPair({ set: input.backupSetId, sourceSnapshot: record.source_snapshot, manifestSnapshot: record.manifest_snapshot,
    manifestDirectory: path, scratchDirectory: input.scratchDirectory, repository: input.repository, databaseDump: parsed.database_dump,
    assertLock: input.assertLock, inspectTrustStoreReadOnly: input.inspectTrustStoreReadOnly,
    ...(input.signal ? { signal: input.signal } : {}), allowCandidate: true })
  if (input.assertAuthenticatedManifest) await input.assertAuthenticatedManifest(manifest)
  return { snapshotId: record.manifest_snapshot, sourceSnapshotId: record.source_snapshot, status: 'verified', manifest }
}

export async function readDirectPublicationRecord(directory: string, set: string): Promise<{ sourceSnapshot: string; manifestSnapshot: string } | null> {
  const record = await readRecord(directory, set)
  return record.state === 'verified' && record.manifest_snapshot
    ? { sourceSnapshot: record.source_snapshot, manifestSnapshot: record.manifest_snapshot } : null
}
