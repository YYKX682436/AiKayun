#!/bin/sh
set -eu
set +x

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_PASSWORD_FILE:?POSTGRES_PASSWORD_FILE is required}"
: "${AIKAYUN_API_DB_PASSWORD_FILE:?AIKAYUN_API_DB_PASSWORD_FILE is required}"
: "${AIKAYUN_MIGRATOR_DB_PASSWORD_FILE:?AIKAYUN_MIGRATOR_DB_PASSWORD_FILE is required}"

export PGHOST="${PGHOST:-db}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="$POSTGRES_USER"
export PGDATABASE="$POSTGRES_DB"
export AIKAYUN_DATABASE_NAME="$POSTGRES_DB"
export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"
export AIKAYUN_API_DB_PASSWORD="$(cat "$AIKAYUN_API_DB_PASSWORD_FILE")"
export AIKAYUN_MIGRATOR_DB_PASSWORD="$(cat "$AIKAYUN_MIGRATOR_DB_PASSWORD_FILE")"

[ -n "$PGPASSWORD" ] && [ -n "$AIKAYUN_API_DB_PASSWORD" ] && [ -n "$AIKAYUN_MIGRATOR_DB_PASSWORD" ] || {
  echo 'Database password files must be non-empty' >&2
  exit 2
}
[ "$AIKAYUN_API_DB_PASSWORD" != "$AIKAYUN_MIGRATOR_DB_PASSWORD" ] || {
  echo 'API and migration database roles require distinct credentials' >&2
  exit 2
}

psql -v ON_ERROR_STOP=1 <<'SQL'
\getenv api_password AIKAYUN_API_DB_PASSWORD
\getenv migrator_password AIKAYUN_MIGRATOR_DB_PASSWORD
\getenv database_name AIKAYUN_DATABASE_NAME
DO $$
DECLARE
  app_exists boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aikayun_app');
  migrator_exists boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aikayun_migrator');
BEGIN
  IF app_exists <> migrator_exists THEN
    RAISE EXCEPTION 'Only one managed application database role exists; refusing partial role repair';
  END IF;
  IF NOT app_exists AND to_regclass('public.kysely_migration') IS NOT NULL THEN
    RAISE EXCEPTION 'Existing migrated database requires the documented supervised role transition';
  END IF;
END
$$;
SELECT format('CREATE ROLE aikayun_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'api_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aikayun_app')
\gexec
SELECT format('CREATE ROLE aikayun_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aikayun_migrator')
\gexec
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aikayun_app'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolcanlogin)) OR
     EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aikayun_migrator'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolcanlogin)) OR
     pg_has_role('aikayun_app', 'aikayun_migrator', 'MEMBER') OR
     pg_has_role('aikayun_migrator', 'aikayun_app', 'MEMBER') THEN
    RAISE EXCEPTION 'Managed database role privilege boundary is invalid';
  END IF;
END
$$;
SELECT format('ALTER DATABASE %I OWNER TO aikayun_migrator', current_database())
\gexec
ALTER SCHEMA public OWNER TO aikayun_migrator;
GRANT CONNECT ON DATABASE :"database_name" TO aikayun_app, aikayun_migrator;
GRANT USAGE ON SCHEMA public TO aikayun_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, aikayun_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aikayun_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO aikayun_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO aikayun_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aikayun_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aikayun_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aikayun_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO aikayun_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aikayun_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO aikayun_app;
SQL

unset PGPASSWORD AIKAYUN_API_DB_PASSWORD AIKAYUN_MIGRATOR_DB_PASSWORD
