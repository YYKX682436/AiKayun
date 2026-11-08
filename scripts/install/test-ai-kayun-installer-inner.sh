#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

PAYLOAD_DIR="$1"
SCENARIO="$2"
CANDIDATE_PAYLOAD_DIR="${3:-}"
HARNESS_ROOT=/tmp/aikayun-installer-flow-test
FAKE_BIN="$HARNESS_ROOT/bin"
FAKE_STATE="$HARNESS_ROOT/state"
EVENT_LOG="$FAKE_STATE/events.log"
TARGET_DIR=/opt/aikayun
INSTALLER="$PAYLOAD_DIR/install.sh"
TEST_SOCKET="$HARNESS_ROOT/docker.sock"
SOCKET_PID=''
PORT_PID=''
HANDOFF_PID=''
trap 'status=$?; trap - ERR; printf "Installer flow assertion failed (exit %s) at %s:%s: %s\\n" "$status" "${BASH_SOURCE[0]}" "${BASH_LINENO[0]:-0}" "$BASH_COMMAND" >&2; if [[ -f "$EVENT_LOG" ]]; then tail -30 "$EVENT_LOG" >&2; fi; exit "$status"' ERR
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
  first-install-tls-failure-resume|first-install-https-ready|release-download-failure|manifest-modified|root-substitution|compose-image-modified|dns-failure|disk-low|ports-in-use|occupied-deployment|fresh-install-untrusted-code|resume-untrusted-code|backup-customer-command-integrity|upgrade-success|upgrade-incompatible|upgrade-migration-mismatch|upgrade-trust-mismatch|upgrade-signature-invalid|upgrade-start-failure|upgrade-lock-competition) ;;
  *) printf 'Unknown isolated installer scenario.\n' >&2; exit 2 ;;
esac
if [[ "$SCENARIO" == upgrade-* ]]; then
  [[ -n "$CANDIDATE_PAYLOAD_DIR" && -d "$CANDIDATE_PAYLOAD_DIR" && -f "$CANDIDATE_PAYLOAD_DIR/release-manifest.json" ]] || {
    printf 'Signed upgrade candidate fixture is missing.\n' >&2
    exit 2
  }
fi
if [[ "$SCENARIO" != occupied-deployment && -e "$TARGET_DIR" ]]; then
  printf 'Refusing to use an occupied target path.\n' >&2
  exit 2
fi
[[ -z "$(find /var/tmp -maxdepth 1 -type d -name 'aikayun-install.*' -print -quit)" ]] || {
  printf 'Unexpected temporary installer directory exists.\n' >&2
  exit 2
}
mkdir -p "$FAKE_BIN" "$FAKE_STATE/volumes" "$FAKE_STATE/identity" "$FAKE_STATE/services"
: > "$EVENT_LOG"

cleanup_fixture() {
  status=$?
  if [[ -e "$TARGET_DIR/.install-owner" && "$(cat "$TARGET_DIR/.install-owner" 2>/dev/null || true)" == aikayun-install-v1 ]]; then
    rm -rf -- "$TARGET_DIR"
  fi
  if [[ -n "$SOCKET_PID" ]]; then kill "$SOCKET_PID" 2>/dev/null || true; fi
  if [[ -n "$PORT_PID" ]]; then kill "$PORT_PID" 2>/dev/null || true; fi
  if [[ -n "$HANDOFF_PID" ]]; then kill "$HANDOFF_PID" 2>/dev/null || true; fi
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
service_file() { printf '%s/services/%s' "$AIKAYUN_TEST_STATE" "$1"; }

if [[ "$1" == context ]]; then
  shift
  case "$1" in
    show) printf '%s\n' "$AIKAYUN_TEST_DOCKER_CONTEXT" ;;
    inspect) event "context_inspect:$2"; printf '%s\n' "$AIKAYUN_TEST_DOCKER_ENDPOINT" ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [[ "$1" == --host ]]; then shift 2; fi
if [[ "$1" == --version ]]; then printf 'Docker version 29.9.3, build fixture\n'; exit 0; fi
if [[ "$1" == compose && "$2" == version ]]; then printf 'v5.7.0\n'; exit 0; fi
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
if [[ "$1" == pull ]]; then
  image="${2:-}"
  if [[ -n "${AIKAYUN_TEST_CANDIDATE_VERSION:-}" && "$image" == *":$AIKAYUN_TEST_CANDIDATE_VERSION" ]]; then
    printf '%s\n' candidate > "$AIKAYUN_TEST_STATE/active-payload"
  elif [[ "$image" == *":9.8.7-rc.3" ]]; then
    printf '%s\n' current > "$AIKAYUN_TEST_STATE/active-payload"
  fi
  event "docker_pull:$image"
  exit 0
fi
if [[ "$1" == network && "$2" == inspect ]]; then
  event docker_network_inspect
  if [[ -e "$AIKAYUN_TEST_STATE/restore-plan-enabled" ]]; then
    event restore_plan_network_fixture
    printf 'aikayun private aikayun_private local\n'
    exit 0
  fi
  if [[ "${AIKAYUN_TEST_BROKER_HOLD:-}" == 1 ]]; then
    : > "$AIKAYUN_TEST_STATE/broker-waiting"
    while [[ -e "$AIKAYUN_TEST_STATE/broker-hold" ]]; do sleep 0.05; done
  fi
  exit 1
