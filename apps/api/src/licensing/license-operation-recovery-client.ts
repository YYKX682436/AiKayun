import { createHash, randomBytes } from 'node:crypto'
import { ByteSequence, parseDictionary } from 'structured-headers'
import { importJWK } from 'jose'
import type { JWK } from 'jose'
import {
  parseRFC9421RequestOrResponse,
  verifyRFC9421Signature,
  verifyRFC9530DigestHeader,
} from '@misskey-dev/node-http-message-signatures'
import { sql, type Kysely } from 'kysely'
import { Client } from 'pg'
import type { Pool } from 'pg'
import type { Database, LocalLicenseOperationAttemptsTable } from '../db/types.js'
import {
  LICENSE_CHALLENGE_PATH,
  LICENSE_OPERATION_CONTINUE_PATH,
  LICENSE_OPERATION_QUERY_PATH,
  createSignedLicenseRequest,
  postSignedLicenseRequest,
} from './license-request-http.js'
import type { TestLicenseTlsOptions } from './license-request-http.js'
import {
  readActivationOperationPayload,
  readLicenseOperationAttemptEnvelope,
  readLicenseOperationAttemptResponse,
  readLicenseOperationAttemptResultJws,
  saveLicenseOperationResponse,
  saveLicenseOperationResultJws,
  allocateLicenseOperationAttempt,
  markLicenseOperationAttemptSent,
  markLicenseOperationAttemptTransportResult,
} from './license-operation-store.js'
import { LocalLicenseOperationError } from './license-operation-store.js'
import type { PendingActivationOperation } from './license-challenge-client.js'
import { readPendingActivationOperation } from './license-challenge-client.js'
import { ed25519IdentityJkt, sha256Base64url } from './license-intent.js'
import { withVerifiedInstallationSigningContext } from './installation-identity.js'
import { fetchTrustedTimeAnchor } from './trust/time-anchor-client.js'
import type { TrustedTimeSample } from './trust/time-anchor-client.js'
import { TrustBundleStore } from './trust/trust-bundle-store.js'
import {
  verifyLicenseChallenge,
  verifyCurrentLicenseLease,
  verifyExpiredHistoricalLease,
  verifyExpiredHistoricalOperationReceipt,
  verifyLicenseOperationReceipt,
} from './trust/evidence.js'
import type { TrustedReleaseLicenseConfig } from './trusted-release-config.js'
import { parseStrictJson } from './strict-json.js'
import { decryptLicensePendingBytes, encryptLicensePendingBytes } from './pending-encryption-key.js'

const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u
const DIGEST = /^[A-Za-z0-9_-]{43}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const REQUEST_HEADER_NAMES = [
  'accept', 'connection', 'content-digest', 'content-length', 'content-type', 'host', 'signature', 'signature-input',
] as const
const MUTATION_FIELDS = [
  'attempt_no', 'challenge', 'database_id', 'identity_jkt', 'instance_id', 'intent_digest', 'license_id',
  'operation_id', 'public_jwk',
]
const CHALLENGE_CLAIMS = [
  'v', 'iss', 'aud', 'sub', 'jti', 'iat', 'nbf', 'exp', 'operation', 'operation_id', 'intent_digest',
  'instance_id', 'identity_jkt', 'client_nonce', 'server_nonce',
]

export type LicenseRecoveryCheckpoint =
  | 'before_attempt_commit'
  | 'after_attempt_commit'
  | 'after_sent_commit'
  | 'before_http_send'
  | 'after_http_response'
  | 'before_response_save'
  | 'after_response_saved'
  | 'before_terminal_evidence_commit'
  | 'after_terminal_row_update'
  | 'after_terminal_evidence_commit'

export class LicenseOperationRecoveryError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'LicenseOperationRecoveryError'
  }
}

export interface LicenseOperationRecoveryClientOptions {
  readonly db: Kysely<Database>
  readonly pool: Pool
  readonly identityRoot: string
  readonly pendingKeyRoot: string
  readonly releaseConfig: TrustedReleaseLicenseConfig
  readonly trustStore: TrustBundleStore
  readonly testTls?: TestLicenseTlsOptions
  /** Isolated process-crash coverage only. Rejected outside NODE_ENV=test. */
  readonly onTestCheckpoint?: (stage: LicenseRecoveryCheckpoint) => void | Promise<void>
}

export interface VerifiedOperationRecoveryEvidence {
  readonly purpose: 'verified_activation_operation_recovery'
  readonly operationId: string
  readonly licenseId: string
  readonly identityJkt: string
  readonly requestAttemptNo: number
  readonly state: 'not_found' | 'committed' | 'rejected' | 'cancelled'
  readonly outcomeCode: string | null
  readonly committedAttemptNo: number | null
  readonly resultJwsDigest: string | null
  readonly resultDisposition: 'none' | 'current_lease' | 'historical_only'
  readonly signatureVerified: true
  readonly projected: false
}

export interface RecoveredActivationOperation {
  readonly query: VerifiedOperationRecoveryEvidence
  readonly continuation: VerifiedOperationRecoveryEvidence | null
}

interface BoundRecoveryChallenge {
  readonly purpose: 'verified_bound_operation_recovery_challenge'
  readonly operation: 'query' | 'continue'
  readonly token: string
  readonly signingKeyId: string
  readonly clientNonce: string
  readonly serverNonce: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly timeSample: TrustedTimeSample
  readonly trustBundleDigest: string
}

interface ValidatedHistoricalAttempt {
  readonly row: LocalLicenseOperationAttemptsTable
  readonly requestBody: Buffer
  readonly requestBodyClaims: Record<string, unknown>
  readonly challengeClaims: Record<string, unknown>
  readonly requestEnvelope: Buffer
  readonly response: Buffer | null
  readonly archivedResult: Buffer | null
}

interface ValidatedOperationHistory {
  readonly operation: PendingActivationOperation
  readonly activationCode: string
  readonly origin: string | null
  readonly attempts: readonly ValidatedHistoricalAttempt[]
}

function fail(code: string): never {
  throw new LicenseOperationRecoveryError(code)
}

