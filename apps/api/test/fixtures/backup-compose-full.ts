// Synthetic release Compose only. Never accepts production project/volumes.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, statfs, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { canonicalPurchaseFormJson } from '@aikayun/contracts'
import type { Database } from '../../src/db/types.js'
import { readConfig } from '../../src/config.js'
import { DockerPgQuiesceAdapter } from '../../src/backup/docker-pg-fence.js'
import { captureUnpublishedSet } from '../../src/backup/capture-set.js'
import { createFixtureCaptureOperations } from '../../src/backup/capture-operations.js'
import { quiesceAndCapture, recoverMaintenance } from '../../src/backup/coordinator.js'
import { readMaintenanceJournal } from '../../src/backup/journal.js'
import { publishCapturedSet, verifyPublishedSnapshot } from '../../src/backup/publish-set.js'
import { capturePostgresDump, verifyPostgresDumpBinding } from '../../src/backup/pg-dump.js'
import { UnsafeMaintenanceRecoveryError } from '../../src/backup/maintenance-errors.js'
import { LocalResticRepository } from '../../src/backup/restic-local.js'
import { readBackupDatabaseMetadata } from '../../src/backup/database-metadata.js'
import { inspectCustomerBackup, listCustomerBackups } from '../../src/backup/customer-inspection.js'
import { initializeEmptyRepository } from '../../src/backup/repository-initialization.js'
import { assertNoUncertainBackupState } from '../../src/backup/fixed-create-gate.js'
import { recoverValidatedMaintenance } from '../../src/backup/maintenance-recovery.js'
import { assertNoSwapTmpfs } from '../../src/backup/tmpfs-staging.js'

const exec = promisify(execFile)
const project = process.env.AIKAYUN_FIXTURE_PROJECT ?? '', fixtureWork = process.env.AIKAYUN_FIXTURE_WORK ?? ''
const postgresId = process.env.AIKAYUN_FIXTURE_DATABASE_CONTAINER_ID ?? '', apiImage = process.env.AIKAYUN_FIXTURE_API_IMAGE ?? ''
const webImage = process.env.AIKAYUN_FIXTURE_WEB_IMAGE ?? '', resticInput = process.env.AIKAYUN_FIXTURE_RESTIC ?? ''
const insideContainer = process.env.AIKAYUN_FIXTURE_CONTAINER_MODE === '1'
const enospcRoot = process.env.AIKAYUN_FIXTURE_ENOSPC_STAGE ?? ''
const enospcMode = process.env.AIKAYUN_FIXTURE_ENOSPC_MODE ?? ''
const appUid = insideContainer ? Number(process.env.AIKAYUN_FIXTURE_APP_UID) : process.getuid!()
const appGid = insideContainer ? Number(process.env.AIKAYUN_FIXTURE_APP_GID) : process.getgid!()
if ((insideContainer && (process.platform !== 'linux' || process.getuid?.() !== 0 || !Number.isSafeInteger(appUid) || appUid < 1 || !Number.isSafeInteger(appGid) || appGid < 0 || enospcRoot !== '/fixture-stage' || !['stage', 'repository'].includes(enospcMode))) ||
    (!insideContainer && (enospcRoot || enospcMode))) throw new Error('Unsafe fixture execution mode')
const volumes = [process.env.AIKAYUN_FIXTURE_STATE_VOLUME, process.env.AIKAYUN_FIXTURE_CADDY_DATA_VOLUME,
  process.env.AIKAYUN_FIXTURE_CADDY_CONFIG_VOLUME] as const
if (!/^aikayun-75a-test-[a-f0-9]{24}$/.test(project) || !fixtureWork.includes('/aikayun-75a-fixture.') ||
    !/^[a-f0-9]{64}$/.test(postgresId) || !apiImage || !webImage || !resticInput || !process.env.AIKAYUN_FIXTURE_DOCKER_SOCKET ||
    volumes.join(',') !== [`${project}_aikayun_state`, `${project}_caddy_data`, `${project}_caddy_config`].join(',')) throw new Error('Unsafe fixture identity')
