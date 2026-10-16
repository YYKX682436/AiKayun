import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const productCatalogR1Migration: Migration = {
  async up(db) {
    await sql`
      ALTER TABLE product_variants
      ADD COLUMN retired_at timestamptz,
      ADD CONSTRAINT product_variants_retired_disabled_check
        CHECK (retired_at IS NULL OR NOT enabled)
    `.execute(db)

    await sql`
      CREATE FUNCTION protect_retired_product_variant() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.retired_at IS NOT NULL THEN
            RAISE EXCEPTION 'A permanently retired SKU cannot be deleted'
              USING ERRCODE = '23514', CONSTRAINT = 'product_variant_retired_immutable';
          END IF;
          RETURN OLD;
        END IF;

        IF OLD.retired_at IS NOT NULL AND (
          NEW.retired_at IS DISTINCT FROM OLD.retired_at
          OR NEW.enabled
          OR NEW.id IS DISTINCT FROM OLD.id
          OR NEW.product_id IS DISTINCT FROM OLD.product_id
          OR NEW.sku_code IS DISTINCT FROM OLD.sku_code
          OR NEW.combination_key IS DISTINCT FROM OLD.combination_key
        ) THEN
          RAISE EXCEPTION 'A permanently retired SKU identity cannot be reused or rewritten'
            USING ERRCODE = '23514', CONSTRAINT = 'product_variant_retired_immutable';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER product_variants_retired_guard
      BEFORE UPDATE OR DELETE ON product_variants
      FOR EACH ROW EXECUTE FUNCTION protect_retired_product_variant()
    `.execute(db)

    await sql`
      CREATE FUNCTION protect_retired_variant_options() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM product_variants
          WHERE product_id = OLD.product_id AND id = OLD.product_variant_id AND retired_at IS NOT NULL
        ) OR (TG_OP = 'UPDATE' AND EXISTS (
          SELECT 1 FROM product_variants
          WHERE product_id = NEW.product_id AND id = NEW.product_variant_id AND retired_at IS NOT NULL
        )) THEN
          RAISE EXCEPTION 'A permanently retired SKU must retain its option references'
            USING ERRCODE = '23514', CONSTRAINT = 'product_variant_retired_options_immutable';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER product_variant_option_values_retired_guard
      BEFORE UPDATE OR DELETE ON product_variant_option_values
      FOR EACH ROW EXECUTE FUNCTION protect_retired_variant_options()
    `.execute(db)

    await sql`
      CREATE FUNCTION prevent_catalog_option_truncate() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE has_rows boolean;
      BEGIN
        IF TG_TABLE_NAME = 'product_variant_option_values' THEN
          SELECT EXISTS (SELECT 1 FROM product_variant_option_values) INTO has_rows;
        ELSIF TG_TABLE_NAME = 'product_option_values' THEN
          SELECT EXISTS (SELECT 1 FROM product_option_values)
            OR EXISTS (SELECT 1 FROM product_variant_option_values) INTO has_rows;
        ELSE
          SELECT EXISTS (SELECT 1 FROM product_option_groups)
            OR EXISTS (SELECT 1 FROM product_variant_option_values) INTO has_rows;
        END IF;

        IF has_rows THEN
          RAISE EXCEPTION 'Use row operations to preserve SKU option identity and revisions'
            USING ERRCODE = '23514', CONSTRAINT = 'product_variant_option_values_truncate_forbidden';
        END IF;
        RETURN NULL;
      END;
      $$
    `.execute(db)
    for (const table of ['product_variant_option_values', 'product_option_values', 'product_option_groups']) {
      await sql.raw(`
        CREATE TRIGGER ${table}_prevent_truncate
        BEFORE TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_catalog_option_truncate()
      `).execute(db)
    }

    // A shared tuple update is required here: advisory locks serialize writers but
    // do not refresh a REPEATABLE READ transaction's already-established snapshot.
    await sql`
      CREATE TABLE product_category_tree_guard (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        revision bigint NOT NULL DEFAULT 0
      )
    `.execute(db)
    await sql`INSERT INTO product_category_tree_guard (singleton) VALUES (true)`.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION lock_product_category_tree() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE product_category_tree_guard SET revision = revision + 1 WHERE singleton;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'The category tree guard row is missing'
            USING ERRCODE = '23514', CONSTRAINT = 'product_category_tree_guard_required';
        END IF;
        RETURN NULL;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION enforce_product_category_tree() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        ancestor_count integer := 0;
        subtree_height integer := 1;
        contains_self boolean := false;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;

        IF NEW.parent_id = NEW.id THEN
          RAISE EXCEPTION 'A category cannot be its own parent'
            USING ERRCODE = '23514', CONSTRAINT = 'product_categories_no_cycle';
        END IF;

        IF NEW.parent_id IS NOT NULL THEN
          WITH RECURSIVE ancestors(id, parent_id, path) AS (
            SELECT category.id, category.parent_id, ARRAY[category.id]
            FROM product_categories AS category
            WHERE category.id = NEW.parent_id
            UNION ALL
            SELECT parent.id, parent.parent_id, ancestors.path || parent.id
            FROM product_categories AS parent
            JOIN ancestors ON parent.id = ancestors.parent_id
            WHERE NOT parent.id = ANY (ancestors.path)
          )
          SELECT count(*)::integer, COALESCE(bool_or(id = NEW.id), false)
          INTO ancestor_count, contains_self
          FROM ancestors;
        END IF;

        IF contains_self THEN
          RAISE EXCEPTION 'A category cannot be moved below itself'
            USING ERRCODE = '23514', CONSTRAINT = 'product_categories_no_cycle';
        END IF;

        IF TG_OP = 'UPDATE' THEN
          WITH RECURSIVE descendants(id, depth, path) AS (
            SELECT category.id, 1, ARRAY[category.id]
            FROM product_categories AS category
            WHERE category.id = NEW.id
            UNION ALL
            SELECT child.id, descendants.depth + 1, descendants.path || child.id
            FROM product_categories AS child
            JOIN descendants ON child.parent_id = descendants.id
            WHERE NOT child.id = ANY (descendants.path)
          )
          SELECT COALESCE(max(depth), 1) INTO subtree_height FROM descendants;
        END IF;

        IF ancestor_count + subtree_height > 4 THEN
          RAISE EXCEPTION 'A category tree cannot exceed four levels'
            USING ERRCODE = '23514', CONSTRAINT = 'product_categories_max_depth';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    // Keep the deferred catalog invariant, but distinguish SKU existence from sales state.
    await sql`
      CREATE OR REPLACE FUNCTION assert_product_catalog_state(product_uuid uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        active_group_count integer;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM products WHERE id = product_uuid) THEN
          RETURN;
        END IF;

        IF (SELECT count(*) FROM product_variants WHERE product_id = product_uuid) = 0 THEN
          RAISE EXCEPTION 'Every product must have at least one SKU'
            USING ERRCODE = '23514', CONSTRAINT = 'product_requires_sku';
        END IF;
        IF (SELECT count(*) FROM product_variants WHERE product_id = product_uuid) > 1000 THEN
          RAISE EXCEPTION 'A product cannot have more than 1000 SKUs'
            USING ERRCODE = '23514', CONSTRAINT = 'product_variants_max_count';
        END IF;
        IF (SELECT count(*) FROM product_option_groups WHERE product_id = product_uuid) > 5 THEN
          RAISE EXCEPTION 'A product cannot have more than five option groups'
            USING ERRCODE = '23514', CONSTRAINT = 'product_option_groups_max_count';
        END IF;
        IF EXISTS (
          SELECT 1 FROM product_option_values
          WHERE product_id = product_uuid
          GROUP BY option_group_id HAVING count(*) > 50
        ) THEN
          RAISE EXCEPTION 'An option group cannot have more than 50 values'
            USING ERRCODE = '23514', CONSTRAINT = 'product_option_values_max_count';
        END IF;
        IF (SELECT count(*) FROM product_attributes WHERE product_id = product_uuid) > 30 THEN
          RAISE EXCEPTION 'A product cannot have more than 30 attributes'
            USING ERRCODE = '23514', CONSTRAINT = 'product_attributes_max_count';
        END IF;

        IF EXISTS (
          SELECT 1 FROM product_category_assignments WHERE product_id = product_uuid
        ) AND (SELECT count(*) FROM product_category_assignments
               WHERE product_id = product_uuid AND is_primary) <> 1 THEN
          RAISE EXCEPTION 'Products with category assignments must have exactly one primary category'
            USING ERRCODE = '23514', CONSTRAINT = 'product_categories_primary_required';
        END IF;

        IF EXISTS (
          SELECT 1 FROM product_variants AS variant
          WHERE variant.product_id = product_uuid
            AND variant.combination_key IS DISTINCT FROM
              product_variant_combination_key(variant.product_id, variant.id)
        ) THEN
          RAISE EXCEPTION 'SKU combination identity does not match its option values'
            USING ERRCODE = '23514', CONSTRAINT = 'product_variant_combination_key_consistent';
        END IF;

        SELECT count(*)::integer INTO active_group_count
        FROM product_option_groups
        WHERE product_id = product_uuid AND enabled;

        IF EXISTS (
          SELECT 1
          FROM product_variants AS variant
          WHERE variant.product_id = product_uuid AND variant.enabled
            AND (
              (active_group_count = 0 AND EXISTS (
                SELECT 1 FROM product_variant_option_values AS selected
                WHERE selected.product_id = variant.product_id
                  AND selected.product_variant_id = variant.id
              ))
              OR (active_group_count > 0 AND (
                (SELECT count(*) FROM product_variant_option_values AS selected
                 WHERE selected.product_id = variant.product_id
                   AND selected.product_variant_id = variant.id) <> active_group_count
                OR EXISTS (
                  SELECT 1
                  FROM product_variant_option_values AS selected
                  JOIN product_option_groups AS option_group
                    ON option_group.product_id = selected.product_id
                    AND option_group.id = selected.option_group_id
                  JOIN product_option_values AS option_value
                    ON option_value.product_id = selected.product_id
                    AND option_value.option_group_id = selected.option_group_id
                    AND option_value.id = selected.option_value_id
                  WHERE selected.product_id = variant.product_id
                    AND selected.product_variant_id = variant.id
                    AND (NOT option_group.enabled OR NOT option_value.enabled)
                )
                OR EXISTS (
                  SELECT 1 FROM product_option_groups AS option_group
                  WHERE option_group.product_id = variant.product_id
                    AND option_group.enabled
                    AND NOT EXISTS (
                      SELECT 1 FROM product_variant_option_values AS selected
                      WHERE selected.product_id = variant.product_id
                        AND selected.product_variant_id = variant.id
                        AND selected.option_group_id = option_group.id
                    )
                )
              ))
            )
        ) THEN
          RAISE EXCEPTION 'An enabled SKU must have a complete, active option combination'
            USING ERRCODE = '23514', CONSTRAINT = 'product_variant_active_combination_required';
        END IF;
      END;
      $$
    `.execute(db)
  },

  async down(db) {
    await sql`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM product_variants WHERE retired_at IS NOT NULL) THEN
          RAISE EXCEPTION 'Cannot downgrade while permanently retired SKU identities exist'
            USING ERRCODE = '23514', CONSTRAINT = 'product_variant_retired_immutable';
        END IF;
        IF EXISTS (
          SELECT 1 FROM products AS product
          WHERE NOT EXISTS (
            SELECT 1 FROM product_variants AS variant
            WHERE variant.product_id = product.id AND variant.enabled
          )
        ) THEN
          RAISE EXCEPTION 'Cannot downgrade while a product has no enabled SKU'
            USING ERRCODE = '23514', CONSTRAINT = 'product_requires_valid_sku';
        END IF;
      END;
      $$
    `.execute(db)
    for (const table of ['product_variant_option_values', 'product_option_values', 'product_option_groups']) {
      await sql.raw(`DROP TRIGGER IF EXISTS ${table}_prevent_truncate ON ${table}`).execute(db)
    }
    await sql`DROP FUNCTION IF EXISTS prevent_catalog_option_truncate()`.execute(db)
    await sql`DROP TRIGGER IF EXISTS product_variant_option_values_retired_guard ON product_variant_option_values`.execute(db)
    await sql`DROP FUNCTION IF EXISTS protect_retired_variant_options()`.execute(db)
    await sql`DROP TRIGGER IF EXISTS product_variants_retired_guard ON product_variants`.execute(db)
    await sql`DROP FUNCTION IF EXISTS protect_retired_product_variant()`.execute(db)
    await sql`ALTER TABLE product_variants DROP CONSTRAINT product_variants_retired_disabled_check`.execute(db)
    await sql`ALTER TABLE product_variants DROP COLUMN retired_at`.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION assert_product_catalog_state(product_uuid uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE active_group_count integer;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM products WHERE id = product_uuid) THEN RETURN; END IF;
        IF (SELECT count(*) FROM product_variants WHERE product_id = product_uuid) = 0 THEN
          RAISE EXCEPTION 'Every product must have at least one SKU' USING ERRCODE = '23514', CONSTRAINT = 'product_requires_sku';
        END IF;
        IF (SELECT count(*) FROM product_variants WHERE product_id = product_uuid) > 1000 THEN
          RAISE EXCEPTION 'A product cannot have more than 1000 SKUs' USING ERRCODE = '23514', CONSTRAINT = 'product_variants_max_count';
        END IF;
        IF (SELECT count(*) FROM product_option_groups WHERE product_id = product_uuid) > 5 THEN
          RAISE EXCEPTION 'A product cannot have more than five option groups' USING ERRCODE = '23514', CONSTRAINT = 'product_option_groups_max_count';
        END IF;
        IF EXISTS (SELECT 1 FROM product_option_values WHERE product_id = product_uuid GROUP BY option_group_id HAVING count(*) > 50) THEN
          RAISE EXCEPTION 'An option group cannot have more than 50 values' USING ERRCODE = '23514', CONSTRAINT = 'product_option_values_max_count';
        END IF;
        IF (SELECT count(*) FROM product_attributes WHERE product_id = product_uuid) > 30 THEN
          RAISE EXCEPTION 'A product cannot have more than 30 attributes' USING ERRCODE = '23514', CONSTRAINT = 'product_attributes_max_count';
        END IF;
        IF EXISTS (SELECT 1 FROM product_category_assignments WHERE product_id = product_uuid)
          AND (SELECT count(*) FROM product_category_assignments WHERE product_id = product_uuid AND is_primary) <> 1 THEN
          RAISE EXCEPTION 'Products with category assignments must have exactly one primary category' USING ERRCODE = '23514', CONSTRAINT = 'product_categories_primary_required';
        END IF;
        IF EXISTS (
          SELECT 1 FROM product_variants AS variant WHERE variant.product_id = product_uuid
            AND variant.combination_key IS DISTINCT FROM product_variant_combination_key(variant.product_id, variant.id)
        ) THEN
          RAISE EXCEPTION 'SKU combination identity does not match its option values' USING ERRCODE = '23514', CONSTRAINT = 'product_variant_combination_key_consistent';
        END IF;
        SELECT count(*)::integer INTO active_group_count FROM product_option_groups WHERE product_id = product_uuid AND enabled;
        IF EXISTS (
          SELECT 1 FROM product_variants AS variant WHERE variant.product_id = product_uuid AND variant.enabled
            AND ((active_group_count = 0 AND EXISTS (
              SELECT 1 FROM product_variant_option_values AS selected WHERE selected.product_id = variant.product_id AND selected.product_variant_id = variant.id
            )) OR (active_group_count > 0 AND (
              (SELECT count(*) FROM product_variant_option_values AS selected WHERE selected.product_id = variant.product_id AND selected.product_variant_id = variant.id) <> active_group_count
              OR EXISTS (
                SELECT 1 FROM product_variant_option_values AS selected
                JOIN product_option_groups AS option_group ON option_group.product_id = selected.product_id AND option_group.id = selected.option_group_id
                JOIN product_option_values AS option_value ON option_value.product_id = selected.product_id AND option_value.option_group_id = selected.option_group_id AND option_value.id = selected.option_value_id
                WHERE selected.product_id = variant.product_id AND selected.product_variant_id = variant.id AND (NOT option_group.enabled OR NOT option_value.enabled)
              )
              OR EXISTS (
                SELECT 1 FROM product_option_groups AS option_group WHERE option_group.product_id = variant.product_id AND option_group.enabled
                  AND NOT EXISTS (SELECT 1 FROM product_variant_option_values AS selected WHERE selected.product_id = variant.product_id AND selected.product_variant_id = variant.id AND selected.option_group_id = option_group.id)
              )
            )))
        ) THEN
          RAISE EXCEPTION 'An enabled SKU must have a complete, active option combination' USING ERRCODE = '23514', CONSTRAINT = 'product_variant_active_combination_required';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM product_variants WHERE product_id = product_uuid AND enabled) THEN
          RAISE EXCEPTION 'Every product must have at least one valid enabled SKU' USING ERRCODE = '23514', CONSTRAINT = 'product_requires_valid_sku';
        END IF;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION lock_product_category_tree() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(41024, 1);
        RETURN NULL;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION enforce_product_category_tree() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        ancestor_count integer := 0;
        subtree_height integer := 1;
        contains_self boolean := false;
      BEGIN
        PERFORM pg_advisory_xact_lock(41024, 1);
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        IF NEW.parent_id IS NOT NULL THEN
          WITH RECURSIVE ancestors(id, parent_id, path) AS (
            SELECT category.id, category.parent_id, ARRAY[category.id]
            FROM product_categories AS category WHERE category.id = NEW.parent_id
            UNION ALL
            SELECT parent.id, parent.parent_id, ancestors.path || parent.id
            FROM product_categories AS parent JOIN ancestors ON parent.id = ancestors.parent_id
            WHERE NOT parent.id = ANY (ancestors.path)
          )
          SELECT count(*)::integer, COALESCE(bool_or(id = NEW.id), false)
          INTO ancestor_count, contains_self FROM ancestors;
        END IF;
        IF contains_self THEN
          RAISE EXCEPTION 'A category cannot be moved below itself'
            USING ERRCODE = '23514', CONSTRAINT = 'product_categories_no_cycle';
        END IF;
        IF TG_OP = 'UPDATE' THEN
          WITH RECURSIVE descendants(id, depth, path) AS (
            SELECT category.id, 1, ARRAY[category.id]
            FROM product_categories AS category WHERE category.id = NEW.id
            UNION ALL
            SELECT child.id, descendants.depth + 1, descendants.path || child.id
            FROM product_categories AS child JOIN descendants ON child.parent_id = descendants.id
            WHERE NOT child.id = ANY (descendants.path)
          )
          SELECT COALESCE(max(depth), 1) INTO subtree_height FROM descendants;
        END IF;
        IF ancestor_count + subtree_height > 4 THEN
          RAISE EXCEPTION 'A category tree cannot exceed four levels'
            USING ERRCODE = '23514', CONSTRAINT = 'product_categories_max_depth';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`DROP TABLE product_category_tree_guard`.execute(db)
  },
}
