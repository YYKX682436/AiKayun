#!/usr/bin/env bash
set -euo pipefail
set +x

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/aikayun-bundle-extraction.XXXXXX")"
registry_container="aikayun-bundle-extract-$(date +%s)-$$"
registry_image='docker.io/library/registry@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e'
registry_was_present=0
image_tag=''
bundle_ref=''
bundle_image_id=''
if docker image inspect "$registry_image" >/dev/null 2>&1; then registry_was_present=1; fi
cleanup() {
  status=$?
  docker rm --force "$registry_container" >/dev/null 2>&1 || true
  if [[ -n "$image_tag" ]]; then docker image rm "$image_tag" >/dev/null 2>&1 || true; fi
  if [[ -n "$bundle_ref" ]]; then docker image rm "$bundle_ref" >/dev/null 2>&1 || true; fi
  if [[ -n "$bundle_image_id" ]]; then docker image rm "$bundle_image_id" >/dev/null 2>&1 || true; fi
  if [[ "$registry_was_present" == 0 ]]; then docker image rm "$registry_image" >/dev/null 2>&1 || true; fi
  rm -rf "$temporary_root"
  return "$status"
}
trap cleanup EXIT INT TERM

port="$(node --input-type=module -e 'import net from "node:net"; const server=net.createServer(); server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close()})')"
docker run --detach --rm --name "$registry_container" --publish "127.0.0.1:${port}:5000" "$registry_image" >/dev/null
for attempt in {1..30}; do
  if curl --fail --silent "http://127.0.0.1:${port}/v2/" >/dev/null; then break; fi
  if [[ "$attempt" == 30 ]]; then echo 'Isolated OCI registry did not become ready.' >&2; exit 1; fi
  sleep 1
done

version='0.1.0-rc.1'
case "$(docker info --format '{{.Architecture}}')" in
  x86_64|amd64) test_platform='linux/amd64' ;;
  aarch64|arm64) test_platform='linux/arm64' ;;
  *) echo 'The bundle extraction test needs an amd64 or arm64 Docker engine.' >&2; exit 2 ;;
esac
image_tag="localhost:${port}/aikayun-release-bundle-test:${version}"
context="$temporary_root/context"
mkdir -m 0700 "$context"
for filename in release-index.json release-manifest.json release-manifest.jws release-manifest.cosign.bundle \
  release-signing-root.jwk.json release-verifier.mjs verify-artifacts.mjs compose.yaml extract-release-bundle.sh; do
  printf 'fixture:%s\n' "$filename" > "$context/$filename"
done
cat > "$context/Dockerfile" <<'DOCKER'
FROM scratch
ARG VERSION
LABEL org.opencontainers.image.version="$VERSION"
COPY . /release/
DOCKER
printf 'Dockerfile\n' > "$context/.dockerignore"
docker build --platform "$test_platform" --build-arg "VERSION=${version}" --tag "$image_tag" "$context" >/dev/null
docker push "$image_tag" >/dev/null
bundle_image_id="$(docker image inspect "$image_tag" --format '{{.Id}}')"
docker pull "$image_tag" >/dev/null
bundle_ref="$(docker image inspect "$image_tag" --format '{{index .RepoDigests 0}}')"
[[ "$bundle_ref" =~ @sha256:[a-f0-9]{64}$ ]] || { echo 'Test bundle did not receive an immutable digest.' >&2; exit 1; }
docker image rm "$image_tag" >/dev/null

destination="$temporary_root/extracted"
"$repo_root/scripts/release/extract-oci-bundle.sh" "$bundle_ref" "$destination" "$version" >/dev/null
for filename in release-index.json release-manifest.json release-manifest.jws release-manifest.cosign.bundle \
  release-signing-root.jwk.json release-verifier.mjs verify-artifacts.mjs compose.yaml extract-release-bundle.sh; do
  cmp -s "$context/$filename" "$destination/$filename" || { echo "Extracted bundle content differs: $filename" >&2; exit 1; }
done
set +e
"$repo_root/scripts/release/extract-oci-bundle.sh" "$bundle_ref" "$destination" "$version" >/dev/null 2>&1
overwrite_status=$?
set -e
[[ "$overwrite_status" != 0 ]] || { echo 'Bundle extraction overwrote an existing directory.' >&2; exit 1; }
echo 'Digest-pinned OCI release bundle extraction passed against an isolated registry.'

