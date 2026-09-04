import { defineConfig } from '@playwright/test';

// Dedicated ports, distinct from a developer's own `pnpm dev` (api:3000,
// web:5173) so this harness can run alongside a normal dev session
// without port conflicts.
const API_PORT = 3900;
const WEB_PORT = 5273;
const PORTAL_PORT = 5274;
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const PORTAL_URL = `http://localhost:${PORTAL_PORT}`;

// Same test Postgres/Redis this project's own backend integration tests use
// (scripts/test-setup.sh) — a precondition, not started here. No containers
// are involved anywhere in this repo: you bring your own PostgreSQL and
// Redis, the same way a real install does. Exported so global-setup.ts's own
// fixture-seed script (which runs as this same Node process, not a webServer
// child) connects to the identical database.
//
// The same three env vars the backend suite reads win when set, so
// `source .test-env` (written by scripts/test-setup.sh) points this harness
// at a non-default host/port without editing anything. The fallbacks are the
// standard ports, which is what test-setup.sh provisions by default and what
// ci.yml's own services block exposes.
export const DATABASE_URL_SYSTEM =
  process.env.DATABASE_URL_TEST_SYSTEM ??
  'postgresql://openestate_system:test_system_pass@localhost:5432/openestate_test';
const DATABASE_URL_APP =
  process.env.DATABASE_URL_TEST ??
  'postgresql://openestate_app:test_app_pass@localhost:5432/openestate_test';
const REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';

// Not real secrets — throwaway key material for a disposable test database
// that gets torn down after every run. Fixed (not randomly generated per
// run) so a crashed run's leftover DB state stays decryptable on a rerun.
// Must be valid hex (0-9a-f only) at exactly 64 chars = 32 bytes — several
// services (PanEncryptionService, TotpService) throw at boot otherwise.
const HARNESS_HEX_KEY = 'ab'.repeat(32);

