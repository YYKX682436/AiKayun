import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const productManagementMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE product_management_audit_events (
        id uuid PRIMARY KEY,
        product_id uuid NOT NULL,
        administrator_id uuid NOT NULL,
        operation varchar(16) NOT NULL,
        before_data jsonb,
        after_data jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_management_audit_operation_check
          CHECK (operation IN ('created', 'updated', 'published', 'paused', 'relisted', 'archived', 'restored', 'copied', 'deleted'))
      )
    `.execute(db)

    // Product and administrator IDs are durable audit identities. These rows
    // deliberately have no foreign keys, so product deletion never erases or
    // blocks the corresponding audit history.
    await sql`
      CREATE INDEX product_management_audit_product_created_idx
      ON product_management_audit_events (product_id, created_at DESC, id DESC)
    `.execute(db)

    await sql`
      CREATE FUNCTION protect_product_management_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Product management audit history is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'product_management_audit_immutable';
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER product_management_audit_immutable
      BEFORE UPDATE OR DELETE ON product_management_audit_events
      FOR EACH ROW EXECUTE FUNCTION protect_product_management_audit()
    `.execute(db)
    await sql`
      CREATE TRIGGER product_management_audit_prevent_truncate
      BEFORE TRUNCATE ON product_management_audit_events
      FOR EACH STATEMENT EXECUTE FUNCTION protect_product_management_audit()
    `.execute(db)
  },

  async down(db) {
    await sql`DROP TABLE product_management_audit_events`.execute(db)
    await sql`DROP FUNCTION protect_product_management_audit()`.execute(db)
  },
}
