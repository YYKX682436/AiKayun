import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import type { Database } from '../src/db/types.js'
import { DockerPgQuiesceAdapter, waitForDatabaseClientsToDrain } from '../src/backup/docker-pg-fence.js'

const exec = promisify(execFile)
const enabled = process.env.AIKAYUN_TEST_DOCKER_FENCE === '1'
const prefix = `aikayun-75a-fence-${randomBytes(12).toString('hex')}`
const volumes = [`${prefix}-state`, `${prefix}-caddy-data`, `${prefix}-caddy-config`] as const
const names = [`${prefix}-db`, `${prefix}-api`, `${prefix}-unknown`, `${prefix}-unrelated`]
let testDirectory = ''
let binary = ''
let socket = ''
let home = ''
let db: Kysely<Database>
let testUrl = ''
let apiId = ''
let locked = true
let adapter: DockerPgQuiesceAdapter

async function docker(args: string[]) {
  const result = await exec(binary, args, { env: { PATH: '/usr/bin:/bin', HOME: home, DOCKER_HOST: `unix://${socket}` }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
  return result.stdout.trim()
}

describe.skipIf(!enabled)('Docker and PostgreSQL writer inspection in isolated containers', () => {
  beforeAll(async () => {
    const original = await realpath('/usr/local/bin/docker')
    const endpoint = (await exec(original, ['context', 'inspect', (await exec(original, ['context', 'show'])).stdout.trim(), '--format', '{{ (index .Endpoints "docker").Host }}'])).stdout.trim()
    if (!endpoint.startsWith('unix:///')) throw new Error('Only a local test daemon is permitted')
    socket = await realpath(endpoint.slice('unix://'.length))
    testDirectory = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-fence-race-')))
    home = testDirectory
    const realBinary = join(testDirectory, 'docker-real')
    await copyFile(original, realBinary); await chmod(realBinary, 0o700)
    binary = join(testDirectory, 'docker-wrapper')
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    // Inject deletion exactly after the daemon returns a volume-filtered list.
    // The real Docker CLI and real daemon are used for every operation.
    const wrapper = `#!/bin/sh
set -eu
case "$*" in
  *${quote(`ps --all --quiet --no-trunc --filter volume=${volumes[0]}`)})
    ${quote(realBinary)} "$@" > ${quote(join(testDirectory, 'listed'))}
    if [ -f ${quote(join(testDirectory, 'drop-unrelated'))} ]; then
      ${quote(realBinary)} --host ${quote(`unix://${socket}`)} rm -f -v ${quote(names[3]!)} >/dev/null
      mv ${quote(join(testDirectory, 'drop-unrelated'))} ${quote(join(testDirectory, 'unrelated-consumed'))}
    fi
    if [ -f ${quote(join(testDirectory, 'drop-target'))} ]; then
      ${quote(realBinary)} --host ${quote(`unix://${socket}`)} rm -f -v ${quote(names[2]!)} >/dev/null
      mv ${quote(join(testDirectory, 'drop-target'))} ${quote(join(testDirectory, 'target-consumed'))}
    fi
    cat ${quote(join(testDirectory, 'listed'))}
    exit 0 ;;
esac
exec ${quote(realBinary)} "$@"
`
    await writeFile(binary, wrapper, { mode: 0o700 })
    for (const volume of volumes) await docker(['volume', 'create', '--label', `aikayun.fixture=${prefix}`, volume])
    await docker(['run', '-d', '--name', names[0]!, '-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_PASSWORD=isolated-fixture-only',
      '-e', 'POSTGRES_DB=fence_test', '-p', '127.0.0.1::5432', 'postgres:18-alpine'])
    const mapped = await docker(['port', names[0]!, '5432'])
    const port = /^127\.0\.0\.1:(\d+)$/.exec(mapped)?.[1]
    if (!port) throw new Error('Unexpected isolated test database port')
    testUrl = `postgresql://fixture:isolated-fixture-only@127.0.0.1:${port}/fence_test`
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: testUrl, max: 1 }) }) })
    for (let attempt = 0; ; attempt++) {
      try { await sql`SELECT 1`.execute(db); break } catch { if (attempt >= 60) throw new Error('Fixture database did not start'); await new Promise(resolve => setTimeout(resolve, 500)) }
    }
    await sql`CREATE ROLE aikayun_app LOGIN`.execute(db)
    await sql`CREATE ROLE aikayun_migrator LOGIN`.execute(db)
    apiId = await docker(['run', '-d', '--name', names[1]!, '--label', `com.docker.compose.project=${prefix}`,
      '--label', 'com.docker.compose.service=api', '--mount', `type=volume,source=${volumes[0]},target=/var/lib/aikayun`, '--mount', 'type=tmpfs,target=/var/lib/postgresql',
      '--entrypoint', 'sh', 'postgres:18-alpine', '-c', 'trap "exit 0" TERM; while :; do sleep 1; done'])
    const deployment = 'a'.repeat(64)
    adapter = new DockerPgQuiesceAdapter({ dockerBinary: binary, dockerSocket: socket, dockerHome: home, project: prefix, deployment,
      stateVolumes: volumes, managed: [{ id: apiId, service: 'api' }], db, databaseClientDrainTimeoutMs: 250,
      host: { assertOwnedLock: async () => { if (!locked) throw new Error('TEST_LOCK_LOST') },
        verifyDeployment: async expected => { if (expected !== deployment) throw new Error('TEST_DEPLOYMENT_CHANGED') } } })
  }, 90_000)
  afterAll(async () => {
    if (db) await db.destroy()
    for (const name of names) await docker(['rm', '-f', '-v', name]).catch(() => {})
    for (const volume of volumes) {
      const label = await docker(['volume', 'inspect', '--format', '{{ index .Labels "aikayun.fixture" }}', volume]).catch(() => '')
      if (label === prefix) await docker(['volume', 'rm', volume])
    }
    if (testDirectory) await rm(testDirectory, { recursive: true, force: true })
  }, 30_000)

  it('blocks known and unknown volume writers, existing DB sessions and lost lock', async () => {
    await adapter.assertDeployment('a'.repeat(64))
    expect(await adapter.containerState(apiId)).toBe('running')
    await expect(adapter.assertNoWriters()).rejects.toThrow('FENCE_VOLUME_WRITER_PRESENT')
    await adapter.stopContainer(apiId)
    await adapter.setRoleLogin('aikayun_app', false)
    await adapter.setRoleLogin('aikayun_migrator', false)
    await adapter.assertNoWriters()
    const other = new Pool({ connectionString: testUrl, max: 1 })
    const connection = await other.connect()
    try { await expect(adapter.assertNoWriters()).rejects.toThrow('FENCE_DATABASE_CLIENT_PRESENT') }
    finally { connection.release(); await other.end() }
    const draining = new Pool({ connectionString: testUrl, max: 1 })
    const drainingConnection = await draining.connect()
    const drainCheck = waitForDatabaseClientsToDrain(db, 2_000, 20)
    setTimeout(() => drainingConnection.release(true), 150)
    await expect(drainCheck).resolves.toBeUndefined()
    await draining.end()
    await docker(['run', '-d', '--name', names[2]!, '--mount', `type=volume,source=${volumes[0]},target=/state`, '--entrypoint', 'sleep', 'postgres:18-alpine', '300'])
    await expect(adapter.assertNoWriters()).rejects.toThrow('FENCE_VOLUME_WRITER_PRESENT')
    await docker(['rm', '-f', '-v', names[2]!])
    await adapter.assertNoWriters()
    // The unrelated container disappears between listing and inspection; it
    // cannot affect the filtered writer check.
    await docker(['run', '-d', '--name', names[3]!, '--network', 'none', '--mount', 'type=tmpfs,target=/var/lib/postgresql', '--entrypoint', 'sleep', 'postgres:18-alpine', '300'])
    await writeFile(join(testDirectory, 'drop-unrelated'), '', { mode: 0o600 })
    await adapter.assertNoWriters()
    expect(await readFile(join(testDirectory, 'unrelated-consumed'), 'utf8')).toBe('')
    // An actual target-volume mount disappears in the same window. Do not
    // reinterpret an uninspectable mount as a safe, absent writer.
    await docker(['run', '-d', '--name', names[2]!, '--network', 'none', '--mount', 'type=tmpfs,target=/var/lib/postgresql', '--mount', `type=volume,source=${volumes[0]},target=/state`, '--entrypoint', 'sleep', 'postgres:18-alpine', '300'])
    await writeFile(join(testDirectory, 'drop-target'), '', { mode: 0o600 })
    await expect(adapter.assertNoWriters()).rejects.toThrow('FENCE_DOCKER_UNAVAILABLE')
    expect(await readFile(join(testDirectory, 'target-consumed'), 'utf8')).toBe('')
    await adapter.assertNoWriters()
    locked = false
    await expect(adapter.startContainer(apiId)).rejects.toThrow('TEST_LOCK_LOST')
    locked = true
    await adapter.assertRestorationSafe()
    await adapter.setRoleLogin('aikayun_app', true)
    await adapter.setRoleLogin('aikayun_migrator', true)
    await adapter.startContainer(apiId)
    expect(await adapter.containerState(apiId)).toBe('running')
  }, 90_000)
})
