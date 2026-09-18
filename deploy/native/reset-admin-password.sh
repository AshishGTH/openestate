#!/usr/bin/env bash
# Emergency CLI password reset for a locked-out super admin, run directly on
# the VM as root. Bypasses the API and login entirely (no session needed) —
# hashes a new password with the same @node-rs/argon2 used in-app and writes
# it straight to the database via the openestate_system role (BYPASSRLS, same
# client AuthService uses), then revokes all of that user's existing
# sessions.
#
# It does NOT turn off two-factor authentication unless you pass
# --clear-2fa. A new password alone does not get a 2FA-enabled user back in:
# they sign in with it and are still asked for a code they may not have.
# Deliberately a separate flag — clearing 2FA on every password reset would
# make a password reset a 2FA bypass. Without the flag, the script warns when
# the account has 2FA on.
#
# Staff users only (applicant_id/broker_id both null) — for a locked-out
# portal customer/broker, use the admin reset actions on their customer or
# broker record in the app instead; this tool is root-only break-glass, not
# a general password-reset mechanism.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

OPT_DIR="/opt/openestate"
CURRENT_LINK="${OPT_DIR}/current"
ENV_FILE="/etc/openestate/openestate.env"
EMAIL=""
NEW_PASSWORD=""
CLEAR_2FA=0

while [ $# -gt 0 ]; do
  case "$1" in
    --email) EMAIL="$2"; shift 2 ;;
    --password) NEW_PASSWORD="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --clear-2fa) CLEAR_2FA=1; shift ;;
    -h|--help)
      cat <<'USAGE'
Usage: sudo ./reset-admin-password.sh --email you@example.com [--password NEW_PW] [--clear-2fa]

Resets a STAFF user's password directly in the database, bypassing login.
For recovering a locked-out super admin only.

Two-factor authentication is left ON unless you pass --clear-2fa. A new
password alone will not get a 2FA-enabled user back in if they have lost
their authenticator and recovery codes.

  --email EMAIL      Staff user's email (required)
  --password PW      New password (min 12 chars). If omitted, a random
                      password is generated and printed once.
  --clear-2fa        Also turn off 2FA: clears the TOTP secret, recovery
                      codes and 2FA lockout. The user can enrol again after
                      signing in. Recorded in the audit log.
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
[ "${#NEW_PASSWORD}" -ge 12 ] || die "Password must be at least 12 characters."

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

# One row: id|totp_enabled (t/f)|company_id.
USER_ROW="$(psql "$DATABASE_URL_SYSTEM" -v ON_ERROR_STOP=1 -tAc \
  "SELECT id, totp_enabled, company_id FROM users WHERE email = '${EMAIL_ESC}' AND applicant_id IS NULL AND broker_id IS NULL")"
[ -n "$USER_ROW" ] || die "No staff user found with email '${EMAIL}' (or it belongs to a portal account — this tool is for staff accounts only)."
IFS='|' read -r USER_ID TOTP_ENABLED COMPANY_ID <<<"$USER_ROW"

# With --clear-2fa: the same five columns as TOTP_CLEARED in
# apps/api/src/auth/totp-lockout.ts (keep the two in step), plus the same
# TOTP_RESET_BY_ADMIN audit row the in-app admin reset writes, with no actor
# (user_id NULL) and surface 'cli'. audit_logs.id has no database default
# (Prisma generates it), and created_at is a TIMESTAMP holding UTC, so both
# are set explicitly — a bare CURRENT_TIMESTAMP would be shifted by the
# session time zone.
CLEAR_2FA_SQL=""
if [ "$CLEAR_2FA" -eq 1 ]; then
  WAS_ENABLED="false"
  [ "$TOTP_ENABLED" = "t" ] && WAS_ENABLED="true"
  CLEAR_2FA_SQL="
  UPDATE users SET totp_enabled = false, totp_secret = NULL, recovery_codes = '{}',
    failed_totp_attempts = 0, totp_locked_until = NULL WHERE id = '${USER_ID}';
  INSERT INTO audit_logs (id, company_id, user_id, entity_type, entity_id, action, after, ip_address, created_at)
    VALUES (gen_random_uuid(), '${COMPANY_ID}', NULL, 'User', '${USER_ID}', 'TOTP_RESET_BY_ADMIN',
      '{\"surface\": \"cli\", \"wasEnabled\": ${WAS_ENABLED}}'::jsonb, NULL, now() AT TIME ZONE 'UTC');"
fi

log "Updating database..."
# One -c string runs as a single transaction, so the password, the 2FA clear
# and the audit row commit together or not at all.
psql "$DATABASE_URL_SYSTEM" -v ON_ERROR_STOP=1 -c "
  UPDATE users SET password_hash = '${HASH_ESC}', force_password_change = false,
    failed_login_attempts = 0, locked_until = NULL WHERE id = '${USER_ID}';
  UPDATE refresh_tokens SET is_revoked = true WHERE user_id = '${USER_ID}' AND is_revoked = false;${CLEAR_2FA_SQL}
" >/dev/null

log "Password reset for ${EMAIL}. All existing sessions have been revoked."
if [ "$CLEAR_2FA" -eq 1 ]; then
  if [ "$TOTP_ENABLED" = "t" ]; then
    log "Two-factor authentication turned off. ${EMAIL} can sign in with the password alone and enrol again."
  else
    log "Two-factor authentication was already off for ${EMAIL}; nothing to clear."
  fi
elif [ "$TOTP_ENABLED" = "t" ]; then
  # A silent dead end is the failure this flag exists to prevent, so this
  # goes to stderr where it can't be lost in the normal output.
  warn "WARNING: ${EMAIL} has two-factor authentication turned on." >&2
  warn "A password reset alone will NOT restore access if they have lost their authenticator and recovery codes." >&2
  warn "To also turn off 2FA, re-run with --clear-2fa:" >&2
  warn "  sudo ./reset-admin-password.sh --email ${EMAIL} --clear-2fa" >&2
fi
if [ "$GENERATED" -eq 1 ]; then
  warn "Generated password (shown once): ${NEW_PASSWORD}"
fi
