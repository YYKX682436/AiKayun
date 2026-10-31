import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** The single durable, fail-closed license evidence projection. */
export const instanceLicenseStateMigration: Migration = {
  async up(db) {
    await sql.raw(`
      CREATE TABLE instance_license_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        license_id uuid,
        database_id uuid,
        instance_id uuid,
        identity_jkt char(43),
        activation_generation bigint,
        entitlement_revision bigint,
        credential_jti uuid,
        credential_issued_at bigint,
        credential_expires_at bigint,
        credential_operation_id uuid,
        credential_attempt_no integer,
        credential_jws_digest char(43),
        credential_encryption_key_id varchar(48),
        encrypted_credential_jws bytea,
        refusal_status text,
        refusal_generation bigint,
        refusal_revision bigint,
        refusal_current_generation bigint,
        refusal_operation_id uuid,
        refusal_attempt_no integer,
        refusal_jws_digest char(43),
        refusal_encryption_key_id varchar(48),
        encrypted_refusal_jws bytea,
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT instance_license_state_identity_check CHECK (
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
            AND credential_jti IS NOT NULL AND credential_issued_at IS NOT NULL AND credential_issued_at > 0
            AND credential_expires_at IS NOT NULL AND credential_expires_at > credential_issued_at
            AND credential_operation_id IS NOT NULL AND credential_attempt_no IS NOT NULL AND credential_attempt_no > 0
            AND credential_jws_digest IS NOT NULL AND credential_jws_digest ~ '^[A-Za-z0-9_-]{43}$'
            AND credential_encryption_key_id IS NOT NULL AND credential_encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND encrypted_credential_jws IS NOT NULL)
        ),
        CONSTRAINT instance_license_state_refusal_check CHECK (
          (refusal_status IS NULL AND refusal_generation IS NULL AND refusal_revision IS NULL
            AND refusal_current_generation IS NULL AND refusal_operation_id IS NULL
            AND refusal_attempt_no IS NULL AND refusal_jws_digest IS NULL
            AND refusal_encryption_key_id IS NULL AND encrypted_refusal_jws IS NULL)
          OR
          (refusal_status IS NOT NULL AND refusal_status IN ('revoked', 'superseded')
            AND refusal_generation IS NOT NULL AND refusal_generation > 0
            AND refusal_revision IS NOT NULL AND refusal_revision > 0
            AND refusal_current_generation IS NOT NULL AND refusal_current_generation >= refusal_generation
            AND refusal_generation = activation_generation
            AND refusal_operation_id IS NOT NULL AND refusal_attempt_no IS NOT NULL AND refusal_attempt_no > 0
            AND refusal_jws_digest IS NOT NULL AND refusal_jws_digest ~ '^[A-Za-z0-9_-]{43}$'
            AND refusal_encryption_key_id IS NOT NULL AND refusal_encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND encrypted_refusal_jws IS NOT NULL
            AND license_id IS NOT NULL)
        ),
        CONSTRAINT instance_license_state_credential_source_fk FOREIGN KEY
          (credential_operation_id, credential_attempt_no)
          REFERENCES local_license_operation_attempts(operation_id, attempt_no) ON DELETE RESTRICT,
        CONSTRAINT instance_license_state_refusal_source_fk FOREIGN KEY
          (refusal_operation_id, refusal_attempt_no)
          REFERENCES local_license_operation_attempts(operation_id, attempt_no) ON DELETE RESTRICT
      );

      INSERT INTO instance_license_state(singleton) VALUES (true);

      CREATE FUNCTION guard_instance_license_state_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'instance license state cannot be deleted' USING ERRCODE = '55000';
        END IF;
        IF NEW.singleton IS DISTINCT FROM OLD.singleton THEN
          RAISE EXCEPTION 'instance license state singleton is immutable' USING ERRCODE = '55000';
        END IF;
        IF OLD.license_id IS NOT NULL THEN
          IF ROW(NEW.license_id, NEW.database_id, NEW.instance_id, NEW.identity_jkt)
            IS DISTINCT FROM ROW(OLD.license_id, OLD.database_id, OLD.instance_id, OLD.identity_jkt) THEN
            RAISE EXCEPTION 'instance license state identity cannot be replaced' USING ERRCODE = '55000';
          END IF;
          IF NEW.activation_generation < OLD.activation_generation OR
            NEW.entitlement_revision < OLD.entitlement_revision THEN
            RAISE EXCEPTION 'instance license state watermarks cannot decrease' USING ERRCODE = '55000';
          END IF;
          IF NEW.activation_generation = OLD.activation_generation AND
            NEW.entitlement_revision = OLD.entitlement_revision AND
            NEW.credential_issued_at <= OLD.credential_issued_at AND
            (NEW.credential_jti, NEW.credential_jws_digest) IS DISTINCT FROM
              (OLD.credential_jti, OLD.credential_jws_digest) THEN
            RAISE EXCEPTION 'same-revision credential must have a newer issue time' USING ERRCODE = '55000';
          END IF;
          IF OLD.refusal_status = 'superseded' AND NEW.refusal_status IS DISTINCT FROM 'superseded' THEN
            RAISE EXCEPTION 'superseded evidence cannot be cleared by a lease' USING ERRCODE = '55000';
          END IF;
          IF OLD.refusal_status IS NOT NULL AND NEW.refusal_status IS NULL THEN
            RAISE EXCEPTION 'accepted refusal evidence cannot be erased' USING ERRCODE = '55000';
          END IF;
          IF OLD.refusal_status IS NOT NULL AND NEW.refusal_status IS NOT NULL AND
            (NEW.refusal_revision < OLD.refusal_revision OR
              NEW.refusal_generation < OLD.refusal_generation OR
              NEW.refusal_current_generation < OLD.refusal_current_generation) THEN
            RAISE EXCEPTION 'accepted refusal watermarks cannot decrease' USING ERRCODE = '55000';
          END IF;
          IF OLD.refusal_status IS NOT NULL AND NEW.refusal_status = OLD.refusal_status AND
            NEW.refusal_revision = OLD.refusal_revision AND
            (NEW.refusal_jws_digest, NEW.refusal_operation_id, NEW.refusal_attempt_no)
              IS DISTINCT FROM (OLD.refusal_jws_digest, OLD.refusal_operation_id, OLD.refusal_attempt_no) THEN
            RAISE EXCEPTION 'accepted refusal evidence is immutable at an existing watermark' USING ERRCODE = '55000';
          END IF;
          IF OLD.refusal_status = 'superseded' AND NEW.refusal_status = 'superseded' AND
            (NEW.refusal_generation, NEW.refusal_current_generation) IS DISTINCT FROM
              (OLD.refusal_generation, OLD.refusal_current_generation) THEN
            RAISE EXCEPTION 'superseded generation fence is immutable' USING ERRCODE = '55000';
          END IF;
        END IF;
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER instance_license_state_mutation_guard
        BEFORE UPDATE OR DELETE ON instance_license_state
        FOR EACH ROW EXECUTE FUNCTION guard_instance_license_state_mutation();

      CREATE FUNCTION prevent_instance_license_state_truncate() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'instance license state cannot be truncated' USING ERRCODE = '55000';
      END
      $$;
      CREATE TRIGGER instance_license_state_no_truncate BEFORE TRUNCATE ON instance_license_state
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_instance_license_state_truncate();
    `).execute(db)
  },
}
