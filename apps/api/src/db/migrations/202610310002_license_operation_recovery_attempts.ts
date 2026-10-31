import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Extend the existing encrypted operation journal to the center's recovery mutation. */
export const licenseOperationRecoveryAttemptsMigration: Migration = {
  async up(db) {
    await sql.raw(`
      ALTER TABLE local_license_operation_attempts
        DROP CONSTRAINT local_license_operation_attempts_purpose_check;
      ALTER TABLE local_license_operation_attempts
        ADD CONSTRAINT local_license_operation_attempts_purpose_check CHECK (purpose IN (
          'activation', 'query', 'continue', 'recovery'
        ));

      CREATE OR REPLACE FUNCTION guard_local_license_operation_attempt_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        operation_row local_license_operations%ROWTYPE;
        next_attempt_no integer;
      BEGIN
        SELECT * INTO operation_row FROM local_license_operations
          WHERE operation_id = NEW.operation_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'attempt must belong to a persisted local license operation' USING ERRCODE = '23503';
        END IF;
        IF operation_row.state NOT IN ('pending', 'response_saved') OR
          (operation_row.state = 'response_saved' AND NEW.purpose = 'activation') THEN
          RAISE EXCEPTION 'only recovery attempts may follow a saved response' USING ERRCODE = '55000';
        END IF;
        IF NEW.intent_digest <> operation_row.intent_digest OR NEW.identity_jkt <> operation_row.identity_jkt THEN
          RAISE EXCEPTION 'attempt identity and intent must match the parent operation' USING ERRCODE = '23514';
        END IF;
        IF (NEW.purpose = 'activation' AND operation_row.kind <> 'activation') OR
          (NEW.purpose = 'recovery' AND operation_row.kind <> 'recovery') OR
          (NEW.purpose IN ('query', 'continue') AND operation_row.kind NOT IN ('activation', 'recovery')) THEN
          RAISE EXCEPTION 'attempt purpose must match a supported operation kind' USING ERRCODE = '23514';
        END IF;
        SELECT COALESCE(MAX(attempt_no), 0) + 1 INTO next_attempt_no
          FROM local_license_operation_attempts WHERE operation_id = NEW.operation_id;
        IF NEW.attempt_no <> next_attempt_no THEN
          RAISE EXCEPTION 'attempt numbers must be allocated monotonically without gaps' USING ERRCODE = '23514';
        END IF;
        IF NEW.send_state <> 'prepared' THEN
          RAISE EXCEPTION 'new attempt evidence must be committed before sending' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE OR REPLACE FUNCTION guard_local_license_operation_attempt_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        operation_kind text;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'local license operation attempts are permanent' USING ERRCODE = '55000';
        END IF;
        SELECT kind INTO operation_kind FROM local_license_operations WHERE operation_id = OLD.operation_id;
        IF operation_kind IS NULL THEN
          RAISE EXCEPTION 'local license operation parent is missing' USING ERRCODE = '23503';
        END IF;
        IF EXISTS (
          SELECT 1 FROM local_license_operations operation
          WHERE operation.operation_id = OLD.operation_id
            AND operation.state IN ('projected', 'terminal', 'cancelled')
        ) THEN
          RAISE EXCEPTION 'final local license operation attempts cannot be changed' USING ERRCODE = '55000';
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
        IF OLD.result_key_id IS NULL AND NEW.result_key_id IS NOT NULL AND (
          NOT ((operation_kind = 'activation' AND OLD.purpose IN ('activation', 'continue')) OR
            (operation_kind = 'recovery' AND OLD.purpose IN ('recovery', 'continue'))) OR
          NEW.send_state NOT IN ('sent', 'transport_unknown', 'response_saved')) THEN
          RAISE EXCEPTION 'only a sent activation or recovery mutation may archive its center result' USING ERRCODE = '55000';
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
