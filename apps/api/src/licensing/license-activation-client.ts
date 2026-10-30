import { createHash } from 'node:crypto'
import { ByteSequence, parseDictionary } from 'structured-headers'
import type { Kysely } from 'kysely'
import type { Pool } from 'pg'
import type { Database } from '../db/types.js'
import {
  LICENSE_ACTIVATION_PATH,
  createSignedLicenseRequest,
  postSignedLicenseRequest,
} from './license-request-http.js'
import type { TestLicenseTlsOptions } from './license-request-http.js'
import {
  assertChallengeClaimsBound,
  createLicenseChallengeClient,
  readPendingActivationOperation,
} from './license-challenge-client.js'
import type { PendingActivationOperation, VerifiedBoundChallenge } from './license-challenge-client.js'
import {
  allocateLicenseOperationAttempt,
  markLicenseOperationAttemptSent,
  markLicenseOperationAttemptTransportResult,
  readActivationOperationPayload,
  readLicenseOperationAttemptEnvelope,
  readLicenseOperationAttemptResponse,
  saveLicenseOperationResponse,
} from './license-operation-store.js'
import { LocalLicenseOperationError } from './license-operation-store.js'
import { withVerifiedInstallationSigningContext } from './installation-identity.js'
import { verifyCurrentLicenseLease, verifyLicenseChallenge, verifyLicenseOperationReceipt } from './trust/evidence.js'
import type { VerifiedCurrentLeaseEvidence } from './trust/evidence.js'
import { fetchTrustedTimeAnchor } from './trust/time-anchor-client.js'
import { TrustBundleStore } from './trust/trust-bundle-store.js'
import type { TrustedReleaseLicenseConfig } from './trusted-release-config.js'
import { parseStrictJson } from './strict-json.js'

const REQUEST_HEADER_NAMES = [
  'accept', 'connection', 'content-digest', 'content-length', 'content-type', 'host', 'signature', 'signature-input',
] as const
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u
const DIGEST = /^[A-Za-z0-9_-]{43}$/u

export class LicenseActivationClientError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'LicenseActivationClientError'
  }
}

/** Verified response evidence only. This deliberately contains no grant or allow property. */
export type VerifiedUnprojectedActivationEvidence =
  | Readonly<{
    purpose: 'verified_activation_lease_unprojected'
    operationId: string
    attemptNo: number
    licenseId: string
    databaseId: string
    instanceId: string
    identityJkt: string
    signingKeyId: string
    activationGeneration: string
    entitlementRevision: string
    subscriptionEnd: number
    leaseExpiresAt: number
    signatureVerified: true
    projected: false
  }>
  | Readonly<{
    purpose: 'verified_activation_rejection_unprojected'
    operationId: string
    attemptNo: number
    licenseId: string
    identityJkt: string
    signingKeyId: string
    outcomeCode: string
    signatureVerified: true
    projected: false
  }>

export interface LicenseActivationClientOptions {
  readonly db: Kysely<Database>
  readonly pool: Pool
  readonly identityRoot: string
  readonly pendingKeyRoot: string
  readonly releaseConfig: TrustedReleaseLicenseConfig
  readonly trustStore: TrustBundleStore
  /** Only isolated HTTPS integration tests may override test DNS or CA roots. */
  readonly testTls?: TestLicenseTlsOptions
  /** Isolated process-crash coverage only. Rejected outside NODE_ENV=test. */
  readonly onTestCheckpoint?: (stage: LicenseActivationCheckpoint) => void | Promise<void>
}

export type LicenseActivationCheckpoint =
  | 'before_attempt_commit'
  | 'after_attempt_commit'
  | 'after_sent_commit'
  | 'before_http_send'
  | 'after_http_response'
  | 'before_response_save'
  | 'after_response_saved'

function fail(code: string): never {
  throw new LicenseActivationClientError(code)
}

function sha256Base64url(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function assertCanonicalNonce(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) fail('activation_challenge_invalid')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) fail('activation_challenge_invalid')
}

