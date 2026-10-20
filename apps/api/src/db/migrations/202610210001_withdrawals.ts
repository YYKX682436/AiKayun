import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** ④-9B completes the existing withdrawal foundation without adding another ledger. */
export const withdrawalsMigration: Migration = {
  async up(db) {
    await sql`
      ALTER TABLE storefront_customer_policy
        ADD COLUMN withdrawal_enabled boolean NOT NULL DEFAULT false,
        ADD COLUMN withdrawal_min_amount numeric(18, 2) NOT NULL DEFAULT 1.00,
        ADD COLUMN withdrawal_max_amount numeric(18, 2) NOT NULL DEFAULT 10000.00,
        ADD COLUMN withdrawal_fixed_fee numeric(18, 2) NOT NULL DEFAULT 0.00,
        ADD COLUMN withdrawal_percent_fee numeric(7, 4) NOT NULL DEFAULT 0.0000,
        ADD COLUMN withdrawal_methods text[] NOT NULL DEFAULT ARRAY['alipay', 'wechat', 'bank_card']::text[],
        ADD CONSTRAINT storefront_customer_policy_withdrawal_limits_check CHECK (
          withdrawal_min_amount > 0 AND withdrawal_max_amount >= withdrawal_min_amount
        ),
        ADD CONSTRAINT storefront_customer_policy_withdrawal_fixed_fee_check CHECK (
          withdrawal_fixed_fee >= 0 AND withdrawal_fixed_fee < 'Infinity'::numeric
        ),
        ADD CONSTRAINT storefront_customer_policy_withdrawal_percent_fee_check CHECK (
          withdrawal_percent_fee >= 0 AND withdrawal_percent_fee <= 100
        ),
        ADD CONSTRAINT storefront_customer_policy_withdrawal_methods_check CHECK (
          cardinality(withdrawal_methods) <= 3
          AND withdrawal_methods <@ ARRAY['alipay', 'wechat', 'bank_card']::text[]
        )
    `.execute(db)

    await sql`
      ALTER TABLE withdrawals
        ADD COLUMN rejection_reason varchar(500),
        ADD CONSTRAINT withdrawals_rejection_reason_check CHECK (
          rejection_reason IS NULL OR length(btrim(rejection_reason)) BETWEEN 1 AND 500
        ),
        ADD CONSTRAINT withdrawals_id_customer_unique UNIQUE (id, customer_id)
    `.execute(db)

    await sql`
      CREATE TABLE withdrawal_audit_events (
        id uuid PRIMARY KEY,
        withdrawal_id uuid NOT NULL,
        action varchar(48) NOT NULL,
        actor_type varchar(16) NOT NULL,
        actor_customer_id uuid,
        actor_admin_id uuid,
        idempotency_key uuid,
        request_sha256 char(64),
        previous_status varchar(32),
        next_status varchar(32),
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT withdrawal_audit_withdrawal_fkey
          FOREIGN KEY (withdrawal_id) REFERENCES withdrawals (id) ON DELETE RESTRICT,
        CONSTRAINT withdrawal_audit_customer_fkey
          FOREIGN KEY (actor_customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
        CONSTRAINT withdrawal_audit_admin_fkey
          FOREIGN KEY (actor_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT withdrawal_audit_action_check CHECK (length(btrim(action)) > 0),
        CONSTRAINT withdrawal_audit_actor_check CHECK (
          (actor_type = 'customer' AND actor_customer_id IS NOT NULL AND actor_admin_id IS NULL)
          OR (actor_type = 'admin' AND actor_customer_id IS NULL AND actor_admin_id IS NOT NULL)
          OR (actor_type = 'system' AND actor_customer_id IS NULL AND actor_admin_id IS NULL)
        ),
        CONSTRAINT withdrawal_audit_hash_check CHECK (
          request_sha256 IS NULL OR request_sha256 ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT withdrawal_audit_details_check CHECK (jsonb_typeof(details) = 'object')
      )
    `.execute(db)
    await sql`CREATE INDEX withdrawal_audit_created_idx ON withdrawal_audit_events (withdrawal_id, created_at, id)`.execute(db)
    await sql`CREATE UNIQUE INDEX withdrawal_audit_idempotency_unique
      ON withdrawal_audit_events (withdrawal_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.execute(db)
    await sql`
      INSERT INTO withdrawal_audit_events (id, withdrawal_id, action, actor_type, details)
      SELECT gen_random_uuid(), withdrawal.id, 'pre_9b_migration_snapshot', 'system',
        jsonb_build_object('status', withdrawal.status, 'amount', withdrawal.amount::text)
      FROM withdrawals AS withdrawal
    `.execute(db)

    await sql`
      CREATE TABLE withdrawal_settings_audit_events (
        id uuid PRIMARY KEY,
        administrator_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE RESTRICT,
        before_settings jsonb NOT NULL,
        after_settings jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT withdrawal_settings_audit_before_check CHECK (jsonb_typeof(before_settings) = 'object'),
        CONSTRAINT withdrawal_settings_audit_after_check CHECK (jsonb_typeof(after_settings) = 'object')
      )
    `.execute(db)

    await sql`
      CREATE TABLE withdrawal_private_files (
        id uuid PRIMARY KEY,
        customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
        withdrawal_id uuid,
        mime_type varchar(24) NOT NULL,
        size_bytes integer NOT NULL,
        sha256 char(64) NOT NULL,
        content bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT withdrawal_private_files_owner_fkey
          FOREIGN KEY (withdrawal_id, customer_id) REFERENCES withdrawals (id, customer_id) ON DELETE RESTRICT,
        CONSTRAINT withdrawal_private_files_mime_check CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
        CONSTRAINT withdrawal_private_files_size_check CHECK (
          size_bytes BETWEEN 1 AND 5242880 AND octet_length(content) = size_bytes
        ),
        CONSTRAINT withdrawal_private_files_hash_check CHECK (sha256 ~ '^[0-9a-f]{64}$')
      )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX withdrawal_private_files_withdrawal_unique
      ON withdrawal_private_files (withdrawal_id) WHERE withdrawal_id IS NOT NULL`.execute(db)
    await sql`CREATE INDEX withdrawal_private_files_customer_created_idx
      ON withdrawal_private_files (customer_id, created_at DESC)`.execute(db)

    await sql`
      CREATE TABLE withdrawal_payout_results (
        attempt_id uuid PRIMARY KEY REFERENCES withdrawal_payout_attempts (id) ON DELETE RESTRICT,
        outcome varchar(16) NOT NULL,
        resolved_by_admin_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE RESTRICT,
        provider_reference varchar(200),
        actual_payout_amount numeric(18, 2),
        actual_payout_at timestamptz,
        confirmed_no_transfer boolean NOT NULL DEFAULT false,
        evidence_sha256 char(64) NOT NULL,
        evidence_summary varchar(500) NOT NULL,
        result_sha256 char(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT withdrawal_payout_results_outcome_check CHECK (outcome IN ('succeeded', 'failed')),
        CONSTRAINT withdrawal_payout_results_evidence_check CHECK (
          evidence_sha256 ~ '^[0-9a-f]{64}$' AND result_sha256 ~ '^[0-9a-f]{64}$'
          AND length(btrim(evidence_summary)) BETWEEN 1 AND 500
        ),
        CONSTRAINT withdrawal_payout_results_shape_check CHECK (
          (outcome = 'succeeded' AND provider_reference IS NOT NULL
            AND length(btrim(provider_reference)) BETWEEN 1 AND 200
            AND actual_payout_amount > 0 AND actual_payout_at IS NOT NULL
            AND confirmed_no_transfer = false)
          OR (outcome = 'failed' AND provider_reference IS NULL
            AND actual_payout_amount IS NULL AND actual_payout_at IS NULL
            AND confirmed_no_transfer = true)
        )
      )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX withdrawal_payout_results_reference_unique
      ON withdrawal_payout_results (provider_reference) WHERE provider_reference IS NOT NULL`.execute(db)

    await sql`
      CREATE FUNCTION append_withdrawal_audit_event(
        withdrawal_uuid uuid,
        action_name varchar,
        actor_kind_input varchar,
        customer_uuid_input uuid,
        admin_uuid_input uuid,
        idempotency_uuid uuid,
        request_hash_input char(64),
        previous_state varchar,
        next_state varchar,
        details_json jsonb
      ) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        actor_kind varchar(16);
        customer_uuid uuid;
        admin_uuid uuid;
      BEGIN
        actor_kind := COALESCE(NULLIF(actor_kind_input, ''), NULLIF(current_setting('aikayun.withdrawal_actor_type', true), ''), 'system');
        customer_uuid := COALESCE(customer_uuid_input, NULLIF(current_setting('aikayun.withdrawal_actor_customer_id', true), '')::uuid);
        admin_uuid := COALESCE(admin_uuid_input, NULLIF(current_setting('aikayun.withdrawal_actor_admin_id', true), '')::uuid);
        IF actor_kind NOT IN ('customer', 'admin', 'system') THEN actor_kind := 'system'; END IF;
        IF actor_kind <> 'customer' THEN customer_uuid := NULL; END IF;
        IF actor_kind <> 'admin' THEN admin_uuid := NULL; END IF;
        INSERT INTO withdrawal_audit_events (
          id, withdrawal_id, action, actor_type, actor_customer_id, actor_admin_id,
          idempotency_key, request_sha256, previous_status, next_status, details
        ) VALUES (
          gen_random_uuid(), withdrawal_uuid, action_name, actor_kind, customer_uuid, admin_uuid,
          idempotency_uuid, request_hash_input, previous_state, next_state, COALESCE(details_json, '{}'::jsonb)
        );
      END;
      $$
    `.execute(db)

    await sql`
      CREATE FUNCTION audit_withdrawal_status() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          PERFORM append_withdrawal_audit_event(NEW.id, 'status_changed', NULL, NULL, NULL, NULL, NULL,
            NULL, NEW.status, jsonb_build_object('amount', NEW.amount::text));
        ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
          PERFORM append_withdrawal_audit_event(NEW.id, 'status_changed', NULL, NULL, NULL, NULL, NULL,
            OLD.status, NEW.status, jsonb_build_object('amount', NEW.amount::text));
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawals_audit_status AFTER INSERT OR UPDATE OF status ON withdrawals
      FOR EACH ROW EXECUTE FUNCTION audit_withdrawal_status()`.execute(db)

    await sql`
      CREATE FUNCTION guard_withdrawal_rejection_reason() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.rejection_reason IS DISTINCT FROM NEW.rejection_reason
          AND NOT (OLD.status = 'pending_review' AND NEW.status = 'rejected'
            AND NEW.rejection_reason IS NOT NULL AND length(btrim(NEW.rejection_reason)) BETWEEN 1 AND 500) THEN
          RAISE EXCEPTION 'A withdrawal rejection reason is immutable after review'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawals_rejection_reason_immutable';
        END IF;
        IF NEW.status = 'rejected' AND NEW.rejection_reason IS NULL THEN
          RAISE EXCEPTION 'A rejected withdrawal requires a reason'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawals_rejection_reason_required';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawals_rejection_reason_guard BEFORE UPDATE ON withdrawals
      FOR EACH ROW EXECUTE FUNCTION guard_withdrawal_rejection_reason()`.execute(db)

    await sql`
      CREATE FUNCTION guard_withdrawal_private_file() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.withdrawal_id IS NOT NULL OR OLD.created_at >= clock_timestamp() - interval '24 hours' THEN
            RAISE EXCEPTION 'Attached or unexpired withdrawal recipient files are permanent private records'
              USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_private_file_immutable';
          END IF;
          RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF OLD.withdrawal_id IS NOT NULL OR NEW.withdrawal_id IS NULL
            OR ROW(NEW.id, NEW.customer_id, NEW.mime_type, NEW.size_bytes, NEW.sha256, NEW.content, NEW.created_at)
              IS DISTINCT FROM ROW(OLD.id, OLD.customer_id, OLD.mime_type, OLD.size_bytes, OLD.sha256, OLD.content, OLD.created_at)
            OR NOT EXISTS (
              SELECT 1 FROM withdrawals AS withdrawal
              WHERE withdrawal.id = NEW.withdrawal_id AND withdrawal.customer_id = NEW.customer_id
                AND withdrawal.recipient_snapshot->>'qrFileId' = NEW.id::text
            ) THEN
            RAISE EXCEPTION 'A private recipient file can only be attached once to its owner withdrawal'
              USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_private_file_attachment_immutable';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawal_private_files_guard BEFORE UPDATE OR DELETE ON withdrawal_private_files
      FOR EACH ROW EXECUTE FUNCTION guard_withdrawal_private_file()`.execute(db)
    await sql`CREATE TRIGGER withdrawal_private_files_prevent_truncate BEFORE TRUNCATE ON withdrawal_private_files
      FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      CREATE FUNCTION assert_withdrawal_private_file_owner() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE file_uuid uuid;
      BEGIN
        file_uuid := NULLIF(NEW.recipient_snapshot->>'qrFileId', '')::uuid;
        IF file_uuid IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM withdrawal_private_files AS private_file
          WHERE private_file.id = file_uuid AND private_file.customer_id = NEW.customer_id
            AND private_file.withdrawal_id = NEW.id
        ) THEN
          RAISE EXCEPTION 'A withdrawal QR file must be private to and attached to its customer withdrawal'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_private_file_owner';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER withdrawals_private_file_owner_check AFTER INSERT ON withdrawals
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_withdrawal_private_file_owner()`.execute(db)

    await sql`
      CREATE FUNCTION guard_withdrawal_payout_result_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE attempt_status varchar(16);
      BEGIN
        SELECT status INTO attempt_status FROM withdrawal_payout_attempts WHERE id = NEW.attempt_id;
        IF attempt_status NOT IN ('started', 'unknown') THEN
          RAISE EXCEPTION 'A payout result requires an active manual transfer attempt'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_result_active_attempt';
        END IF;
        IF NEW.provider_reference IS NOT NULL AND EXISTS (
          SELECT 1 FROM withdrawal_payout_attempts AS old_attempt
          WHERE old_attempt.provider_reference = NEW.provider_reference AND old_attempt.id <> NEW.attempt_id
        ) THEN
          RAISE EXCEPTION 'A withdrawal transfer reference has already been recorded'
            USING ERRCODE = '23505', CONSTRAINT = 'withdrawal_payout_reference_unique';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawal_payout_results_insert_guard BEFORE INSERT ON withdrawal_payout_results
      FOR EACH ROW EXECUTE FUNCTION guard_withdrawal_payout_result_insert()`.execute(db)
    await sql`
      CREATE FUNCTION guard_withdrawal_payout_result_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Withdrawal payout results are immutable financial evidence'
          USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_results_immutable';
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawal_payout_results_immutable BEFORE UPDATE OR DELETE ON withdrawal_payout_results
      FOR EACH ROW EXECUTE FUNCTION guard_withdrawal_payout_result_update()`.execute(db)
    await sql`CREATE TRIGGER withdrawal_payout_results_prevent_truncate BEFORE TRUNCATE ON withdrawal_payout_results
      FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      CREATE FUNCTION guard_withdrawal_payout_reference() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.provider_reference IS NOT NULL AND EXISTS (
          SELECT 1 FROM withdrawal_payout_results AS result
          WHERE result.provider_reference = NEW.provider_reference AND result.attempt_id <> NEW.id
        ) THEN
          RAISE EXCEPTION 'A withdrawal transfer reference has already been recorded'
            USING ERRCODE = '23505', CONSTRAINT = 'withdrawal_payout_reference_unique';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawal_payout_attempt_reference_guard BEFORE INSERT ON withdrawal_payout_attempts
      FOR EACH ROW EXECUTE FUNCTION guard_withdrawal_payout_reference()`.execute(db)

    await sql`
      CREATE FUNCTION guard_withdrawal_payout_terminal_result() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE withdrawal_payout_amount numeric(18, 2);
      DECLARE payout_result withdrawal_payout_results%ROWTYPE;
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('succeeded', 'failed') THEN
          SELECT withdrawal.payout_amount INTO withdrawal_payout_amount
          FROM withdrawals AS withdrawal WHERE withdrawal.id = NEW.withdrawal_id;
          SELECT * INTO payout_result FROM withdrawal_payout_results WHERE attempt_id = NEW.id;
          IF NOT FOUND OR payout_result.outcome <> NEW.status
            OR payout_result.resolved_by_admin_id <> NEW.resolved_by_admin_id
            OR payout_result.result_sha256 <> NEW.result_sha256
            OR (NEW.status = 'succeeded' AND payout_result.actual_payout_amount <> withdrawal_payout_amount) THEN
            RAISE EXCEPTION 'A final payout state requires matching immutable transfer evidence'
              USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_result_required';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawal_payout_attempts_terminal_result_guard
      BEFORE UPDATE OF status ON withdrawal_payout_attempts
      FOR EACH ROW EXECUTE FUNCTION guard_withdrawal_payout_terminal_result()`.execute(db)

    await sql`
      CREATE FUNCTION assert_withdrawal_payout_result_terminal() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE attempt_row withdrawal_payout_attempts%ROWTYPE;
      DECLARE expected_amount numeric(18, 2);
      BEGIN
        SELECT * INTO attempt_row FROM withdrawal_payout_attempts WHERE id = NEW.attempt_id;
        SELECT withdrawal.payout_amount INTO expected_amount
          FROM withdrawals AS withdrawal WHERE withdrawal.id = attempt_row.withdrawal_id;
        IF attempt_row.status <> NEW.outcome OR attempt_row.resolved_by_admin_id <> NEW.resolved_by_admin_id
          OR attempt_row.result_sha256 <> NEW.result_sha256
          OR (NEW.outcome = 'succeeded' AND NEW.actual_payout_amount <> expected_amount) THEN
          RAISE EXCEPTION 'A final payout result must be committed with its matching payout attempt state'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_result_terminal_required';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER withdrawal_payout_results_terminal_check AFTER INSERT ON withdrawal_payout_results
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_withdrawal_payout_result_terminal()`.execute(db)

    await sql`
      CREATE FUNCTION audit_withdrawal_payout_attempt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE action_name varchar(48);
      DECLARE actor_uuid uuid;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          action_name := 'payout_attempt_started';
          actor_uuid := NEW.started_by_admin_id;
        ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
          action_name := CASE NEW.status
            WHEN 'unknown' THEN 'payout_result_unknown'
            WHEN 'succeeded' THEN 'payout_result_succeeded'
            WHEN 'failed' THEN 'payout_result_failed'
            ELSE 'payout_attempt_changed' END;
          actor_uuid := NEW.resolved_by_admin_id;
          IF actor_uuid IS NULL THEN actor_uuid := NULLIF(current_setting('aikayun.withdrawal_actor_admin_id', true), '')::uuid; END IF;
        ELSE
          RETURN NEW;
        END IF;
        PERFORM append_withdrawal_audit_event(NEW.withdrawal_id, action_name,
          CASE WHEN actor_uuid IS NULL THEN NULL ELSE 'admin' END, NULL, actor_uuid,
          NULL, NULL, OLD.status, NEW.status,
          jsonb_build_object('attemptId', NEW.id, 'operationId', NEW.operation_id));
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawal_payout_attempts_audit AFTER INSERT OR UPDATE OF status ON withdrawal_payout_attempts
      FOR EACH ROW EXECUTE FUNCTION audit_withdrawal_payout_attempt()`.execute(db)

    await sql`
      CREATE FUNCTION protect_withdrawal_audit_history() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Withdrawal audit history is append-only'
          USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_audit_immutable';
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawal_audit_immutable BEFORE UPDATE OR DELETE ON withdrawal_audit_events
      FOR EACH ROW EXECUTE FUNCTION protect_withdrawal_audit_history()`.execute(db)
    await sql`CREATE TRIGGER withdrawal_audit_prevent_truncate BEFORE TRUNCATE ON withdrawal_audit_events
      FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER withdrawal_settings_audit_immutable BEFORE UPDATE OR DELETE ON withdrawal_settings_audit_events
      FOR EACH ROW EXECUTE FUNCTION protect_withdrawal_audit_history()`.execute(db)
    await sql`CREATE TRIGGER withdrawal_settings_audit_prevent_truncate BEFORE TRUNCATE ON withdrawal_settings_audit_events
      FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
  },
}
