import { createHash, randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import type {
  Database,
  LocalLicenseAttemptPurpose,
  LocalLicenseAttemptSendState,
  LocalLicenseOperationState,
  LocalLicenseOperationsTable,
} from '../db/types.js'
import { buildActivationIntent, ed25519IdentityJkt, sha256Base64url } from './license-intent.js'
import {
  decryptLicensePendingBytes,
  encryptLicensePendingBytes,
} from './pending-encryption-key.js'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const digestPattern = /^[A-Za-z0-9_-]{43}$/u

export class LocalLicenseOperationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'LocalLicenseOperationError'
  }
}

export interface ActivationOperationInput {
  operationId: string
  licenseId: string
  activationCode: string
  instanceId: string
  databaseId: string
  identityJkt: string
  origin: string | null
}

export interface StoredActivationOperation {
  operationId: string
  intentDigest: string
  state: LocalLicenseOperationState
  created: boolean
}

export interface AllocateOperationAttemptInput {
  operationId: string
  purpose: LocalLicenseAttemptPurpose
  intentDigest: string
  clientNonce: string
  requestNonce: string
  identityJkt: string
  buildRequest: (attemptNo: number) => BuiltLicenseOperationRequest
}

export interface BuiltLicenseOperationRequest {
  requestBody: Uint8Array
  signingKeyId: string
  signatureCreatedAt: Date
  requestEnvelope: Uint8Array
}

export interface AllocatedOperationAttempt {
  operationId: string
  attemptNo: number
  requestBodyDigest: string
  requestNonceHash: string
  state: LocalLicenseAttemptSendState
  requestEnvelope: Buffer
  reused: boolean
}

function invalid(code: string): never {
  throw new LocalLicenseOperationError(code)
}

function assertUuid(value: string): void {
  if (!uuidPattern.test(value)) invalid('invalid_operation_binding')
}

function assertJkt(value: string): void {
  if (!digestPattern.test(value)) invalid('invalid_operation_binding')
}

function assertNonce(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) invalid('invalid_attempt_nonce')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) invalid('invalid_attempt_nonce')
}

