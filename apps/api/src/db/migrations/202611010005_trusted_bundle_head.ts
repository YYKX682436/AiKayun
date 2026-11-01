import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Binds one accepted Trust Store history to the existing singleton license row. */
export const trustedBundleHeadMigration: Migration = {
  async up(db) {
    await sql.raw(`
      ALTER TABLE instance_license_state
        ADD COLUMN trust_bundle_head_digest varchar(43),
        ADD COLUMN trust_bundle_head_version varchar(19),
        ADD COLUMN trust_bundle_pending_artifact_sha256 varchar(43),
        ADD COLUMN trust_bundle_pending_token text,
        ADD CONSTRAINT instance_license_trust_bundle_head_check CHECK (
          (trust_bundle_head_digest IS NULL AND trust_bundle_head_version IS NULL) OR
          (trust_bundle_head_digest ~ '^[A-Za-z0-9_-]{43}$' AND
           trust_bundle_head_version ~ '^[1-9][0-9]{0,18}$')
        ),
        ADD CONSTRAINT instance_license_trust_bundle_pending_check CHECK (
          (trust_bundle_pending_artifact_sha256 IS NULL AND trust_bundle_pending_token IS NULL) OR
          (trust_bundle_pending_artifact_sha256 ~ '^[A-Za-z0-9_-]{43}$' AND
           trust_bundle_pending_token IS NOT NULL AND length(trust_bundle_pending_token) BETWEEN 1 AND 16384)
        );

      CREATE FUNCTION guard_instance_license_trust_bundle_head() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.trust_bundle_head_version IS NOT NULL AND NEW.trust_bundle_head_version IS NOT NULL AND
          (length(NEW.trust_bundle_head_version), NEW.trust_bundle_head_version) <
          (length(OLD.trust_bundle_head_version), OLD.trust_bundle_head_version) THEN
          RAISE EXCEPTION 'accepted trust bundle version cannot decrease' USING ERRCODE = '55000';
        END IF;
        IF OLD.trust_bundle_head_digest IS NOT NULL AND NEW.trust_bundle_head_digest IS NULL THEN
          RAISE EXCEPTION 'accepted trust bundle head cannot be erased' USING ERRCODE = '55000';
        END IF;
        IF OLD.trust_bundle_pending_artifact_sha256 IS NOT NULL AND
          NEW.trust_bundle_pending_artifact_sha256 IS NOT NULL AND
          (OLD.trust_bundle_pending_artifact_sha256, OLD.trust_bundle_pending_token) IS DISTINCT FROM
          (NEW.trust_bundle_pending_artifact_sha256, NEW.trust_bundle_pending_token) THEN
          RAISE EXCEPTION 'pending trust bundle update cannot be replaced' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER instance_license_trust_bundle_head_guard
        BEFORE UPDATE ON instance_license_state
        FOR EACH ROW EXECUTE FUNCTION guard_instance_license_trust_bundle_head();
    `).execute(db)
  },
}
