#!/usr/bin/env bash
# AiKayun Internal Development & Test Deployment Tool
# Fast-path build, deploy, database migration and reset for https://aikayun.aiove.top
set -Eeuo pipefail

SSH_HOST="${AIKAYUN_SSH_HOST:-myshop-prod}"
SSH_OPTS=(-o ServerAliveInterval=15 -o ServerAliveCountMax=60 -o ConnectTimeout=15 -o TCPKeepAlive=yes)
REMOTE_SRC_DIR="/home/myshopops/aikayun-dev-src"
REMOTE_DEV_DIR="/home/myshopops/.aikayun-dev"
REMOTE_OVERLAY="${REMOTE_DEV_DIR}/dev-preview.compose.yaml"
OPT_OVERLAY="/opt/aikayun/dev-preview.compose.yaml"
RELEASE_COMPOSE="/opt/aikayun/release/compose.yaml"
LICENSE_OVERLAY="/data/aikayun-license/ingress/compose.license-overlay.yaml"
ENV_FILE="/opt/aikayun/.env"

# Root signing key thumbprint & center issuer for the running license center
LICENSE_CENTER_ISSUER="https://license.aiove.top"
LICENSE_ROOT_KID="opC-a13Dmr86opfZpOHPvxBJd8h1T2P1aBH2yWFmRCw"
LICENSE_ROOT_JWK_X="7MC55fuV_FuPvYiJhGmiBDMGO5gW5jJaPcM8hclFtso"
LICENSE_CONFIG_ID="e895c49f-0db8-485b-a86e-6b2361839845"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\133[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { printf "${BLUE}[INFO]${NC} %s\n" "$*"; }
log_success() { printf "${GREEN}[SUCCESS]${NC} %s\n" "$*"; }
log_warn() { printf "${YELLOW}[WARN]${NC} %s\n" "$*"; }
log_err() { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }

run_ssh() {
  ssh "${SSH_OPTS[@]}" "$SSH_HOST" "$@"
}

get_version_tag() {
  local sha dirty
  sha="$(git rev-parse --short HEAD)"
  dirty="$(git diff-index --quiet HEAD -- 2>/dev/null || echo "-dirty")"
  echo "${sha}${dirty}"
}

sync_source() {
  log_info "Syncing local repository to ${SSH_HOST}:${REMOTE_SRC_DIR}..."
  rsync -az --delete \
    --exclude='.git' \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='node_modules' \
    --exclude='.pnpm-store' \
    --exclude='.nuxt' \
    --exclude='.output' \
    --exclude='dist' \
    --exclude='coverage' \
    --exclude='playwright-report' \
    --exclude='test-results' \
    --exclude='.agents' \
    --exclude='.serena' \
    --exclude='.gemini' \
    --exclude='.vscode' \
    --exclude='.idea' \
    --exclude='.DS_Store' \
    --exclude='*.log' \
    --exclude='tmp' \
    ./ "${SSH_HOST}:${REMOTE_SRC_DIR}/"
  log_success "Source synced."
}

ensure_dev_license_config() {
  local release_id="${1:-aikayun-dev}"
  run_ssh "mkdir -p ${REMOTE_DEV_DIR} && cat > ${REMOTE_DEV_DIR}/trusted-license-config.json <<EOF
{
  \"schema_version\": 1,
  \"trust_configuration_id\": \"${LICENSE_CONFIG_ID}\",
  \"release_id\": \"${release_id}\",
  \"expected_center_issuer\": \"${LICENSE_CENTER_ISSUER}\",
  \"expected_center_origin\": \"${LICENSE_CENTER_ISSUER}\",
  \"offline_root\": {
    \"kid\": \"${LICENSE_ROOT_KID}\",
    \"publicJwk\": {
      \"crv\": \"Ed25519\",
      \"x\": \"${LICENSE_ROOT_JWK_X}\",
      \"kty\": \"OKP\"
    }
  },
  \"minimum_bundle_version\": \"1\"
}
EOF
chmod 600 ${REMOTE_DEV_DIR}/trusted-license-config.json"
}

ensure_dev_overlay_exists() {
  run_ssh "mkdir -p ${REMOTE_DEV_DIR}
if [ ! -f ${REMOTE_OVERLAY} ]; then
  cat > ${REMOTE_OVERLAY} <<'EOF'
services:
  web:
    image: aikayun-web:internal-preview-db66f63
  api:
    image: aikayun-api:dev-test
  migrate:
    image: aikayun-api:dev-test
EOF
fi
sudo -n cp ${REMOTE_OVERLAY} ${OPT_OVERLAY}
sudo -n chmod 600 ${OPT_OVERLAY}"
}

