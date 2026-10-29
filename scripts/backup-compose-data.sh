#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s BACKUP_DIRECTORY\n' "$0" >&2
  exit 2
fi

backup_root="$1"
mkdir -p -m 700 "$backup_root"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temp_directory="$(mktemp -d "$backup_root/.aikayun-backup.XXXXXX")"
api_stopped=0

finish() {
  result=$?
  if (( api_stopped )); then
    docker compose start api >/dev/null || true
  fi
  if (( result != 0 )); then
    rm -rf "$temp_directory"
  fi
  exit "$result"
}
trap finish EXIT

docker compose stop api
api_stopped=1
database_name="$(docker compose exec -T db sh -lc 'printf %s "$POSTGRES_DB"')"
docker compose exec -T db sh -lc \
  'pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" "$POSTGRES_DB"' \
  > "$temp_directory/database.dump"
docker compose run --rm --no-deps -T --entrypoint sh api \
  -c 'tar -czf - -C "$MEDIA_ROOT" .' > "$temp_directory/media.tar.gz"
docker compose run --rm --no-deps -T --entrypoint sh api \
  -c 'tar -czf - -C "$PRIVATE_FILE_ROOT" .' > "$temp_directory/private-files.tar.gz"
docker compose run --rm --no-deps -T --entrypoint sh api \
  -c 'tar -czf - -C "$INSTANCE_IDENTITY_ROOT" .' > "$temp_directory/identity.tar.gz"

printf 'format=aikayun-compose-backup-v3\ncreated_utc=%s\nproject=%s\ndatabase=%s\n' \
  "$timestamp" "${COMPOSE_PROJECT_NAME:-compose-default}" "$database_name" > "$temp_directory/manifest.txt"
(cd "$temp_directory" && sha256sum database.dump media.tar.gz private-files.tar.gz identity.tar.gz > SHA256SUMS)
backup_path="$backup_root/$timestamp"
if [[ -e "$backup_path" ]]; then
  printf 'Backup destination already exists: %s\n' "$backup_path" >&2
  exit 1
fi
mv "$temp_directory" "$backup_path"
printf 'Created verified database, file and paired instance-identity backup: %s\n' "$backup_path"
