import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Tighten ⑥-2B data gates without rewriting any sealed transaction. */
export const purchaseSnapshotManifestR1Migration: Migration = {
  async up(db) {
    // Inspect one stable committed state before validating or changing gates.
    // A failed audit rolls this migration back and leaves historical rows intact.
    // The archive cleaner locks objects before reading references. Keep that
    // direction here too, after orders blocks new order creation.
    await sql`LOCK TABLE orders, order_items, order_item_purchase_snapshots,
      purchase_order_attachment_objects, order_item_purchase_attachments
      IN ACCESS EXCLUSIVE MODE`.execute(db)

    await sql`
      CREATE FUNCTION purchase_order_attachment_manifest_is_valid(ids uuid[]) RETURNS boolean
      LANGUAGE sql IMMUTABLE STRICT AS $$
        SELECT CASE
          WHEN cardinality(ids) = 0 THEN array_ndims(ids) IS NULL
          WHEN array_ndims(ids) IS DISTINCT FROM 1
            OR array_lower(ids, 1) IS DISTINCT FROM 1 THEN false
          ELSE cardinality(ids) BETWEEN 1 AND 10
            AND array_upper(ids, 1) = cardinality(ids)
            AND cardinality(ids) = (SELECT count(DISTINCT id) FROM unnest(ids) AS id)
        END;
      $$
    `.execute(db)

    await sql`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM order_item_purchase_snapshots AS snap WHERE (
            (snap.template_version_id IS NULL AND snap.normalization_version IS NULL
              AND snap.encrypted_values IS NULL AND snap.values_nonce IS NULL
              AND snap.values_auth_tag IS NULL AND snap.encryption_key_id IS NULL
              AND cardinality(snap.attachment_ids) = 0)
            OR (snap.template_version_id IS NOT NULL AND snap.normalization_version IS NOT NULL
              AND snap.normalization_version = 1 AND snap.encrypted_values IS NOT NULL
              AND snap.values_nonce IS NOT NULL AND snap.values_auth_tag IS NOT NULL
              AND snap.encryption_key_id IS NOT NULL
              AND octet_length(snap.encrypted_values) BETWEEN 1 AND 65536
              AND octet_length(snap.values_nonce) = 12 AND octet_length(snap.values_auth_tag) = 16
              AND snap.encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
              AND cardinality(snap.attachment_ids) BETWEEN 0 AND 10)
          ) IS NOT TRUE
        ) THEN
          RAISE EXCEPTION 'Existing purchase snapshot has an invalid or unsupported normalization shape; audit required'
            USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_snapshot_existing_shape_invalid';
        END IF;
        IF EXISTS (
          SELECT 1 FROM order_item_purchase_snapshots AS snap
          WHERE purchase_order_attachment_manifest_is_valid(snap.attachment_ids) IS NOT TRUE
        ) OR EXISTS (
          SELECT 1 FROM order_item_purchase_attachments AS ref
          LEFT JOIN order_item_purchase_snapshots AS snap ON snap.order_item_id = ref.order_item_id
          LEFT JOIN purchase_order_attachment_objects AS object ON object.id = ref.archive_object_id
          WHERE snap.order_item_id IS NULL
            OR ref.ordinal < 1 OR ref.ordinal > cardinality(snap.attachment_ids)
            OR ref.source_attachment_id IS DISTINCT FROM snap.attachment_ids[ref.ordinal]
            OR object.id IS NULL OR object.status IS DISTINCT FROM 'retained'
            OR object.source_attachment_id IS DISTINCT FROM ref.source_attachment_id
            OR object.sha256 IS DISTINCT FROM ref.sha256 OR object.byte_size IS DISTINCT FROM ref.byte_size
        ) OR EXISTS (
          SELECT 1 FROM order_item_purchase_snapshots AS snap
          WHERE cardinality(snap.attachment_ids) <> (
            SELECT count(*) FROM order_item_purchase_attachments AS ref WHERE ref.order_item_id = snap.order_item_id)
        ) THEN
          RAISE EXCEPTION 'Existing purchase attachment manifest is not a canonical ordered pairing; audit required'
            USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_attachment_existing_manifest_invalid';
        END IF;
      END;
      $$
    `.execute(db)

    await sql`
      ALTER TABLE order_item_purchase_snapshots
        DROP CONSTRAINT order_item_purchase_snapshots_shape_check,
        ADD CONSTRAINT order_item_purchase_snapshots_shape_check CHECK ((
          (template_version_id IS NULL AND normalization_version IS NULL
            AND encrypted_values IS NULL AND values_nonce IS NULL
            AND values_auth_tag IS NULL AND encryption_key_id IS NULL
            AND cardinality(attachment_ids) = 0)
          OR (template_version_id IS NOT NULL AND normalization_version IS NOT NULL
            AND normalization_version = 1
            AND encrypted_values IS NOT NULL AND values_nonce IS NOT NULL
            AND values_auth_tag IS NOT NULL AND encryption_key_id IS NOT NULL
            AND octet_length(encrypted_values) BETWEEN 1 AND 65536
            AND octet_length(values_nonce) = 12 AND octet_length(values_auth_tag) = 16
            AND encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND cardinality(attachment_ids) BETWEEN 0 AND 10)
        ) IS TRUE),
        ADD CONSTRAINT order_item_purchase_snapshots_manifest_check
          CHECK (purchase_order_attachment_manifest_is_valid(attachment_ids) IS TRUE)
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION assert_order_purchase_snapshots_on_seal() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE item_row record; snap order_item_purchase_snapshots%ROWTYPE;
      DECLARE reference_count integer;
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
          SELECT * INTO snap FROM order_item_purchase_snapshots WHERE order_item_id = item_row.id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Every order item requires a sealed purchase snapshot'
              USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_snapshot_required';
          END IF;
          IF snap.template_version_id IS NOT NULL AND snap.normalization_version IS DISTINCT FROM 1 THEN
            RAISE EXCEPTION 'Filled purchase snapshots require a supported normalization version'
              USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_normalization_version_invalid';
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
          reference_count := cardinality(snap.attachment_ids);
          IF purchase_order_attachment_manifest_is_valid(snap.attachment_ids) IS NOT TRUE
            OR reference_count <> (SELECT count(*) FROM order_item_purchase_attachments
              WHERE order_item_id = item_row.id)
            OR EXISTS (
              SELECT 1 FROM order_item_purchase_attachments AS ref
              LEFT JOIN purchase_order_attachment_objects AS object ON object.id = ref.archive_object_id
              WHERE ref.order_item_id = item_row.id
                AND (ref.ordinal < 1 OR ref.ordinal > reference_count
                  OR ref.source_attachment_id IS DISTINCT FROM snap.attachment_ids[ref.ordinal]
                  OR object.id IS NULL OR object.status IS DISTINCT FROM 'retained'
                  OR object.source_attachment_id IS DISTINCT FROM ref.source_attachment_id
                  OR object.sha256 IS DISTINCT FROM ref.sha256 OR object.byte_size IS DISTINCT FROM ref.byte_size)
            ) THEN
            RAISE EXCEPTION 'Purchase snapshot attachments are incomplete, unordered or unretained'
              USING ERRCODE = '23514', CONSTRAINT = 'order_purchase_attachment_manifest_invalid';
          END IF;
        END LOOP;
        RETURN NEW;
      END;
      $$
    `.execute(db)
  },
  // Retain the established isolated empty-state rollback path. Existing
  // snapshots or objects block a downgrade that would loosen their gates.
  async down(db) {
    await sql`LOCK TABLE orders, order_items, order_item_purchase_snapshots,
      purchase_order_attachment_objects, order_item_purchase_attachments
      IN ACCESS EXCLUSIVE MODE`.execute(db)
    const present = await sql<{ present: boolean }>`SELECT EXISTS (
      SELECT 1 FROM order_item_purchase_snapshots
      UNION ALL SELECT 1 FROM order_item_purchase_attachments
      UNION ALL SELECT 1 FROM purchase_order_attachment_objects
    ) AS present`.execute(db)
    if (present.rows[0]?.present) {
      throw new Error('Cannot downgrade purchase snapshot gates while snapshots or archived objects exist')
    }
    await sql`ALTER TABLE order_item_purchase_snapshots
      DROP CONSTRAINT order_item_purchase_snapshots_manifest_check,
      DROP CONSTRAINT order_item_purchase_snapshots_shape_check,
      ADD CONSTRAINT order_item_purchase_snapshots_shape_check CHECK (
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
      )`.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION assert_order_purchase_snapshots_on_seal() RETURNS trigger
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
    await sql`DROP FUNCTION purchase_order_attachment_manifest_is_valid(uuid[])`.execute(db)
  },
}
