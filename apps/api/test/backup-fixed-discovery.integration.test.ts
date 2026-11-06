import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { discoverFixtureDeployment } from '../src/backup/fixed-discovery.js'

const enabled = process.env.AIKAYUN_TEST_LOCAL_DOCKER === 'true'
const image = 'docker.io/library/postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
const fixture = `aikayun-75a-test-${randomBytes(12).toString('hex')}`
const volumeNames = [`${fixture}_aikayun_state`, `${fixture}_caddy_data`, `${fixture}_caddy_config`] as const
let binary: string, socket: string, work: string, composeFile: string, connectionString: string
const docker = (...args: string[]) => execFileSync(binary, ['--host', `unix://${socket}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const compose = (...args: string[]) => docker('compose', '--project-name', fixture, '--file', composeFile, ...args)
const host = { assertOwnedLock: async () => {}, verifyDeployment: async (value: string) => { if (value !== 'a'.repeat(64)) throw new Error('fixture deployment mismatch') } }

describe.skipIf(!enabled)('fixed discovery using an isolated real Compose deployment', () => {
  beforeAll(async () => {
    binary = await realpath(process.env.AIKAYUN_TEST_DOCKER_BINARY!)
    socket = await realpath(process.env.AIKAYUN_TEST_DOCKER_SOCKET!)
    work = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-discovery-compose-')))
    composeFile = join(work, 'compose.yaml')
    await writeFile(composeFile, `services:
  db:
    image: ${image}
    environment: { POSTGRES_USER: fixture, POSTGRES_DB: fixture_test, POSTGRES_HOST_AUTH_METHOD: trust }
    ports: ["127.0.0.1::5432"]
    volumes: ["db-data:/var/lib/postgresql"]
  api:
    image: ${image}
    entrypoint: ["sh", "-c", "while :; do sleep 5; done"]
    tmpfs: ["/var/lib/postgresql"]
    volumes: ["state:/var/lib/aikayun"]
  web:
    image: ${image}
    entrypoint: ["sh", "-c", "while :; do sleep 5; done"]
    tmpfs: ["/var/lib/postgresql"]
  caddy:
    image: ${image}
    entrypoint: ["sh", "-c", "while :; do sleep 5; done"]
    tmpfs: ["/var/lib/postgresql"]
    volumes: ["caddy-data:/data", "caddy-config:/config"]
volumes:
  db-data: { name: ${fixture}_postgres_data }
  state: { name: ${fixture}_aikayun_state }
  caddy-data: { name: ${fixture}_caddy_data }
  caddy-config: { name: ${fixture}_caddy_config }
`, { mode: 0o600 })
    compose('up', '-d')
    const port = compose('port', 'db', '5432').split(':').at(-1)
    connectionString = `postgresql://fixture@127.0.0.1:${port}/fixture_test`
    const pool = new Pool({ connectionString, max: 1 })
    pool.on('connect', client => client.on('error', () => {})); pool.on('error', () => {})
    try {
      let ready = false
      for (let attempt = 0; attempt < 60; attempt++) {
        try { await pool.query('SELECT 1'); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 250)) }
      }
      if (!ready) throw new Error('isolated PostgreSQL unavailable')
      await pool.query('CREATE ROLE aikayun_app LOGIN')
      await pool.query('CREATE ROLE aikayun_migrator LOGIN')
    } finally { await pool.end() }
  }, 120_000)
  afterAll(async () => {
    if (composeFile) compose('down', '--volumes', '--remove-orphans')
    if (work) await rm(work, { recursive: true, force: true })
  }, 60_000)
  async function input() {
    return { binary, socket, dockerHome: await realpath('/var/empty'), project: fixture, stateVolumes: volumeNames,
      postgresImage: image, backupResticImage: `ghcr.io/yykx682436/aikayun-backup-restic@sha256:${'e'.repeat(64)}`, images: { api: image, web: image, postgres: image, caddy: image },
      databaseConfig: { connectionString }, database: 'fixture_test', bootstrapUser: 'fixture', fingerprint: 'a'.repeat(64), host }
  }
  it('discovers fixed services, original states and DB roles through the proven DB container', async () => {
    const result = await discoverFixtureDeployment(await input(), fixture)
    expect(result.snapshot.services.map(item => [item.name, item.running])).toEqual([['caddy', true], ['web', true], ['api', true]])
    expect(result.snapshot.roles).toEqual([{ name: 'aikayun_app', canLogin: true }, { name: 'aikayun_migrator', canLogin: true }])
    expect(result.databaseContainerId).toMatch(/^[a-f0-9]{64}$/)
  }, 60_000)
  it('rejects a named PostgreSQL mount pretending to be an initialization scratch volume', async () => {
    const args = await input(), name = `${fixture}-pretend-init`, volume = `${fixture}_not_anonymous`
    try {
      docker('volume', 'create', '--label', `com.aikayun.fixture=${fixture}`, volume)
      docker('run', '-d', '--name', name, '--label', `com.docker.compose.project=${fixture}`,
        '--label', 'com.docker.compose.service=db-role-init', '--network', 'none',
        '--mount', `type=volume,source=${volume},target=/var/lib/postgresql`, '--entrypoint', 'sleep', image, '60')
      await expect(discoverFixtureDeployment(args, fixture)).rejects.toThrow('FENCE_CONTAINER_MOUNTS_INVALID')
    } finally {
      docker('rm', '-f', '-v', name)
      if (docker('volume', 'inspect', '--format', '{{ index .Labels "com.aikayun.fixture" }}', volume) === fixture) docker('volume', 'rm', volume)
    }
  }, 60_000)
  it('rejects an image mismatch and unrecognized project container without mutating services', async () => {
    const args = await input()
    await expect(discoverFixtureDeployment({ ...args, images: { ...args.images, api: `docker.io/library/postgres@sha256:${'b'.repeat(64)}` } }, fixture))
      .rejects.toThrow('BACKUP_DISCOVERY_IMAGE_MISMATCH')
    const name = `${fixture}-extra`
    try {
      docker('run', '-d', '--name', name, '--label', `com.docker.compose.project=${fixture}`, '--label', 'com.docker.compose.service=unexpected',
        '--network', 'none', '--entrypoint', 'sleep', image, '60')
      await expect(discoverFixtureDeployment(args, fixture)).rejects.toThrow('BACKUP_DISCOVERY_INVALID')
    } finally { docker('rm', '-f', '-v', name) }
    expect(compose('ps', '--status', 'running', '--services').split('\n').sort()).toEqual(['api', 'caddy', 'db', 'web'])
  }, 60_000)
})
