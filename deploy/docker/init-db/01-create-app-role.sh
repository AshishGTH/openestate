#!/bin/bash
# Creates (or activates) the two application Postgres roles used at
# runtime. Runs once when the Postgres container initialises its data
# directory (via /docker-entrypoint-initdb.d/).
#
# The migration SQL creates these roles as NOLOGIN (no credential in
# committed SQL). This script enables LOGIN and sets passwords from
# environment variables so the application can connect.
#
# Roles:
#   openestate_app    — tenant-scoped queries, RLS enforced
#   openestate_system — cross-tenant system ops, BYPASSRLS
#
# The superuser (POSTGRES_USER) is reserved for migrations only and
# never appears in an application connection string.

set -e

APP_PASSWORD="${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}"
SYSTEM_PASSWORD="${POSTGRES_SYSTEM_PASSWORD:?POSTGRES_SYSTEM_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  -- Tenant-scoped role (RLS enforced, no BYPASSRLS)
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'openestate_app') THEN
      CREATE ROLE openestate_app WITH LOGIN PASSWORD '${APP_PASSWORD}' NOINHERIT;
    ELSE
      ALTER ROLE openestate_app WITH LOGIN PASSWORD '${APP_PASSWORD}';
    END IF;
  END
  \$\$;

  -- System role (BYPASSRLS for cross-tenant operations, NOT superuser)
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'openestate_system') THEN
      CREATE ROLE openestate_system WITH LOGIN PASSWORD '${SYSTEM_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
    ELSE
      ALTER ROLE openestate_system WITH LOGIN PASSWORD '${SYSTEM_PASSWORD}';
    END IF;
  END
  \$\$;

  GRANT USAGE ON SCHEMA public TO openestate_app;
  GRANT USAGE ON SCHEMA public TO openestate_system;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openestate_system;

  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openestate_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openestate_system;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO openestate_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO openestate_system;
EOSQL
