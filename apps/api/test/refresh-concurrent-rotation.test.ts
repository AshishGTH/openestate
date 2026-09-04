/**
 * Regression coverage for the concurrent-refresh race in
 * TokenService.rotateRefreshToken (CLAUDE.md's E2E refresh-rotation
 * cascade Decisions entry).
 *
 * The bug: rotateRefreshToken does findFirst → rotateRow (UPDATE +
 * INSERT), each in its own auto-committed statement — no interactive
 * transaction, no row lock. Two exactly-concurrent callers with the
 * same cookie can race between the winner's UPDATE (marks the token
 * revoked) and INSERT (creates the successor). The loser lands
 * squarely in the window:
 *   - reads the token as isRevoked=true, revokedAgoMs within grace
 *   - queries for the family's live successor → finds NONE (winner
 *     hasn't INSERTed yet)
 *   - falls through to revokeFamilyById + returns null → 401
 * Symptom: a legitimate rapid-navigation or multi-tab burst → 401 →
 * user parked on /login for no visible reason.
 *
 * A separate but related mode (loser reads BEFORE winner's UPDATE
 * commits): both find the token live, both do their own rotateRow,
 * both INSERT new tokens for the same family. Both return 200 to
 * their callers, but only ONE of the new tokens ever reaches the
 * client's cookie jar; the other is orphaned. Family now has TWO live
 * tokens for one legitimate session — reuse-detection is defeated
 * for exactly the theft-detection scenario it was built to catch.
 *
 * The fix: wrap the whole function in one interactive $transaction
 * with $queryRaw SELECT ... FOR UPDATE at the top, serializing
 * concurrent callers. AND switch the grace path from
 * ROTATE-THE-SUCCESSOR (current behaviour, produces cookie ambiguity
 * across N concurrent callers who each get a DIFFERENT rotated
 * token) to REPLAY-THE-EXISTING-SUCCESSOR (standard OAuth 2.0
 * rotation-with-reuse-detection pattern — deterministic cookie:
 * N concurrent callers on one token get ONE rotation + N-1 replays
 * of the same successor).
 *
 * Invariants asserted here are OUTCOMES, not timings. A race test that
 * "usually reproduces" is worthless as a gate because it goes green
 * for the same reason the bug survives. These invariants must hold on
 * every burst — not most bursts, every one:
 *   (1) Every response returns 200. No 401.
 *   (2) The family contains exactly ONE live refresh_token row after
 *       the burst (the rotated successor).
 *   (3a) All N responses in a burst carry the SAME newly-issued raw
 *        refresh token — proves the REPLAY semantics of the grace
 *        path (1 rotation + N-1 replays, not N chained rotations).
 *   (3b) Exactly ONE new refresh_token row was created in the family
 *        during the burst — proves rotation happened ONCE, not N
 *        times, and no orphaned successors were left in the DB.
 *
 * K cycles per endpoint: each burst extracts the shared new cookie
 * value from the responses and uses it as the cookie for the next
 * burst. Proves both replay-correctness WITHIN a burst AND
 * forward-progress ACROSS bursts (the client's chain converges).
 *
 * Both endpoints exercised — staff /auth/refresh and portal
 * /portal/auth/refresh — because TokenService is SHARED, not
 * mirrored (portal-auth.service.ts:14 imports it directly from
 * ../auth/token.service). One fix, both endpoints benefit; both must
 * be covered.
 *
 * Throttle: both refresh endpoints are @Public() with no
 * @UseGuards(ThrottlerGuard) decorator, so both fall under the
 * DEFAULT bucket (see app.module.ts's ThrottlerModule.forRoot). Not
 * the portal-auth bucket (which gates /portal/auth/login only, not
 * refresh). Under apps/api/vitest.config.ts's
 * DEFAULT_THROTTLE_LIMIT=2000 override, N=5 × K=20 × 2 endpoints ≈
 * 200 refresh requests per file run — well inside 2000/60s.
 *
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM + Redis, plus
 * a fresh `pnpm --filter @openestate/api build` (see
 * e2e-portal-throttle.test.ts's doc comment for why the compiled
 * dist/ is required, not TS source).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import { makeClients, seedCompany, makePortalRole, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const CUSTOMER_PASSWORD = 'CustomerPass123';

// N = concurrent refreshes per burst. K = bursts per endpoint.
// Pre-fix reproduces reliably at N=5 K=20 (200 refresh calls total per
// endpoint under exact-microsecond Promise.all concurrency). If commit-N
// CI shows the test passing on pre-fix code, raise N or K until it
// reliably fails — the whole point of measuring this in CI is that a
// silent-green pre-fix test is a broken gate. Report the observed
// iteration count from commit-N's log in CLAUDE.md when the fix lands.
const N = 5;
const K = 20;

// Isolate this file's throttle-bucket state in Redis from every OTHER
// integration-test file that shares the same default namespace (same
// pattern as e2e-portal-throttle.test.ts). Per-file PID + timestamp,
// set at module load so bootstrapApp picks it up in RedisThrottlerStorage.
process.env.THROTTLE_TEST_KEY_PREFIX = `refresh-rotation-${process.pid}-${Date.now()}-`;

async function bootstrapApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = APP_URL;
  process.env.DATABASE_URL_SYSTEM = SYSTEM_URL;
  process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
  process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-0123456789';
  process.env.JWT_REFRESH_SECRET ??= 'e2e-test-refresh-secret-0123456789';
  process.env.PAN_ENCRYPTION_KEY ??= 'a1b2c3d4'.repeat(8);
  process.env.TOTP_ENCRYPTION_KEY ??= 'e5f6a7b8'.repeat(8);
  process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'c9d8e7f6'.repeat(8)}`;
  process.env.CORS_ALLOWLIST ??= 'http://localhost:5173';
  process.env.SWAGGER_ENABLED = 'false';

  const require = createRequire(import.meta.url);
  const { AppModule } = require('../dist/app.module');

  const nestApp = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  nestApp.use(helmet());
  nestApp.use(cookieParser());
  nestApp.setGlobalPrefix('api/v1');
  nestApp.useGlobalPipes(new ZodValidationPipe());
  await nestApp.init();
  return nestApp;
}

/** Extract a specific cookie value from a supertest response's Set-Cookie header. */
function extractCookie(res: request.Response, cookieName: string): string {
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const raw of cookies) {
    const m = raw.match(new RegExp(`^${cookieName}=([^;]+)`));
    if (m) return m[1];
  }
  throw new Error(`Cookie "${cookieName}" not found in Set-Cookie: ${JSON.stringify(cookies)}`);
}