function canonicalNonce(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return false
  const bytes = Buffer.from(value, 'base64url')
  return bytes.byteLength === 32 && bytes.toString('base64url') === value
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function decodeCompactPart(part: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/u.test(part)) fail('operation_history_jws_invalid')
  const bytes = Buffer.from(part, 'base64url')
  if (bytes.toString('base64url') !== part) fail('operation_history_jws_invalid')
  let value: unknown
  try { value = parseStrictJson(bytes) } catch { return fail('operation_history_jws_invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('operation_history_jws_invalid')
  return value as Record<string, unknown>
}

function decodeCompactJws(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  if (!COMPACT_JWS.test(token)) fail('operation_history_jws_invalid')
  const [protectedPart, payloadPart] = token.split('.') as [string, string, string]
  return { header: decodeCompactPart(protectedPart), claims: decodeCompactPart(payloadPart) }
}

function digestHeader(raw: string): string {
  let dictionary: ReturnType<typeof parseDictionary>
  try { dictionary = parseDictionary(raw) } catch { return fail('operation_history_signature_invalid') }
  const entry = dictionary.get('sha-256')
  if (dictionary.size !== 1 || !entry || !Array.isArray(entry)) {
    return fail('operation_history_signature_invalid')
  }
  const [item, parameters] = entry
  if (Array.isArray(item) || !(item instanceof ByteSequence) || parameters.size !== 0) return fail('operation_history_signature_invalid')
  return item.toBase64()
}

async function verifyPersistedRequestSignature(input: {
  origin: URL
  target: string
  body: Buffer
  headers: Record<string, string>
  identityJkt: string
  publicJwk: Record<string, unknown>
  requestNonce: string
  signatureCreatedAt: Date
}): Promise<void> {
  const { headers, body } = input
  if (!exactKeys(headers, REQUEST_HEADER_NAMES) || headers.host !== input.origin.host ||
    headers.accept !== 'application/json' || headers['content-type'] !== 'application/json' || headers.connection !== 'close' ||
    headers['content-length'] !== String(body.byteLength) || !canonicalNonce(input.requestNonce)) {
    fail('operation_history_request_envelope_invalid')
  }
  const created = input.signatureCreatedAt.getTime() / 1000
  if (!Number.isSafeInteger(created) || input.signatureCreatedAt.getMilliseconds() !== 0) fail('operation_history_signature_invalid')
  const signatureInput = headers['signature-input']!
  const signature = headers.signature!
  let inputDictionary: ReturnType<typeof parseDictionary>
  let signatureDictionary: ReturnType<typeof parseDictionary>
  try {
    inputDictionary = parseDictionary(signatureInput)
    signatureDictionary = parseDictionary(signature)
  } catch { return fail('operation_history_signature_invalid') }
  const entry = inputDictionary.get('sig1')
  const signatureEntry = signatureDictionary.get('sig1')
  if (inputDictionary.size !== 1 || !entry || !Array.isArray(entry) || signatureDictionary.size !== 1 ||
    !signatureEntry || !Array.isArray(signatureEntry) || !(signatureEntry[0] instanceof ByteSequence) ||
    signatureEntry[1].size !== 0 || digestHeader(headers['content-digest']!) !== createHash('sha256').update(body).digest('base64')) {
    fail('operation_history_signature_invalid')
  }
  const [components, parameters] = entry
  const names = Array.isArray(components) ? components.map(item => Array.isArray(item) ? item[0] : item) : []
  const expectedParameters = ['alg', 'created', 'expires', 'keyid', 'nonce', 'tag']
  if (names.join(',') !== '@method,@target-uri,content-type,content-digest' ||
    [...parameters.keys()].sort().join(',') !== expectedParameters.join(',') || parameters.get('created') !== created ||
    parameters.get('expires') !== created + 60 || parameters.get('keyid') !== input.identityJkt ||
    parameters.get('nonce') !== input.requestNonce || parameters.get('alg') !== 'ed25519' ||
    parameters.get('tag') !== 'aikayun-license-v1') fail('operation_history_signature_invalid')

  const rawHeaders = Object.entries(headers).flatMap(([name, value]) => [name, value])
  const request = {
    method: 'POST',
    url: input.target,
    headers: { ...headers },
    rawHeaders,
  }
  let parsed: ReturnType<typeof parseRFC9421RequestOrResponse>
  try {
    parsed = parseRFC9421RequestOrResponse(request, {
      clockSkew: { now: input.signatureCreatedAt, delay: 0, forward: 0 },
      requiredComponents: { rfc9421: ['@method', '@target-uri', 'content-type', 'content-digest'] },
    })
  } catch { return fail('operation_history_signature_invalid') }
  let publicKey: CryptoKey
  try { publicKey = await importJWK(input.publicJwk as JWK, 'Ed25519') as CryptoKey } catch { return fail('operation_history_signature_invalid') }
  try {
    const [digestValid, signatureValid] = await Promise.all([
      verifyRFC9530DigestHeader(request, Uint8Array.from(body), { algorithms: ['sha-256'], verifyAll: true }),
      verifyRFC9421Signature(parsed.value, publicKey, { algorithms: ['ed25519'], verifyAll: true }),
    ])
    if (!digestValid || !signatureValid) fail('operation_history_signature_invalid')
  } catch (error) {
    if (error instanceof LicenseOperationRecoveryError) throw error
    fail('operation_history_signature_invalid')
  }
}

function parseStoredRequest(input: {
  operation: PendingActivationOperation
  issuer: string
  activationCode: string
  origin: string | null
  attempt: LocalLicenseOperationAttemptsTable
  requestEnvelope: Buffer
}): { body: Buffer; bodyClaims: Record<string, unknown>; challengeClaims: Record<string, unknown>; target: string; headers: Record<string, string> } {
  let value: unknown
  try { value = parseStrictJson(input.requestEnvelope) } catch { return fail('operation_history_request_envelope_invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('operation_history_request_envelope_invalid')
  const envelope = value as Record<string, unknown>
  const target = input.attempt.purpose === 'activation' ? '/v1/activations'
    : input.attempt.purpose === 'query' ? LICENSE_OPERATION_QUERY_PATH : LICENSE_OPERATION_CONTINUE_PATH
  if (!exactKeys(envelope, ['schema', 'method', 'target', 'headers', 'body_base64url']) || envelope.schema !== 1 ||
    envelope.method !== 'POST' || envelope.target !== target || typeof envelope.body_base64url !== 'string' ||
    !/^(?:[A-Za-z0-9_-]{2,})$/u.test(envelope.body_base64url) || !envelope.headers || typeof envelope.headers !== 'object' ||
    Array.isArray(envelope.headers)) fail('operation_history_request_envelope_invalid')
  const body = Buffer.from(envelope.body_base64url, 'base64url')
  if (body.toString('base64url') !== envelope.body_base64url || sha256Base64url(body) !== input.attempt.request_body_digest) {
    fail('operation_history_request_digest_mismatch')
  }
  const headers = envelope.headers as Record<string, string>
  let parsedBody: unknown
  try { parsedBody = parseStrictJson(body) } catch { return fail('operation_history_request_body_invalid') }
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) fail('operation_history_request_body_invalid')
  const bodyClaims = parsedBody as Record<string, unknown>
  const fields = input.attempt.purpose === 'query' ? MUTATION_FIELDS
    : [...MUTATION_FIELDS, 'activation_code', 'origin', ...(input.attempt.purpose === 'continue' ? ['kind'] : [])]
  if (!exactKeys(bodyClaims, fields) || bodyClaims.operation_id !== input.operation.operationId ||
    bodyClaims.intent_digest !== input.operation.intentDigest || bodyClaims.attempt_no !== input.attempt.attempt_no ||
    bodyClaims.license_id !== input.operation.licenseId || bodyClaims.database_id !== input.operation.databaseId ||
    bodyClaims.instance_id !== input.operation.instanceId || bodyClaims.identity_jkt !== input.operation.identityJkt ||
    typeof bodyClaims.challenge !== 'string' || bodyClaims.public_jwk === null || typeof bodyClaims.public_jwk !== 'object' ||
    Array.isArray(bodyClaims.public_jwk)) fail('operation_history_request_binding_invalid')
  const publicJwk = bodyClaims.public_jwk as Record<string, unknown>
  if (!exactKeys(publicJwk, ['kty', 'crv', 'x']) || publicJwk.kty !== 'OKP' || publicJwk.crv !== 'Ed25519' ||
    typeof publicJwk.x !== 'string' || ed25519IdentityJkt(publicJwk as { kty: 'OKP'; crv: 'Ed25519'; x: string }) !== input.operation.identityJkt) {
    fail('operation_history_request_binding_invalid')
  }
  if (input.attempt.purpose === 'activation' || input.attempt.purpose === 'continue') {
    if (bodyClaims.activation_code !== input.activationCode || bodyClaims.origin !== input.origin ||
      (input.attempt.purpose === 'continue' && bodyClaims.kind !== 'activation')) {
      fail('operation_history_request_binding_invalid')
    }
  }
  const challenge = decodeCompactJws(bodyClaims.challenge)
  if (!exactKeys(challenge.claims, CHALLENGE_CLAIMS) || challenge.header.typ !== 'aikayun-license-challenge+jwt' ||
    challenge.header.alg !== 'Ed25519' || typeof challenge.header.kid !== 'string' ||
    !DIGEST.test(challenge.header.kid) || challenge.claims.v !== 1 || challenge.claims.aud !== 'aikayun-commerce' ||
    challenge.claims.iss !== input.issuer || challenge.claims.sub !== input.operation.instanceId ||
    challenge.claims.operation_id !== input.operation.operationId || challenge.claims.intent_digest !== input.operation.intentDigest ||
    challenge.claims.instance_id !== input.operation.instanceId || challenge.claims.identity_jkt !== input.operation.identityJkt ||
    challenge.claims.operation !== (input.attempt.purpose === 'activation' ? 'activation' : input.attempt.purpose) ||
    !UUID.test(String(challenge.claims.jti)) || !Number.isSafeInteger(challenge.claims.iat) ||
    challenge.claims.nbf !== challenge.claims.iat || !Number.isSafeInteger(challenge.claims.exp) ||
    challenge.claims.exp !== Number(challenge.claims.iat) + 300 || !canonicalNonce(challenge.claims.client_nonce) ||
    !canonicalNonce(challenge.claims.server_nonce) ||
    sha256Base64url(String(challenge.claims.client_nonce)) !== input.attempt.client_nonce_hash ||
    sha256Base64url(String(challenge.claims.server_nonce)) !== input.attempt.request_nonce_hash ||
    input.attempt.identity_jkt !== input.operation.identityJkt || input.attempt.intent_digest !== input.operation.intentDigest) {
    fail('operation_history_challenge_invalid')
  }
  return { body, bodyClaims, challengeClaims: challenge.claims, target, headers }
}

function assertBoundChallenge(challenge: BoundRecoveryChallenge, operation: PendingActivationOperation, expected: 'query' | 'continue', trustedTime: number): void {
  if (challenge.purpose !== 'verified_bound_operation_recovery_challenge' || challenge.operation !== expected ||
    challenge.issuedAt > trustedTime || challenge.expiresAt <= trustedTime || challenge.expiresAt - challenge.issuedAt !== 300 ||
    !canonicalNonce(challenge.clientNonce) || !canonicalNonce(challenge.serverNonce) ||
    challenge.token.length < 100 || challenge.token.length > 16 * 1024) fail('operation_challenge_binding_invalid')
  const decoded = decodeCompactJws(challenge.token)
  const claims = decoded.claims
  if (claims.operation !== expected || claims.operation_id !== operation.operationId || claims.intent_digest !== operation.intentDigest ||
    claims.instance_id !== operation.instanceId || claims.sub !== operation.instanceId || claims.identity_jkt !== operation.identityJkt ||
    claims.client_nonce !== challenge.clientNonce || claims.server_nonce !== challenge.serverNonce ||
    claims.iat !== challenge.issuedAt || claims.exp !== challenge.expiresAt) fail('operation_challenge_binding_invalid')
}

async function requestEnvelopeParts(input: {
  operation: PendingActivationOperation
  activationCode: string
  origin: string | null
  issuer: string
  row: LocalLicenseOperationAttemptsTable
  envelope: Buffer
  centerOrigin: URL
}): Promise<{ body: Buffer; bodyClaims: Record<string, unknown>; challengeClaims: Record<string, unknown> }> {
  const parsed = parseStoredRequest({
    operation: input.operation,
    issuer: input.issuer,
    activationCode: input.activationCode,
    origin: input.origin,
    attempt: input.row,
    requestEnvelope: input.envelope,
  })
  await verifyPersistedRequestSignature({
    origin: input.centerOrigin,
    target: parsed.target,
    body: parsed.body,
    headers: parsed.headers,
    identityJkt: input.operation.identityJkt,
    publicJwk: parsed.bodyClaims.public_jwk as Record<string, unknown>,
    requestNonce: String(parsed.challengeClaims.server_nonce),
    signatureCreatedAt: input.row.signature_created_at,
  })
  return { body: parsed.body, bodyClaims: parsed.bodyClaims, challengeClaims: parsed.challengeClaims }
}

async function validateOperationHistory(input: {
  db: Kysely<Database>
  pool: Pool
  pendingKeyRoot: string
  operationId: string
  issuer: string
  centerOrigin: URL
  identity: { databaseId: string; instanceId: string; identityJkt: string }
}): Promise<ValidatedOperationHistory> {
  const operation = await readPendingActivationOperation(input.db, input.pendingKeyRoot, input.operationId, input.identity, {
    allowResponseSaved: true,
  })
  const payload = await readActivationOperationPayload(input.db, input.pendingKeyRoot, input.operationId)
  const rows = await input.db.selectFrom('local_license_operation_attempts').selectAll()
    .where('operation_id', '=', input.operationId).orderBy('attempt_no', 'asc').execute()
  if (rows.some((row, index) => row.attempt_no !== index + 1) || rows.filter(row => row.purpose === 'activation').length > 1) {
    fail('operation_history_sequence_invalid')
  }
  const attempts: ValidatedHistoricalAttempt[] = []
  for (const row of rows) {
    if (!['prepared', 'sent', 'transport_unknown', 'transport_error', 'response_saved'].includes(row.send_state)) {
      fail('operation_history_state_invalid')
    }
    const attemptRow = row as unknown as LocalLicenseOperationAttemptsTable
    const stored = await readLicenseOperationAttemptEnvelope(input.db, input.pendingKeyRoot, input.operationId, row.attempt_no)
    if (stored.purpose !== row.purpose || stored.sendState !== row.send_state ||
      stored.requestBodyDigest !== row.request_body_digest || stored.requestNonceHash !== row.request_nonce_hash ||
      stored.clientNonceHash !== row.client_nonce_hash || stored.identityJkt !== row.identity_jkt ||
      stored.intentDigest !== row.intent_digest || stored.signingKeyId !== row.signing_key_id ||
      stored.signatureCreatedAt.getTime() !== row.signature_created_at.getTime()) fail('operation_history_binding_invalid')
    const parsed = await requestEnvelopeParts({
      operation,
      activationCode: payload.activationCode,
      origin: payload.origin,
      issuer: input.issuer,
      row: attemptRow,
      envelope: stored.requestEnvelope,
      centerOrigin: input.centerOrigin,
    })
    const response = row.send_state === 'response_saved'
      ? await readLicenseOperationAttemptResponse(input.db, input.pendingKeyRoot, input.operationId, row.attempt_no)
      : null
    const archivedResult = await readLicenseOperationAttemptResultJws(input.db, input.pendingKeyRoot, input.operationId, row.attempt_no)
    attempts.push(Object.freeze({
      row: attemptRow,
      requestBody: parsed.body,
      requestBodyClaims: parsed.bodyClaims,
      challengeClaims: parsed.challengeClaims,
      requestEnvelope: stored.requestEnvelope,
      response,
      archivedResult,
    }))
  }
  return Object.freeze({ operation, activationCode: payload.activationCode, origin: payload.origin, attempts: Object.freeze(attempts) })
}

function createTestAnchorOptions(testTls: TestLicenseTlsOptions | undefined) {
  return testTls === undefined ? {} : {
    ...(testTls.ca === undefined ? {} : { testCa: testTls.ca }),
    ...(testTls.lookup === undefined ? {} : { testLookup: testTls.lookup }),
  }
}

async function requestBoundChallenge(options: LicenseOperationRecoveryClientOptions, operationId: string,
  operationType: 'query' | 'continue'): Promise<BoundRecoveryChallenge> {
  return withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async (identity) => {
    const operation = await readPendingActivationOperation(options.db, options.pendingKeyRoot, operationId, identity, {
      allowResponseSaved: true,
    })
    const candidate = await options.trustStore.getCandidateForTimeBootstrap()
    if (!candidate || candidate.claims.sub !== options.releaseConfig.expected_center_issuer) fail('operation_trust_bundle_unavailable')
    const anchorOptions = createTestAnchorOptions(options.testTls)
    const signingSample = await fetchTrustedTimeAnchor(options.releaseConfig, candidate, anchorOptions)
    const accepted = await options.trustStore.getAccepted(signingSample.assertFresh)
    const clientNonce = randomBytes(32).toString('base64url')
    if (!canonicalNonce(clientNonce)) fail('operation_challenge_nonce_invalid')
    const created = signingSample.assertFresh()
    const body = Buffer.from(JSON.stringify({
      operation: operationType,
      operation_id: operation.operationId,
      intent_digest: operation.intentDigest,
      instance_id: operation.instanceId,
      public_jwk: identity.publicJwk,
      client_nonce: clientNonce,
    }), 'utf8')
    const signed = await createSignedLicenseRequest({
      origin: new URL(options.releaseConfig.expected_center_origin),
      path: LICENSE_CHALLENGE_PATH,
      body,
      identity,
      nonce: clientNonce,
      created,
    })
    let response
    try {
      signingSample.assertFresh()
      response = await postSignedLicenseRequest({
        origin: new URL(options.releaseConfig.expected_center_origin),
        path: LICENSE_CHALLENGE_PATH,
        signed,
        ...(options.testTls === undefined ? {} : { testTls: options.testTls }),
      })
    } catch { fail('operation_challenge_request_failed') }
    const contentTypeHeader = response.headers['content-type']
    const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader
    if (response.statusCode !== 201 || typeof contentType !== 'string' ||
      contentType.split(';', 1)[0]!.trim().toLowerCase() !== 'application/json') fail('operation_challenge_response_invalid')
    let envelope: unknown
    try { envelope = parseStrictJson(response.body) } catch { return fail('operation_challenge_response_invalid') }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      !exactKeys(envelope as Record<string, unknown>, ['challenge']) || typeof (envelope as Record<string, unknown>).challenge !== 'string') {
      fail('operation_challenge_response_invalid')
    }
    const token = (envelope as { challenge: string }).challenge
    if (token.length < 100 || token.length > 16 * 1024) fail('operation_challenge_response_invalid')
    const verifySample = await fetchTrustedTimeAnchor(options.releaseConfig, candidate, anchorOptions)
    const acceptedAtResponse = await options.trustStore.getAccepted(verifySample.assertFresh)
    if (acceptedAtResponse.artifactSha256 !== accepted.artifactSha256) fail('operation_trust_bundle_changed')
    const verified = await verifyLicenseChallenge(token, {
      resolver: acceptedAtResponse.resolver,
      issuer: options.releaseConfig.expected_center_issuer,
      trustedTime: verifySample.assertFresh(),
    })
    const claims = verified.claims
    const trustedTime = verifySample.assertFresh()
    if (claims.operation !== operationType || claims.operation_id !== operation.operationId ||
      claims.intent_digest !== operation.intentDigest || claims.instance_id !== operation.instanceId ||
      claims.sub !== operation.instanceId || claims.identity_jkt !== operation.identityJkt ||
      claims.client_nonce !== clientNonce || typeof claims.server_nonce !== 'string' || !canonicalNonce(claims.server_nonce) ||
      typeof claims.iat !== 'number' || typeof claims.exp !== 'number' || claims.iat > trustedTime ||
      claims.exp <= trustedTime || claims.exp - claims.iat !== 300) fail('operation_challenge_binding_invalid')
    const finalBundle = await options.trustStore.getAccepted(verifySample.assertFresh)
    if (finalBundle.artifactSha256 !== acceptedAtResponse.artifactSha256) fail('operation_trust_bundle_changed')
    const current = await readPendingActivationOperation(options.db, options.pendingKeyRoot, operationId, identity, {
      allowResponseSaved: true,
    })
    if (current.operationId !== operation.operationId || current.intentDigest !== operation.intentDigest ||
      current.licenseId !== operation.licenseId || current.databaseId !== operation.databaseId ||
      current.instanceId !== operation.instanceId || current.identityJkt !== operation.identityJkt) fail('operation_challenge_binding_invalid')
    const latestIdentity = await withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async currentIdentity => ({
      databaseId: currentIdentity.databaseId,
      instanceId: currentIdentity.instanceId,
      identityJkt: currentIdentity.identityJkt,
    }))
    if (latestIdentity.databaseId !== operation.databaseId || latestIdentity.instanceId !== operation.instanceId ||
      latestIdentity.identityJkt !== operation.identityJkt) fail('operation_identity_changed')
    return Object.freeze({
      purpose: 'verified_bound_operation_recovery_challenge',
      operation: operationType,
      token,
      signingKeyId: verified.signingKeyId,
      clientNonce,
      serverNonce: claims.server_nonce,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      timeSample: verifySample,
      trustBundleDigest: finalBundle.artifactSha256,
    })
  })
}

