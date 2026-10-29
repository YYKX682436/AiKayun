import { calculateJwkThumbprint } from 'jose'
import { generatedTrustedReleaseLicenseConfig } from './trusted-release-license-config.generated.js'
import { assertMinimumBundleVersion, type Ed25519PublicJwk, type TrustedOfflineRootPin } from './trust/trust-bundle.js'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digestPattern = /^[A-Za-z0-9_-]{43}$/

export interface TrustedReleaseLicenseConfigInput {
  schema_version: 1
  trust_configuration_id: string
  release_id: string
  release_manifest_sha256: string
  expected_center_issuer: string
  expected_center_origin: string
  offline_root: TrustedOfflineRootPin
  minimum_bundle_version: string
}

declare const trustedReleaseConfigBrand: unique symbol
export type TrustedReleaseLicenseConfig = Readonly<TrustedReleaseLicenseConfigInput> & {
  readonly [trustedReleaseConfigBrand]: true
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(value).sort().join('\n') !== [...expected].sort().join('\n')) throw new Error(`Unexpected ${label} fields`)
}

function exactHttpsOrigin(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 256) throw new Error(`Invalid ${label}`)
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error(`Invalid ${label}`) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || value !== parsed.origin) {
    throw new Error(`${label} must be an exact HTTPS origin`)
  }
  return value
}

export async function validateTrustedReleaseLicenseConfig(value: unknown): Promise<TrustedReleaseLicenseConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Trusted release license config must be an object')
  const input = value as Record<string, unknown>
  exactKeys(input, [
    'schema_version', 'trust_configuration_id', 'release_id', 'release_manifest_sha256',
    'expected_center_issuer', 'expected_center_origin', 'offline_root', 'minimum_bundle_version',
  ], 'trusted release license config')
  if (input.schema_version !== 1 || typeof input.trust_configuration_id !== 'string' || !uuidPattern.test(input.trust_configuration_id) ||
    typeof input.release_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(input.release_id) ||
    typeof input.release_manifest_sha256 !== 'string' || !digestPattern.test(input.release_manifest_sha256)) {
    throw new Error('Invalid trusted release identity')
  }
  const issuer = exactHttpsOrigin(input.expected_center_issuer, 'expected center issuer')
  const origin = exactHttpsOrigin(input.expected_center_origin, 'expected center origin')
  if (issuer !== origin) throw new Error('Trusted center issuer and time-anchor origin must be identical')
  if (!input.offline_root || typeof input.offline_root !== 'object' || Array.isArray(input.offline_root)) throw new Error('Invalid offline root pin')
  const rootInput = input.offline_root as Record<string, unknown>
  exactKeys(rootInput, ['kid', 'publicJwk'], 'offline root pin')
  if (!rootInput.publicJwk || typeof rootInput.publicJwk !== 'object' || Array.isArray(rootInput.publicJwk)) throw new Error('Invalid offline root JWK')
  const jwkInput = rootInput.publicJwk as Record<string, unknown>
  exactKeys(jwkInput, ['kty', 'crv', 'x'], 'offline root JWK')
  if (jwkInput.kty !== 'OKP' || jwkInput.crv !== 'Ed25519' || typeof jwkInput.x !== 'string' || !digestPattern.test(jwkInput.x) ||
    Buffer.from(jwkInput.x, 'base64url').byteLength !== 32 || Buffer.from(jwkInput.x, 'base64url').toString('base64url') !== jwkInput.x) {
    throw new Error('Offline root must be a canonical public Ed25519 JWK')
  }
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: jwkInput.x }
  const rootKid = await calculateJwkThumbprint(publicJwk, 'sha256')
  if (rootInput.kid !== rootKid) throw new Error('Offline root JKT does not match its public JWK')
  const minimumBundleVersion = assertMinimumBundleVersion(input.minimum_bundle_version)
  return Object.freeze({
    schema_version: 1,
    trust_configuration_id: input.trust_configuration_id,
    release_id: input.release_id,
    release_manifest_sha256: input.release_manifest_sha256,
    expected_center_issuer: issuer,
    expected_center_origin: origin,
    offline_root: Object.freeze({ kid: rootKid, publicJwk: Object.freeze(publicJwk) }),
    minimum_bundle_version: minimumBundleVersion,
  }) as TrustedReleaseLicenseConfig
}

export async function loadEmbeddedTrustedReleaseLicenseConfig(): Promise<TrustedReleaseLicenseConfig | null> {
  if (generatedTrustedReleaseLicenseConfig === null) return null
  return validateTrustedReleaseLicenseConfig(generatedTrustedReleaseLicenseConfig)
}