build_web() {
  local tag="$1"
  log_info "Building Web image on remote host: ${tag}..."
  run_ssh "sudo -n docker build \
    -t '${tag}' \
    --build-arg AIKAYUN_RELEASE_ID='${tag}' \
    --build-arg AIKAYUN_RELEASE_VERSION='0.1.0-dev' \
    --build-arg AIKAYUN_SOURCE_COMMIT='$(git rev-parse HEAD)' \
    -f '${REMOTE_SRC_DIR}/apps/web/Dockerfile' \
    '${REMOTE_SRC_DIR}'"
  log_success "Web image built: ${tag}"
}

build_api() {
  local tag="$1"
  local release_id="aikayun-dev"
  log_info "Ensuring dev trusted license configuration on remote host..."
  ensure_dev_license_config "$release_id"
  log_info "Building API image on remote host: ${tag}..."
  run_ssh "sudo -n docker build \
    --target runtime \
    -t '${tag}' \
    --build-arg AIKAYUN_RELEASE_ID='${release_id}' \
    --build-arg AIKAYUN_RELEASE_VERSION='0.1.0-dev' \
    --build-arg AIKAYUN_REQUIRE_LICENSE_CONFIG=true \
    --build-arg AIKAYUN_PRODUCTION_LICENSE_ISSUER='${LICENSE_CENTER_ISSUER}' \
    --build-arg AIKAYUN_PRODUCTION_LICENSE_ROOT_KID='${LICENSE_ROOT_KID}' \
    --build-arg AIKAYUN_SOURCE_COMMIT='$(git rev-parse HEAD)' \
    --secret id=aikayun-trusted-license-config,src='${REMOTE_DEV_DIR}/trusted-license-config.json' \
    -f '${REMOTE_SRC_DIR}/apps/api/Dockerfile' \
    '${REMOTE_SRC_DIR}'"
  log_success "API image built: ${tag}"
}

