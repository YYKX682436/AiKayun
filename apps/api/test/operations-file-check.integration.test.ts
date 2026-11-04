import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Migrator } from 'kysely/migration'
import { sql, type Kysely } from 'kysely'
import { Pool } from 'pg'
import { initializeInstallationIdentity } from '../src/licensing/installation-identity.js'
import { createDatabase } from '../src/db/pool.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'

const run = promisify(execFile)
let db: Kysely<Database>
let root: string
let env: NodeJS.ProcessEnv
let adminDb: Kysely<Database>
let schema: string
let originalDatabaseUrl: string | undefined
let unboundCheck: { code?: number; stderr?: string; stdout?: string } | undefined
let unboundRows = -1
let concurrentBeforeCommitRows = -1
let concurrentResult: string | undefined
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL
  if (!url || !new URL(url).pathname.slice(1).endsWith('_test')) throw new Error('Dedicated test database required')
  originalDatabaseUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = url
  adminDb = createDatabase()
  schema = `file_check_${randomBytes(8).toString('hex')}`
  await sql.raw(`CREATE SCHEMA ${schema}`).execute(adminDb)
  const isolated = new URL(url)
  isolated.searchParams.set('options', `-csearch_path=${schema}`)
  process.env.DATABASE_URL = isolated.toString()
  db = createDatabase()
  const result = await new Migrator({ db, provider: new AppMigrationProvider(), migrationTableSchema: schema }).migrateToLatest()
  if (result.error) throw result.error
  root = await mkdtemp(join(tmpdir(), 'aikayun-file-check-'))
  await mkdir(join(root, 'media'), { mode: 0o755 })
  await mkdir(join(root, 'private'), { mode: 0o755 })
  env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, MEDIA_ROOT: join(root, 'media'), PRIVATE_FILE_ROOT: join(root, 'private') }
  try { await cli() } catch (error) { unboundCheck = error as typeof unboundCheck }
  unboundRows = Number((await sql<{ count: string }>`SELECT count(*)::text AS count FROM operations_file_checks`.execute(db)).rows[0]?.count)
  const pool = new Pool({ connectionString: isolated.toString() })
  let duringBinding: ReturnType<typeof cli> | undefined
  try {
    await initializeInstallationIdentity(pool, { identityRoot: join(root, 'identity'), mode: 'fresh', onCheckpoint: async stage => {
      if (stage !== 'binding_transaction_before_commit') return
      duringBinding = cli()
      // Observe the in-flight child without waiting for a lock held until this callback returns.
      void duringBinding.catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 300))
      concurrentBeforeCommitRows = Number((await sql<{ count: string }>`SELECT count(*)::text AS count FROM operations_file_checks`.execute(db)).rows[0]?.count)
    } })
    try { concurrentResult = (await duringBinding!).stdout } catch { concurrentResult = 'unavailable' }
    // A statement that started before commit may legally see the old snapshot.
    if (concurrentResult === 'unavailable') concurrentResult = (await cli()).stdout
    await sql`DELETE FROM operations_file_checks`.execute(db)
  } finally { await pool.end() }
})
afterAll(async () => {
  if (db) await db.destroy()
  if (adminDb && schema) await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(adminDb)
  if (adminDb) await adminDb.destroy()
  if (root) await rm(root, { recursive: true, force: true })
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDatabaseUrl
})
const cli = () => run(process.execPath, ['--import', 'tsx', 'src/media/operations-file-check-cli.ts'], { cwd: process.cwd(), env, timeout: 20_000 })
const reset = () => sql`DELETE FROM operations_file_checks`.execute(db)

