import assert from 'node:assert/strict'
import { createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDatabase } from 'file:///app/dist/db/pool.js'
import {
  allocateLicenseOperationAttempt,
  createOrLoadActivationOperation,
  markLicenseOperationAttemptSent,
  readActivationOperationPayload,
  readSavedLicenseOperationResponse,
  saveLicenseOperationResponse,
} from 'file:///app/dist/licensing/license-operation-store.js'

const operationId = '44444444-4444-4444-8444-444444444444'
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
    await saveLicenseOperationResponse(db, process.env.LICENSE_PENDING_KEY_ROOT, operationId, attempt.attemptNo,
      Buffer.from('synthetic signed center response; no network request was made', 'utf8'))
    process.stdout.write('license_pending_fixture_seeded\n')
  } else if (mode === 'verify') {
    const payload = await readActivationOperationPayload(db, process.env.LICENSE_PENDING_KEY_ROOT, operationId)
    assert.deepEqual(payload, { activationCode, origin })
    const response = await readSavedLicenseOperationResponse(db, process.env.LICENSE_PENDING_KEY_ROOT, operationId)
    assert.equal(response.toString('utf8'), 'synthetic signed center response; no network request was made')
    const state = await db.selectFrom('local_license_operations').select('state')
      .where('operation_id', '=', operationId).executeTakeFirstOrThrow()
    assert.equal(state.state, 'response_saved')
    process.stdout.write('license_pending_fixture_pair_verified\n')
  } else {
    throw new Error('Expected seed or verify')
  }
} finally {
  await db.destroy()
}
