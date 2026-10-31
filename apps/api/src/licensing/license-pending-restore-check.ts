import { sql } from 'kysely'
import { createHash } from 'node:crypto'
import { readConfig } from '../config.js'
import { createDatabase } from '../db/pool.js'
import {
  readActivationOperationPayload,
  readRecoveryOperationPayload,
  readLicenseOperationAttemptEnvelope,
  readLicenseOperationAttemptResponse,
  readLicenseOperationAttemptResultJws,
  readLicenseOperationCenterEvidence,
  readSavedLicenseOperationResponse,
} from './license-operation-store.js'
import { decryptLicensePendingBytes, loadLicensePendingKey } from './pending-encryption-key.js'

export async function verifyLicensePendingBackupPair(): Promise<{ operations: number; attempts: number; projections: number }> {
  const config = readConfig(process.env)
  if (config.nodeEnv !== 'test') throw new Error('license_pending_restore_check_test_only')
  await loadLicensePendingKey(config.licensePendingKeyRoot, [
    config.mediaRoot,
    config.privateFileRoot,
    config.identityRoot,
    config.licenseTrustStoreRoot,
  ])
  const db = createDatabase()
  try {
    const database = await sql<{ database_name: string }>`SELECT current_database() AS database_name`.execute(db)
    const databaseName = database.rows[0]?.database_name
    if (!databaseName?.endsWith('_test')) throw new Error('license_pending_restore_check_test_database_required')
    const tables = await sql<{ operations: boolean; attempts: boolean; projection: boolean }>`
      SELECT to_regclass('local_license_operations') IS NOT NULL AS operations,
        to_regclass('local_license_operation_attempts') IS NOT NULL AS attempts,
        to_regclass('instance_license_state') IS NOT NULL AS projection
    `.execute(db)
    if (!tables.rows[0]?.operations || !tables.rows[0]?.attempts || !tables.rows[0]?.projection) {
      throw new Error('license_pending_restore_check_schema_missing')
    }

    const operations = await db.selectFrom('local_license_operations').selectAll().orderBy('operation_id').execute()
    const attempts = await db.selectFrom('local_license_operation_attempts').selectAll()
      .orderBy('operation_id').orderBy('attempt_no').execute()
    for (const operation of operations) {
      // Recomputes the center-compatible immutable intent from each encrypted operation payload.
      if (operation.kind === 'activation') {
        await readActivationOperationPayload(db, config.licensePendingKeyRoot, operation.operation_id)
      } else if (operation.kind === 'recovery') {
        await readRecoveryOperationPayload(db, config.licensePendingKeyRoot, operation.operation_id)
      } else {
        throw new Error('license_pending_restore_check_unsupported_operation_kind')
      }
    }
    for (const attempt of attempts) {
      await readLicenseOperationAttemptEnvelope(db, config.licensePendingKeyRoot, attempt.operation_id, attempt.attempt_no)
      if (attempt.send_state === 'response_saved') {
        await readLicenseOperationAttemptResponse(db, config.licensePendingKeyRoot, attempt.operation_id, attempt.attempt_no)
      }
      // This also accepts legacy rows without a result and rejects incomplete archives.
      await readLicenseOperationAttemptResultJws(db, config.licensePendingKeyRoot, attempt.operation_id, attempt.attempt_no)
    }
    for (const operation of operations) {
      const centerEvidence = await readLicenseOperationCenterEvidence(db, config.licensePendingKeyRoot, operation.operation_id)
      if ((operation.state === 'terminal' || operation.state === 'cancelled') !== (centerEvidence !== null)) {
        throw new Error('license_pending_restore_check_center_evidence_missing')
      }
      if (operation.state === 'response_saved') {
        await readSavedLicenseOperationResponse(db, config.licensePendingKeyRoot, operation.operation_id)
      }
    }
    const projectionRows = await db.selectFrom('instance_license_state').selectAll()
      .where('singleton', '=', true).execute()
    if (projectionRows.length !== 1) throw new Error('license_pending_restore_check_projection_row_missing')
    const projection = projectionRows[0]!
    if (projection.license_id !== null) {
      const binding = await db.selectFrom('installation_binding').selectAll()
        .where('singleton', '=', true).executeTakeFirst()
      if (!binding || binding.database_id !== projection.database_id || binding.instance_id !== projection.instance_id ||
        binding.identity_jkt !== projection.identity_jkt) throw new Error('license_pending_restore_check_projection_identity_mismatch')
      await verifyProjectionEvidence({
        db, pendingKeyRoot: config.licensePendingKeyRoot,
        operationId: projection.credential_operation_id!, attemptNo: projection.credential_attempt_no!,
        keyId: projection.credential_encryption_key_id!, ciphertext: projection.encrypted_credential_jws!,
        digest: projection.credential_jws_digest!, field: 'projection_lease_jws',
      })
      if (projection.refusal_status !== null) {
        await verifyProjectionEvidence({
          db, pendingKeyRoot: config.licensePendingKeyRoot,
          operationId: projection.refusal_operation_id!, attemptNo: projection.refusal_attempt_no!,
          keyId: projection.refusal_encryption_key_id!, ciphertext: projection.encrypted_refusal_jws!,
          digest: projection.refusal_jws_digest!, field: 'projection_rejection_jws',
        })
      }
    }
    return { operations: operations.length, attempts: attempts.length, projections: projectionRows.length }
  } finally {
    await db.destroy()
  }
}

async function main(): Promise<void> {
  try {
    const result = await verifyLicensePendingBackupPair()
    process.stdout.write(`license_pending_restore_pair_verified operations=${result.operations} attempts=${result.attempts} projections=${result.projections}\n`)
  } catch {
    // Never include decrypt, filesystem, database payload, or secret-bearing errors in command output.
    process.stderr.write('license_pending_restore_pair_rejected\n')
    process.exitCode = 1
  }
}

async function verifyProjectionEvidence(input: {
  db: ReturnType<typeof createDatabase>
  pendingKeyRoot: string
  operationId: string
  attemptNo: number
  keyId: string
  ciphertext: Buffer
  digest: string
  field: 'projection_lease_jws' | 'projection_rejection_jws'
}): Promise<void> {
  const raw = await decryptLicensePendingBytes(input.pendingKeyRoot, {
    operationId: input.operationId, attemptNo: input.attemptNo, record: 'attempt', field: input.field,
  }, { keyId: input.keyId, ciphertext: input.ciphertext })
  if (createHash('sha256').update(raw).digest('base64url') !== input.digest) {
    throw new Error('license_pending_restore_check_projection_digest_mismatch')
  }
  const response = await readLicenseOperationAttemptResponse(input.db, input.pendingKeyRoot, input.operationId, input.attemptNo)
  const archivedResult = await readLicenseOperationAttemptResultJws(input.db, input.pendingKeyRoot, input.operationId, input.attemptNo)
  if (!response.equals(raw) && !archivedResult?.equals(raw)) {
    throw new Error('license_pending_restore_check_projection_source_mismatch')
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main()
