import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const storefrontFeaturedProductsMigration: Migration = {
  async up(db) {
    await sql.raw(`
      CREATE TABLE storefront_featured_products (
        position integer PRIMARY KEY
          CONSTRAINT storefront_featured_products_position_check CHECK (position BETWEEN 1 AND 8),
        product_id uuid NOT NULL
          CONSTRAINT storefront_featured_products_product_fkey REFERENCES products(id) ON DELETE CASCADE,
        CONSTRAINT storefront_featured_products_product_unique UNIQUE (product_id)
      )
    `).execute(db)
  },
  async down(db) {
    await sql`DROP TABLE storefront_featured_products`.execute(db)
  },
}
