#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Isolated synthetic content only. No production deployment or volume is read.
readonly IMAGE='node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c'
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/aikayun-deployment-ownership.XXXXXX")"
cleanup() { python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' "$work"; }
trap cleanup EXIT
pnpm --dir "$root" exec esbuild apps/api/src/backup/deployment-archive.ts --bundle --platform=node --format=esm --target=node24 --outfile="$work/archive.mjs" >/dev/null
cat > "$work/fixture.mjs" <<'JS'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, chown, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureFixtureProductionOwnedDeploymentArchive } from './archive.mjs'
const root = '/tmp/isolated', deployment = join(root, 'deployment'), stage = join(root, 'stage')
const fail = message => { throw new Error(message) }
await mkdir(root, { mode: 0o700 }); await mkdir(deployment, { mode: 0o700 }); await mkdir(stage, { mode: 0o700 })
await mkdir(join(deployment, 'secrets'), { mode: 0o700 }); await mkdir(join(deployment, 'release'), { mode: 0o700 })
const sha = value => createHash('sha256').update(value).digest('hex')
const artifacts = []
for (const name of ['compose.yaml', 'install.sh', 'migration-checksums.json', 'license-trust-bundle.jws', 'release-index.json',
  'release-signing-root.jwk.json', 'release-verifier.mjs', 'verify-artifacts.mjs']) {
  const content = Buffer.from(`fixture-${name}`)
  await writeFile(join(deployment, 'release', name), content, { mode: 0o600 })
  artifacts.push({ name, size: content.length, sha256: sha(content) })
}
const manifest = Buffer.from(JSON.stringify({ artifacts }))
await writeFile(join(deployment, 'release', 'release-manifest.json'), manifest, { mode: 0o600 })
for (const name of ['release-manifest.jws', 'release-manifest.cosign.bundle']) await writeFile(join(deployment, 'release', name), 'fixture', { mode: 0o600 })
for (const name of ['postgres_admin_password', 'api_database_password', 'migrator_database_password', 'payment_credential_key_ring', 'code_pool_encryption_key_ring']) {
  const path = join(deployment, 'secrets', name)
  await writeFile(path, 'fixture-secret', { mode: 0o400 })
  const uid = name === 'postgres_admin_password' ? 0 : 1000
  await chown(path, uid, uid)
}
await writeFile(join(deployment, '.env'), 'fixture', { mode: 0o600 })
await writeFile(join(deployment, '.install-owner'), 'aikayun-install-v1\n', { mode: 0o600 })
await writeFile(join(deployment, 'install-state.json'), JSON.stringify({ manifest_sha256: sha(manifest) }), { mode: 0o600 })
await writeFile(join(deployment, 'aikayun'), 'fixture-install.sh', { mode: 0o755 })
const input = { deploymentRoot: deployment, stagingDirectory: stage, tarBinary: '/usr/bin/tar',
  assertSecureStaging: async () => {}, assertTrustedDeployment: async () => {} }
const fixture = `aikayun-75a-test-${randomBytes(12).toString('hex')}`
await captureFixtureProductionOwnedDeploymentArchive(input, fixture)
if ((await readFile(join(stage, 'deployment.tar'))).length < 1024) fail('valid archive missing')
await rm(join(stage, 'deployment.tar'))
const path = join(deployment, 'secrets', 'payment_credential_key_ring')
await chown(path, 0, 0)
let rejected = false
try { await captureFixtureProductionOwnedDeploymentArchive(input, fixture) } catch (error) { rejected = error.message === 'DEPLOYMENT_SECRETS_INVALID' }
if (!rejected) fail('wrong owner accepted')
await chown(path, 1000, 1000); await chmod(path, 0o600)
rejected = false
try { await captureFixtureProductionOwnedDeploymentArchive(input, fixture) } catch (error) { rejected = error.message === 'DEPLOYMENT_SECRETS_INVALID' }
if (!rejected) fail('wrong mode accepted')
console.log('isolated deployment ownership: 3/3 passed')
JS
docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev --mount "type=bind,source=$work,target=/work,readonly" --env NODE_ENV=test --entrypoint node "$IMAGE" /work/fixture.mjs
