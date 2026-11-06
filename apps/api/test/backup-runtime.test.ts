import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { UnsafeMaintenanceRecoveryError } from '../src/backup/maintenance-errors.js'

const m = vi.hoisted(() => ({
  payload: vi.fn(), scratch: vi.fn(), assertPayload: vi.fn(), assertScratch: vi.fn(), remove: vi.fn(),
  quiesce: vi.fn(), capture: vi.fn(), publish: vi.fn(),
}))
vi.mock('../src/backup/tmpfs-staging.js', () => ({ createTmpfsPayload: m.payload, createTmpfsStaging: m.scratch,
  assertTmpfsPayload: m.assertPayload, assertTmpfsStaging: m.assertScratch, removeTmpfsStaging: m.remove }))
vi.mock('../src/backup/coordinator.js', () => ({ quiesceAndCapture: m.quiesce }))
vi.mock('../src/backup/capture-set.js', () => ({ captureUnpublishedSet: m.capture }))
vi.mock('../src/backup/publish-set.js', () => ({ publishCapturedSet: m.publish }))
import { runLocalBackupRuntime, type LocalBackupRuntimeInput } from '../src/backup/runtime.js'

const noop = async () => {}
function fixture(): LocalBackupRuntimeInput {
  return {
    snapshot: { deployment: 'a'.repeat(64), backupSetId: randomUUID(), services: [], roles: [] },
    adapter: { assertLock: vi.fn(noop), assertDeployment: vi.fn(noop), assertNoWriters: vi.fn(noop), assertRestorationSafe: vi.fn(noop),
      containerState: vi.fn(async () => 'stopped'), stopContainer: vi.fn(noop), startContainer: vi.fn(noop),
      roleLogin: vi.fn(async () => false), setRoleLogin: vi.fn(noop) },
    mountRoot: '/stage', minimumBytes: 1024n, journalDirectory: '/journal', publicationDirectory: '/publication',
    tarBinary: '/bin/tar', releaseId: 'fixture', images: { api: '', web: '', postgres: '', caddy: '' }, resticVersion: '0.19.1',
    repository: {} as LocalBackupRuntimeInput['repository'], assertTrustedDeployment: vi.fn(noop), assertSafeCleanup: vi.fn(noop),
    assertRestoredAndRelease: vi.fn(noop), verifyDumpBinding: vi.fn(noop), createCaptureOperations: vi.fn(() => ({ assertFence: vi.fn(noop), assertSecureStaging: vi.fn(noop),
      readEvidence: vi.fn(), captureDump: vi.fn(), captureVolume: vi.fn(), captureDeployment: vi.fn() })) as LocalBackupRuntimeInput['createCaptureOperations'],
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  m.payload.mockResolvedValue('/stage/payload')
  m.scratch.mockResolvedValue('/stage/scratch')
  m.assertPayload.mockResolvedValue(undefined)
  m.assertScratch.mockResolvedValue(undefined)
  m.remove.mockResolvedValue(undefined)
  m.capture.mockImplementation(async input => { await input.operations.assertSecureStaging(); await input.operations.assertFence(); return { backupSetId: input.backupSetId } })
  m.publish.mockImplementation(async input => { await input.assertSecureStorage(); await input.assertRestoredAndRelease({}); return { snapshotId: 'b'.repeat(64), status: 'verified' } })
  m.quiesce.mockImplementation(async (_directory, _snapshot, _adapter, capture, publish) => publish(await capture(), {}))
})

describe('unpublished internal backup runtime composition', () => {
  it('passes a marker-free payload and independently secured scratch through capture and publish', async () => {
    const input = fixture()
    const result = await runLocalBackupRuntime(input)
    expect(result.status).toBe('verified')
    expect(m.capture.mock.calls[0]?.[0].stagingDirectory).toBe('/stage/payload')
    expect(m.publish.mock.calls[0]?.[0].scratchParent).toBe('/stage/scratch')
    expect(input.adapter.assertNoWriters).toHaveBeenCalled()
    expect(input.assertTrustedDeployment).toHaveBeenCalledTimes(3)
    expect(m.remove).toHaveBeenCalledTimes(2)
    expect(m.remove.mock.calls[1]?.[0].backupSetId).toBe(input.snapshot.backupSetId)
  })
  it('leaves staging for inspection when cleanup of a dump cannot be verified', async () => {
    m.capture.mockRejectedValue(new UnsafeMaintenanceRecoveryError('DUMP_CLEANUP_UNVERIFIED'))
    await expect(runLocalBackupRuntime(fixture())).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
    expect(m.publish).not.toHaveBeenCalled()
    expect(m.remove).not.toHaveBeenCalled()
  })
  it('cleans owned staging on a verified ordinary failure but does not publish', async () => {
    m.capture.mockRejectedValue(new Error('fixture failure'))
    await expect(runLocalBackupRuntime(fixture())).rejects.toThrow('fixture failure')
    expect(m.publish).not.toHaveBeenCalled()
    expect(m.remove).toHaveBeenCalledTimes(2)
  })
  it('fails closed if cleanup is not provable', async () => {
    m.remove.mockRejectedValue(new Error('unsafe cleanup'))
    await expect(runLocalBackupRuntime(fixture())).rejects.toMatchObject({ code: 'SET_CLEANUP_UNVERIFIED' })
  })
  it('does not create staging when trusted deployment cannot be verified', async () => {
    const input = fixture()
    vi.mocked(input.assertTrustedDeployment).mockRejectedValue(new Error('untrusted deployment'))
    await expect(runLocalBackupRuntime(input)).rejects.toThrow('untrusted deployment')
    expect(m.payload).not.toHaveBeenCalled()
    expect(m.quiesce).not.toHaveBeenCalled()
    expect(m.publish).not.toHaveBeenCalled()
  })
  it('preserves staging if maintenance recovery is uncertain', async () => {
    m.quiesce.mockRejectedValue(new AggregateError([new Error('recovery failed')], 'maintenance uncertain'))
    await expect(runLocalBackupRuntime(fixture())).rejects.toThrow('maintenance uncertain')
    expect(m.remove).not.toHaveBeenCalled()
    expect(m.publish).not.toHaveBeenCalled()
  })
})
