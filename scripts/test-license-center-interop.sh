#!/usr/bin/env bash
set -euo pipefail

readonly center_commit='a5cf99439e3bf92b65f19d60c013bca088cf221a'
readonly center_repository='https://github.com/YYKX682436/AiKayun-License.git'
readonly local_center_source='/Users/muchen/Documents/ChatGPT/AiKayun-License'
readonly postgres_image='postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
readonly database_name='aikayun_3c2b_test'
readonly test_filter="${1:-}"
readonly task_id="$(date +%s)-$$"
readonly container_name="aikayun-license-interop-${task_id}"
readonly temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/aikayun-license-interop.XXXXXX")"
readonly center_checkout="${temporary_root}/license-center"

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
  rm -rf "$temporary_root"
}
trap cleanup EXIT INT TERM

if [[ -d "$local_center_source/.git" && "$(git -C "$local_center_source" rev-parse HEAD)" == "$center_commit" ]]; then
  git clone --quiet --local --no-checkout "$local_center_source" "$center_checkout"
  git -C "$center_checkout" checkout --quiet --detach "$center_commit"
  center_source_commit="$(git -C "$local_center_source" rev-parse HEAD)"
else
  git clone --quiet --no-checkout "$center_repository" "$center_checkout"
  git -C "$center_checkout" fetch --quiet --depth 1 origin "$center_commit"
  git -C "$center_checkout" checkout --quiet --detach FETCH_HEAD
  center_source_commit="$(git -C "$center_checkout" rev-parse HEAD)"
fi
[[ "$center_source_commit" == "$center_commit" ]]

pnpm install --frozen-lockfile
(cd "$center_checkout" && npm ci)

docker run --detach --rm --name "$container_name" \
  --env POSTGRES_DB="$database_name" \
  --env POSTGRES_USER=license \
  --env POSTGRES_PASSWORD=license-test-only \
  --publish 127.0.0.1::5432 \
  "$postgres_image" >/dev/null

readonly postgres_port="$(docker port "$container_name" 5432/tcp | awk -F: '{print $NF}')"
for attempt in {1..60}; do
  if docker exec "$container_name" pg_isready -U license -d "$database_name" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == 60 ]]; then
    echo 'Isolated PostgreSQL 18 did not become ready.' >&2
    exit 1
  fi
  sleep 1
done

pnpm build:packages
export NODE_ENV=test
export TEST_DATABASE_URL="postgres://license:license-test-only@127.0.0.1:${postgres_port}/${database_name}"
export LICENSE_CENTER_CHECKOUT="$center_checkout"
if [[ -n "$test_filter" ]]; then
  pnpm --filter @aikayun/api exec vitest run \
    test/license-center-challenge.interop.test.ts \
    test/license-operation-store.integration.test.ts \
    --testNamePattern "$test_filter"
else
  pnpm --filter @aikayun/api exec vitest run \
    test/license-center-challenge.interop.test.ts \
    test/license-operation-store.integration.test.ts
fi
