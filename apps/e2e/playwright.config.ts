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

// Same disposable Postgres/Redis this project's own backend integration
// tests use (scripts/test-setup.sh / deploy/docker-compose.test.yml) —
// precondition, not started here. Exported so global-setup.ts's own
// fixture-seed script (which runs as this same Node process, not a
// webServer child) connects to the identical database.
export const DATABASE_URL_SYSTEM =
  'postgresql://openestate_system:test_system_pass@localhost:5433/openestate_test';
const DATABASE_URL_APP =
  'postgresql://openestate_app:test_app_pass@localhost:5433/openestate_test';
const REDIS_URL = 'redis://localhost:6380';

// Not real secrets — throwaway key material for a disposable test database
// that gets torn down after every run. Fixed (not randomly generated per
// run) so a crashed run's leftover DB state stays decryptable on a rerun.
// Must be valid hex (0-9a-f only) at exactly 64 chars = 32 bytes — several
// services (PanEncryptionService, TotpService) throw at boot otherwise.
const HARNESS_HEX_KEY = 'ab'.repeat(32);

export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // tests share one seeded fixture company; keep runs serial and simple
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
