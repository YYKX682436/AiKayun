import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Versioned, reviewed preparation mappings; this grants no fulfillment capability. */
export const supplierProductMappingsMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE supplier_product_mapping_observations (
        id uuid PRIMARY KEY,
        administrator_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
        supplier_connection_id uuid NOT NULL,
        supplier_connection_version_id uuid NOT NULL,
        provider_type varchar(32) NOT NULL DEFAULT 'kayixin_customer_v3',
        upstream_product_id varchar(32) NOT NULL,
        upstream_product_name varchar(500) NOT NULL,
        upstream_sku_type smallint NOT NULL,
        upstream_sku_code varchar(200),
        upstream_combination jsonb NOT NULL,
        upstream_structure_snapshot jsonb NOT NULL,
        upstream_structure_sha256 char(64) NOT NULL,
        upstream_observed_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        CONSTRAINT supplier_mapping_observation_connection_fkey FOREIGN KEY (supplier_connection_version_id, supplier_connection_id, provider_type)
          REFERENCES supplier_connection_versions(id, supplier_connection_id, provider_type) ON DELETE RESTRICT,
        CONSTRAINT supplier_mapping_observation_provider_check CHECK (provider_type = 'kayixin_customer_v3'),
        CONSTRAINT supplier_mapping_observation_goods_id_check CHECK (upstream_product_id ~ '^[0-9]{1,16}$'),
        CONSTRAINT supplier_mapping_observation_sku_identity_check CHECK (
          (upstream_sku_type = 0 AND upstream_sku_code IS NULL AND jsonb_array_length(upstream_combination) = 0)
          OR (upstream_sku_type IN (1, 2) AND upstream_sku_code IS NOT NULL AND btrim(upstream_sku_code) <> ''
            AND jsonb_array_length(upstream_combination) BETWEEN 1 AND 30)),
        CONSTRAINT supplier_mapping_observation_combination_check CHECK (jsonb_typeof(upstream_combination) = 'array'),
        CONSTRAINT supplier_mapping_observation_snapshot_check CHECK (jsonb_typeof(upstream_structure_snapshot) = 'object'),
        CONSTRAINT supplier_mapping_observation_hash_check CHECK (upstream_structure_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT supplier_mapping_observation_expiry_check CHECK (expires_at > upstream_observed_at)
      )
    `.execute(db)
    await sql`CREATE INDEX supplier_mapping_observations_expiry_idx
      ON supplier_product_mapping_observations(expires_at)`.execute(db)
    await sql`CREATE INDEX supplier_mapping_observations_admin_idx
      ON supplier_product_mapping_observations(administrator_id, supplier_connection_id, expires_at DESC)`.execute(db)

    await sql`
      CREATE TABLE supplier_product_mapping_heads (
        id uuid PRIMARY KEY,
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        revision integer NOT NULL DEFAULT 1,
        status varchar(16) NOT NULL DEFAULT 'draft',
        supplier_connection_id uuid NOT NULL,
        supplier_connection_version_id uuid NOT NULL,
        provider_type varchar(32) NOT NULL DEFAULT 'kayixin_customer_v3',
        upstream_product_id varchar(32) NOT NULL,
        upstream_product_name varchar(500) NOT NULL,
        upstream_sku_type smallint NOT NULL,
        upstream_sku_code varchar(200),
        upstream_combination jsonb NOT NULL,
        upstream_structure_snapshot jsonb NOT NULL,
        upstream_structure_sha256 char(64) NOT NULL,
        upstream_observed_at timestamptz NOT NULL,
        template_id uuid NOT NULL,
        template_version_id uuid NOT NULL,
        template_sha256 char(64) NOT NULL,
        normalization_version smallint NOT NULL,
        rules_version smallint NOT NULL DEFAULT 1,
        rules jsonb NOT NULL,
        rules_sha256 char(64) NOT NULL,
        latest_review_version_id uuid,
        latest_version_number integer NOT NULL DEFAULT 0,
        created_by_admin_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
        updated_by_admin_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT supplier_mapping_local_sku_fkey FOREIGN KEY (product_id, product_variant_id)
          REFERENCES product_variants(product_id, id) ON DELETE CASCADE,
        CONSTRAINT supplier_mapping_connection_version_fkey FOREIGN KEY (supplier_connection_version_id, supplier_connection_id, provider_type)
          REFERENCES supplier_connection_versions(id, supplier_connection_id, provider_type) ON DELETE RESTRICT,
        CONSTRAINT supplier_mapping_template_version_fkey FOREIGN KEY (template_id, template_version_id)
          REFERENCES purchase_form_template_versions(template_id, id) ON DELETE RESTRICT,
        CONSTRAINT supplier_mapping_target_unique UNIQUE (product_id, product_variant_id),
        CONSTRAINT supplier_mapping_identity_unique UNIQUE (id, product_id, product_variant_id),
        CONSTRAINT supplier_mapping_revision_check CHECK (revision >= 1),
        CONSTRAINT supplier_mapping_status_check CHECK (status IN ('draft', 'reviewed', 'stale')),
        CONSTRAINT supplier_mapping_provider_check CHECK (provider_type = 'kayixin_customer_v3'),
        CONSTRAINT supplier_mapping_goods_id_check CHECK (upstream_product_id ~ '^[0-9]{1,16}$'),
        CONSTRAINT supplier_mapping_sku_identity_check CHECK (
          (upstream_sku_type = 0 AND upstream_sku_code IS NULL AND jsonb_array_length(upstream_combination) = 0)
          OR (upstream_sku_type IN (1, 2) AND upstream_sku_code IS NOT NULL AND btrim(upstream_sku_code) <> ''
            AND jsonb_array_length(upstream_combination) BETWEEN 1 AND 30)),
        CONSTRAINT supplier_mapping_combination_array_check CHECK (jsonb_typeof(upstream_combination) = 'array'),
        CONSTRAINT supplier_mapping_snapshot_object_check CHECK (jsonb_typeof(upstream_structure_snapshot) = 'object'),
        CONSTRAINT supplier_mapping_structure_hash_check CHECK (upstream_structure_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT supplier_mapping_template_hash_check CHECK (template_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT supplier_mapping_rules_check CHECK (rules_version = 1 AND jsonb_typeof(rules) = 'object' AND rules->>'version' = '1'),
        CONSTRAINT supplier_mapping_rules_hash_check CHECK (rules_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT supplier_mapping_normalization_version_check CHECK (normalization_version >= 1),
        CONSTRAINT supplier_mapping_review_pointer_check CHECK (
          (latest_version_number = 0 AND latest_review_version_id IS NULL)
          OR (latest_version_number > 0 AND latest_review_version_id IS NOT NULL)),
        CONSTRAINT supplier_mapping_reviewed_shape_check CHECK (status <> 'reviewed' OR latest_review_version_id IS NOT NULL)
      )
    `.execute(db)

    // Reviewed snapshots deliberately have no FK to local products/SKUs, so a
    // legally deletable SKU cascades its mutable head without erasing review history.
    await sql`
      CREATE TABLE supplier_product_mapping_versions (
        id uuid PRIMARY KEY,
        mapping_id uuid NOT NULL,
        version_number integer NOT NULL,
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        supplier_connection_id uuid NOT NULL,
        supplier_connection_version_id uuid NOT NULL,
        provider_type varchar(32) NOT NULL DEFAULT 'kayixin_customer_v3',
        upstream_product_id varchar(32) NOT NULL,
        upstream_product_name varchar(500) NOT NULL,
        upstream_sku_type smallint NOT NULL,
        upstream_sku_code varchar(200),
        upstream_combination jsonb NOT NULL,
        upstream_structure_snapshot jsonb NOT NULL,
        upstream_structure_sha256 char(64) NOT NULL,
        upstream_observed_at timestamptz NOT NULL,
        template_id uuid NOT NULL,
        template_version_id uuid NOT NULL,
        template_sha256 char(64) NOT NULL,
        normalization_version smallint NOT NULL,
        rules_version smallint NOT NULL DEFAULT 1,
        rules jsonb NOT NULL,
        rules_sha256 char(64) NOT NULL,
        administrator_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
        reviewed_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT supplier_mapping_version_connection_fkey FOREIGN KEY (supplier_connection_version_id, supplier_connection_id, provider_type)
          REFERENCES supplier_connection_versions(id, supplier_connection_id, provider_type) ON DELETE RESTRICT,
        CONSTRAINT supplier_mapping_version_template_fkey FOREIGN KEY (template_id, template_version_id)
          REFERENCES purchase_form_template_versions(template_id, id) ON DELETE RESTRICT,
        CONSTRAINT supplier_mapping_version_number_unique UNIQUE (mapping_id, version_number),
        CONSTRAINT supplier_mapping_version_id_mapping_unique UNIQUE (id, mapping_id),
        CONSTRAINT supplier_mapping_version_number_check CHECK (version_number >= 1),
        CONSTRAINT supplier_mapping_version_provider_check CHECK (provider_type = 'kayixin_customer_v3'),
        CONSTRAINT supplier_mapping_version_goods_id_check CHECK (upstream_product_id ~ '^[0-9]{1,16}$'),
        CONSTRAINT supplier_mapping_version_sku_identity_check CHECK (
          (upstream_sku_type = 0 AND upstream_sku_code IS NULL AND jsonb_array_length(upstream_combination) = 0)
          OR (upstream_sku_type IN (1, 2) AND upstream_sku_code IS NOT NULL AND btrim(upstream_sku_code) <> ''
            AND jsonb_array_length(upstream_combination) BETWEEN 1 AND 30)),
        CONSTRAINT supplier_mapping_version_combination_check CHECK (jsonb_typeof(upstream_combination) = 'array'),
        CONSTRAINT supplier_mapping_version_snapshot_check CHECK (jsonb_typeof(upstream_structure_snapshot) = 'object'),
        CONSTRAINT supplier_mapping_version_structure_hash_check CHECK (upstream_structure_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT supplier_mapping_version_template_hash_check CHECK (template_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT supplier_mapping_version_rules_check CHECK (rules_version = 1 AND jsonb_typeof(rules) = 'object' AND rules->>'version' = '1'),
        CONSTRAINT supplier_mapping_version_rules_hash_check CHECK (rules_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT supplier_mapping_version_normalization_check CHECK (normalization_version >= 1)
      )
    `.execute(db)
    // Resolve the mutually-referencing history pointer after the immutable table exists.
    await sql`ALTER TABLE supplier_product_mapping_heads
      ADD CONSTRAINT supplier_mapping_review_version_owner_fkey
      FOREIGN KEY (latest_review_version_id, id)
      REFERENCES supplier_product_mapping_versions(id, mapping_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED`.execute(db)

    await sql`CREATE INDEX supplier_mapping_head_status_idx ON supplier_product_mapping_heads(status, updated_at DESC, id)`.execute(db)
    await sql`CREATE INDEX supplier_mapping_history_idx ON supplier_product_mapping_versions(mapping_id, version_number DESC)`.execute(db)
    await sql`CREATE INDEX supplier_mapping_history_local_identity_idx ON supplier_product_mapping_versions(product_id, product_variant_id, reviewed_at DESC, id DESC)`.execute(db)

    await sql`
      CREATE TABLE supplier_product_mapping_audit_events (
        id uuid PRIMARY KEY,
        mapping_id uuid NOT NULL,
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        administrator_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
        operation varchar(24) NOT NULL,
        mapping_version_id uuid,
        revision integer NOT NULL,
        summary jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT supplier_mapping_audit_operation_check CHECK (operation IN ('created', 'draft_saved', 'reviewed', 'marked_stale', 'restored')),
        CONSTRAINT supplier_mapping_audit_revision_check CHECK (revision >= 1),
        CONSTRAINT supplier_mapping_audit_summary_object_check CHECK (jsonb_typeof(summary) = 'object'),
        CONSTRAINT supplier_mapping_audit_version_fkey FOREIGN KEY (mapping_version_id)
          REFERENCES supplier_product_mapping_versions(id) ON DELETE RESTRICT
      )
    `.execute(db)
    await sql`CREATE INDEX supplier_mapping_audit_local_identity_idx
      ON supplier_product_mapping_audit_events(product_id, product_variant_id, created_at DESC, id DESC)`.execute(db)

    await sql`
      CREATE FUNCTION protect_supplier_product_mapping_history() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'Supplier product mapping history is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'supplier_mapping_history_immutable';
        RETURN NULL;
      END $$
    `.execute(db)
    await sql`CREATE TRIGGER supplier_mapping_versions_immutable
      BEFORE UPDATE OR DELETE ON supplier_product_mapping_versions
      FOR EACH ROW EXECUTE FUNCTION protect_supplier_product_mapping_history()`.execute(db)
    await sql`CREATE TRIGGER supplier_mapping_versions_no_truncate
      BEFORE TRUNCATE ON supplier_product_mapping_versions FOR EACH STATEMENT
      EXECUTE FUNCTION protect_supplier_product_mapping_history()`.execute(db)
    await sql`CREATE TRIGGER supplier_mapping_audit_immutable
      BEFORE UPDATE OR DELETE ON supplier_product_mapping_audit_events
      FOR EACH ROW EXECUTE FUNCTION protect_supplier_product_mapping_history()`.execute(db)
    await sql`CREATE TRIGGER supplier_mapping_audit_no_truncate
      BEFORE TRUNCATE ON supplier_product_mapping_audit_events FOR EACH STATEMENT
      EXECUTE FUNCTION protect_supplier_product_mapping_history()`.execute(db)

    await sql`
      CREATE FUNCTION guard_supplier_product_mapping_head() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.revision <> 1 OR NEW.status <> 'draft' OR NEW.latest_version_number <> 0
            OR NEW.latest_review_version_id IS NOT NULL THEN
            RAISE EXCEPTION 'Supplier mapping must begin as a draft'
              USING ERRCODE = '23514', CONSTRAINT = 'supplier_mapping_initial_state_invalid';
          END IF;
          RETURN NEW;
        END IF;
        IF ROW(NEW.id, NEW.product_id, NEW.product_variant_id, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.product_id, OLD.product_variant_id, OLD.created_at) THEN
          RAISE EXCEPTION 'Supplier mapping local identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_mapping_identity_immutable';
        END IF;
        IF NEW.revision <> OLD.revision + 1 THEN
          RAISE EXCEPTION 'Supplier mapping revision must advance by one'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_mapping_revision_transition_invalid';
        END IF;
        IF NOT (
          (OLD.status = 'draft' AND NEW.status IN ('draft', 'reviewed', 'stale')) OR
          (OLD.status = 'reviewed' AND NEW.status IN ('draft', 'stale')) OR
          (OLD.status = 'stale' AND NEW.status IN ('draft', 'reviewed', 'stale'))
        ) THEN
          RAISE EXCEPTION 'Supplier mapping review state transition is invalid'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_mapping_state_transition_invalid';
        END IF;
        IF OLD.status = 'reviewed' AND NEW.status = 'reviewed' THEN
          RAISE EXCEPTION 'Reviewed supplier mapping heads cannot be edited in place'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_mapping_reviewed_immutable';
        END IF;
        IF NEW.status = 'reviewed' AND (NEW.latest_version_number <> OLD.latest_version_number + 1
          OR NEW.latest_review_version_id IS NULL) THEN
          RAISE EXCEPTION 'Review must append the next immutable mapping version'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_mapping_review_version_required';
        END IF;
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
      END $$
    `.execute(db)
    await sql`CREATE TRIGGER supplier_mapping_head_guard
      BEFORE INSERT OR UPDATE ON supplier_product_mapping_heads
      FOR EACH ROW EXECUTE FUNCTION guard_supplier_product_mapping_head()`.execute(db)

    await sql`
      CREATE FUNCTION guard_supplier_product_mapping_version_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE head supplier_product_mapping_heads%ROWTYPE;
      BEGIN
        SELECT * INTO head FROM supplier_product_mapping_heads WHERE id = NEW.mapping_id FOR UPDATE;
        IF NOT FOUND OR head.product_id <> NEW.product_id OR head.product_variant_id <> NEW.product_variant_id
          OR NEW.version_number <> head.latest_version_number + 1
          OR NEW.supplier_connection_id <> head.supplier_connection_id
          OR NEW.supplier_connection_version_id <> head.supplier_connection_version_id
          OR NEW.upstream_product_id <> head.upstream_product_id
          OR NEW.upstream_product_name IS DISTINCT FROM head.upstream_product_name
          OR NEW.upstream_sku_type <> head.upstream_sku_type
          OR NEW.upstream_sku_code IS DISTINCT FROM head.upstream_sku_code
          OR NEW.upstream_combination <> head.upstream_combination
          OR NEW.upstream_structure_snapshot <> head.upstream_structure_snapshot
          OR NEW.upstream_structure_sha256 <> head.upstream_structure_sha256
          OR NEW.upstream_observed_at <> head.upstream_observed_at
          OR NEW.template_id <> head.template_id OR NEW.template_version_id <> head.template_version_id
          OR NEW.template_sha256 <> head.template_sha256 OR NEW.normalization_version <> head.normalization_version
          OR NEW.rules_version <> head.rules_version OR NEW.rules <> head.rules OR NEW.rules_sha256 <> head.rules_sha256 THEN
          RAISE EXCEPTION 'Supplier mapping review version must snapshot its current head'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_mapping_version_snapshot_mismatch';
        END IF;
        RETURN NEW;
      END $$
    `.execute(db)
    await sql`CREATE TRIGGER supplier_mapping_version_insert_guard
      BEFORE INSERT ON supplier_product_mapping_versions
      FOR EACH ROW EXECUTE FUNCTION guard_supplier_product_mapping_version_insert()`.execute(db)
  },

  async down(db) {
    await sql`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM supplier_product_mapping_versions)
        OR EXISTS (SELECT 1 FROM supplier_product_mapping_audit_events) THEN
        RAISE EXCEPTION 'Cannot remove immutable supplier mapping history';
      END IF;
    END $$`.execute(db)
    await sql`DROP TRIGGER supplier_mapping_version_insert_guard ON supplier_product_mapping_versions`.execute(db)
    await sql`DROP FUNCTION guard_supplier_product_mapping_version_insert()`.execute(db)
    await sql`DROP TRIGGER supplier_mapping_head_guard ON supplier_product_mapping_heads`.execute(db)
    await sql`DROP FUNCTION guard_supplier_product_mapping_head()`.execute(db)
    await sql`DROP TRIGGER supplier_mapping_audit_no_truncate ON supplier_product_mapping_audit_events`.execute(db)
    await sql`DROP TRIGGER supplier_mapping_audit_immutable ON supplier_product_mapping_audit_events`.execute(db)
    await sql`DROP TRIGGER supplier_mapping_versions_no_truncate ON supplier_product_mapping_versions`.execute(db)
    await sql`DROP TRIGGER supplier_mapping_versions_immutable ON supplier_product_mapping_versions`.execute(db)
    await sql`DROP FUNCTION protect_supplier_product_mapping_history()`.execute(db)
    await sql`DROP TABLE supplier_product_mapping_audit_events`.execute(db)
    await sql`ALTER TABLE supplier_product_mapping_heads DROP CONSTRAINT supplier_mapping_review_version_owner_fkey`.execute(db)
    await sql`DROP TABLE supplier_product_mapping_versions`.execute(db)
    await sql`DROP TABLE supplier_product_mapping_heads`.execute(db)
    await sql`DROP TABLE supplier_product_mapping_observations`.execute(db)
  },
}
