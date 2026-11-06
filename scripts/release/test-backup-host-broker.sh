#!/usr/bin/env bash
set -Eeuo pipefail
set +x
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
source "$root/scripts/release/backup-host-broker.sh"
declare -F backup_assert_held_lock >/dev/null

# The production target is Linux (GNU stat); translate only the format used by
# the pinned-release check so this shell regression also runs on macOS hosts.
stat() {
  if [[ "${1:-}" == -c && "${2:-}" == '%u:%g:%a:%h' ]]; then
    local mode_links
    mode_links="$(command stat -f '%Lp:%l' "${3:?}")" || return
    printf '0:0:%s\n' "$mode_links"
  else
    command stat "$@"
  fi
}

SELECTED_API_IMAGE='ghcr.io/yykx682436/aikayun-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
SELECTED_WEB_IMAGE='ghcr.io/yykx682436/aikayun-web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
SELECTED_POSTGRES_IMAGE='docker.io/library/postgres@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
SELECTED_CADDY_IMAGE='docker.io/library/caddy@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
SELECTED_BACKUP_RESTIC_IMAGE='ghcr.io/yykx682436/aikayun-backup-restic@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
managed_id=1111111111111111111111111111111111111111111111111111111111111111
restic_id=2222222222222222222222222222222222222222222222222222222222222222
set_id=33333333-3333-4333-8333-333333333333
operation_id=44444444-4444-4444-8444-444444444444

backup_managed_container() { [[ "$#" == 1 && "$1" =~ ^[a-f0-9]{64}$ && "$1" == "$managed_id" ]]; }
backup_managed_db() { backup_managed_container "$@"; }
backup_restic_owned() { [[ "$#" == 1 && "$1" == "$restic_id" ]]; }

expect_ok() { "$@" || { printf 'Expected request to be allowed: %s\n' "$*" >&2; exit 1; }; }
expect_rejected() { if "$@" 2>/dev/null; then printf 'Expected request to be rejected: %s\n' "$*" >&2; exit 1; fi; }

# The installed launcher authenticates the release before the broker is
# sourced. Pin once, then require every RPC check to see the same exact bytes.
pin_root="$(mktemp -d)"
trap 'rm -rf -- "$pin_root"' EXIT
TARGET_DIR="$pin_root/opt/aikayun"
RELEASE_DIR="$TARGET_DIR/release"
STATE_FILE="$TARGET_DIR/install-state.json"
mkdir -p "$RELEASE_DIR"
printf '%s\n' signed-manifest > "$RELEASE_DIR/release-manifest.json"
printf '%s\n' signed-launcher > "$TARGET_DIR/aikayun"
printf '%s\n' signed-broker > "$RELEASE_DIR/backup-host-broker.sh"
printf '%s\n' signed-state > "$STATE_FILE"
chmod 0644 "$RELEASE_DIR/release-manifest.json" "$RELEASE_DIR/backup-host-broker.sh"
chmod 0555 "$TARGET_DIR/aikayun"
chmod 0600 "$STATE_FILE"
MANIFEST_SHA256="$(backup_hash_file "$RELEASE_DIR/release-manifest.json")"
backup_pin_release_identity
expect_ok backup_verify_pinned_release "$MANIFEST_SHA256"
printf '%s\n' changed > "$RELEASE_DIR/backup-host-broker.sh"
expect_rejected backup_verify_pinned_release "$MANIFEST_SHA256"
printf '%s\n' signed-broker > "$RELEASE_DIR/backup-host-broker.sh"
expect_ok backup_verify_pinned_release "$MANIFEST_SHA256"
expect_rejected backup_verify_pinned_release "$(printf '0%.0s' {1..64})"

