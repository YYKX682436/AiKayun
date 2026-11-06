import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UnsafeMaintenanceRecoveryError } from '../src/backup/maintenance-errors.js'
const mocks = vi.hoisted(() => ({ source: vi.fn(), discover: vi.fn(), target: vi.fn(), adapter: vi.fn(), cleanup: vi.fn(), recover: vi.fn() }))
vi.mock('../src/backup/fixed-release-source.js', () => ({ loadFixedReleaseSource: mocks.source }))
vi.mock('../src/backup/fixed-discovery.js', () => ({ discoverFixedDeployment: mocks.discover }))
vi.mock('../src/backup/database-target.js', () => ({ withProvenProductionDatabaseTarget: mocks.target }))
vi.mock('../src/backup/docker-pg-fence.js', () => ({ productionDockerPgFence: mocks.adapter }))
vi.mock('../src/backup/fixed-cleanup-proof.js', () => ({ assertNoFixedBackupWriters: mocks.cleanup }))
vi.mock('../src/backup/maintenance-recovery.js', () => ({ recoverValidatedMaintenance: mocks.recover }))
import { runFixedMaintenanceRecovery } from '../src/backup/fixed-recovery.js'
const set = '12345678-1234-4234-8234-123456789abc'
let locked = true
const host = { assertOwnedLock: vi.fn(async () => { if (!locked) throw new Error('lock lost') }), verifyDeployment: vi.fn(async () => {}) }
const bound = vi.fn(async () => { await host.assertOwnedLock() })
beforeEach(() => {
  vi.resetAllMocks(); locked = true
  host.assertOwnedLock.mockImplementation(async () => { if (!locked) throw new Error('lock lost') }); host.verifyDeployment.mockResolvedValue(undefined)
  bound.mockImplementation(async () => { await host.assertOwnedLock() })
  mocks.source.mockResolvedValue({ fingerprint: 'a'.repeat(64), host, readAuthenticatedRelease: async () => ({
    postgresImage: 'fixed', backupResticImage: `ghcr.io/yykx682436/aikayun-backup-restic@sha256:${'e'.repeat(64)}`,
  }), databaseConfig: { host: 'db' } })
  mocks.discover.mockResolvedValue({ databaseContainerId: 'b'.repeat(64), managed: [{ id: 'c'.repeat(64), service: 'api' }] })
  mocks.target.mockImplementation(async (_input, callback) => callback({ db: 'pinned-fixture', assertBound: bound }))
  mocks.adapter.mockReturnValue('fence-fixture'); mocks.cleanup.mockResolvedValue(undefined)
})
describe('fixed maintenance-only recovery wiring', () => {
  it('uses signed fixed database, journal, helper and lock checks', async () => {
    mocks.recover.mockImplementation(async config => { await config.assertNoBackupHelpers(); return { backupSetId: set, state: 'restoration_recorded' } })
    await expect(runFixedMaintenanceRecovery(new AbortController().signal)).resolves.toEqual({ backupSetId: set, state: 'restoration_recorded' })
    expect(mocks.target).toHaveBeenCalledWith(expect.objectContaining({ database: 'aikayun', bootstrapUser: 'aikayun_bootstrap',
      databaseConfig: { host: 'db' }, postgresImage: 'fixed', containerId: 'b'.repeat(64), assertLock: expect.any(Function),
      assertSignedDeployment: expect.any(Function) }), expect.any(Function))
    expect(mocks.recover).toHaveBeenCalledWith(expect.objectContaining({ journalDirectory: '/var/lib/aikayun-backup/journal', deployment: 'a'.repeat(64), adapter: 'fence-fixture' }))
    expect(mocks.cleanup).toHaveBeenCalledWith('pinned-fixture')
  })
  it('rejects recovery when its active cleanup checkpoint loses the inherited lock', async () => {
    mocks.recover.mockImplementationOnce(async config => {
      locked = false
      await config.assertNoBackupHelpers()
    })
    await expect(runFixedMaintenanceRecovery(new AbortController().signal)).rejects.toThrow('lock lost')
    expect(host.assertOwnedLock).toHaveBeenCalled()
  }, 5000)
  it('fails on uncertain helper or an interrupted signal and never reports restoration', async () => {
    mocks.cleanup.mockRejectedValueOnce(new UnsafeMaintenanceRecoveryError('SET_CLEANUP_UNVERIFIED'))
    mocks.recover.mockImplementationOnce(async config => { await config.assertNoBackupHelpers() })
    await expect(runFixedMaintenanceRecovery(new AbortController().signal)).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
    const controller = new AbortController(); controller.abort()
    await expect(runFixedMaintenanceRecovery(controller.signal)).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
  })
})