let activeRecoveryLockConnections = 0
const MAX_RECOVERY_LOCK_CONNECTIONS = 4

async function withRecoveryOperationLock<T>(pool: Pool, operationId: string, action: (assertHeld: () => Promise<void>) => Promise<T>): Promise<T> {
  if (activeRecoveryLockConnections >= MAX_RECOVERY_LOCK_CONNECTIONS) fail('operation_recovery_lock_capacity_exceeded')
  // A fresh, non-pooled connection preserves the business pool's database, credentials,
  // TLS and startup options. It is always closed, never returned for reuse.
  const client = new Client({
    ...pool.options,
    password: pool.options.password,
    connectionTimeoutMillis: 5_000,
    lock_timeout: 15_000,
    statement_timeout: 20_000,
    query_timeout: 22_000,
    application_name: 'aikayun-license-recovery-lock',
  })
  activeRecoveryLockConnections += 1
  let locked = false
  let lost = false
  let backendPid = 0
  client.on('error', () => { lost = true })
  client.on('end', () => { lost = true })
  const assertHeld = async () => {
    if (lost || !locked) fail('operation_recovery_lock_lost')
    try {
      const status = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      if (status.rows[0]?.pid !== backendPid) { lost = true; fail('operation_recovery_lock_lost') }
    } catch { lost = true; fail('operation_recovery_lock_lost') }
    if (lost) fail('operation_recovery_lock_lost')
  }
  try {
    await client.connect()
    await client.query("SELECT set_config('lock_timeout', '15s', false), set_config('statement_timeout', '20s', false)")
    const acquired = await client.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid, pg_advisory_lock(hashtextextended($1, 0))', [`aikayun-license-recovery:${operationId}`],
    )
    backendPid = acquired.rows[0]?.pid ?? 0
    if (!backendPid || lost) fail('operation_recovery_lock_lost')
    locked = true
    await assertHeld()
    const result = await action(assertHeld)
    await assertHeld()
    const unlocked = await client.query<{ unlocked: boolean }>(
      'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [`aikayun-license-recovery:${operationId}`],
    )
    if (lost || unlocked.rows[0]?.unlocked !== true) fail('operation_recovery_lock_lost')
    locked = false
    return result
  } finally {
    // Closing the dedicated session releases any lock even after errors/timeouts.
    try { await client.end() } finally { activeRecoveryLockConnections -= 1 }
  }
}

