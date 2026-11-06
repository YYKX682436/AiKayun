import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { Pool } from 'pg'
import type { Database } from '../src/db/types.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { initializeInstallationIdentity } from '../src/licensing/installation-identity.js'
import { capturePostgresDump, verifyPostgresDumpBinding, type PostgresDumpTarget } from '../src/backup/pg-dump.js'

const containerId = process.env.AIKAYUN_TEST_PG_DUMP_CONTAINER
const sourceUrl = process.env.TEST_DATABASE_URL
describe.skipIf(!containerId || !sourceUrl)('binding verification of isolated PostgreSQL custom dumps', () => {
  let admin: Kysely<Database>
  let dbA: Kysely<Database>
  let dbB: Kysely<Database>
  let stage: string
  let identityA: string
  let identityB: string
  let target: PostgresDumpTarget
  let expectedA: Parameters<typeof verifyPostgresDumpBinding>[1]
  let expectedB: typeof expectedA
  const nameA = `backup_a_${randomUUID().replaceAll('-', '')}_test`
  const nameB = `backup_b_${randomUUID().replaceAll('-', '')}_test`
  beforeAll(async () => {
    if (!new URL(sourceUrl!).pathname.endsWith('_test')) throw new Error('isolated test database required')
    admin = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: sourceUrl }) }) })
    for (const name of [nameA, nameB]) await sql.raw(`CREATE DATABASE ${name}`).execute(admin)
    async function create(name: string, root: string) {
      const url = new URL(sourceUrl!); url.pathname = `/${name}`
      const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url.toString() }) }) })
      const migrated = await new Migrator({ db, provider: new AppMigrationProvider() }).migrateToLatest()
      if (migrated.error) throw migrated.error
      const pool = new Pool({ connectionString: url.toString() })
      try { await initializeInstallationIdentity(pool, { identityRoot: root, mode: 'fresh' }) } finally { await pool.end() }
      const pendingKeyId = `lp-${randomUUID().replaceAll('-', '')}`
      await sql`UPDATE installation_binding SET pending_key_id = ${pendingKeyId}, pending_key_sha256 = ${'c'.repeat(64)} WHERE singleton`.execute(db)
      const row = (await sql<{ database_id: string; instance_id: string; identity_jkt: string }>`SELECT database_id::text, instance_id::text, identity_jkt FROM installation_binding`.execute(db)).rows[0]!
      return { db, expected: { databaseId: row.database_id, instanceId: row.instance_id, identityJkt: row.identity_jkt,
        pendingKeyId, pendingKeySha256: 'c'.repeat(64), migrationHead: Object.keys(await new AppMigrationProvider().getMigrations()).sort().at(-1)!, migrationChecksumsSha256: 'd'.repeat(64) } }
    }
    stage = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-75a-binding-stage-')))
    identityA = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-75a-binding-a-')))
    identityB = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-75a-binding-b-')))
    const a = await create(nameA, identityA), b = await create(nameB, identityB)
    dbA = a.db; dbB = b.db; expectedA = a.expected; expectedB = b.expected
    const binary = await realpath(execFileSync('which', ['docker'], { encoding: 'utf8' }).trim())
    const context = execFileSync(binary, ['context', 'show'], { encoding: 'utf8' }).trim()
    const endpoint = execFileSync(binary, ['context', 'inspect', context, '--format', '{{ (index .Endpoints "docker").Host }}'], { encoding: 'utf8' }).trim()
    if (!endpoint.startsWith('unix:///')) throw new Error('local Docker required')
    target = { dockerBinary: binary, dockerSocket: await realpath(endpoint.slice(7)), containerId: containerId!, database: nameA,
      user: 'fixture', stagingDirectory: stage, assertSecureStaging: async () => {}, timeoutMs: 30000 }
  }, 120_000)
  afterAll(async () => {
    if (dbA) await dbA.destroy()
    if (dbB) await dbB.destroy()
    if (admin) {
      for (const name of [nameA, nameB]) await sql.raw(`DROP DATABASE IF EXISTS ${name}`).execute(admin)
      await admin.destroy()
    }
    for (const path of [stage, identityA, identityB]) if (path) await rm(path, { recursive: true, force: true })
  })
  it('accepts its own database identity and rejects another real database identity without modifying either', async () => {
    await capturePostgresDump(target)
    const beforeA = (await sql`SELECT row_to_json(binding) AS value FROM installation_binding binding`.execute(dbA)).rows
    const beforeB = (await sql`SELECT row_to_json(binding) AS value FROM installation_binding binding`.execute(dbB)).rows
    await expect(verifyPostgresDumpBinding(target, expectedA)).resolves.toBeUndefined()
    await expect(verifyPostgresDumpBinding(target, expectedB)).rejects.toThrow('DUMP_BINDING_MISMATCH')
    await expect(verifyPostgresDumpBinding(target, { ...expectedA, migrationHead: 'wrong' })).rejects.toThrow('DUMP_MIGRATIONS_MISMATCH')
    expect((await sql`SELECT row_to_json(binding) AS value FROM installation_binding binding`.execute(dbA)).rows).toEqual(beforeA)
    expect((await sql`SELECT row_to_json(binding) AS value FROM installation_binding binding`.execute(dbB)).rows).toEqual(beforeB)
  }, 60000)
})
