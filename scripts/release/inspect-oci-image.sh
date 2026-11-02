#!/bin/sh
set -eu

image="${1:?Usage: inspect-oci-image.sh IMAGE PLATFORM REPORT_DIRECTORY}"
platform="${2:?Target platform is required}"
report="${3:?Report output directory is required}"
mkdir -p "$report"
temp="$(mktemp -d "${TMPDIR:-/tmp}/aikayun-image-inspect.XXXXXX")"
container="aikayun-inspect-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$temp"' EXIT INT TERM

docker save "$image" --output "$temp/image.tar"
mkdir "$temp/archive"
tar -xf "$temp/image.tar" -C "$temp/archive"
layer_index=0
: > "$report/layers.txt"
while IFS= read -r layer; do
  layer_index=$((layer_index + 1))
  printf 'LAYER %s %s\n' "$layer_index" "$layer" >> "$report/layers.txt"
  tar -tf "$temp/archive/$layer" >> "$report/layers.txt"
done <<EOF
$(jq -r '.[0].Layers[]' "$temp/archive/manifest.json")
EOF

for inventory in "$report/layers.txt"; do
  if grep -E '\.(map|d\.ts|ts)$|(^|/)\.env([./]|$)|\.(pem|key)$|\.tgz$|(^|/)\.git(/|$)|(^|/)node_modules/[^/]+/(test|tests|bench|benchmark|benchmarks|performance|perf)(/|$)|(^|/)node_modules/@[^/]+/[^/]+/(test|tests|__tests__|fixtures|docs|examples|benchmarks|performance|perf)(/|$)|^app/(src|test|tests|fixtures|docs|examples|benchmarks|performance|perf)(/|$)' "$inventory" \
    | grep -Ev '^(\./)?etc/ssl/cert\.pem$|^(\./)?etc/ssl1\.1/cert\.pem$|^(\./)?etc/ssl/certs/[^/]+\.pem$'; then
    echo 'Forbidden source, test, credential or build file was found in an OCI layer' >&2
    exit 1
  fi
done

docker history --no-trunc "$image" > "$report/history.txt"
docker create --name "$container" --platform "$platform" "$image" >/dev/null
docker export "$container" --output "$temp/final.tar"
tar -tf "$temp/final.tar" > "$report/final-files.txt"
if grep -E '\.(map|d\.ts|ts)$|(^|/)\.env([./]|$)|\.(pem|key)$|\.tgz$|(^|/)\.git(/|$)|(^|/)node_modules/[^/]+/(test|tests|bench|benchmark|benchmarks|performance|perf)(/|$)|(^|/)node_modules/@[^/]+/[^/]+/(test|tests|__tests__|fixtures|docs|examples|benchmarks|performance|perf)(/|$)|^app/(src|test|tests|fixtures|docs|examples|benchmarks|performance|perf)(/|$)' "$report/final-files.txt" \
  | grep -Ev '^(\./)?etc/ssl/cert\.pem$|^(\./)?etc/ssl1\.1/cert\.pem$|^(\./)?etc/ssl/certs/[^/]+\.pem$'; then
  echo 'Forbidden source, test, credential or build file was found in the final filesystem' >&2
  exit 1
fi
printf 'Image layer and final filesystem inspection passed: %s %s (%s layers).\n' "$image" "$platform" "$layer_index"
