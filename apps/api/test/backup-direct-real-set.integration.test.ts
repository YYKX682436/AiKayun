import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import type { Database } from '../src/db/types.js'
import { parseCodePoolEncryptionKeyRing, parsePaymentCredentialKeyRing } from '../src/config.js'
import { readBackupDatabaseMetadata } from '../src/backup/database-metadata.js'
import { readBackupKeyReferences } from '../src/backup/key-references.js'
import { readBackupPendingSummary } from '../src/backup/pending-summary.js'
import { capturePostgresDump, verifyPostgresDumpBinding } from '../src/backup/pg-dump.js'
import { captureDirectUnpublishedSet } from '../src/backup/direct-capture-set.js'
import { verifyDirectSourceSnapshot } from '../src/backup/direct-source-inspection.js'
import { publishDirectCapturedSet, verifyDirectPublishedSet } from '../src/backup/direct-publish-set.js'
import { advanceMaintenanceJournal, createMaintenanceJournal } from '../src/backup/journal.js'
import { DirectResticVolumeReader } from '../src/backup/restic-container.js'
import { ResticCommandContainer } from '../src/backup/restic-command-container.js'
import { LocalResticRepository } from '../src/backup/restic-local.js'

const exec = promisify(execFile)
const image = process.env.AIKAYUN_FIXTURE_RESTIC_IMAGE || ''
const project = process.env.AIKAYUN_FIXTURE_PROJECT || ''
const fixtureWork = process.env.AIKAYUN_FIXTURE_WORK || ''
const socket = process.env.AIKAYUN_FIXTURE_DOCKER_SOCKET || ''
const container = process.env.AIKAYUN_FIXTURE_DATABASE_CONTAINER_ID || ''
const port = process.env.AIKAYUN_FIXTURE_DATABASE_HOST_PORT || ''
const databaseName = process.env.AIKAYUN_FIXTURE_DATABASE_NAME || ''
const postgresPasswordFile = process.env.AIKAYUN_FIXTURE_POSTGRES_PASSWORD_FILE || ''
const paymentFile = process.env.AIKAYUN_FIXTURE_PAYMENT_KEY_RING_FILE || ''
const deliveryFile = process.env.AIKAYUN_FIXTURE_DELIVERY_KEY_RING_FILE || ''
const sourceVolumes = {
  state: process.env.AIKAYUN_FIXTURE_STATE_VOLUME || '',
  caddyData: process.env.AIKAYUN_FIXTURE_CADDY_DATA_VOLUME || '',
  caddyConfig: process.env.AIKAYUN_FIXTURE_CADDY_CONFIG_VOLUME || '',
}
const stagingVolume = project + '_reader_staging'
const deploymentVolume = project + '_reader_deployment'
const manifestVolume = project + '_reader_manifest'
const originalAppUid = Number(process.env.AIKAYUN_FIXTURE_APP_UID || process.getuid?.() || 0)
const originalAppGid = Number(process.env.AIKAYUN_FIXTURE_APP_GID || process.getgid?.() || 0)
const fixture = Boolean(/^sha256:[a-f0-9]{64}$/.test(image) &&
  /^aikayun-75a-test-[a-f0-9]{24}$/.test(project) && fixtureWork && socket.startsWith('/') &&
  /^[a-f0-9]{64}$/.test(container) && /^[1-9][0-9]{0,4}$/.test(port) &&
  /^[a-z][a-z0-9_]{0,62}$/.test(databaseName) && postgresPasswordFile && paymentFile && deliveryFile &&
  sourceVolumes.state === project + '_aikayun_state' && sourceVolumes.caddyData === project + '_caddy_data' &&
  sourceVolumes.caddyConfig === project + '_caddy_config')
const uninitializedTrust = { status: 'uninitialized' as const, bundleVersion: null, artifactSha256: null,
  stateDigest: null, revokedKeyCount: 0, retiredKeyCount: 0 }
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const noop = async () => {}
const dockerBinaryPromise = exec('which', ['docker']).then(async result => realpath(result.stdout.trim()))
let dockerBinary = '', root = ''
const testVolumes: string[] = []
let pool: Pool | undefined, db: Kysely<Database> | undefined
const serviceIds = new Map<string, string>(), originalRunning = new Map<string, boolean>()
let originalRoles = new Map<'aikayun_app' | 'aikayun_migrator', boolean>()
let stateOwnerChanged = false

async function docker(args: string[], timeout = 120_000): Promise<string> {
  return (await exec(dockerBinary, ['--host', 'unix://' + socket, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: root || fixtureWork, LANG: 'C' }, timeout, maxBuffer: 8 * 1024 * 1024,
  })).stdout.trim()
}

