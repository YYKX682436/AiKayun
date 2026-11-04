import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Migrator } from 'kysely/migration'
import { sql, Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'
import { createWorkerObserver } from '../src/ops/worker-health.js'
import { createReadinessCheck } from '../src/ops/readiness.js'
import { createOperationsDiagnostics } from '../src/operations/diagnostics.js'
import { startLicenseRenewalWorker } from '../src/licensing/license-renewal-worker.js'
import type { TrustedReleaseLicenseConfig } from '../src/licensing/trusted-release-config.js'
import type { TrustBundleStore } from '../src/licensing/trust/trust-bundle-store.js'
import type { FastifyBaseLogger } from 'fastify'
import { readConfig } from '../src/config.js'

let db: Kysely<Database>
let adminDb: Kysely<Database>
let schema: string
let isolatedUrl: string
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL
  if (!url || !new URL(url).pathname.slice(1).endsWith('_test')) throw new Error('Dedicated test database required')
  adminDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }) })
  schema = `worker_health_${randomUUID().replaceAll('-', '')}`
  await sql.raw(`CREATE SCHEMA ${schema}`).execute(adminDb)
  const isolated = new URL(url)
  isolated.searchParams.set('options', `-csearch_path=${schema}`)
  isolatedUrl = isolated.toString()
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: isolatedUrl }) }) })
  const result = await new Migrator({ db, provider: new AppMigrationProvider(), migrationTableSchema: schema }).migrateToLatest()
  if (result.error) throw result.error
})
afterAll(async () => {
  if (db) await db.destroy()
  if (adminDb && schema) await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(adminDb)
  if (adminDb) await adminDb.destroy()
})

async function waitForRows(count: number) {
  for (let i = 0; i < 50; i++) {
    const result = await sql<{ count: string }>`SELECT count(*)::text AS count FROM operations_worker_health`.execute(db)
    if (Number(result.rows[0]?.count) >= count) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Worker observations did not arrive')
}

describe('worker observations', () => {
  it('records independent idle scans and fixed failure codes across observers', async () => {
    const local = createWorkerObserver(db, 'local_delivery')
    const supplier = createWorkerObserver(db, 'supplier_delivery')
    const renewal = createWorkerObserver(db, 'license_renewal')
    local(true)
    supplier(true)
    renewal(false)
    await waitForRows(3)
    const result = await sql<{ worker: string; last_success_at: Date | null; last_failure_at: Date | null; last_failure_code: string | null }>`
      SELECT worker, last_success_at, last_failure_at, last_failure_code FROM operations_worker_health ORDER BY worker
    `.execute(db)
    expect(result.rows.find(row => row.worker === 'local_delivery')?.last_failure_at).toBeNull()
    expect(result.rows.find(row => row.worker === 'supplier_delivery')?.last_success_at).toBeInstanceOf(Date)
    expect(result.rows.find(row => row.worker === 'license_renewal')?.last_failure_code).toBe('SCAN_FAILED')
    // An immediate failure followed by recovery is observed despite the periodic throttle.
    local(false)
    for (let i = 0; i < 50; i++) {
      const failed = await sql<{ last_failure_at: Date | null }>`SELECT last_failure_at FROM operations_worker_health WHERE worker = 'local_delivery'`.execute(db)
      if (failed.rows[0]?.last_failure_at) break
      if (i === 49) throw new Error('Transition to failure not observed')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    local(true)
    for (let i = 0; i < 50; i++) {
      const recovered = await sql<{ recovered: boolean }>`SELECT last_success_at > last_failure_at AS recovered FROM operations_worker_health WHERE worker = 'local_delivery'`.execute(db)
      if (recovered.rows[0]?.recovered) break
      if (i === 49) throw new Error('Transition to recovery not observed')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    // Further flapping within the window is suppressed; it cannot generate per-scan writes.
    for (let i = 0; i < 100; i++) { local(false); local(true) }
    await new Promise(resolve => setTimeout(resolve, 40))
    const stillRecovered = await sql<{ recovered: boolean }>`SELECT last_success_at > last_failure_at AS recovered FROM operations_worker_health WHERE worker = 'local_delivery'`.execute(db)
    expect(stillRecovered.rows[0]?.recovered).toBe(true)
    // A new instance can update the same row without creating an unbounded instance history.
    createWorkerObserver(db, 'license_renewal')(true)
    for (let i = 0; i < 50; i++) {
      const updated = await sql<{ last_success_at: Date | null }>`SELECT last_success_at FROM operations_worker_health WHERE worker = 'license_renewal'`.execute(db)
      if (updated.rows[0]?.last_success_at) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('Second instance observation did not arrive')
  })
})

describe('bounded readiness', () => {
  it('rejects a storage root that is a symbolic link', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'aikayun-health-link-'))
    const realRoot = await mkdtemp(join(tmpdir(), 'aikayun-health-target-'))
    const privateRoot = await mkdtemp(join(tmpdir(), 'aikayun-health-private-'))
    try {
      await symlink(realRoot, join(parent, 'media'))
      const config = readConfig({ NODE_ENV: 'test', MEDIA_ROOT: join(parent, 'media'), PRIVATE_FILE_ROOT: privateRoot })
      expect(await createReadinessCheck(db, config)()).toBe(false)
    } finally {
      await Promise.all([parent, realRoot, privateRoot].map(path => rm(path, { recursive: true, force: true })))
    }
  })
  it('returns not ready when PostgreSQL is unavailable', async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'aikayun-health-media-'))
    const privateRoot = await mkdtemp(join(tmpdir(), 'aikayun-health-private-'))
    const disconnected = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({
      host: '127.0.0.1', port: 1, user: 'unused', database: 'unavailable_test', connectionTimeoutMillis: 250,
    }) }) })
    try {
      const config = readConfig({ NODE_ENV: 'test', MEDIA_ROOT: mediaRoot, PRIVATE_FILE_ROOT: privateRoot })
      const started = performance.now()
      expect(await createReadinessCheck(disconnected, config)()).toBe(false)
      expect(performance.now() - started).toBeLessThan(2500)
    } finally {
      await disconnected.destroy()
      await rm(mediaRoot, { recursive: true, force: true })
      await rm(privateRoot, { recursive: true, force: true })
    }
  })
})

