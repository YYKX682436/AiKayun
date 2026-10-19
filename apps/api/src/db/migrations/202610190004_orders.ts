import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const ordersMigration: Migration = {
  async up(db) {
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

    // The frozen ④-1 close guard checked collected and refunded amounts, but did
    // not block an active or uncertain payment attempt with no receipt yet.
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
            SELECT COALESCE(sum(receipt.amount), 0), COALESCE(sum(receipt.refunded_amount), 0),
              COALESCE(sum(receipt.refund_reserved_amount), 0)
              INTO paid_amount, refunded_amount, refund_reserved_amount
            FROM payment_receipts AS receipt
            JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
            WHERE attempt.order_id = OLD.id;
            SELECT EXISTS (
              SELECT 1 FROM payment_attempts AS attempt
              WHERE attempt.order_id = OLD.id
                AND ((attempt.status = 'pending' AND attempt.expires_at > clock_timestamp())
                  OR (attempt.status = 'reconciliation_required' AND NOT EXISTS (
                    SELECT 1 FROM payment_receipts AS receipt WHERE receipt.payment_attempt_id = attempt.id
                  )))
            ) INTO has_unresolved_payment;
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
  },
}
