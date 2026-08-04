import { defineConfig } from '@playwright/test';

// Dedicated ports, distinct from a developer's own `pnpm dev` (api:3000,
// web:5173) so this harness can run alongside a normal dev session
// without port conflicts.
const API_PORT = 3900;
const WEB_PORT = 5273;
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

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
        CORS_ALLOWLIST: WEB_URL,
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
      // A production build, not `vite dev` — deliberately. The dev server
      // runs React.StrictMode's double-effect-invocation, which races two
      // concurrent /auth/refresh calls on every page load; if the losing
      // (failed) one resolves after the winning one, its catch() handler
      // stomps the just-set user state back to logged-out. That's a
      // dev-mode-only React artifact — real installs serve exactly this
      // built bundle via nginx, never the dev server — so testing against
      // it here would make the harness chase a false positive instead of
      // reproducing what a real user hits. VITE_API_URL is inlined at
      // build time, so it must be set here, not just at preview time.
      command: `pnpm --filter @openestate/web exec vite build && pnpm --filter @openestate/web exec vite preview --port ${WEB_PORT} --strictPort`,
      cwd: '../..',
      url: WEB_URL,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_API_URL: API_URL,
      },
    },
  ],
});