restic_command_prefix=(--repo /repo --password-file /run/password --no-cache --quiet)
expect_ok backup_validate_restic_command "${restic_command_prefix[@]}" init --repository-version 2
expect_ok backup_validate_restic_command "${restic_command_prefix[@]}" cat config
expect_ok backup_validate_restic_command "${restic_command_prefix[@]}" check --read-data
expect_ok backup_validate_restic_command "${restic_command_prefix[@]}" snapshots --json
expect_ok backup_validate_restic_command "${restic_command_prefix[@]}" snapshots --json --tag "aikayun-set-$set_id"
expect_ok backup_validate_restic_command "${restic_command_prefix[@]}" ls --json "$(printf 'a%.0s' {1..64})" /sources/state
expect_ok backup_validate_restic_command "${restic_command_prefix[@]}" ls --json --recursive "$(printf 'a%.0s' {1..64})" /sources/state
expect_ok backup_validate_restic_command "${restic_command_prefix[@]}" ls --json "$(printf 'a%.0s' {1..64})" /sources/state/license-pending/license-pending-aes-256-gcm.json
expect_ok backup_validate_restic_command "${restic_command_prefix[@]}" dump "$(printf 'a%.0s' {1..64})" /sources/state/identity/current/identity.json
expect_rejected backup_validate_restic_command "${restic_command_prefix[@]}" ls --json "$(printf 'a%.0s' {1..64})" /sources/state/private/customer.bin
expect_rejected backup_validate_restic_command "${restic_command_prefix[@]}" dump "$(printf 'a%.0s' {1..64})" /sources/state/../../etc/passwd
BACKUP_ACTIVE_SET_ID="$set_id"
expect_ok backup_validate_restic_command "${restic_command_prefix[@]}" backup --json --tag "aikayun-set-$set_id" \
  --tag aikayun-role-manifest -- "/var/lib/aikayun-backup/staging/set-$set_id/manifest"
expect_rejected backup_validate_restic_command "${restic_command_prefix[@]}" backup --json --tag "aikayun-set-44444444-4444-4444-8444-444444444444" \
  --tag aikayun-role-manifest -- "/var/lib/aikayun-backup/staging/set-44444444-4444-4444-8444-444444444444/manifest"
expect_rejected backup_validate_restic_command "${restic_command_prefix[@]}" backup /untrusted/path

expect_ok backup_validate_docker_args stop --time 30 "$managed_id"
expect_ok backup_validate_docker_args start "$managed_id"
expect_rejected backup_validate_docker_args stop --time 30 "$restic_id"
expect_rejected backup_validate_docker_args start "$restic_id"
expect_ok backup_validate_docker_args ps -a --quiet --no-trunc --filter label=com.aikayun.backup.restic-command=yes
expect_ok backup_validate_docker_args volume inspect aikayun_state
expect_ok backup_validate_docker_args volume inspect 1111111111111111111111111111111111111111111111111111111111111111
expect_rejected backup_validate_docker_args volume inspect untrusted-volume-name
binding_query="SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE pid = 123 AND datname = 'aikayun' AND usename = 'aikayun_bootstrap' AND application_name = 'aikayun_backup_proof_0123456789abcdef0123456789abcdef'"
stream_query_args=(exec "$managed_id" psql -X --no-password --host=/var/run/postgresql --username=aikayun_bootstrap \
  --dbname=aikayun -v ON_ERROR_STOP=1 -Atc "$binding_query")
expect_ok backup_validate_stream_docker_args "${stream_query_args[@]}"
expect_ok backup_validate_docker_args exec "$managed_id" psql -X --no-password --host=/var/run/postgresql \
  --username=aikayun_bootstrap --dbname=aikayun -v ON_ERROR_STOP=1 -Atc "$binding_query"
expect_ok backup_validate_docker_args exec -i --env PGAPPNAME=aikayun_backup_0123456789abcdef0123456789abcdef "$managed_id" \
  pg_dump --format=custom --no-password --host=/var/run/postgresql --port=5432 --username=aikayun_bootstrap --dbname=aikayun
stop_query="SELECT CASE WHEN count(*) > 0 AND bool_and(pg_terminate_backend(pid, 5000)) THEN 'terminated' ELSE 'unknown' END FROM pg_stat_activity WHERE application_name = 'aikayun_backup_0123456789abcdef0123456789abcdef' AND pid <> pg_backend_pid()"
expect_rejected backup_validate_stream_docker_args exec -i --env PGAPPNAME=aikayun_backup_0123456789abcdef0123456789abcdef "$managed_id" \
  psql -X -v ON_ERROR_STOP=1 -At --no-password --host=/var/run/postgresql --port=5432 \
  --username=aikayun_bootstrap --dbname=postgres -c "$stop_query"
