#!/usr/bin/env bash
# Emergency CLI password reset for a locked-out super admin, run directly on
# the VM as root. Bypasses the API and login entirely (no session, no 2FA
# check) — hashes a new password with the same @node-rs/argon2 used in-app
# and writes it straight to the database via the openestate_system role
# (BYPASSRLS, same client AuthService uses), then revokes all of that
# user's existing sessions. Staff users only (applicant_id/broker_id both
# null) — for a locked-out portal customer/broker, use the normal
# self-service "forgot password" flow or the admin "force password reset"
# feature in the app instead; this tool is root-only break-glass, not a
# general password-reset mechanism.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

OPT_DIR="/opt/openestate"
CURRENT_LINK="${OPT_DIR}/current"
ENV_FILE="/etc/openestate/openestate.env"
EMAIL=""
NEW_PASSWORD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --email) EMAIL="$2"; shift 2 ;;
    --password) NEW_PASSWORD="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
Usage: sudo ./reset-admin-password.sh --email you@example.com [--password NEW_PW]

Resets a STAFF user's password directly in the database, bypassing login
and 2FA entirely. For recovering a locked-out super admin only.

  --email EMAIL      Staff user's email (required)
  --password PW      New password (min 8 chars). If omitted, a random
                      password is generated and printed once.
  --env-file PATH    Default: /etc/openestate/openestate.env
USAGE
      exit 0
      ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Must be run as root (sudo ./reset-admin-password.sh)."
[ -n "$EMAIL" ] || die "Missing --email (see --help)."
[ -L "$CURRENT_LINK" ] || die "${CURRENT_LINK} is not a symlink — is OpenEstate installed via install-native.sh?"
[ -f "$ENV_FILE" ] || die "Env file not found: ${ENV_FILE}"
command -v psql >/dev/null 2>&1 || die "psql client not found. Install it: sudo apt-get install -y postgresql-client"

RELEASE_DIR="$(readlink -f "$CURRENT_LINK")"
[ -d "${RELEASE_DIR}/api/node_modules/@node-rs/argon2" ] || die "@node-rs/argon2 not found under ${RELEASE_DIR}/api/node_modules — is this a valid release directory?"

GENERATED=0
if [ -z "$NEW_PASSWORD" ]; then
  NEW_PASSWORD="$(node -e "process.stdout.write(require('node:crypto').randomBytes(18).toString('base64url'))")"
  GENERATED=1
fi
[ "${#NEW_PASSWORD}" -ge 8 ] || die "Password must be at least 8 characters."

log "Hashing new password..."
NEW_HASH="$(cd "${RELEASE_DIR}/api" && node -e "
const argon2 = require('@node-rs/argon2');
argon2.hash(process.argv[1], { algorithm: argon2.Algorithm.Argon2id }).then((h) => process.stdout.write(h));
" "$NEW_PASSWORD")"
[ -n "$NEW_HASH" ] || die "Hashing failed — got an empty hash."

DATABASE_URL_SYSTEM="$(grep -m1 '^DATABASE_URL_SYSTEM=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$DATABASE_URL_SYSTEM" ] || die "Could not read DATABASE_URL_SYSTEM from ${ENV_FILE}."

sql_escape() { printf '%s' "$1" | sed "s/'/''/g"; }
EMAIL_ESC="$(sql_escape "$EMAIL")"
HASH_ESC="$(sql_escape "$NEW_HASH")"

USER_ID="$(psql "$DATABASE_URL_SYSTEM" -v ON_ERROR_STOP=1 -tAc \
  "SELECT id FROM users WHERE email = '${EMAIL_ESC}' AND applicant_id IS NULL AND broker_id IS NULL")"
[ -n "$USER_ID" ] || die "No staff user found with email '${EMAIL}' (or it belongs to a portal account — this tool is for staff accounts only)."

log "Updating database..."
psql "$DATABASE_URL_SYSTEM" -v ON_ERROR_STOP=1 -c "
  UPDATE users SET password_hash = '${HASH_ESC}', force_password_change = false,
    failed_login_attempts = 0, locked_until = NULL WHERE id = '${USER_ID}';
  UPDATE refresh_tokens SET is_revoked = true WHERE user_id = '${USER_ID}' AND is_revoked = false;
" >/dev/null

log "Password reset for ${EMAIL}. All existing sessions have been revoked."
if [ "$GENERATED" -eq 1 ]; then
  warn "Generated password (shown once): ${NEW_PASSWORD}"
fi
