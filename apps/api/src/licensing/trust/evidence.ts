import { assertExactClaims, assertIntegerClaim, assertStringClaim, verifyTypedJwtWithResolver } from '../crypto/jwt.js'
import type { TrustedSigningKeyResolver, VerifiedJwt } from '../crypto/jwt.js'
import type { InstallationIdentitySnapshot } from '../installation-identity.js'

const AUDIENCE = 'aikayun-commerce'
const LEASE_TYP = 'aikayun-license+jwt'
const STATUS_TYP = 'aikayun-license-status+jwt'
const OPERATION_TYP = 'aikayun-license-operation+jwt'
const CHALLENGE_TYP = 'aikayun-license-challenge+jwt'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST = /^[A-Za-z0-9_-]{43}$/
const DECIMAL = /^[1-9][0-9]{0,18}$/

const LEASE_CLAIMS = [
  'v', 'iss', 'aud', 'sub', 'jti', 'iat', 'nbf', 'exp', 'instance_id', 'database_id', 'identity_jkt',
  'activation_generation', 'entitlement_revision', 'plan', 'subscription_end', 'renew_after', 'grants',
  'request_nonce', 'request_digest',
] as const
const STATUS_CLAIMS = [
  'v', 'iss', 'aud', 'sub', 'jti', 'iat', 'nbf', 'exp', 'instance_id', 'identity_jkt',
  'activation_generation', 'current_generation', 'entitlement_revision', 'subscription_end', 'status',
  'request_nonce', 'request_digest',
] as const
const OPERATION_CLAIMS = [
  'v', 'iss', 'aud', 'sub', 'jti', 'iat', 'nbf', 'exp', 'actor_jkt', 'operation_id', 'intent_digest',
  'state', 'outcome_code', 'attempt_no', 'request_nonce_hash', 'request_digest', 'committed_attempt_no',
  'committed_request_nonce_hash', 'committed_request_digest', 'result_jws',
] as const
const CHALLENGE_CLAIMS = [
  'v', 'iss', 'aud', 'sub', 'jti', 'iat', 'nbf', 'exp', 'operation', 'operation_id', 'intent_digest',
  'instance_id', 'identity_jkt', 'client_nonce', 'server_nonce',
] as const

export interface VerifiedCurrentLeaseEvidence {
  readonly purpose: 'current_license_lease'
  readonly tokenId: string
  readonly signingKeyId: string
  readonly licenseId: string
  readonly instanceId: string
  readonly databaseId: string
  readonly identityJkt: string
  readonly activationGeneration: string
  readonly entitlementRevision: string
  readonly issuedAt: number
  readonly renewAfter: number
  readonly expiresAt: number
  readonly subscriptionEnd: number
  readonly grants: readonly ['create_order', 'create_top_up']
  readonly signatureVerified: true
}

export interface VerifiedHistoricalLeaseEvidence {
  readonly purpose: 'expired_historical_lease'
  readonly tokenId: string
  readonly licenseId: string
  readonly instanceId: string
  readonly databaseId: string
  readonly identityJkt: string
  readonly activationGeneration: string
  readonly entitlementRevision: string
  readonly issuedAt: number
  readonly expiredAt: number
  readonly verifiedAt: number
  readonly signatureVerified: true
  readonly grants: readonly ['create_order', 'create_top_up']
}

export interface VerifiedStatusEvidence {
  readonly purpose: 'license_status_receipt'
  readonly claims: Readonly<Record<string, unknown>>
  readonly signatureVerified: true
}

export interface VerifiedOperationEvidence {
  readonly purpose: 'license_operation_receipt'
  readonly claims: Readonly<Record<string, unknown>>
  readonly signatureVerified: true
}

export interface VerifiedChallengeEvidence {
  readonly purpose: 'license_challenge'
  readonly signingKeyId: string
  readonly claims: Readonly<Record<string, unknown>>
  readonly signatureVerified: true
}

function assertUuid(value: unknown, name: string): string {
  const text = assertStringClaim({ value }, 'value', 36)
  if (!UUID.test(text)) throw new Error(`Invalid ${name}`)
  return text
}

