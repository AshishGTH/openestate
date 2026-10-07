/**
 * SessionSurfaceGuard requires a signed `surface` claim.
 *
 * Before: a token without the claim (issued before v0.8.1) was classified by
 * guessing from applicantId/brokerId, so it kept working. Now it is refused
 * with 401 on both surfaces and the client's silent refresh issues a real one.
 *
 * Claim-less tokens are built the way the real thing looked: take a genuine
 * login token, drop `surface` from its payload, re-sign with the same secret
 * (so iat, exp, sub and every other field are the real ones).
 *
 * Refusal tests (mutation-checked against the inference code):
 *   claim-less staff token, claim-less portal token, claim-less token carrying
 *   portal ids on a staff route, an unknown claim value.
 * Controls that must keep working: real staff and portal tokens on their own
 * surface, wrong-surface 403, inconsistent-claim 403.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { JwtService } from '@nestjs/jwt';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { makeClients, seedCompany, makeApplicant, makePortalRole, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-surface-claim-${process.pid}-${Date.now()}-`;
process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-0123456789';
const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });

const PASSWORD = 'SurfacePass123';

describeIf('SessionSurfaceGuard: a token without a surface claim is refused', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let staffEmail: string;
  let portalPhone: string;
  let staffToken: string;
  let portalToken: string;

  /** Re-sign a real token's payload with `surface` removed or replaced. */
  function resign(real: string, change: (p: Record<string, unknown>) => void): string {
    const payload = jwt.decode(real) as Record<string, unknown>;
    change(payload);
    return jwt.sign(payload); // keeps the real iat and exp
  }
  const dropSurface = (p: Record<string, unknown>) => {
    delete p.surface;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = APP_URL;
    process.env.DATABASE_URL_SYSTEM = SYSTEM_URL;
    process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
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
    app = nestApp;

    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const permByKey = new Map<string, string>(
      (await systemPrisma.permission.findMany()).map((p: { key: string; id: string }) => [p.key, p.id]),
    );
    const hash = await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id });

    const staffRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'Surface Staff', slug: `surface-staff-${Date.now()}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: ALL_PERMISSIONS.map((k) => ({ roleId: staffRole.id, permissionId: permByKey.get(k) })),
    });
    staffEmail = `surface-staff-${Date.now()}@test.com`;
    await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: staffEmail, passwordHash: hash, name: 'Surface Staff', roleId: staffRole.id, forcePasswordChange: false },
    });

    const customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    const ids = ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER].map((k) => permByKey.get(k)).filter((id): id is string => !!id);
    await systemPrisma.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId: customerRoleId, permissionId })) });
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const applicant = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } });
    portalPhone = applicant.primaryPhone;
    await systemPrisma.user.create({
      data: { companyId: fx.companyId, applicantId, phone: portalPhone, name: applicant.name, passwordHash: hash, roleId: customerRoleId, forcePasswordChange: false },
    });

    // One real login on each surface (the portal-auth bucket allows 5 per 5 minutes).
    const s = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: staffEmail, password: PASSWORD }).expect(200);
    staffToken = s.body.accessToken;
    const p = await request(app.getHttpServer()).post('/api/v1/portal/auth/login').send({ identifier: portalPhone, password: PASSWORD }).expect(200);
    portalToken = p.body.accessToken;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  const staffGet = (t: string) => request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${t}`);
  const portalGet = (t: string) => request(app.getHttpServer()).get('/api/v1/portal/auth/me').set('Authorization', `Bearer ${t}`);

  // ---------- controls: real tokens still work, and the guard's other refusals hold ----------

  it('control: a real staff token reaches a staff route and a real portal token reaches a portal route', async () => {
    expect(jwt.decode(staffToken)).toMatchObject({ surface: 'staff' });
    expect(jwt.decode(portalToken)).toMatchObject({ surface: 'portal' });
    expect((await staffGet(staffToken)).status).toBe(200);
    expect((await portalGet(portalToken)).status).toBe(200);
  });

  it('control: wrong surface is still 403 (staff token on a portal route, portal token on a staff route)', async () => {
    expect((await portalGet(staffToken)).status).toBe(403);
    expect((await staffGet(portalToken)).status).toBe(403);
  });

  it('control: an inconsistent claim is still 403 (staff claim with a portal id, portal claim with none)', async () => {
    const staffWithId = resign(staffToken, (p) => { p.applicantId = '00000000-0000-4000-8000-000000000001'; });
    const portalNoId = resign(portalToken, (p) => { delete p.applicantId; delete p.brokerId; });
    expect((await staffGet(staffWithId)).status).toBe(403);
    expect((await portalGet(portalNoId)).status).toBe(403);
  });

  // ---------- refusals (mutation-checked) ----------

  it('a claim-less staff token is refused with 401 on a staff route', async () => {
    const t = resign(staffToken, dropSurface);
    expect(jwt.decode(t)).not.toHaveProperty('surface');
    expect((await staffGet(t)).status).toBe(401);
  });

  it('a claim-less portal token is refused with 401 on a portal route', async () => {
    const t = resign(portalToken, dropSurface);
    expect(jwt.decode(t)).not.toHaveProperty('surface');
    expect((await portalGet(t)).status).toBe(401);
  });

  it('a claim-less token is refused with 401 whichever surface the route is (no guessing from the ids)', async () => {
    expect((await portalGet(resign(staffToken, dropSurface))).status).toBe(401);
    expect((await staffGet(resign(portalToken, dropSurface))).status).toBe(401);
  });

  it('a token whose claim is not "staff" or "portal" is refused with 401', async () => {
    for (const bad of ['admin', '', 'STAFF', 1, null]) {
      const t = resign(staffToken, (p) => { p.surface = bad; });
      expect((await staffGet(t)).status, `surface=${JSON.stringify(bad)}`).toBe(401);
    }
  });

  it('the 401 says to sign in again and does not reveal why', async () => {
    const res = await staffGet(resign(staffToken, dropSurface));
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Your session is out of date. Please sign in again.');
  });
});
