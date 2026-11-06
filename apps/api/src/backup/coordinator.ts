import { advanceMaintenanceJournal, archiveCompletedMaintenanceJournal, createMaintenanceJournal, readMaintenanceJournal, type MaintenanceJournal } from './journal.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'

type RoleName = MaintenanceJournal['roles'][number]['name']
type Snapshot = Omit<MaintenanceJournal, 'version' | 'phase' | 'updatedAt'>

/** Every adapter method must fail on uncertainty. The caller owns the exclusive
 * deployment lock and must prevent non-cooperating writers at the host boundary. */
export interface QuiesceAdapter {
  assertLock(): Promise<void>
  assertDeployment(expected: string): Promise<void>
  assertNoWriters(): Promise<void>
  assertRestorationSafe(): Promise<void>
  containerState(id: string): Promise<'running' | 'stopped' | 'unknown'>
  stopContainer(id: string): Promise<void>
  startContainer(id: string): Promise<void>
  roleLogin(name: RoleName): Promise<boolean | null>
  setRoleLogin(name: RoleName, allowed: boolean): Promise<void>
}

async function assertOriginal(journal: MaintenanceJournal, adapter: QuiesceAdapter) {
  for (const service of journal.services) {
    if (await adapter.containerState(service.containerId) !== (service.running ? 'running' : 'stopped')) throw new Error('Original container state changed')
  }
  for (const role of journal.roles) {
    if (await adapter.roleLogin(role.name) !== role.canLogin) throw new Error('Original database role state changed')
  }
}

/** Explicit recovery can be called after process death; never assumes a backup exists. */
export async function recoverMaintenance(directory: string, adapter: QuiesceAdapter): Promise<void> {
  await adapter.assertLock()
  let journal = await readMaintenanceJournal(directory)
  if (!journal) throw new Error('Maintenance journal is missing')
  await adapter.assertDeployment(journal.deployment)
  if (journal.phase === 'complete') { await assertOriginal(journal, adapter); return }
  await adapter.assertRestorationSafe()
  // Inspect every original identity before any restoration. Original stopped
  // containers or NOLOGIN roles may not have become enabled independently.
  const serviceStates: ('running' | 'stopped')[] = []
  for (const service of journal.services) {
    const state = await adapter.containerState(service.containerId)
    if (state === 'unknown' || (!service.running && state !== 'stopped')) throw new Error('Container state is uncertain')
    if (service.running) serviceStates.push(state)
  }
  const roleStates: boolean[] = []
  for (const role of journal.roles) {
    const login = await adapter.roleLogin(role.name)
    if (login === null || (!role.canLogin && login)) throw new Error('Database role state is uncertain')
    if (role.canLogin) roleStates.push(login)
  }
  // Permit only prefixes reachable by this exact stop/restore order. A
  // manually changed service or role is not an interrupted command result.
  const prefix = <T>(items: readonly T[], first: T, second: T) => {
    let following = false
    for (const item of items) {
      if (item === second) following = true
      else if (item !== first || following) return false
    }
    return true
  }
  if (journal.phase === 'prepared' && (serviceStates.some(state => state !== 'running') || roleStates.some(login => !login))) {
    throw new Error('Original state is uncertain')
  }
  if (journal.phase === 'stopping' && (!prefix(serviceStates, 'stopped', 'running') || !prefix(roleStates, false, true) ||
      (roleStates.some(login => !login) && serviceStates.some(state => state !== 'stopped')))) throw new Error('Stopping state is uncertain')
  if ((journal.phase === 'stopped' || journal.phase === 'captured') && serviceStates.some(state => state !== 'stopped')) throw new Error('Container state is uncertain')
  if ((journal.phase === 'stopped' || journal.phase === 'captured') && roleStates.some(login => login)) throw new Error('Database role state is uncertain')
  // Recovery may begin after a partially completed stop. Resuming in the
  // same order permits one contiguous block of still-stopped services/roles,
  // with untouched original-running entries after that block.
  const oneBlock = <T>(items: readonly T[], blocked: T) => {
    let inBlock = false, ended = false
    for (const item of items) {
      if (item === blocked) { if (ended) return false; inBlock = true }
      else if (inBlock) ended = true
    }
    return true
  }
  if (journal.phase === 'restoring' && (!oneBlock(roleStates, false) || !oneBlock(serviceStates, 'stopped') ||
      (serviceStates.some(state => state === 'running') && roleStates.some(login => !login)))) throw new Error('Restoring state is uncertain')
  if (journal.phase !== 'restoring') {
    await adapter.assertLock()
    journal = await advanceMaintenanceJournal(directory, journal, 'restoring')
  }
  for (const role of journal.roles) {
    if (role.canLogin && await adapter.roleLogin(role.name) === false) {
      await adapter.assertLock()
      await adapter.setRoleLogin(role.name, true)
      if (await adapter.roleLogin(role.name) !== true) throw new Error('Database role restoration uncertain')
    }
  }
  for (const service of journal.services) {
    if (service.running && await adapter.containerState(service.containerId) === 'stopped') {
      await adapter.assertLock()
      await adapter.startContainer(service.containerId)
      if (await adapter.containerState(service.containerId) !== 'running') throw new Error('Container restoration uncertain')
    }
  }
  await adapter.assertLock()
  await adapter.assertDeployment(journal.deployment)
  await assertOriginal(journal, adapter)
  await advanceMaintenanceJournal(directory, journal, 'complete')
}

