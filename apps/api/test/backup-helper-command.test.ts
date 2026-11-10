import { describe, expect, it, vi, beforeEach } from 'vitest'
const mocked = vi.hoisted(() => ({ create: vi.fn(), inspect: vi.fn(), recover: vi.fn(), initialize: vi.fn() }))
vi.mock('../src/backup/fixed-runtime.js', () => ({ runFixedProductionBackup: mocked.create }))
vi.mock('../src/backup/fixed-initialization.js', () => ({ runFixedRepositoryInitialization: mocked.initialize }))
vi.mock('../src/backup/fixed-recovery.js', () => ({ runFixedMaintenanceRecovery: mocked.recover }))
vi.mock('../src/backup/fixed-inspection.js', () => ({ runFixedProductionInspection: mocked.inspect }))
import { parseHelperCommand, runInternalHelper } from '../src/backup/helper-command.js'
import { UnsafeMaintenanceRecoveryError } from '../src/backup/maintenance-errors.js'

const set = '12345678-1234-4234-8234-123456789abc', revision = 'a'.repeat(64)
beforeEach(() => vi.resetAllMocks())
describe('internal helper command protocol', () => {
  it('accepts only bounded create, paginated list, UUID verify, and isolated restore preparation commands', () => {
    expect(parseHelperCommand(['create'])).toEqual({ mode: 'create' })
    expect(parseHelperCommand(['initialize-repository'])).toEqual({ mode: 'initialize-repository' })
    expect(parseHelperCommand(['recover-maintenance'])).toEqual({ mode: 'recover-maintenance' })
    expect(parseHelperCommand(['restore-prepare', set])).toEqual({ mode: 'restore-prepare', set })
    expect(parseHelperCommand(['restore-plan', set])).toEqual({ mode: 'restore-plan', set })
    expect(parseHelperCommand(['list'])).toEqual({ mode: 'list', limit: 10 })
    expect(parseHelperCommand(['list', '2', set, revision])).toEqual({ mode: 'list', limit: 2, after: set, revision })
    expect(parseHelperCommand(['verify', set])).toEqual({ mode: 'verify', set })
    for (const args of [[], ['create', '/tmp'], ['verify', '../../path'], ['list', '0'], ['list', '11'], ['list', '01'],
      ['list', '1', set], ['list', '1', set, 'bad'], ['restore'], ['restore-prepare', '../../path'],
      ['restore-prepare', set, '/tmp'], ['restore-plan', '../bad'], ['create', '--repo=/tmp'], ['list', '1', set, revision, 'extra']]) {
      expect(() => parseHelperCommand(args)).toThrow('BACKUP_COMMAND_INVALID')
    }
  })
  it('reports conservative restore-plan facts and blocks unavailable source checks', async () => {
    const signal = new AbortController().signal
    mocked.inspect.mockResolvedValueOnce({ backupSetId: set, status: 'verified', restoreEvidence: { sourceSnapshotId: revision, manifestSnapshotId: 'b'.repeat(64) }, private: 'marker' })
    const report = await runInternalHelper({ mode: 'restore-plan', set }, signal)
    expect(report).toEqual({ operation: 'restore-plan', backupSetId: set, backup: 'verified', compatibility: 'matched',
      identity: 'matched', target: 'unknown', technicalChecks: 'passed', businessAfterBackup: 'unknown', pendingExternalOperations: 'unknown',
      authorization: 'unknown', disk: 'unknown', externalReconciliation: 'required', blockingReason: 'target-identity-unverified',
      readiness: 'blocked', automaticRestore: 'blocked' })
    expect(JSON.stringify(report)).not.toContain('marker')
    expect(mocked.inspect).toHaveBeenCalledWith({ mode: 'restore-plan', set }, signal)
  })
  it.each([
    ['source database unavailable', 'BACKUP_DATABASE_TARGET_UNVERIFIED'],
    ['identity mismatch', 'RESTORE_IDENTITY_MISMATCH'],
    ['historical key cannot decrypt', 'RESTORE_HISTORICAL_KEY_INVALID'],
    ['schema incompatible', 'RESTORE_SCHEMA_INCOMPATIBLE'],
    ['authorization expired or unknown', 'RESTORE_AUTHORIZATION_UNKNOWN'],
    ['cross-server target cannot be proven', 'RESTORE_TARGET_IDENTITY_UNKNOWN'],
    ['backup or manifest incomplete', 'RESTORE_BACKUP_SET_INCOMPLETE'],
  ])('fails closed for %s', async (_scenario, diagnostic) => {
    mocked.inspect.mockRejectedValueOnce(new Error(diagnostic))
    const report = await runInternalHelper({ mode: 'restore-plan', set }, new AbortController().signal)
    expect(report).toMatchObject({ backup: 'blocked', compatibility: 'unknown', identity: 'unknown', target: 'unknown',
      businessAfterBackup: 'unknown', pendingExternalOperations: 'unknown', authorization: 'unknown', disk: 'unknown',
      externalReconciliation: 'required', readiness: 'blocked', automaticRestore: 'blocked' })
    expect(JSON.stringify(report)).not.toContain(diagnostic)
  })
  it('does not convert an interrupted preflight into a report that could imply completion', async () => {
    const controller = new AbortController()
    mocked.inspect.mockImplementationOnce(async () => { controller.abort(); throw new Error('BACKUP_OPERATION_INTERRUPTED') })
    await expect(runInternalHelper({ mode: 'restore-plan', set }, controller.signal)).rejects.toThrow('BACKUP_OPERATION_INTERRUPTED')
  })
  it('classifies known PostgreSQL connection failures without exposing driver messages', async () => {
    mocked.inspect.mockRejectedValueOnce(Object.assign(new Error('private connection detail'), { code: 'ECONNREFUSED' }))
    const report = await runInternalHelper({ mode: 'restore-plan', set }, new AbortController().signal)
    expect(report).toMatchObject({ backup: 'blocked', blockingReason: 'database-unavailable', readiness: 'blocked' })
    expect(JSON.stringify(report)).not.toContain('private connection detail')
  })
  it('preserves unsafe cleanup and unclassified exceptions instead of returning a normal report', async () => {
    mocked.inspect.mockRejectedValueOnce(new UnsafeMaintenanceRecoveryError('RESTIC_READER_CLEANUP_UNVERIFIED'))
    await expect(runInternalHelper({ mode: 'restore-plan', set }, new AbortController().signal)).rejects.toThrow('RESTIC_READER_CLEANUP_UNVERIFIED')
    mocked.inspect.mockRejectedValueOnce(new Error('unexpected private detail'))
    await expect(runInternalHelper({ mode: 'restore-plan', set }, new AbortController().signal)).rejects.toThrow('BACKUP_RESTORE_PLAN_CHECK_UNCLASSIFIED')
  })
  it.each(['BACKUP_LOCK_LOST', 'BACKUP_INSPECTION_LOCK_UNVERIFIED', 'BACKUP_DEPLOYMENT_CHANGED', 'BACKUP_HOST_CHANNEL_CLOSED'])('treats %s as an unsafe execution fence, not a normal blocked report', async diagnostic => {
      mocked.inspect.mockRejectedValueOnce(new Error(diagnostic))
      await expect(runInternalHelper({ mode: 'restore-plan', set }, new AbortController().signal))
        .rejects.toMatchObject({ name: 'UnsafeMaintenanceRecoveryError', code: 'INSTALLER_VERIFICATION_UNCERTAIN' })
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
    mocked.inspect.mockResolvedValueOnce({ backupSetId: set, status: 'verified', createdAt: '2026-11-05T00:00:00.000Z', releaseId: 'release',
      restoreEvidence: { sourceSnapshotId: revision, manifestSnapshotId: 'b'.repeat(64) }, manifest: 'secret-marker' })
    expect(await runInternalHelper({ mode: 'restore-prepare', set }, signal)).toEqual({ operation: 'restore-prepare', backupSetId: set,
      status: 'verified', sourceSnapshotId: revision, manifestSnapshotId: 'b'.repeat(64) })
    expect(mocked.inspect).toHaveBeenCalledWith({ mode: 'restore-isolated', set }, signal)
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