fi
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
  container="${@: -1}"
  service="${container#fixture-}"
  container_state="$(cat "$(service_file "$service")" 2>/dev/null || printf 'running|0|healthy')"
  container_status="${container_state%%|*}"
  remaining="${container_state#*|}"
  container_exit="${remaining%%|*}"
  remaining="${remaining#*|}"
  container_health="${remaining%%|*}"
  container_image="${remaining#*|}"
  case "$3" in
    *PortBindings*)
      [[ "$service" == caddy && "$container_status" == running ]] && printf '80/tcp=80\n443/tcp=443\n443/udp=443\n' ;;
    *State.Health*) [[ "$container_status" == running ]] && printf '%s\n' "$container_health" || printf '%s\n' "$container_status" ;;
    *State.Status*State.ExitCode*) printf '%s|%s\n' "$container_status" "$container_exit" ;;
    *State.Status*) printf '%s\n' "$container_status" ;;
    *State.ExitCode*) printf '%s\n' "$container_exit" ;;
    *Config.Image*) printf '%s\n' "$container_image" ;;
    *) printf '%s\n' "$container_status" ;;
  esac
  exit 0
fi
if [[ "$1" == image && "$2" == inspect ]]; then
  if [[ "$5" == *RepoDigests* ]]; then
    printf 'ghcr.io/yykx682436/aikayun-release-bundle@sha256:%064d\n' 0
  else
    if [[ "$(cat "$AIKAYUN_TEST_STATE/active-payload" 2>/dev/null || true)" == candidate ]]; then
      printf '%s\n' "$AIKAYUN_TEST_CANDIDATE_VERSION"
    else
      printf '%s\n' "$AIKAYUN_TEST_CURRENT_VERSION"
    fi
  fi
  exit 0
fi
if [[ "$1" == create ]]; then event oci_container_create; printf 'fixture-release-container\n'; exit 0; fi
if [[ "$1" == cp ]]; then
  destination="$3"
  mkdir -p "$destination"
  active_payload="$(cat "$AIKAYUN_TEST_STATE/active-payload" 2>/dev/null || printf current)"
  if [[ "$active_payload" == candidate ]]; then source_payload="$AIKAYUN_TEST_CANDIDATE_PAYLOAD"; else source_payload="$AIKAYUN_TEST_PAYLOAD"; fi
  cp -a "$source_payload/." "$destination/"
  event oci_bundle_copy
  exit 0
fi
if [[ "$1" == rm ]]; then event container_remove; exit 0; fi

