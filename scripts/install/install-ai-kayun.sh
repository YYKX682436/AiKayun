#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly TARGET_DIR='/opt/aikayun'
readonly RELEASE_DIR='/opt/aikayun/release'
readonly STATE_FILE='/opt/aikayun/install-state.json'
readonly LOCK_FILE='/run/lock/aikayun-install.lock'
readonly NODE_IMAGE='node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c'
readonly COSIGN_IMAGE='ghcr.io/sigstore/cosign/cosign:v2.5.3@sha256:f1946d0f30fc8e3777b02f2201e02efdba9fe38f4918162f937052fac98e083f'
readonly RELEASE_CERT_IDENTITY='https://github.com/YYKX682436/AiKayun/.github/workflows/release.yml@refs/heads/main'
readonly RELEASE_OIDC_ISSUER='https://token.actions.githubusercontent.com'
readonly RELEASE_BUNDLE_REPOSITORY='ghcr.io/yykx682436/aikayun-release-bundle'
readonly MINIMUM_DISK_KIB=8388608

WORK_DIR=''
STAGING_DIR=''
SELECTED_RELEASE_ORIGIN="${AIKAYUN_RELEASE_ORIGIN:-}"
SELECTED_VERSION="${AIKAYUN_RELEASE_VERSION:-}"
SELECTED_DOMAIN=''
MANIFEST_SHA256=''
SELECTED_API_IMAGE=''
SELECTED_WEB_IMAGE=''
SELECTED_POSTGRES_IMAGE=''
SELECTED_CADDY_IMAGE=''
RELEASE_BASE=''

cleanup() {
  local status=$?
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then rm -rf -- "$WORK_DIR"; fi
  if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then rm -rf -- "$STAGING_DIR"; fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { printf 'AiKayun installer: %s\n' "$1" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage:
  install.sh install --release-origin HTTPS_ORIGIN --version VERSION --domain STORE_FQDN
  install.sh status
  install.sh resume
  install.sh diagnose
  install.sh setup-token

install/resume require Linux, root, Docker Engine, Docker Compose v2, DNS for the
store hostname, and free TCP ports 80 and 443. The installer never installs Docker
or changes firewall rules. The release origin is a locator; signing roots and the
Cosign workflow identity are fixed by this installer.
USAGE
}

require_root() {
  [[ "$(id -u)" == '0' ]] || fail 'Run this command with sudo or as root.'
}

begin_lock() {
  mkdir -p /run/lock
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then fail 'Another install, resume, or setup-token command holds the deployment lock.'; fi
}

require_host_commands() {
  local name
  for name in awk base64 basename chmod chown cp curl date df diff dirname docker env find flock getent grep head id install mkdir mktemp mv rmdir rm sed sha256sum sleep sort stat tr uname; do
    command -v "$name" >/dev/null 2>&1 || fail "Required host command is missing: $name. Install the standard Linux utility package that provides it."
  done
  command -v bash >/dev/null 2>&1 || fail 'Bash is required to run the controlled installer.'
}

docker_ready() {
  command -v docker >/dev/null 2>&1 || fail 'Docker Engine is required and is not installed.'
  check_docker_local_engine
  docker info --format '{{.OSType}}' 2>/dev/null | grep -qx linux || fail 'The Docker Engine must be running in Linux mode.'
  docker compose version --short >/dev/null 2>&1 || fail 'Docker Compose v2 is required.'
}

check_docker_local_engine() {
  local context endpoint socket
  if [[ -n "${DOCKER_CONTEXT:-}" ]]; then
    context="$DOCKER_CONTEXT"
    endpoint="$(docker context inspect "$context" --format '{{ (index .Endpoints "docker").Host }}' 2>/dev/null)" || \
      fail 'The selected Docker context could not be inspected locally.'
  elif [[ -n "${DOCKER_HOST:-}" ]]; then
    endpoint="$DOCKER_HOST"
  else
    context="$(docker context show 2>/dev/null)" || fail 'The active Docker context could not be read.'
    endpoint="$(docker context inspect "$context" --format '{{ (index .Endpoints "docker").Host }}' 2>/dev/null)" || \
      fail 'The active Docker context could not be inspected locally.'
  fi
  [[ "$endpoint" == unix:///* ]] || \
    fail 'Remote Docker Engines are not supported. Select a Docker Engine on this machine using a Unix socket.'
  socket="${endpoint#unix://}"
  [[ -S "$socket" ]] || fail 'The selected local Docker Unix socket is missing or is not a socket.'
}

expected_host_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'amd64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *) fail 'Only Linux amd64 and arm64 hosts are supported.' ;;
  esac
}

check_architecture() {
  local expected actual
  expected="$(expected_host_arch)"
  actual="$(docker info --format '{{.Architecture}}')"
  case "$actual" in
    x86_64|amd64) actual=amd64 ;;
    aarch64|arm64) actual=arm64 ;;
  esac
  [[ "$actual" == "$expected" ]] || fail "Docker Engine architecture ($actual) does not match this host ($expected)."
}

check_disk_space() {
  local path available
  for path in /opt /var/tmp "$(docker info --format '{{.DockerRootDir}}')"; do
    [[ -d "$path" ]] || path="$(dirname "$path")"
    available="$(df -Pk "$path" | awk 'END { print $4 }')"
    [[ "$available" =~ ^[0-9]+$ && "$available" -ge "$MINIMUM_DISK_KIB" ]] || \
      fail "At least 8 GiB of free disk space is required on the filesystem containing $path."
  done
}

