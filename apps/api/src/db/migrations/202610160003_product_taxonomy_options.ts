import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const productTaxonomyOptionsMigration: Migration = {
  async up(db) {
    await sql`
      ALTER TABLE product_variants
      ADD CONSTRAINT product_variants_product_id_id_unique UNIQUE (product_id, id)
    `.execute(db)

    await sql`
      CREATE TABLE product_categories (
        id uuid PRIMARY KEY,
        parent_id uuid,
        name varchar(120) NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        is_visible boolean NOT NULL DEFAULT true,
        revision integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_categories_parent_id_fkey
          FOREIGN KEY (parent_id) REFERENCES product_categories (id) ON DELETE RESTRICT,
        CONSTRAINT product_categories_name_nonempty CHECK (btrim(name) <> ''),
        CONSTRAINT product_categories_revision_check CHECK (revision >= 1)
      )
    `.execute(db)
    await sql`CREATE INDEX product_categories_parent_order_idx ON product_categories (parent_id, sort_order, id)`.execute(db)

    await sql`
      CREATE TABLE product_category_assignments (
        product_id uuid NOT NULL,
        category_id uuid NOT NULL,
        is_primary boolean NOT NULL DEFAULT false,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_category_assignments_pkey PRIMARY KEY (product_id, category_id),
        CONSTRAINT product_category_assignments_product_id_fkey
          FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
        CONSTRAINT product_category_assignments_category_id_fkey
          FOREIGN KEY (category_id) REFERENCES product_categories (id) ON DELETE RESTRICT
      )
    `.execute(db)
    await sql`
      CREATE UNIQUE INDEX product_category_assignments_one_primary_unique
      ON product_category_assignments (product_id) WHERE is_primary
    `.execute(db)
    await sql`
      CREATE INDEX product_category_assignments_category_order_idx
      ON product_category_assignments (category_id, sort_order, product_id)
    `.execute(db)

    await sql`
      CREATE TABLE product_attributes (
        id uuid PRIMARY KEY,
        product_id uuid NOT NULL,
        name varchar(80) NOT NULL,
        value varchar(500) NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_attributes_product_id_fkey
          FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
        CONSTRAINT product_attributes_name_nonempty CHECK (btrim(name) <> ''),
        CONSTRAINT product_attributes_value_nonempty CHECK (btrim(value) <> '')
      )
    `.execute(db)
    await sql`CREATE INDEX product_attributes_product_order_idx ON product_attributes (product_id, sort_order, id)`.execute(db)

    await sql`
      CREATE TABLE product_option_groups (
        id uuid PRIMARY KEY,
        product_id uuid NOT NULL,
        name varchar(80) NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_option_groups_product_id_fkey
          FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
        CONSTRAINT product_option_groups_product_id_id_unique UNIQUE (product_id, id),
        CONSTRAINT product_option_groups_name_nonempty CHECK (btrim(name) <> '')
      )
    `.execute(db)
    await sql`CREATE INDEX product_option_groups_product_order_idx ON product_option_groups (product_id, sort_order, id)`.execute(db)

    await sql`
      CREATE TABLE product_option_values (
        id uuid PRIMARY KEY,
        product_id uuid NOT NULL,
        option_group_id uuid NOT NULL,
        name varchar(80) NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_option_values_group_fkey
          FOREIGN KEY (product_id, option_group_id)
          REFERENCES product_option_groups (product_id, id) ON DELETE RESTRICT,
        CONSTRAINT product_option_values_product_group_id_unique
          UNIQUE (product_id, option_group_id, id),
        CONSTRAINT product_option_values_name_nonempty CHECK (btrim(name) <> '')
      )
    `.execute(db)
    await sql`CREATE INDEX product_option_values_group_order_idx ON product_option_values (product_id, option_group_id, sort_order, id)`.execute(db)

    await sql`
      CREATE TABLE product_variant_option_values (
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        option_group_id uuid NOT NULL,
        option_value_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_variant_option_values_pkey
          PRIMARY KEY (product_id, product_variant_id, option_group_id),
        CONSTRAINT product_variant_option_values_variant_fkey
          FOREIGN KEY (product_id, product_variant_id)
          REFERENCES product_variants (product_id, id) ON DELETE CASCADE,
        CONSTRAINT product_variant_option_values_group_fkey
          FOREIGN KEY (product_id, option_group_id)
          REFERENCES product_option_groups (product_id, id) ON DELETE RESTRICT,
        CONSTRAINT product_variant_option_values_value_fkey
          FOREIGN KEY (product_id, option_group_id, option_value_id)
          REFERENCES product_option_values (product_id, option_group_id, id) ON DELETE RESTRICT
      )
    `.execute(db)
    await sql`
      CREATE INDEX product_variant_option_values_value_idx
      ON product_variant_option_values (product_id, option_group_id, option_value_id, product_variant_id)
    `.execute(db)

    await sql`
      CREATE FUNCTION set_product_category_revision_and_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        NEW.revision := OLD.revision + 1;
        NEW.updated_at := now();
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE FUNCTION set_catalog_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        NEW.updated_at := now();
        RETURN NEW;
      END;
      $$
    `.execute(db)
    for (const table of [
      'product_category_assignments', 'product_attributes', 'product_option_groups', 'product_option_values',
    ]) {
      await sql.raw(`
        CREATE TRIGGER ${table}_updated_at
        BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION set_catalog_updated_at()
      `).execute(db)
    }
    await sql`
      CREATE TRIGGER product_categories_revision_updated_at
      BEFORE UPDATE ON product_categories
      FOR EACH ROW EXECUTE FUNCTION set_product_category_revision_and_updated_at()
    `.execute(db)

    await sql`
      CREATE FUNCTION lock_product_category_tree() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(41024, 1);
        RETURN NULL;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER product_categories_tree_statement_lock
      BEFORE INSERT OR UPDATE OR DELETE ON product_categories
      FOR EACH STATEMENT EXECUTE FUNCTION lock_product_category_tree()
    `.execute(db)
    await sql`
      CREATE FUNCTION enforce_product_category_tree() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        ancestor_count integer := 0;
        subtree_height integer := 1;
        contains_self boolean := false;
      BEGIN
        -- A taxonomy is small; one transaction lock makes cycle/depth checks safe
        -- when separate administrators move different branches concurrently.
        PERFORM pg_advisory_xact_lock(41024, 1);
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
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
    await sql`
      CREATE TRIGGER product_categories_tree_guard
      BEFORE INSERT OR UPDATE OF parent_id OR DELETE ON product_categories
      FOR EACH ROW EXECUTE FUNCTION enforce_product_category_tree()
    `.execute(db)

    await sql`
      CREATE FUNCTION lock_product_catalog_row() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        old_product uuid;
        new_product uuid;
        product_uuid uuid;
      BEGIN
        IF TG_OP <> 'INSERT' THEN old_product := OLD.product_id; END IF;
        IF TG_OP <> 'DELETE' THEN new_product := NEW.product_id; END IF;
        IF TG_OP = 'UPDATE' AND old_product IS DISTINCT FROM new_product THEN
          RAISE EXCEPTION 'Catalog rows cannot be moved between products'
            USING ERRCODE = '23514', CONSTRAINT = 'product_catalog_identity_immutable';
        END IF;
        FOR product_uuid IN
          SELECT id FROM products
          WHERE id IN (old_product, new_product)
          ORDER BY id
          FOR UPDATE
        LOOP
          NULL;
        END LOOP;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$
    `.execute(db)

    for (const table of [
      'product_category_assignments',
      'product_attributes',
      'product_option_groups',
      'product_option_values',
      'product_variant_option_values',
    ]) {
      await sql.raw(`
        CREATE TRIGGER ${table}_lock_product
        BEFORE INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION lock_product_catalog_row()
      `).execute(db)
    }
    await sql`
      CREATE TRIGGER product_variants_lock_product_catalog
      BEFORE INSERT ON product_variants
      FOR EACH ROW EXECUTE FUNCTION lock_product_catalog_row()
    `.execute(db)

    await sql`
      CREATE FUNCTION touch_product_catalog_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          UPDATE products SET revision = revision + 1
          WHERE id IN (SELECT DISTINCT product_id FROM new_rows)
            AND NOT (revision = 1 AND created_at = transaction_timestamp());
        ELSIF TG_OP = 'DELETE' THEN
          UPDATE products SET revision = revision + 1
          WHERE id IN (SELECT DISTINCT product_id FROM old_rows)
            AND NOT (revision = 1 AND created_at = transaction_timestamp());
        ELSE
          UPDATE products SET revision = revision + 1
          WHERE id IN (SELECT DISTINCT product_id FROM new_rows)
            AND NOT (revision = 1 AND created_at = transaction_timestamp());
        END IF;
        RETURN NULL;
      END;
      $$
    `.execute(db)

    for (const table of [
      'product_category_assignments',
      'product_attributes',
      'product_option_groups',
      'product_option_values',
      'product_variant_option_values',
      'product_variants',
    ]) {
      await sql.raw(`
        CREATE TRIGGER ${table}_touch_product_insert
        AFTER INSERT ON ${table}
        REFERENCING NEW TABLE AS new_rows
        FOR EACH STATEMENT EXECUTE FUNCTION touch_product_catalog_revision()
      `).execute(db)
      await sql.raw(`
        CREATE TRIGGER ${table}_touch_product_update
        AFTER UPDATE ON ${table}
        REFERENCING NEW TABLE AS new_rows
        FOR EACH STATEMENT EXECUTE FUNCTION touch_product_catalog_revision()
      `).execute(db)
      await sql.raw(`
        CREATE TRIGGER ${table}_touch_product_delete
        AFTER DELETE ON ${table}
        REFERENCING OLD TABLE AS old_rows
        FOR EACH STATEMENT EXECUTE FUNCTION touch_product_catalog_revision()
      `).execute(db)
    }

    await sql`
      CREATE FUNCTION product_variant_combination_key(product_uuid uuid, variant_uuid uuid)
      RETURNS text LANGUAGE sql STABLE AS $$
        SELECT CASE WHEN count(*) = 0 THEN ''
          ELSE 'v1:' || string_agg(option_value_id::text, '.' ORDER BY option_value_id::text COLLATE "C")
        END
        FROM product_variant_option_values
        WHERE product_id = product_uuid AND product_variant_id = variant_uuid
      $$
    `.execute(db)

    await sql`
      CREATE FUNCTION assert_product_catalog_state(product_uuid uuid) RETURNS void
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
          SELECT 1 FROM product_category_assignments
          WHERE product_id = product_uuid
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

        IF NOT EXISTS (SELECT 1 FROM product_variants WHERE product_id = product_uuid AND enabled) THEN
          RAISE EXCEPTION 'Every product must have at least one valid enabled SKU'
            USING ERRCODE = '23514', CONSTRAINT = 'product_requires_valid_sku';
        END IF;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE FUNCTION enforce_product_catalog_state() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM assert_product_catalog_state(NEW.id);
        RETURN NULL;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE CONSTRAINT TRIGGER products_require_valid_catalog
      AFTER INSERT OR UPDATE ON products DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_product_catalog_state()
    `.execute(db)
    await sql`
      DO $$
      DECLARE product_uuid uuid;
      BEGIN
        FOR product_uuid IN SELECT id FROM products LOOP
          PERFORM assert_product_catalog_state(product_uuid);
        END LOOP;
      END;
      $$
    `.execute(db)
  },

  async down(db) {
    await sql`DROP TRIGGER IF EXISTS products_require_valid_catalog ON products`.execute(db)
    await sql`DROP TRIGGER IF EXISTS product_categories_tree_guard ON product_categories`.execute(db)
    await sql`DROP TRIGGER IF EXISTS product_categories_tree_statement_lock ON product_categories`.execute(db)
    await sql`DROP TRIGGER IF EXISTS product_categories_revision_updated_at ON product_categories`.execute(db)
    await sql`DROP TRIGGER IF EXISTS product_variants_lock_product_catalog ON product_variants`.execute(db)
    for (const table of [
      'product_category_assignments', 'product_attributes', 'product_option_groups',
      'product_option_values', 'product_variant_option_values', 'product_variants',
    ]) {
      await sql.raw(`DROP TRIGGER IF EXISTS ${table}_lock_product ON ${table}`).execute(db)
      await sql.raw(`DROP TRIGGER IF EXISTS ${table}_touch_product_insert ON ${table}`).execute(db)
      await sql.raw(`DROP TRIGGER IF EXISTS ${table}_touch_product_update ON ${table}`).execute(db)
      await sql.raw(`DROP TRIGGER IF EXISTS ${table}_touch_product_delete ON ${table}`).execute(db)
      if (table !== 'product_variant_option_values' && table !== 'product_variants') {
        await sql.raw(`DROP TRIGGER IF EXISTS ${table}_updated_at ON ${table}`).execute(db)
      }
    }
    await sql`DROP FUNCTION IF EXISTS enforce_product_catalog_state()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS assert_product_catalog_state(uuid)`.execute(db)
    await sql`DROP FUNCTION IF EXISTS product_variant_combination_key(uuid, uuid)`.execute(db)
    await sql`DROP FUNCTION IF EXISTS touch_product_catalog_revision()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS lock_product_catalog_row()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS enforce_product_category_tree()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS lock_product_category_tree()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS set_product_category_revision_and_updated_at()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS set_catalog_updated_at()`.execute(db)
    await sql`DROP TABLE IF EXISTS product_variant_option_values`.execute(db)
    await sql`DROP TABLE IF EXISTS product_option_values`.execute(db)
    await sql`DROP TABLE IF EXISTS product_option_groups`.execute(db)
    await sql`DROP TABLE IF EXISTS product_attributes`.execute(db)
    await sql`DROP TABLE IF EXISTS product_category_assignments`.execute(db)
    await sql`DROP TABLE IF EXISTS product_categories`.execute(db)
    await sql`ALTER TABLE product_variants DROP CONSTRAINT product_variants_product_id_id_unique`.execute(db)
  },
}