function validateRequestEnvelope(envelopeBytes: Uint8Array, expectedBodyDigest: string): void {
  let value: unknown
  try { value = JSON.parse(Buffer.from(envelopeBytes).toString('utf8')) as unknown } catch { invalid('attempt_request_envelope_invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('attempt_request_envelope_invalid')
  const envelope = value as Record<string, unknown>
  if (Object.keys(envelope).sort().join(',') !== 'body_base64url,headers,method,schema,target' ||
    envelope.schema !== 1 || envelope.method !== 'POST' || typeof envelope.target !== 'string' ||
    !/^\/[A-Za-z0-9_./-]{1,512}$/u.test(envelope.target) ||
    typeof envelope.body_base64url !== 'string' || !/^(?:[A-Za-z0-9_-]{2,})?$/u.test(envelope.body_base64url) ||
    !envelope.headers || typeof envelope.headers !== 'object' || Array.isArray(envelope.headers)) {
    invalid('attempt_request_envelope_invalid')
  }
  const body = Buffer.from(envelope.body_base64url, 'base64url')
  if (body.toString('base64url') !== envelope.body_base64url || sha256Base64url(body) !== expectedBodyDigest) {
    invalid('attempt_request_envelope_body_mismatch')
  }
  for (const [name, headerValue] of Object.entries(envelope.headers as Record<string, unknown>)) {
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(name) || typeof headerValue !== 'string' || /[\r\n]/u.test(headerValue)) {
      invalid('attempt_request_envelope_invalid')
    }
  }
}

function parseJsonObject(bytes: Uint8Array, errorCode: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown } catch { invalid(errorCode) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(errorCode)
  return value as Record<string, unknown>
}

async function decryptActivationPayload(
  pendingKeyRoot: string,
  operation: Pick<LocalLicenseOperationsTable,
    'operation_id' | 'kind' | 'license_id' | 'database_id' | 'instance_id' | 'identity_jkt' |
    'intent_digest' | 'payload_key_id' | 'encrypted_intent_payload'>,
): Promise<{ activationCode: string; origin: string | null }> {
  if (operation.kind !== 'activation') invalid('operation_unavailable')
  const plaintext = await decryptLicensePendingBytes(pendingKeyRoot, {
    operationId: operation.operation_id,
    record: 'operation',
    field: 'intent_payload',
  }, { keyId: operation.payload_key_id, ciphertext: operation.encrypted_intent_payload })
  const payload = parseJsonObject(plaintext, 'operation_payload_corrupt')
  if (Object.keys(payload).sort().join(',') !== 'activation_code,origin,schema' || payload.schema !== 1 ||
    typeof payload.activation_code !== 'string' || !(typeof payload.origin === 'string' || payload.origin === null)) {
    invalid('operation_payload_corrupt')
  }
  const intent = buildActivationIntent({
    licenseId: operation.license_id,
    activationCode: payload.activation_code,
    instanceId: operation.instance_id,
    databaseId: operation.database_id,
    identityJkt: operation.identity_jkt,
    origin: payload.origin,
  })
  if (intent.intentDigest !== operation.intent_digest) invalid('operation_payload_intent_mismatch')
  return { activationCode: payload.activation_code, origin: payload.origin }
}

function validateOperationRequestBody(
  bodyBytes: Uint8Array,
  target: string,
  operation: Pick<LocalLicenseOperationsTable,
    'operation_id' | 'kind' | 'license_id' | 'database_id' | 'instance_id' | 'identity_jkt' | 'intent_digest'>,
  purpose: LocalLicenseAttemptPurpose,
  attemptNo: number,
  payload?: { activationCode: string; origin: string | null },
): void {
  const body = parseJsonObject(bodyBytes, 'attempt_request_body_invalid')
  const publicJwk = body.public_jwk
  if (body.operation_id !== operation.operation_id || body.intent_digest !== operation.intent_digest ||
    body.attempt_no !== attemptNo || body.license_id !== operation.license_id ||
    body.database_id !== operation.database_id || body.instance_id !== operation.instance_id ||
    body.identity_jkt !== operation.identity_jkt || typeof body.challenge !== 'string' ||
    body.challenge.length < 100 || body.challenge.length > 16384 ||
    !publicJwk || typeof publicJwk !== 'object' || Array.isArray(publicJwk)) invalid('attempt_request_binding_conflict')
  const jwk = publicJwk as Record<string, unknown>
  if (Object.keys(jwk).sort().join(',') !== 'crv,kty,x' || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.x)) invalid('attempt_request_binding_conflict')
  const publicKey = Buffer.from(jwk.x, 'base64url')
  if (publicKey.length !== 32 || publicKey.toString('base64url') !== jwk.x) invalid('attempt_request_binding_conflict')
  if (ed25519IdentityJkt({ kty: 'OKP', crv: 'Ed25519', x: jwk.x }) !== operation.identity_jkt) {
    invalid('attempt_request_binding_conflict')
  }
  if (purpose === 'activation' || (purpose === 'continue' && operation.kind === 'activation')) {
    const expectedTarget = purpose === 'activation' ? '/v1/activations' : '/v1/operations/continue'
    if (operation.kind !== 'activation' || target !== expectedTarget || !payload ||
      body.activation_code !== payload.activationCode || body.origin !== payload.origin ||
      (purpose === 'continue' && body.kind !== 'activation')) invalid('attempt_request_binding_conflict')
  } else if (purpose === 'query') {
    if (target !== '/v1/operations/query') invalid('attempt_request_binding_conflict')
  } else if (purpose === 'continue') {
    invalid('attempt_request_kind_not_supported')
  }
}