function assertDigest(value: unknown, name: string): string {
  const text = assertStringClaim({ value }, 'value', 64)
  if (!DIGEST.test(text) || Buffer.from(text, 'base64url').byteLength !== 32 || Buffer.from(text, 'base64url').toString('base64url') !== text) {
    throw new Error(`Invalid ${name}`)
  }
  return text
}

function assertDecimal(value: unknown, name: string): string {
  const text = assertStringClaim({ value }, 'value', 19)
  if (!DECIMAL.test(text)) throw new Error(`Invalid ${name}`)
  return text
}

async function verifyPurpose(
  token: unknown,
  input: { resolver: TrustedSigningKeyResolver; issuer: string; trustedTime: number; typ: string; claims: readonly string[]; allowExpired?: boolean },
): Promise<VerifiedJwt> {
  if (!Number.isSafeInteger(input.trustedTime) || input.trustedTime <= 0) throw new Error('Invalid trusted verification time')
  const verified = await verifyTypedJwtWithResolver(token, {
    resolver: input.resolver,
    issuer: input.issuer,
    audience: AUDIENCE,
    typ: input.typ,
    requiredClaims: input.claims,
    now: new Date(input.trustedTime * 1000),
    ...(input.allowExpired ? { allowExpired: true } : {}),
  })
  assertExactClaims(verified.claims, input.claims)
  const iat = assertIntegerClaim(verified.claims, 'iat', 1)
  const nbf = assertIntegerClaim(verified.claims, 'nbf', 1)
  const exp = assertIntegerClaim(verified.claims, 'exp', 1)
  if (nbf !== iat || exp <= iat) throw new Error('Invalid signed token time bounds')
  return verified
}

function validateLeaseClaims(claims: Record<string, unknown>, trustedTime: number): {
  tokenId: string; licenseId: string; instanceId: string; databaseId: string; identityJkt: string;
  activationGeneration: string; entitlementRevision: string; issuedAt: number; renewAfter: number;
  expiresAt: number; subscriptionEnd: number;
} {
  const iat = assertIntegerClaim(claims, 'iat', 1)
  const exp = assertIntegerClaim(claims, 'exp', 1)
  if (iat > trustedTime || assertIntegerClaim(claims, 'v') !== 1 || claims.aud !== AUDIENCE ||
    !['monthly', 'yearly'].includes(String(claims.plan))) throw new Error('Invalid license lease profile')
  const subscriptionEnd = assertIntegerClaim(claims, 'subscription_end', 1)
  const renewAfter = assertIntegerClaim(claims, 'renew_after', 1)
  if (subscriptionEnd <= iat || exp !== Math.min(iat + 7 * 24 * 60 * 60, subscriptionEnd) ||
    renewAfter !== Math.min(iat + 6 * 60 * 60, exp)) throw new Error('Invalid license lease expiry or renewal boundary')
  if (!Array.isArray(claims.grants) || claims.grants.length !== 2 || claims.grants[0] !== 'create_order' || claims.grants[1] !== 'create_top_up') {
    throw new Error('Invalid license lease grants')
  }
  assertDigest(claims.request_nonce, 'lease request nonce')
  assertDigest(claims.request_digest, 'lease request digest')
  return {
    tokenId: assertUuid(claims.jti, 'lease id'),
    licenseId: assertUuid(claims.sub, 'license id'),
    instanceId: assertUuid(claims.instance_id, 'instance id'),
    databaseId: assertUuid(claims.database_id, 'database id'),
    identityJkt: assertDigest(claims.identity_jkt, 'identity JKT'),
    activationGeneration: assertDecimal(claims.activation_generation, 'activation generation'),
    entitlementRevision: assertDecimal(claims.entitlement_revision, 'entitlement revision'),
    issuedAt: iat,
    renewAfter,
    expiresAt: exp,
    subscriptionEnd,
  }
}

