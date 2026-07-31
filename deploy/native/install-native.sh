#!/usr/bin/env bash
# Native installer for OpenEstate: no Docker, no bundled Postgres/Redis.
# Builds the app from this git checkout and installs it as a systemd
# service behind nginx, using a PostgreSQL/Redis the admin already runs.
#
# Run as root, from inside a git checkout of the repo:
#   git clone <repo-url> /opt/openestate-src
#   cd /opt/openestate-src/deploy/native
#   sudo ./install-native.sh
#
# Does NOT install or manage PostgreSQL, Redis, Node.js, or nginx — those
# are prerequisites the admin installs themselves (see --help / the
# installation guide). Safe to re-run: skips steps whose result already
# exists (env file, system user, directories).
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
ETC_DIR="/etc/openestate"
ENV_FILE="${ETC_DIR}/openestate.env"
LOG_DIR="/var/log/openestate"
UPLOADS_DIR="/var/lib/openestate/uploads"
SERVER_NAME="_"
SKIP_DATABASE=0
DB_HOST=""

while [ $# -gt 0 ]; do
  case "$1" in
    --server-name) SERVER_NAME="$2"; shift 2 ;;
    --skip-database) SKIP_DATABASE=1; shift ;;
    --db-host) DB_HOST="$2"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
Usage: sudo ./install-native.sh [options]
  --server-name NAME   nginx server_name (default: _, i.e. any/IP-only)
  --skip-database      Don't run setup-database.sh — print instructions
                        instead, for a DBA-managed database setup.
  --db-host HOST        Passed through to setup-database.sh as --host
                        (default: local peer auth, same machine).
USAGE
      exit 0
      ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Must be run as root (sudo ./install-native.sh)."

log "Checking prerequisites..."
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node.js 20 via NodeSource:
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs"
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ required, found $(node -v). See --help output above for the NodeSource install command."

command -v psql >/dev/null 2>&1 || die "PostgreSQL client not found. Install PostgreSQL 16:
  sudo apt-get install -y postgresql-16 postgresql-client-16"
command -v redis-cli >/dev/null 2>&1 || die "Redis client not found. Install Redis:
  sudo apt-get install -y redis-server"
redis-cli ping >/dev/null 2>&1 || warn "Could not reach a local Redis via 'redis-cli ping' — if Redis runs elsewhere, that's expected; otherwise install/start it: sudo apt-get install -y redis-server && sudo systemctl enable --now redis-server"
command -v nginx >/dev/null 2>&1 || die "nginx not found. Install it:
  sudo apt-get install -y nginx"
command -v openssl >/dev/null 2>&1 || die "openssl not found (needed to generate secrets). Install it: sudo apt-get install -y openssl"
command -v git >/dev/null 2>&1 || die "git not found. Install it: sudo apt-get install -y git"
# argon2 (password hashing) has no prebuilt binary for every platform/Node
# combination and falls back to compiling from source via node-gyp during
# `pnpm install` — the same reason deploy/docker/api.Dockerfile's build
# stage installs these before its own `pnpm install`. Checked (and failed
# loudly) here rather than silently apt-installed: unlike Postgres/Redis/
# nginx this has no ongoing state to manage, but it's still a package
# install decision left to the admin, consistent with every other
# prerequisite in this script.
if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
  die "Build toolchain not found (make/g++/python3 — needed to compile the argon2 native module during install). Install it:
  sudo apt-get install -y build-essential python3"
fi

log "Enabling corepack/pnpm..."
corepack enable
PNPM_VERSION="$(node -e "console.log(require('${SRC_DIR}/package.json').packageManager.split('@')[1])")"
corepack prepare "pnpm@${PNPM_VERSION}" --activate

log "Creating system user '${APP_USER}'..."
if ! id "$APP_USER" >/dev/null 2>&1; then
  # -m: pnpm/corepack writes a version-cache under $HOME/.cache on first
  # invocation (migrate/seed run as this user) — a homeless account makes
  # that fail with EACCES, the same root cause api.Dockerfile's own -m
  # flag documents for the container user.
  useradd -r -m -d "$UPLOADS_DIR" -s /usr/sbin/nologin -U "$APP_USER"
else
  log "User '${APP_USER}' already exists."
fi

log "Creating directories..."
mkdir -p "$RELEASES_DIR" "$ETC_DIR" "$LOG_DIR" "$UPLOADS_DIR"
chown -R "${APP_USER}:${APP_GROUP}" "$OPT_DIR" "$LOG_DIR" "$UPLOADS_DIR"
chmod 750 "$ETC_DIR"

if [ -f "$ENV_FILE" ]; then
  warn "${ENV_FILE} already exists — leaving it in place. Delete it to regenerate secrets."
