#!/usr/bin/env bash
set -euo pipefail
umask 077

version="${1:?Usage: build-release-candidate.sh VERSION PUBLISH-CONFIRMATION}"
confirmation="${2:?Usage: build-release-candidate.sh VERSION PUBLISH-CONFIRMATION}"
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
release_id="aikayun-${version}"
center_commit="$(tr -d '\n' < "$source_root/scripts/release/license-center-release-commit.txt")"
node_base='node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c'
postgres_staging_image='ghcr.io/yykx682436/aikayun-staging-api@sha256:b36f0783117de373b3ce8db84fc2187cee285c2af80fbca5f230f1b9eda3c192'
postgres_image='ghcr.io/yykx682436/aikayun-postgres@sha256:b36f0783117de373b3ce8db84fc2187cee285c2af80fbca5f230f1b9eda3c192'
caddy_image='docker.io/library/caddy@sha256:78bd35025c7ba85961dd149ae670315129954e77abe2383ac47c89106b35ade9'
syft_image='anchore/syft@sha256:825cad3a952c87676a6d07e9a3bb05ac9c401d598360070e970aa46d54c1727e'
trivy_image='aquasec/trivy@sha256:33f816d414b9d582d25bb737ffa4a632ae34e222f7ec1b50252cef0ce2266006'
skopeo_image='quay.io/skopeo/stable@sha256:87a0dd8d9a093c87681706a2cb8ae51757af8c12340f04ab024c85badc6dcc07'
go_toolchain_image='golang@sha256:c65ecfe613b539ac74c62a4c3b2c27e8f8a6076384c8f27e8a3c0f3be17cc385'
owner="${GITHUB_REPOSITORY_OWNER,,}"
release_tag="v${version}"
api_repository="ghcr.io/${owner}/aikayun-api"
web_repository="ghcr.io/${owner}/aikayun-web"
postgres_repository="ghcr.io/${owner}/aikayun-postgres"
backup_repository="ghcr.io/${owner}/aikayun-backup-restic"
bundle_repository="ghcr.io/${owner}/aikayun-release-bundle"
staging_api_repository="ghcr.io/${owner}/aikayun-staging-api"
staging_web_repository="ghcr.io/${owner}/aikayun-staging-web"
staging_backup_repository="ghcr.io/${owner}/aikayun-staging-backup-restic"
staging_bundle_repository="ghcr.io/${owner}/aikayun-staging-release-bundle"
staging_tag="${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"

