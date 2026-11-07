import { runFixedProductionBackup } from './fixed-runtime.js'
import { runFixedProductionInspection, type FixedInspectionCommand } from './fixed-inspection.js'
import { runFixedMaintenanceRecovery } from './fixed-recovery.js'
import { runFixedRepositoryInitialization } from './fixed-initialization.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const digest = /^[a-f0-9]{64}$/
export type HelperCommand = { mode: 'create' } | { mode: 'recover-maintenance' } | { mode: 'initialize-repository' } |
  { mode: 'restore-plan'; set: string } |
  { mode: 'restore-prepare'; set: string } | FixedInspectionCommand

/** No paths, credentials, endpoints, executable names or environment flags are accepted. */
export function parseHelperCommand(args: string[]): HelperCommand {
  if (args.length === 1 && args[0] === 'create') return { mode: 'create' }
  if (args.length === 1 && args[0] === 'initialize-repository') return { mode: 'initialize-repository' }
  if (args.length === 1 && args[0] === 'recover-maintenance') return { mode: 'recover-maintenance' }
  if (args.length === 2 && args[0] === 'restore-prepare' && uuid.test(args[1]!)) return { mode: 'restore-prepare', set: args[1]! }
  if (args.length === 2 && args[0] === 'restore-plan' && uuid.test(args[1]!)) return { mode: 'restore-plan', set: args[1]! }
  if (args.length === 2 && args[0] === 'verify' && uuid.test(args[1]!)) return { mode: 'verify', set: args[1]! }
  if (args[0] === 'list' && (args.length === 1 || args.length === 2 || args.length === 4)) {
    const limit = args.length === 1 ? 10 : Number(args[1])
    if (!/^(?:[1-9]|10)$/.test(args[1] ?? '10') || !Number.isInteger(limit)) throw new Error('BACKUP_COMMAND_INVALID')
    if (args.length === 4) {
      if (!uuid.test(args[2]!) || !digest.test(args[3]!)) throw new Error('BACKUP_COMMAND_INVALID')
      return { mode: 'list', limit, after: args[2]!, revision: args[3]! }
    }
    return { mode: 'list', limit }
  }
  throw new Error('BACKUP_COMMAND_INVALID')
}

/** Internal protocol output is a strict public whitelist; never serialize a
 * raw manifest, exception, process output, credentials or DB rows. */
