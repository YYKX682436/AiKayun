#!/usr/bin/env bash
set -euo pipefail
set +x

image_name="${1:?Usage: scan-oci-image.sh NAME linux/ARCH IMAGE_REF IMAGE_ARCHIVE TRIVY_IMAGE WORK_DIR REPORT_DIR}"
platform="${2:?Platform is required}"
image_ref="${3:?Image reference is required}"
archive_path="${4:?Image archive is required}"
trivy_image="${5:?Pinned Trivy image is required}"
work_dir="${6:?Temporary working directory is required}"
report_dir="${7:?Persistent scan report directory is required}"

[[ "$image_name" =~ ^(api|web|postgres|caddy)$ ]] || { echo 'Invalid image name.' >&2; exit 2; }
[[ "$platform" =~ ^linux/(amd64|arm64)$ ]] || { echo 'Invalid Linux platform.' >&2; exit 2; }
[[ "$image_ref" == *@sha256:* ]] || { echo 'Scanner input must be digest-pinned.' >&2; exit 2; }

arch="${platform#linux/}"
report_path="$report_dir/${image_name}-${arch}.json"
raw_vulnerability="${work_dir}/${image_name}-${arch}-vulnerability.raw.json"
raw_secret="${work_dir}/${image_name}-${arch}-secret.raw.json"
mkdir -p "$report_dir"

set +e
docker run --rm -v "$work_dir:/work" -v "$work_dir/trivy-cache:/root/.cache/trivy" "$trivy_image" \
  image --input "/work/$(basename "$archive_path")" --scanners vuln --severity HIGH,CRITICAL \
  --exit-code 0 --format json --output "/work/$(basename "$raw_vulnerability")" \
  >/dev/null 2>"$work_dir/${image_name}-${arch}-vulnerability.stderr"
vulnerability_status=$?
docker run --rm -v "$work_dir:/work" -v "$work_dir/trivy-cache:/root/.cache/trivy" "$trivy_image" \
  image --input "/work/$(basename "$archive_path")" --scanners secret \
  --exit-code 0 --format json --output "/work/$(basename "$raw_secret")" \
  >/dev/null 2>"$work_dir/${image_name}-${arch}-secret.stderr"
secret_status=$?
set -e

node "$(dirname "$0")/sanitize-trivy-report.mjs" \
  "$raw_vulnerability" "$raw_secret" "$report_path" "$image_ref" "$platform" \
  "$vulnerability_status" "$secret_status"

if ! jq -e '.gate == "passed"' "$report_path" >/dev/null; then
  printf 'Trivy blocked %s (%s); sanitized report: %s\n' "$image_name" "$platform" "$report_path" >&2
  exit 1
fi
