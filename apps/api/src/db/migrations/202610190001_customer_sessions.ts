import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const customerSessionsMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE customer_sessions (
        id uuid PRIMARY KEY,
        customer_id uuid NOT NULL,
        token_hash char(64) NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        CONSTRAINT customer_sessions_customer_fkey
          FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
        CONSTRAINT customer_sessions_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT customer_sessions_expiration_check CHECK (expires_at > created_at)
      )
    `.execute(db)
    await sql`CREATE INDEX customer_sessions_customer_active_idx ON customer_sessions (customer_id, expires_at) WHERE revoked_at IS NULL`.execute(db)
    await sql`CREATE INDEX customer_sessions_expiry_idx ON customer_sessions (expires_at) WHERE revoked_at IS NULL`.execute(db)

    await sql`
      CREATE FUNCTION revoke_customer_sessions_on_status_change() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status <> 'active' AND NEW.status IS DISTINCT FROM OLD.status THEN
          UPDATE customer_sessions
          SET revoked_at = COALESCE(revoked_at, statement_timestamp())
          WHERE customer_id = NEW.id AND revoked_at IS NULL;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE TRIGGER customers_revoke_sessions_on_status_change
      AFTER UPDATE OF status ON customers
      FOR EACH ROW EXECUTE FUNCTION revoke_customer_sessions_on_status_change()
    `.execute(db)
  },

  async down(db) {
    await sql`DROP TRIGGER IF EXISTS customers_revoke_sessions_on_status_change ON customers`.execute(db)
    await sql`DROP FUNCTION IF EXISTS revoke_customer_sessions_on_status_change()`.execute(db)
    await sql`DROP TABLE IF EXISTS customer_sessions`.execute(db)
  },
}