port_is_listening() {
  local port_hex="$1"
  awk -v suffix=":$port_hex" 'index($2, suffix) == length($2)-length(suffix)+1 && $4 == "0A" { found=1 } END { exit !found }' /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

udp_port_is_bound() {
  local port_hex="$1"
  awk -v suffix=":$port_hex" 'index($2, suffix) == length($2)-length(suffix)+1 { found=1 } END { exit !found }' /proc/net/udp /proc/net/udp6 2>/dev/null
}

check_public_domain() {
  local domain="$1"
  docker_node_eval '
    const {isIP}=require("node:net");
    const v=process.argv[1];
    if(typeof v!=="string" || v.length>253 || isIP(v) || !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/.test(v) ||
      /(^|\.)(test|example|invalid|local)$/i.test(v) || /(^|\.)example\.(com|net|org)$/i.test(v)) process.exit(1);
  ' "$domain" || fail 'The store domain must be a public DNS hostname, not an IP, test name, or placeholder.'
  getent ahosts "$domain" >/dev/null 2>&1 || fail "The store domain does not resolve in DNS: $domain"
}

check_release_origin() {
  docker_node_eval '
    const {isIP}=require("node:net");
    const v=process.argv[1]; let u;
    try { u=new URL(v); } catch { process.exit(1); }
    if(u.protocol!=="https:" || u.origin!==v || u.username || u.password || u.pathname!=="/" || u.search || u.hash ||
      isIP(u.hostname) || u.hostname==="localhost" || u.hostname.endsWith(".localhost") ||
      /(^|\.)(test|example|invalid|local)$/i.test(u.hostname) || /(^|\.)example\.(com|net|org)$/i.test(u.hostname)) process.exit(1);
  ' "$SELECTED_RELEASE_ORIGIN" || fail 'Release origin must be a public HTTPS origin without a path or credentials.'
}

host_preflight() {
  [[ "$(uname -s)" == Linux ]] || fail 'The installer supports Linux only.'
  require_host_commands
  docker_ready
  check_architecture
  check_disk_space
}

check_public_ports_available() {
  local allow_managed_caddy="$1" caddy_id bindings
  if [[ "$allow_managed_caddy" == true ]]; then
    caddy_id="$(docker ps -q --filter label=com.docker.compose.project=aikayun \
      --filter label=com.docker.compose.service=caddy | head -1)"
    if [[ -n "$caddy_id" ]]; then
      bindings="$(docker inspect --format '{{range $port,$items := .HostConfig.PortBindings}}{{range $items}}{{printf "%s=%s\n" $port .HostPort}}{{end}}{{end}}' "$caddy_id")"
      if printf '%s\n' "$bindings" | grep -Fqx '80/tcp=80' &&
        printf '%s\n' "$bindings" | grep -Fqx '443/tcp=443' &&
        printf '%s\n' "$bindings" | grep -Fqx '443/udp=443'; then
        return 0
      fi
    fi
  fi
  if port_is_listening 0050 || port_is_listening 01BB || udp_port_is_bound 01BB; then
    fail 'TCP port 80 or 443 is in use by a service outside this AiKayun Compose deployment.'
  fi
}

docker_node_eval() {
  docker run --rm --interactive --entrypoint node "$NODE_IMAGE" -e "$1" "${@:2}"
}

node_work() {
  docker run --rm --mount "type=bind,source=$WORK_DIR,target=/work,readonly" \
    --entrypoint node "$NODE_IMAGE" -e "$1" "${@:2}"
}

node_target() {
  docker run --rm --mount "type=bind,source=$TARGET_DIR,target=/target,readonly" \
    --entrypoint node "$NODE_IMAGE" -e "$1" "${@:2}"
}

fetch_https_file() {
  local url="$1" output="$2"
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error \
    --location --max-redirs 0 --connect-timeout 15 --max-time 120 "$url" --output "$output"
}

assert_origin_marker() {
  local marker_path="$WORK_DIR/marker.json"
  fetch_https_file "${SELECTED_RELEASE_ORIGIN%/}/.well-known/aikayun-release.json" "$marker_path" || \
    fail 'Could not download the HTTPS release marker.'
  node_work '
    const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync("/work/marker.json","utf8")); const origin=process.argv[1];
    const keys=["product","publish_protocol","registry","release_base_url","schema"].sort().join(",");
    if(!v || typeof v!=="object" || Object.keys(v).sort().join(",")!==keys || v.schema!==1 || v.product!=="aikayun" ||
      v.release_base_url!==origin+"/releases/" || v.registry!=="ghcr.io/yykx682436" || v.publish_protocol!=="http-put-if-none-match-v1") process.exit(1);
  ' "$SELECTED_RELEASE_ORIGIN" || fail 'The release marker does not match the AiKayun signed release protocol.'
}

