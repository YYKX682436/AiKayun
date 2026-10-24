import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const purchaseFormAuditProductIdentityMigration: Migration = {
  async up(db) {
    // Preparation audit events retain the original catalog UUIDs and summary
    // after a product is legally deleted. The audit table's immutable triggers
    // remain in place; only these two historical identity FKs are removed.
    await sql`ALTER TABLE purchase_form_audit_events
      DROP CONSTRAINT IF EXISTS purchase_form_audit_events_product_id_fkey`.execute(db)
    await sql`ALTER TABLE purchase_form_audit_events
      DROP CONSTRAINT IF EXISTS purchase_form_audit_events_product_variant_id_fkey`.execute(db)
  },

  async down(db) {
    // Reversal is intentionally constrained: if a later legal product delete
    // left audit identities behind, PostgreSQL refuses to reintroduce these FKs
    // rather than deleting or rewriting immutable history.
    await sql`ALTER TABLE purchase_form_audit_events
      ADD CONSTRAINT purchase_form_audit_events_product_id_fkey
      FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT`.execute(db)
    await sql`ALTER TABLE purchase_form_audit_events
      ADD CONSTRAINT purchase_form_audit_events_product_variant_id_fkey
      FOREIGN KEY (product_variant_id) REFERENCES product_variants (id) ON DELETE RESTRICT`.execute(db)
  },
}