work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/aikayun-release-${version//[^A-Za-z0-9.-]/_}.XXXXXX")"
scan_report_dir="${RUNNER_TEMP:-/tmp}/aikayun-release-scan-reports-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
export AIKAYUN_GO_LICENSE_CACHE_DIR="$work/go-license-cache"
release_key_file="$work/release-signing-key.pem"
registry_logged_in=0
cleanup() {
  status=$?
  unset AIKAYUN_RELEASE_SIGNING_KEY_PASSWORD AIKAYUN_RELEASE_SIGNING_KEY_PEM \
    AIKAYUN_TRUSTED_LICENSE_CONFIG_BASE64 AIKAYUN_TRUSTED_LICENSE_BUNDLE_BASE64
  unset GH_TOKEN
  if [[ "$registry_logged_in" == 1 ]]; then docker logout ghcr.io >/dev/null 2>&1 || true; fi
  rm -f "$release_key_file"
  if [[ "$status" == 0 ]]; then rm -rf "$scan_report_dir"; fi
  rm -rf "$work"
  return "$status"
}
trap cleanup EXIT INT TERM

fail() { printf '%s\n' "$1" >&2; exit 1; }
need() { [[ -n "${!1:-}" ]] || fail "Required protected release setting is missing: $1"; }

[[ "${GITHUB_REF:-}" == 'refs/heads/main' ]] || fail 'Release workflow must run from main.'
[[ "$(git -C "$source_root" rev-parse HEAD)" == "${GITHUB_SHA:-}" ]] || fail 'Checked-out source does not match the workflow commit.'
[[ -z "$(git -C "$source_root" status --porcelain)" ]] || fail 'Release source checkout must be clean.'
[[ "$center_commit" =~ ^[a-f0-9]{40}$ ]] || fail 'Pinned authorization-center source commit is invalid.'
node --input-type=module -e 'import { isCanonicalReleaseSemVer } from "./apps/api/scripts/release/manifest.mjs"; if (!isCanonicalReleaseSemVer(process.argv[1])) process.exit(1)' "$version" || \
  fail 'Release version must be canonical OCI-compatible SemVer without build metadata.'
node --input-type=module -e '
  import { isCanonicalReleaseSemVer } from "./apps/api/scripts/release/manifest.mjs";
  const current = `aikayun-${process.argv[1]}`;
  for (const value of process.argv.slice(2)) {
    const ids = value ? value.split(",") : [];
    if (new Set(ids).size !== ids.length || ids.some(id => id.length > 64 || !id.startsWith("aikayun-") ||
      !isCanonicalReleaseSemVer(id.slice("aikayun-".length)) || id === current)) process.exit(1);
  }
' "$version" "${AIKAYUN_UPGRADE_FROM_RELEASES:-}" "${AIKAYUN_ROLLBACK_TO_RELEASES:-}" || \
  fail 'Upgrade and rollback release inputs must be unique comma-separated signed release IDs.'
[[ "$confirmation" == "PUBLISH-${version}" ]] || fail 'Release confirmation text does not match the requested version.'
[[ "${GITHUB_REPOSITORY,,}" == 'yykx682436/aikayun' ]] || fail 'Unexpected GitHub source repository.'
[[ ! -e "$scan_report_dir" ]] || fail 'A scan-report directory for this workflow attempt already exists.'
mkdir -m 0700 "$scan_report_dir"
for name in AIKAYUN_RELEASE_SIGNING_KEY_PEM AIKAYUN_RELEASE_SIGNING_KEY_PASSWORD AIKAYUN_RELEASE_PUBLIC_KEY_JWK \
  AIKAYUN_TRUSTED_LICENSE_CONFIG_BASE64 AIKAYUN_TRUSTED_LICENSE_BUNDLE_BASE64 \
  AIKAYUN_PRODUCTION_LICENSE_ISSUER AIKAYUN_PRODUCTION_LICENSE_ROOT_KID \
  AIKAYUN_LICENSE_CENTER_SIGNER_KIDS AIKAYUN_RELEASE_ORIGIN GH_TOKEN; do need "$name"; done
[[ "$(gh api "/repos/${GITHUB_REPOSITORY}" --jq .visibility)" == public ]] || fail 'The source repository must be public.'
"$source_root/scripts/release/check-release-policy.sh" >/dev/null
printf '%s' "$AIKAYUN_TRUSTED_LICENSE_CONFIG_BASE64" | base64 --decode > "$work/trusted-license-config.json" || \
  fail 'The production authorization config is not valid base64.'
chmod 0600 "$work/trusted-license-config.json"
printf '%s' "$AIKAYUN_TRUSTED_LICENSE_BUNDLE_BASE64" | base64 --decode > "$work/license-trust-bundle.jws" || \
  fail 'The root-signed Trust Bundle is not valid base64.'
chmod 0600 "$work/license-trust-bundle.jws"
pnpm --filter @aikayun/api exec tsx scripts/release/verify-trust-bundle.ts \
  "$work/trusted-license-config.json" "$work/license-trust-bundle.jws" >/dev/null || \
  fail 'The Trust Bundle does not match the release-pinned root, issuer, minimum version and validity window.'
printf '%s' "$AIKAYUN_RELEASE_SIGNING_KEY_PEM" > "$release_key_file"
chmod 0600 "$release_key_file"

mkdir -p "$work/license-config-check"
AIKAYUN_RELEASE_ID="$release_id" AIKAYUN_RELEASE_VERSION="$version" \
AIKAYUN_TRUSTED_LICENSE_CONFIG_BASE64="$AIKAYUN_TRUSTED_LICENSE_CONFIG_BASE64" \
AIKAYUN_REQUIRE_LICENSE_CONFIG=true AIKAYUN_PRODUCTION_LICENSE_ISSUER="$AIKAYUN_PRODUCTION_LICENSE_ISSUER" \
AIKAYUN_PRODUCTION_LICENSE_ROOT_KID="$AIKAYUN_PRODUCTION_LICENSE_ROOT_KID" \
AIKAYUN_RELEASE_GENERATED_OUTPUT_DIR="$work/license-config-check" \
  node "$source_root/apps/api/scripts/prepare-release-build.mjs" >/dev/null

fake_config="$(node --input-type=module -e '
  const x = Buffer.alloc(32).toString("base64url");
  const config = { schema_version: 1, trust_configuration_id: "55555555-5555-4555-8555-555555555555",
    release_id: process.argv[1], expected_center_issuer: "https://license.example.test",
    expected_center_origin: "https://license.example.test", offline_root: { kid: "A".repeat(43),
      publicJwk: { kty: "OKP", crv: "Ed25519", x } }, minimum_bundle_version: "1" };
  process.stdout.write(Buffer.from(JSON.stringify(config)).toString("base64"));
' "$release_id")"
if AIKAYUN_RELEASE_ID="$release_id" AIKAYUN_RELEASE_VERSION="$version" \
  AIKAYUN_TRUSTED_LICENSE_CONFIG_BASE64="$fake_config" AIKAYUN_REQUIRE_LICENSE_CONFIG=true \
  AIKAYUN_PRODUCTION_LICENSE_ISSUER='https://license.example.test' AIKAYUN_PRODUCTION_LICENSE_ROOT_KID='0000000000000000000000000000000000000000000' \
  AIKAYUN_RELEASE_GENERATED_OUTPUT_DIR="$work/test-root-check" \
  node "$source_root/apps/api/scripts/prepare-release-build.mjs" > "$work/test-root-check.stdout" 2> "$work/test-root-check.stderr"; then
  fail 'A test authorization issuer unexpectedly passed the commercial image build gate.'
fi
grep -q 'non-test HTTPS origin' "$work/test-root-check.stderr" || fail 'The commercial build gate did not reject a test issuer.'

node "$source_root/scripts/release/verify-origin.mjs" "$AIKAYUN_RELEASE_ORIGIN" >/dev/null
origin_status="$(curl --proto '=https' --tlsv1.2 --silent --show-error --output /dev/null \
  --write-out '%{http_code}' --head "${AIKAYUN_RELEASE_ORIGIN%/}/releases/${version}/release-index.json")"
[[ "$origin_status" == 404 ]] || fail 'The public release path already exists or could not be proven unused.'
if git -C "$source_root" ls-remote --exit-code --tags origin "refs/tags/${release_tag}" >/dev/null 2>&1; then
  fail "Release tag already exists: ${release_tag}"
else
  result=$?
  [[ "$result" == 2 ]] || fail 'Could not prove the source release tag is unused.'
fi
printf '%s' "$GH_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin >/dev/null
registry_logged_in=1
owner_type="$(gh api "/users/${GITHUB_REPOSITORY_OWNER}" --jq .type)"
for package in aikayun-staging-api aikayun-staging-web aikayun-staging-backup-restic aikayun-staging-release-bundle; do
  if [[ "$owner_type" == Organization ]]; then path="/orgs/${GITHUB_REPOSITORY_OWNER}/packages/container/${package}"; else path="/user/packages/container/${package}"; fi
  visibility="$(gh api "$path" --jq .visibility)"
  [[ "$visibility" == private ]] || fail "The required staging package must already exist and remain private: $package"
done
for repository in "$api_repository" "$web_repository" "$backup_repository" "$bundle_repository"; do
  set +e
  docker manifest inspect "${repository}:${version}" > "$work/tag-check.stdout" 2> "$work/tag-check.stderr"
  status=$?
  set -e
  if [[ "$status" == 0 ]]; then fail "OCI release tag already exists: ${repository}:${version}"; fi
  if ! grep -Eqi 'no such manifest|manifest unknown|MANIFEST_UNKNOWN' "$work/tag-check.stderr"; then
    cat "$work/tag-check.stderr" >&2
    fail "Could not prove the OCI release tag is unused: ${repository}:${version}"
  fi
done
pnpm audit --audit-level high
builder_driver="$(docker buildx inspect --bootstrap | awk '$1 == "Driver:" { print $2 }')"
[[ "$builder_driver" == docker-container ]] || fail 'Release requires the Actions multi-platform Buildx builder.'

# A build failure after this append-only reservation consumes the version.
git -C "$source_root" config user.name 'github-actions[bot]'
git -C "$source_root" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git -C "$source_root" tag -a "$release_tag" -m "AiKayun ${version} immutable release candidate"
git -C "$source_root" push origin "refs/tags/${release_tag}"

build_time="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
mkdir -p "$work/support" "$work/sbom" "$work/notices" "$work/inspection" "$work/trivy-cache" "$work/tmp"

build_args=(--build-arg "AIKAYUN_RELEASE_ID=${release_id}" --build-arg "AIKAYUN_RELEASE_VERSION=${version}" \
  --build-arg "AIKAYUN_SOURCE_COMMIT=${GITHUB_SHA}")
docker buildx build --platform linux/amd64,linux/arm64 --push --sbom=true --provenance=false \
  --metadata-file "$work/api-build-metadata.json" \
  --secret "id=aikayun-trusted-license-config,src=$work/trusted-license-config.json" \
  "${build_args[@]}" --build-arg AIKAYUN_REQUIRE_LICENSE_CONFIG=true \
  --build-arg "AIKAYUN_PRODUCTION_LICENSE_ISSUER=${AIKAYUN_PRODUCTION_LICENSE_ISSUER}" \
  --build-arg "AIKAYUN_PRODUCTION_LICENSE_ROOT_KID=${AIKAYUN_PRODUCTION_LICENSE_ROOT_KID}" \
  --tag "${staging_api_repository}:${staging_tag}" -f "$source_root/apps/api/Dockerfile" "$source_root"
docker buildx build --platform linux/amd64,linux/arm64 --push --sbom=true --provenance=false \
  --metadata-file "$work/web-build-metadata.json" "${build_args[@]}" \
  --tag "${staging_web_repository}:${staging_tag}" -f "$source_root/apps/web/Dockerfile" "$source_root"
docker buildx build --platform linux/amd64,linux/arm64 --push --sbom=true --provenance=false \
  --metadata-file "$work/backup-build-metadata.json" "${build_args[@]}" --target restic-runtime \
  --tag "${staging_backup_repository}:${staging_tag}" -f "$source_root/apps/api/Dockerfile" "$source_root"
api_index_digest="$(jq -er '.["containerimage.digest"] | select(test("^sha256:[a-f0-9]{64}$"))' "$work/api-build-metadata.json")"
web_index_digest="$(jq -er '.["containerimage.digest"] | select(test("^sha256:[a-f0-9]{64}$"))' "$work/web-build-metadata.json")"
api_staging_index_ref="${staging_api_repository}@${api_index_digest}"
web_staging_index_ref="${staging_web_repository}@${web_index_digest}"
api_index_ref="${api_repository}@${api_index_digest}"
web_index_ref="${web_repository}@${web_index_digest}"
backup_index_digest="$(jq -er '.["containerimage.digest"] | select(test("^sha256:[a-f0-9]{64}$"))' "$work/backup-build-metadata.json")"
backup_staging_index_ref="${staging_backup_repository}@${backup_index_digest}"
backup_index_ref="${backup_repository}@${backup_index_digest}"
docker buildx imagetools inspect --raw "$api_staging_index_ref" > "$work/api-index.json"
docker buildx imagetools inspect --raw "$web_staging_index_ref" > "$work/web-index.json"
docker buildx imagetools inspect --raw "$backup_staging_index_ref" > "$work/backup-index.json"
docker buildx imagetools inspect --raw "$postgres_staging_image" > "$work/postgres-index.json"
docker buildx imagetools inspect --raw "$caddy_image" > "$work/caddy-index.json"

digest_for() {
  local image_name="$1" platform="$2" arch="${2#linux/}"
  jq -er --arg arch "$arch" '.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch) | .digest | select(test("^sha256:[a-f0-9]{64}$"))' \
    "$work/${image_name}-index.json"
}
api_amd64="$(digest_for api linux/amd64)"; api_arm64="$(digest_for api linux/arm64)"
web_amd64="$(digest_for web linux/amd64)"; web_arm64="$(digest_for web linux/arm64)"
postgres_amd64="$(digest_for postgres linux/amd64)"; postgres_arm64="$(digest_for postgres linux/arm64)"
caddy_amd64="$(digest_for caddy linux/amd64)"; caddy_arm64="$(digest_for caddy linux/arm64)"
backup_amd64="$(digest_for backup linux/amd64)"; backup_arm64="$(digest_for backup linux/arm64)"

for platform in linux/amd64 linux/arm64; do
  arch="${platform#linux/}"
  for image_name in api web postgres caddy backup; do
    case "$image_name:$arch" in
      api:amd64) repository="$staging_api_repository"; child="$api_amd64" ;;
      api:arm64) repository="$staging_api_repository"; child="$api_arm64" ;;
      web:amd64) repository="$staging_web_repository"; child="$web_amd64" ;;
      web:arm64) repository="$staging_web_repository"; child="$web_arm64" ;;
      postgres:amd64) repository="$staging_api_repository"; child="$postgres_amd64" ;;
      postgres:arm64) repository="$staging_api_repository"; child="$postgres_arm64" ;;
      caddy:amd64) repository='docker.io/library/caddy'; child="$caddy_amd64" ;;
      caddy:arm64) repository='docker.io/library/caddy'; child="$caddy_arm64" ;;
      backup:amd64) repository="$staging_backup_repository"; child="$backup_amd64" ;;
      backup:arm64) repository="$staging_backup_repository"; child="$backup_arm64" ;;
    esac
    image_ref="${repository}@${child}"
    tar_path="$work/${image_name}-${arch}.tar"
    sbom_path="$work/sbom/${image_name}-${platform//\//-}.cdx.json"
    docker pull --platform "$platform" "$image_ref"
    docker save --output "$tar_path" "$image_ref"
    docker run --rm --user "$(id -u):$(id -g)" -e HOME=/work -e TMPDIR=/work/tmp -v "$work:/work" "$syft_image" \
      "docker-archive:/work/$(basename "$tar_path")" -o "cyclonedx-json=/work/sbom/$(basename "$sbom_path")"
    # Do not ship the experimental helper before its complete image/license
    # evidence chain is integrated into the signed release workflow.
    if [[ "$image_name" == api ]]; then
      node "$source_root/scripts/release/reject-unverified-restic-helper.mjs" "$sbom_path"
    fi
    "$source_root/scripts/release/scan-oci-image.sh" "$image_name" "$platform" "$image_ref" \
      "$tar_path" "$trivy_image" "$work" "$scan_report_dir"
    chmod 0644 "$sbom_path"
    "$source_root/scripts/release/inspect-oci-image.sh" "$image_ref" "$platform" \
      "$work/inspection/${image_name}-${arch}"

    container_id="$(docker create --platform "$platform" "$image_ref")"
    modules_dir="$work/runtime-modules-${image_name}-${arch}"
    system_notice_root="$work/runtime-system-notices-${image_name}-${arch}"
    mkdir -p "$modules_dir" "$system_notice_root/nodejs" "$system_notice_root/lib/apk/db"
    for system_path in /usr/share/doc /usr/share/common-licenses /usr/share/licenses; do
      docker cp "$container_id:$system_path" "$system_notice_root/" >/dev/null 2>&1 || true
    done
    docker cp "$container_id:/nodejs/LICENSE" "$system_notice_root/nodejs/" >/dev/null 2>&1 || true
    docker cp "$container_id:/lib/apk/db/installed" "$system_notice_root/lib/apk/db/installed" \
      >/dev/null 2>&1 || true
    backup_binary_from_image=''
    if [[ "$image_name" == backup ]]; then
      backup_binary_from_image="$work/backup-restic-image-${arch}"
      docker cp "$container_id:/usr/bin/restic" "$backup_binary_from_image"
    fi
    if [[ "$image_name" == api || "$image_name" == web ]]; then
      if [[ "$image_name" == api ]]; then
        docker cp "$container_id:/app/node_modules" "$modules_dir/"
      else
        docker cp "$container_id:/app/server/node_modules" "$modules_dir/node_modules"
      fi
    fi
    docker rm "$container_id" >/dev/null
    if [[ "$image_name" == backup ]]; then
      evidence_root="$work/restic-evidence-${arch}"
      docker buildx build --platform "$platform" --target restic-evidence --output "type=local,dest=$evidence_root" \
        -f "$source_root/apps/api/Dockerfile" "$source_root"
      cmp -s "$backup_binary_from_image" "$evidence_root/restic" || fail 'The scanned backup image binary differs from its license evidence build.'
      docker pull "$go_toolchain_image" >/dev/null
      node "$source_root/scripts/release/prepare-backup-reader-notice.mjs" "$sbom_path" "$evidence_root" \
        "$system_notice_root" "${backup_repository}@${child}" "$arch" "$work/notices/NOTICE-image-backup-${platform//\//-}.txt"
    else
      node "$source_root/scripts/release/generate-sbom-notice.mjs" "$sbom_path" \
        "$work/notices/NOTICE-image-${image_name}-${platform//\//-}.txt" "$image_ref" "$system_notice_root"
    fi
    if [[ "$image_name" == api || "$image_name" == web ]]; then
      node "$source_root/apps/api/scripts/release/generate-notice.mjs" \
        "$modules_dir/node_modules" "$work/notices/NOTICE-${image_name}-${platform//\//-}.txt" \
        "$source_root/node_modules/.pnpm"
    fi
  done
