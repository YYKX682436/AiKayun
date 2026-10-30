import { sql } from 'kysely'
import { readConfig } from '../config.js'
import { createDatabase } from '../db/pool.js'
import {
  readActivationOperationPayload,
  readLicenseOperationAttemptEnvelope,
  readLicenseOperationAttemptResponse,
  readLicenseOperationAttemptResultJws,
  readSavedLicenseOperationResponse,
} from './license-operation-store.js'
import { loadLicensePendingKey } from './pending-encryption-key.js'

export async function verifyLicensePendingBackupPair(): Promise<{ operations: number; attempts: number }> {
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
    const tables = await sql<{ operations: boolean; attempts: boolean }>`
      SELECT to_regclass('local_license_operations') IS NOT NULL AS operations,
        to_regclass('local_license_operation_attempts') IS NOT NULL AS attempts
    `.execute(db)
    if (!tables.rows[0]?.operations || !tables.rows[0]?.attempts) throw new Error('license_pending_restore_check_schema_missing')

    const operations = await db.selectFrom('local_license_operations').selectAll().orderBy('operation_id').execute()
    const attempts = await db.selectFrom('local_license_operation_attempts').selectAll()
      .orderBy('operation_id').orderBy('attempt_no').execute()
    for (const operation of operations) {
      if (operation.kind !== 'activation') throw new Error('license_pending_restore_check_unsupported_operation_kind')
      // Recomputes the center-compatible intent digest from the decrypted business payload.
      await readActivationOperationPayload(db, config.licensePendingKeyRoot, operation.operation_id)
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
      if (operation.state === 'response_saved') {
        await readSavedLicenseOperationResponse(db, config.licensePendingKeyRoot, operation.operation_id)
      }
    }
    return { operations: operations.length, attempts: attempts.length }
  } finally {
    await db.destroy()
  }
}

async function main(): Promise<void> {
  try {
    const result = await verifyLicensePendingBackupPair()
    process.stdout.write(`license_pending_restore_pair_verified operations=${result.operations} attempts=${result.attempts}\n`)
  } catch {
    // Never include decrypt, filesystem, database payload, or secret-bearing errors in command output.
    process.stderr.write('license_pending_restore_pair_rejected\n')
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main()
