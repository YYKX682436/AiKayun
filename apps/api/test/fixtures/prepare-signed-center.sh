#!/bin/sh
# Test container only: do not modify the mounted frozen checkout or use its
# host-platform dependencies inside the container.
set -eu
[ "${NODE_ENV:-}" = test ] || exit 1
root=$(mktemp -d /tmp/aikayun-center-test.XXXXXX)
child=''
cleanup() {
  if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi
  rm -rf "$root"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
git clone --quiet --no-hardlinks /license-center "$root/center"
(cd "$root/center" && npm ci --no-audit --no-fund)
export LICENSE_CENTER_CHECKOUT="$root/center"
if [ -n "${AIKAYUN_TEST_NODE_IMPORT:-}" ]; then
  pnpm --filter @aikayun/api exec node --import tsx --import "$AIKAYUN_TEST_NODE_IMPORT" "$@" &
else
  pnpm --filter @aikayun/api exec tsx "$@" &
fi
child=$!
wait "$child"
child=''