done

for platform in linux/amd64 linux/arm64; do
  AIKAYUN_VALIDATION_POSTGRES_IMAGE="${staging_api_repository}@$(digest_for postgres "$platform")" \
  AIKAYUN_VALIDATION_CADDY_IMAGE="${caddy_image%@*}@$(digest_for caddy "$platform")" \
    "$source_root/scripts/release/test-runtime-platform.sh" "$platform" \
    "${staging_api_repository}@$(digest_for api "$platform")" "${staging_web_repository}@$(digest_for web "$platform")" \
    '202611100002_payment_expiry_and_refund_completion'
done
migration_path="$work/migration-checksums.json"
container_id="$(docker create --platform linux/amd64 "${staging_api_repository}@${api_amd64}")"
docker cp "$container_id:/app/dist/db/migration-checksums.json" "$migration_path"
docker rm "$container_id" >/dev/null
migration_head="$(jq -er '.migration_head | select(test("^[0-9]{12}_[A-Za-z0-9_-]+$"))' "$migration_path")"
[[ "$migration_head" == '202611100002_payment_expiry_and_refund_completion' ]] || fail 'Release migration head differs from the reviewed matrix.'

# The signed manifest schema stores platform hashes without the OCI prefix.
# Keep the original prefixed variables for staging pulls and scan references.
source "$source_root/scripts/release/write-image-metadata.sh"
write_release_image_metadata "$work/image-metadata.json"