describe('safe dependency diagnostics', () => {
  it('reports missing historical payment key without returning identifiers or ciphertext', async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'aikayun-ops-media-'))
    const privateRoot = await mkdtemp(join(tmpdir(), 'aikayun-ops-private-'))
    const admin = randomUUID()
    const secretKeyId = 'private-test-key-id'
    try {
      await sql`INSERT INTO admin_users (id, email, password_hash) VALUES (${admin}::uuid, ${`${admin}@example.invalid`}, 'test-only')`.execute(db)
      await db.transaction().execute(async tx => {
        await sql`SELECT set_config('aikayun.admin_id', ${admin}, true)`.execute(tx)
        await sql`INSERT INTO payment_channels (id, provider_type, name, config_ciphertext, config_nonce, config_auth_tag, config_key_id, credential_version, created_by_admin_id, updated_by_admin_id)
        VALUES (${randomUUID()}::uuid, 'zpay_epay_v1', 'fixture', decode('01','hex'), decode(repeat('00',12),'hex'), decode(repeat('00',16),'hex'), ${secretKeyId}, 1, ${admin}::uuid, ${admin}::uuid)`.execute(tx)
      })
      const config = readConfig({ NODE_ENV: 'test', MEDIA_ROOT: mediaRoot, PRIVATE_FILE_ROOT: privateRoot })
      const report = await createOperationsDiagnostics(db, config)()
      expect(report.checks.find(check => check.key === 'payment_keys')?.reason).toBe('HISTORICAL_KEY_MISSING')
      expect(report.checks.find(check => check.key === 'historical_obligations')?.status).toBe('problem')
      expect(JSON.stringify(report)).not.toContain(secretKeyId)
      expect(JSON.stringify(report)).not.toContain(mediaRoot)
      expect(JSON.stringify(report)).not.toContain(admin)
    } finally {
      await rm(mediaRoot, { recursive: true, force: true })
      await rm(privateRoot, { recursive: true, force: true })
    }
  })
})

describe('renewal observation reflects whether a scan occurred', () => {
  it('marks a missing release config unavailable without inventing a successful scan', async () => {
    await sql`DELETE FROM operations_worker_health WHERE worker = 'license_renewal'`.execute(db)
    const pool = new Pool({ connectionString: isolatedUrl })
    const stop = startLicenseRenewalWorker({ db, pool, identityRoot: '/unused', pendingKeyRoot: '/unused',
      trustStoreRoot: '/unused', logger: { warn() {} } as unknown as FastifyBaseLogger })
    try {
      for (let i = 0; i < 50; i++) {
        const result = await sql<{ last_scan_at: Date | null; last_success_at: Date | null; last_unavailable_code: string | null }>`
          SELECT last_scan_at, last_success_at, last_unavailable_code FROM operations_worker_health WHERE worker = 'license_renewal'`.execute(db)
        if (result.rows[0]) {
          expect(result.rows[0].last_scan_at).toBeNull()
          expect(result.rows[0].last_success_at).toBeNull()
          expect(result.rows[0].last_unavailable_code).toBe('RELEASE_NOT_CONFIGURED')
          return
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error('Missing release configuration was not recorded')
    } finally { await stop(); await pool.end() }
  })

  it('does not record a successful scan when another instance holds the lock', async () => {
    await sql`DELETE FROM operations_worker_health WHERE worker = 'license_renewal'`.execute(db)
    const pool = new Pool({ connectionString: isolatedUrl })
    const locked = await pool.connect()
    await locked.query("SELECT pg_advisory_lock(hashtextextended('aikayun-license-renewal-worker', 0))")
    const stop = startLicenseRenewalWorker({ db, pool, identityRoot: '/unused', pendingKeyRoot: '/unused',
      trustStoreRoot: '/unused', logger: { warn() {} } as unknown as FastifyBaseLogger,
      test: { releaseConfig: {} as TrustedReleaseLicenseConfig, trustStore: {} as TrustBundleStore, tls: {}, pollIntervalMs: 20 } })
    try {
      await new Promise(resolve => setTimeout(resolve, 200))
      const result = await sql<{ count: string }>`SELECT count(*)::text AS count FROM operations_worker_health WHERE worker = 'license_renewal'`.execute(db)
      expect(result.rows[0]?.count).toBe('0')
    } finally {
      await stop()
      await locked.query("SELECT pg_advisory_unlock(hashtextextended('aikayun-license-renewal-worker', 0))")
      locked.release()
      await pool.end()
    }
  })
})
