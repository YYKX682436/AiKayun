import { createHash, randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { createServer } from 'node:net'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const checkout = process.env.LICENSE_CENTER_CHECKOUT
const infoPath = process.env.LICENSE_CENTER_INTEROP_INFO
const expectedCommit = '6f554b51b867a15ad7747c6d002b548e016f65c6'
if (!checkout || !infoPath) throw new Error('interop fixture requires an isolated center checkout and output path')

const centerImport = async (relativePath) => import(pathToFileURL(join(checkout, relativePath)).href)
const [
  { createTestSigningRuntime }, { createDatabase, migrateToLatest }, { createApp }, offlineTrust,
  { initializeSignerRequestDigest },
  { createAdminService, createLicenseRequestDigest, issueActivationCodeRequestDigest, changeLicenseStatusRequestDigest },
  { signOperationReceipt, signLicenseLease }, { decodeJwt },
] = await Promise.all([
  centerImport('test/support/runtime.ts'),
  centerImport('src/db/database.ts'),
  centerImport('src/app.ts'),
  centerImport('tools/offline-trust/trust-bundle-signing.ts'),
  centerImport('src/admin/signing-service.ts'),
  centerImport('src/admin/service.ts'),
  centerImport('src/receipts.ts'),
  import('jose'),
])

const pgUrl = process.env.LICENSE_TEST_DATABASE_URL
if (!pgUrl) throw new Error('interop fixture requires an isolated PostgreSQL test database')

let runtime
let db
let app
let licenseAdmin
let shuttingDown = false

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function cleanup() {
  if (app) await app.close().catch(() => undefined)
  await licenseAdmin?.close().catch(() => undefined)
  await db?.destroy().catch(() => undefined)
  await runtime?.cleanup().catch(() => undefined)
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await cleanup()
  process.exit(0)
}

process.once('SIGTERM', () => { void shutdown() })
process.once('SIGINT', () => { void shutdown() })

try {
  const port = await availablePort()
  const origin = `https://license.example.test:${port}`
  const activationControlPath = join(dirname(infoPath), 'activation-control.json')
  const activationEnteredPath = join(dirname(infoPath), 'activation-entered')
  const activationFinishedPath = join(dirname(infoPath), 'activation-finished')
  runtime = await createTestSigningRuntime()
  runtime.config.issuer = origin
  runtime.config.publicOrigin = origin
  runtime.config.port = port
  const now = Math.floor(Date.now() / 1000)
  const claims = await offlineTrust.buildTrustBundleClaims(origin, {
    bundle_version: '1',
    iat: now - 60,
    nbf: now - 30,
    exp: now + 30 * 24 * 60 * 60,
    propagation_budget_seconds: 24 * 60 * 60,
    keys: [runtime.onlineKey.record],
  }, runtime.offlineRootPublicJwk)
  const bundle = await offlineTrust.signTrustBundle(claims, runtime.offlineRootPrivateKey, runtime.offlineRootPublicJwk)
  db = createDatabase(runtime.config.databaseUrl)
  await migrateToLatest(db)
  const admin = runtime.createAdminService(db)
  const initializeRequest = {
    operationId: randomUUID(),
    expectedSignerRevision: '0',
    activeKid: runtime.onlineKey.kid,
    bundleJws: bundle.token,
    reason: 'initialize disposable 3C-2A interop signer',
  }
  await admin.initialize({
    ...initializeRequest,
    rolloutGate: 'isolated-development-confirmed',
    confirmedRequestDigest: initializeSignerRequestDigest(initializeRequest),
  })
  const databaseUrl = new URL(runtime.config.databaseUrl)
  const databaseCredentialPath = join(dirname(infoPath), 'activation-admin-database.url')
  const policyPath = join(dirname(infoPath), 'activation-admin-policy.json')
  const uid = process.geteuid?.()
  if (uid === undefined) throw new Error('Isolated activation admin requires a POSIX uid')
  await writeFile(databaseCredentialPath, `${runtime.config.databaseUrl}\n`, { mode: 0o600, flag: 'wx' })
  await chmod(databaseCredentialPath, 0o600)
  await writeFile(policyPath, JSON.stringify({
    environment: 'isolated-development',
    allowed_os_uids: [uid],
    database_role: decodeURIComponent(databaseUrl.username),
    database_url_file: databaseCredentialPath,
  }), { mode: 0o600, flag: 'wx' })
  await chmod(policyPath, 0o600)
  licenseAdmin = await createAdminService(policyPath)

  async function issueActivationScenario(revokeAfterIssue = false) {
    const licenseId = randomUUID()
    const createInput = {
      operationId: randomUUID(), licenseId, expectedRevision: '0', plan: 'monthly',
      accountId: `3c2b-interop-${randomUUID()}`, reason: '隔离真实激活互操作测试签发',
    }
    const created = await licenseAdmin.createLicense({
      ...createInput,
      confirmedRequestDigest: createLicenseRequestDigest(createInput),
    })
    if (created.state !== 'succeeded') throw new Error('Isolated test license issuance failed')
    const codeInput = {
      operationId: randomUUID(), licenseId, expectedRevision: created.resultRevision,
      reason: '隔离真实激活互操作测试签发',
    }
    const issued = await licenseAdmin.issueActivationCode({
      ...codeInput,
      confirmedRequestDigest: issueActivationCodeRequestDigest(codeInput),
    })
    if (issued.state !== 'succeeded' || !issued.activationCode) throw new Error('Isolated test activation code issuance failed')
    if (revokeAfterIssue) {
      const revokeInput = { operationId: randomUUID(), licenseId, expectedRevision: issued.resultRevision,
        reason: '隔离真实激活互操作签名拒绝测试' }
      const revoked = await licenseAdmin.revokeLicense({
        ...revokeInput,
        confirmedRequestDigest: changeLicenseStatusRequestDigest(revokeInput, 'license_revoke'),
      })
      if (revoked.state !== 'succeeded') throw new Error('Isolated test license revocation failed')
    }
    return { license_id: licenseId, activation_code: issued.activationCode }
  }
  const activationSuccess = await issueActivationScenario()
  const activationRecovery = await issueActivationScenario()
  const activationContinue = await issueActivationScenario()
  const activationRace = await issueActivationScenario()
  const activationProtocolResolution = await issueActivationScenario()
  const activationConcurrent = await issueActivationScenario()
  const activationRejected = await issueActivationScenario(true)
  const activationExpiredChallenge = await issueActivationScenario()
  const crashActivationCases = []
  for (let index = 0; index < 7; index += 1) crashActivationCases.push(await issueActivationScenario())
  const transportActivationCases = []
  for (let index = 0; index < 13; index += 1) transportActivationCases.push(await issueActivationScenario())
  app = createApp({
    config: runtime.config,
    db,
    challengeNow: async () => {
      let mode
      try { mode = JSON.parse(await readFile(activationControlPath, 'utf8')).mode } catch { /* use current test center time */ }
      return mode === 'expired_challenge' ? new Date(Date.now() - 6 * 60 * 1000) : new Date()
    },
  })
  let isolatedClientAddress = 0
  app.server.on('secureConnection', (socket) => {
    // Keep the real center rate-limit hooks while isolating each in-process test client.
    isolatedClientAddress = (isolatedClientAddress % 254) + 1
    Object.defineProperty(socket, 'remoteAddress', { configurable: true, value: `192.0.2.${isolatedClientAddress}` })
  })
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST') return
    let mode
    try { mode = JSON.parse(await readFile(activationControlPath, 'utf8')).mode } catch { return }
    if (request.url === '/v1/operations/query' && mode === 'query_server_error') {
      return reply.code(503).send({ error: { code: 'ISOLATED_TEST_QUERY_ERROR' } })
    }
    if (request.url === '/v1/operations/query' && mode === 'query_rate_limit') {
      return reply.code(429).send({ error: { code: 'ISOLATED_TEST_RATE_LIMIT' } })
    }
    if (request.url !== '/v1/activations') return
    if (mode === 'drop_after_commit') return
    if (mode === 'delay_activation') {
      await writeFile(activationEnteredPath, 'entered', { mode: 0o600 })
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        let currentMode
        try { currentMode = JSON.parse(await readFile(activationControlPath, 'utf8')).mode } catch { /* test released the gate */ }
        if (currentMode !== 'delay_activation') break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      return
    }
    if (mode === 'disconnect_before_commit') {
      reply.hijack()
      reply.raw.destroy()
      return
    }
    if (mode === 'delay') {
      await new Promise((resolve) => setTimeout(resolve, 6_000))
      return reply.code(500).send({ error: { code: 'ISOLATED_TEST_DELAY' } })
    }
    if (mode === 'invalid_jws') {
      const token = `${'A'.repeat(64)}.${'B'.repeat(32)}.${'C'.repeat(64)}`
      return reply.code(200).send({ license: token })
    }
    const status = mode === 'unsigned_403' ? 403 : mode === 'unsigned_409' ? 409 : mode === 'server_error' ? 503 : undefined
    if (status) return reply.code(status).send({ error: { code: `ISOLATED_TEST_${mode.toUpperCase()}` } })
  })
  app.addHook('preHandler', async (request) => {
    let mode
    try { mode = JSON.parse(await readFile(activationControlPath, 'utf8')).mode } catch { return }
    if (request.method !== 'POST' || request.url !== '/v1/operations/query' || mode !== 'expire_saved_result') return
      const operation = await db.selectFrom('license_operations').selectAll()
        .where('operation_id', '=', request.body.operation_id).executeTakeFirst()
      if (!operation || operation.state !== 'committed' || operation.response_type !== 'license') {
        throw new Error('Expired-result fixture requires a committed activation lease')
      }
      const old = decodeJwt(operation.response_jws)
      const expired = await signLicenseLease(runtime.signer, {
        licenseId: old.sub,
        instanceId: old.instance_id,
        databaseId: old.database_id,
        identityJkt: old.identity_jkt,
        generation: old.activation_generation,
        entitlementRevision: old.entitlement_revision,
        plan: old.plan,
        subscriptionEnd: new Date(old.subscription_end * 1000),
        requestNonce: old.request_nonce,
        requestDigest: old.request_digest,
        now: new Date(old.iat * 1000 - 8 * 24 * 60 * 60 * 1000),
      })
      await db.transaction().execute(async (trx) => {
        await sql.raw('ALTER TABLE license_operations DISABLE TRIGGER license_operations_immutable').execute(trx)
        await trx.updateTable('license_operations').set({
          response_jws: expired.token,
          result_digest: createHash('sha256').update(expired.token).digest('base64url'),
        }).where('operation_id', '=', operation.operation_id).executeTakeFirstOrThrow()
        await sql.raw('ALTER TABLE license_operations ENABLE TRIGGER license_operations_immutable').execute(trx)
      })
  })
  app.addHook('preSerialization', async (request, reply, payload) => {
    if (request.method !== 'POST' || request.url !== '/v1/operations/query') return payload
    let mode
    try { mode = JSON.parse(await readFile(activationControlPath, 'utf8')).mode } catch { return payload }
    const forgedModes = new Set([
      'forged_actor', 'forged_operation', 'forged_committed_attempt', 'forged_not_found_result',
      'wrong_request_digest', 'wrong_receipt_signature', 'wrong_receipt_kid',
    ])
    if (!forgedModes.has(mode)) return payload
    const body = request.body
    const challenge = decodeJwt(body.challenge)
    const requestDigest = createHash('sha256').update(request.rawBody).digest('base64url')
    const challengeNonceHash = createHash('sha256').update(challenge.server_nonce).digest('base64url')
    const claims = {
      licenseId: body.license_id,
      identityJkt: mode === 'forged_actor' ? 'A'.repeat(43) : body.identity_jkt,
      operationId: mode === 'forged_operation' ? randomUUID() : body.operation_id,
      intentDigest: body.intent_digest,
      state: mode === 'forged_not_found_result' ? 'not_found' : 'committed',
      outcomeCode: mode === 'forged_not_found_result' ? 'OPERATION_NOT_FOUND' : 'ACTIVATED',
      attemptNo: body.attempt_no,
      requestNonceHash: challengeNonceHash,
      requestDigest: mode === 'wrong_request_digest' ? 'B'.repeat(43) : requestDigest,
      committedAttemptNo: mode === 'forged_committed_attempt' ? 999 : null,
      committedRequestNonceHash: mode === 'forged_committed_attempt' ? 'C'.repeat(43) : null,
      committedRequestDigest: mode === 'forged_committed_attempt' ? 'D'.repeat(43) : null,
      resultJws: mode === 'forged_not_found_result'
        ? `${Buffer.from('{"alg":"Ed25519","typ":"aikayun-license+jwt"}').toString('base64url')}.${Buffer.from('{"sub":"forged"}').toString('base64url')}.${Buffer.alloc(64, 1).toString('base64url')}`
        : null,
      now: new Date(),
    }
    const signer = mode === 'wrong_receipt_kid'
      ? { ...runtime.signer, ...(await runtime.createOnlineKey()) }
      : runtime.signer
    let token = await signOperationReceipt(signer, claims)
    if (mode === 'wrong_receipt_signature') {
      const parts = token.split('.')
      const signature = parts[2]
      parts[2] = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`
      token = parts.join('.')
    }
    reply.code(200)
    return { operation_receipt: token }
  })
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'POST' || reply.statusCode !== 200) return payload
    let mode
    try { mode = JSON.parse(await readFile(activationControlPath, 'utf8')).mode } catch { return payload }
    if (request.url === '/v1/activations' && mode === 'release_activation') {
      await writeFile(activationFinishedPath, 'finished', { mode: 0o600 })
    }
    if ((request.url === '/v1/activations' && mode === 'drop_after_commit') ||
      (request.url === '/v1/operations/continue' && mode === 'drop_continue_after_commit')) reply.raw.destroy()
    return payload
  })
  await app.listen({ host: '127.0.0.1', port })
  const databaseName = new URL(runtime.config.databaseUrl).pathname.slice(1)
  await writeFile(infoPath, JSON.stringify({
    source_commit: expectedCommit,
    issuer: origin,
    origin,
    port,
    database_name: databaseName,
    trust_bundle: bundle.token,
    root_public_jwk: runtime.offlineRootPublicJwk,
    root_kid: runtime.config.trustedOfflineRoot.kid,
    tls_ca: runtime.config.tlsCertificate.toString('utf8'),
    activation_control_path: activationControlPath,
    activation_entered_path: activationEnteredPath,
    activation_finished_path: activationFinishedPath,
    activation_success: activationSuccess,
    activation_recovery: activationRecovery,
    activation_continue: activationContinue,
    activation_race: activationRace,
    activation_protocol_resolution: activationProtocolResolution,
    activation_concurrent: activationConcurrent,
    activation_rejected: activationRejected,
    activation_expired_challenge: activationExpiredChallenge,
    crash_activation_cases: crashActivationCases,
    transport_activation_cases: transportActivationCases,
  }), { mode: 0o600, flag: 'wx' })
  process.stdout.write('READY\n')
} catch {
  process.stderr.write('Isolated authorization center fixture failed to start.\n')
  await cleanup()
  process.exitCode = 1
}
