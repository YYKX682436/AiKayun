import { createHash } from 'node:crypto'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import { readDirectPublicationRecord, verifyDirectPublishedSet } from './direct-publish-set.js'
import { LocalResticRepository, privateDirectory } from './restic-local.js'
import type { ReadonlyTrustBundleInspection } from '../licensing/trust/trust-bundle-store.js'

const setPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const digestPattern = /^[a-f0-9]{64}$/
const setTagPrefix = 'aikayun-set-'
const roleTags = ['aikayun-role-source', 'aikayun-role-manifest'] as const
const safeFailureCode = /^(?:BACKUP|RESTIC|REPOSITORY|STAGING|DEPLOYMENT|INSTALLER|LICENSE|TRUST|DATABASE|PAYMENT|DELIVERY|SET|FENCE|ARCHIVE|DUMP)_[A-Z0-9_]{1,80}$/u

function listFailure(error: unknown): Error {
  if (error && typeof error === 'object') {
    const candidates = [
      'operationCode' in error && typeof error.operationCode === 'string' ? error.operationCode : '',
      'message' in error && typeof error.message === 'string' ? error.message : '',
    ]
    const code = candidates.find(candidate => safeFailureCode.test(candidate))
    if (code) return new Error(code)
  }
  return new Error('BACKUP_LIST_UNAVAILABLE')
}

export interface DirectCustomerBackupInspectionConfig {
  publicationDirectory: string
  manifestDirectory(set: string): string
  scratchDirectory: string
  repository: LocalResticRepository
  assertSecureStorage(): Promise<void>
  assertLock(): Promise<void>
  inspectTrustStoreReadOnly(directory: string): Promise<ReadonlyTrustBundleInspection>
  assertAuthenticatedManifest: NonNullable<Parameters<typeof verifyDirectPublishedSet>[0]['assertAuthenticatedManifest']>
  signal?: AbortSignal
}

export type DirectCustomerBackupStatus = {
  backupSetId: string
  status: 'verified' | 'needs_attention'
  createdAt: string | null
  releaseId: string | null
  /** Internal restore preparation evidence; callers must keep this behind the
   * signed host command and never expose the manifest or business data. */
  restoreEvidence?: { sourceSnapshotId: string; manifestSnapshotId: string }
}

export async function inspectDirectCustomerBackup(config: DirectCustomerBackupInspectionConfig, set: string,
  includeRestoreEvidence = false): Promise<DirectCustomerBackupStatus> {
  if (!setPattern.test(set) || typeof config.manifestDirectory !== 'function' || typeof config.assertLock !== 'function' ||
      typeof config.assertSecureStorage !== 'function' || typeof config.assertAuthenticatedManifest !== 'function') {
    throw new Error('BACKUP_INSPECTION_ARGUMENT_INVALID')
  }
  try {
    await config.assertLock(); await config.assertSecureStorage()
    const result = await verifyDirectPublishedSet({ backupSetId: set, publicationDirectory: config.publicationDirectory,
      manifestDirectory: config.manifestDirectory(set), scratchDirectory: config.scratchDirectory,
      repository: config.repository, assertLock: config.assertLock, assertSecureStorage: config.assertSecureStorage,
      inspectTrustStoreReadOnly: config.inspectTrustStoreReadOnly, ...(config.signal ? { signal: config.signal } : {}),
      assertAuthenticatedManifest: config.assertAuthenticatedManifest })
    await config.assertLock()
    if (result.status !== 'verified' || result.manifest.backup_set_id !== set) {
      return { backupSetId: set, status: 'needs_attention', createdAt: null, releaseId: null }
    }
    return { backupSetId: set, status: 'verified', createdAt: result.manifest.created_at, releaseId: result.manifest.release_id,
      ...(includeRestoreEvidence ? { restoreEvidence: { sourceSnapshotId: result.sourceSnapshotId, manifestSnapshotId: result.snapshotId } } : {}) }
  } catch (error) {
    if (error instanceof UnsafeMaintenanceRecoveryError) throw error
    await config.assertLock()
    return { backupSetId: set, status: 'needs_attention', createdAt: null, releaseId: null }
  }
}

