import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/**
 * ④-9A adds the workflow and audit surface around the refund allocations that
 * already exist in the ④-1 trade ledger. It deliberately does not introduce a
 * second balance or refund ledger.
 */
export const refundsMigration: Migration = {
  async up(db) {
    await sql`
      ALTER TABLE order_refunds
        ADD COLUMN reason varchar(500) NOT NULL DEFAULT '历史退款申请',
        ADD COLUMN rejection_reason varchar(500),
        ADD COLUMN reviewed_by_admin_id uuid REFERENCES admin_users (id) ON DELETE RESTRICT,
        ADD COLUMN reviewed_at timestamptz,
        ADD CONSTRAINT order_refunds_reason_check CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
        ADD CONSTRAINT order_refunds_rejection_reason_check CHECK (
          rejection_reason IS NULL OR length(btrim(rejection_reason)) BETWEEN 1 AND 500
        ),
        ADD CONSTRAINT order_refunds_review_state_check CHECK (
          (reviewed_by_admin_id IS NULL AND reviewed_at IS NULL)
          OR (reviewed_by_admin_id IS NOT NULL AND reviewed_at IS NOT NULL)
        )
    `.execute(db)

    await sql`
      CREATE TABLE order_refund_audit_events (
        id uuid PRIMARY KEY,
        refund_id uuid NOT NULL,
        action varchar(48) NOT NULL,
        actor_type varchar(16) NOT NULL,
        actor_customer_id uuid,
        actor_admin_id uuid,
        idempotency_key uuid,
        request_sha256 char(64),
        previous_status varchar(24),
        next_status varchar(24),
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT order_refund_audit_refund_fkey
          FOREIGN KEY (refund_id) REFERENCES order_refunds (id) ON DELETE RESTRICT,
        CONSTRAINT order_refund_audit_customer_fkey
          FOREIGN KEY (actor_customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
        CONSTRAINT order_refund_audit_admin_fkey
          FOREIGN KEY (actor_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT order_refund_audit_action_check CHECK (length(btrim(action)) > 0),
        CONSTRAINT order_refund_audit_actor_check CHECK (
          (actor_type = 'customer' AND actor_customer_id IS NOT NULL AND actor_admin_id IS NULL)
          OR (actor_type = 'admin' AND actor_customer_id IS NULL AND actor_admin_id IS NOT NULL)
          OR (actor_type IN ('guest', 'system') AND actor_customer_id IS NULL AND actor_admin_id IS NULL)
        ),
        CONSTRAINT order_refund_audit_hash_check CHECK (
          request_sha256 IS NULL OR request_sha256 ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT order_refund_audit_details_check CHECK (jsonb_typeof(details) = 'object')
      )
    `.execute(db)
    await sql`CREATE INDEX order_refund_audit_refund_created_idx
      ON order_refund_audit_events (refund_id, created_at, id)`.execute(db)
    await sql`CREATE UNIQUE INDEX order_refund_audit_idempotency_unique
      ON order_refund_audit_events (refund_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.execute(db)
    await sql`
      INSERT INTO order_refund_audit_events (
        id, refund_id, action, actor_type, details
      )
      SELECT gen_random_uuid(), refund.id, 'pre_9a_migration_snapshot', 'system',
        jsonb_build_object('status', refund.status, 'amount', refund.amount::text)
      FROM order_refunds AS refund
    `.execute(db)

    await sql`
      CREATE TABLE order_refund_manual_attempts (
        id uuid PRIMARY KEY,
        allocation_id uuid NOT NULL,
        idempotency_key uuid NOT NULL,
        request_sha256 char(64) NOT NULL,
        started_by_admin_id uuid NOT NULL,
        resolved_by_admin_id uuid,
        status varchar(16) NOT NULL DEFAULT 'started',
        provider_reference varchar(200),
        refunded_amount numeric(18, 2),
        actual_refunded_at timestamptz,
        evidence_summary varchar(500),
        resolution_note varchar(500),
        result_sha256 char(64),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz,
        CONSTRAINT order_refund_manual_attempt_allocation_fkey
          FOREIGN KEY (allocation_id) REFERENCES order_refund_allocations (id) ON DELETE RESTRICT,
        CONSTRAINT order_refund_manual_attempt_started_admin_fkey
          FOREIGN KEY (started_by_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT order_refund_manual_attempt_resolved_admin_fkey
          FOREIGN KEY (resolved_by_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT order_refund_manual_attempt_hash_check CHECK (
          request_sha256 ~ '^[0-9a-f]{64}$'
          AND (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$')
        ),
        CONSTRAINT order_refund_manual_attempt_status_check CHECK (status IN ('started', 'unknown', 'succeeded', 'failed')),
        CONSTRAINT order_refund_manual_attempt_result_check CHECK (
          (status = 'started' AND resolved_by_admin_id IS NULL AND provider_reference IS NULL
            AND refunded_amount IS NULL AND actual_refunded_at IS NULL AND evidence_summary IS NULL
            AND resolution_note IS NULL AND result_sha256 IS NULL AND completed_at IS NULL)
          OR (status = 'unknown' AND resolved_by_admin_id IS NOT NULL AND resolution_note IS NOT NULL
            AND length(btrim(resolution_note)) BETWEEN 1 AND 500 AND result_sha256 ~ '^[0-9a-f]{64}$'
            AND provider_reference IS NULL AND refunded_amount IS NULL AND actual_refunded_at IS NULL
            AND evidence_summary IS NULL AND completed_at IS NOT NULL)
          OR (status = 'succeeded' AND resolved_by_admin_id IS NOT NULL
            AND provider_reference IS NOT NULL AND length(btrim(provider_reference)) BETWEEN 1 AND 200
            AND refunded_amount > 0 AND actual_refunded_at IS NOT NULL
            AND evidence_summary IS NOT NULL AND length(btrim(evidence_summary)) BETWEEN 1 AND 500
            AND resolution_note IS NULL AND result_sha256 ~ '^[0-9a-f]{64}$' AND completed_at IS NOT NULL)
          OR (status = 'failed' AND resolved_by_admin_id IS NOT NULL AND resolution_note IS NOT NULL
            AND length(btrim(resolution_note)) BETWEEN 1 AND 500 AND result_sha256 ~ '^[0-9a-f]{64}$'
            AND provider_reference IS NULL AND refunded_amount IS NULL AND actual_refunded_at IS NULL
            AND evidence_summary IS NULL AND completed_at IS NOT NULL)
        ),
        CONSTRAINT order_refund_manual_attempt_idempotency_unique UNIQUE (allocation_id, idempotency_key)
      )
    `.execute(db)
    await sql`CREATE INDEX order_refund_manual_attempt_allocation_idx
      ON order_refund_manual_attempts (allocation_id, created_at, id)`.execute(db)
    await sql`CREATE UNIQUE INDEX order_refund_manual_attempt_active_unique
      ON order_refund_manual_attempts (allocation_id) WHERE status IN ('started', 'unknown')`.execute(db)

    await sql`
      CREATE FUNCTION append_order_refund_audit_event(
        refund_uuid uuid,
        action_name varchar,
        previous_state varchar,
        next_state varchar,
        details_json jsonb
      ) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        actor_kind text;
        customer_uuid uuid;
        admin_uuid uuid;
      BEGIN
        actor_kind := NULLIF(current_setting('aikayun.refund_actor_type', true), '');
        customer_uuid := NULLIF(current_setting('aikayun.refund_actor_customer_id', true), '')::uuid;
        admin_uuid := NULLIF(current_setting('aikayun.refund_actor_admin_id', true), '')::uuid;
        IF actor_kind IS NULL THEN actor_kind := 'system'; END IF;
        IF actor_kind NOT IN ('customer', 'guest', 'admin', 'system') THEN actor_kind := 'system'; END IF;
        IF actor_kind <> 'customer' THEN customer_uuid := NULL; END IF;
        IF actor_kind <> 'admin' THEN admin_uuid := NULL; END IF;
        INSERT INTO order_refund_audit_events (
          id, refund_id, action, actor_type, actor_customer_id, actor_admin_id,
          previous_status, next_status, details
        ) VALUES (
          gen_random_uuid(), refund_uuid, action_name, actor_kind, customer_uuid, admin_uuid,
          previous_state, next_state, COALESCE(details_json, '{}'::jsonb)
        );
      END;
      $$
    `.execute(db)

    await sql`
      CREATE FUNCTION audit_order_refund_status() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          PERFORM append_order_refund_audit_event(NEW.id, 'status_changed', NULL, NEW.status,
            jsonb_build_object('amount', NEW.amount::text, 'reason', NEW.reason));
        ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
          PERFORM append_order_refund_audit_event(NEW.id, 'status_changed', OLD.status, NEW.status,
            jsonb_build_object('amount', NEW.amount::text));
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_refunds_audit_status AFTER INSERT OR UPDATE OF status ON order_refunds
      FOR EACH ROW EXECUTE FUNCTION audit_order_refund_status()`.execute(db)

    await sql`
      CREATE FUNCTION audit_order_refund_allocation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        action_name varchar(48);
        bucket_name varchar(16);
        receipt_amount numeric(18, 2);
      BEGIN
        SELECT source_bucket, amount INTO bucket_name, receipt_amount
        FROM payment_receipts WHERE id = NEW.source_payment_receipt_id;
        IF TG_OP = 'INSERT' THEN
          action_name := 'allocation_reserved';
          PERFORM append_order_refund_audit_event(NEW.refund_id, action_name, NULL, NEW.status,
            jsonb_build_object('allocationId', NEW.id, 'operationId', NEW.operation_id,
              'sourceReceiptId', NEW.source_payment_receipt_id, 'sourceBucket', bucket_name,
              'sourceReceiptAmount', receipt_amount::text, 'destination', NEW.destination, 'amount', NEW.amount::text));
        ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
          action_name := CASE NEW.status WHEN 'succeeded' THEN 'allocation_succeeded' ELSE 'allocation_released' END;
          PERFORM append_order_refund_audit_event(NEW.refund_id, action_name, OLD.status, NEW.status,
            jsonb_build_object('allocationId', NEW.id, 'operationId', NEW.operation_id,
              'sourceReceiptId', NEW.source_payment_receipt_id, 'sourceBucket', bucket_name,
              'sourceReceiptAmount', receipt_amount::text, 'destination', NEW.destination,
              'amount', NEW.amount::text, 'provider', NEW.provider, 'providerRefundId', NEW.provider_refund_id));
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_refund_allocations_audit AFTER INSERT OR UPDATE OF status ON order_refund_allocations
      FOR EACH ROW EXECUTE FUNCTION audit_order_refund_allocation()`.execute(db)

    await sql`
      CREATE FUNCTION audit_order_refund_manual_attempt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE refund_uuid uuid;
      BEGIN
        SELECT refund_id INTO refund_uuid FROM order_refund_allocations WHERE id = NEW.allocation_id;
        IF TG_OP = 'INSERT' THEN
          PERFORM append_order_refund_audit_event(refund_uuid, 'manual_attempt_started', NULL, NEW.status,
            jsonb_build_object('manualAttemptId', NEW.id, 'allocationId', NEW.allocation_id,
              'startedByAdminId', NEW.started_by_admin_id));
        ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
          PERFORM append_order_refund_audit_event(refund_uuid,
            CASE NEW.status WHEN 'unknown' THEN 'manual_attempt_unknown'
              WHEN 'succeeded' THEN 'manual_refund_confirmed' ELSE 'manual_attempt_failed' END,
            OLD.status, NEW.status,
            jsonb_build_object('manualAttemptId', NEW.id, 'allocationId', NEW.allocation_id,
              'startedByAdminId', NEW.started_by_admin_id, 'resolvedByAdminId', NEW.resolved_by_admin_id,
              'providerReference', NEW.provider_reference, 'amount', NEW.refunded_amount::text,
              'actualRefundedAt', NEW.actual_refunded_at, 'evidenceSummary', NEW.evidence_summary,
              'resolutionNote', NEW.resolution_note, 'resultSha256', NEW.result_sha256));
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_refund_manual_attempts_audit AFTER INSERT OR UPDATE OF status ON order_refund_manual_attempts
      FOR EACH ROW EXECUTE FUNCTION audit_order_refund_manual_attempt()`.execute(db)

    await sql`
      CREATE FUNCTION guard_order_refund_manual_attempt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE allocation_row order_refund_allocations%ROWTYPE;
        refund_row order_refunds%ROWTYPE;
        order_owner uuid;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.status <> 'started' OR NEW.resolved_by_admin_id IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
            RAISE EXCEPTION 'Manual refund attempts must start unresolved'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refund_manual_attempt_initial_state';
          END IF;
          SELECT * INTO allocation_row FROM order_refund_allocations WHERE id = NEW.allocation_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Manual refunds require a reserved original-source allocation'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refund_manual_attempt_allocation_required';
          END IF;
          SELECT * INTO refund_row FROM order_refunds WHERE id = allocation_row.refund_id;
          IF allocation_row.destination <> 'original_source' OR allocation_row.status <> 'reserved' THEN
            RAISE EXCEPTION 'Manual refunds require a reserved original-source allocation'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refund_manual_attempt_allocation_required';
          END IF;
          SELECT customer_id INTO order_owner FROM orders WHERE id = refund_row.order_id;
          IF order_owner IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM payment_receipts AS receipt
            JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
            WHERE receipt.id = allocation_row.source_payment_receipt_id
              AND receipt.source_bucket = 'external' AND attempt.provider IS NOT NULL
          ) THEN
            RAISE EXCEPTION 'Manual original-source refunds are restricted to guest external receipts'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refund_manual_attempt_guest_external_only';
          END IF;
          IF order_has_unresolved_payment_attempts(refund_row.order_id)
            OR EXISTS (
              SELECT 1 FROM payment_provider_reconciliation_cases AS reconciliation
              JOIN payment_attempts AS source_attempt ON source_attempt.id = reconciliation.payment_attempt_id
              WHERE source_attempt.order_id = refund_row.order_id AND reconciliation.state = 'open'
            ) OR EXISTS (SELECT 1 FROM payment_attempts AS source_attempt
              WHERE source_attempt.order_id = refund_row.order_id
                AND source_attempt.status = 'reconciliation_required') THEN
            RAISE EXCEPTION 'Manual refund transfer cannot start during unresolved payment or reconciliation evidence'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refund_manual_attempt_payment_unresolved';
          END IF;
          RETURN NEW;
        END IF;

        IF ROW(NEW.id, NEW.allocation_id, NEW.idempotency_key, NEW.request_sha256,
               NEW.started_by_admin_id, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.allocation_id, OLD.idempotency_key, OLD.request_sha256,
               OLD.started_by_admin_id, OLD.created_at) THEN
          RAISE EXCEPTION 'Manual refund attempt identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_manual_attempt_identity_immutable';
        END IF;
        IF OLD.status NOT IN ('started', 'unknown') OR NEW.status NOT IN ('unknown', 'succeeded', 'failed')
          OR (OLD.status = 'unknown' AND NEW.status = 'unknown')
          OR NEW.status = OLD.status OR NEW.resolved_by_admin_id IS NULL THEN
          RAISE EXCEPTION 'Manual refund attempts can only be resolved once per recorded outcome'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_manual_attempt_transition';
        END IF;
        IF NEW.status = 'succeeded' THEN
          SELECT * INTO allocation_row FROM order_refund_allocations WHERE id = NEW.allocation_id;
          SELECT * INTO refund_row FROM order_refunds WHERE id = allocation_row.refund_id;
          IF allocation_row.status <> 'reserved' OR allocation_row.destination <> 'original_source'
            OR NEW.refunded_amount IS DISTINCT FROM allocation_row.amount
            OR NEW.provider_reference IS NULL OR NEW.actual_refunded_at > clock_timestamp()
            OR NEW.evidence_summary IS NULL OR length(btrim(NEW.evidence_summary)) NOT BETWEEN 1 AND 500
            OR EXISTS (
              SELECT 1 FROM orders WHERE id = refund_row.order_id AND customer_id IS NOT NULL
            ) THEN
            RAISE EXCEPTION 'Manual refund success requires a real exact-amount guest transfer record'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refund_manual_attempt_success_evidence';
          END IF;
        END IF;
        NEW.completed_at := clock_timestamp();
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_refund_manual_attempts_guard
      BEFORE INSERT OR UPDATE ON order_refund_manual_attempts
      FOR EACH ROW EXECUTE FUNCTION guard_order_refund_manual_attempt()`.execute(db)
    await sql`CREATE TRIGGER order_refund_manual_attempts_immutable
      BEFORE DELETE ON order_refund_manual_attempts FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER order_refund_manual_attempts_prevent_truncate
      BEFORE TRUNCATE ON order_refund_manual_attempts FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      CREATE FUNCTION apply_order_refund_manual_attempt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE source_provider varchar(64);
        allocation_row order_refund_allocations%ROWTYPE;
        refund_row order_refunds%ROWTYPE;
      BEGIN
        IF OLD.status IS NOT DISTINCT FROM NEW.status OR NEW.status NOT IN ('succeeded', 'failed') THEN
          RETURN NEW;
        END IF;
        IF NEW.status = 'succeeded' THEN
          SELECT attempt.provider INTO source_provider
          FROM order_refund_allocations AS allocation
          JOIN payment_receipts AS receipt ON receipt.id = allocation.source_payment_receipt_id
          JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
          WHERE allocation.id = NEW.allocation_id;
          UPDATE order_refund_allocations SET
            status = 'succeeded', provider = source_provider, provider_refund_id = NEW.provider_reference
          WHERE id = NEW.allocation_id AND status = 'reserved';
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Manual refund success does not match a reserved allocation'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refund_manual_attempt_allocation_transition';
          END IF;
        ELSE
          UPDATE order_refund_allocations SET status = 'released'
          WHERE id = NEW.allocation_id AND status = 'reserved';
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Manual refund failure does not match a reserved allocation'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refund_manual_attempt_allocation_transition';
          END IF;
          SELECT * INTO allocation_row FROM order_refund_allocations WHERE id = NEW.allocation_id;
          SELECT * INTO refund_row FROM order_refunds WHERE id = allocation_row.refund_id;
          IF refund_row.status IN ('processing', 'partially_succeeded') AND EXISTS (
            SELECT 1 FROM order_refund_allocations
            WHERE refund_id = allocation_row.refund_id AND status IN ('succeeded', 'reserved')
          ) THEN
            INSERT INTO order_refund_allocations (
              id, refund_id, source_payment_receipt_id, operation_id, request_sha256,
              destination, amount, status, provider, provider_refund_id
            ) VALUES (
              gen_random_uuid(), allocation_row.refund_id, allocation_row.source_payment_receipt_id,
              gen_random_uuid(), allocation_row.request_sha256, allocation_row.destination,
              allocation_row.amount, 'reserved', NULL, NULL
            );
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_refund_manual_attempts_apply
      AFTER UPDATE OF status ON order_refund_manual_attempts
      FOR EACH ROW EXECUTE FUNCTION apply_order_refund_manual_attempt()`.execute(db)

    await sql`
      CREATE FUNCTION enforce_order_refund_claim_capacity() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE actual_available numeric(18, 2);
        other_claims numeric(18, 2);
        current_claim numeric(18, 2);
      BEGIN
        IF NEW.status NOT IN ('requested', 'approved', 'processing', 'partially_succeeded') THEN
          RETURN NEW;
        END IF;
        PERFORM id FROM orders WHERE id = NEW.order_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Refund order does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'order_refunds_order_fkey';
        END IF;
        SELECT COALESCE(sum(receipt.amount - receipt.refunded_amount - receipt.refund_reserved_amount), 0)
          INTO actual_available
        FROM payment_receipts AS receipt
        JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
        WHERE attempt.order_id = NEW.order_id;
        SELECT COALESCE(sum(GREATEST(refund.amount - allocation.succeeded - allocation.reserved, 0)), 0)
          INTO other_claims
        FROM order_refunds AS refund
        LEFT JOIN LATERAL (
          SELECT COALESCE(sum(amount) FILTER (WHERE status = 'succeeded'), 0) AS succeeded,
            COALESCE(sum(amount) FILTER (WHERE status = 'reserved'), 0) AS reserved
          FROM order_refund_allocations WHERE refund_id = refund.id
        ) AS allocation ON true
        WHERE refund.order_id = NEW.order_id AND refund.id <> NEW.id
          AND refund.status IN ('requested', 'approved', 'processing', 'partially_succeeded');
        SELECT GREATEST(NEW.amount - COALESCE(sum(amount) FILTER (WHERE status = 'succeeded'), 0)
          - COALESCE(sum(amount) FILTER (WHERE status = 'reserved'), 0), 0)
          INTO current_claim
        FROM order_refund_allocations WHERE refund_id = NEW.id;
        IF other_claims + current_claim > actual_available THEN
          RAISE EXCEPTION 'Refund requests exceed confirmed receipts after refunds and reservations'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refunds_exceed_actual_available';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_refunds_claim_capacity
      BEFORE INSERT OR UPDATE OF status ON order_refunds
      FOR EACH ROW EXECUTE FUNCTION enforce_order_refund_claim_capacity()`.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION guard_order_refund_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.status <> 'requested' THEN
            RAISE EXCEPTION 'Refund requests must start in requested state'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refunds_initial_state';
          END IF;
          RETURN NEW;
        END IF;
        IF ROW(NEW.id, NEW.order_id, NEW.idempotency_key, NEW.request_sha256, NEW.amount,
               NEW.reason, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.order_id, OLD.idempotency_key, OLD.request_sha256, OLD.amount,
               OLD.reason, OLD.created_at) THEN
          RAISE EXCEPTION 'Refund identity, requested amount and reason are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refunds_identity_immutable';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
          (OLD.status = 'requested' AND NEW.status IN ('approved', 'cancelled'))
          OR (OLD.status = 'approved' AND NEW.status IN ('processing', 'cancelled'))
          OR (OLD.status = 'processing' AND NEW.status IN ('partially_succeeded', 'succeeded', 'failed'))
          OR (OLD.status = 'partially_succeeded' AND NEW.status IN ('processing', 'succeeded', 'failed'))
          OR (OLD.status = 'failed' AND NEW.status = 'processing')
        ) THEN
          RAISE EXCEPTION 'Illegal refund status transition: % to %', OLD.status, NEW.status
            USING ERRCODE = '23514', CONSTRAINT = 'order_refunds_status_transition';
        END IF;
        IF OLD.reviewed_by_admin_id IS NOT NULL AND ROW(
          NEW.reviewed_by_admin_id, NEW.reviewed_at, NEW.rejection_reason
        ) IS DISTINCT FROM ROW(OLD.reviewed_by_admin_id, OLD.reviewed_at, OLD.rejection_reason) THEN
          RAISE EXCEPTION 'Refund review identity and decision are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refunds_review_immutable';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('approved', 'cancelled', 'failed')
          AND NEW.reviewed_by_admin_id IS NOT NULL THEN
          NEW.reviewed_at := COALESCE(NEW.reviewed_at, clock_timestamp());
        END IF;
        IF NEW.status = 'cancelled' AND NEW.reviewed_by_admin_id IS NOT NULL
          AND (NEW.rejection_reason IS NULL OR length(btrim(NEW.rejection_reason)) NOT BETWEEN 1 AND 500) THEN
          RAISE EXCEPTION 'Refund rejection requires a reason'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refunds_rejection_reason_required';
        END IF;
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION validate_refund_allocation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE refund_row order_refunds%ROWTYPE;
        receipt payment_receipts%ROWTYPE;
        attempt payment_attempts%ROWTYPE;
        owner_customer uuid;
      BEGIN
        IF NEW.status <> 'reserved' OR NEW.completed_at IS NOT NULL THEN
          RAISE EXCEPTION 'Refund allocations must start reserved and uncompleted'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_allocation_initial_state';
        END IF;
        SELECT * INTO refund_row FROM order_refunds WHERE id = NEW.refund_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Refund request does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'order_refund_allocations_refund_fkey';
        END IF;
        PERFORM id FROM orders WHERE id = refund_row.order_id FOR UPDATE;
        PERFORM id FROM order_refunds WHERE id = NEW.refund_id FOR UPDATE;
        SELECT * INTO receipt FROM payment_receipts WHERE id = NEW.source_payment_receipt_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Refund source receipt does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'order_refund_allocations_source_fkey';
        END IF;
        SELECT * INTO attempt FROM payment_attempts WHERE id = receipt.payment_attempt_id;
        IF attempt.order_id IS DISTINCT FROM refund_row.order_id THEN
          RAISE EXCEPTION 'Refund source belongs to another order'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_source_order_match';
        END IF;
        IF refund_row.status NOT IN ('approved', 'processing', 'partially_succeeded') THEN
          RAISE EXCEPTION 'Refund allocations require an approved or processing refund'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_allocation_state';
        END IF;
        IF attempt.status NOT IN ('succeeded', 'late_succeeded')
          OR receipt.disposition NOT IN ('on_time', 'late') THEN
          RAISE EXCEPTION 'Refund allocation requires a settled receipt with a usable disposition'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_receipt_not_refundable';
        END IF;
        IF NOT (
          (receipt.source_bucket = 'gift' AND NEW.destination = 'gift_balance')
          OR (receipt.source_bucket = 'cash' AND NEW.destination = 'cash_balance')
          OR (receipt.source_bucket = 'external' AND NEW.destination IN ('original_source', 'cash_balance'))
        ) THEN
          RAISE EXCEPTION 'Refund destination cannot convert gift funds into cash funds'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_source_bucket_match';
        END IF;
        IF NEW.destination IN ('cash_balance', 'gift_balance') THEN
          SELECT customer_id INTO owner_customer FROM orders WHERE id = refund_row.order_id;
          IF owner_customer IS NULL THEN
            RAISE EXCEPTION 'Guest order refunds cannot credit a customer wallet'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refund_guest_wallet_forbidden';
          END IF;
        END IF;
        IF NEW.destination = 'original_source' THEN
          SELECT customer_id INTO owner_customer FROM orders WHERE id = refund_row.order_id;
        END IF;
        IF NEW.destination = 'original_source'
          AND (receipt.source_bucket <> 'external' OR owner_customer IS NOT NULL) THEN
          RAISE EXCEPTION 'Original-source refund allocations are restricted to guest external receipts'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_original_source_external_only';
        END IF;
        IF NEW.status = 'reserved' AND NEW.provider_refund_id IS NOT NULL THEN
          RAISE EXCEPTION 'A reserved refund has not yet been confirmed by its provider'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_provider_confirmation_required';
        END IF;
        UPDATE payment_receipts SET refund_reserved_amount = refund_reserved_amount + NEW.amount
        WHERE id = NEW.source_payment_receipt_id
          AND refund_reserved_amount + refunded_amount + NEW.amount <= amount;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Refund allocations exceed the source payment amount'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_exceeds_source_payment';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION guard_order_refund_allocation_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE source_provider varchar(64);
      BEGIN
        IF ROW(NEW.id, NEW.refund_id, NEW.source_payment_receipt_id, NEW.operation_id,
               NEW.request_sha256, NEW.destination, NEW.amount, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.refund_id, OLD.source_payment_receipt_id, OLD.operation_id,
               OLD.request_sha256, OLD.destination, OLD.amount, OLD.created_at) THEN
          RAISE EXCEPTION 'Refund allocation identity, source and amount are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_allocations_identity_immutable';
        END IF;
        IF OLD.status <> 'reserved' OR NEW.status NOT IN ('succeeded', 'released') THEN
          RAISE EXCEPTION 'Refund allocation can only leave its reserved state once'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_allocation_transition';
        END IF;
        IF NEW.destination = 'original_source' AND NEW.status = 'succeeded' THEN
          SELECT attempt.provider INTO source_provider
          FROM order_refund_allocations AS allocation
          JOIN payment_receipts AS receipt ON receipt.id = allocation.source_payment_receipt_id
          JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
          WHERE allocation.id = NEW.id;
          IF source_provider IS NULL OR NEW.provider IS DISTINCT FROM source_provider
            OR NEW.provider_refund_id IS NULL OR length(btrim(NEW.provider_refund_id)) NOT BETWEEN 1 AND 200
            OR NOT EXISTS (
              SELECT 1 FROM order_refund_manual_attempts AS manual
              WHERE manual.allocation_id = NEW.id AND manual.status = 'succeeded'
                AND manual.provider_reference = NEW.provider_refund_id
                AND manual.refunded_amount = NEW.amount
            ) THEN
            RAISE EXCEPTION 'Original-source refund requires an exact successful manual transfer record'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refund_provider_source_match';
          END IF;
        ELSIF NEW.status = 'succeeded' AND NEW.destination IN ('cash_balance', 'gift_balance') THEN
          IF EXISTS (
            SELECT 1 FROM order_refunds AS refund
            JOIN payment_attempts AS source_attempt ON source_attempt.order_id = refund.order_id
            JOIN payment_provider_reconciliation_cases AS reconciliation
              ON reconciliation.payment_attempt_id = source_attempt.id AND reconciliation.state = 'open'
            WHERE refund.id = NEW.refund_id
          ) OR EXISTS (
            SELECT 1 FROM order_refunds AS refund
            WHERE refund.id = NEW.refund_id AND order_has_unresolved_payment_attempts(refund.order_id)
          ) OR EXISTS (
            SELECT 1 FROM order_refunds AS refund
            JOIN payment_attempts AS source_attempt ON source_attempt.order_id = refund.order_id
            WHERE refund.id = NEW.refund_id AND source_attempt.status = 'reconciliation_required'
          ) THEN
            RAISE EXCEPTION 'Wallet refund credit is blocked by unresolved payment or reconciliation evidence'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refund_payment_unresolved';
          END IF;
        ELSIF NEW.destination <> 'original_source' AND (NEW.provider IS NOT NULL OR NEW.provider_refund_id IS NOT NULL) THEN
          RAISE EXCEPTION 'Wallet refunds do not use external provider references'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_wallet_provider_forbidden';
        END IF;
        NEW.completed_at := clock_timestamp();
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`CREATE FUNCTION protect_order_refund_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Refund audit events are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_refund_audit_immutable';
      END;
      $$`.execute(db)
    await sql`CREATE TRIGGER order_refund_audit_immutable BEFORE UPDATE OR DELETE ON order_refund_audit_events
      FOR EACH ROW EXECUTE FUNCTION protect_order_refund_audit()`.execute(db)
    await sql`CREATE TRIGGER order_refund_audit_prevent_truncate BEFORE TRUNCATE ON order_refund_audit_events
      FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
  },

  async down() {
    throw new Error('Refund requests, allocation and audit history is immutable; this migration is forward-only.')
  },
}
