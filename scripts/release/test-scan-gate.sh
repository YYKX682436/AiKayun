#!/usr/bin/env bash
set -euo pipefail
set +x

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
candidate_script="$repo_root/scripts/release/build-release-candidate.sh"
# The final GHCR repository is empty on a first release. All pre-promotion
# container reads must therefore use the private staging digest.
pre_promotion="$(sed -n '1,/api_promoted_digest=/p' "$candidate_script")"
grep -Fq 'docker create --platform linux/amd64 "${staging_api_repository}@${api_amd64}"' <<<"$pre_promotion" || {
  echo 'First-release migration metadata still reads the unpublished final API image.' >&2
  exit 1
}
if grep -Fq 'docker create --platform linux/amd64 "$api_index_ref"' <<<"$pre_promotion"; then
  echo 'Pre-promotion logic reads the unpublished final API image.' >&2
  exit 1
fi
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/aikayun-release-scan-test.XXXXXX")"
cleanup() { rm -rf "$temporary_root"; }
trap cleanup EXIT INT TERM
mkdir -p "$temporary_root/work/trivy-cache" "$temporary_root/reports" "$temporary_root/mock-trivy" \
  "$temporary_root/mock-promote" "$temporary_root/config" "$temporary_root/promote-work"
chmod 0700 "$temporary_root" "$temporary_root/config"
printf '{}\n' > "$temporary_root/config/config.json"
touch "$temporary_root/work/image.tar"
cat > "$temporary_root/vuln.json" <<'JSON'
{"Results":[{"Vulnerabilities":[{"VulnerabilityID":"CVE-2099-12345","PkgName":"libcurl","InstalledVersion":"8.10.1-r0","Severity":"HIGH","FixedVersion":"8.10.2-r0"}]}]}
JSON
cat > "$temporary_root/secret.json" <<'JSON'
{"Results":[{"Secrets":[{"RuleID":"private-key","Category":"Private Key","Severity":"CRITICAL","Match":"RAW-SECRET-MUST-NOT-APPEAR"}]}]}
JSON
cat > "$temporary_root/mock-trivy/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
scanner=''; output=''
while (($#)); do
  case "$1" in
    --scanners) scanner="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ "$output" == /work/* ]] || exit 93
destination="$TRIVY_FAKE_WORKDIR/${output#/work/}"
mkdir -p "$(dirname "$destination")"
if [[ "$scanner" == vuln ]]; then cp "$TRIVY_VULNERABILITY_FIXTURE" "$destination"; else cp "$TRIVY_SECRET_FIXTURE" "$destination"; fi
SH
chmod 0700 "$temporary_root/mock-trivy/docker"

set +e
TRIVY_FAKE_WORKDIR="$temporary_root/work" TRIVY_VULNERABILITY_FIXTURE="$temporary_root/vuln.json" \
TRIVY_SECRET_FIXTURE="$temporary_root/secret.json" PATH="$temporary_root/mock-trivy:$PATH" \
  "$repo_root/scripts/release/scan-oci-image.sh" api linux/amd64 \
  "ghcr.io/example/aikayun-api@sha256:$(printf 'a%.0s' {1..64})" \
  "$temporary_root/work/image.tar" aquasec/trivy@sha256:fixture "$temporary_root/work" "$temporary_root/reports" \
  >/dev/null 2>"$temporary_root/scan-error.log"
scan_status=$?
set -e
[[ "$scan_status" != 0 && -s "$temporary_root/reports/api-amd64.json" ]] || {
  echo 'Blocked Trivy findings were not retained as a JSON report.' >&2
  exit 1
}
jq -e '.gate == "blocked" and .high_critical_count == 1 and
  .vulnerabilities[0] == {cve:"CVE-2099-12345",component:"libcurl",version:"8.10.1-r0",severity:"HIGH",fixed_version:"8.10.2-r0"} and
  .secret_findings[0].rule_id == "private-key"' "$temporary_root/reports/api-amd64.json" >/dev/null
if grep -q 'RAW-SECRET-MUST-NOT-APPEAR' "$temporary_root/reports/api-amd64.json"; then
  echo 'Sanitized Trivy JSON leaked the raw secret match.' >&2
  exit 1
fi

reports="$temporary_root/promotion-reports"
mkdir -m 0700 "$reports"
for image in api web postgres caddy backup; do
  for arch in amd64 arm64; do
    jq -n --arg platform "linux/$arch" '{schema_version:1,scanner:"trivy",image:"fixture",platform:$platform,gate:"passed",
      scanner_errors:[],high_critical_count:0,secret_finding_count:0,vulnerabilities:[],secret_findings:[]}' \
      > "$reports/${image}-${arch}.json"
  done
