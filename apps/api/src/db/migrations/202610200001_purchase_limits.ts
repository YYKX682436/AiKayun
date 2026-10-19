import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/**
 * Purchase rules live on the existing product and SKU identities. Purchase
 * totals are derived from immutable order items and payment/fulfillment facts.
 */
export const purchaseLimitsMigration: Migration = {
  async up(db) {
    await sql`
      ALTER TABLE products
        ADD COLUMN purchase_limit_per_order integer,
        ADD COLUMN purchase_limit_lifetime integer,
        ADD COLUMN purchase_limit_24h integer,
        ADD CONSTRAINT products_purchase_limit_per_order_check
          CHECK (purchase_limit_per_order IS NULL OR purchase_limit_per_order BETWEEN 1 AND 4950),
        ADD CONSTRAINT products_purchase_limit_lifetime_check
          CHECK (purchase_limit_lifetime IS NULL OR purchase_limit_lifetime BETWEEN 1 AND 2147483647),
        ADD CONSTRAINT products_purchase_limit_24h_check
          CHECK (purchase_limit_24h IS NULL OR purchase_limit_24h BETWEEN 1 AND 2147483647)
    `.execute(db)

    await sql`
      ALTER TABLE product_variants
        ADD COLUMN purchase_limit_per_order integer,
        ADD COLUMN purchase_limit_lifetime integer,
        ADD COLUMN purchase_limit_24h integer,
        ADD CONSTRAINT product_variants_purchase_limit_per_order_check
          CHECK (purchase_limit_per_order IS NULL OR purchase_limit_per_order BETWEEN 1 AND 99),
        ADD CONSTRAINT product_variants_purchase_limit_lifetime_check
          CHECK (purchase_limit_lifetime IS NULL OR purchase_limit_lifetime BETWEEN 1 AND 2147483647),
        ADD CONSTRAINT product_variants_purchase_limit_24h_check
          CHECK (purchase_limit_24h IS NULL OR purchase_limit_24h BETWEEN 1 AND 2147483647)
    `.execute(db)

    // This version is a row-write fence for REPEATABLE READ direct writers,
    // not a cached purchased-quantity counter.
    await sql`
      ALTER TABLE customers
        ADD COLUMN purchase_limit_lock_version bigint NOT NULL DEFAULT 0,
        ADD CONSTRAINT customers_purchase_limit_lock_version_check
          CHECK (purchase_limit_lock_version >= 0)
    `.execute(db)

    // Product/SKU rule edits remain ordinary catalog revisions. The customer
    // fence is deliberately separate from account purchase quantities.
    await sql`
      CREATE OR REPLACE FUNCTION set_product_revision_and_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'product_variants' THEN
          IF ROW(NEW.id, NEW.product_id, NEW.sku_code, NEW.combination_key, NEW.sale_price,
                 NEW.compare_at_price, NEW.cost_price, NEW.enabled, NEW.retired_at,
                 NEW.inventory_mode, NEW.purchase_limit_per_order, NEW.purchase_limit_lifetime,
                 NEW.purchase_limit_24h)
              IS NOT DISTINCT FROM
              ROW(OLD.id, OLD.product_id, OLD.sku_code, OLD.combination_key, OLD.sale_price,
                  OLD.compare_at_price, OLD.cost_price, OLD.enabled, OLD.retired_at,
                  OLD.inventory_mode, OLD.purchase_limit_per_order, OLD.purchase_limit_lifetime,
                  OLD.purchase_limit_24h) THEN
            NEW.revision := OLD.revision;
            NEW.updated_at := OLD.updated_at;
          ELSE
            NEW.revision := OLD.revision + 1;
            NEW.updated_at := now();
          END IF;
        ELSE
          NEW.revision := OLD.revision + 1;
          NEW.updated_at := now();
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION touch_product_variant_catalog_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE products AS product SET revision = product.revision + 1
        WHERE product.id IN (
          SELECT new_row.product_id
          FROM new_rows AS new_row
          JOIN old_rows AS old_row ON old_row.id = new_row.id
          WHERE ROW(new_row.id, new_row.product_id, new_row.sku_code, new_row.combination_key,
                    new_row.sale_price, new_row.compare_at_price, new_row.cost_price,
                    new_row.enabled, new_row.retired_at, new_row.inventory_mode,
                    new_row.purchase_limit_per_order, new_row.purchase_limit_lifetime,
                    new_row.purchase_limit_24h)
              IS DISTINCT FROM
                ROW(old_row.id, old_row.product_id, old_row.sku_code, old_row.combination_key,
                    old_row.sale_price, old_row.compare_at_price, old_row.cost_price,
                    old_row.enabled, old_row.retired_at, old_row.inventory_mode,
                    old_row.purchase_limit_per_order, old_row.purchase_limit_lifetime,
                    old_row.purchase_limit_24h)
        ) AND NOT (product.revision = 1 AND product.created_at = transaction_timestamp());
        RETURN NULL;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE FUNCTION protect_purchase_limit_catalog_state() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'products' THEN
          IF OLD.status = 'archived' AND ROW(NEW.purchase_limit_per_order,
              NEW.purchase_limit_lifetime, NEW.purchase_limit_24h)
              IS DISTINCT FROM ROW(OLD.purchase_limit_per_order,
              OLD.purchase_limit_lifetime, OLD.purchase_limit_24h) THEN
            RAISE EXCEPTION 'Purchase limits on an archived product cannot be changed'
              USING ERRCODE = '23514', CONSTRAINT = 'purchase_limit_product_archived';
          END IF;
        ELSE
          IF OLD.retired_at IS NOT NULL AND ROW(NEW.purchase_limit_per_order,
              NEW.purchase_limit_lifetime, NEW.purchase_limit_24h)
              IS DISTINCT FROM ROW(OLD.purchase_limit_per_order,
              OLD.purchase_limit_lifetime, OLD.purchase_limit_24h) THEN
            RAISE EXCEPTION 'Purchase limits on a retired SKU cannot be changed'
              USING ERRCODE = '23514', CONSTRAINT = 'purchase_limit_variant_retired';
          END IF;
          IF ROW(NEW.purchase_limit_per_order, NEW.purchase_limit_lifetime, NEW.purchase_limit_24h)
              IS DISTINCT FROM ROW(OLD.purchase_limit_per_order, OLD.purchase_limit_lifetime, OLD.purchase_limit_24h)
             AND EXISTS (SELECT 1 FROM products AS product
                         WHERE product.id = NEW.product_id AND product.status = 'archived') THEN
            RAISE EXCEPTION 'Purchase limits on an archived product cannot be changed'
              USING ERRCODE = '23514', CONSTRAINT = 'purchase_limit_product_archived';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER products_purchase_limit_state_guard
      BEFORE UPDATE OF purchase_limit_per_order, purchase_limit_lifetime, purchase_limit_24h ON products
      FOR EACH ROW EXECUTE FUNCTION protect_purchase_limit_catalog_state()
    `.execute(db)
    await sql`
      CREATE TRIGGER product_variants_purchase_limit_state_guard
      BEFORE UPDATE OF purchase_limit_per_order, purchase_limit_lifetime, purchase_limit_24h ON product_variants
      FOR EACH ROW EXECUTE FUNCTION protect_purchase_limit_catalog_state()
    `.execute(db)

    // One authoritative rule describes when a prior order consumes quota.
    // EXISTS predicates avoid multiplying item quantities by payment receipts.
    await sql`
      CREATE FUNCTION order_counts_as_purchase(order_uuid uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$
        SELECT COALESCE((
          SELECT order_row.status IN ('pending_payment', 'processing', 'completed')
            OR EXISTS (
              SELECT 1 FROM order_status_events AS event
              WHERE event.order_id = order_row.id AND event.next_status IN ('processing', 'completed')
            )
            OR EXISTS (
              SELECT 1 FROM payment_attempts AS attempt
              WHERE attempt.order_id = order_row.id
                AND attempt.status IN ('created', 'pending', 'succeeded', 'late_succeeded', 'reconciliation_required')
            )
            OR EXISTS (
              SELECT 1 FROM payment_receipts AS receipt
              JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
              WHERE attempt.order_id = order_row.id
            )
            OR EXISTS (
              SELECT 1 FROM wallet_operations AS hold
              WHERE hold.order_id = order_row.id AND hold.operation_type = 'order_payment_hold'
                AND NOT EXISTS (
                  SELECT 1 FROM wallet_operations AS resolution
                  WHERE resolution.resolves_operation_id = hold.id
                    AND resolution.operation_type IN ('order_payment_settlement', 'order_payment_release')
                )
            )
            OR EXISTS (
              SELECT 1 FROM order_refunds AS refund
              WHERE refund.order_id = order_row.id
                AND refund.status IN ('requested', 'approved', 'processing', 'partially_succeeded')
            )
            OR EXISTS (
              SELECT 1 FROM order_items AS item
              WHERE item.order_id = order_row.id AND item.fulfilled_quantity > 0
            )
            OR EXISTS (
              SELECT 1 FROM order_item_fulfillment_attempts AS fulfillment
              JOIN order_items AS item ON item.id = fulfillment.order_item_id
              WHERE item.order_id = order_row.id
                AND fulfillment.status IN ('processing', 'unknown', 'succeeded')
            )
            OR EXISTS (
              SELECT 1 FROM order_item_fulfillment_deliveries AS delivery
              JOIN order_item_fulfillment_attempts AS fulfillment
                ON fulfillment.id = delivery.fulfillment_attempt_id
              JOIN order_items AS item ON item.id = fulfillment.order_item_id
              WHERE item.order_id = order_row.id
            )
          FROM orders AS order_row WHERE order_row.id = order_uuid
        ), false)
      $$
    `.execute(db)

    await sql`
      CREATE FUNCTION prior_purchase_quantity(
        customer_uuid uuid,
        product_uuid uuid,
        variant_uuid uuid,
        window_start timestamptz,
        excluded_order_uuid uuid
      ) RETURNS numeric
      LANGUAGE sql STABLE AS $$
        SELECT COALESCE(sum(item.quantity::numeric), 0)
        FROM order_items AS item
        JOIN orders AS order_row ON order_row.id = item.order_id
        WHERE order_row.customer_id = customer_uuid
          AND (excluded_order_uuid IS NULL OR order_row.id <> excluded_order_uuid)
          AND item.product_id = product_uuid
          AND (variant_uuid IS NULL OR item.product_variant_id = variant_uuid)
          AND (window_start IS NULL OR order_row.created_at > window_start)
          AND order_counts_as_purchase(order_row.id)
      $$
    `.execute(db)

    // The customer fence is acquired by the API before its session SHARE lock.
    // This database trigger also serializes trusted SQL order creation and
    // causes a stale REPEATABLE READ writer to fail with 40001 after waiting.
    await sql`
      CREATE FUNCTION lock_customer_for_purchase_order() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        NEW.created_at := clock_timestamp();
        IF NEW.customer_id IS NOT NULL THEN
          UPDATE customers
          SET purchase_limit_lock_version = purchase_limit_lock_version + 1
          WHERE id = NEW.customer_id AND status = 'active';
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Only active customer accounts can create orders'
              USING ERRCODE = '23514', CONSTRAINT = 'orders_customer_must_be_active';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER orders_purchase_limits_owner_lock
      BEFORE INSERT ON orders
      FOR EACH ROW EXECUTE FUNCTION lock_customer_for_purchase_order()
    `.execute(db)

    // Direct order item writes use the same product -> SKU order as catalog
    // snapshot validation. Stable line ordering prevents multi-product direct
    // transactions from acquiring shared catalog locks in opposite orders.
    await sql`
      CREATE FUNCTION lock_purchase_limit_catalog_for_order_item() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        last_product_id uuid;
        last_variant_id uuid;
      BEGIN
        SELECT item.product_id, item.product_variant_id
          INTO last_product_id, last_variant_id
        FROM order_items AS item WHERE item.order_id = NEW.order_id
        ORDER BY item.product_id DESC, item.product_variant_id DESC LIMIT 1;
        IF FOUND AND ROW(NEW.product_id, NEW.product_variant_id) < ROW(last_product_id, last_variant_id) THEN
          RAISE EXCEPTION 'Order items must be inserted in product and SKU identity order'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_purchase_lock_order';
        END IF;

        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER order_items_purchase_limits_lock
      BEFORE INSERT ON order_items
      FOR EACH ROW EXECUTE FUNCTION lock_purchase_limit_catalog_for_order_item()
    `.execute(db)

    await sql`
      CREATE FUNCTION enforce_order_purchase_limits() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        item_row record;
        product_limits record;
        variant_limits record;
        prior_lifetime numeric;
        prior_recent numeric;
        product_quantity bigint;
      BEGIN
        IF NOT NEW.items_sealed OR OLD.items_sealed THEN RETURN NEW; END IF;
        IF NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = NEW.id) THEN
          RAISE EXCEPTION 'An order must contain items before it is sealed'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_items_required';
        END IF;

        FOR item_row IN
          SELECT item.product_id, sum(item.quantity)::bigint AS quantity
          FROM order_items AS item WHERE item.order_id = NEW.id
          GROUP BY item.product_id ORDER BY item.product_id
        LOOP
          SELECT product.purchase_limit_per_order, product.purchase_limit_lifetime,
                 product.purchase_limit_24h
            INTO product_limits FROM products AS product WHERE product.id = item_row.product_id;
          product_quantity := item_row.quantity;

          IF product_limits.purchase_limit_per_order IS NOT NULL
             AND product_quantity > product_limits.purchase_limit_per_order THEN
            RAISE EXCEPTION 'The product per-order purchase limit was exceeded'
              USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_limit_exceeded';
          END IF;
          IF NEW.customer_id IS NULL AND (product_limits.purchase_limit_lifetime IS NOT NULL
             OR product_limits.purchase_limit_24h IS NOT NULL) THEN
            RAISE EXCEPTION 'An account is required for this product purchase limit'
              USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_limit_login_required';
          END IF;
          IF NEW.customer_id IS NOT NULL AND product_limits.purchase_limit_lifetime IS NOT NULL THEN
            prior_lifetime := prior_purchase_quantity(NEW.customer_id, item_row.product_id, NULL, NULL, NEW.id);
            IF prior_lifetime + product_quantity > product_limits.purchase_limit_lifetime THEN
              RAISE EXCEPTION 'The product lifetime purchase limit was exceeded'
                USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_limit_exceeded';
            END IF;
          END IF;
          IF NEW.customer_id IS NOT NULL AND product_limits.purchase_limit_24h IS NOT NULL THEN
            prior_recent := prior_purchase_quantity(NEW.customer_id, item_row.product_id, NULL,
              NEW.created_at - interval '24 hours', NEW.id);
            IF prior_recent + product_quantity > product_limits.purchase_limit_24h THEN
              RAISE EXCEPTION 'The product rolling 24-hour purchase limit was exceeded'
                USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_limit_exceeded';
            END IF;
          END IF;
        END LOOP;

        FOR item_row IN
          SELECT item.product_id, item.product_variant_id, item.quantity
          FROM order_items AS item WHERE item.order_id = NEW.id
          ORDER BY item.product_id, item.product_variant_id
        LOOP
          SELECT variant.purchase_limit_per_order, variant.purchase_limit_lifetime,
                 variant.purchase_limit_24h
            INTO variant_limits FROM product_variants AS variant
          WHERE variant.product_id = item_row.product_id AND variant.id = item_row.product_variant_id;

          IF variant_limits.purchase_limit_per_order IS NOT NULL
             AND item_row.quantity > variant_limits.purchase_limit_per_order THEN
            RAISE EXCEPTION 'The SKU per-order purchase limit was exceeded'
              USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_limit_exceeded';
          END IF;
          IF NEW.customer_id IS NULL AND (variant_limits.purchase_limit_lifetime IS NOT NULL
             OR variant_limits.purchase_limit_24h IS NOT NULL) THEN
            RAISE EXCEPTION 'An account is required for this SKU purchase limit'
              USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_limit_login_required';
          END IF;
          IF NEW.customer_id IS NOT NULL AND variant_limits.purchase_limit_lifetime IS NOT NULL THEN
            prior_lifetime := prior_purchase_quantity(NEW.customer_id, item_row.product_id,
              item_row.product_variant_id, NULL, NEW.id);
            IF prior_lifetime + item_row.quantity > variant_limits.purchase_limit_lifetime THEN
              RAISE EXCEPTION 'The SKU lifetime purchase limit was exceeded'
                USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_limit_exceeded';
            END IF;
          END IF;
          IF NEW.customer_id IS NOT NULL AND variant_limits.purchase_limit_24h IS NOT NULL THEN
            prior_recent := prior_purchase_quantity(NEW.customer_id, item_row.product_id,
              item_row.product_variant_id, NEW.created_at - interval '24 hours', NEW.id);
            IF prior_recent + item_row.quantity > variant_limits.purchase_limit_24h THEN
              RAISE EXCEPTION 'The SKU rolling 24-hour purchase limit was exceeded'
                USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_limit_exceeded';
            END IF;
          END IF;
        END LOOP;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER orders_purchase_limits_seal_check
      BEFORE UPDATE OF items_sealed ON orders
      FOR EACH ROW EXECUTE FUNCTION enforce_order_purchase_limits()
    `.execute(db)

    // The query starts with a customer's order history, then visits each
    // matching order's lines. Existing (order_id, product_variant_id) uniqueness
    // supplies the order_items lookup; this index also covers product grouping.
    await sql`
      CREATE INDEX orders_customer_created_purchase_idx
        ON orders (customer_id, created_at DESC, id)
        WHERE customer_id IS NOT NULL
    `.execute(db)
    await sql`
      CREATE INDEX order_items_order_product_purchase_idx
        ON order_items (order_id, product_id, product_variant_id) INCLUDE (quantity)
    `.execute(db)
    await sql`
      CREATE INDEX payment_attempts_order_purchase_idx
        ON payment_attempts (order_id, status)
        WHERE order_id IS NOT NULL
          AND status IN ('created', 'pending', 'succeeded', 'late_succeeded', 'reconciliation_required')
    `.execute(db)
    await sql`
      CREATE INDEX order_status_events_purchase_idx
        ON order_status_events (order_id)
        WHERE next_status IN ('processing', 'completed')
    `.execute(db)
  },

  async down(db) {
    await sql`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM products WHERE purchase_limit_per_order IS NOT NULL
          OR purchase_limit_lifetime IS NOT NULL OR purchase_limit_24h IS NOT NULL)
          OR EXISTS (SELECT 1 FROM product_variants WHERE purchase_limit_per_order IS NOT NULL
          OR purchase_limit_lifetime IS NOT NULL OR purchase_limit_24h IS NOT NULL) THEN
          RAISE EXCEPTION 'Cannot remove configured purchase limits'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_limit_configuration_present';
        END IF;
      END;
      $$
    `.execute(db)

    await sql`DROP INDEX order_status_events_purchase_idx`.execute(db)
    await sql`DROP INDEX payment_attempts_order_purchase_idx`.execute(db)
    await sql`DROP INDEX order_items_order_product_purchase_idx`.execute(db)
    await sql`DROP INDEX orders_customer_created_purchase_idx`.execute(db)
    await sql`DROP TRIGGER orders_purchase_limits_seal_check ON orders`.execute(db)
    await sql`DROP FUNCTION enforce_order_purchase_limits()`.execute(db)
    await sql`DROP TRIGGER order_items_purchase_limits_lock ON order_items`.execute(db)
    await sql`DROP FUNCTION lock_purchase_limit_catalog_for_order_item()`.execute(db)
    await sql`DROP TRIGGER orders_purchase_limits_owner_lock ON orders`.execute(db)
    await sql`DROP FUNCTION lock_customer_for_purchase_order()`.execute(db)
    await sql`DROP FUNCTION prior_purchase_quantity(uuid, uuid, uuid, timestamptz, uuid)`.execute(db)
    await sql`DROP FUNCTION order_counts_as_purchase(uuid)`.execute(db)
    await sql`DROP TRIGGER product_variants_purchase_limit_state_guard ON product_variants`.execute(db)
    await sql`DROP TRIGGER products_purchase_limit_state_guard ON products`.execute(db)
    await sql`DROP FUNCTION protect_purchase_limit_catalog_state()`.execute(db)
    // Restore the catalog revision functions from the pre-limit schema before
    // removing the columns referenced by the replacement implementations.
    await sql`
      CREATE OR REPLACE FUNCTION set_product_revision_and_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'product_variants' THEN
          IF ROW(NEW.id, NEW.product_id, NEW.sku_code, NEW.combination_key, NEW.sale_price,
                 NEW.compare_at_price, NEW.cost_price, NEW.enabled, NEW.retired_at, NEW.inventory_mode)
              IS NOT DISTINCT FROM
              ROW(OLD.id, OLD.product_id, OLD.sku_code, OLD.combination_key, OLD.sale_price,
                  OLD.compare_at_price, OLD.cost_price, OLD.enabled, OLD.retired_at, OLD.inventory_mode) THEN
            NEW.revision := OLD.revision;
            NEW.updated_at := OLD.updated_at;
          ELSE
            NEW.revision := OLD.revision + 1;
            NEW.updated_at := now();
          END IF;
        ELSE
          NEW.revision := OLD.revision + 1;
          NEW.updated_at := now();
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION touch_product_variant_catalog_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE products AS product SET revision = product.revision + 1
        WHERE product.id IN (
          SELECT new_row.product_id
          FROM new_rows AS new_row
          JOIN old_rows AS old_row ON old_row.id = new_row.id
          WHERE ROW(new_row.id, new_row.product_id, new_row.sku_code, new_row.combination_key,
                    new_row.sale_price, new_row.compare_at_price, new_row.cost_price,
                    new_row.enabled, new_row.retired_at, new_row.inventory_mode)
              IS DISTINCT FROM
                ROW(old_row.id, old_row.product_id, old_row.sku_code, old_row.combination_key,
                    old_row.sale_price, old_row.compare_at_price, old_row.cost_price,
                    old_row.enabled, old_row.retired_at, old_row.inventory_mode)
        ) AND NOT (product.revision = 1 AND product.created_at = transaction_timestamp());
        RETURN NULL;
      END;
      $$
    `.execute(db)
    await sql`
      ALTER TABLE product_variants
        DROP CONSTRAINT product_variants_purchase_limit_24h_check,
        DROP CONSTRAINT product_variants_purchase_limit_lifetime_check,
        DROP CONSTRAINT product_variants_purchase_limit_per_order_check,
        DROP COLUMN purchase_limit_24h,
        DROP COLUMN purchase_limit_lifetime,
        DROP COLUMN purchase_limit_per_order
    `.execute(db)
    await sql`
      ALTER TABLE products
        DROP CONSTRAINT products_purchase_limit_24h_check,
        DROP CONSTRAINT products_purchase_limit_lifetime_check,
        DROP CONSTRAINT products_purchase_limit_per_order_check,
        DROP COLUMN purchase_limit_24h,
        DROP COLUMN purchase_limit_lifetime,
        DROP COLUMN purchase_limit_per_order
    `.execute(db)
    await sql`
      ALTER TABLE customers
        DROP CONSTRAINT customers_purchase_limit_lock_version_check,
        DROP COLUMN purchase_limit_lock_version
    `.execute(db)
  },
}
