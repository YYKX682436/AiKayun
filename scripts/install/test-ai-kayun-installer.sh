#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

readonly repository_root="$(cd "$(dirname "$0")/../.." && pwd)"
readonly node_amd64_image='node:24.22.0-trixie-slim@sha256:0ee27270bfd2db800257dea8e1ddec262e429338eed92e9d7b10484637af6803'
readonly node_arm64_image='node:24.22.0-trixie-slim@sha256:b7225aca1e675b187e0265c549d8500019c9d6b8cb65c8ebc0018104c429b7cb'
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
  if [[ -n "${AIKAYUN_TEST_ONLY_PLATFORM:-}" && "$platform" != "$AIKAYUN_TEST_ONLY_PLATFORM" ]]; then continue; fi
  if [[ "$platform" == linux/amd64 ]]; then test_runner_image="$node_amd64_image"; else test_runner_image="$node_arm64_image"; fi
  for scenario in \
    first-install-tls-failure-resume first-install-https-ready \
    fresh-install-untrusted-code resume-untrusted-code backup-customer-command-integrity \
    release-download-failure manifest-modified root-substitution compose-image-modified \
    dns-failure disk-low ports-in-use occupied-deployment; do
    if [[ -n "${AIKAYUN_TEST_ONLY_SCENARIO:-}" && "$scenario" != "$AIKAYUN_TEST_ONLY_SCENARIO" ]]; then continue; fi
    printf 'Installer scenario: %s (%s)\n' "$scenario" "$platform"
    docker run --rm --network none --platform "$platform" \
      --mount "type=bind,source=$repository_root/scripts/install/test-ai-kayun-installer-inner.sh,target=/fixture/inner.sh,readonly" \
      --mount "type=bind,source=$release_directory,target=/fixture/release,readonly" \
      --mount "type=bind,source=$repository_root/node_modules,target=/node_modules,readonly" \
      --mount "type=bind,source=$repository_root/apps/api/node_modules,target=/fixture/node_modules,readonly" \
      --mount "type=bind,source=$repository_root/packages,target=/packages,readonly" \
      --env "AIKAYUN_TEST_EXPECTED_ARCH=${platform#linux/}" \
      --entrypoint bash "$test_runner_image" /fixture/inner.sh /fixture/release "$scenario"
  done

  for scenario in upgrade-success upgrade-incompatible upgrade-migration-mismatch \
    upgrade-trust-mismatch upgrade-signature-invalid upgrade-start-failure upgrade-lock-competition; do
    if [[ -n "${AIKAYUN_TEST_ONLY_SCENARIO:-}" && "$scenario" != "$AIKAYUN_TEST_ONLY_SCENARIO" ]]; then continue; fi
    candidate_directory="$temporary_root/$scenario-${platform#linux/}"
    mkdir -p "$candidate_directory"
    candidate_env=(AIKAYUN_TEST_RELEASE_VERSION=9.8.7-rc.4
      AIKAYUN_TEST_API_IMAGE_REFERENCE=ghcr.io/yykx682436/aikayun-api@sha256:$(printf 'e%.0s' {1..64})
      AIKAYUN_TEST_WEB_IMAGE_REFERENCE=ghcr.io/yykx682436/aikayun-web@sha256:$(printf 'f%.0s' {1..64}))
    case "$scenario" in
      upgrade-success|upgrade-start-failure|upgrade-lock-competition)
        candidate_env+=(AIKAYUN_TEST_UPGRADE_FROM_RELEASES=aikayun-9.8.7-rc.3
          AIKAYUN_TEST_ROLLBACK_TO_RELEASES=aikayun-9.8.7-rc.3) ;;
      upgrade-migration-mismatch)
        printf '{"schema":1,"migration_head":"202611030003_changed","migrations":[]}\n' \
          > "$temporary_root/migration-checksums-changed.json"
        candidate_env+=(AIKAYUN_TEST_UPGRADE_FROM_RELEASES=aikayun-9.8.7-rc.3
          AIKAYUN_TEST_ROLLBACK_TO_RELEASES=aikayun-9.8.7-rc.3
          AIKAYUN_TEST_MIGRATION_CHECKSUMS_FILE="$temporary_root/migration-checksums-changed.json") ;;
      upgrade-trust-mismatch)
        candidate_env+=(AIKAYUN_TEST_UPGRADE_FROM_RELEASES=aikayun-9.8.7-rc.3
          AIKAYUN_TEST_ROLLBACK_TO_RELEASES=aikayun-9.8.7-rc.3
          AIKAYUN_TEST_TRUST_CONFIGURATION_ID=66666666-6666-4666-8666-666666666666) ;;
      upgrade-incompatible|upgrade-signature-invalid) ;;
    esac
    env "${candidate_env[@]}" node "$repository_root/scripts/install/create-installer-test-release.mjs" "$candidate_directory"
    if [[ "$scenario" == upgrade-signature-invalid ]]; then
      printf 'controlled invalid candidate signature\n' > "$candidate_directory/release/release-manifest.jws"
    fi
    printf 'Installer scenario: %s (%s)\n' "$scenario" "$platform"
    docker run --rm --network none --platform "$platform" \
      --mount "type=bind,source=$repository_root/scripts/install/test-ai-kayun-installer-inner.sh,target=/fixture/inner.sh,readonly" \
      --mount "type=bind,source=$release_directory,target=/fixture/release,readonly" \
      --mount "type=bind,source=$candidate_directory/release,target=/fixture/candidate,readonly" \
      --mount "type=bind,source=$repository_root/node_modules,target=/node_modules,readonly" \
      --mount "type=bind,source=$repository_root/apps/api/node_modules,target=/fixture/node_modules,readonly" \
      --mount "type=bind,source=$repository_root/packages,target=/packages,readonly" \
      --env "AIKAYUN_TEST_EXPECTED_ARCH=${platform#linux/}" \
      --entrypoint bash "$test_runner_image" /fixture/inner.sh /fixture/release "$scenario" /fixture/candidate
  done
done
