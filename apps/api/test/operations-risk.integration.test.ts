import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { Pool } from 'pg'
import type { Database } from '../src/db/types.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { readOperationsFiles, readOperationsRisk, readOperationsWorkers } from '../src/operations/risk.js'

const url = process.env.TEST_DATABASE_URL
let db: Kysely<Database>
describe.skipIf(!url)('operations read-only aggregates on PostgreSQL', () => {
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('isolated test database required')
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }) })
    const database = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)
    if (!database.rows[0]?.name.endsWith('_test')) throw new Error('isolated test database required')
    await sql`DROP SCHEMA public CASCADE`.execute(db)
    await sql`CREATE SCHEMA public`.execute(db)
    const migration = await new Migrator({ db, provider: new AppMigrationProvider() }).migrateToLatest()
    if (migration.error) throw migration.error
  })
  afterAll(async () => { await db?.destroy() })
  it('executes all aggregates and treats absent monitoring as unknown', async () => {
    const risks = await readOperationsRisk(db)
    expect(risks.rows).toEqual([])
    const workers = await readOperationsWorkers(db)
    expect(workers.workers).toHaveLength(4)
    expect(workers.workers.every(w => w.status === 'unknown' && w.backlog === 0)).toBe(true)
    const files = await readOperationsFiles(db)
    expect(files.files).toHaveLength(4)
    expect(files.files.every(f => f.status === 'unknown')).toBe(true)
  })
  it('excludes fresh payment requests, then reports only the older unknown request', async () => {
    const customer = randomUUID()
    await sql`INSERT INTO customers (id, username, password_hash) VALUES (${customer}::uuid, 'ops-test', 'fixture')`.execute(db)
    for (const [state, age, status] of [['requesting', '1 minute', 'created'], ['requesting', '31 minutes', 'created'], ['unknown', '1 minute', 'created'], ['unknown', '11 minutes', 'created'], ['unknown', '31 minutes', 'created'], ['unknown', '31 minutes', 'failed']] as const) {
      const id = randomUUID()
      await sql`INSERT INTO payment_attempts (id, idempotency_key, request_sha256, topup_customer_id, source, amount, provider)
        VALUES (${id}::uuid, ${randomUUID()}::uuid, ${'a'.repeat(64)}, ${customer}::uuid, 'external', 1, 'fixture')`.execute(db)
      await sql`INSERT INTO payment_attempt_provider_state (payment_attempt_id, state, request_started_at)
        VALUES (${id}::uuid, ${state}, clock_timestamp() - ${age}::interval)`.execute(db)
      if (status === 'failed') await sql`UPDATE payment_attempts SET status = 'failed', completed_at = clock_timestamp() WHERE id = ${id}::uuid`.execute(db)
    }
    const risks = await readOperationsRisk(db)
    expect(risks.rows.find(row => row.kind === 'payment_requesting')?.count).toBe(1)
    expect(risks.rows.find(row => row.kind === 'payment_requesting')?.oldest).toBeTruthy()
    expect(risks.rows.find(row => row.kind === 'payment_unknown')?.count).toBe(2)
    const oldestUnknown = risks.rows.find(row => row.kind === 'payment_unknown')?.oldest
    expect(oldestUnknown).toBeTruthy()
    expect(Date.now() - Date.parse(oldestUnknown!)).toBeGreaterThanOrEqual(30 * 60_000)
    expect(Date.now() - Date.parse(oldestUnknown!)).toBeLessThan(32 * 60_000)
  })
  it('distinguishes fresh, failed and stale worker observations and stale file results', async () => {
    await sql`INSERT INTO operations_worker_health (worker, last_scan_at, last_success_at, last_failure_at, last_failure_code)
      VALUES ('unpaid_expiry', clock_timestamp(), clock_timestamp(), NULL, NULL),
      ('local_delivery', clock_timestamp(), clock_timestamp() - interval '2 minutes', clock_timestamp(), 'SCAN_FAILED'),
      ('supplier_delivery', clock_timestamp() - interval '4 minutes', clock_timestamp() - interval '4 minutes', NULL, NULL)`.execute(db)
    await sql`INSERT INTO operations_file_checks (kind, started_at, completed_at, status, counts)
      VALUES ('media', clock_timestamp() - interval '8 days', clock_timestamp() - interval '8 days', 'ok', '{"verifiedVariants": 1, "private": "secret"}')`.execute(db)
    await sql`INSERT INTO operations_worker_health (worker, last_unavailable_at, last_unavailable_code)
      VALUES ('license_renewal', clock_timestamp(), 'RELEASE_NOT_CONFIGURED')`.execute(db)
    const workers = (await readOperationsWorkers(db)).workers
    expect(workers.find(w => w.worker === 'unpaid_expiry')?.status).toBe('running')
    expect(workers.find(w => w.worker === 'local_delivery')?.status).toBe('failed')
    expect(workers.find(w => w.worker === 'supplier_delivery')?.status).toBe('unknown')
    expect(workers.find(w => w.worker === 'license_renewal')).toMatchObject({ status: 'unknown', unavailableCode: 'RELEASE_NOT_CONFIGURED' })
    const media = (await readOperationsFiles(db)).files.find(f => f.kind === 'media')!
    expect(media.status).toBe('unknown')
    expect(media.counts).toEqual({ verifiedVariants: 1 })
  })
})
