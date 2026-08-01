/**
 * Through-the-wire CSRF coverage — real HTTP, real CsrfGuard, real cookie
 * rotation. Regression tests for a blocking production bug: a mutation
 * right after an access-token refresh 403'd with "CSRF token mismatch"
 * (not missing — mismatch), reproduced on the VM creating a role via
 * Admin -> Roles.
 *
 * Root cause: /auth/refresh (and /portal/auth/refresh) issue a brand new
 * CSRF cookie on every call (see setCsrfCookie() in auth.controller.ts —
 * a fresh crypto.randomUUID() each time, by design, standard double-submit
 * rotation). apps/web's and apps/portal's `api()` client transparently
 * retries a 401 (expired access token) by calling refresh() and retrying
 * the original request — but it only updated the Authorization header on
 * the retry, never re-reading the CSRF cookie that refresh() had just
 * rotated. The retry sent a real, well-formed, but STALE X-CSRF-Token
 * that no longer matched the now-rotated cookie: a genuine mismatch, not
 * an absent token, which is exactly why the toast surfaced a specific
 * "CSRF token mismatch" error instead of a generic auth failure. Fixed
 * in apps/web/src/lib/api.ts and apps/portal/src/lib/api.ts by re-reading
 * the cookie after a successful refresh, before retrying.
 *
 * These tests exercise the server side of that contract directly (the
 * actual client-side retry bug lived in frontend fetch code this suite
 * has no harness for — see CLAUDE.md): that a stale pre-rotation CSRF
 * token is correctly rejected as a mismatch (proving the fix's premise),
 * and that a freshly-read post-rotation token is correctly accepted
 * (proving the fix itself, simulated the way the corrected client now
 * behaves). Also covers the second bug this investigation found: the
 * portal login 2FA-pending branch had the identical missing-CSRF-cookie
 * defect fixed on the staff side last session, never fixed on the portal
 * side — every 2FA-enabled portal account was locked out the same way.
 *
 * Requires the compiled dist/ — see e2e-portal.test.ts for why.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import {
  makeClients,
  seedCompany,
  makeApplicant,
  makePortalRole,
  cleanupCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const CUSTOMER_PASSWORD = 'CustomerPass123';
const TAG = Date.now();

// portal-auth's rate limit is 5 requests/5min PER IP, Redis-backed and
// shared globally (not per test-file) unless isolated — every request in
// this suite runs from the same loopback IP. This file does 2 real
// portal logins; e2e-portal-throttle.test.ts's own doc comment already
// documents that e2e-portal/e2e-broker-portal/portal-csrf-guard sharing
// the default namespace was judged "harmless" only because none of them
// assert exact counts and their combined volume stayed under 5 — adding
// this file's calls to that same shared budget is exactly what tipped it
// over in practice (confirmed: 429s appeared on unrelated files in a
// full-suite run once this file existed without its own prefix). Same
// fix as that file: a private, per-process key prefix.
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-csrf-refresh-${process.pid}-${Date.now()}-`;

async function bootstrapApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = APP_URL;
  process.env.DATABASE_URL_SYSTEM = SYSTEM_URL;
  process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6380';
  process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-0123456789';
  process.env.JWT_REFRESH_SECRET ??= 'e2e-test-refresh-secret-0123456789';
  process.env.PAN_ENCRYPTION_KEY ??= 'a1b2c3d4'.repeat(8);
  process.env.TOTP_ENCRYPTION_KEY ??= 'e5f6a7b8'.repeat(8);
  process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'c9d8e7f6'.repeat(8)}`;
  process.env.CORS_ALLOWLIST ??= 'http://localhost:5174';
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

// RFC 6238, matching TotpService exactly: SHA1, 6 digits, 30s period.
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of input.replace(/=+$/, '').toUpperCase()) {
    const val = alphabet.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpCode(secretBase32: string): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
  for (const h of headers) {
    const match = new RegExp(`${name}=([^;]+)`).exec(h);
    if (match) return match[1];
  }
  return undefined;
}

describeIf('e2e CSRF token rotation: real HTTP, real CsrfGuard, real cookie rotation', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let staffEmail: string;
  let onePermissionId: string;
  let customerPhone: string;
  let ticketCategoryId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));
    onePermissionId = permByKey.get(PERMISSIONS.ADMIN_MASTER_READ) as string;

    const staffRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E CSRF Staff', slug: `e2e-csrf-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: ALL_PERMISSIONS.map((key) => ({ roleId: staffRole.id, permissionId: permByKey.get(key) })),
    });
    staffEmail = `e2e-csrf-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: staffEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E CSRF Staff',
        roleId: staffRole.id,
        forcePasswordChange: false,
      },
    });

    // Portal customer, for the portal-side 2FA-login-then-mutation test.
    const customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    const customerPermIds = ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]
      .map((key) => permByKey.get(key))
      .filter((id): id is string => !!id);
    await systemPrisma.rolePermission.createMany({
      data: customerPermIds.map((permissionId) => ({ roleId: customerRoleId, permissionId })),
    });
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const applicant = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } });
    customerPhone = applicant.primaryPhone;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        applicantId,
        phone: customerPhone,
        name: applicant.name,
        passwordHash: await argon2.hash(CUSTOMER_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        roleId: customerRoleId,
        forcePasswordChange: false,
      },
    });

    const category = await systemPrisma.ticketCategory.create({
      data: { companyId: fx.companyId, name: 'E2E CSRF Category' },
    });
    ticketCategoryId = category.id;
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  async function staffLogin() {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email: staffEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(res.headers['set-cookie'], 'openestate_csrf')!;
    return { agent, token: res.body.accessToken as string, csrf };
  }

  function createRolePayload(suffix: string) {
    // createRoleSchema's slug must match ^[a-z][a-z0-9_]*$ — no hyphens.
    const slugSuffix = suffix.replace(/-/g, '_');
    return { name: `E2E CSRF Role ${suffix}`, slug: `e2e_csrf_role_${TAG}_${slugSuffix}`, permissionIds: [onePermissionId] };
  }

  it('mutation immediately after login succeeds', async () => {
    const { agent, token, csrf } = await staffLogin();
    await agent
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send(createRolePayload('login'))
      .expect(201);
  });

  it('a genuinely wrong CSRF token is rejected (mismatch, not missing)', async () => {
    const { agent, token } = await staffLogin();
    await agent
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', 'not-the-real-token')
      .send(createRolePayload('wrong'))
      .expect(403);
  });

  it('a missing CSRF header is rejected', async () => {
    const { agent, token } = await staffLogin();
    await agent
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      // No X-CSRF-Token at all.
      .send(createRolePayload('missing'))
      .expect(403);
  });

  it('regression: after a token refresh, the OLD pre-rotation CSRF token is rejected as a mismatch (this was the bug — the client kept sending it)', async () => {
    const { agent, token: firstToken, csrf: staleCsrf } = await staffLogin();

    // Refresh rotates the CSRF cookie to a brand new value (see
    // setCsrfCookie() — a fresh crypto.randomUUID() on every call).
    const refreshRes = await agent.post('/api/v1/auth/refresh').expect(200);
    const rotatedCsrf = extractCookie(refreshRes.headers['set-cookie'], 'openestate_csrf')!;
    expect(rotatedCsrf).not.toBe(staleCsrf);

    // This is exactly what the buggy client sent: a valid new access
    // token (from the refresh), but the CSRF header from BEFORE the
    // refresh happened. Real, well-formed, just stale — a mismatch, not
    // an absent token.
    await agent
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${refreshRes.body.accessToken}`)
      .set('X-CSRF-Token', staleCsrf)
      .send(createRolePayload('stale-post-refresh'))
      .expect(403);

    void firstToken;
  });

  it('regression: after a token refresh, mutating with the NEWLY ROTATED CSRF token succeeds (the fix)', async () => {
    const { agent } = await staffLogin();
    const refreshRes = await agent.post('/api/v1/auth/refresh').expect(200);
    const rotatedCsrf = extractCookie(refreshRes.headers['set-cookie'], 'openestate_csrf')!;

    await agent
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${refreshRes.body.accessToken}`)
      .set('X-CSRF-Token', rotatedCsrf)
      .send(createRolePayload('fresh-post-refresh'))
      .expect(201);
  });

  it('mutation after a staff 2FA login succeeds', async () => {
    const { agent, token, csrf } = await staffLogin();
    const setup = await agent
      .post('/api/v1/auth/totp/setup')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(200);
    await agent
      .post('/api/v1/auth/totp/confirm')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ code: totpCode(setup.body.secret) })
      .expect(200);

    // Fresh login now requires 2FA.
    const loginAgent = request.agent(app.getHttpServer());
    const loginRes = await loginAgent.post('/api/v1/auth/login').send({ email: staffEmail, password: STAFF_PASSWORD }).expect(200);
    expect(loginRes.body.requiresTwoFactor).toBe(true);
    const twoFaCsrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf')!;

    const verifyRes = await loginAgent
      .post('/api/v1/auth/totp/verify')
      .set('Authorization', `Bearer ${loginRes.body.tempToken}`)
      .set('X-CSRF-Token', twoFaCsrf)
      .send({ code: totpCode(setup.body.secret) })
      .expect(200);
    // totp/verify ALSO rotates the CSRF cookie (setCsrfCookie() runs on
    // every session-issuing response, not just login) — reusing the
    // pre-verify value here would be the exact same stale-token bug this
    // file is regression-testing, just self-inflicted in the test.
    const postVerifyCsrf = extractCookie(verifyRes.headers['set-cookie'], 'openestate_csrf')!;

    await loginAgent
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${verifyRes.body.accessToken}`)
      .set('X-CSRF-Token', postVerifyCsrf)
      .send(createRolePayload('2fa'))
      .expect(201);

    // Cleanup so this staff account doesn't stay 2FA-locked for other
    // tests/runs against the same seeded company.
    await agent
      .post('/api/v1/auth/totp/disable')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(204);
  });

  it('regression: mutation after a portal 2FA login succeeds (portal login\'s 2FA-pending branch had the same missing-cookie bug as the staff side, never fixed until now)', async () => {
    const loginAgent1 = request.agent(app.getHttpServer());
    const loginRes1 = await loginAgent1.post('/api/v1/portal/auth/login').send({ identifier: customerPhone, password: CUSTOMER_PASSWORD }).expect(200);
    const csrf1 = extractCookie(loginRes1.headers['set-cookie'], 'openestate_portal_csrf')!;

    const setup = await loginAgent1
      .post('/api/v1/portal/auth/totp/setup')
      .set('Authorization', `Bearer ${loginRes1.body.accessToken}`)
      .set('X-CSRF-Token', csrf1)
      .expect(200);
    await loginAgent1
      .post('/api/v1/portal/auth/totp/confirm')
      .set('Authorization', `Bearer ${loginRes1.body.accessToken}`)
      .set('X-CSRF-Token', csrf1)
      .send({ code: totpCode(setup.body.secret) })
      .expect(200);

    // Fresh login now requires 2FA — this response must carry a CSRF
    // cookie (the bug: it didn't) for totp/verify to be callable at all.
    const loginAgent2 = request.agent(app.getHttpServer());
    const loginRes2 = await loginAgent2.post('/api/v1/portal/auth/login').send({ identifier: customerPhone, password: CUSTOMER_PASSWORD }).expect(200);
    expect(loginRes2.body.requiresTwoFactor).toBe(true);
    const twoFaCsrf = extractCookie(loginRes2.headers['set-cookie'], 'openestate_portal_csrf');
    expect(twoFaCsrf).toBeTruthy();

    const verifyRes = await loginAgent2
      .post('/api/v1/portal/auth/totp/verify')
      .set('Authorization', `Bearer ${loginRes2.body.tempToken}`)
      .set('X-CSRF-Token', twoFaCsrf!)
      .send({ code: totpCode(setup.body.secret) })
      .expect(200);
    // Same rotation as the staff side: totp/verify issues its own fresh
    // CSRF cookie, distinct from the one login's 2FA-pending response set.
    const postVerifyCsrf = extractCookie(verifyRes.headers['set-cookie'], 'openestate_portal_csrf')!;

    await loginAgent2
      .post('/api/v1/portal/tickets')
      .set('Authorization', `Bearer ${verifyRes.body.accessToken}`)
      .set('X-CSRF-Token', postVerifyCsrf)
      .send({ categoryId: ticketCategoryId, subject: 'E2E CSRF portal 2FA ticket', body: 'Testing mutation after portal 2FA login.' })
      .expect(201);

    await loginAgent1
      .post('/api/v1/portal/auth/totp/disable')
      .set('Authorization', `Bearer ${loginRes1.body.accessToken}`)
      .set('X-CSRF-Token', csrf1)
      .expect(204);
  });
});
