import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
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
import { publishDirectCapturedSet } from '../src/backup/direct-publish-set.js'
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
const apiImage = process.env.AIKAYUN_FIXTURE_API_IMAGE || ''
const webImage = process.env.AIKAYUN_FIXTURE_WEB_IMAGE || ''
const resticRuntimeImage = process.env.AIKAYUN_FIXTURE_RESTIC_RUNTIME_IMAGE || ''
const releaseId = process.env.AIKAYUN_FIXTURE_RELEASE_ID || 'fixture-unsigned'
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
const imageDigest = (reference: string, fallback: string) => {
  const match = reference.match(/@sha256:([a-f0-9]{64})$/u)
  return match ? `sha256:${match[1]}` : `sha256:${fallback.repeat(64).slice(0, 64)}`
}
const noop = async () => {}
const dockerBinaryPromise = exec('which', ['docker']).then(async result => realpath(result.stdout.trim()))
let dockerBinary = '', root = ''
const testVolumes: string[] = []
let pool: Pool | undefined, db: Kysely<Database> | undefined
const serviceIds = new Map<string, string>(), originalRunning = new Map<string, boolean>()
let originalRoles = new Map<'aikayun_app' | 'aikayun_migrator', boolean>()
let stateOwnerChanged = false
let restoreTestRunId = '', restoreTestProject = ''

const restoreTables = [
  'customers', 'products', 'product_variants', 'product_variant_fulfillment', 'product_variant_quantity_inventory', 'product_variant_inventory_adjustments',
  'product_media', 'product_media_variants', 'product_media_references',
  'orders', 'order_items', 'order_inventory_reservations', 'order_inventory_events', 'wallet_accounts',
  'wallet_operations', 'wallet_ledger_entries', 'payment_attempts', 'payment_attempt_provider_state',
  'payment_attempt_secrets', 'payment_channels', 'payment_channel_audit_events', 'payment_receipts', 'payment_provider_events', 'order_refunds',
  'order_refund_allocations', 'order_refund_audit_events', 'order_refund_manual_attempts', 'withdrawals',
  'withdrawal_payout_attempts', 'withdrawal_audit_events', 'withdrawal_private_files',
  'order_status_events', 'order_item_purchase_snapshots',
  'purchase_form_templates', 'purchase_form_template_versions',
  'product_variant_fulfillment_versions', 'order_item_fulfillment_attempts', 'order_item_fulfillment_deliveries',
  'private_file_objects', 'code_pool_batches', 'code_pool_entries', 'supplier_connections',
  'supplier_connection_credentials', 'supplier_connection_versions', 'supplier_api_delivery_operations',
  'supplier_api_delivery_events', 'order_item_procurement_sources', 'procurement_operations',
  'supplier_product_mapping_heads', 'supplier_product_mapping_versions', 'procurement_operation_units',
  'procurement_operation_events', 'procurement_unit_events', 'procurement_execution_leases',
  'procurement_request_intents', 'procurement_execution_evidence', 'procurement_preparation_requests',
  'procurement_execution_conflicts', 'procurement_risk_policies', 'procurement_risk_buckets',
  'procurement_risk_daily', 'procurement_risk_reservations', 'procurement_risk_events',
  'installation_binding', 'instance_license_state',
  'local_license_operations', 'local_license_operation_attempts',
]

async function rowDigestsFromSource(): Promise<Record<string, { count: number; sha256: string }>> {
  const result: Record<string, { count: number; sha256: string }> = {}
  for (const table of restoreTables) {
    const rows = await sql<{ row: string }>`SELECT to_jsonb(row)::text AS row FROM ${sql.raw('public.' + table)} AS row ORDER BY to_jsonb(row)::text`.execute(db!)
    const hash = createHash('sha256')
    for (const row of rows.rows) hash.update(row.row).update('\n')
    result[table] = { count: rows.rows.length, sha256: hash.digest('hex') }
  }
  return result
}

