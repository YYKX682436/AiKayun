// Test-only callback for test-backup-compose-fixture.sh. Never targets production.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { capturePostgresDump, verifyPostgresDump } from '../../src/backup/pg-dump.js'
import { quiesceAndCapture, recoverMaintenance, type QuiesceAdapter } from '../../src/backup/coordinator.js'
import { readMaintenanceJournal } from '../../src/backup/journal.js'
import { UnsafeMaintenanceRecoveryError } from '../../src/backup/maintenance-errors.js'

const project = process.env.AIKAYUN_FIXTURE_PROJECT ?? ''
const work = process.env.AIKAYUN_FIXTURE_WORK ?? ''
const db = process.env.AIKAYUN_FIXTURE_DATABASE_CONTAINER_ID ?? ''
const socket = process.env.AIKAYUN_FIXTURE_DOCKER_SOCKET ?? ''
if (!/^aikayun-75a-test-[a-f0-9]{24}$/.test(project) || !/^[a-f0-9]{64}$/.test(db) || !socket.startsWith('/')) throw new Error('unsafe fixture context')
const binary = await realpath(execFileSync('which', ['docker'], { encoding: 'utf8' }).trim())
const socketPath = await realpath(socket)
const docker = (...args: string[]) => execFileSync(binary, ['--host', `unix://${socketPath}`, ...args], { encoding: 'utf8' }).trim()
const find = (service: string) => {
  const shortId = docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${service}`)
  assert.match(shortId, /^[a-f0-9]{12,64}$/)
  const id = docker('inspect', '--format', '{{.Id}}', shortId)
  assert.match(id, /^[a-f0-9]{64}$/)
  assert.equal(docker('inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', id), project)
  return id
}
assert.equal(find('db'), db)
for (const key of ['STATE', 'POSTGRES', 'CADDY_DATA', 'CADDY_CONFIG']) {
  const name = process.env[`AIKAYUN_FIXTURE_${key}_VOLUME`] ?? ''
  assert.ok(name.startsWith(`${project}_`))
  assert.equal(docker('volume', 'inspect', '--format', '{{ index .Labels "com.aikayun.fixture" }}', name), project)
}
const sql = (statement: string) => docker('exec', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-U', 'aikayun_bootstrap', '-d', 'aikayun', '-c', statement)
const customer = randomUUID()
const attempt = randomUUID()
const key = randomUUID()
const marker = `backup_fixture_${randomUUID().replaceAll('-', '')}`
sql(`INSERT INTO customers (id,username,password_hash) VALUES ('${customer}','${marker}','fixture'); INSERT INTO payment_attempts (id,idempotency_key,request_sha256,topup_customer_id,source,amount,provider) VALUES ('${attempt}','${key}','${'a'.repeat(64)}','${customer}','external',1,'fixture'); INSERT INTO payment_attempt_provider_state (payment_attempt_id,state,request_started_at) VALUES ('${attempt}','unknown',clock_timestamp());`)
const services = ['caddy', 'web', 'api'].map(name => ({ name, containerId: find(name), running: true }))
const roleNames = ['aikayun_app', 'aikayun_migrator'] as const
const roles = roleNames.map(name => ({ name, canLogin: sql(`SELECT rolcanlogin FROM pg_roles WHERE rolname='${name}'`) === 't' }))
const deployment = 'a'.repeat(64)
const adapter: QuiesceAdapter = {
  assertLock: async () => {}, // This isolated callback has no production deployment lock.
  assertDeployment: async value => { assert.equal(value, deployment); assert.equal(find('db'), db) },
  assertNoWriters: async () => {
    assert.equal(sql("SELECT count(*) FROM pg_stat_activity WHERE usename IN ('aikayun_app','aikayun_migrator')"), '0')
    for (const service of services) assert.equal(docker('inspect', '--format', '{{.State.Running}}', service.containerId), 'false')
  },
  assertRestorationSafe: async () => {
    assert.equal(sql("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'aikayun_backup_%'"), '0')
    for (const service of services) assert.equal(find(service.name), service.containerId)
  },
  containerState: async id => docker('inspect', '--format', '{{.State.Running}}', id) === 'true' ? 'running' : 'stopped',
  stopContainer: async id => { docker('stop', id) },
  startContainer: async id => { docker('start', id) },
  roleLogin: async name => sql(`SELECT rolcanlogin FROM pg_roles WHERE rolname='${name}'`) === 't',
  setRoleLogin: async (name, allowed) => { assert.ok(roleNames.includes(name)); sql(`ALTER ROLE ${name} ${allowed ? 'LOGIN' : 'NOLOGIN'}`) },
}
const journalDir = await realpath(await mkdtemp(join(work, 'journal-')))
const stage = await realpath(await mkdtemp(join(work, 'stage-')))
const target = { dockerBinary: binary, dockerSocket: socketPath, containerId: db, database: 'aikayun', user: 'aikayun_bootstrap', stagingDirectory: stage, assertSecureStaging: async () => {}, timeoutMs: 10000 }
const snapshot = () => ({ deployment, backupSetId: randomUUID(), services, roles })
try {
  await quiesceAndCapture(journalDir, snapshot(), adapter, async () => {
    await capturePostgresDump(target)
    await verifyPostgresDump(target)
    const archive = await readFile(join(stage, 'database.dump'))
    const restoredText = execFileSync(binary, ['--host', `unix://${socketPath}`, 'exec', '-i', db, 'pg_restore', '--file=-'], { input: archive, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
    assert.ok(restoredText.includes(marker) && restoredText.includes(attempt))
    return true
  }, async value => value)
  assert.equal((await readMaintenanceJournal(journalDir))?.phase, 'complete')
  for (const service of services) assert.equal(await adapter.containerState(service.containerId), 'running')
  for (const role of roles) assert.equal(await adapter.roleLogin(role.name), role.canLogin)
  assert.equal(sql(`SELECT count(*) FROM payment_attempt_provider_state WHERE payment_attempt_id='${attempt}' AND state='unknown'`), '1')
  await rm(join(stage, 'database.dump'))

  // Inject an unexpected bootstrap session before the simulated fence so the
  // real pg_dump waits. The adapter here checks business roles only; it does
  // not prove the production fence protects against unknown bootstrap writers.
  const holder = spawn(binary, ['--host', `unix://${socketPath}`, 'exec', '-e', 'PGAPPNAME=aikayun_fixture_holder', db,
    'psql', '-U', 'aikayun_bootstrap', '-d', 'aikayun', '-c', 'BEGIN; LOCK TABLE customers IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(20);'])
  try {
    await new Promise(resolve => setTimeout(resolve, 300))
    await assert.rejects(quiesceAndCapture(journalDir, snapshot(), adapter, async () => {
      const controller = new AbortController()
      const pending = capturePostgresDump({ ...target, signal: controller.signal })
      let waiting = false
      for (let i = 0; i < 50 && !waiting; i++) {
        waiting = Number(sql("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'aikayun_backup_%' AND wait_event_type='Lock'")) > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.equal(waiting, true)
      controller.abort()
      return pending
    }, async value => value), /DUMP_INTERRUPTED/)
  } finally {
    sql("SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE application_name='aikayun_fixture_holder'")
    holder.kill('SIGKILL')
  }
  assert.equal(sql("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'aikayun_backup_%'"), '0')
  for (const service of services) assert.equal(await adapter.containerState(service.containerId), 'running')
  await assert.rejects(quiesceAndCapture(journalDir, snapshot(), adapter, () => capturePostgresDump({ ...target, database: 'missing_test' }), async value => value), UnsafeMaintenanceRecoveryError)
  assert.equal((await readMaintenanceJournal(journalDir))?.phase, 'stopped')
  for (const service of services) assert.equal(await adapter.containerState(service.containerId), 'stopped')
  await recoverMaintenance(journalDir, adapter)
  for (const service of services) assert.equal(await adapter.containerState(service.containerId), 'running')
  assert.equal(sql(`SELECT count(*) FROM payment_attempt_provider_state WHERE payment_attempt_id='${attempt}' AND state='unknown'`), '1')
  console.log('isolated production Compose pg_dump, stop, abort, failure and state restoration passed')
} finally {
  await rm(journalDir, { recursive: true, force: true })
  await rm(stage, { recursive: true, force: true })
}
