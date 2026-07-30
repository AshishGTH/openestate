#!/usr/bin/env bash
# Backs up the database, uploaded files, and /etc/openestate/openestate.env
# into one timestamped bundle. The env file is NOT optional: PAN_ENCRYPTION_KEY,
# TOTP_ENCRYPTION_KEY, and PLUGIN_SECRET_ENCRYPTION_KEYS live only there —
# a database dump without it is permanently undecryptable.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

ENV_FILE="/etc/openestate/openestate.env"
UPLOADS_DIR="/var/lib/openestate/uploads"
OUTPUT_DIR="/var/backups/openestate"

while [ $# -gt 0 ]; do
  case "$1" in
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: backup-native.sh [--output DIR] [--env-file PATH]"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[ -f "$ENV_FILE" ] || die "${ENV_FILE} not found. Pass --env-file if it lives elsewhere."
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
[ -n "${DATABASE_URL_SYSTEM:-}" ] || die "DATABASE_URL_SYSTEM not set in ${ENV_FILE}."

TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
BUNDLE_DIR="${OUTPUT_DIR}/${TIMESTAMP}"
mkdir -p "$BUNDLE_DIR"

log "Dumping database..."
# Uses openestate_system (BYPASSRLS), not openestate_app — the app role is
# RLS-enforced, and pg_dump's own COPY queries don't (and can't) set the
# app.current_company_id session variable the way the application's Prisma
# extension does, so every RLS-protected table's COPY is rejected outright
# ("query would be affected by row-level security policy") under the app
# role. Confirmed by hitting this exact error on a real install.
pg_dump "$DATABASE_URL_SYSTEM" > "${BUNDLE_DIR}/db.sql"

log "Archiving uploads (${UPLOADS_DIR})..."
tar czf "${BUNDLE_DIR}/uploads.tar.gz" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"

log "Copying openestate.env (holds the PAN/TOTP/plugin encryption keys)..."
cp "$ENV_FILE" "${BUNDLE_DIR}/openestate.env"
chmod 600 "${BUNDLE_DIR}/openestate.env"

log "Backup complete: ${BUNDLE_DIR}"
log "This bundle includes live secrets (openestate.env) — store it as securely as the database itself."
