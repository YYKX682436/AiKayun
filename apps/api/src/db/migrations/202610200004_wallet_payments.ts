import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const walletPaymentsMigration: Migration = {
  async up(db) {
    await sql`
      ALTER TABLE storefront_customer_policy
        ADD COLUMN wallet_top_up_enabled boolean NOT NULL DEFAULT false,
        ADD COLUMN wallet_top_up_min_amount numeric(18, 2) NOT NULL DEFAULT 1.00,
        ADD COLUMN wallet_top_up_max_amount numeric(18, 2) NOT NULL DEFAULT 1000.00,
        ADD CONSTRAINT storefront_customer_policy_wallet_top_up_limits_check
          CHECK (wallet_top_up_min_amount > 0 AND wallet_top_up_max_amount >= wallet_top_up_min_amount)
    `.execute(db)

    await sql`
      ALTER TABLE payment_attempts
        DROP CONSTRAINT payment_attempts_online_snapshot_check,
        ADD CONSTRAINT payment_attempts_online_snapshot_check CHECK (
          (payment_channel_id IS NULL AND provider_type_snapshot IS NULL AND payment_method_snapshot IS NULL
            AND payment_channel_name_snapshot IS NULL AND channel_credential_version IS NULL AND merchant_order_no IS NULL)
          OR (source = 'external' AND payment_channel_id IS NOT NULL
            AND provider_type_snapshot = 'zpay_epay_v1' AND payment_method_snapshot IN ('alipay', 'wechat')
            AND payment_channel_name_snapshot IS NOT NULL AND channel_credential_version > 0
            AND merchant_order_no IS NOT NULL AND merchant_order_no ~ '^[A-Za-z0-9]{20,32}$'
            AND ((order_id IS NOT NULL AND topup_customer_id IS NULL)
              OR (order_id IS NULL AND topup_customer_id IS NOT NULL)))
        )
    `.execute(db)

    // Top-ups follow customer -> wallet account -> payment attempt. Order receipts
    // retain the established order -> payment attempt sequence.
    await sql`
      CREATE OR REPLACE FUNCTION lock_and_classify_payment_receipt_r1() RETURNS trigger
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
          PERFORM id FROM customers WHERE id = attempt.topup_customer_id FOR UPDATE;
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
          IF NEW.source_bucket NOT IN ('cash', 'gift') OR NEW.provider IS NOT NULL OR NEW.provider_transaction_id IS NOT NULL
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
        ELSIF attempt.expires_at <= clock_timestamp() THEN
          NEW.disposition := 'late';
        END IF;
        RETURN NEW;
      END;
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
        IF NEW.status = 'succeeded' AND (
          payment_attempt_has_unresolved_provider_evidence(NEW.id)
          OR NOT EXISTS (
            SELECT 1 FROM payment_receipts AS receipt WHERE receipt.payment_attempt_id = NEW.id
            GROUP BY receipt.payment_attempt_id
            HAVING bool_and(receipt.disposition = 'on_time') AND (
              (NEW.source = 'wallet' AND sum(receipt.amount) = NEW.amount)
              OR (NEW.source = 'external' AND sum(receipt.amount) FILTER (WHERE receipt.source_bucket = 'external') = NEW.amount
                AND count(*) FILTER (WHERE receipt.source_bucket = 'external') = 1)
            )
          )
        ) THEN
          RAISE EXCEPTION 'A successful payment requires exact on-time receipt evidence and no open reconciliation case'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_success_requires_receipt';
        END IF;
        IF NEW.status = 'late_succeeded' AND NOT EXISTS (
          SELECT 1 FROM payment_receipts AS receipt WHERE receipt.payment_attempt_id = NEW.id AND receipt.disposition = 'late'
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
      CREATE OR REPLACE FUNCTION release_failed_order_wallet_hold() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.source = 'external'
          AND NEW.wallet_hold_operation_id IS NOT NULL
          AND NEW.status IN ('failed', 'expired', 'cancelled', 'late_succeeded') THEN
          PERFORM resolve_order_wallet_hold(NEW.wallet_hold_operation_id, 'order_payment_release');
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
          UPDATE payment_attempts SET status = CASE WHEN received < attempt.amount THEN 'pending'
            WHEN received = attempt.amount THEN 'succeeded' ELSE 'reconciliation_required' END
          WHERE id = NEW.payment_attempt_id;
        ELSE
          IF NEW.disposition = 'late' THEN
            next_status := 'late_succeeded';
          ELSIF NEW.disposition IN ('amount_mismatch', 'excess')
            OR payment_attempt_has_unresolved_provider_evidence(NEW.payment_attempt_id) THEN
            next_status := 'reconciliation_required';
          ELSE
            next_status := 'succeeded';
          END IF;
          UPDATE payment_attempts SET status = next_status WHERE id = NEW.payment_attempt_id;
        END IF;
        SELECT * INTO attempt FROM payment_attempts WHERE id = NEW.payment_attempt_id;

        IF attempt.wallet_hold_operation_id IS NOT NULL THEN
          IF NEW.disposition = 'on_time' AND attempt.status = 'succeeded'
            AND NOT payment_attempt_has_unresolved_provider_evidence(attempt.id) THEN
            PERFORM resolve_order_wallet_hold(attempt.wallet_hold_operation_id, 'order_payment_settlement');
          ELSIF NEW.disposition = 'late' THEN
            PERFORM resolve_order_wallet_hold(attempt.wallet_hold_operation_id, 'order_payment_release');
          END IF;
        END IF;

        IF attempt.order_id IS NOT NULL AND NEW.disposition = 'on_time'
          AND NOT payment_attempt_has_unresolved_provider_evidence(attempt.id) THEN
          SELECT COALESCE(sum(receipt.amount), 0),
            COALESCE(bool_or(receipt.disposition <> 'on_time' OR source_attempt.status <> 'succeeded'
              OR payment_attempt_has_unresolved_provider_evidence(source_attempt.id)), false)
            INTO received, unresolved
          FROM payment_receipts AS receipt
          JOIN payment_attempts AS source_attempt ON source_attempt.id = receipt.payment_attempt_id
          WHERE source_attempt.order_id = attempt.order_id;
          IF received = (SELECT total_amount FROM orders WHERE id = attempt.order_id)
            AND NOT unresolved AND NOT order_has_unresolved_payment_attempts(attempt.order_id)
            AND (SELECT status FROM orders WHERE id = attempt.order_id) = 'pending_payment' THEN
            UPDATE orders SET status = 'processing' WHERE id = attempt.order_id;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE FUNCTION credit_top_up_after_reconciliation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE receipt payment_receipts%ROWTYPE;
      BEGIN
        IF OLD.status IS NOT DISTINCT FROM NEW.status OR NEW.status <> 'succeeded'
          OR NEW.source <> 'external' OR NEW.topup_customer_id IS NULL
          OR payment_attempt_has_unresolved_provider_evidence(NEW.id) THEN
          RETURN NEW;
        END IF;
        SELECT * INTO receipt FROM payment_receipts
        WHERE payment_attempt_id = NEW.id AND source_bucket = 'external';
        IF NOT FOUND OR receipt.disposition <> 'on_time' OR receipt.amount <> NEW.amount THEN
          RETURN NEW;
        END IF;
        PERFORM id FROM customers WHERE id = NEW.topup_customer_id FOR UPDATE;
        PERFORM customer_id FROM wallet_accounts WHERE customer_id = NEW.topup_customer_id FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM wallet_operations WHERE id = receipt.id) THEN
          INSERT INTO wallet_operations (id, customer_id, operation_type, request_sha256)
          VALUES (receipt.id, NEW.topup_customer_id, 'top_up', NEW.request_sha256);
          INSERT INTO wallet_ledger_entries (
            id, wallet_operation_id, line_no, customer_id, bucket, action, amount, payment_attempt_id
          ) VALUES (
            gen_random_uuid(), receipt.id, 1, NEW.topup_customer_id, 'cash', 'credit_available', receipt.amount, NEW.id
          );
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER payment_attempts_credit_top_up
      AFTER UPDATE OF status ON payment_attempts
      FOR EACH ROW EXECUTE FUNCTION credit_top_up_after_reconciliation()
    `.execute(db)

    await sql`
      CREATE FUNCTION guard_order_processing_reconciliation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'processing'
          AND EXISTS (
            SELECT 1 FROM payment_attempts AS attempt
            JOIN payment_provider_reconciliation_cases AS reconciliation ON reconciliation.payment_attempt_id = attempt.id
            WHERE attempt.order_id = NEW.id AND reconciliation.state = 'open'
          ) THEN
          RAISE EXCEPTION 'An order with an open payment reconciliation case cannot enter fulfillment'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_processing_reconciliation_guard';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER orders_processing_reconciliation_guard
      BEFORE UPDATE OF status ON orders
      FOR EACH ROW EXECUTE FUNCTION guard_order_processing_reconciliation()
    `.execute(db)
  },

  async down() {
    throw new Error('Wallet top-up and payment history is immutable; this migration is forward-only.')
  },
}
