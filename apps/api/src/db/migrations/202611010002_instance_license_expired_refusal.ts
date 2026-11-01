import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Retain signed subscription expiry in the existing refusal evidence slot. */
export const instanceLicenseExpiredRefusalMigration: Migration = {
  async up(db) {
    await sql.raw(`
      ALTER TABLE instance_license_state DROP CONSTRAINT instance_license_state_refusal_check;
      ALTER TABLE instance_license_state ADD CONSTRAINT instance_license_state_refusal_check CHECK (
        (refusal_status IS NULL AND refusal_generation IS NULL AND refusal_revision IS NULL
          AND refusal_current_generation IS NULL AND refusal_operation_id IS NULL
          AND refusal_attempt_no IS NULL AND refusal_jws_digest IS NULL
          AND refusal_encryption_key_id IS NULL AND encrypted_refusal_jws IS NULL)
        OR
        (refusal_status IS NOT NULL AND refusal_status IN ('expired', 'revoked', 'superseded')
          AND refusal_generation IS NOT NULL AND refusal_generation > 0
          AND refusal_revision IS NOT NULL AND refusal_revision > 0
          AND refusal_current_generation IS NOT NULL AND refusal_current_generation >= refusal_generation
          AND refusal_generation = activation_generation
          AND refusal_operation_id IS NOT NULL AND refusal_attempt_no IS NOT NULL AND refusal_attempt_no > 0
          AND refusal_jws_digest IS NOT NULL AND refusal_jws_digest ~ '^[A-Za-z0-9_-]{43}$'
          AND refusal_encryption_key_id IS NOT NULL AND refusal_encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
          AND encrypted_refusal_jws IS NOT NULL AND license_id IS NOT NULL)
      );
    `).execute(db)
  },
}
