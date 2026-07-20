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

if [ -f .env ]; then
  warn ".env already exists — leaving it in place. Delete deploy/.env to regenerate secrets."
else
  log "Generating deploy/.env from .env.example with random secrets..."
  cp .env.example .env
  POSTGRES_PASSWORD="$(rand_secret)"
  JWT_ACCESS_SECRET="$(rand_secret)"
  JWT_REFRESH_SECRET="$(rand_secret)"
  PAN_ENCRYPTION_KEY="$(rand_secret)"
  MINIO_ROOT_PASSWORD="$(rand_secret)"

  # Portable in-place sed for both GNU and BSD/macOS sed.
  sedi() { sed -i.bak "$1" .env && rm -f .env.bak; }
  sedi "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=${POSTGRES_PASSWORD}#"
  sedi "s#^JWT_ACCESS_SECRET=.*#JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET}#"
  sedi "s#^JWT_REFRESH_SECRET=.*#JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}#"
  sedi "s#^PAN_ENCRYPTION_KEY=.*#PAN_ENCRYPTION_KEY=${PAN_ENCRYPTION_KEY}#"
  sedi "s#^MINIO_ROOT_PASSWORD=.*#MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}#"
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

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

log "Running database migrations..."
docker compose exec -T api node -e "require('child_process').execSync('pnpm --filter @openestate/db migrate:deploy', {stdio:'inherit'})" \
  || warn "Migration step skipped/failed — no domain models exist yet in Phase 0."

log "Seeding initial data..."
docker compose exec -T api node -e "require('child_process').execSync('pnpm --filter @openestate/db seed', {stdio:'inherit'})" \
  || warn "Seed step skipped/failed — no seed data exists yet in Phase 0."

# TODO(Phase 1): once the auth module ships, generate a real initial
# super_admin user here and force a password change on first login instead
# of printing a static placeholder.
NGINX_PORT="${NGINX_PORT:-8080}"
log "OpenEstate is up: http://localhost:${NGINX_PORT}"
log "API health check: http://localhost:${NGINX_PORT}/api/v1/health"
warn "No admin user exists yet — user/auth management ships in Phase 1."
