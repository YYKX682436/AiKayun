import { discoverFixedDeployment } from './fixed-discovery.js'
import { loadFixedBackupPaths } from './fixed-backup-paths.js'
import { loadFixedReleaseSource } from './fixed-release-source.js'
import { runProductionBackupRuntime } from './production-runtime.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import { assertNoUncertainBackupState } from './fixed-create-gate.js'

/** Invoke from the signed API helper while the parent host command owns the
 * exclusive deployment lock and brokers all Docker operations over stdio. */
export async function runFixedProductionBackup(signal: AbortSignal, onStarted: (backupSetId: string) => Promise<void>) {
  if (!signal || signal.aborted || typeof onStarted !== 'function') throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED')
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  signal.addEventListener('abort', interrupt, { once: true })
  if (signal.aborted) interrupt()
  try {
    const source = await loadFixedReleaseSource(controller.signal)
    const release = await source.readAuthenticatedRelease()
    const paths = await loadFixedBackupPaths(controller.signal, release.backupResticImage, () => source.host.assertOwnedLock())
    await assertNoUncertainBackupState({ ...paths, assertLock: () => source.host.assertOwnedLock() })
    const discovered = await discoverFixedDeployment(source)
    await source.host.assertOwnedLock()
    const snapshot = discovered.snapshot
    await onStarted(snapshot.backupSetId)
    await source.host.assertOwnedLock()
    if (controller.signal.aborted) throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED')
    const result = await runProductionBackupRuntime({ ...paths, snapshot, releaseId: release.releaseId,
      backupResticImage: release.backupResticImage,
      images: release.images, resticVersion: '0.19.1', signal: controller.signal, databaseConfig: source.databaseConfig,
      inspectTrustStoreReadOnly: source.inspectTrustStoreReadOnly,
      inspectTrustStorePersistedReadOnly: source.inspectPersistedTrustStoreReadOnly,
      fence: { deployment: source.fingerprint, managed: discovered.managed, host: source.host },
      dump: { containerId: discovered.databaseContainerId, database: 'aikayun', user: 'aikayun_bootstrap', signal: controller.signal },
      volumes: { postgresImage: release.postgresImage, signal: controller.signal },
      deployment: { deploymentRoot: '/opt/aikayun', signal: controller.signal },
      paymentKeys: source.paymentKeys, deliveryKeys: source.deliveryKeys,
      assertTrustedDeployment: () => source.host.verifyDeployment(source.fingerprint), readAuthenticatedRelease: source.readAuthenticatedRelease,
      async assertSafeCleanup() { await source.host.assertOwnedLock() },
      async assertRestoredAndRelease(journal) {
        if (journal.phase !== 'complete' || journal.backupSetId !== snapshot.backupSetId || journal.deployment !== source.fingerprint ||
            JSON.stringify(journal.services) !== JSON.stringify(snapshot.services) || JSON.stringify(journal.roles) !== JSON.stringify(snapshot.roles)) {
          throw new Error('BACKUP_RESTORATION_UNVERIFIED')
        }
        await source.host.verifyDeployment(source.fingerprint)
      },
    })
    await source.host.assertOwnedLock()
    if (controller.signal.aborted) throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED')
    return { ...result, backupSetId: snapshot.backupSetId }
  } finally {
    signal.removeEventListener('abort', interrupt)
  }
}