function parseOperationReceiptResponse(response: {
  statusCode: number
  headers: { 'content-type'?: string | string[] | undefined }
  body: Buffer
}): Buffer {
  const contentTypeHeader = response.headers['content-type']
  const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader
  if (response.statusCode !== 200 || typeof contentType !== 'string' ||
    contentType.split(';', 1)[0]!.trim().toLowerCase() !== 'application/json') fail('operation_recovery_response_unknown')
  let parsed: unknown
  try { parsed = parseStrictJson(response.body) } catch { return fail('operation_recovery_response_unknown') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    !exactKeys(parsed as Record<string, unknown>, ['operation_receipt'])) fail('operation_recovery_response_unknown')
  const token = (parsed as Record<string, unknown>).operation_receipt
  if (typeof token !== 'string' || token.length < 100 || token.length > 16 * 1024 || !COMPACT_JWS.test(token)) {
    fail('operation_recovery_response_unknown')
  }
  return Buffer.from(token, 'ascii')
}

function boundOperationReceiptClaims(input: {
  history: ValidatedOperationHistory
  requestAttemptNo: number
  requestNonceHash: string
  requestDigest: string
  claims: Readonly<Record<string, unknown>>
}): { state: VerifiedOperationRecoveryEvidence['state']; outcomeCode: string | null; committedAttemptNo: number | null; resultJws: string | null; resultDigest: string | null } {
  const { claims, history } = input
  if (claims.sub !== history.operation.licenseId || claims.actor_jkt !== history.operation.identityJkt ||
    claims.operation_id !== history.operation.operationId || claims.intent_digest !== history.operation.intentDigest ||
    claims.attempt_no !== input.requestAttemptNo || claims.request_nonce_hash !== input.requestNonceHash ||
    claims.request_digest !== input.requestDigest) fail('operation_recovery_receipt_binding_invalid')
  const state = claims.state
  const outcome = claims.outcome_code
  const committedNo = claims.committed_attempt_no
  const committedNonceHash = claims.committed_request_nonce_hash
  const committedDigest = claims.committed_request_digest
  const result = claims.result_jws
  if (!['not_found', 'committed', 'rejected', 'cancelled'].includes(String(state)) ||
    (outcome !== null && (typeof outcome !== 'string' || outcome.length < 1 || outcome.length > 128)) ||
    (committedNo !== null && (!Number.isSafeInteger(committedNo) || Number(committedNo) < 1)) ||
    (committedNonceHash !== null && (typeof committedNonceHash !== 'string' || !DIGEST.test(committedNonceHash))) ||
    (committedDigest !== null && (typeof committedDigest !== 'string' || !DIGEST.test(committedDigest))) ||
    (result !== null && (typeof result !== 'string' || result.length > 16 * 1024 || !COMPACT_JWS.test(result)))) {
    fail('operation_recovery_receipt_invalid')
  }
  const typedState = state as VerifiedOperationRecoveryEvidence['state']
  const typedOutcome = outcome as string | null
  const resultJws = result as string | null
  const resultDigest = resultJws === null ? null : sha256Base64url(Buffer.from(resultJws, 'ascii'))
  if (typedState === 'not_found') {
    if (typedOutcome !== 'OPERATION_NOT_FOUND' || committedNo !== null || committedNonceHash !== null ||
      committedDigest !== null || resultJws !== null) fail('operation_recovery_not_found_invalid')
    return { state: typedState, outcomeCode: typedOutcome, committedAttemptNo: null, resultJws: null, resultDigest: null }
  }
  if (typedOutcome === null) fail('operation_recovery_terminal_invalid')
  if (committedNo === null) {
    if (typedState === 'rejected' && typedOutcome === 'ACTIVATION_AUTHORIZATION_INVALID' &&
      committedNonceHash === null && committedDigest === null && resultJws === null) {
      const original = history.attempts.find(item => item.row.attempt_no === input.requestAttemptNo)
      if (!original || !['activation', 'continue'].includes(original.row.purpose) ||
        String(original.row.send_state) !== 'response_saved' || original.row.request_nonce_hash !== input.requestNonceHash ||
        original.row.request_body_digest !== input.requestDigest) fail('operation_recovery_commit_binding_invalid')
      return { state: typedState, outcomeCode: typedOutcome, committedAttemptNo: null, resultJws: null, resultDigest: null }
    }
    if (typedState !== 'cancelled' || committedNonceHash !== null || committedDigest !== null || resultJws !== null) {
      fail('operation_recovery_commit_binding_invalid')
    }
    return { state: typedState, outcomeCode: typedOutcome, committedAttemptNo: null, resultJws: null, resultDigest: null }
  }
  if (committedNonceHash === null || committedDigest === null || resultJws === null) fail('operation_recovery_commit_binding_invalid')
  const committed = history.attempts.find(item => item.row.attempt_no === committedNo)
  if (!committed || !['activation', 'continue'].includes(committed.row.purpose) ||
    ['prepared', 'transport_error'].includes(String(committed.row.send_state)) ||
    committed.row.request_nonce_hash !== committedNonceHash || committed.row.request_body_digest !== committedDigest) {
    fail('operation_recovery_commit_binding_invalid')
  }
  const originalResult = decodeCompactJws(resultJws)
  if (typedState === 'committed') {
    const resultClaims = originalResult.claims
    if (originalResult.header.typ !== 'aikayun-license+jwt' || resultClaims.sub !== history.operation.licenseId ||
      resultClaims.database_id !== history.operation.databaseId || resultClaims.instance_id !== history.operation.instanceId ||
      resultClaims.identity_jkt !== history.operation.identityJkt ||
      resultClaims.request_nonce !== committed.challengeClaims.server_nonce ||
      resultClaims.request_digest !== committed.row.request_body_digest) fail('operation_recovery_result_binding_invalid')
  } else if (typedState === 'rejected') {
    const resultClaims = originalResult.claims
    if (originalResult.header.typ !== 'aikayun-license-operation+jwt' || resultClaims.sub !== history.operation.licenseId ||
      resultClaims.actor_jkt !== history.operation.identityJkt || resultClaims.operation_id !== history.operation.operationId ||
      resultClaims.intent_digest !== history.operation.intentDigest || resultClaims.state !== 'rejected' ||
      resultClaims.attempt_no !== committed.row.attempt_no || resultClaims.request_nonce_hash !== committed.row.request_nonce_hash ||
      resultClaims.request_digest !== committed.row.request_body_digest) fail('operation_recovery_result_binding_invalid')
  } else if (originalResult.header.typ !== 'aikayun-license-operation+jwt' ||
    originalResult.claims.sub !== history.operation.licenseId || originalResult.claims.actor_jkt !== history.operation.identityJkt ||
    originalResult.claims.operation_id !== history.operation.operationId || originalResult.claims.intent_digest !== history.operation.intentDigest ||
    originalResult.claims.state !== 'cancelled' || originalResult.claims.attempt_no !== committed.row.attempt_no ||
    originalResult.claims.request_nonce_hash !== committed.row.request_nonce_hash ||
    originalResult.claims.request_digest !== committed.row.request_body_digest) {
    fail('operation_recovery_result_binding_invalid')
  }
  const savedResponse = committed.response
  if (savedResponse !== null) {
    if (committed.row.purpose === 'activation') {
      if (!savedResponse.equals(Buffer.from(resultJws, 'ascii'))) fail('operation_recovery_history_result_conflict')
    } else {
      let previous: { claims: Record<string, unknown> }
      try { previous = decodeCompactJws(savedResponse.toString('ascii')) } catch { return fail('operation_recovery_history_result_conflict') }
      if (previous.claims.result_jws !== resultJws) fail('operation_recovery_history_result_conflict')
    }
  }
  if (committed.archivedResult !== null && !committed.archivedResult.equals(Buffer.from(resultJws, 'ascii'))) {
    fail('operation_recovery_history_result_conflict')
  }
  return { state: typedState, outcomeCode: typedOutcome, committedAttemptNo: Number(committedNo), resultJws, resultDigest }
}

