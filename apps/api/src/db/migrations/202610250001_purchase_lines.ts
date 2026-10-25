import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** ⑥-2B extends the existing trade tables without rewriting frozen migrations. */
export const purchaseLinesMigration: Migration = {
  async up(db) {
    // ⑥-2C will provide the explicit activation path. Preparation links alone
    // cannot change the currently accepted no-form purchase behavior.
    await sql`ALTER TABLE storefront_customer_policy
      ADD COLUMN purchase_forms_enabled boolean NOT NULL DEFAULT false`.execute(db)

    // SHA-256 input is the exact canonical no-form JSON used by purchase-lines.ts.
    // Keep the old SKU without an FK: a deleted SKU is still an unavailable cart line.
    await sql`
      ALTER TABLE customer_cart_items
        ADD COLUMN line_id uuid NOT NULL DEFAULT gen_random_uuid(),
        ADD COLUMN revision integer NOT NULL DEFAULT 1,
        ADD COLUMN content_identity char(64),
        ADD COLUMN draft_id uuid,
        ADD COLUMN draft_revision integer,
        ADD COLUMN template_version_id uuid,
        ADD COLUMN normalization_version smallint
    `.execute(db)
    await sql`
      UPDATE customer_cart_items
      SET content_identity = encode(sha256(convert_to(
        format('{"normalizationVersion":null,"skuId":"%s","templateVersionId":null,"values":null}', sku_id::text),
        'UTF8')), 'hex')
    `.execute(db)
    await sql`
      ALTER TABLE customer_cart_items
        ALTER COLUMN content_identity SET NOT NULL,
        DROP CONSTRAINT customer_cart_items_pkey,
        ADD CONSTRAINT customer_cart_items_pkey PRIMARY KEY (line_id),
        ADD CONSTRAINT customer_cart_items_content_unique UNIQUE (customer_id, sku_id, content_identity),
        ADD CONSTRAINT customer_cart_items_revision_check CHECK (revision >= 1),
        ADD CONSTRAINT customer_cart_items_content_check CHECK (content_identity ~ '^[0-9a-f]{64}$'),
        ADD CONSTRAINT customer_cart_items_binding_shape_check CHECK (
          (draft_id IS NULL AND draft_revision IS NULL AND template_version_id IS NULL AND normalization_version IS NULL)
          OR (draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 1
            AND template_version_id IS NOT NULL AND normalization_version IS NOT NULL
            AND normalization_version = 1)
        )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX customer_cart_items_draft_unique
      ON customer_cart_items (draft_id) WHERE draft_id IS NOT NULL`.execute(db)
    await sql`CREATE INDEX customer_cart_items_customer_sku_idx
      ON customer_cart_items (customer_id, sku_id, line_id)`.execute(db)
    await sql`
      CREATE FUNCTION bump_customer_cart_line_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.line_id IS DISTINCT FROM OLD.line_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
          OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'Cart line identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'customer_cart_line_identity_immutable';
        END IF;
        NEW.revision := OLD.revision + 1;
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER customer_cart_line_revision BEFORE UPDATE ON customer_cart_items
      FOR EACH ROW EXECUTE FUNCTION bump_customer_cart_line_revision()`.execute(db)
    await sql`
      CREATE FUNCTION guard_customer_cart_form_binding() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE draft_row purchase_drafts%ROWTYPE;
      DECLARE expected_no_form char(64);
      BEGIN
        IF NEW.draft_id IS NULL THEN
          expected_no_form := encode(sha256(convert_to(
            format('{"normalizationVersion":null,"skuId":"%s","templateVersionId":null,"values":null}', NEW.sku_id::text),
            'UTF8')), 'hex');
          IF NEW.content_identity <> expected_no_form THEN
            RAISE EXCEPTION 'No-form cart line identity does not match its SKU'
              USING ERRCODE = '23514', CONSTRAINT = 'customer_cart_no_form_identity_invalid';
          END IF;
          RETURN NEW;
        END IF;
        SELECT * INTO draft_row FROM purchase_drafts WHERE id = NEW.draft_id FOR SHARE;
        IF NOT FOUND OR draft_row.customer_id IS DISTINCT FROM NEW.customer_id
          OR draft_row.guest_order_session_id IS NOT NULL OR draft_row.status <> 'active'
          OR draft_row.expires_at <= statement_timestamp()
          OR draft_row.revision IS DISTINCT FROM NEW.draft_revision
          OR draft_row.template_version_id IS DISTINCT FROM NEW.template_version_id
          OR draft_row.normalization_version IS DISTINCT FROM NEW.normalization_version THEN
          RAISE EXCEPTION 'Cart line draft binding is no longer current'
            USING ERRCODE = '23514', CONSTRAINT = 'customer_cart_draft_binding_invalid';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER customer_cart_form_binding BEFORE INSERT OR UPDATE ON customer_cart_items
      FOR EACH ROW EXECUTE FUNCTION guard_customer_cart_form_binding()`.execute(db)
    await sql`
      CREATE FUNCTION assert_purchase_draft_cart_payload_binding() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.encrypted_payload, NEW.payload_nonce, NEW.payload_auth_tag, NEW.encryption_key_id)
          IS NOT DISTINCT FROM ROW(OLD.encrypted_payload, OLD.payload_nonce, OLD.payload_auth_tag, OLD.encryption_key_id) THEN
          RETURN NULL;
        END IF;
        -- A coordinated edit may update the draft and its sole cart line in the
        -- same transaction. An independent save cannot leave a stale binding.
        IF EXISTS (SELECT 1 FROM customer_cart_items AS line
          JOIN purchase_drafts AS current_draft ON current_draft.id = line.draft_id
          WHERE line.draft_id = NEW.id AND line.draft_revision IS DISTINCT FROM current_draft.revision) THEN
          RAISE EXCEPTION 'A bound purchase draft requires a coordinated cart edit'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_draft_cart_payload_binding';
        END IF;
        RETURN NULL;
      END;
      $$
    `.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER purchase_draft_cart_payload_binding
      AFTER UPDATE ON purchase_drafts DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_purchase_draft_cart_payload_binding()`.execute(db)

    // Existing orders are genuinely pre-⑥-2B history. New orders must carry
    // explicit purchase data, including an explicit no-form snapshot.
    await sql`ALTER TABLE orders ADD COLUMN purchase_snapshot_version smallint NOT NULL DEFAULT 1,
      ADD CONSTRAINT orders_purchase_snapshot_version_check CHECK (purchase_snapshot_version IN (1, 2))`.execute(db)
    await sql`ALTER TABLE orders ALTER COLUMN purchase_snapshot_version SET DEFAULT 2`.execute(db)
    await sql`
      CREATE FUNCTION guard_order_purchase_snapshot_version() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.purchase_snapshot_version <> 2 THEN
          RAISE EXCEPTION 'New orders require purchase snapshot version 2'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_purchase_snapshot_version_required';
        ELSIF TG_OP = 'UPDATE' AND NEW.purchase_snapshot_version IS DISTINCT FROM OLD.purchase_snapshot_version THEN
          RAISE EXCEPTION 'Order purchase snapshot version is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_purchase_snapshot_version_immutable';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER orders_purchase_snapshot_version_guard
      BEFORE INSERT OR UPDATE ON orders FOR EACH ROW
      EXECUTE FUNCTION guard_order_purchase_snapshot_version()`.execute(db)

    await sql`ALTER TABLE order_items DROP CONSTRAINT order_items_product_sku_unique,
      ADD COLUMN purchase_line_id uuid,
      ADD CONSTRAINT order_items_purchase_line_unique UNIQUE (order_id, purchase_line_id)`.execute(db)
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
               NEW.fulfillment_content_version_id, NEW.unit_price, NEW.quantity, NEW.line_amount,
               NEW.purchase_line_id, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.order_id, OLD.product_id, OLD.product_variant_id,
               OLD.product_name_snapshot, OLD.product_type_snapshot, OLD.sku_code_snapshot,
               OLD.sku_snapshot, OLD.inventory_mode_snapshot, OLD.fulfillment_method_snapshot,
               OLD.fulfillment_content_version_id, OLD.unit_price, OLD.quantity, OLD.line_amount,
               OLD.purchase_line_id, OLD.created_at) THEN
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
      CREATE TABLE order_item_purchase_snapshots (
        order_item_id uuid PRIMARY KEY REFERENCES order_items (id) ON DELETE RESTRICT,
        template_version_id uuid REFERENCES purchase_form_template_versions (id) ON DELETE RESTRICT,
        normalization_version smallint,
        content_identity char(64) NOT NULL,
        encrypted_values bytea,
        values_nonce bytea,
        values_auth_tag bytea,
        encryption_key_id varchar(48),
        attachment_ids uuid[] NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT order_item_purchase_snapshots_hash_check CHECK (content_identity ~ '^[0-9a-f]{64}$'),
        CONSTRAINT order_item_purchase_snapshots_shape_check CHECK (
          (template_version_id IS NULL AND normalization_version IS NULL
            AND encrypted_values IS NULL AND values_nonce IS NULL
            AND values_auth_tag IS NULL AND encryption_key_id IS NULL
            AND cardinality(attachment_ids) = 0)
          OR (template_version_id IS NOT NULL AND normalization_version = 1
            AND encrypted_values IS NOT NULL AND values_nonce IS NOT NULL
            AND values_auth_tag IS NOT NULL AND encryption_key_id IS NOT NULL
            AND octet_length(encrypted_values) BETWEEN 1 AND 65536
            AND octet_length(values_nonce) = 12 AND octet_length(values_auth_tag) = 16
            AND encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND cardinality(attachment_ids) BETWEEN 0 AND 10)
        )
      )
    `.execute(db)

    await sql`
      CREATE TABLE purchase_order_attachment_objects (
        id uuid PRIMARY KEY,
        source_draft_id uuid NOT NULL,
        source_attachment_id uuid NOT NULL,
        storage_key varchar(180) NOT NULL UNIQUE,
        mime_type varchar(24) NOT NULL DEFAULT 'image/webp',
        byte_size integer NOT NULL,
        width integer NOT NULL,
        height integer NOT NULL,
        sha256 char(64) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'prepared',
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT purchase_order_attachment_objects_storage_check
          CHECK (storage_key ~ '^order-objects/[0-9a-f]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$'),
        CONSTRAINT purchase_order_attachment_objects_storage_identity_check
          CHECK (storage_key = format('order-objects/%s/%s.webp', left(id::text, 2), id::text)),
        CONSTRAINT purchase_order_attachment_objects_mime_check CHECK (mime_type = 'image/webp'),
        CONSTRAINT purchase_order_attachment_objects_size_check CHECK (byte_size BETWEEN 1 AND 5242880),
        CONSTRAINT purchase_order_attachment_objects_dimension_check CHECK (
          width BETWEEN 1 AND 8192 AND height BETWEEN 1 AND 8192 AND width::bigint * height <= 16000000),
        CONSTRAINT purchase_order_attachment_objects_sha_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT purchase_order_attachment_objects_state_check CHECK (status IN ('prepared', 'retained', 'deleting'))
      )
    `.execute(db)
    await sql`CREATE INDEX purchase_order_attachment_objects_cleanup_idx
      ON purchase_order_attachment_objects (created_at, id) WHERE status IN ('prepared', 'deleting')`.execute(db)

    await sql`
      CREATE TABLE order_item_purchase_attachments (
        order_item_id uuid NOT NULL REFERENCES order_items (id) ON DELETE RESTRICT,
        source_attachment_id uuid NOT NULL,
        archive_object_id uuid NOT NULL REFERENCES purchase_order_attachment_objects (id) ON DELETE RESTRICT,
        field_id uuid NOT NULL,
        ordinal smallint NOT NULL,
        sha256 char(64) NOT NULL,
        byte_size integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT order_item_purchase_attachments_pkey PRIMARY KEY (order_item_id, source_attachment_id),
        CONSTRAINT order_item_purchase_attachments_object_unique UNIQUE (archive_object_id),
        CONSTRAINT order_item_purchase_attachments_ordinal_unique UNIQUE (order_item_id, ordinal),
        CONSTRAINT order_item_purchase_attachments_ordinal_check CHECK (ordinal BETWEEN 1 AND 10),
        CONSTRAINT order_item_purchase_attachments_sha_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT order_item_purchase_attachments_size_check CHECK (byte_size BETWEEN 1 AND 5242880)
      )
    `.execute(db)

    await sql`
      CREATE FUNCTION guard_order_item_purchase_snapshot_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE parent_version smallint; sealed boolean;
      BEGIN
        SELECT parent.purchase_snapshot_version, parent.items_sealed
          INTO parent_version, sealed
        FROM orders AS parent JOIN order_items AS item ON item.order_id = parent.id
        WHERE item.id = NEW.order_item_id FOR UPDATE OF parent;
        IF NOT FOUND OR parent_version <> 2 OR sealed THEN
          RAISE EXCEPTION 'Purchase snapshots may only be inserted before a version 2 order is sealed'
            USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_snapshot_insert_invalid';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_item_purchase_snapshots_insert_guard
      BEFORE INSERT ON order_item_purchase_snapshots FOR EACH ROW
      EXECUTE FUNCTION guard_order_item_purchase_snapshot_insert()`.execute(db)
    await sql`
      CREATE FUNCTION protect_order_purchase_immutable() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Committed purchase data is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_data_immutable';
        RETURN NULL;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_item_purchase_snapshots_immutable
      BEFORE UPDATE OR DELETE ON order_item_purchase_snapshots FOR EACH ROW
      EXECUTE FUNCTION protect_order_purchase_immutable()`.execute(db)
    await sql`CREATE TRIGGER order_item_purchase_snapshots_no_truncate
      BEFORE TRUNCATE ON order_item_purchase_snapshots FOR EACH STATEMENT
      EXECUTE FUNCTION protect_order_purchase_immutable()`.execute(db)

    await sql`
      CREATE FUNCTION guard_purchase_order_attachment_object() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.status <> 'prepared' THEN
            RAISE EXCEPTION 'Order attachment objects must start prepared'
              USING ERRCODE = '23514', CONSTRAINT = 'purchase_order_attachment_initial_state_invalid';
          END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'DELETE' THEN
          IF OLD.status <> 'deleting' OR EXISTS (
            SELECT 1 FROM order_item_purchase_attachments WHERE archive_object_id = OLD.id) THEN
            RAISE EXCEPTION 'An order attachment object must be unbound and deleting before removal'
              USING ERRCODE = '23514', CONSTRAINT = 'purchase_order_attachment_delete_guard';
          END IF;
          RETURN OLD;
        END IF;
        IF ROW(NEW.id, NEW.source_draft_id, NEW.source_attachment_id,
          NEW.storage_key, NEW.mime_type, NEW.byte_size, NEW.width, NEW.height,
          NEW.sha256, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.source_draft_id, OLD.source_attachment_id,
          OLD.storage_key, OLD.mime_type, OLD.byte_size, OLD.width, OLD.height,
          OLD.sha256, OLD.created_at) THEN
          RAISE EXCEPTION 'Order attachment object metadata is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_order_attachment_metadata_immutable';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
          IF NOT (OLD.status = 'prepared' AND NEW.status IN ('retained', 'deleting')) THEN
            RAISE EXCEPTION 'Order attachment object state transition is invalid'
              USING ERRCODE = '23514', CONSTRAINT = 'purchase_order_attachment_state_invalid';
          END IF;
          IF NEW.status = 'retained' AND NOT EXISTS (
            SELECT 1 FROM order_item_purchase_attachments WHERE archive_object_id = OLD.id) THEN
            RAISE EXCEPTION 'Retained order attachment requires an order item reference'
              USING ERRCODE = '23514', CONSTRAINT = 'purchase_order_attachment_reference_required';
          END IF;
          IF NEW.status = 'deleting' AND EXISTS (
            SELECT 1 FROM order_item_purchase_attachments WHERE archive_object_id = OLD.id) THEN
            RAISE EXCEPTION 'Referenced order attachment cannot be deleted'
              USING ERRCODE = '23514', CONSTRAINT = 'purchase_order_attachment_referenced';
          END IF;
        ELSIF OLD.status = 'retained' THEN
          RAISE EXCEPTION 'Retained order attachment objects are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_order_attachment_retained_immutable';
        END IF;
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER purchase_order_attachment_objects_guard
      BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_attachment_objects FOR EACH ROW
      EXECUTE FUNCTION guard_purchase_order_attachment_object()`.execute(db)
    await sql`CREATE TRIGGER purchase_order_attachment_objects_no_truncate
      BEFORE TRUNCATE ON purchase_order_attachment_objects FOR EACH STATEMENT
      EXECUTE FUNCTION protect_order_purchase_immutable()`.execute(db)

    await sql`
      CREATE FUNCTION guard_order_item_purchase_attachment_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE sealed boolean; parent_version smallint;
      DECLARE object_row purchase_order_attachment_objects%ROWTYPE;
      BEGIN
        SELECT parent.items_sealed, parent.purchase_snapshot_version
          INTO sealed, parent_version
        FROM orders AS parent JOIN order_items AS item ON item.order_id = parent.id
        WHERE item.id = NEW.order_item_id FOR UPDATE OF parent;
        IF NOT FOUND OR sealed OR parent_version <> 2 THEN
          RAISE EXCEPTION 'Order attachments may only be bound before version 2 sealing'
            USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_attachment_insert_invalid';
        END IF;
        SELECT * INTO object_row FROM purchase_order_attachment_objects
          WHERE id = NEW.archive_object_id FOR UPDATE;
        IF NOT FOUND OR object_row.status <> 'prepared'
          OR object_row.source_attachment_id <> NEW.source_attachment_id
          OR object_row.sha256 <> NEW.sha256 OR object_row.byte_size <> NEW.byte_size THEN
          RAISE EXCEPTION 'Archived attachment identity or digest is invalid'
            USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_attachment_object_invalid';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_item_purchase_attachments_insert_guard
      BEFORE INSERT ON order_item_purchase_attachments FOR EACH ROW
      EXECUTE FUNCTION guard_order_item_purchase_attachment_insert()`.execute(db)
    await sql`CREATE TRIGGER order_item_purchase_attachments_immutable
      BEFORE UPDATE OR DELETE ON order_item_purchase_attachments FOR EACH ROW
      EXECUTE FUNCTION protect_order_purchase_immutable()`.execute(db)
    await sql`CREATE TRIGGER order_item_purchase_attachments_no_truncate
      BEFORE TRUNCATE ON order_item_purchase_attachments FOR EACH STATEMENT
      EXECUTE FUNCTION protect_order_purchase_immutable()`.execute(db)

    await sql`
      CREATE FUNCTION assert_order_purchase_snapshots_on_seal() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE item_row record; snap order_item_purchase_snapshots%ROWTYPE;
      DECLARE reference_count integer; distinct_id_count integer;
      DECLARE expected_no_form char(64);
      BEGIN
        IF NOT NEW.items_sealed OR OLD.items_sealed THEN RETURN NEW; END IF;
        IF NEW.purchase_snapshot_version <> 2 THEN
          RAISE EXCEPTION 'Only version 2 purchase data may be sealed on new orders'
            USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_snapshot_version_invalid';
        END IF;
        FOR item_row IN SELECT id, purchase_line_id, product_variant_id FROM order_items
          WHERE order_id = NEW.id ORDER BY id
        LOOP
          IF item_row.purchase_line_id IS NULL THEN
            RAISE EXCEPTION 'Every order item requires its original purchase line identity'
              USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_line_identity_required';
          END IF;
          SELECT * INTO snap FROM order_item_purchase_snapshots
            WHERE order_item_id = item_row.id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Every order item requires a sealed purchase snapshot'
              USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_snapshot_required';
          END IF;
          IF snap.template_version_id IS NULL THEN
            expected_no_form := encode(sha256(convert_to(
              format('{"normalizationVersion":null,"skuId":"%s","templateVersionId":null,"values":null}',
                item_row.product_variant_id::text), 'UTF8')), 'hex');
            IF snap.content_identity <> expected_no_form THEN
              RAISE EXCEPTION 'No-form order snapshot identity does not match its SKU'
                USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_no_form_identity_invalid';
            END IF;
          END IF;
          SELECT count(*), count(DISTINCT attachment_id)
            INTO reference_count, distinct_id_count
          FROM unnest(snap.attachment_ids) AS attachment_id;
          IF reference_count <> distinct_id_count THEN
            RAISE EXCEPTION 'Purchase snapshot attachment identities must be unique'
              USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_attachment_manifest_invalid';
          END IF;
          IF reference_count <> (SELECT count(*) FROM order_item_purchase_attachments
              WHERE order_item_id = item_row.id)
            OR EXISTS (
              SELECT 1 FROM order_item_purchase_attachments AS ref
              JOIN purchase_order_attachment_objects AS object ON object.id = ref.archive_object_id
              WHERE ref.order_item_id = item_row.id
                AND (NOT (ref.source_attachment_id = ANY(snap.attachment_ids))
                  OR ref.source_attachment_id <> snap.attachment_ids[ref.ordinal]
                  OR object.status <> 'retained'
                  OR object.source_attachment_id <> ref.source_attachment_id
                  OR object.sha256 <> ref.sha256 OR object.byte_size <> ref.byte_size)
            ) THEN
            RAISE EXCEPTION 'Purchase snapshot attachments are incomplete or unretained'
              USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_attachment_manifest_invalid';
          END IF;
        END LOOP;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER orders_purchase_snapshots_seal_guard
      BEFORE UPDATE OF items_sealed ON orders FOR EACH ROW
      EXECUTE FUNCTION assert_order_purchase_snapshots_on_seal()`.execute(db)

    // The original product loop already groups all lines. The original SKU
    // loop checked each item independently; after lifting SKU uniqueness it
    // must group the current order before per-order/lifetime/24h checks.
    await sql`
      CREATE OR REPLACE FUNCTION enforce_order_purchase_limits() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        item_row record;
        product_limits record;
        variant_limits record;
        prior_lifetime numeric;
        prior_recent numeric;
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
          IF product_limits.purchase_limit_per_order IS NOT NULL
             AND item_row.quantity > product_limits.purchase_limit_per_order THEN
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
            IF prior_lifetime + item_row.quantity > product_limits.purchase_limit_lifetime THEN
              RAISE EXCEPTION 'The product lifetime purchase limit was exceeded'
                USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_limit_exceeded';
            END IF;
          END IF;
          IF NEW.customer_id IS NOT NULL AND product_limits.purchase_limit_24h IS NOT NULL THEN
            prior_recent := prior_purchase_quantity(NEW.customer_id, item_row.product_id, NULL,
              NEW.created_at - interval '24 hours', NEW.id);
            IF prior_recent + item_row.quantity > product_limits.purchase_limit_24h THEN
              RAISE EXCEPTION 'The product rolling 24-hour purchase limit was exceeded'
                USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_limit_exceeded';
            END IF;
          END IF;
        END LOOP;

        FOR item_row IN
          SELECT item.product_id, item.product_variant_id, sum(item.quantity)::bigint AS quantity
          FROM order_items AS item WHERE item.order_id = NEW.id
          GROUP BY item.product_id, item.product_variant_id
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
  },

  // Only empty ⑥-2B state can be rolled back for isolated migration tests.
  // A live purchase line, archived object or v2 order must never be discarded.
  async down(db) {
    const present = await sql<{
      new_orders: string; cart_lines: string; archive_objects: string
    }>`
      SELECT
        (SELECT count(*)::text FROM orders WHERE purchase_snapshot_version = 2) AS new_orders,
        (SELECT count(*)::text FROM customer_cart_items) AS cart_lines,
        (SELECT count(*)::text FROM purchase_order_attachment_objects) AS archive_objects
    `.execute(db)
    if (present.rows[0]?.new_orders !== '0' || present.rows[0]?.cart_lines !== '0'
      || present.rows[0]?.archive_objects !== '0') {
      throw new Error('Cannot roll back ⑥-2B while purchase lines, new orders or archived objects exist')
    }

    await sql`DROP TRIGGER orders_purchase_snapshots_seal_guard ON orders`.execute(db)
    await sql`DROP FUNCTION assert_order_purchase_snapshots_on_seal()`.execute(db)
    await sql`DROP TRIGGER order_item_purchase_attachments_no_truncate ON order_item_purchase_attachments`.execute(db)
    await sql`DROP TRIGGER order_item_purchase_attachments_immutable ON order_item_purchase_attachments`.execute(db)
    await sql`DROP TRIGGER order_item_purchase_attachments_insert_guard ON order_item_purchase_attachments`.execute(db)
    await sql`DROP FUNCTION guard_order_item_purchase_attachment_insert()`.execute(db)
    await sql`DROP TABLE order_item_purchase_attachments`.execute(db)
    await sql`DROP TRIGGER purchase_order_attachment_objects_no_truncate ON purchase_order_attachment_objects`.execute(db)
    await sql`DROP TRIGGER purchase_order_attachment_objects_guard ON purchase_order_attachment_objects`.execute(db)
    await sql`DROP FUNCTION guard_purchase_order_attachment_object()`.execute(db)
    await sql`DROP INDEX purchase_order_attachment_objects_cleanup_idx`.execute(db)
    await sql`DROP TABLE purchase_order_attachment_objects`.execute(db)
    await sql`DROP TRIGGER order_item_purchase_snapshots_no_truncate ON order_item_purchase_snapshots`.execute(db)
    await sql`DROP TRIGGER order_item_purchase_snapshots_immutable ON order_item_purchase_snapshots`.execute(db)
    await sql`DROP TRIGGER order_item_purchase_snapshots_insert_guard ON order_item_purchase_snapshots`.execute(db)
    await sql`DROP FUNCTION guard_order_item_purchase_snapshot_insert()`.execute(db)
    await sql`DROP TABLE order_item_purchase_snapshots`.execute(db)
    await sql`DROP FUNCTION protect_order_purchase_immutable()`.execute(db)

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
    await sql`ALTER TABLE order_items DROP CONSTRAINT order_items_purchase_line_unique,
      DROP COLUMN purchase_line_id,
      ADD CONSTRAINT order_items_product_sku_unique UNIQUE (order_id, product_variant_id)`.execute(db)
    await sql`DROP TRIGGER orders_purchase_snapshot_version_guard ON orders`.execute(db)
    await sql`DROP FUNCTION guard_order_purchase_snapshot_version()`.execute(db)
    await sql`ALTER TABLE orders DROP CONSTRAINT orders_purchase_snapshot_version_check,
      DROP COLUMN purchase_snapshot_version`.execute(db)

    await sql`DROP TRIGGER purchase_draft_cart_payload_binding ON purchase_drafts`.execute(db)
    await sql`DROP FUNCTION assert_purchase_draft_cart_payload_binding()`.execute(db)
    await sql`DROP TRIGGER customer_cart_form_binding ON customer_cart_items`.execute(db)
    await sql`DROP FUNCTION guard_customer_cart_form_binding()`.execute(db)
    await sql`DROP TRIGGER customer_cart_line_revision ON customer_cart_items`.execute(db)
    await sql`DROP FUNCTION bump_customer_cart_line_revision()`.execute(db)
    await sql`DROP INDEX customer_cart_items_customer_sku_idx`.execute(db)
    await sql`DROP INDEX customer_cart_items_draft_unique`.execute(db)
    await sql`
      ALTER TABLE customer_cart_items
        DROP CONSTRAINT customer_cart_items_binding_shape_check,
        DROP CONSTRAINT customer_cart_items_content_check,
        DROP CONSTRAINT customer_cart_items_revision_check,
        DROP CONSTRAINT customer_cart_items_content_unique,
        DROP CONSTRAINT customer_cart_items_pkey,
        DROP COLUMN line_id,
        DROP COLUMN revision,
        DROP COLUMN content_identity,
        DROP COLUMN draft_id,
        DROP COLUMN draft_revision,
        DROP COLUMN template_version_id,
        DROP COLUMN normalization_version,
        ADD CONSTRAINT customer_cart_items_pkey PRIMARY KEY (customer_id, sku_id)
    `.execute(db)
    await sql`ALTER TABLE storefront_customer_policy DROP COLUMN purchase_forms_enabled`.execute(db)
  },
}