export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // tests share one seeded fixture company; keep runs serial and simple
  // Playwright defaults to half the CPU count — 8 on this project's dev
  // box. At 12 scenarios that reliably crashed Chromium workers with
  // Windows STATUS_STACK_BUFFER_OVERRUN (0xC0000409): a resource
  // exhaustion signature, not a test failure — the same 12 specs pass
  // at 2 workers, and passed at 8 when there were only 9 of them.
  // Capped for the same reason vitest's maxForks is capped in
  // apps/api/vitest.config.ts (see CLAUDE.md's Phase 7→8 CI-reliability
  // entry). No effect on CI, whose 2-core runners already resolve to
  // fewer workers than this.
  workers: 4,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './global-setup.ts',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @openestate/api exec nest start',
      cwd: '../..',
      url: `${API_URL}/api/v1/health`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        NODE_ENV: 'production', // deliberate — see below
        PORT: String(API_PORT),
        DATABASE_URL: DATABASE_URL_APP,
        DATABASE_URL_SYSTEM,
        REDIS_URL,
        // Both frontends are separate origins (different ports) from the
        // API's point of view — apps/portal joined this allowlist for the
        // cross-app ticket-reply scenario, which is the first one to
        // actually need the portal origin talking to this same API.
        CORS_ALLOWLIST: `${WEB_URL},${PORTAL_URL}`,
        SWAGGER_ENABLED: 'false',
        JWT_ACCESS_SECRET: HARNESS_HEX_KEY,
        JWT_REFRESH_SECRET: HARNESS_HEX_KEY,
        JWT_ACCESS_EXPIRES_IN: '15m',
        JWT_REFRESH_EXPIRES_IN: '7d',
        PORTAL_JWT_REFRESH_EXPIRES_IN: '24h',
        PAN_ENCRYPTION_KEY: HARNESS_HEX_KEY,
        TOTP_ENCRYPTION_KEY: HARNESS_HEX_KEY,
        PLUGIN_SECRET_ENCRYPTION_KEYS: `1:${HARNESS_HEX_KEY}`,
        // 2000 = ~2x the empirically-observed peak of 963 requests in
        // any rolling 60s window under the full 40-spec suite (measured
        // 2026-09-03 from the trace-capture run's own network logs
        // across all specs, 4 parallel workers all sharing the runner
        // IP). Production installs never set this and continue at 100.
        //
        // The earlier value of 10000 was ~10x more than needed because
        // it was raised to accommodate the request-doubling bug (every
        // cooldown-hit page load fired every request un-authed, 401,
        // then retried) rather than fixing it. That bug is fixed in
        // the lazy-proactive-refresh commit (74f9213 in the PR history);
        // headroom is now sized to the actual traffic, with room for
        // ~2x suite growth before hitting the limit. If a future spec
        // burst blows it, tune deliberately with fresh trace evidence —
        // don't blanket-raise. See app.module.ts's
        // DEFAULT_THROTTLE_LIMIT block for the production default.
        DEFAULT_THROTTLE_LIMIT: '2000',
        // portal-auth (5 req / 5 min per IP) is exhausted by the full
        // suite: 5 portal logins across 5 specs (media-gallery×2,
        // rapid-reload-session×2, ticket-reply×1) hits the ceiling
        // exactly, so any Playwright retry firing a 6th login 429s and
        // cascades into unrelated spec failures. 50 = ~10x the observed
        // 5-login baseline. Still tight enough that a real brute-force
        // scenario in a portal-auth-focused test (e.g. account-lockout
        // testing) would fire well past 50 and hit the guard. Production
        // installs never set this and stay at 5 — the env var exists
        // ONLY to give the harness's parallel worker pool headroom
        // above the production per-IP ceiling. See app.module.ts's
        // PORTAL_AUTH_THROTTLE_LIMIT block for the prod default.
        PORTAL_AUTH_THROTTLE_LIMIT: '50',
        // NODE_ENV=production here is deliberate, not an oversight: the
        // Secure-cookie bug this harness's first scenario regression-tests
        // (CLAUDE.md "Secure cookies over plain HTTP") was NODE_ENV driving
        // the cookie's Secure flag instead of the real client scheme. This
        // API process is reached directly over plain HTTP (no reverse
        // proxy, no X-Forwarded-Proto), so req.secure is correctly false —
        // if a regression ever re-couples the Secure flag to NODE_ENV
        // instead of req.secure, this is exactly the condition that would
        // make it fail again.
      },
    },
    {
      // Production build by default, not `vite dev` — the dev server runs
      // React.StrictMode's double-effect-invocation, which used to race two
      // concurrent /auth/refresh calls on every page load (fixed in
      // AuthProvider/api.ts's refreshSession(), see CLAUDE.md). Real
      // installs serve exactly this built bundle via nginx, never the dev
      // server, so this is what the harness targets day to day.
      //
      // E2E_WEB_MODE=dev switches to `vite dev` instead — kept as a real,
      // reusable toggle (not a one-off hack) specifically so this harness
      // can prove a session-race fix on its own terms: green against BOTH
      // modes is what shows the race is actually fixed, not just avoided
      // by only ever testing the build that happens not to trigger it.
      command:
        process.env.E2E_WEB_MODE === 'dev'
          ? `pnpm --filter @openestate/web exec vite --port ${WEB_PORT} --strictPort`
          : `pnpm --filter @openestate/web exec vite build && pnpm --filter @openestate/web exec vite preview --port ${WEB_PORT} --strictPort`,
      cwd: '../..',
      url: WEB_URL,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_API_URL: API_URL,
      },
    },
    {
      // Dev mode, not the production build, unlike apps/web above:
      // apps/portal's vite.config.ts only sets base:'/portal/' for a real
      // `build` (production is served under nginx's /portal/ alias) — the
      // dev server stays at base '/'. Building it here would mean this
      // harness would additionally have to replicate that path-prefix
      // serving locally for no benefit, since the StrictMode double-effect
      // race this project cares about testing against a real build
      // (see apps/web's own comment) was already fixed as shared,
      // mirrored code and is already proven against apps/web in both
      // modes — there is nothing portal-build-specific left to prove here.
      // BrowserRouter's own basename="/portal" (apps/portal/src/App.tsx)
      // still applies in dev mode, so routes are under /portal/... either way.
      command: `pnpm --filter @openestate/portal exec vite --port ${PORTAL_PORT} --strictPort`,
      cwd: '../..',
      url: PORTAL_URL,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_API_URL: API_URL,
      },
    },
  ],
});
