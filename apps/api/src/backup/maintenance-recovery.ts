import type { DockerPgFenceConfiguration } from './docker-pg-fence.js'
import { recoverMaintenance, type QuiesceAdapter } from './coordinator.js'
import { archiveCompletedMaintenanceJournal, readMaintenanceJournal } from './journal.js'

/** Internal only: proves exact recorded container identities and absence of
 * detached backup helpers before restoring their original running/login state.
 * It never restores a DB, a backup archive, or a volume. */
export async function recoverValidatedMaintenance(input: {
  journalDirectory: string; deployment: string; managed: DockerPgFenceConfiguration['managed']; adapter: QuiesceAdapter
  assertNoBackupHelpers(): Promise<void>
}) {
  await input.adapter.assertLock()
  const journal = await readMaintenanceJournal(input.journalDirectory)
  if (!journal) throw new Error('BACKUP_MAINTENANCE_UNVERIFIED')
  if (journal.phase === 'complete') {
    await archiveCompletedMaintenanceJournal(input.journalDirectory, journal, () => input.adapter.assertLock())
    return { backupSetId: journal.backupSetId, state: 'restoration_recorded' as const }
  }
  if (journal.deployment !== input.deployment) throw new Error('BACKUP_MAINTENANCE_UNVERIFIED')
  await input.adapter.assertDeployment(input.deployment)
  const recorded = journal.services.map(item => `${item.name}:${item.containerId}`).sort()
  const actual = input.managed.map(item => `${item.service}:${item.id}`).sort()
  if (recorded.length !== actual.length || recorded.some((item, index) => item !== actual[index])) throw new Error('BACKUP_MAINTENANCE_UNVERIFIED')
  await input.assertNoBackupHelpers()
  await input.adapter.assertLock()
  await recoverMaintenance(input.journalDirectory, input.adapter)
  await input.assertNoBackupHelpers()
  await input.adapter.assertLock()
  const complete = await readMaintenanceJournal(input.journalDirectory)
  if (!complete || complete.phase !== 'complete' || complete.deployment !== journal.deployment || complete.backupSetId !== journal.backupSetId ||
      JSON.stringify(complete.services) !== JSON.stringify(journal.services) || JSON.stringify(complete.roles) !== JSON.stringify(journal.roles)) {
    throw new Error('BACKUP_MAINTENANCE_UNVERIFIED')
  }
  return { backupSetId: complete.backupSetId, state: 'restoration_recorded' as const }
}
