import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Pool } from 'pg'
import type { Database } from '../db/types.js'
import { parseStrictJson } from './strict-json.js'
import { buildActivationIntent } from './license-intent.js'
import { readActivationOperationPayload } from './license-operation-store.js'
import { withVerifiedInstallationSigningContext } from './installation-identity.js'
import {
  LicenseHttpsRequestError,
  LICENSE_CHALLENGE_PATH,
  createSignedLicenseRequest,
  postSignedLicenseRequest,
} from './license-request-http.js'
import type { TestLicenseTlsOptions } from './license-request-http.js'
import type { TrustedReleaseLicenseConfig } from './trusted-release-config.js'
import { verifyLicenseChallenge } from './trust/evidence.js'
import type { VerifiedChallengeEvidence } from './trust/evidence.js'
import { fetchTrustedTimeAnchor } from './trust/time-anchor-client.js'
import type { TrustedTimeSample } from './trust/time-anchor-client.js'
import { TrustBundleStore } from './trust/trust-bundle-store.js'

const verifiedBoundChallengeBrand: unique symbol = Symbol('verified-bound-license-challenge')

export class LicenseChallengeClientError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'LicenseChallengeClientError'
  }
}

export interface VerifiedBoundChallenge {
  readonly [verifiedBoundChallengeBrand]: true
  readonly purpose: 'verified_bound_license_challenge'
  readonly token: string
  readonly signingKeyId: string
  readonly operation: 'activation'
  readonly operationId: string
  readonly intentDigest: string
  readonly databaseId: string
  readonly instanceId: string
  readonly identityJkt: string
  readonly clientNonce: string
  readonly serverNonce: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly signatureVerified: true
  readonly operationBound: true
}

export interface VerifiedBoundChallengeWithTimeSample {
  readonly challenge: VerifiedBoundChallenge
  readonly timeSample: TrustedTimeSample
  readonly trustBundleDigest: string
}

export interface LicenseChallengeClientOptions {
  readonly db: Kysely<Database>
  readonly pool: Pool
  readonly identityRoot: string
  readonly pendingKeyRoot: string
  readonly releaseConfig: TrustedReleaseLicenseConfig
  readonly trustStore: TrustBundleStore
  /** Only isolated HTTPS integration tests may override test DNS or CA roots. */
  readonly testTls?: TestLicenseTlsOptions
}

export interface PendingActivationOperation {
  readonly operationId: string
  readonly intentDigest: string
  readonly licenseId: string
  readonly databaseId: string
  readonly instanceId: string
  readonly identityJkt: string
}

function fail(code: string): never {
  throw new LicenseChallengeClientError(code)
}

function assertTrustedOrigin(config: TrustedReleaseLicenseConfig, store: TrustBundleStore): URL {
  let origin: URL
  try { origin = new URL(config.expected_center_origin) } catch { return fail('trusted_origin_invalid') }
  if (config.expected_center_issuer !== config.expected_center_origin || origin.protocol !== 'https:' ||
    origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== config.expected_center_origin ||
    store.expectedCenterIssuer !== config.expected_center_issuer || store.minimumBundleVersion !== config.minimum_bundle_version ||
    store.trustedRoot.kid !== config.offline_root.kid || store.trustedRoot.publicJwk.kty !== config.offline_root.publicJwk.kty ||
    store.trustedRoot.publicJwk.crv !== config.offline_root.publicJwk.crv || store.trustedRoot.publicJwk.x !== config.offline_root.publicJwk.x) {
    return fail('trusted_origin_invalid')
  }
  return origin
}

function assertCanonicalNonce(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) fail('challenge_nonce_invalid')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== value) fail('challenge_nonce_invalid')
}

export async function readPendingActivationOperation(
  db: Kysely<Database>,
  pendingKeyRoot: string,
  operationId: string,
  identity: { databaseId: string; instanceId: string; identityJkt: string },
  options: { allowResponseSaved?: boolean } = {},
): Promise<PendingActivationOperation> {
  const row = await db.selectFrom('local_license_operations')
    .select(['operation_id', 'kind', 'intent_digest', 'license_id', 'database_id', 'instance_id', 'identity_jkt', 'state', 'expected_generation'])
    .where('operation_id', '=', operationId)
    .executeTakeFirst()
  if (!row || row.kind !== 'activation' ||
    (row.state !== 'pending' && !(options.allowResponseSaved && row.state === 'response_saved')) || row.expected_generation !== null ||
    row.database_id !== identity.databaseId || row.instance_id !== identity.instanceId || row.identity_jkt !== identity.identityJkt) {
    fail('activation_operation_unavailable')
  }
  let payload: { activationCode: string; origin: string | null }
  try {
    payload = await readActivationOperationPayload(db, pendingKeyRoot, operationId)
    const reconstructed = buildActivationIntent({
      licenseId: row.license_id,
      activationCode: payload.activationCode,
      instanceId: row.instance_id,
      databaseId: row.database_id,
      identityJkt: row.identity_jkt,
      origin: payload.origin,
    })
    if (reconstructed.intentDigest !== row.intent_digest) fail('activation_operation_unavailable')
  } catch (error) {
    if (error instanceof LicenseChallengeClientError) throw error
    fail('activation_operation_unavailable')
  }
  return Object.freeze({
    operationId: row.operation_id,
    intentDigest: row.intent_digest,
    licenseId: row.license_id,
    databaseId: row.database_id,
    instanceId: row.instance_id,
    identityJkt: row.identity_jkt,
  })
}

