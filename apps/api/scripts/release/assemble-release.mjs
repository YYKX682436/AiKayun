import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const [metadataPath, configPath, migrationChecksumsPath, supportDirectory, outputDirectory] = process.argv.slice(2)
if (!metadataPath || !configPath || !migrationChecksumsPath || !supportDirectory || !outputDirectory) {
  throw new Error('Usage: node assemble-release.mjs METADATA TRUST_CONFIG MIGRATION_CHECKSUMS SUPPORT_DIRECTORY OUTPUT_DIRECTORY')
}
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
const config = JSON.parse(await readFile(configPath, 'utf8'))
const output = resolve(outputDirectory)
await mkdir(output)
await mkdir(join(output, 'deploy'))
await mkdir(join(output, 'sbom'))
await mkdir(join(output, 'notices'))

let compose = await readFile(new URL('../../../../compose.release.yaml', import.meta.url), 'utf8')
const imageMarkers = {
  api: '${AIKAYUN_API_IMAGE:?Set API image reference from the signed release manifest}',
  web: '${AIKAYUN_WEB_IMAGE:?Set Web image reference from the signed release manifest}',
  postgres: '${AIKAYUN_POSTGRES_IMAGE:?Set PostgreSQL image reference from the signed release manifest}',
  caddy: '${AIKAYUN_CADDY_IMAGE:?Set Caddy image reference from the signed release manifest}',
}
for (const [name, marker] of Object.entries(imageMarkers)) {
  const reference = metadata.images[name].reference
  const repository = name === 'api' || name === 'web'
    ? `ghcr.io/yykx682436/aikayun-${name}`
    : `docker.io/library/${name}`
  const prefix = `${repository}@sha256:`
  if (!reference.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(reference.slice(prefix.length))) {
    throw new Error(`${name} image must use its canonical repository and a SHA-256 digest`)
  }
  compose = compose.replaceAll(marker, reference)
}
if (/\blatest\b/.test(compose) || /\bbuild\s*:/u.test(compose)) throw new Error('Release Compose must use immutable image digests and contain no build steps')
await writeFile(join(output, 'compose.yaml'), compose, { flag: 'wx', mode: 0o644 })
await cp(new URL('../../../../deploy/Caddyfile', import.meta.url), join(output, 'deploy/Caddyfile'))
await cp(new URL('../../../../deploy/bootstrap-production-db-roles.sh', import.meta.url), join(output, 'deploy/bootstrap-production-db-roles.sh'))
await cp(new URL('../../../../deploy/prepare-state-volume.sh', import.meta.url), join(output, 'deploy/prepare-state-volume.sh'))
await cp(new URL('../../../../scripts/release/extract-oci-bundle.sh', import.meta.url), join(output, 'extract-release-bundle.sh'))
await cp(new URL('../../../../scripts/install/install-ai-kayun.sh', import.meta.url), join(output, 'install.sh'))
await cp(join(supportDirectory, 'license-trust-bundle.jws'), join(output, 'license-trust-bundle.jws'))
await cp(migrationChecksumsPath, join(output, 'migration-checksums.json'))
await writeFile(join(output, 'license-offline-root.jwk.json'), `${JSON.stringify(config.offline_root.publicJwk)}\n`, { flag: 'wx', mode: 0o644 })
for (const entry of await readdir(supportDirectory, { withFileTypes: true })) {
  if (!entry.isFile()) continue
  if (entry.name.endsWith('.cdx.json')) await cp(join(supportDirectory, entry.name), join(output, 'sbom', entry.name))
  else if (entry.name.startsWith('NOTICE-')) await cp(join(supportDirectory, entry.name), join(output, 'notices', entry.name))
  else if (entry.name === 'release-verifier.mjs' || entry.name === 'release-signing-root.jwk.json' ||
    entry.name === 'verify-artifacts.mjs') {
    await cp(join(supportDirectory, entry.name), join(output, entry.name))
  }
}
const expectedSbm = ['api-linux-amd64.cdx.json', 'api-linux-arm64.cdx.json', 'web-linux-amd64.cdx.json',
  'web-linux-arm64.cdx.json', 'postgres-linux-amd64.cdx.json', 'postgres-linux-arm64.cdx.json',
  'caddy-linux-amd64.cdx.json', 'caddy-linux-arm64.cdx.json']
