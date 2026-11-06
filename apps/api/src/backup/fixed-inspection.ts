import { randomUUID } from 'node:crypto'
import { opendir } from 'node:fs/promises'
import { discoverFixedDeployment } from './fixed-discovery.js'
import { loadFixedBackupPaths } from './fixed-backup-paths.js'
import { loadFixedReleaseSource } from './fixed-release-source.js'
import { withProvenProductionDatabaseTarget } from './database-target.js'
import { readBackupDatabaseMetadata } from './database-metadata.js'
import { assertNoFixedBackupWriters } from './fixed-cleanup-proof.js'
import { inspectDirectCustomerBackup, listDirectCustomerBackups } from './direct-customer-inspection.js'
import { assertNoSwapTmpfs, assertTmpfsStaging, createTmpfsStaging, removeTmpfsStaging, type TmpfsStagingOptions } from './tmpfs-staging.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import { readMaintenanceJournal } from './journal.js'
import { assertInitializedRepository } from './repository-initialization.js'

export type FixedInspectionCommand = { mode: 'list'; limit: number; after?: string; revision?: string } | { mode: 'verify'; set: string }

/** Internal only. Signed image provenance and the inherited host flock must
 * already be established; there is no fallback or caller-supplied authority. */
export async function runFixedProductionInspection(command: FixedInspectionCommand, signal: AbortSignal) {
  if (!signal || signal.aborted) throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED')
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  signal.addEventListener('abort', interrupt, { once: true })
  if (signal.aborted) interrupt()
  try {
    const source = await loadFixedReleaseSource(controller.signal)
    const release = await source.readAuthenticatedRelease()
    const paths = await loadFixedBackupPaths(controller.signal, release.backupResticImage, () => source.host.assertOwnedLock())
    const found = await discoverFixedDeployment(source)
    const assertLock = () => source.host.assertOwnedLock()
    const signed = () => source.host.verifyDeployment(source.fingerprint)
    return await withProvenProductionDatabaseTarget({ databaseConfig: source.databaseConfig,
      containerId: found.databaseContainerId, postgresImage: release.postgresImage, database: 'aikayun', bootstrapUser: 'aikayun_bootstrap',
      assertLock, assertSignedDeployment: signed }, async target => {
      const current = await readBackupDatabaseMetadata(target.db, release.database, release.signedChecksums, release.compiledChecksums)
      await target.assertBound()
      const safeCleanup = async () => { await target.assertBound(); await assertNoFixedBackupWriters(target.db); await assertLock() }
      await assertNoSwapTmpfs(paths.mountRoot, paths.minimumBytes)
      const common = { publicationDirectory: paths.publicationDirectory, scratchDirectory: paths.mountRoot, repository: paths.repository,
        assertLock, signal: controller.signal,
        assertSecureStorage: async () => { await assertLock(); await assertNoSwapTmpfs(paths.mountRoot, 1n) },
        manifestDirectory: (set: string) => `${paths.mountRoot}/set-${set}/manifest`,
        assertBackupRelease: async (releaseId: string, images: typeof release.images) => {
          await target.assertBound()
          const currentRelease = await source.readAuthenticatedRelease()
          if (releaseId !== currentRelease.releaseId ||
              (['api', 'web', 'postgres', 'caddy'] as const).some(name => images[name] !== currentRelease.images[name])) {
            throw new Error('BACKUP_INSPECTION_RELEASE_OR_BINDING_MISMATCH')
          }
        },
        assertBackupMetadata: async (manifest: import('./manifest.js').DirectBackupManifest) => {
          await target.assertBound()
          if (manifest.database.id !== current.databaseId || manifest.binding.instance_id !== current.instanceId ||
              manifest.binding.identity_jkt !== current.identityJkt || manifest.key_ids.pending !== current.pendingKeyId ||
              manifest.binding.pending_key_sha256 !== current.pendingKeySha256 || manifest.database.schema_head !== release.database.migration_head ||
              manifest.database.migration_checksums_sha256 !== release.database.migration_checksums_sha256) {
            throw new Error('BACKUP_INSPECTION_RELEASE_OR_BINDING_MISMATCH')
          }
        },
        inspectTrustStoreReadOnly: source.inspectPersistedTrustStoreReadOnly,
      }
      let repositoryInitialization: 'initialization_recorded' | 'needs_attention' = 'initialization_recorded'
      try { await assertInitializedRepository({ ...paths, assertLock }) }
      catch { await assertLock(); repositoryInitialization = 'needs_attention' }
      if (command.mode === 'list') {
        const result = await listDirectCustomerBackups(common, command)
        await assertLock()
        const journal = await readMaintenanceJournal(paths.journalDirectory)
        const maintenance = journal ? { backupSetId: journal.backupSetId,
          state: journal.phase === 'complete' ? 'restoration_recorded' as const : 'needs_attention' as const } : null
        // This operation does not create a stage. Any pre-existing entry in
        // dedicated tmpfs is left for inspection, never treated as a backup.
        let stagingNeedsAttention = false
        const directory = await opendir(paths.mountRoot)
        for await (const _entry of directory) { stagingNeedsAttention = true; break }
        await target.assertBound(); await assertLock()
        if (controller.signal.aborted) throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED')
        return { ...result, maintenance, stagingNeedsAttention, repositoryInitialization }
      }
      if (repositoryInitialization !== 'initialization_recorded') {
        await target.assertBound(); await assertLock()
        if (controller.signal.aborted) throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED')
        return { backupSetId: command.set, status: 'needs_attention' as const, createdAt: null, releaseId: null }
      }
      const options: TmpfsStagingOptions = { mountRoot: paths.mountRoot, backupSetId: randomUUID(), assertLock, assertSafeCleanup: safeCleanup }
      let created = false, unsafe = false, failure: unknown
      let result: Awaited<ReturnType<typeof inspectDirectCustomerBackup>> | undefined
      try {
        const scratchDirectory = await createTmpfsStaging(options, paths.minimumBytes)
        created = true
        const secure = async () => { await assertTmpfsStaging(options); await assertLock() }
        result = await inspectDirectCustomerBackup({ ...common, scratchDirectory, assertSecureStorage: secure }, command.set)
        await target.assertBound(); await assertLock()
        if (controller.signal.aborted) throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED')
      } catch (error) { failure = error; unsafe = error instanceof UnsafeMaintenanceRecoveryError || controller.signal.aborted }
      if (created && !unsafe) await removeTmpfsStaging(options)
      if (failure) throw failure
      if (!result) throw new Error('BACKUP_INSPECTION_INCOMPLETE')
      return result
    })
  } finally {
    signal.removeEventListener('abort', interrupt)
  }
}
