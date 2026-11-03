import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputDirectory = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Usage: node create-installer-test-release.mjs OUTPUT_DIRECTORY')
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()

const releaseDirectory = join(outputDirectory, 'release')
const supportDirectory = join(outputDirectory, 'support')
await mkdir(supportDirectory, { recursive: true })

const digest = character => character.repeat(64)
const imageRepositories = {
  api: 'ghcr.io/yykx682436/aikayun-api',
  web: 'ghcr.io/yykx682436/aikayun-web',
  postgres: 'docker.io/library/postgres',
  caddy: 'docker.io/library/caddy',
}
const images = Object.fromEntries(Object.entries(imageRepositories).map(([name, repository], index) => [
  name,
  {
    reference: repository + '@sha256:' + digest(String(index + 1)),
    platform_digests: { 'linux/amd64': digest('a'), 'linux/arm64': digest('b') },
    sbom_sha256: { 'linux/amd64': digest('c'), 'linux/arm64': digest('d') },
  },
]))
const metadata = {
  version: '9.8.7-rc.3',
  built_at: '2026-11-03T00:00:00.000Z',
  source_commit: sourceCommit,
  distribution_origin: 'https://downloads.customer.com',
  license_center_signer_kids: ['B'.repeat(43)],
  images,
}
const config = {
  schema_version: 1,
  trust_configuration_id: '55555555-5555-4555-8555-555555555555',
  expected_center_issuer: 'https://license.customer.com',
  expected_center_origin: 'https://license.customer.com',
  offline_root: {
    kid: 'A'.repeat(43),
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: Buffer.alloc(32, 7).toString('base64url') },
  },
  minimum_bundle_version: '1',
}
const migrationChecksums = {
  schema: 1,
  migration_head: '202611030002_license_pending_key_binding',
  migrations: [],
}
const metadataPath = join(outputDirectory, 'metadata.json')
const configPath = join(outputDirectory, 'trust-config.json')
const checksumsPath = join(outputDirectory, 'migration-checksums.json')
await writeFile(metadataPath, JSON.stringify(metadata) + '\n', { mode: 0o600 })
await writeFile(configPath, JSON.stringify(config) + '\n', { mode: 0o600 })
await writeFile(checksumsPath, JSON.stringify(migrationChecksums) + '\n', { mode: 0o600 })

const supportNames = [
  'license-trust-bundle.jws',
  ...['api', 'web'].flatMap(name => ['NOTICE-' + name + '-linux-amd64.txt', 'NOTICE-' + name + '-linux-arm64.txt']),
  ...['api', 'web', 'postgres', 'caddy'].flatMap(name => [
    'NOTICE-image-' + name + '-linux-amd64.txt', 'NOTICE-image-' + name + '-linux-arm64.txt',
    name + '-linux-amd64.cdx.json', name + '-linux-arm64.cdx.json',
  ]),
]
for (const name of supportNames) {
  await writeFile(join(supportDirectory, name), name === 'license-trust-bundle.jws'
    ? 'controlled-test-trust-bundle\n' : 'controlled-test ' + name + '\n', { mode: 0o644 })
}
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const privateKeyPath = join(outputDirectory, 'temporary-test-signing-key.pem')
await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
const privateJwk = privateKey.export({ format: 'jwk' })
await writeFile(join(supportDirectory, 'release-signing-root.jwk.json'), JSON.stringify({
  kty: privateJwk.kty,
  crv: privateJwk.crv,
  x: privateJwk.x,
  y: privateJwk.y,
}) + '\n', { mode: 0o644 })
execFileSync('pnpm', ['exec', 'esbuild', 'apps/api/scripts/release/verify-only.mjs',
  '--bundle', '--platform=node', '--format=esm', '--target=node24',
  '--outfile=' + join(supportDirectory, 'release-verifier.mjs')], { cwd: repositoryRoot, stdio: 'pipe' })
execFileSync('pnpm', ['exec', 'esbuild', 'apps/api/scripts/release/verify-artifacts.mjs',
  '--bundle', '--platform=node', '--format=esm', '--target=node24',
  '--outfile=' + join(supportDirectory, 'verify-artifacts.mjs')], { cwd: repositoryRoot, stdio: 'pipe' })

execFileSync(process.execPath, [
  join(repositoryRoot, 'apps/api/scripts/release/assemble-release.mjs'),
  metadataPath, configPath, checksumsPath, supportDirectory, releaseDirectory,
], { cwd: repositoryRoot, stdio: 'pipe' })
execFileSync(process.execPath, [
  join(repositoryRoot, 'apps/api/scripts/release/create-manifest.mjs'),
  metadataPath, releaseDirectory, checksumsPath, configPath, join(releaseDirectory, 'release-manifest.json'),
], { cwd: repositoryRoot, stdio: 'pipe' })
execFileSync(process.execPath, [
  join(repositoryRoot, 'apps/api/scripts/release/cli.mjs'),
  'sign', join(releaseDirectory, 'release-manifest.json'),
  join(releaseDirectory, 'release-manifest.jws'), privateKeyPath,
], { cwd: repositoryRoot, stdio: 'pipe' })
await writeFile(join(releaseDirectory, 'release-manifest.cosign.bundle'),
  'controlled isolated Sigstore verifier fixture\n', { mode: 0o600 })
await rm(privateKeyPath, { force: true })

process.stdout.write(releaseDirectory + '\n')
