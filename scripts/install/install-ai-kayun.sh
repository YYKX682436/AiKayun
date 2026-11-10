#!/bin/bash -p
set -Eeuo pipefail
set +x
umask 077

readonly TARGET_DIR='/opt/aikayun'
readonly RELEASE_DIR='/opt/aikayun/release'
readonly STATE_FILE='/opt/aikayun/install-state.json'
readonly PREVIOUS_RELEASE_DIR='/opt/aikayun/previous-release'
readonly UPGRADE_STAGING_DIR='/opt/aikayun/.release-upgrade-new'
readonly UPGRADE_OLDER_RELEASE_DIR='/opt/aikayun/.release-upgrade-older'
readonly UPGRADE_JOURNAL_FILE='/opt/aikayun/.upgrade-journal.json'
readonly UPGRADE_STATE_BACKUP='/opt/aikayun/.upgrade-state-backup'
readonly UPGRADE_ENV_BACKUP='/opt/aikayun/.upgrade-env-backup'
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
SELECTED_BACKUP_RESTIC_IMAGE=''
RELEASE_BASE=''
UPGRADE_PRE_ACCEPTANCE=0
UPGRADE_CANDIDATE_DIR=''
CURRENT_RELEASE_VERSION=''
CURRENT_RELEASE_MANIFEST_SHA256=''
CURRENT_API_IMAGE=''
CURRENT_WEB_IMAGE=''
CURRENT_POSTGRES_IMAGE=''
CURRENT_CADDY_IMAGE=''
CURRENT_BACKUP_RESTIC_IMAGE=''
CANDIDATE_RELEASE_VERSION=''
CANDIDATE_RELEASE_MANIFEST_SHA256=''
CANDIDATE_API_IMAGE=''
CANDIDATE_WEB_IMAGE=''
CANDIDATE_POSTGRES_IMAGE=''
CANDIDATE_CADDY_IMAGE=''
CANDIDATE_BACKUP_RESTIC_IMAGE=''

cleanup() {
  local status=$?
  if [[ "$UPGRADE_PRE_ACCEPTANCE" == 1 ]]; then
    set +e
    rollback_upgrade_before_acceptance
    rollback_status=$?
    set -e
    if [[ "$rollback_status" != 0 ]]; then
      printf 'AiKayun installer: automatic rollback could not be completed. The database and persistent volumes were kept; inspect the upgrade state before retrying.\n' >&2
    fi
  fi
  if [[ "$UPGRADE_PRE_ACCEPTANCE" != 1 && ! -e "$UPGRADE_JOURNAL_FILE" && \
     -d "$UPGRADE_STAGING_DIR" && ! -L "$UPGRADE_STAGING_DIR" ]]; then
    rm -rf -- "$UPGRADE_STAGING_DIR"
  fi
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then rm -rf -- "$WORK_DIR"; fi
  if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then rm -rf -- "$STAGING_DIR"; fi
  if declare -F backup_stream_cleanup >/dev/null 2>&1; then backup_stream_cleanup; fi
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
  install.sh upgrade --version VERSION
  install.sh diagnose
  install.sh setup-token

install/resume require Linux, root, Docker Engine, Docker Compose v2, DNS for the
store hostname, and free TCP ports 80 and 443. Upgrade requires a verified, fully
initialized deployment and the same local Docker Engine. The installer never installs Docker
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
  if ! flock -n 9; then fail 'Another install, resume, setup-token, backup, or upgrade command holds the deployment lock.'; fi
  [[ "$(stat -c '%u:%g:%a:%h' "$LOCK_FILE")" == '0:0:600:1' ]] || fail 'The shared deployment lock file is unsafe.'
}

