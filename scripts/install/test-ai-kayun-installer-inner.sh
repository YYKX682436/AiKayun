#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

PAYLOAD_DIR="$1"
SCENARIO="$2"
HARNESS_ROOT=/tmp/aikayun-installer-flow-test
FAKE_BIN="$HARNESS_ROOT/bin"
FAKE_STATE="$HARNESS_ROOT/state"
EVENT_LOG="$FAKE_STATE/events.log"
TARGET_DIR=/opt/aikayun
INSTALLER="$PAYLOAD_DIR/install.sh"
TEST_SOCKET="$HARNESS_ROOT/docker.sock"
SOCKET_PID=''
PORT_PID=''
trap 'printf "Installer flow assertion failed at line %s: %s\\n" "$LINENO" "$BASH_COMMAND" >&2; if [[ -f "$EVENT_LOG" ]]; then tail -30 "$EVENT_LOG" >&2; fi' ERR
DOCKER_CONTEXT=''
DOCKER_HOST=''
export DOCKER_CONTEXT DOCKER_HOST

[[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]] || { printf 'Expected isolated Linux root.\n' >&2; exit 2; }
actual_arch="$(uname -m)"
case "$actual_arch" in x86_64) actual_arch=amd64 ;; aarch64) actual_arch=arm64 ;; esac
[[ "$actual_arch" == "${AIKAYUN_TEST_EXPECTED_ARCH:-}" ]] || {
  printf 'Expected %s Linux, got %s.\n' "${AIKAYUN_TEST_EXPECTED_ARCH:-unset}" "$actual_arch" >&2
  exit 2
}
[[ -d "$PAYLOAD_DIR" && -f "$INSTALLER" ]] || { printf 'Controlled release payload is missing.\n' >&2; exit 2; }
case "$SCENARIO" in
  first-install-tls-failure-resume|first-install-https-ready|release-download-failure|manifest-modified|root-substitution|compose-image-modified|dns-failure|disk-low|ports-in-use|occupied-deployment|fresh-install-untrusted-code|resume-untrusted-code) ;;
  *) printf 'Unknown isolated installer scenario.\n' >&2; exit 2 ;;
esac
if [[ "$SCENARIO" != occupied-deployment && -e "$TARGET_DIR" ]]; then
  printf 'Refusing to use an occupied target path.\n' >&2
  exit 2
fi
[[ -z "$(find /var/tmp -maxdepth 1 -type d -name 'aikayun-install.*' -print -quit)" ]] || {
  printf 'Unexpected temporary installer directory exists.\n' >&2
  exit 2
}
mkdir -p "$FAKE_BIN" "$FAKE_STATE/volumes" "$FAKE_STATE/identity"
: > "$EVENT_LOG"

cleanup_fixture() {
  status=$?
  if [[ -e "$TARGET_DIR/.install-owner" && "$(cat "$TARGET_DIR/.install-owner" 2>/dev/null || true)" == aikayun-install-v1 ]]; then
    rm -rf -- "$TARGET_DIR"
  fi
  if [[ -n "$SOCKET_PID" ]]; then kill "$SOCKET_PID" 2>/dev/null || true; fi
  if [[ -n "$PORT_PID" ]]; then kill "$PORT_PID" 2>/dev/null || true; fi
  rm -rf -- "$HARNESS_ROOT"
  return "$status"
}
trap cleanup_fixture EXIT

node -e 'const net=require("node:net"); const s=net.createServer(); s.listen(process.argv[1]); setInterval(()=>{},3600000)' \
  "$TEST_SOCKET" >/dev/null 2>&1 &
SOCKET_PID=$!
for attempt in {1..40}; do
  [[ -S "$TEST_SOCKET" ]] && break
  sleep 0.05
done
[[ -S "$TEST_SOCKET" ]] || { printf 'Local Unix socket fixture did not start.\n' >&2; exit 1; }

cat > "$FAKE_BIN/docker" <<'DOCKER_FIXTURE'
#!/usr/bin/env bash
set -Eeuo pipefail
set +x
event() { printf '%s\n' "$*" >> "$AIKAYUN_TEST_EVENT_LOG"; }
volume_file() { printf '%s/volumes/%s' "$AIKAYUN_TEST_STATE" "$1"; }

