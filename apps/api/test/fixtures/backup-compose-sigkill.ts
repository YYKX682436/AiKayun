// Isolated fault supervisor. Never used as a customer command.
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import type { Database } from '../../src/db/types.js'
import { DockerPgQuiesceAdapter } from '../../src/backup/docker-pg-fence.js'
import { recoverValidatedMaintenance } from '../../src/backup/maintenance-recovery.js'
import { readMaintenanceJournal } from '../../src/backup/journal.js'
import { LocalResticRepository } from '../../src/backup/restic-local.js'
import { verifyPublishedSnapshot } from '../../src/backup/publish-set.js'
import { assertNoUncertainBackupState } from '../../src/backup/fixed-create-gate.js'

const exec = promisify(execFile)
const project = process.env.AIKAYUN_FIXTURE_PROJECT ?? '', work = await realpath(process.env.AIKAYUN_FIXTURE_WORK ?? '')
const socket = await realpath(process.env.AIKAYUN_FIXTURE_DOCKER_SOCKET ?? '')
const volumes = [process.env.AIKAYUN_FIXTURE_STATE_VOLUME, process.env.AIKAYUN_FIXTURE_CADDY_DATA_VOLUME, process.env.AIKAYUN_FIXTURE_CADDY_CONFIG_VOLUME]
if (!/^aikayun-75a-test-[a-f0-9]{24}$/.test(project) || !work.includes('/aikayun-75a-fixture.') ||
    volumes.join(',') !== [`${project}_aikayun_state`, `${project}_caddy_data`, `${project}_caddy_config`].join(',')) throw new Error('Unsafe fixture identity')
