import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const singleInitialActivationAttemptMigration: Migration = {
  async up(db) {
    await sql.raw(`
      CREATE UNIQUE INDEX local_license_operation_attempts_single_initial_activation
        ON local_license_operation_attempts(operation_id)
        WHERE purpose = 'activation';

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
          RAISE EXCEPTION 'local license attempt evidence is immutable' USING ERRCODE = '55000';
        END IF;
        IF OLD.send_state IN ('transport_error', 'response_saved') THEN
          RAISE EXCEPTION 'completed local license attempt cannot be changed' USING ERRCODE = '55000';
        END IF;
        IF NOT (
          (OLD.send_state = 'prepared' AND NEW.send_state IN ('sent', 'transport_unknown', 'transport_error'))
          OR (OLD.send_state = 'sent' AND NEW.send_state IN ('transport_unknown', 'transport_error', 'response_saved'))
          OR (OLD.send_state = 'transport_unknown' AND NEW.send_state = 'response_saved')
        ) THEN
          RAISE EXCEPTION 'invalid local license attempt send-state transition' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END
      $$;
    `).execute(db)
  },
}