async function servicesRunning(): Promise<boolean> {
  for (const id of serviceIds.values()) {
    if (await docker(['inspect', '--format', '{{.State.Status}}', id]) !== 'running') return false
  }
  return true
}

async function readRoleStates(): Promise<Map<'aikayun_app' | 'aikayun_migrator', boolean>> {
  const result = await pool!.query("SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('aikayun_app', 'aikayun_migrator') ORDER BY rolname")
  if (result.rows.length !== 2) throw new Error('DIRECT_REAL_FIXTURE_ROLE_STATE_INVALID')
  return new Map(result.rows.map((row: { rolname: 'aikayun_app' | 'aikayun_migrator'; rolcanlogin: boolean }) =>
    [row.rolname, row.rolcanlogin]))
}

async function setLogin(role: 'aikayun_app' | 'aikayun_migrator', enabled: boolean): Promise<void> {
  await pool!.query('ALTER ROLE ' + role + (enabled ? ' LOGIN' : ' NOLOGIN'))
}

async function setStateOwner(uid: number, gid: number): Promise<void> {
  await docker(['run', '--rm', '--pull=never', '--network', 'none', '--mount',
    'type=volume,source=' + sourceVolumes.state + ',target=/state', '--entrypoint', '/bin/sh', 'alpine:3.24.1', '-c',
    'for path in identity license-pending license-trust media private-files; do chown -R ' + uid + ':' + gid + ' "/state/$path"; done'])
}

async function inspectTrustStoreReadOnly(directory: string) {
  const names = await import('node:fs/promises').then(fs => fs.readdir(directory))
  if (names.length !== 0) throw new Error('DIRECT_REAL_FIXTURE_EXPECTED_UNINITIALIZED_TRUST_STORE')
  return uninitializedTrust
}

beforeAll(async () => {
  if (!fixture) return
  process.env.NODE_ENV = 'test'
  root = await realpath(await mkdtemp(join(process.cwd(), '.tmp-direct-real-set-')))
  dockerBinary = join(root, 'docker')
  await copyFile(await dockerBinaryPromise, dockerBinary)
  await chmod(dockerBinary, 0o700)
  const password = (await readFile(postgresPasswordFile, 'utf8')).trim()
  const connection = new URL('postgresql://localhost/')
  connection.username = 'aikayun_bootstrap'
  connection.password = password
  connection.hostname = '127.0.0.1'
  connection.port = port
  connection.pathname = '/' + databaseName
  pool = new Pool({ connectionString: connection.toString(), max: 6, connectionTimeoutMillis: 10_000 })
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  await pool.query('SELECT 1')

  for (const service of ['api', 'web', 'caddy']) {
    const id = await docker(['ps', '-aq', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + project,
      '--filter', 'label=com.docker.compose.service=' + service])
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('DIRECT_REAL_FIXTURE_SERVICE_INVALID')
    serviceIds.set(service, id)
    originalRunning.set(service, await docker(['inspect', '--format', '{{.State.Status}}', id]) === 'running')
  }
  if ([...originalRunning.values()].some(value => !value)) throw new Error('DIRECT_REAL_FIXTURE_SERVICES_NOT_RUNNING')
  originalRoles = await readRoleStates()
  if (!originalRoles.get('aikayun_app')) {
    throw new Error('DIRECT_REAL_FIXTURE_ROLE_STATE_INVALID')
  }
})

afterAll(async () => {
  if (stateOwnerChanged) await setStateOwner(originalAppUid, originalAppGid).catch(() => {})
  if (pool && originalRoles.size) {
    for (const [role, enabled] of originalRoles) await setLogin(role, enabled).catch(() => {})
  }
  const toStart: string[] = []
  for (const [name, id] of serviceIds) {
    if (originalRunning.get(name) && await docker(['inspect', '--format', '{{.State.Status}}', id]).catch(() => '') !== 'running') {
      toStart.push(id)
    }
  }
  if (toStart.length) await docker(['start', ...toStart]).catch(() => {})
  if (db) await db.destroy().catch(() => {})
  else if (pool) await pool.end().catch(() => {})
  for (const volume of testVolumes) {
    const owner = await docker(['volume', 'inspect', '--format', '{{ index .Labels "com.aikayun.fixture" }}', volume]).catch(() => '')
    if (owner === project) await docker(['volume', 'rm', volume]).catch(() => {})
  }
  if (root && root.startsWith(process.cwd() + '/.tmp-direct-real-set-')) await rm(root, { recursive: true, force: true })
})