else
  log "Generating ${ENV_FILE} with random secrets..."
  cp "${SCRIPT_DIR}/openestate.env.example" "$ENV_FILE"
  APP_PW="$(rand_secret)"
  SYS_PW="$(rand_secret)"
  JWT_ACCESS="$(rand_secret)"
  JWT_REFRESH="$(rand_secret)"
  PAN_KEY="$(rand_hex_32)"
  TOTP_KEY="$(rand_hex_32)"
  PLUGIN_KEY="1:$(rand_hex_32)"

  sedi() { sed -i.bak "$1" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"; }
  sedi "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://openestate_app:${APP_PW}@${DB_HOST:-localhost}:5432/openestate#"
  sedi "s#^DATABASE_URL_SYSTEM=.*#DATABASE_URL_SYSTEM=postgresql://openestate_system:${SYS_PW}@${DB_HOST:-localhost}:5432/openestate#"
  sedi "s#^JWT_ACCESS_SECRET=.*#JWT_ACCESS_SECRET=${JWT_ACCESS}#"
  sedi "s#^JWT_REFRESH_SECRET=.*#JWT_REFRESH_SECRET=${JWT_REFRESH}#"
  sedi "s#^PAN_ENCRYPTION_KEY=.*#PAN_ENCRYPTION_KEY=${PAN_KEY}#"
  sedi "s#^TOTP_ENCRYPTION_KEY=.*#TOTP_ENCRYPTION_KEY=${TOTP_KEY}#"
  sedi "s#^PLUGIN_SECRET_ENCRYPTION_KEYS=.*#PLUGIN_SECRET_ENCRYPTION_KEYS=${PLUGIN_KEY}#"
  sedi "s#^UPLOADS_DIR=.*#UPLOADS_DIR=${UPLOADS_DIR}#"
  if [ "$SERVER_NAME" != "_" ]; then
    sedi "s#^CORS_ALLOWLIST=.*#CORS_ALLOWLIST=http://${SERVER_NAME}#"
  fi
  chown root:"$APP_GROUP" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [ "$SKIP_DATABASE" -eq 1 ]; then
  warn "Skipping database setup (--skip-database). Ask your DBA to run:"
  warn "  ${SCRIPT_DIR}/setup-database.sh --env-file ${ENV_FILE} [--host ... --admin-user ...]"
else
  log "Setting up the database..."
  DB_HOST_ARGS=()
  [ -n "$DB_HOST" ] && DB_HOST_ARGS=(--host "$DB_HOST")
  "${SCRIPT_DIR}/setup-database.sh" --env-file "$ENV_FILE" "${DB_HOST_ARGS[@]}"
fi

log "Building the application (this can take several minutes on first run)..."
RELEASE_DIR="$(build_release "$SRC_DIR" "$RELEASES_DIR")" || die "Build failed — see output above."
chown -R "${APP_USER}:${APP_GROUP}" "$RELEASE_DIR"
# "other" needs read+traverse to run this release as the postgres OS user
# below (local peer-auth migrate/seed) without granting it any write access.
chmod -R o+rX "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
chown -h "${APP_USER}:${APP_GROUP}" "$CURRENT_LINK"

# Superuser connection for migrate/seed only — never the app's own runtime
# credential (that's DATABASE_URL/DATABASE_URL_SYSTEM in openestate.env,
# the openestate_app/openestate_system roles). Local install: run as the
# `postgres` OS user over the Unix socket (peer auth, no password needed —
# matches setup-database.sh's own local default). Remote: requires a real
# password, same as setup-database.sh's remote path.
run_as_superuser() {
  # Run from RELEASE_DIR, not the caller's cwd (SCRIPT_DIR — this git
  # checkout). Prisma 6.19+ auto-discovers a prisma.config.* file in cwd
  # before running any command, via an lstat() that fails EACCES (not
  # ENOENT) if any ancestor directory isn't traversable by the `postgres`
  # OS user — which SCRIPT_DIR's ancestors often aren't (e.g. GitHub
  # Actions runners: the checkout lives under /home/runner, mode 0750).
  # Prisma treats that EACCES as "failed to load config file" and aborts
  # the whole migrate/seed step. RELEASE_DIR is already made o+rX above
  # for exactly this "run as the postgres OS user" reason, so cd there.
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

log "Running database migrations (as superuser)..."
# Invoked directly (not via `node <path>`) — pnpm's node_modules/.bin
# shims on Linux are POSIX shell scripts that exec into the real JS entry
# point, not JS files themselves; wrapping one in `node` fails with a
# shell-syntax parse error instead of running it.
run_as_superuser "${RELEASE_DIR}/api/node_modules/.bin/prisma" migrate deploy \
  --schema "${RELEASE_DIR}/api/packages/db/prisma/schema.prisma" \
  || die "Migration failed."

log "Seeding initial data..."
run_as_superuser "${RELEASE_DIR}/api/node_modules/.bin/tsx" "${RELEASE_DIR}/api/packages/db/prisma/seed.ts" \
  || warn "Seed step skipped/failed (already seeded is expected on a re-run)."

log "Installing systemd unit..."
cp "${SCRIPT_DIR}/systemd/openestate-api.service" /etc/systemd/system/openestate-api.service
systemctl daemon-reload
systemctl enable --now openestate-api

log "Installing nginx site..."
sed "s#__SERVER_NAME__#${SERVER_NAME}#" "${SCRIPT_DIR}/nginx/openestate.conf.template" > /etc/nginx/sites-available/openestate
ln -sf /etc/nginx/sites-available/openestate /etc/nginx/sites-enabled/openestate
rm -f /etc/nginx/sites-enabled/default
nginx -t || die "nginx config test failed — check /etc/nginx/sites-available/openestate"
systemctl reload nginx

log "Waiting for the API to become healthy..."
if wait_for_health "http://127.0.0.1:3000/api/v1/health" 60; then
  log "OpenEstate is up: http://${SERVER_NAME}/ (staff), http://${SERVER_NAME}/portal/ (customer/broker portal)"
  log "The seed step above printed a one-time initial admin email + random"
  log "password — scroll up in this terminal to find it (also in: journalctl -u openestate-api)."
  if [ "$SERVER_NAME" = "_" ]; then
    warn "No --server-name was given — CORS_ALLOWLIST in ${ENV_FILE} still says"
    warn "'http://localhost'. Edit it to your real domain/IP and 'systemctl restart"
    warn "openestate-api' before logging in from a browser at another address."
  fi
else
  die "API did not become healthy in time. Check: systemctl status openestate-api && journalctl -u openestate-api -n 100"
fi
