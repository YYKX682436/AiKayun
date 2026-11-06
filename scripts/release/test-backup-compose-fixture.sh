#!/usr/bin/env bash
# Disposable production-Compose layout fixture; never targets a real deployment.
set -Eeuo pipefail
set +x
umask 077

root="$(cd "$(dirname "$0")/../.." && pwd)"
mode="${1:---check-only}"
[[ "$mode" == '--check-only' || "$mode" == '--start' ]] || { echo 'Usage: test-backup-compose-fixture.sh [--check-only|--start [-- COMMAND ARG...]]' >&2; exit 2; }
if (($#)); then shift; fi
callback=()
if (($#)); then
  [[ "$mode" == '--start' && "$1" == '--' && $# -ge 2 ]] || { echo 'A fixture callback requires --start -- COMMAND ARG...' >&2; exit 2; }
  shift
  callback=("$@")
fi
for command in docker node openssl mktemp; do command -v "$command" >/dev/null || { echo "Missing $command" >&2; exit 1; }; done
project="aikayun-75a-test-$(openssl rand -hex 12)"
[[ "$project" =~ ^aikayun-75a-test-[a-f0-9]{24}$ ]] || exit 1
app_uid="${AIKAYUN_FIXTURE_APP_UID:-$(id -u)}"
app_gid="${AIKAYUN_FIXTURE_APP_GID:-$(id -g)}"
[[ "$app_uid" =~ ^[0-9]+$ && "$app_gid" =~ ^[0-9]+$ ]] || { echo 'Invalid fixture application identity' >&2; exit 1; }
work="$(mktemp -d "${TMPDIR:-/tmp}/aikayun-75a-fixture.XXXXXXXX")"
created=0
local_docker() { env -i PATH="$PATH" HOME="$HOME" docker "$@"; }
compose() { env -i PATH="$PATH" HOME="$HOME" \
  AIKAYUN_API_IMAGE="$api_image" AIKAYUN_WEB_IMAGE="$web_image" AIKAYUN_POSTGRES_IMAGE="$postgres_image" AIKAYUN_CADDY_IMAGE="$caddy_image" \
  AIKAYUN_DB_NAME="${AIKAYUN_DB_NAME:-aikayun}" AIKAYUN_PUBLIC_HOST=localhost AIKAYUN_PRIVATE_SUBNET="$subnet" \
  AIKAYUN_POSTGRES_ADMIN_PASSWORD_FILE="$work/postgres" AIKAYUN_API_DATABASE_PASSWORD_FILE="$work/api" \
  AIKAYUN_MIGRATOR_DATABASE_PASSWORD_FILE="$work/migrator" AIKAYUN_PAYMENT_CREDENTIAL_KEY_RING_FILE="$work/payment" \
  AIKAYUN_CODE_POOL_ENCRYPTION_KEY_RING_FILE="$work/delivery" AIKAYUN_LICENSE_TRUST_BUNDLE_FILE="$work/trust.jws" \
  AIKAYUN_HTTP_BIND_ADDRESS=127.0.0.1 AIKAYUN_HTTPS_BIND_ADDRESS=127.0.0.1 AIKAYUN_HTTP_PORT=0 AIKAYUN_HTTPS_PORT=0 \
  docker compose --project-name "$project" -f "$root/compose.release.yaml" -f "$work/override.yaml" "$@"; }
cleanup() {
  status=$?
  if (( created )); then
    if (( status != 0 )); then
      fixture_logs="$(compose logs --no-color --tail=80 migrate 2>/dev/null || true)"
      if [[ -n "$fixture_logs" ]]; then
        printf '%s\n' 'Isolated fixture migration diagnostics:' "$fixture_logs" |
          sed -E 's/([Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt])([^[:space:]]*)/[REDACTED]/g' >&2
      fi
    fi
    helper="${project}-reader-restore"
    helper_owner="$(local_docker inspect --format '{{ index .Config.Labels "com.aikayun.fixture" }}' "$helper" 2>/dev/null || true)"
    if [[ "$helper_owner" == "$project" ]]; then
      local_docker stop --timeout 2 "$helper" >/dev/null 2>&1 || true
      local_docker rm "$helper" >/dev/null 2>&1 || true
    fi
    manifest_stage="${project}-manifest-stage"
    manifest_stage_owner="$(local_docker inspect --format '{{ index .Config.Labels "com.aikayun.fixture" }}' "$manifest_stage" 2>/dev/null || true)"
    if [[ "$manifest_stage_owner" == "$project" ]]; then local_docker rm -f "$manifest_stage" >/dev/null 2>&1 || true; fi
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    for key in postgres_data aikayun_state caddy_data caddy_config; do
      name="${project}_${key}"
      label="$(local_docker volume inspect --format '{{ index .Labels "com.aikayun.fixture" }}' "$name" 2>/dev/null || true)"
      [[ "$label" != "$project" ]] || local_docker volume rm "$name" >/dev/null 2>&1 || true
    done
    while IFS= read -r name; do
      [[ "$name" =~ ^${project}_reader_(staging|deployment|manifest|restore_[a-f0-9]{32})$ ]] || continue
      label="$(local_docker volume inspect --format '{{ index .Labels "com.aikayun.fixture" }}' "$name" 2>/dev/null || true)"
      [[ "$label" != "$project" ]] || local_docker volume rm "$name" >/dev/null 2>&1 || true
    done < <(local_docker volume ls --filter "label=com.aikayun.fixture=$project" --format '{{.Name}}')
  fi
  if [[ -d "$work" && "$work" == "${TMPDIR:-/tmp}"/aikayun-75a-fixture.* ]]; then rm -rf -- "$work"; fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

api_image="${AIKAYUN_FIXTURE_API_IMAGE:-ghcr.io/yykx682436/aikayun-api@sha256:$(printf 'a%.0s' {1..64})}"
web_image="${AIKAYUN_FIXTURE_WEB_IMAGE:-ghcr.io/yykx682436/aikayun-web@sha256:$(printf 'b%.0s' {1..64})}"
postgres_image='docker.io/library/postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
caddy_image='docker.io/library/caddy@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5'
if [[ "$mode" == '--start' ]]; then
  [[ -n "${AIKAYUN_FIXTURE_API_IMAGE:-}" && -n "${AIKAYUN_FIXTURE_WEB_IMAGE:-}" ]] || { echo 'Isolated API and Web images are required' >&2; exit 1; }
  endpoint="$(local_docker context inspect "$(local_docker context show)" --format '{{ (index .Endpoints "docker").Host }}')"
  [[ "$endpoint" == unix:///* && -S "${endpoint#unix://}" ]] || { echo 'A local Docker Unix socket is required' >&2; exit 1; }
  for key in postgres_data aikayun_state caddy_data caddy_config; do
    if local_docker volume inspect "${project}_${key}" >/dev/null 2>&1; then echo 'Fixture volume already exists' >&2; exit 1; fi
  done
  if local_docker network inspect "${project}_private" >/dev/null 2>&1; then echo 'Fixture network already exists' >&2; exit 1; fi
  if local_docker network inspect "${project}_postgres_test" >/dev/null 2>&1; then echo 'Fixture PostgreSQL test network already exists' >&2; exit 1; fi
fi
subnet="172.29.$((16#${project: -2})).0/24"
database_host_port="$(node --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
[[ "$database_host_port" =~ ^[1-9][0-9]{0,4}$ ]] || { echo 'Could not allocate an isolated database port' >&2; exit 1; }
for name in postgres api migrator; do openssl rand -hex 32 > "$work/$name"; done
for name in payment delivery; do
  printf '{"activeKeyId":"fixture-current","keys":{"fixture-current":"%s","fixture-history":"%s"}}\n' \
    "$(openssl rand -base64 32)" "$(openssl rand -base64 32)" > "$work/$name"
done
printf '%s\n' 'test-only-placeholder-bundle' > "$work/trust.jws"
cat > "$work/override.yaml" <<YAML
services:
  state-volume-init:
    environment:
      AIKAYUN_STATE_UID: "$app_uid"
      AIKAYUN_STATE_GID: "$app_gid"
      AIKAYUN_STATE_ALLOW_EMPTY_REPAIR: "true"
  migrate:
    user: "$app_uid:$app_gid"
    environment: { PUBLIC_ORIGIN: 'https://www.iana.org' }
  production-install-init:
    user: "$app_uid:$app_gid"
    environment: { PUBLIC_ORIGIN: 'https://www.iana.org' }
  api:
    user: "$app_uid:$app_gid"
    environment: { PUBLIC_ORIGIN: 'https://www.iana.org' }
    volumes:
      - "$root/apps/api/test/fixtures/isolated-restore-business-seed.mjs:/test/isolated-restore-business-seed.mjs:ro"
      - "$root/apps/api/test/fixtures/license-pending-compose-recovery.mjs:/test/license-pending-compose-recovery.mjs:ro"
  web:
    environment: { NUXT_PUBLIC_SITE_URL: 'https://www.iana.org' }
  db:
    networks:
      - private
      - postgres_test
    ports:
      - target: 5432
        host_ip: 127.0.0.1
        published: "$database_host_port"
        protocol: tcp
volumes:
  postgres_data: { name: '${project}_postgres_data', external: true }
  aikayun_state: { name: '${project}_aikayun_state', external: true }
  caddy_data: { name: '${project}_caddy_data', external: true }
  caddy_config: { name: '${project}_caddy_config', external: true }
networks:
  private: { name: '${project}_private', internal: true }
  postgres_test:
    name: '${project}_postgres_test'
    driver: bridge
    driver_opts:
      com.docker.network.bridge.enable_ip_masquerade: 'false'
YAML
compose config --format json > "$work/resolved.json"
node "$root/scripts/release/verify-backup-fixture-config.mjs" "$work/resolved.json" "$project" "$root" "$work" "$database_host_port"
if [[ "$mode" == '--start' ]]; then
  created=1
  for key in postgres_data aikayun_state caddy_data caddy_config; do
    case "$key" in
      aikayun_state) local_docker volume create --label "com.aikayun.fixture=$project" --label com.aikayun.managed-by=aikayun-7-3 "${project}_${key}" >/dev/null ;;
      caddy_data|caddy_config) local_docker volume create --label "com.aikayun.fixture=$project" \
        --label "com.docker.compose.volume=$key" --label com.docker.compose.project=aikayun "${project}_${key}" >/dev/null ;;
      *) local_docker volume create --label "com.aikayun.fixture=$project" "${project}_${key}" >/dev/null ;;
    esac
    label="$(local_docker volume inspect --format '{{ index .Labels "com.aikayun.fixture" }}' "${project}_${key}")"
    [[ "$label" == "$project" ]] || { echo 'Fixture volume ownership could not be verified' >&2; exit 1; }
  done
  compose up -d --wait --wait-timeout 240
  compose ps
  if ((${#callback[@]})); then
    database_id="$(compose ps -q db)"
    [[ "$database_id" =~ ^[a-f0-9]{64}$ ]] || { echo 'Fixture DB container identity is invalid' >&2; exit 1; }
    actual_project="$(local_docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$database_id")"
    [[ "$actual_project" == "$project" ]] || { echo 'Fixture DB container project mismatch' >&2; exit 1; }
    database_binding="$(local_docker port "$database_id" 5432/tcp)"
    [[ "$database_binding" == 127.0.0.1:* ]] || { echo 'Fixture PostgreSQL is not bound to loopback' >&2; exit 1; }
    database_port="${database_binding##*:}"
    [[ "$database_port" =~ ^[1-9][0-9]{0,4}$ ]] || { echo 'Fixture PostgreSQL port is invalid' >&2; exit 1; }
    [[ "$database_port" == "$database_host_port" ]] || { echo 'Fixture PostgreSQL binding differs from its isolated port' >&2; exit 1; }
    # This script is a test-only harness, never a customer or release command.
    # Callback receives only generated fixture identities and temporary paths.
    env -i PATH="$PATH" HOME="$HOME" AIKAYUN_FIXTURE_PROJECT="$project" \
      TMPDIR="${TMPDIR:-/tmp}" \
      AIKAYUN_FIXTURE_WORK="$work" AIKAYUN_FIXTURE_DOCKER_SOCKET="${endpoint#unix://}" \
      AIKAYUN_FIXTURE_DATABASE_CONTAINER_ID="$database_id" \
      AIKAYUN_FIXTURE_DATABASE_HOST_PORT="$database_port" \
      AIKAYUN_FIXTURE_DATABASE_NAME="${AIKAYUN_DB_NAME:-aikayun}" \
      AIKAYUN_FIXTURE_POSTGRES_PASSWORD_FILE="$work/postgres" \
      AIKAYUN_FIXTURE_API_PASSWORD_FILE="$work/api" \
      AIKAYUN_FIXTURE_PAYMENT_KEY_RING_FILE="$work/payment" \
      AIKAYUN_FIXTURE_DELIVERY_KEY_RING_FILE="$work/delivery" \
      AIKAYUN_FIXTURE_APP_UID="$app_uid" AIKAYUN_FIXTURE_APP_GID="$app_gid" \
      AIKAYUN_FIXTURE_API_IMAGE="$api_image" AIKAYUN_FIXTURE_WEB_IMAGE="$web_image" \
      AIKAYUN_FIXTURE_RESTIC="${AIKAYUN_FIXTURE_RESTIC:-}" AIKAYUN_FIXTURE_RESTIC_SHA256="${AIKAYUN_FIXTURE_RESTIC_SHA256:-}" NODE_ENV=production \
      AIKAYUN_FIXTURE_RESTIC_IMAGE="${AIKAYUN_FIXTURE_RESTIC_IMAGE:-}" \
      AIKAYUN_FIXTURE_RESTIC_RUNTIME_IMAGE="${AIKAYUN_FIXTURE_RESTIC_RUNTIME_IMAGE:-${AIKAYUN_FIXTURE_RESTIC_IMAGE:-}}" \
      AIKAYUN_FIXTURE_POSTGRES_IMAGE="$postgres_image" AIKAYUN_FIXTURE_CADDY_IMAGE="$caddy_image" \
      AIKAYUN_FIXTURE_STATE_VOLUME="${project}_aikayun_state" \
      AIKAYUN_FIXTURE_POSTGRES_VOLUME="${project}_postgres_data" \
      AIKAYUN_FIXTURE_CADDY_DATA_VOLUME="${project}_caddy_data" \
      AIKAYUN_FIXTURE_CADDY_CONFIG_VOLUME="${project}_caddy_config" \
      "${callback[@]}"
  fi
fi
