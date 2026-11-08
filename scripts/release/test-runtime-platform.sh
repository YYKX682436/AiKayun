#!/bin/sh
set -eu
set +x

platform="${1:?Usage: test-runtime-platform.sh linux/amd64|linux/arm64 API_IMAGE WEB_IMAGE}"
api_image="${2:?API staging image is required}"
web_image="${3:?Web staging image is required}"
expected_migration_head="${4:?Expected signed migration head is required}"
validation_postgres_image="${AIKAYUN_VALIDATION_POSTGRES_IMAGE:-docker.io/library/postgres@sha256:123b17998ccaf47e53b502e8c6a1e79afd8f579c6f3eec83c563da026f957395}"
validation_caddy_image="${AIKAYUN_VALIDATION_CADDY_IMAGE:-docker.io/library/caddy@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee}"
printf '%s\n' "$validation_postgres_image" | grep -Eq '^docker.io/library/postgres@sha256:[a-f0-9]{64}$' || { echo 'PostgreSQL validation image must be an official digest-pinned image.' >&2; exit 2; }
printf '%s\n' "$validation_caddy_image" | grep -Eq '^docker.io/library/caddy@sha256:[a-f0-9]{64}$' || { echo 'Caddy validation image must be an official digest-pinned image.' >&2; exit 2; }
case "$platform" in
  linux/amd64) network="172.30.240.0/24" ;;
  linux/arm64) network="172.30.241.0/24" ;;
  *) echo 'Unsupported validation platform' >&2; exit 2 ;;
esac

repo_root="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/aikayun-runtime-${platform##*/}.XXXXXX")"
project="aikayun-7-3-${platform##*/}-$$"
runtime_uid="$(id -u)"
runtime_gid="$(id -g)"
https_port="$(node --input-type=module -e 'import net from "node:net"; import { randomInt } from "node:crypto"; const tryPort=()=>new Promise(resolve=>{const s=net.createServer();const p=randomInt(20000,45000);s.once("error",()=>resolve(tryPort()));s.listen(p,"127.0.0.1",()=>s.close(()=>resolve(p))) }); console.log(await tryPort())')"
http_port=$((https_port + 1))

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker compose -p "$project" -f "$repo_root/compose.release.yaml" -f "$work/compose.test.yaml" ps -a || true
    docker compose -p "$project" -f "$repo_root/compose.release.yaml" -f "$work/compose.test.yaml" \
      logs --tail=100 db-role-init state-volume-init migrate production-install-init api web || true
  fi
  docker compose -p "$project" -f "$repo_root/compose.release.yaml" -f "$work/compose.test.yaml" down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "${project}_state" >/dev/null 2>&1 || true
  rm -rf "$work"
  return "$status"
}
trap 'exit 130' INT TERM
trap cleanup EXIT

