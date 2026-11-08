import { readFile } from 'node:fs/promises'
import { createDatabase } from './pool.js'
import { readBackupDatabaseMetadata } from '../backup/database-metadata.js'

const [migrationHead, migrationChecksumsSha256] = process.argv.slice(2)

async function main(): Promise<void> {
  if (!migrationHead || !/^\d{12}_[A-Za-z0-9_-]+$/.test(migrationHead) ||
      !migrationChecksumsSha256 || !/^[a-f0-9]{64}$/.test(migrationChecksumsSha256)) {
    throw new Error('upgrade_database_check_arguments_invalid')
  }

  const compiledChecksums = await readFile('/app/dist/db/migration-checksums.json')
  const database = createDatabase()
  try {
    const result = await readBackupDatabaseMetadata(database, {
      engine_major: 18,
      migration_head: migrationHead,
      migration_checksums_sha256: migrationChecksumsSha256,
    }, compiledChecksums, compiledChecksums)
    process.stdout.write(`${JSON.stringify({ status: 'ready', databaseId: result.databaseId,
      instanceId: result.instanceId, migrationHead: result.migrationHead,
      migrationChecksumsSha256: result.migrationChecksumsSha256 })}\n`)
  } finally {
    await database.destroy()
  }
}

if (process.argv[1]?.endsWith('upgrade-database-check-cli.js')) {
  try {
    await main()
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)
      ? error.message
      : 'UPGRADE_DATABASE_CHECK_FAILED'
    process.stderr.write(`${JSON.stringify({ status: 'error', code })}\n`)
    process.exitCode = 1
  }
}
