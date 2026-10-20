import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const paymentReconciliationMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE payment_provider_reconciliation_cases (
        id uuid PRIMARY KEY,
        payment_attempt_id uuid NOT NULL,
        reason varchar(48) NOT NULL,
        opening_callback_event_id uuid,
        opening_query_event_id uuid,
        state varchar(16) NOT NULL DEFAULT 'open',
        opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        resolved_at timestamptz,
        resolved_by_admin_id uuid,
        resolution_query_event_sha256 char(64),
        resolution_provider_transaction_id varchar(200),
        resolution_payment_method varchar(16),
        resolution_confirmed_amount numeric(18, 2),
        resolution_currency varchar(3),
        resolution_payload jsonb,
        CONSTRAINT payment_provider_reconciliation_cases_attempt_fkey
          FOREIGN KEY (payment_attempt_id) REFERENCES payment_attempts (id) ON DELETE RESTRICT,
        CONSTRAINT payment_provider_reconciliation_cases_callback_fkey
          FOREIGN KEY (opening_callback_event_id) REFERENCES payment_provider_events (id) ON DELETE RESTRICT,
        CONSTRAINT payment_provider_reconciliation_cases_query_fkey
          FOREIGN KEY (opening_query_event_id) REFERENCES payment_provider_events (id) ON DELETE RESTRICT,
        CONSTRAINT payment_provider_reconciliation_cases_admin_fkey
          FOREIGN KEY (resolved_by_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT payment_provider_reconciliation_cases_reason_check CHECK (reason IN (
          'callback_query_mismatch', 'provider_identity_conflict', 'provider_transaction_conflict',
          'provider_amount_mismatch', 'receipt_conflict', 'late_confirmed_payment'
        )),
        CONSTRAINT payment_provider_reconciliation_cases_state_check CHECK (state IN ('open', 'resolved')),
        CONSTRAINT payment_provider_reconciliation_cases_open_evidence_check
          CHECK (opening_callback_event_id IS NOT NULL OR opening_query_event_id IS NOT NULL),
        CONSTRAINT payment_provider_reconciliation_cases_resolution_check CHECK (
          (state = 'open' AND resolved_at IS NULL AND resolved_by_admin_id IS NULL
            AND resolution_query_event_sha256 IS NULL AND resolution_provider_transaction_id IS NULL
            AND resolution_payment_method IS NULL AND resolution_confirmed_amount IS NULL
            AND resolution_currency IS NULL AND resolution_payload IS NULL)
          OR (state = 'resolved' AND resolved_at IS NOT NULL AND resolved_by_admin_id IS NOT NULL
            AND resolution_query_event_sha256 ~ '^[0-9a-f]{64}$'
            AND btrim(resolution_provider_transaction_id) <> ''
            AND resolution_payment_method IN ('alipay', 'wechat')
            AND resolution_confirmed_amount > 0 AND resolution_currency = 'CNY'
            AND jsonb_typeof(resolution_payload) = 'object')
        )
      )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX payment_provider_reconciliation_cases_one_open_unique
      ON payment_provider_reconciliation_cases (payment_attempt_id) WHERE state = 'open'`.execute(db)
    await sql`CREATE INDEX payment_provider_reconciliation_cases_attempt_idx
      ON payment_provider_reconciliation_cases (payment_attempt_id, opened_at DESC, id DESC)`.execute(db)
    await sql`
      CREATE FUNCTION guard_payment_provider_reconciliation_case() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Payment reconciliation cases are immutable audit records'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_reconciliation_cases_immutable';
        END IF;
        IF ROW(NEW.id, NEW.payment_attempt_id, NEW.reason, NEW.opening_callback_event_id,
               NEW.opening_query_event_id, NEW.opened_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.payment_attempt_id, OLD.reason, OLD.opening_callback_event_id,
               OLD.opening_query_event_id, OLD.opened_at) THEN
          RAISE EXCEPTION 'Payment reconciliation case identity and opening evidence are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_reconciliation_cases_identity_immutable';
        END IF;
        IF OLD.state <> 'open' OR NEW.state <> 'resolved'
          OR NEW.resolved_at IS NULL OR NEW.resolved_by_admin_id IS NULL
          OR NEW.resolution_query_event_sha256 IS NULL OR NEW.resolution_provider_transaction_id IS NULL
          OR NEW.resolution_payment_method IS NULL OR NEW.resolution_confirmed_amount IS NULL
          OR NEW.resolution_currency IS DISTINCT FROM 'CNY' OR NEW.resolution_payload IS NULL THEN
          RAISE EXCEPTION 'A reconciliation case can only be resolved once with verified provider evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_reconciliation_cases_resolution_guard';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER payment_provider_reconciliation_cases_guard
      BEFORE UPDATE OR DELETE ON payment_provider_reconciliation_cases
      FOR EACH ROW EXECUTE FUNCTION guard_payment_provider_reconciliation_case()
    `.execute(db)
    await sql`CREATE TRIGGER payment_provider_reconciliation_cases_prevent_truncate
      BEFORE TRUNCATE ON payment_provider_reconciliation_cases FOR EACH STATEMENT
      EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      CREATE FUNCTION payment_attempt_has_unresolved_provider_evidence(attempt_uuid uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
          SELECT 1 FROM payment_provider_reconciliation_cases AS reconciliation
          WHERE reconciliation.payment_attempt_id = attempt_uuid AND reconciliation.state = 'open'
        )
      $$
    `.execute(db)

    // A later authenticated query may be the first reliable proof of money after
    // an earlier callback opened a case. Permit the external receipt to be added
    // while that case is open; the receipt trigger will keep it non-settleable.
    await sql`DROP TRIGGER payment_receipts_lock_classify ON payment_receipts`.execute(db)
    await sql`
      CREATE FUNCTION lock_and_classify_payment_receipt_r1() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        attempt payment_attempts%ROWTYPE;
        order_row orders%ROWTYPE;
        prior_received numeric;
        unresolved boolean;
        ledger_amount numeric(18, 2);
      BEGIN
        SELECT * INTO attempt FROM payment_attempts WHERE id = NEW.payment_attempt_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Payment attempt does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'payment_receipts_attempt_fkey';
        END IF;
        IF attempt.order_id IS NOT NULL THEN
          SELECT * INTO order_row FROM orders WHERE id = attempt.order_id FOR UPDATE;
        ELSE
          PERFORM customer_id FROM wallet_accounts WHERE customer_id = attempt.topup_customer_id FOR UPDATE;
        END IF;
        SELECT * INTO attempt FROM payment_attempts WHERE id = NEW.payment_attempt_id FOR UPDATE;
        NEW.received_at := clock_timestamp();
        IF NEW.refund_reserved_amount <> 0 OR NEW.refunded_amount <> 0 THEN
          RAISE EXCEPTION 'Payment refund totals must begin at zero and follow refund allocations'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_initial_refund_totals';
        END IF;
        IF attempt.source = 'external' THEN
          IF NEW.source_bucket <> 'external' OR NEW.provider IS DISTINCT FROM attempt.provider
            OR NEW.provider_transaction_id IS NULL THEN
            RAISE EXCEPTION 'External payment receipt must match its provider attempt'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_provider_match';
          END IF;
          IF NEW.wallet_operation_id IS NOT NULL OR NEW.wallet_line_no IS NOT NULL THEN
            RAISE EXCEPTION 'External payment receipts cannot use wallet operation references'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_external_wallet_reference';
          END IF;
        ELSE
          IF NEW.source_bucket NOT IN ('cash', 'gift')
            OR NEW.provider IS NOT NULL OR NEW.provider_transaction_id IS NOT NULL
            OR NEW.wallet_operation_id IS DISTINCT FROM attempt.wallet_operation_id
            OR NEW.wallet_line_no NOT BETWEEN 1 AND 2 OR NEW.amount > attempt.amount THEN
            RAISE EXCEPTION 'Wallet receipt must match its wallet payment attempt'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_wallet_match';
          END IF;
          SELECT amount INTO ledger_amount FROM wallet_ledger_entries
          WHERE wallet_operation_id = attempt.wallet_operation_id AND line_no = NEW.wallet_line_no
            AND payment_attempt_id = attempt.id
            AND action = CASE (SELECT operation_type FROM wallet_operations WHERE id = attempt.wallet_operation_id)
              WHEN 'order_payment' THEN 'debit_available' ELSE 'debit_frozen' END
            AND bucket = NEW.source_bucket;
          IF NOT FOUND OR ledger_amount <> NEW.amount THEN
            RAISE EXCEPTION 'Wallet receipt must have an equal immutable debit ledger entry'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_wallet_ledger_match';
          END IF;
        END IF;
        IF attempt.status IN ('succeeded', 'late_succeeded')
          OR (attempt.status = 'reconciliation_required'
            AND NOT (attempt.source = 'external' AND payment_attempt_has_unresolved_provider_evidence(attempt.id)))
          OR (attempt.source = 'wallet' AND attempt.status IN ('failed', 'expired', 'cancelled')) THEN
          RAISE EXCEPTION 'Payment attempt cannot accept another settlement in its current state'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_attempt_state';
        END IF;
        NEW.disposition := 'on_time';
        IF attempt.status IN ('failed', 'expired', 'cancelled') THEN NEW.disposition := 'late'; END IF;
        IF attempt.order_id IS NOT NULL THEN
          IF order_row.status = 'pending_payment'
            AND (order_row.unpaid_expires_at <= clock_timestamp() OR attempt.expires_at <= clock_timestamp()) THEN
            PERFORM close_expired_order_when_settled(order_row.id);
            SELECT * INTO order_row FROM orders WHERE id = attempt.order_id;
          END IF;
          IF attempt.source = 'wallet' AND (order_row.status <> 'pending_payment'
            OR order_row.unpaid_expires_at <= clock_timestamp()) THEN
            RAISE EXCEPTION 'Wallet payment cannot settle a closed order'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_wallet_order_open';
          END IF;
          IF order_row.status = 'closed' THEN
            NEW.disposition := 'late';
          ELSE
            SELECT COALESCE(sum(receipt.amount), 0),
              COALESCE(bool_or(receipt.disposition IN ('late', 'amount_mismatch', 'excess')), false)
              INTO prior_received, unresolved
            FROM payment_receipts AS receipt
            JOIN payment_attempts AS previous_attempt ON previous_attempt.id = receipt.payment_attempt_id
            WHERE previous_attempt.order_id = order_row.id;
            IF attempt.source = 'external' AND NEW.amount <> attempt.amount THEN
              NEW.disposition := 'amount_mismatch';
            ELSIF prior_received + NEW.amount > order_row.total_amount THEN
              NEW.disposition := 'excess';
            ELSIF order_row.unpaid_expires_at <= clock_timestamp() OR attempt.expires_at <= clock_timestamp() THEN
              NEW.disposition := 'late';
            END IF;
          END IF;
        ELSIF NEW.amount <> attempt.amount THEN
          NEW.disposition := 'amount_mismatch';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER payment_receipts_lock_classify BEFORE INSERT ON payment_receipts
      FOR EACH ROW EXECUTE FUNCTION lock_and_classify_payment_receipt_r1()`.execute(db)

    // Keep the existing deadline, wallet-hold, receipt and order-close rules;
    // an open reconciliation case is an additional unresolved payment fact.
    await sql`
      CREATE OR REPLACE FUNCTION order_has_unresolved_payment_attempts(order_uuid uuid) RETURNS boolean
      LANGUAGE sql VOLATILE AS $$
        SELECT EXISTS (
          SELECT 1 FROM payment_attempts AS attempt
          WHERE attempt.order_id = order_uuid
            AND (
              (attempt.status IN ('created', 'pending')
                AND (attempt.expires_at IS NULL OR attempt.expires_at > clock_timestamp()))
              OR (attempt.status IN ('succeeded', 'late_succeeded', 'reconciliation_required')
                AND NOT EXISTS (
                  SELECT 1 FROM payment_receipts AS receipt WHERE receipt.payment_attempt_id = attempt.id
                ))
              OR payment_attempt_has_unresolved_provider_evidence(attempt.id)
              OR (NOT EXISTS (
                SELECT 1 FROM payment_receipts AS receipt WHERE receipt.payment_attempt_id = attempt.id
              ) AND EXISTS (
                SELECT 1 FROM payment_provider_events AS event
                WHERE event.payment_attempt_id = attempt.id AND event.source IN ('callback', 'query')
                  AND event.verification = 'verified' AND event.provider_status = 'paid'
                  AND event.disposition = 'pending_confirmation'
              ))
            )
        )
        OR EXISTS (
          SELECT 1 FROM payment_attempts AS attempt
          JOIN wallet_operations AS hold ON hold.id = attempt.wallet_hold_operation_id
          WHERE attempt.order_id = order_uuid AND hold.operation_type = 'order_payment_hold'
            AND NOT EXISTS (
              SELECT 1 FROM wallet_operations AS resolution
              WHERE resolution.resolves_operation_id = hold.id
                AND resolution.operation_type IN ('order_payment_settlement', 'order_payment_release')
            )
        )
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION guard_payment_attempt_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.id, NEW.idempotency_key, NEW.request_sha256, NEW.order_id, NEW.topup_customer_id,
               NEW.source, NEW.amount, NEW.provider, NEW.provider_payment_id, NEW.wallet_operation_id,
               NEW.wallet_hold_operation_id, NEW.requested_wallet_amount, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.idempotency_key, OLD.request_sha256, OLD.order_id, OLD.topup_customer_id,
               OLD.source, OLD.amount, OLD.provider, OLD.provider_payment_id, OLD.wallet_operation_id,
               OLD.wallet_hold_operation_id, OLD.requested_wallet_amount, OLD.created_at) THEN
          RAISE EXCEPTION 'Payment attempt identity, source and expected amount are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_identity_immutable';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
          (OLD.status = 'created' AND NEW.status IN ('pending', 'succeeded', 'failed', 'expired', 'cancelled', 'late_succeeded', 'reconciliation_required'))
          OR (OLD.status = 'pending' AND NEW.status IN ('succeeded', 'failed', 'expired', 'cancelled', 'late_succeeded', 'reconciliation_required'))
          OR (OLD.status IN ('failed', 'expired', 'cancelled') AND NEW.status IN ('late_succeeded', 'reconciliation_required'))
          OR (OLD.status = 'succeeded' AND NEW.status = 'reconciliation_required')
          OR (OLD.status = 'reconciliation_required' AND NEW.status IN ('succeeded', 'late_succeeded'))
        ) THEN
          RAISE EXCEPTION 'Illegal payment attempt transition: % to %', OLD.status, NEW.status
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_status_transition';
        END IF;
        IF NEW.status = 'succeeded' AND NOT EXISTS (
          SELECT 1 FROM payment_receipts AS receipt WHERE receipt.payment_attempt_id = NEW.id
          GROUP BY receipt.payment_attempt_id
          HAVING bool_and(receipt.disposition = 'on_time') AND (
            (NEW.source = 'wallet' AND sum(receipt.amount) = NEW.amount)
            OR (NEW.source = 'external' AND sum(receipt.amount) FILTER (WHERE receipt.source_bucket = 'external') = NEW.amount
              AND count(*) FILTER (WHERE receipt.source_bucket = 'external') = 1)
          )
        ) THEN
          RAISE EXCEPTION 'A successful payment attempt requires matching on-time receipt evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_success_requires_receipt';
        END IF;
        IF NEW.status = 'late_succeeded' AND NOT EXISTS (
          SELECT 1 FROM payment_receipts AS receipt
          WHERE receipt.payment_attempt_id = NEW.id AND receipt.disposition = 'late'
        ) THEN
          RAISE EXCEPTION 'A late payment attempt requires late receipt evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_late_requires_receipt';
        END IF;
        IF NEW.status = 'reconciliation_required' AND NOT (
          EXISTS (SELECT 1 FROM payment_receipts AS receipt
            WHERE receipt.payment_attempt_id = NEW.id AND receipt.disposition IN ('amount_mismatch', 'excess'))
          OR payment_attempt_has_unresolved_provider_evidence(NEW.id)
        ) THEN
          RAISE EXCEPTION 'Payment reconciliation requires mismatched receipt or unresolved provider evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_reconciliation_requires_evidence';
        END IF;
        IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
          IF NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
            RAISE EXCEPTION 'Payment completion time is controlled by its state transition'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_completed_at_guard';
          END IF;
        ELSE
          NEW.completed_at := CASE WHEN NEW.status IN ('created', 'pending') THEN NULL ELSE now() END;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION finish_payment_receipt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        attempt payment_attempts%ROWTYPE;
        received numeric;
        unresolved boolean;
        next_status varchar(24);
      BEGIN
        SELECT * INTO attempt FROM payment_attempts WHERE id = NEW.payment_attempt_id;
        IF attempt.source = 'wallet' THEN
          SELECT COALESCE(sum(amount), 0) INTO received
          FROM payment_receipts WHERE payment_attempt_id = NEW.payment_attempt_id;
          UPDATE payment_attempts SET
            status = CASE WHEN received < attempt.amount THEN 'pending'
              WHEN received = attempt.amount THEN 'succeeded' ELSE 'reconciliation_required' END,
            completed_at = CASE WHEN received = attempt.amount THEN now() ELSE NULL END
          WHERE id = NEW.payment_attempt_id;
        ELSE
          next_status := CASE
            WHEN NEW.disposition = 'late' THEN 'late_succeeded'
            WHEN NEW.disposition IN ('amount_mismatch', 'excess') THEN 'reconciliation_required'
            WHEN payment_attempt_has_unresolved_provider_evidence(NEW.payment_attempt_id) THEN 'reconciliation_required'
            ELSE 'succeeded' END;
          UPDATE payment_attempts SET
            status = next_status,
            completed_at = CASE WHEN status IS DISTINCT FROM next_status THEN now() ELSE completed_at END
          WHERE id = NEW.payment_attempt_id;
        END IF;
        IF attempt.topup_customer_id IS NOT NULL AND NEW.disposition = 'on_time' THEN
          INSERT INTO wallet_operations (id, customer_id, operation_type, request_sha256)
          VALUES (NEW.id, attempt.topup_customer_id, 'top_up', attempt.request_sha256);
          INSERT INTO wallet_ledger_entries (
            id, wallet_operation_id, line_no, customer_id, bucket, action, amount, payment_attempt_id
          ) VALUES (
            gen_random_uuid(), NEW.id, 1, attempt.topup_customer_id, 'cash', 'credit_available', NEW.amount, attempt.id
          );
        END IF;
        IF attempt.source = 'external' AND attempt.order_id IS NOT NULL
          AND attempt.wallet_hold_operation_id IS NOT NULL THEN
          IF NEW.disposition = 'on_time' THEN
            PERFORM resolve_order_wallet_hold(attempt.wallet_hold_operation_id, 'order_payment_settlement');
          ELSE
            PERFORM resolve_order_wallet_hold(attempt.wallet_hold_operation_id, 'order_payment_release');
          END IF;
        END IF;
        IF attempt.order_id IS NOT NULL AND NEW.disposition = 'on_time' THEN
          SELECT COALESCE(sum(receipt.amount), 0),
            COALESCE(bool_or(receipt.disposition <> 'on_time' OR source_attempt.status <> 'succeeded'
              OR payment_attempt_has_unresolved_provider_evidence(source_attempt.id)), false)
            INTO received, unresolved
          FROM payment_receipts AS receipt
          JOIN payment_attempts AS source_attempt ON source_attempt.id = receipt.payment_attempt_id
          WHERE source_attempt.order_id = attempt.order_id;
          IF received = (SELECT total_amount FROM orders WHERE id = attempt.order_id) AND NOT unresolved
            AND (SELECT status FROM orders WHERE id = attempt.order_id) = 'pending_payment' THEN
            UPDATE orders SET status = 'processing' WHERE id = attempt.order_id;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
  },

  async down(db) {
    await sql`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM payment_provider_reconciliation_cases) THEN
          RAISE EXCEPTION 'Cannot roll back provider reconciliation after a case was recorded';
        END IF;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION order_has_unresolved_payment_attempts(order_uuid uuid) RETURNS boolean
      LANGUAGE sql VOLATILE AS $$
        SELECT EXISTS (
          SELECT 1 FROM payment_attempts AS attempt
          WHERE attempt.order_id = order_uuid
            AND ((attempt.status IN ('created', 'pending')
                  AND (attempt.expires_at IS NULL OR attempt.expires_at > clock_timestamp()))
              OR (attempt.status IN ('succeeded', 'late_succeeded', 'reconciliation_required')
                  AND NOT EXISTS (SELECT 1 FROM payment_receipts AS receipt
                    WHERE receipt.payment_attempt_id = attempt.id)))
        )
        OR EXISTS (
          SELECT 1 FROM payment_attempts AS attempt
          JOIN wallet_operations AS hold ON hold.id = attempt.wallet_hold_operation_id
          WHERE attempt.order_id = order_uuid AND hold.operation_type = 'order_payment_hold'
            AND NOT EXISTS (SELECT 1 FROM wallet_operations AS resolution
              WHERE resolution.resolves_operation_id = hold.id
                AND resolution.operation_type IN ('order_payment_settlement', 'order_payment_release'))
        )
      $$
    `.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION guard_payment_attempt_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.id, NEW.idempotency_key, NEW.request_sha256, NEW.order_id, NEW.topup_customer_id,
               NEW.source, NEW.amount, NEW.provider, NEW.provider_payment_id, NEW.wallet_operation_id,
               NEW.wallet_hold_operation_id, NEW.requested_wallet_amount, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.idempotency_key, OLD.request_sha256, OLD.order_id, OLD.topup_customer_id,
               OLD.source, OLD.amount, OLD.provider, OLD.provider_payment_id, OLD.wallet_operation_id,
               OLD.wallet_hold_operation_id, OLD.requested_wallet_amount, OLD.created_at) THEN
          RAISE EXCEPTION 'Payment attempt identity, source and expected amount are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_identity_immutable';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
          (OLD.status = 'created' AND NEW.status IN ('pending', 'succeeded', 'failed', 'expired', 'cancelled', 'late_succeeded', 'reconciliation_required'))
          OR (OLD.status = 'pending' AND NEW.status IN ('succeeded', 'failed', 'expired', 'cancelled', 'late_succeeded', 'reconciliation_required'))
          OR (OLD.status IN ('failed', 'expired', 'cancelled') AND NEW.status IN ('late_succeeded', 'reconciliation_required'))
          OR (OLD.status = 'reconciliation_required' AND NEW.status IN ('succeeded', 'late_succeeded'))
        ) THEN
          RAISE EXCEPTION 'Illegal payment attempt transition: % to %', OLD.status, NEW.status
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_status_transition';
        END IF;
        IF NEW.status = 'succeeded' AND NOT EXISTS (
          SELECT 1 FROM payment_receipts AS receipt WHERE receipt.payment_attempt_id = NEW.id
          GROUP BY receipt.payment_attempt_id
          HAVING bool_and(receipt.disposition = 'on_time') AND (
            (NEW.source = 'wallet' AND sum(receipt.amount) = NEW.amount)
            OR (NEW.source = 'external' AND sum(receipt.amount) FILTER (WHERE receipt.source_bucket = 'external') = NEW.amount
              AND count(*) FILTER (WHERE receipt.source_bucket = 'external') = 1)
          )
        ) THEN
          RAISE EXCEPTION 'A successful payment attempt requires matching on-time receipt evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_success_requires_receipt';
        END IF;
        IF NEW.status = 'late_succeeded' AND NOT EXISTS (SELECT 1 FROM payment_receipts AS receipt
          WHERE receipt.payment_attempt_id = NEW.id AND receipt.disposition = 'late') THEN
          RAISE EXCEPTION 'A late payment attempt requires late receipt evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_late_requires_receipt';
        END IF;
        IF NEW.status = 'reconciliation_required' AND NOT EXISTS (SELECT 1 FROM payment_receipts AS receipt
          WHERE receipt.payment_attempt_id = NEW.id AND receipt.disposition IN ('amount_mismatch', 'excess')) THEN
          RAISE EXCEPTION 'Payment reconciliation requires a mismatched or excess receipt'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_reconciliation_requires_receipt';
        END IF;
        IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
          IF NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
            RAISE EXCEPTION 'Payment completion time is controlled by its state transition'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_completed_at_guard';
          END IF;
        ELSE
          NEW.completed_at := CASE WHEN NEW.status IN ('created', 'pending') THEN NULL ELSE now() END;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION finish_payment_receipt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE attempt payment_attempts%ROWTYPE; received numeric; unresolved boolean;
      BEGIN
        SELECT * INTO attempt FROM payment_attempts WHERE id = NEW.payment_attempt_id;
        IF attempt.source = 'wallet' THEN
          SELECT COALESCE(sum(amount), 0) INTO received FROM payment_receipts WHERE payment_attempt_id = NEW.payment_attempt_id;
          UPDATE payment_attempts SET status = CASE WHEN received < attempt.amount THEN 'pending'
            WHEN received = attempt.amount THEN 'succeeded' ELSE 'reconciliation_required' END,
            completed_at = CASE WHEN received = attempt.amount THEN now() ELSE NULL END
          WHERE id = NEW.payment_attempt_id;
        ELSE
          UPDATE payment_attempts SET status = CASE NEW.disposition WHEN 'late' THEN 'late_succeeded'
            WHEN 'amount_mismatch' THEN 'reconciliation_required' WHEN 'excess' THEN 'reconciliation_required'
            ELSE 'succeeded' END, completed_at = now()
          WHERE id = NEW.payment_attempt_id;
        END IF;
        IF attempt.topup_customer_id IS NOT NULL AND NEW.disposition = 'on_time' THEN
          INSERT INTO wallet_operations (id, customer_id, operation_type, request_sha256)
          VALUES (NEW.id, attempt.topup_customer_id, 'top_up', attempt.request_sha256);
          INSERT INTO wallet_ledger_entries (id, wallet_operation_id, line_no, customer_id, bucket, action, amount, payment_attempt_id)
          VALUES (gen_random_uuid(), NEW.id, 1, attempt.topup_customer_id, 'cash', 'credit_available', NEW.amount, attempt.id);
        END IF;
        IF attempt.source = 'external' AND attempt.order_id IS NOT NULL AND attempt.wallet_hold_operation_id IS NOT NULL THEN
          IF NEW.disposition = 'on_time' THEN
            PERFORM resolve_order_wallet_hold(attempt.wallet_hold_operation_id, 'order_payment_settlement');
          ELSE
            PERFORM resolve_order_wallet_hold(attempt.wallet_hold_operation_id, 'order_payment_release');
          END IF;
        END IF;
        IF attempt.order_id IS NOT NULL AND NEW.disposition = 'on_time' THEN
          SELECT COALESCE(sum(receipt.amount), 0), COALESCE(bool_or(receipt.disposition <> 'on_time' OR source_attempt.status <> 'succeeded'), false)
            INTO received, unresolved
          FROM payment_receipts AS receipt JOIN payment_attempts AS source_attempt ON source_attempt.id = receipt.payment_attempt_id
          WHERE source_attempt.order_id = attempt.order_id;
          IF received = (SELECT total_amount FROM orders WHERE id = attempt.order_id) AND NOT unresolved
            AND (SELECT status FROM orders WHERE id = attempt.order_id) = 'pending_payment' THEN
            UPDATE orders SET status = 'processing' WHERE id = attempt.order_id;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`DROP TRIGGER payment_receipts_lock_classify ON payment_receipts`.execute(db)
    await sql`DROP FUNCTION lock_and_classify_payment_receipt_r1()`.execute(db)
    await sql`CREATE TRIGGER payment_receipts_lock_classify BEFORE INSERT ON payment_receipts
      FOR EACH ROW EXECUTE FUNCTION lock_and_classify_payment_receipt()`.execute(db)
    await sql`DROP FUNCTION payment_attempt_has_unresolved_provider_evidence(uuid)`.execute(db)
    await sql`DROP TRIGGER payment_provider_reconciliation_cases_prevent_truncate ON payment_provider_reconciliation_cases`.execute(db)
    await sql`DROP TRIGGER payment_provider_reconciliation_cases_guard ON payment_provider_reconciliation_cases`.execute(db)
    await sql`DROP TABLE payment_provider_reconciliation_cases`.execute(db)
    await sql`DROP FUNCTION guard_payment_provider_reconciliation_case()`.execute(db)
  },
}