async function validateStoredOperationRequest(
  pendingKeyRoot: string,
  operation: Pick<LocalLicenseOperationsTable,
    'operation_id' | 'kind' | 'license_id' | 'database_id' | 'instance_id' | 'identity_jkt' |
    'intent_digest' | 'payload_key_id' | 'encrypted_intent_payload'>,
  purpose: LocalLicenseAttemptPurpose,
  attemptNo: number,
  requestBodyDigest: string,
  requestEnvelope: Uint8Array,
): Promise<void> {
  validateRequestEnvelope(requestEnvelope, requestBodyDigest)
  const envelope = parseJsonObject(requestEnvelope, 'attempt_request_envelope_invalid')
  if (typeof envelope.target !== 'string' || typeof envelope.body_base64url !== 'string') {
    invalid('attempt_request_envelope_invalid')
  }
  const activationPayload = operation.kind === 'activation' && purpose !== 'query'
    ? await decryptActivationPayload(pendingKeyRoot, operation)
    : undefined
  validateOperationRequestBody(
    Buffer.from(envelope.body_base64url, 'base64url'),
    envelope.target,
    operation,
    purpose,
    attemptNo,
    activationPayload,
  )
}

function postgresCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

async function lockOperation(trx: Transaction<Database>, operationId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${operationId}, 0))`.execute(trx)
}

async function databaseNow(trx: Transaction<Database>): Promise<Date> {
  const result = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)
  return result.rows[0]!.now
}

function sameActivation(
  row: Pick<LocalLicenseOperationsTable, 'kind' | 'intent_digest' | 'license_id' | 'database_id' | 'instance_id' | 'identity_jkt'>,
  input: ActivationOperationInput,
  digest: string,
): boolean {
  return row.kind === 'activation' && row.intent_digest === digest && row.license_id === input.licenseId &&
    row.database_id === input.databaseId && row.instance_id === input.instanceId && row.identity_jkt === input.identityJkt
}

/** Persist the activation intent before any future challenge/request network phase. */
export async function createOrLoadActivationOperation(
  db: Kysely<Database>,
  pendingKeyRoot: string,
  input: ActivationOperationInput,
): Promise<StoredActivationOperation> {
  assertUuid(input.operationId)
  assertUuid(input.licenseId)
  assertUuid(input.databaseId)
  assertUuid(input.instanceId)
  assertJkt(input.identityJkt)
  const intent = buildActivationIntent(input)
  const encrypted = await encryptLicensePendingBytes(pendingKeyRoot, {
    operationId: input.operationId,
    record: 'operation',
    field: 'intent_payload',
  }, Buffer.from(JSON.stringify({ schema: 1, activation_code: input.activationCode, origin: input.origin }), 'utf8'))

  try {
    return await db.transaction().execute(async (trx) => {
      await lockOperation(trx, input.operationId)
      const existing = await trx.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', input.operationId).forUpdate().executeTakeFirst()
      if (existing) {
        if (!sameActivation(existing, input, intent.intentDigest)) invalid('operation_id_intent_conflict')
        return { operationId: existing.operation_id, intentDigest: existing.intent_digest, state: existing.state, created: false }
      }
      const binding = await trx.selectFrom('installation_binding').selectAll()
        .where('singleton', '=', true).forUpdate().executeTakeFirst()
      if (!binding || binding.binding_state !== 'ready' ||
        binding.database_id !== input.databaseId || binding.instance_id !== input.instanceId ||
        binding.identity_jkt !== input.identityJkt) invalid('installation_binding_conflict')
      const created = await trx.insertInto('local_license_operations').values({
        operation_id: input.operationId,
        kind: 'activation',
        intent_digest: intent.intentDigest,
        license_id: input.licenseId,
        database_id: input.databaseId,
        instance_id: input.instanceId,
        identity_jkt: input.identityJkt,
        expected_generation: null,
        intent_schema: 1,
        payload_key_id: encrypted.keyId,
        encrypted_intent_payload: encrypted.ciphertext,
        state: 'pending',
        response_attempt_no: null,
        response_digest: null,
        encrypted_center_evidence: null,
        center_evidence_key_id: null,
        center_evidence_digest: null,
        response_saved_at: null,
        finalized_at: null,
      }).returning(['operation_id', 'intent_digest', 'state']).executeTakeFirstOrThrow()
      return { operationId: created.operation_id, intentDigest: created.intent_digest, state: created.state, created: true }
    })
  } catch (error) {
    if (error instanceof LocalLicenseOperationError) throw error
    if (postgresCode(error) === '23505') invalid('operation_binding_already_pending')
    if (postgresCode(error) === '23514') invalid('operation_binding_invalid')
    throw error
  }
}

export async function readActivationOperationPayload(
  db: Kysely<Database>,
  pendingKeyRoot: string,
  operationId: string,
): Promise<{ activationCode: string; origin: string | null }> {
  const row = await db.selectFrom('local_license_operations').selectAll()
    .where('operation_id', '=', operationId).executeTakeFirst()
  if (!row) invalid('operation_unavailable')
  return decryptActivationPayload(pendingKeyRoot, row)
}

/** Allocate the next immutable attempt number under both an operation advisory lock and parent row lock. */
export async function allocateLicenseOperationAttempt(
  db: Kysely<Database>,
  pendingKeyRoot: string,
  input: AllocateOperationAttemptInput,
): Promise<AllocatedOperationAttempt> {
  assertUuid(input.operationId)
  assertJkt(input.identityJkt)
  assertNonce(input.clientNonce)
  assertNonce(input.requestNonce)
  if (!digestPattern.test(input.intentDigest)) invalid('invalid_attempt_evidence')
  const requestNonceHash = sha256Base64url(input.requestNonce)
  const clientNonceHash = sha256Base64url(input.clientNonce)

  try {
    return await db.transaction().execute(async (trx) => {
      await lockOperation(trx, input.operationId)
      const operation = await trx.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', input.operationId).forUpdate().executeTakeFirst()
      if (!operation) invalid('operation_not_pending')
      if (operation.intent_digest !== input.intentDigest || operation.identity_jkt !== input.identityJkt) {
        invalid('operation_attempt_binding_conflict')
      }
      if (input.purpose === 'activation' && operation.kind !== 'activation') invalid('attempt_purpose_conflict')
      const prior = await trx.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId)
        .where(eb => eb.or([
          eb('client_nonce_hash', '=', clientNonceHash),
          eb('request_nonce_hash', '=', requestNonceHash),
        ])).forUpdate().executeTakeFirst()
      if (prior) {
        const originalEnvelope = await decryptLicensePendingBytes(pendingKeyRoot, {
          operationId: input.operationId,
          attemptNo: prior.attempt_no,
          record: 'attempt',
          field: 'request_envelope',
        }, { keyId: prior.request_key_id, ciphertext: prior.encrypted_request_envelope })
        if (prior.purpose !== input.purpose || prior.intent_digest !== input.intentDigest ||
          prior.client_nonce_hash !== clientNonceHash || prior.request_nonce_hash !== requestNonceHash ||
          prior.identity_jkt !== input.identityJkt) invalid('attempt_nonce_or_number_reused')
        await validateStoredOperationRequest(pendingKeyRoot, operation, prior.purpose, prior.attempt_no,
          prior.request_body_digest, originalEnvelope)
        return {
          operationId: prior.operation_id,
          attemptNo: prior.attempt_no,
          requestBodyDigest: prior.request_body_digest,
          requestNonceHash: prior.request_nonce_hash,
          state: prior.send_state,
          requestEnvelope: originalEnvelope,
          reused: true,
        }
      }
      if (operation.state !== 'pending' && operation.state !== 'response_saved') invalid('operation_not_pending')
      if (operation.state === 'response_saved' && input.purpose === 'activation') invalid('operation_not_pending')
      const lastAttempt = await trx.selectFrom('local_license_operation_attempts').select('attempt_no')
        .where('operation_id', '=', input.operationId).orderBy('attempt_no', 'desc').forUpdate().executeTakeFirst()
      const attemptNo = (lastAttempt?.attempt_no ?? 0) + 1
      const built = input.buildRequest(attemptNo)
      if (!built || built.signingKeyId !== operation.identity_jkt || built.signingKeyId.length > 128 ||
        !(built.signatureCreatedAt instanceof Date) || !Number.isFinite(built.signatureCreatedAt.getTime())) {
        invalid('invalid_attempt_evidence')
      }
      const requestBodyDigest = sha256Base64url(built.requestBody)
      validateRequestEnvelope(built.requestEnvelope, requestBodyDigest)
      const parsedEnvelope = parseJsonObject(built.requestEnvelope, 'attempt_request_envelope_invalid')
      if (typeof parsedEnvelope.target !== 'string') invalid('attempt_request_envelope_invalid')
      const activationPayload = operation.kind === 'activation' && input.purpose !== 'query'
        ? await decryptActivationPayload(pendingKeyRoot, operation)
        : undefined
      validateOperationRequestBody(built.requestBody, parsedEnvelope.target, operation, input.purpose, attemptNo, activationPayload)
      const encryptedRequest = await encryptLicensePendingBytes(pendingKeyRoot, {
        operationId: input.operationId,
        attemptNo,
        record: 'attempt',
        field: 'request_envelope',
      }, built.requestEnvelope)
      const created = await trx.insertInto('local_license_operation_attempts').values({
        operation_id: input.operationId,
        attempt_no: attemptNo,
        purpose: input.purpose,
        intent_digest: input.intentDigest,
        client_nonce_hash: clientNonceHash,
        request_nonce_hash: requestNonceHash,
        request_body_digest: requestBodyDigest,
        identity_jkt: input.identityJkt,
        signing_key_id: built.signingKeyId,
        signature_created_at: built.signatureCreatedAt,
        request_key_id: encryptedRequest.keyId,
        encrypted_request_envelope: encryptedRequest.ciphertext,
        send_state: 'prepared',
        sent_at: null,
        response_key_id: null,
        encrypted_response: null,
        response_digest: null,
        response_saved_at: null,
      }).returning(['operation_id', 'attempt_no', 'request_body_digest', 'request_nonce_hash', 'send_state'])
        .executeTakeFirstOrThrow()
      return {
        operationId: created.operation_id,
        attemptNo: created.attempt_no,
        requestBodyDigest: created.request_body_digest,
        requestNonceHash: created.request_nonce_hash,
        state: created.send_state,
        requestEnvelope: Buffer.from(built.requestEnvelope),
        reused: false,
      }
    })
  } catch (error) {
    if (error instanceof LocalLicenseOperationError) throw error
    if (postgresCode(error) === '23505') invalid('attempt_nonce_or_number_reused')
    if (postgresCode(error) === '23514') invalid('operation_attempt_binding_conflict')
    throw error
  }
}

export async function markLicenseOperationAttemptSent(
  db: Kysely<Database>,
  operationId: string,
  attemptNo: number,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await lockOperation(trx, operationId)
    const parent = await trx.selectFrom('local_license_operations').select('state')
      .where('operation_id', '=', operationId).forUpdate().executeTakeFirst()
    if (!parent || !['pending', 'response_saved'].includes(parent.state)) invalid('operation_not_pending')
    const attempt = await trx.selectFrom('local_license_operation_attempts').select(['purpose', 'send_state'])
      .where('operation_id', '=', operationId).where('attempt_no', '=', attemptNo).forUpdate().executeTakeFirst()
    if (!attempt || (parent.state === 'response_saved' && attempt.purpose === 'activation')) invalid('attempt_send_state_conflict')
    const sentAt = await databaseNow(trx)
    const updated = await trx.updateTable('local_license_operation_attempts')
      .set({ send_state: 'sent', sent_at: sentAt })
      .where('operation_id', '=', operationId).where('attempt_no', '=', attemptNo)
      .where('send_state', '=', 'prepared').returning('attempt_no').executeTakeFirst()
    if (!updated) invalid('attempt_send_state_conflict')
  })
}

export async function markLicenseOperationAttemptTransportResult(
  db: Kysely<Database>,
  operationId: string,
  attemptNo: number,
  result: 'transport_unknown' | 'transport_error',
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await lockOperation(trx, operationId)
    const parent = await trx.selectFrom('local_license_operations').select('state')
      .where('operation_id', '=', operationId).forUpdate().executeTakeFirst()
    if (!parent || !['pending', 'response_saved'].includes(parent.state)) invalid('operation_not_pending')
    const attempt = await trx.selectFrom('local_license_operation_attempts').select(['purpose', 'send_state'])
      .where('operation_id', '=', operationId).where('attempt_no', '=', attemptNo).forUpdate().executeTakeFirst()
    if (!attempt || (parent.state === 'response_saved' && attempt.purpose === 'activation')) invalid('attempt_send_state_conflict')
    const resultAt = await databaseNow(trx)
    const updated = await trx.updateTable('local_license_operation_attempts')
      .set({ send_state: result, sent_at: resultAt })
      .where('operation_id', '=', operationId).where('attempt_no', '=', attemptNo)
      .where('send_state', 'in', ['prepared', 'sent']).returning('attempt_no').executeTakeFirst()
    if (!updated) invalid('attempt_send_state_conflict')
  })
}

/** Save response bytes before any future receipt verification or local projection. */
export async function saveLicenseOperationResponse(
  db: Kysely<Database>,
  pendingKeyRoot: string,
  operationId: string,
  attemptNo: number,
  rawSignedResponse: Uint8Array,
): Promise<{ responseDigest: string }> {
  if (!Number.isSafeInteger(attemptNo) || attemptNo < 1 || rawSignedResponse.byteLength === 0) invalid('invalid_response')
  const responseDigest = createHash('sha256').update(rawSignedResponse).digest('base64url')
  const encrypted = await encryptLicensePendingBytes(pendingKeyRoot, {
    operationId,
    attemptNo,
    record: 'attempt',
    field: 'center_response',
  }, rawSignedResponse)
  await db.transaction().execute(async (trx) => {
    await lockOperation(trx, operationId)
    const operation = await trx.selectFrom('local_license_operations').selectAll()
      .where('operation_id', '=', operationId).forUpdate().executeTakeFirst()
    if (!operation) invalid('operation_not_pending')
    const attempt = await trx.selectFrom('local_license_operation_attempts').selectAll()
      .where('operation_id', '=', operationId).where('attempt_no', '=', attemptNo).forUpdate().executeTakeFirst()
    if (!attempt || attempt.intent_digest !== operation.intent_digest || attempt.identity_jkt !== operation.identity_jkt) {
      invalid('attempt_response_binding_conflict')
    }
    if (attempt.send_state === 'response_saved') {
      if (attempt.response_digest !== responseDigest) invalid('attempt_response_conflict')
      const existing = await decryptLicensePendingBytes(pendingKeyRoot, {
        operationId, attemptNo, record: 'attempt', field: 'center_response',
      }, { keyId: attempt.response_key_id!, ciphertext: attempt.encrypted_response! })
      if (!existing.equals(Buffer.from(rawSignedResponse))) invalid('attempt_response_conflict')
      return
    }
    if (!['pending', 'response_saved'].includes(operation.state) ||
      !['prepared', 'sent', 'transport_unknown'].includes(attempt.send_state) ||
      (operation.state === 'response_saved' && attempt.purpose === 'activation' && attempt.send_state === 'prepared')) {
      invalid('attempt_response_binding_conflict')
    }
    const savedAt = await databaseNow(trx)
    const updated = await trx.updateTable('local_license_operation_attempts').set({
      send_state: 'response_saved',
      sent_at: attempt.sent_at ?? savedAt,
      response_key_id: encrypted.keyId,
      encrypted_response: encrypted.ciphertext,
      response_digest: responseDigest,
      response_saved_at: savedAt,
    }).where('operation_id', '=', operationId).where('attempt_no', '=', attemptNo)
      .where('send_state', 'in', ['prepared', 'sent', 'transport_unknown']).returning('attempt_no').executeTakeFirst()
    if (!updated) invalid('attempt_response_binding_conflict')
    if (operation.state === 'pending' || operation.response_attempt_no === null || attemptNo > operation.response_attempt_no) {
      const parentUpdate = trx.updateTable('local_license_operations').set({
        state: 'response_saved', response_attempt_no: attemptNo, response_digest: responseDigest, response_saved_at: savedAt,
      }).where('operation_id', '=', operationId).where('state', '=', operation.state)
      const updatedParent = operation.state === 'pending'
        ? await parentUpdate.returning('operation_id').executeTakeFirst()
        : await parentUpdate.where('response_attempt_no', '<', attemptNo).returning('operation_id').executeTakeFirst()
      if (!updatedParent) invalid('operation_response_pointer_conflict')
    }
  })
  return { responseDigest }
}

export async function readSavedLicenseOperationResponse(
  db: Kysely<Database>,
  pendingKeyRoot: string,
  operationId: string,
): Promise<Buffer> {
  const operation = await db.selectFrom('local_license_operations').selectAll()
    .where('operation_id', '=', operationId).executeTakeFirst()
  if (!operation || operation.state !== 'response_saved' || operation.response_attempt_no === null || !operation.response_digest) {
    invalid('operation_response_unavailable')
  }
  const attempt = await db.selectFrom('local_license_operation_attempts').selectAll()
    .where('operation_id', '=', operationId).where('attempt_no', '=', operation.response_attempt_no).executeTakeFirst()
  if (!attempt || attempt.response_digest !== operation.response_digest) invalid('operation_response_binding_mismatch')
  return readLicenseOperationAttemptResponse(db, pendingKeyRoot, operationId, attempt.attempt_no)
}

export async function readLicenseOperationAttemptResponse(
  db: Kysely<Database>,
  pendingKeyRoot: string,
  operationId: string,
  attemptNo: number,
): Promise<Buffer> {
  const attempt = await db.selectFrom('local_license_operation_attempts').selectAll()
    .where('operation_id', '=', operationId).where('attempt_no', '=', attemptNo).executeTakeFirst()
  if (!attempt || attempt.send_state !== 'response_saved' || attempt.response_key_id === null ||
    attempt.encrypted_response === null || attempt.response_digest === null) invalid('operation_response_binding_mismatch')
  const raw = await decryptLicensePendingBytes(pendingKeyRoot, {
    operationId,
    attemptNo,
    record: 'attempt',
    field: 'center_response',
  }, { keyId: attempt.response_key_id, ciphertext: attempt.encrypted_response })
  if (sha256Base64url(raw) !== attempt.response_digest) invalid('operation_response_digest_mismatch')
  return raw
}

export async function readLicenseOperationAttemptEnvelope(
  db: Kysely<Database>,
  pendingKeyRoot: string,
  operationId: string,
  attemptNo: number,
): Promise<{ attemptNo: number; purpose: LocalLicenseAttemptPurpose; sendState: string; requestBodyDigest: string; requestNonceHash: string; requestEnvelope: Buffer }> {
  const [operation, attempt] = await Promise.all([
    db.selectFrom('local_license_operations').selectAll().where('operation_id', '=', operationId).executeTakeFirst(),
    db.selectFrom('local_license_operation_attempts').selectAll()
      .where('operation_id', '=', operationId).where('attempt_no', '=', attemptNo).executeTakeFirst(),
  ])
  if (!operation || !attempt || operation.intent_digest !== attempt.intent_digest || operation.identity_jkt !== attempt.identity_jkt) {
    invalid('operation_attempt_unavailable')
  }
  const requestEnvelope = await decryptLicensePendingBytes(pendingKeyRoot, {
    operationId,
    attemptNo,
    record: 'attempt',
    field: 'request_envelope',
  }, { keyId: attempt.request_key_id, ciphertext: attempt.encrypted_request_envelope })
  await validateStoredOperationRequest(pendingKeyRoot, operation, attempt.purpose, attemptNo,
    attempt.request_body_digest, requestEnvelope)
  return {
    attemptNo,
    purpose: attempt.purpose,
    sendState: attempt.send_state,
    requestBodyDigest: attempt.request_body_digest,
    requestNonceHash: attempt.request_nonce_hash,
    requestEnvelope,
  }
}

export function newLicenseOperationId(): string {
  return randomUUID()
}
