#!/usr/bin/env bash
# Sourced by the release workflow and isolated tests. OCI child references
# retain sha256: while the signed manifest schema stores the bare digest.
write_release_image_metadata() {
  local output_path="$1" value
  for value in "$api_amd64" "$api_arm64" "$web_amd64" "$web_arm64" \
    "$postgres_amd64" "$postgres_arm64" "$caddy_amd64" "$caddy_arm64" \
    "$backup_amd64" "$backup_arm64"; do
    [[ "$value" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid platform manifest digest.' >&2; return 1; }
  done
sha_of() { sha256sum "$1" | cut -d ' ' -f1; }
jq -n \
  --arg version "$version" --arg built_at "$build_time" --arg source_commit "$GITHUB_SHA" \
  --arg distribution_origin "$AIKAYUN_RELEASE_ORIGIN" --arg api_reference "$api_index_ref" \
  --arg api_amd64 "${api_amd64#sha256:}" --arg api_arm64 "${api_arm64#sha256:}" \
  --arg api_amd64_sbom "$(sha_of "$work/sbom/api-linux-amd64.cdx.json")" \
  --arg api_arm64_sbom "$(sha_of "$work/sbom/api-linux-arm64.cdx.json")" \
  --arg web_reference "$web_index_ref" --arg web_amd64 "${web_amd64#sha256:}" --arg web_arm64 "${web_arm64#sha256:}" \
  --arg web_amd64_sbom "$(sha_of "$work/sbom/web-linux-amd64.cdx.json")" \
  --arg web_arm64_sbom "$(sha_of "$work/sbom/web-linux-arm64.cdx.json")" \
  --arg postgres_reference "$postgres_image" --arg postgres_amd64 "${postgres_amd64#sha256:}" --arg postgres_arm64 "${postgres_arm64#sha256:}" \
  --arg postgres_amd64_sbom "$(sha_of "$work/sbom/postgres-linux-amd64.cdx.json")" \
  --arg postgres_arm64_sbom "$(sha_of "$work/sbom/postgres-linux-arm64.cdx.json")" \
  --arg caddy_reference "$caddy_image" --arg caddy_amd64 "${caddy_amd64#sha256:}" --arg caddy_arm64 "${caddy_arm64#sha256:}" \
  --arg caddy_amd64_sbom "$(sha_of "$work/sbom/caddy-linux-amd64.cdx.json")" \
  --arg caddy_arm64_sbom "$(sha_of "$work/sbom/caddy-linux-arm64.cdx.json")" \
  --arg backup_reference "$backup_index_ref" --arg backup_amd64 "${backup_amd64#sha256:}" --arg backup_arm64 "${backup_arm64#sha256:}" \
  --arg backup_amd64_sbom "$(sha_of "$work/sbom/backup-linux-amd64.cdx.json")" \
  --arg backup_arm64_sbom "$(sha_of "$work/sbom/backup-linux-arm64.cdx.json")" \
  --argjson license_center_signer_kids "$AIKAYUN_LICENSE_CENTER_SIGNER_KIDS" \
  '{version:$version,built_at:$built_at,source_commit:$source_commit,distribution_origin:$distribution_origin,
    license_center_signer_kids:$license_center_signer_kids,
    images:{
      api:{reference:$api_reference,platform_digests:{"linux/amd64":$api_amd64,"linux/arm64":$api_arm64},sbom_sha256:{"linux/amd64":$api_amd64_sbom,"linux/arm64":$api_arm64_sbom}},
      web:{reference:$web_reference,platform_digests:{"linux/amd64":$web_amd64,"linux/arm64":$web_arm64},sbom_sha256:{"linux/amd64":$web_amd64_sbom,"linux/arm64":$web_arm64_sbom}},
      postgres:{reference:$postgres_reference,platform_digests:{"linux/amd64":$postgres_amd64,"linux/arm64":$postgres_arm64},sbom_sha256:{"linux/amd64":$postgres_amd64_sbom,"linux/arm64":$postgres_arm64_sbom}},
      caddy:{reference:$caddy_reference,platform_digests:{"linux/amd64":$caddy_amd64,"linux/arm64":$caddy_arm64},sbom_sha256:{"linux/amd64":$caddy_amd64_sbom,"linux/arm64":$caddy_arm64_sbom}},
      backup:{reference:$backup_reference,platform_digests:{"linux/amd64":$backup_amd64,"linux/arm64":$backup_arm64},sbom_sha256:{"linux/amd64":$backup_amd64_sbom,"linux/arm64":$backup_arm64_sbom}}
    }}' > "$output_path"
}