if [[ "$1" == run ]]; then
  if [[ "$*" == *'/app/dist/backup/helper-cli.js'* && " $* " == *' restore-plan '* ]]; then
    event restore_plan_helper_entered
    plan_set="$(cat "$AIKAYUN_TEST_STATE/restore-plan-set")"
    plan_mode="$(cat "$AIKAYUN_TEST_STATE/restore-plan-mode")"
    case "$plan_mode" in
      verified|after-transaction|pending-operation|authorization-unknown|target-clone)
        report="{\"operation\":\"restore-plan\",\"backupSetId\":\"$plan_set\",\"backup\":\"verified\",\"compatibility\":\"matched\",\"identity\":\"matched\",\"target\":\"unknown\",\"technicalChecks\":\"passed\",\"businessAfterBackup\":\"unknown\",\"pendingExternalOperations\":\"unknown\",\"authorization\":\"unknown\",\"disk\":\"unknown\",\"externalReconciliation\":\"required\",\"blockingReason\":\"target-identity-unverified\",\"readiness\":\"blocked\",\"automaticRestore\":\"blocked\"}" ;;
      database-unavailable)
        report="{\"operation\":\"restore-plan\",\"backupSetId\":\"$plan_set\",\"backup\":\"blocked\",\"compatibility\":\"unknown\",\"identity\":\"unknown\",\"target\":\"unknown\",\"technicalChecks\":\"incomplete\",\"businessAfterBackup\":\"unknown\",\"pendingExternalOperations\":\"unknown\",\"authorization\":\"unknown\",\"disk\":\"unknown\",\"externalReconciliation\":\"required\",\"blockingReason\":\"database-unavailable\",\"readiness\":\"blocked\",\"automaticRestore\":\"blocked\"}" ;;
      schema-mismatch|identity-mismatch)
        report="{\"operation\":\"restore-plan\",\"backupSetId\":\"$plan_set\",\"backup\":\"blocked\",\"compatibility\":\"unknown\",\"identity\":\"unknown\",\"target\":\"unknown\",\"technicalChecks\":\"incomplete\",\"businessAfterBackup\":\"unknown\",\"pendingExternalOperations\":\"unknown\",\"authorization\":\"unknown\",\"disk\":\"unknown\",\"externalReconciliation\":\"required\",\"blockingReason\":\"identity-or-schema-mismatch\",\"readiness\":\"blocked\",\"automaticRestore\":\"blocked\"}" ;;
      historical-key-invalid|snapshot-corrupt|key-or-snapshot-corrupt)
        report="{\"operation\":\"restore-plan\",\"backupSetId\":\"$plan_set\",\"backup\":\"blocked\",\"compatibility\":\"unknown\",\"identity\":\"unknown\",\"target\":\"unknown\",\"technicalChecks\":\"incomplete\",\"businessAfterBackup\":\"unknown\",\"pendingExternalOperations\":\"unknown\",\"authorization\":\"unknown\",\"disk\":\"unknown\",\"externalReconciliation\":\"required\",\"blockingReason\":\"backup-check-failed\",\"readiness\":\"blocked\",\"automaticRestore\":\"blocked\"}" ;;
      interrupt) exit 130 ;;
      lockhold)
        report="{\"operation\":\"restore-plan\",\"backupSetId\":\"$plan_set\",\"backup\":\"verified\",\"compatibility\":\"matched\",\"identity\":\"matched\",\"target\":\"unknown\",\"technicalChecks\":\"passed\",\"businessAfterBackup\":\"unknown\",\"pendingExternalOperations\":\"unknown\",\"authorization\":\"unknown\",\"disk\":\"unknown\",\"externalReconciliation\":\"required\",\"blockingReason\":\"target-identity-unverified\",\"readiness\":\"blocked\",\"automaticRestore\":\"blocked\"}" ;;
      *) exit 2 ;;
    esac
    if [[ "$plan_mode" == lockhold ]]; then
      : > "$AIKAYUN_TEST_STATE/restore-plan-helper-waiting"
      while [[ -e "$AIKAYUN_TEST_STATE/restore-plan-helper-hold" ]]; do sleep 0.05; done
    fi
    printf 'REQ\t1\tclient-result\t%s\n' "$(printf '%s' "$report" | base64 -w0)"
    IFS= read -r response || exit 1
    [[ "$response" == $'RES\t1\tOK\t' ]] || exit 1
    event "restore_plan_helper_result:$plan_mode"
    exit 0
  fi
  shift
  mount_sources=()
  mount_targets=()
  entrypoint=''
  while (($#)); do
    case "$1" in
      --rm|--interactive|-i|--read-only) shift ;;
      --pull=*) shift ;;
      --network|--cap-drop|--security-opt) shift 2 ;;
      --mount)
        mount_spec="$2"
        mount_sources+=("$(printf '%s' "$mount_spec" | sed -n 's/.*source=\([^,]*\).*/\1/p')")
        mount_targets+=("$(printf '%s' "$mount_spec" | sed -n 's/.*target=\([^,]*\).*/\1/p')")
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
  if [[ "$entrypoint" == node || "$entrypoint" == /nodejs/bin/node ]]; then
    if [[ "$1" == -e ]]; then
      shift
      script="$1"
      shift
      MOUNT_SOURCE_0="${mount_sources[0]:-}" MOUNT_TARGET_0="${mount_targets[0]:-}" \
      MOUNT_SOURCE_1="${mount_sources[1]:-}" MOUNT_TARGET_1="${mount_targets[1]:-}" \
      node -e '
        const {spawnSync}=require("node:child_process");
        let source=process.argv[1];
        const mounts=[0,1].map(i=>({source:process.env[`MOUNT_SOURCE_${i}`],target:process.env[`MOUNT_TARGET_${i}`]})).filter(x=>x.source&&x.target);
        const remap=value=>mounts.reduce((mapped,mount)=>{
          const escaped=mount.target.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
          return mapped.replace(new RegExp(`${escaped}(?=/|[\\"\\s]|$)`,"g"),mount.source);
        },value);
        source=remap(source);
        const args=process.argv.slice(2).map(remap);
        const result=spawnSync(process.execPath,["-e",source,...args],{stdio:"inherit"});
        process.exit(result.status===null?1:result.status);
      ' "$script" "$@"
      exit $?
    fi
    MOUNT_SOURCE_0="${mount_sources[0]:-}" MOUNT_TARGET_0="${mount_targets[0]:-}" \
    MOUNT_SOURCE_1="${mount_sources[1]:-}" MOUNT_TARGET_1="${mount_targets[1]:-}" \
    node -e '
      const {spawnSync}=require("node:child_process");
      const mounts=[0,1].map(i=>({source:process.env[`MOUNT_SOURCE_${i}`],target:process.env[`MOUNT_TARGET_${i}`]})).filter(x=>x.source&&x.target);
      const remap=value=>mounts.reduce((mapped,mount)=>{
        const escaped=mount.target.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
        return mapped.replace(new RegExp(`${escaped}(?=/|[\\"\\s]|$)`,"g"),mount.source);
      },value);
      const result=spawnSync(process.execPath,[remap(process.argv[1]),...process.argv.slice(2).map(remap)],{stdio:"inherit"});
      process.exit(result.status===null?1:result.status);
    ' "$1" "${@:2}"
    exit $?
  fi
  exit 2
fi

