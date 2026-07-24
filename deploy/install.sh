#!/usr/bin/env bash
# OpenEstate installer: checks Docker, generates deploy/.env with random
# secrets, brings up the stack, runs migrations + seed, prints the URL and
# initial admin credentials.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

log()  { printf '\033[1;32m[install]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31m[install]\033[0m %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is required: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (bundled with modern Docker Desktop/Engine)."

rand_secret() {
  # 48 bytes -> 64 base64 chars, url-safe, no padding noise.
  openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48
}
rand_hex_32() {
  # 32 bytes -> 64 hex chars for AES-256-GCM encryption keys.
  openssl rand -hex 32
}

if [ -f .env ]; then
  warn ".env already exists — leaving it in place. Delete deploy/.env to regenerate secrets."
else
  log "Generating deploy/.env from .env.example with random secrets..."
  cp .env.example .env
  POSTGRES_PASSWORD="$(rand_secret)"
  POSTGRES_APP_PASSWORD="$(rand_secret)"
  POSTGRES_SYSTEM_PASSWORD="$(rand_secret)"
  JWT_ACCESS_SECRET="$(rand_secret)"
  JWT_REFRESH_SECRET="$(rand_secret)"
  PAN_ENCRYPTION_KEY="$(rand_hex_32)"
  TOTP_ENCRYPTION_KEY="$(rand_hex_32)"
  PLUGIN_SECRET_ENCRYPTION_KEYS="1:$(rand_hex_32)"
  MINIO_ROOT_PASSWORD="$(rand_secret)"

  # Portable in-place sed for both GNU and BSD/macOS sed.
  sedi() { sed -i.bak "$1" .env && rm -f .env.bak; }
  sedi "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=${POSTGRES_PASSWORD}#"
  sedi "s#^POSTGRES_APP_PASSWORD=.*#POSTGRES_APP_PASSWORD=${POSTGRES_APP_PASSWORD}#"
  sedi "s#^POSTGRES_SYSTEM_PASSWORD=.*#POSTGRES_SYSTEM_PASSWORD=${POSTGRES_SYSTEM_PASSWORD}#"
  sedi "s#^JWT_ACCESS_SECRET=.*#JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET}#"
  sedi "s#^JWT_REFRESH_SECRET=.*#JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}#"
  sedi "s#^PAN_ENCRYPTION_KEY=.*#PAN_ENCRYPTION_KEY=${PAN_ENCRYPTION_KEY}#"
  sedi "s#^TOTP_ENCRYPTION_KEY=.*#TOTP_ENCRYPTION_KEY=${TOTP_ENCRYPTION_KEY}#"
  sedi "s#^PLUGIN_SECRET_ENCRYPTION_KEYS=.*#PLUGIN_SECRET_ENCRYPTION_KEYS=${PLUGIN_SECRET_ENCRYPTION_KEYS}#"
  sedi "s#^MINIO_ROOT_PASSWORD=.*#MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}#"
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

# Construct the superuser URL for migrations only (never used by the app).
# Host is "postgres" (the compose service's DNS name on the shared
# openestate_default network), not "localhost" — this URL is used inside
# a `docker compose exec api ...` call below, i.e. from the API
# container's own network namespace, where "localhost" would mean the api
# container itself, not the separate postgres container.
MIGRATION_DATABASE_URL="postgresql://${POSTGRES_USER:-openestate}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-openestate}"

log "Building and starting the stack (this can take a few minutes on first run)..."
docker compose up -d --build

log "Waiting for the API to become healthy..."
tries=0
until docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    die "API did not become healthy in time. Check logs: docker compose logs api"
  fi
  sleep 2
done

# Invoked directly via their hoisted node_modules/.bin/ path, NOT via
# `pnpm --filter @openestate/db ...` — the runtime image's /app is a
# `pnpm deploy --prod` output (a flattened, standalone package directory),
# not a pnpm workspace: there's no root package.json/pnpm-workspace.yaml
# there for `--filter` to resolve against, so corepack falls back to
# fetching whatever "latest" pnpm resolves to instead of the version
# pinned in the (absent, from this directory) root package.json — and
# that latest version can require a newer Node than this image ships,
# hard-failing. prisma/tsx are direct `dependencies` of @openestate/api
# specifically so pnpm deploy hoists their binaries to /app/node_modules/.bin/.
log "Running database migrations (as superuser role)..."
docker compose exec -T -w /app/packages/db -e DATABASE_URL="$MIGRATION_DATABASE_URL" api ../../node_modules/.bin/prisma migrate deploy \
  || die "Migration failed. Check logs: docker compose logs api"

log "Seeding initial data..."
docker compose exec -T -w /app/packages/db -e DATABASE_URL="$MIGRATION_DATABASE_URL" api ../../node_modules/.bin/tsx prisma/seed.ts \
  || warn "Seed step skipped/failed."

NGINX_PORT="${NGINX_PORT:-8080}"
log "OpenEstate is up: http://localhost:${NGINX_PORT}"
log "API health check: http://localhost:${NGINX_PORT}/api/v1/health"
log "The seed step above printed a one-time initial admin email + random"
log "password — scroll up in this terminal to find it (it is not shown again)."