async function verifiedHistoricalTerminal(input: {
  history: ValidatedOperationHistory
  resolver: Awaited<ReturnType<TrustBundleStore['getAccepted']>>['resolver']
  issuer: string
  trustedTime: number
}): Promise<{ attemptNo: number; bound: ReturnType<typeof boundOperationReceiptClaims> } | null> {
  const terminal: Array<{ attemptNo: number; bound: ReturnType<typeof boundOperationReceiptClaims> }> = []
  for (const attempt of input.history.attempts) {
    if (!attempt.response || String(attempt.row.send_state) !== 'response_saved') continue
    try {
      const verified = await verifyLicenseOperationReceipt(attempt.response.toString('ascii'), {
        resolver: input.resolver, issuer: input.issuer, trustedTime: input.trustedTime,
      })
      if (verified.claims.state !== 'rejected' && verified.claims.state !== 'cancelled') continue
      const bound = boundOperationReceiptClaims({
        history: input.history,
        requestAttemptNo: attempt.row.attempt_no,
        requestNonceHash: attempt.row.request_nonce_hash,
        requestDigest: attempt.row.request_body_digest,
        claims: verified.claims,
      })
      terminal.push({ attemptNo: attempt.row.attempt_no, bound })
    } catch {
      // An expired or no-longer-retained historical key cannot establish terminal state.
      // The raw history is still checked below and will stop a contradictory not_found.
    }
  }
  if (terminal.length === 0) return null
  const first = terminal[0]!
  if (terminal.some(item => item.bound.state !== first.bound.state || item.bound.outcomeCode !== first.bound.outcomeCode ||
    item.bound.committedAttemptNo !== first.bound.committedAttemptNo || item.bound.resultDigest !== first.bound.resultDigest)) {
    fail('operation_recovery_history_terminal_conflict')
  }
  return first
}

async function ensureNotFoundDoesNotContradictHistory(input: {
  history: ValidatedOperationHistory
  resolver: Awaited<ReturnType<TrustBundleStore['getAccepted']>>['resolver']
  issuer: string
  trustedTime: number
}): Promise<void> {
  const { history } = input
  for (const attempt of history.attempts) {
    if (attempt.archivedResult !== null) fail('operation_recovery_history_conflicts_with_not_found')
    if (attempt.response === null) continue
    try {
      const decoded = decodeCompactJws(attempt.response.toString('ascii'))
      if (decoded.header.typ === 'aikayun-license+jwt') fail('operation_recovery_history_conflicts_with_not_found')
      if (decoded.header.typ === 'aikayun-license-operation+jwt' && decoded.claims.operation_id === history.operation.operationId &&
        ['committed', 'rejected', 'cancelled'].includes(String(decoded.claims.state))) {
        if (decoded.claims.state === 'rejected' && decoded.claims.outcome_code === 'ACTIVATION_AUTHORIZATION_INVALID') {
          try {
            const verified = await verifyExpiredHistoricalOperationReceipt(attempt.response.toString('ascii'), {
              resolver: input.resolver, issuer: input.issuer, trustedTime: input.trustedTime,
            })
            const bound = boundOperationReceiptClaims({
              history, requestAttemptNo: attempt.row.attempt_no, requestNonceHash: attempt.row.request_nonce_hash,
              requestDigest: attempt.row.request_body_digest, claims: verified.claims,
            })
            if (bound.committedAttemptNo === null) continue
          } catch { /* Unverifiable history cannot be treated as the R3 exception. */ }
        }
        fail('operation_recovery_history_conflicts_with_not_found')
      }
    } catch (error) {
      if (error instanceof LicenseOperationRecoveryError && error.code === 'operation_recovery_history_conflicts_with_not_found') throw error
      // A saved but malformed response remains inert evidence; a fresh center query resolves the operation.
    }
  }
}

async function assertRecoveryChallengeCurrent(input: {
  options: LicenseOperationRecoveryClientOptions
  operation: PendingActivationOperation
  challenge: BoundRecoveryChallenge
  expectedOperation: 'query' | 'continue'
}): Promise<void> {
  const trustedTime = input.challenge.timeSample.assertFresh()
  assertBoundChallenge(input.challenge, input.operation, input.expectedOperation, trustedTime)
  const accepted = await input.options.trustStore.getAccepted(input.challenge.timeSample.assertFresh)
  if (accepted.artifactSha256 !== input.challenge.trustBundleDigest) fail('operation_trust_bundle_changed')
  const verified = await verifyLicenseChallenge(input.challenge.token, {
    resolver: accepted.resolver,
    issuer: input.options.releaseConfig.expected_center_issuer,
    trustedTime,
  })
  if (verified.signingKeyId !== input.challenge.signingKeyId ||
    verified.claims.operation !== input.expectedOperation || verified.claims.operation_id !== input.operation.operationId ||
    verified.claims.intent_digest !== input.operation.intentDigest || verified.claims.identity_jkt !== input.operation.identityJkt ||
    verified.claims.client_nonce !== input.challenge.clientNonce || verified.claims.server_nonce !== input.challenge.serverNonce) {
    fail('operation_challenge_binding_invalid')
  }
}

