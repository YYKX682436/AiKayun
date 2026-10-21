import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Records the HMAC key needed to verify a batch replay without changing its immutable digest. */
export const codePoolOperationKeyMigration: Migration = {
  async up(db) {
    await sql`
      ALTER TABLE code_pool_batches
        ADD COLUMN request_fingerprint_key_id varchar(48),
        ADD CONSTRAINT code_pool_batches_request_key_id_check CHECK (
          request_fingerprint_key_id IS NULL OR request_fingerprint_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
        )
    `.execute(db)
  },
  async down(db) {
    await sql`
      ALTER TABLE code_pool_batches
        DROP CONSTRAINT code_pool_batches_request_key_id_check,
        DROP COLUMN request_fingerprint_key_id
    `.execute(db)
  },
}