if [[ "$1" == context ]]; then
  shift
  case "$1" in
    show) printf '%s\n' "$AIKAYUN_TEST_DOCKER_CONTEXT" ;;
    inspect) event "context_inspect:$2"; printf '%s\n' "$AIKAYUN_TEST_DOCKER_ENDPOINT" ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [[ "$1" == info ]]; then
  case "$3" in
    *OSType*) printf 'linux\n' ;;
    *Architecture*) uname -m ;;
    *DockerRootDir*) printf '/var/lib/docker\n' ;;
    *) printf 'fixture\n' ;;
  esac
  event docker_info
  exit 0
fi
if [[ "$1" == pull ]]; then event docker_pull; exit 0; fi
if [[ "$1" == network && "$2" == inspect ]]; then event docker_network_inspect; exit 1; fi
if [[ "$1" == volume && "$2" == inspect ]]; then
  volume="$3"
  format=''
  if [[ "$3" == --format ]]; then
    format="${4:-}"
    volume="${5:-}"
  elif [[ "${4:-}" == --format ]]; then
    format="${5:-}"
  fi
  file="$(volume_file "$volume")"
  event "volume_inspect:$volume:$([[ -f "$file" ]] && printf yes || printf no)"
  [[ -f "$file" ]] || exit 1
  if [[ -n "$format" ]]; then
    if [[ "$format" == *managed-by* ]]; then
      awk -F= '$1=="managed-by" {print $2}' "$file"
    else
      project="$(awk -F= '$1=="project" {print $2}' "$file")"
      name="$(awk -F= '$1=="compose-volume" {print $2}' "$file")"
      printf '%s|%s\n' "$project" "$name"
    fi
  fi
  exit 0
fi
if [[ "$1" == volume && "$2" == create ]]; then
  shift 2
  volume=''
  managed=''
  project=''
  compose_volume=''
  while (($#)); do
    case "$1" in
      --label)
        case "$2" in
          com.aikayun.managed-by=*) managed="$(printf '%s' "$2" | cut -d= -f2-)" ;;
          com.docker.compose.project=*) project="$(printf '%s' "$2" | cut -d= -f2-)" ;;
          com.docker.compose.volume=*) compose_volume="$(printf '%s' "$2" | cut -d= -f2-)" ;;
        esac
        shift 2 ;;
      *) volume="$1"; shift ;;
    esac
  done
  [[ -n "$volume" ]] || exit 2
  {
    printf 'managed-by=%s\n' "$managed"
    printf 'project=%s\n' "$project"
    printf 'compose-volume=%s\n' "$compose_volume"
  } > "$(volume_file "$volume")"
  event "volume_create:$volume"
  printf '%s\n' "$volume"
  exit 0
fi
if [[ "$1" == ps ]]; then
  if [[ " $* " == *' -q '* && -f "$AIKAYUN_TEST_STATE/caddy-started" ]]; then printf 'fixture-caddy\n'; fi
  exit 0
fi
if [[ "$1" == inspect ]]; then
  case "$3" in
    *PortBindings*) printf '80/tcp=80\n443/tcp=443\n443/udp=443\n' ;;
    *State.Health*) printf 'healthy\n' ;;
    *State.Status*) printf 'running\n' ;;
    *) printf 'running\n' ;;
  esac
  exit 0
fi
if [[ "$1" == image && "$2" == inspect ]]; then
  if [[ "$5" == *RepoDigests* ]]; then
    printf 'ghcr.io/yykx682436/aikayun-release-bundle@sha256:%064d\n' 0
  else
    printf '9.8.7-rc.3\n'
  fi
  exit 0
fi
if [[ "$1" == create ]]; then event oci_container_create; printf 'fixture-release-container\n'; exit 0; fi
if [[ "$1" == cp ]]; then
  destination="$3"
  mkdir -p "$destination"
  cp -a "$AIKAYUN_TEST_PAYLOAD/." "$destination/"
  event oci_bundle_copy
  exit 0
fi
if [[ "$1" == rm ]]; then event container_remove; exit 0; fi

