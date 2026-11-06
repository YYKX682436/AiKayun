#!/usr/bin/env bash
# Test-only: random release Compose, experimental unsigned helper image and
# synthetic credentials. Never references a production project or volume.
set -Eeuo pipefail
set +x
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
helper_image='aikayun-forky-helper-fixture-arm64:local'
mode="${AIKAYUN_FIXTURE_ENOSPC_MODE:-stage}"
if [[ ${1:-} == --inner ]]; then mode="${2:-}"; fi
[[ "$mode" == stage || "$mode" == repository ]] || exit 2
stage_size=1m
[[ "$mode" != repository ]] || stage_size=16m
if [[ ${1:-} != --inner ]]; then
  [[ "${AIKAYUN_FIXTURE_API_IMAGE:-}" && "${AIKAYUN_FIXTURE_WEB_IMAGE:-}" ]] || { echo 'Isolated API and Web images required' >&2; exit 2; }
  docker image inspect "$helper_image" >/dev/null
  exec bash "$root/scripts/release/test-backup-compose-fixture.sh" --start -- bash "$root/scripts/release/test-backup-real-enospc.sh" --inner "$mode"
fi
project="${AIKAYUN_FIXTURE_PROJECT:-}"
work="${AIKAYUN_FIXTURE_WORK:-}"
socket="${AIKAYUN_FIXTURE_DOCKER_SOCKET:-}"
[[ "$project" =~ ^aikayun-75a-test-[a-f0-9]{24}$ && "$work" == */aikayun-75a-fixture.* && -d "$work" && ! -L "$work" && -S "$socket" ]] || exit 1
[[ "$AIKAYUN_FIXTURE_STATE_VOLUME" == "${project}_aikayun_state" && "$AIKAYUN_FIXTURE_CADDY_DATA_VOLUME" == "${project}_caddy_data" &&
   "$AIKAYUN_FIXTURE_CADDY_CONFIG_VOLUME" == "${project}_caddy_config" && "$AIKAYUN_FIXTURE_DATABASE_CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
docker_local() { env -i PATH="$PATH" HOME="$HOME" docker --host "unix://$socket" "$@"; }
[[ "$(docker_local inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$AIKAYUN_FIXTURE_DATABASE_CONTAINER_ID")" == "$project" ]] || exit 1
for volume in "$AIKAYUN_FIXTURE_STATE_VOLUME" "$AIKAYUN_FIXTURE_CADDY_DATA_VOLUME" "$AIKAYUN_FIXTURE_CADDY_CONFIG_VOLUME"; do
  [[ "$(docker_local volume inspect --format '{{ index .Labels "com.aikayun.fixture" }}' "$volume")" == "$project" ]] || exit 1
done
helper_name="${project}-enospc-helper"
if docker_local inspect "$helper_name" >/dev/null 2>&1; then exit 1; fi
cleanup() {
  result=$?
  label="$(docker_local inspect --format '{{ index .Config.Labels "com.aikayun.fixture" }}' "$helper_name" 2>/dev/null || true)"
  [[ "$label" != "$project" ]] || docker_local rm -f -v "$helper_name" >/dev/null 2>&1 || true
  return "$result"
}
trap cleanup EXIT
pnpm --dir "$root" exec esbuild apps/api/test/fixtures/backup-compose-full.ts --bundle --platform=node --format=esm --target=node24 \
  '--banner:js=import { createRequire as __fixtureCreateRequire } from "node:module"; const require = __fixtureCreateRequire(import.meta.url);' --outfile="$work/enospc.mjs" >/dev/null
restic_sha="$(docker_local run --rm --network none --user 0:0 --entrypoint /usr/bin/sha256sum "$helper_image" /usr/bin/restic | awk '{print $1}')"
[[ "$restic_sha" =~ ^[a-f0-9]{64}$ ]] || exit 1
docker_local run --rm --name "$helper_name" --label "com.aikayun.fixture=$project" --network "${project}_private" --cap-add SYS_ADMIN --user 0:0 \
  --mount "type=bind,source=$socket,target=/run/docker.sock" \
  --mount "type=bind,source=$work,target=/fixture-input,readonly" \
  --env "AIKAYUN_FIXTURE_PROJECT=$project" --env 'AIKAYUN_FIXTURE_WORK=/tmp/aikayun-75a-fixture.enospc' \
  --env 'AIKAYUN_FIXTURE_DOCKER_SOCKET=/run/docker.sock' --env "AIKAYUN_FIXTURE_DATABASE_CONTAINER_ID=$AIKAYUN_FIXTURE_DATABASE_CONTAINER_ID" \
  --env "AIKAYUN_FIXTURE_API_IMAGE=$AIKAYUN_FIXTURE_API_IMAGE" --env "AIKAYUN_FIXTURE_WEB_IMAGE=$AIKAYUN_FIXTURE_WEB_IMAGE" \
  --env "AIKAYUN_FIXTURE_STATE_VOLUME=$AIKAYUN_FIXTURE_STATE_VOLUME" --env "AIKAYUN_FIXTURE_CADDY_DATA_VOLUME=$AIKAYUN_FIXTURE_CADDY_DATA_VOLUME" \
  --env "AIKAYUN_FIXTURE_CADDY_CONFIG_VOLUME=$AIKAYUN_FIXTURE_CADDY_CONFIG_VOLUME" --env 'AIKAYUN_FIXTURE_RESTIC=/usr/bin/restic' \
  --env "AIKAYUN_FIXTURE_RESTIC_SHA256=$restic_sha" --env "AIKAYUN_FIXTURE_APP_UID=$(id -u)" --env "AIKAYUN_FIXTURE_APP_GID=$(id -g)" --env 'AIKAYUN_FIXTURE_CONTAINER_MODE=1' \
  --env 'AIKAYUN_FIXTURE_ENOSPC_STAGE=/fixture-stage' --env "AIKAYUN_FIXTURE_ENOSPC_MODE=$mode" --env "AIKAYUN_FIXTURE_TMPFS_SIZE=$stage_size" --env 'NODE_ENV=production' --entrypoint /bin/sh "$helper_image" -c '
    set -eu; umask 077
    mkdir -m 700 /fixture-stage /tmp/aikayun-75a-fixture.enospc
    mount -t tmpfs -o noswap,nosuid,nodev,noexec,mode=0700,size="$AIKAYUN_FIXTURE_TMPFS_SIZE" tmpfs /fixture-stage
    for name in postgres api migrator payment delivery; do cp "/fixture-input/$name" "/tmp/aikayun-75a-fixture.enospc/$name"; chmod 600 "/tmp/aikayun-75a-fixture.enospc/$name"; done
    exec /nodejs/bin/node /fixture-input/enospc.mjs
  '