require_host_commands() {
  local name
  for name in awk base64 basename cat chmod chown cmp cp curl date df diff dirname docker env find flock getent grep head id install mkdir mkfifo mktemp mv realpath rmdir rm sed sha256sum sleep sort stat timeout tr uname; do
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

verify_local_release_cosign() {
  docker run --rm --mount "type=bind,source=$1,target=/release,readonly" --entrypoint cosign "$COSIGN_IMAGE" \
    verify-blob --bundle /release/release-manifest.cosign.bundle \
    --certificate-identity "$RELEASE_CERT_IDENTITY" --certificate-oidc-issuer "$RELEASE_OIDC_ISSUER" \
    /release/release-manifest.json >/dev/null
}

# Only use the artifact verifier and JWS root after installer-owned checks
# authenticate their bytes against the Cosign-authenticated manifest.
verify_authenticated_release_jws() {
  docker run --rm --mount "type=bind,source=$1,target=/release,readonly" --entrypoint node "$NODE_IMAGE" \
    /release/release-verifier.mjs /release/release-manifest.json /release/release-manifest.jws \
    /release/release-signing-root.jwk.json >/dev/null
}

verify_release_artifacts_with_installer() {
  local directory="$1"
  docker run --rm --mount "type=bind,source=$directory,target=/release,readonly" \
    --entrypoint node "$NODE_IMAGE" -e '
    const fs=require("node:fs");
    const path=require("node:path");
    const crypto=require("node:crypto");
    const root=path.resolve(process.argv[1]);
    const fail=message=>{ process.stderr.write(`installer-owned release verification failed: ${message}\n`); process.exit(1); };
    const controls=new Set(["release-manifest.json","release-manifest.jws","release-manifest.cosign.bundle"]);
    const canonicalRelative=name=>typeof name==="string" && name.length>0 && name.length<=128 &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes("..") && !name.includes("\\") &&
      !name.split("/").some(part=>part==="" || part==="." || part==="..");
    const safeRegular=(file,maxBytes)=>{
      let info;
      try { info=fs.lstatSync(file,{bigint:true}); } catch { fail("required control file is missing"); }
      if(!info.isFile() || info.nlink!==1n || info.size>BigInt(maxBytes)) fail("control file type, link count, or size is unsafe");
      const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try {
        const opened=fs.fstatSync(fd,{bigint:true});
        if(!opened.isFile() || opened.nlink!==1n || opened.dev!==info.dev || opened.ino!==info.ino || opened.size!==info.size)
          fail("control file changed while opening");
        const bytes=fs.readFileSync(fd);
        if(BigInt(bytes.length)!==opened.size) fail("control file changed while reading");
        return bytes;
      } finally { fs.closeSync(fd); }
    };
    let rootInfo;
    try { rootInfo=fs.lstatSync(root); } catch { fail("release directory is missing"); }
    if(!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("release root is not a real directory");
    for(const name of controls) safeRegular(path.join(root,name),16*1024*1024);
    const manifestBytes=safeRegular(path.join(root,"release-manifest.json"),16*1024*1024);
    let manifest;
    try { manifest=JSON.parse(manifestBytes.toString("utf8")); } catch { fail("signed manifest is not valid JSON"); }
    if(!manifest || !Array.isArray(manifest.artifacts) || manifest.artifacts.length===0 || manifest.artifacts.length>4096)
      fail("signed manifest artifact list is invalid");
    const expected=new Map();
    for(const artifact of manifest.artifacts) {
      if(!artifact || !canonicalRelative(artifact.name) || controls.has(artifact.name) ||
        !Number.isSafeInteger(artifact.size) || artifact.size<0 || !/^[a-f0-9]{64}$/.test(artifact.sha256) || expected.has(artifact.name))
        fail("signed manifest contains an unsafe or duplicate artifact entry");
      expected.set(artifact.name,artifact);
    }
    const expectedDirectories=new Set();
    for(const name of expected.keys()) {
      const parts=name.split("/");
      for(let index=1;index<parts.length;index++) expectedDirectories.add(parts.slice(0,index).join("/"));
    }
    const actualFiles=new Set();
    const walk=(directory,prefix="")=>{
      let entries;
      try { entries=fs.readdirSync(directory,{withFileTypes:true}); } catch { fail("release directory cannot be read"); }
      for(const entry of entries) {
        const name=prefix ? `${prefix}/${entry.name}` : entry.name;
        if(!canonicalRelative(name)) fail("release tree contains an unsafe path");
        const file=path.join(directory,entry.name);
        let info;
        try { info=fs.lstatSync(file,{bigint:true}); } catch { fail("release tree changed while scanning"); }
        if(info.isSymbolicLink()) fail("release tree contains a symbolic link");
        if(info.isDirectory()) {
          if(!expectedDirectories.has(name)) fail("release tree contains an unlisted directory");
          walk(file,name);
        } else if(info.isFile()) {
          if(!controls.has(name) && !expected.has(name)) fail("release tree contains an unlisted file");
          actualFiles.add(name);
        } else fail("release tree contains a special file");
      }
    };
    walk(root);
    for(const name of controls) if(!actualFiles.has(name)) fail("release control file is missing from the tree");
    for(const [name,artifact] of expected) {
      if(!actualFiles.has(name)) fail("signed artifact is missing");
      const file=path.join(root,...name.split("/"));
      let parent=root;
      for(const part of name.split("/")) {
        parent=path.join(parent,part);
        const info=fs.lstatSync(parent,{bigint:true});
        if(info.isSymbolicLink() || (parent===file ? !info.isFile() : !info.isDirectory()))
          fail("signed artifact path contains a symlink or non-regular entry");
      }
      const info=fs.lstatSync(file,{bigint:true});
      if(!info.isFile() || info.nlink!==1n || info.size!==BigInt(artifact.size)) fail("signed artifact type or length mismatch");
      const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try {
        const opened=fs.fstatSync(fd,{bigint:true});
        if(!opened.isFile() || opened.nlink!==1n || opened.dev!==info.dev || opened.ino!==info.ino || opened.size!==info.size)
          fail("signed artifact changed while opening");
        const hash=crypto.createHash("sha256");
        const buffer=Buffer.allocUnsafe(64*1024);
        let total=0n;
        for(;;) {
          const count=fs.readSync(fd,buffer,0,buffer.length,null);
          if(count===0) break;
          total+=BigInt(count);
          if(total>BigInt(artifact.size)) fail("signed artifact grew while hashing");
          hash.update(buffer.subarray(0,count));
        }
        const after=fs.fstatSync(fd,{bigint:true});
        if(total!==BigInt(artifact.size) || after.dev!==opened.dev || after.ino!==opened.ino || after.size!==opened.size ||
          hash.digest("hex")!==artifact.sha256) fail("signed artifact length or SHA-256 mismatch");
      } finally { fs.closeSync(fd); }
    }
  ' /release || return 1
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
  verify_release_artifacts_with_installer "$WORK_DIR/release" || \
    fail 'Installer-owned verification rejected a release artifact before any downloaded verifier could run.'
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

verify_release_image_signature() {
  local image="$1"; shift
  "$@" run --rm --entrypoint cosign "$COSIGN_IMAGE" verify \
    --certificate-identity "$RELEASE_CERT_IDENTITY" --certificate-oidc-issuer "$RELEASE_OIDC_ISSUER" \
    "$image" >/dev/null
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
  for name in api web postgres caddy backup; do
    image="$(docker run --rm --mount "type=bind,source=$directory,target=/release,readonly" \
      --entrypoint node "$NODE_IMAGE" -e '
        const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync("/release/release-manifest.json","utf8"));
        const name=process.argv[1], i=m.images?.[name];
        if(!i || typeof i.reference!=="string" || !/@sha256:[a-f0-9]{64}$/.test(i.reference)) process.exit(1);
        process.stdout.write(i.reference);
      ' "$name")" || fail "The signed manifest has no valid $name image digest."
    if [[ "$name" != backup ]]; then
      grep -Fqx "    image: $image" "$directory/compose.yaml" || fail "Compose does not use the signed $name image digest."
    fi
    docker pull "$image" >/dev/null || fail "Could not pull the digest-pinned $name image."
    if [[ "$name" == api || "$name" == web || "$name" == backup ]]; then
      verify_release_image_signature "$image" docker || fail "Cosign rejected the $name image signature."
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
  if [[ -e "$UPGRADE_JOURNAL_FILE" || -L "$UPGRADE_JOURNAL_FILE" ]]; then
    local journal_phase
    journal_phase="$(node_target 'const fs=require("node:fs");const j=JSON.parse(fs.readFileSync("/target/.upgrade-journal.json","utf8"));if(j.schema!==1||typeof j.phase!=="string")process.exit(1);process.stdout.write(j.phase)')" || \
      fail 'An invalid upgrade journal exists; no automatic service or data changes were attempted.'
    if [[ "$journal_phase" == candidate_active_starting ]]; then
      fail 'An upgrade stopped after candidate services could run business or external operations. Automatic rollback is blocked; inspect status and diagnose.'
    fi
    fail 'An upgrade was interrupted before acceptance. Inspect status and diagnose before running another operation.'
  fi
  recorded_sha="$(node_target '
    const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync("/target/install-state.json","utf8"));
    const base=["domain","manifest_sha256","phase","release_origin","schema","updated_at","version"].sort().join(",");
    const withUpgrade=[...base.split(","),"upgrade"].sort().join(",");
    const keys=Object.keys(s||{}).sort().join(",");
    if(!s || typeof s!=="object" || (keys!==base && keys!==withUpgrade) || s.schema!==1 ||
      !/^[a-zA-Z0-9.-]{1,253}$/.test(s.domain) || !/^[a-f0-9]{64}$/.test(s.manifest_sha256) ||
      !/^[0-9A-Za-z.+-]{1,64}$/.test(s.version) || !["verified","secrets_ready","storage_ready","storage_volumes_ready","database_ready","roles_ready","migrated","identity_ready","api_ready","web_ready","caddy_started","https_ready","setup_token_issued"].includes(s.phase) ||
      typeof s.release_origin!=="string" || typeof s.updated_at!=="string") process.exit(1);
    if(keys===withUpgrade && (!s.upgrade || typeof s.upgrade!=="object" || Array.isArray(s.upgrade) ||
      Object.keys(s.upgrade).sort().join(",")!=="previous_manifest_sha256,previous_version,rollback_status" ||
      !/^[0-9A-Za-z.+-]{1,64}$/.test(s.upgrade.previous_version) ||
      !/^[a-f0-9]{64}$/.test(s.upgrade.previous_manifest_sha256) ||
      !["blocked_after_candidate_start","blocked_after_acceptance"].includes(s.upgrade.rollback_status))) process.exit(1);
    process.stdout.write(s.manifest_sha256);
  ')" || fail 'The persisted install-state record is invalid; automatic initialization is stopped.'
  MANIFEST_SHA256="$(sha256sum "$RELEASE_DIR/release-manifest.json" | awk '{print $1}')"
  [[ "$MANIFEST_SHA256" == "$recorded_sha" ]] || fail 'The stored release manifest differs from the recorded verified digest.'
  verify_local_release_cosign "$RELEASE_DIR" || fail 'The stored release manifest Cosign signature is invalid.'
  verify_release_artifacts_with_installer "$RELEASE_DIR" || \
    fail 'Installer-owned verification rejected a stored release artifact before any downloaded verifier could run.'
  verify_authenticated_release_jws "$RELEASE_DIR" || fail 'The stored release JWS signature is invalid.'
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
  load_release_image_digests_from "$RELEASE_DIR"
}

load_release_image_digests_from() {
  local directory="$1" image_references image_reference
  local -a image_references_array
  image_references="$(docker run --rm --mount "type=bind,source=$directory,target=/release,readonly" --entrypoint node "$NODE_IMAGE" -e '
    const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync("/release/release-manifest.json","utf8"));
    const values=[m.images?.api?.reference,m.images?.web?.reference,m.images?.postgres?.reference,m.images?.caddy?.reference,m.images?.backup?.reference];
    if(values.some(v=>typeof v!=="string" || !/@sha256:[a-f0-9]{64}$/.test(v))) process.exit(1);
    process.stdout.write(values.join("\n"));
  ')" || fail 'Could not load the five verified image references.'
  mapfile -t image_references_array <<< "$image_references"
  [[ "${#image_references_array[@]}" == 5 ]] || fail 'The signed release manifest must contain exactly five images.'
  SELECTED_API_IMAGE="${image_references_array[0]}"
  SELECTED_WEB_IMAGE="${image_references_array[1]}"
  SELECTED_POSTGRES_IMAGE="${image_references_array[2]}"
  SELECTED_CADDY_IMAGE="${image_references_array[3]}"
  SELECTED_BACKUP_RESTIC_IMAGE="${image_references_array[4]}"
  for image_reference in "${image_references_array[@]}"; do
    [[ "$image_reference" =~ ^(ghcr\.io/yykx682436/aikayun-(api|web|backup-restic)|docker\.io/library/(postgres|caddy))@sha256:[a-f0-9]{64}$ ]] || \
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
  local phase="$1" directory="${2:-$TARGET_DIR}" now temporary serialized
  now="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  temporary="$directory/.install-state.$$.tmp"
  if [[ "$directory" == "$TARGET_DIR" && -f "$STATE_FILE" ]]; then
    serialized="$(node_target '
      const fs=require("node:fs");
      const prior=JSON.parse(fs.readFileSync("/target/install-state.json","utf8"));
      const [phase,domain,origin,version,sha,updated]=process.argv.slice(1);
      const next={schema:1,phase,domain,release_origin:origin,version,manifest_sha256:sha,updated_at:updated};
      if(prior.upgrade) next.upgrade=prior.upgrade;
      process.stdout.write(JSON.stringify(next)+"\n");
    ' "$phase" "$SELECTED_DOMAIN" "$SELECTED_RELEASE_ORIGIN" "$SELECTED_VERSION" "$MANIFEST_SHA256" "$now")" || \
      fail 'Could not preserve the recorded upgrade state.'
    printf '%s' "$serialized" > "$temporary"
  else
    printf '{"schema":1,"phase":"%s","domain":"%s","release_origin":"%s","version":"%s","manifest_sha256":"%s","updated_at":"%s"}\n' \
      "$phase" "$SELECTED_DOMAIN" "$SELECTED_RELEASE_ORIGIN" "$SELECTED_VERSION" "$MANIFEST_SHA256" "$now" > "$temporary"
  fi
  chmod 0600 "$temporary"
  chown 0:0 "$temporary"
  mv -f -- "$temporary" "$directory/install-state.json"
}

