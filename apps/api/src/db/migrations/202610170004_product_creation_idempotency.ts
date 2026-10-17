import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { Database } from '../types.js'

export const productCreationIdempotencyMigration = {
  async up(db: Kysely<Database>): Promise<void> {
    await sql`
      CREATE TABLE admin_product_creation_requests (
        idempotency_key uuid PRIMARY KEY,
        administrator_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE RESTRICT,
        payload_sha256 char(64) NOT NULL,
        product_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT admin_product_creation_payload_hash_check CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
      )
    `.execute(db)
    await sql`CREATE INDEX admin_product_creation_requests_created_at_idx ON admin_product_creation_requests (created_at)`.execute(db)
  },
  async down(db: Kysely<Database>): Promise<void> {
    await sql`DROP TABLE admin_product_creation_requests`.execute(db)
  },
}
