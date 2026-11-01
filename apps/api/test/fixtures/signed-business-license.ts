import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Kysely } from 'kysely'
import type { Pool } from 'pg'
import type { Database } from '../../src/db/types.js'
import { initializeInstallationIdentity, verifyInstallationIdentity } from '../../src/licensing/installation-identity.js'
import { initializeTemporaryLicensePendingKey } from '../../src/licensing/pending-encryption-key.js'
import { createOrLoadActivationOperation } from '../../src/licensing/license-operation-store.js'
import { createLicenseActivationClient } from '../../src/licensing/license-activation-client.js'
import { createLicenseOperationRecoveryClient } from '../../src/licensing/license-operation-recovery-client.js'
import { createLicenseStateProjectionClient } from '../../src/licensing/license-state-projection.js'
import { validateTrustedReleaseLicenseConfig } from '../../src/licensing/trusted-release-config.js'
import { TrustBundleStore } from '../../src/licensing/trust/trust-bundle-store.js'
import { verifyTrustBundleSignature } from '../../src/licensing/trust/trust-bundle.js'
import { fetchTrustedTimeAnchor } from '../../src/licensing/trust/time-anchor-client.js'
import { createTrustDatabaseCoordinator } from '../../src/licensing/trust/trust-database-coordinator.js'

const centerCommit = 'a5cf99439e3bf92b65f19d60c013bca088cf221a'

/**
 * Disposable, actually signed center evidence for migrated PostgreSQL test databases.
 * The center's test keys and all private material live exclusively in the temporary
 * directory and are removed by close(). This helper never changes release config.
 */
