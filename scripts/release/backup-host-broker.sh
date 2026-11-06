# Sourced only after the running /opt/aikayun/aikayun script and this signed
# broker have been verified. Host Docker/Compose access stays in this process.

backup_stream_cleanup() {
  if [[ -n "${backup_stream_pid:-}" ]]; then
    kill -TERM "$backup_stream_pid" 2>/dev/null || true
    wait "$backup_stream_pid" 2>/dev/null || true
  fi
  if [[ -n "${backup_stream_encoder_pid:-}" ]]; then
    kill -TERM "$backup_stream_encoder_pid" 2>/dev/null || true
    wait "$backup_stream_encoder_pid" 2>/dev/null || true
  fi
  if [[ "${backup_stream_directory:-}" =~ ^/run/aikayun-backup-stream\.[A-Za-z0-9]{6}$ && -d "$backup_stream_directory" && ! -L "$backup_stream_directory" ]]; then
    rm -rf -- "$backup_stream_directory"
  fi
  backup_stream_pid=''
  backup_stream_encoder_pid=''
  backup_stream_directory=''
}

backup_docker_endpoint() {
  local context endpoint
  if [[ -n "${DOCKER_HOST:-}" ]]; then endpoint="$DOCKER_HOST"
  else
    context="${DOCKER_CONTEXT:-$(timeout --foreground --signal=TERM --kill-after=2s 15s docker context show 2>/dev/null)}"
    [[ -n "$context" ]] || return 1
    endpoint="$(timeout --foreground --signal=TERM --kill-after=2s 15s docker context inspect "$context" --format '{{ (index .Endpoints "docker").Host }}' 2>/dev/null)" || return 1
  fi
  [[ "$endpoint" == unix:///* && -S "${endpoint#unix://}" ]] || return 1
  BACKUP_DOCKER_ENDPOINT="$endpoint"
}

backup_docker() {
  env -i PATH=/usr/bin:/bin HOME=/var/empty LANG=C docker --host "$BACKUP_DOCKER_ENDPOINT" "$@"
}

backup_docker_quick() {
  timeout --foreground --signal=TERM --kill-after=2s 15s env -i PATH=/usr/bin:/bin HOME=/var/empty LANG=C \
    docker --host "$BACKUP_DOCKER_ENDPOINT" "$@"
}

backup_assert_held_lock() {
  [[ -e /proc/$$/fd/9 && -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] || return 1
  [[ "$(stat -Lc '%d:%i:%u:%g:%a:%h' "$LOCK_FILE")" == "$(stat -Lc '%d:%i:%u:%g:%a:%h' "/proc/$$/fd/9")" ]] || return 1
  [[ "$(stat -Lc '%u:%g:%a:%h' "$LOCK_FILE")" == '0:0:600:1' ]] || return 1
  if flock -n "$LOCK_FILE" -c true >/dev/null 2>&1; then return 1; fi
}

backup_hash_file() {
  local line
  line="$(sha256sum "$1")" || return 1
  printf '%s' "${line%% *}"
}

# The launcher has already authenticated Cosign, JWS and every artifact before
# sourcing this broker. Pin the live execution artifacts once; subsequent RPCs
# check those exact bytes without rerunning the full artifact walk hundreds of
# times during one backup.
backup_pin_release_identity() {
  BACKUP_PIN_MANIFEST_SHA256="$(backup_hash_file "$RELEASE_DIR/release-manifest.json")" || return 1
  [[ "$BACKUP_PIN_MANIFEST_SHA256" == "$MANIFEST_SHA256" ]] || return 1
  BACKUP_PIN_STATE_SHA256="$(backup_hash_file "$STATE_FILE")" || return 1
  BACKUP_PIN_LAUNCHER_SHA256="$(backup_hash_file "$TARGET_DIR/aikayun")" || return 1
  BACKUP_PIN_BROKER_SHA256="$(backup_hash_file "$RELEASE_DIR/backup-host-broker.sh")" || return 1
}

backup_verify_pinned_release() {
  local expected="$1"
  [[ "$expected" == "$BACKUP_PIN_MANIFEST_SHA256" && "$expected" == "$MANIFEST_SHA256" ]] || return 1
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" && "$(stat -c '%u:%g:%a:%h' "$STATE_FILE")" == '0:0:600:1' &&
     "$(backup_hash_file "$STATE_FILE")" == "$BACKUP_PIN_STATE_SHA256" ]] || return 1
  [[ -f "$RELEASE_DIR/release-manifest.json" && ! -L "$RELEASE_DIR/release-manifest.json" &&
     "$(stat -c '%u:%g:%a:%h' "$RELEASE_DIR/release-manifest.json")" == '0:0:644:1' &&
     "$(backup_hash_file "$RELEASE_DIR/release-manifest.json")" == "$BACKUP_PIN_MANIFEST_SHA256" ]] || return 1
  [[ -f "$TARGET_DIR/aikayun" && ! -L "$TARGET_DIR/aikayun" &&
     "$(stat -c '%u:%g:%a:%h' "$TARGET_DIR/aikayun")" == '0:0:555:1' &&
     "$(backup_hash_file "$TARGET_DIR/aikayun")" == "$BACKUP_PIN_LAUNCHER_SHA256" ]] || return 1
  [[ -f "$RELEASE_DIR/backup-host-broker.sh" && ! -L "$RELEASE_DIR/backup-host-broker.sh" &&
     "$(stat -c '%u:%g:%a:%h' "$RELEASE_DIR/backup-host-broker.sh")" == '0:0:644:1' &&
     "$(backup_hash_file "$RELEASE_DIR/backup-host-broker.sh")" == "$BACKUP_PIN_BROKER_SHA256" ]] || return 1
}

backup_decode() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9+/]*={0,2}$ ]] || return 1
  base64 -d <<< "$value" 2>/dev/null
}

backup_managed_db() {
  local id="$1" project service image
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
  project="$(backup_docker_quick inspect --type container --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$id" 2>/dev/null)" || return 1
  service="$(backup_docker_quick inspect --type container --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$id" 2>/dev/null)" || return 1
  image="$(backup_docker_quick inspect --type container --format '{{ .Config.Image }}' "$id" 2>/dev/null)" || return 1
  [[ "$project" == aikayun && "$service" == db && "$image" == "$SELECTED_POSTGRES_IMAGE" ]]
}

