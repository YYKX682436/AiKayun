import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Diagnostic observations only. Never used to coordinate or advance business work. */
export const operationsWorkerHealthMigration: Migration = {
  async up(db) {
    await sql.raw(`
      CREATE TABLE operations_worker_health (
        worker text PRIMARY KEY CHECK (worker IN ('unpaid_expiry', 'local_delivery', 'supplier_delivery', 'license_renewal')),
        last_scan_at timestamptz,
        last_success_at timestamptz,
        last_failure_at timestamptz,
        last_failure_code text,
        last_unavailable_at timestamptz,
        last_unavailable_code text
      )
    `).execute(db)
  },
}
