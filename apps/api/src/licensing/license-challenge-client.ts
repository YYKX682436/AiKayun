import { createHash, randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { LookupFunction } from 'node:net'
import {
  genSingleRFC9530DigestHeader,
  signAsRFC9421ToRequestOrResponse,
} from '@misskey-dev/node-http-message-signatures'
import type { CustomSigningKey } from '@misskey-dev/node-http-message-signatures'
import { ByteSequence, parseDictionary, serializeDictionary } from 'structured-headers'
import type { Kysely } from 'kysely'
import type { Pool } from 'pg'
import type { Database } from '../db/types.js'
import { parseStrictJson } from './strict-json.js'
import { buildActivationIntent } from './license-intent.js'
import { readActivationOperationPayload } from './license-operation-store.js'
import { withVerifiedInstallationSigningContext } from './installation-identity.js'
import type { TrustedReleaseLicenseConfig } from './trusted-release-config.js'
import { verifyLicenseChallenge } from './trust/evidence.js'
import type { VerifiedChallengeEvidence } from './trust/evidence.js'
import { fetchTrustedTimeAnchor } from './trust/time-anchor-client.js'
import { TrustBundleStore } from './trust/trust-bundle-store.js'

const CHALLENGE_PATH = '/v1/challenges'
const REQUEST_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 16 * 1024
const SIGNED_COMPONENTS = ['@method', '@target-uri', 'content-type', 'content-digest'] as const
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

export interface LicenseChallengeClientOptions {
  readonly db: Kysely<Database>
  readonly pool: Pool
  readonly identityRoot: string
  readonly pendingKeyRoot: string
  readonly releaseConfig: TrustedReleaseLicenseConfig
  readonly trustStore: TrustBundleStore
  /** Only isolated HTTPS integration tests may override test DNS or CA roots. */
  readonly testTls?: { readonly ca?: string | Buffer; readonly lookup?: LookupFunction }
}

export interface PendingActivationOperation {
  readonly operationId: string
  readonly intentDigest: string
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

async function readPendingActivationOperation(
  db: Kysely<Database>,
  pendingKeyRoot: string,
  operationId: string,
  identity: { databaseId: string; instanceId: string; identityJkt: string },
): Promise<PendingActivationOperation> {
  const row = await db.selectFrom('local_license_operations')
    .select(['operation_id', 'kind', 'intent_digest', 'license_id', 'database_id', 'instance_id', 'identity_jkt', 'state', 'expected_generation'])
    .where('operation_id', '=', operationId)
    .executeTakeFirst()
  if (!row || row.kind !== 'activation' || row.state !== 'pending' || row.expected_generation !== null ||
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
  const bodyBytes = new Uint8Array(input.body.byteLength)
  bodyBytes.set(input.body)
  const digestEntries = await genSingleRFC9530DigestHeader(bodyBytes, 'SHA-256')
  const digestEntryGenerated = digestEntries[0]
  if (!digestEntryGenerated) fail('request_signing_failed')
  const [digestName, [digestBytes, digestParams]] = digestEntryGenerated
  const digestHeader = serializeDictionary(new Map([
    [digestName, [new ByteSequence(digestBytes.toBase64()), digestParams]],
  ]))
  const host = input.origin.host
  const signable = {
    method: 'POST',
    url: CHALLENGE_PATH,
    headers: { host, 'content-type': 'application/json', 'content-digest': digestHeader },
  }
  const signingKey: CustomSigningKey = {
    keyId: input.identity.identityJkt,
    algorithm: { name: 'Ed25519' },
    signatureAlgorithm: 'ed25519',
    signer: async ({ signingString }) => input.identity.sign(Buffer.from(signingString, 'utf8')),
  }
  const signed = await signAsRFC9421ToRequestOrResponse(signable, {
    sig1: {
      key: signingKey,
      identifiers: [...SIGNED_COMPONENTS],
      created: input.created,
      expiresAfter: 60,
      nonce: input.clientNonce,
      tag: 'aikayun-license-v1',
    },
  }, { scheme: 'https' })
  let signatureInput: ReturnType<typeof parseDictionary>
  let signatureDictionary: ReturnType<typeof parseDictionary>
  let contentDigest: ReturnType<typeof parseDictionary>
  try {
    signatureInput = parseDictionary(signed.inputHeader)
    signatureDictionary = parseDictionary(signed.signatureHeader)
    contentDigest = parseDictionary(digestHeader)
  } catch {
    return fail('request_signing_failed')
  }
  const signatureInputEntry = signatureInput.get('sig1')
  const signatureEntry = signatureDictionary.get('sig1')
  const digestEntry = contentDigest.get('sha-256')
  if (signatureInput.size !== 1 || !signatureInputEntry || !Array.isArray(signatureInputEntry) ||
    signatureDictionary.size !== 1 || !signatureEntry || !Array.isArray(signatureEntry) ||
    signatureEntry[1].size !== 0 || !(signatureEntry[0] instanceof ByteSequence) ||
    contentDigest.size !== 1 || !digestEntry || !Array.isArray(digestEntry) || !(digestEntry[0] instanceof ByteSequence) || digestEntry[1].size !== 0) {
    return fail('request_signing_failed')
  }
  const [components, params] = signatureInputEntry
  const componentNames = Array.isArray(components)
    ? components.map((entry) => Array.isArray(entry) ? entry[0] : entry)
    : []
  const expectedParamNames = ['alg', 'created', 'expires', 'keyid', 'nonce', 'tag']
  if (componentNames.length !== SIGNED_COMPONENTS.length || componentNames.some((name, index) => name !== SIGNED_COMPONENTS[index]) ||
    [...params.keys()].sort().join(',') !== expectedParamNames.join(',') || params.get('created') !== input.created ||
    params.get('expires') !== input.created + 60 || params.get('nonce') !== input.clientNonce ||
    params.get('keyid') !== input.identity.identityJkt || params.get('alg') !== 'ed25519' || params.get('tag') !== 'aikayun-license-v1') {
    return fail('request_signing_failed')
  }
  const expectedDigest = createHash('sha256').update(input.body).digest('base64')
  if (digestEntry[0].toBase64() !== expectedDigest) return fail('request_signing_failed')
  return {
    body: input.body,
    headers: {
      host,
      accept: 'application/json',
      'content-type': 'application/json',
      'content-digest': digestHeader,
      'signature-input': signed.inputHeader,
      signature: signed.signatureHeader,
      'content-length': String(input.body.byteLength),
      connection: 'close',
    },
  }
}

function readBoundedResponse(response: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    response.on('data', (chunk: Buffer | Uint8Array | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        response.destroy()
        rejectOnce(new Error('response_limit'))
        return
      }
      chunks.push(bytes)
    })
    response.once('aborted', () => rejectOnce(new Error('response_aborted')))
    response.once('error', rejectOnce)
    response.once('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks, size))
    })
  })
}