describe.skipIf(!fixture)('real PostgreSQL 18 direct source capture and paired Restic publication', () => {
  it('dumps the real Compose database, snapshots production volumes, restores services, and verifies the pair', async () => {
    const set = randomUUID()
    const stagingRoot = join(root, 'staging', set)
    const payload = join(stagingRoot, 'payload')
    const deploymentRoot = join(root, 'deployment')
    const repositoryRoot = join(root, 'repository')
    const scratch = join(root, 'scratch')
    const journalDirectory = join(root, 'journal')
    const publicationDirectory = join(root, 'publications')
    const manifestDirectory = join(root, 'manifest', set)
    const localPassword = join(root, 'restic-password')
    for (const path of [stagingRoot, payload, deploymentRoot, repositoryRoot, scratch, journalDirectory,
      publicationDirectory, manifestDirectory]) await mkdir(path, { recursive: true, mode: 0o700 })
    await Promise.all([stagingRoot, payload, deploymentRoot, repositoryRoot, scratch, journalDirectory,
      publicationDirectory, manifestDirectory].map(path => chmod(path, 0o700)))
    await writeFile(localPassword, 'isolated direct Restic password ' + set + '\n', { mode: 0o600 })
    let resticDiagnostic = ''
    const repositoryExecutor = new ResticCommandContainer({ dockerBinary, dockerSocket: socket, image,
      repositoryDirectory: repositoryRoot, passwordFile: localPassword, timeoutMs: 120_000, assertLock: noop,
      testDiagnostic: tokens => { resticDiagnostic = tokens },
      testSourceVolume: manifestVolume, async testPrepareSource(source) {
        await docker(['run', '--rm', '--pull=never', '--network', 'none', '--mount',
          'type=bind,source=' + source + ',target=/fixture,readonly', '--mount',
          'type=volume,source=' + manifestVolume + ',target=/manifest', '--entrypoint', '/usr/local/bin/node',
          'node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c',
          '-e', 'const fs=require("node:fs"),uid=Number(process.argv[1]),gid=Number(process.argv[2]);' +
            'const d=fs.statSync("/fixture");fs.chownSync("/manifest",uid,gid);fs.chmodSync("/manifest",d.mode&0o777);' +
            'for(const n of fs.readdirSync("/fixture")){if(n!=="manifest.json")process.exit(2);' +
            'const a="/fixture/"+n,b="/manifest/"+n;fs.copyFileSync(a,b);const s=fs.statSync(a);' +
            'fs.chownSync(b,uid,gid);fs.chmodSync(b,s.mode&0o777)}', String(process.getuid!()), String(process.getgid!())])
      } })
    await repositoryExecutor.initialize()
    const repository = new LocalResticRepository({ repository: repositoryRoot, passwordFile: localPassword,
      executor: repositoryExecutor, timeoutMs: 120_000 })
    await repository.initialize()

    for (const [name, label] of [[stagingVolume, 'backup_staging'], [deploymentVolume, 'backup_deployment']] as const) {
      await docker(['volume', 'create', '--label', 'com.aikayun.fixture=' + project,
        '--label', 'com.docker.compose.volume=' + label, '--label', 'com.docker.compose.project=aikayun', name])
      testVolumes.push(name)
    }
    await docker(['volume', 'create', '--label', 'com.aikayun.fixture=' + project,
      '--label', 'com.aikayun.backup.test-source=manifest', manifestVolume])
    testVolumes.push(manifestVolume)

    await docker(['run', '--rm', '--pull=never', '--network', 'none',
      '--mount', 'type=volume,source=' + deploymentVolume + ',target=/deployment',
      '--mount', 'type=bind,source=' + paymentFile + ',target=/fixture/payment,readonly',
      '--mount', 'type=bind,source=' + deliveryFile + ',target=/fixture/delivery,readonly',
      '--entrypoint', '/bin/sh', 'alpine:3.24.1', '-c',
      'mkdir -m 700 -p /deployment/secrets /deployment/release && ' +
      'cp /fixture/payment /deployment/secrets/payment_credential_key_ring && ' +
      'cp /fixture/delivery /deployment/secrets/code_pool_encryption_key_ring && ' +
      'chown 1000:1000 /deployment/secrets/payment_credential_key_ring /deployment/secrets/code_pool_encryption_key_ring && ' +
      'chmod 400 /deployment/secrets/payment_credential_key_ring /deployment/secrets/code_pool_encryption_key_ring && ' +
      'printf "fixture deploy config\\\\n" > /deployment/compose.yaml && ' +
      'printf "fixture install state\\\\n" > /deployment/install-state.json && ' +
      'printf "fixture release index\\\\n" > /deployment/release/release-index.json && ' +
      'chmod 600 /deployment/compose.yaml /deployment/install-state.json /deployment/release/release-index.json'])

    const migrationNames = Object.keys(await new AppMigrationProvider().getMigrations()).sort()
    const checksumBytes = Buffer.from(JSON.stringify({ schema: 1, migration_head: migrationNames.at(-1),
      migrations: migrationNames.map(name => ({ name, sha256: 'a'.repeat(64) })) }))
    const migrationHead = migrationNames.at(-1)!
    const release = { engine_major: 18, migration_head: migrationHead, migration_checksums_sha256: sha(checksumBytes) }
    const paymentKeys = parsePaymentCredentialKeyRing((await readFile(paymentFile, 'utf8')))
    const deliveryKeys = parseCodePoolEncryptionKeyRing((await readFile(deliveryFile, 'utf8')))
    if (!paymentKeys || !deliveryKeys) throw new Error('DIRECT_REAL_FIXTURE_KEY_RINGS_INVALID')

    const serviceRecords = [...serviceIds].map(([name, containerId]) => ({ name, containerId,
      running: originalRunning.get(name)! }))
    const roleRecords = [...originalRoles].map(([name, canLogin]) => ({ name, canLogin }))
    const prepared = await createMaintenanceJournal(journalDirectory, { deployment: sha('fixture:' + project),
      backupSetId: set, services: serviceRecords, roles: roleRecords })
    let journal = await advanceMaintenanceJournal(journalDirectory, prepared, 'stopping')
    const stopStarted = Date.now()
    const stoppedIds = serviceRecords.filter(item => item.running).map(item => item.containerId)
    await docker(['stop', ...stoppedIds])
    await setLogin('aikayun_app', false)
    await setLogin('aikayun_migrator', false)
    if (originalAppUid !== 1000 || originalAppGid !== 1000) {
      stateOwnerChanged = true
      await setStateOwner(1000, 1000)
    }
    journal = await advanceMaintenanceJournal(journalDirectory, journal, 'stopped')

    const dumpTarget = { dockerBinary, dockerSocket: socket, containerId: container,
      database: databaseName, user: 'aikayun_bootstrap', stagingDirectory: payload,
      assertSecureStaging: noop, timeoutMs: 120_000 }
    const operations = {
      assertFence: async () => {
        if (await servicesRunning()) throw new Error('DIRECT_REAL_FIXTURE_WRITERS_RUNNING')
        const current = await readRoleStates()
        if (current.get('aikayun_app') || current.get('aikayun_migrator')) {
          throw new Error('DIRECT_REAL_FIXTURE_WRITER_ROLE_ENABLED')
        }
      },
      assertSecureStaging: noop,
      async readDatabaseEvidence() {
        const database = await readBackupDatabaseMetadata(db!, release, checksumBytes, checksumBytes)
        const keys = await readBackupKeyReferences(db!, paymentKeys, deliveryKeys)
        const unresolved = await readBackupPendingSummary(db!)
        return { database, keys, unresolved }
      },
      async captureDump() {
        return capturePostgresDump(dumpTarget)
      },
      async verifyDumpBinding(metadata: Awaited<ReturnType<typeof readBackupDatabaseMetadata>>) {
        await verifyPostgresDumpBinding(dumpTarget, metadata)
      },
      async captureSourceSnapshot(backupSetId: string) {
        await docker(['run', '--rm', '--pull=never', '--network', 'none',
          '--mount', 'type=volume,source=' + stagingVolume + ',target=/staging',
          '--mount', 'type=bind,source=' + join(payload, 'database.dump') + ',target=/fixture/database.dump,readonly',
          '--entrypoint', '/bin/sh', 'alpine:3.24.1', '-c',
          'mkdir -m 700 -p /staging/payload && cp /fixture/database.dump /staging/payload/database.dump && ' +
          'chown ' + process.getuid!() + ':' + process.getgid!() + ' /staging/payload/database.dump && ' +
          'chmod 600 /staging/payload/database.dump'])
        const reader = await DirectResticVolumeReader.create({ dockerBinary, dockerSocket: socket, image,
          repositoryDirectory: repositoryRoot, passwordFile: localPassword, stagingDirectory: stagingRoot,
          deploymentRoot, backupSetId, testSourceVolumes: sourceVolumes, testStagingVolume: stagingVolume,
          testDeploymentVolume: deploymentVolume, timeoutMs: 180_000, assertLock: noop })
        return (await reader.backup()).snapshotId
      },
      async inspectSourceSnapshot(input: { snapshot: string; dump: { size: number; sha256: string };
        database: Awaited<ReturnType<typeof readBackupDatabaseMetadata>>;
        keys: Awaited<ReturnType<typeof readBackupKeyReferences>> }) {
        return verifyDirectSourceSnapshot({ repo: repository, set, snapshot: input.snapshot,
          scratch, databaseDump: input.dump, database: input.database, keys: input.keys, appUid: 1000, appGid: 1000,
          inspectTrustStoreReadOnly, assertLock: noop })
      },
    }
    const staged = await captureDirectUnpublishedSet({ backupSetId: set, stagingDirectory: payload,
      createdAt: new Date(Date.now() - 60_000).toISOString(), operations }).catch(error => {
        throw new Error('DIRECT_REAL_CAPTURE_FAILED:' + (error instanceof Error ? error.message : 'unknown'))
      })
    expect(staged.pgDumpVersion).toMatch(/^18\./)
    expect(staged.databaseDump.size).toBeGreaterThan(0)
    expect(staged.evidence.trustBundle.status).toBe('uninitialized')
    expect((await readFile(join(payload, 'database.dump'))).subarray(0, 5).toString('ascii')).toBe('PGDMP')

    journal = await advanceMaintenanceJournal(journalDirectory, journal, 'captured')
    journal = await advanceMaintenanceJournal(journalDirectory, journal, 'restoring')
    if (stateOwnerChanged) {
      await setStateOwner(originalAppUid, originalAppGid)
      stateOwnerChanged = false
    }
    for (const [role, canLogin] of originalRoles) await setLogin(role, canLogin)
    await docker(['start', ...stoppedIds])
    if (!(await servicesRunning())) throw new Error('DIRECT_REAL_FIXTURE_SERVICE_RESTORE_FAILED')
    const downtimeMs = Date.now() - stopStarted
    await advanceMaintenanceJournal(journalDirectory, journal, 'complete')
    await new Promise(resolve => setTimeout(resolve, 1500))

    const images = { api: 'sha256:' + 'a'.repeat(64), web: 'sha256:' + 'b'.repeat(64),
      postgres: 'sha256:' + 'c'.repeat(64), caddy: 'sha256:' + 'd'.repeat(64) }
    const published = await publishDirectCapturedSet({ staged, stagingDirectory: payload, manifestDirectory,
      scratchDirectory: scratch, journalDirectory, publicationDirectory, repository, releaseId: 'fixture-unsigned',
      images, resticVersion: '0.19.1', assertLock: noop, assertSecureStorage: noop,
      async assertRestoredAndRelease() {
        if (!(await servicesRunning())) throw new Error('DIRECT_REAL_FIXTURE_SERVICE_RESTORE_FAILED')
        const current = await readRoleStates()
        for (const [role, enabled] of originalRoles) {
          if (current.get(role) !== enabled) throw new Error('DIRECT_REAL_FIXTURE_ROLE_RESTORE_FAILED')
        }
      },
      async verifyDumpBinding(_directory, metadata) { await verifyPostgresDumpBinding(dumpTarget, metadata) },
      inspectTrustStorePersistedReadOnly: inspectTrustStoreReadOnly }).catch(async error => {
        const record = await readFile(join(publicationDirectory, `${set}.json`), 'utf8').catch(() => '')
        const diagnostic = { publicationState: (() => {
          try { return (JSON.parse(record) as { state?: unknown }).state ?? 'invalid' } catch { return 'missing' }
        })(),
        resticDiagnostic,
        reasonCode: error && typeof error === 'object' && 'reasonCode' in error ? error.reasonCode : 'unavailable' }
        throw new Error('DIRECT_REAL_PUBLICATION_FAILED:' + JSON.stringify(diagnostic) + ':' +
          (error instanceof Error ? error.message : 'unknown'))
      })
    expect(published.status).toBe('verified')
    expect(published.sourceSnapshotId).toBe(staged.sourceSnapshotId)
    const verified = await verifyDirectPublishedSet({ backupSetId: set, publicationDirectory, manifestDirectory,
      scratchDirectory: scratch, repository, assertLock: noop, assertSecureStorage: noop, inspectTrustStoreReadOnly })
    expect(verified.status).toBe('verified')
    expect(verified.sourceSnapshotId).toBe(staged.sourceSnapshotId)
    expect(verified.manifest.database_dump).toEqual(staged.databaseDump)
    expect(verified.manifest.database.id).toBe(staged.evidence.database.databaseId)
    expect(verified.manifest.service_restoration).toBe('restored')
    expect(verified.manifest.trust_bundle.status).toBe('uninitialized')
    expect(await servicesRunning()).toBe(true)
    console.info('Direct PG18 set verified; source and manifest snapshots paired; stopped duration ms:', downtimeMs)
  }, 360_000)
})
