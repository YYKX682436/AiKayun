import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Adds file objects to the existing immutable digital fulfillment version and order-delivery model. */
export const privateFileDeliveryMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE private_file_objects (
        id uuid PRIMARY KEY,
        uploaded_by_admin_id uuid NOT NULL,
        upload_filename varchar(255) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'uploading',
        media_type varchar(96),
        size_bytes integer,
        sha256 char(64),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        expires_at timestamptz NOT NULL,
        CONSTRAINT private_file_objects_admin_fkey FOREIGN KEY (uploaded_by_admin_id)
          REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT private_file_objects_status_check
          CHECK (status IN ('uploading', 'staged', 'available', 'missing', 'corrupt', 'failed')),
        CONSTRAINT private_file_objects_filename_check
          CHECK (btrim(upload_filename) <> '' AND char_length(upload_filename) <= 255),
        CONSTRAINT private_file_objects_metadata_check CHECK (
          (status IN ('uploading', 'failed') AND media_type IS NULL AND size_bytes IS NULL AND sha256 IS NULL)
          OR (status IN ('staged', 'available', 'missing', 'corrupt')
            AND media_type IN (
              'application/zip', 'application/pdf', 'text/plain; charset=utf-8',
              'text/markdown; charset=utf-8', 'text/csv; charset=utf-8', 'application/json; charset=utf-8',
              'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'audio/mpeg', 'video/mp4'
            )
            AND size_bytes BETWEEN 1 AND 104857600 AND sha256 ~ '^[0-9a-f]{64}$')
        ),
        CONSTRAINT private_file_objects_expiration_check CHECK (expires_at > created_at)
      )
    `.execute(db)
    await sql`CREATE INDEX private_file_objects_cleanup_idx
      ON private_file_objects (expires_at, id) WHERE status IN ('uploading', 'staged', 'failed')`.execute(db)

    await sql`
      CREATE FUNCTION guard_private_file_object() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF EXISTS (SELECT 1 FROM product_variant_fulfillment_versions AS version
            WHERE version.private_file_object_id = OLD.id) THEN
            RAISE EXCEPTION 'Private file objects referenced by fulfillment history are permanent'
              USING ERRCODE = '23514', CONSTRAINT = 'private_file_object_history_immutable';
          END IF;
          RETURN OLD;
        END IF;
        IF ROW(NEW.id, NEW.uploaded_by_admin_id, NEW.upload_filename, NEW.created_at, NEW.expires_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.uploaded_by_admin_id, OLD.upload_filename, OLD.created_at, OLD.expires_at) THEN
          RAISE EXCEPTION 'Private file upload identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'private_file_object_identity_immutable';
        END IF;
        IF ROW(NEW.media_type, NEW.size_bytes, NEW.sha256) IS DISTINCT FROM ROW(OLD.media_type, OLD.size_bytes, OLD.sha256)
          AND NOT (OLD.status = 'uploading' AND NEW.status = 'staged') THEN
          RAISE EXCEPTION 'Private file content metadata is immutable after upload validation'
            USING ERRCODE = '23514', CONSTRAINT = 'private_file_object_metadata_immutable';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
          (OLD.status = 'uploading' AND NEW.status IN ('staged', 'failed'))
          OR (OLD.status = 'staged' AND NEW.status IN ('available', 'failed'))
          OR (OLD.status = 'available' AND NEW.status IN ('missing', 'corrupt'))
          OR (OLD.status IN ('missing', 'corrupt') AND NEW.status IN ('available', 'missing', 'corrupt'))
        ) THEN
          RAISE EXCEPTION 'Private file object status transition is invalid'
            USING ERRCODE = '23514', CONSTRAINT = 'private_file_object_status_transition';
        END IF;
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER private_file_objects_guard
      BEFORE UPDATE OR DELETE ON private_file_objects
      FOR EACH ROW EXECUTE FUNCTION guard_private_file_object()`.execute(db)
    await sql`CREATE TRIGGER private_file_objects_prevent_truncate
      BEFORE TRUNCATE ON private_file_objects FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      ALTER TABLE product_variant_fulfillment_versions
        ALTER COLUMN encrypted_content DROP NOT NULL,
        ALTER COLUMN content_nonce DROP NOT NULL,
        ALTER COLUMN content_auth_tag DROP NOT NULL,
        ALTER COLUMN encryption_key_id DROP NOT NULL,
        ADD COLUMN private_file_object_id uuid,
        ADD COLUMN display_filename varchar(255),
        DROP CONSTRAINT product_variant_fulfillment_versions_method_check,
        DROP CONSTRAINT product_variant_fulfillment_versions_ciphertext_check,
        DROP CONSTRAINT product_variant_fulfillment_versions_nonce_check,
        DROP CONSTRAINT product_variant_fulfillment_versions_tag_check,
        DROP CONSTRAINT product_variant_fulfillment_versions_key_check,
        ADD CONSTRAINT product_variant_fulfillment_versions_method_check CHECK (method IN ('fixed_content', 'link', 'file')),
        ADD CONSTRAINT product_variant_fulfillment_versions_content_shape_check CHECK (
          (method IN ('fixed_content', 'link')
            AND encrypted_content IS NOT NULL AND octet_length(encrypted_content) BETWEEN 1 AND 65536
            AND content_nonce IS NOT NULL AND octet_length(content_nonce) = 12
            AND content_auth_tag IS NOT NULL AND octet_length(content_auth_tag) = 16
            AND encryption_key_id IS NOT NULL AND encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND private_file_object_id IS NULL AND display_filename IS NULL)
          OR (method = 'file'
            AND encrypted_content IS NULL AND content_nonce IS NULL AND content_auth_tag IS NULL
            AND encryption_key_id IS NULL AND private_file_object_id IS NOT NULL
            AND display_filename IS NOT NULL AND btrim(display_filename) <> ''
            AND char_length(display_filename) <= 255)
        ),
        ADD CONSTRAINT product_variant_fulfillment_versions_file_object_fkey
          FOREIGN KEY (private_file_object_id) REFERENCES private_file_objects (id) ON DELETE RESTRICT
    `.execute(db)

    await sql`
      CREATE FUNCTION guard_private_file_version_object() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE object_status varchar(16); object_sha256 char(64);
      BEGIN
        IF NEW.method <> 'file' THEN RETURN NEW; END IF;
        SELECT status, sha256 INTO object_status, object_sha256
        FROM private_file_objects WHERE id = NEW.private_file_object_id FOR SHARE;
        IF object_status IS DISTINCT FROM 'available' OR object_sha256 IS DISTINCT FROM NEW.content_sha256 THEN
          RAISE EXCEPTION 'File fulfillment versions require a persisted available object with matching SHA-256'
            USING ERRCODE = '23514', CONSTRAINT = 'private_file_version_object_not_available';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER product_variant_fulfillment_private_file_guard
      BEFORE INSERT ON product_variant_fulfillment_versions
      FOR EACH ROW EXECUTE FUNCTION guard_private_file_version_object()`.execute(db)

    await sql`
      ALTER TABLE product_variant_fulfillment
        DROP CONSTRAINT product_variant_fulfillment_content_version_shape_check,
        DROP CONSTRAINT product_variant_fulfillment_readiness_shape_check,
        ADD CONSTRAINT product_variant_fulfillment_content_version_shape_check CHECK (
          (method IN ('fixed_content', 'link', 'file') AND current_content_version_id IS NOT NULL)
          OR (method NOT IN ('fixed_content', 'link', 'file') AND current_content_version_id IS NULL)
        ),
        ADD CONSTRAINT product_variant_fulfillment_readiness_shape_check CHECK (
          (NOT manual_delivery_ready OR method = 'manual')
          AND (NOT code_pool_delivery_ready OR method = 'code_pool')
          AND (NOT automatic_delivery_ready OR method IN ('fixed_content', 'link', 'file'))
        )
    `.execute(db)

    await sql`
      ALTER TABLE order_items
        DROP CONSTRAINT order_items_fulfillment_version_shape_check,
        ADD CONSTRAINT order_items_fulfillment_version_shape_check CHECK (
          (fulfillment_method_snapshot IN ('fixed_content', 'link', 'file') AND fulfillment_content_version_id IS NOT NULL)
          OR (fulfillment_method_snapshot NOT IN ('fixed_content', 'link', 'file') AND fulfillment_content_version_id IS NULL)
        )
    `.execute(db)

    await sql`
      ALTER TABLE order_item_fulfillment_attempts
        DROP CONSTRAINT order_item_fulfillment_attempts_source_check,
        DROP CONSTRAINT order_item_fulfillment_attempts_failure_check,
        ADD CONSTRAINT order_item_fulfillment_attempts_source_check
          CHECK (delivery_source IN ('manual', 'code_pool', 'fixed_content', 'link', 'file')),
        ADD CONSTRAINT order_item_fulfillment_attempts_failure_check CHECK (
          (failure_code IS NULL AND retry_after IS NULL)
          OR (
            delivery_source IN ('code_pool', 'fixed_content', 'link', 'file') AND status = 'failed'
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
              OR (delivery_source = 'file' AND failure_code IN (
                'FILE_DELIVERY_DATA_INCONSISTENT', 'FILE_DELIVERY_OBJECT_UNAVAILABLE',
                'FILE_DELIVERY_INTEGRITY_FAILED', 'FILE_DELIVERY_PAYMENT_UNRESOLVED'
              ))
            )
          )
        )
    `.execute(db)

    await sql`
      ALTER TABLE order_item_fulfillment_deliveries
        DROP CONSTRAINT order_item_fulfillment_deliveries_source_check,
        DROP CONSTRAINT order_item_fulfillment_deliveries_content_check,
        ADD CONSTRAINT order_item_fulfillment_deliveries_source_check
          CHECK (delivery_source IN ('manual', 'code_pool', 'fixed_content', 'link', 'file')),
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
          OR (delivery_source = 'file' AND started_by_admin_id IS NULL AND content IS NULL
            AND encrypted_content IS NULL AND content_nonce IS NULL AND content_auth_tag IS NULL
            AND encryption_key_id IS NULL AND code_pool_entry_id IS NULL
            AND fulfillment_content_version_id IS NOT NULL)
        )
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION guard_fixed_delivery_config() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE sku product_variants%ROWTYPE; product_type varchar(16); object_status varchar(16);
      BEGIN
        IF NEW.method IN ('fixed_content', 'link', 'file') THEN
          SELECT * INTO sku FROM product_variants WHERE id = NEW.product_variant_id;
          SELECT product.product_type INTO product_type FROM products AS product WHERE product.id = sku.product_id;
          IF product_type IS DISTINCT FROM 'digital' OR sku.inventory_mode IS NULL
            OR sku.inventory_mode NOT IN ('quantity', 'unlimited') THEN
            RAISE EXCEPTION 'Automatic digital delivery requires a digital SKU with quantity or unlimited inventory'
              USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_sku_not_supported';
          END IF;
          IF NEW.method = 'file' AND NEW.current_content_version_id IS NOT NULL THEN
            SELECT object.status INTO object_status
            FROM product_variant_fulfillment_versions AS version
            JOIN private_file_objects AS object ON object.id = version.private_file_object_id
            WHERE version.id = NEW.current_content_version_id;
            IF NEW.automatic_delivery_ready AND object_status IS DISTINCT FROM 'available' THEN
              RAISE EXCEPTION 'File fulfillment version is not available'
                USING ERRCODE = '23514', CONSTRAINT = 'file_delivery_object_not_available';
            END IF;
          END IF;
          IF NEW.automatic_delivery_ready AND (NOT sku.enabled OR sku.retired_at IS NOT NULL
            OR NEW.current_content_version_id IS NULL) THEN
            RAISE EXCEPTION 'Automatic delivery requires a saved version and a sellable SKU'
              USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_readiness_invalid';
          END IF;
        ELSIF NEW.automatic_delivery_ready OR NEW.current_content_version_id IS NOT NULL THEN
          RAISE EXCEPTION 'Only automatic delivery methods can reference fulfillment versions'
            USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_method_shape_invalid';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION validate_order_manual_fulfillment_readiness() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        product_type varchar(16); configured_method varchar(24); manual_ready boolean;
        code_pool_ready boolean; automatic_ready boolean; current_version uuid;
        inventory_mode varchar(16); file_status varchar(16);
      BEGIN
        SELECT product.product_type, variant.inventory_mode, fulfillment.method,
          fulfillment.manual_delivery_ready, fulfillment.code_pool_delivery_ready,
          fulfillment.automatic_delivery_ready, fulfillment.current_content_version_id,
          object.status
          INTO product_type, inventory_mode, configured_method, manual_ready,
            code_pool_ready, automatic_ready, current_version, file_status
        FROM products AS product
        JOIN product_variants AS variant ON variant.product_id = product.id
        LEFT JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
        LEFT JOIN product_variant_fulfillment_versions AS version
          ON version.id = fulfillment.current_content_version_id
        LEFT JOIN private_file_objects AS object ON object.id = version.private_file_object_id
        WHERE product.id = NEW.product_id AND variant.id = NEW.product_variant_id;
        IF product_type IS DISTINCT FROM 'digital' OR configured_method IS NULL
          OR NEW.fulfillment_method_snapshot IS DISTINCT FROM configured_method
          OR (configured_method = 'manual' AND manual_ready IS DISTINCT FROM true)
          OR (configured_method = 'code_pool' AND (code_pool_ready IS DISTINCT FROM true OR inventory_mode IS DISTINCT FROM 'quantity'))
          OR (configured_method IN ('fixed_content', 'link') AND (automatic_ready IS DISTINCT FROM true
            OR current_version IS DISTINCT FROM NEW.fulfillment_content_version_id))
          OR (configured_method = 'file' AND (automatic_ready IS DISTINCT FROM true
            OR current_version IS DISTINCT FROM NEW.fulfillment_content_version_id OR file_status IS DISTINCT FROM 'available'))
          OR (configured_method NOT IN ('manual', 'code_pool', 'fixed_content', 'link', 'file')
            OR (configured_method NOT IN ('fixed_content', 'link', 'file') AND NEW.fulfillment_content_version_id IS NOT NULL)) THEN
          RAISE EXCEPTION 'Only explicitly ready manual, code-pool, fixed-content, link or file digital SKUs can be ordered'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_digital_fulfillment_not_ready';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION guard_code_pool_fulfillment_attempt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE method_name varchar(24); delivery_count bigint; parent_status varchar(24);
        order_total numeric(18,2); parent_order uuid; version_id uuid; file_object_status varchar(16);
      BEGIN
        SELECT fulfillment_method_snapshot, fulfillment_content_version_id
          INTO method_name, version_id FROM order_items WHERE id = NEW.order_item_id;
        IF TG_OP = 'INSERT' THEN
          IF NEW.delivery_source IS DISTINCT FROM method_name
            OR (NEW.delivery_source = 'manual' AND NEW.started_by_admin_id IS NULL)
            OR (NEW.delivery_source IN ('code_pool', 'fixed_content', 'link', 'file') AND NEW.started_by_admin_id IS NOT NULL) THEN
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
          AND NEW.delivery_source IN ('code_pool', 'fixed_content', 'link', 'file') THEN
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
          ELSIF NEW.delivery_source IN ('fixed_content', 'link') THEN
            SELECT count(*) INTO delivery_count FROM order_item_fulfillment_deliveries AS delivery
            WHERE delivery.fulfillment_attempt_id = NEW.id AND delivery.delivery_source = NEW.delivery_source
              AND delivery.encrypted_content IS NOT NULL
              AND delivery.fulfillment_content_version_id IS NOT DISTINCT FROM version_id;
            IF version_id IS NULL OR delivery_count <> NEW.quantity THEN
              RAISE EXCEPTION 'Fixed-content delivery requires one encrypted private delivery per unit and its bound version'
                USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_records_required';
            END IF;
          ELSE
            SELECT count(*) INTO delivery_count FROM order_item_fulfillment_deliveries AS delivery
            WHERE delivery.fulfillment_attempt_id = NEW.id AND delivery.delivery_source = 'file'
              AND delivery.content IS NULL AND delivery.encrypted_content IS NULL
              AND delivery.fulfillment_content_version_id IS NOT DISTINCT FROM version_id
              AND EXISTS (
                SELECT 1 FROM product_variant_fulfillment_versions AS version
                JOIN private_file_objects AS object ON object.id = version.private_file_object_id
                WHERE version.id = delivery.fulfillment_content_version_id
                  AND version.method = 'file' AND object.status = 'available'
                  AND version.content_sha256 = delivery.content_sha256
              );
            SELECT object.status INTO file_object_status
            FROM product_variant_fulfillment_versions AS version
            JOIN private_file_objects AS object ON object.id = version.private_file_object_id
            WHERE version.id = version_id AND version.method = 'file';
            IF file_object_status IS DISTINCT FROM 'available' THEN
              RAISE EXCEPTION 'File delivery object is not available at fulfillment commit'
                USING ERRCODE = '23514', CONSTRAINT = 'file_delivery_object_not_available';
            END IF;
            IF version_id IS NULL OR delivery_count <> NEW.quantity THEN
              RAISE EXCEPTION 'File delivery requires one version reference per fulfilled unit'
                USING ERRCODE = '23514', CONSTRAINT = 'file_delivery_records_required';
            END IF;
          END IF;
        END IF;
        IF NEW.failure_code IS NOT NULL AND (NEW.delivery_source NOT IN ('code_pool', 'fixed_content', 'link', 'file')
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
        entry_item uuid; item_version uuid; attempt_item uuid; file_status varchar(16); file_digest char(64);
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
          RAISE EXCEPTION 'Automatic delivery must match its order item method and bound version'
            USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_version_mismatch';
        END IF;
        IF NEW.delivery_source = 'file' AND (NEW.encrypted_content IS NOT NULL OR NEW.content_nonce IS NOT NULL
          OR NEW.content_auth_tag IS NOT NULL OR NEW.encryption_key_id IS NOT NULL) THEN
          RAISE EXCEPTION 'File delivery history stores a version reference without file bytes or encrypted copies'
            USING ERRCODE = '23514', CONSTRAINT = 'file_delivery_reference_only';
        END IF;
        IF NEW.delivery_source = 'file' THEN
          SELECT object.status, version.content_sha256 INTO file_status, file_digest
          FROM product_variant_fulfillment_versions AS version
          JOIN private_file_objects AS object ON object.id = version.private_file_object_id
          WHERE version.id = NEW.fulfillment_content_version_id AND version.method = 'file';
          IF file_status IS DISTINCT FROM 'available' OR file_digest IS DISTINCT FROM NEW.content_sha256 THEN
            RAISE EXCEPTION 'File delivery requires an available immutable object with a matching digest'
              USING ERRCODE = '23514', CONSTRAINT = 'file_delivery_object_not_available';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE INDEX private_file_version_object_idx
      ON product_variant_fulfillment_versions (private_file_object_id)
      WHERE private_file_object_id IS NOT NULL`.execute(db)
  },

  async down() {
    throw new Error('Private-file fulfillment history is immutable; this migration is forward-only.')
  },
}