function signedRequestFromStoredEnvelope(envelopeBytes: Buffer): { body: Buffer; headers: Record<string, string> } {
  let value: unknown
  try { value = parseStrictJson(envelopeBytes) } catch { return fail('operation_request_envelope_invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('operation_request_envelope_invalid')
  const envelope = value as Record<string, unknown>
  if (typeof envelope.body_base64url !== 'string' || !envelope.headers || typeof envelope.headers !== 'object' ||
    Array.isArray(envelope.headers)) fail('operation_request_envelope_invalid')
  const body = Buffer.from(envelope.body_base64url, 'base64url')
  const headers = envelope.headers as Record<string, unknown>
  const normalized: Record<string, string> = {}
  for (const [name, header] of Object.entries(headers)) {
    if (typeof header !== 'string' || /[\r\n]/u.test(header)) fail('operation_request_envelope_invalid')
    normalized[name] = header
  }
  return { body, headers: normalized }
}

async function archiveAndClassifyResult(input: {
  options: LicenseOperationRecoveryClientOptions
  operationId: string
  accepted: Awaited<ReturnType<TrustBundleStore['getAccepted']>>
  trustedTime: number
  history: ValidatedOperationHistory
  bound: ReturnType<typeof boundOperationReceiptClaims>
}): Promise<VerifiedOperationRecoveryEvidence['resultDisposition']> {
  const { bound, history } = input
  if (bound.resultJws === null || bound.committedAttemptNo === null) return 'none'
  const resultBytes = Buffer.from(bound.resultJws, 'ascii')
  await saveLicenseOperationResultJws(input.options.db, input.options.pendingKeyRoot, input.operationId,
    bound.committedAttemptNo, resultBytes)
  const archived = await readLicenseOperationAttemptResultJws(input.options.db, input.options.pendingKeyRoot,
    input.operationId, bound.committedAttemptNo)
  if (!archived || !archived.equals(resultBytes)) fail('operation_result_archive_unknown')

  const committed = history.attempts.find(item => item.row.attempt_no === bound.committedAttemptNo)
  if (!committed) fail('operation_recovery_commit_binding_invalid')
  if (bound.state !== 'committed') return 'none'
  const claims = decodeCompactJws(bound.resultJws).claims
  const exp = claims.exp
  const identity = {
    status: 'ready' as const,
    code: 'ready',
    databaseId: history.operation.databaseId,
    instanceId: history.operation.instanceId,
    identityJkt: history.operation.identityJkt,
    bindingState: 'ready' as const,
  }
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) fail('operation_recovery_result_invalid')
  if (exp > input.trustedTime) {
    try {
      const current = await verifyCurrentLicenseLease(bound.resultJws, {
        resolver: input.accepted.resolver,
        issuer: input.options.releaseConfig.expected_center_issuer,
        trustedTime: input.trustedTime,
        identity,
      })
      if (current.requestNonce !== committed.challengeClaims.server_nonce ||
        current.requestDigest !== committed.row.request_body_digest) fail('operation_recovery_result_binding_invalid')
      return 'current_lease'
    } catch (error) {
      if (error instanceof LicenseOperationRecoveryError) throw error
      // The current signed operation receipt still proves the center's historical commit;
      // an unavailable, revoked, retired, expired, or invalid old lease never grants use.
      return 'historical_only'
    }
  }
  try {
    const historical = await verifyExpiredHistoricalLease(bound.resultJws, {
      resolver: input.accepted.resolver,
      issuer: input.options.releaseConfig.expected_center_issuer,
      trustedTime: input.trustedTime,
      identity,
    })
    if (historical.databaseId !== history.operation.databaseId || historical.instanceId !== history.operation.instanceId ||
      historical.identityJkt !== history.operation.identityJkt ||
      historical.activationGeneration !== String(claims.activation_generation) ||
      historical.entitlementRevision !== String(claims.entitlement_revision)) fail('operation_recovery_result_binding_invalid')
  } catch (error) {
    if (error instanceof LicenseOperationRecoveryError) throw error
    // Normal key verification retention can expire before audit retention. The fresh
    // operation receipt remains the authority for this historical commit fact.
  }
  return 'historical_only'
}

export type LicenseOperationFinalizationCheckpoint =
  | 'before_terminal_evidence_commit'
  | 'after_terminal_row_update'
  | 'after_terminal_evidence_commit'

/** Re-read, re-verify, and atomically settle a persisted center-signed activation rejection. */
export async function finalizeTrustedActivationRejection(input: {
  options: LicenseOperationRecoveryClientOptions
  operationId: string
  evidenceAttemptNo: number
  readTrustedTime: () => number
  checkpoint?: (stage: LicenseOperationFinalizationCheckpoint) => void | Promise<void>
}): Promise<void> {
  const { options, operationId, evidenceAttemptNo } = input
  if (!Number.isSafeInteger(evidenceAttemptNo) || evidenceAttemptNo < 1) fail('operation_terminal_evidence_invalid')
  const issuer = options.releaseConfig.expected_center_issuer
  const origin = new URL(options.releaseConfig.expected_center_origin)
  const identity = await withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async current => ({
    databaseId: current.databaseId, instanceId: current.instanceId, identityJkt: current.identityJkt,
  }))
  const rawEvidence = await readLicenseOperationAttemptResponse(
    options.db, options.pendingKeyRoot, operationId, evidenceAttemptNo,
  )
  const token = rawEvidence.toString('ascii')
  if (!COMPACT_JWS.test(token) || !Buffer.from(token, 'ascii').equals(rawEvidence)) fail('operation_terminal_evidence_invalid')
  const evidenceDigest = sha256Base64url(rawEvidence)
  // Finish encryption before taking the PostgreSQL transaction. The ciphertext is committed
  // atomically with the terminal state below, so no partially finalized evidence is exposed.
  const encryptedEvidence = await encryptLicensePendingBytes(options.pendingKeyRoot, {
    operationId, record: 'operation', field: 'center_evidence',
  }, rawEvidence)

  async function assertSameFinalizedEvidence(db: Kysely<Database>): Promise<void> {
    const operation = await db.selectFrom('local_license_operations').selectAll()
      .where('operation_id', '=', operationId).executeTakeFirst()
    if (!operation || operation.state !== 'terminal' || operation.kind !== 'activation' || operation.expected_generation !== null ||
      operation.database_id !== identity.databaseId || operation.instance_id !== identity.instanceId ||
      operation.identity_jkt !== identity.identityJkt ||
      operation.center_evidence_key_id === null || operation.encrypted_center_evidence === null ||
      operation.center_evidence_digest !== evidenceDigest) fail('operation_terminal_evidence_conflict')
    const archived = await decryptLicensePendingBytes(options.pendingKeyRoot, {
      operationId, record: 'operation', field: 'center_evidence',
    }, { keyId: operation.center_evidence_key_id, ciphertext: operation.encrypted_center_evidence })
    if (!archived.equals(rawEvidence) || sha256Base64url(archived) !== operation.center_evidence_digest) {
      fail('operation_terminal_evidence_conflict')
    }
    const attempt = await readLicenseOperationAttemptResponse(db, options.pendingKeyRoot, operationId, evidenceAttemptNo)
    if (!attempt.equals(archived)) fail('operation_terminal_evidence_conflict')
  }

  const current = await options.db.selectFrom('local_license_operations').selectAll()
    .where('operation_id', '=', operationId).executeTakeFirst()
  if (current?.state === 'terminal') return assertSameFinalizedEvidence(options.db)
  if (!current || current.state !== 'response_saved' || current.kind !== 'activation' || current.expected_generation !== null ||
    current.database_id !== identity.databaseId || current.instance_id !== identity.instanceId ||
    current.identity_jkt !== identity.identityJkt) fail('operation_terminal_evidence_binding_invalid')

  const accepted = await options.trustStore.getAccepted(input.readTrustedTime)

  try {
    await options.db.transaction().execute(async trx => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${operationId}, 0))`.execute(trx)
      const operation = await trx.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', operationId).forUpdate().executeTakeFirst()
      if (!operation) fail('operation_terminal_evidence_binding_invalid')
      if (operation.state === 'terminal') return assertSameFinalizedEvidence(trx)
      if (operation.state !== 'response_saved' || operation.kind !== 'activation' || operation.expected_generation !== null ||
        operation.database_id !== identity.databaseId || operation.instance_id !== identity.instanceId ||
        operation.identity_jkt !== identity.identityJkt) fail('operation_terminal_evidence_binding_invalid')
      const binding = await trx.selectFrom('installation_binding').selectAll()
        .where('singleton', '=', true).forUpdate().executeTakeFirst()
      if (!binding || binding.binding_state !== 'ready' || binding.database_id !== operation.database_id ||
        binding.instance_id !== operation.instance_id || binding.identity_jkt !== operation.identity_jkt) {
        fail('operation_terminal_evidence_binding_invalid')
      }
      const history = await validateOperationHistory({
        db: trx, pool: options.pool, pendingKeyRoot: options.pendingKeyRoot, operationId, issuer,
        centerOrigin: origin, identity,
      })
      const target = history.attempts.find(attempt => attempt.row.attempt_no === evidenceAttemptNo)
      if (!target || !target.response || String(target.row.send_state) !== 'response_saved' || !target.response.equals(rawEvidence)) {
        fail('operation_terminal_evidence_binding_invalid')
      }
      const pointer = history.attempts.find(attempt => attempt.row.attempt_no === operation.response_attempt_no)
      if (!pointer || !pointer.response || pointer.row.response_digest !== operation.response_digest ||
        pointer.row.response_saved_at?.getTime() !== operation.response_saved_at?.getTime()) {
        fail('operation_terminal_evidence_history_invalid')
      }
      const verified = await verifyLicenseOperationReceipt(target.response.toString('ascii'), {
        resolver: accepted.resolver, issuer, trustedTime: input.readTrustedTime(),
      })
      if (verified.claims.state !== 'rejected') fail('operation_terminal_evidence_not_rejected')
      const bound = boundOperationReceiptClaims({
        history,
        requestAttemptNo: evidenceAttemptNo,
        requestNonceHash: target.row.request_nonce_hash,
        requestDigest: target.row.request_body_digest,
        claims: verified.claims,
      })
      if (bound.state !== 'rejected') fail('operation_terminal_evidence_not_rejected')

      // A locally saved lease or a conflicting committed result permanently blocks rejection settlement.
      for (const attempt of history.attempts) {
        if (attempt.archivedResult !== null &&
          (attempt.row.attempt_no !== bound.committedAttemptNo || bound.resultJws === null ||
            !attempt.archivedResult.equals(Buffer.from(bound.resultJws, 'ascii')))) {
          fail('operation_terminal_evidence_history_conflict')
        }
        if (!attempt.response) continue
        if (attempt.row.attempt_no === evidenceAttemptNo) continue
        let previous: { header: Record<string, unknown>; claims: Record<string, unknown> }
        try { previous = decodeCompactJws(attempt.response.toString('ascii')) } catch { continue }
        if (previous.header.typ === 'aikayun-license+jwt' ||
          (previous.header.typ === 'aikayun-license-operation+jwt' &&
            ['committed', 'cancelled'].includes(String(previous.claims.state)))) {
          fail('operation_terminal_evidence_history_conflict')
        }
        if (previous.header.typ !== 'aikayun-license-operation+jwt' || previous.claims.state !== 'rejected') continue
        if (bound.committedAttemptNo === attempt.row.attempt_no && bound.resultJws !== null &&
          attempt.response.toString('ascii') === bound.resultJws) continue
        let previousVerified: { claims: Readonly<Record<string, unknown>> }
        try {
          previousVerified = await verifyLicenseOperationReceipt(attempt.response.toString('ascii'), {
            resolver: accepted.resolver, issuer, trustedTime: input.readTrustedTime(),
          })
        } catch {
          try {
            previousVerified = await verifyExpiredHistoricalOperationReceipt(attempt.response.toString('ascii'), {
              resolver: accepted.resolver, issuer, trustedTime: input.readTrustedTime(),
            })
          } catch { continue }
        }
        const previousBound = boundOperationReceiptClaims({
          history, requestAttemptNo: attempt.row.attempt_no, requestNonceHash: attempt.row.request_nonce_hash,
          requestDigest: attempt.row.request_body_digest, claims: previousVerified.claims,
        })
        if (previousBound.state !== bound.state || previousBound.outcomeCode !== bound.outcomeCode ||
          previousBound.committedAttemptNo !== bound.committedAttemptNo || previousBound.resultDigest !== bound.resultDigest) {
          fail('operation_terminal_evidence_history_conflict')
        }
      }

      const latestTrust = await options.trustStore.getAccepted(input.readTrustedTime)
      if (latestTrust.artifactSha256 !== accepted.artifactSha256) fail('operation_trust_bundle_changed')
      await input.checkpoint?.('before_terminal_evidence_commit')
      const finalizedAt = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)
      const updated = await trx.updateTable('local_license_operations').set({
        state: 'terminal',
        encrypted_center_evidence: encryptedEvidence.ciphertext,
        center_evidence_key_id: encryptedEvidence.keyId,
        center_evidence_digest: evidenceDigest,
        finalized_at: finalizedAt.rows[0]!.now,
      }).where('operation_id', '=', operationId).where('state', '=', 'response_saved')
        .returning('operation_id').executeTakeFirst()
      if (!updated) fail('operation_terminal_evidence_state_conflict')
      await input.checkpoint?.('after_terminal_row_update')
    })
    await input.checkpoint?.('after_terminal_evidence_commit')
    await assertSameFinalizedEvidence(options.db)
  } catch (error) {
    // A lost COMMIT acknowledgement is recovered only by reading and matching this operation's
    // immutable terminal evidence. No second operation is ever created here.
    const after = await options.db.selectFrom('local_license_operations').select('state')
      .where('operation_id', '=', operationId).executeTakeFirst()
    if (after?.state === 'terminal') return assertSameFinalizedEvidence(options.db)
    throw error
  }
}

function resultEvidence(
  operation: PendingActivationOperation,
  requestAttemptNo: number,
  bound: ReturnType<typeof boundOperationReceiptClaims>,
  resultDisposition: VerifiedOperationRecoveryEvidence['resultDisposition'],
): VerifiedOperationRecoveryEvidence {
  return Object.freeze({
    purpose: 'verified_activation_operation_recovery',
    operationId: operation.operationId,
    licenseId: operation.licenseId,
    identityJkt: operation.identityJkt,
    requestAttemptNo,
    state: bound.state,
    outcomeCode: bound.outcomeCode,
    committedAttemptNo: bound.committedAttemptNo,
    resultJwsDigest: bound.resultDigest,
    resultDisposition,
    signatureVerified: true,
    projected: false,
  })
}

function mapHttpFailure(status: number, stage: 'query' | 'continue'): never {
  if (stage === 'continue' && status === 403) return fail('requires_protocol_resolution')
  return fail('operation_recovery_result_unknown')
}

async function runOneRecoveryRequest(input: {
  options: LicenseOperationRecoveryClientOptions
  operationId: string
  stage: 'query' | 'continue'
  checkpoint: (stage: LicenseRecoveryCheckpoint) => Promise<void>
  assertLockHeld: () => Promise<void>
}): Promise<VerifiedOperationRecoveryEvidence> {
  const { options, operationId, stage, checkpoint } = input
  return withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async (identity) => {
    const origin = new URL(options.releaseConfig.expected_center_origin)
    const historyBeforeChallenge = await validateOperationHistory({
      db: options.db, pool: options.pool, pendingKeyRoot: options.pendingKeyRoot, operationId,
      issuer: options.releaseConfig.expected_center_issuer, centerOrigin: origin, identity,
    })
    const operation = historyBeforeChallenge.operation
    const challenge = await requestBoundChallenge(options, operationId, stage)
    await assertRecoveryChallengeCurrent({ options, operation, challenge, expectedOperation: stage })
    // Re-read every immutable attempt after Challenge I/O so a racing original activation
    // is included before this request receives the next shared attempt number.
    await validateOperationHistory({
      db: options.db, pool: options.pool, pendingKeyRoot: options.pendingKeyRoot, operationId,
      issuer: options.releaseConfig.expected_center_issuer, centerOrigin: origin, identity,
    })
    let requestDigest = ''
    const path = stage === 'query' ? LICENSE_OPERATION_QUERY_PATH : LICENSE_OPERATION_CONTINUE_PATH
    const payload = stage === 'continue'
      ? { activationCode: historyBeforeChallenge.activationCode, origin: historyBeforeChallenge.origin }
      : undefined
    const attempt = await allocateLicenseOperationAttempt(options.db, options.pendingKeyRoot, {
      operationId,
      purpose: stage,
      intentDigest: operation.intentDigest,
      clientNonce: challenge.clientNonce,
      requestNonce: challenge.serverNonce,
      identityJkt: identity.identityJkt,
      async buildRequest(attemptNo) {
        const created = challenge.timeSample.assertFresh()
        assertBoundChallenge(challenge, operation, stage, created)
        const common = {
          operation_id: operation.operationId,
          intent_digest: operation.intentDigest,
          attempt_no: attemptNo,
          license_id: operation.licenseId,
          database_id: operation.databaseId,
          instance_id: operation.instanceId,
          identity_jkt: operation.identityJkt,
          public_jwk: identity.publicJwk,
          challenge: challenge.token,
        }
        const requestBody = Buffer.from(JSON.stringify(stage === 'query' ? common : {
          ...common,
          activation_code: payload!.activationCode,
          origin: payload!.origin,
          kind: 'activation',
        }), 'utf8')
        const signed = await createSignedLicenseRequest({
          origin,
          path,
          body: requestBody,
          identity,
          nonce: challenge.serverNonce,
          created,
        })
        requestDigest = sha256Base64url(signed.body)
        const signatureCreatedAt = new Date(created * 1000)
        const requestEnvelope = Buffer.from(JSON.stringify({
          schema: 1,
          method: 'POST',
          target: path,
          headers: signed.headers,
          body_base64url: signed.body.toString('base64url'),
        }), 'utf8')
        await checkpoint('before_attempt_commit')
        return { requestBody: signed.body, signingKeyId: identity.identityJkt, signatureCreatedAt, requestEnvelope }
      },
    })
    await checkpoint('after_attempt_commit')
    if (attempt.reused || attempt.state !== 'prepared' || attempt.requestBodyDigest !== requestDigest) {
      fail('operation_attempt_already_exists')
    }
    await markLicenseOperationAttemptSent(options.db, operationId, attempt.attemptNo)
    await checkpoint('after_sent_commit')
    const stored = await readLicenseOperationAttemptEnvelope(options.db, options.pendingKeyRoot, operationId, attempt.attemptNo)
    const parsed = await requestEnvelopeParts({
      operation,
      activationCode: historyBeforeChallenge.activationCode,
      origin: historyBeforeChallenge.origin,
      issuer: options.releaseConfig.expected_center_issuer,
      row: await options.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', operationId).where('attempt_no', '=', attempt.attemptNo).executeTakeFirstOrThrow() as unknown as LocalLicenseOperationAttemptsTable,
      envelope: stored.requestEnvelope,
      centerOrigin: origin,
    })
    const request = signedRequestFromStoredEnvelope(stored.requestEnvelope)
    if (!request.body.equals(parsed.body) || stored.requestBodyDigest !== attempt.requestBodyDigest ||
      parsed.challengeClaims.operation !== stage || parsed.challengeClaims.server_nonce !== challenge.serverNonce ||
      parsed.challengeClaims.client_nonce !== challenge.clientNonce) fail('operation_attempt_persistence_invalid')
    try {
      const sendTime = challenge.timeSample.assertFresh()
      assertBoundChallenge(challenge, operation, stage, sendTime)
      const accepted = await options.trustStore.getAccepted(challenge.timeSample.assertFresh)
      if (accepted.artifactSha256 !== challenge.trustBundleDigest || sendTime >= stored.signatureCreatedAt.getTime() / 1000 + 60) {
        fail('operation_challenge_expired')
      }
      const currentOperation = await readPendingActivationOperation(options.db, options.pendingKeyRoot, operationId, identity, {
        allowResponseSaved: true,
      })
      if (currentOperation.intentDigest !== operation.intentDigest || currentOperation.licenseId !== operation.licenseId) {
        fail('operation_binding_changed')
      }
      const currentIdentity = await withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async current => ({
        databaseId: current.databaseId, instanceId: current.instanceId, identityJkt: current.identityJkt,
      }))
      if (currentIdentity.databaseId !== operation.databaseId || currentIdentity.instanceId !== operation.instanceId ||
        currentIdentity.identityJkt !== operation.identityJkt) fail('operation_identity_changed')
      await assertRecoveryChallengeCurrent({ options, operation, challenge, expectedOperation: stage })
    } catch (error) {
      await markLicenseOperationAttemptTransportResult(options.db, operationId, attempt.attemptNo, 'transport_error')
      throw error
    }
    let response
    try {
      await checkpoint('before_http_send')
      await input.assertLockHeld()
      response = await postSignedLicenseRequest({
        origin,
        path,
        signed: request,
        ...(options.testTls === undefined ? {} : { testTls: options.testTls }),
      })
      await input.assertLockHeld()
    } catch {
      await markLicenseOperationAttemptTransportResult(options.db, operationId, attempt.attemptNo, 'transport_unknown')
      fail('operation_recovery_result_unknown')
    }
    try {
      await checkpoint('after_http_response')
      await input.assertLockHeld()
    } catch {
      await markLicenseOperationAttemptTransportResult(options.db, operationId, attempt.attemptNo, 'transport_unknown')
      fail('operation_recovery_result_unknown')
    }
    if (response.statusCode !== 200) {
      await markLicenseOperationAttemptTransportResult(options.db, operationId, attempt.attemptNo, 'transport_unknown')
      mapHttpFailure(response.statusCode, stage)
    }
    const responseJws = parseOperationReceiptResponse(response)
    try {
      await checkpoint('before_response_save')
      await saveLicenseOperationResponse(options.db, options.pendingKeyRoot, operationId, attempt.attemptNo, responseJws)
      const persisted = await readLicenseOperationAttemptResponse(options.db, options.pendingKeyRoot, operationId, attempt.attemptNo)
      if (!persisted.equals(responseJws)) fail('operation_response_archive_mismatch')
    } catch {
      try {
        await saveLicenseOperationResponse(options.db, options.pendingKeyRoot, operationId, attempt.attemptNo, responseJws)
        const persisted = await readLicenseOperationAttemptResponse(options.db, options.pendingKeyRoot, operationId, attempt.attemptNo)
        if (!persisted.equals(responseJws)) fail('operation_response_archive_mismatch')
      } catch { fail('operation_response_archive_unknown') }
    }
    await checkpoint('after_response_saved')
    const responseCandidate = await options.trustStore.getCandidateForTimeBootstrap()
    if (!responseCandidate || responseCandidate.claims.sub !== options.releaseConfig.expected_center_issuer) {
      fail('operation_trust_bundle_unavailable')
    }
    const responseSample = await fetchTrustedTimeAnchor(options.releaseConfig, responseCandidate, createTestAnchorOptions(options.testTls))
    const trustedTime = responseSample.assertFresh()
    const accepted = await options.trustStore.getAccepted(responseSample.assertFresh)
    if (accepted.artifactSha256 !== challenge.trustBundleDigest) fail('operation_trust_bundle_changed')
    const verified = await verifyLicenseOperationReceipt(responseJws.toString('ascii'), {
      resolver: accepted.resolver,
      issuer: options.releaseConfig.expected_center_issuer,
      trustedTime,
    })
    const historyAfterResponse = await validateOperationHistory({
      db: options.db, pool: options.pool, pendingKeyRoot: options.pendingKeyRoot, operationId,
      issuer: options.releaseConfig.expected_center_issuer, centerOrigin: origin, identity,
    })
    // Re-evaluate using the complete durable history, including the just-saved current response.
    const checked = boundOperationReceiptClaims({
      history: historyAfterResponse,
      requestAttemptNo: attempt.attemptNo,
      requestNonceHash: attempt.requestNonceHash,
      requestDigest: attempt.requestBodyDigest,
      claims: verified.claims,
    })
    if (checked.state === 'not_found') {
      const historicalTerminal = await verifiedHistoricalTerminal({
        history: historyAfterResponse,
        resolver: accepted.resolver,
        issuer: options.releaseConfig.expected_center_issuer,
        trustedTime,
      })
        if (historicalTerminal) {
          if (historicalTerminal.bound.state === 'rejected') {
            const disposition = await archiveAndClassifyResult({
              options, operationId, accepted, trustedTime, history: historyAfterResponse,
              bound: historicalTerminal.bound,
            })
            await finalizeTrustedActivationRejection({
              options, operationId, evidenceAttemptNo: historicalTerminal.attemptNo,
              readTrustedTime: () => responseSample.assertFresh(), checkpoint,
            })
            return resultEvidence(operation, historicalTerminal.attemptNo, historicalTerminal.bound, disposition)
          }
          return resultEvidence(operation, historicalTerminal.attemptNo, historicalTerminal.bound, 'none')
        }
      await ensureNotFoundDoesNotContradictHistory({
        history: historyAfterResponse, resolver: accepted.resolver,
        issuer: options.releaseConfig.expected_center_issuer, trustedTime,
      })
    }
    const resultDisposition = await archiveAndClassifyResult({
      options, operationId, accepted, trustedTime, history: historyAfterResponse, bound: checked,
    })
    if (checked.state === 'rejected') {
      await finalizeTrustedActivationRejection({
        options, operationId, evidenceAttemptNo: attempt.attemptNo,
        readTrustedTime: () => responseSample.assertFresh(), checkpoint,
      })
    }
    const latestBundle = await options.trustStore.getAccepted(responseSample.assertFresh)
    if (latestBundle.artifactSha256 !== accepted.artifactSha256) fail('operation_trust_bundle_changed')
    return resultEvidence(operation, attempt.attemptNo, checked, resultDisposition)
  })
}

export function createLicenseOperationRecoveryClient(options: LicenseOperationRecoveryClientOptions) {
  if ((options.testTls !== undefined || options.onTestCheckpoint !== undefined) && process.env.NODE_ENV !== 'test') {
    fail('license_test_transport_forbidden')
  }
  const checkpoint = async (stage: LicenseRecoveryCheckpoint) => options.onTestCheckpoint?.(stage)
  async function queryLocked(operationId: string, assertLockHeld: () => Promise<void>): Promise<VerifiedOperationRecoveryEvidence> {
    const identity = await withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async current => ({
      databaseId: current.databaseId, instanceId: current.instanceId, identityJkt: current.identityJkt,
    }))
    const origin = new URL(options.releaseConfig.expected_center_origin)
    await validateOperationHistory({
      db: options.db, pool: options.pool, pendingKeyRoot: options.pendingKeyRoot, operationId,
      issuer: options.releaseConfig.expected_center_issuer, centerOrigin: origin, identity,
    })
    return runOneRecoveryRequest({ options, operationId, stage: 'query', checkpoint, assertLockHeld })
  }
  return Object.freeze({
    async queryPendingActivation(operationId: string): Promise<VerifiedOperationRecoveryEvidence> {
      try {
        return await withRecoveryOperationLock(options.pool, operationId, assertHeld => queryLocked(operationId, assertHeld))
      } catch (error) {
        if (error instanceof LicenseOperationRecoveryError) throw error
        if (error instanceof LocalLicenseOperationError) fail(error.code)
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
        if (code && /^[a-z][a-z0-9_]{1,80}$/u.test(code)) fail(code)
        fail('operation_recovery_failed')
      }
    },
    async continuePendingActivation(operationId: string): Promise<RecoveredActivationOperation> {
      try {
        return await withRecoveryOperationLock(options.pool, operationId, async (assertHeld) => {
          const query = await queryLocked(operationId, assertHeld)
          if (query.state !== 'not_found') return Object.freeze({ query, continuation: null })
          const identity = await withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async current => ({
            databaseId: current.databaseId, instanceId: current.instanceId, identityJkt: current.identityJkt,
          }))
          const origin = new URL(options.releaseConfig.expected_center_origin)
          await validateOperationHistory({
            db: options.db, pool: options.pool, pendingKeyRoot: options.pendingKeyRoot, operationId,
            issuer: options.releaseConfig.expected_center_issuer, centerOrigin: origin, identity,
          })
          // The signed not_found is advisory only. Continue uses the identical operation and intent;
          // the center's operation lock serializes it with any late original activation.
          const continuation = await runOneRecoveryRequest({ options, operationId, stage: 'continue', checkpoint, assertLockHeld: assertHeld })
          return Object.freeze({ query, continuation })
        })
      } catch (error) {
        if (error instanceof LicenseOperationRecoveryError) throw error
        if (error instanceof LocalLicenseOperationError) fail(error.code)
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
        if (code && /^[a-z][a-z0-9_]{1,80}$/u.test(code)) fail(code)
        fail('operation_recovery_failed')
      }
    },
    async recoverPendingActivation(operationId: string): Promise<RecoveredActivationOperation> {
      return this.continuePendingActivation(operationId)
    },
  })
}
