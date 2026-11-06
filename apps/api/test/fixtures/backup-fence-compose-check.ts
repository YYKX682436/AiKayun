// Isolated release-Compose fixture callback. Never accepts production names.
import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { DockerPgQuiesceAdapter } from '../../src/backup/docker-pg-fence.js'
import type { Database } from '../../src/db/types.js'

const exec = promisify(execFile)
const project = process.env.AIKAYUN_FIXTURE_PROJECT ?? ''
const work = process.env.AIKAYUN_FIXTURE_WORK ?? ''
const dbId = process.env.AIKAYUN_FIXTURE_DATABASE_CONTAINER_ID ?? ''
const apiImage = process.env.AIKAYUN_FIXTURE_API_IMAGE ?? ''
if (!/^aikayun-75a-test-[a-f0-9]{24}$/.test(project) || !/^[a-f0-9]{64}$/.test(dbId) || !apiImage ||
    !work.includes('/aikayun-75a-fixture.') || !process.env.AIKAYUN_FIXTURE_DOCKER_SOCKET) throw new Error('Unsafe fixture identity')
const names = ['state', 'caddy-data', 'caddy-config'] as const
const volumes = [process.env.AIKAYUN_FIXTURE_STATE_VOLUME, process.env.AIKAYUN_FIXTURE_CADDY_DATA_VOLUME,
  process.env.AIKAYUN_FIXTURE_CADDY_CONFIG_VOLUME] as const
if (volumes[0] !== `${project}_aikayun_state` || volumes[1] !== `${project}_caddy_data` || volumes[2] !== `${project}_caddy_config`) throw new Error('Unsafe fixture volumes')
const binary = await realpath('/usr/local/bin/docker')
const socket = await realpath(process.env.AIKAYUN_FIXTURE_DOCKER_SOCKET)
const home = await realpath(process.env.HOME!)
async function docker(args: string[]) {
  return (await exec(binary, args, { env: { PATH: '/usr/bin:/bin', HOME: home, DOCKER_HOST: `unix://${socket}` }, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim()
}
for (const volume of volumes) {
  if (await docker(['volume', 'inspect', '--format', '{{ index .Labels "com.aikayun.fixture" }}', volume]) !== project) throw new Error('Fixture volume ownership changed')
}
const ids = (await docker(['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`])).split(/\s+/)
const managed: { id: string; service: string }[] = []
for (const id of ids) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Fixture container ID invalid')
  const service = await docker(['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.service" }}', id])
  if (['api', 'web', 'caddy'].includes(service)) managed.push({ id, service })
}
if (managed.length !== 3 || new Set(managed.map(item => item.service)).size !== 3) throw new Error('Fixture topology incomplete')
managed.sort((a, b) => ['caddy', 'web', 'api'].indexOf(a.service) - ['caddy', 'web', 'api'].indexOf(b.service))
const relayName = `${project}-fence-relay`
const relayNetwork = `${project}-fence-relay-net`
let db: Kysely<Database> | undefined
let adapter: DockerPgQuiesceAdapter | undefined
const deployment = 'a'.repeat(64)
const originallyRunning: string[] = []
try {
  // A disposable TCP relay exposes only the random fixture DB on loopback.
  if (await docker(['network', 'inspect', relayNetwork]).then(() => true, () => false)) throw new Error('Fixture relay network already exists')
  await docker(['network', 'create', '--label', `com.aikayun.fixture=${project}`, relayNetwork])
  await docker(['run', '-d', '--name', relayName, '--network', relayNetwork, '-p', '127.0.0.1::5432',
    '--entrypoint', '/nodejs/bin/node', apiImage, '-e',
    `const n=require('node:net');n.createServer(s=>{const u=n.connect(5432,'db');s.pipe(u);u.pipe(s);s.on('error',()=>u.destroy());u.on('error',()=>s.destroy())}).listen(5432,'0.0.0.0')`])
  await docker(['network', 'connect', `${project}_private`, relayName])
  const mapped = await docker(['port', relayName, '5432'])
  const port = /^127\.0\.0\.1:(\d{1,5})$/.exec(mapped)?.[1]
  if (!port) throw new Error('Fixture relay is not loopback-only')
  const password = (await readFile(join(work, 'postgres'), 'utf8')).trim()
  const pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'aikayun_bootstrap', password, database: 'aikayun', max: 1 })
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  adapter = new DockerPgQuiesceAdapter({ dockerBinary: binary, dockerSocket: socket, dockerHome: home, project, deployment,
    stateVolumes: volumes as [string, string, string], managed, db,
    // Synthetic proof for this isolated test only; not a production flock check.
    host: { assertOwnedLock: async () => {}, verifyDeployment: async value => { if (value !== deployment) throw new Error('Fixture identity changed') } } })
  await adapter.assertDeployment(deployment)
  for (const service of managed) {
    if (await adapter.containerState(service.id) === 'running') {
      originallyRunning.push(service.id)
      await adapter.stopContainer(service.id)
    }
  }
  await adapter.setRoleLogin('aikayun_app', false)
  await adapter.setRoleLogin('aikayun_migrator', false)
  await adapter.assertNoWriters()
  const extraName = `${project}-fence-writer`
  try {
    await docker(['run', '-d', '--name', extraName, '--network', 'none', '--mount', `type=volume,source=${volumes[0]},target=/state`,
      '--entrypoint', 'sh', 'postgres:18-alpine', '-c', 'trap "exit 0" TERM; while :; do sleep 1; done'])
    let rejected = false
    try { await adapter.assertNoWriters() } catch (error) { rejected = error instanceof Error && error.message === 'FENCE_VOLUME_WRITER_PRESENT' }
    if (!rejected) throw new Error('Unknown live state-volume writer was not rejected')
  } finally { await docker(['rm', '-f', '-v', extraName]).catch(() => {}) }
  await adapter.assertNoWriters()
  console.log(`Verified isolated release Compose writer fence for ${names.length} persistent non-DB volumes`)
} finally {
  if (adapter) {
    await adapter.setRoleLogin('aikayun_app', true).catch(() => {})
    await adapter.setRoleLogin('aikayun_migrator', true).catch(() => {})
    for (const id of originallyRunning.reverse()) await adapter.startContainer(id).catch(() => {})
  }
  if (db) await db.destroy()
  await docker(['rm', '-f', '-v', relayName]).catch(() => {})
  const label = await docker(['network', 'inspect', '--format', '{{ index .Labels "com.aikayun.fixture" }}', relayNetwork]).catch(() => '')
  if (label === project) await docker(['network', 'rm', relayNetwork]).catch(() => {})
}
