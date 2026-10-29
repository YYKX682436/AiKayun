import { randomBytes } from 'node:crypto'
import { assertExactClaims, assertIntegerClaim, assertStringClaim, verifyTypedJwtWithKey } from './jwt.js'
import { parseStrictJsonSegment } from '../strict-json.js'
import {
  assertTrustBundleValidAt,
  getRootAuthenticatedCandidateKey,
  type RootAuthenticatedTrustBundleCandidate,
} from '../trust/trust-bundle.js'

export const TIME_ANCHOR_TYP = 'aikayun-time-anchor+jwt'
export const TIME_ANCHOR_AUDIENCE = 'aikayun-time-bootstrap'
export const MAX_TIME_ANCHOR_RTT_MS = 5_000
const MAX_TOKEN_BYTES = 16 * 1024
const HEADER_FIELDS = ['alg', 'kid', 'typ'] as const
const CLAIM_FIELDS = ['v', 'iss', 'aud', 'sub', 'jti', 'iat', 'nbf', 'exp', 'server_time', 'client_nonce'] as const
const noncePattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isCanonicalNonce(value: unknown): value is string {
  return typeof value === 'string' && noncePattern.test(value) && Buffer.from(value, 'base64url').byteLength === 32 &&
    Buffer.from(value, 'base64url').toString('base64url') === value
}

function parseAnchorHeader(token: unknown): { kid: string; payload: Record<string, unknown> } {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) throw new Error('Time-anchor JWS exceeds size limit')
  const segments = token.split('.')
  if (segments.length !== 3 || !segments.every((segment) => segment.length > 0)) throw new Error('Invalid compact time-anchor JWS')
  const header = parseStrictJsonSegment(segments[0]!)
  const payload = parseStrictJsonSegment(segments[1]!)
  const signature = segments[2]!
  if (Object.keys(header).sort().join('\n') !== [...HEADER_FIELDS].sort().join('\n') || header.alg !== 'Ed25519' ||
    header.typ !== TIME_ANCHOR_TYP || typeof header.kid !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(signature) || Buffer.from(signature, 'base64url').byteLength !== 64 ||
    Buffer.from(signature, 'base64url').toString('base64url') !== signature) {
    throw new Error('Unexpected time-anchor protected header or signature encoding')
  }
  return { kid: header.kid, payload }
}

export interface VerifiedTimeAnchor {
  tokenId: string
  serverTime: number
  expiresAt: number
  clientNonce: string
  keyId: string
}

/** Candidate-only validation path: a root-authenticated key may bootstrap time, but grants no license trust. */
export async function verifyTimeAnchorWithTrustBundleCandidate(
  token: unknown,
  input: { candidate: RootAuthenticatedTrustBundleCandidate; clientNonce: string; roundTripMs: number },
): Promise<VerifiedTimeAnchor> {
  if (typeof input.roundTripMs !== 'number' || !Number.isFinite(input.roundTripMs) || input.roundTripMs < 0 ||
    input.roundTripMs > MAX_TIME_ANCHOR_RTT_MS || !isCanonicalNonce(input.clientNonce)) {
    throw new Error('Time-anchor sample is not fresh')
  }
  const { kid, payload } = parseAnchorHeader(token)
  const serverTimeValue = payload.server_time
  if (typeof serverTimeValue !== 'number' || !Number.isSafeInteger(serverTimeValue) || serverTimeValue <= 0) throw new Error('Invalid time-anchor server time')
  const selected = getRootAuthenticatedCandidateKey(input.candidate, kid)
  if (selected.record.revoked_at !== null) throw new Error('A revoked key cannot bootstrap trusted time')
  const verified = await verifyTypedJwtWithKey(token, {
    publicKey: selected.publicKey,
    keyId: kid,
    issuer: input.candidate.claims.sub,
    audience: TIME_ANCHOR_AUDIENCE,
    typ: TIME_ANCHOR_TYP,
    requiredClaims: CLAIM_FIELDS,
    now: new Date(serverTimeValue * 1000),
  })
  assertTrustBundleValidAt(input.candidate, serverTimeValue)
  const claims = verified.claims
  assertExactClaims(claims, CLAIM_FIELDS)
  const iat = assertIntegerClaim(claims, 'iat', 1)
  const nbf = assertIntegerClaim(claims, 'nbf', 1)
  const exp = assertIntegerClaim(claims, 'exp', 1)
  const serverTime = assertIntegerClaim(claims, 'server_time', 1)
  const tokenId = assertStringClaim(claims, 'jti', 36)
  const nonce = assertStringClaim(claims, 'client_nonce', 128)
  if (verified.header.alg !== 'Ed25519' || verified.header.typ !== TIME_ANCHOR_TYP || verified.header.kid !== kid ||
    assertIntegerClaim(claims, 'v') !== 1 || claims.iss !== input.candidate.claims.sub || claims.aud !== TIME_ANCHOR_AUDIENCE ||
    claims.sub !== 'license-center-time' || iat !== serverTime || nbf !== serverTime || exp !== serverTime + 30 ||
    serverTime !== serverTimeValue || nonce !== input.clientNonce || !isCanonicalNonce(nonce) || !uuidPattern.test(tokenId)) {
    throw new Error('Time-anchor claims do not match the nonce-bound bootstrap profile')
  }
  const key = selected.record
  if (iat < key.not_before || (key.retire_after !== null && iat >= key.retire_after) ||
    (key.verify_until !== null && (serverTime >= key.verify_until || exp > key.verify_until))) {
    throw new Error('Time anchor is outside the root-authenticated key lifecycle')
  }
  return { tokenId, serverTime, expiresAt: exp, clientNonce: nonce, keyId: kid }
}

export function createTimeAnchorNonce(): string {
  return randomBytes(32).toString('base64url')
}