/** capture creates only an unpublished staging set under the writer fence.
 * publish may expose a complete set only after original state is verified.
 * Callers must not publish a complete set inside capture. */
export async function quiesceAndCapture<T, R>(directory: string, snapshot: Snapshot, adapter: QuiesceAdapter,
  capture: () => Promise<T>, publish: (staged: T, maintenance: MaintenanceJournal) => Promise<R>): Promise<R> {
  await adapter.assertLock()
  await adapter.assertDeployment(snapshot.deployment)
  const previous = await readMaintenanceJournal(directory)
  if (previous?.phase === 'complete') {
    await adapter.assertDeployment(previous.deployment)
    if (previous.deployment !== snapshot.deployment) throw new Error('Previous maintenance deployment changed')
    await assertOriginal(previous, adapter)
    await archiveCompletedMaintenanceJournal(directory, previous, () => adapter.assertLock())
  }
  let journal = await createMaintenanceJournal(directory, snapshot)
  let mutationAttempted = false
  let staged: T
  try {
    await assertOriginal(journal, adapter)
    await adapter.assertLock()
    journal = await advanceMaintenanceJournal(directory, journal, 'stopping')
    for (const service of journal.services) {
      if (!service.running) continue
      await adapter.assertLock()
      mutationAttempted = true
      await adapter.stopContainer(service.containerId)
      if (await adapter.containerState(service.containerId) !== 'stopped') throw new Error('Container stop uncertain')
    }
    for (const role of journal.roles) {
      if (!role.canLogin) continue
      await adapter.assertLock()
      mutationAttempted = true
      await adapter.setRoleLogin(role.name, false)
      if (await adapter.roleLogin(role.name) !== false) throw new Error('Database role fence uncertain')
    }
    await adapter.assertLock()
    await adapter.assertNoWriters()
    journal = await advanceMaintenanceJournal(directory, journal, 'stopped')
    staged = await capture()
    await adapter.assertLock()
    await adapter.assertNoWriters()
    await advanceMaintenanceJournal(directory, journal, 'captured')
    await recoverMaintenance(directory, adapter)
  } catch (error) {
    // An active or unidentifiable dump may still hold a DB session after the
    // Docker client dies; keep the fence and journal for explicit inspection.
    if (error instanceof UnsafeMaintenanceRecoveryError) throw error
    if (!mutationAttempted) throw error
    try { await recoverMaintenance(directory, adapter) }
    catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Backup and maintenance recovery did not complete', { cause: recoveryError }) }
    throw error
  }
  await adapter.assertLock()
  await adapter.assertDeployment(snapshot.deployment)
  const completed = await readMaintenanceJournal(directory)
  if (!completed || completed.phase !== 'complete' || completed.backupSetId !== snapshot.backupSetId ||
      completed.deployment !== snapshot.deployment) throw new Error('Maintenance completion uncertain')
  await assertOriginal(completed, adapter)
  await adapter.assertLock()
  return publish(staged, completed)
}