export async function createSignedChallengeRequest(input: {
  origin: URL
  body: Buffer
  identity: { identityJkt: string; sign(message: Uint8Array): Buffer }
  clientNonce: string
  created: number
}): Promise<{ body: Buffer; headers: Record<string, string> }> {
  return createSignedLicenseRequest({
    origin: input.origin,
    path: LICENSE_CHALLENGE_PATH,
    body: input.body,
    identity: input.identity,
    nonce: input.clientNonce,
    created: input.created,
  })
}

export async function postChallenge(input: {
  origin: URL
  signed: { body: Buffer; headers: Record<string, string> }
  testTls?: TestLicenseTlsOptions
}): Promise<Buffer> {
  if (input.testTls !== undefined && process.env.NODE_ENV !== 'test') fail('test_transport_forbidden')
  if (input.origin.protocol !== 'https:' || input.origin.username || input.origin.password || input.origin.pathname !== '/' ||
    input.origin.search || input.origin.hash || input.signed.headers.host !== input.origin.host) {
    fail('challenge_target_invalid')
  }
  let response
  try {
    response = await postSignedLicenseRequest({
      origin: input.origin,
      path: LICENSE_CHALLENGE_PATH,
      signed: input.signed,
      ...(input.testTls === undefined ? {} : { testTls: input.testTls }),
    })
  } catch (error) {
    if (error instanceof LicenseHttpsRequestError && error.code === 'license_response_too_large') fail('challenge_response_too_large')
    if (error instanceof LicenseHttpsRequestError && error.code === 'license_response_invalid') fail('challenge_response_invalid')
    fail('challenge_transport_failed')
  }
  if (response.statusCode !== 201) fail('challenge_http_rejected')
  const contentType = response.headers['content-type']
  if (typeof contentType !== 'string' || contentType.split(';', 1)[0]!.trim().toLowerCase() !== 'application/json') {
    fail('challenge_response_invalid')
  }
  return response.body
}

function parseChallengeEnvelope(body: Buffer): string {
  let parsed: unknown
  try { parsed = parseStrictJson(body) } catch { return fail('challenge_response_invalid') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join(',') !== 'challenge') {
    return fail('challenge_response_invalid')
  }
  const token = (parsed as Record<string, unknown>).challenge
  if (typeof token !== 'string' || token.length < 100 || token.length > 16 * 1024) return fail('challenge_response_invalid')
  return token
}

export function assertChallengeClaimsBound(
  claims: Readonly<Record<string, unknown>>,
  operation: PendingActivationOperation,
  clientNonce: string,
  trustedTime: number,
): { readonly issuedAt: number; readonly expiresAt: number; readonly serverNonce: string } {
  if (claims.operation !== 'activation' || claims.operation_id !== operation.operationId ||
    claims.intent_digest !== operation.intentDigest || claims.instance_id !== operation.instanceId ||
    claims.identity_jkt !== operation.identityJkt || claims.client_nonce !== clientNonce ||
    claims.iat === undefined || typeof claims.iat !== 'number' || claims.exp === undefined || typeof claims.exp !== 'number' ||
    claims.iat > trustedTime || claims.exp <= trustedTime || claims.exp - claims.iat !== 300 ||
    typeof claims.server_nonce !== 'string') {
    return fail('challenge_binding_invalid')
  }
  assertCanonicalNonce(claims.server_nonce)
  return Object.freeze({ issuedAt: claims.iat, expiresAt: claims.exp, serverNonce: claims.server_nonce })
}

function verifyAndBindChallenge(
  evidence: VerifiedChallengeEvidence,
  operation: PendingActivationOperation,
  clientNonce: string,
  trustedTime: number,
  token: string,
): VerifiedBoundChallenge {
  const boundClaims = assertChallengeClaimsBound(evidence.claims, operation, clientNonce, trustedTime)
  return Object.freeze({
    [verifiedBoundChallengeBrand]: true as const,
    purpose: 'verified_bound_license_challenge',
    token,
    signingKeyId: evidence.signingKeyId,
    operation: 'activation',
    operationId: operation.operationId,
    intentDigest: operation.intentDigest,
    databaseId: operation.databaseId,
    instanceId: operation.instanceId,
    identityJkt: operation.identityJkt,
    clientNonce,
    serverNonce: boundClaims.serverNonce,
    issuedAt: boundClaims.issuedAt,
    expiresAt: boundClaims.expiresAt,
    signatureVerified: true,
    operationBound: true,
  })
}

