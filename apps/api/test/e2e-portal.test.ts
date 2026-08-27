/**
 * THE REAL FIX — through-the-wire tests: real HTTP requests (via
 * supertest) against the FULLY bootstrapped Nest app — real Express, real
 * APP_GUARD chain (ThrottlerGuard -> JwtAuthGuard -> CsrfGuard ->
 * PermissionsGuard), real TenantContextInterceptor, real Postgres/Redis.
 * This is the only file in the whole suite that exercises the actual
 * pipeline order; every other test calls services/controllers directly,
 * which is exactly the gap that let TWO real bugs ship undetected through
 * 176 previously-passing tests (see CLAUDE.md Phase 6 commit 2
 * decisions):
 *
 *  1. TenantMiddleware/PortalTenantMiddleware ran as Express middleware,
 *     which executes BEFORE Nest guards, so req.user (set by
 *     JwtAuthGuard) never existed yet when they ran — every tenant-scoped
 *     portal read 500'd with "Tenant context required", first caught by
 *     manual browser click-through.
 *  2. After moving context-establishment into a Guard using
 *     AsyncLocalStorage.enterWith(), the SAME symptom resurfaced: a debug
 *     trace proved the store was undefined by the time a query ran inside
 *     prisma.$transaction()'s callback, even though the guard had called
 *     enterWith() moments earlier in the same request. Fixed by switching
 *     to a global INTERCEPTOR that wraps next.handle() inside
 *     runWithTenant() (AsyncLocalStorage.run()) — see
 *     TenantContextInterceptor's doc comment for why .run() survives that
 *     boundary and .enterWith() didn't.
 *
 * The "portal customer: login over HTTP then GET /portal/profile" test
 * below is this file's dedicated ORDERING regression test: it only
 * passes if context-establishment ran after JwtAuthGuard populated
 * req.user AND survives into the real Prisma transaction the profile
 * service opens. (The staff read test does NOT prove this — staff
 * services self-wrap their own tenant context independently of ambient
 * context, which is exactly how bug #1 stayed hidden for every staff
 * route across five prior phases.)
 *
 * Standing rule going forward (also in CLAUDE.md): every phase's test
 * additions must include at least one through-the-wire supertest per new
 * controller, because direct-call tests cannot prove pipeline behavior.
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
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import {
  makeClients,
  seedCompany,
  makeUnit,
  makeApplicant,
  makePortalRole,
  cleanupCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

// portal-auth's rate limit (5 req/5min per IP, Redis-backed) is shared
// globally across test files unless isolated — see e2e-portal-throttle
// .test.ts's doc comment for the original precedent. This file's own
// real portal logins were intermittently 429'd by e2e-broker-portal
// .test.ts's concurrent logins sharing the same default namespace
// (confirmed by a full-suite run, not hypothetical). Same fix, same
// reasoning.
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-portal-${process.pid}-${Date.now()}-`;

const STAFF_PASSWORD = 'StaffPass123';
const CUSTOMER_PASSWORD = 'CustomerPass123';

describeIf('Phase 6 e2e: real HTTP through the full guard pipeline', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;

  let staffEmail: string;
  let customerPhone: string; // applicant A (primary on bookingA)
  let coApplicantPhone: string; // applicant C, co-applicant on bookingA
  let unrelatedPhone: string; // applicant B, no connection to bookingA
  let applicantAId: string;
  let applicantCId: string;
  let bookingAId: string;
  let ticketCategoryId: string;

  beforeAll(async () => {
    // Same test Postgres/Redis every other file in this suite uses — set
    // explicitly here (rather than relying on apps/api/.env existing) for
    // CI portability, mirroring this suite's existing DATABASE_URL_TEST/
    // DATABASE_URL_TEST_SYSTEM/REDIS_TEST_URL convention.
    process.env.DATABASE_URL = APP_URL;
    process.env.DATABASE_URL_SYSTEM = SYSTEM_URL;
    process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
    process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'e2e-test-refresh-secret-0123456789';
    process.env.PAN_ENCRYPTION_KEY ??= 'a1b2c3d4'.repeat(8);
    process.env.TOTP_ENCRYPTION_KEY ??= 'e5f6a7b8'.repeat(8);
    process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'c9d8e7f6'.repeat(8)}`;
    process.env.CORS_ALLOWLIST ??= 'http://localhost:5174';
    process.env.SWAGGER_ENABLED = 'false';

    // Requires COMPILED dist/ (pnpm --filter @openestate/api build), not the
    // TS source — vitest's esbuild-based transform does not correctly emit
    // NestJS's design:paramtypes decorator metadata, so bootstrapping
    // AppModule from source under vitest fails DI resolution (surfaced as
    // "Cannot read properties of undefined (reading 'getOrThrow')" inside
    // TotpService, a ConfigService injection failure, followed by a native
    // crash in Nest's own error handler). The REAL compiled output — the
    // same dist/ `nest build`/main.ts actually ships — carries correct
    // Reflect.metadata calls regardless of how this TEST file is
    // transformed, since metadata correctness is a property of the file
    // where the @Injectable() class is defined, not its importers.
    const require = createRequire(import.meta.url);
    const { AppModule } = require('../dist/app.module');

    const nestApp = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
    // Mirrors main.ts's real bootstrap — cookieParser especially matters
    // here since CSRF/refresh cookies are exercised below.
    nestApp.use(helmet());
    nestApp.use(cookieParser());
    nestApp.setGlobalPrefix('api/v1');
    nestApp.useGlobalPipes(new ZodValidationPipe());
    await nestApp.init();
    app = nestApp;

    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    // Permission rows are global, not company-scoped — upsert is
    // idempotent and safe alongside other tests/seed runs.
    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    // Real staff role with real permissions attached — unlike
    // seedCompany()'s bare 'admin' role (no RolePermission rows), this
    // must pass the REAL PermissionsGuard, not a bypassed direct call.
    const staffRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Admin', slug: `e2e-admin-${Date.now()}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: ALL_PERMISSIONS.map((key) => ({ roleId: staffRole.id, permissionId: permByKey.get(key) })),
    });
    const tag = Date.now();
    staffEmail = `e2e-staff-${tag}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: staffEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Staff',
        roleId: staffRole.id,
        forcePasswordChange: false,
      },
    });

    // makePortalRole() creates the ROLE row only (it exists for
    // PortalAuthService's role-by-slug lookup in other tests, which never
    // go through PermissionsGuard) — a REAL guard-enforced test needs the
    // customer role's actual RolePermission rows attached too.
    const customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    const customerPermIds = ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]
      .map((key) => permByKey.get(key))
      .filter((id): id is string => !!id);
    await systemPrisma.rolePermission.createMany({
      data: customerPermIds.map((permissionId) => ({ roleId: customerRoleId, permissionId })),
    });

    applicantAId = await makeApplicant(systemPrisma, fx.companyId);
    const applicantBId = await makeApplicant(systemPrisma, fx.companyId);
    applicantCId = await makeApplicant(systemPrisma, fx.companyId);

    const applicantA = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantAId } });
    const applicantB = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantBId } });
    const applicantC = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantCId } });
    customerPhone = applicantA.primaryPhone;
    unrelatedPhone = applicantB.primaryPhone;
    coApplicantPhone = applicantC.primaryPhone;

    for (const [applId, phone, name] of [
      [applicantAId, applicantA.primaryPhone, applicantA.name],
      [applicantBId, applicantB.primaryPhone, applicantB.name],
      [applicantCId, applicantC.primaryPhone, applicantC.name],
    ] as const) {
      await systemPrisma.user.create({
        data: {
          companyId: fx.companyId,
          applicantId: applId,
          phone,
          name,
          passwordHash: await argon2.hash(CUSTOMER_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
          roleId: customerRoleId,
          forcePasswordChange: false,
        },
      });
    }

    const unitId = await makeUnit(systemPrisma, fx);
    const bookingA = await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId,
        primaryApplicantId: applicantAId,
        bookingNumber: `E2E-${tag}`,
        agreedPricePaise: BigInt(20_00_000_00),
        bookingDate: new Date('2026-06-01'),
      },
    });
    bookingAId = bookingA.id;
    await systemPrisma.bookingCoApplicant.create({
      data: { companyId: fx.companyId, bookingId: bookingAId, applicantId: applicantCId },
    });

    const category = await systemPrisma.ticketCategory.create({
      data: { companyId: fx.companyId, name: 'General Query' },
    });
    ticketCategoryId = category.id;
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string {
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
    for (const h of headers) {
      const match = new RegExp(`${name}=([^;]+)`).exec(h);
      if (match) return match[1];
    }
    throw new Error(`Cookie ${name} not found in Set-Cookie headers`);
  }

  /** Staff mutations need BOTH the Bearer token AND the double-submit CSRF
   * cookie/header pair — the agent carries the cookie automatically, this
   * just also captures its value to echo as X-CSRF-Token. */
  async function staffLoginWithCsrf() {
    const agent = request.agent(app.getHttpServer());
    const res = await agent
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: STAFF_PASSWORD })
      .expect(200);
    const csrf = extractCookie(res.headers['set-cookie'], 'openestate_csrf');
    return { agent, token: res.body.accessToken as string, csrf };
  }

  // Portal sessions are cached per identity and reused across tests within
  // this file (memoized on first login, not per-test) — the portal-auth
  // throttle bucket is a real 5-requests/5-minutes-per-IP security control
  // (see CLAUDE.md/portal-auth decisions), and supertest drives every
  // request in this suite from the same loopback IP. Tests that need "a
  // valid token/cookie jar for this identity" reuse the cached session;
  // only tests whose whole point IS the login call itself (the ordering
  // regression test, the CSRF-403 test) perform a login, and even those
  // are fine reusing a cached agent — the property under test (context
  // establishment, CSRF cookie/header matching) doesn't depend on the
  // login having *just* happened.
  const portalSessions = new Map<string, { agent: ReturnType<typeof request.agent>; token: string; csrf: string }>();

  async function portalSession(identifier: string) {
    const cached = portalSessions.get(identifier);
    if (cached) return cached;
    const agent = request.agent(app.getHttpServer());
    const res = await agent
      .post('/api/v1/portal/auth/login')
      .send({ identifier, password: CUSTOMER_PASSWORD })
      .expect(200);
    const csrf = extractCookie(res.headers['set-cookie'], 'openestate_portal_csrf');
    const session = { agent, token: res.body.accessToken as string, csrf };
    portalSessions.set(identifier, session);
    return session;
  }

  async function portalLogin(identifier: string): Promise<string> {
    return (await portalSession(identifier)).token;
  }

  it('staff: login over HTTP then a tenant-scoped read returns the seeded data', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: STAFF_PASSWORD })
      .expect(200);
    const token = login.body.accessToken as string;
    expect(token).toBeTruthy();

    const res = await request(app.getHttpServer())
      .get('/api/v1/applicants')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const ids = (res.body.data as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain(applicantAId);
  });

  it("ordering regression: portal customer login over HTTP then GET /portal/profile returns own data — the exact request that 500'd twice before this fix", async () => {
    const token = await portalLogin(customerPhone);

    // This is the file's dedicated pipeline-ordering proof. It only
    // returns 200 if BOTH hold: (a) TenantContextInterceptor runs after
    // JwtAuthGuard, so req.user is populated when it builds the store —
    // regressed by moving the interceptor before JwtAuthGuard, or by
    // reverting to Express middleware; and (b) the ambient context it
    // establishes actually survives into PortalProfileService's
    // withTenantTx()/prisma.$transaction() call — regressed by reverting
    // TenantContextInterceptor to a Guard using enterWith() instead of
    // wrapping next.handle() in runWithTenant()/.run(). Before this fix,
    // both failure modes 500'd with "Tenant context required for
    // Applicant.findFirstOrThrow" — reproduced first in a real browser,
    // not by any test (see CLAUDE.md Phase 6 commit 2 decisions).
    const res = await request(app.getHttpServer())
      .get('/api/v1/portal/profile')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.self.id).toBe(applicantAId);
    // Looked up by id, not by phone: makeApplicant()'s phone counter is
    // per-process (resets to 0 for each forked test FILE), so an unscoped
    // phone lookup can collide with an unrelated applicant from a
    // DIFFERENT company created by another test file running concurrently
    // under --pool=forks — caught by a real failure when this test ran as
    // part of the full suite, not in isolation.
    expect(res.body.coApplicants.map((a: { id: string }) => a.id)).toContain(applicantCId);
  });

  it('portal IDOR over HTTP: an unrelated customer cannot download a document from another booking; the co-applicant can', async () => {
    const { agent, token: staffToken, csrf } = await staffLoginWithCsrf();

    // Generate a real statement document for booking A through the actual
    // staff HTTP endpoint (not a direct service call) — a POST, so it
    // needs the CSRF header too, not just the Bearer token.
    const doc = await agent
      .post(`/api/v1/bookings/${bookingAId}/documents/statement`)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-CSRF-Token', csrf)
      .expect(201);
    const documentId = doc.body.id as string;

    const unrelatedToken = await portalLogin(unrelatedPhone);
    await request(app.getHttpServer())
      .get(`/api/v1/portal/account/documents/${documentId}/download`)
      .set('Authorization', `Bearer ${unrelatedToken}`)
      .expect(404);

    const coApplicantToken = await portalLogin(coApplicantPhone);
    await request(app.getHttpServer())
      .get(`/api/v1/portal/account/documents/${documentId}/download`)
      .set('Authorization', `Bearer ${coApplicantToken}`)
      .expect(200);
  });

  it('portal change-requests over HTTP: a valid submission is accepted; a payload carrying pan is rejected 400 at the validation boundary', async () => {
    const { agent, token, csrf } = await portalSession(customerPhone);

    // Whitelist proof: submitChangeRequestSchema's .strict() shape rejects
    // an unrecognized key (pan is deliberately NOT portal-editable — see
    // CLAUDE.md/portal.ts) at the ZodValidationPipe boundary, before the
    // request body ever reaches the controller — not a 200 with the field
    // silently ignored by a post-parse allowedFields.includes() loop.
    await agent
      .post('/api/v1/portal/profile/change-requests')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ email: 'new-email@example.com', pan: 'ABCDE1234F' })
      .expect(400);

    const res = await agent
      .post('/api/v1/portal/profile/change-requests')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ email: 'new-email@example.com' })
      .expect(201);

    expect(res.body.status).toBe('PENDING');
    expect(res.body.applicantId).toBe(applicantAId);
  });

  it('portal tickets over HTTP: a customer can raise a ticket and read it back; an unrelated customer cannot', async () => {
    const { agent, token, csrf } = await portalSession(customerPhone);

    const created = await agent
      .post('/api/v1/portal/tickets')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ categoryId: ticketCategoryId, subject: 'Leak in bathroom', body: 'Please send a plumber.' })
      .expect(201);
    const ticketId = created.body.id as string;

    const mine = await request(app.getHttpServer())
      .get('/api/v1/portal/tickets')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((mine.body as Array<{ id: string }>).map((t) => t.id)).toContain(ticketId);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/portal/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body.subject).toBe('Leak in bathroom');

    const unrelatedToken = await portalLogin(unrelatedPhone);
    await request(app.getHttpServer())
      .get(`/api/v1/portal/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${unrelatedToken}`)
      .expect(404);
  });

  it('CSRF over HTTP: a portal POST without the CSRF header is rejected with 403', async () => {
    // Reuses the cached customerPhone session (same portal-auth throttle
    // budget concern as the other tests below) — the property under test
    // (CsrfGuard rejecting a cookie/no-header mismatch) doesn't depend on
    // the login having *just* happened, only on the agent's cookie jar
    // carrying a real portal CSRF cookie.
    const { agent, token } = await portalSession(customerPhone);

    // The agent carries the portal CSRF/refresh cookies set by login
    // automatically on subsequent requests — but this request deliberately
    // never echoes the cookie value back as the X-CSRF-Token header.
    await agent
      .post('/api/v1/portal/profile/change-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new-email@example.com' })
      .expect(403);
  });
});
