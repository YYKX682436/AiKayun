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
compose_config="$(docker compose config --format json)"
api_container="$(docker compose ps --all -q api)"
database_image="$(jq -er '.services.db.image | select(test("@sha256:"))' <<< "$compose_config")"
media_root="$(jq -er '.services.api.environment.MEDIA_ROOT' <<< "$compose_config")"
private_file_root="$(jq -er '.services.api.environment.PRIVATE_FILE_ROOT' <<< "$compose_config")"
identity_root="$(jq -er '.services.api.environment.INSTANCE_IDENTITY_ROOT' <<< "$compose_config")"
license_trust_store_root="$(jq -er '.services.api.environment.LICENSE_TRUST_STORE_ROOT' <<< "$compose_config")"
license_pending_key_root="$(jq -er '.services.api.environment.LICENSE_PENDING_KEY_ROOT' <<< "$compose_config")"
if [[ -z "$api_container" ]]; then
  printf 'Cannot back up API data because the stopped API container is unavailable.\n' >&2
  exit 2
fi
database_name="$(docker compose exec -T db sh -lc 'printf %s "$POSTGRES_DB"')"
docker compose exec -T db sh -lc \
  'pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" "$POSTGRES_DB"' \
  > "$temp_directory/database.dump"
archive_volume() {
  local volume_root="$1"
  local archive_path="$2"
  docker run --rm --network none --volumes-from "$api_container" --user 1000:1000 \
    -e "VOLUME_ROOT=$volume_root" --entrypoint sh "$database_image" \
    -c 'tar -czf - -C "$VOLUME_ROOT" .' > "$archive_path"
}
archive_volume "$media_root" "$temp_directory/media.tar.gz"
archive_volume "$private_file_root" "$temp_directory/private-files.tar.gz"
archive_volume "$identity_root" "$temp_directory/identity.tar.gz"
archive_volume "$license_trust_store_root" "$temp_directory/license-trust-store.tar.gz"
archive_volume "$license_pending_key_root" "$temp_directory/license-pending-key.tar.gz"
pending_key_identity="$(docker compose run --rm --no-deps -T --entrypoint /nodejs/bin/node api --input-type=module -e '
import { createHash } from "node:crypto";
import { loadLicensePendingKey } from "./dist/licensing/pending-encryption-key.js";
const value = await loadLicensePendingKey(process.env.LICENSE_PENDING_KEY_ROOT);
process.stdout.write(`${value.keyId}:${createHash("sha256").update(value.key).digest("hex")}`);')"
pending_key_id="${pending_key_identity%%:*}"
pending_key_sha256="${pending_key_identity#*:}"
if [[ -z "$pending_key_id" || ! "$pending_key_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'The license pending encryption key is missing or invalid; refusing to create an unpaired backup.\n' >&2
  exit 2
fi

printf 'format=aikayun-compose-backup-v5\ncreated_utc=%s\nproject=%s\ndatabase=%s\n' \
  "$timestamp" "${COMPOSE_PROJECT_NAME:-compose-default}" "$database_name" > "$temp_directory/manifest.txt"
printf 'pending_key_id=%s\npending_key_sha256=%s\n' "$pending_key_id" "$pending_key_sha256" >> "$temp_directory/manifest.txt"
(cd "$temp_directory" && sha256sum database.dump media.tar.gz private-files.tar.gz identity.tar.gz license-trust-store.tar.gz license-pending-key.tar.gz > SHA256SUMS)
backup_path="$backup_root/$timestamp"
if [[ -e "$backup_path" ]]; then
  printf 'Backup destination already exists: %s\n' "$backup_path" >&2
  exit 1
fi
mv "$temp_directory" "$backup_path"
printf 'Created verified v5 database, file, instance-identity, license-trust-store and paired license-pending-key backup: %s\n' "$backup_path"