expect_ok backup_validate_docker_args exec -i --env PGAPPNAME=aikayun_backup_0123456789abcdef0123456789abcdef "$managed_id" \
  psql -X -v ON_ERROR_STOP=1 -At --no-password --host=/var/run/postgresql --port=5432 \
  --username=aikayun_bootstrap --dbname=postgres -c "$stop_query"
expect_rejected backup_validate_docker_args exec --env PGAPPNAME=unexpected "$managed_id" psql
expect_rejected backup_validate_docker_args exec "$managed_id" psql -X -c 'DROP TABLE public.orders'

tab=$'\t'
format='{{json .Id}}'"$tab"'{{json .Config.Image}}'"$tab"'{{json (index .Config.Labels "com.docker.compose.project")}}'"$tab"'{{json (index .Config.Labels "com.docker.compose.service")}}'"$tab"'{{json .State.Running}}'"$tab"'{{json .State.StartedAt}}'"$tab"'{{json .Mounts}}'
expect_ok backup_validate_docker_args inspect --type container --format "$format" "$managed_id"
expect_rejected backup_validate_docker_args inspect --type container --format '{{json .Config.Env}}' "$managed_id"
expect_rejected backup_validate_docker_args inspect --type container "$managed_id"
expect_ok backup_validate_docker_args inspect --type container "$restic_id"
expect_ok backup_validate_docker_args inspect --type container --format '{{json .Id}}'"$tab"'{{json (index .Config.Labels "com.docker.compose.project")}}'"$tab"'{{json (index .Config.Labels "com.docker.compose.service")}}'"$tab"'{{json .Config.Image}}' "$managed_id"
expect_ok backup_validate_docker_args inspect --type container --format '{{json .Id}}'"$tab"'{{json .Config.Image}}'"$tab"'{{json (index .Config.Labels "com.docker.compose.project")}}'"$tab"'{{json (index .Config.Labels "com.docker.compose.service")}}'"$tab"'{{json .State.Running}}'"$tab"'{{json .State.StartedAt}}'"$tab"'{{json .Mounts}}' "$managed_id"
expect_ok backup_validate_docker_args inspect --type container --format '{{json .Id}}'"$tab"'{{json (index .Config.Labels "com.docker.compose.project")}}'"$tab"'{{json (index .Config.Labels "com.docker.compose.service")}}'"$tab"'{{json .State.Status}}'"$tab"'{{json .State.Running}}'"$tab"'{{json .State.Paused}}'"$tab"'{{json .State.Restarting}}'"$tab"'{{json .Mounts}}' "$managed_id"

cmd_mounts=(--mount 'type=bind,source=/var/lib/aikayun-backup/repository,target=/repo'
  --mount 'type=bind,source=/etc/aikayun-backup/restic-password,target=/run/password,readonly')
cmd_create=(create --pull=never --name "aikayun-restic-cmd-$operation_id"
  --label com.aikayun.backup.restic-command=yes --label "com.aikayun.backup.restic-operation=$operation_id"
  --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --cap-drop ALL --cap-add DAC_READ_SEARCH
  --security-opt no-new-privileges:true --user 0:0 "${cmd_mounts[@]}" --entrypoint /usr/bin/restic
  "$SELECTED_BACKUP_RESTIC_IMAGE" --repo /repo --password-file /run/password --no-cache --quiet init --repository-version 2)
expect_ok backup_validate_docker_args "${cmd_create[@]}"
manifest_source="/var/lib/aikayun-backup/staging/set-$set_id/manifest"
manifest_mount="type=bind,source=$manifest_source,target=$manifest_source,readonly"
manifest_create=(create --pull=never --name "aikayun-restic-cmd-$operation_id"
  --label com.aikayun.backup.restic-command=yes --label "com.aikayun.backup.restic-operation=$operation_id"
  --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --cap-drop ALL --cap-add DAC_READ_SEARCH
  --security-opt no-new-privileges:true --user 0:0 "${cmd_mounts[@]}" --mount "$manifest_mount"
  --entrypoint /usr/bin/restic "$SELECTED_BACKUP_RESTIC_IMAGE" "${restic_command_prefix[@]}" backup --json \
  --tag "aikayun-set-$set_id" --tag aikayun-role-manifest -- "$manifest_source")
