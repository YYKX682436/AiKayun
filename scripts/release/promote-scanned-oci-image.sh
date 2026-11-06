#!/usr/bin/env bash
set -euo pipefail
set +x

source_ref="${1:?Usage: promote-scanned-oci-image.sh SOURCE@DIGEST DESTINATION_REPOSITORY TAG REPORT_DIR WORK_DIR SKOPEO_IMAGE}"
destination_repository="${2:?Destination repository is required}"
tag="${3:?Immutable release tag is required}"
report_dir="${4:?Sanitized report directory is required}"
work_dir="${5:?Temporary work directory is required}"
skopeo_image="${6:?Pinned Skopeo image is required}"

[[ "$source_ref" =~ ^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$ ]] || { echo 'Staging source must be digest-pinned.' >&2; exit 2; }
[[ "$destination_repository" =~ ^[A-Za-z0-9._:/-]+$ && "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || {
  echo 'Destination reference is invalid.' >&2
  exit 2
}
[[ "$tag" != latest ]] || { echo 'The latest tag cannot be a release authority.' >&2; exit 2; }
[[ -n "${DOCKER_CONFIG:-}" && -s "$DOCKER_CONFIG/config.json" ]] || { echo 'Authenticated staging registry credentials are required.' >&2; exit 2; }

for image in api web postgres caddy backup; do
  for arch in amd64 arm64; do
    report="$report_dir/${image}-${arch}.json"
    [[ -s "$report" ]] || { echo "Missing Trivy scan report: ${image}-${arch}" >&2; exit 1; }
    jq -e '.schema_version == 1 and .scanner == "trivy" and .gate == "passed" and
      .scanner_errors == [] and .high_critical_count == 0 and .secret_finding_count == 0' "$report" >/dev/null || {
      echo "Trivy gate did not pass for ${image}-${arch}; no final release tag was copied." >&2
      exit 1
    }
  done
done

source_digest="${source_ref##*@}"
source_safe_name="$(printf '%s' "$destination_repository-$tag" | tr -c 'A-Za-z0-9._-' '_')"
source_manifest="$work_dir/${source_safe_name}-source-manifest.json"
destination_manifest="$work_dir/${source_safe_name}-destination-manifest.json"
copied_digest_file="$work_dir/${source_safe_name}-copied-digest.txt"

skopeo_run() {
  docker run --rm --platform linux/amd64 \
    -v "$DOCKER_CONFIG:/auth:ro" -v "$work_dir:/work" \
    --entrypoint /usr/bin/skopeo "$skopeo_image" "$@"
}

skopeo_run --authfile /auth/config.json inspect --raw "docker://${source_ref}" > "$source_manifest"
observed_source_digest="$(skopeo_run manifest-digest "/work/$(basename "$source_manifest")")"
[[ "$observed_source_digest" == "$source_digest" ]] || { echo 'Staging manifest digest did not match its pinned reference.' >&2; exit 1; }

skopeo_run --authfile /auth/config.json copy --all --preserve-digests \
  --digestfile "/work/$(basename "$copied_digest_file")" \
  "docker://${source_ref}" "docker://${destination_repository}:${tag}"
copied_digest="$(tr -d '\r\n' < "$copied_digest_file")"
[[ "$copied_digest" == "$source_digest" ]] || { echo 'OCI promotion changed the manifest digest.' >&2; exit 1; }

skopeo_run --authfile /auth/config.json inspect --raw \
  "docker://${destination_repository}:${tag}" > "$destination_manifest"
observed_destination_digest="$(skopeo_run manifest-digest "/work/$(basename "$destination_manifest")")"
[[ "$observed_destination_digest" == "$source_digest" ]] || { echo 'Destination tag does not resolve to the verified staging digest.' >&2; exit 1; }

printf '%s\n' "$observed_destination_digest"
