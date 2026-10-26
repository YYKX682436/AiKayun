import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Bounded administrator initiated history for read-only upstream reference quotes. */
export const supplierQuoteObservationsMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE supplier_reference_quote_observations (
        id uuid PRIMARY KEY,
        administrator_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        mapping_id uuid,
        mapping_version_id uuid REFERENCES supplier_product_mapping_versions(id) ON DELETE RESTRICT,
        mapping_revision integer,
        mapping_status varchar(16) NOT NULL,
        supplier_connection_id uuid,
        supplier_connection_version_id uuid,
        configuration_version_number integer,
        upstream_product_id varchar(32),
        upstream_sku_type smallint,
        upstream_sku_code varchar(200),
        upstream_combination jsonb NOT NULL DEFAULT '[]'::jsonb,
        quote_scope varchar(16),
        quote_amount varchar(64),
        quote_currency varchar(3),
        currency_status varchar(24) NOT NULL DEFAULT 'unspecified',
        quote_basis varchar(48),
        quote_unit_status varchar(24) NOT NULL DEFAULT 'unverified',
        actual_debit_verified boolean NOT NULL DEFAULT false,
        outcome varchar(32) NOT NULL,
        observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        source_read_at timestamptz,
        structure_fingerprint char(64),
        failure_code varchar(80),
        comparable_to_previous boolean NOT NULL DEFAULT false,
        comparison_reason varchar(48) NOT NULL,
        previous_observation_id uuid,
        previous_amount varchar(64),
        raw_reference_delta varchar(64),
        CONSTRAINT supplier_quote_mapping_status_check CHECK (mapping_status IN ('none', 'draft', 'reviewed', 'stale')),
        CONSTRAINT supplier_quote_mapping_revision_check CHECK (mapping_revision IS NULL OR mapping_revision >= 1),
        CONSTRAINT supplier_quote_source_shape_check CHECK (
          (supplier_connection_id IS NULL AND supplier_connection_version_id IS NULL AND configuration_version_number IS NULL)
          OR (supplier_connection_id IS NOT NULL AND supplier_connection_version_id IS NOT NULL AND configuration_version_number > 0)
        ),
        CONSTRAINT supplier_quote_source_version_fkey FOREIGN KEY (supplier_connection_version_id, supplier_connection_id)
          REFERENCES supplier_connection_versions(id, supplier_connection_id) ON DELETE RESTRICT,
        CONSTRAINT supplier_quote_goods_id_check CHECK (upstream_product_id IS NULL OR upstream_product_id ~ '^[0-9]{1,16}$'),
        CONSTRAINT supplier_quote_sku_identity_check CHECK (
          (upstream_sku_type IS NULL AND upstream_sku_code IS NULL)
          OR (upstream_sku_type = 0 AND upstream_sku_code IS NULL AND jsonb_array_length(upstream_combination) = 0)
          OR (upstream_sku_type IN (1, 2) AND upstream_sku_code IS NOT NULL AND btrim(upstream_sku_code) <> '')
        ),
        CONSTRAINT supplier_quote_combination_check CHECK (jsonb_typeof(upstream_combination) = 'array'),
        CONSTRAINT supplier_quote_scope_check CHECK (quote_scope IS NULL OR quote_scope IN ('product', 'variant')),
        CONSTRAINT supplier_quote_amount_check CHECK (quote_amount IS NULL OR quote_amount ~ '^(0|[1-9][0-9]{0,23})(\\.[0-9]{1,18})?$'),
        CONSTRAINT supplier_quote_previous_amount_check CHECK (previous_amount IS NULL OR previous_amount ~ '^(0|[1-9][0-9]{0,23})(\\.[0-9]{1,18})?$'),
        CONSTRAINT supplier_quote_delta_check CHECK (raw_reference_delta IS NULL OR raw_reference_delta ~ '^-?(0|[1-9][0-9]{0,24})(\\.[0-9]{1,18})?$'),
        CONSTRAINT supplier_quote_unverified_currency_check CHECK (quote_currency IS NULL AND currency_status = 'unspecified'),
        CONSTRAINT supplier_quote_unverified_debit_check CHECK (actual_debit_verified = false AND quote_unit_status = 'unverified'),
        CONSTRAINT supplier_quote_basis_check CHECK (quote_basis IS NULL OR quote_basis = 'upstream_account_reference'),
        CONSTRAINT supplier_quote_outcome_check CHECK (outcome IN (
          'observed', 'quote_missing', 'mapping_missing', 'mapping_not_reviewed', 'mapping_stale',
          'configuration_changed', 'identity_changed', 'structure_changed', 'read_failed', 'mapping_changed', 'sku_changed'
        )),
        CONSTRAINT supplier_quote_structure_hash_check CHECK (structure_fingerprint IS NULL OR structure_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT supplier_quote_comparison_reason_check CHECK (comparison_reason IN (
          'comparable_same_source_and_structure', 'first_observation', 'previous_observation_unusable',
          'different_connection', 'different_configuration', 'different_product', 'different_sku',
          'different_quote_scope', 'structure_changed', 'quote_missing'
        )),
        CONSTRAINT supplier_quote_comparison_consistency_check CHECK (
          (comparable_to_previous AND comparison_reason = 'comparable_same_source_and_structure'
            AND previous_observation_id IS NOT NULL AND quote_amount IS NOT NULL)
          OR (NOT comparable_to_previous AND comparison_reason <> 'comparable_same_source_and_structure')
        )
      )
    `.execute(db)
    await sql`CREATE INDEX supplier_reference_quote_observations_sku_history_idx
      ON supplier_reference_quote_observations(product_id, product_variant_id, observed_at DESC, id DESC)`.execute(db)
    await sql`CREATE INDEX supplier_reference_quote_observations_source_idx
      ON supplier_reference_quote_observations(supplier_connection_id, supplier_connection_version_id, observed_at DESC)`.execute(db)
    await sql`
      CREATE FUNCTION protect_supplier_reference_quote_observation_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Supplier reference quote observations are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'supplier_reference_quote_observation_immutable';
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER supplier_reference_quote_observation_immutable
      BEFORE UPDATE ON supplier_reference_quote_observations FOR EACH ROW
      EXECUTE FUNCTION protect_supplier_reference_quote_observation_update()`.execute(db)
    await sql`CREATE TRIGGER supplier_reference_quote_observation_prevent_truncate
      BEFORE TRUNCATE ON supplier_reference_quote_observations FOR EACH STATEMENT
      EXECUTE FUNCTION protect_supplier_reference_quote_observation_update()`.execute(db)
  },

  async down(db) {
    await sql`DROP TABLE supplier_reference_quote_observations`.execute(db)
    await sql`DROP FUNCTION protect_supplier_reference_quote_observation_update()`.execute(db)
  },
}
