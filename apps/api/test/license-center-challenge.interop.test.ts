import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as signEd25519 } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import type { Transaction } from 'kysely'
import { Pool } from 'pg'
import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader } from 'jose'
import { assertChallengeClaimsBound, createLicenseChallengeClient, createSignedChallengeRequest, postChallenge } from '../src/licensing/license-challenge-client.js'
import type { PendingActivationOperation } from '../src/licensing/license-challenge-client.js'
import { createLicenseActivationClient } from '../src/licensing/license-activation-client.js'
import type { LicenseActivationCheckpoint } from '../src/licensing/license-activation-client.js'
import { createLicenseOperationRecoveryClient } from '../src/licensing/license-operation-recovery-client.js'
import { finalizeTrustedActivationRejection } from '../src/licensing/license-operation-recovery-client.js'
import type { LicenseRecoveryCheckpoint } from '../src/licensing/license-operation-recovery-client.js'
import { createSignedLicenseRequest, LICENSE_ACTIVATION_PATH, postSignedLicenseRequest } from '../src/licensing/license-request-http.js'
import type { TestLicenseTlsOptions } from '../src/licensing/license-request-http.js'
import { installationIdentityMigration } from '../src/db/migrations/202610290001_installation_identity.js'
import { localLicenseOperationsMigration } from '../src/db/migrations/202610300001_local_license_operations.js'
import { singleInitialActivationAttemptMigration } from '../src/db/migrations/202610300002_single_initial_activation_attempt.js'
import { licenseOperationResultArchiveMigration } from '../src/db/migrations/202610300003_license_operation_result_archive.js'
import { licenseResultArchivePresenceMigration } from '../src/db/migrations/202610300004_license_result_archive_presence.js'
import { licenseOperationTrustedRejectionMigration } from '../src/db/migrations/202610310001_license_operation_trusted_rejection.js'
import type { Database } from '../src/db/types.js'
import { initializeInstallationIdentity, withVerifiedInstallationSigningContext } from '../src/licensing/installation-identity.js'
import { createOrLoadActivationOperation } from '../src/licensing/license-operation-store.js'
import {
  readLicenseOperationAttemptEnvelope,
  readLicenseOperationAttemptResponse,
  readLicenseOperationAttemptResultJws,
  readLicenseOperationCenterEvidence,
  readSavedLicenseOperationResponse,
} from '../src/licensing/license-operation-store.js'
import { decryptLicensePendingBytes, initializeTemporaryLicensePendingKey } from '../src/licensing/pending-encryption-key.js'
import { validateTrustedReleaseLicenseConfig } from '../src/licensing/trusted-release-config.js'
import { TrustBundleStore } from '../src/licensing/trust/trust-bundle-store.js'
import { verifyTrustBundleSignature } from '../src/licensing/trust/trust-bundle.js'
import { fetchTrustedTimeAnchor } from '../src/licensing/trust/time-anchor-client.js'
import type { LookupFunction } from 'node:net'