write_upgrade_state() {
  local phase="$1" rollback_status="$2" previous_version="$3" previous_sha="$4" now temporary
  now="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  temporary="$TARGET_DIR/.install-state.$$.tmp"
  printf '{"schema":1,"phase":"%s","domain":"%s","release_origin":"%s","version":"%s","manifest_sha256":"%s","updated_at":"%s","upgrade":{"previous_version":"%s","previous_manifest_sha256":"%s","rollback_status":"%s"}}\n' \
    "$phase" "$SELECTED_DOMAIN" "$SELECTED_RELEASE_ORIGIN" "$SELECTED_VERSION" "$MANIFEST_SHA256" "$now" \
    "$previous_version" "$previous_sha" "$rollback_status" > "$temporary"
  chmod 0600 "$temporary"
  chown 0:0 "$temporary"
  mv -f -- "$temporary" "$STATE_FILE"
}

compose() {
  env \
    -u AIKAYUN_API_IMAGE -u AIKAYUN_WEB_IMAGE -u AIKAYUN_POSTGRES_IMAGE -u AIKAYUN_CADDY_IMAGE \
    -u AIKAYUN_PUBLIC_HOST -u AIKAYUN_LICENSE_TRUST_BUNDLE_FILE \
    -u AIKAYUN_POSTGRES_ADMIN_PASSWORD_FILE -u AIKAYUN_API_DATABASE_PASSWORD_FILE -u AIKAYUN_MIGRATOR_DATABASE_PASSWORD_FILE \
    -u AIKAYUN_PAYMENT_CREDENTIAL_KEY_RING_FILE -u AIKAYUN_CODE_POOL_ENCRYPTION_KEY_RING_FILE -u AIKAYUN_DB_NAME \
    -u AIKAYUN_PRIVATE_SUBNET -u AIKAYUN_HTTP_BIND_ADDRESS -u AIKAYUN_HTTP_PORT -u AIKAYUN_HTTPS_BIND_ADDRESS \
    -u AIKAYUN_HTTPS_PORT -u AIKAYUN_UPGRADE_PROBE_ONLY -u NUXT_PUBLIC_STORE_NAME -u NUXT_PUBLIC_STORE_LOGO_URL -u NUXT_PUBLIC_STORE_BRAND_COLOR \
    AIKAYUN_API_IMAGE="$SELECTED_API_IMAGE" AIKAYUN_WEB_IMAGE="$SELECTED_WEB_IMAGE" \
    AIKAYUN_POSTGRES_IMAGE="$SELECTED_POSTGRES_IMAGE" AIKAYUN_CADDY_IMAGE="$SELECTED_CADDY_IMAGE" \
    docker compose --project-name aikayun --file "$RELEASE_DIR/compose.yaml" --env-file "$TARGET_DIR/.env" "$@"
}

