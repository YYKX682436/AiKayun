import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const licenseOperationResultArchiveMigration: Migration = {
  async up(db) {
    await sql.raw(`
      ALTER TABLE local_license_operation_attempts
        ADD COLUMN result_key_id varchar(48),
        ADD COLUMN encrypted_result_jws bytea,
        ADD COLUMN result_digest char(43),
        ADD COLUMN result_saved_at timestamptz;

      ALTER TABLE local_license_operation_attempts
        ADD CONSTRAINT local_license_operation_attempt_result_check CHECK (
          (result_key_id IS NULL AND encrypted_result_jws IS NULL AND result_digest IS NULL AND result_saved_at IS NULL)
          OR (result_key_id IS NOT NULL AND result_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND encrypted_result_jws IS NOT NULL
            AND result_digest IS NOT NULL AND result_digest ~ '^[A-Za-z0-9_-]{43}$'
            AND result_saved_at IS NOT NULL)
        );

      CREATE OR REPLACE FUNCTION guard_local_license_operation_attempt_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'local license operation attempts are permanent' USING ERRCODE = '55000';
        END IF;
        IF (NEW.operation_id, NEW.attempt_no, NEW.purpose, NEW.intent_digest,
            NEW.client_nonce_hash, NEW.request_nonce_hash, NEW.request_body_digest,
            NEW.identity_jkt, NEW.signing_key_id, NEW.signature_created_at,
            NEW.request_key_id, NEW.encrypted_request_envelope, NEW.created_at)
          IS DISTINCT FROM
           (OLD.operation_id, OLD.attempt_no, OLD.purpose, OLD.intent_digest,
            OLD.client_nonce_hash, OLD.request_nonce_hash, OLD.request_body_digest,
            OLD.identity_jkt, OLD.signing_key_id, OLD.signature_created_at,
            OLD.request_key_id, OLD.encrypted_request_envelope, OLD.created_at) THEN
          RAISE EXCEPTION 'local license attempt request evidence is immutable' USING ERRCODE = '55000';
        END IF;
        IF OLD.result_key_id IS NOT NULL AND
          (NEW.result_key_id, NEW.encrypted_result_jws, NEW.result_digest, NEW.result_saved_at)
          IS DISTINCT FROM
          (OLD.result_key_id, OLD.encrypted_result_jws, OLD.result_digest, OLD.result_saved_at) THEN
          RAISE EXCEPTION 'local license operation result evidence is immutable' USING ERRCODE = '55000';
        END IF;
        IF OLD.result_key_id IS NULL AND NEW.result_key_id IS NOT NULL AND
          (NEW.purpose NOT IN ('activation', 'continue') OR NEW.send_state NOT IN ('sent', 'transport_unknown', 'response_saved')) THEN
          RAISE EXCEPTION 'only a sent activation mutation may archive its center result' USING ERRCODE = '55000';
        END IF;
        IF OLD.send_state IN ('transport_error', 'response_saved') THEN
          IF OLD.send_state = 'transport_error' OR
            (NEW.send_state, NEW.sent_at, NEW.response_key_id, NEW.encrypted_response, NEW.response_digest, NEW.response_saved_at)
              IS DISTINCT FROM
            (OLD.send_state, OLD.sent_at, OLD.response_key_id, OLD.encrypted_response, OLD.response_digest, OLD.response_saved_at) THEN
            RAISE EXCEPTION 'completed local license attempt cannot be changed' USING ERRCODE = '55000';
          END IF;
          IF (NEW.result_key_id, NEW.encrypted_result_jws, NEW.result_digest, NEW.result_saved_at)
            IS DISTINCT FROM
            (OLD.result_key_id, OLD.encrypted_result_jws, OLD.result_digest, OLD.result_saved_at)
            AND OLD.result_key_id IS NOT NULL THEN
            RAISE EXCEPTION 'local license operation result evidence is immutable' USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END IF;
        IF NOT (
          (OLD.send_state = 'prepared' AND NEW.send_state IN ('sent', 'transport_unknown', 'transport_error', 'response_saved'))
          OR (OLD.send_state = 'sent' AND NEW.send_state IN ('transport_unknown', 'transport_error', 'response_saved'))
          OR (OLD.send_state = 'transport_unknown' AND NEW.send_state = 'response_saved')
          OR (OLD.send_state = NEW.send_state AND OLD.send_state IN ('sent', 'transport_unknown'))
        ) THEN
          RAISE EXCEPTION 'invalid local license attempt send-state transition' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END
      $$;
    `).execute(db)
  },
}
