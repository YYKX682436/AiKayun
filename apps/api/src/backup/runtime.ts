import { randomUUID } from 'node:crypto'
import { captureUnpublishedSet, type CaptureSetOperations } from './capture-set.js'
import { quiesceAndCapture, type QuiesceAdapter } from './coordinator.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import type { ReadonlyTrustBundleInspection } from '../licensing/trust/trust-bundle-store.js'
import { publishCapturedSet, type PublishSetInput } from './publish-set.js'
import { assertTmpfsPayload, assertTmpfsStaging, createTmpfsPayload, createTmpfsStaging, removeTmpfsStaging, type TmpfsStagingOptions } from './tmpfs-staging.js'

/** Internal composition only. This is not a customer entry point. Callers must
 * independently verify the signed deployment and supply real OS/DB adapters. */
export interface LocalBackupRuntimeInput {
  snapshot: Parameters<typeof quiesceAndCapture>[1]
  adapter: QuiesceAdapter
  mountRoot: string
  minimumBytes: bigint
  journalDirectory: string
  publicationDirectory: string
  tarBinary: string
  releaseId: PublishSetInput['releaseId']
  images: PublishSetInput['images']
  resticVersion: string
  repository: PublishSetInput['repository']
  assertTrustedDeployment(): Promise<void>
  /** Proves no abandoned dump or archive helper can still write to staging. */
  assertSafeCleanup(): Promise<void>
  assertRestoredAndRelease: PublishSetInput['assertRestoredAndRelease']
  verifyDumpBinding: PublishSetInput['verifyDumpBinding']
  inspectTrustStoreReadOnly?: ((directory: string) => Promise<ReadonlyTrustBundleInspection>) | undefined
  createCaptureOperations(payload: string, assertSecureStorage: () => Promise<void>): CaptureSetOperations
  signal?: AbortSignal | undefined
}

/** Compose the real primitives without providing mock trust proofs or exposing
 * a CLI. A failed cleanup or unverified writer fence stays fail-closed. */
export async function runLocalBackupRuntime(input: LocalBackupRuntimeInput): Promise<{ snapshotId: string; status: 'verified' }> {
  const started = new Date().toISOString()
  const lock = () => input.adapter.assertLock()
  const common = { mountRoot: input.mountRoot, assertLock: lock, assertSafeCleanup: input.assertSafeCleanup }
  const payloadOptions: TmpfsStagingOptions = { ...common, backupSetId: input.snapshot.backupSetId }
  const scratchOptions: TmpfsStagingOptions = { ...common, backupSetId: randomUUID() }
  let payloadCreated = false
  let scratchCreated = false
  let unsafe = false
  let result: { snapshotId: string; status: 'verified' } | undefined
  let failure: unknown
  try {
    await lock()
    await input.assertTrustedDeployment()
    const payload = await createTmpfsPayload(payloadOptions, input.minimumBytes)
    payloadCreated = true
    const scratch = await createTmpfsStaging(scratchOptions, 1n)
    scratchCreated = true
    const secureStorage = async () => { await assertTmpfsPayload(payloadOptions); await assertTmpfsStaging(scratchOptions) }
    const operations = input.createCaptureOperations(payload, secureStorage)
    const originalFence = operations.assertFence
    const capturedOperations: CaptureSetOperations = { ...operations, assertSecureStaging: secureStorage, async assertFence() {
      await lock()
      await input.assertTrustedDeployment()
      await input.adapter.assertNoWriters()
      await originalFence()
      await secureStorage()
    } }
    result = await quiesceAndCapture(input.journalDirectory, input.snapshot, input.adapter,
      () => captureUnpublishedSet({ backupSetId: input.snapshot.backupSetId, stagingDirectory: payload,
        tarBinary: input.tarBinary, createdAt: started, signal: input.signal, operations: capturedOperations }),
      staged => publishCapturedSet({ staged, stagingDirectory: payload, scratchParent: scratch,
        journalDirectory: input.journalDirectory, publicationDirectory: input.publicationDirectory,
        tarBinary: input.tarBinary, releaseId: input.releaseId, images: input.images, resticVersion: input.resticVersion,
        repository: input.repository, assertLock: lock, assertSafeCleanup: input.assertSafeCleanup, signal: input.signal, assertSecureStorage: secureStorage, verifyDumpBinding: input.verifyDumpBinding,
        inspectTrustStoreReadOnly: input.inspectTrustStoreReadOnly,
        async assertRestoredAndRelease(journal) {
          await input.assertTrustedDeployment()
          await input.assertRestoredAndRelease(journal)
          await lock()
        } }))
  } catch (error) {
    failure = error
    unsafe = error instanceof UnsafeMaintenanceRecoveryError || error instanceof AggregateError
  }
  // Unknown writer/lock state requires inspection, not automatic deletion.
  if (!unsafe) {
    try {
      if (scratchCreated) await removeTmpfsStaging(scratchOptions)
      if (payloadCreated) await removeTmpfsStaging(payloadOptions)
    } catch { throw new UnsafeMaintenanceRecoveryError('SET_CLEANUP_UNVERIFIED') }
  }
  if (failure) throw failure
  if (!result) throw new Error('BACKUP_RUNTIME_INCOMPLETE')
  return result
}