cp "$work/sbom/"*.cdx.json "$work/support/"
cp "$work/notices/"NOTICE-*.txt "$work/support/"
cp "$work/license-trust-bundle.jws" "$work/support/license-trust-bundle.jws"
node "$source_root/apps/api/scripts/release/cli.mjs" public-key "$release_key_file" \
  "$work/support/release-signing-root.jwk.json" >/dev/null
pnpm exec esbuild "$source_root/apps/api/scripts/release/verify-only.mjs" --bundle --platform=node --format=esm --target=node24 \
  --outfile="$work/support/release-verifier.mjs"
pnpm exec esbuild "$source_root/apps/api/scripts/release/verify-artifacts.mjs" --bundle --platform=node --format=esm --target=node24 \
  --outfile="$work/support/verify-artifacts.mjs"
cp "$source_root/scripts/release/backup-host-broker.sh" "$work/support/backup-host-broker.sh"
chmod 0644 "$work/support/backup-host-broker.sh"
cp "$source_root/scripts/release/compose.restore-isolated.yaml" "$work/support/compose.restore-isolated.yaml"
chmod 0644 "$work/support/compose.restore-isolated.yaml"
release_dir="$work/release-package"
node "$source_root/apps/api/scripts/release/assemble-release.mjs" "$work/image-metadata.json" \
  "$work/trusted-license-config.json" "$migration_path" "$work/support" "$release_dir"
