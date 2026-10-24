import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const purchaseFormsDraftsMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE purchase_form_templates (
        id uuid PRIMARY KEY,
        name varchar(120) NOT NULL,
        definition jsonb NOT NULL,
        revision integer NOT NULL DEFAULT 1,
        latest_version_number integer NOT NULL DEFAULT 0,
        created_by_admin_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE RESTRICT,
        updated_by_admin_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT purchase_form_templates_name_check CHECK (btrim(name) <> ''),
        CONSTRAINT purchase_form_templates_revision_check CHECK (revision >= 1),
        CONSTRAINT purchase_form_templates_version_check CHECK (latest_version_number >= 0),
        CONSTRAINT purchase_form_templates_definition_object_check CHECK (jsonb_typeof(definition) = 'object')
      )
    `.execute(db)
    await sql`CREATE INDEX purchase_form_templates_updated_idx ON purchase_form_templates (updated_at DESC, id)`.execute(db)

    await sql`
      CREATE TABLE purchase_form_template_versions (
        id uuid PRIMARY KEY,
        template_id uuid NOT NULL REFERENCES purchase_form_templates (id) ON DELETE RESTRICT,
        version_number integer NOT NULL,
        name varchar(120) NOT NULL,
        definition jsonb NOT NULL,
        sha256 char(64) NOT NULL,
        created_by_admin_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT purchase_form_template_versions_number_check CHECK (version_number >= 1),
        CONSTRAINT purchase_form_template_versions_name_check CHECK (btrim(name) <> ''),
        CONSTRAINT purchase_form_template_versions_hash_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT purchase_form_template_versions_definition_object_check CHECK (jsonb_typeof(definition) = 'object'),
        CONSTRAINT purchase_form_template_versions_number_unique UNIQUE (template_id, version_number),
        CONSTRAINT purchase_form_template_versions_template_id_unique UNIQUE (template_id, id)
      )
    `.execute(db)
    await sql`CREATE INDEX purchase_form_template_versions_history_idx
      ON purchase_form_template_versions (template_id, version_number DESC)`.execute(db)

    await sql`
      CREATE TABLE purchase_form_template_identities (
        template_id uuid NOT NULL REFERENCES purchase_form_templates (id) ON DELETE RESTRICT,
        id uuid NOT NULL,
        identity_kind varchar(8) NOT NULL,
        meaning_key varchar(64) NOT NULL,
        semantic_type varchar(16),
        parent_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (template_id, id),
        CONSTRAINT purchase_form_identity_kind_check CHECK (identity_kind IN ('field', 'option')),
        CONSTRAINT purchase_form_identity_meaning_check CHECK (meaning_key ~ '^[a-z][a-z0-9_]{0,63}$'),
        CONSTRAINT purchase_form_identity_type_check CHECK (
          (identity_kind = 'field' AND semantic_type IN ('text', 'textarea', 'digits', 'select', 'cascade', 'image')) OR
          (identity_kind = 'option' AND semantic_type IS NULL)
        ),
        CONSTRAINT purchase_form_identity_parent_check CHECK (parent_id IS NULL OR parent_id <> id),
        CONSTRAINT purchase_form_identity_parent_fkey FOREIGN KEY (template_id, parent_id)
          REFERENCES purchase_form_template_identities (template_id, id) DEFERRABLE INITIALLY DEFERRED
      )
    `.execute(db)

    await sql`
      CREATE TABLE product_purchase_form_settings (
        product_id uuid PRIMARY KEY REFERENCES products (id) ON DELETE RESTRICT,
        mode varchar(16) NOT NULL,
        template_version_id uuid,
        updated_by_admin_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE RESTRICT,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_purchase_form_mode_check CHECK (mode IN ('none', 'template')),
        CONSTRAINT product_purchase_form_mode_version_check CHECK (
          (mode = 'template' AND template_version_id IS NOT NULL) OR
          (mode = 'none' AND template_version_id IS NULL)
        ),
        CONSTRAINT product_purchase_form_version_fkey FOREIGN KEY (template_version_id)
          REFERENCES purchase_form_template_versions (id) ON DELETE RESTRICT
      )
    `.execute(db)

    await sql`
      CREATE TABLE sku_purchase_form_overrides (
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        mode varchar(16) NOT NULL,
        template_version_id uuid,
        updated_by_admin_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE RESTRICT,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (product_id, product_variant_id),
        CONSTRAINT sku_purchase_form_mode_check CHECK (mode IN ('none', 'template')),
        CONSTRAINT sku_purchase_form_mode_version_check CHECK (
          (mode = 'template' AND template_version_id IS NOT NULL) OR
          (mode = 'none' AND template_version_id IS NULL)
        ),
        CONSTRAINT sku_purchase_form_variant_fkey FOREIGN KEY (product_id, product_variant_id)
          REFERENCES product_variants (product_id, id) ON DELETE RESTRICT,
        CONSTRAINT sku_purchase_form_version_fkey FOREIGN KEY (template_version_id)
          REFERENCES purchase_form_template_versions (id) ON DELETE RESTRICT
      )
    `.execute(db)

    await sql`
      CREATE TABLE purchase_form_audit_events (
        id uuid PRIMARY KEY,
        administrator_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE RESTRICT,
        operation varchar(32) NOT NULL,
        template_id uuid REFERENCES purchase_form_templates (id) ON DELETE RESTRICT,
        product_id uuid REFERENCES products (id) ON DELETE RESTRICT,
        product_variant_id uuid REFERENCES product_variants (id) ON DELETE RESTRICT,
        summary jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT purchase_form_audit_operation_check CHECK (operation IN (
          'template_created', 'template_updated', 'template_version_saved',
          'product_assignment_updated', 'sku_override_updated'
        )),
        CONSTRAINT purchase_form_audit_scope_check CHECK (
          (operation IN ('template_created', 'template_updated', 'template_version_saved')
            AND template_id IS NOT NULL AND product_id IS NULL AND product_variant_id IS NULL) OR
          (operation = 'product_assignment_updated' AND product_id IS NOT NULL
            AND template_id IS NULL AND product_variant_id IS NULL) OR
          (operation = 'sku_override_updated' AND product_id IS NOT NULL
            AND product_variant_id IS NOT NULL AND template_id IS NULL)
        ),
        CONSTRAINT purchase_form_audit_summary_object_check CHECK (jsonb_typeof(summary) = 'object')
      )
    `.execute(db)
    await sql`CREATE INDEX purchase_form_audit_template_idx ON purchase_form_audit_events (template_id, created_at DESC, id) WHERE template_id IS NOT NULL`.execute(db)
    await sql`CREATE INDEX purchase_form_audit_product_idx ON purchase_form_audit_events (product_id, created_at DESC, id) WHERE product_id IS NOT NULL`.execute(db)

    await sql`
      CREATE TABLE purchase_drafts (
        id uuid PRIMARY KEY,
        customer_id uuid,
        guest_order_session_id uuid,
        claimed_from_guest_order_session_id uuid,
        template_version_id uuid NOT NULL REFERENCES purchase_form_template_versions (id) ON DELETE RESTRICT,
        normalization_version smallint NOT NULL DEFAULT 1,
        revision integer NOT NULL DEFAULT 1,
        status varchar(16) NOT NULL DEFAULT 'active',
        encrypted_payload bytea NOT NULL,
        payload_nonce bytea NOT NULL,
        payload_auth_tag bytea NOT NULL,
        encryption_key_id varchar(48) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        CONSTRAINT purchase_drafts_customer_fkey FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
        CONSTRAINT purchase_drafts_guest_session_fkey FOREIGN KEY (guest_order_session_id) REFERENCES guest_order_sessions (id) ON DELETE RESTRICT,
        CONSTRAINT purchase_drafts_claimed_guest_fkey FOREIGN KEY (claimed_from_guest_order_session_id) REFERENCES guest_order_sessions (id) ON DELETE RESTRICT,
        CONSTRAINT purchase_drafts_single_owner_check CHECK (num_nonnulls(customer_id, guest_order_session_id) = 1),
        CONSTRAINT purchase_drafts_claimed_guest_check CHECK (claimed_from_guest_order_session_id IS NULL OR (customer_id IS NOT NULL AND guest_order_session_id IS NULL)),
        CONSTRAINT purchase_drafts_version_check CHECK (normalization_version = 1),
        CONSTRAINT purchase_drafts_revision_check CHECK (revision >= 1),
        CONSTRAINT purchase_drafts_status_check CHECK (status IN ('active', 'deleting')),
        CONSTRAINT purchase_drafts_ciphertext_check CHECK (octet_length(encrypted_payload) BETWEEN 1 AND 65536),
        CONSTRAINT purchase_drafts_nonce_check CHECK (octet_length(payload_nonce) = 12),
        CONSTRAINT purchase_drafts_auth_tag_check CHECK (octet_length(payload_auth_tag) = 16),
        CONSTRAINT purchase_drafts_key_id_check CHECK (encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'),
        CONSTRAINT purchase_drafts_expiration_check CHECK (expires_at > created_at)
      )
    `.execute(db)
    await sql`CREATE INDEX purchase_drafts_customer_expiry_idx ON purchase_drafts (customer_id, expires_at, id) WHERE status = 'active' AND customer_id IS NOT NULL`.execute(db)
    await sql`CREATE INDEX purchase_drafts_guest_expiry_idx ON purchase_drafts (guest_order_session_id, expires_at, id) WHERE status = 'active' AND guest_order_session_id IS NOT NULL`.execute(db)
    await sql`CREATE INDEX purchase_drafts_expiry_idx ON purchase_drafts (expires_at, id)`.execute(db)

    await sql`
      CREATE TABLE purchase_draft_attachments (
        id uuid PRIMARY KEY,
        draft_id uuid NOT NULL REFERENCES purchase_drafts (id) ON DELETE RESTRICT,
        field_id uuid NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'uploading',
        storage_key varchar(160) NOT NULL,
        mime_type varchar(24) NOT NULL DEFAULT 'image/webp',
        byte_size integer,
        reserved_bytes integer NOT NULL,
        width integer,
        height integer,
        sha256 char(64),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT purchase_draft_attachments_draft_id_unique UNIQUE (draft_id, id),
        CONSTRAINT purchase_draft_attachments_status_check CHECK (status IN ('uploading', 'ready', 'failed', 'deleting')),
        CONSTRAINT purchase_draft_attachments_storage_key_check CHECK (storage_key ~ '^objects/[0-9a-f]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$'),
        CONSTRAINT purchase_draft_attachments_mime_check CHECK (mime_type = 'image/webp'),
        CONSTRAINT purchase_draft_attachments_reserved_check CHECK (reserved_bytes BETWEEN 1 AND 5242880),
        CONSTRAINT purchase_draft_attachments_ready_metadata_check CHECK (
          status <> 'ready' OR (byte_size IS NOT NULL AND byte_size BETWEEN 1 AND 5242880
            AND width IS NOT NULL AND width BETWEEN 1 AND 8192
            AND height IS NOT NULL AND height BETWEEN 1 AND 8192
            AND sha256 IS NOT NULL AND sha256 ~ '^[0-9a-f]{64}$')
        ),
        CONSTRAINT purchase_draft_attachments_sha_check CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$')
      )
    `.execute(db)
    await sql`CREATE INDEX purchase_draft_attachments_draft_idx ON purchase_draft_attachments (draft_id, status, created_at, id)`.execute(db)
    await sql`CREATE INDEX purchase_draft_attachments_cleanup_idx ON purchase_draft_attachments (status, created_at, id) WHERE status IN ('uploading', 'failed', 'deleting')`.execute(db)

    await sql`
      CREATE TABLE purchase_draft_attachment_references (
        draft_id uuid NOT NULL,
        attachment_id uuid NOT NULL,
        field_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (draft_id, attachment_id),
        CONSTRAINT purchase_draft_attachment_reference_object_fkey FOREIGN KEY (draft_id, attachment_id)
          REFERENCES purchase_draft_attachments (draft_id, id) ON DELETE RESTRICT
      )
    `.execute(db)
    await sql`CREATE INDEX purchase_draft_attachment_references_attachment_idx ON purchase_draft_attachment_references (attachment_id)`.execute(db)

    await sql`
      CREATE FUNCTION protect_purchase_form_immutable_row() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Purchase form history is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'purchase_form_history_immutable';
        RETURN NULL;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE FUNCTION protect_purchase_form_immutable_truncate() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Purchase form history is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'purchase_form_history_immutable';
        RETURN NULL;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER purchase_form_template_versions_immutable
      BEFORE UPDATE OR DELETE ON purchase_form_template_versions
      FOR EACH ROW EXECUTE FUNCTION protect_purchase_form_immutable_row()`.execute(db)
    await sql`CREATE TRIGGER purchase_form_template_versions_prevent_truncate
      BEFORE TRUNCATE ON purchase_form_template_versions FOR EACH STATEMENT
      EXECUTE FUNCTION protect_purchase_form_immutable_truncate()`.execute(db)
    await sql`CREATE TRIGGER purchase_form_template_identities_immutable
      BEFORE UPDATE OR DELETE ON purchase_form_template_identities
      FOR EACH ROW EXECUTE FUNCTION protect_purchase_form_immutable_row()`.execute(db)
    await sql`CREATE TRIGGER purchase_form_template_identities_prevent_truncate
      BEFORE TRUNCATE ON purchase_form_template_identities FOR EACH STATEMENT
      EXECUTE FUNCTION protect_purchase_form_immutable_truncate()`.execute(db)
    await sql`CREATE TRIGGER purchase_form_audit_immutable
      BEFORE UPDATE OR DELETE ON purchase_form_audit_events
      FOR EACH ROW EXECUTE FUNCTION protect_purchase_form_immutable_row()`.execute(db)
    await sql`CREATE TRIGGER purchase_form_audit_prevent_truncate
      BEFORE TRUNCATE ON purchase_form_audit_events FOR EACH STATEMENT
      EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`CREATE FUNCTION advance_purchase_form_template_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        NEW.revision := OLD.revision + 1;
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
      END $$`.execute(db)
    await sql`CREATE TRIGGER purchase_form_templates_revision
      BEFORE UPDATE ON purchase_form_templates FOR EACH ROW
      EXECUTE FUNCTION advance_purchase_form_template_revision()`.execute(db)

    await sql`
      CREATE FUNCTION guard_purchase_draft_owner_and_version() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.claimed_from_guest_order_session_id IS NOT NULL THEN
            RAISE EXCEPTION 'The original guest claimant can only be recorded during one-way claim'
              USING ERRCODE = '23514', CONSTRAINT = 'purchase_draft_owner_transfer_invalid';
          END IF;
          RETURN NEW;
        END IF;
        IF ROW(NEW.id, NEW.template_version_id, NEW.normalization_version, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.template_version_id, OLD.normalization_version, OLD.created_at) THEN
          RAISE EXCEPTION 'Purchase draft identity and template version are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_draft_identity_immutable';
        END IF;
        IF ROW(NEW.customer_id, NEW.guest_order_session_id)
          IS DISTINCT FROM ROW(OLD.customer_id, OLD.guest_order_session_id) THEN
          IF OLD.customer_id IS NOT NULL OR OLD.guest_order_session_id IS NULL
            OR NEW.customer_id IS NULL OR NEW.guest_order_session_id IS NOT NULL
            OR NEW.claimed_from_guest_order_session_id IS DISTINCT FROM OLD.guest_order_session_id
            OR OLD.status <> 'active' OR OLD.expires_at <= statement_timestamp() THEN
            RAISE EXCEPTION 'Purchase drafts may only be claimed once from an active guest owner'
              USING ERRCODE = '23514', CONSTRAINT = 'purchase_draft_owner_transfer_invalid';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM customers WHERE id = NEW.customer_id AND status = 'active' AND username IS NOT NULL) THEN
            RAISE EXCEPTION 'An active customer is required to claim a purchase draft'
              USING ERRCODE = '23514', CONSTRAINT = 'purchase_draft_owner_transfer_invalid';
          END IF;
        END IF;
        IF NEW.claimed_from_guest_order_session_id IS DISTINCT FROM OLD.claimed_from_guest_order_session_id
          AND NOT (
            OLD.customer_id IS NULL AND OLD.guest_order_session_id IS NOT NULL
            AND NEW.customer_id IS NOT NULL AND NEW.guest_order_session_id IS NULL
            AND OLD.claimed_from_guest_order_session_id IS NULL
            AND NEW.claimed_from_guest_order_session_id = OLD.guest_order_session_id
            AND OLD.status = 'active' AND OLD.expires_at > statement_timestamp()
          ) THEN
          RAISE EXCEPTION 'The original guest claimant can only be recorded during one-way claim'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_draft_owner_transfer_invalid';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER purchase_drafts_owner_version_guard
      BEFORE INSERT OR UPDATE ON purchase_drafts FOR EACH ROW EXECUTE FUNCTION guard_purchase_draft_owner_and_version()`.execute(db)
    await sql`CREATE FUNCTION advance_purchase_draft_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        NEW.revision := OLD.revision + 1;
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
      END $$`.execute(db)
    await sql`CREATE TRIGGER purchase_drafts_revision
      BEFORE UPDATE ON purchase_drafts FOR EACH ROW EXECUTE FUNCTION advance_purchase_draft_revision()`.execute(db)

    await sql`
      CREATE FUNCTION guard_purchase_draft_attachment_reference() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE attachment_state varchar(16); attachment_field uuid; draft_state varchar(16); draft_expiry timestamptz;
      BEGIN
        SELECT object.status, object.field_id, draft.status, draft.expires_at
          INTO attachment_state, attachment_field, draft_state, draft_expiry
          FROM purchase_draft_attachments AS object
          JOIN purchase_drafts AS draft ON draft.id = object.draft_id
          WHERE object.draft_id = NEW.draft_id AND object.id = NEW.attachment_id
          FOR SHARE OF object, draft;
        IF NOT FOUND OR attachment_state <> 'ready' OR attachment_field <> NEW.field_id
          OR draft_state <> 'active' OR draft_expiry <= statement_timestamp() THEN
          RAISE EXCEPTION 'Only ready attachments for an active draft field may be referenced'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_draft_attachment_reference_invalid';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER purchase_draft_attachment_references_guard
      BEFORE INSERT OR UPDATE ON purchase_draft_attachment_references
      FOR EACH ROW EXECUTE FUNCTION guard_purchase_draft_attachment_reference()`.execute(db)

    await sql`
      CREATE FUNCTION guard_purchase_draft_attachment_field() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE valid_image_field boolean;
      BEGIN
        WITH RECURSIVE nodes(value, depth) AS (
          SELECT version.definition, 0
            FROM purchase_drafts AS draft
            JOIN purchase_form_template_versions AS version ON version.id = draft.template_version_id
            WHERE draft.id = NEW.draft_id
          UNION ALL
          SELECT child.value, nodes.depth + 1
            FROM nodes
            CROSS JOIN LATERAL (
              SELECT element.value
                FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(nodes.value) = 'array' THEN nodes.value ELSE '[]'::jsonb END
                ) AS element(value)
                WHERE jsonb_typeof(nodes.value) = 'array'
              UNION ALL
              SELECT entry.value
                FROM jsonb_each(
                  CASE WHEN jsonb_typeof(nodes.value) = 'object' THEN nodes.value ELSE '{}'::jsonb END
                ) AS entry(key, value)
                WHERE jsonb_typeof(nodes.value) = 'object'
            ) AS child
            WHERE nodes.depth < 24
        )
        SELECT EXISTS (
          SELECT 1 FROM nodes
          WHERE jsonb_typeof(value) = 'object'
            AND value->>'type' = 'image'
            AND lower(value->>'id') = NEW.field_id::text
        ) INTO valid_image_field;
        IF NOT valid_image_field THEN
          RAISE EXCEPTION 'Attachment field must be an image field in the pinned template version'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_draft_attachment_field_invalid';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER purchase_draft_attachments_field_guard
      BEFORE INSERT OR UPDATE OF draft_id, field_id ON purchase_draft_attachments
      FOR EACH ROW EXECUTE FUNCTION guard_purchase_draft_attachment_field()`.execute(db)

    await sql`
      CREATE FUNCTION guard_purchase_draft_attachment_state() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.id, NEW.draft_id, NEW.field_id, NEW.storage_key, NEW.mime_type,
          NEW.reserved_bytes, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.draft_id, OLD.field_id, OLD.storage_key, OLD.mime_type,
            OLD.reserved_bytes, OLD.created_at) THEN
          RAISE EXCEPTION 'Purchase attachment identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_attachment_identity_immutable';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
          IF NOT ((OLD.status = 'uploading' AND NEW.status IN ('ready', 'failed', 'deleting'))
            OR (OLD.status IN ('ready', 'failed') AND NEW.status = 'deleting')) THEN
            RAISE EXCEPTION 'Purchase attachment state transition is invalid'
              USING ERRCODE = '23514', CONSTRAINT = 'purchase_attachment_state_invalid';
          END IF;
          IF NEW.status = 'deleting' AND EXISTS (
            SELECT 1 FROM purchase_draft_attachment_references
            WHERE draft_id = OLD.draft_id AND attachment_id = OLD.id
          ) THEN
            RAISE EXCEPTION 'A referenced purchase attachment cannot be deleted'
              USING ERRCODE = '23514', CONSTRAINT = 'purchase_attachment_referenced';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER purchase_draft_attachments_state_guard
      BEFORE UPDATE ON purchase_draft_attachments FOR EACH ROW EXECUTE FUNCTION guard_purchase_draft_attachment_state()`.execute(db)
    await sql`
      CREATE FUNCTION guard_purchase_draft_attachment_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status <> 'deleting' OR EXISTS (
          SELECT 1 FROM purchase_draft_attachment_references
          WHERE draft_id = OLD.draft_id AND attachment_id = OLD.id
        ) THEN
          RAISE EXCEPTION 'Purchase attachments must be unreferenced and deleting before removal'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_attachment_delete_guard';
        END IF;
        RETURN OLD;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER purchase_draft_attachments_delete_guard
      BEFORE DELETE ON purchase_draft_attachments FOR EACH ROW EXECUTE FUNCTION guard_purchase_draft_attachment_delete()`.execute(db)
    await sql`
      CREATE FUNCTION guard_purchase_draft_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status <> 'deleting' OR EXISTS (
          SELECT 1 FROM purchase_draft_attachments WHERE draft_id = OLD.id
        ) THEN
          RAISE EXCEPTION 'Purchase draft attachments must be removed before draft deletion'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_draft_delete_guard';
        END IF;
        RETURN OLD;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER purchase_drafts_delete_guard
      BEFORE DELETE ON purchase_drafts FOR EACH ROW EXECUTE FUNCTION guard_purchase_draft_delete()`.execute(db)
  },

  async down(db) {
    await sql`DROP TRIGGER IF EXISTS purchase_drafts_delete_guard ON purchase_drafts`.execute(db)
    await sql`DROP FUNCTION IF EXISTS guard_purchase_draft_delete()`.execute(db)
    await sql`DROP TRIGGER IF EXISTS purchase_drafts_revision ON purchase_drafts`.execute(db)
    await sql`DROP FUNCTION IF EXISTS advance_purchase_draft_revision()`.execute(db)
    await sql`DROP TRIGGER IF EXISTS purchase_draft_attachments_delete_guard ON purchase_draft_attachments`.execute(db)
    await sql`DROP FUNCTION IF EXISTS guard_purchase_draft_attachment_delete()`.execute(db)
    await sql`DROP TRIGGER IF EXISTS purchase_draft_attachments_field_guard ON purchase_draft_attachments`.execute(db)
    await sql`DROP FUNCTION IF EXISTS guard_purchase_draft_attachment_field()`.execute(db)
    await sql`DROP TRIGGER IF EXISTS purchase_draft_attachments_state_guard ON purchase_draft_attachments`.execute(db)
    await sql`DROP FUNCTION IF EXISTS guard_purchase_draft_attachment_state()`.execute(db)
    await sql`DROP TRIGGER IF EXISTS purchase_draft_attachment_references_guard ON purchase_draft_attachment_references`.execute(db)
    await sql`DROP FUNCTION IF EXISTS guard_purchase_draft_attachment_reference()`.execute(db)
    await sql`DROP TRIGGER IF EXISTS purchase_drafts_owner_version_guard ON purchase_drafts`.execute(db)
    await sql`DROP FUNCTION IF EXISTS guard_purchase_draft_owner_and_version()`.execute(db)
    await sql`DROP TRIGGER IF EXISTS purchase_form_audit_prevent_truncate ON purchase_form_audit_events`.execute(db)
    await sql`DROP TRIGGER IF EXISTS purchase_form_templates_revision ON purchase_form_templates`.execute(db)
    await sql`DROP FUNCTION IF EXISTS advance_purchase_form_template_revision()`.execute(db)
    await sql`DROP TRIGGER IF EXISTS purchase_form_audit_immutable ON purchase_form_audit_events`.execute(db)
    await sql`DROP TRIGGER IF EXISTS purchase_form_template_identities_immutable ON purchase_form_template_identities`.execute(db)
    await sql`DROP TRIGGER IF EXISTS purchase_form_template_versions_immutable ON purchase_form_template_versions`.execute(db)
    await sql`DROP TRIGGER IF EXISTS purchase_form_template_identities_prevent_truncate ON purchase_form_template_identities`.execute(db)
    await sql`DROP TRIGGER IF EXISTS purchase_form_template_versions_prevent_truncate ON purchase_form_template_versions`.execute(db)
    await sql`DROP FUNCTION IF EXISTS protect_purchase_form_immutable_truncate()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS protect_purchase_form_immutable_row()`.execute(db)
    await sql`DROP TABLE IF EXISTS purchase_draft_attachment_references`.execute(db)
    await sql`DROP TABLE IF EXISTS purchase_draft_attachments`.execute(db)
    await sql`DROP TABLE IF EXISTS purchase_drafts`.execute(db)
    await sql`DROP TABLE IF EXISTS purchase_form_audit_events`.execute(db)
    await sql`DROP TABLE IF EXISTS sku_purchase_form_overrides`.execute(db)
    await sql`DROP TABLE IF EXISTS product_purchase_form_settings`.execute(db)
    await sql`DROP TABLE IF EXISTS purchase_form_template_identities`.execute(db)
    await sql`DROP TABLE IF EXISTS purchase_form_template_versions`.execute(db)
    await sql`DROP TABLE IF EXISTS purchase_form_templates`.execute(db)
  },
}