umask 077
openssl rand -hex 32 > "$work/postgres-admin-password"
openssl rand -hex 32 > "$work/api-database-password"
openssl rand -hex 32 > "$work/migrator-database-password"
payment_key="$(openssl rand -base64 32)"
delivery_key="$(openssl rand -base64 32)"
printf '{"activeKeyId":"validation","keys":{"validation":"%s"}}\n' "$payment_key" > "$work/payment-key-ring.json"
printf '{"activeKeyId":"validation","keys":{"validation":"%s"}}\n' "$delivery_key" > "$work/delivery-key-ring.json"
printf '%s\n' 'test-only-placeholder-bundle' > "$work/license-trust-bundle.jws"
chmod 0400 "$work"/*

export AIKAYUN_API_IMAGE="$api_image"
export AIKAYUN_WEB_IMAGE="$web_image"
export AIKAYUN_POSTGRES_IMAGE="$validation_postgres_image"
export AIKAYUN_CADDY_IMAGE="$validation_caddy_image"
export AIKAYUN_PUBLIC_HOST=localhost
export AIKAYUN_PRIVATE_SUBNET="$network"
export AIKAYUN_POSTGRES_ADMIN_PASSWORD_FILE="$work/postgres-admin-password"
export AIKAYUN_API_DATABASE_PASSWORD_FILE="$work/api-database-password"
export AIKAYUN_MIGRATOR_DATABASE_PASSWORD_FILE="$work/migrator-database-password"
export AIKAYUN_PAYMENT_CREDENTIAL_KEY_RING_FILE="$work/payment-key-ring.json"
export AIKAYUN_CODE_POOL_ENCRYPTION_KEY_RING_FILE="$work/delivery-key-ring.json"
export AIKAYUN_LICENSE_TRUST_BUNDLE_FILE="$work/license-trust-bundle.jws"
export AIKAYUN_HTTP_BIND_ADDRESS=127.0.0.1
export AIKAYUN_HTTP_PORT="$http_port"
export AIKAYUN_HTTPS_BIND_ADDRESS=127.0.0.1
export AIKAYUN_HTTPS_PORT="$https_port"
export API_IMAGE="$api_image"
export WEB_IMAGE="$web_image"
export TARGET_PLATFORM="$platform"
export VALIDATION_PROJECT="$project"
export VALIDATION_UID="$runtime_uid"
export VALIDATION_GID="$runtime_gid"

docker volume create "${project}_state" >/dev/null
for volume in "postgres_data:${project}_postgres" "caddy_data:${project}_caddy_data" "caddy_config:${project}_caddy_config"; do
  compose_key="${volume%%:*}"
  volume_name="${volume#*:}"
  docker volume create \
    --label "com.docker.compose.project=$project" \
    --label "com.docker.compose.volume=$compose_key" \
    "$volume_name" >/dev/null
done
cat > "$work/compose.test.yaml" <<'YAML'
services:
  db:
    platform: ${TARGET_PLATFORM}
  db-role-init:
    platform: ${TARGET_PLATFORM}
  state-volume-init:
    environment:
      AIKAYUN_STATE_UID: ${VALIDATION_UID}
      AIKAYUN_STATE_GID: ${VALIDATION_GID}
      AIKAYUN_STATE_ALLOW_EMPTY_REPAIR: "true"
  migrate:
    image: ${API_IMAGE}
    platform: ${TARGET_PLATFORM}
    user: ${VALIDATION_UID}:${VALIDATION_GID}
    environment:
      PUBLIC_ORIGIN: https://www.iana.org
  production-install-init:
    image: ${API_IMAGE}
    platform: ${TARGET_PLATFORM}
    user: ${VALIDATION_UID}:${VALIDATION_GID}
    environment:
      PUBLIC_ORIGIN: https://www.iana.org
  api:
    image: ${API_IMAGE}
    platform: ${TARGET_PLATFORM}
    user: ${VALIDATION_UID}:${VALIDATION_GID}
    environment:
      PUBLIC_ORIGIN: https://www.iana.org
  web:
    image: ${WEB_IMAGE}
    platform: ${TARGET_PLATFORM}
    environment:
      NUXT_PUBLIC_SITE_URL: https://www.iana.org
  caddy:
    platform: ${TARGET_PLATFORM}
volumes:
  postgres_data:
    name: ${VALIDATION_PROJECT}_postgres
  aikayun_state:
    name: ${VALIDATION_PROJECT}_state
    external: true
  caddy_data:
    name: ${VALIDATION_PROJECT}_caddy_data
  caddy_config:
    name: ${VALIDATION_PROJECT}_caddy_config
networks:
  private:
    name: ${VALIDATION_PROJECT}_private
    internal: true
YAML

docker compose -p "$project" -f "$repo_root/compose.release.yaml" -f "$work/compose.test.yaml" config --quiet
docker compose -p "$project" -f "$repo_root/compose.release.yaml" -f "$work/compose.test.yaml" up -d --wait --wait-timeout 240

docker compose -p "$project" -f "$repo_root/compose.release.yaml" -f "$work/compose.test.yaml" exec -T api /nodejs/bin/node --input-type=module -e '
import { createDatabase } from "./dist/db/pool.js";
import { createPostgresPool } from "./dist/db/pool.js";
import { createNewObligationGate, LicenseNewObligationError } from "./dist/licensing/new-obligation-gate.js";
import { readConfig } from "./dist/config.js";
const pool = createPostgresPool({ applicationName: "release-validation-role-check" });
try {
  const role = await pool.query("SELECT session_user, current_user, r.rolsuper FROM pg_roles r WHERE r.rolname = current_user");
  if (role.rows[0]?.session_user !== "aikayun_app" || role.rows[0]?.current_user !== "aikayun_app" || role.rows[0]?.rolsuper !== false) throw new Error("API database role is not least-privileged");
} finally { await pool.end(); }
const db = createDatabase();
const gatePool = createPostgresPool({ applicationName: "release-validation-license-gate" });
const gate = createNewObligationGate({ db, pool: gatePool,
  identityRoot: readConfig().identityRoot, pendingKeyRoot: readConfig().licensePendingKeyRoot,
  trustStoreRoot: readConfig().licenseTrustStoreRoot });
try {
  await db.transaction().execute(async trx => {
    try { await gate.assertNewObligationAllowed(trx, "create_order"); }
    catch (error) { if (error instanceof LicenseNewObligationError && (error.statusCode === 403 || error.statusCode === 503)) return; throw error; }
    throw new Error("New order was allowed without an initialized trust store");
  });
} finally { await db.destroy(); await gatePool.end(); }
'

docker compose -p "$project" -f "$repo_root/compose.release.yaml" -f "$work/compose.test.yaml" exec -T db \
  psql -U aikayun_bootstrap -d aikayun -v ON_ERROR_STOP=1 -Atc \
  "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1" | grep -qx "$expected_migration_head"

docker run --rm --network "${project}_private" node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c \
  node --input-type=module -e '
import https from "node:https";
const fetchPage = () => new Promise((resolve, reject) => {
  const request = https.get({ hostname: "caddy", port: 443, servername: "localhost", rejectUnauthorized: false,
    headers: { host: "localhost" } }, response => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", chunk => body += chunk);
    response.on("end", () => response.statusCode === 200 && /全部商品|暂无可展示的商品/.test(body)
      ? resolve() : reject(new Error(`Unexpected SSR status ${response.statusCode}`)));
  });
  request.on("error", reject);
});
let lastError;
for (let attempt = 0; attempt < 30; attempt++) {
  try { await fetchPage(); process.exit(0); }
  catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 1000)); }
}
throw lastError;
'

fingerprint_install_secrets() {
  docker compose -p "$project" -f "$repo_root/compose.release.yaml" -f "$work/compose.test.yaml" \
    exec -T api /nodejs/bin/node -e '
      const fs=require("node:fs"), crypto=require("node:crypto");
      const identity=JSON.parse(fs.readFileSync("/var/lib/aikayun/identity/current/identity.json","utf8"));
      const pending=fs.readFileSync("/var/lib/aikayun/license-pending/license-pending-aes-256-gcm.json");
      process.stdout.write(JSON.stringify({databaseId:identity.database_id,instanceId:identity.instance_id,
        identityJkt:identity.identity_jkt,pendingKeyDigest:crypto.createHash("sha256").update(pending).digest("hex")}));
    '
}

before_fingerprint="$(fingerprint_install_secrets)"
docker compose -p "$project" -f "$repo_root/compose.release.yaml" -f "$work/compose.test.yaml" \
  run --rm --no-deps production-install-init >/dev/null
after_init_fingerprint="$(fingerprint_install_secrets)"
[ "$after_init_fingerprint" = "$before_fingerprint" ] || {
  echo 'Repeated production initialization changed instance identity or Pending Key' >&2
  exit 1
}
docker compose -p "$project" -f "$repo_root/compose.release.yaml" -f "$work/compose.test.yaml" \
  up -d --no-deps --force-recreate api >/dev/null
docker compose -p "$project" -f "$repo_root/compose.release.yaml" -f "$work/compose.test.yaml" \
  ps -q api >/dev/null
for attempt in $(seq 1 120); do
  api_id="$(docker compose -p "$project" -f "$repo_root/compose.release.yaml" -f "$work/compose.test.yaml" ps -q api)"
  if [ -n "$api_id" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$api_id" 2>/dev/null || true)" = healthy ]; then break; fi
  sleep 1
done
after_recreate_fingerprint="$(fingerprint_install_secrets)"
[ "$after_recreate_fingerprint" = "$before_fingerprint" ] || {
  echo 'Recreating the API container changed instance identity or Pending Key' >&2
  exit 1
}

printf 'Runtime validation passed for %s (database, migration, SSR and fail-closed license gate).\n' "$platform"