node "$source_root/apps/api/scripts/release/create-manifest.mjs" "$work/image-metadata.json" \
  "$release_dir" "$migration_path" "$work/trusted-license-config.json" "$release_dir/release-manifest.json"
AIKAYUN_RELEASE_SIGNING_KEY_PASSWORD="$AIKAYUN_RELEASE_SIGNING_KEY_PASSWORD" \
  node "$source_root/apps/api/scripts/release/cli.mjs" sign "$release_dir/release-manifest.json" \
  "$release_dir/release-manifest.jws" "$release_key_file" > "$work/jws-signature.json"
node "$source_root/apps/api/scripts/release/cli.mjs" verify "$release_dir/release-manifest.json" \
  "$release_dir/release-manifest.jws" "$work/support/release-signing-root.jwk.json" > "$work/jws-verified.json"
node "$source_root/apps/api/scripts/release/verify-artifacts.mjs" "$release_dir/release-manifest.json" \
  "$release_dir" > "$work/artifacts-verified.json"

cosign sign-blob --yes --bundle "$release_dir/release-manifest.cosign.bundle" \
  "$release_dir/release-manifest.json" >/dev/null
release_identity="https://github.com/${GITHUB_REPOSITORY}/.github/workflows/release.yml@refs/heads/main"
cosign verify-blob --bundle "$release_dir/release-manifest.cosign.bundle" \
  --certificate-identity "$release_identity" --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$release_dir/release-manifest.json" >/dev/null
