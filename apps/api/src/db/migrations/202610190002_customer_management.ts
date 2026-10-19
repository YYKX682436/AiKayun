import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const customerManagementMigration: Migration = {
  async up(db) {
    await sql`CREATE INDEX customers_admin_created_idx ON customers (created_at DESC, id DESC) WHERE status <> 'deleted'`.execute(db)
    await sql`CREATE INDEX customers_admin_status_created_idx ON customers (status, created_at DESC, id DESC)`.execute(db)
    await sql`CREATE INDEX customers_admin_username_prefix_idx ON customers (lower(username) text_pattern_ops) WHERE status <> 'deleted' AND username IS NOT NULL`.execute(db)
    await sql`CREATE INDEX customers_admin_email_prefix_idx ON customers (lower(email) text_pattern_ops) WHERE status <> 'deleted' AND email IS NOT NULL`.execute(db)
    await sql`CREATE INDEX customers_admin_phone_prefix_idx ON customers (phone text_pattern_ops) WHERE status <> 'deleted' AND phone IS NOT NULL`.execute(db)

    await sql`
      CREATE TABLE customer_management_audit (
        id uuid PRIMARY KEY,
        administrator_id uuid NOT NULL,
        customer_id uuid NOT NULL,
        action varchar(32) NOT NULL,
        summary jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT customer_management_audit_admin_fkey
          FOREIGN KEY (administrator_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT customer_management_audit_customer_fkey
          FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
        CONSTRAINT customer_management_audit_action_check CHECK (action IN (
          'username_updated', 'contact_updated', 'password_reset', 'disabled', 'restored', 'deleted'
        )),
        CONSTRAINT customer_management_audit_summary_check CHECK (jsonb_typeof(summary) = 'object')
      )
    `.execute(db)
    await sql`CREATE INDEX customer_management_audit_customer_created_idx ON customer_management_audit (customer_id, created_at DESC, id DESC)`.execute(db)
    await sql`CREATE INDEX customer_management_audit_admin_created_idx ON customer_management_audit (administrator_id, created_at DESC, id DESC)`.execute(db)

    await sql`
      CREATE FUNCTION prevent_customer_management_audit_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Customer management audit records are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'customer_management_audit_immutable';
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER customer_management_audit_immutable
      BEFORE UPDATE OR DELETE ON customer_management_audit
      FOR EACH ROW EXECUTE FUNCTION prevent_customer_management_audit_mutation()
    `.execute(db)
    await sql`
      CREATE TRIGGER customer_management_audit_prevent_truncate
      BEFORE TRUNCATE ON customer_management_audit
      FOR EACH STATEMENT EXECUTE FUNCTION prevent_customer_management_audit_mutation()
    `.execute(db)
  },

  async down(db) {
    await sql`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM customer_management_audit) THEN
          RAISE EXCEPTION 'Cannot remove customer management audit history'
            USING ERRCODE = '23514', CONSTRAINT = 'customer_management_audit_data_present';
        END IF;
      END;
      $$
    `.execute(db)
    await sql`DROP TRIGGER customer_management_audit_prevent_truncate ON customer_management_audit`.execute(db)
    await sql`DROP TRIGGER customer_management_audit_immutable ON customer_management_audit`.execute(db)
    await sql`DROP FUNCTION prevent_customer_management_audit_mutation()`.execute(db)
    await sql`DROP TABLE customer_management_audit`.execute(db)
    await sql`DROP INDEX customers_admin_phone_prefix_idx`.execute(db)
    await sql`DROP INDEX customers_admin_email_prefix_idx`.execute(db)
    await sql`DROP INDEX customers_admin_username_prefix_idx`.execute(db)
    await sql`DROP INDEX customers_admin_status_created_idx`.execute(db)
    await sql`DROP INDEX customers_admin_created_idx`.execute(db)
  },
}
