import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const supplierQuoteSourceConsistencyMigration: Migration = {
  async up(db) {
    // Older failure rows may contain mismatched source metadata and cannot be
    // repaired without rewriting immutable history. New rows identify snapshots
    // captured by the corrected path; the constraint applies to new writes.
    await sql`ALTER TABLE supplier_reference_quote_observations
      ADD COLUMN source_snapshot_consistent boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT supplier_quote_outcome_amount_consistency CHECK (
        (outcome = 'observed' AND quote_amount IS NOT NULL)
        OR (outcome <> 'observed' AND quote_amount IS NULL)
      ) NOT VALID`.execute(db)
  },
  async down(db) {
    await sql`ALTER TABLE supplier_reference_quote_observations
      DROP CONSTRAINT supplier_quote_outcome_amount_consistency,
      DROP COLUMN source_snapshot_consistent`.execute(db)
  },
}