function assertMatchesInstallation(
  lease: ReturnType<typeof validateLeaseClaims>,
  identity: InstallationIdentitySnapshot,
): void {
  if (identity.status !== 'ready' || identity.bindingState !== 'ready' || !identity.databaseId || !identity.instanceId || !identity.identityJkt ||
    lease.databaseId !== identity.databaseId || lease.instanceId !== identity.instanceId || lease.identityJkt !== identity.identityJkt) {
    throw new Error('Lease installation binding does not match a ready local identity')
  }
}

export async function verifyCurrentLicenseLease(
  token: unknown,
  input: { resolver: TrustedSigningKeyResolver; issuer: string; trustedTime: number; identity: InstallationIdentitySnapshot },
): Promise<VerifiedCurrentLeaseEvidence> {
  const verified = await verifyPurpose(token, { ...input, typ: LEASE_TYP, claims: LEASE_CLAIMS })
  const lease = validateLeaseClaims(verified.claims, input.trustedTime)
  assertMatchesInstallation(lease, input.identity)
  if (lease.expiresAt <= input.trustedTime) throw new Error('Current lease has expired')
  return Object.freeze({
    purpose: 'current_license_lease',
    ...lease,
    signingKeyId: assertStringClaim(verified.header, 'kid', 43),
    grants: Object.freeze(['create_order', 'create_top_up']) as readonly ['create_order', 'create_top_up'],
    signatureVerified: true,
  })
}

/** Historical evidence never grants current commerce permissions. It still requires a currently retained, non-revoked key. */
export async function verifyExpiredHistoricalLease(
  token: unknown,
  input: { resolver: TrustedSigningKeyResolver; issuer: string; trustedTime: number; identity: InstallationIdentitySnapshot },
): Promise<VerifiedHistoricalLeaseEvidence> {
  const verified = await verifyPurpose(token, { ...input, typ: LEASE_TYP, claims: LEASE_CLAIMS, allowExpired: true })
  const lease = validateLeaseClaims(verified.claims, input.trustedTime)
  assertMatchesInstallation(lease, input.identity)
  if (lease.expiresAt > input.trustedTime) throw new Error('Historical lease has not expired')
  return Object.freeze({
    purpose: 'expired_historical_lease',
    tokenId: lease.tokenId,
    licenseId: lease.licenseId,
    instanceId: lease.instanceId,
    databaseId: lease.databaseId,
    identityJkt: lease.identityJkt,
    activationGeneration: lease.activationGeneration,
    entitlementRevision: lease.entitlementRevision,
    issuedAt: lease.issuedAt,
    expiredAt: lease.expiresAt,
    verifiedAt: input.trustedTime,
    signatureVerified: true,
    grants: Object.freeze(['create_order', 'create_top_up']) as readonly ['create_order', 'create_top_up'],
  })
}

export async function verifyLicenseStatusReceipt(
  token: unknown,
  input: { resolver: TrustedSigningKeyResolver; issuer: string; trustedTime: number },
): Promise<VerifiedStatusEvidence> {
  const verified = await verifyPurpose(token, { ...input, typ: STATUS_TYP, claims: STATUS_CLAIMS })
  const claims = verified.claims
  const iat = assertIntegerClaim(claims, 'iat', 1)
  if (assertIntegerClaim(claims, 'v') !== 1 || claims.aud !== AUDIENCE ||
    !['expired', 'revoked', 'superseded'].includes(String(claims.status)) ||
    assertIntegerClaim(claims, 'exp', 1) !== iat + 5 * 60) throw new Error('Invalid license status receipt')
  assertUuid(claims.sub, 'license id')
  assertUuid(claims.jti, 'status receipt id')
  assertUuid(claims.instance_id, 'instance id')
  assertDigest(claims.identity_jkt, 'identity JKT')
  assertDecimal(claims.activation_generation, 'activation generation')
  assertDecimal(claims.current_generation, 'current generation')
  assertDecimal(claims.entitlement_revision, 'entitlement revision')
  assertIntegerClaim(claims, 'subscription_end', 1)
  assertDigest(claims.request_nonce, 'request nonce')
  assertDigest(claims.request_digest, 'request digest')
  return Object.freeze({ purpose: 'license_status_receipt', claims: Object.freeze({ ...claims }), signatureVerified: true })
}

