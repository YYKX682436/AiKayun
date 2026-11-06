import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { Pool } from 'pg'
import { CompactSign, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose'
import type { Database } from '../src/db/types.js'
import { AppMigrationProvider } from '../src/db/migration-provider.js'
import { initializeInstallationIdentity } from '../src/licensing/installation-identity.js'
import { initializeTemporaryLicensePendingKey, loadLicensePendingKey } from '../src/licensing/pending-encryption-key.js'
import { readConfig } from '../src/config.js'
import { readBackupDatabaseMetadata } from '../src/backup/database-metadata.js'
import { verifyBackupIdentityPair } from '../src/backup/identity-pair.js'
import { readBackupKeyReferences } from '../src/backup/key-references.js'
import { readBackupPendingSummary } from '../src/backup/pending-summary.js'
import { verifyPostgresDumpBinding, type PostgresDumpTarget } from '../src/backup/pg-dump.js'
import { createFixtureCaptureOperations } from '../src/backup/capture-operations.js'
import { captureUnpublishedSet } from '../src/backup/capture-set.js'
import { createMaintenanceJournal, advanceMaintenanceJournal } from '../src/backup/journal.js'
import { publishCapturedSet, verifyPublishedSnapshot } from '../src/backup/publish-set.js'
import { TrustBundleStore } from '../src/licensing/trust/trust-bundle-store.js'
import { createTrustDatabaseCoordinator } from '../src/licensing/trust/trust-database-coordinator.js'
import type { TrustedOfflineRootPin } from '../src/licensing/trust/trust-bundle.js'
import { inspectCustomerBackup } from '../src/backup/customer-inspection.js'
import { LocalResticRepository } from '../src/backup/restic-local.js'

const url = process.env.TEST_DATABASE_URL
const container = process.env.AIKAYUN_TEST_PG_DUMP_CONTAINER
const restic = process.env.AIKAYUN_TEST_RESTIC
const dumpUser = process.env.AIKAYUN_TEST_PG_DUMP_USER ?? 'fixture'
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const noop = async () => {}

describe.skipIf(!url || !container || !restic)('real isolated PostgreSQL, state identity and restic set', () => {
  let root: string
  let db: Kysely<Database>
  let stage: string, scratch: string, journal: string, publication: string, state: string, deployment: string, repo: string, password: string
  let target: PostgresDumpTarget
  let tar: string
  let binary: string, socket: string, fixture: string
  let trustRoot: TrustedOfflineRootPin
  let trustBundle: { status: 'accepted'; bundleVersion: string; artifactSha256: string; stateDigest: string;
    revokedKeyCount: number; retiredKeyCount: number }
  const trustIssuer = 'https://license.example.test'
  const createdVolumes: string[] = []
  const image = 'docker.io/library/postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
  const docker = (...args: string[]) => execFileSync(binary, ['--host', `unix://${socket}`, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('isolated test database required')
    root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-75a-real-set-')))
    stage = join(root, 'stage'); scratch = join(root, 'scratch'); journal = join(root, 'journal'); publication = join(root, 'publication')
    state = join(root, 'state'); deployment = join(root, 'deployment'); repo = join(root, 'repo'); password = join(root, 'password')
    for (const path of [stage, scratch, journal, publication, state, deployment, repo]) await mkdir(path, { mode: 0o700 })
    await mkdir(join(state, 'identity'), { mode: 0o700 }); await mkdir(join(state, 'license-pending'), { mode: 0o700 })
    await mkdir(join(state, 'license-trust'), { mode: 0o700 })
    await mkdir(join(deployment, 'secrets'), { mode: 0o700 })
    await writeFile(password, 'isolated-random-repository-password', { mode: 0o600 })
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }) })
    const migration = await new Migrator({ db, provider: new AppMigrationProvider() }).migrateToLatest()
    if (migration.error) throw migration.error
    const pool = new Pool({ connectionString: url })
    try { await initializeInstallationIdentity(pool, { identityRoot: join(state, 'identity'), mode: 'fresh' }) } finally { await pool.end() }
    await initializeTemporaryLicensePendingKey(join(state, 'license-pending'), 'test')
    const key = await loadLicensePendingKey(join(state, 'license-pending'))
    const pendingSha = sha(key.key)
    key.key.fill(0)
    await sql`UPDATE installation_binding SET pending_key_id = ${key.keyId}, pending_key_sha256 = ${pendingSha} WHERE singleton`.execute(db)
    const trustPair = await generateKeyPair('Ed25519', { extractable: true })
    const trustJwk = await exportJWK(trustPair.publicKey)
    if (!trustJwk.x) throw new Error('test Trust Store root key unavailable')
    const publicJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: trustJwk.x }
    trustRoot = { kid: await calculateJwkThumbprint(publicJwk, 'sha256'), publicJwk }
    const centerPair = await generateKeyPair('Ed25519', { extractable: true })
    const centerJwk = await exportJWK(centerPair.publicKey)
    if (!centerJwk.x) throw new Error('test Trust Store signing key unavailable')
    const centerPublicJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: centerJwk.x }
    const centerKid = await calculateJwkThumbprint(centerPublicJwk, 'sha256')
    const trustedTime = 2_000_000_000
    const token = await new CompactSign(Buffer.from(JSON.stringify({
      iss: 'urn:aikayun:license:offline-release-root:v1', aud: 'aikayun-license-signing-keys', sub: trustIssuer,
      bundle_schema: 1, bundle_version: '1', iat: trustedTime - 60, nbf: trustedTime - 30,
      exp: trustedTime + 30 * 24 * 60 * 60, propagation_budget_seconds: 24 * 60 * 60,
      keys: [{ kid: centerKid, alg: 'Ed25519', ...centerPublicJwk, not_before: trustedTime - 10_000,
        retire_after: null, verify_until: null, revoked_at: null }],
    }))).setProtectedHeader({ alg: 'Ed25519', kid: trustRoot.kid, typ: 'aikayun-license-trust-bundle+jwt' }).sign(trustPair.privateKey)
    const localTrustStore = new TrustBundleStore({ directory: join(state, 'license-trust'), trustedRoot: trustRoot,
      expectedCenterIssuer: trustIssuer, minimumBundleVersion: '1' })
    await localTrustStore.accept(token, trustedTime)
    const coordinator = createTrustDatabaseCoordinator({ db, identityRoot: join(state, 'identity') })
    const boundTrustStore = localTrustStore.withCoordinator(coordinator)
    await boundTrustStore.initializeDatabaseHead(trustedTime)
    const trustInspection = await boundTrustStore.inspectAcceptedReadOnly()
    if (trustInspection.status !== 'accepted') throw new Error('test Trust Store head was not accepted')
    trustBundle = trustInspection
    binary = await realpath(process.env.AIKAYUN_TEST_DOCKER_BINARY!)
    socket = await realpath(process.env.AIKAYUN_TEST_DOCKER_SOCKET!)
    fixture = `aikayun-75a-test-${randomBytes(12).toString('hex')}`
    for (const suffix of ['aikayun_state', 'caddy_data', 'caddy_config']) {
      const name = `${fixture}_${suffix}`
      docker('volume', 'create', '--label', `com.aikayun.fixture=${fixture}`, name)
      createdVolumes.push(name)
    }
    const sourceArchive = execFileSync(tar || '/usr/bin/tar', ['-cf', '-', '-C', state, '.'])
    execFileSync(binary, ['--host', `unix://${socket}`, 'run', '-i', '--rm', '--network', 'none', '--pull=never',
      '--mount', `type=volume,source=${fixture}_aikayun_state,target=/snapshot`, '--entrypoint', 'sh', image, '-c',
      'tar -xpf - -C /snapshot && chown -R 1000:1000 /snapshot && mkdir -m 700 /snapshot/media /snapshot/private-files && mkdir -m 700 -p /snapshot/license-trust && chown 1000:1000 /snapshot/media /snapshot/private-files /snapshot/license-trust && printf aikayun-state-volume-v1 > /snapshot/.aikayun-volume-v1 && chmod 400 /snapshot/.aikayun-volume-v1 && mkdir -m 700 /snapshot/root-owned && printf root-only > /snapshot/root-owned/value && chmod 600 /snapshot/root-owned/value'], { input: sourceArchive, stdio: ['pipe', 'pipe', 'pipe'] })
    tar = await realpath('/usr/bin/tar')
    target = { dockerBinary: binary, dockerSocket: socket, containerId: container!, database: new URL(url!).pathname.slice(1),
      user: dumpUser, stagingDirectory: stage, assertSecureStaging: noop, timeoutMs: 30000 }
  }, 120_000)
  afterAll(async () => {
    if (db) await db.destroy()
    if (binary && socket) for (const name of createdVolumes) docker('volume', 'rm', name)
    if (root) await rm(root, { recursive: true, force: true })
  })
  it('captures, binds, encrypts and independently rechecks a real database and paired key files', async () => {
    const names = Object.keys(await new AppMigrationProvider().getMigrations()).sort()
    // Synthetic checksum manifest exercises the parser, not a signed release.
    const checksums = Buffer.from(JSON.stringify({ schema: 1, migration_head: names.at(-1), migrations: names.map(name => ({ name, sha256: 'a'.repeat(64) })) }))
    const database = await readBackupDatabaseMetadata(db, { engine_major: 18, migration_head: names.at(-1)!, migration_checksums_sha256: sha(checksums) }, checksums, checksums)
    const identity = await verifyBackupIdentityPair(db, join(state, 'identity'), join(state, 'license-pending'), database)
    for (const name of ['payment_credential_key_ring', 'code_pool_encryption_key_ring']) {
      await writeFile(join(deployment, 'secrets', name), JSON.stringify({ activeKeyId: 'current', keys: { current: randomBytes(32).toString('base64') } }), { mode: 0o600 })
    }
    const config = readConfig({ NODE_ENV: 'test', PAYMENT_CREDENTIAL_KEY_RING_FILE: join(deployment, 'secrets', 'payment_credential_key_ring'),
      CODE_POOL_ENCRYPTION_KEY_RING_FILE: join(deployment, 'secrets', 'code_pool_encryption_key_ring') })
    const keys = await readBackupKeyReferences(db, config.paymentCredentialKeyRing, config.codePoolEncryptionKeyRing)
    const unresolved = await readBackupPendingSummary(db)
    const before = (await sql`SELECT row_to_json(binding) AS value FROM installation_binding binding`.execute(db)).rows
    const evidence = { database, identityFileSha256: identity.identityFileSha256, keys, unresolved, trustBundle }
    // Synthetic release/control files exercise the real deployment archiver;
    // their callbacks are fixtures and do not authenticate a production release.
    const releasePath = join(deployment, 'release')
    await mkdir(releasePath, { mode: 0o700 })
    const artifactNames = ['compose.yaml', 'install.sh', 'migration-checksums.json', 'license-trust-bundle.jws',
      'release-index.json', 'release-signing-root.jwk.json', 'release-verifier.mjs', 'verify-artifacts.mjs']
    const artifacts = []
    for (const name of artifactNames) {
      const content = Buffer.from(`fixture-${name}`)
      await writeFile(join(releasePath, name), content, { mode: 0o600 })
      artifacts.push({ name, size: content.length, sha256: sha(content) })
    }
    const releaseManifest = Buffer.from(JSON.stringify({ artifacts }))
    await writeFile(join(releasePath, 'release-manifest.json'), releaseManifest, { mode: 0o600 })
    for (const name of ['release-manifest.jws', 'release-manifest.cosign.bundle']) await writeFile(join(releasePath, name), 'fixture', { mode: 0o600 })
    for (const name of ['api_database_password', 'migrator_database_password', 'postgres_admin_password']) await writeFile(join(deployment, 'secrets', name), 'fixture', { mode: 0o600 })
    await writeFile(join(deployment, '.env'), 'fixture', { mode: 0o600 })
    await writeFile(join(deployment, '.install-owner'), 'aikayun-install-v1\n', { mode: 0o600 })
    await writeFile(join(deployment, 'install-state.json'), JSON.stringify({ manifest_sha256: sha(releaseManifest) }), { mode: 0o600 })
    await writeFile(join(deployment, 'aikayun'), 'fixture-install.sh', { mode: 0o755 })
    const operations = createFixtureCaptureOperations({ db, stagingDirectory: stage, tarBinary: tar, dump: target,
      volumes: { dockerBinary: binary, dockerSocket: socket, postgresImage: image }, deployment: { deploymentRoot: deployment },
      paymentKeys: config.paymentCredentialKeyRing, deliveryKeys: config.codePoolEncryptionKeyRing,
      assertFence: noop, assertSecureStaging: noop,
      inspectTrustStoreReadOnly: async directory => new TrustBundleStore({ directory, trustedRoot: trustRoot,
        expectedCenterIssuer: trustIssuer, minimumBundleVersion: '1',
        coordinator: createTrustDatabaseCoordinator({ db, identityRoot: join(state, 'identity') }) }).inspectAcceptedReadOnly(),
      readAuthenticatedRelease: async () => ({ releaseId: 'fixture-unsigned', images: { api: `sha256:${'a'.repeat(64)}`, web: `sha256:${'b'.repeat(64)}`, postgres: image.slice('docker.io/library/postgres@'.length), caddy: `sha256:${'d'.repeat(64)}` }, backupResticImage: `ghcr.io/yykx682436/aikayun-backup-restic@sha256:${'e'.repeat(64)}`, database: { engine_major: 18, migration_head: names.at(-1)!, migration_checksums_sha256: sha(checksums) },
        signedChecksums: checksums, compiledChecksums: checksums, postgresImage: image }) }, fixture, 1000)
    const set = randomUUID()
    const staged = await captureUnpublishedSet({ backupSetId: set, stagingDirectory: stage, tarBinary: tar,
      createdAt: new Date(Date.now() - 1000).toISOString(), operations })
    expect(staged.evidence).toEqual(evidence)
    expect(execFileSync(tar, ['-xOf', join(stage, 'state.tar'), './root-owned/value'], { encoding: 'utf8' })).toBe('root-only')
    const initial = await createMaintenanceJournal(journal, { deployment: 'b'.repeat(64), backupSetId: set,
      services: [], roles: [{ name: 'aikayun_app', canLogin: true }, { name: 'aikayun_migrator', canLogin: false }] })
    const restoring = await advanceMaintenanceJournal(journal, initial, 'restoring')
    await advanceMaintenanceJournal(journal, restoring, 'complete')
    const repository = new LocalResticRepository({ binary: await realpath(restic!), repository: repo, passwordFile: password })
    await repository.initialize()
    const dumpCheck = (directory: string, metadata: typeof database) => verifyPostgresDumpBinding({ ...target, stagingDirectory: directory }, metadata)
    const result = await publishCapturedSet({ staged, stagingDirectory: stage, journalDirectory: journal, publicationDirectory: publication,
      scratchParent: scratch, tarBinary: tar, releaseId: 'fixture-unsigned', images: { api: `sha256:${'a'.repeat(64)}`, web: `sha256:${'b'.repeat(64)}`,
        postgres: `sha256:${'c'.repeat(64)}`, caddy: `sha256:${'d'.repeat(64)}` }, resticVersion: '0.19.1', repository,
      assertLock: noop, assertSecureStorage: noop, assertSafeCleanup: noop, assertRestoredAndRelease: noop, verifyDumpBinding: dumpCheck,
      inspectTrustStoreReadOnly: async directory => new TrustBundleStore({ directory, trustedRoot: trustRoot,
        expectedCenterIssuer: trustIssuer, minimumBundleVersion: '1',
        coordinator: createTrustDatabaseCoordinator({ db, identityRoot: join(state, 'identity') }) }).inspectAcceptedReadOnly() })
    const verified = await verifyPublishedSnapshot({ backupSetId: set, publicationDirectory: publication, scratchParent: scratch, tarBinary: tar,
      repository, maxExtractBytes: 100 * 1024 * 1024, assertSecureStorage: noop, assertSafeCleanup: noop, verifyDumpBinding: dumpCheck,
      inspectTrustStoreReadOnly: async directory => new TrustBundleStore({ directory, trustedRoot: trustRoot,
        expectedCenterIssuer: trustIssuer, minimumBundleVersion: '1' }).inspectPersistedReadOnly() })
    expect(verified.snapshotId).toBe(result.snapshotId)
    expect(verified.manifest.database.id).toBe(database.databaseId)
    expect(verified.manifest.trust_bundle).toMatchObject({ status: 'accepted', bundle_version: '1',
      artifact_sha256: trustBundle.artifactSha256, state_digest: trustBundle.stateDigest })
    const customer = await inspectCustomerBackup({ publicationDirectory: publication, scratchParent: scratch, tarBinary: tar, repository,
      maxExtractBytes: 100 * 1024 * 1024, pgDumpTarget: target, assertSecureStorage: noop, assertSafeCleanup: noop, assertBackupMetadata: noop,
      assertBackupRelease: noop, assertLock: noop,
      inspectTrustStoreReadOnly: async directory => new TrustBundleStore({ directory, trustedRoot: trustRoot,
        expectedCenterIssuer: trustIssuer, minimumBundleVersion: '1' }).inspectPersistedReadOnly() }, set)
    expect(customer).toEqual({ backupSetId: set, status: 'verified', createdAt: staged.createdAt, releaseId: 'fixture-unsigned' })
    expect(JSON.stringify(customer)).not.toContain('key_material_proofs')
    expect((await sql`SELECT row_to_json(binding) AS value FROM installation_binding binding`.execute(db)).rows).toEqual(before)
    expect(await readdir(stage)).toEqual([])
    expect(await readdir(scratch)).toEqual([])
  }, 180_000)
})
