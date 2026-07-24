#!/usr/bin/env bash
# Starts a disposable Postgres for integration tests, applies migrations,
# and runs the seed. Designed to be run from the repo root.
#
# Usage:
#   ./scripts/test-setup.sh          # start DB + migrate + seed
#   ./scripts/test-setup.sh teardown # stop DB
set -euo pipefail

COMPOSE_FILE="deploy/docker-compose.test.yml"
SERVICE="postgres-test"

# connection_limit is deliberate, not decorative — see CLAUDE.md's Phase 7
# CI-reliability decisions. Every test file gets its OWN PrismaClient pair
# (createTenantPrismaClient/createSystemPrismaClient), and Prisma's default
# pool size is num_cpus*2+1 (33 on a 16-core box) PER CLIENT. With vitest's
# default fork concurrency, that adds up to several hundred potential
# connections against Postgres's max_connections=100 — capped here to a
# fixed, arithmetically-checked-safe budget instead (see vitest.config.ts's
# maxForks comment for the other half of this budget).
export DATABASE_URL="postgresql://openestate_super:test_super_pass@localhost:5433/openestate_test"
export DATABASE_URL_TEST="postgresql://openestate_app:test_app_pass@localhost:5433/openestate_test?connection_limit=10"
export DATABASE_URL_TEST_SYSTEM="postgresql://openestate_system:test_system_pass@localhost:5433/openestate_test?connection_limit=5"

if [ "${1:-}" = "teardown" ]; then
  echo "Stopping test database..."
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans
  exit 0
fi

echo "Starting test database..."
docker compose -f "$COMPOSE_FILE" up -d --wait

echo "Applying Prisma migration..."
cd packages/db
npx prisma migrate deploy
echo ""
echo "Migration status:"
npx prisma migrate status
cd ../..

echo ""
echo "Running seed..."
pnpm --filter @openestate/db seed

echo ""
echo "Test database ready. Run tests with:"
echo "  export DATABASE_URL_TEST=\"$DATABASE_URL_TEST\""
echo "  export DATABASE_URL_TEST_SYSTEM=\"$DATABASE_URL_TEST_SYSTEM\""
echo "  pnpm test"