cp "$release_dir/release-manifest.json" "$work/replaced-manifest.json"
printf '\n' >> "$work/replaced-manifest.json"
if cosign verify-blob --bundle "$release_dir/release-manifest.cosign.bundle" \
  --certificate-identity "$release_identity" --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$work/replaced-manifest.json" >/dev/null 2>&1; then
  fail 'Cosign unexpectedly accepted a replaced release manifest.'
fi

docker buildx build --platform linux/amd64,linux/arm64 --push --provenance=false \
  --metadata-file "$work/bundle-build-metadata.json" \
  --build-arg "AIKAYUN_RELEASE_ID=${release_id}" --build-arg "AIKAYUN_RELEASE_VERSION=${version}" \
  --build-arg "AIKAYUN_SOURCE_COMMIT=${GITHUB_SHA}" --tag "${staging_bundle_repository}:${staging_tag}" \
  -f "$source_root/apps/api/scripts/release/ReleasePackage.Dockerfile" "$release_dir"
bundle_digest="$(jq -er '.["containerimage.digest"] | select(test("^sha256:[a-f0-9]{64}$"))' "$work/bundle-build-metadata.json")"
bundle_staging_ref="${staging_bundle_repository}@${bundle_digest}"
"$source_root/scripts/release/extract-oci-bundle.sh" "$bundle_staging_ref" \
  "$work/bundle-extracted" "$version" >/dev/null