export function createLicenseChallengeClient(options: LicenseChallengeClientOptions) {
  if (options.testTls !== undefined && process.env.NODE_ENV !== 'test') fail('test_transport_forbidden')
  const origin = assertTrustedOrigin(options.releaseConfig, options.trustStore)
  const testAnchorOptions = options.testTls === undefined ? {} : {
    ...(options.testTls.ca === undefined ? {} : { testCa: options.testTls.ca }),
    ...(options.testTls.lookup === undefined ? {} : { testLookup: options.testTls.lookup }),
  }

  const client = {
    async requestActivationChallengeWithTimeSample(operationId: string): Promise<VerifiedBoundChallengeWithTimeSample> {
      try {
        return await withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async (identity) => {
          const operation = await readPendingActivationOperation(options.db, options.pendingKeyRoot, operationId, identity)
          const candidate = await options.trustStore.getCandidateForTimeBootstrap()
          if (!candidate || candidate.claims.sub !== options.releaseConfig.expected_center_issuer) fail('trust_bundle_unavailable')
          const sample = await fetchTrustedTimeAnchor(options.releaseConfig, candidate, testAnchorOptions)
          const accepted = await options.trustStore.getAccepted(sample.readCurrentTrustedTime)
          const clientNonce = randomBytes(32).toString('base64url')
          assertCanonicalNonce(clientNonce)
          const created = sample.assertFresh()
          const requestBody = Buffer.from(JSON.stringify({
            operation: 'activation',
            operation_id: operation.operationId,
            intent_digest: operation.intentDigest,
            instance_id: operation.instanceId,
            public_jwk: identity.publicJwk,
            client_nonce: clientNonce,
          }), 'utf8')
          const signed = await createSignedChallengeRequest({
            origin,
            body: requestBody,
            identity,
            clientNonce,
            created,
          })
          sample.assertFresh()
          const responseBytes = await postChallenge({
            origin,
            signed,
            ...(options.testTls === undefined ? {} : { testTls: options.testTls }),
          })
          const token = parseChallengeEnvelope(responseBytes)
          // Verify the newly issued Challenge against a fresh signed sample acquired after its response.
          const verificationSample = await fetchTrustedTimeAnchor(options.releaseConfig, candidate, testAnchorOptions)
          const acceptedAtResponse = await options.trustStore.getAccepted(verificationSample.assertFresh)
          if (acceptedAtResponse.artifactSha256 !== accepted.artifactSha256) fail('trust_bundle_changed_during_challenge')
          const verified = await verifyLicenseChallenge(token, {
            resolver: acceptedAtResponse.resolver,
            issuer: options.releaseConfig.expected_center_issuer,
            trustedTime: verificationSample.assertFresh(),
          })
          const verifiedAt = verificationSample.assertFresh()
          const finalBundle = await options.trustStore.getAccepted(verifiedAt)
          if (finalBundle.artifactSha256 !== acceptedAtResponse.artifactSha256) fail('trust_bundle_changed_during_challenge')
          const bound = verifyAndBindChallenge(verified, operation, clientNonce, finalBundle.trustedTime, token)
          const operationAfterResponse = await readPendingActivationOperation(options.db, options.pendingKeyRoot, operationId, identity)
          if (operationAfterResponse.operationId !== operation.operationId || operationAfterResponse.intentDigest !== operation.intentDigest ||
            operationAfterResponse.databaseId !== operation.databaseId || operationAfterResponse.instanceId !== operation.instanceId ||
            operationAfterResponse.identityJkt !== operation.identityJkt) fail('challenge_binding_invalid')
          const finalIdentity = await withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async (current) => ({
            databaseId: current.databaseId,
            instanceId: current.instanceId,
            identityJkt: current.identityJkt,
          }))
          if (finalIdentity.databaseId !== operation.databaseId || finalIdentity.instanceId !== operation.instanceId ||
            finalIdentity.identityJkt !== operation.identityJkt) fail('challenge_binding_invalid')
          return Object.freeze({
            challenge: bound,
            timeSample: verificationSample,
            trustBundleDigest: finalBundle.artifactSha256,
          })
        })
      } catch (error) {
        if (error instanceof LicenseChallengeClientError) throw error
        fail('challenge_request_failed')
      }
    },
  }
  return Object.freeze({
    async requestActivationChallenge(operationId: string): Promise<VerifiedBoundChallenge> {
      return (await client.requestActivationChallengeWithTimeSample(operationId)).challenge
    },
    requestActivationChallengeWithTimeSample: client.requestActivationChallengeWithTimeSample,
  })
}