download_and_verify_release() {
  [[ "$SELECTED_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+)(\.([0-9A-Za-z-]+))*)?$ ]] || \
    fail 'Provide a canonical release version, such as the one published by the project.'
  check_release_origin
  assert_origin_marker
  RELEASE_BASE="${SELECTED_RELEASE_ORIGIN%/}/releases/${SELECTED_VERSION}/"
  mkdir -m 0700 "$WORK_DIR/release"
  fetch_https_file "${RELEASE_BASE}release-index.json" "$WORK_DIR/release/release-index.json" || \
    fail 'Could not download the versioned release index.'
  node_work '
    const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync("/work/release/release-index.json","utf8"));
    const version=process.argv[1], origin=process.argv[2];
    const keys=["artifacts","channel","download_base_url","manifest","manifest_cosign_bundle","manifest_signature","product","release_id","release_signature_root","schema","version"].sort().join(",");
    if(!v || typeof v!=="object" || Object.keys(v).sort().join(",")!==keys || v.schema!==1 || v.product!=="aikayun" ||
      v.version!==version || v.release_id!=="aikayun-"+version || v.download_base_url!==origin+"/releases/"+version+"/" ||
      v.manifest!=="release-manifest.json" || v.manifest_signature!=="release-manifest.jws" ||
      v.manifest_cosign_bundle!=="release-manifest.cosign.bundle" || v.release_signature_root!=="release-signing-root.jwk.json" ||
      v.artifacts!=="release-manifest.json:artifacts" || !["candidate","stable"].includes(v.channel)) process.exit(1);
  ' "$SELECTED_VERSION" "${SELECTED_RELEASE_ORIGIN%/}" || fail 'The release index does not match the requested version and origin.'

  local file artifact name path
  for file in release-manifest.json release-manifest.jws release-manifest.cosign.bundle; do
    fetch_https_file "${RELEASE_BASE}${file}" "$WORK_DIR/release/$file" || fail "Could not download $file."
  done
  docker run --rm --mount "type=bind,source=$WORK_DIR/release,target=/release,readonly" --entrypoint cosign "$COSIGN_IMAGE" \
    verify-blob --bundle /release/release-manifest.cosign.bundle \
    --certificate-identity "$RELEASE_CERT_IDENTITY" --certificate-oidc-issuer "$RELEASE_OIDC_ISSUER" \
    /release/release-manifest.json >/dev/null || fail 'Cosign rejected the release manifest or its fixed workflow identity.'

  while IFS= read -r artifact; do
    [[ -n "$artifact" ]] || continue
    [[ "$artifact" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ && "$artifact" != *'..'* ]] || fail 'The signed manifest contains an unsafe artifact path.'
    path="$WORK_DIR/release/$artifact"
    mkdir -p "$(dirname "$path")"
    fetch_https_file "${RELEASE_BASE}${artifact}" "$path" || fail "Could not download the signed release artifact: $artifact"
  done < <(node_work '
    const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync("/work/release/release-manifest.json","utf8"));
    if(!Array.isArray(m.artifacts)) process.exit(1);
    for(const a of m.artifacts) {
      if(!a || typeof a.name!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(a.name) || a.name.includes("..")) process.exit(1);
      console.log(a.name);
    }
  ')

  [[ -f "$WORK_DIR/release/release-signing-root.jwk.json" && -f "$WORK_DIR/release/release-verifier.mjs" && \
     -f "$WORK_DIR/release/verify-artifacts.mjs" && -f "$WORK_DIR/release/compose.yaml" && \
     -f "$WORK_DIR/release/extract-release-bundle.sh" && -f "$WORK_DIR/release/license-trust-bundle.jws" && \
     -f "$WORK_DIR/release/deploy/prepare-state-volume.sh" ]] || \
    fail 'The signed release is missing a required installation artifact.'
  docker run --rm --mount "type=bind,source=$WORK_DIR/release,target=/release,readonly" --entrypoint node "$NODE_IMAGE" \
    /release/release-verifier.mjs /release/release-manifest.json /release/release-manifest.jws \
    /release/release-signing-root.jwk.json >/dev/null || fail 'The release JWS signature or embedded JWS root failed verification.'
  docker run --rm --mount "type=bind,source=$WORK_DIR/release,target=/release,readonly" --entrypoint node "$NODE_IMAGE" \
    /release/verify-artifacts.mjs /release/release-manifest.json /release >/dev/null || fail 'A release artifact does not match its signed SHA-256 and size.'

  MANIFEST_SHA256="$(sha256sum "$WORK_DIR/release/release-manifest.json" | awk '{print $1}')"
  verify_release_image_references "$WORK_DIR/release"
  verify_and_extract_oci_bundle "$WORK_DIR/release"
  diff -qr "$WORK_DIR/release" "$WORK_DIR/oci-release" >/dev/null || fail 'The signed HTTPS files differ from the digest-pinned OCI release bundle.'
}

verify_release_image_references() {
  local directory="$1" image name manifest_references compose_references
  manifest_references="$(docker run --rm --mount "type=bind,source=$directory,target=/release,readonly" \
    --entrypoint node "$NODE_IMAGE" -e '
    const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync("/release/release-manifest.json","utf8"));
    for(const name of ["api","web","postgres","caddy"]) {
      const ref=m.images?.[name]?.reference;
      if(typeof ref!=="string" || !/@sha256:[a-f0-9]{64}$/.test(ref)) process.exit(1);
      console.log(ref);
    }
  ' 2>/dev/null)" || fail 'The signed manifest does not contain four valid image references.'
  compose_references="$(sed -n 's/^[[:space:]]*image:[[:space:]]*//p' "$directory/compose.yaml" | sort -u)"
  [[ "$compose_references" == "$(printf '%s\n' "$manifest_references" | sort -u)" ]] || \
    fail 'The release Compose image references do not exactly match the four signed manifest digests.'
  for name in api web postgres caddy; do
    image="$(docker run --rm --mount "type=bind,source=$directory,target=/release,readonly" \
      --entrypoint node "$NODE_IMAGE" -e '
        const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync("/release/release-manifest.json","utf8"));
        const name=process.argv[1], i=m.images?.[name];
        if(!i || typeof i.reference!=="string" || !/@sha256:[a-f0-9]{64}$/.test(i.reference)) process.exit(1);
        process.stdout.write(i.reference);
      ' "$name")" || fail "The signed manifest has no valid $name image digest."
    grep -Fqx "    image: $image" "$directory/compose.yaml" || fail "Compose does not use the signed $name image digest."
    docker pull "$image" >/dev/null || fail "Could not pull the digest-pinned $name image."
    if [[ "$name" == api || "$name" == web ]]; then
      docker run --rm --entrypoint cosign "$COSIGN_IMAGE" verify \
        --certificate-identity "$RELEASE_CERT_IDENTITY" --certificate-oidc-issuer "$RELEASE_OIDC_ISSUER" \
        "$image" >/dev/null || fail "Cosign rejected the $name image signature."
    fi
  done
  if grep -Eq '(^|[[:space:]])latest([[:space:]]|$)|^[[:space:]]*build:' "$directory/compose.yaml"; then
    fail 'The signed production Compose file contains a mutable latest tag or source build step.'
  fi
}

verify_and_extract_oci_bundle() {
  local directory="$1" image_tag image_digests image_ref
  image_tag="${RELEASE_BUNDLE_REPOSITORY}:${SELECTED_VERSION}"
  docker pull "$image_tag" >/dev/null || fail 'Could not pull the immutable OCI release bundle tag.'
  image_digests="$(docker image inspect "$image_tag" --format '{{range .RepoDigests}}{{println .}}{{end}}')"
  image_ref="$(printf '%s\n' "$image_digests" | awk -v prefix="${RELEASE_BUNDLE_REPOSITORY}@sha256:" 'index($0,prefix)==1 {print; exit}')"
  [[ "$image_ref" =~ ^ghcr\.io/yykx682436/aikayun-release-bundle@sha256:[a-f0-9]{64}$ ]] || \
    fail 'The OCI release bundle did not resolve to an immutable repository digest.'
  docker run --rm --entrypoint cosign "$COSIGN_IMAGE" verify \
    --certificate-identity "$RELEASE_CERT_IDENTITY" --certificate-oidc-issuer "$RELEASE_OIDC_ISSUER" \
    "$image_ref" >/dev/null || fail 'Cosign rejected the OCI release bundle signature.'
  bash "$directory/extract-release-bundle.sh" "$image_ref" "$WORK_DIR/oci-release" "$SELECTED_VERSION" >/dev/null || \
    fail 'The digest-pinned OCI release bundle could not be extracted safely.'
}