expect_ok backup_validate_docker_args "${manifest_create[@]}"
wrong_manifest_mount="type=bind,source=/var/lib/aikayun-backup/staging/set-44444444-4444-4444-8444-444444444444/manifest,target=/var/lib/aikayun-backup/staging/set-44444444-4444-4444-8444-444444444444/manifest,readonly"
bad_manifest_create=("${manifest_create[@]}")
for ((index=0; index<${#bad_manifest_create[@]}; index++)); do
  if [[ "${bad_manifest_create[index]}" == "$manifest_mount" ]]; then bad_manifest_create[index]="$wrong_manifest_mount"; break; fi
done
expect_rejected backup_validate_docker_args "${bad_manifest_create[@]}"
(
  IFS=$'\t'
  expect_ok backup_validate_docker_args "${cmd_create[@]}"
  expect_ok backup_validate_docker_args exec "$managed_id" psql -X --no-password --host=/var/run/postgresql \
    --username=aikayun_bootstrap --dbname=aikayun -v ON_ERROR_STOP=1 -Atc "$binding_query"
)

reader_mounts=(--mount 'type=volume,source=aikayun_state,target=/sources/state,readonly'
  --mount 'type=volume,source=aikayun_caddy_data,target=/sources/caddy-data,readonly'
  --mount 'type=volume,source=aikayun_caddy_config,target=/sources/caddy-config,readonly'
  --mount "type=bind,source=/var/lib/aikayun-backup/staging/set-$set_id,target=/sources/staging,readonly"
  --mount 'type=bind,source=/opt/aikayun,target=/sources/deployment,readonly'
  --mount 'type=bind,source=/var/lib/aikayun-backup/repository,target=/repo'
  --mount 'type=bind,source=/etc/aikayun-backup/restic-password,target=/run/password,readonly')
reader_create=(create --pull=never --name "aikayun-restic-read-$operation_id"
  --label "com.aikayun.backup.restic-set=$set_id" --network none --read-only
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --cap-drop ALL --cap-add DAC_READ_SEARCH
  --security-opt no-new-privileges:true --user 0:0 "${reader_mounts[@]}" --entrypoint /usr/bin/restic
  "$SELECTED_BACKUP_RESTIC_IMAGE" --repo /repo --password-file /run/password --no-cache --quiet backup --json -- /sources/state)
expect_ok backup_validate_docker_args "${reader_create[@]}"
unsafe_reader_create=("${reader_create[@]}")
for ((index=0; index<${#unsafe_reader_create[@]}; index++)); do
  if [[ "${unsafe_reader_create[index]}" == 'type=bind,source=/var/lib/aikayun-backup/repository,target=/repo' ]]; then
    unsafe_reader_create[index]='type=bind,source=/run/docker.sock,target=/repo'
    break
  fi
done
expect_rejected backup_validate_docker_args "${unsafe_reader_create[@]}"
bad_image_create=("${cmd_create[@]}")
for ((index=0; index<${#bad_image_create[@]}; index++)); do
  if [[ "${bad_image_create[index]}" == "$SELECTED_BACKUP_RESTIC_IMAGE" ]]; then
    bad_image_create[index]='/untrusted/image:latest'
    break
  fi
done
expect_rejected backup_validate_docker_args "${bad_image_create[@]}"

format='{{json .Id}}'"$tab"'{{json (index .Config.Labels "com.docker.compose.project")}}'"$tab"'{{json (index .Config.Labels "com.docker.compose.service")}}'"$tab"'{{json .State.Status}}'"$tab"'{{json .State.Running}}'"$tab"'{{json .State.Paused}}'"$tab"'{{json .State.Restarting}}'"$tab"'{{json .Mounts}}'
expect_ok backup_validate_docker_args inspect --type container --format "$format" "$managed_id"
expect_ok backup_validate_docker_args inspect --type container "$restic_id"

# A PostgreSQL dump lock heartbeat can arrive while Restic is streaming. The
# broker must answer that bounded RPC without cancelling or consuming the
# active stream response.
stream_size=1201694
stream_expected="$(head -c "$stream_size" /dev/zero | command base64 | tr -d '\n')"
stream_result="$(mktemp)"
backup_stream_helper_test() {
  local line seen_lock=0 seen_query=0 seen_end=0 argument stream_data=''
  IFS= read -r -t 3 line || exit 1
  [[ "$line" == $'RES\t71\tSTREAM' ]] || exit 1
  printf 'REQ\t72\tassert-lock\n'
  printf 'REQ\t73\tdocker-exec\t%s' "$(printf '%s' 60000 | command base64 | tr -d '\n')"
  for argument in "${stream_query_args[@]}"; do printf '\t%s' "$(printf '%s' "$argument" | command base64 | tr -d '\n')"; done
  printf '\n'
  while IFS= read -r -t 3 line; do
    case "$line" in
      $'RES\t72\tOK\t') seen_lock=1 ;;
      $'RES\t73\tOK\tMQ==') seen_query=1 ;;
      $'RES\t71\tDATA\t'*) stream_data+="${line#*$'DATA\t'}" ;;
      $'RES\t71\tEND\t0') seen_end=1; break ;;
      $'RES\t71\tEND\t'*) exit 1 ;;
    esac
  done
  ((seen_lock == 1 && seen_query == 1 && seen_end == 1)) && [[ "$stream_data" == "$stream_expected" ]] || exit 1
  printf 'passed\n' > "$stream_result"
}
coproc BACKUP_STREAM_HELPER { backup_stream_helper_test; }
BACKUP_HELPER_IN="${BACKUP_STREAM_HELPER[1]}"
BACKUP_HELPER_OUT="${BACKUP_STREAM_HELPER[0]}"
backup_stream_helper_pid="$BACKUP_STREAM_HELPER_PID"
BACKUP_DOCKER_ENDPOINT='unix:///isolated-test.sock'
backup_assert_held_lock() { return 0; }
backup_docker_quick() {
  local IFS=' '
  local -a args=("$@")
  [[ "${args[*]}" == "${stream_query_args[*]}" ]] || return 1
  printf '1'
}
timeout() {
  while [[ "${1:-}" == --* ]]; do shift; done
  shift
  "$@"
}
env() {
  [[ "${1:-}" == -i ]] || return 1
  shift
  while [[ "${1:-}" == *=* ]]; do shift; done
  "$@"
}
base64() {
  if [[ "${1:-}" == -w ]]; then shift 2; command base64 | tr -d '\n' | fold -w 65536; printf '\n'
  elif [[ "${1:-}" == -w0 ]]; then shift; local encoded; encoded="$(command base64 | tr -d '\n')"; printf '%s' "$encoded"
  elif [[ "${1:-}" == -d ]]; then shift; command openssl base64 -d -A
  else command base64 "$@"; fi
}
docker() {
  [[ "${1:-}" == --host && "${2:-}" == "$BACKUP_DOCKER_ENDPOINT" && "${3:-}" == start &&
    "${4:-}" == --attach && "${5:-}" == "$restic_id" && $# == 5 ]] || return 1
  sleep 1
  head -c "$stream_size" /dev/zero
}
mktemp() {
  if [[ "${1:-}" == -d && "${2:-}" == /run/aikayun-backup-stream.XXXXXX ]]; then
    command mktemp -d "$pin_root/aikayun-backup-stream.XXXXXX"
  else
    command mktemp "$@"
  fi
}
backup_rpc_stream 71 '' start --attach "$restic_id"
wait "$backup_stream_helper_pid"
[[ "$(cat "$stream_result")" == passed ]]
rm -f -- "$stream_result"

printf '%s\n' 'Host broker Docker allowlist, inspect projections, fixed Restic mounts, and negative cases passed.'
