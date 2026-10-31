import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { createServer } from 'node:net'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const checkout = process.env.LICENSE_CENTER_CHECKOUT
const infoPath = process.env.LICENSE_CENTER_INTEROP_INFO
const expectedCommit = 'a5cf99439e3bf92b65f19d60c013bca088cf221a'
if (!checkout || !infoPath) throw new Error('interop fixture requires an isolated center checkout and output path')

const centerImport = async (relativePath) => import(pathToFileURL(join(checkout, relativePath)).href)
const [
  { createTestSigningRuntime }, { createDatabase, migrateToLatest }, { createApp }, offlineTrust,
  { trustBundleArtifactDigest },
  { initializeSignerRequestDigest, acceptSignerTrustBundleRequestDigest, rotateSignerRequestDigest },
  { createAdminService, createLicenseRequestDigest, issueActivationCodeRequestDigest, changeLicenseStatusRequestDigest, renewLicenseRequestDigest },
  { signOperationReceipt, signLicenseLease }, { decodeJwt },
] = await Promise.all([
  centerImport('test/support/runtime.ts'),
  centerImport('src/db/database.ts'),
  centerImport('src/app.ts'),
  centerImport('tools/offline-trust/trust-bundle-signing.ts'),
  centerImport('src/trust/trust-bundle.ts'),
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
let currentOnlineKey
let currentTrustKeys
let pendingSignerRotation
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
  const initialKeyRecord = {
    ...runtime.onlineKey.record,
    retire_after: now + 7 * 24 * 60 * 60,
    verify_until: now + 15 * 24 * 60 * 60,
  }
  currentOnlineKey = { ...runtime.onlineKey, record: initialKeyRecord }
  currentTrustKeys = [initialKeyRecord]
  const claims = await offlineTrust.buildTrustBundleClaims(origin, {
    bundle_version: '1',
    iat: now - 60,
    nbf: now - 30,
    exp: now + 30 * 24 * 60 * 60,
    propagation_budget_seconds: 24 * 60 * 60,
    keys: [initialKeyRecord],
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
  const activationCommittedConflict = await issueActivationScenario()
  const activationConcurrent = await issueActivationScenario()
  const activationRejected = await issueActivationScenario(true)
  const activationRetryCases = []
  for (const variant of ['wrong', 'expired', 'revoked', 'consumed', 'cross-license']) {
    const target = await issueActivationScenario()
    let rejectedCode
    if (variant === 'wrong') rejectedCode = randomBytes(32).toString('base64url')
    else if (variant === 'cross-license') rejectedCode = (await issueActivationScenario()).activation_code
    else if (variant === 'expired') {
      const now = new Date()
      await db.updateTable('activation_codes').set({ revoked_at: now })
        .where('token_hash', '=', createHash('sha256').update(target.activation_code).digest('base64url')).executeTakeFirstOrThrow()
      rejectedCode = randomBytes(32).toString('base64url')
      await db.insertInto('activation_codes').values({
        id: randomUUID(), license_id: target.license_id,
        token_hash: createHash('sha256').update(rejectedCode).digest('base64url'),
        created_at: new Date(now.getTime() - 120_000), expires_at: new Date(now.getTime() - 60_000),
        consumed_at: null, revoked_at: null,
      }).execute()
    } else {
      const now = new Date()
      await db.updateTable('activation_codes').set(variant === 'revoked' ? { revoked_at: now } : { consumed_at: now })
        .where('token_hash', '=', createHash('sha256').update(target.activation_code).digest('base64url')).executeTakeFirstOrThrow()
      rejectedCode = target.activation_code
    }
    activationRetryCases.push({ variant, license_id: target.license_id, rejected_code: rejectedCode })
  }
  const activationFinalizationCases = []
  for (let index = 0; index < 7; index += 1) activationFinalizationCases.push(await issueActivationScenario())
  const activationExpiredChallenge = await issueActivationScenario()
  const recoveryExpiredRenewed = await issueActivationScenario()
  const recoveryRetiredSigner = await issueActivationScenario()
  const recoveryRevokedSigner = await issueActivationScenario()
  const recoveryRevokedLicense = await issueActivationScenario()
  const recoveryExpiredSubscription = await issueActivationScenario()
  const recoverySuperseded = await issueActivationScenario()
  const recoveryWrongIdentity = await issueActivationScenario()
  const recoveryLostResponse = await issueActivationScenario()
  const recoveryContinue = await issueActivationScenario()
  const recoveryCrash = await issueActivationScenario()
  const recoveryTamper = await issueActivationScenario()
  const recoveryTimeout = await issueActivationScenario()
  const recoveryForgedResponse = await issueActivationScenario()
  const recoveryWrongKidResponse = await issueActivationScenario()
  const recoveryMisboundResponse = await issueActivationScenario()
  const recoveryHistoricalBadArchive = await issueActivationScenario()
  const recoveryConflictingVerifiedResponse = await issueActivationScenario()
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
  app.post('/__test/issue-activation-code', async (request, reply) => {
    const body = request.body
    if (!body || typeof body !== 'object' || typeof body.license_id !== 'string') {
      return reply.code(400).send({ error: 'invalid test request' })
    }
    const license = await db.selectFrom('licenses').selectAll().where('id', '=', body.license_id).executeTakeFirst()
    if (!license) return reply.code(404).send({ error: 'test license not found' })
    const unresolved = await db.selectFrom('activation_codes').selectAll().where('license_id', '=', body.license_id)
      .where('consumed_at', 'is', null).where('revoked_at', 'is', null).orderBy('created_at', 'asc').execute()
    const valid = unresolved.filter(code => code.expires_at.getTime() > Date.now())
    if (valid.length > 1) return reply.code(409).send({ error: 'ambiguous test codes' })
    const codeInput = {
      operationId: randomUUID(), licenseId: body.license_id, expectedRevision: license.revision.toString(),
      reason: '隔离互操作测试结案后补发激活码', ...(valid[0] ? { replaceCodeId: valid[0].id } : {}),
    }
    const issued = await licenseAdmin.issueActivationCode({
      ...codeInput, confirmedRequestDigest: issueActivationCodeRequestDigest(codeInput),
    })
    if (issued.state !== 'succeeded' || !issued.activationCode) {
      return reply.code(409).send({ error: 'replacement rejected', outcome_code: issued.outcomeCode })
    }
    return reply.code(200).send({ activation_code: issued.activationCode })
  })
  app.post('/__test/renew-license', async (request, reply) => {
    const body = request.body
    if (!body || typeof body !== 'object' || typeof body.license_id !== 'string') {
      return reply.code(400).send({ error: 'invalid test request' })
    }
    const license = await db.selectFrom('licenses').select(['id', 'revision'])
      .where('id', '=', body.license_id).executeTakeFirst()
    if (!license) return reply.code(404).send({ error: 'test license not found' })
    const input = {
      operationId: randomUUID(), licenseId: license.id, expectedRevision: license.revision.toString(),
      businessReference: `interop-renewal-${randomUUID()}`, reason: '隔离恢复互操作修订权益',
    }
    const result = await licenseAdmin.renewLicense({
      ...input, confirmedRequestDigest: renewLicenseRequestDigest(input),
    })
    if (result.state !== 'succeeded') return reply.code(409).send({ outcome_code: result.outcomeCode })
    return reply.code(200).send({
      revision: result.resultRevision,
      entitlement_revision: result.result.entitlement_revision,
    })
  })
  app.post('/__test/expire-license', async (request, reply) => {
    const body = request.body
    if (!body || typeof body !== 'object' || typeof body.license_id !== 'string') {
      return reply.code(400).send({ error: 'invalid test request' })
    }
    const updated = await db.updateTable('licenses').set({
      confirmed_subscription_end: new Date(Date.now() - 60_000),
    }).where('id', '=', body.license_id).returning('id').executeTakeFirst()
    if (!updated) return reply.code(404).send({ error: 'test license not found' })
    return reply.code(200).send({ state: 'expired' })
  })
  app.post('/__test/revoke-license', async (request, reply) => {
    const body = request.body
    if (!body || typeof body !== 'object' || typeof body.license_id !== 'string') {
      return reply.code(400).send({ error: 'invalid test request' })
    }
    const license = await db.selectFrom('licenses').select(['id', 'revision'])
      .where('id', '=', body.license_id).executeTakeFirst()
    if (!license) return reply.code(404).send({ error: 'test license not found' })
    const input = { operationId: randomUUID(), licenseId: license.id,
      expectedRevision: license.revision.toString(), reason: '隔离恢复互操作撤销权益' }
    const result = await licenseAdmin.revokeLicense({
      ...input, confirmedRequestDigest: changeLicenseStatusRequestDigest(input, 'license_revoke'),
    })
    return reply.code(200).send({ state: result.state, outcome_code: result.outcomeCode })
  })
  app.post('/__test/supersede-license', async (request, reply) => {
    const body = request.body
    if (!body || typeof body !== 'object' || typeof body.license_id !== 'string') {
      return reply.code(400).send({ error: 'invalid test request' })
    }
    await db.transaction().execute(async trx => {
      await trx.updateTable('license_activations').set({ state: 'retired', retired_at: new Date() })
        .where('license_id', '=', body.license_id).where('state', '=', 'active').executeTakeFirstOrThrow()
      await sql`UPDATE licenses SET current_generation = current_generation + 1 WHERE id = ${body.license_id}`.execute(trx)
    })
    return reply.code(200).send({ state: 'superseded' })
  })
  app.post('/__test/break-activation-identity', async (request, reply) => {
    const body = request.body
    if (!body || typeof body !== 'object' || typeof body.license_id !== 'string') {
      return reply.code(400).send({ error: 'invalid test request' })
    }
    await db.transaction().execute(async trx => {
      await trx.updateTable('license_activations').set({ database_id: randomUUID() })
        .where('license_id', '=', body.license_id).executeTakeFirstOrThrow()
    })
    return reply.code(200).send({ state: 'mismatched' })
  })
  app.post('/__test/prepare-signer-rotation', async (request, reply) => {
    const body = request.body
    if (!body || typeof body !== 'object' || !['retired', 'revoked'].includes(body.lifecycle)) {
      return reply.code(400).send({ error: 'invalid signer lifecycle' })
    }
    if (pendingSignerRotation) return reply.code(409).send({ error: 'signer rotation already prepared' })
    const newKey = await runtime.createOnlineKey()
    const now = Math.floor(Date.now() / 1000)
    const previousKeys = currentTrustKeys.map(record => record.kid !== currentOnlineKey.kid
      ? { ...record }
      : body.lifecycle === 'revoked'
        ? { ...record, revoked_at: now }
        : { ...record })
    const keys = [...previousKeys, newKey.record]
    const claims = await offlineTrust.buildTrustBundleClaims(origin, {
      bundle_version: String(Number((await admin.getState()).bundleVersion) + 1),
      iat: now,
      nbf: now,
      exp: now + 80 * 24 * 60 * 60,
      propagation_budget_seconds: 24 * 60 * 60,
      keys,
    }, runtime.offlineRootPublicJwk)
    const bundle = await offlineTrust.signTrustBundle(claims, runtime.offlineRootPrivateKey, runtime.offlineRootPublicJwk)
    pendingSignerRotation = {
      bundle,
      bundleVersion: claims.bundle_version,
      keys,
      newKey,
      lifecycle: body.lifecycle,
      oldKid: currentOnlineKey.kid,
    }
    return reply.code(200).send({
      bundle_jws: bundle.token,
      bundle_version: claims.bundle_version,
      old_kid: currentOnlineKey.kid,
      old_verify_until: keys.find(record => record.kid === currentOnlineKey.kid).verify_until,
      new_kid: newKey.kid,
    })
  })
  app.post('/__test/activate-signer-rotation', async (request, reply) => {
    if (!pendingSignerRotation) return reply.code(409).send({ error: 'no signer rotation prepared' })
    const pending = pendingSignerRotation
    const state = await admin.getState()
    const acceptInput = {
      operationId: randomUUID(),
      expectedSignerRevision: state.signerRevision,
      reason: `isolated interop ${pending.lifecycle} historical signer`,
      bundleJws: pending.bundle.token,
    }
    const accepted = await admin.acceptTrustBundle({
      ...acceptInput,
      rolloutGate: 'isolated-development-confirmed',
      confirmedRequestDigest: acceptSignerTrustBundleRequestDigest(acceptInput),
    })
    if (accepted.state !== 'succeeded') throw new Error('Isolated trust-bundle acceptance failed')
    runtime.config.signingKeyring.set(pending.newKey.kid, pending.newKey)
    const afterAccept = await admin.getState()
    const rotateInput = {
      operationId: randomUUID(),
      expectedSignerRevision: afterAccept.signerRevision,
      targetKid: pending.newKey.kid,
      bundleVersion: pending.bundleVersion,
      artifactSha256: trustBundleArtifactDigest(pending.bundle.token),
      reason: `isolated interop ${pending.lifecycle} historical signer`,
    }
    const rotated = await admin.rotate({
      ...rotateInput,
      rolloutGate: 'isolated-development-confirmed',
      confirmedRequestDigest: rotateSignerRequestDigest(rotateInput),
    })
    if (rotated.state !== 'succeeded') throw new Error('Isolated signer rotation failed')
    currentOnlineKey = pending.newKey
    currentTrustKeys = pending.keys
    pendingSignerRotation = undefined
    const info = JSON.parse(await readFile(infoPath, 'utf8'))
    info.trust_bundle = pending.bundle.token
    await writeFile(infoPath, JSON.stringify(info), { mode: 0o600 })
    return reply.code(200).send({ state: 'succeeded', active_kid: rotated.activeSigningKid, bundle_version: rotated.bundleVersion })
  })
  let isolatedClientAddress = 0
  app.server.on('secureConnection', (socket) => {
    // Keep the real center rate-limit hooks while isolating each in-process test client.
    isolatedClientAddress = (isolatedClientAddress % 65_024) + 1
    const thirdOctet = Math.floor((isolatedClientAddress - 1) / 254)
    const fourthOctet = ((isolatedClientAddress - 1) % 254) + 1
    Object.defineProperty(socket, 'remoteAddress', { configurable: true, value: `198.18.${thirdOctet}.${fourthOctet}` })
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
      const expired = await signLicenseLease({ ...runtime.signer, issuer: origin }, {
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
    if (request.method === 'POST' && request.url === '/v1/leases/renew') {
      let mode
      try { mode = JSON.parse(await readFile(activationControlPath, 'utf8')).mode } catch { return payload }
      if (mode === 'delay_recovery_response_after_commit') {
        await new Promise(resolve => setTimeout(resolve, 6_000))
      }
    }
    if (request.method !== 'POST' || !['/v1/operations/query', '/v1/operations/continue'].includes(request.url)) return payload
    let mode
    let control
    try { control = JSON.parse(await readFile(activationControlPath, 'utf8')); mode = control.mode } catch { return payload }
    if (['other_unrecorded_rejection', 'expired_unrecorded_rejection'].includes(mode) && request.url === '/v1/operations/continue') {
      const body = request.body
      const challenge = decodeJwt(body.challenge)
      const token = await signOperationReceipt({ ...runtime.signer, issuer: origin }, {
        licenseId: body.license_id, identityJkt: body.identity_jkt, operationId: body.operation_id,
        intentDigest: body.intent_digest, state: 'rejected',
        outcomeCode: mode === 'other_unrecorded_rejection' ? 'LICENSE_REVOKED' : 'ACTIVATION_AUTHORIZATION_INVALID',
        attemptNo: body.attempt_no,
        requestNonceHash: createHash('sha256').update(challenge.server_nonce).digest('base64url'),
        requestDigest: createHash('sha256').update(request.rawBody).digest('base64url'),
        now: new Date(Date.now() - (mode === 'expired_unrecorded_rejection' ? 6 * 60 * 1000 : 0)),
      })
      return { operation_receipt: token }
    }
    if (request.url !== '/v1/operations/query') return payload
    const forgedModes = new Set([
      'forged_actor', 'forged_operation', 'forged_committed_attempt', 'forged_not_found_result',
      'wrong_request_digest', 'wrong_receipt_signature', 'wrong_receipt_kid', 'query_unrecorded_rejection', 'query_not_found',
      'recovery_query_not_found',
    ])
    if (!forgedModes.has(mode)) return payload
    const body = request.body
    if (mode === 'recovery_query_not_found' && body.operation_id !== control.operation_id) return payload
    const challenge = decodeJwt(body.challenge)
    const requestDigest = createHash('sha256').update(request.rawBody).digest('base64url')
    const challengeNonceHash = createHash('sha256').update(challenge.server_nonce).digest('base64url')
    const claims = {
      licenseId: body.license_id,
      identityJkt: mode === 'forged_actor' ? 'A'.repeat(43) : body.identity_jkt,
      operationId: mode === 'forged_operation' ? randomUUID() : body.operation_id,
      intentDigest: body.intent_digest,
      state: ['forged_not_found_result', 'query_not_found', 'recovery_query_not_found'].includes(mode) ? 'not_found'
        : mode === 'query_unrecorded_rejection' ? 'rejected' : 'committed',
      outcomeCode: ['forged_not_found_result', 'query_not_found', 'recovery_query_not_found'].includes(mode) ? 'OPERATION_NOT_FOUND'
        : mode === 'query_unrecorded_rejection' ? 'ACTIVATION_AUTHORIZATION_INVALID' : 'ACTIVATED',
      attemptNo: body.attempt_no,
      requestNonceHash: challengeNonceHash,
      requestDigest: mode === 'wrong_request_digest' ? 'A'.repeat(43) : requestDigest,
      committedAttemptNo: mode === 'forged_committed_attempt' ? 999 : null,
      committedRequestNonceHash: mode === 'forged_committed_attempt' ? 'A'.repeat(43) : null,
      committedRequestDigest: mode === 'forged_committed_attempt' ? 'A'.repeat(43) : null,
      resultJws: mode === 'forged_not_found_result'
        ? `${Buffer.from('{"alg":"Ed25519","typ":"aikayun-license+jwt"}').toString('base64url')}.${Buffer.from('{"sub":"forged"}').toString('base64url')}.${Buffer.alloc(64, 1).toString('base64url')}`
        : null,
      now: new Date(),
    }
    const signer = mode === 'wrong_receipt_kid'
      ? { ...runtime.signer, ...(await runtime.createOnlineKey()), issuer: origin }
      : ['query_not_found', 'recovery_query_not_found'].includes(mode)
        ? { ...runtime.signer, ...currentOnlineKey, issuer: origin }
      : { ...runtime.signer, issuer: origin }
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
  app.addHook('preSerialization', async (request, reply, payload) => {
    if (request.method === 'POST' && request.url === '/v1/leases/renew' && reply.statusCode === 200) {
      let mode
      try { mode = JSON.parse(await readFile(activationControlPath, 'utf8')).mode } catch { return payload }
      if (['forged_recovery_signature', 'wrong_recovery_kid', 'misbound_recovery_request',
        'different_bound_recovery_lease'].includes(mode) &&
        payload && typeof payload === 'object' && typeof payload.license === 'string') {
        const parts = payload.license.split('.')
        if (mode === 'forged_recovery_signature') {
          const signature = parts[2]
          if (!signature) throw new Error('Recovery lease fixture signature is missing')
          parts[2] = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`
        } else if (mode === 'wrong_recovery_kid') {
          const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
          header.kid = 'A'.repeat(43)
          parts[0] = Buffer.from(JSON.stringify(header)).toString('base64url')
        } else {
          const claims = decodeJwt(payload.license)
          const misbound = mode === 'misbound_recovery_request'
          const forged = await signLicenseLease({ ...runtime.signer, issuer: origin }, {
            licenseId: claims.sub,
            databaseId: claims.database_id,
            instanceId: claims.instance_id,
            identityJkt: claims.identity_jkt,
            generation: claims.activation_generation,
            entitlementRevision: claims.entitlement_revision,
            plan: claims.plan,
            subscriptionEnd: new Date(claims.subscription_end * 1000),
            requestNonce: misbound ? randomBytes(32).toString('base64url') : claims.request_nonce,
            requestDigest: misbound ? 'A'.repeat(43) : claims.request_digest,
            now: new Date(),
          })
          return { ...payload, license: forged.token }
        }
        return { ...payload, license: parts.join('.') }
      }
    }
    if (request.method !== 'POST' || request.url !== '/v1/activations' || reply.statusCode !== 409) return payload
    let mode
    try { mode = JSON.parse(await readFile(activationControlPath, 'utf8')).mode } catch { return payload }
    if (!['forged_activation_rejection_signature', 'misbound_activation_rejection_actor', 'misbound_activation_rejection_intent'].includes(mode)) return payload
    if (!payload || typeof payload !== 'object' || typeof payload.operation_receipt !== 'string') return payload
    let token = payload.operation_receipt
    if (mode === 'forged_activation_rejection_signature') {
      const parts = token.split('.')
      const signature = parts[2]
      if (!signature) throw new Error('Activation rejection fixture signature is missing')
      parts[2] = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`
      token = parts.join('.')
    } else {
      const claims = decodeJwt(token)
      token = await signOperationReceipt({ ...runtime.signer, issuer: origin }, {
        licenseId: claims.sub,
        identityJkt: mode === 'misbound_activation_rejection_actor' ? 'A'.repeat(43) : claims.actor_jkt,
        operationId: claims.operation_id,
        intentDigest: mode === 'misbound_activation_rejection_intent' ? 'B'.repeat(43) : claims.intent_digest,
        state: 'rejected',
        outcomeCode: claims.outcome_code,
        attemptNo: claims.attempt_no,
        requestNonceHash: claims.request_nonce_hash,
        requestDigest: claims.request_digest,
        now: new Date(claims.iat * 1000),
      })
    }
    return { operation_receipt: token }
  })
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'POST') return payload
    let mode
    try { mode = JSON.parse(await readFile(activationControlPath, 'utf8')).mode } catch { return payload }
    if (request.url === '/v1/activations' && mode === 'release_activation') {
      await writeFile(activationFinishedPath, 'finished', { mode: 0o600 })
    }
    if ((reply.statusCode === 200 && request.url === '/v1/activations' && mode === 'drop_after_commit') ||
      (reply.statusCode === 200 && request.url === '/v1/operations/continue' && mode === 'drop_continue_after_commit') ||
      (reply.statusCode === 200 && request.url === '/v1/leases/renew' && mode === 'drop_recovery_after_commit') ||
      (reply.statusCode === 200 && request.url === '/v1/operations/continue' && mode === 'drop_recovery_continue_after_commit') ||
      (request.url === '/v1/activations' && mode === 'drop_activation_rejection' && reply.statusCode === 409)) reply.raw.destroy()
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
    activation_committed_conflict: activationCommittedConflict,
    activation_concurrent: activationConcurrent,
    activation_rejected: activationRejected,
    activation_retry_cases: activationRetryCases,
    activation_finalization_cases: activationFinalizationCases,
    activation_expired_challenge: activationExpiredChallenge,
    recovery_expired_renewed: recoveryExpiredRenewed,
    recovery_retired_signer: recoveryRetiredSigner,
    recovery_revoked_signer: recoveryRevokedSigner,
    recovery_revoked_license: recoveryRevokedLicense,
    recovery_expired_subscription: recoveryExpiredSubscription,
    recovery_superseded: recoverySuperseded,
    recovery_wrong_identity: recoveryWrongIdentity,
    recovery_lost_response: recoveryLostResponse,
    recovery_continue: recoveryContinue,
    recovery_crash: recoveryCrash,
    recovery_tamper: recoveryTamper,
    recovery_timeout: recoveryTimeout,
    recovery_forged_response: recoveryForgedResponse,
    recovery_wrong_kid_response: recoveryWrongKidResponse,
    recovery_misbound_response: recoveryMisboundResponse,
    recovery_historical_bad_archive: recoveryHistoricalBadArchive,
    recovery_conflicting_verified_response: recoveryConflictingVerifiedResponse,
    crash_activation_cases: crashActivationCases,
    transport_activation_cases: transportActivationCases,
  }), { mode: 0o600, flag: 'wx' })
  process.stdout.write('READY\n')
} catch {
  process.stderr.write('Isolated authorization center fixture failed to start.\n')
  await cleanup()
  process.exitCode = 1
}
