import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Close direct-SQL holes found by ⑤-5; retain every frozen migration and history row. */
export const digitalFulfillmentAcceptanceMigration: Migration = {
  async up(db) {
    await sql`
      CREATE FUNCTION order_has_unresolved_fulfillment(order_uuid uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM order_items AS item WHERE item.order_id = order_uuid
          AND (item.fulfillment_reserved_quantity > 0 OR EXISTS (
            SELECT 1 FROM order_item_fulfillment_attempts AS attempt WHERE attempt.order_item_id = item.id
              AND attempt.status IN ('processing', 'unknown'))))
      $$
    `.execute(db)
    await sql`
      CREATE FUNCTION guard_refund_fulfillment_obligation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE order_uuid uuid;
      BEGIN
        IF TG_TABLE_NAME = 'order_refunds' THEN
          IF TG_OP = 'UPDATE' AND NOT (NEW.status = 'approved'
            OR (NEW.status = 'processing' AND OLD.status IN ('approved', 'failed'))) THEN RETURN NEW; END IF;
          order_uuid := NEW.order_id;
        ELSE
          -- A recorded original-source transfer is an external money fact.
          -- Preserve its confirmation even for a legacy conflicting obligation.
          IF TG_OP = 'UPDATE' AND (NEW.status <> 'succeeded' OR NEW.destination = 'original_source') THEN RETURN NEW; END IF;
          SELECT order_id INTO order_uuid FROM order_refunds WHERE id = NEW.refund_id;
        END IF;
        PERFORM id FROM orders WHERE id = order_uuid FOR UPDATE;
        IF order_has_unresolved_fulfillment(order_uuid) THEN
          RAISE EXCEPTION 'Refund action must wait for in-flight or unknown fulfillment to resolve'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_fulfillment_unresolved';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_refunds_fulfillment_guard BEFORE INSERT OR UPDATE OF status ON order_refunds
      FOR EACH ROW EXECUTE FUNCTION guard_refund_fulfillment_obligation()`.execute(db)
    await sql`CREATE TRIGGER order_refund_allocations_fulfillment_guard BEFORE INSERT OR UPDATE OF status ON order_refund_allocations
      FOR EACH ROW EXECUTE FUNCTION guard_refund_fulfillment_obligation()`.execute(db)
    await sql`
      CREATE FUNCTION guard_digital_delivery_unit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE item order_items%ROWTYPE; parent orders%ROWTYPE;
        attempt order_item_fulfillment_attempts%ROWTYPE; operation supplier_api_delivery_operations%ROWTYPE;
      BEGIN
        SELECT * INTO attempt FROM order_item_fulfillment_attempts WHERE id = NEW.fulfillment_attempt_id;
        SELECT order_row.* INTO parent FROM orders AS order_row JOIN order_items AS line ON line.order_id = order_row.id
          WHERE line.id = attempt.order_item_id FOR UPDATE OF order_row;
        SELECT * INTO item FROM order_items WHERE id = attempt.order_item_id FOR UPDATE;
        -- The attempt may have finished while this insert waited for its parent.
        SELECT * INTO attempt FROM order_item_fulfillment_attempts WHERE id = NEW.fulfillment_attempt_id FOR UPDATE;
        IF attempt.id IS NULL OR attempt.status NOT IN ('processing', 'unknown')
          OR NEW.unit_index > item.quantity THEN
          RAISE EXCEPTION 'Delivery units require a live attempt and an in-range order unit'
            USING ERRCODE = '23514', CONSTRAINT = 'digital_delivery_unit_invalid';
        END IF;
        IF parent.status IS DISTINCT FROM 'processing' OR order_has_unresolved_payment_attempts(parent.id)
          OR EXISTS (SELECT 1 FROM order_refunds WHERE order_id = parent.id AND status IN ('requested', 'approved', 'processing', 'partially_succeeded'))
          OR EXISTS (SELECT 1 FROM payment_attempts AS payment JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = payment.id
            WHERE payment.order_id = parent.id AND (receipt.refunded_amount > 0 OR receipt.refund_reserved_amount > 0))
          OR EXISTS (SELECT 1 FROM payment_attempts AS payment JOIN payment_provider_reconciliation_cases AS reconciliation
            ON reconciliation.payment_attempt_id = payment.id WHERE payment.order_id = parent.id AND reconciliation.state = 'open')
          OR (parent.total_amount > 0 AND COALESCE((SELECT sum(receipt.amount) FROM payment_attempts AS payment
            JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = payment.id
            WHERE payment.order_id = parent.id AND payment.status = 'succeeded' AND receipt.disposition = 'on_time'), 0) <> parent.total_amount) THEN
          RAISE EXCEPTION 'Every delivery method requires confirmed payment without unresolved evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'digital_delivery_payment_required';
        END IF;
        IF EXISTS (SELECT 1 FROM order_item_fulfillment_deliveries AS delivery
          JOIN order_item_fulfillment_attempts AS prior ON prior.id = delivery.fulfillment_attempt_id
          WHERE prior.order_item_id = item.id AND prior.status <> 'failed' AND delivery.unit_index = NEW.unit_index) THEN
          RAISE EXCEPTION 'An order unit cannot be delivered twice across attempts'
            USING ERRCODE = '23514', CONSTRAINT = 'digital_delivery_unit_duplicate';
        END IF;
        IF NEW.delivery_source = 'api' THEN
          SELECT * INTO operation FROM supplier_api_delivery_operations WHERE id = NEW.supplier_api_operation_id;
          IF operation.state IS DISTINCT FROM 'succeeded_pending_finalize'
            OR operation.unit_index IS DISTINCT FROM NEW.unit_index
            OR operation.result_type IS DISTINCT FROM NEW.supplier_content_type
            OR (NEW.supplier_content_type <> 'completed' AND ROW(NEW.encrypted_content, NEW.content_nonce, NEW.content_auth_tag, NEW.encryption_key_id)
              IS DISTINCT FROM ROW(operation.result_ciphertext, operation.result_nonce, operation.result_auth_tag, operation.result_key_id)) THEN
            RAISE EXCEPTION 'API delivery must retain its confirmed unit and encrypted result'
              USING ERRCODE = '23514', CONSTRAINT = 'api_delivery_result_mismatch';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_item_fulfillment_deliveries_unit_guard
      BEFORE INSERT ON order_item_fulfillment_deliveries FOR EACH ROW EXECUTE FUNCTION guard_digital_delivery_unit()`.execute(db)

    await sql`
      CREATE FUNCTION guard_digital_delivery_payment() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE parent orders%ROWTYPE;
      BEGIN
        IF NEW.status <> 'succeeded' OR OLD.status = 'succeeded' THEN RETURN NEW; END IF;
        SELECT order_row.* INTO parent FROM orders AS order_row JOIN order_items AS item ON item.order_id = order_row.id
          WHERE item.id = NEW.order_item_id FOR UPDATE OF order_row;
        IF parent.status IS DISTINCT FROM 'processing' OR order_has_unresolved_payment_attempts(parent.id)
          OR EXISTS (SELECT 1 FROM order_refunds WHERE order_id = parent.id AND status IN ('requested', 'approved', 'processing', 'partially_succeeded'))
          OR EXISTS (SELECT 1 FROM payment_attempts AS payment JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = payment.id
            WHERE payment.order_id = parent.id AND (receipt.refunded_amount > 0 OR receipt.refund_reserved_amount > 0))
          OR EXISTS (SELECT 1 FROM payment_attempts AS payment JOIN payment_provider_reconciliation_cases AS reconciliation
            ON reconciliation.payment_attempt_id = payment.id WHERE payment.order_id = parent.id AND reconciliation.state = 'open')
          OR (parent.total_amount > 0 AND COALESCE((SELECT sum(receipt.amount) FROM payment_attempts AS payment
            JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = payment.id
            WHERE payment.order_id = parent.id AND payment.status = 'succeeded' AND receipt.disposition = 'on_time'), 0) <> parent.total_amount) THEN
          RAISE EXCEPTION 'Delivery success requires confirmed payment without refund or unresolved evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'digital_delivery_payment_required';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_item_fulfillment_payment_guard BEFORE UPDATE OF status ON order_item_fulfillment_attempts
      FOR EACH ROW EXECUTE FUNCTION guard_digital_delivery_payment()`.execute(db)

    await sql`
      CREATE FUNCTION guard_supplier_api_unit_identity() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE attempt order_item_fulfillment_attempts%ROWTYPE; item order_items%ROWTYPE;
        version product_variant_fulfillment_versions%ROWTYPE; connection_uuid uuid;
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW.unit_index IS DISTINCT FROM OLD.unit_index
            OR (OLD.provider_operation_id IS NOT NULL AND NEW.provider_operation_id IS DISTINCT FROM OLD.provider_operation_id) THEN
            RAISE EXCEPTION 'Supplier unit and recorded provider identity are immutable'
              USING ERRCODE = '23514', CONSTRAINT = 'supplier_api_operation_unit_immutable';
          END IF;
          IF NEW.state = 'succeeded' AND OLD.state <> 'succeeded' AND NOT EXISTS (
            SELECT 1 FROM order_item_fulfillment_deliveries AS delivery
            JOIN order_item_fulfillment_attempts AS fulfilled ON fulfilled.id = delivery.fulfillment_attempt_id
            WHERE delivery.supplier_api_operation_id = NEW.id AND delivery.unit_index = NEW.unit_index
              AND fulfilled.id = NEW.fulfillment_attempt_id AND fulfilled.status = 'succeeded'
          ) THEN
            RAISE EXCEPTION 'Supplier completion requires its committed final delivery'
              USING ERRCODE = '23514', CONSTRAINT = 'supplier_api_operation_delivery_required';
          END IF;
          RETURN NEW;
        END IF;
        SELECT * INTO attempt FROM order_item_fulfillment_attempts WHERE id = NEW.fulfillment_attempt_id;
        PERFORM parent.id FROM orders AS parent JOIN order_items AS line ON line.order_id = parent.id
          WHERE line.id = attempt.order_item_id FOR UPDATE OF parent;
        SELECT * INTO item FROM order_items WHERE id = attempt.order_item_id FOR UPDATE;
        SELECT * INTO attempt FROM order_item_fulfillment_attempts WHERE id = NEW.fulfillment_attempt_id FOR UPDATE;
        SELECT * INTO version FROM product_variant_fulfillment_versions WHERE id = item.fulfillment_content_version_id;
        SELECT supplier_connection_id INTO connection_uuid FROM supplier_connection_versions WHERE id = version.supplier_connection_version_id;
        IF attempt.id IS NULL OR attempt.delivery_source <> 'api' OR attempt.quantity <> 1 OR attempt.status <> 'processing'
          OR NEW.id IS DISTINCT FROM attempt.operation_id OR NEW.operation_id IS DISTINCT FROM attempt.operation_id
          OR NEW.idempotency_key IS DISTINCT FROM 'aikayun:' || NEW.operation_id::text
          OR NEW.unit_index > item.quantity OR version.method IS DISTINCT FROM 'api'
          OR NEW.supplier_connection_version_id IS DISTINCT FROM version.supplier_connection_version_id
          OR NEW.supplier_connection_id IS DISTINCT FROM connection_uuid
          OR NEW.supplier_product_id IS DISTINCT FROM version.supplier_product_id THEN
          RAISE EXCEPTION 'Supplier operation must match its immutable order unit and version'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_api_operation_order_unit_invalid';
        END IF;
        IF EXISTS (SELECT 1 FROM supplier_api_delivery_operations AS prior
          JOIN order_item_fulfillment_attempts AS prior_attempt ON prior_attempt.id = prior.fulfillment_attempt_id
          WHERE prior_attempt.order_item_id = item.id AND prior.unit_index = NEW.unit_index AND prior.state <> 'failed') THEN
          RAISE EXCEPTION 'Only a confirmed failed supplier unit may receive another operation'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_api_operation_unit_duplicate';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER supplier_api_operations_unit_guard BEFORE INSERT OR UPDATE ON supplier_api_delivery_operations
      FOR EACH ROW EXECUTE FUNCTION guard_supplier_api_unit_identity()`.execute(db)
  },
  async down() {
    throw new Error('Digital fulfillment history protections are forward-only.')
  },
}
