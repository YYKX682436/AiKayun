#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s BACKUP_DIRECTORY\n' "$0" >&2
  exit 2
fi
if [[ "${ALLOW_TEST_DATABASE_RESTORE:-}" != 'YES' ]]; then
  printf 'Refusing restore. Set ALLOW_TEST_DATABASE_RESTORE=YES for an isolated _test database.\n' >&2
  exit 2
fi
case "${COMPOSE_PROJECT_NAME:-}" in
  *test*|*restore*) ;;
  *)
    printf 'Refusing restore. Set COMPOSE_PROJECT_NAME to an explicit isolated test or restore project.\n' >&2
    exit 2
    ;;
esac

backup_directory="$1"
if [[ ! -f "$backup_directory/database.dump" || ! -f "$backup_directory/media.tar.gz" \
  || ! -f "$backup_directory/private-files.tar.gz" \
  || ! -f "$backup_directory/identity.tar.gz" \
  || ! -f "$backup_directory/SHA256SUMS" || ! -f "$backup_directory/manifest.txt" ]]; then
  printf 'The backup is incomplete.\n' >&2
  exit 2
fi
if ! grep -Fxq 'format=aikayun-compose-backup-v3' "$backup_directory/manifest.txt"; then
  printf 'The backup manifest format is unsupported; expected v3 with paired instance identity.\n' >&2
  exit 2
fi
(cd "$backup_directory" && sha256sum -c SHA256SUMS)

database_name="$(docker compose exec -T db sh -lc 'printf %s "$POSTGRES_DB"')"
if [[ "$database_name" != *_test ]]; then
  printf 'Refusing restore to non-test database: %s\n' "$database_name" >&2
  exit 2
fi
api_container="$(docker compose ps -q api)"
if [[ -z "$api_container" ]]; then
  printf 'Refusing restore because the isolated API container is not running.\n' >&2
  exit 2
fi
media_root="$(docker compose exec -T api node -e 'process.stdout.write(process.env.MEDIA_ROOT || "")')"
private_file_root="$(docker compose exec -T api node -e 'process.stdout.write(process.env.PRIVATE_FILE_ROOT || "")')"
identity_root="$(docker compose exec -T api node -e 'process.stdout.write(process.env.INSTANCE_IDENTITY_ROOT || "")')"
media_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "'"$media_root"'"}}{{.Name}}{{end}}{{end}}' "$api_container")"
private_file_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "'"$private_file_root"'"}}{{.Name}}{{end}}{{end}}' "$api_container")"
identity_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "'"$identity_root"'"}}{{.Name}}{{end}}{{end}}' "$api_container")"
if [[ "$media_volume" != "${COMPOSE_PROJECT_NAME}_product_media" ]]; then
  printf 'Refusing restore because the media volume is not the project-scoped product_media volume.\n' >&2
  exit 2
fi
if [[ "$private_file_volume" != "${COMPOSE_PROJECT_NAME}_private_files" ]]; then
  printf 'Refusing restore because the private-file volume is not the project-scoped private_files volume.\n' >&2
  exit 2
fi
if [[ "$identity_volume" != "${COMPOSE_PROJECT_NAME}_instance_identity" ]]; then
  printf 'Refusing restore because the identity volume is not the project-scoped instance_identity volume.\n' >&2
  exit 2
fi

# A failed restore deliberately leaves the stack stopped for inspection.
docker compose stop api web caddy
docker compose exec -T db sh -lc \
  'pg_restore --clean --if-exists --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  < "$backup_directory/database.dump"
docker compose run --rm --no-deps -T --entrypoint sh api -c \
  'node -e '\''const fs=require("node:fs"),path=require("node:path"),root=process.env.MEDIA_ROOT;for(const name of fs.readdirSync(root))fs.rmSync(path.join(root,name),{recursive:true,force:true})'\'' && tar -xzf - -C "$MEDIA_ROOT"' \
  < "$backup_directory/media.tar.gz"
docker compose run --rm --no-deps -T --entrypoint sh api -c \
  'node -e '\''const fs=require("node:fs"),path=require("node:path"),root=process.env.PRIVATE_FILE_ROOT;for(const name of fs.readdirSync(root))fs.rmSync(path.join(root,name),{recursive:true,force:true})'\'' && tar -xzf - -C "$PRIVATE_FILE_ROOT"' \
  < "$backup_directory/private-files.tar.gz"
docker compose run --rm --no-deps -T --entrypoint sh api -c \
  'node -e '\''const fs=require("node:fs"),path=require("node:path"),root=process.env.INSTANCE_IDENTITY_ROOT;for(const name of fs.readdirSync(root))fs.rmSync(path.join(root,name),{recursive:true,force:true})'\'' && tar -xzf - -C "$INSTANCE_IDENTITY_ROOT"' \
  < "$backup_directory/identity.tar.gz"
docker compose start api web caddy
printf 'Restored the verified backup into isolated database %s.\n' "$database_name"
