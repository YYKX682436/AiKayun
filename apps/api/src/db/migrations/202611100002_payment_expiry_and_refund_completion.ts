import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const paymentExpiryAndRefundCompletionMigration: Migration = {
  async up(db) {
    // Change only the top-up branches of the installed ledger functions.
    await sql`
      DO $patch$
      DECLARE source text; changed text;
      BEGIN
        SELECT pg_get_functiondef('apply_wallet_ledger_entry()'::regprocedure) INTO source;
        changed := replace(source, $old$AND receipt.source_bucket = 'external' AND receipt.disposition = 'on_time'
                AND receipt.amount = NEW.amount AND attempt.amount = NEW.amount
                AND attempt.status = 'succeeded'$old$, $new$AND receipt.source_bucket = 'external'
                AND receipt.amount = NEW.amount AND attempt.amount = NEW.amount
                AND NOT payment_attempt_has_unresolved_provider_evidence(attempt.id)
                AND ((attempt.status = 'succeeded' AND receipt.disposition = 'on_time')
                  OR (attempt.status = 'late_succeeded' AND receipt.disposition = 'late'))$new$);
        IF changed = source THEN RAISE EXCEPTION 'Could not update top-up ledger receipt check'; END IF;
        EXECUTE changed;

        SELECT pg_get_functiondef('assert_wallet_operation_entries()'::regprocedure) INTO source;
        changed := replace(source, $old$AND attempt.topup_customer_id = NEW.customer_id AND attempt.status = 'succeeded'
              AND attempt.amount = expected_amount AND receipt.disposition = 'on_time'
              AND receipt.amount = expected_amount$old$, $new$AND attempt.topup_customer_id = NEW.customer_id AND receipt.source_bucket = 'external'
              AND attempt.amount = expected_amount AND receipt.amount = expected_amount
              AND NOT payment_attempt_has_unresolved_provider_evidence(attempt.id)
              AND ((attempt.status = 'succeeded' AND receipt.disposition = 'on_time')
                OR (attempt.status = 'late_succeeded' AND receipt.disposition = 'late'))$new$);
        IF changed = source THEN RAISE EXCEPTION 'Could not update deferred top-up ledger check'; END IF;
        EXECUTE changed;
      END
      $patch$;

      CREATE FUNCTION credit_payment_top_up(attempt_uuid uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        owner_uuid uuid;
        attempt payment_attempts%ROWTYPE;
        receipt payment_receipts%ROWTYPE;
      BEGIN
        SELECT topup_customer_id INTO owner_uuid FROM payment_attempts
        WHERE id = attempt_uuid AND source = 'external';
        IF owner_uuid IS NULL THEN RETURN; END IF;
        PERFORM id FROM customers WHERE id = owner_uuid FOR UPDATE;
        PERFORM customer_id FROM wallet_accounts WHERE customer_id = owner_uuid FOR UPDATE;
        SELECT * INTO attempt FROM payment_attempts WHERE id = attempt_uuid FOR UPDATE;
        IF payment_attempt_has_unresolved_provider_evidence(attempt_uuid) THEN RETURN; END IF;

        SELECT * INTO receipt FROM payment_receipts
        WHERE payment_attempt_id = attempt_uuid AND source_bucket = 'external' AND amount = attempt.amount
          AND ((attempt.status = 'succeeded' AND disposition = 'on_time')
            OR (attempt.status = 'late_succeeded' AND disposition = 'late'));
        IF NOT FOUND OR EXISTS (SELECT 1 FROM wallet_operations WHERE id = receipt.id) THEN RETURN; END IF;

        INSERT INTO wallet_operations (id, customer_id, operation_type, request_sha256)
        VALUES (receipt.id, owner_uuid, 'top_up', attempt.request_sha256);
        INSERT INTO wallet_ledger_entries (
          id, wallet_operation_id, line_no, customer_id, bucket, action, amount, payment_attempt_id
        ) VALUES (
          gen_random_uuid(), receipt.id, 1, owner_uuid, 'cash', 'credit_available', receipt.amount, attempt_uuid
        );
      END;
      $$;

      CREATE OR REPLACE FUNCTION credit_top_up_after_reconciliation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('succeeded', 'late_succeeded')
          AND NEW.topup_customer_id IS NOT NULL THEN
          PERFORM credit_payment_top_up(NEW.id);
        END IF;
        RETURN NEW;
      END;
      $$;
    `.execute(db)

    // The refund status trigger is shared by wallet refunds and confirmed manual refunds.
    await sql`
      CREATE OR REPLACE FUNCTION close_expired_order_when_settled(order_uuid uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        order_row orders%ROWTYPE;
        collected_amount numeric;
        refunded_amount numeric;
        reserved_refund_amount numeric;
      BEGIN
        SELECT * INTO order_row FROM orders WHERE id = order_uuid FOR UPDATE;
        IF NOT FOUND OR order_row.status NOT IN ('pending_payment', 'processing')
          OR order_has_unresolved_payment_attempts(order_uuid) THEN RETURN; END IF;
        IF order_row.status = 'pending_payment' AND (order_row.unpaid_expires_at IS NULL
          OR (order_row.unpaid_expires_at > clock_timestamp() AND NOT EXISTS (
            SELECT 1 FROM payment_attempts AS attempt
            WHERE attempt.order_id = order_uuid AND attempt.expires_at <= clock_timestamp()
          ))) THEN RETURN; END IF;

        SELECT COALESCE(sum(receipt.amount), 0), COALESCE(sum(receipt.refunded_amount), 0),
          COALESCE(sum(receipt.refund_reserved_amount), 0)
          INTO collected_amount, refunded_amount, reserved_refund_amount
        FROM payment_receipts AS receipt
        JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
        WHERE attempt.order_id = order_uuid;
        IF collected_amount <> refunded_amount OR reserved_refund_amount <> 0
          OR (order_row.status = 'processing' AND collected_amount = 0)
          OR EXISTS (SELECT 1 FROM order_refunds AS refund WHERE refund.order_id = order_uuid
            AND refund.status IN ('requested', 'approved', 'processing', 'partially_succeeded'))
          OR order_has_unresolved_fulfillment(order_uuid) THEN RETURN; END IF;

        UPDATE orders SET status = 'closed' WHERE id = order_uuid;
      END;
      $$;
    `.execute(db)

    await sql`
      DO $backfill$
      DECLARE target uuid;
      BEGIN
        FOR target IN
          SELECT attempt.id FROM payment_attempts AS attempt
          JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = attempt.id
          WHERE attempt.topup_customer_id IS NOT NULL AND attempt.status = 'late_succeeded'
            AND receipt.source_bucket = 'external' AND receipt.disposition = 'late' AND receipt.amount = attempt.amount
            AND NOT payment_attempt_has_unresolved_provider_evidence(attempt.id)
            AND NOT EXISTS (SELECT 1 FROM wallet_operations WHERE id = receipt.id)
          ORDER BY attempt.topup_customer_id, attempt.id
        LOOP
          PERFORM credit_payment_top_up(target);
        END LOOP;

        FOR target IN
          SELECT parent.id FROM orders AS parent
          JOIN payment_attempts AS attempt ON attempt.order_id = parent.id
          JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = attempt.id
          WHERE parent.status = 'processing'
          GROUP BY parent.id
          HAVING sum(receipt.refunded_amount) = sum(receipt.amount) AND sum(receipt.refund_reserved_amount) = 0
          ORDER BY parent.id
        LOOP
          PERFORM close_expired_order_when_settled(target);
        END LOOP;
      END
      $backfill$;
    `.execute(db)
  },
  async down() {
    throw new Error('Completed top-up credits and inventory releases are immutable; this migration is forward-only.')
  },
}