export function assertActivationEvidenceFresh(
  challenge: Pick<VerifiedBoundChallenge, 'clientNonce' | 'serverNonce' | 'issuedAt' | 'expiresAt'>,
  trustedTime: number,
  signatureCreatedAt?: number,
): void {
  if (!Number.isSafeInteger(trustedTime) || trustedTime <= 0 || challenge.issuedAt > trustedTime ||
    challenge.expiresAt <= trustedTime || challenge.expiresAt - challenge.issuedAt !== 300) {
    fail('activation_challenge_expired')
  }
  assertCanonicalNonce(challenge.clientNonce)
  assertCanonicalNonce(challenge.serverNonce)
  if (signatureCreatedAt !== undefined &&
    (!Number.isSafeInteger(signatureCreatedAt) || signatureCreatedAt <= 0 || trustedTime >= signatureCreatedAt + 60)) {
    fail('activation_signature_expired')
  }
}

async function verifyBoundChallengeAtCurrentTrust(
  challenge: VerifiedBoundChallenge,
  operation: PendingActivationOperation,
  trustedTime: number,
  options: LicenseActivationClientOptions,
): Promise<{ artifactSha256: string }> {
  assertActivationEvidenceFresh(challenge, trustedTime)
  const accepted = await options.trustStore.getAccepted(() => trustedTime)
  const verified = await verifyLicenseChallenge(challenge.token, {
    resolver: accepted.resolver,
    issuer: options.releaseConfig.expected_center_issuer,
    trustedTime,
  })
  if (verified.signingKeyId !== challenge.signingKeyId ||
    verified.claims.operation !== 'activation' || verified.claims.operation_id !== operation.operationId ||
    verified.claims.intent_digest !== operation.intentDigest || verified.claims.instance_id !== operation.instanceId ||
    verified.claims.identity_jkt !== operation.identityJkt || verified.claims.client_nonce !== challenge.clientNonce) {
    fail('activation_challenge_binding_invalid')
  }
  const bound = assertChallengeClaimsBound(verified.claims, operation, challenge.clientNonce, trustedTime)
  if (bound.serverNonce !== challenge.serverNonce || bound.issuedAt !== challenge.issuedAt ||
    bound.expiresAt !== challenge.expiresAt) fail('activation_challenge_binding_invalid')
  return { artifactSha256: accepted.artifactSha256 }
}

