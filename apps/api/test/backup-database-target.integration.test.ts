import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import type { Database } from '../src/db/types.js'
import { withProvenFixtureDatabaseTarget, type ProvenDatabaseTarget } from '../src/backup/database-target.js'

const enabled = process.env.AIKAYUN_TEST_LOCAL_DOCKER === 'true'
const image = process.env.AIKAYUN_TEST_POSTGRES_IMAGE || 'docker.io/library/postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
const noop = async () => {}
describe.skipIf(!enabled)('pinned database target proof against isolated PostgreSQL containers', () => {
  let binary: string, socket: string
  const fixtures: { prefix: string; volume: string; id: string; db: Kysely<Database>; connectionString: string }[] = []
  const volumes: string[] = [], containers: string[] = []
  const docker = (...args: string[]) => execFileSync(binary, ['--host', `unix://${socket}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  beforeAll(async () => {
    binary = await realpath(process.env.AIKAYUN_TEST_DOCKER_BINARY!)
    socket = await realpath(process.env.AIKAYUN_TEST_DOCKER_SOCKET!)
    for (let i = 0; i < 2; i++) {
      const prefix = `aikayun-75a-test-${randomBytes(12).toString('hex')}`, volume = `${prefix}_postgres_data`, name = `${prefix}-db`
      docker('volume', 'create', '--label', `com.aikayun.fixture=${prefix}`, volume)
      if (docker('volume', 'inspect', '--format', '{{ index .Labels "com.aikayun.fixture" }}', volume) !== prefix) throw new Error('fixture volume identity mismatch')
      volumes.push(volume)
      const id = docker('run', '-d', '--name', name, '--label', `com.docker.compose.project=${prefix}`,
        '--label', 'com.docker.compose.service=db', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
        '-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_DB=fixture_test', '--mount', `type=volume,source=${volume},target=/var/lib/postgresql`, image)
      containers.push(id)
      let ready = false
      for (let attempt = 0; attempt < 40; attempt++) {
        try { docker('exec', id, 'pg_isready', '-U', 'fixture', '-d', 'fixture_test'); ready = true; break }
        catch { await new Promise(resolve => setTimeout(resolve, 250)) }
      }
      if (!ready) throw new Error('fixture not ready')
      const port = docker('port', id, '5432/tcp').split(':').at(-1)
      const connectionString = `postgresql://fixture@127.0.0.1:${port}/fixture_test`
      const setupPool = new Pool({ connectionString, max: 1 })
      setupPool.on('connect', client => client.on('error', () => {}))
      setupPool.on('error', () => {})
      const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: setupPool }) })
      fixtures.push({ prefix, volume, id, db, connectionString })
      let connected = false
      for (let attempt = 0; attempt < 40; attempt++) {
        try { await sql`SELECT 1`.execute(db); connected = true; break }
        catch { await new Promise(resolve => setTimeout(resolve, 250)) }
      }
      if (!connected) throw new Error('fixture connection not ready')
      // Deliberately identical data: matching logical IDs alone cannot prove a
      // live session belongs to the selected PostgreSQL container.
      await sql`CREATE TABLE proof_fixture (same_id uuid NOT NULL)`.execute(db)
      await sql`INSERT INTO proof_fixture VALUES ('12345678-1234-4123-8123-123456789abc')`.execute(db)
    }
  }, 120_000)
  afterAll(async () => {
    for (const fixture of fixtures) await fixture.db.destroy()
    for (const id of containers) docker('rm', '-f', id)
    for (const volume of volumes) docker('volume', 'rm', volume)
  }, 60_000)
  function input(index: number) {
    const fixture = fixtures[index]!
    return { databaseConfig: { connectionString: fixture.connectionString }, dockerBinary: binary, dockerSocket: socket, containerId: fixture.id, postgresImage: image,
      database: 'fixture_test', bootstrapUser: 'fixture', assertLock: vi.fn(noop), assertSignedDeployment: vi.fn(noop) }
  }
  it('binds a single session and resets the proof marker without forcing a read-only transaction', async () => {
    const opts = input(0)
    const before = ''
    let expired: ProvenDatabaseTarget | undefined
    await withProvenFixtureDatabaseTarget(opts, fixtures[0]!.prefix, async target => {
      expired = target
      const first = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(target.db)).rows[0]!.pid
      await sql`CREATE TEMP TABLE backup_fixture_temp (value int)`.execute(target.db)
      await target.assertBound()
      const second = (await sql<{ pid: number; value: string }>`SELECT pg_backend_pid() AS pid, current_setting('application_name') AS value`.execute(target.db)).rows[0]!
      expect(second).toEqual({ pid: first, value: before })
    })
    await expect(expired!.assertBound()).rejects.toThrow('BACKUP_DATABASE_TARGET_UNVERIFIED')
    expect(opts.assertLock).toHaveBeenCalled()
    expect(opts.assertSignedDeployment).toHaveBeenCalled()
  }, 30_000)
  it('rejects a different container even when database values match', async () => {
    const opts = { ...input(1), databaseConfig: { connectionString: fixtures[0]!.connectionString } }
    const operation = vi.fn()
    await expect(withProvenFixtureDatabaseTarget(opts, fixtures[1]!.prefix, operation)).rejects.toThrow('BACKUP_DATABASE_TARGET_UNVERIFIED')
    expect(operation).not.toHaveBeenCalled()
  }, 30_000)
  it('invalidates the pinned session when the PostgreSQL container restarts', async () => {
    const opts = input(1)
    await expect(withProvenFixtureDatabaseTarget(opts, fixtures[1]!.prefix, async target => {
      docker('restart', opts.containerId)
      await expect(target.assertBound()).rejects.toThrow()
    })).rejects.toThrow()
  }, 30_000)
  it('refuses an incorrect image, missing lock or failed signature proof before the operation', async () => {
    const opts = input(0), operation = vi.fn()
    await expect(withProvenFixtureDatabaseTarget({ ...opts, postgresImage: `docker.io/library/postgres@sha256:${'f'.repeat(64)}` }, fixtures[0]!.prefix, operation))
      .rejects.toThrow('BACKUP_DATABASE_TARGET_UNVERIFIED')
    await expect(withProvenFixtureDatabaseTarget({ ...opts, assertLock: async () => { throw new Error('lock missing') } }, fixtures[0]!.prefix, operation))
      .rejects.toThrow('lock missing')
    await expect(withProvenFixtureDatabaseTarget({ ...opts, assertSignedDeployment: async () => { throw new Error('signature missing') } }, fixtures[0]!.prefix, operation))
      .rejects.toThrow('signature missing')
    expect(operation).not.toHaveBeenCalled()
  }, 30_000)
})
