import { createPrivateKey, createHash } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { relative, resolve, sep } from 'node:path'
import canonicalize from 'canonicalize'
import {
  CompactSign, compactVerify, calculateJwkThumbprint, importJWK,
} from 'jose'

const digestPattern = /^[a-f0-9]{64}$/
const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$/
const platforms = ['linux/amd64', 'linux/arm64']
const imageNames = ['api', 'web', 'postgres', 'caddy', 'backup']
const imageRepositories = {
  api: 'ghcr.io/yykx682436/aikayun-api',
  web: 'ghcr.io/yykx682436/aikayun-web',
  postgres: 'ghcr.io/yykx682436/aikayun-postgres',
  caddy: 'docker.io/library/caddy',
  backup: 'ghcr.io/yykx682436/aikayun-backup-restic',
}

export function isCanonicalReleaseSemVer(value) {
  return typeof value === 'string' && semverPattern.test(value)
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`Invalid ${label} fields`)
  }
}

export function validateReleaseManifest(value) {
  exactKeys(value, ['schema', 'product', 'release_id', 'version', 'channel', 'built_at', 'source_commit',
    'platforms', 'images', 'artifacts', 'database', 'license', 'distribution'], 'release manifest')
  if (value.schema !== 1 || value.product !== 'aikayun' || typeof value.release_id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value.release_id) || typeof value.version !== 'string' ||
      !isCanonicalReleaseSemVer(value.version) || value.release_id !== `aikayun-${value.version}` ||
      !['candidate', 'stable'].includes(value.channel) || typeof value.built_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.built_at) ||
      !Number.isFinite(Date.parse(value.built_at)) || typeof value.source_commit !== 'string' ||
      !/^[a-f0-9]{40}$/.test(value.source_commit)) throw new Error('Invalid release manifest identity')
  if (!Array.isArray(value.platforms) || value.platforms.join(',') !== platforms.join(',')) {
    throw new Error('Release manifest must list exactly the tested amd64 and arm64 platforms in order')
  }
  exactKeys(value.distribution, ['https_origin', 'release_path'], 'release distribution')
  if (typeof value.distribution.https_origin !== 'string' || typeof value.distribution.release_path !== 'string' ||
      !/^\/releases\/[A-Za-z0-9][A-Za-z0-9.+-]{0,63}\/$/.test(value.distribution.release_path)) {
    throw new Error('Invalid release distribution location')
  }
  const distributionOrigin = new URL(value.distribution.https_origin)
  if (distributionOrigin.protocol !== 'https:' || distributionOrigin.origin !== value.distribution.https_origin ||
      distributionOrigin.username || distributionOrigin.password || isIP(distributionOrigin.hostname) ||
      distributionOrigin.hostname === 'localhost' || distributionOrigin.hostname.endsWith('.localhost') ||
      /(^|\.)(test|example|invalid|local)$/i.test(distributionOrigin.hostname) ||
      /(^|\.)example\.(com|net|org)$/i.test(distributionOrigin.hostname)) {
    throw new Error('Release distribution must use the configured public HTTPS origin')
  }
  exactKeys(value.images, imageNames, 'release image map')
  for (const name of imageNames) {
    const image = value.images[name]
    exactKeys(image, ['reference', 'platform_digests', 'sbom_sha256'], `${name} image`)
    if (typeof image.reference !== 'string' || !image.reference.startsWith(`${imageRepositories[name]}@sha256:`) ||
        !/@sha256:[a-f0-9]{64}$/.test(image.reference)) {
      throw new Error(`Invalid ${name} image reference`)
    }
    exactKeys(image.platform_digests, platforms, `${name} platform digest map`)
    for (const platform of platforms) if (!digestPattern.test(image.platform_digests[platform])) {
      throw new Error(`Invalid ${name} ${platform} manifest digest`)
    }
    exactKeys(image.sbom_sha256, platforms, `${name} platform SBOM digest map`)
    for (const platform of platforms) if (!digestPattern.test(image.sbom_sha256[platform])) {
      throw new Error(`Invalid ${name} ${platform} SBOM digest`)
    }
  }
  if (!Array.isArray(value.artifacts)) throw new Error('Release artifacts must be an array')
  const artifactNames = new Set()
  for (const artifact of value.artifacts) {
    exactKeys(artifact, ['name', 'size', 'sha256'], 'release artifact')
    if (typeof artifact.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(artifact.name) ||
        artifact.name.includes('..') || artifactNames.has(artifact.name) || !Number.isSafeInteger(artifact.size) ||
        artifact.size < 0 || !digestPattern.test(artifact.sha256)) throw new Error('Invalid or duplicate release artifact')
    artifactNames.add(artifact.name)
  }
  if (value.artifacts.length < 1) throw new Error('Release manifest must identify downloadable artifacts')
  exactKeys(value.database, ['engine_major', 'migration_head', 'migration_checksums_sha256', 'readable_heads',
    'writable_heads', 'upgrade_from_releases', 'rollback_to_releases', 'requires_write_quiescence'], 'database compatibility')
  const database = value.database
  if (database.engine_major !== 18 || typeof database.migration_head !== 'string' ||
      !/^[0-9]{12}_[A-Za-z0-9_-]+$/.test(database.migration_head) || !digestPattern.test(database.migration_checksums_sha256) ||
      !Array.isArray(database.readable_heads) || !database.readable_heads.includes(database.migration_head) ||
      !Array.isArray(database.writable_heads) || !database.writable_heads.includes(database.migration_head) ||
      database.requires_write_quiescence !== true) throw new Error('Invalid database compatibility declaration')
  for (const [name, releases] of [['upgrade_from_releases', database.upgrade_from_releases],
    ['rollback_to_releases', database.rollback_to_releases]]) {
    if (!Array.isArray(releases) || releases.length > 32 || new Set(releases).size !== releases.length ||
        releases.some(release => typeof release !== 'string' || release.length > 64 || !release.startsWith('aikayun-') ||
          !isCanonicalReleaseSemVer(release.slice('aikayun-'.length)) || release === value.release_id)) {
      throw new Error(`Invalid database ${name} declaration`)
    }
  }
  exactKeys(value.license, ['protocol_versions', 'trust_configuration_id', 'issuer', 'offline_root_kid',
    'online_signer_kids', 'minimum_bundle_version'],
    'license release configuration')
  const license = value.license
  if (!Array.isArray(license.protocol_versions) || license.protocol_versions.length !== 1 || license.protocol_versions[0] !== 1 ||
      typeof license.trust_configuration_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(license.trust_configuration_id) ||
      typeof license.issuer !== 'string' || typeof license.offline_root_kid !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(license.offline_root_kid) || typeof license.minimum_bundle_version !== 'string' ||
      !/^[1-9][0-9]{0,18}$/.test(license.minimum_bundle_version)) throw new Error('A trusted production license configuration is required')
  if (!Array.isArray(license.online_signer_kids) || license.online_signer_kids.length === 0 ||
      license.online_signer_kids.some(kid => typeof kid !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(kid)) ||
      new Set(license.online_signer_kids).size !== license.online_signer_kids.length ||
      license.online_signer_kids.includes(license.offline_root_kid)) {
    throw new Error('The production authorization-center online signer KIDs must be explicitly pinned')
  }
  const issuer = new URL(license.issuer)
  if (issuer.protocol !== 'https:' || issuer.origin !== license.issuer || issuer.username || issuer.password ||
      ['localhost', '127.0.0.1', '::1'].includes(issuer.hostname) ||
      isIP(issuer.hostname) ||
      /(^|\.)(test|example|invalid|local)$/i.test(issuer.hostname) || /(^|\.)example\.(com|net|org)$/i.test(issuer.hostname)) {
    throw new Error('Release license issuer must be a production HTTPS origin')
  }
  return value
}