diff -qr "$release_dir" "$work/bundle-extracted" >/dev/null || fail 'Extracted OCI bundle differs from the verified release package.'
node "$work/bundle-extracted/release-verifier.mjs" "$work/bundle-extracted/release-manifest.json" \
  "$work/bundle-extracted/release-manifest.jws" "$work/bundle-extracted/release-signing-root.jwk.json" \
  > "$work/extracted-bundle-jws-verification.json"
node "$work/bundle-extracted/verify-artifacts.mjs" "$work/bundle-extracted/release-manifest.json" \
  "$work/bundle-extracted" > "$work/extracted-bundle-artifact-verification.json"

api_promoted_digest="$("$source_root/scripts/release/promote-scanned-oci-image.sh" \
  "$api_staging_index_ref" "$api_repository" "$version" "$scan_report_dir" "$work" "$skopeo_image")"
web_promoted_digest="$("$source_root/scripts/release/promote-scanned-oci-image.sh" \
  "$web_staging_index_ref" "$web_repository" "$version" "$scan_report_dir" "$work" "$skopeo_image")"
postgres_promoted_digest="$("$source_root/scripts/release/promote-scanned-oci-image.sh" \
  "$postgres_staging_image" "$postgres_repository" "$version" "$scan_report_dir" "$work" "$skopeo_image")"
backup_promoted_digest="$("$source_root/scripts/release/promote-scanned-oci-image.sh" \
  "$backup_staging_index_ref" "$backup_repository" "$version" "$scan_report_dir" "$work" "$skopeo_image")"
bundle_promoted_digest="$("$source_root/scripts/release/promote-scanned-oci-image.sh" \
  "$bundle_staging_ref" "$bundle_repository" "$version" "$scan_report_dir" "$work" "$skopeo_image")"
[[ "$api_promoted_digest" == "$api_index_digest" && "$web_promoted_digest" == "$web_index_digest" && \
  "$postgres_promoted_digest" == "${postgres_image##*@}" && \
  "$backup_promoted_digest" == "$backup_index_digest" && \
  "$bundle_promoted_digest" == "$bundle_digest" ]] || fail 'OCI promotion did not preserve the verified staging digests.'