export async function listDirectCustomerBackups(config: DirectCustomerBackupInspectionConfig, options: { limit: number; after?: string; revision?: string }): Promise<{
  items: { backupSetId: string; status: 'not_checked' | 'needs_attention' }[]
  nextAfter: string | null; revision: string; unknownRecords: boolean; untrackedSnapshots: number
}> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10 ||
      (options.after !== undefined && (!setPattern.test(options.after) || !options.revision)) ||
      (options.revision !== undefined && !digestPattern.test(options.revision)) || typeof config.assertLock !== 'function') {
    throw new Error('BACKUP_INSPECTION_ARGUMENT_INVALID')
  }
  try {
    if (!isAbsolute(config.publicationDirectory) || resolve(config.publicationDirectory) !== config.publicationDirectory ||
        await realpath(config.publicationDirectory) !== config.publicationDirectory) throw new Error('invalid')
    await privateDirectory(config.publicationDirectory)
    await config.repository.assertSeparatedStorage([config.publicationDirectory, config.scratchDirectory])
    await config.assertLock()
  } catch (error) { throw listFailure(error) }
  const sets = new Set<string>(), revisionEntries: string[] = []
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
      } else unknownRecords = true
    }
  } catch (error) { throw listFailure(error) }
  let snapshots: unknown
  try { snapshots = await config.repository.allSnapshotMetadata() } catch (error) { throw listFailure(error) }
  if (!Array.isArray(snapshots) || snapshots.length > 10000) throw new Error('BACKUP_LIST_UNAVAILABLE')
  const bySet = new Map<string, { source: string[]; manifest: string[] }>()
  let untrackedSnapshots = 0
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || typeof snapshot.id !== 'string' || !digestPattern.test(snapshot.id) ||
        !Array.isArray(snapshot.tags) || !snapshot.tags.every((tag: unknown) => typeof tag === 'string')) throw new Error('BACKUP_LIST_UNAVAILABLE')
    const tags = snapshot.tags as string[]
    const setTags = tags.filter(tag => tag.startsWith(setTagPrefix))
    const role = roleTags.filter(tag => tags.includes(tag))
    revisionEntries.push(`snapshot:${snapshot.id}:${[...setTags, ...role].sort().join(',')}`)
    if (setTags.length !== 1 || role.length !== 1) { untrackedSnapshots++; continue }
    const set = setTags[0]!.slice(setTagPrefix.length)
    if (!setPattern.test(set) || !sets.has(set)) { untrackedSnapshots++; continue }
    const pair = bySet.get(set) ?? { source: [], manifest: [] }
    if (role[0] === roleTags[0]) pair.source.push(snapshot.id)
    else pair.manifest.push(snapshot.id)
    bySet.set(set, pair)
  }
  const revision = createHash('sha256').update(JSON.stringify({ entries: revisionEntries.sort(), unknownRecords, untrackedSnapshots })).digest('hex')
  if (options.revision !== undefined && options.revision !== revision) throw new Error('BACKUP_LIST_CHANGED')
  const all = [...sets].sort().filter(set => options.after === undefined || set > options.after)
  const page = all.slice(0, options.limit)
  const items: { backupSetId: string; status: 'not_checked' | 'needs_attention' }[] = []
  for (const set of page) {
    let status: 'not_checked' | 'needs_attention' = 'needs_attention'
    try {
      const recorded = await readDirectPublicationRecord(config.publicationDirectory, set)
      const pair = bySet.get(set)
      if (recorded && pair?.source.length === 1 && pair.manifest.length === 1 &&
          pair.source[0] === recorded.sourceSnapshot && pair.manifest[0] === recorded.manifestSnapshot) status = 'not_checked'
    } catch { /* Missing, incomplete or malformed records need review. */ }
    items.push({ backupSetId: set, status })
  }
  await config.assertLock()
  return { items, nextAfter: all.length > page.length ? page[page.length - 1]! : null, revision, unknownRecords, untrackedSnapshots }
}