done
jq '.gate="blocked" | .high_critical_count=1' "$reports/api-amd64.json" > "$temporary_root/blocked.json"
mv "$temporary_root/blocked.json" "$reports/api-amd64.json"

cat > "$temporary_root/mock-promote/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$PROMOTION_DOCKER_LOG"
if [[ " $* " == *' manifest-digest '* ]]; then printf '%s\n' "$PROMOTION_EXPECTED_DIGEST"; exit 0; fi
if [[ " $* " == *' inspect --raw '* ]]; then
  printf '%s\n' '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}'
  exit 0
fi
if [[ " $* " == *' copy '* ]]; then
  while (($#)); do
    if [[ "$1" == --digestfile ]]; then
      [[ "$2" == /work/* ]] || exit 95
      printf '%s\n' "$PROMOTION_EXPECTED_DIGEST" > "$PROMOTION_WORKDIR/${2#/work/}"
      break
    fi
    shift
  done
  exit 0
fi
exit 96
SH
chmod 0700 "$temporary_root/mock-promote/docker"
export DOCKER_CONFIG="$temporary_root/config"
export PROMOTION_DOCKER_LOG="$temporary_root/skopeo-calls.log"
export PROMOTION_WORKDIR="$temporary_root/promote-work"
export PROMOTION_EXPECTED_DIGEST="sha256:$(printf 'a%.0s' {1..64})"
source_ref="ghcr.io/owner/aikayun-staging-api@${PROMOTION_EXPECTED_DIGEST}"
set +e
PATH="$temporary_root/mock-promote:$PATH" \
  "$repo_root/scripts/release/promote-scanned-oci-image.sh" "$source_ref" ghcr.io/owner/aikayun-api \
  0.1.0-rc.1 "$reports" "$PROMOTION_WORKDIR" "quay.io/skopeo/stable@sha256:$(printf 'b%.0s' {1..64})" \
  >/dev/null 2>"$temporary_root/promotion-error.log"
promotion_status=$?
set -e
[[ "$promotion_status" != 0 && ! -s "$PROMOTION_DOCKER_LOG" ]] || {
  echo 'A final OCI tag was copied before the complete vulnerability gate passed.' >&2
  exit 1
}

jq '.gate="passed" | .high_critical_count=0' "$reports/api-amd64.json" > "$temporary_root/passed.json"
mv "$temporary_root/passed.json" "$reports/api-amd64.json"
promotion_output="$(PATH="$temporary_root/mock-promote:$PATH" \
  "$repo_root/scripts/release/promote-scanned-oci-image.sh" "$source_ref" ghcr.io/owner/aikayun-api \
  0.1.0-rc.1 "$reports" "$PROMOTION_WORKDIR" "quay.io/skopeo/stable@sha256:$(printf 'b%.0s' {1..64})")"
[[ "$promotion_output" == "$PROMOTION_EXPECTED_DIGEST" ]]
grep -Fq -- '--all --preserve-digests' "$PROMOTION_DOCKER_LOG" || {
  echo 'OCI promotion did not copy all platforms with digest preservation.' >&2
  exit 1
}
echo 'Sanitized Trivy reports and scan-gated OCI digest promotion passed.'

