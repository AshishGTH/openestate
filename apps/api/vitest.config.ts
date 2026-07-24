import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Capped, not left at vitest's default (== CPU count, 16 on this
    // machine's dev box). Instrumentation (see CLAUDE.md's Phase 7
    // CI-reliability decisions) showed the full-suite flakiness was NOT
    // connection-count exhaustion (peak observed 39/100 against
    // max_connections=100) — it was CPU/IO contention slowing individual
    // transactions down past Prisma's maxWait and widening the window for
    // postsales-property.test.ts's abandoned-timeout self-race. Fewer
    // concurrent forks means less contention, which directly shrinks both
    // failure windows. 4 forks x 15 connections/file (connection_limit=10
    // tenant + 5 system, scripts/test-setup.sh) = 60, comfortably under
    // Postgres's max_connections=100 even alongside packages/db's own
    // uncapped test run (peak measured well below the theoretical max).
    poolOptions: {
      forks: {
        // minForks must be set explicitly alongside maxForks — vitest's
        // own default minForks is NOT 1, it's derived from CPU count too,
        // so specifying only maxForks here throws "minThreads and
        // maxThreads must not conflict" (min > max) at collection time.
        minForks: 1,
        maxForks: 4,
      },
    },
  },
});
