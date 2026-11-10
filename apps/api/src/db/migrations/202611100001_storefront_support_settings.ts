import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const storefrontSupportSettingsMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE storefront_support_settings (
        singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        channels jsonb NOT NULL CHECK (
          CASE WHEN jsonb_typeof(channels) = 'array'
            THEN jsonb_array_length(channels) <= 3
            ELSE FALSE
          END
        )
      )
    `.execute(db)
  },
  async down(db) {
    await sql`DROP TABLE storefront_support_settings`.execute(db)
  },
}