describe('isolated operations file check', () => {
  it('refuses an uninitialized identity before scanning or recording', () => {
    expect(unboundCheck?.code).toBe(1)
    expect(unboundCheck?.stderr).toContain('File check unavailable: installation identity is not initialized.')
    expect(unboundCheck?.stdout).toBe('')
    expect(unboundRows).toBe(0)
    expect(concurrentBeforeCommitRows).toBe(0)
    expect(JSON.parse(concurrentResult!)).toEqual({ media: 'ok', private: 'ok', draft: 'ok', order: 'ok' })
  })
  it('records only counts, does not create attachment directories or alter permissions, and limits repeats', async () => {
    await reset()
    const result = await cli()
    expect(JSON.parse(result.stdout)).toEqual({ media: 'ok', private: 'ok', draft: 'ok', order: 'ok' })
    expect(await readdir(join(root, 'private'))).toEqual([])
    expect((await stat(join(root, 'private'))).mode & 0o777).toBe(0o755)
    const snapshots = await sql<{ kind: string; status: string; counts: Record<string, unknown> }>`SELECT kind, status, counts FROM operations_file_checks`.execute(db)
    expect(snapshots.rows).toHaveLength(4)
    for (const row of snapshots.rows) {
      expect(row.status).toBe('ok')
      expect(Object.values(row.counts).every(value => typeof value === 'number')).toBe(true)
    }
    await expect(cli()).rejects.toMatchObject({ code: 1 })
  })
  it('marks missing roots unknown instead of treating empty listings as healthy', async () => {
    await reset()
    await rm(join(root, 'private'), { recursive: true })
    await expect(cli()).rejects.toMatchObject({ code: 1 })
    const result = await sql<{ kind: string; status: string }>`SELECT kind, status FROM operations_file_checks`.execute(db)
    expect(result.rows.filter(row => row.kind !== 'media').map(row => row.status)).toEqual(['unknown', 'unknown', 'unknown'])
    await mkdir(join(root, 'private'))
  })
  it.each([
    ['objects', 'file'], ['objects', 'symlink'], ['.staging', 'file'], ['.staging', 'symlink'],
  ] as const)('marks media %s invalid when it is a %s', async (directory, kind) => {
    await reset()
    const path = join(root, 'media', directory)
    if (kind === 'file') await writeFile(path, 'not a directory')
    else await symlink(join(root, 'private'), path)
    try {
      await expect(cli()).rejects.toMatchObject({ code: 1 })
      const result = await sql<{ status: string; counts: Record<string, number> }>`SELECT status, counts FROM operations_file_checks WHERE kind = 'media'`.execute(db)
      expect(result.rows[0]).toEqual({ status: 'unknown', counts: {} })
    } finally {
      await rm(path, { force: true })
    }
  })
  it('reports corrupted registered media and only aged draft staging, without deleting or repairing either', async () => {
    await reset()
    const mediaId = randomUUID()
    const key = `objects/${mediaId.slice(0, 2)}/${mediaId}-thumbnail.webp`
    const mediaPath = join(root, 'media', key)
    await mkdir(join(root, 'media', 'objects', mediaId.slice(0, 2)), { recursive: true })
    await writeFile(mediaPath, 'bad')
    const expected = createHash('sha256').update('yes').digest('hex')
    await sql`INSERT INTO product_media (id) VALUES (${mediaId}::uuid)`.execute(db)
    await sql`INSERT INTO product_media_variants (media_id, variant, storage_key, width, height, size_bytes, sha256, processing_version)
      VALUES (${mediaId}::uuid, 'thumbnail', ${key}, 1, 1, 3, ${expected}, 'webp-v1')`.execute(db)
    const staging = join(root, 'private', 'purchase-attachments', 'staging')
    await mkdir(staging, { recursive: true })
    const oldPath = join(staging, `${randomUUID()}.part`)
    const freshPath = join(staging, `${randomUUID()}.part`)
    await writeFile(oldPath, 'old')
    await writeFile(freshPath, 'fresh')
    const old = new Date(Date.now() - 25 * 60 * 60_000)
    await utimes(oldPath, old, old)
    await expect(cli()).rejects.toMatchObject({ code: 1 })
    const snapshots = await sql<{ kind: string; status: string; counts: Record<string, number> }>`SELECT kind, status, counts FROM operations_file_checks`.execute(db)
    expect(snapshots.rows.find(row => row.kind === 'media')).toMatchObject({ status: 'attention', counts: { invalidFiles: 1 } })
    expect(snapshots.rows.find(row => row.kind === 'draft')).toMatchObject({ status: 'attention', counts: { oldOrphanFiles: 1 } })
    expect(await readFile(mediaPath, 'utf8')).toBe('bad')
    expect(await readFile(oldPath, 'utf8')).toBe('old')
    expect(await readFile(freshPath, 'utf8')).toBe('fresh')
    expect((await sql`SELECT 1 FROM product_media_variants WHERE media_id = ${mediaId}::uuid`.execute(db)).rows).toHaveLength(1)
    await sql`DELETE FROM product_media WHERE id = ${mediaId}::uuid`.execute(db)
    await rm(join(root, 'media', 'objects'), { recursive: true })
    await rm(join(root, 'private', 'purchase-attachments'), { recursive: true })
  })
  it('fails closed if the database is disconnected', async () => {
    const unavailable = new URL(env.DATABASE_URL!)
    unavailable.port = '1'
    try {
      await run(process.execPath, ['--import', 'tsx', 'src/media/operations-file-check-cli.ts'], {
        cwd: process.cwd(), env: { ...env, DATABASE_URL: unavailable.toString() }, timeout: 20_000,
      })
      throw new Error('Disconnected database was incorrectly accepted')
    } catch (error) {
      expect(error).toMatchObject({ code: 1 })
      expect(String((error as { stderr?: string }).stderr)).not.toContain('isolated-test-only')
    }
  })
  it('leaves unfinished scans explicitly running when the checking process is killed', async () => {
    await reset()
    await db.transaction().execute(async trx => {
      await sql`LOCK TABLE product_media_variants IN ACCESS EXCLUSIVE MODE`.execute(trx)
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/media/operations-file-check-cli.ts'], { cwd: process.cwd(), env, stdio: 'ignore' })
      try {
        let count = 0
        for (let i = 0; i < 100; i++) {
          count = Number((await sql<{ count: string }>`SELECT count(*)::text AS count FROM operations_file_checks WHERE status = 'running'`.execute(db)).rows[0]?.count ?? 0)
          if (count === 4) break
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        expect(count).toBe(4)
        // A second process cannot overlap a scan, even from another API instance.
        await expect(cli()).rejects.toMatchObject({ code: 1 })
      } finally {
        child.kill('SIGKILL')
        await new Promise<void>(resolve => child.once('exit', () => resolve()))
      }
    })
    const result = await sql<{ count: string }>`SELECT count(*)::text AS count FROM operations_file_checks WHERE status = 'running'`.execute(db)
    expect(Number(result.rows[0]?.count)).toBe(4)
  })
})