describeIf('TokenService.rotateRefreshToken — N concurrent refreshes on one cookie', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let staffEmail: string;
  let staffUserId: string;
  let customerPhone: string;
  let customerUserId: string;

  beforeAll(async () => {
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    // seedCompany creates the admin user with passwordHash: 'x' (a
    // placeholder — no real password) and email like 'fin-<tag>@test'
    // which is not a valid @email.() format the login DTO would accept.
    // Fix both: real hash for a known password, and a plausible email.
    const staffUser = await systemPrisma.user.findFirst({
      where: { companyId: fx.companyId, applicantId: null, brokerId: null },
    });
    staffEmail = `refresh-staff-${Date.now()}@openestate.test`;
    staffUserId = staffUser.id;
    await systemPrisma.user.update({
      where: { id: staffUserId },
      data: {
        email: staffEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
      },
    });

    // Portal customer — same makePortalRole + user pattern as
    // e2e-portal-throttle.test.ts. High-entropy phone avoids collision
    // with any other test file's applicant fixtures under vitest
    // parallelism (CLAUDE.md Phase 6 commit 4's collision note).
    const customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    customerPhone = `9${Date.now()}${Math.floor(Math.random() * 10_000)}`.slice(0, 15);
    const applicant = await systemPrisma.applicant.create({
      data: {
        companyId: fx.companyId,
        name: 'RefreshRotation Customer',
        primaryPhone: customerPhone,
        primaryPhoneNormalized: customerPhone,
      },
    });
    const customer = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        applicantId: applicant.id,
        phone: customerPhone,
        name: 'RefreshRotation Customer',
        passwordHash: await argon2.hash(CUSTOMER_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        roleId: customerRoleId,
        forcePasswordChange: false,
      },
    });
    customerUserId = customer.id;

    app = await bootstrapApp();
  });

  afterAll(async () => {
    await app?.close();
    // RefreshToken has onDelete: Cascade on its userId FK
    // (schema.prisma:232), so cleanupCompany's user delete implicitly
    // drops every refresh_token this test created.
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  /**
   * Drives K bursts of N concurrent refreshes for one endpoint. Each
   * burst extracts the winner's rotated cookie and carries it into the
   * next burst — proving both replay-correctness within a burst and
   * forward-progress across bursts.
   *
   * Fails on the FIRST burst that violates any invariant, reporting
   * which cycle and which invariant broke — this is what commit-N
   * (test-only, pre-fix) will surface in the CI log so we can measure
   * how quickly the pre-fix race actually fires.
   */
  async function runBursts(
    endpoint: string,
    initialCookie: string,
    cookieName: string,
    userId: string,
  ): Promise<void> {
    let currentCookie = initialCookie;

    for (let cycle = 0; cycle < K; cycle++) {
      // Baseline for invariant (3b): total row count in this user's
      // refresh_tokens BEFORE the burst. After a correct burst, exactly
      // ONE new row exists (the successor) and the old one is now
      // revoked, so total delta === 1.
      const preBurstTotal = await systemPrisma.refreshToken.count({ where: { userId } });

      // The race trigger: N concurrent POSTs with the same cookie via
      // Promise.all. Under Node's http.Agent defaults these fire
      // near-simultaneously — pre-fix, they reliably interleave inside
      // the winner's UPDATE→INSERT window.
      const responses = await Promise.all(
        Array.from({ length: N }, () =>
          request(app.getHttpServer()).post(endpoint).set('Cookie', `${cookieName}=${currentCookie}`),
        ),
      );

      // Invariant (1): every response 200. No 401. Report every failure
      // in the burst, not just the first, so the CI log tells us what
      // fraction of concurrent callers lost the race.
      const statuses = responses.map((r) => r.status);
      const non200 = statuses.map((s, i) => ({ s, i })).filter(({ s }) => s !== 200);
      expect(
        non200,
        `cycle=${cycle} endpoint=${endpoint}: expected all ${N} responses to return 200, but got non-200 at indexes [${non200
          .map(({ i, s }) => `${i}=${s}`)
          .join(', ')}] — full statuses: [${statuses.join(', ')}]`,
      ).toEqual([]);

      // Invariant (3a): all N responses carry the SAME new refresh
      // cookie. Under REPLAY semantics: 1 rotation + N-1 replays →
      // every caller sees the SAME successor token. If we see distinct
      // cookies, the grace path is CHAINING (each replay rotates the
      // successor again) — the fix's grace-path change failed.
      const newCookies = responses.map((r) => extractCookie(r, cookieName));
      const uniqueCookies = new Set(newCookies);
      expect(
        uniqueCookies.size,
        `cycle=${cycle} endpoint=${endpoint}: expected all ${N} responses to carry the SAME rotated cookie (REPLAY semantics), but got ${uniqueCookies.size} distinct token values — first 8 chars each: ${[
          ...uniqueCookies,
        ]
          .map((c) => c.slice(0, 8))
          .join(', ')}`,
      ).toBe(1);

      // Invariant (2) and (3b) combined: exactly ONE new row was
      // inserted, so the total for this user grew by exactly 1. Under
      // the pre-fix race with no INSERT-time coordination, each of N
      // concurrent callers would INSERT its own new row (total delta =
      // N). Under the pure grace-only failure mode (loser 401s), delta
      // is 1 but (1) already failed. Under the fix, exactly one
      // rotation → exactly one new row.
      const postBurstTotal = await systemPrisma.refreshToken.count({ where: { userId } });
      expect(
        postBurstTotal - preBurstTotal,
        `cycle=${cycle} endpoint=${endpoint}: expected exactly 1 new refresh_token row after the burst (baseline=${preBurstTotal}, post=${postBurstTotal}, delta=${postBurstTotal - preBurstTotal})`,
      ).toBe(1);

      // Invariant (2): exactly ONE live row across the user's family
      // now — the just-inserted successor. The old cookie's row is
      // revoked. If we see > 1 live, an orphaned successor from the
      // pre-fix "both readers see live" case is present, defeating
      // reuse detection for the theft scenario the family model exists
      // to catch.
      const postBurstLive = await systemPrisma.refreshToken.count({
        where: { userId, isRevoked: false },
      });
      expect(
        postBurstLive,
        `cycle=${cycle} endpoint=${endpoint}: expected exactly 1 live refresh_token in the user's family after the burst, found ${postBurstLive}`,
      ).toBe(1);

      // Carry the winner's cookie into the next burst. Because all N
      // callers should have returned the same cookie (invariant 3a),
      // any element of newCookies works.
      currentCookie = newCookies[0];
    }
  }

  it(`staff /auth/refresh: N=${N} concurrent × K=${K} bursts remain replay-safe`, async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: STAFF_PASSWORD });
    expect(loginRes.status, `staff login must succeed as a precondition; got ${loginRes.status}: ${JSON.stringify(loginRes.body)}`).toBe(200);
    const initialCookie = extractCookie(loginRes, 'openestate_refresh');

    await runBursts('/api/v1/auth/refresh', initialCookie, 'openestate_refresh', staffUserId);
  });

  it(`portal /portal/auth/refresh: N=${N} concurrent × K=${K} bursts remain replay-safe`, async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/portal/auth/login')
      .send({ identifier: customerPhone, password: CUSTOMER_PASSWORD });
    expect(loginRes.status, `portal login must succeed as a precondition; got ${loginRes.status}: ${JSON.stringify(loginRes.body)}`).toBe(200);
    const initialCookie = extractCookie(loginRes, 'openestate_portal_refresh');

    await runBursts('/api/v1/portal/auth/refresh', initialCookie, 'openestate_portal_refresh', customerUserId);
  });
});