cosign sign --yes "$api_index_ref" >/dev/null
cosign sign --yes "$web_index_ref" >/dev/null
cosign sign --yes "$postgres_image" >/dev/null
cosign sign --yes "$backup_index_ref" >/dev/null
cosign sign --yes "${bundle_repository}@${bundle_digest}" >/dev/null

printf 'Signed release packages are ready. Set the five GHCR packages to Public in GitHub package settings; waiting up to one hour.\n'
all_public=0
for attempt in $(seq 1 240); do
  all_public=1
  for package in aikayun-api aikayun-web aikayun-postgres aikayun-backup-restic aikayun-release-bundle; do
    if [[ "$owner_type" == Organization ]]; then path="/orgs/${GITHUB_REPOSITORY_OWNER}/packages/container/${package}"; else path="/user/packages/container/${package}"; fi
    visibility="$(gh api "$path" --jq .visibility)"
    if [[ "$visibility" != public ]]; then all_public=0; break; fi
  done
  [[ "$all_public" == 1 ]] && break
  sleep 15
done
[[ "$all_public" == 1 ]] || fail 'Signed GHCR release packages were not made public within one hour.'

docker logout ghcr.io >/dev/null
registry_logged_in=0
for image in "$api_index_ref" "$web_index_ref" "$postgres_image" "$backup_index_ref" "${bundle_repository}@${bundle_digest}"; do docker pull "$image" >/dev/null; done
for image in "$api_index_ref" "$web_index_ref" "$postgres_image" "$backup_index_ref" "${bundle_repository}@${bundle_digest}"; do
  cosign verify --certificate-identity "$release_identity" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com "$image" >/dev/null
done
docker run --rm -v "$release_dir:/release:ro" --entrypoint node "$node_base" \
  /release/release-verifier.mjs /release/release-manifest.json /release/release-manifest.jws \
  /release/release-signing-root.jwk.json > "$work/independent-jws-verification.json"
docker run --rm -v "$release_dir:/release:ro" --entrypoint node "$node_base" \
  /release/verify-artifacts.mjs /release/release-manifest.json /release > "$work/independent-artifact-verification.json"

node "$source_root/scripts/release/publish-static-release.mjs" "$release_dir" "$version" > "$work/static-publish.json"
customer_download="$work/customer-linux-download"
mkdir -p "$customer_download"
download_base="${AIKAYUN_RELEASE_ORIGIN%/}/releases/${version}/"
for name in release-manifest.json release-manifest.jws release-manifest.cosign.bundle release-signing-root.jwk.json; do
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --max-redirs 0 \
    "${download_base}${name}" --output "$customer_download/$name"
done
while IFS= read -r artifact; do
  [[ "$artifact" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ && "$artifact" != *'..'* ]] || fail 'Release manifest contains an unsafe download path.'
  mkdir -p "$customer_download/$(dirname "$artifact")"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --max-redirs 0 \
    "${download_base}${artifact}" --output "$customer_download/$artifact"
done < <(jq -r '.artifacts[].name' "$customer_download/release-manifest.json")
env -u GH_TOKEN -u GITHUB_TOKEN cosign verify-blob \
  --bundle "$customer_download/release-manifest.cosign.bundle" \
  --certificate-identity "$release_identity" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$customer_download/release-manifest.json" >/dev/null
docker run --rm -v "$customer_download:/release:ro" --entrypoint node "$node_base" \
  /release/release-verifier.mjs /release/release-manifest.json /release/release-manifest.jws \
  /release/release-signing-root.jwk.json > "$work/customer-linux-jws-verification.json"
docker run --rm -v "$customer_download:/release:ro" --entrypoint node "$node_base" \
  /release/verify-artifacts.mjs /release/release-manifest.json /release \
  > "$work/customer-linux-artifact-verification.json"
manifest_sha256="$(jq -er '.manifest_sha256' "$work/jws-verified.json")"
printf '%s\n' "Release ID: ${release_id}" "Source: ${GITHUB_SHA}" "Manifest SHA-256: ${manifest_sha256}" \
  "API image: ${api_index_ref}" "Web image: ${web_index_ref}" "Backup reader image: ${backup_index_ref}" "Release bundle: ${bundle_repository}@${bundle_digest}" \
  'Anonymous GHCR and HTTPS verification: passed' >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
printf 'Commercial release candidate gates passed: %s (%s)\n' "$release_id" "$manifest_sha256"