update_compose_override() {
  local web_tag="${1:-}"
  local api_tag="${2:-}"
  ensure_dev_overlay_exists
  run_ssh "python3 -c '
import sys, yaml, os

path = \"${REMOTE_OVERLAY}\"
data = {\"services\": {}}
if os.path.exists(path):
    try:
        with open(path, \"r\") as f:
            data = yaml.safe_load(f) or {\"services\": {}}
    except Exception:
        data = {\"services\": {}}

if \"services\" not in data or not isinstance(data.get(\"services\"), dict):
    data[\"services\"] = {}

web_tag = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else \"\"
api_tag = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else \"\"

if web_tag:
    if \"web\" not in data[\"services\"] or not isinstance(data[\"services\"].get(\"web\"), dict):
        data[\"services\"][\"web\"] = {}
    data[\"services\"][\"web\"][\"image\"] = web_tag
if api_tag:
    if \"api\" not in data[\"services\"] or not isinstance(data[\"services\"].get(\"api\"), dict):
        data[\"services\"][\"api\"] = {}
    data[\"services\"][\"api\"][\"image\"] = api_tag
    if \"migrate\" not in data[\"services\"] or not isinstance(data[\"services\"].get(\"migrate\"), dict):
        data[\"services\"][\"migrate\"] = {}
    data[\"services\"][\"migrate\"][\"image\"] = api_tag

with open(path, \"w\") as f:
    yaml.dump(data, f, default_flow_style=False)
' '${web_tag}' '${api_tag}'
sudo -n cp ${REMOTE_OVERLAY} ${OPT_OVERLAY}
sudo -n chmod 600 ${OPT_OVERLAY}"
}

compose_cmd() {
  echo "sudo -n docker compose -f ${RELEASE_COMPOSE} -f ${LICENSE_OVERLAY} -f ${OPT_OVERLAY} --env-file ${ENV_FILE}"
}

wait_for_services() {
  local cmd="$1"
  shift
  local services=("$@")
  local timeout=60
  local interval=3
  local elapsed=0

  log_info "Waiting for service(s) to become healthy: ${services[*]}..."

  while [ $elapsed -lt $timeout ]; do
    local all_healthy=true
    local status_lines
    status_lines="$(run_ssh "${cmd} ps -a ${services[*]} --format '{{.Service}}\t{{.State}}\t{{.Health}}'")"

    for svc in "${services[@]}"; do
      local line
      line="$(grep -E "^${svc}[[:space:]]" <<< "$status_lines" || true)"
      if [ -z "$line" ]; then
        log_err "Target service '${svc}' not found in compose project."
        return 1
      fi

      local svc_name state health
      svc_name="$(awk '{print $1}' <<< "$line")"
      state="$(awk '{print $2}' <<< "$line")"
      health="$(awk '{print $3}' <<< "$line")"

      if [ "$state" = "exited" ] || [ "$state" = "dead" ]; then
        log_err "Target service '${svc}' failed (state=${state})."
        run_ssh "${cmd} logs --tail=50 ${svc}"
        return 1
      fi

      if [ "$health" = "unhealthy" ]; then
        log_err "Target service '${svc}' reported unhealthy."
        run_ssh "${cmd} logs --tail=50 ${svc}"
        return 1
      fi

      if [ "$state" != "running" ] || [ "$health" != "healthy" ]; then
        all_healthy=false
      fi
    done

    if [ "$all_healthy" = true ]; then
      log_success "All targeted service(s) [${services[*]}] are running and healthy!"
      return 0
    fi

    sleep $interval
    elapsed=$((elapsed + interval))
  done

  log_err "Timed out waiting for service(s) [${services[*]}] to become healthy after ${timeout}s."
  run_ssh "${cmd} ps -a ${services[*]}"
  return 1
}

deploy_services() {
  local services=("$@")
  ensure_dev_overlay_exists
  local cmd
  cmd="$(compose_cmd)"
  log_info "Deploying service(s): ${services[*]}..."
  run_ssh "${cmd} up -d --no-deps ${services[*]}"
  wait_for_services "$cmd" "${services[@]}"
}

check_status() {
  local cmd
  cmd="$(compose_cmd)"
  log_info "Current deployment status on ${SSH_HOST}:"
  run_ssh "${cmd} ps"
  printf "\n"
  log_info "Testing public endpoints:"
  local web_code license_code
  web_code="$(curl -s -o /dev/null -w "%{http_code}" https://aikayun.aiove.top || echo "FAIL")"
  license_code="$(curl -sk -o /dev/null -w "%{http_code}" https://license.aiove.top || echo "FAIL")"
  printf "  - Storefront (https://aikayun.aiove.top): HTTP %s\n" "$web_code"
  printf "  - License Center (https://license.aiove.top): HTTP %s\n" "$license_code"
}

db_migrate() {
  ensure_dev_overlay_exists
  local cmd
  cmd="$(compose_cmd)"
  log_info "Running database migrations using current dev API image..."
  run_ssh "${cmd} run --rm migrate"
  log_success "Database migrations completed."
}

db_reset_data() {
  log_warn "Resetting commerce test data on dev store..."
  log_warn "Target Database: aikayun (Postgres container: aikayun-db-1)"
  log_warn "Preserved: installation_binding, instance_license_state, admin_users, migrations"

  ensure_dev_overlay_exists
  local cmd
  cmd="$(compose_cmd)"

  log_info "Pausing Web and API services to prevent concurrent database writes..."
  run_ssh "${cmd} stop web api"

  local reset_err=0

  log_info "Executing safe table truncate (RESTRICT mode) on non-system commerce tables..."
  run_ssh "sudo -n docker exec aikayun-db-1 psql -U aikayun_bootstrap -d aikayun -v ON_ERROR_STOP=1 -c \"
DO \\\$\\\$
DECLARE
  cur_db text := current_database();
  target_tables text;
  r record;
BEGIN
  IF cur_db <> 'aikayun' THEN
    RAISE EXCEPTION 'SAFETY GATE TRIGGERED: Refusing to reset non-store database: %', cur_db;
  END IF;

  SELECT string_agg(quote_ident(tablename), ', ')
  INTO target_tables
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename NOT IN (
      'installation_binding',
      'installation_identity_initializations',
      'instance_license_state',
      'local_license_operations',
      'local_license_operation_attempts',
      'admin_setup_state',
      'admin_users',
      'admin_sessions',
      'admin_setup_sessions',
      'kysely_migration',
      'kysely_migration_lock'
    );

  IF target_tables IS NOT NULL AND target_tables <> '' THEN
    FOR r IN (
      SELECT quote_ident(tablename) AS tbl
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN (
          'installation_binding',
          'installation_identity_initializations',
          'instance_license_state',
          'local_license_operations',
          'local_license_operation_attempts',
          'admin_setup_state',
          'admin_users',
          'admin_sessions',
          'admin_setup_sessions',
          'kysely_migration',
          'kysely_migration_lock'
        )
    ) LOOP
      EXECUTE 'ALTER TABLE ' || r.tbl || ' DISABLE TRIGGER USER';
    END LOOP;

    EXECUTE 'TRUNCATE TABLE ' || target_tables || ' RESTART IDENTITY RESTRICT';

    FOR r IN (
      SELECT quote_ident(tablename) AS tbl
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN (
          'installation_binding',
          'installation_identity_initializations',
          'instance_license_state',
          'local_license_operations',
          'local_license_operation_attempts',
          'admin_setup_state',
          'admin_users',
          'admin_sessions',
          'admin_setup_sessions',
          'kysely_migration',
          'kysely_migration_lock'
        )
    ) LOOP
      EXECUTE 'ALTER TABLE ' || r.tbl || ' ENABLE TRIGGER USER';
    END LOOP;
  END IF;
END \\\$\\\$;
\"" || reset_err=1

  if [ $reset_err -eq 0 ]; then
    log_info "Cleaning media and private-files in aikayun_state volume..."
    run_ssh "bash -s" <<'CLEAN_EOF' || reset_err=1
set -Eeuo pipefail
vol_mount="$(sudo -n docker volume inspect aikayun_state --format '{{.Mountpoint}}' 2>/dev/null || true)"
if [ -z "$vol_mount" ] || [ ! -d "$vol_mount" ]; then
  echo "ERROR: aikayun_state volume mountpoint not found or invalid: '$vol_mount'" >&2
  exit 1
fi

media_dir="${vol_mount}/media"
private_files_dir="${vol_mount}/private-files"

if [ ! -d "$media_dir" ]; then
  echo "ERROR: media directory not found: '$media_dir'" >&2
  exit 1
fi
if [ ! -d "$private_files_dir" ]; then
  echo "ERROR: private-files directory not found: '$private_files_dir'" >&2
  exit 1
fi

sudo -n find "$media_dir" -mindepth 1 -delete
sudo -n find "$private_files_dir" -mindepth 1 -delete
CLEAN_EOF
  fi

  log_info "Resuming Web and API services..."
  run_ssh "${cmd} up -d --no-deps web api"
  wait_for_services "$cmd" web api

  if [ $reset_err -ne 0 ]; then
    log_err "Store reset failed."
    return 1
  fi

  log_info "Verifying preserved admin and license bindings..."
  local check_result
  check_result="$(run_ssh "sudo -n docker exec aikayun-db-1 psql -U aikayun_bootstrap -d aikayun -t -A -c \"
SELECT 
  (SELECT count(*) FROM installation_binding) || '|' ||
  (SELECT count(*) FROM instance_license_state) || '|' ||
  (SELECT count(*) FROM admin_users) || '|' ||
  (SELECT count(*) FROM orders) || '|' ||
  (SELECT count(*) FROM products);
\"")"

  local b_count l_count a_count o_count p_count
  IFS='|' read -r b_count l_count a_count o_count p_count <<< "$check_result"
  if [ "${b_count:-0}" -lt 1 ] || [ "${l_count:-0}" -lt 1 ] || [ "${a_count:-0}" -lt 1 ]; then
    log_err "CRITICAL SAFETY FAILURE: Protected tables compromised! (binding=${b_count}, license=${l_count}, admin=${a_count})"
    return 1
  fi

  log_success "Store test data reset successfully."
  printf "  - installation_binding: %s (preserved)\n" "$b_count"
  printf "  - instance_license_state: %s (preserved)\n" "$l_count"
  printf "  - admin_users: %s (preserved)\n" "$a_count"
  printf "  - orders: %s (cleared)\n" "$o_count"
  printf "  - products: %s (cleared)\n" "$p_count"
}

case "${1:-help}" in
  web)
    ver="$(get_version_tag)"
    tag="aikayun-web:internal-dev-${ver}"
    sync_source
    build_web "$tag"
    update_compose_override "$tag" ""
    deploy_services web
    check_status
    ;;
  api)
    ver="$(get_version_tag)"
    tag="aikayun-api:internal-dev-${ver}"
    sync_source
    build_api "$tag"
    update_compose_override "" "$tag"
    deploy_services api
    check_status
    ;;
  all)
    ver="$(get_version_tag)"
    web_tag="aikayun-web:internal-dev-${ver}"
    api_tag="aikayun-api:internal-dev-${ver}"
    sync_source
    build_api "$api_tag"
    update_compose_override "" "$api_tag"
    db_migrate
    build_web "$web_tag"
    update_compose_override "$web_tag" "$api_tag"
    deploy_services api web
    check_status
    ;;
  db-migrate)
    db_migrate
    ;;
  db-reset)
    db_reset_data
    ;;
  status)
    check_status
    ;;
  *)
    echo "AiKayun Rapid Dev & Deployment Tool"
    echo ""
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  web         Sync, build and deploy Web only"
    echo "  api         Sync, build and deploy API only"
    echo "  all         Sync, build and deploy both Web and API"
    echo "  db-migrate  Run latest database migrations"
    echo "  db-reset    Safely reset store test data (orders/products/carts), preserving license & admin"
    echo "  status      Show current services, images and endpoint status"
    echo ""
    exit 1
    ;;
esac
