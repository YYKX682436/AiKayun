import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { Pool } from 'pg'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'
import { readBackupPendingSummary } from '../src/backup/pending-summary.js'

const url = process.env.TEST_DATABASE_URL
describe.skipIf(!url)('backup pending summary', () => {
  let admin: Kysely<Database>
  let db: Kysely<Database>
  let schema: string
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('isolated test database required')
    admin = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }) })
    schema = `backup_pending_${randomUUID().replaceAll('-', '')}`
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin)
    const isolated = new URL(url!)
    isolated.searchParams.set('options', `-csearch_path=${schema}`)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: isolated.toString() }) }) })
    const migration = await new Migrator({ db, provider: new AppMigrationProvider(), migrationTableSchema: schema }).migrateToLatest()
    if (migration.error) throw migration.error
  }, 60_000)
  afterAll(async () => {
    if (db) await db.destroy()
    if (admin && schema) await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin)
    if (admin) await admin.destroy()
  })

  it('reads real payment states without age thresholds or exposing any source rows', async () => {
    const initial = await readBackupPendingSummary(db)
    expect(Object.values(initial).every(value => value === 0)).toBe(true)
    const customer = randomUUID()
    const name = `private-${randomUUID()}`
    await sql`INSERT INTO customers (id, username, password_hash) VALUES (${customer}::uuid, ${name}, 'secret-fixture')`.execute(db)
    for (const [state, failed] of [['requesting', false], ['unknown', false], ['unknown', true]] as const) {
      const id = randomUUID()
      await sql`INSERT INTO payment_attempts (id, idempotency_key, request_sha256, topup_customer_id, source, amount, provider)
        VALUES (${id}::uuid, ${randomUUID()}::uuid, ${'a'.repeat(64)}, ${customer}::uuid, 'external', 1, 'fixture')`.execute(db)
      await sql`INSERT INTO payment_attempt_provider_state (payment_attempt_id, state, request_started_at)
        VALUES (${id}::uuid, ${state}, clock_timestamp())`.execute(db)
      if (failed) await sql`UPDATE payment_attempts SET status = 'failed', completed_at = clock_timestamp() WHERE id = ${id}::uuid`.execute(db)
    }
    const before = await sql<{ count: string }>`SELECT count(*)::text AS count FROM payment_attempt_provider_state`.execute(db)
    const summary = await readBackupPendingSummary(db)
    expect(summary).toEqual({ ...initial, paymentAttemptsPending: 2, paymentRequests: 1, paymentUnknown: 2 })
    expect(JSON.stringify(summary)).not.toContain(name)
    expect(JSON.stringify(summary)).not.toContain('secret-fixture')
    expect((await sql<{ count: string }>`SELECT count(*)::text AS count FROM payment_attempt_provider_state`.execute(db)).rows).toEqual(before.rows)
  })
})