const challengeOperations = [
  'activation', 'renewal', 'recovery', 'query', 'continue', 'transfer_prepare', 'transfer_commit',
  'disaster_transfer_prepare', 'disaster_transfer_commit', 'time_reset',
] as const

export async function verifyLicenseChallenge(
  token: unknown,
  input: { resolver: TrustedSigningKeyResolver; issuer: string; trustedTime: number },
): Promise<VerifiedChallengeEvidence> {
  const verified = await verifyPurpose(token, { ...input, typ: CHALLENGE_TYP, claims: CHALLENGE_CLAIMS })
  const claims = verified.claims
  const iat = assertIntegerClaim(claims, 'iat', 1)
  if (assertIntegerClaim(claims, 'v') !== 1 || claims.aud !== AUDIENCE || assertIntegerClaim(claims, 'exp', 1) !== iat + 5 * 60 ||
    !challengeOperations.includes(claims.operation as typeof challengeOperations[number])) throw new Error('Invalid license challenge')
  const instanceId = assertUuid(claims.instance_id, 'instance id')
  if (assertUuid(claims.sub, 'subject') !== instanceId) throw new Error('Challenge subject does not match its instance')
  assertUuid(claims.jti, 'challenge id')
  assertUuid(claims.operation_id, 'operation id')
  assertDigest(claims.intent_digest, 'intent digest')
  assertDigest(claims.identity_jkt, 'identity JKT')
  assertDigest(claims.client_nonce, 'client nonce')
  assertDigest(claims.server_nonce, 'server nonce')
  return Object.freeze({
    purpose: 'license_challenge',
    signingKeyId: assertStringClaim(verified.header, 'kid', 43),
    claims: Object.freeze({ ...claims }),
    signatureVerified: true,
  })
}

export async function verifyLicenseOperationReceipt(
  token: unknown,
  input: { resolver: TrustedSigningKeyResolver; issuer: string; trustedTime: number },
): Promise<VerifiedOperationEvidence> {
  const verified = await verifyPurpose(token, { ...input, typ: OPERATION_TYP, claims: OPERATION_CLAIMS })
  const claims = verified.claims
  const iat = assertIntegerClaim(claims, 'iat', 1)
  if (assertIntegerClaim(claims, 'v') !== 1 || claims.aud !== AUDIENCE || assertIntegerClaim(claims, 'exp', 1) !== iat + 5 * 60 ||
    !['not_found', 'committed', 'rejected', 'cancelled'].includes(String(claims.state))) throw new Error('Invalid license operation receipt')
  assertUuid(claims.sub, 'license id')
  assertUuid(claims.jti, 'operation receipt id')
  assertDigest(claims.actor_jkt, 'operation actor JKT')
  assertUuid(claims.operation_id, 'operation id')
  assertDigest(claims.intent_digest, 'intent digest')
  assertIntegerClaim(claims, 'attempt_no', 1)
  assertDigest(claims.request_nonce_hash, 'request nonce hash')
  assertDigest(claims.request_digest, 'request digest')
  const outcome = claims.outcome_code
  if (outcome !== null && (typeof outcome !== 'string' || outcome.length < 1 || outcome.length > 128)) throw new Error('Invalid operation outcome code')
  const committedAttempt = claims.committed_attempt_no
  if (committedAttempt !== null && (typeof committedAttempt !== 'number' || !Number.isSafeInteger(committedAttempt) || committedAttempt < 1)) {
    throw new Error('Invalid committed operation attempt')
  }
  for (const name of ['committed_request_nonce_hash', 'committed_request_digest']) {
    if (claims[name] !== null) assertDigest(claims[name], name)
  }
  const result = claims.result_jws
  if (result !== null && (typeof result !== 'string' || result.length > 16 * 1024 || result.split('.').length !== 3)) {
    throw new Error('Invalid operation result JWS envelope')
  }
  return Object.freeze({ purpose: 'license_operation_receipt', claims: Object.freeze({ ...claims }), signatureVerified: true })
}