compose_with_release() {
  local compose_file="$1" probe_only="$2"
  shift 2
  env \
    -u AIKAYUN_API_IMAGE -u AIKAYUN_WEB_IMAGE -u AIKAYUN_POSTGRES_IMAGE -u AIKAYUN_CADDY_IMAGE \
    -u AIKAYUN_PUBLIC_HOST -u AIKAYUN_LICENSE_TRUST_BUNDLE_FILE \
    -u AIKAYUN_POSTGRES_ADMIN_PASSWORD_FILE -u AIKAYUN_API_DATABASE_PASSWORD_FILE -u AIKAYUN_MIGRATOR_DATABASE_PASSWORD_FILE \
    -u AIKAYUN_PAYMENT_CREDENTIAL_KEY_RING_FILE -u AIKAYUN_CODE_POOL_ENCRYPTION_KEY_RING_FILE -u AIKAYUN_DB_NAME \
    -u AIKAYUN_PRIVATE_SUBNET -u AIKAYUN_HTTP_BIND_ADDRESS -u AIKAYUN_HTTP_PORT -u AIKAYUN_HTTPS_BIND_ADDRESS \
    -u AIKAYUN_HTTPS_PORT -u AIKAYUN_UPGRADE_PROBE_ONLY -u NUXT_PUBLIC_STORE_NAME -u NUXT_PUBLIC_STORE_LOGO_URL -u NUXT_PUBLIC_STORE_BRAND_COLOR \
    AIKAYUN_API_IMAGE="$SELECTED_API_IMAGE" AIKAYUN_WEB_IMAGE="$SELECTED_WEB_IMAGE" \
    AIKAYUN_POSTGRES_IMAGE="$SELECTED_POSTGRES_IMAGE" AIKAYUN_CADDY_IMAGE="$SELECTED_CADDY_IMAGE" \
    AIKAYUN_UPGRADE_PROBE_ONLY="$probe_only" \
    docker compose --project-name aikayun --file "$compose_file" --env-file "$TARGET_DIR/.env" "$@"
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
  install -m 0555 "$STAGING_DIR/release/install.sh" "$STAGING_DIR/aikayun"
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
  if [[ ! -e "$UPGRADE_JOURNAL_FILE" ]]; then
    saved_bundle_verify
  else
    SELECTED_VERSION="$(state_value version)"
    SELECTED_RELEASE_ORIGIN="$(state_value release_origin)"
    SELECTED_DOMAIN="$(state_value domain)"
    load_release_image_digests
  fi
  node_target '
    const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync("/target/install-state.json","utf8"));
    for(const k of ["phase","version","domain","release_origin","manifest_sha256","updated_at"]) console.log(`${k}: ${s[k]}`);
    if(s.upgrade) {
      console.log(`previous_version: ${s.upgrade.previous_version}`);
      console.log(`rollback_status: ${s.upgrade.rollback_status}`);
    }
    try {
      const j=JSON.parse(fs.readFileSync("/target/.upgrade-journal.json","utf8"));
      console.log(`upgrade_journal: ${j.phase} (${j.from_version} -> ${j.to_version})`);
    } catch (error) { if(error.code!=="ENOENT") process.exit(1); }
  ' || fail 'The saved deployment state is invalid.'
  if [[ -f "$TARGET_DIR/.env" ]]; then compose ps
  else printf 'Compose services: not started\n'; fi
}

diagnose() {
  require_root
  docker_ready
  check_docker_local_engine
  if [[ ! -f "$STATE_FILE" ]]; then fail 'No saved deployment is available to diagnose.'; fi
  if [[ -e "$UPGRADE_JOURNAL_FILE" || -L "$UPGRADE_JOURNAL_FILE" ]]; then
    node_target '
      const fs=require("node:fs");
      const j=JSON.parse(fs.readFileSync("/target/.upgrade-journal.json","utf8"));
      if(j.schema!==1 || typeof j.phase!=="string") process.exit(1);
      console.log(`Interrupted upgrade: ${j.phase} (${j.from_version} -> ${j.to_version})`);
      if(j.phase==="candidate_active_starting") {
        console.log("Automatic rollback is blocked because candidate services may have processed business or external operations.");
        console.log("Keep all database volumes, files, keys, and state. Inspect the running services before any manual recovery.");
      } else {
        console.log("Candidate services have not been accepted for public traffic. Resume the review before retrying any deployment operation.");
      }
    ' || fail 'The interrupted upgrade journal is invalid; data and services were left unchanged.'
    return 0
  fi
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

verify_upgrade_compatibility() {
  local candidate_directory="$1"
  docker run --rm \
    --mount "type=bind,source=$RELEASE_DIR,target=/current,readonly" \
    --mount "type=bind,source=$candidate_directory,target=/candidate,readonly" \
    --entrypoint node "$NODE_IMAGE" -e '
      const fs=require("node:fs");
      const crypto=require("node:crypto");
      const fail=code=>{ process.stderr.write(code+"\n"); process.exit(1); };
      const read=(root,name)=>fs.readFileSync(`${root}/${name}`);
      const manifest=root=>JSON.parse(read(root,"release-manifest.json").toString("utf8"));
      let current,next;
      try { current=manifest("/current"); next=manifest("/candidate"); } catch { fail("upgrade_manifest_invalid"); }
      const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
      if(next.release_id===current.release_id || next.version===current.version) fail("upgrade_version_must_change");
      if(next.database?.engine_major!==18 || current.database?.engine_major!==18 ||
         next.database.migration_head!==current.database.migration_head ||
         next.database.migration_checksums_sha256!==current.database.migration_checksums_sha256 ||
         !next.database.readable_heads?.includes(current.database.migration_head) ||
         !next.database.writable_heads?.includes(current.database.migration_head)) fail("upgrade_database_compatibility_mismatch");
      if(!next.database.upgrade_from_releases?.includes(current.release_id)) fail("upgrade_not_allowed_by_signed_release");
      if(!next.database.rollback_to_releases?.includes(current.release_id)) fail("upgrade_rollback_not_supported_by_signed_release");
      const currentChecksums=read("/current","migration-checksums.json");
      const nextChecksums=read("/candidate","migration-checksums.json");
      const checksum=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
      if(!currentChecksums.equals(nextChecksums) || checksum(currentChecksums)!==current.database.migration_checksums_sha256 ||
         checksum(nextChecksums)!==next.database.migration_checksums_sha256) fail("upgrade_migration_checksums_mismatch");
      const trustFields=["protocol_versions","trust_configuration_id","issuer","offline_root_kid","online_signer_kids","minimum_bundle_version"];
      const trust=value=>Object.fromEntries(trustFields.map(key=>[key,value.license?.[key]]));
      if(!same(trust(current),trust(next)) ||
         !read("/current","license-trust-bundle.jws").equals(read("/candidate","license-trust-bundle.jws")) ||
         !read("/current","license-offline-root.jwk.json").equals(read("/candidate","license-offline-root.jwk.json"))) {
        fail("upgrade_license_trust_configuration_mismatch");
      }
      for(const name of ["postgres","caddy"]) {
        if(current.images?.[name]?.reference!==next.images?.[name]?.reference) fail(`upgrade_${name}_image_change_not_supported`);
      }
      const staticFiles=["deploy/Caddyfile","deploy/bootstrap-production-db-roles.sh","deploy/prepare-state-volume.sh",
        "backup-host-broker.sh","compose.restore-isolated.yaml"];
      for(const name of staticFiles) if(!read("/current",name).equals(read("/candidate",name))) fail("upgrade_runtime_artifact_change_not_supported");
      const oldCompose=read("/current","compose.yaml").toString("utf8");
      const newCompose=read("/candidate","compose.yaml").toString("utf8");
      const probeLine=/^[ \t]*AIKAYUN_UPGRADE_PROBE_ONLY: \$\{AIKAYUN_UPGRADE_PROBE_ONLY:-false\}[ \t]*\r?\n/gm;
      if((newCompose.match(probeLine)||[]).length!==1) fail("upgrade_probe_support_missing");
      const expectedOld=oldCompose.replace(probeLine,"");
      const normalizedNew=newCompose.replaceAll(next.images.api.reference,current.images.api.reference)
        .replaceAll(next.images.web.reference,current.images.web.reference).replace(probeLine,"");
      if(expectedOld!==normalizedNew) fail("upgrade_compose_change_not_supported");
      process.stdout.write(JSON.stringify({status:"compatible",from:current.release_id,to:next.release_id})+"\n");
    ' || fail 'The signed release does not meet the first-stage upgrade and rollback compatibility policy.'
}

write_upgrade_journal() {
  local phase="$1" now temporary
  now="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  temporary="$TARGET_DIR/.upgrade-journal.$$.tmp"
  printf '{"schema":1,"phase":"%s","from_version":"%s","from_manifest_sha256":"%s","to_version":"%s","to_manifest_sha256":"%s","updated_at":"%s"}\n' \
    "$phase" "$CURRENT_RELEASE_VERSION" "$CURRENT_RELEASE_MANIFEST_SHA256" "$SELECTED_VERSION" "$MANIFEST_SHA256" "$now" > "$temporary"
  chmod 0600 "$temporary"
  chown 0:0 "$temporary"
  mv -f -- "$temporary" "$UPGRADE_JOURNAL_FILE"
}

verify_upgrade_stopped_services() {
  local service id state code ids
  for service in api web caddy; do
    ids="$(compose ps --all -q "$service")" || return 1
    [[ -n "$ids" ]] || return 1
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      state="$(docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$id" 2>/dev/null)" || return 1
      code="${state#*|}"
      [[ "${state%%|*}" == exited && "$code" == 0 ]] || return 1
    done <<< "$ids"
  done
}