saved_bundle_verify() {
  [[ -d "$TARGET_DIR" && ! -L "$TARGET_DIR" && "$(stat -c '%u:%g:%a' "$TARGET_DIR")" == '0:0:700' ]] || \
    fail 'The fixed deployment directory is missing or unsafe.'
  [[ -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" && -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] || \
    fail 'No safe resumable AiKayun deployment state was found under /opt/aikayun.'
  local recorded_sha
  [[ -f "$TARGET_DIR/.install-owner" && ! -L "$TARGET_DIR/.install-owner" ]] || fail 'The deployment ownership marker is missing or unsafe.'
  [[ "$(stat -c '%u:%g:%a:%h' "$TARGET_DIR/.install-owner")" == '0:0:600:1' ]] || fail 'The deployment ownership marker permissions changed.'
  [[ "$(cat "$TARGET_DIR/.install-owner")" == aikayun-install-v1 ]] || fail 'The deployment ownership marker is invalid.'
  [[ "$(stat -c '%u:%g:%a:%h' "$STATE_FILE")" == '0:0:600:1' ]] || fail 'The persistent install-state permissions changed.'
  recorded_sha="$(node_target '
    const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync("/target/install-state.json","utf8"));
    const keys=["domain","manifest_sha256","phase","release_origin","schema","updated_at","version"].sort().join(",");
    if(!s || typeof s!=="object" || Object.keys(s).sort().join(",")!==keys || s.schema!==1 ||
      !/^[a-zA-Z0-9.-]{1,253}$/.test(s.domain) || !/^[a-f0-9]{64}$/.test(s.manifest_sha256) ||
      !/^[0-9A-Za-z.+-]{1,64}$/.test(s.version) || !["verified","secrets_ready","storage_ready","storage_volumes_ready","database_ready","roles_ready","migrated","identity_ready","api_ready","web_ready","caddy_started","https_ready","setup_token_issued"].includes(s.phase) ||
      typeof s.release_origin!=="string" || typeof s.updated_at!=="string") process.exit(1);
    process.stdout.write(s.manifest_sha256);
  ')" || fail 'The persisted install-state record is invalid; automatic initialization is stopped.'
  MANIFEST_SHA256="$(sha256sum "$RELEASE_DIR/release-manifest.json" | awk '{print $1}')"
  [[ "$MANIFEST_SHA256" == "$recorded_sha" ]] || fail 'The stored release manifest differs from the recorded verified digest.'
  docker run --rm --mount "type=bind,source=$RELEASE_DIR,target=/release,readonly" --entrypoint cosign "$COSIGN_IMAGE" \
    verify-blob --bundle /release/release-manifest.cosign.bundle \
    --certificate-identity "$RELEASE_CERT_IDENTITY" --certificate-oidc-issuer "$RELEASE_OIDC_ISSUER" \
    /release/release-manifest.json >/dev/null || fail 'The stored release manifest Cosign signature is invalid.'
  docker run --rm --mount "type=bind,source=$RELEASE_DIR,target=/release,readonly" --entrypoint node "$NODE_IMAGE" \
    /release/release-verifier.mjs /release/release-manifest.json /release/release-manifest.jws \
    /release/release-signing-root.jwk.json >/dev/null || fail 'The stored release JWS signature is invalid.'
  docker run --rm --mount "type=bind,source=$RELEASE_DIR,target=/release,readonly" --entrypoint node "$NODE_IMAGE" \
    /release/verify-artifacts.mjs /release/release-manifest.json /release >/dev/null || fail 'A stored release artifact failed SHA-256 verification.'
  SELECTED_VERSION="$(state_value version)"
  SELECTED_RELEASE_ORIGIN="$(state_value release_origin)"
  SELECTED_DOMAIN="$(state_value domain)"
  load_release_image_digests
  if [[ -f "$TARGET_DIR/.env" ]]; then compose config --quiet || fail 'The saved Compose configuration is invalid.'; fi
}

state_value() {
  local key="$1"
  node_target '
    const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync("/target/install-state.json","utf8"));
    const k=process.argv[1]; const v=s[k]; if(typeof v!=="string") process.exit(1); process.stdout.write(v);
  ' "$key"
}

load_release_image_digests() {
  local image_references image_reference
  local -a image_references_array
  image_references="$(node_target '
    const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync("/target/release/release-manifest.json","utf8"));
    const values=[m.images?.api?.reference,m.images?.web?.reference,m.images?.postgres?.reference,m.images?.caddy?.reference];
    if(values.some(v=>typeof v!=="string" || !/@sha256:[a-f0-9]{64}$/.test(v))) process.exit(1);
    process.stdout.write(values.join("\n"));
  ')" || fail 'Could not load the four verified image references.'
  mapfile -t image_references_array <<< "$image_references"
  [[ "${#image_references_array[@]}" == 4 ]] || fail 'The signed release manifest must contain exactly four images.'
  SELECTED_API_IMAGE="${image_references_array[0]}"
  SELECTED_WEB_IMAGE="${image_references_array[1]}"
  SELECTED_POSTGRES_IMAGE="${image_references_array[2]}"
  SELECTED_CADDY_IMAGE="${image_references_array[3]}"
  for image_reference in "${image_references_array[@]}"; do
    [[ "$image_reference" =~ ^(ghcr\.io/yykx682436/aikayun-(api|web)|docker\.io/library/(postgres|caddy))@sha256:[a-f0-9]{64}$ ]] || \
      fail 'A signed image reference does not use its canonical repository and immutable digest.'
  done
}

phase_rank() {
  case "$1" in
    verified) printf 1 ;; secrets_ready) printf 2 ;; storage_ready) printf 3 ;; storage_volumes_ready) printf 4 ;;
    database_ready) printf 5 ;; roles_ready) printf 6 ;; migrated) printf 7 ;; identity_ready) printf 8 ;;
    api_ready) printf 9 ;; web_ready) printf 10 ;; caddy_started) printf 11 ;; https_ready) printf 12 ;; setup_token_issued) printf 13 ;;
    *) fail 'Unknown persisted deployment phase.' ;;
  esac
}