for (const filename of expectedSbm) {
  const path = join(output, 'sbom', filename)
  await readFile(path)
}
for (const name of ['NOTICE-api-linux-amd64.txt', 'NOTICE-api-linux-arm64.txt', 'NOTICE-web-linux-amd64.txt', 'NOTICE-web-linux-arm64.txt']) {
  await readFile(join(output, 'notices', name))
}
for (const image of ['api', 'web', 'postgres', 'caddy']) {
  for (const platform of ['amd64', 'arm64']) await readFile(join(output, 'notices', `NOTICE-image-${image}-linux-${platform}.txt`))
}
await readFile(join(output, 'release-verifier.mjs'))
await readFile(join(output, 'verify-artifacts.mjs'))
await readFile(join(output, 'release-signing-root.jwk.json'))
await readFile(join(output, 'extract-release-bundle.sh'))
await readFile(join(output, 'install.sh'))
await readFile(join(output, 'deploy/prepare-state-volume.sh'))

const releaseIndex = {
  schema: 1,
  product: 'aikayun',
  version: metadata.version,
  release_id: `aikayun-${metadata.version}`,
  channel: metadata.version.includes('-') ? 'candidate' : 'stable',
  download_base_url: `${metadata.distribution_origin}/releases/${metadata.version}/`,
  manifest: 'release-manifest.json',
  manifest_signature: 'release-manifest.jws',
  manifest_cosign_bundle: 'release-manifest.cosign.bundle',
  release_signature_root: 'release-signing-root.jwk.json',
  artifacts: 'release-manifest.json:artifacts',
}
await writeFile(join(output, 'release-index.json'), `${JSON.stringify(releaseIndex, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
await writeFile(join(output, 'README.md'), [
  `# AiKayun ${metadata.version} candidate package`,
  '',
  'This bundle is an immutable signed release candidate. It contains no application source checkout, build system, credentials, customer data, or test trust keys.',
  '',
  '1. Verify `release-manifest.cosign.bundle` with Cosign, the Sigstore trust root and the published release workflow identity.',
  '2. Verify `release-manifest.json` and its detached JWS with `release-signing-root.jwk.json` using `release-verifier.mjs`; step 1 authenticates this JWS root.',
  '3. Compare every artifact SHA-256 and every OCI image reference with the signed manifest before using `compose.yaml`.',
  '4. Bootstrap bundle extraction on Linux with Docker using the digest-pinned pull/create/cp interface. The signed HTTPS artifact `extract-release-bundle.sh` provides that interface without Node, pnpm or source; it is also included in the OCI payload for later installer runs.',
  '5. The bundle includes one currently valid offline-root-signed Trust Bundle JWS. The signed shell installer accepts no user-provided signing key; it verifies Cosign, JWS, every artifact hash and the OCI bundle before deployment.',
  '6. The installer requires an existing Linux Docker Engine/Compose v2, public DNS for the store hostname, open TCP 80/443 and sufficient disk. It does not install Docker or change firewall rules.',
  '7. Use the server-local `setup-token` command only after HTTPS/ACME is ready. The token is printed only to that terminal and expires after 30 minutes.',
  '8. Use only the image digests rendered into `compose.yaml`; do not replace them with tags.',
  '',
  'The signed release index and artifacts are served from the HTTPS download location recorded in the signed manifest and index.',
  '',
].join('\n'), { flag: 'wx', mode: 0o644 })

const forbiddenPattern = /(^|\/)(\.git|test|tests|fixtures|docs|src|node_modules|\.env)(\/|$)|\.(map|ts|d\.ts|pem|key)$/i
async function walk(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (forbiddenPattern.test(name)) throw new Error(`Forbidden release bundle path: ${name}`)
    if (entry.isDirectory()) await walk(join(directory, entry.name), name)
  }
}
await walk(output)
process.stdout.write(JSON.stringify({ output, version: metadata.version }) + '\n')