wait_healthy_with_release() {
  local compose_file="$1" probe_only="$2" service="$3" limit="${4:-300}" id health attempt
  for ((attempt=1; attempt<=limit; attempt++)); do
    id="$(compose_with_release "$compose_file" "$probe_only" ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$id" ]]; then
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
      [[ "$health" == healthy ]] && return 0
      [[ "$health" == exited || "$health" == dead ]] && return 1
    fi
    sleep 2
  done
  return 1
}

verify_running_program_image() {
  local service="$1" expected="$2" id actual
  id="$(compose ps -q "$service" 2>/dev/null)" || return 1
  [[ -n "$id" ]] || return 1
  actual="$(docker inspect --format '{{.Config.Image}}' "$id" 2>/dev/null)" || return 1
  [[ "$actual" == "$expected" ]]
}

select_current_upgrade_release() {
  SELECTED_VERSION="$CURRENT_RELEASE_VERSION"
  SELECTED_RELEASE_ORIGIN="$(state_value release_origin)"
  SELECTED_DOMAIN="$(state_value domain)"
  MANIFEST_SHA256="$CURRENT_RELEASE_MANIFEST_SHA256"
  SELECTED_API_IMAGE="$CURRENT_API_IMAGE"
  SELECTED_WEB_IMAGE="$CURRENT_WEB_IMAGE"
  SELECTED_POSTGRES_IMAGE="$CURRENT_POSTGRES_IMAGE"
  SELECTED_CADDY_IMAGE="$CURRENT_CADDY_IMAGE"
  SELECTED_BACKUP_RESTIC_IMAGE="$CURRENT_BACKUP_RESTIC_IMAGE"
}

select_candidate_upgrade_release() {
  SELECTED_VERSION="$CANDIDATE_RELEASE_VERSION"
  MANIFEST_SHA256="$CANDIDATE_RELEASE_MANIFEST_SHA256"
  SELECTED_API_IMAGE="$CANDIDATE_API_IMAGE"
  SELECTED_WEB_IMAGE="$CANDIDATE_WEB_IMAGE"
  SELECTED_POSTGRES_IMAGE="$CANDIDATE_POSTGRES_IMAGE"
  SELECTED_CADDY_IMAGE="$CANDIDATE_CADDY_IMAGE"
  SELECTED_BACKUP_RESTIC_IMAGE="$CANDIDATE_BACKUP_RESTIC_IMAGE"
}

verify_previous_release() {
  local expected_version="$1" expected_sha="$2" actual_sha actual_version
  [[ -d "$PREVIOUS_RELEASE_DIR" && ! -L "$PREVIOUS_RELEASE_DIR" && \
     "$(stat -c '%u:%g:%a' "$PREVIOUS_RELEASE_DIR")" == '0:0:755' && \
     "$(realpath -e "$PREVIOUS_RELEASE_DIR")" == "$PREVIOUS_RELEASE_DIR" ]] || \
    fail 'The saved previous release directory is missing or unsafe.'
  actual_sha="$(sha256sum "$PREVIOUS_RELEASE_DIR/release-manifest.json" | awk '{print $1}')"
  [[ "$actual_sha" == "$expected_sha" ]] || fail 'The saved previous release differs from its recorded manifest digest.'
  actual_version="$(docker run --rm --mount "type=bind,source=$PREVIOUS_RELEASE_DIR,target=/release,readonly" \
    --entrypoint node "$NODE_IMAGE" -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync("/release/release-manifest.json","utf8"));process.stdout.write(m.version)')" || \
    fail 'The saved previous release manifest is invalid.'
  [[ "$actual_version" == "$expected_version" ]] || fail 'The saved previous release version differs from its recorded version.'
  docker run --rm --mount "type=bind,source=$PREVIOUS_RELEASE_DIR,target=/release,readonly" --entrypoint cosign "$COSIGN_IMAGE" \
    verify-blob --bundle /release/release-manifest.cosign.bundle \
    --certificate-identity "$RELEASE_CERT_IDENTITY" --certificate-oidc-issuer "$RELEASE_OIDC_ISSUER" \
    /release/release-manifest.json >/dev/null || fail 'Cosign rejected the saved previous release.'
  verify_release_artifacts_with_installer "$PREVIOUS_RELEASE_DIR" || fail 'Installer-owned verification rejected the saved previous release.'
  docker run --rm --mount "type=bind,source=$PREVIOUS_RELEASE_DIR,target=/release,readonly" --entrypoint node "$NODE_IMAGE" \
    /release/release-verifier.mjs /release/release-manifest.json /release/release-manifest.jws \
    /release/release-signing-root.jwk.json >/dev/null || fail 'The saved previous release JWS signature is invalid.'
  docker run --rm --mount "type=bind,source=$PREVIOUS_RELEASE_DIR,target=/release,readonly" --entrypoint node "$NODE_IMAGE" \
    /release/verify-artifacts.mjs /release/release-manifest.json /release >/dev/null || \
    fail 'A saved previous release artifact failed SHA-256 verification.'
}

assert_services_stopped_with_release() {
  local compose_file="$1" probe_only="$2" service ids id state code
  for service in api web caddy; do
    ids="$(compose_with_release "$compose_file" "$probe_only" ps --all -q "$service")" || return 1
    [[ -n "$ids" ]] || return 1
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      state="$(docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$id" 2>/dev/null)" || return 1
      code="${state#*|}"
      [[ "${state%%|*}" == exited && "$code" == 0 ]] || return 1
    done <<< "$ids"
  done
}

