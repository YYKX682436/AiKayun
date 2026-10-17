import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const inventoryRetirementSafetyMigration: Migration = {
  async up(db) {
    await sql`
      DO $$
      DECLARE legacy_count bigint;
      BEGIN
        SELECT count(*) INTO legacy_count
        FROM product_variants AS variant
        JOIN product_variant_quantity_inventory AS inventory
          ON inventory.product_id = variant.product_id
          AND inventory.product_variant_id = variant.id
        WHERE variant.retired_at IS NOT NULL
          AND (inventory.stocked > 0 OR inventory.reserved > 0);
        IF legacy_count > 0 THEN
          RAISE NOTICE 'Preserving % permanently retired SKU inventory row(s); reduce legacy stocked quantity through the guarded adjustment API after migration', legacy_count;
        END IF;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION protect_retired_product_variant() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        quantity_stocked integer;
        quantity_reserved integer;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.retired_at IS NOT NULL THEN
            RAISE EXCEPTION 'A permanently retired SKU cannot be deleted'
              USING ERRCODE = '23514', CONSTRAINT = 'product_variant_retired_immutable';
          END IF;
          RETURN OLD;
        END IF;

        IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL THEN
          SELECT stocked, reserved INTO quantity_stocked, quantity_reserved
          FROM product_variant_quantity_inventory
          WHERE product_id = OLD.product_id AND product_variant_id = OLD.id
          FOR UPDATE;
          IF FOUND AND quantity_reserved > 0 THEN
            RAISE EXCEPTION 'A SKU with reserved quantity cannot be permanently retired'
              USING ERRCODE = '23514', CONSTRAINT = 'product_variant_retirement_reserved_check';
          END IF;
          IF FOUND AND quantity_stocked > 0 THEN
            RAISE EXCEPTION 'Stocked quantity must be zero before permanently retiring a SKU'
              USING ERRCODE = '23514', CONSTRAINT = 'product_variant_retirement_stocked_check';
          END IF;
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
          OR (NEW.inventory_revision IS DISTINCT FROM OLD.inventory_revision AND (
            NEW.inventory_revision <> OLD.inventory_revision + 1
            OR NOT EXISTS (
              SELECT 1
              FROM product_variant_inventory_adjustments AS adjustment
              JOIN product_variant_quantity_inventory AS inventory
                ON inventory.product_id = adjustment.product_id
                AND inventory.product_variant_id = adjustment.product_variant_id
              WHERE adjustment.product_id = OLD.product_id
                AND adjustment.product_variant_id = OLD.id
                AND adjustment.inventory_revision = NEW.inventory_revision
                AND adjustment.quantity_after < adjustment.quantity_before
                AND adjustment.quantity_after = inventory.stocked
            )
          ))
        ) THEN
          RAISE EXCEPTION 'A permanently retired SKU cannot be repriced, reconfigured, or reused'
            USING ERRCODE = '23514', CONSTRAINT = 'product_variant_retired_immutable';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE FUNCTION prevent_product_inventory_truncate() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'TRUNCATE is not allowed on inventory table %', TG_TABLE_NAME
          USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_truncate_forbidden';
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER product_variant_quantity_inventory_prevent_truncate
      BEFORE TRUNCATE ON product_variant_quantity_inventory
      FOR EACH STATEMENT EXECUTE FUNCTION prevent_product_inventory_truncate()
    `.execute(db)
    await sql`
      CREATE TRIGGER product_variant_inventory_adjustments_prevent_truncate
      BEFORE TRUNCATE ON product_variant_inventory_adjustments
      FOR EACH STATEMENT EXECUTE FUNCTION prevent_product_inventory_truncate()
    `.execute(db)
  },

  async down(db) {
    await sql`DROP TRIGGER product_variant_inventory_adjustments_prevent_truncate ON product_variant_inventory_adjustments`.execute(db)
    await sql`DROP TRIGGER product_variant_quantity_inventory_prevent_truncate ON product_variant_quantity_inventory`.execute(db)
    await sql`DROP FUNCTION prevent_product_inventory_truncate()`.execute(db)
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
  },
}