export async function postChallenge(input: {
  origin: URL
  signed: { body: Buffer; headers: Record<string, string> }
  testTls?: { ca?: string | Buffer; lookup?: LookupFunction }
}): Promise<Buffer> {
  if (input.testTls !== undefined && process.env.NODE_ENV !== 'test') fail('test_transport_forbidden')
  if (input.origin.protocol !== 'https:' || input.origin.username || input.origin.password || input.origin.pathname !== '/' ||
    input.origin.search || input.origin.hash || input.signed.headers.host !== input.origin.host) {
    fail('challenge_target_invalid')
  }
  const requestOptions = {
    protocol: 'https:' as const,
    hostname: input.origin.hostname,
    port: input.origin.port ? Number(input.origin.port) : 443,
    path: CHALLENGE_PATH,
    method: 'POST' as const,
    agent: false as const,
    rejectUnauthorized: true as const,
    servername: input.origin.hostname,
    headers: input.signed.headers,
    maxHeaderSize: 8 * 1024,
    ...(input.testTls?.ca === undefined ? {} : { ca: input.testTls.ca }),
    ...(input.testTls?.lookup === undefined ? {} : { lookup: input.testTls.lookup }),
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const rejectOnce = (code: string) => {
      if (settled) return
      settled = true
      reject(new LicenseChallengeClientError(code))
    }
    const request = httpsRequest(requestOptions, async (response) => {
      try {
        if (response.statusCode !== 201) {
          response.destroy()
          rejectOnce('challenge_http_rejected')
          return
        }
        const contentType = response.headers['content-type']
        if (typeof contentType !== 'string' || contentType.split(';', 1)[0]!.trim().toLowerCase() !== 'application/json') {
          response.destroy()
          rejectOnce('challenge_response_invalid')
          return
        }
        const contentLength = response.headers['content-length']
        if (contentLength !== undefined && (typeof contentLength !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(contentLength) ||
          Number(contentLength) > MAX_RESPONSE_BYTES)) {
          response.destroy()
          rejectOnce('challenge_response_too_large')
          return
        }
        const body = await readBoundedResponse(response)
        if (!settled) {
          settled = true
          resolve(body)
        }
      } catch {
        rejectOnce('challenge_response_invalid')
      }
    })
    const timeout = setTimeout(() => request.destroy(new Error('timeout')), REQUEST_TIMEOUT_MS)
    timeout.unref()
    request.once('close', () => clearTimeout(timeout))
    request.once('error', () => rejectOnce('challenge_transport_failed'))
    request.end(input.signed.body)
  })
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

  return Object.freeze({
    async requestActivationChallenge(operationId: string): Promise<VerifiedBoundChallenge> {
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
          const acceptedAtResponse = await options.trustStore.getAccepted(sample.assertFresh)
          if (acceptedAtResponse.artifactSha256 !== accepted.artifactSha256) fail('trust_bundle_changed_during_challenge')
          const verified = await verifyLicenseChallenge(token, {
            resolver: acceptedAtResponse.resolver,
            issuer: options.releaseConfig.expected_center_issuer,
            trustedTime: acceptedAtResponse.trustedTime,
          })
          const verifiedAt = sample.assertFresh()
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
          return bound
        })
      } catch (error) {
        if (error instanceof LicenseChallengeClientError) throw error
        fail('challenge_request_failed')
      }
    },
  })
}