upgrade_install() {
  local requested_version="$1" state_volume_label previous_info previous_version previous_sha
  [[ ! -e "$UPGRADE_JOURNAL_FILE" && ! -L "$UPGRADE_JOURNAL_FILE" ]] || \
    fail 'A prior upgrade was interrupted. Inspect status and diagnose before starting another upgrade.'
  [[ ! -e "$UPGRADE_STAGING_DIR" && ! -L "$UPGRADE_STAGING_DIR" && \
     ! -e "$UPGRADE_OLDER_RELEASE_DIR" && ! -L "$UPGRADE_OLDER_RELEASE_DIR" && \
     ! -e "$UPGRADE_STATE_BACKUP" && ! -L "$UPGRADE_STATE_BACKUP" && \
     ! -e "$UPGRADE_ENV_BACKUP" && ! -L "$UPGRADE_ENV_BACKUP" ]] || \
    fail 'An unfinished upgrade staging artifact exists. Inspect it before retrying.'

  saved_bundle_verify
  verify_backup_launcher
  [[ "$(state_value phase)" == setup_token_issued ]] || \
    fail 'Upgrade requires a fully initialized installation with verified HTTPS and administrator setup.'
  CURRENT_RELEASE_VERSION="$SELECTED_VERSION"
  CURRENT_RELEASE_MANIFEST_SHA256="$MANIFEST_SHA256"
  CURRENT_API_IMAGE="$SELECTED_API_IMAGE"
  CURRENT_WEB_IMAGE="$SELECTED_WEB_IMAGE"
  CURRENT_POSTGRES_IMAGE="$SELECTED_POSTGRES_IMAGE"
  CURRENT_CADDY_IMAGE="$SELECTED_CADDY_IMAGE"
  CURRENT_BACKUP_RESTIC_IMAGE="$SELECTED_BACKUP_RESTIC_IMAGE"
  [[ "$requested_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+)(\.([0-9A-Za-z-]+))*)?$ ]] || \
    fail 'Provide a canonical release version, such as the one published by the project.'
  [[ "$requested_version" != "$CURRENT_RELEASE_VERSION" ]] || fail 'The requested version is already installed.'

  prepare_secret_files 13
  prepare_compose_volumes 13
  state_volume_label="$(docker volume inspect aikayun_state --format '{{ index .Labels "com.aikayun.managed-by" }}')" || \
    fail 'The persistent state volume is missing; upgrade stopped without recreating it.'
  [[ "$state_volume_label" == aikayun-7-3 ]] || fail 'The persistent state volume ownership marker changed.'
  compose config --quiet || fail 'The current Compose configuration is invalid.'
  check_public_ports_available true
  check_release_origin
  compose exec -T api /nodejs/bin/node /app/dist/production-install-init.js verify >/dev/null || \
    fail 'The current database identity or Pending Key binding is not verified; upgrade stopped.'

  if [[ -e "$PREVIOUS_RELEASE_DIR" || -L "$PREVIOUS_RELEASE_DIR" ]]; then
    previous_info="$(node_target '
      const fs=require("node:fs");const s=JSON.parse(fs.readFileSync("/target/install-state.json","utf8"));
      const u=s.upgrade;
      if(!u || typeof u.previous_version!=="string" || !/^[a-f0-9]{64}$/.test(u.previous_manifest_sha256)) process.exit(1);
      process.stdout.write(u.previous_version+"\n"+u.previous_manifest_sha256);
    ')" || fail 'The existing previous release is not described by verified upgrade state.'
    previous_version="${previous_info%%$'\n'*}"
    previous_sha="${previous_info#*$'\n'}"
    [[ -z "$UPGRADE_OLDER_RELEASE_DIR" || ! -e "$UPGRADE_OLDER_RELEASE_DIR" ]] || \
      fail 'An older previous release is already staged; inspect the installation before retrying.'
    verify_previous_release "$previous_version" "$previous_sha"
  fi

  WORK_DIR="$(mktemp -d /var/tmp/aikayun-install.XXXXXX)"
  chmod 0700 "$WORK_DIR"
  SELECTED_VERSION="$requested_version"
  download_and_verify_release
  load_release_image_digests_from "$WORK_DIR/release"
  CANDIDATE_RELEASE_VERSION="$SELECTED_VERSION"
  CANDIDATE_RELEASE_MANIFEST_SHA256="$MANIFEST_SHA256"
  CANDIDATE_API_IMAGE="$SELECTED_API_IMAGE"
  CANDIDATE_WEB_IMAGE="$SELECTED_WEB_IMAGE"
  CANDIDATE_POSTGRES_IMAGE="$SELECTED_POSTGRES_IMAGE"
  CANDIDATE_CADDY_IMAGE="$SELECTED_CADDY_IMAGE"
  CANDIDATE_BACKUP_RESTIC_IMAGE="$SELECTED_BACKUP_RESTIC_IMAGE"

  cp -a "$WORK_DIR/release" "$UPGRADE_STAGING_DIR"
  chmod -R a+rX "$UPGRADE_STAGING_DIR"
  chmod 0400 "$UPGRADE_STAGING_DIR/license-trust-bundle.jws"
  chown 1000:1000 "$UPGRADE_STAGING_DIR/license-trust-bundle.jws"
  UPGRADE_CANDIDATE_DIR="$UPGRADE_STAGING_DIR"
  verify_release_artifacts_with_installer "$UPGRADE_STAGING_DIR" || fail 'The staged signed release failed installer-owned verification.'
  docker run --rm --mount "type=bind,source=$UPGRADE_STAGING_DIR,target=/release,readonly" --entrypoint cosign "$COSIGN_IMAGE" \
    verify-blob --bundle /release/release-manifest.cosign.bundle \
    --certificate-identity "$RELEASE_CERT_IDENTITY" --certificate-oidc-issuer "$RELEASE_OIDC_ISSUER" \
    /release/release-manifest.json >/dev/null || fail 'Cosign rejected the staged release manifest.'
  docker run --rm --mount "type=bind,source=$UPGRADE_STAGING_DIR,target=/release,readonly" --entrypoint node "$NODE_IMAGE" \
    /release/release-verifier.mjs /release/release-manifest.json /release/release-manifest.jws \
    /release/release-signing-root.jwk.json >/dev/null || fail 'The staged release JWS signature is invalid.'
  docker run --rm --mount "type=bind,source=$UPGRADE_STAGING_DIR,target=/release,readonly" --entrypoint node "$NODE_IMAGE" \
    /release/verify-artifacts.mjs /release/release-manifest.json /release >/dev/null || \
    fail 'A staged release artifact failed SHA-256 verification.'

  SELECTED_VERSION="$CANDIDATE_RELEASE_VERSION"
  MANIFEST_SHA256="$CANDIDATE_RELEASE_MANIFEST_SHA256"
  SELECTED_API_IMAGE="$CANDIDATE_API_IMAGE"
  SELECTED_WEB_IMAGE="$CANDIDATE_WEB_IMAGE"
  SELECTED_POSTGRES_IMAGE="$CANDIDATE_POSTGRES_IMAGE"
  SELECTED_CADDY_IMAGE="$CANDIDATE_CADDY_IMAGE"
  SELECTED_BACKUP_RESTIC_IMAGE="$CANDIDATE_BACKUP_RESTIC_IMAGE"
  verify_upgrade_compatibility "$UPGRADE_STAGING_DIR"
  compose_with_release "$UPGRADE_STAGING_DIR/compose.yaml" false config --quiet || \
    fail 'The candidate signed Compose configuration is invalid.'

  cp -p "$STATE_FILE" "$UPGRADE_STATE_BACKUP"
  cp -p "$TARGET_DIR/.env" "$UPGRADE_ENV_BACKUP"
  chmod 0600 "$UPGRADE_STATE_BACKUP" "$UPGRADE_ENV_BACKUP"
  chown 0:0 "$UPGRADE_STATE_BACKUP" "$UPGRADE_ENV_BACKUP"
  write_upgrade_journal preacceptance_probe

  select_current_upgrade_release
  compose stop caddy || fail 'Could not stop the public Caddy service cleanly; no candidate service was started.'
  compose stop web || fail 'Could not stop the current Web service cleanly; no candidate service was started.'
  compose stop --timeout 30 api || fail 'The current API did not stop cleanly. No candidate service was started; inspect pending operations before retrying.'
  verify_upgrade_stopped_services || fail 'A current service did not exit cleanly. Upgrade stopped to avoid overlapping business writers.'
  UPGRADE_PRE_ACCEPTANCE=1

  select_candidate_upgrade_release
  compose_with_release "$UPGRADE_STAGING_DIR/compose.yaml" false run --rm --no-deps --entrypoint /nodejs/bin/node \
    migrate /app/dist/db/upgrade-database-check-cli.js \
    "$(docker run --rm --mount "type=bind,source=$UPGRADE_STAGING_DIR,target=/release,readonly" --entrypoint node "$NODE_IMAGE" -e \
      'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync("/release/release-manifest.json","utf8")).database.migration_head)')" \
    "$(docker run --rm --mount "type=bind,source=$UPGRADE_STAGING_DIR,target=/release,readonly" --entrypoint node "$NODE_IMAGE" -e \
      'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync("/release/release-manifest.json","utf8")).database.migration_checksums_sha256)')" || \
    fail 'The live PostgreSQL major version, applied migration registry, identity binding, or complete migration checksum does not match.'
  compose_with_release "$UPGRADE_STAGING_DIR/compose.yaml" false run --rm --no-deps \
    production-install-init verify >/dev/null || fail 'The candidate release could not verify the existing installation identity and Pending Key.'

  write_upgrade_journal preacceptance_probe
  compose_with_release "$UPGRADE_STAGING_DIR/compose.yaml" true up -d --force-recreate --no-deps api || \
    fail 'The candidate API probe failed before public traffic; the prior program will be restored.'
  wait_healthy_with_release "$UPGRADE_STAGING_DIR/compose.yaml" true api 300 || \
    fail 'The candidate API did not become healthy during its no-worker probe; the prior program will be restored.'
  compose_with_release "$UPGRADE_STAGING_DIR/compose.yaml" true up -d --force-recreate --no-deps web || \
    fail 'The candidate Web probe failed before public traffic; the prior program will be restored.'
  wait_healthy_with_release "$UPGRADE_STAGING_DIR/compose.yaml" true web 300 || \
    fail 'The candidate Web did not become healthy during its no-worker probe; the prior program will be restored.'
  compose_with_release "$UPGRADE_STAGING_DIR/compose.yaml" true stop api web || \
    fail 'The candidate no-worker probe could not stop cleanly; the prior program will be restored.'
  assert_services_stopped_with_release "$UPGRADE_STAGING_DIR/compose.yaml" true || \
    fail 'A no-worker probe service did not stop cleanly; the prior program will be restored.'

  write_upgrade_journal preacceptance_switch
  if [[ -d "$PREVIOUS_RELEASE_DIR" ]]; then
    mv -- "$PREVIOUS_RELEASE_DIR" "$UPGRADE_OLDER_RELEASE_DIR" || fail 'Could not stage the older verified release.'
  fi
  mv -- "$RELEASE_DIR" "$PREVIOUS_RELEASE_DIR" || fail 'Could not preserve the current signed release.'
  mv -- "$UPGRADE_STAGING_DIR" "$RELEASE_DIR" || fail 'Could not install the verified signed release directory.'
  UPGRADE_CANDIDATE_DIR="$RELEASE_DIR"
  write_upgrade_env "$CANDIDATE_API_IMAGE" "$CANDIDATE_WEB_IMAGE"
  SELECTED_RELEASE_ORIGIN="$(state_value release_origin)"
  SELECTED_DOMAIN="$(state_value domain)"
  select_candidate_upgrade_release
  prepare_secret_files 13
  compose config --quiet || fail 'The switched candidate Compose environment does not match the signed release and preserved secrets.'
  install -m 0555 "$RELEASE_DIR/install.sh" "$TARGET_DIR/.aikayun.upgrade.$$.tmp"
  chown 0:0 "$TARGET_DIR/.aikayun.upgrade.$$.tmp"
  mv -f -- "$TARGET_DIR/.aikayun.upgrade.$$.tmp" "$TARGET_DIR/aikayun"
  write_upgrade_journal candidate_active_starting
  UPGRADE_PRE_ACCEPTANCE=0

  compose up -d --force-recreate --no-deps api || \
    fail 'The candidate API failed after workers could start. Automatic rollback is blocked; Caddy remains stopped and all data is retained.'
  wait_healthy api 300 || fail 'The candidate API health check failed after workers could start. Automatic rollback is blocked; inspect before retrying.'
  compose up -d --force-recreate --no-deps web || \
    fail 'The candidate Web failed after the API became active. Automatic rollback is blocked; Caddy remains stopped and all data is retained.'
  wait_healthy web 300 || fail 'The candidate Web health check failed after the API became active. Automatic rollback is blocked; inspect before retrying.'
  compose run --rm --no-deps production-install-init verify >/dev/null || \
    fail 'The running candidate could not verify the existing identity and Pending Key. Automatic rollback is blocked.'
  verify_running_program_image api "$CANDIDATE_API_IMAGE" || \
    fail 'The running API image does not match the signed candidate manifest. Automatic rollback is blocked.'
  verify_running_program_image web "$CANDIDATE_WEB_IMAGE" || \
    fail 'The running Web image does not match the signed candidate manifest. Automatic rollback is blocked.'
  write_upgrade_state setup_token_issued blocked_after_candidate_start "$CURRENT_RELEASE_VERSION" "$CURRENT_RELEASE_MANIFEST_SHA256"
  compose up -d --no-recreate --no-deps caddy || \
    fail 'The candidate programs are healthy but Caddy could not be restored. Automatic rollback is blocked; inspect before retrying.'

  probe_https || fail 'The candidate programs are running but the HTTPS acceptance probe failed. Automatic rollback is blocked; inspect status and diagnose.'
  write_upgrade_state setup_token_issued blocked_after_acceptance "$CURRENT_RELEASE_VERSION" "$CURRENT_RELEASE_MANIFEST_SHA256"
  [[ ! -e "$UPGRADE_OLDER_RELEASE_DIR" ]] || rm -rf -- "$UPGRADE_OLDER_RELEASE_DIR"
  rm -f -- "$UPGRADE_JOURNAL_FILE" "$UPGRADE_STATE_BACKUP" "$UPGRADE_ENV_BACKUP"
  UPGRADE_CANDIDATE_DIR=''
  printf 'AiKayun upgraded from %s to %s. Previous release %s is retained; automatic rollback is blocked after candidate services could process business or external operations.\n' \
    "$CURRENT_RELEASE_VERSION" "$CANDIDATE_RELEASE_VERSION" "$CURRENT_RELEASE_VERSION"
}

write_upgrade_env() {
  local api_image="$1" web_image="$2" temporary="$TARGET_DIR/.env.upgrade.$$.tmp"
  sed -e "s|^AIKAYUN_API_IMAGE=.*$|AIKAYUN_API_IMAGE=$api_image|" \
      -e "s|^AIKAYUN_WEB_IMAGE=.*$|AIKAYUN_WEB_IMAGE=$web_image|" \
    "$TARGET_DIR/.env" > "$temporary" || fail 'Could not prepare the signed program image update.'
  [[ "$(grep -c '^AIKAYUN_API_IMAGE=' "$temporary")" == 1 && "$(grep -c '^AIKAYUN_WEB_IMAGE=' "$temporary")" == 1 ]] || {
    rm -f -- "$temporary"
    fail 'The persistent Compose file does not contain exactly one API and Web image entry.'
  }
  chmod 0600 "$temporary"
  chown 0:0 "$temporary"
  mv -f -- "$temporary" "$TARGET_DIR/.env"
}

rollback_upgrade_before_acceptance() {
  local current_manifest_sha=''
  printf 'AiKayun installer: restoring the prior program before public traffic was enabled.\n' >&2
  if [[ -n "$UPGRADE_CANDIDATE_DIR" && -f "$UPGRADE_CANDIDATE_DIR/compose.yaml" ]]; then
    compose_with_release "$UPGRADE_CANDIDATE_DIR/compose.yaml" true stop api web >/dev/null 2>&1 || true
  fi

  if [[ -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" && -f "$RELEASE_DIR/release-manifest.json" ]]; then
    current_manifest_sha="$(sha256sum "$RELEASE_DIR/release-manifest.json" | awk '{print $1}')"
  fi
  if [[ "$current_manifest_sha" == "$MANIFEST_SHA256" && -d "$PREVIOUS_RELEASE_DIR" && ! -L "$PREVIOUS_RELEASE_DIR" ]]; then
    [[ ! -e "$UPGRADE_STAGING_DIR" ]] || rm -rf -- "$UPGRADE_STAGING_DIR"
    mv -- "$RELEASE_DIR" "$UPGRADE_STAGING_DIR" || return 1
    mv -- "$PREVIOUS_RELEASE_DIR" "$RELEASE_DIR" || return 1
  elif [[ ! -d "$RELEASE_DIR" && -d "$PREVIOUS_RELEASE_DIR" && ! -L "$PREVIOUS_RELEASE_DIR" ]]; then
    mv -- "$PREVIOUS_RELEASE_DIR" "$RELEASE_DIR" || return 1
  fi
  if [[ -d "$UPGRADE_OLDER_RELEASE_DIR" && ! -L "$UPGRADE_OLDER_RELEASE_DIR" ]]; then
    [[ ! -e "$PREVIOUS_RELEASE_DIR" ]] || return 1
    mv -- "$UPGRADE_OLDER_RELEASE_DIR" "$PREVIOUS_RELEASE_DIR" || return 1
  fi
  if [[ -f "$UPGRADE_ENV_BACKUP" && ! -L "$UPGRADE_ENV_BACKUP" ]]; then
    mv -f -- "$UPGRADE_ENV_BACKUP" "$TARGET_DIR/.env" || return 1
  fi
  if [[ -f "$UPGRADE_STATE_BACKUP" && ! -L "$UPGRADE_STATE_BACKUP" ]]; then
    mv -f -- "$UPGRADE_STATE_BACKUP" "$STATE_FILE" || return 1
  fi
  [[ -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]] || return 1
  install -m 0555 "$RELEASE_DIR/install.sh" "$TARGET_DIR/.aikayun.rollback.$$.tmp" || return 1
  chown 0:0 "$TARGET_DIR/.aikayun.rollback.$$.tmp" || return 1
  mv -f -- "$TARGET_DIR/.aikayun.rollback.$$.tmp" "$TARGET_DIR/aikayun" || return 1

  SELECTED_VERSION="$(state_value version)" || return 1
  SELECTED_RELEASE_ORIGIN="$(state_value release_origin)" || return 1
  SELECTED_DOMAIN="$(state_value domain)" || return 1
  MANIFEST_SHA256="$(sha256sum "$RELEASE_DIR/release-manifest.json" | awk '{print $1}')"
  load_release_image_digests || return 1
  compose config --quiet >/dev/null 2>&1 || return 1
  compose up -d --force-recreate --no-deps api >/dev/null 2>&1 || return 1
  wait_healthy api 300 || return 1
  compose up -d --force-recreate --no-deps web >/dev/null 2>&1 || return 1
  wait_healthy web 300 || return 1
  compose up -d --no-recreate --no-deps caddy >/dev/null 2>&1 || return 1

  [[ ! -e "$UPGRADE_STAGING_DIR" ]] || rm -rf -- "$UPGRADE_STAGING_DIR"
  rm -f -- "$UPGRADE_JOURNAL_FILE" "$UPGRADE_STATE_BACKUP" "$UPGRADE_ENV_BACKUP"
  UPGRADE_PRE_ACCEPTANCE=0
  printf 'AiKayun installer: prior program restored; database, volumes, secrets, and identity were retained.\n' >&2
  return 0
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

verify_backup_launcher() {
  local running
  [[ "$0" == "$TARGET_DIR/aikayun" && -f "$TARGET_DIR/aikayun" && ! -L "$TARGET_DIR/aikayun" && \
     "$(realpath -e "$TARGET_DIR/aikayun")" == "$TARGET_DIR/aikayun" && \
     "$(stat -c '%u:%g:%a:%h' "$TARGET_DIR/aikayun")" == '0:0:555:1' ]] || \
    fail 'The installed operator command is missing, modified, or unsafe.'
  running="$(realpath -e "$0")" || fail 'The executing operator command path is unavailable.'
  [[ "$running" == "$TARGET_DIR/aikayun" ]] || fail 'The executing operator command is not the fixed installed artifact.'
  cmp -s "$TARGET_DIR/aikayun" "$RELEASE_DIR/install.sh" || fail 'The executing operator command differs from the signed installer artifact.'
}

verify_backup_host_broker() {
  local broker="$RELEASE_DIR/backup-host-broker.sh"
  [[ -f "$broker" && ! -L "$broker" && "$(realpath -e "$broker")" == "$broker" && \
     "$(stat -c '%u:%g:%a:%h' "$broker")" == '0:0:644:1' ]] || \
    fail 'The signed host backup broker is missing or unsafe.'
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
    upgrade)
      [[ $# == 3 && "$2" == --version ]] || fail 'Usage: sudo /opt/aikayun/aikayun upgrade --version X.Y.Z'
      local upgrade_version="$3"
      require_root
      begin_lock
      host_preflight
      find /var/tmp -maxdepth 1 -type d -name 'aikayun-install.*' -user 0 -mmin +1 -exec rm -rf -- {} + 2>/dev/null || true
      upgrade_install "$upgrade_version"
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
    backup)
      (($# >= 2)) || fail 'Usage: sudo /opt/aikayun/aikayun backup create|list|verify|restore-plan|restore-isolated|cleanup-isolated|initialize-repository|recover-maintenance'
      local backup_operation="$2"
      shift 2
      if [[ "$backup_operation" == help || "$backup_operation" == -h || "$backup_operation" == --help ]]; then
        printf '%s\n' 'Usage: sudo /opt/aikayun/aikayun backup create|list [LIMIT]|verify SET_ID|restore-plan SET_ID|restore-isolated SET_ID|cleanup-isolated RESTORE_ID|initialize-repository|recover-maintenance'
        return 0
      fi
      case "$backup_operation" in
        create|list|verify|restore-plan|restore-isolated|cleanup-isolated|initialize-repository|recover-maintenance) ;;
        *) fail 'Unsupported backup command.' ;;
      esac
      require_root
      host_preflight
      begin_lock
      saved_bundle_verify
      verify_backup_launcher
      verify_backup_host_broker
      # The signed broker is sourced only after every installed artifact and
      # the actual executing command have been checked against the saved JWS.
      source "$RELEASE_DIR/backup-host-broker.sh"
      run_backup_host_broker "$backup_operation" "$@"
      ;;
    *) usage; fail "Unknown command: $command" ;;
  esac
}

main "$@"
