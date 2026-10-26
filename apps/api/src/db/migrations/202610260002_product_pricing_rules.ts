import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const productPricingRulesMigration: Migration = {
  async up(db) {
    await sql`
      ALTER TABLE product_variants
        ADD COLUMN pricing_mode varchar(24) NOT NULL DEFAULT 'manual',
        ADD COLUMN pricing_fixed_profit numeric(18, 5),
        ADD COLUMN pricing_markup_rate numeric(10, 4),
        ADD COLUMN pricing_rule_revision integer NOT NULL DEFAULT 0,
        ADD COLUMN pricing_rule_status varchar(16) NOT NULL DEFAULT 'manual',
        ADD CONSTRAINT product_variants_pricing_mode_check
          CHECK (pricing_mode IN ('manual', 'fixed_profit', 'percentage_markup')),
        ADD CONSTRAINT product_variants_pricing_fixed_profit_check
          CHECK (pricing_fixed_profit IS NULL OR (pricing_fixed_profit >= 0 AND pricing_fixed_profit = trunc(pricing_fixed_profit, 5))),
        ADD CONSTRAINT product_variants_pricing_markup_rate_check
          CHECK (pricing_markup_rate IS NULL OR (pricing_markup_rate >= 0 AND pricing_markup_rate <= 999999.9999
            AND pricing_markup_rate = trunc(pricing_markup_rate, 4))),
        ADD CONSTRAINT product_variants_pricing_rule_revision_check CHECK (pricing_rule_revision >= 0),
        ADD CONSTRAINT product_variants_pricing_rule_state_check
          CHECK (
            (pricing_mode = 'manual' AND pricing_fixed_profit IS NULL AND pricing_markup_rate IS NULL
              AND pricing_rule_status = 'manual')
            OR (pricing_mode = 'fixed_profit' AND pricing_fixed_profit IS NOT NULL AND pricing_markup_rate IS NULL
              AND pricing_rule_status IN ('pending', 'applied', 'stale'))
            OR (pricing_mode = 'percentage_markup' AND pricing_fixed_profit IS NULL AND pricing_markup_rate IS NOT NULL
              AND pricing_rule_status IN ('pending', 'applied', 'stale'))
          )
    `.execute(db)

    await sql`
      CREATE TABLE product_variant_pricing_rule_versions (
        id uuid PRIMARY KEY,
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        revision integer NOT NULL,
        mode varchar(24) NOT NULL,
        fixed_profit numeric(18, 5),
        markup_rate numeric(10, 4),
        change_type varchar(16) NOT NULL,
        restored_from_revision integer,
        administrator_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_variant_pricing_rule_versions_sku_revision_unique
          UNIQUE (product_variant_id, revision),
        CONSTRAINT product_variant_pricing_rule_versions_revision_check CHECK (revision >= 1),
        CONSTRAINT product_variant_pricing_rule_versions_mode_check
          CHECK (mode IN ('manual', 'fixed_profit', 'percentage_markup')),
        CONSTRAINT product_variant_pricing_rule_versions_fixed_profit_check
          CHECK (fixed_profit IS NULL OR (fixed_profit >= 0 AND fixed_profit = trunc(fixed_profit, 5))),
        CONSTRAINT product_variant_pricing_rule_versions_markup_rate_check
          CHECK (markup_rate IS NULL OR (markup_rate >= 0 AND markup_rate <= 999999.9999
            AND markup_rate = trunc(markup_rate, 4))),
        CONSTRAINT product_variant_pricing_rule_versions_config_check
          CHECK (
            (mode = 'manual' AND fixed_profit IS NULL AND markup_rate IS NULL)
            OR (mode = 'fixed_profit' AND fixed_profit IS NOT NULL AND markup_rate IS NULL)
            OR (mode = 'percentage_markup' AND fixed_profit IS NULL AND markup_rate IS NOT NULL)
          ),
        CONSTRAINT product_variant_pricing_rule_versions_change_type_check
          CHECK ((change_type = 'configured' AND restored_from_revision IS NULL)
            OR (change_type = 'restored' AND restored_from_revision IS NOT NULL AND restored_from_revision >= 1))
      )
    `.execute(db)
    await sql`CREATE INDEX product_variant_pricing_rule_versions_history_idx
      ON product_variant_pricing_rule_versions (product_id, product_variant_id, revision DESC)`.execute(db)
    await sql`
      CREATE FUNCTION protect_product_pricing_rule_history() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Product pricing rule history is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'product_pricing_rule_history_immutable';
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER product_pricing_rule_history_immutable
      BEFORE UPDATE OR DELETE ON product_variant_pricing_rule_versions
      FOR EACH ROW EXECUTE FUNCTION protect_product_pricing_rule_history()`.execute(db)
    await sql`CREATE TRIGGER product_pricing_rule_history_prevent_truncate
      BEFORE TRUNCATE ON product_variant_pricing_rule_versions
      FOR EACH STATEMENT EXECUTE FUNCTION protect_product_pricing_rule_history()`.execute(db)

    await sql`
      CREATE FUNCTION bump_product_variant_pricing_rule_state() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.pricing_mode, NEW.pricing_fixed_profit, NEW.pricing_markup_rate)
            IS DISTINCT FROM ROW(OLD.pricing_mode, OLD.pricing_fixed_profit, OLD.pricing_markup_rate) THEN
          NEW.pricing_rule_revision := OLD.pricing_rule_revision + 1;
          NEW.pricing_rule_status := CASE WHEN NEW.pricing_mode = 'manual' THEN 'manual' ELSE 'pending' END;
        ELSIF NEW.pricing_mode <> 'manual'
          AND ROW(NEW.sale_price, NEW.cost_price) IS DISTINCT FROM ROW(OLD.sale_price, OLD.cost_price)
          AND NEW.pricing_rule_status IS NOT DISTINCT FROM OLD.pricing_rule_status THEN
          NEW.pricing_rule_status := 'stale';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER product_variants_pricing_rule_state
      BEFORE UPDATE ON product_variants
      FOR EACH ROW EXECUTE FUNCTION bump_product_variant_pricing_rule_state()`.execute(db)

    await sql`
      CREATE FUNCTION protect_product_pricing_rule_catalog_state() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.retired_at IS NOT NULL AND ROW(
          NEW.pricing_mode, NEW.pricing_fixed_profit, NEW.pricing_markup_rate,
          NEW.pricing_rule_revision, NEW.pricing_rule_status
        ) IS DISTINCT FROM ROW(
          OLD.pricing_mode, OLD.pricing_fixed_profit, OLD.pricing_markup_rate,
          OLD.pricing_rule_revision, OLD.pricing_rule_status
        ) THEN
          RAISE EXCEPTION 'A permanently retired SKU cannot change its pricing rule'
            USING ERRCODE = '23514', CONSTRAINT = 'product_variant_retired_pricing_rule_immutable';
        END IF;
        IF ROW(NEW.pricing_mode, NEW.pricing_fixed_profit, NEW.pricing_markup_rate,
               NEW.pricing_rule_revision, NEW.pricing_rule_status)
            IS DISTINCT FROM ROW(OLD.pricing_mode, OLD.pricing_fixed_profit, OLD.pricing_markup_rate,
               OLD.pricing_rule_revision, OLD.pricing_rule_status)
          AND EXISTS (SELECT 1 FROM products WHERE id = OLD.product_id AND status = 'archived') THEN
          RAISE EXCEPTION 'An archived product pricing rule cannot be changed'
            USING ERRCODE = '23514', CONSTRAINT = 'product_archived_pricing_rule_immutable';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER product_variants_pricing_rule_catalog_state
      BEFORE UPDATE ON product_variants
      FOR EACH ROW EXECUTE FUNCTION protect_product_pricing_rule_catalog_state()`.execute(db)

    // Keep product/SKU catalog revisions authoritative for rule edits and for
    // status invalidation after a direct price or cost edit.
    await sql`
      CREATE OR REPLACE FUNCTION set_product_revision_and_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'product_variants' THEN
          IF ROW(NEW.id, NEW.product_id, NEW.sku_code, NEW.combination_key, NEW.sale_price,
                 NEW.compare_at_price, NEW.cost_price, NEW.enabled, NEW.retired_at,
                 NEW.inventory_mode, NEW.purchase_limit_per_order, NEW.purchase_limit_lifetime,
                 NEW.purchase_limit_24h, NEW.pricing_mode, NEW.pricing_fixed_profit,
                 NEW.pricing_markup_rate, NEW.pricing_rule_revision, NEW.pricing_rule_status)
              IS NOT DISTINCT FROM
              ROW(OLD.id, OLD.product_id, OLD.sku_code, OLD.combination_key, OLD.sale_price,
                  OLD.compare_at_price, OLD.cost_price, OLD.enabled, OLD.retired_at,
                  OLD.inventory_mode, OLD.purchase_limit_per_order, OLD.purchase_limit_lifetime,
                  OLD.purchase_limit_24h, OLD.pricing_mode, OLD.pricing_fixed_profit,
                  OLD.pricing_markup_rate, OLD.pricing_rule_revision, OLD.pricing_rule_status) THEN
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
    await sql`
      CREATE OR REPLACE FUNCTION touch_product_variant_catalog_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE products AS product SET revision = product.revision + 1
        WHERE product.id IN (
          SELECT new_row.product_id
          FROM new_rows AS new_row
          JOIN old_rows AS old_row ON old_row.id = new_row.id
          WHERE ROW(new_row.id, new_row.product_id, new_row.sku_code, new_row.combination_key,
                    new_row.sale_price, new_row.compare_at_price, new_row.cost_price,
                    new_row.enabled, new_row.retired_at, new_row.inventory_mode,
                    new_row.purchase_limit_per_order, new_row.purchase_limit_lifetime,
                    new_row.purchase_limit_24h, new_row.pricing_mode, new_row.pricing_fixed_profit,
                    new_row.pricing_markup_rate, new_row.pricing_rule_revision, new_row.pricing_rule_status)
              IS DISTINCT FROM
                ROW(old_row.id, old_row.product_id, old_row.sku_code, old_row.combination_key,
                    old_row.sale_price, old_row.compare_at_price, old_row.cost_price,
                    old_row.enabled, old_row.retired_at, old_row.inventory_mode,
                    old_row.purchase_limit_per_order, old_row.purchase_limit_lifetime,
                    old_row.purchase_limit_24h, old_row.pricing_mode, old_row.pricing_fixed_profit,
                    old_row.pricing_markup_rate, old_row.pricing_rule_revision, old_row.pricing_rule_status)
        ) AND NOT (product.revision = 1 AND product.created_at = transaction_timestamp());
        RETURN NULL;
      END;
      $$
    `.execute(db)

    await sql`ALTER TABLE product_management_audit_events
      DROP CONSTRAINT product_management_audit_operation_check`.execute(db)
    await sql`ALTER TABLE product_management_audit_events
      ADD CONSTRAINT product_management_audit_operation_check CHECK (operation IN (
        'created', 'updated', 'published', 'paused', 'relisted', 'archived', 'restored', 'copied', 'deleted',
        'gallery_updated', 'rich_content_updated', 'rule_saved', 'rule_restored', 'rule_applied', 'price_updated'
      ))`.execute(db)
  },

  async down(db) {
    const history = await sql<{ count: string }>`SELECT count(*)::text AS count FROM product_variant_pricing_rule_versions`.execute(db)
    const configured = await sql<{ count: string }>`SELECT count(*)::text AS count FROM product_variants
      WHERE pricing_mode <> 'manual' OR pricing_rule_revision <> 0`.execute(db)
    if (Number(history.rows[0]?.count ?? '0') > 0 || Number(configured.rows[0]?.count ?? '0') > 0) {
      throw new Error('Cannot roll back product pricing rules after rule history or non-manual configuration exists')
    }
    await sql`ALTER TABLE product_management_audit_events DROP CONSTRAINT product_management_audit_operation_check`.execute(db)
    await sql`ALTER TABLE product_management_audit_events ADD CONSTRAINT product_management_audit_operation_check
      CHECK (operation IN ('created', 'updated', 'published', 'paused', 'relisted', 'archived', 'restored', 'copied', 'deleted', 'gallery_updated', 'rich_content_updated'))`.execute(db)
    await sql`DROP TRIGGER product_variants_pricing_rule_catalog_state ON product_variants`.execute(db)
    await sql`DROP FUNCTION protect_product_pricing_rule_catalog_state()`.execute(db)
    await sql`DROP TRIGGER product_variants_pricing_rule_state ON product_variants`.execute(db)
    await sql`DROP FUNCTION bump_product_variant_pricing_rule_state()`.execute(db)
    await sql`DROP TRIGGER product_pricing_rule_history_prevent_truncate ON product_variant_pricing_rule_versions`.execute(db)
    await sql`DROP TRIGGER product_pricing_rule_history_immutable ON product_variant_pricing_rule_versions`.execute(db)
    await sql`DROP FUNCTION protect_product_pricing_rule_history()`.execute(db)
    await sql`DROP TABLE product_variant_pricing_rule_versions`.execute(db)
    await sql`ALTER TABLE product_variants
      DROP CONSTRAINT product_variants_pricing_rule_state_check,
      DROP CONSTRAINT product_variants_pricing_rule_revision_check,
      DROP CONSTRAINT product_variants_pricing_markup_rate_check,
      DROP CONSTRAINT product_variants_pricing_fixed_profit_check,
      DROP CONSTRAINT product_variants_pricing_mode_check,
      DROP COLUMN pricing_rule_status,
      DROP COLUMN pricing_rule_revision,
      DROP COLUMN pricing_markup_rate,
      DROP COLUMN pricing_fixed_profit,
      DROP COLUMN pricing_mode`.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION set_product_revision_and_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'product_variants' THEN
          IF ROW(NEW.id, NEW.product_id, NEW.sku_code, NEW.combination_key, NEW.sale_price,
                 NEW.compare_at_price, NEW.cost_price, NEW.enabled, NEW.retired_at,
                 NEW.inventory_mode, NEW.purchase_limit_per_order, NEW.purchase_limit_lifetime,
                 NEW.purchase_limit_24h)
              IS NOT DISTINCT FROM
              ROW(OLD.id, OLD.product_id, OLD.sku_code, OLD.combination_key, OLD.sale_price,
                  OLD.compare_at_price, OLD.cost_price, OLD.enabled, OLD.retired_at,
                  OLD.inventory_mode, OLD.purchase_limit_per_order, OLD.purchase_limit_lifetime,
                  OLD.purchase_limit_24h) THEN
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
    await sql`
      CREATE OR REPLACE FUNCTION touch_product_variant_catalog_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE products AS product SET revision = product.revision + 1
        WHERE product.id IN (
          SELECT new_row.product_id FROM new_rows AS new_row
          JOIN old_rows AS old_row ON old_row.id = new_row.id
          WHERE ROW(new_row.id, new_row.product_id, new_row.sku_code, new_row.combination_key,
                    new_row.sale_price, new_row.compare_at_price, new_row.cost_price,
                    new_row.enabled, new_row.retired_at, new_row.inventory_mode,
                    new_row.purchase_limit_per_order, new_row.purchase_limit_lifetime,
                    new_row.purchase_limit_24h)
            IS DISTINCT FROM ROW(old_row.id, old_row.product_id, old_row.sku_code, old_row.combination_key,
                    old_row.sale_price, old_row.compare_at_price, old_row.cost_price,
                    old_row.enabled, old_row.retired_at, old_row.inventory_mode,
                    old_row.purchase_limit_per_order, old_row.purchase_limit_lifetime,
                    old_row.purchase_limit_24h)
        ) AND NOT (product.revision = 1 AND product.created_at = transaction_timestamp());
        RETURN NULL;
      END;
      $$
    `.execute(db)
  },
}
