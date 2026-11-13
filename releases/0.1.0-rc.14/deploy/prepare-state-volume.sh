#!/bin/sh
set -eu
set +x

readonly root=/var/lib/aikayun
readonly marker="$root/.aikayun-volume-v1"
readonly marker_temporary="$root/.aikayun-volume-v1.tmp"
state_uid="${AIKAYUN_STATE_UID:-1000}"
state_gid="${AIKAYUN_STATE_GID:-1000}"
allow_empty_repair="${AIKAYUN_STATE_ALLOW_EMPTY_REPAIR:-false}"

fail() {
  printf 'AiKayun state volume initialization stopped: %s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || fail 'root is required to set initial volume ownership'
case "$state_uid:$state_gid" in *[!0-9:]*|:*) fail 'state directory owner must be numeric' ;; esac

marker_valid=false
if [ -e "$marker" ]; then
  [ -f "$marker" ] && [ ! -L "$marker" ] || fail 'volume marker is not a regular file'
  if [ "$(stat -c '%u:%g:%a:%h' "$marker")" = '0:0:400:1' ] &&
    [ "$(cat "$marker")" = 'aikayun-state-volume-v1' ]; then marker_valid=true; fi
fi

if [ "$marker_valid" = true ]; then
  for name in media private-files identity license-trust license-pending; do
    path="$root/$name"
    [ -d "$path" ] && [ ! -L "$path" ] || fail "required state directory is missing or unsafe: $name"
    [ "$(stat -c '%u:%g:%a' "$path")" = "$state_uid:$state_gid:700" ] || fail "state directory ownership or mode changed: $name"
  done
  for path in "$root"/* "$root"/.[!.]* "$root"/..?*; do
    [ -e "$path" ] || continue
    case "$path" in
      "$marker"|"$root/media"|"$root/private-files"|"$root/identity"|"$root/license-trust"|"$root/license-pending") ;;
      *) fail 'unexpected top-level state volume path found' ;;
    esac
  done
  exit 0
fi

[ "$allow_empty_repair" = true ] || fail 'state volume marker is missing or invalid'

for path in "$root"/* "$root"/.[!.]* "$root"/..?*; do
  [ -e "$path" ] || continue
  name="${path##*/}"
  case "$name" in
    media|private-files|identity|license-trust|license-pending)
      [ -d "$path" ] && [ ! -L "$path" ] || fail "unsafe state path found: $name"
      [ -z "$(find "$path" -mindepth 1 -print -quit)" ] || fail "non-empty state path will not be adopted: $name"
      ;;
    .aikayun-volume-v1)
      [ -f "$path" ] && [ ! -L "$path" ] || fail 'volume marker is not a regular file'
      ;;
    .aikayun-volume-v1.tmp)
      [ -f "$path" ] && [ ! -L "$path" ] || fail 'temporary volume marker is unsafe'
      ;;
    *) fail 'unmarked non-empty volume will not be adopted' ;;
  esac
done

rm -f "$marker_temporary"

for name in media private-files identity license-trust license-pending; do
  [ -d "$root/$name" ] || mkdir -m 0700 "$root/$name"
  chown "$state_uid:$state_gid" "$root/$name"
  chmod 0700 "$root/$name"
done
printf '%s\n' 'aikayun-state-volume-v1' > "$marker_temporary"
chown 0:0 "$marker_temporary"
chmod 0400 "$marker_temporary"
mv -f "$marker_temporary" "$marker"
