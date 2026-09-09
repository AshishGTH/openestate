/**
 * Through-the-wire coverage for POST /users/:id/deactivate revoking the
 * target's refresh tokens, not just flipping isActive.
 *
 * Before this fix, JwtStrategy does no DB lookup (see
 * apps/api/src/auth/strategies/jwt.strategy.ts), so a deactivated user's
 * already-issued access token kept working until it expired on its own
 * (JWT_ACCESS_EXPIRES_IN, default 15m) — refreshTokens() correctly refused
 * to renew (it checks isActive), but nothing cut off the live session.
 *
 * These tests assert the OUTCOME — that the refresh token is actually dead
 * — not that TokenService.revokeAllForUser was called. There is no
 * separate "portal user deactivation" endpoint: portal-linked users
 * (applicantId/brokerId set) are rows in the same User table, and
 * POST /users/:id/deactivate is not filtered by that — it's one shared
 * implementation, not a mirrored staff/portal pair, so both are covered
 * here in the same file rather than split like the auth-controller tests.
 *
 * Requires the compiled dist/ — see e2e-portal.test.ts for why.
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
  makeApplicant,
  makePortalRole,
  cleanupCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const TAG = Date.now();

// Isolates this file's portal-auth login usage (5 req/5min, IP-tracked)
// from any other file exercising the same bucket — same established
// pattern as e2e-password-change.test.ts and friends.
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-user-deactivate-${process.pid}-${Date.now()}-`;

async function bootstrapApp(): Promise<INestApplication> {
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

function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
  for (const h of headers) {
    const match = new RegExp(`${name}=([^;]+)`).exec(h);
    if (match) return match[1];
  }
  return undefined;
}

describeIf('e2e user deactivation revokes refresh tokens', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let permByKey: Map<string, string>;
  let adminRoleId: string;
  let staffRoleId: string;
  let customerRoleId: string;
  let seq = 0;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    const adminRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Deactivate Admin', slug: `e2e-deactivate-admin-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: ALL_PERMISSIONS.map((key) => ({ roleId: adminRole.id, permissionId: permByKey.get(key) })),
    });
    adminRoleId = adminRole.id;

    const staffRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Deactivate Staff', slug: `e2e-deactivate-staff-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: ALL_PERMISSIONS.map((key) => ({ roleId: staffRole.id, permissionId: permByKey.get(key) })),
    });
    staffRoleId = staffRole.id;

    customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    const customerPermIds = ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]
      .map((key) => permByKey.get(key))
      .filter((id): id is string => !!id);
    await systemPrisma.rolePermission.createMany({
      data: customerPermIds.map((permissionId) => ({ roleId: customerRoleId, permissionId })),
    });
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  async function createAdmin(password: string) {
    const email = `e2e-deactivate-admin-${TAG}-${seq++}@test.com`;
    const user = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: await argon2.hash(password, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Deactivate Admin',
        roleId: adminRoleId,
        forcePasswordChange: false,
      },
    });
    return { id: user.id as string, email };
  }

  async function createStaffUser(password: string) {
    const email = `e2e-deactivate-staff-${TAG}-${seq++}@test.com`;
    const user = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: await argon2.hash(password, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Deactivate Staff',
        roleId: staffRoleId,
        forcePasswordChange: false,
      },
    });
    return { id: user.id as string, email };
  }

  async function createCustomerUser(password: string) {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const applicant = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } });
    const user = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        applicantId,
        phone: applicant.primaryPhone,
        name: applicant.name,
        passwordHash: await argon2.hash(password, { algorithm: argon2.Algorithm.Argon2id }),
        roleId: customerRoleId,
        forcePasswordChange: false,
      },
    });
    return { id: user.id as string, phone: applicant.primaryPhone as string };
  }

  async function staffLogin(email: string, password: string) {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
    const csrf = extractCookie(res.headers['set-cookie'], 'openestate_csrf')!;
    return { agent, token: res.body.accessToken as string, csrf };
  }

  async function portalLogin(identifier: string, password: string) {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/portal/auth/login').send({ identifier, password }).expect(200);
    const csrf = extractCookie(res.headers['set-cookie'], 'openestate_portal_csrf')!;
    return { agent, token: res.body.accessToken as string, csrf };
  }

  it('staff target: deactivation revokes the live refresh token — refresh 401s, login 401s', async () => {
    const admin = await createAdmin('AdminPass111');
    const target = await createStaffUser('TargetOldPass111');
    const targetSession = await staffLogin(target.email, 'TargetOldPass111');
    const adminSession = await staffLogin(admin.email, 'AdminPass111');

    // Sanity: the session is genuinely live before deactivation.
    await targetSession.agent.post('/api/v1/auth/refresh').expect(200);

    await adminSession.agent
      .post(`/api/v1/users/${target.id}/deactivate`)
      .set('Authorization', `Bearer ${adminSession.token}`)
      .set('X-CSRF-Token', adminSession.csrf)
      .expect(200);

    // The outcome, not the call: the target's refresh token is dead.
    await targetSession.agent.post('/api/v1/auth/refresh').expect(401);

    // And can no longer log in at all.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: 'TargetOldPass111' })
      .expect(401);
  });

  it('portal-linked (customer) target: same shared deactivate endpoint revokes the portal refresh token', async () => {
    const admin = await createAdmin('AdminPass222');
    const target = await createCustomerUser('TargetPortalOld111');
    const targetSession = await portalLogin(target.phone, 'TargetPortalOld111');
    const adminSession = await staffLogin(admin.email, 'AdminPass222');

    await targetSession.agent.post('/api/v1/portal/auth/refresh').expect(200);

    await adminSession.agent
      .post(`/api/v1/users/${target.id}/deactivate`)
      .set('Authorization', `Bearer ${adminSession.token}`)
      .set('X-CSRF-Token', adminSession.csrf)
      .expect(200);

    await targetSession.agent.post('/api/v1/portal/auth/refresh').expect(401);

    // Verified directly (not via another real portal login) — this file's
    // portal-auth login count is kept under that bucket's 5-per-5min
    // limit, same accounting note as e2e-password-change.test.ts.
    const updated = await systemPrisma.user.findFirst({ where: { id: target.id } });
    expect(updated.isActive).toBe(false);
  });
});