export function canonicalManifestBytes(value) {
  validateReleaseManifest(value)
  const serialized = canonicalize(value)
  if (!serialized) throw new Error('Release manifest cannot be canonicalized')
  return Buffer.from(serialized, 'utf8')
}

export function assertReleaseIdentityUnused(candidate, previousManifests) {
  validateReleaseManifest(candidate)
  for (const manifest of previousManifests) {
    if (manifest.release_id === candidate.release_id || manifest.version === candidate.version) {
      throw new Error(`Release ID or SemVer has already been used: ${candidate.release_id}`)
    }
  }
}

function detachedJws(compact) {
  const [protectedHeader, payload, signature] = compact.split('.')
  if (!protectedHeader || !payload || !signature) throw new Error('JOSE signer returned an invalid compact JWS')
  return `${protectedHeader}..${signature}`
}

function expandDetachedJws(signature, payload) {
  const compact = signature.trim()
  const parts = compact.split('.')
  if (parts.length !== 3 || !parts[0] || parts[1] !== '' || !parts[2]) throw new Error('Detached JWS format is invalid')
  return `${parts[0]}.${payload.toString('base64url')}.${parts[2]}`
}

export async function exportReleaseTrustRoot(privateKeyPath, outputPath, options = {}) {
  const privatePem = await readFile(privateKeyPath)
  const nodeKey = createPrivateKey({ key: privatePem, ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }) })
  if (nodeKey.asymmetricKeyType !== 'ec' || nodeKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Release signing key must be P-256')
  }
  const privateJwk = nodeKey.export({ format: 'jwk' })
  const publicJwk = { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y }
  const kid = await calculateJwkThumbprint(publicJwk, 'sha256')
  if (process.env.AIKAYUN_RELEASE_PUBLIC_KEY_JWK) {
    const configured = JSON.parse(process.env.AIKAYUN_RELEASE_PUBLIC_KEY_JWK)
    exactKeys(configured, ['kty', 'crv', 'x', 'y'], 'protected release public key')
    if (canonicalize(configured) !== canonicalize(publicJwk)) throw new Error('Release signing key does not match the protected public root pin')
  } else {
    throw new Error('The protected release public-key root pin is required')
  }
  await writeFile(outputPath, `${JSON.stringify(publicJwk)}\n`, { flag: 'wx', mode: 0o644 })
  return { kid, public_jwk: publicJwk }
}

