import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Worker coordination only; these fields do not grant or revoke an entitlement. */
export const licenseRenewalRetryMigration: Migration = {
  async up(db) {
    await sql.raw(`
      ALTER TABLE instance_license_state
        ADD COLUMN renewal_retry_count smallint NOT NULL DEFAULT 0,
        ADD COLUMN renewal_retry_after timestamptz,
        ADD CONSTRAINT instance_license_renewal_retry_check CHECK (
          renewal_retry_count BETWEEN 0 AND 7 AND
          ((renewal_retry_count = 0 AND renewal_retry_after IS NULL) OR
           (renewal_retry_count > 0 AND renewal_retry_after IS NOT NULL))
        );
    `).execute(db)
  },
}