process.env.NODE_ENV = 'test'
const work = await realpath(fixtureWork), socket = await realpath(process.env.AIKAYUN_FIXTURE_DOCKER_SOCKET)
const binary = join(work, 'docker-client')
const original = await realpath((await exec('which', ['docker'])).stdout.trim())
await copyFile(original, binary); await chmod(binary, 0o700)
const restic = await realpath(resticInput)
const resticSha = process.env.AIKAYUN_FIXTURE_RESTIC_SHA256
if (!resticSha || !/^[a-f0-9]{64}$/.test(resticSha) || createHash('sha256').update(await readFile(restic)).digest('hex') !== resticSha) throw new Error('Fixture restic digest mismatch')
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function docker(args: string[]) {
  return (await exec(binary, ['--host', `unix://${socket}`, ...args], { env: { PATH: '/usr/bin:/bin', HOME: work, LANG: 'C' }, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim()
}
const relayName = `${project}-full-relay`, relayNetwork = `${project}-full-relay-net`
let db: Kysely<Database> | undefined
try {
  for (const volume of volumes) if (await docker(['volume', 'inspect', '--format', '{{ index .Labels "com.aikayun.fixture" }}', volume!]) !== project) throw new Error('Fixture volume ownership changed')
  const ids = (await docker(['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`])).split(/\s+/)
  const order = ['caddy', 'web', 'api', 'production-install-init', 'migrate', 'db-role-init', 'state-volume-init']
  const managed: { id: string; service: string }[] = []
  for (const id of ids) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid fixture container')
    const service = await docker(['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.service" }}', id])
    if (order.includes(service)) managed.push({ id, service })
  }
  if (['api', 'web', 'caddy'].some(name => managed.filter(item => item.service === name).length !== 1)) throw new Error('Incomplete fixture services')
  managed.sort((a, b) => order.indexOf(a.service) - order.indexOf(b.service) || a.id.localeCompare(b.id))
  let dbHost = 'db', port = '5432'
  if (!insideContainer) {
    await docker(['network', 'create', '--label', `com.aikayun.fixture=${project}`, relayNetwork])
    await docker(['run', '-d', '--label', `com.aikayun.fixture=${project}`, '--name', relayName, '--network', relayNetwork, '-p', '127.0.0.1::5432', '--entrypoint', '/nodejs/bin/node', apiImage,
      '-e', "const n=require('node:net');n.createServer(s=>{const u=n.connect(5432,'db');s.pipe(u);u.pipe(s);s.on('error',()=>u.destroy());u.on('error',()=>s.destroy())}).listen(5432,'0.0.0.0')"])
    await docker(['network', 'connect', `${project}_private`, relayName])
    const mapped = /^127\.0\.0\.1:(\d{1,5})$/.exec(await docker(['port', relayName, '5432']))?.[1]
    if (!mapped) throw new Error('Fixture relay not loopback-only')
    dbHost = '127.0.0.1'; port = mapped
  }
  const password = (await readFile(join(work, 'postgres'), 'utf8')).trim()
  const pool = new Pool({ host: dbHost, port: Number(port), user: 'aikayun_bootstrap', password, database: 'aikayun', max: 1 })
  pool.on('connect', client => client.on('error', () => {})); pool.on('error', () => {})
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  const fingerprint = 'a'.repeat(64)
  const host = { assertOwnedLock: async () => {}, verifyDeployment: async (value: string) => { if (value !== fingerprint) throw new Error('Fixture proof failed') } }
  let adapter = new DockerPgQuiesceAdapter({ dockerBinary: binary, dockerSocket: socket, dockerHome: work, project, deployment: fingerprint,
    stateVolumes: volumes as [string, string, string], managed, db, host })
  for (const item of managed) {
    try { await adapter.containerState(item.id) } catch { throw new Error(`Fixture mount check failed for ${item.service}`) }
  }
  await adapter.assertDeployment(fingerprint)
  const services = []
  for (const item of managed) {
    const state = await adapter.containerState(item.id)
    if (state === 'unknown') throw new Error('Fixture service state unknown')
    services.push({ name: item.service, containerId: item.id, running: state === 'running' })
  }
  const app = await adapter.roleLogin('aikayun_app'), migrator = await adapter.roleLogin('aikayun_migrator')
  if (app === null || migrator === null) throw new Error('Fixture roles unknown')
  const roles = [{ name: 'aikayun_app' as const, canLogin: app }, { name: 'aikayun_migrator' as const, canLogin: migrator }]
  const before = (await sql`SELECT row_to_json(b) AS value FROM installation_binding b`.execute(db)).rows
  const customerId = randomUUID(), orderId = randomUUID(), productId = randomUUID(), variantId = randomUUID(), itemId = randomUUID()
  if (insideContainer) {
    const sku = `SKU-${variantId.slice(0, 8)}`, productName = `Fixture ${productId.slice(0, 8)}`
    await db.transaction().execute(async trx => {
      await trx.insertInto('customers').values({ id: customerId, username: `fixture-${customerId}`, password_hash: 'fixture-password-hash',
        email: null, email_verified_at: null, phone: null, phone_verified_at: null }).execute()
      await trx.insertInto('products').values({ id: productId, name: productName, description: 'Isolated backup fixture', product_type: 'digital', status: 'active' }).execute()
      await trx.insertInto('product_variants').values({ id: variantId, product_id: productId, sku_code: sku, combination_key: '', sale_price: '10.00',
        compare_at_price: null, cost_price: null, enabled: true, retired_at: null, inventory_mode: null, inventory_revision: 0 }).execute()
      await trx.updateTable('product_variants').set({ inventory_mode: 'unlimited', inventory_revision: 1 }).where('id', '=', variantId).execute()
      await trx.insertInto('product_variant_fulfillment').values({ product_variant_id: variantId, method: 'manual', manual_delivery_ready: true }).execute()
      await trx.insertInto('orders').values({ id: orderId, customer_id: customerId, guest_order_session_id: null, idempotency_key: randomUUID(),
        request_sha256: 'a'.repeat(64), total_amount: '10.00', unpaid_expires_at: new Date(Date.now() + 86_400_000),
        history_hidden_at: null, history_hidden_by_admin_id: null, history_hidden_reason: null }).execute()
      await trx.insertInto('order_items').values({ id: itemId, order_id: orderId, purchase_line_id: randomUUID(), product_id: productId, product_variant_id: variantId,
        product_name_snapshot: productName, product_type_snapshot: 'digital', sku_code_snapshot: sku, sku_snapshot: JSON.stringify([]),
        inventory_mode_snapshot: 'unlimited', fulfillment_method_snapshot: 'manual', unit_price: '10.00', quantity: 1, line_amount: '10.00' }).execute()
      // Same no-form snapshot as the existing SQL fixture, kept dependency-light
      // so the isolated Linux helper does not need the unrelated image stack.
      await trx.insertInto('order_item_purchase_snapshots').values({ order_item_id: itemId,
        template_version_id: null, normalization_version: null,
        content_identity: createHash('sha256').update(canonicalPurchaseFormJson({
          skuId: variantId.toLowerCase(), templateVersionId: null, normalizationVersion: null, values: null,
        }), 'utf8').digest('hex'), encrypted_values: null, values_nonce: null, values_auth_tag: null,
        encryption_key_id: null, attachment_ids: [] }).execute()
      await trx.updateTable('orders').set({ items_sealed: true }).where('id', '=', orderId).execute()
    })
  }
  const businessState = async () => (await sql`SELECT c.status AS customer_status, w.cash_available::text, w.cash_frozen::text,
    w.gift_available::text, w.gift_frozen::text, o.status AS order_status, o.total_amount::text, o.items_sealed
    FROM customers c JOIN wallet_accounts w ON w.customer_id = c.id JOIN orders o ON o.customer_id = c.id
    WHERE c.id = ${customerId}::uuid AND o.id = ${orderId}::uuid`.execute(db!)).rows
  const beforeBusiness = insideContainer ? await businessState() : []
  if (insideContainer && beforeBusiness.length !== 1) throw new Error('Fixture business state missing')
  if (insideContainer) await assertNoSwapTmpfs(enospcRoot, 1n)
  const stage = await mkdtemp(join(insideContainer && enospcMode === 'stage' ? enospcRoot : work, 'stage-')), scratch = await mkdtemp(join(work, 'scratch-'))
  const journal = await mkdtemp(join(work, 'journal-')), pub = await mkdtemp(join(work, 'pub-')), repoDir = await mkdtemp(join(insideContainer && enospcMode === 'repository' ? enospcRoot : work, 'repo-'))
  const deployment = await mkdtemp(join(work, 'deploy-')), secretDir = join(deployment, 'secrets'), releaseDir = join(deployment, 'release')
  await mkdir(secretDir, { mode: 0o700 }); await mkdir(releaseDir, { mode: 0o700 })
  for (const [target, src] of [['api_database_password', 'api'], ['migrator_database_password', 'migrator'], ['postgres_admin_password', 'postgres'],
    ['payment_credential_key_ring', 'payment'], ['code_pool_encryption_key_ring', 'delivery']]) {
    await copyFile(join(work, src!), join(secretDir, target!)); await chmod(join(secretDir, target!), 0o600)
  }
  const names = ['compose.yaml', 'install.sh', 'migration-checksums.json', 'license-trust-bundle.jws', 'release-index.json',
    'release-signing-root.jwk.json', 'release-verifier.mjs', 'verify-artifacts.mjs']
  const entries = []
  for (const name of names) { const content = Buffer.from(`fixture-${name}`); await writeFile(join(releaseDir, name), content, { mode: 0o600 }); entries.push({ name, size: content.length, sha256: sha(content) }) }
  const releaseManifest = Buffer.from(JSON.stringify({ artifacts: entries }))
  await writeFile(join(releaseDir, 'release-manifest.json'), releaseManifest, { mode: 0o600 })
  for (const name of ['release-manifest.jws', 'release-manifest.cosign.bundle']) await writeFile(join(releaseDir, name), 'synthetic', { mode: 0o600 })
  await writeFile(join(deployment, '.env'), 'fixture', { mode: 0o600 })
  await writeFile(join(deployment, '.install-owner'), 'aikayun-install-v1\n', { mode: 0o600 })
  await writeFile(join(deployment, 'install-state.json'), JSON.stringify({ manifest_sha256: sha(releaseManifest) }), { mode: 0o600 })
  await writeFile(join(deployment, 'aikayun'), 'fixture-install.sh', { mode: 0o755 })
  await chmod(join(deployment, 'aikayun'), 0o755)
  const checksumFile = join(work, 'fixture-checksums')
  await docker(['cp', `${managed.find(item => item.service === 'api')!.id}:/app/dist/db/migration-checksums.json`, checksumFile])
  const checksums = await readFile(checksumFile)
  const checksumData = JSON.parse(checksums.toString('utf8')) as { migration_head: string }
  const config = readConfig({ NODE_ENV: 'test', PAYMENT_CREDENTIAL_KEY_RING_FILE: join(secretDir, 'payment_credential_key_ring'), CODE_POOL_ENCRYPTION_KEY_RING_FILE: join(secretDir, 'code_pool_encryption_key_ring') })
  const postgresImage = 'docker.io/library/postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
  const images = { api: await docker(['image', 'inspect', apiImage, '--format', '{{.Id}}']), web: await docker(['image', 'inspect', webImage, '--format', '{{.Id}}']),
    postgres: await docker(['image', 'inspect', postgresImage, '--format', '{{.Id}}']), caddy: await docker(['image', 'inspect', 'docker.io/library/caddy@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5', '--format', '{{.Id}}']) }
  const tar = await realpath('/usr/bin/tar'), passwordFile = join(work, 'restic-password')
  await writeFile(passwordFile, 'isolated-restic-password', { mode: 0o600 })
  const repository = new LocalResticRepository({ binary: restic, repository: repoDir, passwordFile })
  await initializeEmptyRepository({ repositoryDirectory: repoDir, journalDirectory: journal, publicationDirectory: pub, mountRoot: stage, repository, assertLock: host.assertOwnedLock })
  const target = { dockerBinary: binary, dockerSocket: socket, containerId: postgresId, database: 'aikayun', user: 'aikayun_bootstrap', stagingDirectory: stage, assertSecureStaging: async () => {} }
  function operations(stagingDirectory: string) {
    return createFixtureCaptureOperations({ db: db!, stagingDirectory, tarBinary: tar, dump: target,
      volumes: { dockerBinary: binary, dockerSocket: socket, postgresImage }, deployment: { deploymentRoot: deployment },
      paymentKeys: config.paymentCredentialKeyRing, deliveryKeys: config.codePoolEncryptionKeyRing, assertFence: () => adapter.assertNoWriters(),
      assertSecureStaging: async () => { if (insideContainer && enospcMode === 'stage') await assertNoSwapTmpfs(enospcRoot, 0n) }, readAuthenticatedRelease: async () => ({ releaseId: 'fixture', images, postgresImage,
        database: { engine_major: 18, migration_head: checksumData.migration_head, migration_checksums_sha256: sha(checksums) }, signedChecksums: checksums, compiledChecksums: checksums }) }, project, appUid, appGid)
  }
  const snapshot = () => ({ deployment: fingerprint, backupSetId: randomUUID(), services, roles })
  const started = new Date(Date.now() - 1000).toISOString(), first = snapshot()
  if (insideContainer && enospcMode === 'stage') {
    // Fill only the random helper's dedicated noswap tmpfs. Verify an actual
    // kernel ENOSPC, then run the existing real Compose/PG capture chain.
    const fs = await statfs(enospcRoot, { bigint: true }), available = fs.bavail * fs.bsize
    if (available < 131072n || available > 16n * 1024n * 1024n) throw new Error('Unexpected fixture tmpfs size')
    await writeFile(join(enospcRoot, 'filler'), Buffer.alloc(Number(available - 65536n)), { mode: 0o600 })
    let full = false
    try { await writeFile(join(enospcRoot, 'probe'), Buffer.alloc(1024 * 1024), { mode: 0o600 }) }
    catch (error) { full = (error as NodeJS.ErrnoException).code === 'ENOSPC' }
    finally { await unlink(join(enospcRoot, 'probe')).catch(() => {}) }
    if (!full) throw new Error('Fixture did not reach kernel ENOSPC')
    let failureCode = '', published = false
    try {
      await quiesceAndCapture(journal, first, adapter,
        () => captureUnpublishedSet({ backupSetId: first.backupSetId, stagingDirectory: stage, tarBinary: tar, createdAt: started, operations: operations(stage) }),
        async () => { published = true })
    } catch (error) { failureCode = error instanceof Error ? error.message : '' }
    if (!['ARCHIVE_COMMAND_FAILED', 'DUMP_COMMAND_FAILED', 'DUMP_CLEANUP_UNVERIFIED', 'SET_CLEANUP_UNVERIFIED', 'SET_FENCE_UNVERIFIED'].includes(failureCode) || published || (await readdir(pub)).includes(`${first.backupSetId}.json`)) throw new Error('ENOSPC capture was published')
    const record = await readMaintenanceJournal(journal)
    if (!record || !['stopped', 'complete'].includes(record.phase)) throw new Error('ENOSPC maintenance state uncertain')
    await unlink(join(enospcRoot, 'filler'))
    if (record.phase === 'stopped') {
      await adapter.assertNoWriters()
      await recoverValidatedMaintenance({ journalDirectory: journal, deployment: fingerprint, managed, adapter,
        assertNoBackupHelpers: async () => {
          const active = await sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name LIKE 'aikayun_backup_%' AND pid <> pg_backend_pid()`.execute(db!)
          if (active.rows[0]?.count !== '0') throw new Error('Fixture dump remains active')
          for (const volume of volumes) if (await docker(['ps', '-aq', '--no-trunc', '--filter', `volume=${volume}`, '--filter', 'label=com.aikayun.backup.archive'])) throw new Error('Fixture archive helper remains')
        } })
    }
    for (const service of services) if (await adapter.containerState(service.containerId) !== (service.running ? 'running' : 'stopped')) throw new Error('ENOSPC service restoration failed')
    if (JSON.stringify((await sql`SELECT row_to_json(b) AS value FROM installation_binding b`.execute(db)).rows) !== JSON.stringify(before) ||
        JSON.stringify(await businessState()) !== JSON.stringify(beforeBusiness)) throw new Error('ENOSPC changed fixture business data')
    console.log(`Real Linux noswap tmpfs ENOSPC during isolated Compose/PG capture (${failureCode}): no publication; original services and DB preserved`)
  } else {
  const killMode = process.env.AIKAYUN_FIXTURE_KILL_MODE
  if (killMode && !['stopped', 'dump', 'upload'].includes(killMode)) throw new Error('Invalid fault mode')
  if (killMode && typeof process.send !== 'function') throw new Error('Fault fixture requires isolated supervisor')
  if (killMode) {
    process.send!({ phase: 'prepared', journal, pub, stage, scratch, repoDir, passwordFile, port, first, before, managed, relayName, relayNetwork })
    await new Promise<void>(resolve => process.once('message', () => resolve()))
  }
  const result = await quiesceAndCapture(journal, first, adapter,
    async () => {
      if (killMode === 'stopped' || killMode === 'dump') {
        process.send!({ phase: 'stopped' })
        if (killMode === 'stopped') await new Promise(() => {})
        await new Promise<void>(resolve => process.once('message', () => resolve()))
        await capturePostgresDump(target)
        throw new Error('Expected supervisor to kill blocked dump')
      }
      return captureUnpublishedSet({ backupSetId: first.backupSetId, stagingDirectory: stage, tarBinary: tar, createdAt: started, operations: operations(stage) })
    },
    staged => {
      if (killMode === 'upload') process.send!({ phase: 'upload' })
      return publishCapturedSet({ staged, stagingDirectory: stage, journalDirectory: journal, publicationDirectory: pub, scratchParent: scratch,
      tarBinary: tar, releaseId: 'fixture', images, resticVersion: '0.19.1', repository, assertLock: host.assertOwnedLock,
      assertSecureStorage: async () => {}, assertSafeCleanup: async () => {}, assertRestoredAndRelease: async record => { if (record.phase !== 'complete') throw new Error('not restored') },
      verifyDumpBinding: (directory, metadata) => verifyPostgresDumpBinding({ ...target, stagingDirectory: directory }, metadata) })
    })
  const verified = await verifyPublishedSnapshot({ backupSetId: first.backupSetId, publicationDirectory: pub, scratchParent: scratch, tarBinary: tar,
    repository, maxExtractBytes: 200 * 1024 * 1024, assertSecureStorage: async () => {}, assertSafeCleanup: async () => {},
    verifyDumpBinding: (directory, metadata) => verifyPostgresDumpBinding({ ...target, stagingDirectory: directory }, metadata) })
  if (result.snapshotId !== verified.snapshotId || verified.status !== 'verified') throw new Error('Fixture publication failed')
  const current = await readBackupDatabaseMetadata(db, { engine_major: 18, migration_head: checksumData.migration_head, migration_checksums_sha256: sha(checksums) }, checksums, checksums)
  const inspection = { publicationDirectory: pub, scratchParent: scratch, tarBinary: tar, repository, maxExtractBytes: 200 * 1024 * 1024,
    pgDumpTarget: { ...target, assertSecureStaging: async () => {} }, assertSecureStorage: async () => {}, assertSafeCleanup: host.assertOwnedLock,
    assertLock: host.assertOwnedLock, assertBackupRelease: async (releaseId: string, savedImages: typeof images) => {
      if (releaseId !== 'fixture' || JSON.stringify(savedImages) !== JSON.stringify(images)) throw new Error('Fixture release mismatch')
    }, assertBackupMetadata: async (saved: typeof current) => {
      if (saved.databaseId !== current.databaseId || saved.instanceId !== current.instanceId || saved.identityJkt !== current.identityJkt ||
          saved.migrationHead !== current.migrationHead || saved.migrationChecksumsSha256 !== current.migrationChecksumsSha256) throw new Error('Fixture binding mismatch')
    } }
  const page = await listCustomerBackups(inspection, { limit: 10 })
  const inspected = await inspectCustomerBackup(inspection, first.backupSetId)
  if (page.items.length !== 1 || page.items[0]?.status !== 'not_checked' || inspected.status !== 'verified' ||
      JSON.stringify([page, inspected]).includes('key_material_proofs')) throw new Error('Fixture read-only inspection failed')
  for (const service of services) if (await adapter.containerState(service.containerId) !== (service.running ? 'running' : 'stopped')) throw new Error('Fixture service not restored')
  if (JSON.stringify((await sql`SELECT row_to_json(b) AS value FROM installation_binding b`.execute(db)).rows) !== JSON.stringify(before)) throw new Error('Fixture DB binding changed')
  if (insideContainer && enospcMode === 'repository') {
    const firstMarker = await readFile(join(pub, `${first.backupSetId}.json`))
    const fs = await statfs(enospcRoot, { bigint: true }), available = fs.bavail * fs.bsize
    if (available < 131072n || available > 32n * 1024n * 1024n) throw new Error('Unexpected fixture repository space')
    await writeFile(join(enospcRoot, 'filler'), Buffer.alloc(Number(available - 65536n)), { mode: 0o600 })
    let full = false
    try { await writeFile(join(enospcRoot, 'probe'), Buffer.alloc(1024 * 1024), { mode: 0o600 }) }
    catch (error) { full = (error as NodeJS.ErrnoException).code === 'ENOSPC' }
    finally { await unlink(join(enospcRoot, 'probe')).catch(() => {}) }
    if (!full) throw new Error('Fixture repository did not reach kernel ENOSPC')
    const failedStage = await mkdtemp(join(work, 'repository-full-stage-')), failedSet = snapshot()
    let rejected = false
    try {
      await quiesceAndCapture(journal, failedSet, adapter,
        () => captureUnpublishedSet({ backupSetId: failedSet.backupSetId, stagingDirectory: failedStage, tarBinary: tar,
          createdAt: new Date(Date.now() - 1000).toISOString(), operations: operations(failedStage) }),
        staged => publishCapturedSet({ staged, stagingDirectory: failedStage, journalDirectory: journal, publicationDirectory: pub, scratchParent: scratch,
          tarBinary: tar, releaseId: 'fixture', images, resticVersion: '0.19.1', repository, assertLock: host.assertOwnedLock,
          assertSecureStorage: async () => {}, assertSafeCleanup: async () => {}, assertRestoredAndRelease: async record => { if (record.phase !== 'complete') throw new Error('not restored') },
          verifyDumpBinding: (directory, metadata) => verifyPostgresDumpBinding({ ...target, stagingDirectory: directory }, metadata) }))
    } catch (error) { rejected = error instanceof Error && error.message === 'BACKUP_PUBLICATION_INCOMPLETE_OR_UNKNOWN' }
    if (!rejected || (await readMaintenanceJournal(journal))?.phase !== 'complete' ||
        JSON.parse(await readFile(join(pub, `${failedSet.backupSetId}.json`), 'utf8')).state !== 'uploading' ||
        !(await readFile(join(pub, `${first.backupSetId}.json`))).equals(firstMarker)) throw new Error('Full repository outcome was not safely retained')
    await unlink(join(enospcRoot, 'filler'))
    const emptyStage = await mkdtemp(join(work, 'repository-gate-stage-'))
    let blocked = false
    try { await assertNoUncertainBackupState({ repositoryDirectory: repoDir, journalDirectory: journal, publicationDirectory: pub,
      mountRoot: emptyStage, repository, assertLock: host.assertOwnedLock }) }
    catch (error) { blocked = error instanceof Error && error.message === 'BACKUP_PREVIOUS_ATTEMPT_REQUIRES_REVIEW' }
    if (!blocked || (await inspectCustomerBackup(inspection, first.backupSetId)).status !== 'verified') throw new Error('Existing verified snapshot changed or retry not blocked')
    for (const service of services) if (await adapter.containerState(service.containerId) !== (service.running ? 'running' : 'stopped')) throw new Error('Repository ENOSPC changed service state')
    if (JSON.stringify((await sql`SELECT row_to_json(b) AS value FROM installation_binding b`.execute(db)).rows) !== JSON.stringify(before) ||
        JSON.stringify(await businessState()) !== JSON.stringify(beforeBusiness)) throw new Error('Repository ENOSPC changed fixture business data')
    console.log('Real restic repository ENOSPC: unknown publication blocks retry; prior verified snapshot and fixture business state preserved')
  } else {
  // A second distinct set must preserve the first marker and decrypt both.
  const firstMarker = await readFile(join(pub, `${first.backupSetId}.json`))
  const secondStage = await mkdtemp(join(work, 'second-stage-')), successfulSecond = snapshot()
  await assertNoUncertainBackupState({ repositoryDirectory: repoDir, journalDirectory: journal, publicationDirectory: pub, mountRoot: secondStage, repository, assertLock: host.assertOwnedLock })
  const secondResult = await quiesceAndCapture(journal, successfulSecond, adapter,
    () => captureUnpublishedSet({ backupSetId: successfulSecond.backupSetId, stagingDirectory: secondStage, tarBinary: tar,
      createdAt: new Date(Date.now() - 1000).toISOString(), operations: operations(secondStage) }),
    staged => publishCapturedSet({ staged, stagingDirectory: secondStage, journalDirectory: journal, publicationDirectory: pub, scratchParent: scratch,
      tarBinary: tar, releaseId: 'fixture', images, resticVersion: '0.19.1', repository, assertLock: host.assertOwnedLock,
      assertSecureStorage: async () => {}, assertSafeCleanup: async () => {}, assertRestoredAndRelease: async record => { if (record.phase !== 'complete') throw new Error('not restored') },
      verifyDumpBinding: (directory, metadata) => verifyPostgresDumpBinding({ ...target, stagingDirectory: directory }, metadata) }))
  if (successfulSecond.backupSetId === first.backupSetId || secondResult.snapshotId === result.snapshotId ||
      !(await readFile(join(pub, `${first.backupSetId}.json`))).equals(firstMarker)) throw new Error('Successive backup identity changed')
  const pageAfterSecond = await listCustomerBackups(inspection, { limit: 10 })
  const secondInspection = await inspectCustomerBackup(inspection, successfulSecond.backupSetId)
  const firstInspection = await inspectCustomerBackup(inspection, first.backupSetId)
  if (pageAfterSecond.items.length !== 2 || pageAfterSecond.items.some(item => item.status !== 'not_checked') ||
      firstInspection.status !== 'verified' || secondInspection.status !== 'verified') throw new Error('Successive backup verification failed')
  console.log('Two successive real backup sets and original snapshot preservation passed')
  // Missing local fixture release material and a key file each abort capture;
  // originals are synthetic and restored immediately after the injection.
  for (const missing of [join(secretDir, 'payment_credential_key_ring'), join(releaseDir, 'compose.yaml')]) {
    const contents = await readFile(missing), missingStage = await mkdtemp(join(work, 'missing-stage-')), missingSet = snapshot()
    let rejected = false, published = false
    try {
      await quiesceAndCapture(journal, missingSet, adapter, async () => {
        await unlink(missing)
        return captureUnpublishedSet({ backupSetId: missingSet.backupSetId, stagingDirectory: missingStage, tarBinary: tar,
          createdAt: new Date(Date.now() - 1000).toISOString(), operations: operations(missingStage) })
      }, async () => { published = true })
    } catch { rejected = true }
    finally { await writeFile(missing, contents, { mode: 0o600 }) }
    if (!rejected || published || (await readdir(missingStage)).length !== 0 || (await readMaintenanceJournal(journal))?.phase !== 'complete' ||
        (await readdir(pub)).includes(`${missingSet.backupSetId}.json`)) throw new Error('Missing fixture material was not safely rejected')
    for (const service of services) if (await adapter.containerState(service.containerId) !== (service.running ? 'running' : 'stopped')) throw new Error('Missing-material recovery failed')
  }
  console.log('Missing fixture release file and encryption key rejected with service recovery passed')
  // Stop only the verified random Compose database during a real capture,
  // after both state archive and pg_dump have been written.
  const disconnectedStage = await mkdtemp(join(work, 'disconnected-stage-')), disconnectedSet = snapshot()
  const disconnectedOps = operations(disconnectedStage), originalDeployment = disconnectedOps.captureDeployment
  disconnectedOps.captureDeployment = async () => { await docker(['stop', '--time', '1', postgresId]); return originalDeployment() }
  let disconnected = false, disconnectedPublished = false
  try {
    await quiesceAndCapture(journal, disconnectedSet, adapter,
      () => captureUnpublishedSet({ backupSetId: disconnectedSet.backupSetId, stagingDirectory: disconnectedStage, tarBinary: tar,
        createdAt: new Date(Date.now() - 1000).toISOString(), operations: disconnectedOps }),
      async () => { disconnectedPublished = true })
  } catch (error) { disconnected = error instanceof UnsafeMaintenanceRecoveryError && error.code === 'SET_FENCE_UNVERIFIED' }
  const preserved = await readdir(disconnectedStage)
  if (!disconnected || disconnectedPublished || !preserved.includes('state.tar') || !preserved.includes('database.dump') ||
      (await readMaintenanceJournal(journal))?.phase !== 'stopped') throw new Error('Database loss did not preserve the fence and staged evidence')
  for (const service of services) if (await adapter.containerState(service.containerId) !== 'stopped') throw new Error('Service restarted during DB loss')
  await db.destroy(); db = undefined
  const dbProject = await docker(['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', postgresId])
  if (dbProject !== project) throw new Error('Fixture database identity changed')
  await docker(['start', postgresId])
  const replacement = new Pool({ host: dbHost, port: Number(port), user: 'aikayun_bootstrap', password, database: 'aikayun', max: 1 })
  replacement.on('connect', client => client.on('error', () => {})); replacement.on('error', () => {})
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: replacement }) })
  for (let attempt = 0; ; attempt++) {
    try { await sql`SELECT 1`.execute(db); break } catch { if (attempt >= 60) throw new Error('Fixture DB did not return'); await new Promise(resolve => setTimeout(resolve, 500)) }
  }
  adapter = new DockerPgQuiesceAdapter({ dockerBinary: binary, dockerSocket: socket, dockerHome: work, project, deployment: fingerprint,
    stateVolumes: volumes as [string, string, string], managed, db, host })
  if (await adapter.roleLogin('aikayun_app') !== false || await adapter.roleLogin('aikayun_migrator') !== false) throw new Error('Database fence was lost across restart')
  await recoverValidatedMaintenance({ journalDirectory: journal, deployment: fingerprint, managed, adapter,
    assertNoBackupHelpers: async () => {
      const active = await sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name LIKE 'aikayun_backup_%' AND pid <> pg_backend_pid()`.execute(db!)
      if (active.rows[0]?.count !== '0') throw new Error('Fixture dump remains active')
      for (const volume of volumes) if (await docker(['ps', '-aq', '--no-trunc', '--filter', `volume=${volume}`, '--filter', 'label=com.aikayun.backup.archive'])) throw new Error('Fixture archive helper remains')
    } })
  for (const service of services) if (await adapter.containerState(service.containerId) !== (service.running ? 'running' : 'stopped')) throw new Error('DB-loss recovery failed')
  if (JSON.stringify((await sql`SELECT row_to_json(b) AS value FROM installation_binding b`.execute(db)).rows) !== JSON.stringify(before)) throw new Error('DB-loss changed binding')
  console.log('Actual fixture PostgreSQL disconnect retained the fence and evidence; explicit recovery passed')
  // An uncertain capture must keep the actual staged dump and maintenance fence;
  // explicit recovery is performed only after this isolated injection ends.
  const unsafeStage = await mkdtemp(join(work, 'unsafe-stage-')), second = snapshot()
  const unsafeOps = operations(unsafeStage), captureDump = unsafeOps.captureDump
  unsafeOps.captureDump = async () => { await captureDump(); throw new UnsafeMaintenanceRecoveryError('DUMP_CLEANUP_UNVERIFIED') }
  let unsafe = false
  try { await quiesceAndCapture(journal, second, adapter,
    () => captureUnpublishedSet({ backupSetId: second.backupSetId, stagingDirectory: unsafeStage, tarBinary: tar, createdAt: started, operations: unsafeOps }),
    async () => { throw new Error('unsafe snapshot was published') }) }
  catch (error) { unsafe = error instanceof UnsafeMaintenanceRecoveryError && error.code === 'DUMP_CLEANUP_UNVERIFIED' }
  if (!unsafe || !(await readdir(unsafeStage)).includes('database.dump') || (await readMaintenanceJournal(journal))?.phase !== 'stopped') throw new Error('Unknown cleanup did not preserve evidence and fence')
  if (await adapter.roleLogin('aikayun_app') !== false || await adapter.roleLogin('aikayun_migrator') !== false) throw new Error('Unknown cleanup released database fence')
  await recoverMaintenance(journal, adapter)
  for (const service of services) if (await adapter.containerState(service.containerId) !== (service.running ? 'running' : 'stopped')) throw new Error('Fixture explicit recovery failed')
  if (JSON.stringify((await sql`SELECT row_to_json(b) AS value FROM installation_binding b`.execute(db)).rows) !== JSON.stringify(before)) throw new Error('Fixture DB binding changed')
  console.log('Release Compose fixture: real capture, restored services, restic verification, customer listing/inspection, uncertain cleanup and explicit recovery passed')
  }
  }
} finally {
  if (db) await db.destroy()
  await docker(['rm', '-f', '-v', relayName]).catch(() => {})
  const label = await docker(['network', 'inspect', '--format', '{{ index .Labels "com.aikayun.fixture" }}', relayNetwork]).catch(() => '')
  if (label === project) await docker(['network', 'rm', relayNetwork])
}