backup_managed_container() {
  local id="$1" project service image expected
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
  project="$(backup_docker_quick inspect --type container --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$id" 2>/dev/null)" || return 1
  service="$(backup_docker_quick inspect --type container --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$id" 2>/dev/null)" || return 1
  image="$(backup_docker_quick inspect --type container --format '{{ .Config.Image }}' "$id" 2>/dev/null)" || return 1
  [[ "$project" == aikayun ]] || return 1
  case "$service" in
    api|production-install-init|migrate) expected="$SELECTED_API_IMAGE" ;;
    web) expected="$SELECTED_WEB_IMAGE" ;;
    caddy) expected="$SELECTED_CADDY_IMAGE" ;;
    db|db-role-init|state-volume-init) expected="$SELECTED_POSTGRES_IMAGE" ;;
    *) return 1 ;;
  esac
  [[ "$image" == "$expected" ]]
}

backup_safe_restic_mount() {
  case "$1" in
    'type=bind,source=/var/lib/aikayun-backup/repository,target=/repo') return 0 ;;
    'type=bind,source=/etc/aikayun-backup/restic-password,target=/run/password,readonly') return 0 ;;
    'type=volume,source=aikayun_state,target=/sources/state,readonly') return 0 ;;
    'type=volume,source=aikayun_caddy_data,target=/sources/caddy-data,readonly') return 0 ;;
    'type=volume,source=aikayun_caddy_config,target=/sources/caddy-config,readonly') return 0 ;;
    'type=bind,source=/opt/aikayun,target=/sources/deployment,readonly') return 0 ;;
    type=bind,source=/var/lib/aikayun-backup/staging/set-*/manifest,target=/var/lib/aikayun-backup/staging/set-*/manifest,readonly)
      [[ "${BACKUP_ACTIVE_SET_ID:-}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
         "$1" == "type=bind,source=/var/lib/aikayun-backup/staging/set-$BACKUP_ACTIVE_SET_ID/manifest,target=/var/lib/aikayun-backup/staging/set-$BACKUP_ACTIVE_SET_ID/manifest,readonly" ]] ;;
    type=bind,source=/var/lib/aikayun-backup/staging/set-*,target=/sources/staging,readonly)
      [[ "$1" =~ ^type=bind,source=/var/lib/aikayun-backup/staging/set-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12},target=/sources/staging,readonly$ ]] ;;
    *) return 1 ;;
  esac
}

backup_safe_restic_snapshot_path() {
  case "$1" in
    /sources/state|/sources/state/identity|/sources/state/identity/current|/sources/state/license-pending|/sources/state/license-trust) return 0 ;;
    /sources/state/.aikayun-volume-v1|/sources/state/identity/current/identity.json|\
    /sources/state/identity/current/identity-intent.json|/sources/state/identity/current/instance-private-key.pk8.pem|\
    /sources/state/license-pending/license-pending-aes-256-gcm.json|/sources/state/license-trust/trust-bundle-state.json|\
    /sources/state/license-trust/trust-bundle-store.marker.json|/sources/deployment/secrets/payment_credential_key_ring|\
    /sources/deployment/secrets/code_pool_encryption_key_ring|/sources/staging/payload/database.dump) return 0 ;;
    /var/lib/aikayun-backup/staging/set-*/manifest/manifest.json)
      [[ "$1" =~ ^/var/lib/aikayun-backup/staging/set-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/manifest/manifest\.json$ ]] ;;
    *) return 1 ;;
  esac
}

backup_restic_owned() {
  local id="$1" reader_label command_label set_label
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
  reader_label="$(backup_docker_quick inspect --type container --format '{{ index .Config.Labels "com.aikayun.backup.restic" }}' "$id" 2>/dev/null)" || return 1
  set_label="$(backup_docker_quick inspect --type container --format '{{ index .Config.Labels "com.aikayun.backup.restic-set" }}' "$id" 2>/dev/null)" || return 1
  command_label="$(backup_docker_quick inspect --type container --format '{{ index .Config.Labels "com.aikayun.backup.restic-command" }}' "$id" 2>/dev/null)" || return 1
  [[ "$reader_label" == yes || "$set_label" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ || "$command_label" == yes ]]
}

backup_inspect_format_allowed() {
  local separator=$'\t'
  case "$1" in
    "{{json .Id}}${separator}{{json (index .Config.Labels \"com.docker.compose.project\")}}${separator}{{json (index .Config.Labels \"com.docker.compose.service\")}}${separator}{{json .Config.Image}}") return 0 ;;
    "{{json .Id}}${separator}{{json .Config.Image}}${separator}{{json (index .Config.Labels \"com.docker.compose.project\")}}${separator}{{json (index .Config.Labels \"com.docker.compose.service\")}}${separator}{{json .State.Running}}${separator}{{json .State.StartedAt}}${separator}{{json .Mounts}}") return 0 ;;
    "{{json .Id}}${separator}{{json (index .Config.Labels \"com.docker.compose.project\")}}${separator}{{json (index .Config.Labels \"com.docker.compose.service\")}}${separator}{{json .State.Status}}${separator}{{json .State.Running}}${separator}{{json .State.Paused}}${separator}{{json .State.Restarting}}${separator}{{json .Mounts}}") return 0 ;;
    "{{json .Id}}${separator}{{json .Image}}${separator}{{json .Config.Image}}${separator}{{json .Config.User}}${separator}{{json .Config.Labels}}${separator}{{json .Path}}${separator}{{json .Args}}${separator}{{json .State.Status}}${separator}{{json .HostConfig.NetworkMode}}${separator}{{json .HostConfig.ReadonlyRootfs}}${separator}{{json .HostConfig.CapDrop}}${separator}{{json .HostConfig.CapAdd}}${separator}{{json .HostConfig.SecurityOpt}}${separator}{{json .HostConfig.Tmpfs}}${separator}{{json .HostConfig.RestartPolicy.Name}}${separator}{{json .HostConfig.AutoRemove}}${separator}{{json .HostConfig.Privileged}}${separator}{{json .HostConfig.PidMode}}${separator}{{json .HostConfig.IpcMode}}${separator}{{json .HostConfig.Devices}}${separator}{{json .HostConfig.Binds}}${separator}{{json .HostConfig.VolumesFrom}}${separator}{{json .Mounts}}") return 0 ;;
    *) return 1 ;;
  esac
}

