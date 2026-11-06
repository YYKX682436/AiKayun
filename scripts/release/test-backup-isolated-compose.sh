#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

root="$(cd "$(dirname "$0")/../.." && pwd)"
compose_file="$root/scripts/release/compose.restore-isolated.yaml"
work="$(mktemp -d "${TMPDIR:-/tmp}/aikayun-restore-compose-check.XXXXXXXX")"
cleanup() { [[ -d "$work" && "$work" == "${TMPDIR:-/tmp}"/aikayun-restore-compose-check.* ]] && rm -rf -- "$work"; }
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || { echo 'Docker CLI is required for isolated restore Compose validation.' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo 'Node.js is required for isolated restore Compose validation.' >&2; exit 1; }

run_id="$(node --input-type=module -e 'process.stdout.write(crypto.randomUUID())')"
project="aikayun-drill-${run_id//-/}"
for name in repository password bootstrap readonly; do : > "$work/$name"; chmod 0600 "$work/$name"; done
cat > "$work/compose.env" <<EOF
AIKAYUN_RESTORE_RUN_ID=$run_id
AIKAYUN_RESTORE_PROJECT=$project
AIKAYUN_RESTORE_SET_ID=11111111-1111-4111-8111-111111111111
AIKAYUN_RESTORE_SOURCE_SNAPSHOT_ID=$(printf 'a%.0s' {1..64})
AIKAYUN_RESTORE_MANIFEST_SNAPSHOT_ID=$(printf 'b%.0s' {1..64})
AIKAYUN_RESTORE_MANIFEST_DIRECTORY=/var/lib/aikayun-backup/staging/set-11111111-1111-4111-8111-111111111111/manifest
AIKAYUN_RESTORE_RELEASE_ID=aikayun-test
AIKAYUN_RESTORE_API_DIGEST=sha256:$(printf 'c%.0s' {1..64})
AIKAYUN_RESTORE_WEB_DIGEST=sha256:$(printf 'd%.0s' {1..64})
AIKAYUN_RESTORE_POSTGRES_DIGEST=sha256:$(printf 'e%.0s' {1..64})
AIKAYUN_RESTORE_CADDY_DIGEST=sha256:$(printf 'f%.0s' {1..64})
AIKAYUN_API_IMAGE=example.invalid/aikayun-api@sha256:$(printf '1%.0s' {1..64})
AIKAYUN_WEB_IMAGE=example.invalid/aikayun-web@sha256:$(printf '2%.0s' {1..64})
AIKAYUN_POSTGRES_IMAGE=docker.io/library/postgres:18-alpine@sha256:$(printf '3%.0s' {1..64})
AIKAYUN_CADDY_IMAGE=example.invalid/caddy@sha256:$(printf '4%.0s' {1..64})
AIKAYUN_BACKUP_RESTIC_IMAGE=example.invalid/restic@sha256:$(printf '5%.0s' {1..64})
AIKAYUN_RESTORE_REPOSITORY=$work/repository
AIKAYUN_RESTORE_PASSWORD_FILE=$work/password
AIKAYUN_RESTORE_BOOTSTRAP_PASSWORD_FILE=$work/bootstrap
AIKAYUN_RESTORE_READONLY_PASSWORD_FILE=$work/readonly
EOF

docker compose --project-name "$project" --file "$compose_file" --env-file "$work/compose.env" \
  config --format json > "$work/resolved.json"
node --input-type=module - "$work/resolved.json" "$project" "$run_id" <<'NODE'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [path, project, runId] = process.argv.slice(2)
const config = JSON.parse(await readFile(path, 'utf8'))
const services = Object.keys(config.services).sort()
assert.deepEqual(services, ['db', 'restore-database', 'restore-input-permissions', 'restore-manifest',
  'restore-readonly-role', 'restore-secrets', 'restore-source', 'validate'].sort())
