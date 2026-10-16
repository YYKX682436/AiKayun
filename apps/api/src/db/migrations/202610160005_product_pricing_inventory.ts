import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const productPricingInventoryMigration: Migration = {
  async up(db) {
    await sql`
      ALTER TABLE product_variants
      ADD COLUMN compare_at_price numeric(18, 5),
      ADD COLUMN cost_price numeric(18, 5),
      ADD COLUMN inventory_mode varchar(16),
      ADD COLUMN inventory_revision integer NOT NULL DEFAULT 0,
      ADD CONSTRAINT product_variants_compare_at_price_check
        CHECK (compare_at_price IS NULL OR (compare_at_price >= 0
          AND compare_at_price = trunc(compare_at_price, 2)
          AND compare_at_price > sale_price)),
      ADD CONSTRAINT product_variants_cost_price_check
        CHECK (cost_price IS NULL OR (cost_price >= 0 AND cost_price = trunc(cost_price, 5))),
      ADD CONSTRAINT product_variants_inventory_mode_check
        CHECK (inventory_mode IS NULL OR inventory_mode IN ('quantity', 'resource_pool', 'unlimited', 'external')),
      ADD CONSTRAINT product_variants_inventory_revision_check
        CHECK (inventory_revision >= 0)
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION protect_retired_product_variant() RETURNS trigger
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
          OR NEW.sale_price IS DISTINCT FROM OLD.sale_price
          OR NEW.compare_at_price IS DISTINCT FROM OLD.compare_at_price
          OR NEW.cost_price IS DISTINCT FROM OLD.cost_price
          OR NEW.inventory_mode IS DISTINCT FROM OLD.inventory_mode
          OR NEW.inventory_revision IS DISTINCT FROM OLD.inventory_revision
        ) THEN
          RAISE EXCEPTION 'A permanently retired SKU cannot be repriced or reuse its inventory state'
            USING ERRCODE = '23514', CONSTRAINT = 'product_variant_retired_immutable';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE TABLE product_variant_quantity_inventory (
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        stocked integer NOT NULL DEFAULT 0,
        reserved integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_variant_quantity_inventory_pkey PRIMARY KEY (product_id, product_variant_id),
        CONSTRAINT product_variant_quantity_inventory_variant_fkey
          FOREIGN KEY (product_id, product_variant_id)
          REFERENCES product_variants (product_id, id) ON DELETE RESTRICT,
        CONSTRAINT product_variant_quantity_inventory_stocked_check CHECK (stocked >= 0),
        CONSTRAINT product_variant_quantity_inventory_reserved_check CHECK (reserved >= 0 AND reserved <= stocked)
      )
    `.execute(db)
    await sql`
      CREATE INDEX product_variant_quantity_inventory_sku_idx
      ON product_variant_quantity_inventory (product_variant_id)
    `.execute(db)

    await sql`
      CREATE TABLE product_variant_inventory_adjustments (
        id uuid PRIMARY KEY,
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        operation_id uuid NOT NULL,
        administrator_id uuid NOT NULL,
        action varchar(16) NOT NULL,
        requested_quantity integer NOT NULL,
        quantity_before integer NOT NULL,
        quantity_after integer NOT NULL,
        quantity_delta integer NOT NULL,
        inventory_revision integer NOT NULL,
        reason varchar(500) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_variant_inventory_adjustments_operation_unique UNIQUE (operation_id),
        CONSTRAINT product_variant_inventory_adjustments_variant_fkey
          FOREIGN KEY (product_id, product_variant_id)
          REFERENCES product_variants (product_id, id) ON DELETE RESTRICT,
        CONSTRAINT product_variant_inventory_adjustments_admin_fkey
          FOREIGN KEY (administrator_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT product_variant_inventory_adjustments_action_check
          CHECK (action IN ('increase', 'decrease', 'set')),
        CONSTRAINT product_variant_inventory_adjustments_quantities_check
          CHECK (requested_quantity >= 0 AND quantity_before >= 0 AND quantity_after >= 0
            AND quantity_delta = quantity_after - quantity_before AND inventory_revision >= 1),
        CONSTRAINT product_variant_inventory_adjustments_action_delta_check
          CHECK ((action = 'increase' AND requested_quantity > 0 AND quantity_delta = requested_quantity)
            OR (action = 'decrease' AND requested_quantity > 0 AND quantity_delta = -requested_quantity)
            OR (action = 'set' AND requested_quantity = quantity_after)),
        CONSTRAINT product_variant_inventory_adjustments_reason_nonempty
          CHECK (btrim(reason) <> '')
      )
    `.execute(db)
    await sql`
      CREATE INDEX product_variant_inventory_adjustments_sku_created_idx
      ON product_variant_inventory_adjustments (product_id, product_variant_id, created_at DESC, id DESC)
    `.execute(db)

    await sql`
      CREATE FUNCTION touch_product_quantity_inventory_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.stocked, NEW.reserved) IS DISTINCT FROM ROW(OLD.stocked, OLD.reserved) THEN
          NEW.updated_at := now();
        ELSE
          NEW.updated_at := OLD.updated_at;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER product_variant_quantity_inventory_updated_at
      BEFORE UPDATE ON product_variant_quantity_inventory
      FOR EACH ROW EXECUTE FUNCTION touch_product_quantity_inventory_updated_at()
    `.execute(db)

    // Inventory version changes must not update the D2 product or SKU revisions.
    await sql`
      CREATE OR REPLACE FUNCTION set_product_revision_and_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'product_variants' THEN
          IF ROW(NEW.id, NEW.product_id, NEW.sku_code, NEW.combination_key, NEW.sale_price,
                 NEW.compare_at_price, NEW.cost_price, NEW.enabled, NEW.retired_at, NEW.inventory_mode)
              IS NOT DISTINCT FROM
              ROW(OLD.id, OLD.product_id, OLD.sku_code, OLD.combination_key, OLD.sale_price,
                  OLD.compare_at_price, OLD.cost_price, OLD.enabled, OLD.retired_at, OLD.inventory_mode) THEN
            NEW.revision := OLD.revision;
            NEW.updated_at := OLD.updated_at;
          ELSE
            NEW.revision := OLD.revision + 1;
            NEW.updated_at := now();
          END IF;
        ELSE
          NEW.revision := OLD.revision + 1;
          NEW.updated_at := now();
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`DROP TRIGGER product_variants_touch_product_update ON product_variants`.execute(db)
    await sql`
      CREATE FUNCTION touch_product_variant_catalog_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE products AS product SET revision = product.revision + 1
        WHERE product.id IN (
          SELECT new_row.product_id
          FROM new_rows AS new_row
          JOIN old_rows AS old_row ON old_row.id = new_row.id
          WHERE ROW(new_row.id, new_row.product_id, new_row.sku_code, new_row.combination_key,
                    new_row.sale_price, new_row.compare_at_price, new_row.cost_price,
                    new_row.enabled, new_row.retired_at, new_row.inventory_mode)
              IS DISTINCT FROM
                ROW(old_row.id, old_row.product_id, old_row.sku_code, old_row.combination_key,
                    old_row.sale_price, old_row.compare_at_price, old_row.cost_price,
                    old_row.enabled, old_row.retired_at, old_row.inventory_mode)
        ) AND NOT (product.revision = 1 AND product.created_at = transaction_timestamp());
        RETURN NULL;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER product_variants_touch_product_update
      AFTER UPDATE ON product_variants
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION touch_product_variant_catalog_revision()
    `.execute(db)

    await sql`
      CREATE FUNCTION assert_product_variant_quantity_state(product_uuid uuid, variant_uuid uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        configured_mode varchar(16);
        quantity_row_exists boolean;
      BEGIN
        SELECT inventory_mode INTO configured_mode
        FROM product_variants
        WHERE product_id = product_uuid AND id = variant_uuid;
        IF NOT FOUND THEN
          RETURN;
        END IF;

        SELECT EXISTS (
          SELECT 1 FROM product_variant_quantity_inventory
          WHERE product_id = product_uuid AND product_variant_id = variant_uuid
        ) INTO quantity_row_exists;

        IF COALESCE(configured_mode = 'quantity', false) IS DISTINCT FROM quantity_row_exists THEN
          RAISE EXCEPTION 'Quantity inventory state must exist exactly for quantity-mode SKUs'
            USING ERRCODE = '23514', CONSTRAINT = 'product_variant_quantity_state_consistent';
        END IF;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE FUNCTION enforce_product_variant_quantity_state() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE product_uuid uuid; variant_uuid uuid;
      BEGIN
        IF TG_TABLE_NAME = 'product_variants' THEN
          IF TG_OP <> 'INSERT' THEN
            PERFORM assert_product_variant_quantity_state(OLD.product_id, OLD.id);
          END IF;
          IF TG_OP <> 'DELETE' THEN
            PERFORM assert_product_variant_quantity_state(NEW.product_id, NEW.id);
          END IF;
        ELSE
          IF TG_OP <> 'INSERT' THEN
            PERFORM assert_product_variant_quantity_state(OLD.product_id, OLD.product_variant_id);
          END IF;
          IF TG_OP <> 'DELETE' THEN
            PERFORM assert_product_variant_quantity_state(NEW.product_id, NEW.product_variant_id);
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE CONSTRAINT TRIGGER product_variants_quantity_state_consistent
      AFTER INSERT OR UPDATE ON product_variants DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_product_variant_quantity_state()
    `.execute(db)
    await sql`
      CREATE CONSTRAINT TRIGGER quantity_inventory_state_consistent
      AFTER INSERT OR UPDATE OR DELETE ON product_variant_quantity_inventory DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_product_variant_quantity_state()
    `.execute(db)

    await sql`
      CREATE FUNCTION prevent_inventory_adjustment_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Inventory adjustment history is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'product_variant_inventory_adjustments_immutable';
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER product_variant_inventory_adjustments_immutable
      BEFORE UPDATE OR DELETE ON product_variant_inventory_adjustments
      FOR EACH ROW EXECUTE FUNCTION prevent_inventory_adjustment_mutation()
    `.execute(db)
  },

  async down(db) {
    await sql`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM product_variant_inventory_adjustments)
          OR EXISTS (SELECT 1 FROM product_variant_quantity_inventory)
          OR EXISTS (SELECT 1 FROM product_variants
                     WHERE compare_at_price IS NOT NULL OR cost_price IS NOT NULL
                       OR inventory_mode IS NOT NULL OR inventory_revision <> 0) THEN
          RAISE EXCEPTION 'Cannot remove D3 schema while price or inventory data exists'
            USING ERRCODE = '23514', CONSTRAINT = 'product_pricing_inventory_data_present';
        END IF;
      END;
      $$
    `.execute(db)
    await sql`DROP TRIGGER product_variant_inventory_adjustments_immutable ON product_variant_inventory_adjustments`.execute(db)
    await sql`DROP FUNCTION prevent_inventory_adjustment_mutation()`.execute(db)
    await sql`DROP TRIGGER quantity_inventory_state_consistent ON product_variant_quantity_inventory`.execute(db)
    await sql`DROP TRIGGER product_variants_quantity_state_consistent ON product_variants`.execute(db)
    await sql`DROP FUNCTION enforce_product_variant_quantity_state()`.execute(db)
    await sql`DROP FUNCTION assert_product_variant_quantity_state(uuid, uuid)`.execute(db)
    await sql`DROP TRIGGER product_variants_touch_product_update ON product_variants`.execute(db)
    await sql`DROP FUNCTION touch_product_variant_catalog_revision()`.execute(db)
    await sql`
      CREATE TRIGGER product_variants_touch_product_update
      AFTER UPDATE ON product_variants
      REFERENCING NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION touch_product_catalog_revision()
    `.execute(db)
    await sql`DROP TRIGGER product_variant_quantity_inventory_updated_at ON product_variant_quantity_inventory`.execute(db)
    await sql`DROP FUNCTION touch_product_quantity_inventory_updated_at()`.execute(db)
    await sql`DROP TABLE product_variant_inventory_adjustments`.execute(db)
    await sql`DROP TABLE product_variant_quantity_inventory`.execute(db)
    await sql`ALTER TABLE product_variants
      DROP CONSTRAINT product_variants_compare_at_price_check,
      DROP CONSTRAINT product_variants_cost_price_check,
      DROP CONSTRAINT product_variants_inventory_mode_check,
      DROP CONSTRAINT product_variants_inventory_revision_check,
      DROP COLUMN compare_at_price,
      DROP COLUMN cost_price,
      DROP COLUMN inventory_mode,
      DROP COLUMN inventory_revision`.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION set_product_revision_and_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        NEW.revision := OLD.revision + 1;
        NEW.updated_at := now();
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION protect_retired_product_variant() RETURNS trigger
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
  },
}
