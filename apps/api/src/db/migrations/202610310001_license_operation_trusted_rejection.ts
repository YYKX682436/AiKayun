import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Permit only a verified activation rejection to settle an already saved response. */
export const licenseOperationTrustedRejectionMigration: Migration = {
  async up(db) {
    await sql.raw(`
      CREATE OR REPLACE FUNCTION guard_local_license_operation_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'local license operations are permanent' USING ERRCODE = '55000';
        END IF;
        IF (NEW.operation_id, NEW.kind, NEW.intent_digest, NEW.license_id, NEW.database_id,
            NEW.instance_id, NEW.identity_jkt, NEW.expected_generation, NEW.intent_schema,
            NEW.payload_key_id, NEW.encrypted_intent_payload, NEW.created_at)
          IS DISTINCT FROM
           (OLD.operation_id, OLD.kind, OLD.intent_digest, OLD.license_id, OLD.database_id,
            OLD.instance_id, OLD.identity_jkt, OLD.expected_generation, OLD.intent_schema,
            OLD.payload_key_id, OLD.encrypted_intent_payload, OLD.created_at) THEN
          RAISE EXCEPTION 'local license operation intent is immutable' USING ERRCODE = '55000';
        END IF;
        IF OLD.state IN ('projected', 'terminal', 'cancelled') THEN
          RAISE EXCEPTION 'final local license operation cannot be changed' USING ERRCODE = '55000';
        END IF;
        IF OLD.state = 'response_saved' AND NEW.state = 'terminal' THEN
          IF NEW.kind <> 'activation' OR NEW.expected_generation IS NOT NULL OR
            ROW(NEW.response_attempt_no, NEW.response_digest, NEW.response_saved_at)
              IS DISTINCT FROM ROW(OLD.response_attempt_no, OLD.response_digest, OLD.response_saved_at) OR
            NEW.finalized_at IS NULL OR NEW.encrypted_center_evidence IS NULL OR
            NEW.center_evidence_key_id IS NULL OR NEW.center_evidence_digest IS NULL THEN
            RAISE EXCEPTION 'trusted rejection must preserve the response pointer and archive its center evidence'
              USING ERRCODE = '55000';
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM local_license_operation_attempts attempt
            WHERE attempt.operation_id = NEW.operation_id
              AND attempt.attempt_no = NEW.response_attempt_no
              AND attempt.send_state = 'response_saved'
              AND attempt.response_digest = NEW.response_digest
              AND attempt.response_saved_at = NEW.response_saved_at
          ) THEN
            RAISE EXCEPTION 'trusted rejection must preserve a response pointer bound to a saved attempt'
              USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END IF;
        IF NOT (
          (OLD.state = 'pending' AND NEW.state = 'response_saved'
            AND NEW.response_attempt_no IS NOT NULL AND NEW.response_attempt_no > 0)
          OR (OLD.state = 'response_saved' AND NEW.state = 'response_saved'
            AND NEW.response_attempt_no IS NOT NULL
            AND NEW.response_attempt_no > OLD.response_attempt_no
            AND NEW.response_saved_at >= OLD.response_saved_at)
        ) THEN
          RAISE EXCEPTION 'response pointer must advance monotonically while the operation remains response_saved'
            USING ERRCODE = '55000';
        END IF;
        IF NEW.response_attempt_no IS NULL OR NEW.response_digest IS NULL OR NEW.response_saved_at IS NULL OR
          NEW.finalized_at IS NOT NULL OR NEW.encrypted_center_evidence IS NOT NULL OR
          NEW.center_evidence_key_id IS NOT NULL OR NEW.center_evidence_digest IS NOT NULL THEN
          RAISE EXCEPTION 'saved response pointer and center evidence boundary are invalid' USING ERRCODE = '55000';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM local_license_operation_attempts attempt
          WHERE attempt.operation_id = NEW.operation_id
            AND attempt.attempt_no = NEW.response_attempt_no
            AND attempt.send_state = 'response_saved'
            AND attempt.response_digest = NEW.response_digest
            AND attempt.response_saved_at = NEW.response_saved_at
        ) THEN
          RAISE EXCEPTION 'saved center response must match an immutable attempt' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE OR REPLACE FUNCTION guard_local_license_operation_attempt_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'local license operation attempts are permanent' USING ERRCODE = '55000';
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