for (const service of Object.values(config.services)) assert.equal(service.ports?.length ?? 0, 0)
assert.deepEqual(Object.keys(config.services.db.networks), ['restore'])
assert.deepEqual(Object.keys(config.services.validate.networks), ['restore'])
assert.equal(config.services.validate.user, '1000:1000')
assert.equal(config.services.validate.read_only, true)
assert.deepEqual(config.services.validate.cap_drop, ['ALL'])
assert.deepEqual(config.services.validate.tmpfs, ['/tmp:rw,noexec,nosuid,nodev,size=8m'])
assert.equal(config.services.validate.entrypoint[0], '/nodejs/bin/node')
assert.deepEqual(config.services.validate.command, ['/app/dist/backup/isolated-restore-cli.js'])
assert.equal(config.services.validate.environment.NODE_ENV, 'production')
assert.equal(config.services.validate.environment.PUBLIC_ORIGIN, 'https://www.iana.org')
assert.equal(config.services.validate.environment.COOKIE_SECURE, 'true')
assert.equal(config.services.validate.environment.TRUST_PROXY_CIDRS, '127.0.0.1/32')
assert.equal('TRUST_PROXY' in config.services.validate.environment, false)
for (const name of ['restore-secrets', 'restore-source', 'restore-manifest', 'restore-input-permissions']) {
  assert.equal(config.services[name].network_mode, 'none')
}
assert.equal(config.services['restore-input-permissions'].user, '0:0')
assert.equal(config.services['restore-input-permissions'].read_only, true)
assert.deepEqual(config.services['restore-input-permissions'].cap_drop, ['ALL'])
assert.deepEqual(config.services['restore-input-permissions'].cap_add, ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'])
assert.ok(config.services['restore-input-permissions'].command.join(' ').includes('chown 1000:1000 /database /manifest'))
assert.ok(config.services['restore-input-permissions'].command.join(' ').includes('chown 1000:1000 /database /manifest /keys'))
assert.ok(config.services['restore-input-permissions'].command.join(' ').includes('chmod 0700 /database /manifest /keys'))
assert.ok(config.services['restore-input-permissions'].volumes.some(volume =>
  volume.type === 'volume' && volume.source === 'deployment_keys' && volume.target === '/keys'))
assert.ok(config.services['restore-readonly-role'].command.join(' ').includes('RESTORE_READONLY_ROLE_CREATE_FAILED'))
assert.ok(config.services['restore-source'].tmpfs.includes('/restore:rw,noexec,nosuid,nodev,size=8m'))
assert.ok(!config.services['restore-manifest'].tmpfs.includes('/restore:rw,noexec,nosuid,nodev,size=8m'))
assert.ok(config.services['restore-manifest'].volumes.some(volume =>
  volume.type === 'volume' && volume.source === 'manifest' && volume.target === '/restore'))
assert.equal(config.networks.restore.internal, true)
assert.equal(config.networks.restore.name, `${project}_restore`)
assert.equal(config.networks.restore.labels['com.aikayun.restore.run'], runId)
assert.deepEqual(Object.keys(config.volumes).sort(), ['caddy_config', 'caddy_data', 'credentials', 'database',
  'database_input', 'deployment_keys', 'manifest', 'state'].sort())
for (const [name, volume] of Object.entries(config.volumes)) {
  assert.ok(volume.driver === undefined || volume.driver === 'local')
  assert.equal(volume.name, `${project}_${name}`)
  assert.equal(volume.labels['com.aikayun.restore.run'], runId)
}
assert.equal(config.services.validate.environment.PGOPTIONS, '-c default_transaction_read_only=on')
assert.equal(config.services.validate.environment.AIKAYUN_RESTORE_RUN_ID, runId)
assert.equal(config.services.validate.environment.AIKAYUN_RESTORE_TEST_DIAGNOSTICS, 'false')
console.log('Isolated restore Compose isolation and read-only validation config verified.')
NODE