write_state() {
  local phase="$1" directory="${2:-$TARGET_DIR}" now temporary
  now="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  temporary="$directory/.install-state.$$.tmp"
  printf '{"schema":1,"phase":"%s","domain":"%s","release_origin":"%s","version":"%s","manifest_sha256":"%s","updated_at":"%s"}\n' \
    "$phase" "$SELECTED_DOMAIN" "$SELECTED_RELEASE_ORIGIN" "$SELECTED_VERSION" "$MANIFEST_SHA256" "$now" > "$temporary"
  chmod 0600 "$temporary"
  chown 0:0 "$temporary"
  mv -f -- "$temporary" "$directory/install-state.json"
}

compose() {
  env \
    -u AIKAYUN_API_IMAGE -u AIKAYUN_WEB_IMAGE -u AIKAYUN_POSTGRES_IMAGE -u AIKAYUN_CADDY_IMAGE \
    -u AIKAYUN_PUBLIC_HOST -u AIKAYUN_LICENSE_TRUST_BUNDLE_FILE \
    -u AIKAYUN_POSTGRES_ADMIN_PASSWORD_FILE -u AIKAYUN_API_DATABASE_PASSWORD_FILE -u AIKAYUN_MIGRATOR_DATABASE_PASSWORD_FILE \
    -u AIKAYUN_PAYMENT_CREDENTIAL_KEY_RING_FILE -u AIKAYUN_CODE_POOL_ENCRYPTION_KEY_RING_FILE -u AIKAYUN_DB_NAME \
    -u AIKAYUN_PRIVATE_SUBNET -u AIKAYUN_HTTP_BIND_ADDRESS -u AIKAYUN_HTTP_PORT -u AIKAYUN_HTTPS_BIND_ADDRESS \
    -u AIKAYUN_HTTPS_PORT -u NUXT_PUBLIC_STORE_NAME -u NUXT_PUBLIC_STORE_LOGO_URL -u NUXT_PUBLIC_STORE_BRAND_COLOR \
    AIKAYUN_API_IMAGE="$SELECTED_API_IMAGE" AIKAYUN_WEB_IMAGE="$SELECTED_WEB_IMAGE" \
    AIKAYUN_POSTGRES_IMAGE="$SELECTED_POSTGRES_IMAGE" AIKAYUN_CADDY_IMAGE="$SELECTED_CADDY_IMAGE" \
    docker compose --project-name aikayun --file "$RELEASE_DIR/compose.yaml" --env-file "$TARGET_DIR/.env" "$@"
}

prepare_state_volume() {
  local rank="$1" exists label
  if docker volume inspect aikayun_state >/dev/null 2>&1; then exists=1; else exists=0; fi
  if (( rank < 3 )); then
    if (( exists == 0 )); then
      docker volume create --label com.aikayun.managed-by=aikayun-7-3 aikayun_state >/dev/null || \
        fail 'Could not create the fixed persistent state volume.'
      label="$(docker volume inspect aikayun_state --format '{{ index .Labels "com.aikayun.managed-by" }}')"
      [[ "$label" == aikayun-7-3 ]] || fail 'The fixed state volume appeared outside the current installation; automatic adoption is stopped.'
    else
      label="$(docker volume inspect aikayun_state --format '{{ index .Labels "com.aikayun.managed-by" }}')"
      [[ "$label" == aikayun-7-3 ]] || fail 'An unmarked state volume exists before storage initialization; automatic adoption is stopped.'
    fi
    run_job state-volume-init allow-empty-repair
    write_state storage_ready
  else
    (( exists == 1 )) || fail 'The persistent state volume is missing; automatic recreation is stopped to protect instance identity.'
    label="$(docker volume inspect aikayun_state --format '{{ index .Labels "com.aikayun.managed-by" }}')"
    [[ "$label" == aikayun-7-3 ]] || fail 'The persistent state volume ownership marker changed; automatic recovery is stopped.'
    run_job state-volume-init
  fi
}

prepare_compose_volumes() {
  local rank="$1" name compose_key labels project_label volume_label exists
  for name in 'aikayun_postgres_data:postgres_data' 'aikayun_caddy_data:caddy_data' 'aikayun_caddy_config:caddy_config'; do
    compose_key="${name#*:}"
    name="${name%%:*}"
    if docker volume inspect "$name" >/dev/null 2>&1; then exists=1; else exists=0; fi
    if (( exists == 0 && rank >= 4 )); then
      fail "A persistent volume is missing from a recorded deployment stage: $name. Automatic recreation is stopped."
    fi
    if (( exists == 0 )); then
      docker volume create \
        --label com.docker.compose.project=aikayun \
        --label "com.docker.compose.volume=$compose_key" \
        "$name" >/dev/null || fail "Could not create the fixed persistent volume: $name"
    fi
    labels="$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}|{{ index .Labels "com.docker.compose.volume" }}' "$name")"
    project_label="${labels%%|*}"
    volume_label="${labels#*|}"
    [[ "$project_label" == aikayun && "$volume_label" == "$compose_key" ]] || \
      fail "Persistent volume ownership does not match the fixed AiKayun Compose project: $name"
  done
}

