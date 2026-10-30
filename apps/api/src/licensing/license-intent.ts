import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'

export interface ActivationIntentInput {
  licenseId: string
  activationCode: string
  instanceId: string
  databaseId: string
  identityJkt: string
  origin: string | null
}

export class LicenseIntentError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'LicenseIntentError'
  }
}

export function sha256Base64url(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('base64url')
}

export function ed25519IdentityJkt(publicJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string }): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(publicJwk.x)) throw new LicenseIntentError('invalid_identity_jwk')
  const x = Buffer.from(publicJwk.x, 'base64url')
  if (x.length !== 32 || x.toString('base64url') !== publicJwk.x) throw new LicenseIntentError('invalid_identity_jwk')
  const canonicalJwk = canonicalize({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x })
  if (typeof canonicalJwk !== 'string') throw new LicenseIntentError('identity_jwk_canonicalization_failed')
  return sha256Base64url(canonicalJwk)
}

export function activationCodeSha256(activationCode: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(activationCode)) {
    throw new LicenseIntentError('invalid_activation_code')
  }
  const decoded = Buffer.from(activationCode, 'base64url')
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== activationCode) {
    throw new LicenseIntentError('invalid_activation_code')
  }
  return sha256Base64url(activationCode)
}

function assertCenterActivationOrigin(origin: string | null): void {
  if (origin === null) return
  let parsed: URL
  try { parsed = new URL(origin) } catch { throw new LicenseIntentError('invalid_activation_origin') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' ||
    parsed.search || parsed.hash || origin !== parsed.origin) {
    throw new LicenseIntentError('invalid_activation_origin')
  }
}

/** Matches the authorization center's activationIntentDigest() v1 field-for-field. */
export function buildActivationIntent(input: ActivationIntentInput): {
  intentDigest: string
  activationCodeSha256: string
  canonicalIntent: string
} {
  assertCenterActivationOrigin(input.origin)
  const activationCodeHash = activationCodeSha256(input.activationCode)
  const intent = {
    v: 1,
    kind: 'activation',
    license_id: input.licenseId,
    activation_code_sha256: activationCodeHash,
    instance_id: input.instanceId,
    database_id: input.databaseId,
    identity_jkt: input.identityJkt,
    origin: input.origin,
  }
  const canonicalIntent = canonicalize(intent)
  if (typeof canonicalIntent !== 'string') throw new LicenseIntentError('activation_intent_canonicalization_failed')
  return { intentDigest: sha256Base64url(canonicalIntent), activationCodeSha256: activationCodeHash, canonicalIntent }
}
