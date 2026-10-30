import { randomBytes } from 'node:crypto'
import { createDatabase } from '../../src/db/pool.js'
import { buildActivationIntent, sha256Base64url } from '../../src/licensing/license-intent.js'
import {
  allocateLicenseOperationAttempt,
  createOrLoadActivationOperation,
} from '../../src/licensing/license-operation-store.js'
import { verifyLicensePendingBackupPair } from '../../src/licensing/license-pending-restore-check.js'
import { encryptLicensePendingBytes } from '../../src/licensing/pending-encryption-key.js'

const [mode, schema, pendingRoot, operationId, licenseId, databaseId, instanceId, identityJkt, activationCode] = process.argv.slice(2)
if (!mode || !schema || !pendingRoot || !operationId || !licenseId || !databaseId || !instanceId || !identityJkt || !activationCode) {
  throw new Error('Missing isolated license operation fixture arguments')
}

const baseUrl = new URL(process.env.TEST_DATABASE_URL ?? '')
baseUrl.searchParams.set('options', `-c search_path=${schema}`)
process.env.DATABASE_URL = baseUrl.toString()
process.env.NODE_ENV = 'test'
const db = createDatabase()
const input = { operationId, licenseId, activationCode, instanceId, databaseId, identityJkt, origin: 'https://shop.example.test' }
const intent = buildActivationIntent(input)

function attemptInput(fixed: boolean) {
  const clientNonce = fixed ? Buffer.alloc(32, 0x70).toString('base64url') : randomBytes(32).toString('base64url')
  const requestNonce = fixed ? Buffer.alloc(32, 0x71).toString('base64url') : randomBytes(32).toString('base64url')
  return {
    operationId,
    purpose: 'activation' as const,
    intentDigest: intent.intentDigest,
    clientNonce,
    requestNonce,
    identityJkt,
    buildRequest(attemptNo: number) {
      const requestBody = Buffer.from(JSON.stringify({
        operation_id: operationId,
        intent_digest: intent.intentDigest,
        attempt_no: attemptNo,
        license_id: licenseId,
        database_id: databaseId,
        instance_id: instanceId,
        identity_jkt: identityJkt,
        public_jwk: { kty: 'OKP', crv: 'Ed25519', x: Buffer.alloc(32, 9).toString('base64url') },
        challenge: 'synthetic-test-challenge-token'.padEnd(128, 'x'),
        activation_code: activationCode,
        origin: input.origin,
      }), 'utf8')
      const requestEnvelope = Buffer.from(JSON.stringify({
        schema: 1,
        method: 'POST',
        target: '/v1/activations',
        headers: {
          'x-test-client-nonce': clientNonce,
          'x-test-request-nonce': requestNonce,
          signature: 'synthetic-test-only',
        },
        body_base64url: requestBody.toString('base64url'),
      }), 'utf8')
      return {
        requestBody,
        signingKeyId: identityJkt,
        signatureCreatedAt: fixed ? new Date('2026-10-30T00:00:00.000Z') : new Date(),
        requestEnvelope,
      }
    },
  }
}

if (mode === 'restore-check') {
  const result = await verifyLicensePendingBackupPair()
  process.stdout.write(`verified operations=${result.operations} attempts=${result.attempts}\n`)
} else if (mode === 'commit-operation') {
  await createOrLoadActivationOperation(db, pendingRoot, input)
  process.kill(process.pid, 'SIGKILL')
} else if (mode === 'commit-attempt') {
  const result = await allocateLicenseOperationAttempt(db, pendingRoot, attemptInput(true))
  process.stdout.write(`${result.attemptNo}\n`)
  process.kill(process.pid, 'SIGKILL')
} else if (mode === 'concurrent-attempt') {
  const result = await allocateLicenseOperationAttempt(db, pendingRoot, attemptInput(false))
  process.stdout.write(`${result.attemptNo}\n`)
} else if (mode === 'rollback-operation') {
  const encrypted = await encryptLicensePendingBytes(pendingRoot, {
    operationId, record: 'operation', field: 'intent_payload',
  }, Buffer.from(JSON.stringify({ schema: 1, activation_code: activationCode, origin: input.origin }), 'utf8'))
  await db.transaction().execute(async trx => {
    await trx.insertInto('local_license_operations').values({
      operation_id: operationId, kind: 'activation', intent_digest: intent.intentDigest,
      license_id: licenseId, database_id: databaseId, instance_id: instanceId, identity_jkt: identityJkt,
      expected_generation: null, intent_schema: 1, payload_key_id: encrypted.keyId,
      encrypted_intent_payload: encrypted.ciphertext, state: 'pending', response_attempt_no: null,
      response_digest: null, encrypted_center_evidence: null, center_evidence_key_id: null,
      center_evidence_digest: null, response_saved_at: null, finalized_at: null,
    }).execute()
    process.kill(process.pid, 'SIGKILL')
  })
} else if (mode === 'rollback-attempt') {
  const evidence = attemptInput(true)
  const built = evidence.buildRequest(1)
  const bodyDigest = sha256Base64url(built.requestBody)
  const requestNonceHash = sha256Base64url(evidence.requestNonce)
  const clientNonceHash = sha256Base64url(evidence.clientNonce)
  const encrypted = await encryptLicensePendingBytes(pendingRoot, {
    operationId, attemptNo: 1, record: 'attempt', field: 'request_envelope',
  }, built.requestEnvelope)
  await db.transaction().execute(async trx => {
    await trx.insertInto('local_license_operation_attempts').values({
      operation_id: operationId, attempt_no: 1, purpose: 'activation', intent_digest: intent.intentDigest,
      client_nonce_hash: clientNonceHash, request_nonce_hash: requestNonceHash,
      request_body_digest: bodyDigest, identity_jkt: identityJkt, signing_key_id: identityJkt,
      signature_created_at: built.signatureCreatedAt, request_key_id: encrypted.keyId,
      encrypted_request_envelope: encrypted.ciphertext, send_state: 'prepared', sent_at: null,
      response_key_id: null, encrypted_response: null, response_digest: null, response_saved_at: null,
    }).execute()
    process.kill(process.pid, 'SIGKILL')
  })
} else {
  await db.destroy()
  throw new Error('Unknown isolated license operation fixture mode')
}

await db.destroy()