if [[ "$1" == run ]]; then
  shift
  mount_source=''
  mount_target=''
  entrypoint=''
  while (($#)); do
    case "$1" in
      --rm|--interactive|-i) shift ;;
      --mount)
        mount_spec="$2"
        mount_source="$(printf '%s' "$mount_spec" | sed -n 's/.*source=\([^,]*\).*/\1/p')"
        mount_target="$(printf '%s' "$mount_spec" | sed -n 's/.*target=\([^,]*\).*/\1/p')"
        shift 2 ;;
      --entrypoint) entrypoint="$2"; shift 2 ;;
      *) image="$1"; shift; break ;;
    esac
  done
  if [[ "$entrypoint" == cosign ]]; then
    joined=" $* "
    [[ "$joined" == *' --certificate-identity https://github.com/YYKX682436/AiKayun/.github/workflows/release.yml@refs/heads/main '* ]] || exit 1
    [[ "$joined" == *' --certificate-oidc-issuer https://token.actions.githubusercontent.com '* ]] || exit 1
    event controlled_cosign_identity
    exit 0
  fi
  if [[ "$entrypoint" == node ]]; then
    if [[ "$1" == -e ]]; then
      shift
      script="$1"
      shift
      MOUNT_SOURCE="$mount_source" MOUNT_TARGET="$mount_target" node -e '
        const {spawnSync}=require("node:child_process");
        let source=process.argv[1];
        if(process.env.MOUNT_TARGET) source=source.split(process.env.MOUNT_TARGET+"/").join(process.env.MOUNT_SOURCE+"/");
        const args=process.argv.slice(2).map(value=>process.env.MOUNT_TARGET && (value===process.env.MOUNT_TARGET || value.startsWith(process.env.MOUNT_TARGET+"/"))
          ? value.replace(process.env.MOUNT_TARGET,process.env.MOUNT_SOURCE) : value);
        const result=spawnSync(process.execPath,["-e",source,...args],{stdio:"inherit"});
        process.exit(result.status===null?1:result.status);
      ' "$script" "$@"
      exit $?
    fi
    command_path="$1"
    shift
    node_args=()
    if [[ -n "$mount_source" && -n "$mount_target" ]]; then
      command_path="$(printf '%s' "$command_path" | sed "s|$mount_target|$mount_source|")"
      for argument in "$@"; do
        if [[ "$argument" == "$mount_target" || "$argument" == "$mount_target"/* ]]; then
          node_args+=("${argument/#$mount_target/$mount_source}")
        else
          node_args+=("$argument")
        fi
      done
    else
      node_args=("$@")
    fi
    exec node "$command_path" "${node_args[@]}"
  fi
  exit 2
fi

if [[ "$1" == compose ]]; then
  shift
  while (($#)); do
    case "$1" in
      --project-name|--file|--env-file) shift 2 ;;
      *) break ;;
    esac
  done
  subcommand="$1"
  shift
  case "$subcommand" in
    version) printf '2.32.0\n' ;;
    config)
      node -e '
        const fs=require("node:fs");
        const expected=JSON.parse(fs.readFileSync(process.env.AIKAYUN_TEST_PAYLOAD+"/release-manifest.json","utf8")).images;
        for(const name of ["api","web","postgres","caddy"]) {
          const key="AIKAYUN_"+name.toUpperCase()+"_IMAGE";
          if(process.env[key]!==expected[name].reference) process.exit(1);
        }
      '
      event compose_config_four_signed_refs
      ;;
    up)
      service="$*"
      event "compose_up:$service"
      [[ "$service" != *caddy* ]] || : > "$AIKAYUN_TEST_STATE/caddy-started"
      ;;
    run)
      while (($#)); do
        case "$1" in --rm|--no-deps) shift ;; -e) shift 2 ;; *) break ;; esac
      done
      service="$1"
      event "compose_run:$service"
      if [[ "$service" == production-install-init ]]; then
        mkdir -p "$AIKAYUN_TEST_STATE/identity"
        [[ -f "$AIKAYUN_TEST_STATE/identity/installation.json" ]] || \
          printf 'controlled isolated identity\n' > "$AIKAYUN_TEST_STATE/identity/installation.json"
        [[ -f "$AIKAYUN_TEST_STATE/identity/pending-key.bin" ]] || \
          printf 'controlled isolated pending key\n' > "$AIKAYUN_TEST_STATE/identity/pending-key.bin"
      fi
      ;;
    exec)
      [[ "$1" != -T ]] || shift
      service="$1"
      shift
      if [[ "$*" == *setup-token-cli.js*issue* ]]; then
        [[ "$(tail -n 1 "$AIKAYUN_TEST_EVENT_LOG")" == https_probe_ready ]] || exit 1
        event setup_token_issue
        printf 'SIMULATED_SETUP_TOKEN_256BIT\n'
      elif [[ "$*" == *production-install-init.js*verify* ]]; then
        event identity_verify
      else
        event "compose_exec:$service"
      fi
      ;;
    ps)
      if [[ "${1:-}" == -q ]]; then printf 'fixture-%s\n' "${2:-service}"; fi
      ;;
    *) exit 2 ;;
  esac
  exit 0
fi
printf 'Unexpected isolated Docker shim command.\n' >&2
exit 2
DOCKER_FIXTURE
chmod 0700 "$FAKE_BIN/docker"

cat > "$FAKE_BIN/curl" <<'CURL_FIXTURE'
#!/usr/bin/env bash
set -Eeuo pipefail
set +x
output=''
url=''
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
[[ -n "$url" && -n "$output" ]] || exit 2
if [[ "$url" == https://store.customer.com/api/v1/setup/status ]]; then
  if [[ "$output" == /var/tmp/aikayun-install.*/setup-status.json && -d "$(dirname "$output")" ]]; then
    printf 'https_probe_workdir_retained\n' >> "$AIKAYUN_TEST_EVENT_LOG"
  else
    printf 'https_probe_workdir_missing\n' >> "$AIKAYUN_TEST_EVENT_LOG"
    exit 1
  fi
  if [[ "$AIKAYUN_TEST_TLS_READY" == 1 ]]; then
    printf '{"data":{"status":"required"}}\n' > "$output"
    printf 'https_probe_ready\n' >> "$AIKAYUN_TEST_EVENT_LOG"
    exit 0
  fi
  printf 'https_probe_unready\n' >> "$AIKAYUN_TEST_EVENT_LOG"
  exit 7