const docker = async (args: string[]) => (await exec('docker', ['--host', `unix://${socket}`, ...args], { timeout: 60000, maxBuffer: 1024 * 1024 })).stdout.trim()
for (const volume of volumes) if (await docker(['volume', 'inspect', '--format', '{{ index .Labels "com.aikayun.fixture" }}', volume!]) !== project) throw new Error('Fixture volume ownership changed')
const postgresImage = 'docker.io/library/postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
// Extend the synthetic state so a real restic upload can be observed while active.
await docker(['run', '--rm', '--network', 'none', '--mount', `type=volume,src=${volumes[0]},dst=/state`, '--entrypoint', 'sh', postgresImage, '-c', 'umask 077; dd if=/dev/urandom of=/state/fixture-fault-data bs=1048576 count=96 status=none'])
type Context = { phase: string; journal: string; pub: string; stage: string; scratch: string; repoDir: string; passwordFile: string; port: string; first: { backupSetId: string }; before: unknown; managed: { id: string; service: string }[]; relayName: string; relayNetwork: string }
const host = { assertOwnedLock: async () => {}, verifyDeployment: async (value: string) => { if (value !== 'a'.repeat(64)) throw new Error('Fixture proof failed') } }
const password = (await readFile(join(work, 'postgres'), 'utf8')).trim()
const waitUntil = async <T>(fn: () => Promise<T | undefined>, ms = 30000): Promise<T> => { const deadline = Date.now() + ms; while (Date.now() < deadline) { const v = await fn(); if (v !== undefined) return v; await delay(50) } throw new Error('Fault fixture timeout') }
const allModes = ['stopped', 'dump', 'upload'] as const
const selected = process.argv.slice(2)
if (selected.some(value => !allModes.some(mode => mode === value)) || new Set(selected).size !== selected.length) throw new Error('Invalid fixture fault selection')
for (const mode of allModes.filter(value => selected.length === 0 || selected.includes(value))) {
  const child = spawn(process.execPath, ['--import', 'tsx', join(process.cwd(), 'test/fixtures/backup-compose-full.ts')], { env: { ...process.env, AIKAYUN_FIXTURE_KILL_MODE: mode }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let exited = false
  const exitResult: { signal: NodeJS.Signals | null } = { signal: null }
  child.stdout!.resume(); child.stderr!.resume()
  const exit = new Promise<void>(resolve => child.once('exit', (_code, signal) => { exited = true; exitResult.signal = signal; resolve() }))
  const messages: Context[] = []
  child.on('message', message => messages.push(message as Context))
  const message = async (phase: string) => waitUntil(async () => { if (exited) throw new Error(`Fixture child exited in ${phase}`); return messages.find(item => item.phase === phase) }, 180000)
  let ctx: Context | undefined, db: Kysely<Database> | undefined, blocker: Pool | undefined, blockerClient: PoolClient | undefined, resticPid: number | undefined, dumpDockerPid: number | undefined
  try {
    ctx = await message('prepared')
    const connect = () => { const pool = new Pool({ host: '127.0.0.1', port: Number(ctx!.port), user: 'aikayun_bootstrap', password, database: 'aikayun', max: 1 }); pool.on('error', () => {}); return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }) }
    db = connect()
    await sql`CREATE TABLE IF NOT EXISTS backup_fault_fixture (id integer PRIMARY KEY, value text NOT NULL)`.execute(db)
    await sql`INSERT INTO backup_fault_fixture VALUES (1, 'unchanged') ON CONFLICT (id) DO NOTHING`.execute(db)
    await db.destroy(); db = undefined
    child.send('continue')
    if (mode === 'dump') {
      await message('stopped')
      blocker = new Pool({ host: '127.0.0.1', port: Number(ctx.port), user: 'aikayun_bootstrap', password, database: 'aikayun', max: 1 })
      const client = await blocker.connect(); blockerClient = client
      await client.query('BEGIN'); await client.query('LOCK TABLE backup_fault_fixture IN ACCESS EXCLUSIVE MODE')
      child.send('continue')
      await waitUntil(async () => { await client.query('SELECT pg_stat_clear_snapshot()'); const r = await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE 'aikayun_backup_%' AND wait_event_type = 'Lock'"); return r.rows[0].n > 0 ? true : undefined }, 60000)
      dumpDockerPid = await waitUntil(async () => { const rows = (await exec('/bin/ps', ['-axo', 'pid=,ppid=,command='])).stdout.split('\n'); for (const row of rows) { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row); if (m && Number(m[2]) === child.pid && m[3]!.includes('/docker-client') && m[3]!.includes('pg_dump')) return Number(m[1]) } return undefined }, 10000)
      child.kill('SIGKILL'); await exit
      await client.query('ROLLBACK'); client.release(); blockerClient = undefined; await blocker.end(); blocker = undefined
    } else if (mode === 'stopped') {
      await message('stopped'); child.kill('SIGKILL'); await exit
    } else {
      await message('upload')
      resticPid = await waitUntil(async () => { const rows = (await exec('/bin/ps', ['-axo', 'pid=,ppid=,command='])).stdout.split('\n'); for (const row of rows) { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row); if (m && Number(m[2]) === child.pid && /(?:^|\/)restic\s/.test(m[3]!) && /\sbackup\s/.test(m[3]!)) return Number(m[1]) } return undefined }, 90000)
      await waitUntil(async () => {
        try { process.kill(resticPid!, 0) } catch { throw new Error('Restic exited before a data pack was observed') }
        const data = join(ctx!.repoDir, 'data')
        for (const prefix of await readdir(data)) for (const file of await readdir(join(data, prefix))) {
          if ((await stat(join(data, prefix, file))).size > 0) return true
        }
        return undefined
      }, 30000)
      process.kill(resticPid, 'SIGSTOP'); child.kill('SIGKILL'); await exit; process.kill(resticPid, 'SIGCONT')
      try { process.kill(resticPid, 'SIGTERM') } catch { /* Already exited. */ }
      await waitUntil(async () => { try { process.kill(resticPid!, 0); return undefined } catch { return true } }, 30000)
      resticPid = undefined
    }
    if (exitResult.signal !== 'SIGKILL') throw new Error('Helper was not terminated by SIGKILL')
    db = connect()
    // Dump backend may survive Docker client death: identify and terminate only
    // this random fixture's generated application name before explicit recovery.
    if (mode === 'dump') {
      if (!(await readdir(ctx.stage)).includes('database.dump')) throw new Error('Interrupted dump evidence disappeared')
      await sql`SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE application_name LIKE 'aikayun_backup_%' AND pid <> pg_backend_pid()`.execute(db)
      await waitUntil(async () => { try { process.kill(dumpDockerPid!, 0); return undefined } catch { return true } }, 30000)
    }
    const record = await readMaintenanceJournal(ctx.journal)
    if (!record || record.phase !== (mode === 'upload' ? 'complete' : 'stopped')) throw new Error('Unexpected durable maintenance phase')
    const adapter = new DockerPgQuiesceAdapter({ dockerBinary: join(work, 'docker-client'), dockerSocket: socket, dockerHome: work, project, deployment: 'a'.repeat(64), stateVolumes: volumes as [string, string, string], managed: ctx.managed, db, host })
    if (mode !== 'upload') {
      if (await adapter.roleLogin('aikayun_app') !== false || await adapter.roleLogin('aikayun_migrator') !== false) throw new Error('Fence disappeared after SIGKILL')
      for (const service of record.services) if (await adapter.containerState(service.containerId) !== 'stopped') throw new Error('Writer restarted after SIGKILL')
      await adapter.assertNoWriters()
      const assertNoBackupHelpers = async () => {
        const active = await sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name LIKE 'aikayun_backup_%' AND pid <> pg_backend_pid()`.execute(db!)
        if (active.rows[0]?.count !== '0') throw new Error('Fixture dump remains active')
        for (const volume of volumes) if (await docker(['ps', '-aq', '--no-trunc', '--filter', `volume=${volume}`, '--filter', 'label=com.aikayun.backup.archive'])) throw new Error('Fixture archive helper remains')
      }
      const recovery = { journalDirectory: ctx.journal, deployment: 'a'.repeat(64), managed: ctx.managed, adapter, assertNoBackupHelpers }
      const missing = await mkdtemp(join(work, 'missing-journal-'))
      let missingRejected = false
      try { await recoverValidatedMaintenance({ ...recovery, journalDirectory: missing }) } catch (error) { missingRejected = error instanceof Error && error.message === 'BACKUP_MAINTENANCE_UNVERIFIED' }
      if (!missingRejected) throw new Error('Missing journal was not rejected')
      await adapter.setRoleLogin('aikayun_app', true)
      let thirdRejected = false
      try { await recoverValidatedMaintenance(recovery) } catch (error) { thirdRejected = error instanceof Error && error.message === 'Database role state is uncertain' }
      finally { await adapter.setRoleLogin('aikayun_app', false) }
      if (!thirdRejected) throw new Error('Unexpected role state was not rejected')
      const helperName = `${project}-recovery-writer`
      try {
        await docker(['run', '-d', '--name', helperName, '--label', `com.aikayun.fixture=${project}`, '--label', 'com.aikayun.backup.archive=fixture',
          '--network', 'none', '--mount', `type=volume,src=${volumes[0]},dst=/state`, '--entrypoint', 'sleep', postgresImage, '300'])
        let helperRejected = false
        try { await recoverValidatedMaintenance(recovery) } catch (error) { helperRejected = error instanceof Error && error.message === 'Fixture archive helper remains' }
        if (!helperRejected) throw new Error('Unknown fixture helper was not rejected')
      } finally {
        const label = await docker(['inspect', '--format', '{{ index .Config.Labels "com.aikayun.fixture" }}', helperName]).catch(() => '')
        if (label === project) await docker(['rm', '-f', '-v', helperName])
      }
      await adapter.assertNoWriters()
      await recoverValidatedMaintenance(recovery)
    } else {
      const marker = JSON.parse(await readFile(join(ctx.pub, `${ctx.first.backupSetId}.json`), 'utf8')) as { state: string }
      if (marker.state !== 'uploading') throw new Error('Unknown upload was marked complete')
      const repository = new LocalResticRepository({ binary: await realpath(process.env.AIKAYUN_FIXTURE_RESTIC!), repository: ctx.repoDir, passwordFile: ctx.passwordFile })
      let createRejected = false
      try { await assertNoUncertainBackupState({ repositoryDirectory: ctx.repoDir, journalDirectory: ctx.journal, publicationDirectory: ctx.pub, mountRoot: ctx.scratch, repository, assertLock: host.assertOwnedLock }) }
      catch (error) { createRejected = error instanceof Error && error.message === 'BACKUP_PREVIOUS_ATTEMPT_REQUIRES_REVIEW' }
      if (!createRejected) throw new Error('Unknown upload did not block a new create')
      let rejected = false
      try { await verifyPublishedSnapshot({ backupSetId: ctx.first.backupSetId, publicationDirectory: ctx.pub, scratchParent: ctx.scratch, tarBinary: await realpath('/usr/bin/tar'), repository, maxExtractBytes: 250 * 1024 * 1024, assertSecureStorage: async () => {}, assertSafeCleanup: async () => {}, verifyDumpBinding: async () => { throw new Error('Unexpected dump verifier') } }) } catch (error) { rejected = error instanceof Error && error.message === 'BACKUP_PUBLICATION_NOT_VERIFIED' }
      if (!rejected) throw new Error('Unknown upload was not rejected by publication state')
    }
    for (const service of record.services) if (await adapter.containerState(service.containerId) !== (service.running ? 'running' : 'stopped')) throw new Error('Original service state changed')
    for (const role of record.roles) if (await adapter.roleLogin(role.name) !== role.canLogin) throw new Error('Original role state changed')
    if (JSON.stringify((await sql`SELECT row_to_json(b) AS value FROM installation_binding b`.execute(db)).rows) !== JSON.stringify(ctx.before)) throw new Error('DB binding changed')
    const data = await sql<{ value: string }>`SELECT value FROM backup_fault_fixture WHERE id = 1`.execute(db)
    if (data.rows.length !== 1 || data.rows[0]?.value !== 'unchanged') throw new Error('Fixture data changed')
    console.log(mode === 'upload' ? 'SIGKILL upload: completed maintenance, uncertain marker, verification rejection and fixture data passed' : `SIGKILL ${mode}: journal, writer checks, explicit recovery and fixture data passed`)
  } finally {
    if (!exited) { child.kill('SIGKILL'); await exit }
    if (resticPid) { try { process.kill(resticPid, 'SIGCONT'); process.kill(resticPid, 'SIGKILL') } catch { /* Already exited. */ } }
    if (blockerClient) { await blockerClient.query('ROLLBACK').catch(() => {}); blockerClient.release() }
    if (blocker) await blocker.end().catch(() => {})
    if (db) await db.destroy()
    const relayName = `${project}-full-relay`, relayNetwork = `${project}-full-relay-net`
    const relayProject = await docker(['inspect', '--format', '{{ index .Config.Labels "com.aikayun.fixture" }}', relayName]).catch(() => '')
    if (relayProject === project) await docker(['rm', '-f', '-v', relayName])
    const label = await docker(['network', 'inspect', '--format', '{{ index .Labels "com.aikayun.fixture" }}', relayNetwork]).catch(() => '')
    if (label === project) await docker(['network', 'rm', relayNetwork])
  }
}
console.log('Synthetic signature, lock and plaintext staging are test substitutes; no production deployment was used')
