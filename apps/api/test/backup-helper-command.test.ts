import { describe, expect, it, vi, beforeEach } from 'vitest'
const mocked = vi.hoisted(() => ({ create: vi.fn(), inspect: vi.fn(), recover: vi.fn(), initialize: vi.fn() }))
vi.mock('../src/backup/fixed-runtime.js', () => ({ runFixedProductionBackup: mocked.create }))
vi.mock('../src/backup/fixed-initialization.js', () => ({ runFixedRepositoryInitialization: mocked.initialize }))
vi.mock('../src/backup/fixed-recovery.js', () => ({ runFixedMaintenanceRecovery: mocked.recover }))
vi.mock('../src/backup/fixed-inspection.js', () => ({ runFixedProductionInspection: mocked.inspect }))
import { parseHelperCommand, runInternalHelper } from '../src/backup/helper-command.js'

const set = '12345678-1234-4234-8234-123456789abc', revision = 'a'.repeat(64)
beforeEach(() => vi.resetAllMocks())
describe('internal helper command protocol', () => {
  it('accepts only bounded create, paginated list, and UUID verify commands', () => {
    expect(parseHelperCommand(['create'])).toEqual({ mode: 'create' })
    expect(parseHelperCommand(['initialize-repository'])).toEqual({ mode: 'initialize-repository' })
    expect(parseHelperCommand(['recover-maintenance'])).toEqual({ mode: 'recover-maintenance' })
    expect(parseHelperCommand(['list'])).toEqual({ mode: 'list', limit: 10 })
    expect(parseHelperCommand(['list', '2', set, revision])).toEqual({ mode: 'list', limit: 2, after: set, revision })
    expect(parseHelperCommand(['verify', set])).toEqual({ mode: 'verify', set })
    for (const args of [[], ['create', '/tmp'], ['verify', '../../path'], ['list', '0'], ['list', '11'], ['list', '01'],
      ['list', '1', set], ['list', '1', set, 'bad'], ['restore'], ['create', '--repo=/tmp'], ['list', '1', set, revision, 'extra']]) {
      expect(() => parseHelperCommand(args)).toThrow('BACKUP_COMMAND_INVALID')
    }
  })
  it('returns only the allowed create and verification fields', async () => {
    const signal = new AbortController().signal
    mocked.create.mockImplementation(async (_signal, started) => { await started(set); return { backupSetId: set, status: 'verified', snapshotId: revision, password: 'secret-marker' } })
    const events: unknown[] = []
    expect(await runInternalHelper({ mode: 'create' }, signal, async event => { events.push(event) })).toEqual({ operation: 'create', backupSetId: set, status: 'verified' })
    expect(events).toEqual([{ operation: 'create', backupSetId: set, status: 'started' }])
    mocked.inspect.mockResolvedValue({ backupSetId: set, status: 'verified', createdAt: '2026-11-05T00:00:00.000Z', releaseId: 'release', key: 'secret-marker' })
    const result = await runInternalHelper({ mode: 'verify', set }, signal)
    expect(result).toEqual({ operation: 'verify', backupSetId: set, status: 'verified', createdAt: '2026-11-05T00:00:00.000Z', releaseId: 'release' })
    expect(JSON.stringify(result)).not.toContain('secret-marker')
    expect(mocked.inspect).toHaveBeenCalledWith({ mode: 'verify', set }, signal)
  })
  it('initializes only through the fixed independently provisioned repository path', async () => {
    const signal = new AbortController().signal
    mocked.initialize.mockResolvedValueOnce({ state: 'initialized', credential: 'private' })
    expect(await runInternalHelper({ mode: 'initialize-repository' }, signal)).toEqual({ operation: 'initialize-repository', state: 'initialized' })
    expect(mocked.initialize).toHaveBeenCalledWith(signal)
  })
  it('only returns the original maintenance ID after controlled service recovery', async () => {
    const signal = new AbortController().signal
    mocked.recover.mockResolvedValueOnce({ backupSetId: set, state: 'restoration_recorded', private: 'marker' })
    expect(await runInternalHelper({ mode: 'recover-maintenance' }, signal)).toEqual({ operation: 'recover-maintenance', backupSetId: set, state: 'restoration_recorded' })
    expect(mocked.recover).toHaveBeenCalledWith(signal)
  })
  it('never reports success without the same set ID having been announced', async () => {
    mocked.create.mockResolvedValueOnce({ backupSetId: set, status: 'verified', snapshotId: revision })
    await expect(runInternalHelper({ mode: 'create' }, new AbortController().signal, async () => {})).rejects.toThrow('BACKUP_COMMAND_INCOMPLETE')
    mocked.create.mockImplementationOnce(async (_signal, started) => { await started(set); return { backupSetId: '00000000-0000-4000-8000-000000000000', status: 'verified', snapshotId: revision } })
    await expect(runInternalHelper({ mode: 'create' }, new AbortController().signal, async () => {})).rejects.toThrow('BACKUP_COMMAND_INCOMPLETE')
  })
  it('retains list uncertainty, strips extra fields and rejects aborted output', async () => {
    const controller = new AbortController()
    mocked.inspect.mockResolvedValue({ items: [{ backupSetId: set, status: 'not_checked', secret: 'marker' }], nextAfter: null,
      revision, unknownRecords: true, untrackedSnapshots: 1, maintenance: { backupSetId: set, state: 'needs_attention', secret: 'marker' }, stagingNeedsAttention: true, repositoryInitialization: 'initialization_recorded', secret: 'marker' })
    const result = await runInternalHelper({ mode: 'list', limit: 1 }, controller.signal)
    expect(result).toEqual({ operation: 'list', items: [{ backupSetId: set, status: 'not_checked' }], nextAfter: null, revision, unknownRecords: true, untrackedSnapshots: 1, maintenance: { backupSetId: set, state: 'needs_attention' }, stagingNeedsAttention: true, repositoryInitialization: 'initialization_recorded' })
    mocked.inspect.mockImplementationOnce(async () => { controller.abort(); return { items: [], nextAfter: null, revision, unknownRecords: false, untrackedSnapshots: 0, maintenance: null, stagingNeedsAttention: false, repositoryInitialization: 'initialization_recorded' } })
    await expect(runInternalHelper({ mode: 'list', limit: 1 }, controller.signal)).rejects.toThrow('BACKUP_COMMAND_INTERRUPTED')
    await expect(runInternalHelper({ mode: 'create' }, controller.signal, async () => {})).rejects.toThrow('BACKUP_COMMAND_INTERRUPTED')
  })
})
