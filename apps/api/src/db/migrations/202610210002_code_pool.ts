import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/**
 * ⑤-1 adds encrypted, per-SKU code pools while preserving the original order,
 * reservation, inventory-event, fulfillment-attempt and delivery history.
 * Imports, withdrawals, reservations, releases and consumption all pass through
 * order_inventory_events; the event trigger is the only code-pool state writer.
 */
export const codePoolMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE product_variant_fulfillment
      ADD COLUMN code_pool_delivery_ready boolean NOT NULL DEFAULT false`.execute(db)

    await sql`
      CREATE TABLE code_pool_batches (
        id uuid PRIMARY KEY,
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        operation_id uuid NOT NULL,
        kind varchar(16) NOT NULL,
        request_sha256 char(64) NOT NULL,
        requested_count integer NOT NULL,
        accepted_count integer NOT NULL,
        duplicate_count integer NOT NULL DEFAULT 0,
        invalid_count integer NOT NULL DEFAULT 0,
        reason varchar(500),
        created_by_admin_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT code_pool_batches_variant_fkey
          FOREIGN KEY (product_id, product_variant_id)
          REFERENCES product_variants (product_id, id) ON DELETE RESTRICT,
        CONSTRAINT code_pool_batches_admin_fkey
          FOREIGN KEY (created_by_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT code_pool_batches_operation_unique UNIQUE (product_variant_id, operation_id),
        CONSTRAINT code_pool_batches_id_sku_unique UNIQUE (id, product_id, product_variant_id),
        CONSTRAINT code_pool_batches_kind_check CHECK (kind IN ('import', 'withdrawal')),
        CONSTRAINT code_pool_batches_hash_check CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT code_pool_batches_counts_check CHECK (
          requested_count >= 0 AND accepted_count >= 0 AND duplicate_count >= 0 AND invalid_count >= 0
          AND requested_count = accepted_count + duplicate_count + invalid_count
        ),
        CONSTRAINT code_pool_batches_reason_check CHECK (
          (kind = 'import' AND reason IS NULL)
          OR (kind = 'withdrawal' AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500
            AND requested_count = accepted_count AND accepted_count > 0 AND duplicate_count = 0 AND invalid_count = 0)
        )
      )
    `.execute(db)
    await sql`CREATE INDEX code_pool_batches_sku_created_idx
      ON code_pool_batches (product_variant_id, created_at DESC, id DESC)`.execute(db)

    await sql`
      CREATE TABLE code_pool_entries (
        id uuid PRIMARY KEY,
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        import_batch_id uuid NOT NULL,
        ciphertext bytea NOT NULL,
        nonce bytea NOT NULL,
        auth_tag bytea NOT NULL,
        encryption_key_id varchar(48) NOT NULL,
        content_fingerprint char(64) NOT NULL,
        fingerprint_key_id varchar(48) NOT NULL,
        state varchar(16) NOT NULL DEFAULT 'staged',
        order_item_id uuid,
        withdrawal_batch_id uuid,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        reserved_at timestamptz,
        delivered_at timestamptz,
        revoked_at timestamptz,
        CONSTRAINT code_pool_entries_import_batch_fkey
          FOREIGN KEY (import_batch_id, product_id, product_variant_id)
          REFERENCES code_pool_batches (id, product_id, product_variant_id) ON DELETE RESTRICT,
        CONSTRAINT code_pool_entries_withdrawal_batch_fkey
          FOREIGN KEY (withdrawal_batch_id, product_id, product_variant_id)
          REFERENCES code_pool_batches (id, product_id, product_variant_id) ON DELETE RESTRICT,
        CONSTRAINT code_pool_entries_order_item_fkey
          FOREIGN KEY (order_item_id, product_id, product_variant_id)
          REFERENCES order_items (id, product_id, product_variant_id) ON DELETE RESTRICT,
        CONSTRAINT code_pool_entries_nonce_check CHECK (octet_length(nonce) = 12),
        CONSTRAINT code_pool_entries_tag_check CHECK (octet_length(auth_tag) = 16),
        CONSTRAINT code_pool_entries_encryption_key_check
          CHECK (encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'),
        CONSTRAINT code_pool_entries_fingerprint_key_check
          CHECK (fingerprint_key_id ~ '^[A-Za-z0-9_-]{1,48}$'),
        CONSTRAINT code_pool_entries_fingerprint_check
          CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT code_pool_entries_state_check CHECK (state IN ('staged', 'available', 'reserved', 'delivered', 'revoked')),
        CONSTRAINT code_pool_entries_state_shape_check CHECK (
          (state = 'staged' AND order_item_id IS NULL AND withdrawal_batch_id IS NULL
            AND reserved_at IS NULL AND delivered_at IS NULL AND revoked_at IS NULL)
          OR (state = 'available' AND order_item_id IS NULL AND withdrawal_batch_id IS NULL
            AND reserved_at IS NULL AND delivered_at IS NULL AND revoked_at IS NULL)
          OR (state = 'reserved' AND order_item_id IS NOT NULL AND withdrawal_batch_id IS NULL
            AND reserved_at IS NOT NULL AND delivered_at IS NULL AND revoked_at IS NULL)
          OR (state = 'delivered' AND order_item_id IS NOT NULL AND withdrawal_batch_id IS NULL
            AND reserved_at IS NOT NULL AND delivered_at IS NOT NULL AND revoked_at IS NULL)
          OR (state = 'revoked' AND order_item_id IS NULL AND withdrawal_batch_id IS NOT NULL
            AND reserved_at IS NULL AND delivered_at IS NULL AND revoked_at IS NOT NULL)
        ),
        CONSTRAINT code_pool_entries_id_sku_unique UNIQUE (id, product_id, product_variant_id),
        CONSTRAINT code_pool_entries_fingerprint_unique
          UNIQUE (product_variant_id, fingerprint_key_id, content_fingerprint)
      )
    `.execute(db)
    await sql`CREATE INDEX code_pool_entries_available_idx
      ON code_pool_entries (product_variant_id, created_at, id) WHERE state = 'available'`.execute(db)
    await sql`CREATE INDEX code_pool_entries_order_item_idx
      ON code_pool_entries (order_item_id, state, id) WHERE order_item_id IS NOT NULL`.execute(db)
    await sql`CREATE INDEX code_pool_entries_batch_idx
      ON code_pool_entries (import_batch_id, state, id)`.execute(db)

    await sql`
      CREATE TABLE code_pool_withdrawal_entries (
        batch_id uuid NOT NULL,
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        entry_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT code_pool_withdrawal_entries_pkey PRIMARY KEY (batch_id, entry_id),
        CONSTRAINT code_pool_withdrawal_entries_batch_fkey
          FOREIGN KEY (batch_id, product_id, product_variant_id)
          REFERENCES code_pool_batches (id, product_id, product_variant_id) ON DELETE RESTRICT,
        CONSTRAINT code_pool_withdrawal_entries_entry_fkey
          FOREIGN KEY (entry_id, product_id, product_variant_id)
          REFERENCES code_pool_entries (id, product_id, product_variant_id) ON DELETE RESTRICT
      )
    `.execute(db)

    await sql`
      ALTER TABLE order_inventory_events
        ALTER COLUMN reservation_id DROP NOT NULL,
        ADD COLUMN product_variant_id uuid,
        ADD COLUMN code_pool_batch_id uuid,
        DROP CONSTRAINT order_inventory_events_action_check,
        ADD CONSTRAINT order_inventory_events_action_check
          CHECK (action IN ('reserve', 'release', 'consume', 'restock', 'withdraw')),
        ADD CONSTRAINT order_inventory_events_product_variant_fkey
          FOREIGN KEY (product_variant_id) REFERENCES product_variants (id) ON DELETE RESTRICT,
        ADD CONSTRAINT order_inventory_events_code_pool_batch_fkey
          FOREIGN KEY (code_pool_batch_id) REFERENCES code_pool_batches (id) ON DELETE RESTRICT,
        ADD CONSTRAINT order_inventory_events_shape_check CHECK (
          (action IN ('reserve', 'release', 'consume') AND reservation_id IS NOT NULL
            AND product_variant_id IS NULL AND code_pool_batch_id IS NULL)
          OR (action IN ('restock', 'withdraw') AND reservation_id IS NULL
            AND product_variant_id IS NOT NULL AND code_pool_batch_id IS NOT NULL)
        )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX order_inventory_events_pool_batch_action_unique
      ON order_inventory_events (code_pool_batch_id, action) WHERE code_pool_batch_id IS NOT NULL`.execute(db)

    await sql`
      ALTER TABLE order_item_fulfillment_attempts
        ADD COLUMN delivery_source varchar(16) NOT NULL DEFAULT 'manual',
        ADD COLUMN failure_code varchar(48),
        ADD COLUMN retry_after timestamptz,
        ADD CONSTRAINT order_item_fulfillment_attempts_source_check
          CHECK (delivery_source IN ('manual', 'code_pool')),
        ADD CONSTRAINT order_item_fulfillment_attempts_failure_check CHECK (
          (failure_code IS NULL AND retry_after IS NULL)
          OR (delivery_source = 'code_pool' AND status = 'failed' AND failure_code IS NOT NULL
            AND failure_code IN ('CODE_POOL_DATA_INCONSISTENT', 'CODE_POOL_KEY_UNAVAILABLE',
              'CODE_POOL_DECRYPTION_FAILED', 'CODE_POOL_PAYMENT_UNRESOLVED')
            AND retry_after IS NOT NULL)
        )
    `.execute(db)

    await sql`
      ALTER TABLE order_item_fulfillment_deliveries
        ALTER COLUMN started_by_admin_id DROP NOT NULL,
        ALTER COLUMN content DROP NOT NULL,
        ADD COLUMN delivery_source varchar(16) NOT NULL DEFAULT 'manual',
        ADD COLUMN encrypted_content bytea,
        ADD COLUMN content_nonce bytea,
        ADD COLUMN content_auth_tag bytea,
        ADD COLUMN encryption_key_id varchar(48),
        ADD COLUMN code_pool_entry_id uuid REFERENCES code_pool_entries (id) ON DELETE RESTRICT,
        DROP CONSTRAINT order_item_fulfillment_deliveries_content_check,
        ADD CONSTRAINT order_item_fulfillment_deliveries_source_check CHECK (delivery_source IN ('manual', 'code_pool')),
        ADD CONSTRAINT order_item_fulfillment_deliveries_content_check CHECK (
          (delivery_source = 'manual' AND started_by_admin_id IS NOT NULL
            AND content IS NOT NULL AND char_length(content) BETWEEN 1 AND 512 AND btrim(content) <> ''
            AND encrypted_content IS NULL AND content_nonce IS NULL AND content_auth_tag IS NULL
            AND encryption_key_id IS NULL AND code_pool_entry_id IS NULL)
          OR (delivery_source = 'code_pool' AND started_by_admin_id IS NULL AND content IS NULL
            AND encrypted_content IS NOT NULL AND octet_length(content_nonce) = 12
            AND octet_length(content_auth_tag) = 16
            AND encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$' AND code_pool_entry_id IS NOT NULL)
        )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX order_item_fulfillment_deliveries_code_pool_entry_unique
      ON order_item_fulfillment_deliveries (code_pool_entry_id) WHERE code_pool_entry_id IS NOT NULL`.execute(db)

    await sql`
      CREATE FUNCTION guard_code_pool_catalog_state() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        sku product_variants%ROWTYPE;
        product_type varchar(16);
        has_history boolean;
      BEGIN
        IF TG_TABLE_NAME = 'product_variant_fulfillment' THEN
          SELECT * INTO sku FROM product_variants WHERE id = NEW.product_variant_id;
          IF NOT FOUND THEN RETURN NEW; END IF;
          SELECT product.product_type INTO product_type FROM products AS product WHERE product.id = sku.product_id;
          IF NEW.method = 'code_pool' AND (product_type <> 'digital' OR sku.inventory_mode <> 'quantity') THEN
            RAISE EXCEPTION 'Code-pool fulfillment requires a digital SKU with quantity inventory'
              USING ERRCODE = '23514', CONSTRAINT = 'code_pool_requires_quantity_digital_sku';
          END IF;
          IF NEW.code_pool_delivery_ready AND (NEW.method <> 'code_pool' OR product_type <> 'digital'
            OR sku.inventory_mode <> 'quantity' OR NOT sku.enabled OR sku.retired_at IS NOT NULL) THEN
            RAISE EXCEPTION 'Only an enabled, active quantity-mode digital code-pool SKU can be made ready'
              USING ERRCODE = '23514', CONSTRAINT = 'code_pool_delivery_readiness_invalid';
          END IF;
          IF TG_OP = 'UPDATE' AND OLD.method = 'code_pool'
            AND (NEW.method <> 'code_pool' OR NEW.product_variant_id <> OLD.product_variant_id) THEN
            SELECT EXISTS (SELECT 1 FROM code_pool_batches WHERE product_variant_id = OLD.product_variant_id)
              OR EXISTS (SELECT 1 FROM order_items WHERE product_variant_id = OLD.product_variant_id
                AND fulfillment_method_snapshot = 'code_pool') INTO has_history;
            IF has_history THEN
              RAISE EXCEPTION 'Code-pool fulfillment history is immutable'
                USING ERRCODE = '23514', CONSTRAINT = 'code_pool_fulfillment_history_immutable';
            END IF;
          END IF;
          RETURN NEW;
        END IF;

        IF TG_OP = 'UPDATE' AND OLD.inventory_mode IS DISTINCT FROM NEW.inventory_mode
          AND EXISTS (SELECT 1 FROM product_variant_fulfillment AS fulfillment
            WHERE fulfillment.product_variant_id = OLD.id AND fulfillment.method = 'code_pool') THEN
          RAISE EXCEPTION 'A code-pool SKU must retain quantity inventory mode'
            USING ERRCODE = '23514', CONSTRAINT = 'code_pool_inventory_mode_immutable';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER product_variant_fulfillment_code_pool_guard
      BEFORE INSERT OR UPDATE ON product_variant_fulfillment
      FOR EACH ROW EXECUTE FUNCTION guard_code_pool_catalog_state()`.execute(db)
    await sql`CREATE TRIGGER product_variants_code_pool_mode_guard
      BEFORE UPDATE OF inventory_mode ON product_variants
      FOR EACH ROW EXECUTE FUNCTION guard_code_pool_catalog_state()`.execute(db)

    await sql`
      CREATE FUNCTION guard_code_pool_fulfillment_config_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.method = 'code_pool' AND (
          EXISTS (SELECT 1 FROM code_pool_batches WHERE product_variant_id = OLD.product_variant_id)
          OR EXISTS (SELECT 1 FROM order_items WHERE product_variant_id = OLD.product_variant_id
            AND fulfillment_method_snapshot = 'code_pool')
        ) THEN
          RAISE EXCEPTION 'Code-pool fulfillment history is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'code_pool_fulfillment_history_immutable';
        END IF;
        RETURN OLD;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER product_variant_fulfillment_code_pool_delete_guard
      BEFORE DELETE ON product_variant_fulfillment
      FOR EACH ROW EXECUTE FUNCTION guard_code_pool_fulfillment_config_delete()`.execute(db)

    await sql`
      CREATE FUNCTION guard_code_pool_batch_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE configured_method varchar(24); inventory_mode varchar(16); product_type varchar(16);
      BEGIN
        SELECT fulfillment.method, variant.inventory_mode, product.product_type
          INTO configured_method, inventory_mode, product_type
        FROM product_variants AS variant
        JOIN products AS product ON product.id = variant.product_id
        JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
        WHERE variant.product_id = NEW.product_id AND variant.id = NEW.product_variant_id
        FOR UPDATE OF variant;
        IF NOT FOUND OR configured_method <> 'code_pool' OR inventory_mode <> 'quantity' OR product_type <> 'digital' THEN
          RAISE EXCEPTION 'Code-pool batches require a configured digital quantity-mode SKU'
            USING ERRCODE = '23514', CONSTRAINT = 'code_pool_batch_sku_not_ready';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER code_pool_batches_validate_sku
      BEFORE INSERT ON code_pool_batches FOR EACH ROW EXECUTE FUNCTION guard_code_pool_batch_insert()`.execute(db)

    await sql`
      CREATE FUNCTION guard_code_pool_entry_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE batch_kind varchar(16); batch_count integer; current_count bigint;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Code-pool entries are immutable history and cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'code_pool_entries_immutable';
        END IF;
        IF TG_OP = 'INSERT' THEN
          SELECT kind, accepted_count INTO batch_kind, batch_count FROM code_pool_batches
          WHERE id = NEW.import_batch_id AND product_variant_id = NEW.product_variant_id;
          SELECT count(*) INTO current_count FROM code_pool_entries WHERE import_batch_id = NEW.import_batch_id;
          IF batch_kind IS DISTINCT FROM 'import' OR NEW.state <> 'staged' OR current_count >= batch_count THEN
            RAISE EXCEPTION 'Code-pool entries must be staged in their import batch'
              USING ERRCODE = '23514', CONSTRAINT = 'code_pool_entries_initial_state';
          END IF;
          RETURN NEW;
        END IF;
        IF ROW(NEW.id, NEW.product_id, NEW.product_variant_id, NEW.import_batch_id,
            NEW.ciphertext, NEW.nonce, NEW.auth_tag, NEW.encryption_key_id,
            NEW.content_fingerprint, NEW.fingerprint_key_id, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.product_id, OLD.product_variant_id, OLD.import_batch_id,
            OLD.ciphertext, OLD.nonce, OLD.auth_tag, OLD.encryption_key_id,
            OLD.content_fingerprint, OLD.fingerprint_key_id, OLD.created_at) THEN
          RAISE EXCEPTION 'Code-pool entry content and identity are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'code_pool_entries_immutable';
        END IF;
        IF ROW(OLD.state, NEW.state) NOT IN (
          ROW('staged'::varchar, 'available'::varchar),
          ROW('available'::varchar, 'revoked'::varchar),
          ROW('available'::varchar, 'reserved'::varchar),
          ROW('reserved'::varchar, 'available'::varchar),
          ROW('reserved'::varchar, 'delivered'::varchar)
        ) OR pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'Code-pool state changes must be caused by inventory events'
            USING ERRCODE = '23514', CONSTRAINT = 'code_pool_entries_event_required';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER code_pool_entries_guard
      BEFORE INSERT OR UPDATE OR DELETE ON code_pool_entries
      FOR EACH ROW EXECUTE FUNCTION guard_code_pool_entry_mutation()`.execute(db)
    await sql`CREATE TRIGGER code_pool_entries_prevent_truncate
      BEFORE TRUNCATE ON code_pool_entries FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      CREATE FUNCTION guard_code_pool_withdrawal_link() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE batch_kind varchar(16); entry_state varchar(16);
      BEGIN
        SELECT kind INTO batch_kind FROM code_pool_batches WHERE id = NEW.batch_id
          AND product_id = NEW.product_id AND product_variant_id = NEW.product_variant_id;
        SELECT state INTO entry_state FROM code_pool_entries WHERE id = NEW.entry_id
          AND product_id = NEW.product_id AND product_variant_id = NEW.product_variant_id FOR UPDATE;
        IF batch_kind <> 'withdrawal' OR entry_state <> 'available' THEN
          RAISE EXCEPTION 'Only available entries can be assigned to a withdrawal batch'
            USING ERRCODE = '23514', CONSTRAINT = 'code_pool_withdrawal_entry_not_available';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER code_pool_withdrawal_entries_validate
      BEFORE INSERT ON code_pool_withdrawal_entries FOR EACH ROW EXECUTE FUNCTION guard_code_pool_withdrawal_link()`.execute(db)

    await sql`
      CREATE FUNCTION protect_code_pool_batch_history() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Code-pool batch history is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'code_pool_batches_immutable';
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER code_pool_batches_immutable
      BEFORE UPDATE OR DELETE ON code_pool_batches FOR EACH ROW EXECUTE FUNCTION protect_code_pool_batch_history()`.execute(db)
    await sql`CREATE TRIGGER code_pool_batches_prevent_truncate
      BEFORE TRUNCATE ON code_pool_batches FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER code_pool_withdrawal_entries_immutable
      BEFORE UPDATE OR DELETE ON code_pool_withdrawal_entries FOR EACH ROW EXECUTE FUNCTION protect_code_pool_batch_history()`.execute(db)

    await sql`
      CREATE FUNCTION assert_code_pool_batch_accounting() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE recorded_count bigint; event_count bigint; event_quantity integer;
      BEGIN
        IF NEW.kind = 'import' THEN
          SELECT count(*) INTO recorded_count FROM code_pool_entries WHERE import_batch_id = NEW.id;
          SELECT count(*), max(quantity) INTO event_count, event_quantity FROM order_inventory_events
            WHERE code_pool_batch_id = NEW.id AND action = 'restock';
        ELSE
          SELECT count(*) INTO recorded_count FROM code_pool_withdrawal_entries WHERE batch_id = NEW.id;
          SELECT count(*), max(quantity) INTO event_count, event_quantity FROM order_inventory_events
            WHERE code_pool_batch_id = NEW.id AND action = 'withdraw';
        END IF;
        IF recorded_count <> NEW.accepted_count
          OR (NEW.accepted_count = 0 AND event_count <> 0)
          OR (NEW.accepted_count > 0 AND (event_count <> 1 OR event_quantity <> NEW.accepted_count)) THEN
          RAISE EXCEPTION 'Code-pool batch does not match its immutable inventory event and entries'
            USING ERRCODE = '23514', CONSTRAINT = 'code_pool_batch_accounting_mismatch';
        END IF;
        RETURN NULL;
      END;
      $$
    `.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER code_pool_batches_accounting_check
      AFTER INSERT ON code_pool_batches DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_code_pool_batch_accounting()`.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION validate_order_manual_fulfillment_readiness() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        product_type varchar(16);
        configured_method varchar(24);
        manual_ready boolean;
        code_pool_ready boolean;
        inventory_mode varchar(16);
      BEGIN
        SELECT product.product_type, variant.inventory_mode, fulfillment.method,
          fulfillment.manual_delivery_ready, fulfillment.code_pool_delivery_ready
          INTO product_type, inventory_mode, configured_method, manual_ready, code_pool_ready
        FROM products AS product
        JOIN product_variants AS variant ON variant.product_id = product.id
        LEFT JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
        WHERE product.id = NEW.product_id AND variant.id = NEW.product_variant_id;
        IF product_type IS DISTINCT FROM 'digital' OR configured_method IS NULL
          OR NEW.fulfillment_method_snapshot IS DISTINCT FROM configured_method
          OR (configured_method = 'manual' AND manual_ready IS DISTINCT FROM true)
          OR (configured_method = 'code_pool' AND (code_pool_ready IS DISTINCT FROM true OR inventory_mode IS DISTINCT FROM 'quantity'))
          OR configured_method NOT IN ('manual', 'code_pool') THEN
          RAISE EXCEPTION 'Only explicitly ready manual or code-pool digital SKUs can be ordered'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_digital_fulfillment_not_ready';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION apply_order_inventory_event() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        reservation order_inventory_reservations%ROWTYPE;
        pool_batch code_pool_batches%ROWTYPE;
        item_row order_items%ROWTYPE;
        order_uuid uuid;
        order_state varchar(24);
        item_fulfillment_reserved integer;
        inventory_row product_variant_quantity_inventory%ROWTYPE;
        variant_uuid uuid;
        next_revision integer;
        reserved_before bigint;
        changed_entries bigint;
      BEGIN
        IF NEW.action IN ('restock', 'withdraw') THEN
          SELECT * INTO pool_batch FROM code_pool_batches
          WHERE id = NEW.code_pool_batch_id FOR UPDATE;
          IF NOT FOUND OR pool_batch.product_variant_id <> NEW.product_variant_id
            OR (NEW.action = 'restock' AND (pool_batch.kind <> 'import' OR NEW.quantity <> pool_batch.accepted_count))
            OR (NEW.action = 'withdraw' AND (pool_batch.kind <> 'withdrawal' OR NEW.quantity <> pool_batch.accepted_count)) THEN
            RAISE EXCEPTION 'Code-pool inventory event does not match its immutable batch'
              USING ERRCODE = '23514', CONSTRAINT = 'code_pool_event_batch_mismatch';
          END IF;
          variant_uuid := NEW.product_variant_id;
        ELSE
          SELECT * INTO reservation FROM order_inventory_reservations WHERE id = NEW.reservation_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Inventory event reservation does not exist'
              USING ERRCODE = '23503', CONSTRAINT = 'order_inventory_reservations_item_fkey';
          END IF;
          SELECT * INTO item_row FROM order_items AS item WHERE item.id = reservation.order_item_id;
          SELECT item.order_id INTO order_uuid FROM order_items AS item WHERE item.id = reservation.order_item_id;
          SELECT status INTO order_state FROM orders WHERE id = order_uuid;
          item_fulfillment_reserved := item_row.fulfillment_reserved_quantity;
          variant_uuid := reservation.product_variant_id;
        END IF;

        -- Keep the established writer order: SKU first, quantity inventory second,
        -- then code-pool entry rows. Import, checkout and fulfillment use this order.
        PERFORM id FROM product_variants WHERE id = variant_uuid FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Inventory event SKU no longer exists'
            USING ERRCODE = '23503', CONSTRAINT = 'order_inventory_variant_fkey';
        END IF;
        SELECT * INTO inventory_row FROM product_variant_quantity_inventory
        WHERE product_variant_id = variant_uuid FOR UPDATE;
        IF NOT FOUND OR (SELECT inventory_mode FROM product_variants WHERE id = variant_uuid) <> 'quantity' THEN
          RAISE EXCEPTION 'Inventory events require quantity inventory state'
            USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_quantity_state_required';
        END IF;

        IF NEW.action IN ('restock', 'withdraw') THEN
          IF NEW.action = 'restock' THEN
            SELECT count(*) INTO changed_entries FROM code_pool_entries
            WHERE import_batch_id = pool_batch.id AND state = 'staged';
            IF changed_entries <> NEW.quantity THEN
              RAISE EXCEPTION 'Code-pool import entry count does not match its inventory event'
                USING ERRCODE = '23514', CONSTRAINT = 'code_pool_import_count_mismatch';
            END IF;
            UPDATE code_pool_entries SET state = 'available'
            WHERE import_batch_id = pool_batch.id AND state = 'staged';
            UPDATE product_variant_quantity_inventory SET stocked = stocked + NEW.quantity
            WHERE product_variant_id = variant_uuid AND stocked <= 2147483647 - NEW.quantity;
          ELSE
            SELECT count(*) INTO changed_entries FROM code_pool_withdrawal_entries AS link
            JOIN code_pool_entries AS entry ON entry.id = link.entry_id
            WHERE link.batch_id = pool_batch.id AND entry.state = 'available';
            IF changed_entries <> NEW.quantity OR inventory_row.stocked - inventory_row.reserved < NEW.quantity THEN
              RAISE EXCEPTION 'Only unreserved code-pool stock can be withdrawn'
                USING ERRCODE = '23514', CONSTRAINT = 'code_pool_withdrawal_count_mismatch';
            END IF;
            UPDATE code_pool_entries AS entry SET state = 'revoked', withdrawal_batch_id = pool_batch.id,
              revoked_at = clock_timestamp()
            FROM code_pool_withdrawal_entries AS link
            WHERE link.batch_id = pool_batch.id AND link.entry_id = entry.id AND entry.state = 'available';
            UPDATE product_variant_quantity_inventory SET stocked = stocked - NEW.quantity
            WHERE product_variant_id = variant_uuid AND stocked - reserved >= NEW.quantity;
          END IF;
        ELSE
          SELECT
            COALESCE(sum(quantity) FILTER (WHERE action = 'reserve'), 0)
            - COALESCE(sum(quantity) FILTER (WHERE action IN ('release', 'consume')), 0)
            INTO reserved_before
          FROM order_inventory_events WHERE reservation_id = NEW.reservation_id AND id <> NEW.id;

          IF NEW.action = 'reserve' THEN
            IF order_state NOT IN ('pending_payment', 'processing') OR NEW.quantity <> reservation.quantity
              OR reserved_before <> 0 OR inventory_row.stocked - inventory_row.reserved < NEW.quantity THEN
              RAISE EXCEPTION 'Initial reservation does not match available quantity inventory'
                USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_reservation_state';
            END IF;
            UPDATE product_variant_quantity_inventory SET reserved = reserved + NEW.quantity
            WHERE product_variant_id = variant_uuid AND reserved <= stocked - NEW.quantity;
            IF item_row.fulfillment_method_snapshot = 'code_pool' THEN
              WITH selected AS MATERIALIZED (
                SELECT id FROM code_pool_entries WHERE product_variant_id = variant_uuid AND state = 'available'
                ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT NEW.quantity
              ), updated AS (
                UPDATE code_pool_entries AS entry SET state = 'reserved', order_item_id = item_row.id,
                  reserved_at = clock_timestamp()
                WHERE entry.id IN (SELECT id FROM selected) AND entry.state = 'available'
                RETURNING entry.id
              ) SELECT count(*) INTO changed_entries FROM updated;
              IF changed_entries <> NEW.quantity THEN
                RAISE EXCEPTION 'Not enough unreserved codes are available for this order item'
                  USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_insufficient_code_pool';
              END IF;
            END IF;
          ELSIF NEW.action = 'release' THEN
            IF order_state <> 'closed' OR NEW.quantity <> reserved_before - item_fulfillment_reserved
              OR NEW.quantity <= 0 THEN
              RAISE EXCEPTION 'Inventory can only release the unfulfilled remainder of a closed order'
                USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_release_state';
            END IF;
            UPDATE product_variant_quantity_inventory SET reserved = reserved - NEW.quantity
            WHERE product_variant_id = variant_uuid AND reserved >= NEW.quantity;
            IF item_row.fulfillment_method_snapshot = 'code_pool' THEN
              WITH selected AS MATERIALIZED (
                SELECT id FROM code_pool_entries WHERE order_item_id = item_row.id AND state = 'reserved'
                ORDER BY id FOR UPDATE LIMIT NEW.quantity
              ), updated AS (
                UPDATE code_pool_entries AS entry SET state = 'available', order_item_id = NULL, reserved_at = NULL
                WHERE entry.id IN (SELECT id FROM selected) AND entry.state = 'reserved'
                RETURNING entry.id
              ) SELECT count(*) INTO changed_entries FROM updated;
              IF changed_entries <> NEW.quantity THEN
                RAISE EXCEPTION 'Code-pool reservation could not be safely released'
                  USING ERRCODE = '23514', CONSTRAINT = 'code_pool_release_count_mismatch';
              END IF;
            END IF;
          ELSE
            IF NEW.quantity > reserved_before OR NOT EXISTS (
              SELECT 1 FROM order_item_fulfillment_attempts AS attempt
              WHERE attempt.operation_id = NEW.operation_id AND attempt.status = 'succeeded'
                AND attempt.order_item_id = reservation.order_item_id AND attempt.quantity = NEW.quantity
            ) THEN
              RAISE EXCEPTION 'Inventory consumption must match a successful fulfillment attempt and active reservation'
                USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_consume_state';
            END IF;
            IF item_row.fulfillment_method_snapshot = 'code_pool' THEN
              SELECT count(*) INTO changed_entries FROM order_item_fulfillment_deliveries AS delivery
              JOIN code_pool_entries AS entry ON entry.id = delivery.code_pool_entry_id
              JOIN order_item_fulfillment_attempts AS attempt ON attempt.id = delivery.fulfillment_attempt_id
              WHERE attempt.operation_id = NEW.operation_id AND attempt.status = 'succeeded'
                AND attempt.order_item_id = item_row.id AND entry.state = 'reserved'
                AND entry.order_item_id = item_row.id;
              IF changed_entries <> NEW.quantity THEN
                RAISE EXCEPTION 'Successful code-pool fulfillment requires one reserved code per delivery'
                  USING ERRCODE = '23514', CONSTRAINT = 'code_pool_delivery_count_mismatch';
              END IF;
              UPDATE code_pool_entries AS entry SET state = 'delivered', delivered_at = clock_timestamp()
              FROM order_item_fulfillment_deliveries AS delivery
              JOIN order_item_fulfillment_attempts AS attempt ON attempt.id = delivery.fulfillment_attempt_id
              WHERE attempt.operation_id = NEW.operation_id AND attempt.status = 'succeeded'
                AND attempt.order_item_id = item_row.id AND entry.id = delivery.code_pool_entry_id
                AND entry.state = 'reserved' AND entry.order_item_id = item_row.id;
            END IF;
            UPDATE product_variant_quantity_inventory SET stocked = stocked - NEW.quantity, reserved = reserved - NEW.quantity
            WHERE product_variant_id = variant_uuid AND reserved >= NEW.quantity AND stocked >= NEW.quantity;
          END IF;
        END IF;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Inventory movement would violate stocked and reserved quantities'
            USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_quantity_bounds';
        END IF;
        UPDATE product_variants SET inventory_revision = inventory_revision + 1
        WHERE id = variant_uuid AND inventory_revision < 2147483647
        RETURNING inventory_revision INTO next_revision;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Inventory revision is exhausted'
            USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_revision_exhausted';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE FUNCTION guard_code_pool_stock_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF EXISTS (SELECT 1 FROM product_variant_fulfillment AS fulfillment
            WHERE fulfillment.product_variant_id = OLD.product_variant_id AND fulfillment.method = 'code_pool') THEN
            RAISE EXCEPTION 'Code-pool quantity inventory is part of immutable SKU history'
              USING ERRCODE = '23514', CONSTRAINT = 'code_pool_stock_requires_inventory_event';
          END IF;
          RETURN OLD;
        END IF;
        IF NEW.stocked IS DISTINCT FROM OLD.stocked AND pg_trigger_depth() < 2
          AND EXISTS (SELECT 1 FROM product_variant_fulfillment AS fulfillment
            WHERE fulfillment.product_variant_id = NEW.product_variant_id AND fulfillment.method = 'code_pool') THEN
          RAISE EXCEPTION 'Code-pool stocked quantity can only change through inventory events'
            USING ERRCODE = '23514', CONSTRAINT = 'code_pool_stock_requires_inventory_event';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER code_pool_stock_event_guard
      BEFORE UPDATE OF stocked OR DELETE ON product_variant_quantity_inventory
      FOR EACH ROW EXECUTE FUNCTION guard_code_pool_stock_write()`.execute(db)

    await sql`
      CREATE FUNCTION guard_code_pool_fulfillment_attempt() RETURNS trigger
      LANGUAGE plpgsql AS $$
        DECLARE method_name varchar(24); delivery_count bigint;
        DECLARE parent_status varchar(24); order_total numeric(18,2); parent_order uuid;
      BEGIN
        SELECT fulfillment_method_snapshot INTO method_name FROM order_items WHERE id = NEW.order_item_id;
        IF TG_OP = 'INSERT' THEN
          IF (NEW.delivery_source = 'code_pool' AND (method_name <> 'code_pool' OR NEW.started_by_admin_id IS NOT NULL))
            OR (NEW.delivery_source = 'manual' AND (method_name <> 'manual' OR NEW.started_by_admin_id IS NULL)) THEN
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
        IF NEW.status = 'succeeded' AND OLD.status IS DISTINCT FROM NEW.status AND method_name = 'code_pool' THEN
          SELECT order_row.status, order_row.total_amount, order_row.id INTO parent_status, order_total, parent_order
          FROM orders AS order_row JOIN order_items AS item ON item.order_id = order_row.id
          WHERE item.id = NEW.order_item_id;
          IF parent_status IS DISTINCT FROM 'processing'
            OR (order_total > 0 AND (order_has_unresolved_payment_attempts(parent_order) OR EXISTS (
              SELECT 1 FROM payment_attempts AS payment_attempt
              JOIN payment_provider_reconciliation_cases AS reconciliation
                ON reconciliation.payment_attempt_id = payment_attempt.id
              WHERE payment_attempt.order_id = parent_order AND reconciliation.state = 'open'
            ) OR COALESCE((
              SELECT sum(receipt.amount) FROM payment_attempts AS payment_attempt
              JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = payment_attempt.id
              WHERE payment_attempt.order_id = parent_order AND payment_attempt.status = 'succeeded'
                AND receipt.disposition = 'on_time'
            ), 0) <> order_total)) THEN
            RAISE EXCEPTION 'Code-pool delivery requires a processing order with confirmed payment and no open reconciliation'
              USING ERRCODE = '23514', CONSTRAINT = 'code_pool_delivery_payment_required';
          END IF;
          SELECT count(*) INTO delivery_count FROM order_item_fulfillment_deliveries AS delivery
          WHERE delivery.fulfillment_attempt_id = NEW.id AND delivery.delivery_source = 'code_pool'
            AND delivery.code_pool_entry_id IS NOT NULL AND delivery.encrypted_content IS NOT NULL;
          IF NEW.delivery_source <> 'code_pool' OR delivery_count <> NEW.quantity THEN
            RAISE EXCEPTION 'Code-pool success requires one encrypted private delivery per unit'
              USING ERRCODE = '23514', CONSTRAINT = 'code_pool_fulfillment_delivery_required';
          END IF;
        END IF;
        IF NEW.failure_code IS NOT NULL AND (NEW.delivery_source <> 'code_pool' OR NEW.status <> 'failed') THEN
          RAISE EXCEPTION 'Only failed code-pool attempts can record an automatic failure code'
            USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_failure_code_state';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_item_fulfillment_code_pool_guard
      BEFORE INSERT OR UPDATE ON order_item_fulfillment_attempts
      FOR EACH ROW EXECUTE FUNCTION guard_code_pool_fulfillment_attempt()`.execute(db)

    await sql`
      CREATE FUNCTION guard_code_pool_delivery_record() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE attempt_source varchar(16); item_method varchar(24); entry_state varchar(16); entry_item uuid;
      BEGIN
        IF NEW.delivery_source = 'manual' THEN RETURN NEW; END IF;
        SELECT delivery_source, item.fulfillment_method_snapshot INTO attempt_source, item_method
        FROM order_item_fulfillment_attempts AS attempt
        JOIN order_items AS item ON item.id = attempt.order_item_id
        WHERE attempt.id = NEW.fulfillment_attempt_id;
        SELECT state, order_item_id INTO entry_state, entry_item FROM code_pool_entries
        WHERE id = NEW.code_pool_entry_id FOR UPDATE;
        IF attempt_source <> 'code_pool' OR item_method <> 'code_pool' OR entry_state <> 'reserved'
          OR entry_item IS DISTINCT FROM (SELECT order_item_id FROM order_item_fulfillment_attempts WHERE id = NEW.fulfillment_attempt_id)
          OR NEW.started_by_admin_id IS NOT NULL OR NEW.content IS NOT NULL THEN
          RAISE EXCEPTION 'Encrypted code-pool delivery must reference a reserved entry for its order item'
            USING ERRCODE = '23514', CONSTRAINT = 'code_pool_delivery_entry_mismatch';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_item_fulfillment_deliveries_code_pool_guard
      BEFORE INSERT ON order_item_fulfillment_deliveries
      FOR EACH ROW EXECUTE FUNCTION guard_code_pool_delivery_record()`.execute(db)

    await sql`
      CREATE FUNCTION assert_code_pool_inventory_consistency(variant_uuid uuid) RETURNS boolean
      LANGUAGE plpgsql STABLE AS $$
      DECLARE
        pool_method varchar(24);
        inventory_row product_variant_quantity_inventory%ROWTYPE;
        available_count bigint;
        reserved_count bigint;
      BEGIN
        SELECT method INTO pool_method FROM product_variant_fulfillment WHERE product_variant_id = variant_uuid;
        IF pool_method IS DISTINCT FROM 'code_pool' THEN RETURN true; END IF;
        SELECT * INTO inventory_row FROM product_variant_quantity_inventory WHERE product_variant_id = variant_uuid;
        IF NOT FOUND THEN RETURN false; END IF;
        SELECT count(*) FILTER (WHERE state = 'available'), count(*) FILTER (WHERE state = 'reserved')
          INTO available_count, reserved_count FROM code_pool_entries WHERE product_variant_id = variant_uuid;
        RETURN inventory_row.stocked - inventory_row.reserved = available_count
          AND inventory_row.reserved = reserved_count;
      END;
      $$
    `.execute(db)

    await sql`CREATE FUNCTION forbid_code_pool_batch_truncate() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'Code-pool withdrawal history cannot be truncated'
          USING ERRCODE = '23514', CONSTRAINT = 'code_pool_batches_truncate_forbidden';
      END; $$`.execute(db)
    await sql`CREATE TRIGGER code_pool_withdrawal_entries_prevent_truncate
      BEFORE TRUNCATE ON code_pool_withdrawal_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_code_pool_batch_truncate()`.execute(db)

    await sql`CREATE INDEX order_item_fulfillment_code_pool_retry_idx
      ON order_item_fulfillment_attempts (completed_at, order_item_id)
      WHERE delivery_source = 'code_pool' AND status = 'failed'`.execute(db)
  },

  async down() {
    throw new Error('Code-pool credentials and delivery history are immutable; this migration is forward-only.')
  },
}
