import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { advanceMaintenanceJournal, createMaintenanceJournal, readMaintenanceJournal } from '../src/backup/journal.js'
import { recoverValidatedMaintenance } from '../src/backup/maintenance-recovery.js'
import type { QuiesceAdapter } from '../src/backup/coordinator.js'

let root: string, directory: string
const fingerprint = 'a'.repeat(64), api = 'b'.repeat(64), web = 'c'.repeat(64)
let services: Map<string, 'running' | 'stopped' | 'unknown'>, roles: Map<'aikayun_app' | 'aikayun_migrator', boolean | null>, adapter: QuiesceAdapter
const managed = [{ id: api, service: 'api' }, { id: web, service: 'web' }]
const helpers = vi.fn(async () => {})
const input = () => ({ journalDirectory: directory, deployment: fingerprint, managed, adapter, assertNoBackupHelpers: helpers })
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-maintenance-recovery-'))); directory = join(root, 'journal'); await mkdir(directory, { mode: 0o700 })
  services = new Map([[api, 'stopped'], [web, 'stopped']]); roles = new Map([['aikayun_app', false], ['aikayun_migrator', false]])
  helpers.mockReset(); helpers.mockResolvedValue(undefined)
  adapter = { assertLock: async () => {}, assertDeployment: async () => {}, assertNoWriters: async () => {}, assertRestorationSafe: async () => {},
    containerState: async id => services.get(id) ?? 'unknown', stopContainer: async id => { services.set(id, 'stopped') },
    startContainer: async id => { services.set(id, 'running') }, roleLogin: async name => roles.get(name) ?? null,
    setRoleLogin: async (name, allowed) => { roles.set(name, allowed) } }
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function stoppedJournal() {
  const record = await createMaintenanceJournal(directory, { deployment: fingerprint, backupSetId: randomUUID(),
    services: [{ name: 'api', containerId: api, running: true }, { name: 'web', containerId: web, running: false }],
    roles: [{ name: 'aikayun_app', canLogin: true }, { name: 'aikayun_migrator', canLogin: false }] })
  const stopping = await advanceMaintenanceJournal(directory, record, 'stopping')
  return advanceMaintenanceJournal(directory, stopping, 'stopped')
}
describe('maintenance-only recovery', () => {
  it('restores only the recorded service and role states, without treating it as a completed backup', async () => {
    const journal = await stoppedJournal()
    expect(await recoverValidatedMaintenance(input())).toEqual({ backupSetId: journal.backupSetId, state: 'restoration_recorded' })
    expect(services.get(api)).toBe('running'); expect(services.get(web)).toBe('stopped')
    expect(roles.get('aikayun_app')).toBe(true); expect(roles.get('aikayun_migrator')).toBe(false)
    expect((await readMaintenanceJournal(directory))?.phase).toBe('complete')
    expect(helpers).toHaveBeenCalledTimes(2)
  })
  it('refuses a missing journal, changed container set, or unknown detached helper before mutation', async () => {
    await expect(recoverValidatedMaintenance(input())).rejects.toThrow('BACKUP_MAINTENANCE_UNVERIFIED')
    await stoppedJournal()
    await expect(recoverValidatedMaintenance({ ...input(), managed: [{ id: api, service: 'api' }] })).rejects.toThrow('BACKUP_MAINTENANCE_UNVERIFIED')
    helpers.mockRejectedValueOnce(new Error('unidentified helper'))
    await expect(recoverValidatedMaintenance(input())).rejects.toThrow('unidentified helper')
    expect(services.get(api)).toBe('stopped'); expect(roles.get('aikayun_app')).toBe(false)
  })
  it('refuses prepared or partially stopped states that cannot arise from the recorded order', async () => {
    const record = await createMaintenanceJournal(directory, { deployment: fingerprint, backupSetId: randomUUID(),
      services: [{ name: 'api', containerId: api, running: true }, { name: 'web', containerId: web, running: true }],
      roles: [{ name: 'aikayun_app', canLogin: true }, { name: 'aikayun_migrator', canLogin: true }] })
    await expect(recoverValidatedMaintenance(input())).rejects.toThrow('Original state is uncertain')
    await advanceMaintenanceJournal(directory, record, 'stopping')
    services.set(api, 'running'); services.set(web, 'stopped'); roles.set('aikayun_app', true); roles.set('aikayun_migrator', true)
    await expect(recoverValidatedMaintenance(input())).rejects.toThrow('Stopping state is uncertain')
    services.set(api, 'stopped'); services.set(web, 'running'); roles.set('aikayun_app', false)
    await expect(recoverValidatedMaintenance(input())).rejects.toThrow('Stopping state is uncertain')
  })
  it('refuses partially restored roles or services outside the recorded order', async () => {
    const record = await createMaintenanceJournal(directory, { deployment: fingerprint, backupSetId: randomUUID(),
      services: [{ name: 'api', containerId: api, running: true }, { name: 'web', containerId: web, running: true }],
      roles: [{ name: 'aikayun_app', canLogin: true }, { name: 'aikayun_migrator', canLogin: true }] })
    const stopping = await advanceMaintenanceJournal(directory, record, 'stopping')
    const stopped = await advanceMaintenanceJournal(directory, stopping, 'stopped')
    await advanceMaintenanceJournal(directory, stopped, 'restoring')
    roles.set('aikayun_app', false); roles.set('aikayun_migrator', true)
    services.set(api, 'running'); services.set(web, 'stopped')
    await expect(recoverValidatedMaintenance(input())).rejects.toThrow('Restoring state is uncertain')
    // Recovery may have been interrupted after only the first service had
    // stopped, before the later original-running service was ever stopped.
    roles.set('aikayun_app', true); roles.set('aikayun_migrator', true)
    services.set(api, 'stopped'); services.set(web, 'running')
    await expect(recoverValidatedMaintenance(input())).resolves.toMatchObject({ state: 'restoration_recorded' })
  })
  it('rejects unexpected running containers, enabled roles and unknown observations', async () => {
    await stoppedJournal()
    services.set(api, 'running')
    await expect(recoverValidatedMaintenance(input())).rejects.toThrow('Container state is uncertain')
    services.set(api, 'stopped'); roles.set('aikayun_migrator', true)
    await expect(recoverValidatedMaintenance(input())).rejects.toThrow('Database role state is uncertain')
    roles.set('aikayun_migrator', false); services.set(web, 'unknown')
    await expect(recoverValidatedMaintenance(input())).rejects.toThrow('Container state is uncertain')
    expect((await readMaintenanceJournal(directory))?.phase).toBe('stopped')
  })
})
