import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, createPublicKey } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { calculateJwkThumbprint, exportJWK } from 'jose'
import {
  assertReleaseIdentityUnused, canonicalManifestBytes, signReleaseManifest, validateReleaseManifest,
  verifyReleaseArtifacts, verifyReleaseManifest,
} from './manifest.mjs'

const hex = value => value.repeat(64).slice(0, 64)
const platformDigests = { 'linux/amd64': hex('1'), 'linux/arm64': hex('2') }
const imageReferences = {
  api: 'ghcr.io/yykx682436/aikayun-api',
  web: 'ghcr.io/yykx682436/aikayun-web',
  postgres: 'docker.io/library/postgres',
  caddy: 'docker.io/library/caddy',
}
const images = Object.fromEntries(['api', 'web', 'postgres', 'caddy'].map((name, index) => [name, {
  reference: `${imageReferences[name]}@sha256:${hex(String(index + 3))}`,
  platform_digests: platformDigests,
  sbom_sha256: { 'linux/amd64': hex(String(index + 7)), 'linux/arm64': hex(String(index + 8)) },
}]))
const makeManifest = () => ({
  schema: 1,
  product: 'aikayun',
  release_id: 'aikayun-0.1.0-rc.1',
  version: '0.1.0-rc.1',
  channel: 'candidate',
  built_at: '2026-11-02T02:00:00.000Z',
  source_commit: 'a'.repeat(40),
  platforms: ['linux/amd64', 'linux/arm64'],
  images,
  artifacts: [{ name: 'compose.yaml', size: 4, sha256: hex('b') }],
  distribution: { https_origin: 'https://www.iana.org', release_path: '/releases/0.1.0-rc.1/' },
  database: {
    engine_major: 18,
    migration_head: '202611030002_license_pending_key_binding',
    migration_checksums_sha256: hex('c'),
    readable_heads: ['202611030002_license_pending_key_binding'],
    writable_heads: ['202611030002_license_pending_key_binding'],
    upgrade_from_releases: [],
    rollback_to_releases: [],
    requires_write_quiescence: true,
  },
  license: {
    protocol_versions: [1],
    trust_configuration_id: '55555555-5555-4555-8555-555555555555',
    issuer: 'https://www.iana.org',
    offline_root_kid: 'A'.repeat(43),
    online_signer_kids: ['B'.repeat(43)],
    minimum_bundle_version: '1',
  },
})

test('release manifest JWS binds exact canonical bytes and a distinct release key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aikayun-release-manifest-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const privateKeyPath = join(directory, 'release-signing-key.pem')
  const manifestPath = join(directory, 'release-manifest.json')
  const signaturePath = join(directory, 'release-manifest.jws')
  const publicJwkPath = `${signaturePath}.public.jwk.json`
  const manifest = makeManifest()
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await writeFile(manifestPath, canonicalManifestBytes(manifest), { mode: 0o600 })

  const signed = await signReleaseManifest(manifestPath, signaturePath, privateKeyPath)
  const publicKey = createPublicKey(privateKey)
  const publicJwk = await exportJWK(publicKey)
  assert.equal(signed.kid, await calculateJwkThumbprint(publicJwk, 'sha256'))
  await writeFile(publicJwkPath, JSON.stringify({ kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y }))
  const verified = await verifyReleaseManifest(manifestPath, signaturePath, publicJwkPath)
  assert.equal(verified.manifest_sha256, signed.manifest_sha256)
  assert.equal(verified.manifest.release_id, manifest.release_id)
})

test('wrong release key and substituted manifest bytes fail verification', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aikayun-release-tamper-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const first = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const second = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const manifestPath = join(directory, 'release-manifest.json')
  const signaturePath = join(directory, 'release-manifest.jws')
  const privateKeyPath = join(directory, 'release-signing-key.pem')
  const wrongPublicJwkPath = join(directory, 'wrong-public.jwk.json')
  const manifest = makeManifest()
  await writeFile(manifestPath, canonicalManifestBytes(manifest))
  await writeFile(privateKeyPath, first.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await signReleaseManifest(manifestPath, signaturePath, privateKeyPath)
  const wrongJwk = await exportJWK(second.publicKey)
  await writeFile(wrongPublicJwkPath, JSON.stringify({ kty: wrongJwk.kty, crv: wrongJwk.crv, x: wrongJwk.x, y: wrongJwk.y }))
  await assert.rejects(verifyReleaseManifest(manifestPath, signaturePath, wrongPublicJwkPath))

  const changed = {
    ...manifest,
    images: {
      ...manifest.images,
      api: { ...manifest.images.api, reference: `ghcr.io/yykx682436/aikayun-api@sha256:${hex('e')}` },
    },
  }
  await writeFile(manifestPath, canonicalManifestBytes(changed))
  const correctJwk = await exportJWK(createPublicKey(first.privateKey))
  const correctPublicJwkPath = join(directory, 'correct-public.jwk.json')
  await writeFile(correctPublicJwkPath, JSON.stringify({
    kty: correctJwk.kty, crv: correctJwk.crv, x: correctJwk.x, y: correctJwk.y,
  }))
  await assert.rejects(verifyReleaseManifest(manifestPath, signaturePath, correctPublicJwkPath))
})

