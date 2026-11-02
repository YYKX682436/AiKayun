import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { writeCanonicalManifest } from './manifest.mjs'

const [metadataPath, artifactDirectory, migrationChecksumsPath, licenseConfigPath, outputPath] = process.argv.slice(2)
if (!metadataPath || !artifactDirectory || !migrationChecksumsPath || !licenseConfigPath || !outputPath) {
  throw new Error('Usage: node create-manifest.mjs IMAGE_METADATA ARTIFACT_DIRECTORY MIGRATION_CHECKSUMS LICENSE_CONFIG OUTPUT')
}
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
const migrationsBytes = await readFile(migrationChecksumsPath)
const migrations = JSON.parse(migrationsBytes.toString('utf8'))
const licenseConfig = JSON.parse(await readFile(licenseConfigPath, 'utf8'))
const root = resolve(artifactDirectory)

async function listFiles(directory) {
  const result = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await listFiles(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

const artifacts = []
for (const path of await listFiles(root)) {
  const name = relative(root, path).split(sep).join('/')
  if (['release-manifest.json', 'release-manifest.jws', 'release-manifest.jws.public.jwk.json'].includes(name)) continue
  const [bytes, info] = await Promise.all([readFile(path), stat(path)])
  artifacts.push({ name, size: info.size, sha256: createHash('sha256').update(bytes).digest('hex') })
}

const version = metadata.version
const manifest = {
  schema: 1,
  product: 'aikayun',
  release_id: `aikayun-${version}`,
  version,
  channel: version.includes('-') ? 'candidate' : 'stable',
  built_at: metadata.built_at,
  source_commit: metadata.source_commit,
  platforms: ['linux/amd64', 'linux/arm64'],
  images: metadata.images,
  artifacts,
  database: {
    engine_major: 18,
    migration_head: migrations.migration_head,
    migration_checksums_sha256: createHash('sha256').update(migrationsBytes).digest('hex'),
    readable_heads: [migrations.migration_head],
    writable_heads: [migrations.migration_head],
    upgrade_from_releases: [],
    rollback_to_releases: [],
    requires_write_quiescence: true,
  },
  license: {
    protocol_versions: [1],
    trust_configuration_id: licenseConfig.trust_configuration_id,
    issuer: licenseConfig.expected_center_issuer,
    offline_root_kid: licenseConfig.offline_root.kid,
    online_signer_kids: metadata.license_center_signer_kids,
    minimum_bundle_version: licenseConfig.minimum_bundle_version,
  },
  distribution: {
    https_origin: metadata.distribution_origin,
    release_path: `/releases/${version}/`,
  },
}
await writeCanonicalManifest(outputPath, manifest)
process.stdout.write(JSON.stringify({ release_id: manifest.release_id, migration_head: manifest.database.migration_head,
  artifacts: artifacts.length, manifest_path: outputPath }) + '\n')
