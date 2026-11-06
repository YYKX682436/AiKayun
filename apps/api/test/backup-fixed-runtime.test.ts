import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ source: vi.fn(), paths: vi.fn(), gate: vi.fn(), discover: vi.fn(), runtime: vi.fn() }))
vi.mock('../src/backup/fixed-release-source.js', () => ({ loadFixedReleaseSource: mocks.source }))
vi.mock('../src/backup/fixed-backup-paths.js', () => ({ loadFixedBackupPaths: mocks.paths }))
vi.mock('../src/backup/fixed-create-gate.js', () => ({ assertNoUncertainBackupState: mocks.gate }))
vi.mock('../src/backup/fixed-discovery.js', () => ({ discoverFixedDeployment: mocks.discover }))
vi.mock('../src/backup/production-runtime.js', () => ({ runProductionBackupRuntime: mocks.runtime }))
import { runFixedProductionBackup } from '../src/backup/fixed-runtime.js'

beforeEach(() => { vi.resetAllMocks(); mocks.gate.mockResolvedValue(undefined) })
describe('fixed runtime lock interruption', () => {
  it('wires fixed signed identity, storage, DB and volume inputs into the production coordinator', async () => {
    const host = { assertOwnedLock: vi.fn(async () => {}), verifyDeployment: vi.fn(async () => {}) }
    const release = { releaseId: 'signed-fixture', images: { api: 'a', web: 'b', postgres: 'c', caddy: 'd' },
      backupResticImage: `ghcr.io/yykx682436/aikayun-backup-restic@sha256:${'e'.repeat(64)}`, postgresImage: 'fixed-image' }
    const source = { fingerprint: 'a'.repeat(64), host, readAuthenticatedRelease: vi.fn(async () => release),
      databaseConfig: { host: 'db' }, paymentKeys: { id: 'payment' }, deliveryKeys: { id: 'delivery' } }
    const paths = { mountRoot: '/fixed/staging', journalDirectory: '/fixed/journal', publicationDirectory: '/fixed/publications',
      minimumBytes: 1n, repository: {} }
    const snapshot = { backupSetId: 'set', services: [], roles: [] }
    mocks.source.mockResolvedValueOnce(source); mocks.paths.mockResolvedValueOnce(paths)
    mocks.discover.mockResolvedValueOnce({ snapshot, managed: [{ id: 'id', service: 'api' }], databaseContainerId: 'db-id' })
    mocks.runtime.mockResolvedValueOnce({ snapshotId: 'snapshot', status: 'verified' })
    await expect(runFixedProductionBackup(new AbortController().signal, async () => {})).resolves.toEqual({ snapshotId: 'snapshot', status: 'verified', backupSetId: 'set' })
    expect(mocks.runtime).toHaveBeenCalledWith(expect.objectContaining({ ...paths, snapshot, releaseId: 'signed-fixture', images: release.images,
      backupResticImage: release.backupResticImage,
      databaseConfig: source.databaseConfig, dump: expect.objectContaining({ containerId: 'db-id', database: 'aikayun', user: 'aikayun_bootstrap' }),
      volumes: expect.objectContaining({ postgresImage: 'fixed-image' }),
      deployment: expect.objectContaining({ deploymentRoot: '/opt/aikayun' }),
      paymentKeys: source.paymentKeys, deliveryKeys: source.deliveryKeys }))
    expect(host.assertOwnedLock).toHaveBeenCalled()
  })
  it('rejects an unresolved earlier attempt before choosing or reporting a new set', async () => {
    const source = { fingerprint: 'a'.repeat(64), host: { assertOwnedLock: vi.fn(async () => {}), verifyDeployment: vi.fn(async () => {}) },
      readAuthenticatedRelease: vi.fn(async () => ({ releaseId: 'fixture', images: {}, backupResticImage: 'fixture', postgresImage: 'fixture' })) }
    mocks.source.mockResolvedValueOnce(source); mocks.paths.mockResolvedValueOnce({})
    mocks.gate.mockRejectedValueOnce(new Error('BACKUP_PREVIOUS_ATTEMPT_REQUIRES_REVIEW'))
    const announce = vi.fn(async () => {})
    await expect(runFixedProductionBackup(new AbortController().signal, announce)).rejects.toThrow('BACKUP_PREVIOUS_ATTEMPT_REQUIRES_REVIEW')
    expect(mocks.discover).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled(); expect(announce).not.toHaveBeenCalled()
  })
  it('never starts capture if the set ID cannot be reported to the caller', async () => {
    const source = { fingerprint: 'a'.repeat(64), host: { assertOwnedLock: vi.fn(async () => {}), verifyDeployment: vi.fn(async () => {}) },
      readAuthenticatedRelease: vi.fn(async () => ({ releaseId: 'fixture', images: {}, backupResticImage: 'fixture', postgresImage: 'fixture' })),
      databaseConfig: {}, paymentKeys: {}, deliveryKeys: {} }
    mocks.source.mockResolvedValueOnce(source); mocks.paths.mockResolvedValueOnce({})
    mocks.discover.mockResolvedValueOnce({ snapshot: { backupSetId: 'set', services: [], roles: [] }, managed: [], databaseContainerId: 'fixture' })
    await expect(runFixedProductionBackup(new AbortController().signal, async () => { throw new Error('closed pipe') })).rejects.toThrow('closed pipe')
    expect(mocks.runtime).not.toHaveBeenCalled()
  })
  it('rejects cleanup when the inherited lock proof is lost during the operation', async () => {
    const assertOwnedLock = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValue(new Error('lock lost'))
    const source = { fingerprint: 'a'.repeat(64), host: { assertOwnedLock, verifyDeployment: vi.fn(async () => {}) },
      readAuthenticatedRelease: vi.fn(async () => ({ releaseId: 'fixture', images: {}, backupResticImage: 'fixture', postgresImage: 'fixture' })),
      databaseConfig: {}, paymentKeys: {}, deliveryKeys: {} }
    mocks.source.mockResolvedValueOnce(source)
    mocks.paths.mockResolvedValueOnce({})
    mocks.discover.mockResolvedValueOnce({ snapshot: { backupSetId: 'fixture', services: [], roles: [] }, managed: [], databaseContainerId: 'fixture' })
    mocks.runtime.mockImplementationOnce(async input => {
      await input.assertSafeCleanup()
      return { snapshotId: 'unreachable', status: 'verified' }
    })
    await expect(runFixedProductionBackup(new AbortController().signal, async () => {})).rejects.toThrow('lock lost')
    expect(assertOwnedLock).toHaveBeenCalledTimes(3)
    expect(mocks.runtime).toHaveBeenCalledOnce()
  }, 5000)
})