fi
if [[ "$url" == https://downloads.customer.com/.well-known/aikayun-release.json ]]; then
  printf '{"schema":1,"product":"aikayun","release_base_url":"https://downloads.customer.com/releases/","registry":"ghcr.io/yykx682436","publish_protocol":"http-put-if-none-match-v1"}\n' > "$output"
  exit 0
fi
if [[ "$AIKAYUN_TEST_SCENARIO" == release-download-failure && "$url" == */release-index.json ]]; then exit 8; fi
if [[ "$url" == https://downloads.customer.com/releases/9.8.7-rc.3/* ]]; then
  relative="$(printf '%s' "$url" | sed 's#^https://downloads.customer.com/releases/9.8.7-rc.3/##')"
  [[ "$relative" != *'..'* && -f "$AIKAYUN_TEST_PAYLOAD/$relative" ]] || exit 8
  cp "$AIKAYUN_TEST_PAYLOAD/$relative" "$output"
  if [[ "$AIKAYUN_TEST_SCENARIO" == fresh-install-untrusted-code && \
      ("$relative" == release-verifier.mjs || "$relative" == verify-artifacts.mjs) ]]; then
    printf '%s\n' 'import { writeFileSync } from "node:fs"; writeFileSync("/tmp/aikayun-untrusted-release-code-executed", "executed"); process.exit(0);' > "$output"
  elif [[ "$AIKAYUN_TEST_SCENARIO" == fresh-install-untrusted-code && "$relative" == extract-release-bundle.sh ]]; then
    printf '%s\n' '#!/bin/sh' 'touch /tmp/aikayun-untrusted-release-code-executed' 'exit 0' > "$output"
  elif [[ "$AIKAYUN_TEST_SCENARIO" == manifest-modified && "$relative" == release-manifest.json ]]; then
    node -e 'const fs=require("node:fs"),p=process.argv[1],m=JSON.parse(fs.readFileSync(p,"utf8"));m.source_commit="f".repeat(40);fs.writeFileSync(p,JSON.stringify(m))' "$output"
  elif [[ "$AIKAYUN_TEST_SCENARIO" == root-substitution && "$relative" == release-signing-root.jwk.json ]]; then
    node -e 'const fs=require("node:fs"),{generateKeyPairSync}=require("node:crypto"),p=process.argv[1],k=generateKeyPairSync("ec",{namedCurve:"prime256v1"}).publicKey.export({format:"jwk"});fs.writeFileSync(p,JSON.stringify({kty:k.kty,crv:k.crv,x:k.x,y:k.y})+"\n")' "$output"
  elif [[ "$AIKAYUN_TEST_SCENARIO" == compose-image-modified && "$relative" == compose.yaml ]]; then
    node -e 'const fs=require("node:fs"),p=process.argv[1],m=JSON.parse(fs.readFileSync(process.argv[2],"utf8")),old=m.images.api.reference,bad=old.slice(0,-1)+(old.endsWith("f")?"e":"f"),text=fs.readFileSync(p,"utf8");if(!text.includes(old))process.exit(1);fs.writeFileSync(p,text.replace(old,bad))' \
      "$output" "$AIKAYUN_TEST_PAYLOAD/release-manifest.json"
  fi
  exit 0
fi
exit 9
CURL_FIXTURE
chmod 0700 "$FAKE_BIN/curl"

cat > "$FAKE_BIN/getent" <<'GETENT_FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
[[ "$AIKAYUN_TEST_SCENARIO" != dns-failure || "$AIKAYUN_TEST_PREFLIGHT_OVERRIDE" == 1 ]] || exit 1
printf '192.0.2.80 STREAM %s\n' "$*"
GETENT_FIXTURE
chmod 0700 "$FAKE_BIN/getent"
cat > "$FAKE_BIN/df" <<'DF_FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
if [[ "$AIKAYUN_TEST_SCENARIO" == disk-low && "$AIKAYUN_TEST_PREFLIGHT_OVERRIDE" != 1 ]]; then
  printf '/dev/test 20000000 19999000 1000 99%% /\n'
  exit 0
fi
printf '/dev/test 20000000 0 20000000 0%% /\n'
DF_FIXTURE
chmod 0700 "$FAKE_BIN/df"

export AIKAYUN_TEST_PAYLOAD="$PAYLOAD_DIR"
export AIKAYUN_TEST_STATE="$FAKE_STATE"
export AIKAYUN_TEST_EVENT_LOG="$EVENT_LOG"
export AIKAYUN_TEST_SCENARIO="$SCENARIO"
export AIKAYUN_TEST_PREFLIGHT_OVERRIDE=1
export AIKAYUN_TEST_DOCKER_ENDPOINT="unix://$TEST_SOCKET"
export AIKAYUN_TEST_DOCKER_CONTEXT=local-fixture
export AIKAYUN_TEST_TLS_READY=0
export PATH="$FAKE_BIN:$PATH"

run_installer() {
  expected_status="$1"
  shift
  output="$HARNESS_ROOT/command-$RANDOM.log"
  if bash "$INSTALLER" "$@" >"$output" 2>&1; then status=0; else status=$?; fi
  if [[ "$status" != "$expected_status" ]]; then
    cat "$output" >&2
    printf 'Expected installer exit %s, got %s for %s.\n' "$expected_status" "$status" "$1" >&2
    exit 1
  fi
  printf '%s\n' "$output"
}
assert_no_workdir() {
  [[ -z "$(find /var/tmp -maxdepth 1 -type d -name 'aikayun-install.*' -print -quit)" ]] || {
    printf 'Installer leaked its temporary work directory.\n' >&2
    exit 1
  }
  [[ ! -e /setup-status.json ]] || { printf 'Installer wrote a response file at filesystem root.\n' >&2; exit 1; }
}
assert_no_secret_leak() {
  output_file="$1"
  for secret_file in "$TARGET_DIR"/secrets/*; do
    [[ -f "$secret_file" ]] || continue
    secret="$(cat "$secret_file")"
    [[ -n "$secret" ]] || continue
    ! grep -Fq -- "$secret" "$output_file" || { printf 'Installer output leaked a secret.\n' >&2; exit 1; }
  done
}
volume_file() { printf '%s/volumes/%s' "$FAKE_STATE" "$1"; }

printf 'managed-by=aikayun-7-3\nproject=aikayun\ncompose-volume=postgres_data\n' \
  > "$(volume_file aikayun_postgres_data)"
preexisting_volume_hash="$(sha256sum "$(volume_file aikayun_postgres_data)" | awk '{print $1}')"
if [[ "$SCENARIO" == fresh-install-untrusted-code ]]; then export AIKAYUN_TEST_SCENARIO=first-install-https-ready; fi
preexisting_log="$(run_installer 1 install --release-origin https://downloads.customer.com --version 9.8.7-rc.3 --domain store.customer.com)"
export AIKAYUN_TEST_SCENARIO="$SCENARIO"
grep -Fq 'persistent Docker volume already exists' "$preexisting_log"
[[ "$(sha256sum "$(volume_file aikayun_postgres_data)" | awk '{print $1}')" == "$preexisting_volume_hash" ]]
[[ ! -e "$TARGET_DIR" ]]
rm -f "$(volume_file aikayun_postgres_data)"
export AIKAYUN_TEST_PREFLIGHT_OVERRIDE=0

status_before="$(run_installer 0 status)"
grep -Fq 'AiKayun deployment state: not installed' "$status_before"

if [[ "$SCENARIO" == ports-in-use ]]; then
  node -e 'const net=require("node:net"); const server=net.createServer(); server.listen(80,"0.0.0.0"); setInterval(()=>{},3600000)' \
    >/dev/null 2>&1 &
  PORT_PID=$!
  port_ready=false
  for attempt in {1..40}; do
    if awk 'index($2, ":0050") == length($2)-length(":0050")+1 && $4 == "0A" { found=1 } END { exit !found }' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
      port_ready=true
      break
    fi
    sleep 0.05
  done
  [[ "$port_ready" == true ]] || { printf 'Port 80 listener fixture did not start.\n' >&2; exit 1; }
fi

case "$SCENARIO" in
  occupied-deployment)
    mkdir -p "$TARGET_DIR/secrets" "$TARGET_DIR/identity"
    printf 'existing customer secret\n' > "$TARGET_DIR/secrets/api_database_password"
    printf 'existing customer identity\n' > "$TARGET_DIR/identity/identity.json"
    printf 'existing customer configuration\n' > "$TARGET_DIR/.env"
    occupied_hash="$(find "$TARGET_DIR" -type f -exec sha256sum {} \; | sort | sha256sum | awk '{print $1}')"
    occupied_log="$(run_installer 1 install --release-origin https://downloads.customer.com --version 9.8.7-rc.3 --domain store.customer.com)"
    grep -Fq '/opt/aikayun is not empty' "$occupied_log"
    [[ "$(find "$TARGET_DIR" -type f -exec sha256sum {} \; | sort | sha256sum | awk '{print $1}')" == "$occupied_hash" ]]
    ! grep -Fq 'volume_create:' "$EVENT_LOG"
    exit 0
    ;;
  dns-failure|disk-low|ports-in-use|release-download-failure|manifest-modified|root-substitution|compose-image-modified|fresh-install-untrusted-code)
    failure_log="$(run_installer 1 install --release-origin https://downloads.customer.com --version 9.8.7-rc.3 --domain store.customer.com)"
    case "$SCENARIO" in
      dns-failure) grep -Fq 'does not resolve in DNS' "$failure_log" || { cat "$failure_log" >&2; exit 1; } ;;
      disk-low) grep -Fq 'At least 8 GiB of free disk space is required' "$failure_log" || { cat "$failure_log" >&2; exit 1; } ;;
      ports-in-use) grep -Fq 'port 80 or 443 is in use' "$failure_log" || { cat "$failure_log" >&2; exit 1; } ;;
      release-download-failure) grep -Fq 'Could not download the versioned release index' "$failure_log" || { cat "$failure_log" >&2; exit 1; } ;;
      manifest-modified) grep -Fq 'release JWS signature or embedded JWS root failed verification' "$failure_log" || { cat "$failure_log" >&2; exit 1; } ;;
      root-substitution) grep -Fq 'Installer-owned verification rejected a release artifact before any downloaded verifier could run' "$failure_log" || { cat "$failure_log" >&2; exit 1; } ;;
      compose-image-modified) grep -Fq 'Installer-owned verification rejected a release artifact before any downloaded verifier could run' "$failure_log" || { cat "$failure_log" >&2; exit 1; } ;;
      fresh-install-untrusted-code) grep -Fq 'Installer-owned verification rejected a release artifact before any downloaded verifier could run' "$failure_log" || { cat "$failure_log" >&2; exit 1; } ;;
    esac
    assert_no_workdir
    [[ ! -e "$TARGET_DIR" ]]
    ! grep -Eq '^(volume_create:|compose_up:|docker_pull)' "$EVENT_LOG"
    if [[ "$SCENARIO" == fresh-install-untrusted-code ]]; then
      [[ ! -e /tmp/aikayun-untrusted-release-code-executed ]]
      ! grep -Fq 'executed' "$failure_log"
    fi
    exit 0
    ;;
esac

if [[ "$SCENARIO" == first-install-tls-failure-resume ]]; then
  failed_install_log="$(run_installer 1 install --release-origin https://downloads.customer.com --version 9.8.7-rc.3 --domain store.customer.com)"
  grep -Fq 'DNS, ACME, or TLS is not ready' "$failed_install_log"
  assert_no_workdir
  [[ "$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1])).phase)' "$TARGET_DIR/install-state.json")" == caddy_started ]]
  [[ -f "$TARGET_DIR/secrets/api_database_password" && -f "$(volume_file aikayun_postgres_data)" ]]
  ! grep -Fq 'setup_token_issue' "$EVENT_LOG"
  ! grep -Fq 'https_probe_workdir_missing' "$EVENT_LOG"
  assert_no_secret_leak "$failed_install_log"
else
  export AIKAYUN_TEST_TLS_READY=1
  first_install_log="$(run_installer 0 install --release-origin https://downloads.customer.com --version 9.8.7-rc.3 --domain store.customer.com)"
  grep -Fq 'SIMULATED_SETUP_TOKEN_256BIT' "$first_install_log"
  [[ "$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1])).phase)' "$TARGET_DIR/install-state.json")" == setup_token_issued ]]
  assert_no_workdir
  ! grep -Fq 'https_probe_workdir_missing' "$EVENT_LOG"
  assert_no_secret_leak "$first_install_log"
fi
identity_hash="$(sha256sum "$FAKE_STATE/identity/"* | sha256sum | awk '{print $1}')"
secrets_hash="$(sha256sum "$TARGET_DIR/secrets/"* | sha256sum | awk '{print $1}')"

duplicate_log="$(run_installer 1 install --release-origin https://downloads.customer.com --version 9.8.7-rc.3 --domain store.customer.com)"
grep -Fq 'is not empty' "$duplicate_log"
[[ "$(sha256sum "$FAKE_STATE/identity/"* | sha256sum | awk '{print $1}')" == "$identity_hash" ]]
[[ "$(sha256sum "$TARGET_DIR/secrets/"* | sha256sum | awk '{print $1}')" == "$secrets_hash" ]]
assert_no_secret_leak "$duplicate_log"

if [[ "$SCENARIO" == resume-untrusted-code ]]; then
  snapshot_persistent_state() {
    find "$TARGET_DIR" "$FAKE_STATE" -type f ! -path "$EVENT_LOG" -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
  }
  backup_directory="$HARNESS_ROOT/release-backups"
  mkdir -m 0700 "$backup_directory"
  before_resume_snapshot="$(snapshot_persistent_state)"
  for artifact_name in release-verifier.mjs verify-artifacts.mjs extract-release-bundle.sh; do
    backup_path="$backup_directory/$artifact_name"
    stored_path="$TARGET_DIR/release/$artifact_name"
    cp -p "$stored_path" "$backup_path"
    case "$artifact_name" in
      *.mjs) printf '%s\n' 'import { writeFileSync } from "node:fs"; writeFileSync("/tmp/aikayun-untrusted-release-code-executed", "executed"); process.exit(0);' > "$stored_path" ;;
      *.sh) printf '%s\n' '#!/bin/sh' 'touch /tmp/aikayun-untrusted-release-code-executed' 'exit 0' > "$stored_path" ;;
    esac
    chmod 0600 "$stored_path"
    rm -f /tmp/aikayun-untrusted-release-code-executed
    events_before="$(wc -l < "$EVENT_LOG")"
    tampered_resume_log="$(run_installer 1 resume)"
    grep -Fq 'Installer-owned verification rejected a stored release artifact before any downloaded verifier could run' "$tampered_resume_log" || {
      cat "$tampered_resume_log" >&2
      exit 1
    }
    [[ ! -e /tmp/aikayun-untrusted-release-code-executed ]]
    ! grep -Fq 'executed' "$tampered_resume_log"
    ! tail -n +"$((events_before + 1))" "$EVENT_LOG" | grep -Eq '^(volume_create:|docker_pull|compose_up:|compose_run:)'
    cp -p "$backup_path" "$stored_path"
    [[ "$(snapshot_persistent_state)" == "$before_resume_snapshot" ]]
    assert_no_secret_leak "$tampered_resume_log"
  done
  printf 'Resume rejected tampered verifier and extractor artifacts before execution, preserving deployment data and volumes.\n'
  exit 0
fi

if [[ "$SCENARIO" == first-install-tls-failure-resume ]]; then
  export AIKAYUN_TEST_TLS_READY=1
  resume_log="$(run_installer 0 resume)"
  grep -Fq 'SIMULATED_SETUP_TOKEN_256BIT' "$resume_log"
  [[ "$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1])).phase)' "$TARGET_DIR/install-state.json")" == setup_token_issued ]]
  [[ "$(sha256sum "$FAKE_STATE/identity/"* | sha256sum | awk '{print $1}')" == "$identity_hash" ]]
  [[ "$(sha256sum "$TARGET_DIR/secrets/"* | sha256sum | awk '{print $1}')" == "$secrets_hash" ]]
  assert_no_workdir
  ! grep -Fq 'https_probe_workdir_missing' "$EVENT_LOG"
fi
awk '/setup_token_issue/ { if(previous!="https_probe_ready") exit 1; found++ } {previous=$0} END {if(found<1) exit 1}' "$EVENT_LOG"

status_log="$(run_installer 0 status)"
grep -Fq 'setup_token_issued' "$status_log"
diagnose_log="$(run_installer 0 diagnose)"
grep -Fq 'identity and Pending Key: verified' "$diagnose_log"
token_log="$(run_installer 0 setup-token)"
grep -Fq 'SIMULATED_SETUP_TOKEN_256BIT' "$token_log"
assert_no_workdir

before_remote="$(wc -l < "$EVENT_LOG")"
for command in status diagnose setup-token resume; do
  remote_log="$(AIKAYUN_TEST_DOCKER_ENDPOINT='ssh://operator@other-host' AIKAYUN_TEST_DOCKER_CONTEXT=remote-fixture run_installer 1 "$command")"
  grep -Fq 'Remote Docker Engines are not supported' "$remote_log"
done
host_log="$(AIKAYUN_TEST_DOCKER_ENDPOINT='unix:///tmp/aikayun-installer-flow-test/docker.sock' \
  AIKAYUN_TEST_DOCKER_CONTEXT=local-fixture DOCKER_CONTEXT='' DOCKER_HOST='tcp://other-host:2376' \
  run_installer 1 status)"
grep -Fq 'Remote Docker Engines are not supported' "$host_log"
[[ "$(awk 'NR>'"$before_remote"' && /^(docker_info|volume_create|compose_)/ {count++} END {print count+0}' "$EVENT_LOG")" == 0 ]]

printf 'Actual installer command flow passed in isolated Linux with controlled release, Docker, DNS and TLS fixtures.\n'