if [[ "$1" == compose ]]; then
  shift
  compose_file=''
  while (($#)); do
    case "$1" in
      --project-name) shift 2 ;;
      --file) compose_file="$2"; shift 2 ;;
      --env-file) shift 2 ;;
      *) break ;;
    esac
  done
  subcommand="$1"
  shift
  manifest_path="${compose_file%/compose.yaml}/release-manifest.json"
  release_version="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version)' "$manifest_path" 2>/dev/null || true)"
  service_is_candidate=0
  [[ -n "${AIKAYUN_TEST_CANDIDATE_VERSION:-}" && "$release_version" == "$AIKAYUN_TEST_CANDIDATE_VERSION" ]] && service_is_candidate=1
  case "$subcommand" in
    version) printf '2.32.0\n' ;;
    config)
      node -e '
        const fs=require("node:fs");
        const expected=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).images;
        for(const name of ["api","web","postgres","caddy"]) {
          const key="AIKAYUN_"+name.toUpperCase()+"_IMAGE";
          if(process.env[key]!==expected[name].reference) {
            process.stderr.write(`${key} expected ${expected[name].reference} got ${process.env[key]}\n`);
            process.exit(1);
          }
        }
      ' "$manifest_path"
      event "compose_config:$release_version"
      ;;
    up)
      services=()
      while (($#)); do
        case "$1" in
          -d|--force-recreate|--no-recreate|--no-deps) shift ;;
          --timeout) shift 2 ;;
          *) services+=("$1"); shift ;;
        esac
      done
      service_text="${services[*]}"
      if [[ "$service_is_candidate" == 1 && "${AIKAYUN_TEST_SCENARIO:-}" == upgrade-start-failure && \
        "${AIKAYUN_UPGRADE_PROBE_ONLY:-false}" == true && " ${services[*]} " == *' api '* && \
        ! -e "$AIKAYUN_TEST_STATE/probe-start-failed" ]]; then
        : > "$AIKAYUN_TEST_STATE/probe-start-failed"
        event "compose_up_failed:$release_version:$service_text"
        exit 1
      fi
      event "compose_up:$release_version:$service_text:probe=${AIKAYUN_UPGRADE_PROBE_ONLY:-false}"
      for service in "${services[@]}"; do
        [[ -n "$service" ]] || continue
        case "$service" in
          api) image_ref="$AIKAYUN_API_IMAGE" ;;
          web) image_ref="$AIKAYUN_WEB_IMAGE" ;;
          db) image_ref="$AIKAYUN_POSTGRES_IMAGE" ;;
          caddy) image_ref="$AIKAYUN_CADDY_IMAGE" ;;
          *) image_ref=fixture ;;
        esac
        printf 'running|0|healthy|%s\n' "$image_ref" > "$(service_file "$service")"
        [[ "$service" != caddy ]] || : > "$AIKAYUN_TEST_STATE/caddy-started"
      done
      ;;
    stop)
      services=()
      while (($#)); do
        case "$1" in --timeout) shift 2 ;; *) services+=("$1"); shift ;; esac
      done
      event "compose_stop:$release_version:${services[*]}"
      for service in "${services[@]}"; do
        [[ -n "$service" ]] || continue
        printf 'exited|0|none\n' > "$(service_file "$service")"
        [[ "$service" != caddy ]] || rm -f "$AIKAYUN_TEST_STATE/caddy-started"
      done
      ;;
    run)
      entrypoint=''
      while (($#)); do
        case "$1" in
          --rm|--no-deps) shift ;;
          -e|--entrypoint) [[ "$1" == --entrypoint ]] && entrypoint="$2"; shift 2 ;;
          *) break ;;
        esac
      done
      service="$1"
      shift
      event "compose_run:$release_version:$service"
      if [[ "$*" == *upgrade-database-check-cli.js* ]]; then
        [[ "$entrypoint" == /nodejs/bin/node ]] || { event upgrade_database_check_was_not_readonly; exit 1; }
        event compose_upgrade_database_check_readonly
        if [[ "$AIKAYUN_TEST_SCENARIO" == upgrade-lock-competition ]]; then
          : > "$AIKAYUN_TEST_STATE/upgrade-lock-held"
          while [[ -e "$AIKAYUN_TEST_STATE/upgrade-lock-release" ]]; do sleep 0.05; done
        fi
      elif [[ "$service" == migrate ]]; then
        event compose_migration_default_entrypoint
      fi
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
        grep -Fq 'https_probe_ready' "$AIKAYUN_TEST_EVENT_LOG" || exit 1
        event setup_token_issue
        printf 'SIMULATED_SETUP_TOKEN_256BIT\n'
      elif [[ "$*" == *production-install-init.js*verify* ]]; then
        event identity_verify
      else
        event "compose_exec:$service"
      fi
      ;;
    ps)
      service="${@: -1}"
      if [[ -f "$(service_file "$service")" ]]; then printf 'fixture-%s\n' "$service"; fi
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
if [[ "$url" =~ ^https://downloads\.customer\.com/releases/([^/]+)/(.+)$ ]]; then
  release_version="${BASH_REMATCH[1]}"
  relative="${BASH_REMATCH[2]}"
  release_payload="$AIKAYUN_TEST_PAYLOAD"
  if [[ -n "${AIKAYUN_TEST_CANDIDATE_VERSION:-}" && "$release_version" == "$AIKAYUN_TEST_CANDIDATE_VERSION" ]]; then
    release_payload="$AIKAYUN_TEST_CANDIDATE_PAYLOAD"
  elif [[ "$release_version" != "$AIKAYUN_TEST_CURRENT_VERSION" ]]; then
    exit 8
  fi
  [[ "$relative" != *'..'* && -f "$release_payload/$relative" ]] || exit 8
  cp "$release_payload/$relative" "$output"
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
      "$output" "$release_payload/release-manifest.json"
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
export AIKAYUN_TEST_CANDIDATE_PAYLOAD="$CANDIDATE_PAYLOAD_DIR"
AIKAYUN_TEST_CURRENT_VERSION="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version)' "$PAYLOAD_DIR/release-manifest.json")"
AIKAYUN_TEST_CANDIDATE_VERSION=''
if [[ -n "$CANDIDATE_PAYLOAD_DIR" ]]; then
  AIKAYUN_TEST_CANDIDATE_VERSION="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version)' "$CANDIDATE_PAYLOAD_DIR/release-manifest.json")"
fi
export AIKAYUN_TEST_CURRENT_VERSION AIKAYUN_TEST_CANDIDATE_VERSION
printf '%s\n' current > "$FAKE_STATE/active-payload"
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
run_customer_command() {
  expected_status="$1"
  shift
  output="$HARNESS_ROOT/customer-command-$RANDOM.log"
  if "$TARGET_DIR/aikayun" "$@" >"$output" 2>&1; then status=0; else status=$?; fi
  if [[ "$status" != "$expected_status" ]]; then
    cat "$output" >&2
    printf 'Expected customer command exit %s, got %s for %s.\n' "$expected_status" "$status" "$1" >&2
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
service_file() { printf '%s/services/%s' "$FAKE_STATE" "$1"; }

printf 'managed-by=aikayun-7-3\nproject=aikayun\ncompose-volume=postgres_data\n' \
  > "$(volume_file aikayun_postgres_data)"
preexisting_volume_hash="$(sha256sum "$(volume_file aikayun_postgres_data)" | awk '{print $1}')"
if [[ "$SCENARIO" == fresh-install-untrusted-code ]]; then export AIKAYUN_TEST_SCENARIO=first-install-https-ready; fi
preexisting_log="$(run_installer 1 install --release-origin https://downloads.customer.com --version 9.8.7-rc.3 --domain store.customer.com)"
export AIKAYUN_TEST_SCENARIO="$SCENARIO"
grep -Fq 'persistent Docker volume already exists' "$preexisting_log" || { cat "$preexisting_log" >&2; exit 1; }
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

if [[ "$SCENARIO" == upgrade-* ]]; then
  snapshot_upgrade_data() {
    find "$TARGET_DIR/secrets" "$FAKE_STATE/identity" "$FAKE_STATE/volumes" -type f -print0 | sort -z | \
      xargs -0 sha256sum | sha256sum | awk '{print $1}'
  }
  old_manifest_sha="$(sha256sum "$TARGET_DIR/release/release-manifest.json" | awk '{print $1}')"
  old_env_sha="$(sha256sum "$TARGET_DIR/.env" | awk '{print $1}')"
  old_data_snapshot="$(snapshot_upgrade_data)"
  old_default_migration_count="$(grep -c '^compose_migration_default_entrypoint$' "$EVENT_LOG" || true)"
  before_upgrade_events="$(wc -l < "$EVENT_LOG")"

  case "$SCENARIO" in
    upgrade-success)
      upgrade_log="$(run_customer_command 0 upgrade --version 9.8.7-rc.4)"
      grep -Fq 'AiKayun upgraded from 9.8.7-rc.3 to 9.8.7-rc.4' "$upgrade_log"
      [[ "$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1])).version)' "$TARGET_DIR/install-state.json")" == 9.8.7-rc.4 ]]
      [[ "$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1])).upgrade.previous_version)' "$TARGET_DIR/install-state.json")" == 9.8.7-rc.3 ]]
      [[ "$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1])).upgrade.rollback_status)' "$TARGET_DIR/install-state.json")" == blocked_after_acceptance ]]
      [[ "$(sha256sum "$TARGET_DIR/release/release-manifest.json" | awk '{print $1}')" == \
        "$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1])).manifest_sha256)' "$TARGET_DIR/install-state.json")" ]]
      [[ -d "$TARGET_DIR/previous-release" && ! -L "$TARGET_DIR/previous-release" ]]
      [[ "$(sha256sum "$TARGET_DIR/previous-release/release-manifest.json" | awk '{print $1}')" == "$old_manifest_sha" ]]
      node -e '
        const fs=require("node:fs");
        const manifest=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
        const env=fs.readFileSync(process.argv[2],"utf8");
        for(const key of ["api","web"]) if(!env.includes(`AIKAYUN_${key.toUpperCase()}_IMAGE=${manifest.images[key].reference}\n`)) process.exit(1);
      ' "$TARGET_DIR/release/release-manifest.json" "$TARGET_DIR/.env"
      [[ "$(snapshot_upgrade_data)" == "$old_data_snapshot" ]]
      [[ "$(grep -c '^compose_migration_default_entrypoint$' "$EVENT_LOG" || true)" == "$old_default_migration_count" ]]
      grep -Fq 'compose_upgrade_database_check_readonly' "$EVENT_LOG"
      ! grep -Eq '^volume_create:' <(tail -n "+$((before_upgrade_events + 1))" "$EVENT_LOG")
      [[ ! -e "$FAKE_STATE/upgrade-lock-held" && ! -e "$TARGET_DIR/.upgrade-journal.json" ]]
      printf 'Signed customer upgrade succeeded; exact migration registry was checked read-only; business volumes, secrets, and identity hashes stayed unchanged.\n'
      ;;
    upgrade-incompatible|upgrade-migration-mismatch|upgrade-trust-mismatch)
      upgrade_log="$(run_customer_command 1 upgrade --version 9.8.7-rc.4)"
      grep -Fq 'first-stage upgrade and rollback compatibility policy' "$upgrade_log"
      [[ "$(tail -n +"$((before_upgrade_events + 1))" "$EVENT_LOG" | grep -c '^compose_stop:' || true)" == 0 ]]
      [[ "$(sha256sum "$TARGET_DIR/.env" | awk '{print $1}')" == "$old_env_sha" ]]
      [[ "$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1])).version)' "$TARGET_DIR/install-state.json")" == 9.8.7-rc.3 ]]
      [[ "$(snapshot_upgrade_data)" == "$old_data_snapshot" ]]
      [[ ! -e "$TARGET_DIR/.release-upgrade-new" && ! -e "$TARGET_DIR/.upgrade-journal.json" ]]
      printf 'Signed compatibility rejection completed before stopping services or changing persistent data.\n'
      ;;
    upgrade-signature-invalid)
      upgrade_log="$(run_customer_command 1 upgrade --version 9.8.7-rc.4)"
      grep -Fq 'release JWS signature or embedded JWS root failed verification' "$upgrade_log"
      [[ "$(tail -n +"$((before_upgrade_events + 1))" "$EVENT_LOG" | grep -c '^compose_stop:' || true)" == 0 ]]
      [[ "$(snapshot_upgrade_data)" == "$old_data_snapshot" ]]
      [[ ! -e "$TARGET_DIR/.release-upgrade-new" ]]
      printf 'Candidate signature rejection completed before stopping services or changing persistent data.\n'
      ;;
    upgrade-start-failure)
      upgrade_log="$(run_customer_command 1 upgrade --version 9.8.7-rc.4)"
      grep -Fq 'candidate API probe failed before public traffic' "$upgrade_log"
      grep -Fq 'prior program restored' "$upgrade_log"
      [[ "$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1])).version)' "$TARGET_DIR/install-state.json")" == 9.8.7-rc.3 ]]
      [[ "$(sha256sum "$TARGET_DIR/release/release-manifest.json" | awk '{print $1}')" == "$old_manifest_sha" ]]
      [[ "$(sha256sum "$TARGET_DIR/.env" | awk '{print $1}')" == "$old_env_sha" ]]
      [[ "$(snapshot_upgrade_data)" == "$old_data_snapshot" ]]
      [[ "$(cat "$(service_file caddy)")" == running\|0\|healthy\|* ]]
      [[ ! -e "$TARGET_DIR/previous-release" && ! -e "$TARGET_DIR/.upgrade-journal.json" ]]
      printf 'Candidate startup probe failure restored the old program before business workers or public traffic started.\n'
      ;;
    upgrade-lock-competition)
      touch "$FAKE_STATE/upgrade-lock-release"
      "$TARGET_DIR/aikayun" upgrade --version 9.8.7-rc.4 > "$HARNESS_ROOT/upgrade-lock-running.log" 2>&1 &
      upgrade_pid=$!
      for _ in {1..1200}; do
        [[ -f "$FAKE_STATE/upgrade-lock-held" ]] && break
        kill -0 "$upgrade_pid" 2>/dev/null || { cat "$HARNESS_ROOT/upgrade-lock-running.log" >&2; exit 1; }
        sleep 0.05
      done
      [[ -f "$FAKE_STATE/upgrade-lock-held" ]] || { cat "$HARNESS_ROOT/upgrade-lock-running.log" >&2; exit 1; }
      if competing="$("$TARGET_DIR/aikayun" backup list 2>&1)"; then
        printf 'Concurrent backup unexpectedly bypassed the upgrade lock.\n' >&2; exit 1
      else
        competing_status=$?
      fi
      [[ "$competing_status" != 0 ]]
      grep -Fq 'Another install, resume, setup-token, backup, or upgrade command holds the deployment lock' <<< "$competing"
      rm -f "$FAKE_STATE/upgrade-lock-release"
      wait "$upgrade_pid"
      grep -Fq 'AiKayun upgraded from 9.8.7-rc.3 to 9.8.7-rc.4' "$HARNESS_ROOT/upgrade-lock-running.log"
      [[ "$(snapshot_upgrade_data)" == "$old_data_snapshot" ]]
      printf 'Backup command observed the shared deployment lock while the signed upgrade held it.\n'
      ;;
  esac
  assert_no_workdir
  exit 0
