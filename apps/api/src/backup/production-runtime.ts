import { matchesBackupPostgresImage } from './postgres-image.js'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { PoolConfig } from 'pg'
import type { Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import type { ReadonlyTrustBundleInspection } from '../licensing/trust/trust-bundle-store.js'
import { assertPendingKeyReferences, readBackupKeyReferences } from './key-references.js'
import { readBackupDatabaseMetadata } from './database-metadata.js'
import { readBackupPendingSummary } from './pending-summary.js'
import { withProvenProductionDatabaseTarget } from './database-target.js'
import { productionDockerPgFence, type DockerPgFenceConfiguration } from './docker-pg-fence.js'
import { assertNoFixedBackupWriters } from './fixed-cleanup-proof.js'
import { verifyPostgresDumpBinding, capturePostgresDump } from './pg-dump.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import { quiesceAndCapture } from './coordinator.js'
import { captureDirectUnpublishedSet } from './direct-capture-set.js'
import { publishDirectCapturedSet } from './direct-publish-set.js'
import { verifyDirectSourceSnapshot } from './direct-source-inspection.js'
import { DirectResticVolumeReader } from './restic-container.js'
import { assertTmpfsPayload, assertTmpfsStaging, createTmpfsPayload, createTmpfsStaging, removeTmpfsStaging,
  type TmpfsStagingOptions } from './tmpfs-staging.js'
import type { CaptureOperationsInput } from './capture-operations.js'
import type { LocalBackupRuntimeInput } from './runtime.js'

/** Production composition used only from the signed, lock-holding helper. The
 * host must supply an installer-owned deployment verifier and lock proof. */
export type ProductionBackupRuntimeInput = Omit<LocalBackupRuntimeInput,
  'adapter' | 'createCaptureOperations' | 'verifyDumpBinding' | 'inspectTrustStoreReadOnly' | 'tarBinary'> &
  Omit<CaptureOperationsInput, 'db' | 'stagingDirectory' | 'assertFence' | 'assertSecureStaging' | 'tarBinary' | 'inspectTrustStoreReadOnly' | 'volumes'> & {
    volumes: Omit<CaptureOperationsInput['volumes'], 'dockerBinary' | 'dockerSocket'> & { dockerBinary?: string; dockerSocket?: string }
    backupResticImage: string
    fence: Omit<DockerPgFenceConfiguration, 'project' | 'stateVolumes' | 'db'>
    databaseConfig: PoolConfig
    inspectTrustStoreReadOnly(directory: string, db: Kysely<Database>): Promise<ReadonlyTrustBundleInspection>
    inspectTrustStorePersistedReadOnly(directory: string): Promise<ReadonlyTrustBundleInspection>
  }

export async function runProductionBackupRuntime(input: ProductionBackupRuntimeInput): Promise<{ snapshotId: string; status: 'verified' }> {
  const hostBroker = process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1'
  let diagnosticPhase = 'database_target'
  const dockerPathsMatch = input?.dump?.dockerBinary === input?.volumes?.dockerBinary && input?.dump?.dockerSocket === input?.volumes?.dockerSocket &&
    input?.dump?.dockerBinary === input?.fence?.dockerBinary && input?.dump?.dockerSocket === input?.fence?.dockerSocket
  if (!input || typeof input.assertTrustedDeployment !== 'function' || typeof input.readAuthenticatedRelease !== 'function' ||
      !input.paymentKeys || !input.deliveryKeys || !input.volumes || !input.deployment || !input.images || !input.dump || !input.fence || !input.fence.host || !input.databaseConfig ||
      typeof input.inspectTrustStorePersistedReadOnly !== 'function' ||
      !/^ghcr\.io\/yykx682436\/aikayun-backup-restic@sha256:[a-f0-9]{64}$/.test(input.backupResticImage) ||
      input.dump.user !== 'aikayun_bootstrap' || input.fence.deployment !== input.snapshot.deployment ||
      (!hostBroker && !dockerPathsMatch) ||
      !matchesBackupPostgresImage(input.volumes.postgresImage, input.images.postgres)) {
    throw new Error('BACKUP_CAPTURE_AUTHORITY_MISSING')
  }
  try {
  return await withProvenProductionDatabaseTarget({ databaseConfig: input.databaseConfig,
    ...(input.dump.dockerBinary ? { dockerBinary: input.dump.dockerBinary } : {}), ...(input.dump.dockerSocket ? { dockerSocket: input.dump.dockerSocket } : {}),
    containerId: input.dump.containerId, postgresImage: input.volumes.postgresImage, database: input.dump.database,
    bootstrapUser: input.dump.user, assertLock: () => input.fence.host.assertOwnedLock(),
    async assertSignedDeployment() {
      await input.fence.host.verifyDeployment(input.snapshot.deployment)
      await input.assertTrustedDeployment()
    } }, async target => {
    diagnosticPhase = 'database_fence'
    const adapter = productionDockerPgFence({ ...input.fence, db: target.db })
    const lock = async () => { await input.fence.host.assertOwnedLock(); await target.assertBound() }
    const assertSafeCleanup = async () => { await lock(); await assertNoFixedBackupWriters(target.db); await input.assertSafeCleanup() }
    const securePayload = (options: TmpfsStagingOptions) => async () => { await assertTmpfsPayload(options) }
    const startedAt = new Date().toISOString()
    const payloadOptions: TmpfsStagingOptions = { mountRoot: input.mountRoot, backupSetId: input.snapshot.backupSetId,
      assertLock: lock, assertSafeCleanup }
    const scratchOptions: TmpfsStagingOptions = { mountRoot: input.mountRoot, backupSetId: randomUUID(),
      assertLock: lock, assertSafeCleanup }
    let payloadCreated = false, scratchCreated = false, unsafe = false
    let failure: unknown
    let result: { snapshotId: string; status: 'verified' } | undefined
    try {
      diagnosticPhase = 'staging'
      await lock()
      await target.assertBound()
      const payload = await createTmpfsPayload(payloadOptions, input.minimumBytes)
      payloadCreated = true
      const scratch = await createTmpfsStaging(scratchOptions, 1n)
      scratchCreated = true
      const secureStorage = async () => {
        await assertTmpfsPayload(payloadOptions)
        await assertTmpfsStaging(scratchOptions)
      }
      const assertFence = async () => {
        await lock()
        await adapter.assertNoWriters()
        await secureStorage()
      }
      const readRelease = async () => {
        await lock()
        const release = await input.readAuthenticatedRelease()
        if (!release || release.releaseId !== input.releaseId || !release.images || release.backupResticImage !== input.backupResticImage ||
            (['api', 'web', 'postgres', 'caddy'] as const).some(name => release.images[name] !== input.images[name])) {
          throw new Error('BACKUP_CAPTURE_RELEASE_UNVERIFIED')
        }
        return release
      }
      const readDatabaseEvidence = async () => {
        await assertFence()
        const release = await readRelease()
        const database = await readBackupDatabaseMetadata(target.db, release.database, release.signedChecksums, release.compiledChecksums)
        await assertPendingKeyReferences(target.db, database.pendingKeyId)
        const keys = await readBackupKeyReferences(target.db, input.paymentKeys!, input.deliveryKeys!)
        const unresolved = await readBackupPendingSummary(target.db)
        await assertFence()
        return { database, keys, unresolved }
      }
      diagnosticPhase = 'capture_and_restore'
      result = await quiesceAndCapture(input.journalDirectory, input.snapshot, adapter,
        () => captureDirectUnpublishedSet({ backupSetId: input.snapshot.backupSetId, stagingDirectory: payload, createdAt: startedAt,
          ...(input.signal ? { signal: input.signal } : {}), operations: {
            assertFence,
            assertSecureStaging: secureStorage,
            readDatabaseEvidence,
            async captureDump() {
              await assertFence(); await readRelease()
              return capturePostgresDump({ ...input.dump, stagingDirectory: payload, assertSecureStaging: secureStorage })
            },
            async verifyDumpBinding(metadata) {
              await assertFence()
              await verifyPostgresDumpBinding({ ...input.dump, stagingDirectory: payload, assertSecureStaging: secureStorage }, metadata)
              await assertFence()
            },
            async captureSourceSnapshot(backupSetId) {
              await assertFence()
              await readRelease()
              const storage = input.repository.storagePaths()
              const reader = await DirectResticVolumeReader.create({
                ...(input.volumes.dockerBinary ? { dockerBinary: input.volumes.dockerBinary } : {}),
                ...(input.volumes.dockerSocket ? { dockerSocket: input.volumes.dockerSocket } : {}),
                image: input.backupResticImage, repositoryDirectory: storage.repository, passwordFile: storage.passwordFile,
                stagingDirectory: dirname(payload), deploymentRoot: input.deployment.deploymentRoot, backupSetId,
                assertLock: lock, ...(input.signal ? { signal: input.signal } : {}),
              })
              const summary = await reader.backup()
              const snapshots = await input.repository.snapshotsForRole(backupSetId, 'source')
              if (snapshots.length !== 1 || !snapshots[0]!.startsWith(summary.snapshotId)) throw new Error('BACKUP_SOURCE_SNAPSHOT_INVALID')
              await assertFence()
              return snapshots[0]!
            },
            async inspectSourceSnapshot({ snapshot, dump, database, keys }) {
              await assertFence()
              await readRelease()
              const verified = await verifyDirectSourceSnapshot({ repo: input.repository, set: input.snapshot.backupSetId, snapshot,
                scratch, databaseDump: dump, database, keys, appUid: 1000, appGid: 1000,
                inspectTrustStoreReadOnly: directory => input.inspectTrustStoreReadOnly(directory, target.db), assertLock: lock,
                ...(input.signal ? { signal: input.signal } : {}) })
              await assertFence()
              return verified
            },
          } }),
        async staged => {
          diagnosticPhase = 'publish'
          return publishDirectCapturedSet({ staged, stagingDirectory: payload, manifestDirectory: join(dirname(payload), 'manifest'), scratchDirectory: scratch,
          journalDirectory: input.journalDirectory, publicationDirectory: input.publicationDirectory,
          repository: input.repository, releaseId: input.releaseId, images: input.images, resticVersion: input.resticVersion,
          assertLock: lock,
          async assertSecureStorage() { await secureStorage() },
          async assertRestoredAndRelease(journal) {
            await target.assertBound()
            await adapter.assertDeployment(input.snapshot.deployment)
            for (const service of journal.services) {
              if (await adapter.containerState(service.containerId) !== (service.running ? 'running' : 'stopped')) throw new Error('BACKUP_RESTORATION_UNVERIFIED')
            }
            for (const role of journal.roles) if (await adapter.roleLogin(role.name) !== role.canLogin) throw new Error('BACKUP_RESTORATION_UNVERIFIED')
            await input.assertRestoredAndRelease(journal)
          },
          async verifyDumpBinding(directory, metadata) {
            await target.assertBound()
            await verifyPostgresDumpBinding({ ...input.dump, stagingDirectory: directory, assertSecureStaging: securePayload(payloadOptions) }, metadata)
          },
          inspectTrustStorePersistedReadOnly: input.inspectTrustStorePersistedReadOnly,
          ...(input.signal ? { signal: input.signal } : {}),
        })
        })
    } catch (error) {
      failure = error
      unsafe = error instanceof UnsafeMaintenanceRecoveryError || error instanceof AggregateError
    }
    if (!unsafe) {
      try {
        diagnosticPhase = 'cleanup'
        if (scratchCreated) await removeTmpfsStaging(scratchOptions)
        if (payloadCreated) await removeTmpfsStaging(payloadOptions)
      } catch { throw new UnsafeMaintenanceRecoveryError('SET_CLEANUP_UNVERIFIED') }
    }
    if (failure) throw failure
    if (!result) throw new Error('BACKUP_RUNTIME_INCOMPLETE')
    return result
  })
  } catch (error) {
    // Raw causes can include database or provider output; preserve only the allowlisted error code.
    // eslint-disable-next-line preserve-caught-error
    if (error instanceof UnsafeMaintenanceRecoveryError) throw new Error(error.code)
    // eslint-disable-next-line preserve-caught-error
    if (error instanceof AggregateError) throw new Error('BACKUP_MAINTENANCE_RECOVERY_UNVERIFIED')
    const candidates = error && typeof error === 'object'
      ? [
        'operationCode' in error && typeof error.operationCode === 'string' ? error.operationCode : '',
        'message' in error && typeof error.message === 'string' ? error.message : '',
      ]
      : []
    const safeCode = candidates.find(candidate => /^(?:BACKUP|RESTIC|REPOSITORY|STAGING|DEPLOYMENT|INSTALLER|LICENSE|TRUST|DATABASE|PAYMENT|DELIVERY|SET|FENCE|ARCHIVE|DUMP)_[A-Z0-9_]{1,80}$/u.test(candidate))
    // eslint-disable-next-line preserve-caught-error
    if (safeCode) throw new Error(safeCode)
    const code = `BACKUP_RUNTIME_${diagnosticPhase.toUpperCase()}_FAILED`
    // eslint-disable-next-line preserve-caught-error
    throw new Error(code)
  }
}
