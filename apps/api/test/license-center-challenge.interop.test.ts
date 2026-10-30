import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as signEd25519 } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { calculateJwkThumbprint } from 'jose'
import { assertChallengeClaimsBound, createLicenseChallengeClient, createSignedChallengeRequest, postChallenge } from '../src/licensing/license-challenge-client.js'
import type { PendingActivationOperation } from '../src/licensing/license-challenge-client.js'
import { installationIdentityMigration } from '../src/db/migrations/202610290001_installation_identity.js'
import { localLicenseOperationsMigration } from '../src/db/migrations/202610300001_local_license_operations.js'
import type { Database } from '../src/db/types.js'
import { initializeInstallationIdentity, withVerifiedInstallationSigningContext } from '../src/licensing/installation-identity.js'
import { createOrLoadActivationOperation } from '../src/licensing/license-operation-store.js'
import { initializeTemporaryLicensePendingKey } from '../src/licensing/pending-encryption-key.js'
import { validateTrustedReleaseLicenseConfig } from '../src/licensing/trusted-release-config.js'
import { TrustBundleStore } from '../src/licensing/trust/trust-bundle-store.js'
import { verifyTrustBundleSignature } from '../src/licensing/trust/trust-bundle.js'
import type { LookupFunction } from 'node:net'

const expectedCenterCommit = '6f554b51b867a15ad7747c6d002b548e016f65c6'
const testDatabaseUrl = process.env.TEST_DATABASE_URL
const centerCheckout = process.env.LICENSE_CENTER_CHECKOUT
describe.skipIf(!testDatabaseUrl || !centerCheckout)('3C-2A frozen authorization-center HTTPS interop', () => {
  let apiAdminPool: Pool
  let apiPool: Pool
  let apiDb: Kysely<Database>
  let apiSchema = ''
  let sandboxRoot = ''
  let identityRoot = ''
  let pendingKeyRoot = ''
  let trustRoot = ''
  let infoPath = ''
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
    if (checkedOutCenter !== expectedCenterCommit) throw new Error('Authorization-center checkout is not at the 2C-4 frozen commit')

    sandboxRoot = await mkdtemp(join(tmpdir(), 'aikayun-3c-2a-interop-'))
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
    identitySnapshot = await initializeInstallationIdentity(apiPool, { identityRoot, mode: 'fresh' })
    if (identitySnapshot.status !== 'ready' || !identitySnapshot.databaseId || !identitySnapshot.instanceId || !identitySnapshot.identityJkt) {
      throw new Error('Isolated 3A instance identity did not initialize')
    }
    await initializeTemporaryLicensePendingKey(pendingKeyRoot, 'test')
    operation = await createOrLoadActivationOperation(apiDb, pendingKeyRoot, {
      operationId: randomUUID(),
      licenseId: randomUUID(),
      activationCode: randomBytes(32).toString('base64url'),
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
      release_id: 'test-3c-2a',
      release_manifest_sha256: randomBytes(32).toString('base64url'),
      expected_center_issuer: info.issuer,
      expected_center_origin: info.origin,
      offline_root: { kid: info.root_kid, publicJwk: info.root_public_jwk },
      minimum_bundle_version: '1',
    })
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
    const { fetchTrustedTimeAnchor } = await import('../src/licensing/trust/time-anchor-client.js')
    const anchor = await fetchTrustedTimeAnchor(releaseConfig, candidate, { testCa: info.tls_ca, testLookup: localTestLookup })
    await trustStore.accept(info.trust_bundle, anchor.assertFresh)

    const centerDatabaseUrl = new URL(testDatabaseUrl)
    centerDatabaseUrl.pathname = `/${info.database_name}`
    centerPool = new Pool({ connectionString: centerDatabaseUrl.toString(), max: 2 })
  }, 45_000)

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

  function challengeClient(testTls: { ca?: string | Buffer; lookup?: LookupFunction } = { ca: info.tls_ca, lookup: localTestLookup }) {
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
})
