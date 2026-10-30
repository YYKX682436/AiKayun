import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const localLicenseOperationsMigration: Migration = {
  async up(db) {
    await sql.raw(`
      CREATE TABLE local_license_operations (
        operation_id uuid PRIMARY KEY,
        kind text NOT NULL,
        intent_digest char(43) NOT NULL,
        license_id uuid NOT NULL,
        database_id uuid NOT NULL,
        instance_id uuid NOT NULL,
        identity_jkt char(43) NOT NULL,
        expected_generation bigint,
        intent_schema smallint NOT NULL DEFAULT 1,
        payload_key_id varchar(48) NOT NULL,
        encrypted_intent_payload bytea NOT NULL,
        state text NOT NULL DEFAULT 'pending',
        response_attempt_no integer,
        response_digest char(43),
        encrypted_center_evidence bytea,
        center_evidence_key_id varchar(48),
        center_evidence_digest char(43),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        response_saved_at timestamptz,
        finalized_at timestamptz,
        CONSTRAINT local_license_operations_kind_check CHECK (kind IN (
          'activation', 'renewal', 'recovery', 'transfer_prepare', 'transfer_commit',
          'disaster_transfer_prepare', 'disaster_transfer_commit', 'time_reset'
        )),
        CONSTRAINT local_license_operations_intent_digest_check CHECK (intent_digest ~ '^[A-Za-z0-9_-]{43}$'),
        CONSTRAINT local_license_operations_identity_jkt_check CHECK (identity_jkt ~ '^[A-Za-z0-9_-]{43}$'),
        CONSTRAINT local_license_operations_generation_check CHECK (expected_generation IS NULL OR expected_generation > 0),
        CONSTRAINT local_license_operations_schema_check CHECK (intent_schema = 1),
        CONSTRAINT local_license_operations_key_id_check CHECK (payload_key_id ~ '^[A-Za-z0-9_-]{1,48}$'),
        CONSTRAINT local_license_operations_state_check CHECK (state IN (
          'pending', 'response_saved', 'projected', 'terminal', 'cancelled'
        )),
        CONSTRAINT local_license_operations_response_check CHECK (
          (state = 'pending' AND response_attempt_no IS NULL AND response_digest IS NULL AND response_saved_at IS NULL)
          OR (state <> 'pending' AND response_attempt_no IS NOT NULL AND response_digest IS NOT NULL
            AND response_digest ~ '^[A-Za-z0-9_-]{43}$'
            AND response_saved_at IS NOT NULL)
        ),
        CONSTRAINT local_license_operations_evidence_check CHECK (
          (state IN ('terminal', 'cancelled') AND encrypted_center_evidence IS NOT NULL
            AND center_evidence_key_id IS NOT NULL AND center_evidence_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND center_evidence_digest IS NOT NULL AND center_evidence_digest ~ '^[A-Za-z0-9_-]{43}$' AND finalized_at IS NOT NULL)
          OR (state NOT IN ('terminal', 'cancelled') AND encrypted_center_evidence IS NULL
            AND center_evidence_key_id IS NULL AND center_evidence_digest IS NULL
            AND (state <> 'projected' OR finalized_at IS NOT NULL)
            AND (state = 'projected' OR finalized_at IS NULL))
        )
      );

      CREATE TABLE local_license_operation_attempts (
        operation_id uuid NOT NULL REFERENCES local_license_operations(operation_id) ON DELETE RESTRICT,
        attempt_no integer NOT NULL,
        purpose text NOT NULL,
        intent_digest char(43) NOT NULL,
        client_nonce_hash char(43) NOT NULL,
        request_nonce_hash char(43) NOT NULL,
        request_body_digest char(43) NOT NULL,
        identity_jkt char(43) NOT NULL,
        signing_key_id varchar(128) NOT NULL,
        signature_created_at timestamptz NOT NULL,
        request_key_id varchar(48) NOT NULL,
        encrypted_request_envelope bytea NOT NULL,
        send_state text NOT NULL DEFAULT 'prepared',
        sent_at timestamptz,
        response_key_id varchar(48),
        encrypted_response bytea,
        response_digest char(43),
        response_saved_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (operation_id, attempt_no),
        CONSTRAINT local_license_operation_attempts_number_check CHECK (attempt_no > 0),
        CONSTRAINT local_license_operation_attempts_purpose_check CHECK (purpose IN (
          'activation', 'query', 'continue'
        )),
        CONSTRAINT local_license_operation_attempts_digest_check CHECK (
          intent_digest ~ '^[A-Za-z0-9_-]{43}$' AND client_nonce_hash ~ '^[A-Za-z0-9_-]{43}$'
          AND request_nonce_hash ~ '^[A-Za-z0-9_-]{43}$' AND request_body_digest ~ '^[A-Za-z0-9_-]{43}$'
          AND identity_jkt ~ '^[A-Za-z0-9_-]{43}$'
        ),
        CONSTRAINT local_license_operation_attempts_send_state_check CHECK (send_state IN (
          'prepared', 'sent', 'transport_unknown', 'transport_error', 'response_saved'
        )),
        CONSTRAINT local_license_operation_attempts_sent_at_check CHECK (
          (send_state = 'prepared' AND sent_at IS NULL)
          OR (send_state <> 'prepared' AND sent_at IS NOT NULL)
        ),
        CONSTRAINT local_license_operation_attempts_response_check CHECK (
          (send_state = 'response_saved' AND response_key_id IS NOT NULL AND response_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND encrypted_response IS NOT NULL AND response_digest IS NOT NULL
            AND response_digest ~ '^[A-Za-z0-9_-]{43}$'
            AND response_saved_at IS NOT NULL)
          OR (send_state <> 'response_saved' AND response_key_id IS NULL AND encrypted_response IS NULL
            AND response_digest IS NULL AND response_saved_at IS NULL)
        ),
        CONSTRAINT local_license_operation_attempts_key_id_check CHECK (
          request_key_id ~ '^[A-Za-z0-9_-]{1,48}$' AND signing_key_id <> ''
        ),
        CONSTRAINT local_license_operation_attempts_request_nonce_unique UNIQUE (request_nonce_hash),
        CONSTRAINT local_license_operation_attempts_client_nonce_unique UNIQUE (client_nonce_hash)
      );

      ALTER TABLE local_license_operations
        ADD CONSTRAINT local_license_operations_response_attempt_fk
        FOREIGN KEY (operation_id, response_attempt_no)
        REFERENCES local_license_operation_attempts(operation_id, attempt_no)
        DEFERRABLE INITIALLY DEFERRED;

      CREATE INDEX local_license_operations_license_created
        ON local_license_operations(license_id, created_at);
      CREATE UNIQUE INDEX local_license_operations_active_activation_binding
        ON local_license_operations(database_id, instance_id)
        WHERE kind = 'activation' AND state IN ('pending', 'response_saved', 'projected');

      CREATE FUNCTION guard_local_license_operation_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state <> 'pending' OR NEW.response_attempt_no IS NOT NULL OR NEW.response_digest IS NOT NULL
          OR NEW.response_saved_at IS NOT NULL OR NEW.finalized_at IS NOT NULL
          OR NEW.encrypted_center_evidence IS NOT NULL OR NEW.center_evidence_key_id IS NOT NULL
          OR NEW.center_evidence_digest IS NOT NULL THEN
          RAISE EXCEPTION 'new local license operations must start pending without center evidence' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER local_license_operations_insert_guard
        BEFORE INSERT ON local_license_operations
        FOR EACH ROW EXECUTE FUNCTION guard_local_license_operation_insert();

      CREATE FUNCTION guard_local_license_operation_attempt_insert() RETURNS trigger
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
          RAISE EXCEPTION 'only recovery query or continue attempts may follow a saved response' USING ERRCODE = '55000';
        END IF;
        IF NEW.intent_digest <> operation_row.intent_digest OR NEW.identity_jkt <> operation_row.identity_jkt THEN
          RAISE EXCEPTION 'attempt identity and intent must match the parent operation' USING ERRCODE = '23514';
        END IF;
        IF NEW.purpose = 'activation' AND operation_row.kind <> 'activation' THEN
          RAISE EXCEPTION 'activation attempt purpose must match an activation operation' USING ERRCODE = '23514';
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
      CREATE TRIGGER local_license_operation_attempts_insert_guard
        BEFORE INSERT ON local_license_operation_attempts
        FOR EACH ROW EXECUTE FUNCTION guard_local_license_operation_attempt_insert();

      CREATE FUNCTION guard_local_license_operation_mutation() RETURNS trigger
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
        IF NOT (
          (OLD.state = 'pending' AND NEW.state = 'response_saved'
            AND NEW.response_attempt_no IS NOT NULL
            AND NEW.response_attempt_no > 0)
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
      CREATE TRIGGER local_license_operations_immutable
        BEFORE UPDATE OR DELETE ON local_license_operations
        FOR EACH ROW EXECUTE FUNCTION guard_local_license_operation_mutation();

      CREATE FUNCTION guard_local_license_operation_attempt_mutation() RETURNS trigger
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
          (OLD.send_state = 'prepared' AND NEW.send_state IN ('sent', 'transport_unknown', 'transport_error', 'response_saved'))
          OR (OLD.send_state = 'sent' AND NEW.send_state IN ('transport_unknown', 'transport_error', 'response_saved'))
          OR (OLD.send_state = 'transport_unknown' AND NEW.send_state = 'response_saved')
        ) THEN
          RAISE EXCEPTION 'invalid local license attempt send-state transition' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER local_license_operation_attempts_append_only
        BEFORE UPDATE OR DELETE ON local_license_operation_attempts
        FOR EACH ROW EXECUTE FUNCTION guard_local_license_operation_attempt_mutation();

      CREATE FUNCTION require_parent_response_saved() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.send_state = 'response_saved' AND NOT EXISTS (
          SELECT 1 FROM local_license_operations operation
          JOIN local_license_operation_attempts latest
            ON latest.operation_id = operation.operation_id
            AND latest.attempt_no = operation.response_attempt_no
            AND latest.send_state = 'response_saved'
            AND latest.response_digest = operation.response_digest
            AND latest.response_saved_at = operation.response_saved_at
          WHERE operation.operation_id = NEW.operation_id
            AND operation.state = 'response_saved'
            AND operation.response_attempt_no >= NEW.attempt_no
        ) THEN
          RAISE EXCEPTION 'saved response evidence and the parent latest-response pointer must commit together' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END
      $$;
      CREATE CONSTRAINT TRIGGER local_license_operation_attempt_response_atomic
        AFTER INSERT OR UPDATE ON local_license_operation_attempts
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION require_parent_response_saved();

      CREATE FUNCTION prevent_local_license_operation_history_truncate() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'local license operation history cannot be truncated' USING ERRCODE = '55000';
      END
      $$;
      CREATE TRIGGER local_license_operations_no_truncate BEFORE TRUNCATE ON local_license_operations
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_license_operation_history_truncate();
      CREATE TRIGGER local_license_operation_attempts_no_truncate BEFORE TRUNCATE ON local_license_operation_attempts
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_license_operation_history_truncate();
    `).execute(db)
  },
}
