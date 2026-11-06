import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import { dockerExec } from './docker-client.js'

/** Call while holding the verified host lock and pinned DB connection. This
 * is not a janitor: it never stops processes or removes unknown containers. */
export async function assertNoFixedBackupWriters(db: Kysely<Database>): Promise<void> {
  try {
    const result = await sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_catalog.pg_stat_activity
      WHERE starts_with(application_name, 'aikayun_backup_') AND pid <> pg_backend_pid()`.execute(db)
    if (result.rows.length !== 1 || result.rows[0]?.count !== '0') throw new Error('pending dump')
    const output = await dockerExec(process.env.NODE_ENV === 'test' ? '/usr/bin/docker' : undefined,
      process.env.NODE_ENV === 'test' ? '/run/docker.sock' : undefined,
      ['ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=com.aikayun.backup.archive'],
      { timeoutMs: 30000, maxBuffer: 65536 })
    if (output.trim()) throw new Error('pending archive')
  } catch { throw new UnsafeMaintenanceRecoveryError('SET_CLEANUP_UNVERIFIED') }
}