export async function runInternalHelper(command: HelperCommand, signal: AbortSignal, onStarted?: (event: { operation: 'create'; backupSetId: string; status: 'started' }) => Promise<void>) {
  if (!signal || signal.aborted) throw new Error('BACKUP_COMMAND_INTERRUPTED')
  if (command.mode === 'create') {
    if (typeof onStarted !== 'function') throw new Error('BACKUP_COMMAND_INVALID')
    let started: string | undefined
    const result = await runFixedProductionBackup(signal, async backupSetId => {
      if (signal.aborted || started !== undefined || !uuid.test(backupSetId)) throw new Error('BACKUP_COMMAND_INTERRUPTED')
      await onStarted({ operation: 'create', backupSetId, status: 'started' })
      started = backupSetId
    })
    if (signal.aborted || result.status !== 'verified' || result.backupSetId !== started || !uuid.test(result.backupSetId) || !digest.test(result.snapshotId)) throw new Error('BACKUP_COMMAND_INCOMPLETE')
    return { operation: 'create' as const, backupSetId: result.backupSetId, status: 'verified' as const }
  }
  if (command.mode === 'initialize-repository') {
    const result = await runFixedRepositoryInitialization(signal)
    if (signal.aborted || result.state !== 'initialized') throw new Error('BACKUP_COMMAND_INCOMPLETE')
    return { operation: 'initialize-repository' as const, state: 'initialized' as const }
  }
  if (command.mode === 'recover-maintenance') {
    const result = await runFixedMaintenanceRecovery(signal)
    if (signal.aborted || !uuid.test(result.backupSetId) || result.state !== 'restoration_recorded') throw new Error('BACKUP_COMMAND_INCOMPLETE')
    return { operation: 'recover-maintenance' as const, backupSetId: result.backupSetId, state: 'restoration_recorded' as const }
  }
  const inspection = command.mode === 'restore-prepare' || command.mode === 'restore-plan'
    ? { mode: 'restore-isolated' as const, set: command.set }
    : command
  let result: Awaited<ReturnType<typeof runFixedProductionInspection>>
  try { result = await runFixedProductionInspection(inspection, signal) }
  catch (error) {
    if (command.mode !== 'restore-plan' || signal.aborted) throw error
    return { operation: 'restore-plan' as const, backupSetId: command.set, backup: 'blocked' as const,
      compatibility: 'unknown' as const, identity: 'unknown' as const, target: 'unknown' as const,
      technicalChecks: 'incomplete' as const,
      businessAfterBackup: 'unknown' as const, pendingExternalOperations: 'unknown' as const,
      authorization: 'unknown' as const, disk: 'unknown' as const, externalReconciliation: 'required' as const,
      readiness: 'blocked' as const, automaticRestore: 'blocked' as const }
  }
  if (signal.aborted) throw new Error('BACKUP_COMMAND_INTERRUPTED')
  if (command.mode === 'restore-plan') {
    if (!('backupSetId' in result) || result.backupSetId !== command.set || result.status !== 'verified' ||
        !('restoreEvidence' in result) || !result.restoreEvidence ||
        !digest.test(result.restoreEvidence.sourceSnapshotId) || !digest.test(result.restoreEvidence.manifestSnapshotId)) {
      return { operation: 'restore-plan' as const, backupSetId: command.set, backup: 'blocked' as const,
        compatibility: 'unknown' as const, identity: 'unknown' as const, target: 'unknown' as const,
        technicalChecks: 'incomplete' as const,
        businessAfterBackup: 'unknown' as const, pendingExternalOperations: 'unknown' as const,
        authorization: 'unknown' as const, disk: 'unknown' as const, externalReconciliation: 'required' as const,
        readiness: 'blocked' as const, automaticRestore: 'blocked' as const }
    }
    return { operation: 'restore-plan' as const, backupSetId: command.set, backup: 'verified' as const,
      compatibility: 'matched' as const, identity: 'matched' as const, target: 'current-instance' as const,
      technicalChecks: 'passed' as const,
      businessAfterBackup: 'unknown' as const, pendingExternalOperations: 'unknown' as const,
      authorization: 'unknown' as const, disk: 'unknown' as const, externalReconciliation: 'required' as const,
      readiness: 'blocked' as const, automaticRestore: 'blocked' as const }
  }
  if (command.mode === 'restore-prepare') {
    if (!('backupSetId' in result) || result.backupSetId !== command.set || result.status !== 'verified' ||
        !('restoreEvidence' in result) || !result.restoreEvidence ||
        !digest.test(result.restoreEvidence.sourceSnapshotId) || !digest.test(result.restoreEvidence.manifestSnapshotId)) {
      throw new Error('BACKUP_RESTORE_SET_NOT_VERIFIED')
    }
    return { operation: 'restore-prepare' as const, backupSetId: command.set, status: 'verified' as const,
      sourceSnapshotId: result.restoreEvidence.sourceSnapshotId, manifestSnapshotId: result.restoreEvidence.manifestSnapshotId }
  }
  if (command.mode === 'verify') {
    if (!('backupSetId' in result) || result.backupSetId !== command.set || !['verified', 'needs_attention'].includes(result.status) ||
        (result.status === 'needs_attention' && (result.createdAt !== null || result.releaseId !== null)) ||
        (result.status === 'verified' && (typeof result.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result.createdAt) ||
          !Number.isFinite(Date.parse(result.createdAt)) || new Date(result.createdAt).toISOString() !== result.createdAt ||
          typeof result.releaseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(result.releaseId)))) throw new Error('BACKUP_COMMAND_INCOMPLETE')
    return { operation: 'verify' as const, backupSetId: command.set, status: result.status,
      createdAt: result.createdAt, releaseId: result.releaseId }
  }
  if (command.mode !== 'list') throw new Error('BACKUP_COMMAND_INVALID')
  if (!('items' in result) || result.items.length > command.limit || !digest.test(result.revision) ||
      (result.nextAfter !== null && !uuid.test(result.nextAfter)) || !Number.isSafeInteger(result.untrackedSnapshots) || result.untrackedSnapshots < 0 ||
      typeof result.unknownRecords !== 'boolean' || typeof result.stagingNeedsAttention !== 'boolean' || !['initialization_recorded', 'needs_attention'].includes(result.repositoryInitialization) ||
      (result.maintenance !== null && (!uuid.test(result.maintenance.backupSetId) || !['restoration_recorded', 'needs_attention'].includes(result.maintenance.state))) || result.items.some(item => !uuid.test(item.backupSetId) || !['not_checked', 'needs_attention'].includes(item.status))) throw new Error('BACKUP_COMMAND_INCOMPLETE')
  return { operation: 'list' as const, items: result.items.map(item => ({ backupSetId: item.backupSetId, status: item.status })),
    nextAfter: result.nextAfter, revision: result.revision, unknownRecords: result.unknownRecords, untrackedSnapshots: result.untrackedSnapshots,
    maintenance: result.maintenance ? { backupSetId: result.maintenance.backupSetId, state: result.maintenance.state } : null, stagingNeedsAttention: result.stagingNeedsAttention, repositoryInitialization: result.repositoryInitialization }
}