async function docker(args: string[], timeout = 120_000): Promise<string> {
  return (await exec(dockerBinary, ['--host', 'unix://' + socket, ...args], {
    // Docker Desktop discovers its Compose CLI plugin through the user's
    // config/plugin directories; the explicit Engine socket remains pinned.
    env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || fixtureWork,
      LANG: 'C' }, timeout, maxBuffer: 8 * 1024 * 1024,
  })).stdout.trim()
}

async function cleanupRestoreTestResources(): Promise<void> {
  if (!restoreTestRunId || !restoreTestProject) return
  const allowedServices = new Set(['db', 'restore-secrets', 'restore-source', 'restore-manifest',
    'restore-database', 'restore-readonly-role', 'restore-input-permissions', 'validate'])
  const ids = (await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${restoreTestProject}`]))
    .split('\n').filter(Boolean)
  for (const id of ids) {
    const fields = (await docker(['inspect', '--format', '{{index .Config.Labels "com.aikayun.restore.run"}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.aikayun.restore.scope"}}', id])).split('|')
    if (fields[0] !== restoreTestRunId || fields[1] !== restoreTestProject ||
        !allowedServices.has(fields[2] || '') || fields[3] !== 'isolated-restore-v1') continue
    await docker(['rm', '-f', id]).catch(() => undefined)
  }
  const network = `${restoreTestProject}_restore`
  const networkMetadata = await docker(['network', 'inspect', network, '--format',
    '{{.Internal}}|{{index .Labels "com.aikayun.restore.run"}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.aikayun.restore.scope"}}']).catch(() => '')
  if (networkMetadata === `true|${restoreTestRunId}|${restoreTestProject}|isolated-restore-v1`) {
    await docker(['network', 'rm', network]).catch(() => undefined)
  }
  const volumes = (await docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${restoreTestProject}`]))
    .split('\n').filter(Boolean)
  for (const volume of volumes) {
    const metadata = (await docker(['volume', 'inspect', volume, '--format',
      '{{index .Labels "com.aikayun.restore.run"}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.aikayun.restore.scope"}}'])).split('|')
    if (metadata[0] === restoreTestRunId && metadata[1] === restoreTestProject && metadata[2] === 'isolated-restore-v1') {
      await docker(['volume', 'rm', volume]).catch(() => undefined)
    }
  }
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
  if (restoreTestRunId && restoreTestProject) await cleanupRestoreTestResources().catch(() => {})
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
    const customerBackupRoot = process.env.AIKAYUN_FIXTURE_CUSTOMER_BACKUP_ROOT
    const stagingRoot = join(root, 'staging', set)
    const payload = join(stagingRoot, 'payload')
    const deploymentRoot = join(root, 'deployment')
    const repositoryRoot = customerBackupRoot ? join(customerBackupRoot, 'repository') : join(root, 'repository')
    const scratch = join(root, 'scratch')
    const journalDirectory = customerBackupRoot ? join(customerBackupRoot, 'journal') : join(root, 'journal')
    const publicationDirectory = customerBackupRoot ? join(customerBackupRoot, 'publications') : join(root, 'publications')
    const manifestDirectory = customerBackupRoot
      ? join(customerBackupRoot, 'staging', `set-${set}`, 'manifest')
      : join(root, 'manifest', set)
    const customerPasswordFile = process.env.AIKAYUN_FIXTURE_CUSTOMER_PASSWORD_FILE
    if (customerBackupRoot && !customerPasswordFile) throw new Error('DIRECT_REAL_FIXTURE_CUSTOMER_PASSWORD_DESTINATION_REQUIRED')
    const localPassword = customerBackupRoot ? customerPasswordFile! : join(root, 'restic-password')
    for (const path of [stagingRoot, payload, deploymentRoot, repositoryRoot, scratch, journalDirectory,
      publicationDirectory, manifestDirectory]) await mkdir(path, { recursive: true, mode: 0o700 })
    await Promise.all([stagingRoot, payload, deploymentRoot, repositoryRoot, scratch, journalDirectory,
      publicationDirectory, manifestDirectory].map(path => chmod(path, 0o700)))
    if (customerBackupRoot) {
      await chmod(localPassword, 0o600)
    } else {
      await writeFile(localPassword, 'isolated direct Restic password ' + set + '\n', { mode: 0o600 })
    }
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
    if (customerBackupRoot) await repository.check()
    else await repository.initialize()

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
    const checksumBase64 = await docker(['exec', serviceIds.get('api')!, '/nodejs/bin/node', '-e',
      'process.stdout.write(require("node:fs").readFileSync("/app/dist/db/migration-checksums.json").toString("base64"))'])
    const checksumBytes = Buffer.from(checksumBase64, 'base64')
    const checksumManifest = JSON.parse(checksumBytes.toString('utf8')) as { migration_head: string; migrations: Array<{ name: string }> }
    const migrationHead = checksumManifest.migration_head
    if (checksumManifest.migrations.map(row => row.name).join('\n') !== migrationNames.join('\n')) {
      throw new Error('DIRECT_REAL_FIXTURE_RELEASE_MIGRATION_REGISTRY_MISMATCH')
    }
    const release = { engine_major: 18, migration_head: migrationHead, migration_checksums_sha256: sha(checksumBytes) }
    const paymentKeys = parsePaymentCredentialKeyRing((await readFile(paymentFile, 'utf8')))
    const deliveryKeys = parseCodePoolEncryptionKeyRing((await readFile(deliveryFile, 'utf8')))
    if (!paymentKeys || !deliveryKeys) throw new Error('DIRECT_REAL_FIXTURE_KEY_RINGS_INVALID')
    if (!paymentKeys.keys['fixture-history'] || !deliveryKeys.keys['fixture-history']) {
      throw new Error('DIRECT_REAL_FIXTURE_HISTORICAL_KEYS_REQUIRED')
    }
    const businessSeed = await docker(['exec', serviceIds.get('api')!, '/nodejs/bin/node',
      '/test/isolated-restore-business-seed.mjs'])
    const businessSeedLine = businessSeed.split('\n').find(line => line.startsWith('{"operation":"synthetic-restore-business-seed"'))
    if (!businessSeedLine) throw new Error('DIRECT_REAL_FIXTURE_BUSINESS_SEED_FAILED')
    const businessReport = JSON.parse(businessSeedLine) as { status: string; orders: number; pendingPayment: boolean;
      refundReserved: boolean; withdrawalUncertain: boolean; historicalFileDownloadAuthorized: boolean;
      privateFileSha256Verified: boolean; publicMediaVariants: number; procurementSourceAndRisk: boolean;
      procurementOperationUnknown: boolean; procurementRiskOutstandingMinor: string }
    expect(businessReport).toMatchObject({ status: 'seeded', orders: 4, pendingPayment: true, refundReserved: true,
      withdrawalUncertain: true, historicalFileDownloadAuthorized: true, privateFileSha256Verified: true, publicMediaVariants: 3,
      procurementSourceAndRisk: true, procurementOperationUnknown: true, procurementRiskOutstandingMinor: '10' })
    const licenseSeed = await docker(['exec', '--env', 'NODE_ENV=test', serviceIds.get('api')!,
      '/nodejs/bin/node', '/test/license-pending-compose-recovery.mjs', 'seed'])
    if (!licenseSeed.includes('license_pending_fixture_seeded')) throw new Error('DIRECT_REAL_FIXTURE_LICENSE_SEED_FAILED')

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

    const images = { api: imageDigest(apiImage, 'a'), web: imageDigest(webImage, 'b'),
      postgres: imageDigest(process.env.AIKAYUN_FIXTURE_POSTGRES_IMAGE || '', 'c'),
      caddy: imageDigest(process.env.AIKAYUN_FIXTURE_CADDY_IMAGE || '', 'd') }
    const published = await publishDirectCapturedSet({ staged, stagingDirectory: payload, manifestDirectory,
      scratchDirectory: scratch, journalDirectory, publicationDirectory, repository, releaseId,
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
    const publishedManifest = JSON.parse(await readFile(join(manifestDirectory, 'manifest.json'), 'utf8')) as {
      database_dump: { size: number; sha256: string }; database: { id: string }; service_restoration: string;
      trust_bundle: { status: string }
    }
    expect(publishedManifest.database_dump).toEqual(staged.databaseDump)
    expect(publishedManifest.database.id).toBe(staged.evidence.database.databaseId)
    expect(publishedManifest.service_restoration).toBe('restored')
    expect(publishedManifest.trust_bundle.status).toBe('uninitialized')
    expect(await servicesRunning()).toBe(true)

    const rowDigests = await rowDigestsFromSource()
    if (!apiImage || !webImage || !resticRuntimeImage || !process.env.AIKAYUN_FIXTURE_POSTGRES_IMAGE ||
        !process.env.AIKAYUN_FIXTURE_CADDY_IMAGE) throw new Error('DIRECT_REAL_FIXTURE_RESTORE_IMAGES_REQUIRED')
    const restoreRun = randomUUID()
    const restoreProject = 'aikayun-drill-' + restoreRun.replaceAll('-', '')
    restoreTestRunId = restoreRun
    restoreTestProject = restoreProject
    const composeFile = join(process.cwd(), '..', '..', 'scripts/release/compose.restore-isolated.yaml')
    const envFile = join(root, 'restore.env')
    const bootstrapPassword = join(root, 'restore-bootstrap-password')
    const readonlyPassword = join(root, 'restore-readonly-password')
    await writeFile(bootstrapPassword, 'isolated-bootstrap-' + randomUUID() + '\n', { mode: 0o400 })
    await writeFile(readonlyPassword, 'isolated-readonly-' + randomUUID() + '\n', { mode: 0o400 })
    await chmod(bootstrapPassword, 0o400)
    await chmod(readonlyPassword, 0o400)
    const restoreEnv = {
      AIKAYUN_RESTORE_RUN_ID: restoreRun,
      AIKAYUN_RESTORE_PROJECT: restoreProject,
      AIKAYUN_RESTORE_SET_ID: set,
      AIKAYUN_RESTORE_SOURCE_SNAPSHOT_ID: staged.sourceSnapshotId,
      AIKAYUN_RESTORE_MANIFEST_SNAPSHOT_ID: published.snapshotId,
      AIKAYUN_RESTORE_MANIFEST_DIRECTORY: manifestDirectory,
      AIKAYUN_RESTORE_RELEASE_ID: releaseId,
      AIKAYUN_RESTORE_TEST_DIAGNOSTICS: 'true',
      AIKAYUN_RESTORE_API_DIGEST: images.api,
      AIKAYUN_RESTORE_WEB_DIGEST: images.web,
      AIKAYUN_RESTORE_POSTGRES_DIGEST: images.postgres,
      AIKAYUN_RESTORE_CADDY_DIGEST: images.caddy,
      AIKAYUN_API_IMAGE: apiImage,
      AIKAYUN_WEB_IMAGE: webImage,
      AIKAYUN_POSTGRES_IMAGE: process.env.AIKAYUN_FIXTURE_POSTGRES_IMAGE,
      AIKAYUN_CADDY_IMAGE: process.env.AIKAYUN_FIXTURE_CADDY_IMAGE,
      AIKAYUN_BACKUP_RESTIC_IMAGE: resticRuntimeImage,
      AIKAYUN_RESTORE_REPOSITORY: repositoryRoot,
      AIKAYUN_RESTORE_PASSWORD_FILE: localPassword,
      AIKAYUN_RESTORE_BOOTSTRAP_PASSWORD_FILE: bootstrapPassword,
      AIKAYUN_RESTORE_READONLY_PASSWORD_FILE: readonlyPassword,
    }
    await writeFile(envFile, Object.entries(restoreEnv).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 })
    const restoreCompose = (...args: string[]) => docker(['compose', '--project-name', restoreProject, '--file', composeFile,
      '--env-file', envFile, ...args], 180_000)
    const expectIsolatedSourceFailure = async (kind: string, override: Record<string, string>) => {
      const failureRun = randomUUID()
      const failureProject = 'aikayun-drill-' + failureRun.replaceAll('-', '')
      const failureEnvFile = join(root, `restore-${kind}.env`)
      const failureEnv = { ...restoreEnv, ...override, AIKAYUN_RESTORE_RUN_ID: failureRun,
        AIKAYUN_RESTORE_PROJECT: failureProject }
      await writeFile(failureEnvFile, Object.entries(failureEnv).map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
        { mode: 0o600 })
      const isolatedCompose = (...args: string[]) => docker(['compose', '--project-name', failureProject, '--file', composeFile,
        '--env-file', failureEnvFile, ...args], 180_000)
      await isolatedCompose('config', '--quiet')
      let failed = false
      try {
        await isolatedCompose('run', '--pull', 'never', '--no-deps', '--no-TTY', '--name', `${failureProject}-restore-source`, 'restore-source')
      } catch { failed = true }
      expect(failed).toBe(true)
      const containers = (await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${failureProject}`]))
        .split('\n').filter(Boolean)
      expect(containers).toHaveLength(1)
      for (const id of containers) {
        const details = await docker(['inspect', '--format', '{{index .Config.Labels "com.aikayun.restore.run"}}|' +
          '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|' +
          '{{index .Config.Labels "com.aikayun.restore.scope"}}|{{.State.Status}}', id])
        expect(details).toBe(`${failureRun}|${failureProject}|restore-source|isolated-restore-v1|exited`)
      }
      const volumes = (await docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${failureProject}`]))
        .split('\n').filter(Boolean)
      for (const volume of volumes) {
        const labels = (await docker(['volume', 'inspect', '--format',
          '{{index .Labels "com.aikayun.restore.run"}}|{{index .Labels "com.docker.compose.project"}}|' +
          '{{index .Labels "com.aikayun.restore.scope"}}', volume])).split('|')
        expect(labels).toEqual([failureRun, failureProject, 'isolated-restore-v1'])
      }
      await isolatedCompose('down', '--volumes', '--remove-orphans')
      expect(await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${failureProject}`])).toBe('')
      expect(await docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${failureProject}`])).toBe('')
      expect(await docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${failureProject}`])).toBe('')
    }
    const wrongResticPassword = join(root, 'wrong-restic-password')
    await writeFile(wrongResticPassword, 'synthetic-wrong-password\n', { mode: 0o400 })
    await chmod(wrongResticPassword, 0o400)
    await expectIsolatedSourceFailure('wrong-password', { AIKAYUN_RESTORE_PASSWORD_FILE: wrongResticPassword })
    await expectIsolatedSourceFailure('missing-snapshot', { AIKAYUN_RESTORE_SOURCE_SNAPSHOT_ID: 'f'.repeat(64) })
    const restoreServices = (await restoreCompose('config', '--services')).split('\n').filter(Boolean).sort()
    expect(restoreServices).toEqual(['db', 'restore-database', 'restore-input-permissions', 'restore-manifest',
      'restore-readonly-role', 'restore-secrets', 'restore-source', 'validate'].sort())
    await restoreCompose('config', '--quiet')
    console.info('Restore a verified paired set into a separately named, internal-only PostgreSQL 18 Compose project')
    await restoreCompose('run', '--pull', 'never', '--no-deps', '--no-TTY', '--name', `${restoreProject}-restore-secrets`, 'restore-secrets')
    await restoreCompose('up', '--detach', '--pull', 'never', '--wait', 'db')
    const network = `${restoreProject}_restore`
    expect(await docker(['network', 'inspect', network, '--format', '{{.Internal}}'])).toBe('true')
    let validation = ''
    for (const service of ['restore-source', 'restore-manifest', 'restore-input-permissions', 'restore-database',
      'restore-readonly-role', 'validate']) {
      let output: string
      try {
        output = await restoreCompose('run', '--pull', 'never', '--no-deps', '--no-TTY', '--name', `${restoreProject}-${service}`, service)
      } catch (error) {
        const containerName = `${restoreProject}-${service}`
        const safeLogs = await docker(['logs', containerName]).catch(() => '')
        const exitCode = await docker(['inspect', '--format', '{{.State.ExitCode}}', containerName]).catch(() => 'unknown')
        const safeError = error instanceof Error ? error.message : ''
        let safeCode = (safeLogs + safeError).match(/RESTORE_[A-Z0-9_]+/u)?.[0] ??
          (service === 'restore-input-permissions' ? 'RESTORE_INPUT_DIAGNOSTIC_UNAVAILABLE' : 'RESTORE_STAGE_FAILED')
        if (service === 'restore-input-permissions') {
          const fileState = await docker(['run', '--rm', '--pull=never', '--network', 'none',
            '--mount', `type=volume,source=${restoreProject}_database_input,target=/database,readonly`,
            '--mount', `type=volume,source=${restoreProject}_manifest,target=/manifest,readonly`,
            '--entrypoint', '/bin/sh', process.env.AIKAYUN_FIXTURE_POSTGRES_IMAGE!, '-ec',
            'test -f /database/database.dump && echo RESTORE_DATABASE_PRESENT || echo RESTORE_DATABASE_MISSING; ' +
            'test -f /manifest/manifest.json && echo RESTORE_MANIFEST_AT_ROOT || ' +
            '(find /manifest -type f -name manifest.json -print -quit | grep -q . && echo RESTORE_MANIFEST_NESTED || echo RESTORE_MANIFEST_MISSING)']).catch(() => 'RESTORE_INPUT_VOLUME_DIAGNOSTIC_UNAVAILABLE')
          safeCode += ':' + fileState.split('\n').filter(line => /^RESTORE_(DATABASE|MANIFEST)_/u.test(line)).join(',')
        }
        // Raw Compose errors may echo env-file paths or credential data; the fixed stage/code/exit tuple above is the safe diagnostic.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`DIRECT_REAL_RESTORE_STAGE_FAILED:${service}:${safeCode}:EXIT_${exitCode}`)
      }
      if (service === 'validate') validation = output
    }
    const validationLine = validation.split('\n').find(line => line.startsWith('{"operation":"restore-validation"'))
    expect(validationLine).toBeTruthy()
    const validationReport = JSON.parse(validationLine!) as { status: string; network: string; purchaseSnapshotsDecrypted: number;
      business: { orders: number; orderItems: number; paymentAttempts: number; refunds: number; withdrawals: number;
        deliveries: number; fileDeliveries: number; walletLedgerEntries: number; consistency: string;
        procurementOperations: number; unknownProcurementOperations: number; procurementRequestIntents: number;
        procurementExecutionEvidence: number; procurementRiskReservations: number; procurementRiskEvents: number } }
    expect(validationReport.status).toBe('verified')
    expect(validationReport.network).toBe('egress-blocked')
    expect(validationReport.business).toMatchObject({ orders: 4, orderItems: 4, paymentAttempts: 5,
      refunds: 1, withdrawals: 1, deliveries: 2, fileDeliveries: 1, consistency: 'verified',
      procurementOperations: 1, unknownProcurementOperations: 1, procurementRequestIntents: 1,
      procurementExecutionEvidence: 1, procurementRiskReservations: 1, procurementRiskEvents: 1 })
    expect(validationReport.purchaseSnapshotsDecrypted).toBe(1)
    const restoredQuery = `SELECT table_name || ':' || encode(convert_to(row_json, 'UTF8'), 'hex') FROM (${restoreTables.map(table =>
      `SELECT '${table}'::text AS table_name, to_jsonb(row)::text AS row_json FROM public.${table} AS row`).join(' UNION ALL ')}) AS records ORDER BY table_name, row_json`
    const restoredRows = await restoreCompose('exec', '-T', 'db', '/bin/sh', '-ec',
      'export PGPASSWORD="$(cat /run/restore/readonly-password)"; psql -X --no-password --host 127.0.0.1 --username aikayun_restore_ro --dbname aikayun --no-align --tuples-only --command "$1"',
      'restore-row-digest', restoredQuery)
    const targetHashes = new Map<string, ReturnType<typeof createHash>>()
    const targetCounts = new Map<string, number>()
    for (const table of restoreTables) { targetHashes.set(table, createHash('sha256')); targetCounts.set(table, 0) }
    for (const line of restoredRows.split('\n').filter(Boolean)) {
      const separator = line.indexOf(':')
      if (separator < 1) throw new Error('DIRECT_REAL_RESTORE_ROW_DIGEST_OUTPUT_INVALID')
      const table = line.slice(0, separator), row = Buffer.from(line.slice(separator + 1), 'hex').toString('utf8')
      const hash = targetHashes.get(table)
      if (!hash) throw new Error('DIRECT_REAL_RESTORE_ROW_DIGEST_TABLE_INVALID')
      hash.update(row).update('\n')
      targetCounts.set(table, targetCounts.get(table)! + 1)
    }
    const restoredDigests = Object.fromEntries(restoreTables.map(table => [table, {
      count: targetCounts.get(table)!, sha256: targetHashes.get(table)!.digest('hex'),
    }]))
    expect(restoredDigests).toEqual(rowDigests)
    const containers = (await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${restoreProject}`])).split('\n').filter(Boolean)
    expect(containers).toHaveLength(8)
    const restoreImages = [apiImage, process.env.AIKAYUN_FIXTURE_POSTGRES_IMAGE!, resticRuntimeImage]
    const imageIds = await Promise.all(restoreImages.map(ref => docker(['image', 'inspect', '--format', '{{.Id}}', ref])))
    for (const id of containers) {
      const details = await docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Status}}|{{json .HostConfig.PortBindings}}|{{.Config.Image}}|{{.Image}}', id])
      const [service, state, portBindings, reference, imageId] = details.split('|')
      const expected = service === 'validate' ? 0 : service === 'restore-source' || service === 'restore-manifest' ? 2 : 1
      expect(reference).toBe(restoreImages[expected])
      expect(imageId).toBe(imageIds[expected])
      expect(state).toBe(service === 'db' ? 'running' : 'exited')
      expect(portBindings === 'null' || portBindings === '{}').toBe(true)
    }
    await restoreCompose('stop', 'db')
    expect(await restoreCompose('ps', '--all', '--format', 'json')).toContain('"State":"exited"')
    await restoreCompose('down', '--volumes', '--remove-orphans')
    expect(await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${restoreProject}`])).toBe('')
    expect(await docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${restoreProject}`])).toBe('')
    expect(await docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${restoreProject}`])).toBe('')
    console.info('Isolated restore PostgreSQL 18 accepted; complete selected historical rows match source exactly')
    console.info('Direct PG18 set verified; source and manifest snapshots paired; stopped duration ms:', downtimeMs)

    if (customerBackupRoot) {
      const targetRepository = join(customerBackupRoot, 'repository')
      const targetManifest = join(customerBackupRoot, 'staging', `set-${set}`, 'manifest')
      if (targetRepository !== repositoryRoot) {
        await cp(repositoryRoot, targetRepository, { recursive: true, preserveTimestamps: true })
      }
      if (targetManifest !== manifestDirectory) {
        await mkdir(targetManifest, { recursive: true, mode: 0o700 })
        await cp(manifestDirectory, targetManifest, { recursive: true, preserveTimestamps: true })
      }
      const targetPublications = join(customerBackupRoot, 'publications')
      if (targetPublications !== publicationDirectory) {
        await cp(publicationDirectory, targetPublications, { recursive: true, preserveTimestamps: true })
      }
      if (customerPasswordFile && customerPasswordFile !== localPassword) {
        await copyFile(localPassword, customerPasswordFile)
        await chmod(customerPasswordFile, 0o600)
      }
      const countFiles = async (directory: string): Promise<number> => {
        let count = 0
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isDirectory()) count += await countFiles(join(directory, entry.name))
          else if (entry.isFile()) count++
        }
        return count
      }
      console.info(JSON.stringify({ operation: 'customer-restore-fixture-export', backupSetId: set,
        sourceSnapshotId: staged.sourceSnapshotId, manifestSnapshotId: published.snapshotId,
        releaseId, repositoryFiles: await countFiles(repositoryRoot), manifestSha256: sha(await readFile(join(targetManifest, 'manifest.json'))),
      }))
    }
  }, 360_000)
})