function parsePersistedEnvelope(
  bytes: Uint8Array,
  origin: URL,
  operation: PendingActivationOperation,
  challenge: VerifiedBoundChallenge,
  attempt: Awaited<ReturnType<typeof readLicenseOperationAttemptEnvelope>>,
): { body: Buffer; headers: Record<string, string> } {
  let value: unknown
  try { value = parseStrictJson(bytes) } catch { fail('activation_request_envelope_invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('activation_request_envelope_invalid')
  const envelope = value as Record<string, unknown>
  if (Object.keys(envelope).sort().join(',') !== 'body_base64url,headers,method,schema,target' ||
    envelope.schema !== 1 || envelope.method !== 'POST' || envelope.target !== LICENSE_ACTIVATION_PATH ||
    typeof envelope.body_base64url !== 'string' || !/^(?:[A-Za-z0-9_-]{2,})$/u.test(envelope.body_base64url) ||
    !envelope.headers || typeof envelope.headers !== 'object' || Array.isArray(envelope.headers)) {
    fail('activation_request_envelope_invalid')
  }
  const body = Buffer.from(envelope.body_base64url, 'base64url')
  if (body.toString('base64url') !== envelope.body_base64url || sha256Base64url(body) !== attempt.requestBodyDigest) {
    fail('activation_request_digest_mismatch')
  }
  const headers = envelope.headers as Record<string, unknown>
  if (Object.keys(headers).sort().join(',') !== [...REQUEST_HEADER_NAMES].sort().join(',')) fail('activation_request_envelope_invalid')
  const stringHeaders: Record<string, string> = {}
  for (const [name, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== 'string' || /[\r\n]/u.test(headerValue)) fail('activation_request_envelope_invalid')
    stringHeaders[name] = headerValue
  }
  if (stringHeaders.host !== origin.host || stringHeaders.accept !== 'application/json' ||
    stringHeaders['content-type'] !== 'application/json' || stringHeaders.connection !== 'close' ||
    stringHeaders['content-length'] !== String(body.byteLength) || attempt.purpose !== 'activation' ||
    attempt.sendState !== 'sent' || attempt.identityJkt !== operation.identityJkt || attempt.intentDigest !== operation.intentDigest ||
    attempt.signingKeyId !== operation.identityJkt || attempt.requestNonceHash !== sha256Base64url(challenge.serverNonce) ||
    attempt.clientNonceHash !== sha256Base64url(challenge.clientNonce)) fail('activation_request_binding_invalid')

  let bodyValue: unknown
  try { bodyValue = parseStrictJson(body) } catch { fail('activation_request_body_invalid') }
  if (!bodyValue || typeof bodyValue !== 'object' || Array.isArray(bodyValue)) fail('activation_request_body_invalid')
  const requestBody = bodyValue as Record<string, unknown>
  if (requestBody.operation_id !== operation.operationId || requestBody.intent_digest !== operation.intentDigest ||
    requestBody.license_id !== operation.licenseId || requestBody.database_id !== operation.databaseId ||
    requestBody.instance_id !== operation.instanceId || requestBody.identity_jkt !== operation.identityJkt ||
    requestBody.challenge !== challenge.token || requestBody.attempt_no !== attempt.attemptNo ||
    !requestBody.public_jwk || typeof requestBody.public_jwk !== 'object' || Array.isArray(requestBody.public_jwk)) {
    fail('activation_request_binding_invalid')
  }

  let signatureInput: ReturnType<typeof parseDictionary>
  let signature: ReturnType<typeof parseDictionary>
  let contentDigest: ReturnType<typeof parseDictionary>
  try {
    signatureInput = parseDictionary(stringHeaders['signature-input']!)
    signature = parseDictionary(stringHeaders.signature!)
    contentDigest = parseDictionary(stringHeaders['content-digest']!)
  } catch { fail('activation_request_signature_invalid') }
  const input = signatureInput.get('sig1')
  const signatureValue = signature.get('sig1')
  const digestValue = contentDigest.get('sha-256')
  if (signatureInput.size !== 1 || !input || !Array.isArray(input) || signature.size !== 1 || !signatureValue ||
    !Array.isArray(signatureValue) || !(signatureValue[0] instanceof ByteSequence) || signatureValue[1].size !== 0 ||
    contentDigest.size !== 1 || !digestValue || !Array.isArray(digestValue) ||
    !(digestValue[0] instanceof ByteSequence) || digestValue[1].size !== 0 ||
    digestValue[0].toBase64() !== createHash('sha256').update(body).digest('base64')) {
    fail('activation_request_signature_invalid')
  }
  const [components, parameters] = input
  const componentNames = Array.isArray(components)
    ? components.map(entry => Array.isArray(entry) ? entry[0] : entry)
    : []
  const createdAt = attempt.signatureCreatedAt.getTime() / 1000
  if (!Number.isSafeInteger(createdAt) || componentNames.join(',') !== '@method,@target-uri,content-type,content-digest' ||
    [...parameters.keys()].sort().join(',') !== 'alg,created,expires,keyid,nonce,tag' ||
    parameters.get('created') !== createdAt || parameters.get('expires') !== createdAt + 60 ||
    parameters.get('keyid') !== operation.identityJkt || parameters.get('nonce') !== challenge.serverNonce ||
    parameters.get('alg') !== 'ed25519' || parameters.get('tag') !== 'aikayun-license-v1') {
    fail('activation_request_signature_invalid')
  }
  return { body, headers: stringHeaders }
}

function parseCompactResponse(response: { statusCode: number; headers: { 'content-type'?: string | string[] | undefined }; body: Buffer }): {
  kind: 'lease' | 'operation_receipt'
  tokenBytes: Buffer
} {
  const kind = response.statusCode === 200 ? 'lease' : response.statusCode === 409 ? 'operation_receipt' : undefined
  const expectedName = kind === 'lease' ? 'license' : kind === 'operation_receipt' ? 'operation_receipt' : undefined
  const contentTypeHeader = response.headers['content-type']
  const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader
  if (!kind || !expectedName || typeof contentType !== 'string' ||
    contentType.split(';', 1)[0]!.trim().toLowerCase() !== 'application/json') fail('activation_signed_response_unavailable')

  let parsed: unknown
  try { parsed = parseStrictJson(response.body) } catch { fail('activation_signed_response_unavailable') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('activation_signed_response_unavailable')
  const envelope = parsed as Record<string, unknown>
  if (Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, expectedName)) fail('activation_signed_response_unavailable')
  const token = envelope[expectedName]
  if (typeof token !== 'string' || token.length < 100 || token.length > 16 * 1024 || !COMPACT_JWS.test(token)) {
    fail('activation_signed_response_unavailable')
  }
  return { kind, tokenBytes: Buffer.from(token, 'ascii') }
}

function leaseIdentity(operation: PendingActivationOperation) {
  return {
    status: 'ready' as const,
    code: 'ready',
    databaseId: operation.databaseId,
    instanceId: operation.instanceId,
    identityJkt: operation.identityJkt,
    bindingState: 'ready' as const,
  }
}

function verifiedLeaseEvidence(
  operation: PendingActivationOperation,
  attemptNo: number,
  evidence: VerifiedCurrentLeaseEvidence,
  requestDigest: string,
  requestNonce: string,
): VerifiedUnprojectedActivationEvidence {
  if (evidence.licenseId !== operation.licenseId || evidence.databaseId !== operation.databaseId ||
    evidence.instanceId !== operation.instanceId || evidence.identityJkt !== operation.identityJkt ||
    evidence.requestNonce !== requestNonce || evidence.requestDigest !== requestDigest || !evidence.signatureVerified) {
    fail('activation_lease_binding_invalid')
  }
  return Object.freeze({
    purpose: 'verified_activation_lease_unprojected',
    operationId: operation.operationId,
    attemptNo,
    licenseId: evidence.licenseId,
    databaseId: evidence.databaseId,
    instanceId: evidence.instanceId,
    identityJkt: evidence.identityJkt,
    signingKeyId: evidence.signingKeyId,
    activationGeneration: evidence.activationGeneration,
    entitlementRevision: evidence.entitlementRevision,
    subscriptionEnd: evidence.subscriptionEnd,
    leaseExpiresAt: evidence.expiresAt,
    signatureVerified: true,
    projected: false,
  })
}

function verifiedRejectionEvidence(
  operation: PendingActivationOperation,
  attemptNo: number,
  signingKeyId: string,
  claims: Readonly<Record<string, unknown>>,
  requestNonceHash: string,
  requestDigest: string,
): VerifiedUnprojectedActivationEvidence {
  const outcomeCode = claims.outcome_code
  if (claims.operation_id !== operation.operationId || claims.intent_digest !== operation.intentDigest ||
    claims.sub !== operation.licenseId || claims.actor_jkt !== operation.identityJkt ||
    claims.attempt_no !== attemptNo || claims.request_nonce_hash !== requestNonceHash ||
    claims.request_digest !== requestDigest || claims.state !== 'rejected' ||
    typeof outcomeCode !== 'string' || outcomeCode.length < 1 || outcomeCode.length > 128) {
    fail('activation_receipt_binding_invalid')
  }
  return Object.freeze({
    purpose: 'verified_activation_rejection_unprojected',
    operationId: operation.operationId,
    attemptNo,
    licenseId: operation.licenseId,
    identityJkt: operation.identityJkt,
    signingKeyId,
    outcomeCode,
    signatureVerified: true,
    projected: false,
  })
}

function codeFromUnknown(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function assertTrustBundleUnchanged(expected: string, observed: string): void {
  if (expected !== observed) fail('activation_trust_bundle_changed')
}

export function createLicenseActivationClient(options: LicenseActivationClientOptions) {
  if ((options.testTls !== undefined || options.onTestCheckpoint !== undefined) && process.env.NODE_ENV !== 'test') {
    fail('license_test_transport_forbidden')
  }
  const checkpoint = async (stage: LicenseActivationCheckpoint): Promise<void> => {
    await options.onTestCheckpoint?.(stage)
  }
  const challengeClient = createLicenseChallengeClient(options)
  const origin = new URL(options.releaseConfig.expected_center_origin)
  const testAnchorOptions = options.testTls === undefined ? {} : {
    ...(options.testTls.ca === undefined ? {} : { testCa: options.testTls.ca }),
    ...(options.testTls.lookup === undefined ? {} : { testLookup: options.testTls.lookup }),
  }
  return Object.freeze({
    async submitPendingActivation(operationId: string): Promise<VerifiedUnprojectedActivationEvidence> {
      try {
        return await withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async (identity) => {
          const existingInitialAttempt = await options.db.selectFrom('local_license_operation_attempts')
            .select('attempt_no').where('operation_id', '=', operationId).where('purpose', '=', 'activation')
            .executeTakeFirst()
          if (existingInitialAttempt) fail('activation_attempt_already_exists')
          const operation = await readPendingActivationOperation(options.db, options.pendingKeyRoot, operationId, identity)
          const payload = await readActivationOperationPayload(options.db, options.pendingKeyRoot, operationId)

          // Challenge acquisition intentionally precedes the activation-attempt SQL transaction.
          const challengeResult = await challengeClient.requestActivationChallengeWithTimeSample(operationId)
          const challenge = challengeResult.challenge
          const sample = challengeResult.timeSample
          const trustedTime = sample.assertFresh()
          const initialBundleDigest = (await verifyBoundChallengeAtCurrentTrust(challenge, operation, trustedTime, options)).artifactSha256
          assertTrustBundleUnchanged(challengeResult.trustBundleDigest, initialBundleDigest)
          await assertCurrentOperationAndIdentity(options, operation, identity)
          const created = sample.assertFresh()
          assertActivationEvidenceFresh(challenge, created)

          let builtRequestDigest = ''
          const attempt = await allocateLicenseOperationAttempt(options.db, options.pendingKeyRoot, {
            operationId,
            purpose: 'activation',
            intentDigest: operation.intentDigest,
            clientNonce: challenge.clientNonce,
            requestNonce: challenge.serverNonce,
            identityJkt: identity.identityJkt,
            async buildRequest(attemptNo) {
              // This callback performs only local serialization/signing while the operation lock is held.
              const signingTime = sample.assertFresh()
              assertActivationEvidenceFresh(challenge, signingTime)
              const requestBody = Buffer.from(JSON.stringify({
                operation_id: operation.operationId,
                intent_digest: operation.intentDigest,
                attempt_no: attemptNo,
                license_id: operation.licenseId,
                database_id: operation.databaseId,
                instance_id: operation.instanceId,
                identity_jkt: operation.identityJkt,
                public_jwk: identity.publicJwk,
                challenge: challenge.token,
                activation_code: payload.activationCode,
                origin: payload.origin,
              }), 'utf8')
              const signed = await createSignedLicenseRequest({
                origin,
                path: LICENSE_ACTIVATION_PATH,
                body: requestBody,
                identity,
                nonce: challenge.serverNonce,
                created: signingTime,
              })
              const signatureCreatedAt = new Date(signingTime * 1000)
              const requestEnvelope = Buffer.from(JSON.stringify({
                schema: 1,
                method: 'POST',
                target: LICENSE_ACTIVATION_PATH,
                headers: signed.headers,
                body_base64url: signed.body.toString('base64url'),
              }), 'utf8')
              builtRequestDigest = sha256Base64url(signed.body)
              await checkpoint('before_attempt_commit')
              return { requestBody: signed.body, signingKeyId: identity.identityJkt, signatureCreatedAt, requestEnvelope }
            },
          })
          await checkpoint('after_attempt_commit')
          if (attempt.reused || attempt.state !== 'prepared') fail('activation_attempt_already_exists')
          if (!DIGEST.test(builtRequestDigest) || attempt.requestBodyDigest !== builtRequestDigest) {
            fail('activation_attempt_persistence_invalid')
          }

          // Persist possible-send evidence first, then reload the encrypted bytes for the actual HTTPS write.
          await markLicenseOperationAttemptSent(options.db, operationId, attempt.attemptNo)
          await checkpoint('after_sent_commit')
          const persisted = await readLicenseOperationAttemptEnvelope(options.db, options.pendingKeyRoot, operationId, attempt.attemptNo)
          const signed = parsePersistedEnvelope(persisted.requestEnvelope, origin, operation, challenge, persisted)

          try {
            const sendTime = sample.assertFresh()
            assertActivationEvidenceFresh(challenge, sendTime, Math.floor(persisted.signatureCreatedAt.getTime() / 1000))
            const finalBundle = await verifyBoundChallengeAtCurrentTrust(challenge, operation, sendTime, options)
            assertTrustBundleUnchanged(initialBundleDigest, finalBundle.artifactSha256)
            await assertCurrentOperationAndIdentity(options, operation, identity)
            assertTrustBundleUnchanged(initialBundleDigest, (await options.trustStore.getAccepted(sample.assertFresh)).artifactSha256)
            const immediateSendTime = sample.assertFresh()
            assertActivationEvidenceFresh(
              challenge, immediateSendTime, Math.floor(persisted.signatureCreatedAt.getTime() / 1000),
            )
          } catch (error) {
            await markLicenseOperationAttemptTransportResult(options.db, operationId, attempt.attemptNo, 'transport_error')
            throw error
          }

          let httpResponse
          try {
            await checkpoint('before_http_send')
            httpResponse = await postSignedLicenseRequest({
              origin,
              path: LICENSE_ACTIVATION_PATH,
              signed,
              ...(options.testTls === undefined ? {} : { testTls: options.testTls }),
            })
          } catch {
            await markLicenseOperationAttemptTransportResult(options.db, operationId, attempt.attemptNo, 'transport_unknown')
            fail('activation_result_unknown')
          }
          await checkpoint('after_http_response')

          let response: ReturnType<typeof parseCompactResponse>
          try {
            response = parseCompactResponse(httpResponse)
          } catch {
            await markLicenseOperationAttemptTransportResult(options.db, operationId, attempt.attemptNo, 'transport_unknown')
            fail('activation_result_unknown')
          }

          try {
            // Archive only the extracted compact JWS bytes. Verification always reads it back from encrypted storage.
            await checkpoint('before_response_save')
            await saveLicenseOperationResponse(
              options.db, options.pendingKeyRoot, operationId, attempt.attemptNo, response.tokenBytes,
            )
            const storedToken = await readLicenseOperationAttemptResponse(
              options.db, options.pendingKeyRoot, operationId, attempt.attemptNo,
            )
            if (!storedToken.equals(response.tokenBytes)) fail('activation_response_archive_mismatch')
          } catch (error) {
            // A lost PostgreSQL commit acknowledgement is resolved by replaying the same archive bytes only.
            try {
              await saveLicenseOperationResponse(
                options.db, options.pendingKeyRoot, operationId, attempt.attemptNo, response.tokenBytes,
              )
              const storedToken = await readLicenseOperationAttemptResponse(
                options.db, options.pendingKeyRoot, operationId, attempt.attemptNo,
              )
              if (!storedToken.equals(response.tokenBytes)) fail('activation_response_archive_mismatch')
            } catch {
              fail('activation_response_archive_unknown')
            }
            if (error instanceof LicenseActivationClientError) throw error
          }
          await checkpoint('after_response_saved')

          const responseCandidate = await options.trustStore.getCandidateForTimeBootstrap()
          if (!responseCandidate || responseCandidate.claims.sub !== options.releaseConfig.expected_center_issuer) {
            fail('activation_trust_bundle_unavailable')
          }
          const responseSample = await fetchTrustedTimeAnchor(options.releaseConfig, responseCandidate, testAnchorOptions)
          const responseTime = responseSample.assertFresh()
          const accepted = await options.trustStore.getAccepted(responseSample.assertFresh)
          assertTrustBundleUnchanged(initialBundleDigest, accepted.artifactSha256)
          const requestNonceHash = sha256Base64url(challenge.serverNonce)
          let verified: VerifiedUnprojectedActivationEvidence
          if (response.kind === 'lease') {
            const lease = await verifyCurrentLicenseLease(response.tokenBytes.toString('ascii'), {
              resolver: accepted.resolver,
              issuer: options.releaseConfig.expected_center_issuer,
              trustedTime: responseTime,
              identity: leaseIdentity(operation),
            })
            verified = verifiedLeaseEvidence(
              operation, attempt.attemptNo, lease, attempt.requestBodyDigest, challenge.serverNonce,
            )
          } else {
            const receipt = await verifyLicenseOperationReceipt(response.tokenBytes.toString('ascii'), {
              resolver: accepted.resolver,
              issuer: options.releaseConfig.expected_center_issuer,
              trustedTime: responseTime,
            })
            verified = verifiedRejectionEvidence(
              operation,
              attempt.attemptNo,
              receipt.signingKeyId,
              receipt.claims,
              requestNonceHash,
              attempt.requestBodyDigest,
            )
          }
          const latestBundle = await options.trustStore.getAccepted(responseSample.assertFresh)
          assertTrustBundleUnchanged(accepted.artifactSha256, latestBundle.artifactSha256)
          await assertCurrentOperationAndIdentity(options, operation, identity, true)
          return verified
        })
      } catch (error) {
        if (error instanceof LicenseActivationClientError) throw error
        if (error instanceof LocalLicenseOperationError) fail(error.code)
        const code = codeFromUnknown(error)
        if (code === 'activation_attempt_already_exists' || code === 'operation_not_pending' ||
          code === 'operation_attempt_binding_conflict' || code === 'operation_payload_intent_mismatch') fail(code)
        if (code && /^[a-z][a-z0-9_]{1,80}$/u.test(code)) fail(code)
        fail('activation_submission_failed')
      }
    },
  })
}

async function assertCurrentOperationAndIdentity(
  options: LicenseActivationClientOptions,
  operation: PendingActivationOperation,
  identity: { databaseId: string; instanceId: string; identityJkt: string },
  allowResponseSaved = false,
): Promise<void> {
  const current = await readPendingActivationOperation(options.db, options.pendingKeyRoot, operation.operationId, identity, { allowResponseSaved })
  if (current.operationId !== operation.operationId || current.intentDigest !== operation.intentDigest ||
    current.licenseId !== operation.licenseId || current.databaseId !== operation.databaseId ||
    current.instanceId !== operation.instanceId || current.identityJkt !== operation.identityJkt) {
    fail('activation_operation_changed')
  }
  const latestIdentity = await withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async (snapshot) => ({
    databaseId: snapshot.databaseId,
    instanceId: snapshot.instanceId,
    identityJkt: snapshot.identityJkt,
  }))
  if (latestIdentity.databaseId !== operation.databaseId || latestIdentity.instanceId !== operation.instanceId ||
    latestIdentity.identityJkt !== operation.identityJkt) fail('activation_identity_changed')
}