fi

if [[ "$SCENARIO" == backup-customer-command-integrity ]]; then
  customer_command() {
    local expected="$1" output status
    output="$HARNESS_ROOT/customer-backup-$RANDOM.log"
    if "$TARGET_DIR/aikayun" backup create >"$output" 2>&1; then status=0; else status=$?; fi
    if [[ "$status" != "$expected" ]]; then cat "$output" >&2; printf 'Expected customer backup status %s, got %s.\n' "$expected" "$status" >&2; exit 1; fi
    printf '%s\n' "$output"
  }

  [[ -f "$TARGET_DIR/aikayun" && ! -L "$TARGET_DIR/aikayun" ]]
  [[ "$(stat -c '%u:%g:%a:%h' "$TARGET_DIR/aikayun")" == 0:0:555:1 ]]
  cmp -s "$TARGET_DIR/aikayun" "$TARGET_DIR/release/install.sh"
  broker="$TARGET_DIR/release/backup-host-broker.sh"
  [[ -f "$broker" && ! -L "$broker" ]]

  cp -p "$broker" "$HARNESS_ROOT/original-backup-host-broker.sh"
  printf '# tampered fixture\n' >> "$broker"
  before_events="$(wc -l < "$EVENT_LOG")"
  tampered_log="$(customer_command 1)"
  grep -Fq 'Installer-owned verification rejected a stored release artifact before any downloaded verifier could run' "$tampered_log" || { cat "$tampered_log" >&2; exit 1; }
  ! tail -n +"$((before_events + 1))" "$EVENT_LOG" | grep -Eq '^(docker_network_inspect|compose_down:|docker_stop:|service_stop:)'
  cp -p "$HARNESS_ROOT/original-backup-host-broker.sh" "$broker"

  mv "$broker" "$HARNESS_ROOT/missing-backup-host-broker.sh"
  missing_log="$(customer_command 1)"
  grep -Fq 'Installer-owned verification rejected a stored release artifact before any downloaded verifier could run' "$missing_log" || { cat "$missing_log" >&2; exit 1; }
  mv "$HARNESS_ROOT/missing-backup-host-broker.sh" "$broker"

  cp -p "$TARGET_DIR/release/release-manifest.jws" "$HARNESS_ROOT/original-release-manifest.jws"
  printf 'tampered signature fixture\n' > "$TARGET_DIR/release/release-manifest.jws"
  signature_log="$(customer_command 1)"
  grep -Fq 'The stored release JWS signature is invalid' "$signature_log"
  cp -p "$HARNESS_ROOT/original-release-manifest.jws" "$TARGET_DIR/release/release-manifest.jws"

  {
    printf '%s\n' '#!/bin/bash'
    printf '%s\n' 'export AIKAYUN_TEST_DOCKER_CONTEXT=local-fixture'
    printf '%s\n' 'export AIKAYUN_TEST_DOCKER_ENDPOINT=unix:///tmp/aikayun-installer-flow-test/docker.sock'
    printf '%s\n' 'export AIKAYUN_TEST_EVENT_LOG=/tmp/aikayun-installer-flow-test/state/events.log'
    printf '%s\n' 'export AIKAYUN_TEST_PAYLOAD=/fixture/release'
    printf '%s\n' 'export AIKAYUN_TEST_PREFLIGHT_OVERRIDE=0'
    printf '%s\n' 'export AIKAYUN_TEST_SCENARIO=backup-customer-command-integrity'
    printf '%s\n' 'export AIKAYUN_TEST_STATE=/tmp/aikayun-installer-flow-test/state'
    printf '%s\n' 'export AIKAYUN_TEST_TLS_READY=1'
    printf '%s\n' 'export AIKAYUN_TEST_BROKER_HOLD=1'
    printf 'exec %q "$@"\n' "$FAKE_BIN/docker"
  } >/usr/bin/docker
  chmod 0755 /usr/bin/docker

  [[ ! -e /var/lib/aikayun-backup && ! -e /etc/aikayun-backup ]] || {
    printf 'Fixed backup paths already exist in the isolated runner.\n' >&2; exit 2;
  }
  mkdir -m 0700 -p /var/lib/aikayun-backup /var/lib/aikayun-backup/repository \
    /var/lib/aikayun-backup/journal /var/lib/aikayun-backup/publications /var/lib/aikayun-backup/staging \
    /etc/aikayun-backup
  printf 'fixture backup password\n' > /etc/aikayun-backup/restic-password
  chmod 0600 /etc/aikayun-backup/restic-password

  printf 'Backup command fixture: starting the held customer command.\n'
  touch "$FAKE_STATE/broker-hold"
  AIKAYUN_TEST_BROKER_HOLD=1 "$TARGET_DIR/aikayun" backup create >"$HARNESS_ROOT/customer-backup-running.log" 2>&1 &
  command_pid=$!
  # ARM64 runs through QEMU in CI, where verifying the signed artifact set can
  # take longer than the native runner. Keep the wait bounded but avoid racing
  # the broker-ready marker against that verification work.
  for _ in {1..1200}; do
    [[ -f "$FAKE_STATE/broker-waiting" ]] && break
    kill -0 "$command_pid" 2>/dev/null || { cat "$HARNESS_ROOT/customer-backup-running.log" >&2; exit 1; }
    sleep 0.05
  done
  [[ -f "$FAKE_STATE/broker-waiting" ]] || {
    cat "$HARNESS_ROOT/customer-backup-running.log" >&2
    printf 'Customer backup did not reach the broker hold within 60 seconds.\n' >&2
    exit 1
  }
  printf 'Backup command fixture: broker hold reached; checking lock contention.\n'
  second_log="$(customer_command 1)"
  if ! grep -Fq 'Another install, resume, setup-token, backup, or upgrade command holds the deployment lock' "$second_log"; then
    cat "$second_log" >&2
    printf 'Concurrent customer backup did not report the held deployment lock.\n' >&2
    exit 1
  fi
  installer_log="$(run_installer 1 status)"
  if ! grep -Fq 'Another install, resume, setup-token, backup, or upgrade command holds the deployment lock' "$installer_log"; then
    cat "$installer_log" >&2
    printf 'Installer status did not report the held deployment lock.\n' >&2
    exit 1
  fi
  printf 'Backup command fixture: backup and installer lock contention passed; releasing broker hold.\n'
  rm -f "$FAKE_STATE/broker-hold"
  if wait "$command_pid"; then echo 'The fixture broker unexpectedly passed its unavailable-network check.' >&2; exit 1; fi
  if ! grep -Fq 'The fixed private network is unavailable' "$HARNESS_ROOT/customer-backup-running.log"; then
    cat "$HARNESS_ROOT/customer-backup-running.log" >&2
    printf 'Held customer backup did not reach the expected unavailable-network failure.\n' >&2
    exit 1
  fi
  printf 'Backup command fixture: held backup exited fail-closed after the network check.\n'

  # Exercise the installed customer entrypoint and the real signed host
  # broker protocol. The isolated fake Docker helper only supplies bounded
  # report payloads; it never provides a live database or external service.
  plan_set='99999999-9999-4999-8999-999999999999'
  plan_command() {
    printf '%s\n' "$plan_set" > "$FAKE_STATE/restore-plan-set"
    printf '%s\n' "$1" > "$FAKE_STATE/restore-plan-mode"
    : > "$FAKE_STATE/restore-plan-enabled"
    "$TARGET_DIR/aikayun" backup restore-plan "$plan_set"
  }
  snapshot_drill_state() {
    find "$TARGET_DIR/secrets" "$FAKE_STATE/identity" "$FAKE_STATE/volumes" /var/lib/aikayun-backup/repository \
      /var/lib/aikayun-backup/publications -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
  }
  before_plan_snapshot="$(snapshot_drill_state)"
  for plan_case in verified after-transaction pending-operation authorization-unknown target-clone \
      database-unavailable schema-mismatch identity-mismatch historical-key-invalid snapshot-corrupt; do
    plan_output="$(plan_command "$plan_case")"
    plan_json="$(printf '%s\n' "$plan_output" | sed -n '/^{"operation":"restore-plan"/p')"
    [[ -n "$plan_json" ]] || { printf 'restore-plan scenario %s omitted machine report.\n' "$plan_case" >&2; exit 1; }
    printf 'Customer command: sudo /opt/aikayun/aikayun backup restore-plan %s scenario=%s exit=0 report=%s\n' \
      "$plan_set" "$plan_case" "$plan_json"
    printf '%s\n' "$plan_output" | CASE="$plan_case" node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const l=d.split("\n").find(x=>x.startsWith("{")); const r=JSON.parse(l); if(r.readiness!=="blocked"||r.automaticRestore!=="blocked"||r.target!=="unknown"||r.businessAfterBackup!=="unknown"||r.pendingExternalOperations!=="unknown"||r.authorization!=="unknown"||r.disk!=="unknown"||r.externalReconciliation!=="required")process.exit(1); if(process.env.CASE==="verified" && (r.backup!=="verified"||r.technicalChecks!=="passed"))process.exit(1); if(process.env.CASE==="database-unavailable" && (r.backup!=="blocked"||r.blockingReason!=="database-unavailable"))process.exit(1); if(["schema-mismatch","identity-mismatch"].includes(process.env.CASE) && r.blockingReason!=="identity-or-schema-mismatch")process.exit(1); if(["historical-key-invalid","snapshot-corrupt"].includes(process.env.CASE) && r.blockingReason!=="backup-check-failed")process.exit(1); if(["after-transaction","pending-operation"].includes(process.env.CASE) && r.backup!=="verified")process.exit(1); if(process.env.CASE==="target-clone" && r.target!=="unknown")process.exit(1);})'
    [[ "$(snapshot_drill_state)" == "$before_plan_snapshot" ]]
    ! grep -Eq '^(compose_down:|docker_stop:|service_stop:|volume_create:|compose_up:|docker_pull)' "$EVENT_LOG"
  done
  printf '%s\n' "$plan_set" > "$FAKE_STATE/restore-plan-set"
  printf '%s\n' interrupt > "$FAKE_STATE/restore-plan-mode"
  if "$TARGET_DIR/aikayun" backup restore-plan "$plan_set" > "$HARNESS_ROOT/restore-plan-interrupt.log" 2>&1; then
    printf 'Interrupted restore-plan fixture unexpectedly returned success.\n' >&2; exit 1
  else
    plan_interrupt_status=$?
  fi
  ! grep -Fq '"operation":"restore-plan"' "$HARNESS_ROOT/restore-plan-interrupt.log"
  printf 'Customer command interruption scenario=%s exit=%s report=none\n' interrupt "$plan_interrupt_status"

  touch "$FAKE_STATE/restore-plan-helper-hold"
  printf '%s\n' "$plan_set" > "$FAKE_STATE/restore-plan-set"
  printf '%s\n' lockhold > "$FAKE_STATE/restore-plan-mode"
  "$TARGET_DIR/aikayun" backup restore-plan "$plan_set" > "$HARNESS_ROOT/restore-plan-held.log" 2>&1 &
  plan_pid=$!
  for _ in {1..1200}; do
    [[ -f "$FAKE_STATE/restore-plan-helper-waiting" ]] && break
    kill -0 "$plan_pid" 2>/dev/null || { cat "$HARNESS_ROOT/restore-plan-held.log" >&2; exit 1; }
    sleep 0.05
  done
  [[ -f "$FAKE_STATE/restore-plan-helper-waiting" ]] || { printf 'restore-plan helper did not reach its hold.\n' >&2; exit 1; }
  if competing="$("$TARGET_DIR/aikayun" backup restore-plan "$plan_set" 2>&1)"; then
    printf 'Concurrent restore-plan unexpectedly bypassed the shared lock.\n' >&2; exit 1
  else
    plan_competing_status=$?
  fi
  grep -Fq 'Another install, resume, setup-token, backup, or upgrade command holds the deployment lock' <<< "$competing"
  installer_competing="$(run_installer 1 status)"
  grep -Fq 'Another install, resume, setup-token, backup, or upgrade command holds the deployment lock' "$installer_competing"
  if create_competing="$("$TARGET_DIR/aikayun" backup create 2>&1)"; then
    printf 'Concurrent backup create unexpectedly bypassed the shared lock.\n' >&2; exit 1
  else
    create_competing_status=$?
  fi
  grep -Fq 'Another install, resume, setup-token, backup, or upgrade command holds the deployment lock' <<< "$create_competing"
  rm -f "$FAKE_STATE/restore-plan-helper-hold"
  wait "$plan_pid"
  after_plan_snapshot="$(snapshot_drill_state)"
  [[ "$after_plan_snapshot" == "$before_plan_snapshot" ]]
  printf 'Customer concurrent restore-plan exit=%s; backup create exit=%s; helper completed blocked report after lock release. Fixture file snapshot unchanged.\n' \
    "$plan_competing_status" "$create_competing_status"
  printf 'Restore-plan fixture source file snapshot SHA-256: before=%s after=%s; no Docker stop/create/pull/Compose mutation event observed.\n' \
    "$before_plan_snapshot" "$after_plan_snapshot"

  printf 'Signed customer launcher ran restore-plan in isolated blocked/unknown scenarios; malformed/unauthorized restoration states stayed blocked, interrupted execution failed closed, and concurrent backup/installer commands observed the shared lock. Fixture source material stayed unchanged.\n'
  exit 0
fi

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
