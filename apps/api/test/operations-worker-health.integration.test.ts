import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Migrator } from 'kysely/migration'
import { sql, Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'
import { createWorkerObserver } from '../src/ops/worker-health.js'
import { createReadinessCheck } from '../src/ops/readiness.js'
import { createOperationsDiagnostics } from '../src/operations/diagnostics.js'
import { startLicenseRenewalWorker } from '../src/licensing/license-renewal-worker.js'
import { initializeInstallationIdentity } from '../src/licensing/installation-identity.js'
import type { TrustedReleaseLicenseConfig } from '../src/licensing/trusted-release-config.js'
import type { TrustBundleStore } from '../src/licensing/trust/trust-bundle-store.js'
import type { FastifyBaseLogger } from 'fastify'
import { readConfig } from '../src/config.js'
import { createApp } from '../src/app.js'

let db: Kysely<Database>
let adminDb: Kysely<Database>
let schema: string
let isolatedUrl: string
let identityRoot: string
let beforeCommitCount = -1
let beforeInitializationCount = -1
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
  identityRoot = await mkdtemp(join(tmpdir(), 'aikayun-worker-identity-'))
  createWorkerObserver(db, 'unpaid_expiry')(true)
  await new Promise(resolve => setTimeout(resolve, 100))
  beforeInitializationCount = Number((await sql<{ count: string }>`SELECT count(*)::text AS count FROM operations_worker_health`.execute(db)).rows[0]?.count)
  const identityPool = new Pool({ connectionString: isolatedUrl })
  try {
    await expect(initializeInstallationIdentity(identityPool, { identityRoot, mode: 'fresh', onCheckpoint: async stage => {
      if (stage !== 'binding_transaction_before_commit') return
      createWorkerObserver(db, 'unpaid_expiry')(true)
      await new Promise(resolve => setTimeout(resolve, 100))
      beforeCommitCount = Number((await sql<{ count: string }>`SELECT count(*)::text AS count FROM operations_worker_health`.execute(db)).rows[0]?.count)
      throw new Error('synthetic binding rollback')
    } })).rejects.toThrow('Instance identity initialization could not be completed')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(Number((await sql<{ count: string }>`SELECT count(*)::text AS count FROM operations_worker_health`.execute(db)).rows[0]?.count)).toBe(0)
    await initializeInstallationIdentity(identityPool, { identityRoot, mode: 'fresh' })
    // A new observation after the committed binding must eventually persist.
    createWorkerObserver(db, 'unpaid_expiry')(true)
    await waitForRows(1)
    await sql`DELETE FROM operations_worker_health`.execute(db)
  } finally { await identityPool.end() }
})
afterAll(async () => {
  if (db) await db.destroy()
  if (adminDb && schema) await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(adminDb)
  if (adminDb) await adminDb.destroy()
  if (identityRoot) await rm(identityRoot, { recursive: true, force: true })
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
  it('does not write before identity initialization or before binding commit', () => {
    expect(beforeInitializationCount).toBe(0)
    expect(beforeCommitCount).toBe(0)
  })
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
  it('keeps the entire scan in flight when a directory fails before a stalled database branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aikayun-ready-branches-'))
    const mediaRoot = join(root, 'missing-media')
    const privateRoot = join(root, 'private')
    await mkdir(privateRoot)
    const pool = new Pool({ connectionString: isolatedUrl, max: 1 })
    const held = await pool.connect()
    let acquisitions = 0
    const counted = new Kysely<Database>({ dialect: new PostgresDialect({ pool: {
      connect: () => { acquisitions++; return pool.connect() },
      end: () => pool.end(),
    } }) })
    let now = performance.now()
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    let released = false
    try {
      const ready = createReadinessCheck(counted, readConfig({ NODE_ENV: 'test', MEDIA_ROOT: mediaRoot, PRIVATE_FILE_ROOT: privateRoot }))
      const started = Date.now()
      expect(await ready()).toBe(false)
      expect(Date.now() - started).toBeLessThan(2500)
      expect(acquisitions).toBe(1)
      for (let cycle = 0; cycle < 3; cycle++) {
        now += 5000
        expect(await Promise.all(Array.from({ length: 20 }, () => ready()))).toEqual(Array(20).fill(false))
        expect(acquisitions).toBe(1)
      }
      await mkdir(mediaRoot)
      held.release()
      released = true
      // Wait for the old database branch to finish and release the single-flight marker.
      for (let i = 0; i < 100 && pool.idleCount === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(pool.idleCount).toBe(1)
      await new Promise(resolve => setTimeout(resolve, 20))
      now += 5000
      expect(await ready()).toBe(true)
      expect(acquisitions).toBe(2)
    } finally {
      if (!released) held.release()
      clock.mockRestore()
      await counted.destroy()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
  it('limits real HTTP probe scans, including the ten-second Docker interval', async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'aikayun-ready-http-media-'))
    const privateRoot = await mkdtemp(join(tmpdir(), 'aikayun-ready-http-private-'))
    const pool = new Pool({ connectionString: isolatedUrl })
    let scans = 0
    const counted = new Kysely<Database>({ dialect: new PostgresDialect({ pool }), log(event) {
      if (event.query.sql.includes('SELECT name FROM kysely_migration')) scans++
    } })
    let now = performance.now()
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const config = readConfig({ NODE_ENV: 'test', MEDIA_ROOT: mediaRoot, PRIVATE_FILE_ROOT: privateRoot })
    const app = await createApp({ db: counted, config, logger: false })
    try {
      const responses = await Promise.all(Array.from({ length: 50 }, () => app.inject('/api/v1/health/ready')))
      expect(responses.every(response => response.statusCode === 200)).toBe(true)
      for (let i = 0; i < 100; i++) expect((await app.inject('/api/v1/health/ready')).statusCode).toBe(200)
      expect(scans).toBe(1)
      for (let i = 0; i < 3; i++) {
        now += 10_000
        expect((await app.inject('/api/v1/health/ready')).statusCode).toBe(200)
      }
      expect(scans).toBe(4)
    } finally {
      clock.mockRestore()
      await app.close()
      await counted.destroy()
      await Promise.all([mediaRoot, privateRoot].map(path => rm(path, { recursive: true, force: true })))
    }
  }, 30_000)
  it('coalesces requests, expires both outcomes and recovers after schema and connection failures', async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'aikayun-ready-media-'))
    const privateRoot = await mkdtemp(join(tmpdir(), 'aikayun-ready-private-'))
    const pool = new Pool({ connectionString: isolatedUrl, max: 1, application_name: 'readiness-count-test' })
    const offline = new Pool({ host: '127.0.0.1', port: 1, user: 'unused', database: 'unavailable_test', connectionTimeoutMillis: 250 })
    let disconnected = false
    let acquisitions = 0
    const selectablePool = {
      connect: () => { acquisitions++; return disconnected ? offline.connect() : pool.connect() },
      end: async () => { await Promise.all([pool.end(), offline.end()]) },
    }
    let scans = 0
    const counted = new Kysely<Database>({ dialect: new PostgresDialect({ pool: selectablePool }), log(event) {
      if (event.query.sql.includes('SELECT name FROM kysely_migration')) scans++
    } })
    let now = performance.now()
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const config = readConfig({ NODE_ENV: 'test', MEDIA_ROOT: mediaRoot, PRIVATE_FILE_ROOT: privateRoot })
      const ready = createReadinessCheck(counted, config)
      expect(await Promise.all(Array.from({ length: 50 }, () => ready()))).toEqual(Array(50).fill(true))
      for (let i = 0; i < 100; i++) expect(await ready()).toBe(true)
      expect(scans).toBe(1)
      now += 4999
      expect(await ready()).toBe(true)
      expect(scans).toBe(1)
      now += 1
      expect(await ready()).toBe(true)
      expect(scans).toBe(2)
      // A normal Docker probe every ten seconds triggers one fresh scan each.
      for (let i = 0; i < 3; i++) { now += 10_000; expect(await ready()).toBe(true) }
      expect(scans).toBe(5)

      await sql`ALTER TABLE orders RENAME COLUMN total_amount TO broken_total`.execute(db)
      try {
        expect(await ready()).toBe(true) // bounded cached result
        now += 5000
        expect(await ready()).toBe(false)
        expect(scans).toBe(6)
        expect(await ready()).toBe(false)
        expect(scans).toBe(6)
      } finally { await sql`ALTER TABLE orders RENAME COLUMN broken_total TO total_amount`.execute(db) }
      now += 5000
      expect(await ready()).toBe(true)
      expect(scans).toBe(7)

      // An unreachable PostgreSQL socket fails acquisition; recovery reconnects
      // to the real database after the cached failure expires.
      disconnected = true
      now += 5000
      expect(await ready()).toBe(false)
      expect(acquisitions).toBe(8)
      expect(scans).toBe(7)
      expect(await ready()).toBe(false)
      disconnected = false
      now += 5000
      expect(await ready()).toBe(true)
      expect(acquisitions).toBe(9)
      expect(scans).toBe(8)

      // A pool acquisition that outlives the deadline must not publish its late success.
      const held = await pool.connect()
      now += 5000
      const started = Date.now()
      const timedOut = await ready()
      expect(timedOut).toBe(false)
      expect(Date.now() - started).toBeLessThan(2500)
      now += 5000
      expect(await ready()).toBe(false)
      expect(scans).toBe(8)
      held.release()
      for (let i = 0; i < 100 && scans === 8; i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(scans).toBe(9)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(await ready()).toBe(true)
      expect(scans).toBe(10)
    } finally {
      clock.mockRestore()
      await counted.destroy()
      await Promise.all([mediaRoot, privateRoot].map(path => rm(path, { recursive: true, force: true })))
    }
  }, 30_000)
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
