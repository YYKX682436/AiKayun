#!/usr/bin/env bash
set -euo pipefail
set +x

image_ref="${1:?Usage: extract-oci-bundle.sh IMAGE@sha256:DIGEST DESTINATION VERSION}"
destination_input="${2:?Destination directory is required}"
expected_version="${3:?Expected immutable release version is required}"

[[ "$image_ref" =~ ^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$ ]] || { echo 'Release bundle must be referenced by OCI digest.' >&2; exit 2; }
[[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo 'Release version is invalid.' >&2; exit 2; }

destination_parent="$(mkdir -p "$(dirname "$destination_input")" && cd -P "$(dirname "$destination_input")" && pwd)"
destination="$destination_parent/$(basename "$destination_input")"
[[ ! -e "$destination" ]] || { echo 'Refusing to overwrite an existing release bundle directory.' >&2; exit 2; }

temporary_directory="$(mktemp -d "$destination_parent/.aikayun-release-bundle.XXXXXX")"
container_id=''
cleanup() {
  status=$?
  if [[ -n "$container_id" ]]; then docker rm "$container_id" >/dev/null 2>&1 || true; fi
  if [[ -d "$temporary_directory" ]]; then rm -rf "$temporary_directory"; fi
  return "$status"
}
trap cleanup EXIT INT TERM

docker pull "$image_ref" >/dev/null
image_version="$(docker image inspect "$image_ref" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}')"
[[ "$image_version" == "$expected_version" ]] || { echo 'Release bundle OCI version label did not match.' >&2; exit 1; }
# FROM scratch bundles have no command; set a placeholder only for the never-started container.
container_id="$(docker create --entrypoint /bin/sh "$image_ref" -c exit)"
docker cp "$container_id:/release/." "$temporary_directory/" >/dev/null
for required in release-index.json release-manifest.json release-manifest.jws release-manifest.cosign.bundle \
  release-signing-root.jwk.json release-verifier.mjs verify-artifacts.mjs compose.yaml extract-release-bundle.sh; do
  [[ -f "$temporary_directory/$required" ]] || { echo "Release bundle is missing ${required}." >&2; exit 1; }
done

mv -n "$temporary_directory" "$destination"
[[ ! -e "$temporary_directory" && -f "$destination/release-manifest.json" ]] || {
  echo 'Release bundle extraction destination already exists.' >&2
  exit 1
}
temporary_directory=''
printf '%s\n' "$destination"