backup_validate_restic_command() {
  local IFS=' ' snapshot path set_tag set_id source_path
  local -a command=("$@") tail=()
  ((${#command[@]} >= 8)) || return 1
  [[ "${command[*]:0:6}" == '--repo /repo --password-file /run/password --no-cache --quiet' ]] || return 1
  tail=("${command[@]:6}")
  case "${tail[0]:-}" in
    init) [[ "${tail[*]}" == 'init --repository-version 2' && ${#tail[@]} == 3 ]] ;;
    cat) [[ "${tail[*]}" == 'cat config' && ${#tail[@]} == 2 ]] ;;
    check) [[ "${tail[*]}" == 'check --read-data' && ${#tail[@]} == 2 ]] ;;
    snapshots)
      if [[ "${tail[*]}" == 'snapshots --json' && ${#tail[@]} == 2 ]]; then return 0; fi
      ((${#tail[@]} == 4)) && [[ "${tail[1]}" == --json && "${tail[2]}" == --tag &&
        "${tail[3]}" =~ ^aikayun-set-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ;;
    backup)
      ((${#tail[@]} == 8)) && [[ "${tail[1]}" == --json && "${tail[2]}" == --tag &&
        "${tail[3]}" =~ ^aikayun-set-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
        "${tail[4]}" == --tag && "${tail[5]}" == aikayun-role-manifest && "${tail[6]}" == -- ]] || return 1
      set_tag="${tail[3]}"; set_id="${set_tag#aikayun-set-}"
      source_path="/var/lib/aikayun-backup/staging/set-$set_id/manifest"
      [[ "${BACKUP_ACTIVE_SET_ID:-}" == "$set_id" && "${tail[7]}" == "$source_path" ]] ;;
    ls)
      if ((${#tail[@]} == 4)) && [[ "${tail[1]}" == --json ]]; then
        snapshot="${tail[2]}"; path="${tail[3]}"
      elif ((${#tail[@]} == 5)) && [[ "${tail[1]}" == --json && "${tail[2]}" == --recursive ]]; then
        snapshot="${tail[3]}"; path="${tail[4]}"
      else return 1; fi
      [[ "$snapshot" =~ ^[a-f0-9]{64}$ ]] && backup_safe_restic_snapshot_path "$path" || return 1
      if [[ "${tail[2]:-}" == --recursive ]]; then [[ "$path" == /sources/state ]] || return 1; fi ;;
    dump)
      ((${#tail[@]} == 3)) || return 1
      snapshot="${tail[1]}"; path="${tail[2]}"
      [[ "$snapshot" =~ ^[a-f0-9]{64}$ ]] && backup_safe_restic_snapshot_path "$path" ;;
    *) return 1 ;;
  esac
}

backup_validate_stream_docker_args() {
  local IFS=' '
  local -a args=("$@")
  backup_validate_docker_args "${args[@]}" || return 1
  case "${args[0]:-}" in
    ps|inspect|volume|image) return 0 ;;
    exec)
      [[ ${#args[@]} == 12 && "${args[2]}" == psql &&
        "${args[11]}" =~ ^SELECT\ count\(\*\)\ FROM\ pg_catalog\.pg_stat_activity\ WHERE\ pid\ =\ [1-9][0-9]{0,8}\ AND\ datname\ =\ \'aikayun\'\ AND\ usename\ =\ \'aikayun_bootstrap\'\ AND\ application_name\ =\ \'aikayun_backup_proof_[a-f0-9]{32}\'$ ]] ;;
    *) return 1 ;;
  esac
}

backup_validate_docker_args() {
  # The RPC loop parses tab-separated fields with a dynamically scoped IFS.
  # Docker argv joins below must always use ordinary spaces.
  local IFS=' '
  local -a args=("$@")
  local name='' value='' count=0 image='' entry='' network=0 read_only=0 cap_drop=0 cap_add=0 security=0 user=0 tmpfs=0
  local command_label='' set_label='' operation_label='' manifest_source='' ps_shape=invalid ps_filter=unknown i
  local -a restic_command=()
  local -a mounts=()
  case "${args[0]:-}" in
    ps)
      if [[ "${args[1]:-}" == -a && "${args[2]:-}" == --quiet && "${args[3]:-}" == --no-trunc ]]; then ps_shape=short
      elif [[ "${args[1]:-}" == --all && "${args[2]:-}" == --quiet && "${args[3]:-}" == --no-trunc ]]; then ps_shape=long; fi
      case "${args[5]:-}" in
        label=com.docker.compose.project=aikayun) ps_filter=project ;;
        label=com.aikayun.backup.archive) ps_filter=archive ;;
        label=com.aikayun.backup.restic-command=yes) ps_filter=restic-command ;;
        label=com.aikayun.backup.restic=yes) ps_filter=restic ;;
        label=com.aikayun.backup.restic-set=*) ps_filter=restic-set ;;
        volume=aikayun_state|volume=aikayun_caddy_data|volume=aikayun_caddy_config) ps_filter=volume ;;
      esac
      if [[ "$ps_shape" != invalid && "${args[4]:-}" == --filter && "$ps_filter" != unknown ]] && ((${#args[@]} == 6)); then return 0; fi
      printf 'Backup host rejected Docker ps shape: count=%s flags=%s filter=%s\n' "${#args[@]}" "$ps_shape" "$ps_filter" >&2
      return 1 ;;
    stop)
      [[ "${args[1]:-}" == '--time' && "${args[2]:-}" == 30 && ${#args[@]} == 4 ]] && backup_managed_container "${args[3]}" ;;
    start)
      if [[ "${args[1]:-}" == '--attach' && ${#args[@]} == 3 ]]; then backup_restic_owned "${args[2]}"
      elif ((${#args[@]} == 2)); then backup_managed_container "${args[1]}"; else return 1; fi ;;
    rm)
      [[ ${#args[@]} == 2 ]] && backup_restic_owned "${args[1]}" ;;
    volume)
      [[ "${args[1]:-}" == inspect && ${#args[@]} == 3 &&
         ( "${args[2]}" =~ ^(aikayun_state|aikayun_caddy_data|aikayun_caddy_config)$ || "${args[2]}" =~ ^[a-f0-9]{64}$ ) ]] ;;
    image)
      [[ "${args[1]:-}" == inspect && ${#args[@]} == 3 && "${args[2]}" == "$SELECTED_BACKUP_RESTIC_IMAGE" ]] ;;
    inspect)
      if [[ "${args[1]:-}" == '--type' && "${args[2]:-}" == container && "${args[3]:-}" == '--format' ]]; then
        ((${#args[@]} >= 6 && ${#args[@]} <= 37)) || return 1
        backup_inspect_format_allowed "${args[4]}" || return 1
        if ((${#args[@]} == 6)) && backup_restic_owned "${args[5]}"; then return 0; fi
        local inspect_id
        for inspect_id in "${args[@]:5}"; do backup_managed_container "$inspect_id" || return 1; done
      elif [[ "${args[1]:-}" == '--type' && "${args[2]:-}" == container && ${#args[@]} == 4 ]]; then
        backup_restic_owned "${args[3]}"
      else return 1; fi ;;
    exec)
      local id command position=1 command_line
      local -a command_args=()
      if [[ "${args[position]:-}" == -i ]]; then ((position+=1)); fi
      if [[ "${args[position]:-}" == --env ]]; then
        [[ "${args[1]:-}" == -i ]] || return 1
        ((position+1 < ${#args[@]})) || return 1
        [[ "${args[position+1]}" =~ ^PGAPPNAME=aikayun_backup_[a-f0-9]{32}$ ]] || return 1
        ((position+=2))
      fi
      id="${args[position]:-}"
      backup_managed_db "$id" || return 1
      command="${args[position+1]:-}"
      command_args=("${args[@]:position+2}")
      command_line="${command_args[*]}"
      case "$command" in
        psql)
          [[ "$command_line" =~ ^-X\ --no-password\ --host=/var/run/postgresql\ --username=aikayun_bootstrap\ --dbname=aikayun\ -v\ ON_ERROR_STOP=1\ -Atc\ SELECT\ count\(\*\)\ FROM\ pg_catalog\.pg_stat_activity\ WHERE\ pid\ =\ [1-9][0-9]{0,8}\ AND\ datname\ =\ \'aikayun\'\ AND\ usename\ =\ \'aikayun_bootstrap\'\ AND\ application_name\ =\ \'aikayun_backup_proof_[a-f0-9]{32}\'$ ]] || \
          [[ "$command_line" =~ ^-X\ -v\ ON_ERROR_STOP=1\ -At\ --no-password\ --host=/var/run/postgresql\ --port=5432\ --username=aikayun_bootstrap\ --dbname=postgres\ -c\ SELECT\ CASE\ WHEN\ count\(\*\)\ \>\ 0\ AND\ bool_and\(pg_terminate_backend\(pid,\ 5000\)\)\ THEN\ \'terminated\'\ ELSE\ \'unknown\'\ END\ FROM\ pg_stat_activity\ WHERE\ application_name\ =\ \'aikayun_backup_[a-f0-9]{32}\'\ AND\ pid\ \<\>\ pg_backend_pid\(\)$ ]] || return 1 ;;
        pg_dump)
          [[ "$command_line" == '--version' || "$command_line" == '--format=custom --no-password --host=/var/run/postgresql --port=5432 --username=aikayun_bootstrap --dbname=aikayun' ]] || return 1 ;;
        pg_restore)
          [[ "$command_line" == '--version' || "$command_line" == '--exit-on-error --file=/dev/null' ||
             "$command_line" == '--data-only --exit-on-error --table installation_binding --file=-' ||
             "$command_line" == '--data-only --exit-on-error --table kysely_migration --file=-' ]] || return 1 ;;
        *) return 1 ;;
      esac
      ((${#args[@]} <= 24)) ;;
    create)
      [[ "${args[1]:-}" == '--pull=never' ]] || return 1
      for ((i=2; i<${#args[@]}; i++)); do
        case "${args[i]}" in
          --name) ((i+1<${#args[@]})) || return 1; name="${args[++i]}" ;;
          --label)
            ((i+1<${#args[@]})) || return 1
            value="${args[++i]}"
            case "$value" in
              com.aikayun.backup.restic-command=yes) [[ -z "$command_label" ]] || return 1; command_label=yes ;;
              com.aikayun.backup.restic-set=*) [[ -z "$set_label" && "${value#*=}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || return 1; set_label="${value#*=}" ;;
              com.aikayun.backup.restic-operation=*) [[ -z "$operation_label" && "${value#*=}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || return 1; operation_label="${value#*=}" ;;
              *) return 1 ;;
            esac ;;
          --network) ((i+1<${#args[@]})) || return 1; [[ "${args[++i]}" == none ]] || return 1; network=1 ;;
          --read-only) read_only=1 ;;
          --tmpfs) ((i+1<${#args[@]})) || return 1; value="${args[++i]}"; [[ "$value" == /tmp:rw,noexec,nosuid,nodev,size=64m ]] || return 1; tmpfs=1 ;;
          --cap-drop) ((i+1<${#args[@]})) || return 1; [[ "${args[++i]}" == ALL ]] || return 1; cap_drop=1 ;;
          --cap-add) ((i+1<${#args[@]})) || return 1; [[ "${args[++i]}" == DAC_READ_SEARCH ]] || return 1; cap_add=1 ;;
          --security-opt) ((i+1<${#args[@]})) || return 1; [[ "${args[++i]}" == no-new-privileges:true ]] || return 1; security=1 ;;
          --user) ((i+1<${#args[@]})) || return 1; [[ "${args[++i]}" == 0:0 ]] || return 1; user=1 ;;
          --mount)
            ((i+1<${#args[@]})) || return 1
            value="${args[++i]}"
            backup_safe_restic_mount "$value" || return 1
            mounts+=("$value")
            ((count+=1)) ;;
          --entrypoint) ((i+1<${#args[@]})) || return 1; entry="${args[++i]}" ;;
          --privileged|--pid|--ipc|--device|--volumes-from) return 1 ;;
          *) image="${args[i]}"; restic_command=("${args[@]:i+1}"); break ;;
        esac
      done
      [[ -n "$name" ]] || { printf 'Backup host rejected Restic container name.\n' >&2; return 1; }
      [[ "$image" == "$SELECTED_BACKUP_RESTIC_IMAGE" ]] || { printf 'Backup host rejected Restic image identity.\n' >&2; return 1; }
      [[ "$entry" == /usr/bin/restic ]] || { printf 'Backup host rejected Restic entrypoint.\n' >&2; return 1; }
      ((network == 1)) || { printf 'Backup host rejected Restic network profile.\n' >&2; return 1; }
      ((read_only == 1 && cap_drop == 1 && cap_add == 1 && security == 1 && user == 1 && tmpfs == 1)) || {
        printf 'Backup host rejected Restic security profile.\n' >&2; return 1;
      }
      if [[ "$command_label" == yes ]]; then
        if [[ -n "$set_label" || ! "$operation_label" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ||
              "$name" != "aikayun-restic-cmd-$operation_label" ]]; then
          printf 'Backup host rejected Restic command identity.\n' >&2
          return 1
        fi
        if [[ "${restic_command[6]:-}" == backup ]]; then
          if [[ ! "${BACKUP_ACTIVE_SET_ID:-}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
            printf 'Backup host rejected inactive manifest staging.\n' >&2
            return 1
          fi
          manifest_source="/var/lib/aikayun-backup/staging/set-$BACKUP_ACTIVE_SET_ID/manifest"
          if ((count != 3)); then
            printf 'Backup host rejected Restic manifest mount count.\n' >&2
            return 1
          fi
        elif ((count != 2)); then
          printf 'Backup host rejected Restic command mount count.\n' >&2
          return 1
        fi
        if ! backup_validate_restic_command "${restic_command[@]}"; then
          printf 'Backup host rejected Restic command allowlist.\n' >&2
          return 1
        fi
        if [[ " ${mounts[*]} " != *' type=bind,source=/var/lib/aikayun-backup/repository,target=/repo '* ||
              " ${mounts[*]} " != *' type=bind,source=/etc/aikayun-backup/restic-password,target=/run/password,readonly '* ]]; then
          printf 'Backup host rejected Restic command mounts.\n' >&2
          return 1
        fi
        if [[ -n "$manifest_source" && " ${mounts[*]} " != *" type=bind,source=$manifest_source,target=$manifest_source,readonly "* ]]; then
          printf 'Backup host rejected Restic manifest mount.\n' >&2
          return 1
        fi
      else
        [[ -z "$operation_label" && "$set_label" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
           "$name" =~ ^aikayun-restic-read-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ && $count == 7 ]] || return 1
        for value in 'type=bind,source=/var/lib/aikayun-backup/repository,target=/repo' \
          'type=bind,source=/etc/aikayun-backup/restic-password,target=/run/password,readonly' \
          'type=volume,source=aikayun_state,target=/sources/state,readonly' \
          'type=volume,source=aikayun_caddy_data,target=/sources/caddy-data,readonly' \
          'type=volume,source=aikayun_caddy_config,target=/sources/caddy-config,readonly' \
          'type=bind,source=/opt/aikayun,target=/sources/deployment,readonly'; do
          [[ " ${mounts[*]} " == *" $value "* ]] || return 1
        done
        local stage_mounts=0
        for value in "${mounts[@]}"; do [[ "$value" != *target=/sources/staging* ]] || ((stage_mounts+=1)); done
        ((stage_mounts == 1)) || return 1
        [[ " ${mounts[*]} " == *" type=bind,source=/var/lib/aikayun-backup/staging/set-$set_label,target=/sources/staging,readonly "* ]] || return 1
      fi
      [[ " ${args[*]} " == *' --repo /repo --password-file /run/password --no-cache '* ]] || return 1
      [[ " ${args[*]} " == *' backup '* || " ${args[*]} " == *' snapshots '* || " ${args[*]} " == *' check '* ||
         " ${args[*]} " == *' init '* || " ${args[*]} " == *' cat '* || " ${args[*]} " == *' ls '* ||
         " ${args[*]} " == *' dump '* || " ${args[*]} " == *' restore '* ]] || return 1 ;;
    *) return 1 ;;
  esac
}

backup_rpc_reply() {
  if [[ "$2" == ERR && "$3" =~ ^[A-Z0-9_]{1,80}$ ]]; then
    printf 'Backup helper request failed: %s\n' "$3" >&2
  fi
  printf 'RES\t%s\t%s\t%s\n' "$1" "$2" "$3" >&"$BACKUP_HELPER_IN"
}

backup_safe_docker_summary() {
  local value summary=''
  for value in "$@"; do
    case "$value" in
      create|ps|--pull=never|--name|--label|--network|none|--read-only|--tmpfs|--cap-drop|ALL|--cap-add|DAC_READ_SEARCH|--security-opt|no-new-privileges:true|--user|0:0|--mount|--entrypoint|/usr/bin/restic|--repo|/repo|--password-file|/run/password|--no-cache|--quiet|init|--repository-version|2|--filter|--all|-a|--no-trunc) summary+="$value " ;;
      /tmp:rw,noexec,nosuid,nodev,size=64m) summary+='<tmpfs> ' ;;
      type=bind,source=/var/lib/aikayun-backup/repository,target=/repo) summary+='<repository-mount> ' ;;
      type=bind,source=/etc/aikayun-backup/restic-password,target=/run/password,readonly) summary+='<password-mount> ' ;;
      com.aikayun.backup.restic-command=yes) summary+='<restic-command-label> ' ;;
      com.aikayun.backup.restic-operation=*) summary+='<restic-operation-label> ' ;;
      com.aikayun.backup.restic-set=*) summary+='<restic-set-label> ' ;;
      aikayun-restic-cmd-*) summary+='<restic-command-name> ' ;;
      "$SELECTED_BACKUP_RESTIC_IMAGE") summary+='<signed-restic-image> ' ;;
      "$SELECTED_API_IMAGE") summary+='<signed-api-image> ' ;;
      "$SELECTED_WEB_IMAGE") summary+='<signed-web-image> ' ;;
      "$SELECTED_POSTGRES_IMAGE") summary+='<signed-postgres-image> ' ;;
      "$SELECTED_CADDY_IMAGE") summary+='<signed-caddy-image> ' ;;
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f]*) summary+='<uuid> ' ;;
      --[A-Za-z0-9-]*) summary+='<long-option> ' ;;
      [A-Za-z][A-Za-z0-9_-]*) summary+='<word> ' ;;
      [0-9]*) summary+='<number> ' ;;
      *) summary+='<other> ' ;;
    esac
  done
  printf '%s' "$summary"
}

backup_rpc_execute() {
  local id="$1" action="$2"; shift 2
  local -a args=()
  local field output
  for field in "$@"; do args+=("$(backup_decode "$field")") || { backup_rpc_reply "$id" ERR BACKUP_HOST_PROTOCOL_INVALID; return; }; done
  case "$action" in
    assert-lock)
      (($# == 0)) && backup_assert_held_lock || { backup_rpc_reply "$id" ERR BACKUP_LOCK_LOST; return; }
      backup_rpc_reply "$id" OK '' ;;
    verify-deployment)
      (($# == 1)) && [[ "${args[0]}" =~ ^[a-f0-9]{64}$ ]] && backup_assert_held_lock || { backup_rpc_reply "$id" ERR BACKUP_DEPLOYMENT_UNVERIFIED; return; }
      backup_verify_pinned_release "${args[0]}" || { backup_rpc_reply "$id" ERR BACKUP_DEPLOYMENT_CHANGED; return; }
      backup_rpc_reply "$id" OK '' ;;
    client-event)
      (($# == 3)) && [[ "${args[0]}" == create && "${args[1]}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ && "${args[2]}" == started ]] || { backup_rpc_reply "$id" ERR BACKUP_CLIENT_EVENT_INVALID; return; }
      BACKUP_ACTIVE_SET_ID="${args[1]}"
      printf 'Backup set %s started.\n' "${args[1]}"
      backup_rpc_reply "$id" OK '' ;;
    client-result)
      (($# == 1)) || { backup_rpc_reply "$id" ERR BACKUP_CLIENT_RESULT_INVALID; return; }
      output="${args[0]}"
      if [[ "$output" =~ ^\{"operation":"create","backupSetId":"([0-9a-f-]{36})","status":"verified"\}$ ]]; then
        printf 'Backup verified: %s\n' "${BASH_REMATCH[1]}"
        [[ -z "${BACKUP_ACTIVE_SET_ID:-}" || "${BASH_REMATCH[1]}" == "$BACKUP_ACTIVE_SET_ID" ]] || { backup_rpc_reply "$id" ERR BACKUP_CLIENT_RESULT_MISMATCH; return; }
        BACKUP_ACTIVE_SET_ID=''
      else
        printf 'Backup operation completed. %s\n' "$output"
      fi
      backup_rpc_reply "$id" OK '' ;;
    docker-exec)
      local timeout_ms timeout_seconds command_status
      (($# >= 1)) && [[ "${args[0]}" =~ ^[1-9][0-9]{0,7}$ ]] || { backup_rpc_reply "$id" ERR BACKUP_DOCKER_REQUEST_REJECTED; return; }
      timeout_ms="${args[0]}"
      ((timeout_ms <= 21600000)) || { backup_rpc_reply "$id" ERR BACKUP_DOCKER_REQUEST_REJECTED; return; }
      timeout_seconds=$(( (timeout_ms + 999) / 1000 ))
      args=("${args[@]:1}")
      backup_validate_docker_args "${args[@]}" || {
        printf 'Backup host rejected Docker operation: %s %s\n' "${args[0]:-unknown}" "$(backup_safe_docker_summary "${args[@]}")" >&2
        if [[ "${args[0]:-}" == inspect && "${args[1]:-}" == --type && "${args[2]:-}" == container &&
              "${args[3]:-}" == --format && -n "${args[4]:-}" ]]; then
          local projection_hash
          projection_hash="$(printf '%s' "${args[4]}" | sha256sum)"
          projection_hash="${projection_hash%% *}"
          printf 'Backup host rejected Docker inspect projection: length=%s sha256=%s\n' "${#args[4]}" "$projection_hash" >&2
        fi
        backup_rpc_reply "$id" ERR BACKUP_DOCKER_REQUEST_REJECTED
        return
      }
      set +e
      output="$(timeout --foreground --signal=TERM --kill-after=2s "${timeout_seconds}s" env -i PATH=/usr/bin:/bin HOME=/var/empty LANG=C \
        docker --host "$BACKUP_DOCKER_ENDPOINT" "${args[@]}" 2>/dev/null | head -c 1048577)"
      command_status=$?
      set -e
      if (( ${#output} > 1024 * 1024 )); then
        backup_rpc_reply "$id" ERR BACKUP_DOCKER_OUTPUT_LIMIT
      elif ((command_status == 0)); then
        backup_rpc_reply "$id" OK "$(printf '%s' "$output" | base64 -w0)"
      else backup_rpc_reply "$id" ERR BACKUP_DOCKER_COMMAND_FAILED; fi ;;
    docker-stream|docker-stream-file)
      local input_path=''
      if [[ "$action" == docker-stream-file ]]; then
        (($# >= 2)) || { backup_rpc_reply "$id" ERR BACKUP_DOCKER_REQUEST_REJECTED; return; }
        input_path="${args[0]}"; args=("${args[@]:1}")
        [[ "${BACKUP_ACTIVE_SET_ID:-}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ && \
           "$input_path" == "/var/lib/aikayun-backup/staging/set-$BACKUP_ACTIVE_SET_ID/payload/database.dump" && \
           -f "$input_path" && ! -L "$input_path" && "$(realpath -e "$input_path")" == "$input_path" && \
           "$(stat -c '%u:%g:%a:%h' "$input_path")" == '0:0:600:1' ]] || { backup_rpc_reply "$id" ERR BACKUP_DUMP_PATH_REJECTED; return; }
      fi
      backup_validate_docker_args "${args[@]}" || {
        printf 'Backup host rejected Docker operation: %s %s\n' "${args[0]:-unknown}" "$(backup_safe_docker_summary "${args[@]}")" >&2
        backup_rpc_reply "$id" ERR BACKUP_DOCKER_REQUEST_REJECTED
        return
      }
      backup_rpc_stream "$id" "$input_path" "${args[@]}" ;;
    *) backup_rpc_reply "$id" ERR BACKUP_HOST_ACTION_REJECTED ;;
  esac
}

backup_rpc_stream() {
  local id="$1" input_path="$2"; shift 2
  local rc=0 encoded='' fragment='' read_status failure_code='' wait_status
  local stream_directory stream_fifo raw_fifo stream_fd docker_status encoder_status
  stream_directory="$(mktemp -d /run/aikayun-backup-stream.XXXXXX)" || { backup_rpc_reply "$id" ERR BACKUP_STREAM_UNAVAILABLE; return; }
  chmod 0700 "$stream_directory"
  stream_fifo="$stream_directory/data"
  raw_fifo="$stream_directory/raw"
  mkfifo -m 0600 "$stream_fifo" "$raw_fifo" || { rmdir "$stream_directory"; backup_rpc_reply "$id" ERR BACKUP_STREAM_UNAVAILABLE; return; }
  backup_stream_directory="$stream_directory"
  backup_stream_pid=''
  backup_stream_encoder_pid=''
  backup_stream_input_partial=''
  base64 -w 65536 < "$raw_fifo" > "$stream_fifo" &
  backup_stream_encoder_pid=$!
  if [[ -n "$input_path" ]]; then
    timeout --foreground --signal=TERM --kill-after=2s 6h env -i PATH=/usr/bin:/bin HOME=/var/empty LANG=C \
      docker --host "$BACKUP_DOCKER_ENDPOINT" "$@" < "$input_path" > "$raw_fifo" 2>/dev/null &
  else
    timeout --foreground --signal=TERM --kill-after=2s 6h env -i PATH=/usr/bin:/bin HOME=/var/empty LANG=C \
      docker --host "$BACKUP_DOCKER_ENDPOINT" "$@" > "$raw_fifo" 2>/dev/null &
  fi
  backup_stream_pid=$!
  exec {stream_fd}< "$stream_fifo"
  printf 'RES\t%s\tSTREAM\n' "$id" >&"$BACKUP_HELPER_IN" || { rc=125; failure_code=BACKUP_STREAM_CHANNEL_WRITE_FAILED; }
  while ((rc == 0)); do
    backup_assert_held_lock || { rc=125; failure_code=BACKUP_STREAM_LOCK_LOST; break; }
    fragment=''
    if IFS= read -r -t 0.15 -u "$stream_fd" fragment; then
      encoded="${backup_stream_output_partial:-}${fragment}"
      backup_stream_output_partial=''
      printf 'RES\t%s\tDATA\t%s\n' "$id" "$encoded" >&"$BACKUP_HELPER_IN" || { rc=125; failure_code=BACKUP_STREAM_CHANNEL_WRITE_FAILED; break; }
    else
      read_status=$?
      backup_stream_output_partial="${backup_stream_output_partial:-}${fragment}"
      if ((read_status == 1)); then
        [[ -z "$backup_stream_output_partial" ]] || { rc=125; failure_code=BACKUP_STREAM_OUTPUT_INVALID; break; }
        break
      fi
    fi

    fragment=''
    if IFS= read -r -t 0.001 -u "$BACKUP_HELPER_OUT" fragment; then
      backup_stream_input_partial="${backup_stream_input_partial}${fragment}"
      local IFS=$'\t'; local -a incoming=(); read -r -a incoming <<< "$backup_stream_input_partial"
      backup_stream_input_partial=''
      if [[ "${incoming[0]:-}" == CANCEL && "${incoming[1]:-}" == "$id" && ${#incoming[@]} -le 3 &&
            ( ${#incoming[@]} == 2 || "${incoming[2]}" =~ ^(SIGINT|SIGTERM|SIGKILL)$ ) ]]; then
        kill -TERM "$backup_stream_pid" 2>/dev/null || true
        kill -TERM "$backup_stream_encoder_pid" 2>/dev/null || true
        rc=130
        failure_code=BACKUP_STREAM_CANCELLED
        break
      elif [[ "${incoming[0]:-}" == REQ && "${incoming[1]:-}" =~ ^[1-9][0-9]{0,8}$ ]]; then
        case "${incoming[2]:-}" in
          assert-lock)
            if ((${#incoming[@]} == 3)) && backup_assert_held_lock; then
              backup_rpc_reply "${incoming[1]}" OK ''
            else
              backup_rpc_reply "${incoming[1]}" ERR BACKUP_LOCK_LOST
              rc=125
              failure_code=BACKUP_STREAM_LOCK_LOST
              break
            fi ;;
          verify-deployment)
            local expected_manifest=''
            if ((${#incoming[@]} == 4)) && expected_manifest="$(backup_decode "${incoming[3]}")" &&
                [[ "$expected_manifest" =~ ^[a-f0-9]{64}$ ]] && backup_assert_held_lock &&
                backup_verify_pinned_release "$expected_manifest"; then
              backup_rpc_reply "${incoming[1]}" OK ''
            else
              backup_rpc_reply "${incoming[1]}" ERR BACKUP_DEPLOYMENT_UNVERIFIED
              rc=125
              failure_code=BACKUP_STREAM_DEPLOYMENT_UNVERIFIED
              break
            fi ;;
          docker-exec)
            local -a stream_docker_args=()
            local stream_timeout output field
            for field in "${incoming[@]:3}"; do
              stream_docker_args+=("$(backup_decode "$field")") || { rc=125; failure_code=BACKUP_STREAM_PROTOCOL_INVALID; break; }
            done
            if ((rc != 0)) || (("${#stream_docker_args[@]}" < 2)) ||
                [[ ! "${stream_docker_args[0]}" =~ ^[1-9][0-9]{0,7}$ ]]; then
              backup_rpc_reply "${incoming[1]}" ERR BACKUP_DOCKER_REQUEST_REJECTED
              rc=125
              failure_code=BACKUP_STREAM_DOCKER_REQUEST_REJECTED
              break
            fi
            stream_timeout="${stream_docker_args[0]}"
            if ((stream_timeout > 60000)) || ! backup_validate_stream_docker_args "${stream_docker_args[@]:1}"; then
              backup_rpc_reply "${incoming[1]}" ERR BACKUP_DOCKER_REQUEST_REJECTED
              rc=125
              failure_code=BACKUP_STREAM_DOCKER_REQUEST_REJECTED
              break
            fi
            if ! output="$(backup_docker_quick "${stream_docker_args[@]:1}" 2>/dev/null)"; then
              backup_rpc_reply "${incoming[1]}" ERR BACKUP_DOCKER_COMMAND_FAILED
              rc=125
              failure_code=BACKUP_STREAM_DOCKER_CHECK_FAILED
              break
            fi
            if (( ${#output} > 1024 * 1024 )); then
              backup_rpc_reply "${incoming[1]}" ERR BACKUP_DOCKER_OUTPUT_LIMIT
              rc=125
              failure_code=BACKUP_STREAM_DOCKER_OUTPUT_LIMIT
              break
            fi
            backup_rpc_reply "${incoming[1]}" OK "$(printf '%s' "$output" | base64 -w0)" ;;
          *)
            backup_rpc_reply "${incoming[1]}" ERR BACKUP_HOST_ACTION_REJECTED
            rc=125
            failure_code=BACKUP_STREAM_ACTION_REJECTED
            break ;;
        esac
      else
        rc=125
        failure_code=BACKUP_STREAM_PROTOCOL_INVALID
        break
      fi
    else
      read_status=$?
      backup_stream_input_partial="${backup_stream_input_partial}${fragment}"
      if ((read_status == 1)); then rc=125; failure_code=BACKUP_STREAM_HELPER_CHANNEL_CLOSED; break; fi
    fi
  done
  if ((rc != 0)); then
    kill -TERM "$backup_stream_pid" 2>/dev/null || true
    kill -TERM "$backup_stream_encoder_pid" 2>/dev/null || true
  fi
  if wait "$backup_stream_pid"; then docker_status=0; else docker_status=$?; fi
  if wait "$backup_stream_encoder_pid"; then encoder_status=0; else encoder_status=$?; fi
  if ((rc == 0 && docker_status != 0)); then rc="$docker_status"; failure_code=BACKUP_STREAM_DOCKER_EXIT_FAILED; fi
  if ((rc == 0 && encoder_status != 0)); then rc="$encoder_status"; failure_code=BACKUP_STREAM_ENCODER_EXIT_FAILED; fi
  exec {stream_fd}<&- || true
  printf 'RES\t%s\tEND\t%s\n' "$id" "$rc" >&"$BACKUP_HELPER_IN" || true
  if [[ -n "$failure_code" ]]; then printf 'Backup stream ended: %s\n' "$failure_code" >&2; fi
  backup_stream_pid=''
  backup_stream_encoder_pid=''
  rm -f -- "$stream_fifo" "$raw_fifo"
  rmdir -- "$stream_directory"
  backup_stream_directory=''
}

run_backup_host_broker() {
  local operation="$1"; shift
  local backup_root=/var/lib/aikayun-backup credential_root=/etc/aikayun-backup
  [[ "$operation" =~ ^(create|list|verify|initialize-repository|recover-maintenance)$ ]] || fail 'Unsupported backup command.'
  backup_docker_endpoint || fail 'A local Unix-socket Docker Engine is required for backup.'
  local network_identity
  network_identity="$(backup_docker_quick network inspect aikayun_private --format '{{index .Labels "com.docker.compose.project"}} {{index .Labels "com.docker.compose.network"}} {{.Name}} {{.Scope}}' 2>/dev/null)" || fail 'The fixed private network is unavailable.'
  [[ "$network_identity" == 'aikayun private aikayun_private local' ]] || fail 'The private network identity is unsafe.'
  [[ -d "$backup_root" && ! -L "$backup_root" && "$(stat -c '%u:%g:%a' "$backup_root")" == '0:0:700' ]] || fail 'Fixed backup storage is missing or unsafe.'
  for path in "$backup_root/repository" "$backup_root/journal" "$backup_root/publications" "$backup_root/staging"; do
    [[ -d "$path" && ! -L "$path" && "$(stat -c '%u:%g:%a' "$path")" == '0:0:700' ]] || fail 'A fixed backup directory is missing or unsafe.'
  done
  [[ -d "$credential_root" && ! -L "$credential_root" && "$(stat -c '%u:%g:%a' "$credential_root")" == '0:0:700' && \
     -f "$credential_root/restic-password" && ! -L "$credential_root/restic-password" && \
     "$(stat -c '%u:%g:%a:%h' "$credential_root/restic-password")" == '0:0:600:1' ]] || fail 'The separate backup password is missing or unsafe.'
  backup_assert_held_lock || fail 'The deployment operation lock is no longer held.'
  backup_pin_release_identity || fail 'The verified host backup release changed before helper startup.'
  local run_id
  run_id="$(cat /proc/sys/kernel/random/uuid)"
  [[ "$run_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail 'Could not create an operation identifier.'
  coproc AIKAYUN_BACKUP_HELPER { backup_docker run --rm --interactive --pull=never --name "aikayun-backup-helper-$run_id" \
    --label "com.aikayun.backup.operation=$run_id" --network aikayun_private --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
    --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges:true --user 0:0 \
    --mount "type=bind,source=$TARGET_DIR,target=$TARGET_DIR,readonly" \
    --mount "type=bind,source=$backup_root,target=$backup_root" \
    --mount "type=bind,source=$credential_root,target=$credential_root,readonly" \
    --env NODE_ENV=production --env AIKAYUN_BACKUP_HOST_BROKER=stdio-v1 \
    --entrypoint /nodejs/bin/node "$SELECTED_API_IMAGE" /app/dist/backup/helper-cli.js "$operation" "$@"; }
  local helper_pid="$AIKAYUN_BACKUP_HELPER_PID" helper_out="${AIKAYUN_BACKUP_HELPER[0]}" helper_in="${AIKAYUN_BACKUP_HELPER[1]}"
  BACKUP_HELPER_IN="$helper_in"
  local status=0 line read_status
  BACKUP_HELPER_OUT="$helper_out"
  backup_stream_directory=''
  backup_stream_pid=''
  backup_stream_encoder_pid=''
  backup_stream_output_partial=''
  backup_stream_input_partial=''
  BACKUP_ACTIVE_SET_ID=''
  while true; do
    line=''
    if IFS= read -r -t 1 -u "$helper_out" line; then
      :
    else
      read_status=$?
      if ((read_status == 1)); then break; fi
      backup_assert_held_lock || { status=1; break; }
      continue
    fi
    [[ "$line" == REQ$'\t'* ]] || { status=1; break; }
    local IFS=$'\t'; local -a fields=(); read -r -a fields <<< "$line"
    ((${#fields[@]} >= 3)) && [[ "${fields[1]}" =~ ^[1-9][0-9]{0,8}$ ]] || { status=1; break; }
    backup_assert_held_lock || { printf 'RES\t%s\tERR\tBACKUP_LOCK_LOST\n' "${fields[1]}" >&"$helper_in"; status=1; break; }
    backup_rpc_execute "${fields[1]}" "${fields[2]}" "${fields[@]:3}" || { status=1; break; }
  done
  BACKUP_HELPER_OUT=''
  [[ -z "$backup_stream_directory" ]] || rm -rf -- "$backup_stream_directory"
  if ! wait "$helper_pid"; then status=1; fi
  exec {helper_out}<&- || true
  exec {helper_in}>&- || true
  ((status == 0)) || fail 'The backup helper did not complete with a verified result; inspect the maintenance journal before retrying.'
  backup_assert_held_lock || fail 'The deployment operation lock was lost during backup.'
}