export async function signReleaseManifest(manifestPath, signaturePath, privateKeyPath, options = {}) {
  const manifestBytes = await readFile(manifestPath)
  const parsed = JSON.parse(manifestBytes.toString('utf8'))
  validateReleaseManifest(parsed)
  const canonicalBytes = canonicalManifestBytes(parsed)
  if (!manifestBytes.equals(canonicalBytes)) throw new Error('Manifest file must contain canonical JSON bytes exactly')
  const privatePem = await readFile(privateKeyPath)
  const nodeKey = createPrivateKey({ key: privatePem, ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }) })
  if (nodeKey.asymmetricKeyType !== 'ec' || nodeKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Release signing key must be P-256 and independent from license-center signing keys')
  }
  const privateJwk = nodeKey.export({ format: 'jwk' })
  const publicJwk = { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y }
  const kid = await calculateJwkThumbprint(publicJwk, 'sha256')
  if (kid === parsed.license.offline_root_kid) throw new Error('Release signing key must not equal the authorization offline root')
  if (parsed.license.online_signer_kids.includes(kid)) {
    throw new Error('Release signing key must not overlap an authorization-center online signer')
  }
  const key = await importJWK(privateJwk, 'ES256')
  const compact = await new CompactSign(canonicalBytes)
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'aikayun-release-manifest+jws' })
    .sign(key)
  await writeFile(signaturePath, `${detachedJws(compact)}\n`, { flag: 'wx', mode: 0o600 })
  return { kid, public_jwk: publicJwk, manifest_sha256: createHash('sha256').update(canonicalBytes).digest('hex') }
}

export async function verifyReleaseManifest(manifestPath, signaturePath, publicJwkPath) {
  const manifestBytes = await readFile(manifestPath)
  const parsed = JSON.parse(manifestBytes.toString('utf8'))
  validateReleaseManifest(parsed)
  const canonicalBytes = canonicalManifestBytes(parsed)
  if (!manifestBytes.equals(canonicalBytes)) throw new Error('Manifest file is not canonical JSON')
  const publicJwk = JSON.parse(await readFile(publicJwkPath, 'utf8'))
  exactKeys(publicJwk, ['kty', 'crv', 'x', 'y'], 'release trust root')
  if (publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256' || typeof publicJwk.x !== 'string' || typeof publicJwk.y !== 'string') {
    throw new Error('Release trust root must be a public P-256 JWK')
  }
  const kid = await calculateJwkThumbprint(publicJwk, 'sha256')
  if (kid === parsed.license.offline_root_kid) throw new Error('Release verification root overlaps the authorization root')
  if (parsed.license.online_signer_kids.includes(kid)) {
    throw new Error('Release verification root overlaps an authorization-center online signer')
  }
  const key = await importJWK(publicJwk, 'ES256')
  const compact = expandDetachedJws(await readFile(signaturePath, 'utf8'), canonicalBytes)
  const result = await compactVerify(compact, key, { algorithms: ['ES256'] })
  if (!Buffer.from(result.payload).equals(canonicalBytes) || result.protectedHeader.typ !== 'aikayun-release-manifest+jws' ||
      result.protectedHeader.kid !== kid) throw new Error('Release manifest signature identity or payload mismatch')
  return { kid, manifest_sha256: createHash('sha256').update(canonicalBytes).digest('hex'), manifest: parsed }
}

export async function verifyReleaseArtifacts(manifestPath, artifactDirectory) {
  const manifestBytes = await readFile(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  validateReleaseManifest(manifest)
  if (!manifestBytes.equals(canonicalManifestBytes(manifest))) throw new Error('Manifest file is not canonical JSON')
  const root = await realpath(resolve(artifactDirectory))
  for (const artifact of manifest.artifacts) {
    const path = resolve(root, ...artifact.name.split('/'))
    const pathRelative = relative(root, path)
    if (pathRelative === '' || pathRelative.startsWith(`..${sep}`) || pathRelative === '..' || pathRelative.startsWith(sep)) {
      throw new Error(`Artifact path escapes the release directory: ${artifact.name}`)
    }
    let current = root
    for (const part of artifact.name.split('/')) {
      current = resolve(current, part)
      const info = await lstat(current)
      if (info.isSymbolicLink() || (current !== path && !info.isDirectory()) || (current === path && !info.isFile())) {
        throw new Error(`Artifact path must contain only regular files and directories: ${artifact.name}`)
      }
    }
    const bytes = await readFile(path)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength !== artifact.size || digest !== artifact.sha256) {
      throw new Error(`Release artifact size or SHA-256 mismatch: ${artifact.name}`)
    }
  }
  return { release_id: manifest.release_id, verified_artifacts: manifest.artifacts.length }
}

export async function writeCanonicalManifest(path, manifest) {
  const bytes = canonicalManifestBytes(manifest)
  await writeFile(path, bytes, { flag: 'wx', mode: 0o644 })
  return createHash('sha256').update(bytes).digest('hex')
}
