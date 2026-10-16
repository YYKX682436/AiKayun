import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const productCatalogCoreMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE products (
        id uuid PRIMARY KEY,
        name varchar(200) NOT NULL,
        description text NOT NULL DEFAULT '',
        product_type varchar(16) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'draft',
        revision integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT products_name_nonempty CHECK (btrim(name) <> ''),
        CONSTRAINT products_product_type_check CHECK (product_type IN ('physical', 'digital', 'service')),
        CONSTRAINT products_status_check CHECK (status IN ('draft', 'active', 'paused', 'archived')),
        CONSTRAINT products_revision_check CHECK (revision >= 1)
      )
    `.execute(db)

    await sql`
      CREATE TABLE product_variants (
        id uuid PRIMARY KEY,
        product_id uuid NOT NULL,
        sku_code varchar(64) NOT NULL,
        combination_key text NOT NULL,
        sale_price numeric(18, 5) NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        revision integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_variants_product_id_fkey
          FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
        CONSTRAINT product_variants_sku_code_nonempty CHECK (btrim(sku_code) <> ''),
        CONSTRAINT product_variants_sku_code_unique UNIQUE (sku_code),
        CONSTRAINT product_variants_product_combination_unique UNIQUE (product_id, combination_key),
        CONSTRAINT product_variants_sale_price_check
          CHECK (sale_price >= 0 AND sale_price = trunc(sale_price, 2)),
        CONSTRAINT product_variants_revision_check CHECK (revision >= 1)
      )
    `.execute(db)

    await sql`
      CREATE FUNCTION set_product_revision_and_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        NEW.revision := OLD.revision + 1;
        NEW.updated_at := now();
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE TRIGGER products_revision_updated_at
      BEFORE UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION set_product_revision_and_updated_at()
    `.execute(db)

    await sql`
      CREATE TRIGGER product_variants_revision_updated_at
      BEFORE UPDATE ON product_variants
      FOR EACH ROW EXECUTE FUNCTION set_product_revision_and_updated_at()
    `.execute(db)

    await sql`
      CREATE FUNCTION assert_product_has_default_sku(product_uuid uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM products WHERE id = product_uuid)
          AND NOT EXISTS (
            SELECT 1 FROM product_variants
            WHERE product_id = product_uuid AND combination_key = ''
          ) THEN
          RAISE EXCEPTION 'Every product must have a default SKU'
            USING ERRCODE = '23514', CONSTRAINT = 'product_requires_default_sku';
        END IF;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE FUNCTION enforce_product_default_sku() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'products' THEN
          PERFORM assert_product_has_default_sku(NEW.id);
        ELSIF TG_OP = 'DELETE' THEN
          PERFORM assert_product_has_default_sku(OLD.product_id);
        ELSIF TG_OP = 'UPDATE' THEN
          PERFORM assert_product_has_default_sku(OLD.product_id);
          IF NEW.product_id IS DISTINCT FROM OLD.product_id THEN
            PERFORM assert_product_has_default_sku(NEW.product_id);
          END IF;
        ELSE
          PERFORM assert_product_has_default_sku(NEW.product_id);
        END IF;
        RETURN NULL;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE CONSTRAINT TRIGGER products_require_default_sku
      AFTER INSERT ON products DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_product_default_sku()
    `.execute(db)

    await sql`
      CREATE CONSTRAINT TRIGGER product_variants_require_default_sku
      AFTER INSERT OR UPDATE OR DELETE ON product_variants DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_product_default_sku()
    `.execute(db)
  },

  async down(db) {
    await sql`DROP TABLE IF EXISTS product_variants`.execute(db)
    await sql`DROP TABLE IF EXISTS products`.execute(db)
    await sql`DROP FUNCTION IF EXISTS enforce_product_default_sku()`.execute(db)
    await sql`DROP FUNCTION IF EXISTS assert_product_has_default_sku(uuid)`.execute(db)
    await sql`DROP FUNCTION IF EXISTS set_product_revision_and_updated_at()`.execute(db)
  },
}
