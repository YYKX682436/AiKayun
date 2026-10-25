import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Replace the preparation boolean with an irreversible-first-enable lifecycle. */
export const purchaseFormActivationStateMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE product_purchase_form_settings
      DROP CONSTRAINT product_purchase_form_mode_check,
      DROP CONSTRAINT product_purchase_form_mode_version_check,
      ADD CONSTRAINT product_purchase_form_mode_check CHECK (mode IN ('not_configured', 'none', 'template')),
      ADD CONSTRAINT product_purchase_form_mode_version_check CHECK (
        (mode IN ('not_configured', 'none') AND template_version_id IS NULL)
        OR (mode = 'template' AND template_version_id IS NOT NULL)
      )`.execute(db)
    await sql`ALTER TABLE sku_purchase_form_overrides
      DROP CONSTRAINT sku_purchase_form_mode_check,
      DROP CONSTRAINT sku_purchase_form_mode_version_check,
      ADD CONSTRAINT sku_purchase_form_mode_check CHECK (mode IN ('product_default', 'none', 'template')),
      ADD CONSTRAINT sku_purchase_form_mode_version_check CHECK (
        (mode IN ('product_default', 'none') AND template_version_id IS NULL)
        OR (mode = 'template' AND template_version_id IS NOT NULL)
      )`.execute(db)
    await sql`ALTER TABLE purchase_form_audit_events
      DROP CONSTRAINT purchase_form_audit_operation_check,
      DROP CONSTRAINT purchase_form_audit_scope_check,
      ADD CONSTRAINT purchase_form_audit_operation_check CHECK (operation IN (
        'template_created', 'template_updated', 'template_version_saved',
        'product_assignment_updated', 'sku_override_updated',
        'product_assignment_applied', 'sku_override_applied', 'purchase_forms_status_changed'
      )),
      ADD CONSTRAINT purchase_form_audit_scope_check CHECK (
        (operation IN ('template_created', 'template_updated', 'template_version_saved')
          AND template_id IS NOT NULL AND product_id IS NULL AND product_variant_id IS NULL) OR
        (operation IN ('product_assignment_updated', 'product_assignment_applied')
          AND product_id IS NOT NULL AND template_id IS NULL AND product_variant_id IS NULL) OR
        (operation IN ('sku_override_updated', 'sku_override_applied')
          AND product_id IS NOT NULL AND product_variant_id IS NOT NULL AND template_id IS NULL) OR
        (operation = 'purchase_forms_status_changed'
          AND template_id IS NULL AND product_id IS NULL AND product_variant_id IS NULL)
      )`.execute(db)
    await sql`ALTER TABLE storefront_customer_policy
      ADD COLUMN purchase_forms_status varchar(16) NOT NULL DEFAULT 'preparing'
      CHECK (purchase_forms_status IN ('preparing', 'active', 'paused'))`.execute(db)
    await sql`UPDATE storefront_customer_policy
      SET purchase_forms_status = CASE WHEN purchase_forms_enabled THEN 'active' ELSE 'preparing' END`.execute(db)

    await sql`ALTER TABLE product_purchase_form_settings
      ADD COLUMN applied_mode varchar(16),
      ADD COLUMN applied_template_version_id uuid,
      ADD CONSTRAINT product_purchase_form_applied_version_fkey
        FOREIGN KEY (applied_template_version_id) REFERENCES purchase_form_template_versions (id) ON DELETE RESTRICT,
      ADD CONSTRAINT product_purchase_form_applied_shape_check CHECK (
        (applied_mode IS NULL AND applied_template_version_id IS NULL)
        OR (applied_mode = 'none' AND applied_template_version_id IS NULL)
        OR (applied_mode = 'template' AND applied_template_version_id IS NOT NULL)
      )`.execute(db)
    await sql`ALTER TABLE sku_purchase_form_overrides
      ADD COLUMN applied_mode varchar(16),
      ADD COLUMN applied_template_version_id uuid,
      ADD CONSTRAINT sku_purchase_form_applied_version_fkey
        FOREIGN KEY (applied_template_version_id) REFERENCES purchase_form_template_versions (id) ON DELETE RESTRICT,
      ADD CONSTRAINT sku_purchase_form_applied_shape_check CHECK (
        (applied_mode IS NULL AND applied_template_version_id IS NULL)
        OR (applied_mode = 'none' AND applied_template_version_id IS NULL)
        OR (applied_mode = 'template' AND applied_template_version_id IS NOT NULL)
      )`.execute(db)

    // A true legacy flag represented already-enabled behavior. Preserve it;
    // false rows stay safely in preparation with no effective assignment.
    await sql`UPDATE product_purchase_form_settings AS setting
      SET applied_mode = CASE WHEN setting.mode = 'not_configured' THEN 'none' ELSE setting.mode END,
          applied_template_version_id = setting.template_version_id
      WHERE EXISTS (SELECT 1 FROM storefront_customer_policy AS policy
        WHERE policy.singleton = true AND policy.purchase_forms_status = 'active')`.execute(db)
    await sql`UPDATE sku_purchase_form_overrides AS setting
      SET applied_mode = CASE WHEN setting.mode = 'product_default' THEN NULL ELSE setting.mode END,
          applied_template_version_id = setting.template_version_id
      WHERE EXISTS (SELECT 1 FROM storefront_customer_policy AS policy
        WHERE policy.singleton = true AND policy.purchase_forms_status = 'active')`.execute(db)

    await sql`
      CREATE FUNCTION guard_purchase_forms_status_transition() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.purchase_forms_status IS NOT DISTINCT FROM OLD.purchase_forms_status THEN RETURN NEW; END IF;
        IF NOT (
          (OLD.purchase_forms_status = 'preparing' AND NEW.purchase_forms_status = 'active')
          OR (OLD.purchase_forms_status = 'active' AND NEW.purchase_forms_status = 'paused')
          OR (OLD.purchase_forms_status = 'paused' AND NEW.purchase_forms_status = 'active')
        ) THEN
          RAISE EXCEPTION 'Purchase form lifecycle transition is invalid'
            USING ERRCODE = '23514', CONSTRAINT = 'purchase_forms_status_transition_invalid';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER storefront_purchase_forms_status_transition
      BEFORE UPDATE OF purchase_forms_status ON storefront_customer_policy
      FOR EACH ROW EXECUTE FUNCTION guard_purchase_forms_status_transition()`.execute(db)
    await sql`ALTER TABLE storefront_customer_policy DROP COLUMN purchase_forms_enabled`.execute(db)
  },
  async down(db) {
    // A legacy boolean cannot represent a paused installation, staged-versus-applied
    // divergence, or the new explicit inheritance modes. Refuse before any DDL so a
    // rollback cannot silently reopen ordering or discard prepared intent.
    await sql`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM storefront_customer_policy WHERE purchase_forms_status = 'paused') THEN
          RAISE EXCEPTION 'Cannot downgrade paused purchase form lifecycle without reopening ordering'
            USING ERRCODE = '55000';
        END IF;
        IF EXISTS (SELECT 1 FROM product_purchase_form_settings WHERE mode = 'not_configured')
          OR EXISTS (SELECT 1 FROM sku_purchase_form_overrides WHERE mode = 'product_default') THEN
          RAISE EXCEPTION 'Cannot downgrade explicit purchase form inheritance modes without losing prepared state'
            USING ERRCODE = '55000';
        END IF;
        IF EXISTS (
          SELECT 1 FROM storefront_customer_policy AS policy
          WHERE policy.purchase_forms_status = 'active' AND (
            EXISTS (
              SELECT 1 FROM product_purchase_form_settings AS setting
              WHERE setting.applied_mode IS DISTINCT FROM setting.mode
                OR setting.applied_template_version_id IS DISTINCT FROM setting.template_version_id
            ) OR EXISTS (
              SELECT 1 FROM sku_purchase_form_overrides AS setting
              WHERE setting.applied_mode IS DISTINCT FROM setting.mode
                OR setting.applied_template_version_id IS DISTINCT FROM setting.template_version_id
            )
          )
        ) THEN
          RAISE EXCEPTION 'Cannot downgrade purchase form changes that have not been explicitly applied'
            USING ERRCODE = '55000';
        END IF;
      END
    $$`.execute(db)
    await sql`ALTER TABLE storefront_customer_policy ADD COLUMN purchase_forms_enabled boolean NOT NULL DEFAULT false`.execute(db)
    await sql`UPDATE storefront_customer_policy SET purchase_forms_enabled = purchase_forms_status <> 'preparing'`.execute(db)
    await sql`DROP TRIGGER IF EXISTS storefront_purchase_forms_status_transition ON storefront_customer_policy`.execute(db)
    await sql`DROP FUNCTION IF EXISTS guard_purchase_forms_status_transition()`.execute(db)
    await sql`ALTER TABLE sku_purchase_form_overrides
      DROP CONSTRAINT IF EXISTS sku_purchase_form_applied_shape_check,
      DROP CONSTRAINT IF EXISTS sku_purchase_form_applied_version_fkey,
      DROP COLUMN IF EXISTS applied_template_version_id,
      DROP COLUMN IF EXISTS applied_mode`.execute(db)
    await sql`ALTER TABLE product_purchase_form_settings
      DROP CONSTRAINT IF EXISTS product_purchase_form_applied_shape_check,
      DROP CONSTRAINT IF EXISTS product_purchase_form_applied_version_fkey,
      DROP COLUMN IF EXISTS applied_template_version_id,
      DROP COLUMN IF EXISTS applied_mode`.execute(db)
    await sql`ALTER TABLE storefront_customer_policy DROP COLUMN purchase_forms_status`.execute(db)
    await sql`DELETE FROM sku_purchase_form_overrides WHERE mode = 'product_default'`.execute(db)
    await sql`UPDATE product_purchase_form_settings SET mode = 'none' WHERE mode = 'not_configured'`.execute(db)
    await sql`ALTER TABLE sku_purchase_form_overrides
      DROP CONSTRAINT IF EXISTS sku_purchase_form_mode_version_check,
      DROP CONSTRAINT IF EXISTS sku_purchase_form_mode_check,
      ADD CONSTRAINT sku_purchase_form_mode_check CHECK (mode IN ('none', 'template')),
      ADD CONSTRAINT sku_purchase_form_mode_version_check CHECK (
        (mode = 'none' AND template_version_id IS NULL) OR (mode = 'template' AND template_version_id IS NOT NULL)
      )`.execute(db)
    await sql`ALTER TABLE product_purchase_form_settings
      DROP CONSTRAINT IF EXISTS product_purchase_form_mode_version_check,
      DROP CONSTRAINT IF EXISTS product_purchase_form_mode_check,
      ADD CONSTRAINT product_purchase_form_mode_check CHECK (mode IN ('none', 'template')),
      ADD CONSTRAINT product_purchase_form_mode_version_check CHECK (
        (mode = 'none' AND template_version_id IS NULL) OR (mode = 'template' AND template_version_id IS NOT NULL)
      )`.execute(db)
    await sql`ALTER TABLE purchase_form_audit_events
      DROP CONSTRAINT IF EXISTS purchase_form_audit_scope_check,
      DROP CONSTRAINT IF EXISTS purchase_form_audit_operation_check,
      ADD CONSTRAINT purchase_form_audit_operation_check CHECK (operation IN (
        'template_created', 'template_updated', 'template_version_saved',
        'product_assignment_updated', 'sku_override_updated'
      )),
      ADD CONSTRAINT purchase_form_audit_scope_check CHECK (
        (operation IN ('template_created', 'template_updated', 'template_version_saved')
          AND template_id IS NOT NULL AND product_id IS NULL AND product_variant_id IS NULL) OR
        (operation = 'product_assignment_updated' AND product_id IS NOT NULL
          AND template_id IS NULL AND product_variant_id IS NULL) OR
        (operation = 'sku_override_updated' AND product_id IS NOT NULL
          AND product_variant_id IS NOT NULL AND template_id IS NULL)
      )`.execute(db)
  },
}
