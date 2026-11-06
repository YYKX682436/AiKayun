import { lstat, opendir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { readVerifiedPublicationRecord, verifyPublishedSnapshot } from './publish-set.js'
import { LocalResticRepository, privateDirectory } from './restic-local.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import { verifyPostgresDumpBinding, type PostgresDumpTarget } from './pg-dump.js'
import type { readBackupDatabaseMetadata } from './database-metadata.js'
import type { BackupManifest } from './manifest.js'
import type { ReadonlyTrustBundleInspection } from '../licensing/trust/trust-bundle-store.js'

const setPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const digestPattern = /^[a-f0-9]{64}$/

async function requireLock(config: CustomerBackupInspectionConfig): Promise<void> {
  try { await config.assertLock() } catch { throw new Error('BACKUP_INSPECTION_LOCK_UNVERIFIED') }
}

export interface CustomerBackupInspectionConfig {
  publicationDirectory: string
  scratchParent: string
  tarBinary: string
  repository: LocalResticRepository
  maxExtractBytes: number
  pgDumpTarget: Omit<PostgresDumpTarget, 'stagingDirectory'>
  assertSecureStorage(): Promise<void>
  assertSafeCleanup(): Promise<void>
  /** Compare the saved binding and migration evidence with an authenticated release. */
  assertBackupMetadata(metadata: Awaited<ReturnType<typeof readBackupDatabaseMetadata>>): Promise<void>
  assertBackupRelease(releaseId: string, images: BackupManifest['images']): Promise<void>
  inspectTrustStoreReadOnly?(directory: string): Promise<ReadonlyTrustBundleInspection>
  signal?: AbortSignal | undefined
  assertLock(): Promise<void>
}

export type CustomerBackupStatus = {
  backupSetId: string
  status: 'verified' | 'needs_attention'
  createdAt: string | null
  releaseId: string | null
}

/** Only the public whitelist is returned. The decrypted manifest contains
 * identity and key-material proofs and must never leave the verifier. */
export async function inspectCustomerBackup(config: CustomerBackupInspectionConfig, set: string): Promise<CustomerBackupStatus> {
  if (!setPattern.test(set) || !config.pgDumpTarget || typeof config.assertLock !== 'function' ||
      typeof config.assertSecureStorage !== 'function' || typeof config.assertSafeCleanup !== 'function' || typeof config.assertBackupMetadata !== 'function' || typeof config.assertBackupRelease !== 'function') throw new Error('BACKUP_INSPECTION_ARGUMENT_INVALID')
  await requireLock(config)
  let result: Awaited<ReturnType<typeof verifyPublishedSnapshot>>
  try {
    result = await verifyPublishedSnapshot({ backupSetId: set, publicationDirectory: config.publicationDirectory,
      scratchParent: config.scratchParent, tarBinary: config.tarBinary, repository: config.repository,
      maxExtractBytes: config.maxExtractBytes, assertSecureStorage: config.assertSecureStorage, assertSafeCleanup: config.assertSafeCleanup, signal: config.signal,
      assertAuthenticatedManifest: manifest => config.assertBackupRelease(manifest.release_id, manifest.images),
      inspectTrustStoreReadOnly: config.inspectTrustStoreReadOnly,
      verifyDumpBinding: async (directory, metadata) => { await config.assertBackupMetadata(metadata); await verifyPostgresDumpBinding({ ...config.pgDumpTarget, stagingDirectory: directory }, metadata) } })
  } catch (error) {
    if (error instanceof UnsafeMaintenanceRecoveryError) throw error
    await requireLock(config)
    return { backupSetId: set, status: 'needs_attention', createdAt: null, releaseId: null }
  }
  await requireLock(config)
  if (result.status !== 'verified' || result.manifest.status !== 'candidate' || result.manifest.backup_set_id !== set ||
      !digestPattern.test(result.snapshotId)) return { backupSetId: set, status: 'needs_attention', createdAt: null, releaseId: null }
  return { backupSetId: set, status: 'verified', createdAt: result.manifest.created_at, releaseId: result.manifest.release_id }
}

/** Listing is metadata-only. A publication record does not prove health, so a
 * matching snapshot is explicitly 'not_checked'; only explicit inspection does
 * the full repository and archive recheck and can report 'verified'. */
export async function listCustomerBackups(config: CustomerBackupInspectionConfig, options: { limit: number; after?: string; revision?: string }): Promise<{
  items: { backupSetId: string; status: 'not_checked' | 'needs_attention' }[]
  nextAfter: string | null; revision: string; unknownRecords: boolean; untrackedSnapshots: number
}> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10 ||
      (options.after !== undefined && (!setPattern.test(options.after) || !options.revision)) ||
      (options.revision !== undefined && !digestPattern.test(options.revision)) || typeof config.assertLock !== 'function' ||
      typeof config.assertSecureStorage !== 'function' || !config.pgDumpTarget) throw new Error('BACKUP_INSPECTION_ARGUMENT_INVALID')
  try {
    if (!isAbsolute(config.publicationDirectory) || resolve(config.publicationDirectory) !== config.publicationDirectory ||
        await realpath(config.publicationDirectory) !== config.publicationDirectory) throw new Error('invalid')
    await privateDirectory(config.publicationDirectory)
  } catch { throw new Error('BACKUP_LIST_UNAVAILABLE') }
  await requireLock(config)
  try { await config.repository.assertSeparatedStorage([config.publicationDirectory, config.scratchParent]) }
  catch { throw new Error('BACKUP_LIST_UNAVAILABLE') }
  const sets = new Set<string>()
  const revisionEntries: string[] = []
  let unknownRecords = false, entries = 0
  try {
    const directory = await opendir(config.publicationDirectory)
    for await (const entry of directory) {
      if (++entries > 10000) throw new Error('BACKUP_LIST_LIMIT')
      const match = /^([0-9a-f-]{36})\.json$/.exec(entry.name)
      if (match && setPattern.test(match[1]!)) {
        sets.add(match[1]!)
        const stat = await lstat(`${config.publicationDirectory}/${entry.name}`)
        revisionEntries.push(`publication:${match[1]!}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`)
      }
      else unknownRecords = true
    }
  } catch { throw new Error('BACKUP_LIST_UNAVAILABLE') }
  let snapshots: unknown
  try { snapshots = await config.repository.allSnapshotMetadata() } catch { throw new Error('BACKUP_LIST_UNAVAILABLE') }
  if (!Array.isArray(snapshots) || snapshots.length > 10000) throw new Error('BACKUP_LIST_UNAVAILABLE')
  let untrackedSnapshots = 0
  const bySet = new Map<string, string[]>()
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || typeof snapshot.id !== 'string' ||
        !digestPattern.test(snapshot.id) || (snapshot.tags !== undefined && (!Array.isArray(snapshot.tags) ||
        !snapshot.tags.every((tag: unknown) => typeof tag === 'string')))) {
      throw new Error('BACKUP_LIST_UNAVAILABLE')
    }
    const relevant = (snapshot.tags ?? []).filter((tag: string) => tag.startsWith('aikayun-set-'))
    revisionEntries.push(`snapshot:${snapshot.id}:${relevant.sort().join(',')}`)
    if (relevant.length !== 1 || !setPattern.test(relevant[0]!.slice('aikayun-set-'.length))) { untrackedSnapshots++; continue }
    const set = relevant[0]!.slice('aikayun-set-'.length)
    if (!sets.has(set)) { untrackedSnapshots++; continue }
    const ids = bySet.get(set) ?? []
    ids.push(snapshot.id)
    bySet.set(set, ids)
  }
  const revision = createHash('sha256').update(JSON.stringify({ entries: revisionEntries.sort(), unknownRecords, untrackedSnapshots })).digest('hex')
  if (options.revision !== undefined && options.revision !== revision) throw new Error('BACKUP_LIST_CHANGED')
  const all = [...sets].sort().filter(set => options.after === undefined || set > options.after)
  const page = all.slice(0, options.limit)
  const items: { backupSetId: string; status: 'not_checked' | 'needs_attention' }[] = []
  for (const set of page) {
    let status: 'not_checked' | 'needs_attention' = 'needs_attention'
    try {
      const recorded = await readVerifiedPublicationRecord(config.publicationDirectory, set)
      const ids = bySet.get(set) ?? []
      if (ids.length === 1 && ids[0] === recorded) status = 'not_checked'
    } catch { /* Missing, incomplete or malformed records require attention. */ }
    items.push({ backupSetId: set, status })
  }
  await requireLock(config)
  return { items, nextAfter: all.length > page.length ? page[page.length - 1]! : null, revision, unknownRecords, untrackedSnapshots }
}
