import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const productSkuInvariantMigration: Migration = {
  async up(db) {
    await sql`DROP TRIGGER products_require_default_sku ON products`.execute(db)
    await sql`DROP TRIGGER product_variants_require_default_sku ON product_variants`.execute(db)
    await sql`DROP FUNCTION enforce_product_default_sku()`.execute(db)
    await sql`DROP FUNCTION assert_product_has_default_sku(uuid)`.execute(db)

    await sql`
      ALTER TABLE product_variants
      DROP CONSTRAINT product_variants_product_combination_unique
    `.execute(db)
    await sql`
      ALTER TABLE product_variants
      ADD CONSTRAINT product_variants_product_combination_unique
      UNIQUE (product_id, combination_key) DEFERRABLE INITIALLY IMMEDIATE
    `.execute(db)

    await sql`
      CREATE FUNCTION assert_product_has_sku(product_uuid uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM products WHERE id = product_uuid)
          AND NOT EXISTS (
            SELECT 1 FROM product_variants WHERE product_id = product_uuid
          ) THEN
          RAISE EXCEPTION 'Every product must have at least one SKU'
            USING ERRCODE = '23514', CONSTRAINT = 'product_requires_sku';
        END IF;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE FUNCTION enforce_product_has_sku() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'products' THEN
          PERFORM assert_product_has_sku(NEW.id);
        ELSIF TG_OP = 'DELETE' THEN
          PERFORM assert_product_has_sku(OLD.product_id);
        ELSE
          PERFORM assert_product_has_sku(OLD.product_id);
          IF NEW.product_id IS DISTINCT FROM OLD.product_id THEN
            PERFORM assert_product_has_sku(NEW.product_id);
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE CONSTRAINT TRIGGER products_require_sku
      AFTER INSERT ON products DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_product_has_sku()
    `.execute(db)

    await sql`
      CREATE CONSTRAINT TRIGGER product_variants_require_sku
      AFTER UPDATE OR DELETE ON product_variants DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_product_has_sku()
    `.execute(db)

    await sql`
      CREATE FUNCTION serialize_product_sku_change() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        product_uuid uuid;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          UPDATE products
          SET revision = revision + 1
          WHERE id = OLD.product_id;
          RETURN OLD;
        END IF;

        IF OLD.product_id IS DISTINCT FROM NEW.product_id
          OR OLD.combination_key IS DISTINCT FROM NEW.combination_key THEN
          -- Updating the parent tuple makes concurrent REPEATABLE READ writers
          -- conflict instead of validating disjoint snapshots independently.
          -- A deterministic order avoids inverted locks when moving between products.
          FOR product_uuid IN
            SELECT id FROM products
            WHERE id IN (OLD.product_id, NEW.product_id)
            ORDER BY id
          LOOP
            UPDATE products
            SET revision = revision + 1
            WHERE id = product_uuid;
          END LOOP;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE TRIGGER product_variants_serialize_sku_change
      BEFORE UPDATE OR DELETE ON product_variants
      FOR EACH ROW EXECUTE FUNCTION serialize_product_sku_change()
    `.execute(db)

    await sql`
      CREATE FUNCTION prevent_product_sku_truncate() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM products) THEN
          RAISE EXCEPTION 'Cannot truncate SKUs while products exist'
            USING ERRCODE = '23514', CONSTRAINT = 'product_requires_sku';
        END IF;
        RETURN NULL;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE TRIGGER product_variants_prevent_truncate
      BEFORE TRUNCATE ON product_variants
      FOR EACH STATEMENT EXECUTE FUNCTION prevent_product_sku_truncate()
    `.execute(db)
  },
}
