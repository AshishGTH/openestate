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
 *   (3) Exactly ONE response in the burst carries a Set-Cookie for the
 *       refresh cookie; the other N-1 carry NONE. Proves the E5 REPLAY
 *       design — losers stay silent on cookies, winner's Set-Cookie
 *       reaches the browser, client's jar converges deterministically
 *       regardless of response-arrival order.
 *   (4) Exactly ONE new refresh_token row created in the family per
 *       burst — proves the rotation happened ONCE (not N times), and
 *       no orphaned successors were left in the DB.
 *   (5) K-cycle forward progress: the previous cycle's cookie's row
 *       is REVOKED after this burst, and this burst produced a NEW
 *       live row. Proves each cycle advances rather than sticking on
 *       the same token or replaying a stuck successor.
 *
 * K cycles per endpoint: each burst extracts the winner's Set-Cookie
 * value from the sole response carrying one, and uses it as the cookie
 * for the next burst. Proves both replay-correctness WITHIN a burst
 * AND forward-progress ACROSS bursts (the client's chain converges
 * and advances).
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
import { createHash } from 'node:crypto';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import { makeClients, seedCompany, makePortalRole, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

// Matches TokenService's private hashToken — SHA-256 hex. Used to look up
// refresh_token rows by their raw value in invariant (5)'s forward-progress
// check, since only the hash is stored server-side.
const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

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
    const currentCookieHash = () => hashToken(currentCookie);

    for (let cycle = 0; cycle < K; cycle++) {
      // Baseline for invariants (4) and (5): total row count for this
      // user's refresh_tokens BEFORE the burst.
      const preBurstTotal = await systemPrisma.refreshToken.count({ where: { userId } });

      // The race trigger: N concurrent POSTs with the same cookie via
      // Promise.all. Under Node's http.Agent defaults these fire
      // near-simultaneously — pre-fix, they reliably interleave inside
      // the winner's UPDATE→INSERT window (measurement pre-fix on
      // cycle=0: 1/5 staff, 2/5 portal, from run 33915421187).
      const responses = await Promise.all(
        Array.from({ length: N }, () =>
          request(app.getHttpServer()).post(endpoint).set('Cookie', `${cookieName}=${currentCookie}`),
        ),
      );

      // Invariant (1): every response 200. No 401. Report every failure
      // in the burst so the CI log names exactly which requests lost
      // and what fraction.
      const statuses = responses.map((r) => r.status);
      const non200 = statuses.map((s, i) => ({ s, i })).filter(({ s }) => s !== 200);
      expect(
        non200,
        `cycle=${cycle} endpoint=${endpoint}: expected all ${N} responses to return 200, but got non-200 at indexes [${non200
          .map(({ i, s }) => `${i}=${s}`)
          .join(', ')}] — full statuses: [${statuses.join(', ')}]`,
      ).toEqual([]);

      // Invariant (3): exactly ONE response carries a Set-Cookie for
      // the refresh cookie name; the other N-1 stay silent. Proves E5's
      // winner/loser split — the winner rotates and sets a new cookie,
      // losers mint an access token from userId but leave cookies alone.
      // If more than one response carries Set-Cookie, the fix's
      // discriminated-result design failed (either TokenService
      // returned kind: 'rotated' for a loser, or the controller ignored
      // kind and set the cookie unconditionally). If zero carry it,
      // the winner also skipped — the fix's rotation path failed.
      const withRefreshCookie = responses.map((r, i) => {
        const setCookie = r.headers['set-cookie'];
        const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
        return { i, hasIt: cookies.some((c) => c.startsWith(`${cookieName}=`)) };
      });
      const winnerIdxs = withRefreshCookie.filter((r) => r.hasIt).map((r) => r.i);
      expect(
        winnerIdxs.length,
        `cycle=${cycle} endpoint=${endpoint}: expected exactly 1 response to carry Set-Cookie ${cookieName}=..., got ${winnerIdxs.length} at indexes [${winnerIdxs.join(', ')}]`,
      ).toBe(1);
      const winnerIdx = winnerIdxs[0];

      // Invariant (4): exactly ONE new refresh_token row was created
      // during the burst — proves the ROTATION happened once, not N
      // times. Under pre-fix code with no INSERT-time coordination,
      // each of N concurrent callers INSERTs its own new row (delta = N).
      // Under FOR UPDATE serialization + CHAIN grace (E3/E4, rejected),
      // delta = N sequential rotations. Under E5, delta = 1.
      const postBurstTotal = await systemPrisma.refreshToken.count({ where: { userId } });
      expect(
        postBurstTotal - preBurstTotal,
        `cycle=${cycle} endpoint=${endpoint}: expected exactly 1 new refresh_token row after the burst (baseline=${preBurstTotal}, post=${postBurstTotal}, delta=${postBurstTotal - preBurstTotal})`,
      ).toBe(1);

      // Invariant (2): exactly ONE live row for this user now — the
      // just-inserted successor. Old cookie's row is revoked. > 1 live
      // means an orphaned successor from the pre-fix "both readers see
      // live" case is present, defeating reuse-detection for the theft
      // scenario the family model exists to catch.
      const postBurstLive = await systemPrisma.refreshToken.count({
        where: { userId, isRevoked: false },
      });
      expect(
        postBurstLive,
        `cycle=${cycle} endpoint=${endpoint}: expected exactly 1 live refresh_token in the user's family after the burst, found ${postBurstLive}`,
      ).toBe(1);

      // Invariant (5) part A: the CURRENT cookie's row (the one all N
      // callers presented) is now REVOKED. Proves the winner actually
      // consumed the ancestor rather than replaying without rotating.
      const consumedRow = await systemPrisma.refreshToken.findFirst({
        where: { tokenHash: currentCookieHash() },
      });
      expect(
        consumedRow,
        `cycle=${cycle} endpoint=${endpoint}: expected the presented cookie's row to still exist in DB after the burst (revoked but not deleted); it was missing`,
      ).not.toBeNull();
      expect(
        consumedRow?.isRevoked,
        `cycle=${cycle} endpoint=${endpoint}: expected the presented cookie's row to be revoked after the burst (winner consumed it); it is still live`,
      ).toBe(true);

      // Winner's Set-Cookie value = the new cookie for next burst.
      const nextCookie = extractCookie(responses[winnerIdx], cookieName);

      // Invariant (5) part B: this burst produced a NEW live row —
      // the successor from the winner's Set-Cookie. Look it up by hash
      // to prove the wire value the client received matches the row
      // the DB has.
      const newLiveRow = await systemPrisma.refreshToken.findFirst({
        where: { tokenHash: hashToken(nextCookie) },
      });
      expect(
        newLiveRow,
        `cycle=${cycle} endpoint=${endpoint}: expected the winner's Set-Cookie value to correspond to a real refresh_token row in DB; no matching row found`,
      ).not.toBeNull();
      expect(
        newLiveRow?.isRevoked,
        `cycle=${cycle} endpoint=${endpoint}: expected the winner's new cookie's row to be LIVE (the just-rotated successor); it is revoked`,
      ).toBe(false);

      // Carry into next burst — this proves forward progress across K
      // cycles (each cycle consumes the previous cycle's successor).
      currentCookie = nextCookie;
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
