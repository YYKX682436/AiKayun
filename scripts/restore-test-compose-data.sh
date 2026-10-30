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
  || ! -f "$backup_directory/license-trust-store.tar.gz" \
  || ! -f "$backup_directory/license-pending-key.tar.gz" \
  || ! -f "$backup_directory/SHA256SUMS" || ! -f "$backup_directory/manifest.txt" ]]; then
  printf 'The backup is incomplete.\n' >&2
  exit 2
fi
if ! grep -Fxq 'format=aikayun-compose-backup-v5' "$backup_directory/manifest.txt"; then
  printf 'The backup manifest format is unsupported; expected v5 with paired instance identity, license trust store and pending encryption key.\n' >&2
  exit 2
fi
(cd "$backup_directory" && sha256sum -c SHA256SUMS)
pending_key_archive_listing="$(tar -tzf "$backup_directory/license-pending-key.tar.gz")"
if ! grep -Fxq './license-pending-aes-256-gcm.json' <<< "$pending_key_archive_listing"; then
  printf 'The v5 backup is missing its paired license pending encryption key.\n' >&2
  exit 2
fi
pending_key_identity="$(tar -xOzf "$backup_directory/license-pending-key.tar.gz" ./license-pending-aes-256-gcm.json | node -e '
let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { input += chunk }); process.stdin.on("end", () => {
  try {
    const value = JSON.parse(input);
    const key = Buffer.from(value.key, "base64url");
    if (value.schema !== 1 || value.purpose !== "aikayun-license-pending-aes-256-gcm-v1" ||
      typeof value.key_id !== "string" || !/^[A-Za-z0-9_-]{1,48}$/.test(value.key_id) ||
      key.length !== 32 || key.toString("base64url") !== value.key) process.exit(2);
    const digest = require("node:crypto").createHash("sha256").update(key).digest("hex");
    process.stdout.write(`${value.key_id}:${digest}`);
  } catch { process.exit(2); }
});')"
backup_key_id="$(sed -n 's/^pending_key_id=//p' "$backup_directory/manifest.txt")"
backup_key_sha256="$(sed -n 's/^pending_key_sha256=//p' "$backup_directory/manifest.txt")"
if [[ "$pending_key_identity" != "$backup_key_id:$backup_key_sha256" || ! "$backup_key_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'The v5 backup pending key does not match its manifest; refusing restore.\n' >&2
  exit 2
fi

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
license_trust_store_root="$(docker compose exec -T api node -e 'process.stdout.write(process.env.LICENSE_TRUST_STORE_ROOT || "")')"
license_pending_key_root="$(docker compose exec -T api node -e 'process.stdout.write(process.env.LICENSE_PENDING_KEY_ROOT || "")')"
media_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "'"$media_root"'"}}{{.Name}}{{end}}{{end}}' "$api_container")"
private_file_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "'"$private_file_root"'"}}{{.Name}}{{end}}{{end}}' "$api_container")"
identity_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "'"$identity_root"'"}}{{.Name}}{{end}}{{end}}' "$api_container")"
license_trust_store_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "'"$license_trust_store_root"'"}}{{.Name}}{{end}}{{end}}' "$api_container")"
license_pending_key_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "'"$license_pending_key_root"'"}}{{.Name}}{{end}}{{end}}' "$api_container")"
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
if [[ "$license_trust_store_volume" != "${COMPOSE_PROJECT_NAME}_license_trust_store" ]]; then
  printf 'Refusing restore because the license trust store is not the project-scoped license_trust_store volume.\n' >&2
  exit 2
fi
if [[ "$license_pending_key_volume" != "${COMPOSE_PROJECT_NAME}_license_pending_key" ]]; then
  printf 'Refusing restore because the license pending key is not in the project-scoped license_pending_key volume.\n' >&2
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
docker compose run --rm --no-deps -T --entrypoint sh api -c \
  'node -e '\''const fs=require("node:fs"),path=require("node:path"),root=process.env.LICENSE_TRUST_STORE_ROOT;for(const name of fs.readdirSync(root))fs.rmSync(path.join(root,name),{recursive:true,force:true})'\'' && tar -xzf - -C "$LICENSE_TRUST_STORE_ROOT"' \
  < "$backup_directory/license-trust-store.tar.gz"
docker compose run --rm --no-deps -T --entrypoint sh api -c \
  'node -e '\''const fs=require("node:fs"),path=require("node:path"),root=process.env.LICENSE_PENDING_KEY_ROOT;for(const name of fs.readdirSync(root))fs.rmSync(path.join(root,name),{recursive:true,force:true})'\'' && tar -xzf - -C "$LICENSE_PENDING_KEY_ROOT"' \
  < "$backup_directory/license-pending-key.tar.gz"
docker compose run --rm --no-deps -T -e NODE_ENV=test --entrypoint node api \
  dist/licensing/license-pending-restore-check.js
docker compose start api web caddy
printf 'Restored the verified backup into isolated database %s.\n' "$database_name"
