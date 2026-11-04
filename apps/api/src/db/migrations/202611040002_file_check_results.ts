import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const fileCheckResultsMigration: Migration = {
  async up(db) {
    await sql.raw(`
      CREATE TABLE operations_file_checks (
        kind text PRIMARY KEY CHECK (kind IN ('media', 'private', 'draft', 'order')),
        started_at timestamptz NOT NULL,
        completed_at timestamptz,
        status text NOT NULL CHECK (status IN ('running', 'ok', 'attention', 'unknown')),
        counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
        CHECK ((status = 'running' AND completed_at IS NULL) OR (status <> 'running' AND completed_at IS NOT NULL))
      )
    `).execute(db)
  },
  async down(db) { await sql`DROP TABLE operations_file_checks`.execute(db) },
}
