import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDatabase } from 'file:///app/dist/db/pool.js'
import {
  allocateLicenseOperationAttempt,
  createOrLoadActivationOperation,
  createOrLoadRecoveryOperation,
  markLicenseOperationAttemptSent,
  readActivationOperationPayload,
  readRecoveryOperationPayload,
  readLicenseOperationAttemptEnvelope,
  readLicenseOperationAttemptResponse,
  readLicenseOperationAttemptResultJws,
  readLicenseOperationCenterEvidence,
  saveLicenseOperationResponse,
  saveLicenseOperationResultJws,
} from 'file:///app/dist/licensing/license-operation-store.js'
import { encryptLicensePendingBytes } from 'file:///app/dist/licensing/pending-encryption-key.js'

const operationId = '44444444-4444-4444-8444-444444444444'
const replacementOperationId = '55555555-5555-4555-8555-555555555555'
const licenseId = '11111111-1111-4111-8111-111111111111'
const activationCode = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const origin = 'https://shop.example.test'
const db = createDatabase()

try {
  const mode = process.argv[2]
  const binding = await db.selectFrom('installation_binding').selectAll().where('singleton', '=', true).executeTakeFirst()
  assert.ok(binding?.binding_state === 'ready')

  if (mode === 'seed') {
    const input = {
      operationId,
      licenseId,
      activationCode,
      instanceId: binding.instance_id,
      databaseId: binding.database_id,
      identityJkt: binding.identity_jkt,
      origin,
    }
    const privateKey = await readFile(join(process.env.INSTANCE_IDENTITY_ROOT, 'current', 'instance-private-key.pk8.pem'))
    const exportedJwk = createPublicKey(privateKey).export({ format: 'jwk' })
    const publicJwk = { kty: exportedJwk.kty, crv: exportedJwk.crv, x: exportedJwk.x }
    const operation = await createOrLoadActivationOperation(db, process.env.LICENSE_PENDING_KEY_ROOT, input)
    const clientNonce = Buffer.alloc(32, 0x70).toString('base64url')
    const requestNonce = Buffer.alloc(32, 0x71).toString('base64url')
    const attempt = await allocateLicenseOperationAttempt(db, process.env.LICENSE_PENDING_KEY_ROOT, {
      operationId,
      purpose: 'activation',
      intentDigest: operation.intentDigest,
      clientNonce,
      requestNonce,
      identityJkt: binding.identity_jkt,
      buildRequest(attemptNo) {
        const requestBody = Buffer.from(JSON.stringify({
          operation_id: operationId,
          intent_digest: operation.intentDigest,
          attempt_no: attemptNo,
          license_id: licenseId,
          database_id: binding.database_id,
          instance_id: binding.instance_id,
          identity_jkt: binding.identity_jkt,
          public_jwk: publicJwk,
          challenge: 'synthetic-test-challenge-token'.padEnd(128, 'x'),
          activation_code: activationCode,
          origin,
        }), 'utf8')
        return {
          requestBody,
          signingKeyId: binding.identity_jkt,
          signatureCreatedAt: new Date('2026-10-30T00:00:00.000Z'),
          requestEnvelope: Buffer.from(JSON.stringify({
            schema: 1,
            method: 'POST',
            target: '/v1/activations',
            headers: {
              'x-test-client-nonce': clientNonce,
              'x-test-request-nonce': requestNonce,
              signature: 'synthetic-test-only',
            },
            body_base64url: requestBody.toString('base64url'),
          }), 'utf8'),
        }
      },
    })
    await markLicenseOperationAttemptSent(db, operationId, attempt.attemptNo)
    // These are storage-only fixture JWS values signed by a disposable key. Real center
    // receipt verification and finalization are covered by the isolated HTTPS interop.
    const { privateKey: resultKey, publicKey: resultPublicKey } = generateKeyPairSync('ed25519')
    const signJws = claims => {
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'aikayun-license-operation+jwt', kid: 'test-only' })).toString('base64url')
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
      const signingInput = Buffer.from(`${header}.${payload}`)
      const signature = sign(null, signingInput, resultKey)
      assert.ok(verify(null, signingInput, resultPublicKey, signature))
      return Buffer.from(`${signingInput.toString('ascii')}.${signature.toString('base64url')}`)
    }
    const savedAttempt = await db.selectFrom('local_license_operation_attempts').selectAll()
      .where('operation_id', '=', operationId).where('attempt_no', '=', attempt.attemptNo).executeTakeFirstOrThrow()
    const issuedAt = Math.floor(Date.now() / 1000)
    const resultJws = signJws({
      iss: 'https://center.example.test', aud: 'aikayun-license-operation', sub: licenseId,
      actor_jkt: binding.identity_jkt, operation_id: operationId, intent_digest: operation.intentDigest,
      v: 1, jti: randomUUID(), iat: issuedAt, exp: issuedAt + 300,
      state: 'rejected', outcome_code: 'LICENSE_REVOKED', attempt_no: attempt.attemptNo,
      request_nonce_hash: savedAttempt.request_nonce_hash, request_digest: savedAttempt.request_body_digest,
      committed_attempt_no: attempt.attemptNo, committed_request_nonce_hash: savedAttempt.request_nonce_hash,
      committed_request_digest: savedAttempt.request_body_digest,
    })
    await saveLicenseOperationResultJws(db, process.env.LICENSE_PENDING_KEY_ROOT, operationId, attempt.attemptNo, resultJws)
    assert.deepEqual(await readLicenseOperationAttemptResultJws(db, process.env.LICENSE_PENDING_KEY_ROOT, operationId, 1), resultJws)
    const responseJws = signJws({
      iss: 'https://center.example.test', aud: 'aikayun-license-operation', sub: licenseId,
      actor_jkt: binding.identity_jkt, operation_id: operationId, intent_digest: operation.intentDigest,
      v: 1, jti: randomUUID(), iat: issuedAt, exp: issuedAt + 300,
      state: 'rejected', outcome_code: 'LICENSE_REVOKED', attempt_no: attempt.attemptNo,
      request_nonce_hash: savedAttempt.request_nonce_hash, request_digest: savedAttempt.request_body_digest,
      committed_attempt_no: attempt.attemptNo, committed_request_nonce_hash: savedAttempt.request_nonce_hash,
      committed_request_digest: savedAttempt.request_body_digest, result_jws: resultJws.toString('ascii'),
    })
    await saveLicenseOperationResponse(db, process.env.LICENSE_PENDING_KEY_ROOT, operationId, attempt.attemptNo, responseJws)
    const recovery = await createOrLoadRecoveryOperation(db, process.env.LICENSE_PENDING_KEY_ROOT, {
      licenseId,
      recoveryOfOperationId: operationId,
      expectedGeneration: '1',
      knownRevision: '1',
      instanceId: binding.instance_id,
      databaseId: binding.database_id,
      identityJkt: binding.identity_jkt,
    })
    const recoveryClientNonce = Buffer.alloc(32, 0x72).toString('base64url')
    const recoveryRequestNonce = Buffer.alloc(32, 0x73).toString('base64url')
    await allocateLicenseOperationAttempt(db, process.env.LICENSE_PENDING_KEY_ROOT, {
      operationId: recovery.operationId,
      purpose: 'recovery',
      intentDigest: recovery.intentDigest,
      clientNonce: recoveryClientNonce,
      requestNonce: recoveryRequestNonce,
      identityJkt: binding.identity_jkt,
      buildRequest(attemptNo) {
        const requestBody = Buffer.from(JSON.stringify({
          operation_id: recovery.operationId,
          intent_digest: recovery.intentDigest,
          attempt_no: attemptNo,
          license_id: licenseId,
          database_id: binding.database_id,
          instance_id: binding.instance_id,
          identity_jkt: binding.identity_jkt,
          public_jwk: publicJwk,
          challenge: 'synthetic-recovery-challenge'.padEnd(128, 'x'),
          expected_generation: '1',
          known_revision: '1',
          recovery_of_operation_id: operationId,
        }), 'utf8')
        return {
          requestBody,
          signingKeyId: binding.identity_jkt,
          signatureCreatedAt: new Date('2026-10-30T00:00:00.000Z'),
          requestEnvelope: Buffer.from(JSON.stringify({
            schema: 1,
            method: 'POST',
            target: '/v1/leases/renew',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body_base64url: requestBody.toString('base64url'),
          }), 'utf8'),
        }
      },
    })
    const encryptedEvidence = await encryptLicensePendingBytes(process.env.LICENSE_PENDING_KEY_ROOT, {
      operationId, record: 'operation', field: 'center_evidence',
    }, responseJws)
    await db.updateTable('local_license_operations').set({
      state: 'terminal', encrypted_center_evidence: encryptedEvidence.ciphertext,
      center_evidence_key_id: encryptedEvidence.keyId,
      center_evidence_digest: createHash('sha256').update(responseJws).digest('base64url'),
      finalized_at: new Date(),
    }).where('operation_id', '=', operationId).where('state', '=', 'response_saved').executeTakeFirstOrThrow()
    assert.deepEqual(await readLicenseOperationCenterEvidence(db, process.env.LICENSE_PENDING_KEY_ROOT, operationId), responseJws)
    process.stdout.write(`RESULT_JWS=${resultJws.toString('base64url')}\n`)
    process.stdout.write(`CENTER_EVIDENCE=${responseJws.toString('base64url')}\n`)
    process.stdout.write('license_pending_fixture_seeded\n')
  } else if (mode === 'verify') {
    const payload = await readActivationOperationPayload(db, process.env.LICENSE_PENDING_KEY_ROOT, operationId)
    assert.deepEqual(payload, { activationCode, origin })
    const recovery = await db.selectFrom('local_license_operations').selectAll().where('kind', '=', 'recovery').executeTakeFirstOrThrow()
    assert.deepEqual(await readRecoveryOperationPayload(db, process.env.LICENSE_PENDING_KEY_ROOT, recovery.operation_id), {
      recoveryOfOperationId: operationId, expectedGeneration: '1', knownRevision: '1',
    })
    assert.equal((await readLicenseOperationAttemptEnvelope(
      db, process.env.LICENSE_PENDING_KEY_ROOT, recovery.operation_id, 1,
    )).purpose, 'recovery')
    const response = await readLicenseOperationAttemptResponse(db, process.env.LICENSE_PENDING_KEY_ROOT, operationId, 1)
    const centerEvidence = await readLicenseOperationCenterEvidence(db, process.env.LICENSE_PENDING_KEY_ROOT, operationId)
    assert.ok(centerEvidence)
    assert.deepEqual(centerEvidence, response)
    const resultJws = await readLicenseOperationAttemptResultJws(db, process.env.LICENSE_PENDING_KEY_ROOT, operationId, 1)
    assert.ok(resultJws)
    process.stdout.write(`RESULT_JWS=${resultJws.toString('base64url')}\n`)
    process.stdout.write(`CENTER_EVIDENCE=${centerEvidence.toString('base64url')}\n`)
    const state = await db.selectFrom('local_license_operations').select('state')
      .where('operation_id', '=', operationId).executeTakeFirstOrThrow()
    assert.equal(state.state, 'terminal')
    const replacement = await createOrLoadActivationOperation(db, process.env.LICENSE_PENDING_KEY_ROOT, {
      operationId: replacementOperationId, licenseId, activationCode,
      instanceId: binding.instance_id, databaseId: binding.database_id,
      identityJkt: binding.identity_jkt, origin,
    })
    assert.equal(replacement.state, 'pending')
    process.stdout.write('license_pending_fixture_pair_verified\n')
  } else {
    throw new Error('Expected seed or verify')
  }
} finally {
  await db.destroy()
}
