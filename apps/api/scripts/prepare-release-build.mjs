import { mkdir, writeFile } from 'node:fs/promises'
import { calculateJwkThumbprint, importJWK } from 'jose'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const releaseId = process.env.AIKAYUN_RELEASE_ID ?? 'local-development'
const version = process.env.AIKAYUN_RELEASE_VERSION ?? '0.0.0-dev'
const configBase64 = process.env.AIKAYUN_TRUSTED_LICENSE_CONFIG_BASE64 ?? ''
const requireConfig = process.env.AIKAYUN_REQUIRE_LICENSE_CONFIG === 'true'

if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(releaseId)) throw new Error('Invalid immutable release ID')
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  throw new Error('Release version must be a canonical SemVer without build metadata')
}

let config = null
if (configBase64) {
  const decoded = Buffer.from(configBase64, 'base64')
  if (decoded.length === 0 || decoded.length > 16 * 1024 || decoded.toString('base64') !== configBase64) {
    throw new Error('Trusted release configuration must be canonical base64 JSON under 16 KiB')
  }
  config = JSON.parse(decoded.toString('utf8'))
  const keys = ['schema_version', 'trust_configuration_id', 'release_id', 'expected_center_issuer',
    'expected_center_origin', 'offline_root', 'minimum_bundle_version'].sort().join(',')
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).sort().join(',') !== keys ||
    config.schema_version !== 1 || config.release_id !== releaseId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(config.trust_configuration_id) ||
    typeof config.minimum_bundle_version !== 'string' || !/^[1-9][0-9]{0,18}$/.test(config.minimum_bundle_version)) {
    throw new Error('Trusted release configuration identity or schema is invalid')
  }
  const issuer = new URL(config.expected_center_issuer)
  const origin = new URL(config.expected_center_origin)
  if (issuer.protocol !== 'https:' || origin.protocol !== 'https:' || issuer.origin !== config.expected_center_issuer ||
    origin.origin !== config.expected_center_origin || issuer.origin !== origin.origin || issuer.username || issuer.password ||
    ['localhost', '127.0.0.1', '::1'].includes(issuer.hostname) || isIP(issuer.hostname) ||
    /(^|\.)(test|example|invalid|local)$/i.test(issuer.hostname) || /(^|\.)example\.(com|net|org)$/i.test(issuer.hostname)) {
    throw new Error('Commercial trusted center must be a non-test HTTPS origin')
  }
  const root = config.offline_root
  if (!root || typeof root !== 'object' || Array.isArray(root) || Object.keys(root).sort().join(',') !== 'kid,publicJwk' ||
    !root.publicJwk || typeof root.publicJwk !== 'object' || Array.isArray(root.publicJwk) ||
    Object.keys(root.publicJwk).sort().join(',') !== 'crv,kty,x' || root.publicJwk.kty !== 'OKP' ||
    root.publicJwk.crv !== 'Ed25519' || typeof root.publicJwk.x !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(root.publicJwk.x) || Buffer.from(root.publicJwk.x, 'base64url').toString('base64url') !== root.publicJwk.x ||
    Buffer.from(root.publicJwk.x, 'base64url').length !== 32) {
    throw new Error('Trusted release configuration must pin one public Ed25519 root')
  }
  const rootKid = await calculateJwkThumbprint(root.publicJwk, 'sha256')
  if (root.kid !== rootKid || rootKid !== process.env.AIKAYUN_PRODUCTION_LICENSE_ROOT_KID ||
    issuer.origin !== process.env.AIKAYUN_PRODUCTION_LICENSE_ISSUER) {
    throw new Error('Trusted center issuer or root does not match the protected release environment pins')
  }
  await importJWK(root.publicJwk, 'Ed25519')
} else if (requireConfig) {
  throw new Error('A verified production authorization configuration is required for a commercial release')
}

const releaseIdentity = {
  product: 'aikayun',
  release_id: releaseId,
  version,
}
const generatedOutputDirectory = resolve(process.env.AIKAYUN_RELEASE_GENERATED_OUTPUT_DIR ??
  fileURLToPath(new URL('../src/licensing', import.meta.url)))
await mkdir(generatedOutputDirectory, { recursive: true })
await writeFile(resolve(generatedOutputDirectory, 'release-identity.generated.ts'),
  `/** Generated from the immutable release workflow inputs. */\nexport const generatedReleaseIdentity = Object.freeze(${JSON.stringify(releaseIdentity)})\n`)
await writeFile(resolve(generatedOutputDirectory, 'trusted-release-license-config.generated.ts'),
  `/** Generated from the protected production release configuration. */\nexport const generatedTrustedReleaseLicenseConfig: unknown = ${JSON.stringify(config)}\n`)
