#!/usr/bin/env bash
# Upgrades an existing native install: backup -> build a new versioned
# release -> migrate -> cut over -> healthcheck gate. On a failed
# healthcheck, rolls the `current` symlink back to the previous release and
# restarts — it never attempts to un-apply a migration (migrations are
# forward-only; see CLAUDE.md), so the pre-upgrade backup is the tool for a
# human-decided database rollback if the migration itself is the problem.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

APP_USER="openestate"
APP_GROUP="openestate"
OPT_DIR="/opt/openestate"
RELEASES_DIR="${OPT_DIR}/releases"
CURRENT_LINK="${OPT_DIR}/current"
ENV_FILE="/etc/openestate/openestate.env"
REF=""
NO_BACKUP=0
DB_HOST=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --no-backup) NO_BACKUP=1; shift ;;
    --db-host) DB_HOST="$2"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
Usage: sudo ./upgrade-native.sh [--ref TAG_OR_BRANCH] [--no-backup] [--db-host HOST]
  --ref REF        git ref to check out in the source checkout before
                    building (default: whatever is currently checked out —
                    run `git fetch --tags` and `git checkout vX.Y.Z`
                    yourself first if you'd rather control this directly).
  --no-backup      Skip the automatic pre-upgrade backup (for scripted
                    upgrades that already snapshot elsewhere).
  --db-host HOST   Same meaning as install-native.sh — only needed for a
                    remote database (requires PG_SUPERUSER_PASSWORD).
USAGE
      exit 0
      ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Must be run as root (sudo ./upgrade-native.sh)."
[ -L "$CURRENT_LINK" ] || die "${CURRENT_LINK} is not a symlink — is OpenEstate installed via install-native.sh?"
PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK")"

if [ "$NO_BACKUP" -eq 1 ]; then
  warn "Skipping pre-upgrade backup (--no-backup)."
else
  log "Taking a pre-upgrade backup..."
  "${SCRIPT_DIR}/backup-native.sh" --env-file "$ENV_FILE"
fi

if [ -n "$REF" ]; then
  log "Checking out ${REF}..."
  (cd "$SRC_DIR" && git fetch --tags && git checkout "$REF")
fi

log "Building new release..."
RELEASE_DIR="$(build_release "$SRC_DIR" "$RELEASES_DIR")" || die "Build failed — see output above. Previous release (${PREVIOUS_RELEASE}) is untouched and still running."
chown -R "${APP_USER}:${APP_GROUP}" "$RELEASE_DIR"
chmod -R o+rX "$RELEASE_DIR"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

run_as_superuser() {
  # See install-native.sh: run from RELEASE_DIR (already o+rX), not this
  # script's own cwd — Prisma 6.19+'s cwd-relative prisma.config.*
  # auto-discovery lstat()s and gets EACCES, not ENOENT, when an ancestor
  # of the checkout isn't traversable by the `postgres` OS user, which
  # aborts the migrate step entirely.
  (
    cd "$RELEASE_DIR" || exit 1
    if [ -n "$DB_HOST" ]; then
      PGPASSWORD="${PG_SUPERUSER_PASSWORD:?Set PG_SUPERUSER_PASSWORD when using --db-host}" \
        env DATABASE_URL="postgresql://${PG_SUPERUSER:-postgres}:${PG_SUPERUSER_PASSWORD}@${DB_HOST}:5432/openestate" "$@"
    else
      sudo -u postgres env DATABASE_URL="postgresql://postgres@localhost/openestate?host=/var/run/postgresql" "$@"
    fi
  )
}

log "Running database migrations (before cutover — old release keeps running against the new, backward-compatible schema until it's swapped)..."
# See install-native.sh: pnpm's .bin shims are shell scripts, not JS —
# invoked directly, never wrapped in `node`.
run_as_superuser "${RELEASE_DIR}/api/node_modules/.bin/prisma" migrate deploy \
  --schema "${RELEASE_DIR}/api/packages/db/prisma/schema.prisma" \
  || die "Migration failed. Previous release (${PREVIOUS_RELEASE}) is untouched and still running. Inspect the backup taken above before retrying."

# Schema migrations don't cover PERMISSIONS constants — those are
# application-level rows, not a Prisma model change. seed.ts's own
# permission-upsert loop never reaches an existing install (it returns
# early the moment any company exists, which is every install after its
# first boot) — so without this, a release that adds a permission and a
# UI gated on it would upgrade clean and heal nothing: no role could
# ever be granted a permission row that was never inserted. This step is
# scoped to permissions only (see sync-permissions.ts's own comment for
# why roles/masters are deliberately excluded — both are per-company
# data an admin may have already customised).
log "Syncing permission rows added since the previous release..."
run_as_superuser "${RELEASE_DIR}/api/node_modules/.bin/tsx" "${RELEASE_DIR}/api/packages/db/prisma/sync-permissions.ts" \
  || die "Permission sync failed. Previous release (${PREVIOUS_RELEASE}) is untouched and still running. Inspect the backup taken above before retrying."

log "Cutting over to the new release..."
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
chown -h "${APP_USER}:${APP_GROUP}" "$CURRENT_LINK"
systemctl restart openestate-api

log "Waiting for the API to become healthy..."
if wait_for_health "http://127.0.0.1:3000/api/v1/health" 60; then
  log "Upgrade complete: ${RELEASE_DIR}"
else
  warn "Healthcheck failed after cutover — rolling code back to ${PREVIOUS_RELEASE}."
  ln -sfn "$PREVIOUS_RELEASE" "$CURRENT_LINK"
  chown -h "${APP_USER}:${APP_GROUP}" "$CURRENT_LINK"
  systemctl restart openestate-api
  die "Rolled back to ${PREVIOUS_RELEASE}. The database schema migration was NOT rolled back (migrations are forward-only) — if you suspect the migration itself broke something, inspect the pre-upgrade backup and involve a human before doing anything destructive. Check: journalctl -u openestate-api -n 200"
fi
