import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const storefrontBrandSettingsMigration: Migration = {
  async up(db) {
    await sql.raw(`
      CREATE TABLE storefront_brand_settings (
        singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        store_name text,
        store_logo_url text,
        store_brand_color text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT storefront_brand_settings_values_check CHECK (
          (store_name IS NULL AND store_logo_url IS NULL AND store_brand_color IS NULL)
          OR (
            store_name IS NOT NULL
            AND char_length(store_name) BETWEEN 1 AND 80
            AND btrim(store_name) <> ''
            AND store_name !~ '[<>[:cntrl:]]'
            AND store_logo_url IS NOT NULL
            AND char_length(store_logo_url) <= 2048
            AND store_brand_color ~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$'
          )
        )
      )
    `).execute(db)
  },
  async down(db) {
    await sql`DROP TABLE storefront_brand_settings`.execute(db)
  },
}
