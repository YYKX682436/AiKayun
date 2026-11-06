#!/usr/bin/env bash
# Test-only shared-file lock experiment; it is not a production entry point.
set -Eeuo pipefail
set +x
umask 077
api_image="${AIKAYUN_FIXTURE_API_IMAGE:?Set a locally built isolated API image}"
test_image='node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c'
docker image inspect "$api_image" >/dev/null
docker image inspect "$test_image" >/dev/null
project="aikayun-75a-lock-$(openssl rand -hex 12)"
[[ "$project" =~ ^aikayun-75a-lock-[a-f0-9]{24}$ ]] || exit 1
work="$(mktemp -d "${TMPDIR:-/tmp}/aikayun-75a-lock.XXXXXXXX")"
work="$(cd "$work" && pwd -P)"
lock="$work/deployment.lock"
: > "$lock"
chmod 0600 "$lock"
endpoint="$(env -i PATH="$PATH" HOME="$HOME" docker context inspect "$(env -i PATH="$PATH" HOME="$HOME" docker context show)" --format '{{ (index .Endpoints "docker").Host }}')"
[[ "$endpoint" == unix:///* && -S "${endpoint#unix://}" ]] || { echo 'Local Docker socket required' >&2; exit 1; }
docker_local() { env -i PATH="$PATH" HOME="$HOME" docker --host "$endpoint" "$@"; }
cleanup() {
  local result=$?
  docker_local rm -f "${project}-holder" "${project}-helper" >/dev/null 2>&1 || true
  if [[ -d "$work" && "$work" == */aikayun-75a-lock.* && ! -L "$work" ]]; then rm -rf -- "$work"; fi
  return "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mount="type=bind,source=$lock,target=/run/aikayun-deployment.lock"
for name in "${project}-holder" "${project}-helper"; do
  if docker_local inspect "$name" >/dev/null 2>&1; then echo 'Unexpected existing fixture container' >&2; exit 1; fi
done
docker_local run -d --network none --name "${project}-holder" --mount "$mount" --user 0:0 \
  --entrypoint /bin/sh "$test_image" -c 'exec 9<>/run/aikayun-deployment.lock; flock -n 9; echo HELD; exec sleep 300' >/dev/null
wait_for_log() {
  local name="$1"
  for _ in {1..100}; do
    if docker_local logs "$name" 2>&1 | grep -qx HELD; then return 0; fi
    sleep 0.1
  done
  echo 'Lock holder did not start' >&2; return 1
}
wait_for_log "${project}-holder"
if docker_local run --rm --network none --mount "$mount" --user 0:0 --entrypoint /usr/bin/flock "$api_image" \
  -n -F /run/aikayun-deployment.lock /nodejs/bin/node -e 'process.exit(0)' >/dev/null 2>&1; then
  echo 'A helper unexpectedly acquired the held lock' >&2; exit 1
fi
docker_local rm -f "${project}-holder" >/dev/null
docker_local run -d --network none --name "${project}-helper" --mount "$mount" --user 0:0 --entrypoint /usr/bin/flock "$api_image" \
  -n -F /run/aikayun-deployment.lock /nodejs/bin/node -e 'console.log("HELD");setInterval(()=>{},1000)' >/dev/null
wait_for_log "${project}-helper"
# The detached Docker client has exited; the helper itself must still hold the lock.
if docker_local run --rm --network none --mount "$mount" --user 0:0 --entrypoint /usr/bin/flock "$api_image" \
  -n -F /run/aikayun-deployment.lock /nodejs/bin/node -e 'process.exit(0)' >/dev/null 2>&1; then
  echo 'A second helper unexpectedly acquired the lock' >&2; exit 1
fi
docker_local kill "${project}-helper" >/dev/null
docker_local run --rm --network none --mount "$mount" --user 0:0 --entrypoint /usr/bin/flock "$api_image" \
  -n -F /run/aikayun-deployment.lock /nodejs/bin/node -e 'process.exit(0)' >/dev/null
printf '%s\n' 'Isolated Linux helper lock contention, client exit and helper SIGKILL passed.'
