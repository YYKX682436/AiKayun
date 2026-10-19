import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const customerCartMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE customer_cart_items (
        customer_id uuid NOT NULL,
        sku_id uuid NOT NULL,
        quantity integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT customer_cart_items_pkey PRIMARY KEY (customer_id, sku_id),
        CONSTRAINT customer_cart_items_customer_fkey
          FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
        CONSTRAINT customer_cart_items_quantity_check CHECK (quantity BETWEEN 1 AND 99)
      )
    `.execute(db)
    await sql`CREATE INDEX customer_cart_items_customer_updated_idx ON customer_cart_items (customer_id, updated_at DESC, sku_id)`.execute(db)

    // SKU identity is deliberately not a foreign key: deleted catalog items
    // remain visible as unavailable cart entries and never block product deletion.
    await sql`
      CREATE TABLE customer_cart_merge_requests (
        customer_id uuid NOT NULL,
        merge_id uuid NOT NULL,
        request_sha256 char(64) NOT NULL,
        skipped_sku_ids uuid[] NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT customer_cart_merge_requests_pkey PRIMARY KEY (customer_id, merge_id),
        CONSTRAINT customer_cart_merge_requests_customer_fkey
          FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
        CONSTRAINT customer_cart_merge_requests_hash_check CHECK (request_sha256 ~ '^[0-9a-f]{64}$')
      )
    `.execute(db)
    await sql`CREATE INDEX customer_cart_merge_requests_customer_created_idx ON customer_cart_merge_requests (customer_id, created_at DESC)`.execute(db)
  },

  async down(db) {
    const rows = await sql<{ item_count: string; merge_count: string }>`
      SELECT
        (SELECT count(*)::text FROM customer_cart_items) AS item_count,
        (SELECT count(*)::text FROM customer_cart_merge_requests) AS merge_count
    `.execute(db)
    if (rows.rows[0]?.item_count !== '0' || rows.rows[0]?.merge_count !== '0') {
      throw new Error('Cannot remove customer cart tables while cart or merge records exist')
    }
    await sql`DROP TABLE customer_cart_merge_requests`.execute(db)
    await sql`DROP TABLE customer_cart_items`.execute(db)
  },
}
