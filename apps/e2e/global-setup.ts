import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedE2eFixture } from './fixtures/seed';
import { DATABASE_URL_SYSTEM } from './playwright.config';

// Runs once before any spec. Precondition (not started here, matching
// apps/api's own vitest.config.ts contract): the disposable test Postgres
// + Redis are already up — `bash scripts/test-setup.sh` from the repo
// root. Seeds one fixture company directly via Prisma (see fixtures/seed.ts
// for why this doesn't import apps/api's or packages/db's own test/seed
// helpers directly) and writes it to a JSON file the spec files read —
// simpler and more explicit than relying on env var propagation into
// Playwright's worker processes.
//
// One independent company+admin PER SCENARIO, not one shared across all
// four — auth-2fa.spec.ts changes its admin's password and enables 2FA
// as part of what it's testing, which would break the others if they
// ever ran after it against the same account. Isolated fixtures make the
// specs order-independent and safely parallelizable later, matching how
// every backend test file in this project seeds its own company rather
// than sharing one.
export default async function globalSetup() {
  const fixtures = {
    authTwoFactor: await seedE2eFixture(DATABASE_URL_SYSTEM, { forcePasswordChange: true }),
    mastersCrud: await seedE2eFixture(DATABASE_URL_SYSTEM),
    chequeBounce: await seedE2eFixture(DATABASE_URL_SYSTEM),
    plcBooking: await seedE2eFixture(DATABASE_URL_SYSTEM, { withPricingMasters: true }),
  };
  writeFileSync(path.join(__dirname, '.fixture-state.json'), JSON.stringify(fixtures, null, 2));
}