export async function createSignedBusinessLicense(input: {
  db: Kysely<Database>
  pool: Pool
  databaseUrl: string
  centerCheckout: string
  subscriptionSeconds?: number
  /** Reuse an already verified test identity and paired pending key without modifying either root. */
  existingRoots?: { identityRoot: string; pendingKeyRoot: string }
}) {
  if (process.env.NODE_ENV !== 'test' || !new URL(input.databaseUrl).pathname.slice(1).endsWith('_test')) {
    throw new Error('Signed business license fixture requires an isolated test database')
  }
  const head = execFileSync('git', ['-C', input.centerCheckout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (head !== centerCommit) throw new Error('Frozen license center checkout has an unexpected commit')
  const root = await mkdtemp(join(tmpdir(), 'aikayun-signed-business-license-'))
  const identityRoot = input.existingRoots?.identityRoot ?? join(root, 'identity')
  const pendingKeyRoot = input.existingRoots?.pendingKeyRoot ?? join(root, 'pending')
  const trustRoot = join(root, 'trust')
  const infoPath = join(root, 'center-info.json')
  let child: ReturnType<typeof spawn> | undefined
  let stderr = ''
  async function close() {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolveExit => {
        const timer = setTimeout(() => child?.kill('SIGKILL'), 10_000)
        child!.once('exit', () => { clearTimeout(timer); resolveExit() })
        child!.kill('SIGTERM')
      })
    }
    await rm(root, { recursive: true, force: true })
  }
  try {
    if (!input.existingRoots) await mkdir(identityRoot, { mode: 0o700 })
    await mkdir(trustRoot, { mode: 0o700 })
    const loader = join(input.centerCheckout, 'node_modules/tsx/dist/loader.mjs')
    await stat(loader)
    child = spawn(process.execPath, ['--import', loader, resolve(import.meta.dirname, 'license-center-challenge-interop-server.mjs')], {
      cwd: input.centerCheckout,
      env: { ...process.env, NODE_ENV: 'test', LICENSE_CENTER_CHECKOUT: input.centerCheckout,
        LICENSE_CENTER_INTEROP_INFO: infoPath, LICENSE_TEST_DATABASE_URL: input.databaseUrl },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const deadline = Date.now() + 90_000
    let info: {
      source_commit: string; issuer: string; origin: string; trust_bundle: string; root_kid: string;
      root_public_jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string }; tls_ca: string;
      activation_success: { license_id: string; activation_code: string }
    } | undefined
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Frozen center failed to start: ${stderr}`)
      try {
        info = JSON.parse(await readFile(infoPath, 'utf8')) as NonNullable<typeof info>
        break
      } catch (error) {
        const fileNotReady = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
        if (!(error instanceof SyntaxError) && !fileNotReady) throw error
        await new Promise(resolveWait => setTimeout(resolveWait, 100))
      }
    }
    if (!info) throw new Error(`Frozen center metadata was not ready before timeout: ${stderr}`)
    if (info.source_commit !== centerCommit || info.issuer !== info.origin) throw new Error('Invalid frozen center metadata')
    const lookup = ((_hostname, optionsOrCallback, callbackMaybe) => {
      const callback = callbackMaybe
      if (!callback) throw new Error('Missing TLS lookup callback')
      if (typeof optionsOrCallback === 'object' && optionsOrCallback !== null && 'all' in optionsOrCallback && optionsOrCallback.all === true) {
        callback(null, [{ address: '127.0.0.1', family: 4 }])
      } else callback(null, '127.0.0.1', 4)
    }) as LookupFunction
    const testTls = { ca: info.tls_ca, lookup }
    const postCenter = async (path: string, bodyValue: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const target = new URL(path, info.origin)
      const body = Buffer.from(JSON.stringify(bodyValue))
      return await new Promise((resolveResponse, reject) => {
        const request = httpsRequest({ hostname: target.hostname, port: Number(target.port), servername: target.hostname,
          path: target.pathname, method: 'POST', ca: info.tls_ca, lookup,
          headers: { 'content-type': 'application/json', 'content-length': String(body.length) } }, response => {
          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(Buffer.from(chunk)))
          response.once('end', () => {
            if (response.statusCode !== 200) return reject(new Error(`Center fixture request failed: ${path} (${response.statusCode})`))
            try { resolveResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) } catch (error) { reject(error) }
          })
        })
        request.once('error', reject)
        request.end(body)
      })
    }
    const releaseConfig = await validateTrustedReleaseLicenseConfig({
      schema_version: 1, trust_configuration_id: randomUUID(), release_id: 'business-integration-test',
      release_manifest_sha256: randomBytes(32).toString('base64url'),
      expected_center_issuer: info.issuer, expected_center_origin: info.origin,
      offline_root: { kid: info.root_kid, publicJwk: info.root_public_jwk }, minimum_bundle_version: '1',
    })
    const identity = input.existingRoots
      ? await verifyInstallationIdentity(input.pool, identityRoot)
      : await initializeInstallationIdentity(input.pool, { identityRoot, mode: 'adopt_existing', confirmExistingData: true })
    if (identity.status !== 'ready' || !identity.databaseId || !identity.instanceId || !identity.identityJkt) {
      throw new Error('Test installation identity did not initialize')
    }
    const trustStore = new TrustBundleStore({ directory: trustRoot, trustedRoot: releaseConfig.offline_root,
      expectedCenterIssuer: releaseConfig.expected_center_issuer, minimumBundleVersion: releaseConfig.minimum_bundle_version,
      coordinator: createTrustDatabaseCoordinator({ db: input.db, identityRoot }) })
    const candidate = await verifyTrustBundleSignature(info.trust_bundle, {
      trustedRoot: releaseConfig.offline_root, expectedCenterIssuer: releaseConfig.expected_center_issuer,
    })
    const anchor = await fetchTrustedTimeAnchor(releaseConfig, candidate, { testCa: info.tls_ca, testLookup: lookup })
    await trustStore.accept(info.trust_bundle, anchor.assertFresh)
    if (!input.existingRoots) await initializeTemporaryLicensePendingKey(pendingKeyRoot, 'test')
    const operation = await createOrLoadActivationOperation(input.db, pendingKeyRoot, {
      operationId: randomUUID(), licenseId: info.activation_success.license_id,
      activationCode: info.activation_success.activation_code, databaseId: identity.databaseId,
      instanceId: identity.instanceId, identityJkt: identity.identityJkt, origin: null,
    })
    if (input.subscriptionSeconds !== undefined) {
      const result = await postCenter('/__test/set-subscription-end', {
        license_id: info.activation_success.license_id, seconds_from_now: input.subscriptionSeconds,
      })
      if (result.state !== 'updated') throw new Error('Unable to set test subscription end')
    }
    const options = { db: input.db, pool: input.pool, identityRoot, pendingKeyRoot, releaseConfig, trustStore, testTls }
    await createLicenseActivationClient(options).submitPendingActivation(operation.operationId)
    const projection = createLicenseStateProjectionClient(options)
    await projection.projectPersistedOperation(operation.operationId)
    const snapshot = await projection.getLicenseSnapshot()
    if (snapshot.status !== 'active') throw new Error(`Test license was not active: ${snapshot.status}`)
    async function revokeAndProject() {
      const result = await postCenter('/__test/revoke-license', { license_id: info.activation_success.license_id })
      if (result.state !== 'succeeded') throw new Error('Unable to revoke test license')
      const evidence = await createLicenseOperationRecoveryClient(options).recoverCurrentLease(operation.operationId)
      await projection.projectPersistedOperation(evidence.recoveryOperationId)
    }
    return { options, trustRoot, projection, operation, revokeAndProject, close }
  } catch (error) {
    await close()
    throw error
  }
}
