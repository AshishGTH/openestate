import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Raise the default throttle bucket for every apps/api test run,
    // local or CI. Each of the 4 forked test files boots its own
    // NestFactory.create() with its own RedisThrottlerStorage instance
    // (Phase 8 decisions), but Redis itself is SHARED — they all read
    // and write the SAME per-IP keys. Under supertest running against
    // 127.0.0.1, the production default of 100 req/60s per IP is
    // easily exceeded across 90+ test files' aggregate traffic
    // (auth logins, mount refreshes, plugin/webhook e2e requests),
    // exactly the same throttle-exhaustion mechanism the E2E harness
    // hit — see app.module.ts's DEFAULT_THROTTLE_LIMIT block and
    // CLAUDE.md's "E2E refresh-rotation cascade" Decisions entry.
    // Production installs never set this and continue at 100.
    env: {
      // 2000 matches the value in apps/e2e/playwright.config.ts, which
      // was sized to ~2x the empirically-observed 60s-window peak (963)
      // once the request-doubling bug was fixed. Integration tests run
      // vitest workers against an in-process NestJS app, all from
      // localhost — one IP, one throttle bucket. Production installs
      // never set this and continue at 100 (see app.module.ts).
      DEFAULT_THROTTLE_LIMIT: '2000',
    },
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
