#!/usr/bin/env bash
# Synthetic metadata only. The experimental helper is not signed release proof.
set -Eeuo pipefail
set +x
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
image='aikayun-al2023-helper-fixture-arm64:local'
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
task_dir="$(mktemp -d "${TMPDIR:-/tmp}/aikayun-deployment-metadata.XXXXXXXX")"
fixture="aikayun-deployment-metadata-$(openssl rand -hex 12)"
cleanup() {
  if [[ "$(docker volume inspect --format '{{ index .Labels "com.aikayun.fixture" }}' "$fixture" 2>/dev/null || true)" == "$fixture" ]]; then docker volume rm "$fixture" >/dev/null; fi
  python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' "$task_dir"
}
trap cleanup EXIT
docker volume create --label "com.aikayun.fixture=$fixture" "$fixture" >/dev/null
pnpm --dir "$root" exec esbuild apps/api/test/fixtures/backup-deployment-metadata.ts --bundle --platform=node --format=esm --target=node24 --outfile="$task_dir/test.mjs" >/dev/null
docker run --rm --pull=never --network none --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777 --mount "type=bind,source=$task_dir,target=/fixture,readonly" --mount "type=volume,source=$fixture,target=/fixture-work" \
  --env NODE_ENV=test --entrypoint /usr/local/bin/node "$image_id" /fixture/test.mjs
