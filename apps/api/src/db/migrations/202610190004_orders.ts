import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const ordersMigration: Migration = {
  async up(db) {
    // `created` may already have a provider-side payment in flight. Treat it
    // like `pending` until a provider deadline has elapsed or a terminal result
    // is confirmed. Legacy NULL deadlines remain valid records, but never make
    // an attempt look safely expired.
    await sql`
      CREATE FUNCTION order_has_unresolved_payment_attempts(order_uuid uuid) RETURNS boolean
      LANGUAGE sql VOLATILE AS $$
        SELECT EXISTS (
          SELECT 1 FROM payment_attempts AS attempt
          WHERE attempt.order_id = order_uuid
            AND (
              (attempt.status IN ('created', 'pending')
                AND (attempt.expires_at IS NULL OR attempt.expires_at > clock_timestamp()))
              OR (attempt.status IN ('succeeded', 'late_succeeded', 'reconciliation_required')
                AND NOT EXISTS (
                  SELECT 1 FROM payment_receipts AS receipt
                  WHERE receipt.payment_attempt_id = attempt.id
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
      CREATE FUNCTION guard_payment_attempt_deadline_r1() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        order_status varchar(24);
        order_expires_at timestamptz;
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.order_id IS NOT NULL AND NEW.source = 'external'
          AND NEW.status = 'created'
          AND (NEW.expires_at IS NULL OR NEW.expires_at <= clock_timestamp()) THEN
          RAISE EXCEPTION 'A new external order payment attempt requires a future provider deadline'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_created_deadline_required';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.expires_at IS DISTINCT FROM OLD.expires_at
          AND NOT (OLD.status = 'created' AND NEW.status = 'pending') THEN
          -- The provider deadline is captured when an attempt is created. The
          -- only permitted later write is setting it while created -> pending;
          -- that state transition takes the order advisory lock below and
          -- revalidates that the order remains payable. In particular,
          -- created -> created cannot race order closure by editing the value
          -- that the close guard uses to classify an attempt.
          RAISE EXCEPTION 'A payment attempt deadline is immutable after creation'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_deadline_immutable';
        END IF;
        IF NEW.status = 'pending' THEN
          IF NEW.expires_at IS NULL OR NEW.expires_at <= clock_timestamp() THEN
            RAISE EXCEPTION 'A pending payment attempt requires a future provider deadline'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_pending_deadline_required';
          END IF;
        END IF;
        IF NEW.order_id IS NOT NULL AND TG_OP = 'UPDATE'
          AND OLD.status IS DISTINCT FROM NEW.status THEN
          -- UPDATE has already locked its payment_attempts row before this
          -- trigger runs. Keep that row -> advisory order for state changes.
          -- INSERT deliberately does not take this lock: the frozen
          -- payment_attempts_validate trigger locks the order row first.
          -- Order closure must never update payment_attempts from its AFTER
          -- trigger, or it would invert these row/advisory locks.
          PERFORM pg_advisory_xact_lock(hashtextextended(NEW.order_id::text, 0));
          IF NEW.status = 'pending' THEN
            SELECT status, unpaid_expires_at INTO order_status, order_expires_at
            FROM orders WHERE id = NEW.order_id;
            IF NOT FOUND OR order_status <> 'pending_payment'
              OR order_expires_at IS NULL OR order_expires_at <= clock_timestamp() THEN
              RAISE EXCEPTION 'A payment attempt cannot become pending for a closed or expired order'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_order_payable';
            END IF;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    // The frozen ④-1 close trigger synchronously cancelled payment attempts.
    // That takes a payment row after order -> advisory locks and can deadlock
    // with payment_attempts_deadline_r1, which reaches advisory after the
    // UPDATE has locked its payment row. Keep attempts intact after closure so
    // a later provider receipt can still be recorded and classified as late.
    // The shared close predicate protects unresolved attempts and wallet holds.
    await sql`
      CREATE OR REPLACE FUNCTION release_order_inventory_on_close() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE reservation_row record;
      DECLARE outstanding bigint;
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'closed' THEN
          FOR reservation_row IN
            SELECT reservation.id, reservation.quantity, item.fulfillment_reserved_quantity
            FROM order_inventory_reservations AS reservation
            JOIN order_items AS item ON item.id = reservation.order_item_id
            WHERE item.order_id = NEW.id
            ORDER BY reservation.product_variant_id, reservation.id
          LOOP
            SELECT COALESCE(sum(quantity) FILTER (WHERE action = 'reserve'), 0)
              - COALESCE(sum(quantity) FILTER (WHERE action IN ('release', 'consume')), 0)
              INTO outstanding
            FROM order_inventory_events WHERE reservation_id = reservation_row.id;
            outstanding := outstanding - reservation_row.fulfillment_reserved_quantity;
            IF outstanding > 0 THEN
              INSERT INTO order_inventory_events (id, reservation_id, operation_id, action, quantity)
              VALUES (gen_random_uuid(), reservation_row.id, gen_random_uuid(), 'release', outstanding::integer);
            END IF;
          END LOOP;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER payment_attempts_deadline_r1
      BEFORE INSERT OR UPDATE ON payment_attempts
      FOR EACH ROW EXECUTE FUNCTION guard_payment_attempt_deadline_r1()
    `.execute(db)

    await sql`
      ALTER TABLE product_variant_fulfillment
        ADD COLUMN manual_delivery_ready boolean NOT NULL DEFAULT false
    `.execute(db)
    await sql`
      ALTER TABLE order_item_fulfillment_attempts
        ADD COLUMN started_by_admin_id uuid,
        ADD CONSTRAINT order_item_fulfillment_attempts_admin_fkey
          FOREIGN KEY (started_by_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT
    `.execute(db)

    await sql`
      CREATE TABLE order_item_fulfillment_deliveries (
        id uuid PRIMARY KEY,
        fulfillment_attempt_id uuid NOT NULL,
        started_by_admin_id uuid NOT NULL,
        unit_index integer NOT NULL,
        content text NOT NULL,
        content_sha256 char(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT order_item_fulfillment_deliveries_attempt_fkey
          FOREIGN KEY (fulfillment_attempt_id)
          REFERENCES order_item_fulfillment_attempts (id) ON DELETE RESTRICT,
        CONSTRAINT order_item_fulfillment_deliveries_admin_fkey
          FOREIGN KEY (started_by_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT order_item_fulfillment_deliveries_unit_unique
          UNIQUE (fulfillment_attempt_id, unit_index),
        CONSTRAINT order_item_fulfillment_deliveries_unit_check CHECK (unit_index > 0),
        CONSTRAINT order_item_fulfillment_deliveries_content_check
          CHECK (char_length(content) BETWEEN 1 AND 512 AND btrim(content) <> ''),
        CONSTRAINT order_item_fulfillment_deliveries_hash_check
          CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
      )
    `.execute(db)
    await sql`
      CREATE INDEX order_item_fulfillment_deliveries_attempt_idx
        ON order_item_fulfillment_deliveries (fulfillment_attempt_id, unit_index)
    `.execute(db)

    await sql`
      CREATE FUNCTION guard_manual_fulfillment_delivery_success() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        fulfillment_method varchar(24);
        delivery_count bigint;
        delivery_actor_count bigint;
      BEGIN
        IF NEW.status = 'succeeded' AND OLD.status IS DISTINCT FROM NEW.status THEN
          SELECT fulfillment_method_snapshot INTO fulfillment_method
          FROM order_items WHERE id = NEW.order_item_id;
          IF fulfillment_method = 'manual' THEN
            SELECT count(*), count(*) FILTER (WHERE started_by_admin_id = NEW.started_by_admin_id)
              INTO delivery_count, delivery_actor_count
            FROM order_item_fulfillment_deliveries
            WHERE fulfillment_attempt_id = NEW.id;
            IF NEW.started_by_admin_id IS NULL OR delivery_count <> NEW.quantity
              OR delivery_actor_count <> delivery_count THEN
              RAISE EXCEPTION 'Manual fulfillment requires one private delivery record per unit and its administrator'
                USING ERRCODE = '23514', CONSTRAINT = 'manual_fulfillment_delivery_required';
            END IF;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER order_item_fulfillment_manual_delivery_guard
      BEFORE UPDATE OF status ON order_item_fulfillment_attempts
      FOR EACH ROW EXECUTE FUNCTION guard_manual_fulfillment_delivery_success()
    `.execute(db)

    await sql`
      CREATE FUNCTION validate_order_manual_fulfillment_readiness() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        product_type varchar(16);
        configured_method varchar(24);
        delivery_ready boolean;
      BEGIN
        SELECT product.product_type, fulfillment.method, fulfillment.manual_delivery_ready
          INTO product_type, configured_method, delivery_ready
        FROM products AS product
        JOIN product_variants AS variant ON variant.product_id = product.id
        LEFT JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
        WHERE product.id = NEW.product_id AND variant.id = NEW.product_variant_id;
        IF product_type IS DISTINCT FROM 'digital' OR configured_method IS DISTINCT FROM 'manual'
          OR delivery_ready IS DISTINCT FROM true OR NEW.fulfillment_method_snapshot <> 'manual' THEN
          RAISE EXCEPTION 'Only explicitly ready manual digital SKUs can be ordered'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_manual_delivery_not_ready';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER order_items_validate_snapshot_manual
      BEFORE INSERT ON order_items
      FOR EACH ROW EXECUTE FUNCTION validate_order_manual_fulfillment_readiness()
    `.execute(db)

    await sql`
      CREATE FUNCTION protect_fulfillment_delivery_content() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Fulfillment delivery content is immutable trade history'
          USING ERRCODE = '23514', CONSTRAINT = 'fulfillment_delivery_content_immutable';
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER order_item_fulfillment_deliveries_immutable
      BEFORE UPDATE OR DELETE ON order_item_fulfillment_deliveries
      FOR EACH ROW EXECUTE FUNCTION protect_fulfillment_delivery_content()
    `.execute(db)
    await sql`
      CREATE TRIGGER order_item_fulfillment_deliveries_prevent_truncate
      BEFORE TRUNCATE ON order_item_fulfillment_deliveries
      FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()
    `.execute(db)

    // A late receipt can arrive after the order deadline while its attempt is
    // still active (including a legacy NULL deadline). Keep the order open for
    // reconciliation; the receipt trigger will record the money as late.
    await sql`
      CREATE OR REPLACE FUNCTION close_expired_order_when_settled(order_uuid uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        order_row orders%ROWTYPE;
        collected_amount numeric(18, 2);
        refunded_amount numeric(18, 2);
        reserved_refund_amount numeric(18, 2);
        has_active_refund boolean;
        has_inflight_fulfillment boolean;
      BEGIN
        SELECT * INTO order_row FROM orders WHERE id = order_uuid FOR UPDATE;
        IF NOT FOUND OR order_row.status <> 'pending_payment' OR order_row.unpaid_expires_at IS NULL
          OR order_has_unresolved_payment_attempts(order_uuid)
          OR (order_row.unpaid_expires_at > clock_timestamp() AND NOT EXISTS (
            SELECT 1 FROM payment_attempts AS attempt
            WHERE attempt.order_id = order_uuid AND attempt.expires_at <= clock_timestamp()
          )) THEN
          RETURN;
        END IF;

        SELECT COALESCE(sum(receipt.amount), 0), COALESCE(sum(receipt.refunded_amount), 0),
          COALESCE(sum(receipt.refund_reserved_amount), 0)
          INTO collected_amount, refunded_amount, reserved_refund_amount
        FROM payment_receipts AS receipt
        JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
        WHERE attempt.order_id = order_uuid;
        SELECT EXISTS (SELECT 1 FROM order_refunds AS refund WHERE refund.order_id = order_uuid
          AND refund.status IN ('requested', 'approved', 'processing', 'partially_succeeded'))
          INTO has_active_refund;
        SELECT EXISTS (
          SELECT 1 FROM order_item_fulfillment_attempts AS attempt
          JOIN order_items AS item ON item.id = attempt.order_item_id
          WHERE item.order_id = order_uuid AND attempt.status IN ('processing', 'unknown')
        ) OR EXISTS (SELECT 1 FROM order_items AS item
          WHERE item.order_id = order_uuid AND item.fulfillment_reserved_quantity > 0)
          INTO has_inflight_fulfillment;

        IF collected_amount = refunded_amount AND reserved_refund_amount = 0
          AND NOT has_active_refund AND NOT has_inflight_fulfillment THEN
          UPDATE orders SET status = 'closed' WHERE id = order_uuid AND status = 'pending_payment';
        END IF;
      END;
      $$
    `.execute(db)

    // API cancellation, timeout closure, receipt-triggered expiration and the
    // database guard all share one payment-attempt state predicate.
    await sql`
      CREATE OR REPLACE FUNCTION guard_order_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        paid_amount numeric;
        refunded_amount numeric;
        refund_reserved_amount numeric;
        has_unresolved boolean;
        has_active_refund boolean;
        has_inflight_fulfillment boolean;
        has_unresolved_payment boolean;
        all_items_complete boolean;
      BEGIN
        IF ROW(NEW.id, NEW.customer_id, NEW.guest_order_session_id, NEW.idempotency_key,
               NEW.request_sha256, NEW.total_amount, NEW.currency, NEW.created_at,
               NEW.unpaid_expires_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.customer_id, OLD.guest_order_session_id, OLD.idempotency_key,
               OLD.request_sha256, OLD.total_amount, OLD.currency, OLD.created_at,
               OLD.unpaid_expires_at) THEN
          RAISE EXCEPTION 'Order ownership, idempotency and amount snapshots are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_identity_immutable';
        END IF;
        IF NEW.items_sealed IS DISTINCT FROM OLD.items_sealed
          AND (OLD.items_sealed OR NOT NEW.items_sealed) THEN
          RAISE EXCEPTION 'Order items can only be sealed once'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_items_seal_transition';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status THEN
          IF NOT ((OLD.status = 'pending_payment' AND NEW.status IN ('processing', 'closed'))
            OR (OLD.status = 'processing' AND NEW.status IN ('completed', 'closed'))) THEN
            RAISE EXCEPTION 'Illegal order status transition: % to %', OLD.status, NEW.status
              USING ERRCODE = '23514', CONSTRAINT = 'orders_status_transition';
          END IF;
          IF NEW.status = 'processing' AND OLD.status = 'pending_payment' THEN
            SELECT COALESCE(sum(receipt.amount), 0),
              COALESCE(bool_or(receipt.disposition <> 'on_time' OR attempt.status <> 'succeeded'), false)
              INTO paid_amount, has_unresolved FROM payment_receipts AS receipt
              JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
              WHERE attempt.order_id = OLD.id;
            IF OLD.total_amount > 0 AND (paid_amount <> OLD.total_amount OR has_unresolved) THEN
              RAISE EXCEPTION 'An order requires confirmed on-time payment before processing'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_processing_requires_payment';
            END IF;
          END IF;
          IF NEW.status = 'closed' THEN
            -- Pair with payment_attempts_deadline_r1 before checking payment
            -- rows. The lock is shared by every state transition for this
            -- order, without taking payment-attempt row locks in reverse order.
            PERFORM pg_advisory_xact_lock(hashtextextended(OLD.id::text, 0));
            SELECT COALESCE(sum(receipt.amount), 0), COALESCE(sum(receipt.refunded_amount), 0),
              COALESCE(sum(receipt.refund_reserved_amount), 0)
              INTO paid_amount, refunded_amount, refund_reserved_amount
            FROM payment_receipts AS receipt
            JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
            WHERE attempt.order_id = OLD.id;
            SELECT order_has_unresolved_payment_attempts(OLD.id) INTO has_unresolved_payment;
            SELECT EXISTS (SELECT 1 FROM order_refunds AS refund
              WHERE refund.order_id = OLD.id
                AND refund.status IN ('requested', 'approved', 'processing', 'partially_succeeded'))
              INTO has_active_refund;
            SELECT EXISTS (
              SELECT 1 FROM order_item_fulfillment_attempts AS attempt
              JOIN order_items AS item ON item.id = attempt.order_item_id
              WHERE item.order_id = OLD.id AND attempt.status IN ('processing', 'unknown')
            ) OR EXISTS (SELECT 1 FROM order_items AS item
              WHERE item.order_id = OLD.id AND item.fulfillment_reserved_quantity > 0)
              INTO has_inflight_fulfillment;
            IF has_unresolved_payment THEN
              RAISE EXCEPTION 'Order cannot close while a payment is active or requires reconciliation'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_close_payment_unresolved';
            END IF;
            IF refund_reserved_amount > 0 OR has_active_refund THEN
              RAISE EXCEPTION 'Order cannot close while a refund is unresolved'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_close_refund_unresolved';
            END IF;
            IF paid_amount <> refunded_amount THEN
              RAISE EXCEPTION 'Collected order funds must be fully refunded before closing'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_close_requires_full_refund';
            END IF;
            IF has_inflight_fulfillment THEN
              RAISE EXCEPTION 'Order cannot close while fulfillment is processing or uncertain'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_close_fulfillment_unresolved';
            END IF;
          END IF;
          IF NEW.status = 'completed' THEN
            SELECT count(*) > 0 AND bool_and(
              item.fulfillment_status = 'completed' AND item.fulfilled_quantity = item.quantity
            ) INTO all_items_complete FROM order_items AS item WHERE item.order_id = OLD.id;
            IF NOT COALESCE(all_items_complete, false) THEN
              RAISE EXCEPTION 'Every order item must be fully fulfilled before order completion'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_completion_requires_fulfillment';
            END IF;
          END IF;
        END IF;
        IF ROW(NEW.history_hidden_at, NEW.history_hidden_by_admin_id, NEW.history_hidden_reason)
          IS DISTINCT FROM ROW(OLD.history_hidden_at, OLD.history_hidden_by_admin_id, OLD.history_hidden_reason) THEN
          IF OLD.history_hidden_at IS NOT NULL OR NEW.history_hidden_at IS NULL THEN
            RAISE EXCEPTION 'Order history hiding is a one-way audited action'
              USING ERRCODE = '23514', CONSTRAINT = 'orders_history_visibility_transition';
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
        IF EXISTS (SELECT 1 FROM order_item_fulfillment_deliveries) THEN
          RAISE EXCEPTION 'Cannot roll back manual fulfillment while private delivery history exists';
        END IF;
      END;
      $$
    `.execute(db)
    await sql`DROP TRIGGER order_item_fulfillment_deliveries_prevent_truncate ON order_item_fulfillment_deliveries`.execute(db)
    await sql`DROP TRIGGER order_item_fulfillment_deliveries_immutable ON order_item_fulfillment_deliveries`.execute(db)
    await sql`DROP TRIGGER order_item_fulfillment_manual_delivery_guard ON order_item_fulfillment_attempts`.execute(db)
    await sql`DROP TRIGGER order_items_validate_snapshot_manual ON order_items`.execute(db)
    await sql`DROP TABLE order_item_fulfillment_deliveries`.execute(db)
    await sql`DROP FUNCTION protect_fulfillment_delivery_content()`.execute(db)
    await sql`DROP FUNCTION guard_manual_fulfillment_delivery_success()`.execute(db)
    await sql`DROP FUNCTION validate_order_manual_fulfillment_readiness()`.execute(db)
    await sql`
      ALTER TABLE order_item_fulfillment_attempts
        DROP CONSTRAINT order_item_fulfillment_attempts_admin_fkey,
        DROP COLUMN started_by_admin_id
    `.execute(db)
    await sql`ALTER TABLE product_variant_fulfillment DROP COLUMN manual_delivery_ready`.execute(db)

    // Restore the frozen ④-1 inventory-close trigger implementation on rollback.
    await sql`
      CREATE OR REPLACE FUNCTION release_order_inventory_on_close() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE reservation_row record;
      DECLARE outstanding bigint;
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'closed' THEN
          UPDATE payment_attempts SET status = 'cancelled'
          WHERE order_id = NEW.id AND status IN ('created', 'pending');
          FOR reservation_row IN
            SELECT reservation.id, reservation.quantity, item.fulfillment_reserved_quantity
            FROM order_inventory_reservations AS reservation
            JOIN order_items AS item ON item.id = reservation.order_item_id
            WHERE item.order_id = NEW.id
            ORDER BY reservation.product_variant_id, reservation.id
          LOOP
            SELECT COALESCE(sum(quantity) FILTER (WHERE action = 'reserve'), 0)
              - COALESCE(sum(quantity) FILTER (WHERE action IN ('release', 'consume')), 0)
              INTO outstanding
            FROM order_inventory_events WHERE reservation_id = reservation_row.id;
            outstanding := outstanding - reservation_row.fulfillment_reserved_quantity;
            IF outstanding > 0 THEN
              INSERT INTO order_inventory_events (id, reservation_id, operation_id, action, quantity)
              VALUES (gen_random_uuid(), reservation_row.id, gen_random_uuid(), 'release', outstanding::integer);
            END IF;
          END LOOP;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    // Restore the frozen ④-1 close guard when rolling this migration back.
    await sql`
      CREATE OR REPLACE FUNCTION guard_order_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        paid_amount numeric;
        refunded_amount numeric;
        refund_reserved_amount numeric;
        has_unresolved boolean;
        has_active_refund boolean;
        has_inflight_fulfillment boolean;
        all_items_complete boolean;
      BEGIN
        IF ROW(NEW.id, NEW.customer_id, NEW.guest_order_session_id, NEW.idempotency_key,
               NEW.request_sha256, NEW.total_amount, NEW.currency, NEW.created_at,
               NEW.unpaid_expires_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.customer_id, OLD.guest_order_session_id, OLD.idempotency_key,
               OLD.request_sha256, OLD.total_amount, OLD.currency, OLD.created_at,
               OLD.unpaid_expires_at) THEN
          RAISE EXCEPTION 'Order ownership, idempotency and amount snapshots are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_identity_immutable';
        END IF;
        IF NEW.items_sealed IS DISTINCT FROM OLD.items_sealed
          AND (OLD.items_sealed OR NOT NEW.items_sealed) THEN
          RAISE EXCEPTION 'Order items can only be sealed once'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_items_seal_transition';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status THEN
          IF NOT ((OLD.status = 'pending_payment' AND NEW.status IN ('processing', 'closed'))
            OR (OLD.status = 'processing' AND NEW.status IN ('completed', 'closed'))) THEN
            RAISE EXCEPTION 'Illegal order status transition: % to %', OLD.status, NEW.status
              USING ERRCODE = '23514', CONSTRAINT = 'orders_status_transition';
          END IF;
          IF NEW.status = 'processing' AND OLD.status = 'pending_payment' THEN
            SELECT COALESCE(sum(receipt.amount), 0),
              COALESCE(bool_or(receipt.disposition <> 'on_time' OR attempt.status <> 'succeeded'), false)
              INTO paid_amount, has_unresolved FROM payment_receipts AS receipt
              JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
              WHERE attempt.order_id = OLD.id;
            IF OLD.total_amount > 0 AND (paid_amount <> OLD.total_amount OR has_unresolved) THEN
              RAISE EXCEPTION 'An order requires confirmed on-time payment before processing'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_processing_requires_payment';
            END IF;
          END IF;
          IF NEW.status = 'closed' THEN
            SELECT COALESCE(sum(receipt.amount), 0), COALESCE(sum(receipt.refunded_amount), 0),
              COALESCE(sum(receipt.refund_reserved_amount), 0)
              INTO paid_amount, refunded_amount, refund_reserved_amount
            FROM payment_receipts AS receipt
            JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
            WHERE attempt.order_id = OLD.id;
            SELECT EXISTS (SELECT 1 FROM order_refunds AS refund
              WHERE refund.order_id = OLD.id
                AND refund.status IN ('requested', 'approved', 'processing', 'partially_succeeded'))
              INTO has_active_refund;
            SELECT EXISTS (
              SELECT 1 FROM order_item_fulfillment_attempts AS attempt
              JOIN order_items AS item ON item.id = attempt.order_item_id
              WHERE item.order_id = OLD.id AND attempt.status IN ('processing', 'unknown')
            ) OR EXISTS (SELECT 1 FROM order_items AS item
              WHERE item.order_id = OLD.id AND item.fulfillment_reserved_quantity > 0)
              INTO has_inflight_fulfillment;
            IF refund_reserved_amount > 0 OR has_active_refund THEN
              RAISE EXCEPTION 'Order cannot close while a refund is unresolved'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_close_refund_unresolved';
            END IF;
            IF paid_amount <> refunded_amount THEN
              RAISE EXCEPTION 'Collected order funds must be fully refunded before closing'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_close_requires_full_refund';
            END IF;
            IF has_inflight_fulfillment THEN
              RAISE EXCEPTION 'Order cannot close while fulfillment is processing or uncertain'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_close_fulfillment_unresolved';
            END IF;
          END IF;
          IF NEW.status = 'completed' THEN
            SELECT count(*) > 0 AND bool_and(
              item.fulfillment_status = 'completed' AND item.fulfilled_quantity = item.quantity
            ) INTO all_items_complete FROM order_items AS item WHERE item.order_id = OLD.id;
            IF NOT COALESCE(all_items_complete, false) THEN
              RAISE EXCEPTION 'Every order item must be fully fulfilled before order completion'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_completion_requires_fulfillment';
            END IF;
          END IF;
        END IF;
        IF ROW(NEW.history_hidden_at, NEW.history_hidden_by_admin_id, NEW.history_hidden_reason)
          IS DISTINCT FROM ROW(OLD.history_hidden_at, OLD.history_hidden_by_admin_id, OLD.history_hidden_reason) THEN
          IF OLD.history_hidden_at IS NOT NULL OR NEW.history_hidden_at IS NULL THEN
            RAISE EXCEPTION 'Order history hiding is a one-way audited action'
              USING ERRCODE = '23514', CONSTRAINT = 'orders_history_visibility_transition';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION close_expired_order_when_settled(order_uuid uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        order_row orders%ROWTYPE;
        collected_amount numeric(18, 2);
        refunded_amount numeric(18, 2);
        reserved_refund_amount numeric(18, 2);
        has_active_refund boolean;
        has_inflight_fulfillment boolean;
      BEGIN
        SELECT * INTO order_row FROM orders WHERE id = order_uuid FOR UPDATE;
        IF NOT FOUND OR order_row.status <> 'pending_payment' OR order_row.unpaid_expires_at IS NULL
          OR (order_row.unpaid_expires_at > clock_timestamp() AND NOT EXISTS (
            SELECT 1 FROM payment_attempts AS attempt
            WHERE attempt.order_id = order_uuid AND attempt.expires_at <= clock_timestamp()
          )) THEN
          RETURN;
        END IF;

        SELECT COALESCE(sum(receipt.amount), 0), COALESCE(sum(receipt.refunded_amount), 0),
          COALESCE(sum(receipt.refund_reserved_amount), 0)
          INTO collected_amount, refunded_amount, reserved_refund_amount
        FROM payment_receipts AS receipt
        JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
        WHERE attempt.order_id = order_uuid;
        SELECT EXISTS (SELECT 1 FROM order_refunds AS refund WHERE refund.order_id = order_uuid
          AND refund.status IN ('requested', 'approved', 'processing', 'partially_succeeded'))
          INTO has_active_refund;
        SELECT EXISTS (
          SELECT 1 FROM order_item_fulfillment_attempts AS attempt
          JOIN order_items AS item ON item.id = attempt.order_item_id
          WHERE item.order_id = order_uuid AND attempt.status IN ('processing', 'unknown')
        ) OR EXISTS (SELECT 1 FROM order_items AS item
          WHERE item.order_id = order_uuid AND item.fulfillment_reserved_quantity > 0)
          INTO has_inflight_fulfillment;

        IF collected_amount = refunded_amount AND reserved_refund_amount = 0
          AND NOT has_active_refund AND NOT has_inflight_fulfillment THEN
          UPDATE orders SET status = 'closed' WHERE id = order_uuid AND status = 'pending_payment';
        END IF;
      END;
      $$
    `.execute(db)

    await sql`DROP TRIGGER payment_attempts_deadline_r1 ON payment_attempts`.execute(db)
    await sql`DROP FUNCTION guard_payment_attempt_deadline_r1()`.execute(db)
    await sql`DROP FUNCTION order_has_unresolved_payment_attempts(uuid)`.execute(db)
  },
}
