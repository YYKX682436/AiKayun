#!/usr/bin/env bash
set -euo pipefail
umask 077
source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/aikayun-metadata-test.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/sbom" "$work/artifacts"
for image in api web postgres caddy backup; do
  for arch in amd64 arm64; do printf '{"fixture":"%s-%s"}\n' "$image" "$arch" > "$work/sbom/${image}-linux-${arch}.cdx.json"; done
done
version='1.2.3'
build_time='2026-11-05T00:00:00.000Z'
GITHUB_SHA=$(printf 'c%.0s' {1..40})
AIKAYUN_RELEASE_ORIGIN='https://release.vendor.com'
AIKAYUN_LICENSE_CENTER_SIGNER_KIDS='["BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"]'
a=$(printf 'a%.0s' {1..64}); b=$(printf 'b%.0s' {1..64})
api_index_ref="ghcr.io/yykx682436/aikayun-api@sha256:$a"
web_index_ref="ghcr.io/yykx682436/aikayun-web@sha256:$a"
postgres_image="docker.io/library/postgres@sha256:$a"
caddy_image="docker.io/library/caddy@sha256:$a"
backup_index_ref="ghcr.io/yykx682436/aikayun-backup-restic@sha256:$a"
for image in api web postgres caddy backup; do printf -v "${image}_amd64" 'sha256:%s' "$a"; printf -v "${image}_arm64" 'sha256:%s' "$b"; done
source "$source_root/scripts/release/write-image-metadata.sh"
write_release_image_metadata "$work/image-metadata.json"
for image in api web postgres caddy backup; do
  for arch in amd64 arm64; do
    var="${image}_${arch}"; [[ "${!var}" == sha256:* ]] || { echo 'OCI reference lost its prefix.' >&2; exit 1; }
    expected="${!var#sha256:}"
    [[ "$(jq -r --arg image "$image" --arg platform "linux/$arch" '.images[$image].platform_digests[$platform]' "$work/image-metadata.json")" == "$expected" ]]
    [[ "$(jq -r --arg image "$image" --arg platform "linux/$arch" '.images[$image].sbom_sha256[$platform]' "$work/image-metadata.json")" == "$(sha256sum "$work/sbom/${image}-linux-${arch}.cdx.json" | cut -d ' ' -f1)" ]]
  done
done
printf '{"migration_head":"202611040002_file_check_results"}' > "$work/migrations.json"
printf '{"trust_configuration_id":"11111111-1111-4111-8111-111111111111","expected_center_issuer":"https://license.vendor.com","offline_root":{"kid":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"minimum_bundle_version":"1"}' > "$work/config.json"
printf 'fixture' > "$work/artifacts/test.txt"
node "$source_root/apps/api/scripts/release/create-manifest.mjs" "$work/image-metadata.json" "$work/artifacts" "$work/migrations.json" "$work/config.json" "$work/release-manifest.json" >/dev/null
[[ "$(jq -r '.images.api.platform_digests["linux/amd64"]' "$work/release-manifest.json")" == "$a" ]]
[[ "$(jq -r '.images.backup.reference' "$work/release-manifest.json")" == "$backup_index_ref" ]]
for image in api web postgres caddy backup; do
  for arch in amd64 arm64; do
    var="${image}_${arch}"; original=${!var}; printf -v "$var" '%s' 'sha256:invalid'
    if write_release_image_metadata "$work/rejected.json" >/dev/null 2>&1; then echo "Invalid digest accepted: $var" >&2; exit 1; fi
    [[ ! -e "$work/rejected.json" ]] || { echo 'Invalid digest created metadata.' >&2; exit 1; }
    printf -v "$var" '%s' "$original"
  done
done
printf 'Passed: actual metadata and canonical manifest, preserved OCI references, ten invalid platform digests.\n'