prepare_secret_files() {
  local phase_rank_value="$1" staging="$TARGET_DIR/.secrets-initial" random_password payment_key delivery_key name
  if [[ -e "$TARGET_DIR/secrets" ]]; then
    [[ -d "$TARGET_DIR/secrets" && ! -L "$TARGET_DIR/secrets" ]] || fail 'The secrets directory is unsafe; no replacement values were created.'
    [[ "$(stat -c '%u:%g:%a' "$TARGET_DIR/secrets")" == '0:0:700' ]] || fail 'The secrets directory ownership or mode changed.'
    for name in postgres_admin_password api_database_password migrator_database_password payment_credential_key_ring code_pool_encryption_key_ring; do
      local owner='1000:1000:400:1'
      [[ "$name" == postgres_admin_password ]] && owner='0:0:400:1'
      [[ -f "$TARGET_DIR/secrets/$name" && ! -L "$TARGET_DIR/secrets/$name" && \
        "$(stat -c '%u:%g:%a:%h' "$TARGET_DIR/secrets/$name")" == "$owner" ]] || \
        fail "A persistent secret file is missing or unsafe: $name. No secret was regenerated."
    done
    for name in "$TARGET_DIR/secrets"/* "$TARGET_DIR/secrets"/.[!.]* "$TARGET_DIR/secrets"/..?*; do
      [[ -e "$name" ]] || continue
      case "${name##*/}" in postgres_admin_password|api_database_password|migrator_database_password|payment_credential_key_ring|code_pool_encryption_key_ring) ;;
        *) fail 'An unexpected entry exists in the persistent secrets directory.' ;;
      esac
    done
  elif (( phase_rank_value >= 2 )); then
    fail 'Persistent secrets are missing from a recorded install stage; automatic secret regeneration is stopped.'
  else
    [[ ! -e "$staging" ]] || rm -rf -- "$staging"
    mkdir -m 0700 "$staging"
    random_password() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }
    random_password > "$staging/postgres_admin_password"
    random_password > "$staging/api_database_password"
    random_password > "$staging/migrator_database_password"
    payment_key="$(random_password)"
    delivery_key="$(random_password)"
    printf '{"activeKeyId":"install-v1","keys":{"install-v1":"%s"}}\n' "$payment_key" > "$staging/payment_credential_key_ring"
    printf '{"activeKeyId":"install-v1","keys":{"install-v1":"%s"}}\n' "$delivery_key" > "$staging/code_pool_encryption_key_ring"
    chmod 0400 "$staging"/*
    chown 0:0 "$staging/postgres_admin_password"
    chown 1000:1000 "$staging/api_database_password" "$staging/migrator_database_password" \
      "$staging/payment_credential_key_ring" "$staging/code_pool_encryption_key_ring"
    mv "$staging" "$TARGET_DIR/secrets"
  fi
  [[ -f "$RELEASE_DIR/license-trust-bundle.jws" && ! -L "$RELEASE_DIR/license-trust-bundle.jws" && \
    "$(stat -c '%u:%g:%a:%h' "$RELEASE_DIR/license-trust-bundle.jws")" == '1000:1000:400:1' ]] || \
    fail 'The release Trust Bundle file permissions changed.'
  if [[ ! -f "$TARGET_DIR/.env" ]]; then
    local env_tmp="$TARGET_DIR/.env.$$.tmp"
    cat > "$env_tmp" <<EOF
AIKAYUN_PUBLIC_HOST=$SELECTED_DOMAIN
AIKAYUN_API_IMAGE=$SELECTED_API_IMAGE
AIKAYUN_WEB_IMAGE=$SELECTED_WEB_IMAGE
AIKAYUN_POSTGRES_IMAGE=$SELECTED_POSTGRES_IMAGE
AIKAYUN_CADDY_IMAGE=$SELECTED_CADDY_IMAGE
AIKAYUN_LICENSE_TRUST_BUNDLE_FILE=$RELEASE_DIR/license-trust-bundle.jws
AIKAYUN_POSTGRES_ADMIN_PASSWORD_FILE=$TARGET_DIR/secrets/postgres_admin_password
AIKAYUN_API_DATABASE_PASSWORD_FILE=$TARGET_DIR/secrets/api_database_password
AIKAYUN_MIGRATOR_DATABASE_PASSWORD_FILE=$TARGET_DIR/secrets/migrator_database_password
AIKAYUN_PAYMENT_CREDENTIAL_KEY_RING_FILE=$TARGET_DIR/secrets/payment_credential_key_ring
AIKAYUN_CODE_POOL_ENCRYPTION_KEY_RING_FILE=$TARGET_DIR/secrets/code_pool_encryption_key_ring
EOF
    chmod 0600 "$env_tmp"
    chown 0:0 "$env_tmp"
    mv "$env_tmp" "$TARGET_DIR/.env"
  else
    [[ -f "$TARGET_DIR/.env" && ! -L "$TARGET_DIR/.env" && "$(stat -c '%u:%g:%a:%h' "$TARGET_DIR/.env")" == '0:0:600:1' ]] || \
      fail 'The persistent Compose configuration file is unsafe.'
    cmp -s "$TARGET_DIR/.env" <(cat <<EOF
AIKAYUN_PUBLIC_HOST=$SELECTED_DOMAIN
AIKAYUN_API_IMAGE=$SELECTED_API_IMAGE
AIKAYUN_WEB_IMAGE=$SELECTED_WEB_IMAGE
AIKAYUN_POSTGRES_IMAGE=$SELECTED_POSTGRES_IMAGE
AIKAYUN_CADDY_IMAGE=$SELECTED_CADDY_IMAGE
AIKAYUN_LICENSE_TRUST_BUNDLE_FILE=$RELEASE_DIR/license-trust-bundle.jws
AIKAYUN_POSTGRES_ADMIN_PASSWORD_FILE=$TARGET_DIR/secrets/postgres_admin_password
AIKAYUN_API_DATABASE_PASSWORD_FILE=$TARGET_DIR/secrets/api_database_password
AIKAYUN_MIGRATOR_DATABASE_PASSWORD_FILE=$TARGET_DIR/secrets/migrator_database_password
AIKAYUN_PAYMENT_CREDENTIAL_KEY_RING_FILE=$TARGET_DIR/secrets/payment_credential_key_ring
AIKAYUN_CODE_POOL_ENCRYPTION_KEY_RING_FILE=$TARGET_DIR/secrets/code_pool_encryption_key_ring
EOF
) || fail 'The persistent Compose configuration differs from this installation.'
  fi
}

wait_healthy() {
  local service="$1" limit="${2:-300}" id health attempt
  for ((attempt=1; attempt<=limit; attempt++)); do
    id="$(compose ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$id" ]]; then
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
      [[ "$health" == healthy ]] && return 0
      [[ "$health" == exited || "$health" == dead ]] && return 1
    fi
    sleep 2
  done
  return 1
}

run_job() {
  local service="$1" status mode="${2:-verify}"
  set +e
  if [[ "$service" == state-volume-init && "$mode" == allow-empty-repair ]]; then
    compose run --rm --no-deps -e AIKAYUN_STATE_ALLOW_EMPTY_REPAIR=true "$service"
  else
    compose run --rm --no-deps "$service"
  fi
  status=$?
  set -e
  [[ "$status" == 0 ]] || fail "$service exited with status $status. Database state was not assumed to have rolled back; run diagnose and then resume."
}

probe_https() {
  local response="$WORK_DIR/setup-status.json"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --connect-timeout 5 --max-time 15 \
    --resolve "$SELECTED_DOMAIN:443:127.0.0.1" "https://$SELECTED_DOMAIN/api/v1/setup/status" --output "$response" || return 1
  docker run --rm --mount "type=bind,source=$WORK_DIR,target=/work,readonly" --entrypoint node "$NODE_IMAGE" -e '
    const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync("/work/setup-status.json","utf8"));
    if(r?.data?.status!=="required" && r?.data?.status!=="completed") process.exit(1);
  ' || return 1
}

issue_setup_token() {
  probe_https || fail 'HTTPS/ACME is not ready. The installation state is retained; do not use HTTP. Fix DNS, ports, or ACME access and run resume.'
  local setup_status
  setup_status="$(grep -o '"status":"[a-z]*"' "$WORK_DIR/setup-status.json" | head -1 || true)"
  if [[ "$setup_status" == '"status":"completed"' ]]; then
    printf 'Administrator initialization is already complete. No token was issued.\n'
    return 0
  fi
  # The CLI prints the credential only to this controlled terminal. Compose/API logs never contain it.
  compose exec -T api /nodejs/bin/node /app/dist/setup-token-cli.js issue
}

initialize_services() {
  local saved_phase rank
  saved_phase="$(state_value phase)"
  rank="$(phase_rank "$saved_phase")"
  prepare_secret_files "$rank"
  if (( rank < 2 )); then write_state secrets_ready; rank=2; fi
  prepare_state_volume "$rank"
  saved_phase="$(state_value phase)"
  rank="$(phase_rank "$saved_phase")"
  prepare_compose_volumes "$rank"
  if (( rank < 4 )); then write_state storage_volumes_ready; rank=4; fi
  compose config --quiet || fail 'Compose configuration validation failed before any service was started.'

  compose up -d --no-recreate db
  wait_healthy db 300 || fail 'PostgreSQL did not become healthy. Persistent volumes were kept; inspect status and resume.'
  if (( rank < 5 )); then write_state database_ready; rank=5; fi

  if (( rank < 6 )); then
    run_job db-role-init
    write_state roles_ready
    rank=6
  fi

  # Re-running the migration command reads the real PostgreSQL migration journal first.
  # An unknown process exit is never interpreted as a database rollback.
  run_job migrate
  if (( rank < 7 )); then write_state migrated; rank=7; fi

  # This create-once production entrypoint resumes the existing identity journal and verifies
  # an existing Pending Key; it never rotates either persisted identity or encryption material.
  run_job production-install-init
  if (( rank < 8 )); then write_state identity_ready; rank=8; fi

  compose up -d --no-recreate api
  wait_healthy api 300 || fail 'The API did not become healthy. Persistent data and services were kept; inspect status and resume.'
  if (( rank < 9 )); then write_state api_ready; rank=9; fi

  compose up -d --no-recreate web
  wait_healthy web 300 || fail 'The Web service did not become healthy. Persistent data and services were kept; inspect status and resume.'
  if (( rank < 10 )); then write_state web_ready; rank=10; fi

  compose up -d --no-recreate caddy
  local caddy_id
  caddy_id="$(compose ps -q caddy)"
  [[ -n "$caddy_id" ]] && [[ "$(docker inspect --format '{{.State.Status}}' "$caddy_id")" == running ]] || \
    fail 'Caddy did not start. Persistent state was kept; inspect status and resume.'
  if (( rank < 11 )); then write_state caddy_started; rank=11; fi

  if ! probe_https; then
    fail 'DNS, ACME, or TLS is not ready. Caddy remains configured for automatic HTTPS and setup credentials were not issued. Correct the cause and run resume.'
  fi
  if (( rank < 12 )); then write_state https_ready; rank=12; fi
  if (( rank < 13 )); then
    issue_setup_token
    write_state setup_token_issued
  fi
}

install_new() {
  local stale
  require_root
  [[ -n "$SELECTED_RELEASE_ORIGIN" && -n "$SELECTED_VERSION" && -n "$SELECTED_DOMAIN" ]] || \
    fail 'install requires --release-origin, --version, and --domain.'
  host_preflight
  check_public_ports_available false
  check_public_domain "$SELECTED_DOMAIN"
  check_release_origin
  if [[ -e "$TARGET_DIR" ]]; then
    [[ -d "$TARGET_DIR" && ! -L "$TARGET_DIR" && -z "$(find "$TARGET_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] || \
      fail '/opt/aikayun is not empty. The installer will not adopt or overwrite an existing deployment.'
  fi
  for volume in aikayun_postgres_data aikayun_state aikayun_caddy_data aikayun_caddy_config; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      fail "A persistent Docker volume already exists ($volume). Automatic initialization is stopped to protect existing data."
    fi
  done
  if docker network inspect aikayun_private >/dev/null 2>&1; then fail 'The fixed AiKayun Docker network already exists; inspect the existing deployment first.'; fi
  WORK_DIR="$(mktemp -d /var/tmp/aikayun-install.XXXXXX)"
  chmod 0700 "$WORK_DIR"
  download_and_verify_release
  mkdir -p /opt
  while IFS= read -r -d '' stale; do
    [[ -d "$stale" && ! -L "$stale" ]] || fail 'Unsafe installer staging path found under /opt.'
    if [[ -f "$stale/.install-owner" && ! -L "$stale/.install-owner" ]]; then
      [[ "$(cat "$stale/.install-owner")" == aikayun-install-v1 ]] || fail 'An unrecognized installer staging marker exists under /opt.'
      rm -rf -- "$stale"
    elif [[ -z "$(find "$stale" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
      rmdir -- "$stale"
    else
      fail 'An unmarked interrupted staging directory exists under /opt; inspect it before retrying.'
    fi
  done < <(find /opt -maxdepth 1 -type d -name '.aikayun-installing.*' -print0)
  STAGING_DIR="$(mktemp -d /opt/.aikayun-installing.XXXXXX)"
  chmod 0700 "$STAGING_DIR"
  printf '%s\n' aikayun-install-v1 > "$STAGING_DIR/.install-owner"
  chmod 0600 "$STAGING_DIR/.install-owner"
  chown 0:0 "$STAGING_DIR/.install-owner"
  cp -a "$WORK_DIR/release" "$STAGING_DIR/release"
  chmod -R a+rX "$STAGING_DIR/release"
  chmod 0400 "$STAGING_DIR/release/license-trust-bundle.jws"
  chown 1000:1000 "$STAGING_DIR/release/license-trust-bundle.jws"
  install -m 0755 "$STAGING_DIR/release/install.sh" "$STAGING_DIR/aikayun"
  SELECTED_RELEASE_ORIGIN="${SELECTED_RELEASE_ORIGIN%/}"
  write_state verified "$STAGING_DIR"
  if [[ -d "$TARGET_DIR" ]]; then rmdir -- "$TARGET_DIR" || fail '/opt/aikayun became non-empty while installation was being verified.'; fi
  mv -- "$STAGING_DIR" "$TARGET_DIR"
  STAGING_DIR=''
  load_release_image_digests
  initialize_services
  RELEASE_BASE=''
}

resume_install() {
  require_root
  host_preflight
  [[ -s "$STATE_FILE" ]] || fail 'No saved AiKayun installation exists. Run install for a new deployment.'
  SELECTED_VERSION="$(state_value version)"
  SELECTED_RELEASE_ORIGIN="$(state_value release_origin)"
  SELECTED_DOMAIN="$(state_value domain)"
  saved_bundle_verify
  check_public_ports_available true
  check_public_domain "$SELECTED_DOMAIN"
  WORK_DIR="$(mktemp -d /var/tmp/aikayun-install.XXXXXX)"
  chmod 0700 "$WORK_DIR"
  initialize_services
}

https_status() {
  local domain="$1" output="$2"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --connect-timeout 5 --max-time 15 \
    --resolve "$domain:443:127.0.0.1" "https://$domain/api/v1/setup/status" --output "$output"
}

show_status() {
  require_root
  docker_ready
  check_docker_local_engine
  if [[ ! -f "$STATE_FILE" ]]; then
    printf 'AiKayun deployment state: not installed\n'
    return 0
  fi
  node_target '
    const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync("/target/install-state.json","utf8"));
    for(const k of ["phase","version","domain","release_origin","manifest_sha256","updated_at"]) console.log(`${k}: ${s[k]}`);
  ' || fail 'The saved deployment state is invalid.'
  if [[ -f "$TARGET_DIR/.env" ]]; then compose ps
  else printf 'Compose services: not started\n'; fi
}

diagnose() {
  require_root
  docker_ready
  check_docker_local_engine
  if [[ ! -f "$STATE_FILE" ]]; then fail 'No saved deployment is available to diagnose.'; fi
  saved_bundle_verify
  if [[ -f "$TARGET_DIR/.env" ]]; then compose ps
  else printf 'Compose configuration: not prepared\n'; fi
  if compose exec -T api /nodejs/bin/node /app/dist/production-install-init.js verify >/dev/null 2>&1; then
    printf 'identity and Pending Key: verified\n'
  else
    printf 'identity and Pending Key: not verified\n'
  fi
  WORK_DIR="$(mktemp -d /var/tmp/aikayun-install.XXXXXX)"
  chmod 0700 "$WORK_DIR"
  local response="$WORK_DIR/setup-status.json" domain
  domain="$(state_value domain)"
  if https_status "$domain" "$response" >/dev/null 2>&1; then
    if grep -q '"status":"completed"' "$response"; then printf 'HTTPS setup: initialized\n'
    else printf 'HTTPS setup: available\n'; fi
  else
    printf 'HTTPS setup: unavailable; no HTTP fallback is used\n'
  fi
}

setup_token_command() {
  require_root
  docker_ready
  check_docker_local_engine
  if [[ ! -f "$STATE_FILE" ]]; then fail 'No saved deployment is available.'; fi
  saved_bundle_verify
  WORK_DIR="$(mktemp -d /var/tmp/aikayun-install.XXXXXX)"
  chmod 0700 "$WORK_DIR"
  local domain response
  domain="$(state_value domain)"
  response="$WORK_DIR/setup-status.json"
  https_status "$domain" "$response" || fail 'Verified HTTPS is not ready; no setup token was issued.'
  if grep -q '"status":"completed"' "$response"; then
    printf 'Administrator initialization is already complete. No token was issued.\n'
    return 0
  fi
  compose exec -T api /nodejs/bin/node /app/dist/setup-token-cli.js issue
  write_state setup_token_issued
}

parse_install_options() {
  shift
  while (($#)); do
    case "$1" in
      --release-origin) (($# >= 2)) || fail '--release-origin requires a value.'; SELECTED_RELEASE_ORIGIN="$2"; shift 2 ;;
      --version) (($# >= 2)) || fail '--version requires a value.'; SELECTED_VERSION="$2"; shift 2 ;;
      --domain) (($# >= 2)) || fail '--domain requires a value.'; SELECTED_DOMAIN="$2"; shift 2 ;;
      *) fail "Unsupported install option: $1" ;;
    esac
  done
}

main() {
  local command="${1:-help}"
  case "$command" in
    help|-h|--help) usage ;;
    install)
      parse_install_options "$@"
      require_root
      begin_lock
      require_host_commands
      find /var/tmp -maxdepth 1 -type d -name 'aikayun-install.*' -user 0 -mmin +1 -exec rm -rf -- {} + 2>/dev/null || true
      install_new
      ;;
    resume)
      (($# == 1)) || fail 'resume does not accept options; it uses the verified saved deployment.'
      require_root
      begin_lock
      require_host_commands
      find /var/tmp -maxdepth 1 -type d -name 'aikayun-install.*' -user 0 -mmin +1 -exec rm -rf -- {} + 2>/dev/null || true
      resume_install
      ;;
    status)
      (($# == 1)) || fail 'status does not accept options.'
      require_root
      begin_lock
      show_status
      ;;
    diagnose)
      (($# == 1)) || fail 'diagnose does not accept options.'
      require_root
      begin_lock
      diagnose
      ;;
    setup-token)
      (($# == 1)) || fail 'setup-token does not accept options.'
      require_root
      begin_lock
      require_host_commands
      setup_token_command
      ;;
    *) usage; fail "Unknown command: $command" ;;
  esac
}

main "$@"
