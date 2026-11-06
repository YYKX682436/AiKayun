import { loadFixedReleaseSource } from './fixed-release-source.js'
import { loadFixedBackupPaths } from './fixed-backup-paths.js'
import { initializeEmptyRepository } from './repository-initialization.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'

/** Internal only. Existing independently provisioned password, signed release,
 * inherited lock, private directories and dedicated noswap tmpfs are required. */
export async function runFixedRepositoryInitialization(signal: AbortSignal) {
  if (!signal || signal.aborted) throw new UnsafeMaintenanceRecoveryError('REPOSITORY_INIT_UNCERTAIN')
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  signal.addEventListener('abort', interrupt, { once: true })
  if (signal.aborted) interrupt()
  try {
    const source = await loadFixedReleaseSource(controller.signal)
    const release = await source.readAuthenticatedRelease()
    const paths = await loadFixedBackupPaths(controller.signal, release.backupResticImage, () => source.host.assertOwnedLock())
    await initializeEmptyRepository({ ...paths, assertLock: () => source.host.assertOwnedLock() })
    await source.host.assertOwnedLock()
    if (controller.signal.aborted) throw new UnsafeMaintenanceRecoveryError('REPOSITORY_INIT_UNCERTAIN')
    return { state: 'initialized' as const }
  } finally {
    signal.removeEventListener('abort', interrupt)
  }
}