test('rejects release ID and SemVer reuse', () => {
  const candidate = makeManifest()
  validateReleaseManifest(candidate)
  assert.throws(() => assertReleaseIdentityUnused(candidate, [makeManifest()]), /already been used/u)
  assert.throws(() => validateReleaseManifest({ ...candidate, release_id: 'reused-id' }), /identity/u)
  assert.throws(() => validateReleaseManifest({ ...candidate, version: '0.1.0-rc.01' }), /identity/u)
})

test('release signing key cannot overlap authorization online signers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aikayun-release-key-overlap-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const privateKeyPath = join(directory, 'release-signing-key.pem')
  const manifestPath = join(directory, 'release-manifest.json')
  const signaturePath = join(directory, 'release-manifest.jws')
  const publicJwk = await exportJWK(publicKey)
  const { calculateJwkThumbprint } = await import('jose')
  const signerKid = await calculateJwkThumbprint(publicJwk, 'sha256')
  const manifest = makeManifest()
  manifest.license.online_signer_kids = [signerKid]
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await writeFile(manifestPath, canonicalManifestBytes(manifest))
  await assert.rejects(signReleaseManifest(manifestPath, signaturePath, privateKeyPath), /authorization-center online signer/u)
})

test('release artifact verifier checks exact file size and SHA-256 and rejects symlinks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aikayun-release-artifacts-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const artifactDirectory = join(directory, 'artifacts')
  const manifestPath = join(directory, 'release-manifest.json')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(artifactDirectory))
  const bytes = Buffer.from('compose')
  await writeFile(join(artifactDirectory, 'compose.yaml'), bytes)
  const manifest = makeManifest()
  manifest.artifacts = [{ name: 'compose.yaml', size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex') }]
  await writeFile(manifestPath, canonicalManifestBytes(manifest))
  assert.deepEqual(await verifyReleaseArtifacts(manifestPath, artifactDirectory), {
    release_id: manifest.release_id, verified_artifacts: 1,
  })
  await writeFile(join(artifactDirectory, 'compose.yaml'), 'tampered')
  await assert.rejects(verifyReleaseArtifacts(manifestPath, artifactDirectory), /size or SHA-256 mismatch/u)
})

test('release bundle assembly pins full API/Web references into Compose and includes installer and Trust Bundle', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aikayun-release-assembly-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const support = join(directory, 'support')
  const output = join(directory, 'bundle')
  await mkdir(support)
  const api = `ghcr.io/yykx682436/aikayun-api@sha256:${hex('a')}`
  const web = `ghcr.io/yykx682436/aikayun-web@sha256:${hex('b')}`
  const version = '1.2.3-rc.1'
  const metadataPath = join(directory, 'metadata.json')
  const configPath = join(directory, 'config.json')
  const checksumsPath = join(directory, 'migration-checksums.json')
  const trustBundle = 'fixture.payload.signature\n'
  await writeFile(metadataPath, JSON.stringify({
    version, distribution_origin: 'https://download.example.test',
    images: { api: { reference: api }, web: { reference: web } },
  }))
  await writeFile(configPath, JSON.stringify({ offline_root: { publicJwk: {
    kty: 'OKP', crv: 'Ed25519', x: Buffer.alloc(32, 7).toString('base64url'),
  } } }))
  await writeFile(checksumsPath, JSON.stringify({ schema: 1, migration_head: '202611030002_license_pending_key_binding', migrations: [] }))

  const supportFiles = [
    'release-verifier.mjs', 'verify-artifacts.mjs', 'release-signing-root.jwk.json', 'license-trust-bundle.jws',
    ...['api', 'web'].flatMap(image => [`NOTICE-${image}-linux-amd64.txt`, `NOTICE-${image}-linux-arm64.txt`]),
    ...['api', 'web', 'postgres', 'caddy'].flatMap(image => [
      `NOTICE-image-${image}-linux-amd64.txt`, `NOTICE-image-${image}-linux-arm64.txt`,
      `${image}-linux-amd64.cdx.json`, `${image}-linux-arm64.cdx.json`,
    ]),
  ]
  for (const filename of supportFiles) {
    await writeFile(join(support, filename), filename === 'license-trust-bundle.jws' ? trustBundle : `fixture ${filename}\n`)
  }

  execFileSync(process.execPath, [join(import.meta.dirname, 'assemble-release.mjs'),
    metadataPath, configPath, checksumsPath, support, output], { encoding: 'utf8' })
  const compose = await readFile(join(output, 'compose.yaml'), 'utf8')
  assert.ok(compose.includes(`image: ${api}`))
  assert.ok(compose.includes(`image: ${web}`))
  assert.ok(!compose.includes(`@sha256:${api}`))
  assert.equal(await readFile(join(output, 'install.sh'), 'utf8'),
    await readFile(new URL('../../../../scripts/install/install-ai-kayun.sh', import.meta.url), 'utf8'))
  assert.equal(await readFile(join(output, 'license-trust-bundle.jws'), 'utf8'), trustBundle)
  assert.equal(JSON.parse(await readFile(join(output, 'release-index.json'), 'utf8')).version, version)
})
