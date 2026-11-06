#!/usr/bin/env bash
# Isolated Linux kernel test: creates a mount only inside its disposable container.
set -Eeuo pipefail
set +x
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
image='node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c'
module="$root/apps/api/dist/backup/tmpfs-staging.js"
probe="$root/scripts/release/fixtures/backup-tmpfs-probe.mjs"
work="$(mktemp -d "${TMPDIR:-/tmp}/aikayun-enospc-bundle.XXXXXXXX")"
trap 'python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1])" "$work"' EXIT
pnpm --dir "$root" exec esbuild scripts/release/fixtures/backup-enospc-probe.ts --bundle --platform=node --format=esm --target=node24 --outfile="$work/enospc.mjs" >/dev/null
[[ -f "$module" && -f "$probe" ]] || { echo 'Build API before running the isolated tmpfs probe' >&2; exit 1; }
endpoint="$(env -i PATH="$PATH" HOME="$HOME" docker context inspect "$(env -i PATH="$PATH" HOME="$HOME" docker context show)" --format '{{ (index .Endpoints "docker").Host }}')"
[[ "$endpoint" == unix:///* && -S "${endpoint#unix://}" ]] || { echo 'Local Docker socket required' >&2; exit 1; }
env -i PATH="$PATH" HOME="$HOME" docker --host "$endpoint" run --rm --network none --cap-add SYS_ADMIN --user 0:0 \
  --mount "type=bind,source=$module,target=/test/tmpfs-staging.mjs,readonly" \
  --mount "type=bind,source=$probe,target=/test/probe.mjs,readonly" \
  --mount "type=bind,source=$work/enospc.mjs,target=/test/enospc.mjs,readonly" --entrypoint /bin/sh "$image" \
  -c 'mkdir -m 700 /stage /swap-stage /bind-stage && mount -t tmpfs -o noswap,nosuid,nodev,noexec,mode=0700,size=4m tmpfs /stage && mount -t tmpfs -o nosuid,nodev,noexec,mode=0700,size=1m tmpfs /swap-stage && mount --bind /stage /bind-stage && node /test/probe.mjs && exec node /test/enospc.mjs'
