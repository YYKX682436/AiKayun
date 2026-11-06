import { discoverFixedDeployment } from './fixed-discovery.js'
import { loadFixedReleaseSource } from './fixed-release-source.js'
import { withProvenProductionDatabaseTarget } from './database-target.js'
import { productionDockerPgFence } from './docker-pg-fence.js'
import { assertNoFixedBackupWriters } from './fixed-cleanup-proof.js'
import { recoverValidatedMaintenance } from './maintenance-recovery.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'

/** Internal recovery of the maintenance fence only; this does not restore a
 * backup. The signed host helper acquires the same exclusive lock. */
export async function runFixedMaintenanceRecovery(signal: AbortSignal) {
  if (!signal || signal.aborted) throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED')
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  signal.addEventListener('abort', interrupt, { once: true })
  if (signal.aborted) interrupt()
  try {
    const source = await loadFixedReleaseSource(controller.signal)
    const release = await source.readAuthenticatedRelease(), found = await discoverFixedDeployment(source)
    const assertLock = () => source.host.assertOwnedLock()
    return await withProvenProductionDatabaseTarget({ databaseConfig: source.databaseConfig,
      containerId: found.databaseContainerId, postgresImage: release.postgresImage, database: 'aikayun', bootstrapUser: 'aikayun_bootstrap',
      assertLock, assertSignedDeployment: () => source.host.verifyDeployment(source.fingerprint) }, async target => {
      const adapter = productionDockerPgFence({
        deployment: source.fingerprint, managed: found.managed, db: target.db, host: source.host })
      const result = await recoverValidatedMaintenance({ journalDirectory: '/var/lib/aikayun-backup/journal', deployment: source.fingerprint,
        managed: found.managed, adapter, assertNoBackupHelpers: async () => { await target.assertBound(); await assertNoFixedBackupWriters(target.db); await assertLock() } })
        await target.assertBound(); await assertLock()
      if (controller.signal.aborted) throw new UnsafeMaintenanceRecoveryError('SET_FENCE_UNVERIFIED')
      return result
    })
  } finally {
    signal.removeEventListener('abort', interrupt)
  }
}
