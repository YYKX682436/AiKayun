import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/**
 * ⑤-2 adds immutable, encrypted fixed-content versions to the existing SKU,
 * order-item, fulfillment-attempt, delivery and inventory-event model.
 */
export const fixedDeliveryMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE product_variant_fulfillment_versions (
        id uuid PRIMARY KEY,
        product_variant_id uuid NOT NULL,
        version_number integer NOT NULL,
        method varchar(24) NOT NULL,
        encrypted_content bytea NOT NULL,
        content_nonce bytea NOT NULL,
        content_auth_tag bytea NOT NULL,
        encryption_key_id varchar(48) NOT NULL,
        content_sha256 char(64) NOT NULL,
        created_by_admin_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT product_variant_fulfillment_versions_variant_fkey
          FOREIGN KEY (product_variant_id) REFERENCES product_variants (id) ON DELETE RESTRICT,
        CONSTRAINT product_variant_fulfillment_versions_admin_fkey
          FOREIGN KEY (created_by_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT product_variant_fulfillment_versions_version_check CHECK (version_number > 0),
        CONSTRAINT product_variant_fulfillment_versions_method_check CHECK (method IN ('fixed_content', 'link')),
        CONSTRAINT product_variant_fulfillment_versions_ciphertext_check
          CHECK (octet_length(encrypted_content) BETWEEN 1 AND 65536),
        CONSTRAINT product_variant_fulfillment_versions_nonce_check CHECK (octet_length(content_nonce) = 12),
        CONSTRAINT product_variant_fulfillment_versions_tag_check CHECK (octet_length(content_auth_tag) = 16),
        CONSTRAINT product_variant_fulfillment_versions_key_check
          CHECK (encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'),
        CONSTRAINT product_variant_fulfillment_versions_hash_check CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT product_variant_fulfillment_versions_sku_version_unique UNIQUE (product_variant_id, version_number),
        CONSTRAINT product_variant_fulfillment_versions_id_sku_method_unique UNIQUE (id, product_variant_id, method)
      )
    `.execute(db)
    await sql`CREATE INDEX product_variant_fulfillment_versions_history_idx
      ON product_variant_fulfillment_versions (product_variant_id, version_number DESC)`.execute(db)

    await sql`
      ALTER TABLE product_variant_fulfillment
        ADD COLUMN automatic_delivery_ready boolean NOT NULL DEFAULT false,
        ADD COLUMN current_content_version_id uuid,
        ADD COLUMN configuration_revision integer NOT NULL DEFAULT 0,
        ADD CONSTRAINT product_variant_fulfillment_revision_check CHECK (configuration_revision >= 0),
        ADD CONSTRAINT product_variant_fulfillment_content_version_shape_check CHECK (
          (method IN ('fixed_content', 'link') AND current_content_version_id IS NOT NULL)
          OR (method NOT IN ('fixed_content', 'link') AND current_content_version_id IS NULL)
        ),
        ADD CONSTRAINT product_variant_fulfillment_readiness_shape_check CHECK (
          (NOT manual_delivery_ready OR method = 'manual')
          AND (NOT code_pool_delivery_ready OR method = 'code_pool')
          AND (NOT automatic_delivery_ready OR method IN ('fixed_content', 'link'))
        ),
        ADD CONSTRAINT product_variant_fulfillment_current_version_fkey
          FOREIGN KEY (current_content_version_id, product_variant_id, method)
          REFERENCES product_variant_fulfillment_versions (id, product_variant_id, method) ON DELETE RESTRICT
    `.execute(db)

    await sql`
      ALTER TABLE order_items
        ADD COLUMN fulfillment_content_version_id uuid,
        ADD CONSTRAINT order_items_fulfillment_version_shape_check CHECK (
          (fulfillment_method_snapshot IN ('fixed_content', 'link') AND fulfillment_content_version_id IS NOT NULL)
          OR (fulfillment_method_snapshot NOT IN ('fixed_content', 'link') AND fulfillment_content_version_id IS NULL)
        ),
        ADD CONSTRAINT order_items_fulfillment_version_fkey
          FOREIGN KEY (fulfillment_content_version_id, product_variant_id, fulfillment_method_snapshot)
          REFERENCES product_variant_fulfillment_versions (id, product_variant_id, method) ON DELETE RESTRICT
    `.execute(db)
    await sql`CREATE INDEX order_items_fulfillment_version_idx
      ON order_items (fulfillment_content_version_id) WHERE fulfillment_content_version_id IS NOT NULL`.execute(db)

    await sql`
      ALTER TABLE order_item_fulfillment_attempts
        DROP CONSTRAINT order_item_fulfillment_attempts_source_check,
        DROP CONSTRAINT order_item_fulfillment_attempts_failure_check,
        ADD CONSTRAINT order_item_fulfillment_attempts_source_check
          CHECK (delivery_source IN ('manual', 'code_pool', 'fixed_content', 'link')),
        ADD CONSTRAINT order_item_fulfillment_attempts_failure_check CHECK (
          (failure_code IS NULL AND retry_after IS NULL)
          OR (
            delivery_source IN ('code_pool', 'fixed_content', 'link') AND status = 'failed'
            AND failure_code IS NOT NULL AND retry_after IS NOT NULL
            AND (
              (delivery_source = 'code_pool' AND failure_code IN (
                'CODE_POOL_DATA_INCONSISTENT', 'CODE_POOL_KEY_UNAVAILABLE',
                'CODE_POOL_DECRYPTION_FAILED', 'CODE_POOL_PAYMENT_UNRESOLVED'
              ))
              OR (delivery_source IN ('fixed_content', 'link') AND failure_code IN (
                'FIXED_DELIVERY_DATA_INCONSISTENT', 'FIXED_DELIVERY_KEY_UNAVAILABLE',
                'FIXED_DELIVERY_DECRYPTION_FAILED', 'FIXED_DELIVERY_VERSION_UNAVAILABLE',
                'FIXED_DELIVERY_PAYMENT_UNRESOLVED'
              ))
            )
          )
        )
    `.execute(db)

    await sql`
      ALTER TABLE order_item_fulfillment_deliveries
        ADD COLUMN fulfillment_content_version_id uuid,
        ADD CONSTRAINT order_item_fulfillment_deliveries_version_fkey
          FOREIGN KEY (fulfillment_content_version_id) REFERENCES product_variant_fulfillment_versions (id) ON DELETE RESTRICT,
        DROP CONSTRAINT order_item_fulfillment_deliveries_source_check,
        DROP CONSTRAINT order_item_fulfillment_deliveries_content_check,
        ADD CONSTRAINT order_item_fulfillment_deliveries_source_check
          CHECK (delivery_source IN ('manual', 'code_pool', 'fixed_content', 'link')),
        ADD CONSTRAINT order_item_fulfillment_deliveries_content_check CHECK (
          (delivery_source = 'manual' AND started_by_admin_id IS NOT NULL
            AND content IS NOT NULL AND char_length(content) BETWEEN 1 AND 512 AND btrim(content) <> ''
            AND encrypted_content IS NULL AND content_nonce IS NULL AND content_auth_tag IS NULL
            AND encryption_key_id IS NULL AND code_pool_entry_id IS NULL AND fulfillment_content_version_id IS NULL)
          OR (delivery_source = 'code_pool' AND started_by_admin_id IS NULL AND content IS NULL
            AND encrypted_content IS NOT NULL AND content_nonce IS NOT NULL AND octet_length(content_nonce) = 12
            AND content_auth_tag IS NOT NULL AND octet_length(content_auth_tag) = 16
            AND encryption_key_id IS NOT NULL AND encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND code_pool_entry_id IS NOT NULL AND fulfillment_content_version_id IS NULL)
          OR (delivery_source IN ('fixed_content', 'link') AND started_by_admin_id IS NULL AND content IS NULL
            AND encrypted_content IS NOT NULL AND octet_length(encrypted_content) BETWEEN 1 AND 65536
            AND content_nonce IS NOT NULL AND octet_length(content_nonce) = 12
            AND content_auth_tag IS NOT NULL AND octet_length(content_auth_tag) = 16
            AND encryption_key_id IS NOT NULL AND encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND code_pool_entry_id IS NULL AND fulfillment_content_version_id IS NOT NULL)
        )
    `.execute(db)

    await sql`
      CREATE FUNCTION protect_fulfillment_content_version() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Digital fulfillment content versions are immutable history'
          USING ERRCODE = '23514', CONSTRAINT = 'fulfillment_content_version_immutable';
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER product_variant_fulfillment_versions_immutable
      BEFORE UPDATE OR DELETE ON product_variant_fulfillment_versions
      FOR EACH ROW EXECUTE FUNCTION protect_fulfillment_content_version()`.execute(db)
    await sql`CREATE TRIGGER product_variant_fulfillment_versions_prevent_truncate
      BEFORE TRUNCATE ON product_variant_fulfillment_versions
      FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      CREATE FUNCTION bump_fulfillment_configuration_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.method, NEW.manual_delivery_ready, NEW.code_pool_delivery_ready,
               NEW.automatic_delivery_ready, NEW.current_content_version_id)
          IS DISTINCT FROM ROW(OLD.method, OLD.manual_delivery_ready, OLD.code_pool_delivery_ready,
               OLD.automatic_delivery_ready, OLD.current_content_version_id) THEN
          NEW.configuration_revision := OLD.configuration_revision + 1;
          NEW.updated_at := clock_timestamp();
        ELSIF NEW.configuration_revision IS DISTINCT FROM OLD.configuration_revision THEN
          RAISE EXCEPTION 'Fulfillment configuration revision is database controlled'
            USING ERRCODE = '23514', CONSTRAINT = 'fulfillment_configuration_revision_guard';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER product_variant_fulfillment_revision_guard
      BEFORE UPDATE ON product_variant_fulfillment
      FOR EACH ROW EXECUTE FUNCTION bump_fulfillment_configuration_revision()`.execute(db)

    await sql`
      CREATE FUNCTION guard_fixed_delivery_config() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE sku product_variants%ROWTYPE; product_type varchar(16);
      BEGIN
        IF NEW.method IN ('fixed_content', 'link') THEN
          SELECT * INTO sku FROM product_variants WHERE id = NEW.product_variant_id;
          SELECT product.product_type INTO product_type FROM products AS product WHERE product.id = sku.product_id;
          IF product_type IS DISTINCT FROM 'digital' OR sku.inventory_mode IS NULL
            OR sku.inventory_mode NOT IN ('quantity', 'unlimited') THEN
            RAISE EXCEPTION 'Fixed digital delivery requires a digital SKU with quantity or unlimited inventory'
              USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_sku_not_supported';
          END IF;
          IF NEW.automatic_delivery_ready AND (NOT sku.enabled OR sku.retired_at IS NOT NULL
            OR NEW.current_content_version_id IS NULL) THEN
            RAISE EXCEPTION 'Automatic delivery requires a saved version and a sellable SKU'
              USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_readiness_invalid';
          END IF;
        ELSIF NEW.automatic_delivery_ready OR NEW.current_content_version_id IS NOT NULL THEN
          RAISE EXCEPTION 'Only fixed-content and link methods can reference automatic delivery versions'
            USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_method_shape_invalid';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER product_variant_fulfillment_fixed_delivery_guard
      BEFORE INSERT OR UPDATE ON product_variant_fulfillment
      FOR EACH ROW EXECUTE FUNCTION guard_fixed_delivery_config()`.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION validate_order_manual_fulfillment_readiness() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        product_type varchar(16); configured_method varchar(24); manual_ready boolean;
        code_pool_ready boolean; automatic_ready boolean; current_version uuid;
        inventory_mode varchar(16);
      BEGIN
        SELECT product.product_type, variant.inventory_mode, fulfillment.method,
          fulfillment.manual_delivery_ready, fulfillment.code_pool_delivery_ready,
          fulfillment.automatic_delivery_ready, fulfillment.current_content_version_id
          INTO product_type, inventory_mode, configured_method, manual_ready,
            code_pool_ready, automatic_ready, current_version
        FROM products AS product
        JOIN product_variants AS variant ON variant.product_id = product.id
        LEFT JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
        WHERE product.id = NEW.product_id AND variant.id = NEW.product_variant_id;
        IF product_type IS DISTINCT FROM 'digital' OR configured_method IS NULL
          OR NEW.fulfillment_method_snapshot IS DISTINCT FROM configured_method
          OR (configured_method = 'manual' AND manual_ready IS DISTINCT FROM true)
          OR (configured_method = 'code_pool' AND (code_pool_ready IS DISTINCT FROM true OR inventory_mode IS DISTINCT FROM 'quantity'))
          OR (configured_method IN ('fixed_content', 'link') AND (automatic_ready IS DISTINCT FROM true
            OR current_version IS DISTINCT FROM NEW.fulfillment_content_version_id))
          OR (configured_method NOT IN ('manual', 'code_pool', 'fixed_content', 'link')
            OR (configured_method NOT IN ('fixed_content', 'link') AND NEW.fulfillment_content_version_id IS NOT NULL)) THEN
          RAISE EXCEPTION 'Only explicitly ready manual, code-pool, fixed-content or link digital SKUs can be ordered'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_digital_fulfillment_not_ready';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION validate_order_item_snapshot() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        order_state varchar(24); order_items_sealed boolean;
        product_name varchar(200); product_type varchar(16); product_status varchar(16);
        sku_code varchar(64); sale_price numeric(18, 5); inventory_mode varchar(16);
        sku_enabled boolean; sku_retired_at timestamptz; fulfillment_method varchar(24);
        option_snapshot jsonb;
      BEGIN
        SELECT status, items_sealed INTO order_state, order_items_sealed
        FROM orders WHERE id = NEW.order_id FOR UPDATE;
        IF NOT FOUND OR order_state NOT IN ('pending_payment', 'processing') OR order_items_sealed THEN
          RAISE EXCEPTION 'Order items can only be added before the creation transaction seals them'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_order_open_check';
        END IF;
        IF NEW.fulfillment_status <> 'pending' OR NEW.fulfilled_quantity <> 0
          OR NEW.fulfillment_reserved_quantity <> 0 THEN
          RAISE EXCEPTION 'Order item fulfillment must begin with no delivered or reserved quantity'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_initial_fulfillment_state';
        END IF;
        PERFORM id FROM products WHERE id = NEW.product_id FOR SHARE;
        SELECT product.name, product.product_type, product.status
          INTO product_name, product_type, product_status
        FROM products AS product WHERE product.id = NEW.product_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Order item product does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'order_items_product_fkey';
        END IF;
        SELECT variant.sku_code, variant.sale_price, variant.inventory_mode, variant.enabled, variant.retired_at
          INTO sku_code, sale_price, inventory_mode, sku_enabled, sku_retired_at
        FROM product_variants AS variant
        WHERE variant.product_id = NEW.product_id AND variant.id = NEW.product_variant_id FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Order item SKU does not belong to its product'
            USING ERRCODE = '23503', CONSTRAINT = 'order_items_variant_fkey';
        END IF;
        SELECT method INTO fulfillment_method FROM product_variant_fulfillment
        WHERE product_variant_id = NEW.product_variant_id FOR SHARE;
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'groupId', option_group.id, 'groupName', option_group.name,
          'valueId', option_value.id, 'valueName', option_value.name
        ) ORDER BY option_group.sort_order, option_value.sort_order, option_group.id, option_value.id), '[]'::jsonb)
        INTO option_snapshot
        FROM product_variant_option_values AS selected
        JOIN product_option_groups AS option_group
          ON option_group.product_id = selected.product_id AND option_group.id = selected.option_group_id
        JOIN product_option_values AS option_value
          ON option_value.product_id = selected.product_id AND option_value.option_group_id = selected.option_group_id
            AND option_value.id = selected.option_value_id
        WHERE selected.product_id = NEW.product_id AND selected.product_variant_id = NEW.product_variant_id;
        IF product_status <> 'active' OR NOT sku_enabled OR sku_retired_at IS NOT NULL THEN
          RAISE EXCEPTION 'Only active products and enabled, non-retired SKUs can be ordered'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_sale_state_check';
        END IF;
        IF inventory_mode IS NULL OR inventory_mode NOT IN ('quantity', 'unlimited') OR fulfillment_method IS NULL THEN
          RAISE EXCEPTION 'The SKU does not have a ready inventory and fulfillment configuration'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_sale_readiness_check';
        END IF;
        IF NEW.product_name_snapshot <> product_name OR NEW.product_type_snapshot <> product_type
          OR NEW.sku_code_snapshot <> sku_code OR NEW.sku_snapshot <> option_snapshot
          OR NEW.inventory_mode_snapshot <> inventory_mode
          OR NEW.fulfillment_method_snapshot <> fulfillment_method
          OR NEW.unit_price <> sale_price::numeric(18, 2) THEN
          RAISE EXCEPTION 'Order item snapshots must match the locked catalog state'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_snapshot_consistency';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION protect_order_item_snapshot() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Order items are permanent transaction records'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_immutable';
        END IF;
        IF ROW(NEW.id, NEW.order_id, NEW.product_id, NEW.product_variant_id,
               NEW.product_name_snapshot, NEW.product_type_snapshot, NEW.sku_code_snapshot,
               NEW.sku_snapshot, NEW.inventory_mode_snapshot, NEW.fulfillment_method_snapshot,
               NEW.fulfillment_content_version_id, NEW.unit_price, NEW.quantity, NEW.line_amount, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.order_id, OLD.product_id, OLD.product_variant_id,
               OLD.product_name_snapshot, OLD.product_type_snapshot, OLD.sku_code_snapshot,
               OLD.sku_snapshot, OLD.inventory_mode_snapshot, OLD.fulfillment_method_snapshot,
               OLD.fulfillment_content_version_id, OLD.unit_price, OLD.quantity, OLD.line_amount, OLD.created_at) THEN
          RAISE EXCEPTION 'Order item identity and purchase snapshots are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_snapshot_immutable';
        END IF;
        IF ROW(NEW.fulfilled_quantity, NEW.fulfillment_reserved_quantity, NEW.fulfillment_status)
          IS DISTINCT FROM ROW(OLD.fulfilled_quantity, OLD.fulfillment_reserved_quantity, OLD.fulfillment_status)
          AND pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'Fulfillment summary can only be changed by fulfillment records'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_fulfillment_requires_record';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION guard_code_pool_fulfillment_attempt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE method_name varchar(24); delivery_count bigint; parent_status varchar(24);
        order_total numeric(18,2); parent_order uuid; version_id uuid;
      BEGIN
        SELECT fulfillment_method_snapshot, fulfillment_content_version_id
          INTO method_name, version_id FROM order_items WHERE id = NEW.order_item_id;
        IF TG_OP = 'INSERT' THEN
          IF NEW.delivery_source IS DISTINCT FROM method_name
            OR (NEW.delivery_source = 'manual' AND NEW.started_by_admin_id IS NULL)
            OR (NEW.delivery_source IN ('code_pool', 'fixed_content', 'link') AND NEW.started_by_admin_id IS NOT NULL) THEN
            RAISE EXCEPTION 'Fulfillment attempt source does not match the order item method'
              USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_source_mismatch';
          END IF;
          RETURN NEW;
        END IF;
        IF ROW(NEW.order_item_id, NEW.operation_id, NEW.quantity, NEW.started_by_admin_id, NEW.delivery_source)
          IS DISTINCT FROM ROW(OLD.order_item_id, OLD.operation_id, OLD.quantity, OLD.started_by_admin_id, OLD.delivery_source) THEN
          RAISE EXCEPTION 'Fulfillment attempt identity and source are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_attempts_identity_immutable';
        END IF;
        IF NEW.status = 'succeeded' AND OLD.status IS DISTINCT FROM NEW.status
          AND NEW.delivery_source IN ('code_pool', 'fixed_content', 'link') THEN
          SELECT order_row.status, order_row.total_amount, order_row.id
            INTO parent_status, order_total, parent_order
          FROM orders AS order_row JOIN order_items AS item ON item.order_id = order_row.id
          WHERE item.id = NEW.order_item_id;
          IF parent_status IS DISTINCT FROM 'processing'
            OR order_has_unresolved_payment_attempts(parent_order)
            OR EXISTS (
              SELECT 1 FROM payment_attempts AS payment_attempt
              JOIN payment_provider_reconciliation_cases AS reconciliation
                ON reconciliation.payment_attempt_id = payment_attempt.id
              WHERE payment_attempt.order_id = parent_order AND reconciliation.state = 'open'
            )
            OR (order_total > 0 AND COALESCE((
              SELECT sum(receipt.amount) FROM payment_attempts AS payment_attempt
              JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = payment_attempt.id
              WHERE payment_attempt.order_id = parent_order AND payment_attempt.status = 'succeeded'
                AND receipt.disposition = 'on_time'
            ), 0) <> order_total) THEN
            RAISE EXCEPTION 'Automatic delivery requires a processing order, confirmed payment and no open reconciliation'
              USING ERRCODE = '23514', CONSTRAINT = 'digital_delivery_payment_required';
          END IF;
          IF NEW.delivery_source = 'code_pool' THEN
            SELECT count(*) INTO delivery_count FROM order_item_fulfillment_deliveries AS delivery
            WHERE delivery.fulfillment_attempt_id = NEW.id AND delivery.delivery_source = 'code_pool'
              AND delivery.encrypted_content IS NOT NULL AND delivery.code_pool_entry_id IS NOT NULL
              AND delivery.fulfillment_content_version_id IS NULL;
            IF delivery_count <> NEW.quantity THEN
              RAISE EXCEPTION 'Code-pool success requires one encrypted private delivery per unit'
                USING ERRCODE = '23514', CONSTRAINT = 'code_pool_fulfillment_delivery_required';
            END IF;
          ELSE
            SELECT count(*) INTO delivery_count FROM order_item_fulfillment_deliveries AS delivery
            WHERE delivery.fulfillment_attempt_id = NEW.id AND delivery.delivery_source = NEW.delivery_source
              AND delivery.encrypted_content IS NOT NULL
              AND delivery.fulfillment_content_version_id IS NOT DISTINCT FROM version_id;
            IF version_id IS NULL OR delivery_count <> NEW.quantity THEN
              RAISE EXCEPTION 'Fixed-content delivery requires one encrypted private delivery per unit and its bound version'
                USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_records_required';
            END IF;
          END IF;
        END IF;
        IF NEW.failure_code IS NOT NULL AND (NEW.delivery_source NOT IN ('code_pool', 'fixed_content', 'link')
          OR NEW.status <> 'failed') THEN
          RAISE EXCEPTION 'Only failed automatic fulfillment attempts can record an automatic failure code'
            USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_failure_code_state';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION guard_code_pool_delivery_record() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE attempt_source varchar(16); item_method varchar(24); entry_state varchar(16);
        entry_item uuid; item_version uuid; attempt_item uuid;
      BEGIN
        SELECT attempt.delivery_source, item.fulfillment_method_snapshot,
          item.fulfillment_content_version_id, attempt.order_item_id
          INTO attempt_source, item_method, item_version, attempt_item
        FROM order_item_fulfillment_attempts AS attempt
        JOIN order_items AS item ON item.id = attempt.order_item_id
        WHERE attempt.id = NEW.fulfillment_attempt_id;
        IF NEW.delivery_source = 'manual' THEN
          IF attempt_source <> 'manual' OR item_method <> 'manual' THEN
            RAISE EXCEPTION 'Manual delivery source does not match its order item'
              USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_source_mismatch';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.delivery_source = 'code_pool' THEN
          SELECT state, order_item_id INTO entry_state, entry_item FROM code_pool_entries
          WHERE id = NEW.code_pool_entry_id FOR UPDATE;
          IF attempt_source <> 'code_pool' OR item_method <> 'code_pool' OR entry_state <> 'reserved'
            OR entry_item IS DISTINCT FROM attempt_item OR NEW.started_by_admin_id IS NOT NULL OR NEW.content IS NOT NULL THEN
            RAISE EXCEPTION 'Encrypted code-pool delivery must reference a reserved entry for its order item'
              USING ERRCODE = '23514', CONSTRAINT = 'code_pool_delivery_entry_mismatch';
          END IF;
          RETURN NEW;
        END IF;
        IF attempt_source IS DISTINCT FROM NEW.delivery_source OR item_method IS DISTINCT FROM NEW.delivery_source
          OR item_version IS DISTINCT FROM NEW.fulfillment_content_version_id
          OR NEW.started_by_admin_id IS NOT NULL OR NEW.content IS NOT NULL OR NEW.code_pool_entry_id IS NOT NULL THEN
          RAISE EXCEPTION 'Encrypted fixed delivery must match the order item method and bound content version'
            USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_version_mismatch';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`CREATE INDEX order_item_fulfillment_automatic_retry_idx
      ON order_item_fulfillment_attempts (retry_after, order_item_id)
      WHERE delivery_source IN ('code_pool', 'fixed_content', 'link') AND status = 'failed'`.execute(db)
  },

  async down() {
    throw new Error('Digital fulfillment versions and delivery history are immutable; this migration is forward-only.')
  },
}