const expectedCenterCommit = 'a5cf99439e3bf92b65f19d60c013bca088cf221a'
const testDatabaseUrl = process.env.TEST_DATABASE_URL
const centerCheckout = process.env.LICENSE_CENTER_CHECKOUT
describe.skipIf(!testDatabaseUrl || !centerCheckout)('3C-3A frozen authorization-center HTTPS interop', () => {
  let apiAdminPool: Pool
  let apiPool: Pool
  let apiDb: Kysely<Database>
  let apiSchema = ''
  let sandboxRoot = ''
  let identityRoot = ''
  let pendingKeyRoot = ''
  let trustRoot = ''
  let infoPath = ''
  let releaseConfigPath = ''
  let centerProcess: ReturnType<typeof spawn> | undefined
  let centerStderr = ''
  let info: {
    source_commit: string
    issuer: string
    origin: string
    port: number
    database_name: string
    trust_bundle: string
    root_public_jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string }
    root_kid: string
    tls_ca: string
    activation_success: { license_id: string; activation_code: string }
    activation_recovery: { license_id: string; activation_code: string }
    activation_continue: { license_id: string; activation_code: string }
    activation_race: { license_id: string; activation_code: string }
    activation_protocol_resolution: { license_id: string; activation_code: string }
    activation_committed_conflict: { license_id: string; activation_code: string }
    activation_concurrent: { license_id: string; activation_code: string }
    activation_rejected: { license_id: string; activation_code: string }
    activation_retry_cases: Array<{ variant: string; license_id: string; rejected_code: string }>
    activation_finalization_cases: Array<{ license_id: string; activation_code: string }>
    activation_expired_challenge: { license_id: string; activation_code: string }
    crash_activation_cases: Array<{ license_id: string; activation_code: string }>
    transport_activation_cases: Array<{ license_id: string; activation_code: string }>
    activation_control_path: string
  }
  let identitySnapshot: Awaited<ReturnType<typeof initializeInstallationIdentity>>
  let operation: { operationId: string; intentDigest: string; state: string }
  let releaseConfig: Awaited<ReturnType<typeof validateTrustedReleaseLicenseConfig>>
  let trustStore: TrustBundleStore
  let centerPool: Pool
  const localTestLookup = ((hostname: string, optionsOrCallback: unknown, callbackMaybe?: (
    error: NodeJS.ErrnoException | null,
    address: string | Array<{ address: string; family: number }>,
    family?: number,
  ) => void) => {
    const callback = callbackMaybe
    if (!callback) throw new Error('TLS test lookup did not receive a callback')
    if (!hostname) return callback(new Error('missing hostname'), '', 0)
    if (typeof optionsOrCallback === 'object' && optionsOrCallback !== null && 'all' in optionsOrCallback && optionsOrCallback.all === true) {
      callback(null, [{ address: '127.0.0.1', family: 4 }])
    } else {
      callback(null, '127.0.0.1', 4)
    }
  }) as LookupFunction

  function testTlsOptions(): TestLicenseTlsOptions {
    return { ca: info.tls_ca, lookup: localTestLookup }
  }

  beforeAll(async () => {
    if (!testDatabaseUrl || !centerCheckout) return
    const parsedTestUrl = new URL(testDatabaseUrl)
    if (!parsedTestUrl.pathname.slice(1).endsWith('_test')) throw new Error('Cross-center tests require an isolated PostgreSQL database ending in _test')
    const checkedOutCenter = await new Promise<string>((resolveResult, reject) => {
      const child = spawn('git', ['-C', centerCheckout, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
      child.once('error', reject)
      child.once('close', (code) => code === 0 ? resolveResult(stdout.trim()) : reject(new Error('Unable to verify frozen authorization-center checkout')))
    })
    if (checkedOutCenter !== expectedCenterCommit) throw new Error('Authorization-center checkout is not at the R3 frozen commit')

    sandboxRoot = await mkdtemp(join(tmpdir(), 'aikayun-3c-2b-interop-'))
    identityRoot = join(sandboxRoot, 'instance-identity')
    pendingKeyRoot = join(sandboxRoot, 'pending-key')
    trustRoot = join(sandboxRoot, 'trust-store')
    infoPath = join(sandboxRoot, 'license-center.json')
    await mkdir(identityRoot, { mode: 0o700 })
    await mkdir(trustRoot, { mode: 0o700 })

    const centerLoader = join(centerCheckout, 'node_modules/tsx/dist/loader.mjs')
    await stat(centerLoader)
    centerProcess = spawn(process.execPath, ['--import', centerLoader, resolve(import.meta.dirname, 'fixtures/license-center-challenge-interop-server.mjs')], {
      cwd: centerCheckout,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LICENSE_CENTER_CHECKOUT: centerCheckout,
        LICENSE_CENTER_INTEROP_INFO: infoPath,
        LICENSE_TEST_DATABASE_URL: testDatabaseUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    centerProcess.stderr.setEncoding('utf8').on('data', (chunk) => { centerStderr += chunk })
    const ready = Date.now() + 30_000
    while (Date.now() < ready) {
      if (centerProcess.exitCode !== null || centerProcess.signalCode !== null) throw new Error(`Frozen authorization center failed to start: ${centerStderr}`)
      try { await stat(infoPath); break } catch { await new Promise((resolveResult) => setTimeout(resolveResult, 100)) }
    }
    await stat(infoPath)
    info = JSON.parse(await readFile(infoPath, 'utf8')) as typeof info
    if (info.source_commit !== expectedCenterCommit || info.issuer !== info.origin) throw new Error('Isolated authorization-center metadata is invalid')

    apiAdminPool = new Pool({ connectionString: testDatabaseUrl, max: 4 })
    const schema = `client_challenge_test_${randomUUID().replaceAll('-', '')}`
    apiSchema = schema
    await apiAdminPool.query(`CREATE SCHEMA "${schema}"`)
    apiPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}`, max: 6 })
    apiDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: apiPool }) })
    await installationIdentityMigration.up(apiDb)
    await localLicenseOperationsMigration.up(apiDb)
    await singleInitialActivationAttemptMigration.up(apiDb)
    await licenseOperationResultArchiveMigration.up(apiDb)
    await licenseResultArchivePresenceMigration.up(apiDb)
    await licenseOperationTrustedRejectionMigration.up(apiDb)
    identitySnapshot = await initializeInstallationIdentity(apiPool, { identityRoot, mode: 'fresh' })
    if (identitySnapshot.status !== 'ready' || !identitySnapshot.databaseId || !identitySnapshot.instanceId || !identitySnapshot.identityJkt) {
      throw new Error('Isolated 3A instance identity did not initialize')
    }
    await initializeTemporaryLicensePendingKey(pendingKeyRoot, 'test')
    operation = await createOrLoadActivationOperation(apiDb, pendingKeyRoot, {
      operationId: randomUUID(),
      licenseId: info.activation_success.license_id,
      activationCode: info.activation_success.activation_code,
      instanceId: identitySnapshot.instanceId,
      databaseId: identitySnapshot.databaseId,
      identityJkt: identitySnapshot.identityJkt,
      origin: null,
    })

    const rootThumbprint = await calculateJwkThumbprint(info.root_public_jwk, 'sha256')
    if (rootThumbprint !== info.root_kid) throw new Error('Disposable center test root JKT is inconsistent')
    releaseConfig = await validateTrustedReleaseLicenseConfig({
      schema_version: 1,
      trust_configuration_id: randomUUID(),
      release_id: 'test-3c-2b',
      release_manifest_sha256: randomBytes(32).toString('base64url'),
      expected_center_issuer: info.issuer,
      expected_center_origin: info.origin,
      offline_root: { kid: info.root_kid, publicJwk: info.root_public_jwk },
      minimum_bundle_version: '1',
    })
    releaseConfigPath = join(sandboxRoot, 'trusted-release-license-config.json')
    await writeFile(releaseConfigPath, JSON.stringify(releaseConfig), { mode: 0o600, flag: 'wx' })
    trustStore = new TrustBundleStore({
      directory: trustRoot,
      trustedRoot: releaseConfig.offline_root,
      expectedCenterIssuer: releaseConfig.expected_center_issuer,
      minimumBundleVersion: releaseConfig.minimum_bundle_version,
    })
    const candidate = await verifyTrustBundleSignature(info.trust_bundle, {
      trustedRoot: releaseConfig.offline_root,
      expectedCenterIssuer: releaseConfig.expected_center_issuer,
    })
    const anchor = await fetchTrustedTimeAnchor(releaseConfig, candidate, { testCa: info.tls_ca, testLookup: localTestLookup })
    await trustStore.accept(info.trust_bundle, anchor.assertFresh)

    const centerDatabaseUrl = new URL(testDatabaseUrl)
    centerDatabaseUrl.pathname = `/${info.database_name}`
    centerPool = new Pool({ connectionString: centerDatabaseUrl.toString(), max: 2 })
  }, 90_000)

  afterAll(async () => {
    await centerPool?.end().catch(() => undefined)
    if (centerProcess && centerProcess.exitCode === null && centerProcess.signalCode === null) {
      await new Promise<void>((resolveResult) => {
        const timeout = setTimeout(() => centerProcess?.kill('SIGKILL'), 10_000)
        centerProcess?.once('exit', () => { clearTimeout(timeout); resolveResult() })
        centerProcess?.kill('SIGTERM')
      })
    }
    await apiDb?.destroy().catch(() => undefined)
    await apiAdminPool?.query(`DROP SCHEMA IF EXISTS "${apiSchema}" CASCADE`).catch(() => undefined)
    await apiAdminPool?.end().catch(() => undefined)
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true })
  })

  function challengeClient(testTls: TestLicenseTlsOptions = testTlsOptions()) {
    return createLicenseChallengeClient({
      db: apiDb,
      pool: apiPool,
      identityRoot,
      pendingKeyRoot,
      releaseConfig,
      trustStore,
      testTls,
    })
  }

  function activationClient(input: {
    testTls?: TestLicenseTlsOptions
    onTestCheckpoint?: (stage: LicenseActivationCheckpoint) => void | Promise<void>
  } = {}) {
    return createLicenseActivationClient({
      db: apiDb,
      pool: apiPool,
      identityRoot,
      pendingKeyRoot,
      releaseConfig,
      trustStore,
      testTls: input.testTls ?? testTlsOptions(),
      ...(input.onTestCheckpoint === undefined ? {} : { onTestCheckpoint: input.onTestCheckpoint }),
    })
  }

  function recoveryClient(input: {
    db?: Kysely<Database>
    pool?: Pool
    identityRoot?: string
    pendingKeyRoot?: string
    trustStore?: TrustBundleStore
    testTls?: TestLicenseTlsOptions
    onTestCheckpoint?: (stage: LicenseRecoveryCheckpoint) => void | Promise<void>
  } = {}) {
    return createLicenseOperationRecoveryClient({
      db: input.db ?? apiDb,
      pool: input.pool ?? apiPool,
      identityRoot: input.identityRoot ?? identityRoot,
      pendingKeyRoot: input.pendingKeyRoot ?? pendingKeyRoot,
      releaseConfig,
      trustStore: input.trustStore ?? trustStore,
      testTls: input.testTls ?? testTlsOptions(),
      ...(input.onTestCheckpoint === undefined ? {} : { onTestCheckpoint: input.onTestCheckpoint }),
    })
  }

  async function createRecoveryCase(input: {
    name: string
    license: { license_id: string; activation_code: string }
    activationCode?: string
  }) {
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `client_recovery_${suffix}`
    const root = join(sandboxRoot, `${input.name}-${suffix}`)
    const caseIdentityRoot = join(root, 'identity')
    const casePendingRoot = join(root, 'pending')
    const caseTrustRoot = join(root, 'trust')
    await mkdir(caseIdentityRoot, { recursive: true, mode: 0o700 })
    await mkdir(caseTrustRoot, { recursive: true, mode: 0o700 })
    await apiAdminPool.query(`CREATE SCHEMA "${schema}"`)
    const casePool = new Pool({ connectionString: testDatabaseUrl!, options: `-c search_path=${schema}`, max: 8 })
    const caseDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: casePool }) })
    try {
      await installationIdentityMigration.up(caseDb)
      await localLicenseOperationsMigration.up(caseDb)
      await singleInitialActivationAttemptMigration.up(caseDb)
      await licenseOperationResultArchiveMigration.up(caseDb)
      await licenseResultArchivePresenceMigration.up(caseDb)
      await licenseOperationTrustedRejectionMigration.up(caseDb)
      const identity = await initializeInstallationIdentity(casePool, { identityRoot: caseIdentityRoot, mode: 'fresh' })
      if (!identity.databaseId || !identity.instanceId || !identity.identityJkt) throw new Error('Recovery fixture identity is missing')
      await initializeTemporaryLicensePendingKey(casePendingRoot, 'test')
      const pending = await createOrLoadActivationOperation(caseDb, casePendingRoot, {
        operationId: randomUUID(),
        licenseId: input.license.license_id,
        activationCode: input.activationCode ?? input.license.activation_code,
        databaseId: identity.databaseId,
        instanceId: identity.instanceId,
        identityJkt: identity.identityJkt,
        origin: null,
      })
      const candidate = await verifyTrustBundleSignature(info.trust_bundle, {
        trustedRoot: releaseConfig.offline_root,
        expectedCenterIssuer: releaseConfig.expected_center_issuer,
      })
      const anchor = await fetchTrustedTimeAnchor(releaseConfig, candidate, {
        testCa: info.tls_ca, testLookup: localTestLookup,
      })
      const caseTrustStore = new TrustBundleStore({
        directory: caseTrustRoot,
        trustedRoot: releaseConfig.offline_root,
        expectedCenterIssuer: releaseConfig.expected_center_issuer,
        minimumBundleVersion: releaseConfig.minimum_bundle_version,
      })
      await caseTrustStore.accept(info.trust_bundle, anchor.assertFresh)
      return {
        schema, root, identityRoot: caseIdentityRoot, pendingRoot: casePendingRoot, pool: casePool, db: caseDb,
        trustStore: caseTrustStore, operation: pending, identity,
        recoveryClientForCase(onTestCheckpoint?: (stage: LicenseRecoveryCheckpoint) => void | Promise<void>) {
          return recoveryClient({
            db: caseDb, pool: casePool, identityRoot: caseIdentityRoot, pendingKeyRoot: casePendingRoot,
            trustStore: caseTrustStore, ...(onTestCheckpoint === undefined ? {} : { onTestCheckpoint }),
          })
        },
        activationClientForCase(
          onTestCheckpoint?: (stage: LicenseActivationCheckpoint) => void | Promise<void>,
          database: Kysely<Database> = caseDb,
        ) {
          return createLicenseActivationClient({
            db: database, pool: casePool, identityRoot: caseIdentityRoot, pendingKeyRoot: casePendingRoot,
            releaseConfig, trustStore: caseTrustStore, testTls: testTlsOptions(),
            ...(onTestCheckpoint === undefined ? {} : { onTestCheckpoint }),
          })
        },
        async close() {
          await caseDb.destroy().catch(() => undefined)
          await apiAdminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
          await rm(root, { recursive: true, force: true }).catch(() => undefined)
        },
      }
    } catch (error) {
      await caseDb.destroy().catch(() => undefined)
      await apiAdminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  function runActivationCrashChild(input: {
    checkpoint: string
    schema: string
    operationId: string
    identityRoot: string
    pendingRoot: string
    trustRoot?: string
  }) {
    const databaseUrl = new URL(testDatabaseUrl!)
    databaseUrl.searchParams.set('options', `-c search_path=${input.schema}`)
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [
        '--import', resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs'),
        resolve(import.meta.dirname, 'fixtures/license-activation-crash-process.ts'),
        input.checkpoint, input.schema, input.operationId, input.identityRoot, input.pendingRoot,
        input.trustRoot ?? trustRoot, releaseConfigPath, infoPath,
      ], {
        cwd: resolve(import.meta.dirname, '../../..'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TEST_DATABASE_URL: testDatabaseUrl!,
          DATABASE_URL: databaseUrl.toString(),
          LICENSE_PENDING_KEY_ROOT: input.pendingRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.once('error', reject)
      child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }))
    })
  }

  function runFinalizationChild(input: {
    schema: string
    operationId: string
    evidenceAttemptNo: number
    identityRoot: string
    pendingRoot: string
    trustRoot: string
  }) {
    const databaseUrl = new URL(testDatabaseUrl!)
    databaseUrl.searchParams.set('options', `-c search_path=${input.schema}`)
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [
        '--import', resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs'),
        resolve(import.meta.dirname, 'fixtures/license-operation-finalize-process.ts'),
        input.schema, input.operationId, String(input.evidenceAttemptNo), input.identityRoot,
        input.pendingRoot, input.trustRoot, releaseConfigPath, infoPath,
      ], {
        cwd: resolve(import.meta.dirname, '../../..'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TEST_DATABASE_URL: testDatabaseUrl!,
          DATABASE_URL: databaseUrl.toString(),
          LICENSE_PENDING_KEY_ROOT: input.pendingRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('close', (code, signal) => { clearTimeout(timeout); resolveResult({ code, signal, stdout, stderr }) })
    })
  }

  function runRecoveryChild(input: {
    checkpoint?: LicenseRecoveryCheckpoint | 'none'
    occurrence?: number
    schema: string
    operationId: string
    identityRoot: string
    pendingRoot: string
    trustRoot: string
    poolMax?: number
    mode?: 'query' | 'parallel' | 'busy'
    timeoutMs?: number
  }) {
    const databaseUrl = new URL(testDatabaseUrl!)
    databaseUrl.searchParams.set('options', `-c search_path=${input.schema}`)
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [
        '--import', resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs'),
        resolve(import.meta.dirname, 'fixtures/license-operation-recovery-process.ts'),
        input.checkpoint ?? 'none', String(input.occurrence ?? 0), input.schema, input.operationId,
        input.identityRoot, input.pendingRoot, input.trustRoot, releaseConfigPath, infoPath,
      ], {
        cwd: resolve(import.meta.dirname, '../../..'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TEST_DATABASE_URL: testDatabaseUrl!,
          DATABASE_URL: databaseUrl.toString(),
          LICENSE_PENDING_KEY_ROOT: input.pendingRoot,
          ...(input.poolMax === undefined ? {} : { RECOVERY_TEST_POOL_MAX: String(input.poolMax) }),
          ...(input.mode === undefined ? {} : { RECOVERY_TEST_MODE: input.mode }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      const timeout = setTimeout(() => child.kill('SIGKILL'), input.timeoutMs ?? 60_000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('close', (code, signal) => { clearTimeout(timeout); resolveResult({ code, signal, stdout, stderr }) })
    })
  }

  async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try { await stat(path); return } catch { await new Promise(resolveResult => setTimeout(resolveResult, 25)) }
    }
    throw new Error(`Timed out waiting for isolated interop marker ${path}`)
  }

  async function setCenterMode(mode: string): Promise<void> {
    await writeFile(info.activation_control_path, JSON.stringify({ mode }), { mode: 0o600 })
  }

  async function clearCenterMode(): Promise<void> {
    await rm(info.activation_control_path, { force: true })
  }

  async function issueCenterReplacementCode(licenseId: string): Promise<string> {
    const origin = new URL(info.origin)
    const body = Buffer.from(JSON.stringify({ license_id: licenseId }), 'utf8')
    return new Promise((resolveResult, reject) => {
      const request = httpsRequest({
        hostname: origin.hostname, port: Number(origin.port), servername: origin.hostname,
        path: '/__test/issue-activation-code', method: 'POST', ca: info.tls_ca, lookup: localTestLookup,
        headers: { 'content-type': 'application/json', 'content-length': String(body.byteLength) },
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.once('end', () => {
          const bytes = Buffer.concat(chunks)
          if (response.statusCode !== 200 || typeof response.headers['content-type'] !== 'string' ||
            response.headers['content-type'].split(';', 1)[0]!.trim().toLowerCase() !== 'application/json') {
            reject(new Error(`Frozen-center replacement-code fixture endpoint failed (${response.statusCode}): ${bytes.toString('utf8')}`))
            return
          }
          try {
            const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
            if (Object.keys(parsed).length !== 1 || typeof parsed.activation_code !== 'string') throw new Error('invalid response')
            resolveResult(parsed.activation_code)
          } catch { reject(new Error('Frozen-center replacement-code response was invalid')) }
        })
      })
      request.once('error', reject)
      request.end(body)
    })
  }

  async function storedRequestBody(input: {
    db: Kysely<Database>
    pendingRoot: string
    operationId: string
    attemptNo: number
  }): Promise<{ body: Record<string, unknown>; requestBytes: Buffer; challenge: Record<string, unknown>; headers: Record<string, string> }> {
    const stored = await readLicenseOperationAttemptEnvelope(input.db, input.pendingRoot, input.operationId, input.attemptNo)
    const envelope = JSON.parse(stored.requestEnvelope.toString('utf8')) as {
      body_base64url: string
      headers: Record<string, string>
    }
    const requestBytes = Buffer.from(envelope.body_base64url, 'base64url')
    const body = JSON.parse(requestBytes.toString('utf8')) as Record<string, unknown>
    return { body, requestBytes, challenge: decodeJwt(String(body.challenge)), headers: envelope.headers }
  }

  function loseCommitAcknowledgementAfterWrite(db: Kysely<Database>): Kysely<Database> {
    return new Proxy(db, {
      get(target, property) {
        if (property === 'transaction') {
          return () => {
            const builder = target.transaction()
            return {
              execute<T>(callback: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
                return builder.execute(callback).then(() => {
                  throw new Error('injected_unknown_recovery_commit_acknowledgement')
                })
              },
            }
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Kysely<Database>
  }

  function loseTerminalCommitAcknowledgement(db: Kysely<Database>, operationId: string): {
    db: Kysely<Database>
    wasLost: () => boolean
  } {
    let wasLost = false
    const wrapped = new Proxy(db, {
      get(target, property) {
        if (property === 'transaction') {
          return () => {
            const builder = target.transaction()
            return {
              execute<T>(callback: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
                return builder.execute(callback).then(async result => {
                  if (!wasLost) {
                    const operation = await target.selectFrom('local_license_operations').select('state')
                      .where('operation_id', '=', operationId).executeTakeFirst()
                    if (operation?.state === 'terminal') {
                      wasLost = true
                      throw new Error('injected_unknown_terminal_commit_acknowledgement')
                    }
                  }
                  return result
                })
              },
            }
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Kysely<Database>
    return { db: wrapped, wasLost: () => wasLost }
  }

  async function sendRawChallengeRequest(body: Buffer, headers: Record<string, string>): Promise<number> {
    return new Promise((resolveResult, reject) => {
      const target = new URL(info.origin)
      const request = httpsRequest({
        hostname: target.hostname,
        port: target.port,
        path: '/v1/challenges',
        method: 'POST',
        agent: false,
        rejectUnauthorized: true,
        servername: target.hostname,
        ca: info.tls_ca,
        lookup: localTestLookup,
        headers: { ...headers, 'content-length': String(body.byteLength), connection: 'close' },
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        response.once('end', () => {
          const status = response.statusCode ?? 0
          resolveResult(status)
        })
      })
      request.once('error', reject)
      request.end(body)
    })
  }

  async function validChallengeRequestBody(identity: { databaseId: string; instanceId: string; identityJkt: string; publicJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string } }) {
    return Buffer.from(JSON.stringify({
      operation: 'activation',
      operation_id: randomUUID(),
      intent_digest: randomBytes(32).toString('base64url'),
      instance_id: identity.instanceId,
      public_jwk: identity.publicJwk,
      client_nonce: randomBytes(32).toString('base64url'),
    }), 'utf8')
  }

  it('proves 3A identity against the real frozen HTTPS center and returns only a locally bound Challenge', async () => {
    const client = challengeClient()
    const result = await client.requestActivationChallenge(operation.operationId)
    expect(result).toMatchObject({
      purpose: 'verified_bound_license_challenge',
      operation: 'activation',
      operationId: operation.operationId,
      intentDigest: operation.intentDigest,
      databaseId: identitySnapshot.databaseId,
      instanceId: identitySnapshot.instanceId,
      identityJkt: identitySnapshot.identityJkt,
      signatureVerified: true,
      operationBound: true,
    })
    expect(Buffer.from(result.clientNonce, 'base64url')).toHaveLength(32)
    expect(Buffer.from(result.serverNonce, 'base64url')).toHaveLength(32)
    expect(result.expiresAt - result.issuedAt).toBe(300)
    expect(result.signingKeyId).toMatch(/^[A-Za-z0-9_-]{43}$/u)

    const attempts = await apiDb.selectFrom('local_license_operation_attempts').select('attempt_no')
      .where('operation_id', '=', operation.operationId).execute()
    const unchangedOperation = await apiDb.selectFrom('local_license_operations').select(['operation_id', 'intent_digest', 'state'])
      .where('operation_id', '=', operation.operationId).executeTakeFirstOrThrow()
    expect(attempts).toHaveLength(0)
    expect(unchangedOperation).toEqual({ operation_id: operation.operationId, intent_digest: operation.intentDigest, state: 'pending' })

    const centerMutations = await centerPool.query<{ activations: string; operations: string; attempts: string }>(`
      SELECT (SELECT count(*) FROM license_activations)::text AS activations,
        (SELECT count(*) FROM license_operations)::text AS operations,
        (SELECT count(*) FROM license_operation_attempts)::text AS attempts
    `)
    expect(centerMutations.rows[0]).toEqual({ activations: '0', operations: '0', attempts: '0' })
    const localProjection = await apiPool.query<{ projection: string | null }>("SELECT to_regclass('license_projection')::text AS projection")
    expect(localProjection.rows[0]?.projection).toBeNull()
  }, 20_000)

  it('uses RFC 9421 ordered components, the expected profile, the JKT and RFC 9530 digest of unchanged body bytes', async () => {
    await withVerifiedInstallationSigningContext(apiPool, identityRoot, async (identity) => {
      const target = new URL(info.origin)
      const requestBody = await validChallengeRequestBody(identity)
      const nonce = JSON.parse(requestBody.toString('utf8')).client_nonce as string
      const created = Math.floor(Date.now() / 1000)
      const signed = await createSignedChallengeRequest({ origin: target, body: requestBody, identity, clientNonce: nonce, created })
      const input = signed.headers['signature-input']!
      expect(input).toMatch(/^sig1=\("@method" "@target-uri" "content-type" "content-digest"\);keyid="[A-Za-z0-9_-]{43}";alg="ed25519";created=[0-9]+;expires=[0-9]+;nonce="[A-Za-z0-9_-]{43}";tag="aikayun-license-v1"$/u)
      expect(signed.body).toBe(requestBody)
      const digestBase64 = /sha-256=:([^:]+):/u.exec(signed.headers['content-digest']!)?.[1]
      expect(digestBase64).toBe(createHash('sha256').update(requestBody).digest('base64'))
      expect(await sendRawChallengeRequest(signed.body, signed.headers)).toBe(201)
    })
  }, 20_000)

  it('real center rejects wrong private keys, wrong JKT, signature tampering, body tampering and a false Content-Digest', async () => {
    await withVerifiedInstallationSigningContext(apiPool, identityRoot, async (identity) => {
      const target = new URL(info.origin)
      const goodBody = await validChallengeRequestBody(identity)
      const nonce = JSON.parse(goodBody.toString('utf8')).client_nonce as string
      const created = Math.floor(Date.now() / 1000)
      const valid = await createSignedChallengeRequest({ origin: target, body: goodBody, identity, clientNonce: nonce, created })
      expect(await sendRawChallengeRequest(valid.body, valid.headers)).toBe(201)

      const staleBody = await validChallengeRequestBody(identity)
      const staleNonce = JSON.parse(staleBody.toString('utf8')).client_nonce as string
      const staleTime = await createSignedChallengeRequest({
        origin: target,
        body: staleBody,
        identity,
        clientNonce: staleNonce,
        created: created - 120,
      })
      expect(await sendRawChallengeRequest(staleTime.body, staleTime.headers)).toBe(401)

      const wrongPair = generateKeyPairSync('ed25519')
      const wrongPrivate = await createSignedChallengeRequest({
        origin: target,
        body: goodBody,
        identity: { ...identity, sign: (message) => signEd25519(null, Buffer.from(message), wrongPair.privateKey) },
        clientNonce: nonce,
        created,
      })
      expect(await sendRawChallengeRequest(wrongPrivate.body, wrongPrivate.headers)).toBe(401)

      const wrongJkt = await createSignedChallengeRequest({
        origin: target,
        body: goodBody,
        identity: { ...identity, identityJkt: randomBytes(32).toString('base64url') },
        clientNonce: nonce,
        created,
      })
      expect(await sendRawChallengeRequest(wrongJkt.body, wrongJkt.headers)).toBe(401)

      const signature = valid.headers.signature!
      const signatureBytes = /sig1=:([^:]+):/u.exec(signature)?.[1]
      if (!signatureBytes) throw new Error('RFC 9421 signature was not encoded as a byte sequence')
      const alteredSignatureBytes = `${signatureBytes.slice(0, -1)}${signatureBytes.endsWith('A') ? 'B' : 'A'}`
      const alteredSignature = { ...valid.headers, signature: signature.replace(signatureBytes, alteredSignatureBytes) }
      expect(await sendRawChallengeRequest(valid.body, alteredSignature)).toBe(401)

      const changedClaims = JSON.parse(goodBody.toString('utf8')) as Record<string, unknown>
      changedClaims['operation_id'] = randomUUID()
      const changedBody = Buffer.from(JSON.stringify(changedClaims), 'utf8')
      expect(await sendRawChallengeRequest(changedBody, valid.headers)).toBe(401)

      const digestHeader = valid.headers['content-digest']!
      const digestBytes = /sha-256=:([^:]+):/u.exec(digestHeader)?.[1]
      if (!digestBytes) throw new Error('RFC 9530 digest was not encoded as a byte sequence')
      const changedDigest = { ...valid.headers, 'content-digest': digestHeader.replace(digestBytes, `${digestBytes.slice(0, -1)}${digestBytes.endsWith('A') ? 'B' : 'A'}`) }
      expect(await sendRawChallengeRequest(valid.body, changedDigest)).toBe(401)
    })
  }, 30_000)

  it('concurrent and retried Challenges reuse the same pending activation operation without allocating activation attempts', async () => {
    const retryable = createLicenseChallengeClient({
      db: apiDb,
      pool: apiPool,
      identityRoot,
      pendingKeyRoot,
      releaseConfig,
      trustStore,
      testTls: { ca: info.tls_ca, lookup: ((hostname: string, _options: unknown, callbackMaybe?: (
        error: NodeJS.ErrnoException | null,
        address: string | Array<{ address: string; family: number }>,
        family?: number,
      ) => void) => {
        const callback = callbackMaybe
        if (!callback) throw new Error('TLS test lookup did not receive a callback')
        callback(new Error('one isolated network interruption'), '', 0)
      }) as LookupFunction },
    })
    await expect(retryable.requestActivationChallenge(operation.operationId)).rejects.toMatchObject({ code: 'challenge_request_failed' })
    const client = challengeClient()
    const [first, second] = await Promise.all([
      client.requestActivationChallenge(operation.operationId),
      client.requestActivationChallenge(operation.operationId),
    ])
    expect(first.operationId).toBe(operation.operationId)
    expect(second.operationId).toBe(operation.operationId)
    expect(first.clientNonce).not.toBe(second.clientNonce)
    expect(await apiDb.selectFrom('local_license_operations').select('operation_id').where('operation_id', '=', operation.operationId).execute()).toHaveLength(1)
    expect(await apiDb.selectFrom('local_license_operation_attempts').select('attempt_no').where('operation_id', '=', operation.operationId).execute()).toHaveLength(0)
  }, 25_000)

  it('binds the signed challenge to the immutable local operation and refuses every mismatched field', () => {
    const expected: PendingActivationOperation = {
      operationId: randomUUID(),
      intentDigest: randomBytes(32).toString('base64url'),
      databaseId: randomUUID(),
      instanceId: randomUUID(),
      identityJkt: randomBytes(32).toString('base64url'),
    }
    const nonce = randomBytes(32).toString('base64url')
    const serverNonce = randomBytes(32).toString('base64url')
    const issuedAt = 2_000_000_000
    const claims = {
      operation: 'activation', operation_id: expected.operationId, intent_digest: expected.intentDigest,
      instance_id: expected.instanceId, identity_jkt: expected.identityJkt, client_nonce: nonce,
      server_nonce: serverNonce, iat: issuedAt, exp: issuedAt + 300,
    }
    expect(assertChallengeClaimsBound(claims, expected, nonce, issuedAt + 1)).toMatchObject({
      issuedAt, expiresAt: issuedAt + 300, serverNonce,
    })
    for (const [name, value] of Object.entries({
      operation: 'renewal', operation_id: randomUUID(), intent_digest: randomBytes(32).toString('base64url'),
      instance_id: randomUUID(), identity_jkt: randomBytes(32).toString('base64url'), client_nonce: randomBytes(32).toString('base64url'),
    })) {
      const altered = { ...claims, [name]: value }
      expect(() => assertChallengeClaimsBound(altered, expected, nonce, issuedAt + 1)).toThrow(/challenge_binding_invalid/u)
    }
    for (const invalidTime of [issuedAt - 1, issuedAt + 300]) {
      expect(() => assertChallengeClaimsBound(claims, expected, nonce, invalidTime)).toThrow(/challenge_binding_invalid/u)
    }
    const invalidServerNonce = { ...claims, server_nonce: 'not-a-nonce' }
    expect(() => assertChallengeClaimsBound(invalidServerNonce, expected, nonce, issuedAt + 1)).toThrow(/challenge_nonce_invalid/u)
  })

  it('never follows redirects and enforces TLS hostname validation for the signed HTTPS request', async () => {
    expect(() => createLicenseChallengeClient({
      db: apiDb,
      pool: apiPool,
      identityRoot,
      pendingKeyRoot,
      releaseConfig: { ...releaseConfig, expected_center_origin: 'https://wrong.example.test' } as typeof releaseConfig,
      trustStore,
    })).toThrow(/trusted_origin_invalid/u)
    await withVerifiedInstallationSigningContext(apiPool, identityRoot, async (identity) => {
      const body = await validChallengeRequestBody(identity)
      const wrongOrigin = new URL(`https://wrong.example.test:${info.port}`)
      const signedForWrongHost = await createSignedChallengeRequest({
        origin: wrongOrigin,
        body,
        identity,
        clientNonce: JSON.parse(body.toString('utf8')).client_nonce as string,
        created: Math.floor(Date.now() / 1000),
      })
      await expect(postChallenge({ origin: wrongOrigin, signed: signedForWrongHost, testTls: { ca: info.tls_ca, lookup: localTestLookup } }))
        .rejects.toMatchObject({ code: 'challenge_transport_failed' })
    })
  }, 10_000)

  it('rejects untrusted test TLS, redirects, timeout, declared oversize and streamed oversized responses', async () => {
    const certPath = join(sandboxRoot, 'response-server-cert.pem')
    const keyPath = join(sandboxRoot, 'response-server-key.pem')
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=interop-response.example.test',
      '-addext', 'subjectAltName=DNS:interop-response.example.test', '-keyout', keyPath, '-out', certPath,
    ], { stdio: 'ignore' })
    const certificate = await readFile(certPath)
    const privateKey = await readFile(keyPath)
    let mode: 'redirect' | 'declared_oversize' | 'streamed_oversize' | 'slow' = 'redirect'
    let requestCount = 0
    const server = createHttpsServer({ key: privateKey, cert: certificate }, (request, response) => {
      requestCount += 1
      if (mode === 'redirect') {
        response.writeHead(302, { location: 'https://redirect-target.example.test/v1/challenges' })
        response.end()
      } else if (mode === 'declared_oversize') {
        response.writeHead(201, { 'content-type': 'application/json', 'content-length': String(16 * 1024 + 1) })
        response.end()
      } else if (mode === 'streamed_oversize') {
        response.writeHead(201, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' })
        response.end(Buffer.alloc(16 * 1024 + 1, 0x61))
      } else {
        const timer = setTimeout(() => {
          if (!response.destroyed) response.writeHead(201, { 'content-type': 'application/json' }).end('{"challenge":"x"}')
        }, 6_000)
        request.once('close', () => clearTimeout(timer))
      }
    })
    await new Promise<void>((resolveResult, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolveResult())
    })
    const port = (server.address() as AddressInfo).port
    const origin = new URL(`https://interop-response.example.test:${port}`)
    const body = Buffer.from('{"test":true}', 'utf8')
    const signed = {
      body,
      headers: { host: origin.host, 'content-type': 'application/json', 'content-length': String(body.byteLength) },
    }
    const options = { ca: certificate, lookup: localTestLookup }
    try {
      await expect(postChallenge({ origin, signed, testTls: options })).rejects.toMatchObject({ code: 'challenge_http_rejected' })
      expect(requestCount).toBe(1)
      mode = 'declared_oversize'
      await expect(postChallenge({ origin, signed, testTls: options })).rejects.toMatchObject({ code: 'challenge_response_too_large' })
      mode = 'streamed_oversize'
      await expect(postChallenge({ origin, signed, testTls: options })).rejects.toMatchObject({ code: 'challenge_response_invalid' })
      await expect(postChallenge({ origin, signed, testTls: { lookup: localTestLookup } })).rejects.toMatchObject({ code: 'challenge_transport_failed' })
      mode = 'slow'
      await expect(postChallenge({ origin, signed, testTls: options })).rejects.toMatchObject({ code: 'challenge_transport_failed' })
    } finally {
      await new Promise<void>((resolveResult) => server.close(() => resolveResult()))
    }
  }, 15_000)

  it('stops on a real center-signed expired Challenge without creating an activation attempt or retrying', async () => {
    const challengeCountBefore = await centerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM request_nonces WHERE operation_id = $1`, [operation.operationId],
    )
    await writeFile(info.activation_control_path, JSON.stringify({ mode: 'expired_challenge' }), { mode: 0o600 })
    try {
      await expect(activationClient().submitPendingActivation(operation.operationId))
        .rejects.toMatchObject({ code: 'challenge_request_failed' })
    } finally {
      await rm(info.activation_control_path, { force: true })
    }
    const attempts = await apiDb.selectFrom('local_license_operation_attempts').select('attempt_no')
      .where('operation_id', '=', operation.operationId).execute()
    expect(attempts).toEqual([])
    const issuedChallenges = await centerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM request_nonces WHERE operation_id = $1`, [operation.operationId],
    )
    expect(Number(issuedChallenges.rows[0]?.count) - Number(challengeCountBefore.rows[0]?.count)).toBe(1)
    const centerOperation = await centerPool.query(`SELECT operation_id FROM license_operations WHERE operation_id = $1`, [operation.operationId])
    expect(centerOperation.rowCount).toBe(0)
    const code = await centerPool.query<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM activation_codes WHERE license_id = $1`, [info.activation_success.license_id],
    )
    expect(code.rows[0]?.consumed_at).toBeNull()
  })

  it('rejects activation body, digest, signature, nonce and JKT tampering at the real center before side effects', async () => {
    const expectedIdentity = await withVerifiedInstallationSigningContext(apiPool, identityRoot, async identity => identity)
    const evilKeys = generateKeyPairSync('ed25519')
    const evilPublicJwk = evilKeys.publicKey.export({ format: 'jwk' })
    const evilIdentityJkt = await calculateJwkThumbprint(evilPublicJwk)

    async function signedActivation(
      challenge: Awaited<ReturnType<ReturnType<typeof challengeClient>['requestActivationChallenge']>>,
      identity: { identityJkt: string; publicJwk: unknown; sign(message: Uint8Array): Buffer },
      options: { signatureNonce?: string; bodyIdentityJkt?: string; bodyPublicJwk?: unknown } = {},
    ) {
      const body = Buffer.from(JSON.stringify({
        operation_id: operation.operationId,
        intent_digest: operation.intentDigest,
        attempt_no: 1,
        license_id: info.activation_success.license_id,
        database_id: identitySnapshot.databaseId,
        instance_id: identitySnapshot.instanceId,
        identity_jkt: options.bodyIdentityJkt ?? identitySnapshot.identityJkt,
        public_jwk: options.bodyPublicJwk ?? identitySnapshot.publicJwk,
        challenge: challenge.token,
        activation_code: info.activation_success.activation_code,
        origin: null,
      }), 'utf8')
      return createSignedLicenseRequest({
        origin: new URL(info.origin),
        path: LICENSE_ACTIVATION_PATH,
        body,
        identity,
        nonce: options.signatureNonce ?? challenge.serverNonce,
        created: challenge.issuedAt,
      })
    }

    async function postWithChallenge(
      identity: { identityJkt: string; publicJwk: unknown; sign(message: Uint8Array): Buffer },
      options: { signatureNonce?: string; bodyIdentityJkt?: string; bodyPublicJwk?: unknown } = {},
      transform?: (signed: Awaited<ReturnType<typeof createSignedLicenseRequest>>) => { body: Buffer; headers: Record<string, string> },
      tls: { ca?: string | Buffer; lookup?: LookupFunction } = { ca: info.tls_ca, lookup: localTestLookup },
    ) {
      const challenge = await challengeClient().requestActivationChallenge(operation.operationId)
      const signed = await signedActivation(challenge, identity, options)
      return postSignedLicenseRequest({
        origin: new URL(info.origin),
        path: LICENSE_ACTIVATION_PATH,
        signed: transform ? transform(signed) : signed,
        testTls: tls,
      })
    }

    const bodyTampered = await postWithChallenge(expectedIdentity, {}, signed => ({
      ...signed,
      body: Buffer.concat([signed.body, Buffer.from(' ', 'utf8')]),
      headers: { ...signed.headers, 'content-length': String(signed.body.byteLength + 1) },
    }))
    expect([400, 401]).toContain(bodyTampered.statusCode)

    const digestTampered = await postWithChallenge(expectedIdentity, {}, signed => {
      const digest = /sha-256=:([^:]+):/u.exec(signed.headers['content-digest']!)?.[1]
      if (!digest) throw new Error('Missing activation request digest')
      return { ...signed, headers: {
        ...signed.headers,
        'content-digest': signed.headers['content-digest']!.replace(digest, `${digest.slice(0, -1)}${digest.endsWith('A') ? 'B' : 'A'}`),
      } }
    })
    expect([400, 401]).toContain(digestTampered.statusCode)

    const signatureTampered = await postWithChallenge(expectedIdentity, {}, signed => {
      const signature = /sig1=:([^:]+):/u.exec(signed.headers.signature)?.[1]
      if (!signature) throw new Error('Missing activation signature bytes')
      return { ...signed, headers: {
        ...signed.headers,
        signature: signed.headers.signature.replace(signature, `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`),
      } }
    })
    expect([400, 401]).toContain(signatureTampered.statusCode)

    const wrongNonce = await postWithChallenge(expectedIdentity, {
      signatureNonce: randomBytes(32).toString('base64url'),
    })
    expect([400, 401]).toContain(wrongNonce.statusCode)

    const wrongJkt = await postWithChallenge({
      identityJkt: evilIdentityJkt,
      publicJwk: evilPublicJwk,
      sign: message => signEd25519(null, message, evilKeys.privateKey),
    }, { bodyIdentityJkt: evilIdentityJkt, bodyPublicJwk: evilPublicJwk })
    expect([400, 401]).toContain(wrongJkt.statusCode)

    await expect(postWithChallenge(expectedIdentity, {}, undefined, { lookup: localTestLookup }))
      .rejects.toMatchObject({ code: 'license_transport_failed' })

    const attempts = await apiDb.selectFrom('local_license_operation_attempts').select('attempt_no')
      .where('operation_id', '=', operation.operationId).execute()
    expect(attempts).toEqual([])
    const centerOperation = await centerPool.query(`SELECT operation_id FROM license_operations WHERE operation_id = $1`, [operation.operationId])
    expect(centerOperation.rowCount).toBe(0)
    const code = await centerPool.query<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM activation_codes WHERE license_id = $1`, [info.activation_success.license_id],
    )
    expect(code.rows[0]?.consumed_at).toBeNull()
  }, 30_000)

  it('activates once over frozen-center HTTPS, persists the exact request and raw lease JWS, and leaves it unprojected', async () => {
    const client = activationClient()
    const concurrent = await Promise.allSettled([
      client.submitPendingActivation(operation.operationId),
      client.submitPendingActivation(operation.operationId),
    ])
    const fulfilled = concurrent.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof client.submitPendingActivation>>> =>
      item.status === 'fulfilled')
    const rejected = concurrent.filter(item => item.status === 'rejected')
    expect(fulfilled, JSON.stringify(rejected.map(item => item.status === 'rejected' ? item.reason : null))).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined)
      .toMatchObject({ code: 'activation_attempt_already_exists' })
    const evidence = fulfilled[0]!.value
    expect(evidence).toMatchObject({
      purpose: 'verified_activation_lease_unprojected',
      operationId: operation.operationId,
      attemptNo: 1,
      licenseId: info.activation_success.license_id,
      databaseId: identitySnapshot.databaseId,
      instanceId: identitySnapshot.instanceId,
      identityJkt: identitySnapshot.identityJkt,
      activationGeneration: '1',
      signatureVerified: true,
      projected: false,
    })
    expect('allow' in evidence).toBe(false)
    expect('grants' in evidence).toBe(false)

    const localOperation = await apiDb.selectFrom('local_license_operations').selectAll()
      .where('operation_id', '=', operation.operationId).executeTakeFirstOrThrow()
    const localAttempts = await apiDb.selectFrom('local_license_operation_attempts').selectAll()
      .where('operation_id', '=', operation.operationId).execute()
    expect(localOperation.state).toBe('response_saved')
    expect(localAttempts).toHaveLength(1)
    expect(localAttempts[0]).toMatchObject({ purpose: 'activation', attempt_no: 1, send_state: 'response_saved' })
    const storedRequest = await readLicenseOperationAttemptEnvelope(apiDb, pendingKeyRoot, operation.operationId, 1)
    const requestEnvelope = JSON.parse(storedRequest.requestEnvelope.toString('utf8')) as { body_base64url: string; headers: Record<string, string> }
    const requestBodyBytes = Buffer.from(requestEnvelope.body_base64url, 'base64url')
    const requestBody = JSON.parse(requestBodyBytes.toString('utf8')) as Record<string, unknown>
    const requestDigest = createHash('sha256').update(requestBodyBytes).digest('base64url')
    const challengeClaims = decodeJwt(String(requestBody['challenge']))
    expect(storedRequest).toMatchObject({
      requestBodyDigest: requestDigest,
      requestNonceHash: createHash('sha256').update(String(challengeClaims['server_nonce'])).digest('base64url'),
      clientNonceHash: createHash('sha256').update(String(challengeClaims['client_nonce'])).digest('base64url'),
      sendState: 'response_saved',
    })
    expect(requestEnvelope.target).toBe('/v1/activations')
    expect(requestBody).toMatchObject({
      operation_id: operation.operationId,
      intent_digest: operation.intentDigest,
      attempt_no: 1,
      license_id: info.activation_success.license_id,
      database_id: identitySnapshot.databaseId,
      instance_id: identitySnapshot.instanceId,
      identity_jkt: identitySnapshot.identityJkt,
      activation_code: info.activation_success.activation_code,
      public_jwk: expect.objectContaining({ kty: 'OKP', crv: 'Ed25519' }),
    })
    expect(requestEnvelope.headers['signature-input']).toContain(`nonce="${String(challengeClaims['server_nonce'])}"`)
    expect(requestEnvelope.headers['content-digest']).toContain(createHash('sha256').update(requestBodyBytes).digest('base64'))

    const rawLease = await readLicenseOperationAttemptResponse(apiDb, pendingKeyRoot, operation.operationId, 1)
    const lease = decodeJwt(rawLease.toString('ascii'))
    expect(lease).toMatchObject({
      sub: info.activation_success.license_id,
      database_id: identitySnapshot.databaseId,
      instance_id: identitySnapshot.instanceId,
      identity_jkt: identitySnapshot.identityJkt,
      activation_generation: '1',
      request_nonce: challengeClaims['server_nonce'],
      request_digest: requestDigest,
      grants: ['create_order', 'create_top_up'],
    })
    expect(localAttempts[0]!.request_body_digest).toBe(requestDigest)
    expect(Buffer.concat([localAttempts[0]!.encrypted_response!]).toString('ascii')).not.toContain(rawLease.toString('ascii'))

    const centerActivation = await centerPool.query<{ generation: string; identity_jkt: string }>(
      `SELECT generation::text, identity_jkt FROM license_activations WHERE license_id = $1`, [info.activation_success.license_id],
    )
    expect(centerActivation.rows).toEqual([{ generation: '1', identity_jkt: identitySnapshot.identityJkt }])
    const centerLicense = await centerPool.query<{ current_generation: string }>(
      `SELECT current_generation::text FROM licenses WHERE id = $1`, [info.activation_success.license_id],
    )
    expect(centerLicense.rows).toEqual([{ current_generation: '1' }])
    const codeRows = await centerPool.query<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM activation_codes WHERE license_id = $1`, [info.activation_success.license_id],
    )
    expect(codeRows.rows).toHaveLength(1)
    expect(codeRows.rows[0]!.consumed_at).toBeInstanceOf(Date)
    const centerOperation = await centerPool.query<{ state: string; outcome_code: string; response_jws: string }>(
      `SELECT state, outcome_code, response_jws FROM license_operations WHERE operation_id = $1`, [operation.operationId],
    )
    expect(centerOperation.rows).toEqual([{ state: 'committed', outcome_code: 'ACTIVATED', response_jws: rawLease.toString('ascii') }])
    const centerAttempt = await centerPool.query<{ attempt_no: number; body_digest: string; server_nonce_hash: string; identity_jkt: string }>(
      `SELECT attempt_no, body_digest, server_nonce_hash, identity_jkt FROM license_operation_attempts WHERE operation_id = $1`,
      [operation.operationId],
    )
    expect(centerAttempt.rows).toEqual([{
      attempt_no: 1,
      body_digest: requestDigest,
      server_nonce_hash: storedRequest.requestNonceHash,
      identity_jkt: identitySnapshot.identityJkt,
    }])
    const projection = await apiPool.query<{ projection: string | null }>("SELECT to_regclass('license_projection')::text AS projection")
    expect(projection.rows[0]?.projection).toBeNull()
    const challengeCountBeforeReentry = await centerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM request_nonces WHERE operation_id = $1`, [operation.operationId],
    )
    await expect(client.submitPendingActivation(operation.operationId)).rejects.toMatchObject({ code: 'activation_attempt_already_exists' })
    const challengeCountAfterReentry = await centerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM request_nonces WHERE operation_id = $1`, [operation.operationId],
    )
    expect(challengeCountAfterReentry.rows).toEqual(challengeCountBeforeReentry.rows)
    expect(await apiDb.selectFrom('local_license_operations').select('operation_id').execute()).toHaveLength(1)
    expect(await centerPool.query(`SELECT id FROM license_activations WHERE license_id = $1`, [info.activation_success.license_id]))
      .toMatchObject({ rowCount: 1 })

    const recovered = await recoveryClient().queryPendingActivation(operation.operationId)
    expect(recovered).toMatchObject({
      purpose: 'verified_activation_operation_recovery',
      operationId: operation.operationId,
      requestAttemptNo: 2,
      state: 'committed',
      outcomeCode: 'ACTIVATED',
      committedAttemptNo: 1,
      resultDisposition: 'current_lease',
      signatureVerified: true,
      projected: false,
    })
    expect('allow' in recovered).toBe(false)
    expect('grants' in recovered).toBe(false)
    const queryRequest = await storedRequestBody({ db: apiDb, pendingRoot: pendingKeyRoot, operationId: operation.operationId, attemptNo: 2 })
    expect(Object.keys(queryRequest.body).sort()).toEqual([
      'attempt_no', 'challenge', 'database_id', 'identity_jkt', 'instance_id', 'intent_digest', 'license_id', 'operation_id', 'public_jwk',
    ])
    expect(queryRequest.body).toMatchObject({
      operation_id: operation.operationId,
      intent_digest: operation.intentDigest,
      attempt_no: 2,
      license_id: info.activation_success.license_id,
      database_id: identitySnapshot.databaseId,
      instance_id: identitySnapshot.instanceId,
      identity_jkt: identitySnapshot.identityJkt,
    })
    expect(queryRequest.challenge.operation).toBe('query')
    expect(queryRequest.challenge.client_nonce).not.toBe(challengeClaims['client_nonce'])
    expect(queryRequest.challenge.server_nonce).not.toBe(challengeClaims['server_nonce'])
    expect(queryRequest.headers['signature-input']).toContain(`nonce="${String(queryRequest.challenge.server_nonce)}"`)
    const currentQueryReceipt = await readLicenseOperationAttemptResponse(apiDb, pendingKeyRoot, operation.operationId, 2)
    expect(currentQueryReceipt.toString('ascii')).not.toBe(rawLease.toString('ascii'))
    expect(decodeJwt(currentQueryReceipt.toString('ascii'))).toMatchObject({
      operation_id: operation.operationId,
      intent_digest: operation.intentDigest,
      state: 'committed',
      attempt_no: 2,
      request_nonce_hash: createHash('sha256').update(String(queryRequest.challenge.server_nonce)).digest('base64url'),
      request_digest: createHash('sha256').update(queryRequest.requestBytes).digest('base64url'),
      committed_attempt_no: 1,
      committed_request_nonce_hash: storedRequest.requestNonceHash,
      committed_request_digest: requestDigest,
      result_jws: rawLease.toString('ascii'),
    })
    expect(await readLicenseOperationAttemptResultJws(apiDb, pendingKeyRoot, operation.operationId, 1)).toEqual(rawLease)
    expect(await readLicenseOperationAttemptResultJws(apiDb, pendingKeyRoot, operation.operationId, 2)).toBeNull()
    expect(await readSavedLicenseOperationResponse(apiDb, pendingKeyRoot, operation.operationId)).toEqual(currentQueryReceipt)
    const latestOperation = await apiDb.selectFrom('local_license_operations').select(['state', 'response_attempt_no', 'response_digest'])
      .where('operation_id', '=', operation.operationId).executeTakeFirstOrThrow()
    expect(latestOperation).toMatchObject({ state: 'response_saved', response_attempt_no: 2 })
    const afterRecoveryAttempts = await apiDb.selectFrom('local_license_operation_attempts').selectAll()
      .where('operation_id', '=', operation.operationId).orderBy('attempt_no', 'asc').execute()
    expect(afterRecoveryAttempts.map(row => [row.attempt_no, row.purpose, row.send_state])).toEqual([
      [1, 'activation', 'response_saved'], [2, 'query', 'response_saved'],
    ])
    expect((await centerPool.query(`SELECT generation FROM license_activations WHERE license_id = $1`, [info.activation_success.license_id])).rowCount)
      .toBe(1)
    expect((await centerPool.query<{ current_generation: string }>(`SELECT current_generation::text FROM licenses WHERE id = $1`, [info.activation_success.license_id]))
      .rows).toEqual([{ current_generation: '1' }])
  }, 45_000)

  it('recovers a committed activation after the original HTTPS response was lost without another generation', async () => {
    const fixture = await createRecoveryCase({ name: 'lost-activation-response', license: info.activation_recovery })
    try {
      await setCenterMode('drop_after_commit')
      const activation = fixture.activationClientForCase()
      await expect(activation.submitPendingActivation(fixture.operation.operationId))
        .rejects.toMatchObject({ code: 'activation_result_unknown' })
      await clearCenterMode()

      const before = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      expect(before).toMatchObject({ purpose: 'activation', attempt_no: 1, send_state: 'transport_unknown' })
      const evidence = await fixture.recoveryClientForCase().queryPendingActivation(fixture.operation.operationId)
      expect(evidence).toMatchObject({
        requestAttemptNo: 2, state: 'committed', committedAttemptNo: 1, resultDisposition: 'current_lease', projected: false,
      })
      const attempts = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).orderBy('attempt_no', 'asc').execute()
      expect(attempts.map(row => [row.attempt_no, row.purpose, row.send_state])).toEqual([
        [1, 'activation', 'transport_unknown'], [2, 'query', 'response_saved'],
      ])
      expect(await readLicenseOperationAttemptResponse(fixture.db, fixture.pendingRoot, fixture.operation.operationId, 1)
        .catch(error => (error as { code?: string }).code)).toBe('operation_response_binding_mismatch')

      const query = await storedRequestBody({
        db: fixture.db, pendingRoot: fixture.pendingRoot, operationId: fixture.operation.operationId, attemptNo: 2,
      })
      expect(Object.keys(query.body).sort()).toEqual([
        'attempt_no', 'challenge', 'database_id', 'identity_jkt', 'instance_id', 'intent_digest', 'license_id', 'operation_id', 'public_jwk',
      ])
      expect(query.challenge.operation).toBe('query')
      const result = await readLicenseOperationAttemptResultJws(fixture.db, fixture.pendingRoot, fixture.operation.operationId, 1)
      expect(result?.toString('ascii')).toBe((await centerPool.query<{ response_jws: string }>(
        `SELECT response_jws FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId],
      )).rows[0]?.response_jws)
      expect((await centerPool.query<{ generation: string }>(
        `SELECT generation::text AS generation FROM license_activations WHERE license_id = $1`, [info.activation_recovery.license_id],
      )).rows).toEqual([{ generation: '1' }])
      expect((await centerPool.query<{ current_generation: string }>(
        `SELECT current_generation::text AS current_generation FROM licenses WHERE id = $1`, [info.activation_recovery.license_id],
      )).rows).toEqual([{ current_generation: '1' }])
      expect((await centerPool.query(`SELECT operation_id FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId])).rowCount)
        .toBe(1)
    } finally {
      await clearCenterMode()
      await fixture.close()
    }
  }, 60_000)

  it('continues one original operation after signed not_found and preserves both request tuples', async () => {
    const fixture = await createRecoveryCase({ name: 'continue-not-found', license: info.activation_continue })
    try {
      const result = await fixture.recoveryClientForCase().continuePendingActivation(fixture.operation.operationId)
      expect(result.query).toMatchObject({ requestAttemptNo: 1, state: 'not_found', outcomeCode: 'OPERATION_NOT_FOUND' })
      expect(result.continuation).toMatchObject({
        requestAttemptNo: 2, state: 'committed', outcomeCode: 'ACTIVATED', committedAttemptNo: 2,
        resultDisposition: 'current_lease', projected: false,
      })
      expect(result.continuation?.operationId).toBe(fixture.operation.operationId)
      const query = await storedRequestBody({
        db: fixture.db, pendingRoot: fixture.pendingRoot, operationId: fixture.operation.operationId, attemptNo: 1,
      })
      const continuation = await storedRequestBody({
        db: fixture.db, pendingRoot: fixture.pendingRoot, operationId: fixture.operation.operationId, attemptNo: 2,
      })
      expect(Object.keys(query.body).sort()).toEqual([
        'attempt_no', 'challenge', 'database_id', 'identity_jkt', 'instance_id', 'intent_digest', 'license_id', 'operation_id', 'public_jwk',
      ])
      expect(Object.keys(continuation.body).sort()).toEqual([
        'activation_code', 'attempt_no', 'challenge', 'database_id', 'identity_jkt', 'instance_id', 'intent_digest',
        'kind', 'license_id', 'operation_id', 'origin', 'public_jwk',
      ])
      expect(continuation.body).toMatchObject({
        operation_id: fixture.operation.operationId,
        intent_digest: fixture.operation.intentDigest,
        attempt_no: 2,
        license_id: info.activation_continue.license_id,
        database_id: fixture.identity.databaseId,
        instance_id: fixture.identity.instanceId,
        identity_jkt: fixture.identity.identityJkt,
        activation_code: info.activation_continue.activation_code,
        origin: null,
        kind: 'activation',
      })
      expect(query.challenge.operation).toBe('query')
      expect(continuation.challenge.operation).toBe('continue')
      expect(continuation.challenge.client_nonce).not.toBe(query.challenge.client_nonce)
      expect(continuation.challenge.server_nonce).not.toBe(query.challenge.server_nonce)
      const outer = decodeJwt((await readLicenseOperationAttemptResponse(
        fixture.db, fixture.pendingRoot, fixture.operation.operationId, 2,
      )).toString('ascii'))
      expect(outer).toMatchObject({
        operation_id: fixture.operation.operationId,
        intent_digest: fixture.operation.intentDigest,
        state: 'committed',
        attempt_no: 2,
        request_nonce_hash: createHash('sha256').update(String(continuation.challenge.server_nonce)).digest('base64url'),
        request_digest: createHash('sha256').update(continuation.requestBytes).digest('base64url'),
        committed_attempt_no: 2,
        committed_request_nonce_hash: createHash('sha256').update(String(continuation.challenge.server_nonce)).digest('base64url'),
        committed_request_digest: createHash('sha256').update(continuation.requestBytes).digest('base64url'),
      })
      const localAttempts = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).orderBy('attempt_no', 'asc').execute()
      expect(localAttempts.map(row => [row.attempt_no, row.purpose, row.send_state])).toEqual([
        [1, 'query', 'response_saved'], [2, 'continue', 'response_saved'],
      ])
      const centerOperation = await centerPool.query<{ state: string; outcome_code: string; response_jws: string }>(
        `SELECT state, outcome_code, response_jws FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId],
      )
      expect(centerOperation.rows).toHaveLength(1)
      expect(centerOperation.rows[0]).toMatchObject({ state: 'committed', outcome_code: 'ACTIVATED' })
      const centerAttempt = await centerPool.query<{
        attempt_no: number; body_digest: string; client_nonce_hash: string; server_nonce_hash: string | null
      }>(`SELECT attempt_no, body_digest, client_nonce_hash, server_nonce_hash FROM license_operation_attempts WHERE operation_id = $1`,
        [fixture.operation.operationId])
      expect(centerAttempt.rows).toEqual([{
        attempt_no: 2,
        body_digest: createHash('sha256').update(continuation.requestBytes).digest('base64url'),
        client_nonce_hash: createHash('sha256').update(String(continuation.challenge.client_nonce)).digest('base64url'),
        server_nonce_hash: createHash('sha256').update(String(continuation.challenge.server_nonce)).digest('base64url'),
      }])
      const archivedResult = await readLicenseOperationAttemptResultJws(fixture.db, fixture.pendingRoot, fixture.operation.operationId, 2)
      expect(archivedResult?.toString('ascii')).toBe(centerOperation.rows[0]!.response_jws)
      const centerActivation = await centerPool.query<{ generation: string }>(
        `SELECT generation::text AS generation FROM license_activations WHERE license_id = $1`, [info.activation_continue.license_id],
      )
      expect(centerActivation.rows).toEqual([{ generation: '1' }])
      const code = await centerPool.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM activation_codes WHERE license_id = $1`, [info.activation_continue.license_id],
      )
      expect(code.rows).toHaveLength(1)
      expect(code.rows[0]!.consumed_at).toBeInstanceOf(Date)
    } finally {
      await clearCenterMode()
      await fixture.close()
    }
  }, 60_000)

  it('resolves a lost continue response by querying the same operation instead of replaying activation', async () => {
    const activation = info.transport_activation_cases[7]!
    const fixture = await createRecoveryCase({ name: 'lost-continue-response', license: activation })
    try {
      await setCenterMode('drop_continue_after_commit')
      await expect(fixture.recoveryClientForCase().recoverPendingActivation(fixture.operation.operationId))
        .rejects.toMatchObject({ code: 'operation_recovery_result_unknown' })
      await clearCenterMode()
      const beforeRetry = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).orderBy('attempt_no', 'asc').execute()
      expect(beforeRetry.map(row => [row.attempt_no, row.purpose, row.send_state])).toEqual([
        [1, 'query', 'response_saved'], [2, 'continue', 'transport_unknown'],
      ])

      const recovered = await fixture.recoveryClientForCase().recoverPendingActivation(fixture.operation.operationId)
      expect(recovered.query).toMatchObject({ requestAttemptNo: 3, state: 'committed', committedAttemptNo: 2 })
      expect(recovered.continuation).toBeNull()
      const attempts = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).orderBy('attempt_no', 'asc').execute()
      expect(attempts.map(row => [row.attempt_no, row.purpose, row.send_state])).toEqual([
        [1, 'query', 'response_saved'], [2, 'continue', 'transport_unknown'], [3, 'query', 'response_saved'],
      ])
      const centerResult = await centerPool.query<{ response_jws: string }>(
        `SELECT response_jws FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId],
      )
      expect((await readLicenseOperationAttemptResultJws(fixture.db, fixture.pendingRoot, fixture.operation.operationId, 2))?.toString('ascii'))
        .toBe(centerResult.rows[0]?.response_jws)
      expect((await centerPool.query(`SELECT operation_id FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId])).rowCount)
        .toBe(1)
      expect((await centerPool.query(`SELECT id FROM license_activations WHERE license_id = $1`, [activation.license_id])).rowCount)
        .toBe(1)
      expect((await centerPool.query<{ current_generation: string }>(
        `SELECT current_generation::text AS current_generation FROM licenses WHERE id = $1`, [activation.license_id],
      )).rows).toEqual([{ current_generation: '1' }])
    } finally {
      await clearCenterMode()
      await fixture.close()
    }
  }, 75_000)

  it('recovers with a one-connection business pool and when concurrent calls saturate it', async () => {
    const fixture = await createRecoveryCase({ name: 'recovery-small-pool', license: info.activation_concurrent })
    try {
      const input = {
        schema: fixture.schema, operationId: fixture.operation.operationId, identityRoot: fixture.identityRoot,
        pendingRoot: fixture.pendingRoot, trustRoot: join(fixture.root, 'trust'), timeoutMs: 25_000,
      }
      const results = await Promise.all((['query', 'parallel', 'busy'] as const).map(async mode => ({
        mode, result: await runRecoveryChild({ ...input, mode, poolMax: mode === 'parallel' ? 2 : 1 }),
      })))
      expect(results.map(({ mode, result }) => ({ mode, code: result.code, signal: result.signal })))
        .toEqual(['query', 'parallel', 'busy'].map(mode => ({ mode, code: 0, signal: null })))
      const attempts = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).orderBy('attempt_no', 'asc').execute()
      expect(attempts.map(row => [row.attempt_no, row.purpose])).toEqual([
        [1, 'query'], [2, 'query'], [3, 'query'], [4, 'query'],
      ])
    } finally { await fixture.close() }
  }, 40_000)

  it.each(['before_http_send', 'after_http_response'] as const)('fails closed after lock loss at %s and recovers with a new attempt', async (killStage) => {
    const fixture = await createRecoveryCase({ name: `recovery-lock-lost-${killStage}`, license: info.activation_concurrent })
    let killed = false
    try {
      const client = fixture.recoveryClientForCase(async stage => {
        if (stage !== killStage || killed) return
        const result = await fixture.pool.query<{ killed: boolean }>(
          `SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
           WHERE application_name = 'aikayun-license-recovery-lock' AND pid <> pg_backend_pid()`,
        )
        expect(result.rows).toEqual([{ killed: true }])
        killed = true
      })
      await expect(client.queryPendingActivation(fixture.operation.operationId)).rejects.toMatchObject({ code: 'operation_recovery_result_unknown' })
      const first = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).where('attempt_no', '=', 1).executeTakeFirstOrThrow()
      expect(first.send_state).toBe('transport_unknown')
      const result = await fixture.recoveryClientForCase().queryPendingActivation(fixture.operation.operationId)
      expect(result).toMatchObject({ state: 'not_found', requestAttemptNo: 2 })
    } finally { await fixture.close() }
  }, 40_000)

  it('bounds a blocked advisory lock wait and permits a later recovery', async () => {
    const fixture = await createRecoveryCase({ name: 'recovery-lock-timeout', license: info.activation_concurrent })
    const blocker = await fixture.pool.connect()
    try {
      await blocker.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`aikayun-license-recovery:${fixture.operation.operationId}`])
      const start = Date.now()
      await expect(fixture.recoveryClientForCase().queryPendingActivation(fixture.operation.operationId)).rejects.toBeTruthy()
      expect(Date.now() - start).toBeLessThan(25_000)
      expect(await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).execute()).toHaveLength(0)
      await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`aikayun-license-recovery:${fixture.operation.operationId}`])
      const result = await fixture.recoveryClientForCase().queryPendingActivation(fixture.operation.operationId)
      expect(result).toMatchObject({ state: 'not_found', requestAttemptNo: 1 })
    } finally { blocker.release(); await fixture.close() }
  }, 45_000)

  it('serializes two independent API processes restoring one activation operation', async () => {
    const fixture = await createRecoveryCase({ name: 'parallel-recovery-processes', license: info.activation_concurrent })
    try {
      const childInput = {
        schema: fixture.schema,
        operationId: fixture.operation.operationId,
        identityRoot: fixture.identityRoot,
        pendingRoot: fixture.pendingRoot,
        trustRoot: join(fixture.root, 'trust'),
        poolMax: 1,
      }
      const [left, right] = await Promise.all([
        runRecoveryChild(childInput),
        runRecoveryChild(childInput),
      ])
      expect(left.code, left.stderr).toBe(0)
      expect(right.code, right.stderr).toBe(0)
      const outcomes = [JSON.parse(left.stdout.trim()), JSON.parse(right.stdout.trim())] as Array<{
        query: { state: string; requestAttemptNo: number }
        continuation: { state: string; requestAttemptNo: number } | null
      }>
      expect(outcomes.filter(outcome => outcome.continuation?.state === 'committed')).toHaveLength(1)
      expect(outcomes.filter(outcome => outcome.query.state === 'committed')).toHaveLength(1)
      const attempts = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).orderBy('attempt_no', 'asc').execute()
      expect(attempts.map(row => [row.attempt_no, row.purpose, row.send_state])).toEqual([
        [1, 'query', 'response_saved'], [2, 'continue', 'response_saved'], [3, 'query', 'response_saved'],
      ])
      expect((await centerPool.query(`SELECT operation_id FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId])).rowCount)
        .toBe(1)
      expect((await centerPool.query(`SELECT id FROM license_activations WHERE license_id = $1`, [info.activation_concurrent.license_id])).rowCount)
        .toBe(1)
      expect((await centerPool.query<{ current_generation: string }>(
        `SELECT current_generation::text AS current_generation FROM licenses WHERE id = $1`, [info.activation_concurrent.license_id],
      )).rows).toEqual([{ current_generation: '1' }])
    } finally {
      await clearCenterMode()
      await fixture.close()
    }
  }, 90_000)

  it('keeps a delayed original activation racing query and continue inside the same center operation lock', async () => {
    const fixture = await createRecoveryCase({ name: 'late-activation-race', license: info.activation_race })
    try {
      await rm(info.activation_entered_path, { force: true })
      await rm(info.activation_finished_path, { force: true })
      await setCenterMode('delay_activation')
      const originalPromise = fixture.activationClientForCase().submitPendingActivation(fixture.operation.operationId)
        .then(value => ({ value }), error => ({ error }))
      await waitForFile(info.activation_entered_path)
      const recovery = await fixture.recoveryClientForCase().continuePendingActivation(fixture.operation.operationId)
      expect(recovery.query.state).toBe('not_found')
      expect(recovery.continuation).toMatchObject({ state: 'committed', requestAttemptNo: 3, committedAttemptNo: 3 })

      await setCenterMode('release_activation')
      await waitForFile(info.activation_finished_path)
      const original = await originalPromise
      if ('error' in original) expect(original.error).toBeTruthy()
      const attempts = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).orderBy('attempt_no', 'asc').execute()
      expect(attempts.map(row => [row.attempt_no, row.purpose])).toEqual([
        [1, 'activation'], [2, 'query'], [3, 'continue'],
      ])
      expect(attempts[1]?.send_state).toBe('response_saved')
      expect(attempts[2]?.send_state).toBe('response_saved')
      const parent = await fixture.db.selectFrom('local_license_operations').select(['state', 'response_attempt_no'])
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      expect(parent.response_attempt_no).toBe(3)
      expect(parent.state).toBe('response_saved')
      const continuedReceipt = await readLicenseOperationAttemptResponse(fixture.db, fixture.pendingRoot, fixture.operation.operationId, 3)
      expect(await readSavedLicenseOperationResponse(fixture.db, fixture.pendingRoot, fixture.operation.operationId)).toEqual(continuedReceipt)
      expect((await centerPool.query(`SELECT operation_id FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId])).rowCount)
        .toBe(1)
      expect((await centerPool.query(`SELECT id FROM license_activations WHERE license_id = $1`, [info.activation_race.license_id])).rowCount)
        .toBe(1)
      expect((await centerPool.query<{ current_generation: string }>(
        `SELECT current_generation::text AS current_generation FROM licenses WHERE id = $1`, [info.activation_race.license_id],
      )).rows).toEqual([{ current_generation: '1' }])
      const code = await centerPool.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM activation_codes WHERE license_id = $1`, [info.activation_race.license_id],
      )
      expect(code.rows[0]?.consumed_at).toBeInstanceOf(Date)
    } finally {
      await clearCenterMode()
      await fixture.close()
    }
  }, 60_000)

  it('continues the same operation after a not_found and settles the frozen R3 HTTP 200 rejection', async () => {
    const fixture = await createRecoveryCase({
      name: 'unsigned-invalid-activation',
      license: info.activation_protocol_resolution,
      activationCode: randomBytes(32).toString('base64url'),
    })
    try {
      const recovery = await fixture.recoveryClientForCase().recoverPendingActivation(fixture.operation.operationId)
      expect(recovery.query).toMatchObject({ state: 'not_found', requestAttemptNo: 1 })
      expect(recovery.continuation).toMatchObject({ state: 'rejected', outcomeCode: 'ACTIVATION_AUTHORIZATION_INVALID',
        requestAttemptNo: 2, committedAttemptNo: null, signatureVerified: true, projected: false })
      const local = await fixture.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      const attempts = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).orderBy('attempt_no', 'asc').execute()
      expect(local).toMatchObject({ state: 'terminal', response_attempt_no: 2 })
      expect(local.encrypted_center_evidence).not.toBeNull()
      expect(local.center_evidence_key_id).not.toBeNull()
      expect(local.center_evidence_digest).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(local.finalized_at).toBeInstanceOf(Date)
      expect(attempts.map(row => [row.attempt_no, row.purpose, row.send_state])).toEqual([
        [1, 'query', 'response_saved'], [2, 'continue', 'response_saved'],
      ])
      const continueRequest = await storedRequestBody({
        db: fixture.db, pendingRoot: fixture.pendingRoot, operationId: fixture.operation.operationId, attemptNo: 2,
      })
      expect(Object.keys(continueRequest.body).sort()).toEqual([
        'activation_code', 'attempt_no', 'challenge', 'database_id', 'identity_jkt', 'instance_id', 'intent_digest',
        'kind', 'license_id', 'operation_id', 'origin', 'public_jwk',
      ])
      expect(continueRequest.body.activation_code).not.toBe(info.activation_protocol_resolution.activation_code)
      expect(continueRequest.body.kind).toBe('activation')
      expect((await centerPool.query(
        `SELECT operation_id FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId],
      )).rowCount).toBe(0)
      expect((await centerPool.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM activation_codes WHERE license_id = $1`, [info.activation_protocol_resolution.license_id],
      )).rows[0]?.consumed_at).toBeNull()
      const archivedEvidence = await decryptLicensePendingBytes(fixture.pendingRoot, {
        operationId: fixture.operation.operationId, record: 'operation', field: 'center_evidence',
      }, { keyId: local.center_evidence_key_id!, ciphertext: local.encrypted_center_evidence! })
      expect(archivedEvidence).toEqual(await readLicenseOperationAttemptResponse(
        fixture.db, fixture.pendingRoot, fixture.operation.operationId, 2,
      ))
      expect(createHash('sha256').update(archivedEvidence).digest('base64url')).toBe(local.center_evidence_digest)
      const replacement = await createOrLoadActivationOperation(fixture.db, fixture.pendingRoot, {
        operationId: randomUUID(), licenseId: info.activation_protocol_resolution.license_id,
        activationCode: info.activation_protocol_resolution.activation_code,
        databaseId: fixture.identity.databaseId!, instanceId: fixture.identity.instanceId!,
        identityJkt: fixture.identity.identityJkt!, origin: null,
      })
      expect(replacement).toMatchObject({ state: 'pending', created: true })
      const activated = await fixture.activationClientForCase().submitPendingActivation(replacement.operationId)
      expect(activated).toMatchObject({ purpose: 'verified_activation_lease_unprojected', signatureVerified: true, projected: false })
      expect((await fixture.db.selectFrom('local_license_operations').select('state')
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()).state).toBe('terminal')
      expect((await fixture.db.selectFrom('local_license_operations').select('state')
        .where('operation_id', '=', replacement.operationId).executeTakeFirstOrThrow()).state).toBe('response_saved')
    } finally {
      await clearCenterMode()
      await fixture.close()
    }
  }, 60_000)

  it('settles direct signed rejection for wrong, expired, revoked, consumed, and cross-license codes, then activates a new operation with a replacement code', async () => {
    for (const scenario of info.activation_retry_cases) {
      const fixture = await createRecoveryCase({
        name: `direct-reject-${scenario.variant}`,
        license: { license_id: scenario.license_id, activation_code: scenario.rejected_code },
        activationCode: scenario.rejected_code,
      })
      try {
        const rejected = await fixture.activationClientForCase().submitPendingActivation(fixture.operation.operationId)
        expect(rejected).toMatchObject({
          purpose: 'verified_activation_rejection_unprojected', operationId: fixture.operation.operationId,
          attemptNo: 1, outcomeCode: 'ACTIVATION_AUTHORIZATION_INVALID', signatureVerified: true, projected: false,
        })
        const old = await fixture.db.selectFrom('local_license_operations').selectAll()
          .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
        expect(old).toMatchObject({ state: 'terminal', response_attempt_no: 1 })
        expect(old.encrypted_center_evidence).not.toBeNull()
        const response = await readLicenseOperationAttemptResponse(fixture.db, fixture.pendingRoot, fixture.operation.operationId, 1)
        const archived = await decryptLicensePendingBytes(fixture.pendingRoot, {
          operationId: fixture.operation.operationId, record: 'operation', field: 'center_evidence',
        }, { keyId: old.center_evidence_key_id!, ciphertext: old.encrypted_center_evidence! })
        expect(archived).toEqual(response)
        expect(createHash('sha256').update(archived).digest('base64url')).toBe(old.center_evidence_digest)
        expect((await centerPool.query(
          `SELECT operation_id FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId],
        )).rowCount).toBe(0)

        const correctCode = await issueCenterReplacementCode(scenario.license_id)
        const replacement = await createOrLoadActivationOperation(fixture.db, fixture.pendingRoot, {
          operationId: randomUUID(), licenseId: scenario.license_id, activationCode: correctCode,
          databaseId: fixture.identity.databaseId!, instanceId: fixture.identity.instanceId!,
          identityJkt: fixture.identity.identityJkt!, origin: null,
        })
        expect(replacement).toMatchObject({ state: 'pending', created: true })
        const activated = await fixture.activationClientForCase().submitPendingActivation(replacement.operationId)
        expect(activated).toMatchObject({
          purpose: 'verified_activation_lease_unprojected', operationId: replacement.operationId,
          signatureVerified: true, projected: false,
        })
        expect((await fixture.db.selectFrom('local_license_operations').select('state')
          .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()).state).toBe('terminal')
        expect((await fixture.db.selectFrom('local_license_operations').select('state')
          .where('operation_id', '=', replacement.operationId).executeTakeFirstOrThrow()).state).toBe('response_saved')
      } finally {
        await fixture.close()
      }
    }
  }, 180_000)

  it('recovers a lost terminal COMMIT acknowledgement by matching the same encrypted evidence and is idempotent', async () => {
    const scenario = info.activation_retry_cases.find(item => item.variant === 'wrong')!
    const fixture = await createRecoveryCase({
      name: 'terminal-commit-ack-lost',
      license: { license_id: scenario.license_id, activation_code: scenario.rejected_code },
      activationCode: scenario.rejected_code,
    })
    try {
      const lostAck = loseTerminalCommitAcknowledgement(fixture.db, fixture.operation.operationId)
      const outcome = await fixture.activationClientForCase(undefined, lostAck.db).submitPendingActivation(fixture.operation.operationId)
      expect(outcome).toMatchObject({ outcomeCode: 'ACTIVATION_AUTHORIZATION_INVALID', signatureVerified: true })
      expect(lostAck.wasLost()).toBe(true)
      const terminal = await fixture.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      expect(terminal.state).toBe('terminal')
      const response = await readLicenseOperationAttemptResponse(fixture.db, fixture.pendingRoot, fixture.operation.operationId, 1)
      expect(await readLicenseOperationCenterEvidence(fixture.db, fixture.pendingRoot, fixture.operation.operationId)).toEqual(response)

      const candidate = await fixture.trustStore.getCandidateForTimeBootstrap()
      if (!candidate) throw new Error('R3 test trust bundle is unavailable')
      const time = await fetchTrustedTimeAnchor(releaseConfig, candidate, { testCa: info.tls_ca, testLookup: localTestLookup })
      const options = {
        db: fixture.db, pool: fixture.pool, identityRoot: fixture.identityRoot, pendingKeyRoot: fixture.pendingRoot,
        releaseConfig, trustStore: fixture.trustStore, testTls: testTlsOptions(),
      }
      await finalizeTrustedActivationRejection({
        options, operationId: fixture.operation.operationId, evidenceAttemptNo: 1, readTrustedTime: () => time.assertFresh(),
      })
      expect(await readLicenseOperationCenterEvidence(fixture.db, fixture.pendingRoot, fixture.operation.operationId)).toEqual(response)
    } finally { await fixture.close() }
  }, 60_000)

  it('serializes independent processes finalizing the same saved R3 rejection', async () => {
    const scenario = info.activation_finalization_cases[0]!
    const fixture = await createRecoveryCase({
      name: 'parallel-terminal-finalization',
      license: scenario,
      activationCode: randomBytes(32).toString('base64url'),
    })
    try {
      await expect(fixture.activationClientForCase(stage => {
        if (stage === 'after_response_saved') throw new Error('fixture_stop_before_rejection_finalization')
      }).submitPendingActivation(fixture.operation.operationId)).rejects.toBeTruthy()
      const saved = await fixture.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      expect(saved.state).toBe('response_saved')
      const leftTrustRoot = join(fixture.root, 'trust-left')
      const rightTrustRoot = join(fixture.root, 'trust-right')
      await Promise.all([
        cp(join(fixture.root, 'trust'), leftTrustRoot, { recursive: true }),
        cp(join(fixture.root, 'trust'), rightTrustRoot, { recursive: true }),
      ])
      const results = await Promise.all([1, 2].map((_, index) => runFinalizationChild({
        schema: fixture.schema, operationId: fixture.operation.operationId, evidenceAttemptNo: 1,
        identityRoot: fixture.identityRoot, pendingRoot: fixture.pendingRoot,
        trustRoot: index === 0 ? leftTrustRoot : rightTrustRoot,
      })))
      for (const result of results) expect(result.code, result.stderr).toBe(0)
      expect(results.map(result => result.signal)).toEqual([null, null])
      const terminal = await fixture.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      expect(terminal.state).toBe('terminal')
      const raw = await readLicenseOperationAttemptResponse(fixture.db, fixture.pendingRoot, fixture.operation.operationId, 1)
      expect(await readLicenseOperationCenterEvidence(fixture.db, fixture.pendingRoot, fixture.operation.operationId)).toEqual(raw)
      expect(await fixture.db.selectFrom('local_license_operation_attempts').select('attempt_no')
        .where('operation_id', '=', fixture.operation.operationId).execute()).toEqual([{ attempt_no: 1 }])
      const replacement = await createOrLoadActivationOperation(fixture.db, fixture.pendingRoot, {
        operationId: randomUUID(), licenseId: scenario.license_id,
        activationCode: await issueCenterReplacementCode(scenario.license_id),
        databaseId: fixture.identity.databaseId!, instanceId: fixture.identity.instanceId!,
        identityJkt: fixture.identity.identityJkt!, origin: null,
      })
      expect(replacement).toMatchObject({ state: 'pending', created: true })
    } finally { await fixture.close() }
  }, 90_000)

  it.each(['after_terminal_row_update', 'after_terminal_evidence_commit'] as const)(
    'recovers the trusted rejection after SIGKILL at %s', async checkpoint => {
      const scenario = info.activation_finalization_cases[checkpoint === 'after_terminal_row_update' ? 1 : 2]!
      const fixture = await createRecoveryCase({
        name: `terminal-crash-${checkpoint}`,
        license: scenario,
        activationCode: randomBytes(32).toString('base64url'),
      })
      try {
        const killed = await runActivationCrashChild({
          checkpoint, schema: fixture.schema, operationId: fixture.operation.operationId,
          identityRoot: fixture.identityRoot, pendingRoot: fixture.pendingRoot, trustRoot: join(fixture.root, 'trust'),
        })
        expect(killed.signal, killed.stderr).toBe('SIGKILL')
        let operation = await fixture.db.selectFrom('local_license_operations').selectAll()
          .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
        if (checkpoint === 'after_terminal_row_update') {
          expect(operation.state).toBe('response_saved')
          await fixture.recoveryClientForCase().recoverPendingActivation(fixture.operation.operationId)
          operation = await fixture.db.selectFrom('local_license_operations').selectAll()
            .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
        }
        expect(operation.state).toBe('terminal')
        const evidence = await readLicenseOperationCenterEvidence(fixture.db, fixture.pendingRoot, fixture.operation.operationId)
        expect(evidence).toEqual(await readLicenseOperationAttemptResponse(
          fixture.db, fixture.pendingRoot, fixture.operation.operationId, 1,
        ))
        const replacement = await createOrLoadActivationOperation(fixture.db, fixture.pendingRoot, {
          operationId: randomUUID(), licenseId: scenario.license_id,
          activationCode: await issueCenterReplacementCode(scenario.license_id),
          databaseId: fixture.identity.databaseId!, instanceId: fixture.identity.instanceId!,
          identityJkt: fixture.identity.identityJkt!, origin: null,
        })
        expect(replacement).toMatchObject({ state: 'pending', created: true })
      } finally { await fixture.close() }
    }, 90_000,
  )

  it('recovers a lost direct rejection through signed not_found and same-operation continue before reactivation', async () => {
    const scenario = info.activation_finalization_cases[3]!
    const fixture = await createRecoveryCase({
      name: 'lost-direct-r3-rejection',
      license: scenario,
      activationCode: randomBytes(32).toString('base64url'),
    })
    try {
      await setCenterMode('drop_activation_rejection')
      await expect(fixture.activationClientForCase().submitPendingActivation(fixture.operation.operationId))
        .rejects.toMatchObject({ code: 'activation_result_unknown' })
      await clearCenterMode()
      const original = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      expect(original).toMatchObject({ attempt_no: 1, purpose: 'activation', send_state: 'transport_unknown' })
      const recovered = await fixture.recoveryClientForCase().recoverPendingActivation(fixture.operation.operationId)
      expect(recovered.query).toMatchObject({ state: 'not_found', requestAttemptNo: 2 })
      expect(recovered.continuation).toMatchObject({
        state: 'rejected', outcomeCode: 'ACTIVATION_AUTHORIZATION_INVALID', requestAttemptNo: 3,
        committedAttemptNo: null, signatureVerified: true,
      })
      const terminal = await fixture.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      expect(terminal).toMatchObject({ state: 'terminal', response_attempt_no: 3 })
      const replacementCode = await issueCenterReplacementCode(scenario.license_id)
      const replacement = await createOrLoadActivationOperation(fixture.db, fixture.pendingRoot, {
        operationId: randomUUID(), licenseId: scenario.license_id, activationCode: replacementCode,
        databaseId: fixture.identity.databaseId!, instanceId: fixture.identity.instanceId!,
        identityJkt: fixture.identity.identityJkt!, origin: null,
      })
      expect((await fixture.activationClientForCase().submitPendingActivation(replacement.operationId)).purpose)
        .toBe('verified_activation_lease_unprojected')
    } finally {
      await clearCenterMode()
      await fixture.close()
    }
  }, 90_000)

  it('keeps a late original activation response from overwriting a terminal continue rejection', async () => {
    const scenario = info.activation_finalization_cases[5]!
    const fixture = await createRecoveryCase({
      name: 'late-activation-after-terminal-rejection',
      license: scenario,
      activationCode: randomBytes(32).toString('base64url'),
    })
    try {
      await rm(info.activation_entered_path, { force: true })
      await rm(info.activation_finished_path, { force: true })
      await setCenterMode('delay_activation')
      const originalPromise = fixture.activationClientForCase().submitPendingActivation(fixture.operation.operationId)
        .then(value => ({ value }), error => ({ error }))
      await waitForFile(info.activation_entered_path)

      const recovered = await fixture.recoveryClientForCase().recoverPendingActivation(fixture.operation.operationId)
      expect(recovered.query).toMatchObject({ state: 'not_found' })
      expect(recovered.continuation).toMatchObject({
        state: 'rejected', outcomeCode: 'ACTIVATION_AUTHORIZATION_INVALID', committedAttemptNo: null,
      })
      const terminalBeforeLateResponse = await fixture.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      expect(terminalBeforeLateResponse).toMatchObject({ state: 'terminal', response_attempt_no: 3 })
      const evidenceBeforeLateResponse = await readLicenseOperationCenterEvidence(
        fixture.db, fixture.pendingRoot, fixture.operation.operationId,
      )
      expect(evidenceBeforeLateResponse).toEqual(await readLicenseOperationAttemptResponse(
        fixture.db, fixture.pendingRoot, fixture.operation.operationId, 3,
      ))

      await setCenterMode('release_activation')
      await waitForFile(info.activation_finished_path)
      const late = await originalPromise
      expect('error' in late).toBe(true)
      const terminalAfterLateResponse = await fixture.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      expect(terminalAfterLateResponse).toMatchObject({ state: 'terminal', response_attempt_no: 3 })
      expect(await readLicenseOperationCenterEvidence(fixture.db, fixture.pendingRoot, fixture.operation.operationId))
        .toEqual(evidenceBeforeLateResponse)
      const attempts = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).orderBy('attempt_no', 'asc').execute()
      expect(attempts.map(attempt => [attempt.attempt_no, attempt.purpose, attempt.send_state])).toEqual([
        [1, 'activation', 'sent'], [2, 'query', 'response_saved'], [3, 'continue', 'response_saved'],
      ])
      expect((await centerPool.query(
        `SELECT operation_id FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId],
      )).rowCount).toBe(0)
      expect((await centerPool.query(
        `SELECT id FROM license_activations WHERE license_id = $1`, [scenario.license_id],
      )).rowCount).toBe(0)
    } finally {
      await clearCenterMode()
      await fixture.close()
    }
  }, 75_000)

  it('keeps a successfully activated operation response_saved when a later query carries an invalid unrecorded rejection', async () => {
    const fixture = await createRecoveryCase({ name: 'committed-rejection-conflict', license: info.activation_committed_conflict })
    try {
      const activated = await fixture.activationClientForCase().submitPendingActivation(fixture.operation.operationId)
      expect(activated.purpose).toBe('verified_activation_lease_unprojected')
      await setCenterMode('query_unrecorded_rejection')
      await expect(fixture.recoveryClientForCase().queryPendingActivation(fixture.operation.operationId))
        .rejects.toMatchObject({ code: 'operation_recovery_commit_binding_invalid' })
      const local = await fixture.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      expect(local).toMatchObject({ state: 'response_saved', response_attempt_no: 2 })
      expect(local.encrypted_center_evidence).toBeNull()
      const lease = await readLicenseOperationAttemptResponse(fixture.db, fixture.pendingRoot, fixture.operation.operationId, 1)
      expect(decodeProtectedHeader(lease.toString('ascii')).typ).toBe('aikayun-license+jwt')
      const center = await centerPool.query<{ state: string }>(
        `SELECT state FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId],
      )
      expect(center.rows).toEqual([{ state: 'committed' }])
    } finally {
      await clearCenterMode()
      await fixture.close()
    }
  }, 60_000)

  it('rejects a signed unrecorded rejection for any outcome other than the R3 invalid-authorization exception', async () => {
    const fixture = await createRecoveryCase({
      name: 'other-unrecorded-rejection', license: info.activation_protocol_resolution,
      activationCode: randomBytes(32).toString('base64url'),
    })
    try {
      await setCenterMode('other_unrecorded_rejection')
      await expect(fixture.recoveryClientForCase().recoverPendingActivation(fixture.operation.operationId))
        .rejects.toMatchObject({ code: 'operation_recovery_commit_binding_invalid' })
      const parent = await fixture.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      expect(parent).toMatchObject({ state: 'response_saved', response_attempt_no: 2 })
      expect(parent.encrypted_center_evidence).toBeNull()
      const receipt = await readLicenseOperationAttemptResponse(fixture.db, fixture.pendingRoot, fixture.operation.operationId, 2)
      expect(decodeJwt(receipt.toString('ascii'))).toMatchObject({ state: 'rejected', outcome_code: 'LICENSE_REVOKED' })
    } finally {
      await clearCenterMode()
      await fixture.close()
    }
  }, 60_000)

  it('recognizes an expired signed R3 rejection only to continue the original operation', async () => {
    const scenario = info.activation_finalization_cases[4]!
    const fixture = await createRecoveryCase({
      name: 'expired-unrecorded-rejection', license: scenario,
      activationCode: randomBytes(32).toString('base64url'),
    })
    try {
      await setCenterMode('expired_unrecorded_rejection')
      await expect(fixture.recoveryClientForCase().recoverPendingActivation(fixture.operation.operationId)).rejects.toBeTruthy()
      await clearCenterMode()
      const recovered = await fixture.recoveryClientForCase().recoverPendingActivation(fixture.operation.operationId)
      expect(recovered.query).toMatchObject({ state: 'not_found', requestAttemptNo: 3 })
      expect(recovered.continuation).toMatchObject({
        state: 'rejected', outcomeCode: 'ACTIVATION_AUTHORIZATION_INVALID', requestAttemptNo: 4, committedAttemptNo: null,
      })
      const parent = await fixture.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      expect(parent).toMatchObject({ state: 'terminal', response_attempt_no: 4 })
      expect(parent.encrypted_center_evidence).not.toBeNull()
      const replacement = await createOrLoadActivationOperation(fixture.db, fixture.pendingRoot, {
        operationId: randomUUID(), licenseId: scenario.license_id,
        activationCode: scenario.activation_code,
        databaseId: fixture.identity.databaseId!, instanceId: fixture.identity.instanceId!,
        identityJkt: fixture.identity.identityJkt!, origin: null,
      })
      expect((await fixture.activationClientForCase().submitPendingActivation(replacement.operationId)).purpose)
        .toBe('verified_activation_lease_unprojected')
    } finally {
      await clearCenterMode()
      await fixture.close()
    }
  }, 60_000)

  it('keeps unsigned 5xx/429 and malformed signed query receipts unknown after archiving their raw bytes', async () => {
    const modes = [
      { mode: 'query_server_error', saved: false },
      { mode: 'query_rate_limit', saved: false },
      { mode: 'forged_actor', saved: true, code: 'operation_recovery_receipt_binding_invalid' },
      { mode: 'forged_operation', saved: true, code: 'operation_recovery_receipt_binding_invalid' },
      { mode: 'forged_committed_attempt', saved: true, code: 'operation_recovery_commit_binding_invalid' },
      { mode: 'forged_not_found_result', saved: true, code: 'operation_recovery_not_found_invalid' },
      { mode: 'wrong_request_digest', saved: true, code: 'operation_recovery_receipt_binding_invalid' },
      { mode: 'wrong_receipt_signature', saved: true },
      { mode: 'wrong_receipt_kid', saved: true },
    ] as const
    for (const [index, scenario] of modes.entries()) {
      const fixture = await createRecoveryCase({ name: `invalid-query-${index}`, license: info.activation_expired_challenge })
      try {
        await setCenterMode(scenario.mode)
        const request = fixture.recoveryClientForCase().queryPendingActivation(fixture.operation.operationId)
        if ('code' in scenario) await expect(request).rejects.toMatchObject({ code: scenario.code })
        else await expect(request).rejects.toBeTruthy()
        const local = await fixture.db.selectFrom('local_license_operations').selectAll()
          .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
        const attempt = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
          .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
        expect(local.state).toBe(scenario.saved ? 'response_saved' : 'pending')
        expect(attempt).toMatchObject({ attempt_no: 1, purpose: 'query', send_state: scenario.saved ? 'response_saved' : 'transport_unknown' })
        if (scenario.saved) {
          const raw = await readLicenseOperationAttemptResponse(fixture.db, fixture.pendingRoot, fixture.operation.operationId, 1)
          expect(raw.toString('ascii').split('.')).toHaveLength(3)
          expect(Buffer.concat([attempt.encrypted_response!])).not.toContain(raw)
        }
        expect((await centerPool.query(
          `SELECT operation_id FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId],
        )).rowCount).toBe(0)
      } finally {
        await clearCenterMode()
        await fixture.close()
      }
    }
  }, 120_000)

  it('keeps an expired original result as historical evidence without restoring lease permission', async () => {
    const activation = info.transport_activation_cases[8]!
    const fixture = await createRecoveryCase({ name: 'expired-original-result', license: activation })
    try {
      await setCenterMode('drop_after_commit')
      await expect(fixture.activationClientForCase().submitPendingActivation(fixture.operation.operationId))
        .rejects.toMatchObject({ code: 'activation_result_unknown' })
      await setCenterMode('expire_saved_result')
      const evidence = await fixture.recoveryClientForCase().queryPendingActivation(fixture.operation.operationId)
      await clearCenterMode()
      expect(evidence).toMatchObject({ state: 'committed', committedAttemptNo: 1, resultDisposition: 'historical_only', projected: false })
      expect('allow' in evidence).toBe(false)
      expect('grants' in evidence).toBe(false)
      const result = await readLicenseOperationAttemptResultJws(fixture.db, fixture.pendingRoot, fixture.operation.operationId, 1)
      expect(result).not.toBeNull()
      const claims = decodeJwt(result!.toString('ascii'))
      expect(claims.exp).toBeLessThan(Math.floor(Date.now() / 1000))
      const centerStored = await centerPool.query<{ response_jws: string }>(
        `SELECT response_jws FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId],
      )
      expect(result?.toString('ascii')).toBe(centerStored.rows[0]?.response_jws)
      expect((await centerPool.query<{ current_generation: string }>(
        `SELECT current_generation::text AS current_generation FROM licenses WHERE id = $1`, [activation.license_id],
      )).rows).toEqual([{ current_generation: '1' }])
    } finally {
      await clearCenterMode()
      await fixture.close()
    }
  }, 60_000)

  it('restarts safely after API SIGKILL at query/continue archive boundaries and unknown PostgreSQL commit acknowledgement', async () => {
    const cases = [
      { name: 'query-attempt-commit', license: info.transport_activation_cases[9]!, checkpoint: 'after_attempt_commit' as const, occurrence: 1 },
      { name: 'query-response-commit', license: info.transport_activation_cases[10]!, checkpoint: 'after_response_saved' as const, occurrence: 1 },
      { name: 'continue-response-commit', license: info.transport_activation_cases[11]!, checkpoint: 'after_response_saved' as const, occurrence: 2 },
    ]
    for (const scenario of cases) {
      const fixture = await createRecoveryCase({ name: scenario.name, license: scenario.license })
      try {
        const killed = await runRecoveryChild({
          checkpoint: scenario.checkpoint, occurrence: scenario.occurrence, schema: fixture.schema,
          operationId: fixture.operation.operationId, identityRoot: fixture.identityRoot,
          pendingRoot: fixture.pendingRoot, trustRoot: join(fixture.root, 'trust'),
        })
        expect(killed.signal, `${scenario.name}: ${killed.stderr}`).toBe('SIGKILL')
        const durableBeforeRestart = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
          .where('operation_id', '=', fixture.operation.operationId).orderBy('attempt_no', 'asc').execute()
        expect(durableBeforeRestart.length).toBeGreaterThan(0)
        const result = await fixture.recoveryClientForCase().recoverPendingActivation(fixture.operation.operationId)
        if (scenario.name === 'continue-response-commit') {
          expect(result.query.state).toBe('committed')
          expect(result.continuation).toBeNull()
        } else {
          expect(result.query.state).toBe('not_found')
          expect(result.continuation).toMatchObject({ state: 'committed' })
        }
        const attempts = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
          .where('operation_id', '=', fixture.operation.operationId).orderBy('attempt_no', 'asc').execute()
        expect(attempts.every((row, index) => row.attempt_no === index + 1)).toBe(true)
        const centerOperations = await centerPool.query<{ operation_id: string; state: string }>(
          `SELECT operation_id, state FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId],
        )
        expect(centerOperations.rows).toEqual([{ operation_id: fixture.operation.operationId, state: 'committed' }])
        expect((await centerPool.query(`SELECT id FROM license_activations WHERE license_id = $1`, [scenario.license.license_id])).rowCount)
          .toBe(1)
        expect((await centerPool.query<{ current_generation: string }>(
          `SELECT current_generation::text AS current_generation FROM licenses WHERE id = $1`, [scenario.license.license_id],
        )).rows).toEqual([{ current_generation: '1' }])
      } finally {
        await clearCenterMode()
        await fixture.close()
      }
    }

    const fixture = await createRecoveryCase({ name: 'unknown-recovery-pg-commit-ack', license: info.transport_activation_cases[12]! })
    try {
      const lostAckClient = recoveryClient({
        db: loseCommitAcknowledgementAfterWrite(fixture.db), pool: fixture.pool,
        identityRoot: fixture.identityRoot, pendingKeyRoot: fixture.pendingRoot, trustStore: fixture.trustStore,
      })
      await expect(lostAckClient.queryPendingActivation(fixture.operation.operationId))
        .rejects.toMatchObject({ code: 'operation_recovery_failed' })
      const committedAttempt = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).executeTakeFirstOrThrow()
      expect(committedAttempt).toMatchObject({ attempt_no: 1, purpose: 'query', send_state: 'prepared' })
      expect((await centerPool.query(
        `SELECT operation_id FROM license_operations WHERE operation_id = $1`, [fixture.operation.operationId],
      )).rowCount).toBe(0)
      const recovered = await fixture.recoveryClientForCase().recoverPendingActivation(fixture.operation.operationId)
      expect(recovered.query.state).toBe('not_found')
      expect(recovered.continuation).toMatchObject({ state: 'committed' })
      const attempts = await fixture.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', fixture.operation.operationId).orderBy('attempt_no', 'asc').execute()
      expect(attempts.map(row => [row.attempt_no, row.purpose, row.send_state])).toEqual([
        [1, 'query', 'prepared'], [2, 'query', 'response_saved'], [3, 'continue', 'response_saved'],
      ])
    } finally {
      await clearCenterMode()
      await fixture.close()
    }
  }, 180_000)

  it('archives and verifies a center-signed business rejection without treating HTTP 409 as local authority', async () => {
    const schema = `client_activation_reject_${randomUUID().replaceAll('-', '')}`
    const root = join(sandboxRoot, 'activation-rejected-case')
    const rejectIdentityRoot = join(root, 'identity')
    const rejectPendingRoot = join(root, 'pending')
    const rejectTrustRoot = join(root, 'trust')
    await mkdir(rejectIdentityRoot, { recursive: true, mode: 0o700 })
    await mkdir(rejectTrustRoot, { recursive: true, mode: 0o700 })
    await apiAdminPool.query(`CREATE SCHEMA "${schema}"`)
    const rejectPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}`, max: 5 })
    const rejectDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: rejectPool }) })
    try {
      await installationIdentityMigration.up(rejectDb)
      await localLicenseOperationsMigration.up(rejectDb)
      await singleInitialActivationAttemptMigration.up(rejectDb)
      await licenseOperationResultArchiveMigration.up(rejectDb)
      await licenseResultArchivePresenceMigration.up(rejectDb)
      await licenseOperationTrustedRejectionMigration.up(rejectDb)
      const rejectedIdentity = await initializeInstallationIdentity(rejectPool, { identityRoot: rejectIdentityRoot, mode: 'fresh' })
      if (!rejectedIdentity.databaseId || !rejectedIdentity.instanceId || !rejectedIdentity.identityJkt) throw new Error('Rejected activation identity missing')
      await initializeTemporaryLicensePendingKey(rejectPendingRoot, 'test')
      const rejectedOperation = await createOrLoadActivationOperation(rejectDb, rejectPendingRoot, {
        operationId: randomUUID(),
        licenseId: info.activation_rejected.license_id,
        activationCode: info.activation_rejected.activation_code,
        databaseId: rejectedIdentity.databaseId,
        instanceId: rejectedIdentity.instanceId,
        identityJkt: rejectedIdentity.identityJkt,
        origin: null,
      })
      // The auxiliary Store accepts the same root-signed bundle and time-anchor using the real center endpoints.
      const candidate = await verifyTrustBundleSignature(info.trust_bundle, {
        trustedRoot: releaseConfig.offline_root,
        expectedCenterIssuer: releaseConfig.expected_center_issuer,
      })
      const anchor = await fetchTrustedTimeAnchor(releaseConfig, candidate, { testCa: info.tls_ca, testLookup: localTestLookup })
      const rejectStore = new TrustBundleStore({
        directory: rejectTrustRoot,
        trustedRoot: releaseConfig.offline_root,
        expectedCenterIssuer: releaseConfig.expected_center_issuer,
        minimumBundleVersion: releaseConfig.minimum_bundle_version,
      })
      await rejectStore.accept(info.trust_bundle, anchor.assertFresh)
      const rejectionClient = createLicenseActivationClient({
        db: rejectDb,
        pool: rejectPool,
        identityRoot: rejectIdentityRoot,
        pendingKeyRoot: rejectPendingRoot,
        releaseConfig,
        trustStore: rejectStore,
        testTls: testTlsOptions(),
      })
      const outcome = await rejectionClient.submitPendingActivation(rejectedOperation.operationId)
      expect(outcome).toMatchObject({
        purpose: 'verified_activation_rejection_unprojected',
        operationId: rejectedOperation.operationId,
        attemptNo: 1,
        licenseId: info.activation_rejected.license_id,
        outcomeCode: 'LICENSE_REVOKED',
        signatureVerified: true,
        projected: false,
      })
      expect('allow' in outcome).toBe(false)
      const local = await rejectDb.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', rejectedOperation.operationId).executeTakeFirstOrThrow()
      const attempt = await rejectDb.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', rejectedOperation.operationId).executeTakeFirstOrThrow()
      expect(local.state).toBe('response_saved')
      expect(attempt).toMatchObject({ purpose: 'activation', send_state: 'response_saved', attempt_no: 1 })
      const response = await readLicenseOperationAttemptResponse(rejectDb, rejectPendingRoot, rejectedOperation.operationId, 1)
      expect(response.toString('ascii').split('.')).toHaveLength(3)
      const rejectedRecovery = recoveryClient({
        db: rejectDb, pool: rejectPool, identityRoot: rejectIdentityRoot, pendingKeyRoot: rejectPendingRoot,
        trustStore: rejectStore,
      })
      const historicalRejection = await rejectedRecovery.queryPendingActivation(rejectedOperation.operationId)
      expect(historicalRejection).toMatchObject({
        requestAttemptNo: 2, state: 'rejected', outcomeCode: 'LICENSE_REVOKED', committedAttemptNo: 1,
        resultDisposition: 'none', projected: false,
      })
      expect(await readLicenseOperationAttemptResultJws(rejectDb, rejectPendingRoot, rejectedOperation.operationId, 1)).toEqual(response)
      expect(await readLicenseOperationAttemptResponse(rejectDb, rejectPendingRoot, rejectedOperation.operationId, 1))
        .toEqual(response)
      expect((await rejectDb.selectFrom('local_license_operations').select(['state', 'response_attempt_no'])
        .where('operation_id', '=', rejectedOperation.operationId).executeTakeFirstOrThrow()))
        .toMatchObject({ state: 'terminal', response_attempt_no: 2 })
      const queryResponse = await readLicenseOperationAttemptResponse(rejectDb, rejectPendingRoot, rejectedOperation.operationId, 2)
      expect(queryResponse).not.toEqual(response)
      expect(await readLicenseOperationCenterEvidence(rejectDb, rejectPendingRoot, rejectedOperation.operationId)).toEqual(queryResponse)
      const centerOperation = await centerPool.query<{ state: string; outcome_code: string; response_type: string; response_jws: string }>(
        `SELECT state, outcome_code, response_type, response_jws FROM license_operations WHERE operation_id = $1`, [rejectedOperation.operationId],
      )
      expect(centerOperation.rows).toHaveLength(1)
      expect(centerOperation.rows[0]).toMatchObject({ state: 'rejected', outcome_code: 'LICENSE_REVOKED', response_type: 'operation' })
      expect(Buffer.from(centerOperation.rows[0]!.response_jws, 'ascii')).toEqual(response)
      expect(decodeJwt(queryResponse.toString('ascii')).result_jws).toBe(response.toString('ascii'))
      const centerLicense = await centerPool.query<{ current_generation: string }>(
        `SELECT current_generation::text FROM licenses WHERE id = $1`, [info.activation_rejected.license_id],
      )
      expect(centerLicense.rows).toEqual([{ current_generation: '0' }])
      expect((await centerPool.query(`SELECT id FROM license_activations WHERE license_id = $1`, [info.activation_rejected.license_id])).rowCount)
        .toBe(0)
      const projection = await rejectPool.query<{ projection: string | null }>("SELECT to_regclass('license_projection')::text AS projection")
      expect(projection.rows[0]?.projection).toBeNull()
    } finally {
      await rejectDb.destroy().catch(() => undefined)
      await apiAdminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 45_000)

  it('survives real SIGKILL boundaries before/after attempt commit, send, and response archive without replaying activation', async () => {
    const stages = [
      'before_attempt_commit', 'after_attempt_commit', 'after_sent_commit', 'before_http_send',
      'after_http_response', 'before_response_save', 'after_response_saved',
    ] as const
    for (const [index, checkpoint] of stages.entries()) {
      const schema = `client_activation_crash_${randomUUID().replaceAll('-', '')}`
      const root = join(sandboxRoot, `activation-crash-${index}`)
      const caseIdentityRoot = join(root, 'identity')
      const casePendingRoot = join(root, 'pending')
      await mkdir(caseIdentityRoot, { recursive: true, mode: 0o700 })
      await apiAdminPool.query(`CREATE SCHEMA "${schema}"`)
      const casePool = new Pool({ connectionString: testDatabaseUrl!, options: `-c search_path=${schema}`, max: 5 })
      const caseDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: casePool }) })
      try {
        await installationIdentityMigration.up(caseDb)
        await localLicenseOperationsMigration.up(caseDb)
        await singleInitialActivationAttemptMigration.up(caseDb)
        await licenseOperationResultArchiveMigration.up(caseDb)
        await licenseResultArchivePresenceMigration.up(caseDb)
        await licenseOperationTrustedRejectionMigration.up(caseDb)
        const caseIdentity = await initializeInstallationIdentity(casePool, { identityRoot: caseIdentityRoot, mode: 'fresh' })
        if (!caseIdentity.databaseId || !caseIdentity.instanceId || !caseIdentity.identityJkt) throw new Error('Crash fixture identity missing')
        await initializeTemporaryLicensePendingKey(casePendingRoot, 'test')
        const activation = info.crash_activation_cases[index]!
        const caseOperation = await createOrLoadActivationOperation(caseDb, casePendingRoot, {
          operationId: randomUUID(),
          licenseId: activation.license_id,
          activationCode: activation.activation_code,
          databaseId: caseIdentity.databaseId,
          instanceId: caseIdentity.instanceId,
          identityJkt: caseIdentity.identityJkt,
          origin: null,
        })
        const killed = await runActivationCrashChild({
          checkpoint, schema, operationId: caseOperation.operationId,
          identityRoot: caseIdentityRoot, pendingRoot: casePendingRoot,
        })
        expect(killed.signal, `${checkpoint}: ${killed.stderr}`).toBe('SIGKILL')
        expect(killed.stderr).not.toContain(activation.activation_code)

        const parent = await caseDb.selectFrom('local_license_operations').selectAll()
          .where('operation_id', '=', caseOperation.operationId).executeTakeFirstOrThrow()
        const attempts = await caseDb.selectFrom('local_license_operation_attempts').selectAll()
          .where('operation_id', '=', caseOperation.operationId).execute()
        const reachedCenter = checkpoint === 'after_http_response' || checkpoint === 'before_response_save' || checkpoint === 'after_response_saved'
        if (checkpoint === 'before_attempt_commit') {
          expect(attempts).toHaveLength(0)
          expect(parent.state).toBe('pending')
        } else {
          expect(attempts).toHaveLength(1)
          expect(parent.state).toBe(reachedCenter && checkpoint === 'after_response_saved' ? 'response_saved' : 'pending')
          const expectedSendState = checkpoint === 'after_attempt_commit' ? 'prepared'
            : checkpoint === 'after_response_saved' ? 'response_saved' : 'sent'
          expect(attempts[0]!.send_state).toBe(expectedSendState)
        }
        const centerOperation = await centerPool.query<{ state: string }>(
          `SELECT state FROM license_operations WHERE operation_id = $1`, [caseOperation.operationId],
        )
        expect(centerOperation.rowCount).toBe(reachedCenter ? 1 : 0)
        const centerActivation = await centerPool.query<{ generation: string }>(
          `SELECT generation::text FROM license_activations WHERE license_id = $1`, [activation.license_id],
        )
        expect(centerActivation.rows).toEqual(reachedCenter ? [{ generation: '1' }] : [])
        const retryClient = createLicenseActivationClient({
          db: caseDb,
          pool: casePool,
          identityRoot: caseIdentityRoot,
          pendingKeyRoot: casePendingRoot,
          releaseConfig,
          trustStore,
          testTls: testTlsOptions(),
        })
        if (checkpoint !== 'before_attempt_commit') {
          await expect(retryClient.submitPendingActivation(caseOperation.operationId))
            .rejects.toMatchObject({ code: 'activation_attempt_already_exists' })
          expect((await centerPool.query(`SELECT operation_id FROM license_operations WHERE operation_id = $1`, [caseOperation.operationId])).rowCount)
            .toBe(reachedCenter ? 1 : 0)
        }
        if (checkpoint === 'after_response_saved') {
          const raw = await readLicenseOperationAttemptResponse(caseDb, casePendingRoot, caseOperation.operationId, 1)
          expect(raw.toString('ascii').split('.')).toHaveLength(3)
        }
      } finally {
        await caseDb.destroy().catch(() => undefined)
        await apiAdminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
        await rm(root, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }, 120_000)

  it('keeps unsigned HTTP errors, timeout and response loss unknown; archives invalid compact JWS before verification', async () => {
    const modes = ['unsigned_403', 'unsigned_409', 'server_error', 'delay', 'disconnect_before_commit', 'drop_after_commit', 'invalid_jws'] as const
    for (const [index, mode] of modes.entries()) {
      const schema = `client_activation_http_${randomUUID().replaceAll('-', '')}`
      const root = join(sandboxRoot, `activation-http-${index}`)
      const caseIdentityRoot = join(root, 'identity')
      const casePendingRoot = join(root, 'pending')
      await mkdir(caseIdentityRoot, { recursive: true, mode: 0o700 })
      await apiAdminPool.query(`CREATE SCHEMA "${schema}"`)
      const casePool = new Pool({ connectionString: testDatabaseUrl!, options: `-c search_path=${schema}`, max: 5 })
      const caseDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: casePool }) })
      try {
        await installationIdentityMigration.up(caseDb)
        await localLicenseOperationsMigration.up(caseDb)
        await singleInitialActivationAttemptMigration.up(caseDb)
        await licenseOperationResultArchiveMigration.up(caseDb)
        await licenseResultArchivePresenceMigration.up(caseDb)
        await licenseOperationTrustedRejectionMigration.up(caseDb)
        const caseIdentity = await initializeInstallationIdentity(casePool, { identityRoot: caseIdentityRoot, mode: 'fresh' })
        if (!caseIdentity.databaseId || !caseIdentity.instanceId || !caseIdentity.identityJkt) throw new Error('HTTP fixture identity missing')
        await initializeTemporaryLicensePendingKey(casePendingRoot, 'test')
        const activation = info.transport_activation_cases[index]!
        const caseOperation = await createOrLoadActivationOperation(caseDb, casePendingRoot, {
          operationId: randomUUID(),
          licenseId: activation.license_id,
          activationCode: activation.activation_code,
          databaseId: caseIdentity.databaseId,
          instanceId: caseIdentity.instanceId,
          identityJkt: caseIdentity.identityJkt,
          origin: null,
        })
        await writeFile(info.activation_control_path, JSON.stringify({ mode }), { mode: 0o600 })
        const client = createLicenseActivationClient({
          db: caseDb,
          pool: casePool,
          identityRoot: caseIdentityRoot,
          pendingKeyRoot: casePendingRoot,
          releaseConfig,
          trustStore,
          testTls: testTlsOptions(),
        })
        if (mode === 'invalid_jws') {
          await expect(client.submitPendingActivation(caseOperation.operationId))
            .rejects.toMatchObject({ code: 'activation_submission_failed' })
        } else {
          await expect(client.submitPendingActivation(caseOperation.operationId))
            .rejects.toMatchObject({ code: 'activation_result_unknown' })
        }
        await rm(info.activation_control_path, { force: true })

        const localOperation = await caseDb.selectFrom('local_license_operations').selectAll()
          .where('operation_id', '=', caseOperation.operationId).executeTakeFirstOrThrow()
        const attempt = await caseDb.selectFrom('local_license_operation_attempts').selectAll()
          .where('operation_id', '=', caseOperation.operationId).executeTakeFirstOrThrow()
        expect(localOperation.state).toBe(mode === 'invalid_jws' ? 'response_saved' : 'pending')
        expect(attempt.send_state).toBe(mode === 'invalid_jws' ? 'response_saved' : 'transport_unknown')

        const committed = mode === 'drop_after_commit'
        const centerOperation = await centerPool.query<{ state: string }>(
          `SELECT state FROM license_operations WHERE operation_id = $1`, [caseOperation.operationId],
        )
        expect(centerOperation.rowCount).toBe(committed ? 1 : 0)
        const centerActivation = await centerPool.query<{ generation: string }>(
          `SELECT generation::text FROM license_activations WHERE license_id = $1`, [activation.license_id],
        )
        expect(centerActivation.rows).toEqual(committed ? [{ generation: '1' }] : [])
        if (mode === 'invalid_jws') {
          const archived = await readLicenseOperationAttemptResponse(caseDb, casePendingRoot, caseOperation.operationId, 1)
          expect(archived.toString('ascii')).toBe(`${'A'.repeat(64)}.${'B'.repeat(32)}.${'C'.repeat(64)}`)
        }
        const retryClient = createLicenseActivationClient({
          db: caseDb,
          pool: casePool,
          identityRoot: caseIdentityRoot,
          pendingKeyRoot: casePendingRoot,
          releaseConfig,
          trustStore,
          testTls: testTlsOptions(),
        })
        await expect(retryClient.submitPendingActivation(caseOperation.operationId))
          .rejects.toMatchObject({ code: 'activation_attempt_already_exists' })
        expect((await centerPool.query(`SELECT operation_id FROM license_operations WHERE operation_id = $1`, [caseOperation.operationId])).rowCount)
          .toBe(committed ? 1 : 0)
      } finally {
        await rm(info.activation_control_path, { force: true }).catch(() => undefined)
        await caseDb.destroy().catch(() => undefined)
        await apiAdminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
        await rm(root, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }, 120_000)
})
