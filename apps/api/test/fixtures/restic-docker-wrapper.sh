#!/bin/bash
set -Eeuo pipefail
set +x
umask 077
config="$(dirname "$0")/restic-wrapper.conf"
[[ -f "$config" && ! -L "$config" ]] || exit 60
exec 9< "$config"
IFS= read -r docker_binary <&9
IFS= read -r docker_socket <&9
IFS= read -r image <&9
IFS= read -r work <&9
IFS= read -r owner <&9
IFS= read -r group <&9
IFS= read -r project <&9 || true
IFS= read -r manifest_root <&9 || true
exec 9<&-
printf '%s\n' config-read > "$work/wrapper-stage"
[[ -x "$docker_binary" ]] || { printf '%s\n' docker-binary-invalid > "$work/wrapper-stage"; exit 60; }
[[ -S "$docker_socket" ]] || { printf '%s\n' docker-socket-invalid > "$work/wrapper-stage"; exit 60; }
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || { printf '%s\n' image-invalid > "$work/wrapper-stage"; exit 60; }
[[ "$owner" =~ ^[0-9]+$ ]] || { printf '%s\n' owner-invalid > "$work/wrapper-stage"; exit 60; }
[[ "$group" =~ ^[0-9]+$ ]] || { printf '%s\n' group-invalid > "$work/wrapper-stage"; exit 60; }
[[ "$project" =~ ^aikayun-75a-test-[a-f0-9]{24}$ && "$manifest_root" == /* ]] || exit 60
if [[ "$#" -lt 7 || "$1" != --repo || "$3" != --password-file || "$4" != /dev/fd/3 ]]; then
  printf '%s\n' arguments-invalid > "$work/wrapper-stage"
  exit 61
fi
repo="$2"
password="$work/password.$$"
cat /dev/fd/3 > "$password" || { printf '%s\n' password-fd-failed > "$work/wrapper-stage"; exit 63; }
chmod 0600 "$password"
printf '%s\n' password-staged > "$work/wrapper-stage"
trap 'rm -f -- "$password"' EXIT HUP INT TERM
shift 4
[[ "$1" == --no-cache && "$2" == --quiet ]] || exit 61
shift 2
source_path=''
run_test_docker() {
  printf '%s\n' docker-start > "$work/wrapper-stage"
  set +e
  "$docker_binary" --host "unix://$docker_socket" "$@" 2>"$work/docker.stderr"
  status=$?
  set -e
  printf '%s\n' "$status" > "$work/docker.status"
  if [[ "$status" != 0 ]]; then
    cat "$work/docker.stderr" > "$work/docker.last-failure.stderr"
    printf '%s\n' "$status" > "$work/docker.last-failure.status"
  fi
  return "$status"
}
if [[ "$1" == backup ]]; then
  shift
  restic_args=(backup)
  while (($#)); do
    if [[ "$1" == -- ]]; then
      shift
      [[ "$#" == 1 ]] || exit 62
      source_path="$1"
      break
    fi
    restic_args+=("$1")
    shift
  done
  [[ "$source_path" == /* && "$source_path" != *','* && "$source_path" != *$'\n'* ]] || exit 62
  source_target=/source
  source_mount=(--mount "type=bind,source=$source_path,target=/source,readonly")
  if [[ "$source_path" == "$manifest_root"/manifest/* ]]; then
    volume="${project}_reader_manifest"
    stage_container="${project}-manifest-stage"
    if "$docker_binary" --host "unix://$docker_socket" volume inspect "$volume" >/dev/null 2>&1; then
      printf '%s\n' manifest-volume-already-exists > "$work/wrapper-stage"
      exit 64
    fi
    "$docker_binary" --host "unix://$docker_socket" volume create --label "com.aikayun.fixture=$project" "$volume" >/dev/null
    "$docker_binary" --host "unix://$docker_socket" create --name "$stage_container" --label "com.aikayun.fixture=$project" \
      --network none --mount "type=volume,source=$volume,target=/stage" alpine:3.24.1 /bin/sh -c 'sleep 300' >/dev/null
    "$docker_binary" --host "unix://$docker_socket" cp "$source_path/." "$stage_container:/stage/"
    stage_owner="$("$docker_binary" --host "unix://$docker_socket" inspect --format '{{ index .Config.Labels "com.aikayun.fixture" }}' "$stage_container")"
    [[ "$stage_owner" == "$project" ]] || exit 64
    "$docker_binary" --host "unix://$docker_socket" rm "$stage_container" >/dev/null
    "$docker_binary" --host "unix://$docker_socket" run --rm --pull=never --network none \
      --mount "type=volume,source=$volume,target=/stage" --entrypoint /bin/sh alpine:3.24.1 -c \
      'chown -R "$1:$2" /stage && chmod 700 /stage && test -f /stage/manifest.json && chmod 600 /stage/manifest.json' \
      sh "$owner" "$group"
    source_target="$source_path"
    source_mount=(--mount "type=volume,source=$volume,target=$source_target,readonly")
  fi
  mounts=(--mount "type=bind,source=$repo,target=/repo" --mount "type=bind,source=$password,target=/run/password,readonly" "${source_mount[@]}")
  run_test_docker run --rm --pull=never --network none --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges:true --user 0:0 \
    "${mounts[@]}" --entrypoint /usr/bin/restic "$image" --repo /repo --password-file /run/password --no-cache --quiet \
    "${restic_args[@]}" -- "$source_target"
else
  run_test_docker run --rm --pull=never --network none --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges:true --user 0:0 \
    --mount "type=bind,source=$repo,target=/repo" --mount "type=bind,source=$password,target=/run/password,readonly" \
    --entrypoint /usr/bin/restic "$image" --repo /repo --password-file /run/password --no-cache --quiet "$@"
fi
