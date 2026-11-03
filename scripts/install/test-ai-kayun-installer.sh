#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

readonly repository_root="$(cd "$(dirname "$0")/../.." && pwd)"
readonly node_image='node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c'
readonly temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/aikayun-installer-real-flow.XXXXXX")"
cleanup() {
  status=$?
  rm -rf "$temporary_root"
  return "$status"
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null 2>&1 || { printf 'Docker is required for the isolated Linux installer test.\n' >&2; exit 2; }
command -v pnpm >/dev/null 2>&1 || { printf 'pnpm is required to construct the isolated release fixture.\n' >&2; exit 2; }
release_directory="$(node "$repository_root/scripts/install/create-installer-test-release.mjs" "$temporary_root")"

for platform in linux/amd64 linux/arm64; do
  for scenario in \
    first-install-tls-failure-resume first-install-https-ready \
    release-download-failure manifest-modified root-substitution compose-image-modified \
    dns-failure disk-low ports-in-use occupied-deployment; do
    printf 'Installer scenario: %s (%s)\n' "$scenario" "$platform"
    docker run --rm --network none --platform "$platform" \
      --mount "type=bind,source=$repository_root/scripts/install/test-ai-kayun-installer-inner.sh,target=/fixture/inner.sh,readonly" \
      --mount "type=bind,source=$release_directory,target=/fixture/release,readonly" \
      --env "AIKAYUN_TEST_EXPECTED_ARCH=${platform#linux/}" \
      --entrypoint bash "$node_image" /fixture/inner.sh /fixture/release "$scenario"
  done
done
