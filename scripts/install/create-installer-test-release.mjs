import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputDirectory = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Usage: node create-installer-test-release.mjs OUTPUT_DIRECTORY')
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
const version = process.env.AIKAYUN_TEST_RELEASE_VERSION ?? '9.8.7-rc.3'
const releaseId = `aikayun-${version}`
const releaseList = name => process.env[name] ? process.env[name].split(',') : []

const releaseDirectory = join(outputDirectory, 'release')
const supportDirectory = join(outputDirectory, 'support')
await mkdir(supportDirectory, { recursive: true })

const digest = character => character.repeat(64)
const platformDigest = (name, arch, fallback) => {
  const value = process.env[`AIKAYUN_TEST_${name.toUpperCase()}_${arch.toUpperCase()}_DIGEST`] ?? fallback
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid isolated ${name} ${arch} image digest`)
  return value
}
const imageRepositories = {
  api: 'ghcr.io/yykx682436/aikayun-api',
  web: 'ghcr.io/yykx682436/aikayun-web',
  postgres: 'docker.io/library/postgres',
  caddy: 'docker.io/library/caddy',
  backup: 'ghcr.io/yykx682436/aikayun-backup-restic',
}
const images = Object.fromEntries(Object.entries(imageRepositories).map(([name, repository], index) => [
  name,
  {
    reference: process.env[`AIKAYUN_TEST_${name.toUpperCase()}_IMAGE_REFERENCE`] ??
      repository + '@sha256:' + digest(String(index + 1)),
    platform_digests: {
      'linux/amd64': platformDigest(name, 'amd64', digest('a')),
      'linux/arm64': platformDigest(name, 'arm64', digest('b')),
    },
    sbom_sha256: { 'linux/amd64': digest('c'), 'linux/arm64': digest('d') },
  },
]))
const metadata = {
  version,
  built_at: '2026-11-03T00:00:00.000Z',
  source_commit: sourceCommit,
  distribution_origin: 'https://downloads.customer.com',
  license_center_signer_kids: ['B'.repeat(43)],
  upgrade_from_releases: releaseList('AIKAYUN_TEST_UPGRADE_FROM_RELEASES'),
  rollback_to_releases: releaseList('AIKAYUN_TEST_ROLLBACK_TO_RELEASES'),
  images,
}
const generatedConfig = {
  schema_version: 1,
  trust_configuration_id: process.env.AIKAYUN_TEST_TRUST_CONFIGURATION_ID ?? '55555555-5555-4555-8555-555555555555',
  release_id: releaseId,
  expected_center_issuer: 'https://license.customer.com',
  expected_center_origin: 'https://license.customer.com',
  offline_root: {
    kid: '',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: Buffer.alloc(32, 7).toString('base64url') },
  },
  minimum_bundle_version: '1',
}
generatedConfig.offline_root.kid = createHash('sha256').update(JSON.stringify({
  crv: generatedConfig.offline_root.publicJwk.crv, kty: generatedConfig.offline_root.publicJwk.kty, x: generatedConfig.offline_root.publicJwk.x,
})).digest('base64url')
const config = process.env.AIKAYUN_TEST_TRUSTED_LICENSE_CONFIG_FILE
  ? JSON.parse(await readFile(process.env.AIKAYUN_TEST_TRUSTED_LICENSE_CONFIG_FILE, 'utf8'))
  : generatedConfig
const trustBundle = process.env.AIKAYUN_TEST_TRUST_BUNDLE_FILE
  ? await readFile(process.env.AIKAYUN_TEST_TRUST_BUNDLE_FILE)
  : Buffer.from('controlled-test-trust-bundle\n')
await writeFile(join(outputDirectory, 'trusted-release-license-config.generated.js'),
  `export const generatedTrustedReleaseLicenseConfig = Object.freeze(${JSON.stringify(config)})\n`, { mode: 0o600 })
await writeFile(join(outputDirectory, 'release-identity.generated.js'),
  `export const generatedReleaseIdentity = Object.freeze(${JSON.stringify({ product: 'aikayun', release_id: releaseId, version })})\n`,
  { mode: 0o600 })
const migrationChecksumsBytes = process.env.AIKAYUN_TEST_MIGRATION_CHECKSUMS_FILE
  ? await readFile(process.env.AIKAYUN_TEST_MIGRATION_CHECKSUMS_FILE)
  : Buffer.from(JSON.stringify({
  schema: 1,
  migration_head: '202611030002_license_pending_key_binding',
  migrations: [],
}) + '\n')
const migrationChecksums = JSON.parse(migrationChecksumsBytes.toString('utf8'))
if (migrationChecksums.schema !== 1 || typeof migrationChecksums.migration_head !== 'string' || !Array.isArray(migrationChecksums.migrations)) {
  throw new Error('The isolated installer fixture needs a schema-1 migration checksum document')
}
const metadataPath = join(outputDirectory, 'metadata.json')
const configPath = join(outputDirectory, 'trust-config.json')
const checksumsPath = join(outputDirectory, 'migration-checksums.json')
await writeFile(metadataPath, JSON.stringify(metadata) + '\n', { mode: 0o600 })
await writeFile(configPath, JSON.stringify(config) + '\n', { mode: 0o600 })
await writeFile(checksumsPath, migrationChecksumsBytes, { mode: 0o600 })

const supportNames = [
  'license-trust-bundle.jws',
  'compose.restore-isolated.yaml',
  ...['api', 'web'].flatMap(name => ['NOTICE-' + name + '-linux-amd64.txt', 'NOTICE-' + name + '-linux-arm64.txt']),
  ...['api', 'web', 'postgres', 'caddy', 'backup'].flatMap(name => [
    'NOTICE-image-' + name + '-linux-amd64.txt', 'NOTICE-image-' + name + '-linux-arm64.txt',
    name + '-linux-amd64.cdx.json', name + '-linux-arm64.cdx.json',
  ]),
  'NOTICE-backup-reader-scan-linux-amd64.txt', 'NOTICE-backup-reader-scan-linux-arm64.txt',
]
for (const name of supportNames) {
  let contents = name === 'license-trust-bundle.jws' ? trustBundle : Buffer.from('controlled-test ' + name + '\n')
  if (name.startsWith('NOTICE-backup-reader-scan-')) {
    const arch = name.includes('amd64') ? 'amd64' : 'arm64'
    const notice = await readFile(join(supportDirectory, `NOTICE-image-backup-linux-${arch}.txt`))
    contents = `${JSON.stringify({ schema:'aikayun.backup-reader-notice-scan.v1',
      scanner:'aquasec/trivy@sha256:33f816d414b9d582d25bb737ffa4a632ae34e222f7ec1b50252cef0ce2266006',
      scope:'notice-files-only', arch, notice_sha256:createHash('sha256').update(notice).digest('hex'), findings:0 })}\n`
  }
  await writeFile(join(supportDirectory, name), contents, { mode: 0o644 })
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
await cp(join(repositoryRoot, 'scripts/release/backup-host-broker.sh'), join(supportDirectory, 'backup-host-broker.sh'))
await chmod(join(supportDirectory, 'backup-host-broker.sh'), 0o644)
await cp(process.env.AIKAYUN_TEST_RESTORE_COMPOSE_FILE ?? join(repositoryRoot, 'scripts/release/compose.restore-isolated.yaml'),
  join(supportDirectory, 'compose.restore-isolated.yaml'))
await chmod(join(supportDirectory, 'compose.restore-isolated.yaml'), 0o644)

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
