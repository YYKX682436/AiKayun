import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Permit a trusted refusal watermark to initialize the single projection before a lease exists. */
export const instanceLicenseRefusalFirstMigration: Migration = {
  async up(db) {
    await sql.raw(`
      ALTER TABLE instance_license_state
        DROP CONSTRAINT instance_license_state_identity_check;

      ALTER TABLE instance_license_state
        ADD CONSTRAINT instance_license_state_identity_check CHECK (
          (license_id IS NULL AND database_id IS NULL AND instance_id IS NULL AND identity_jkt IS NULL
            AND activation_generation IS NULL AND entitlement_revision IS NULL
            AND credential_jti IS NULL AND credential_issued_at IS NULL AND credential_expires_at IS NULL
            AND credential_operation_id IS NULL AND credential_attempt_no IS NULL
            AND credential_jws_digest IS NULL AND credential_encryption_key_id IS NULL AND encrypted_credential_jws IS NULL
            AND refusal_status IS NULL AND refusal_generation IS NULL AND refusal_revision IS NULL
            AND refusal_current_generation IS NULL AND refusal_operation_id IS NULL
            AND refusal_attempt_no IS NULL AND refusal_jws_digest IS NULL AND refusal_encryption_key_id IS NULL
            AND encrypted_refusal_jws IS NULL)
          OR
          (license_id IS NOT NULL AND database_id IS NOT NULL AND instance_id IS NOT NULL
            AND identity_jkt IS NOT NULL AND identity_jkt ~ '^[A-Za-z0-9_-]{43}$'
            AND activation_generation IS NOT NULL AND activation_generation > 0
            AND entitlement_revision IS NOT NULL AND entitlement_revision > 0
            AND (
              (credential_jti IS NOT NULL AND credential_issued_at IS NOT NULL AND credential_issued_at > 0
                AND credential_expires_at IS NOT NULL AND credential_expires_at > credential_issued_at
                AND credential_operation_id IS NOT NULL AND credential_attempt_no IS NOT NULL AND credential_attempt_no > 0
                AND credential_jws_digest IS NOT NULL AND credential_jws_digest ~ '^[A-Za-z0-9_-]{43}$'
                AND credential_encryption_key_id IS NOT NULL AND credential_encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
                AND encrypted_credential_jws IS NOT NULL)
              OR
              (credential_jti IS NULL AND credential_issued_at IS NULL AND credential_expires_at IS NULL
                AND credential_operation_id IS NULL AND credential_attempt_no IS NULL
                AND credential_jws_digest IS NULL AND credential_encryption_key_id IS NULL
                AND encrypted_credential_jws IS NULL AND refusal_status IS NOT NULL)
            )
          )
        );
    `).execute(db)
  },
}
