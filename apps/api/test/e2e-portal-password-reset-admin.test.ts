/**
 * Through-the-wire coverage for POST /admin/portal-password-resets — the
 * portal counterpart of the staff force-password-reset endpoint. An admin
 * issues a one-time token for an applicant's or broker's existing portal
 * account; it is confirmed through the existing, unchanged
 * /portal/auth/password-reset/confirm. Nothing is sent by the server.
 *
 * Requires the compiled dist/ — see e2e-portal.test.ts for why.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import {
  ALL_PERMISSIONS,
  NO_PORTAL_ACCOUNT_ERROR,
  forcePasswordResetResponseSchema,
} from '@openestate/shared';
import {
  makeClients,
  seedCompany,
  makeApplicant,
  makeBroker,
  makePortalRole,
  cleanupCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const TAG = Date.now();
const STAFF_PASSWORD = 'StaffPass111';

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-portal-reset-admin-${process.pid}-${Date.now()}-`;

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

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describeIf('e2e admin-issued portal password reset', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let adminRoleId: string;
  let noPermRoleId: string;
  let customerRoleId: string;
  let brokerRoleId: string;
  let seq = 0;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms: Array<{ id: string }> = await systemPrisma.permission.findMany();
    const adminRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Portal Reset Admin', slug: `e2e-portal-reset-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: allPerms.map((p) => ({ roleId: adminRole.id, permissionId: p.id })),
    });
    adminRoleId = adminRole.id;
    noPermRoleId = (
      await systemPrisma.role.create({
        data: { companyId: fx.companyId, name: 'E2E No Perms', slug: `e2e-portal-reset-noperm-${TAG}`, isSystem: true },
      })
    ).id;
    customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    brokerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'broker');
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  async function createStaff(roleId: string) {
    const email = `e2e-portal-reset-staff-${TAG}-${seq++}@test.com`;
    const user = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Staff',
        roleId,
        forcePasswordChange: false,
      },
    });
    return { id: user.id as string, email };
  }

  // A portal account exists only once an invite has been consumed; created
  // directly here. passwordHash is a placeholder — these tests never log in
  // as the portal user, they read the hash back after a reset instead.
  async function createPortalAccount(kind: 'applicant' | 'broker', isActive = true) {
    if (kind === 'applicant') {
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      const a = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } });
      const user = await systemPrisma.user.create({
        data: {
          companyId: fx.companyId, applicantId, phone: a.primaryPhone, name: a.name,
          passwordHash: 'x', roleId: customerRoleId, forcePasswordChange: false, isActive,
        },
      });
      return { userId: user.id as string, body: { applicantId } };
    }
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    const b = await systemPrisma.broker.findUniqueOrThrow({ where: { id: brokerId } });
    const user = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId, brokerId, phone: b.phone, name: b.name,
        passwordHash: 'x', roleId: brokerRoleId, forcePasswordChange: false, isActive,
      },
    });
    return { userId: user.id as string, body: { brokerId } };
  }

  // Takes the expected status rather than returning the request: a supertest
  // Test is thenable, so returning it from an async function would send it
  // unasserted and hand back a Response with no .expect().
  async function issue(staffEmail: string, body: object, status: number) {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/v1/auth/login').send({ email: staffEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(login.headers['set-cookie'], 'openestate_csrf')!;
    return agent
      .post('/api/v1/admin/portal-password-resets')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .set('X-CSRF-Token', csrf)
      .send(body)
      .expect(status);
  }

  // The portal confirm endpoint is public, so PortalAuthThrottlerGuard counts
  // these per IP on that one handler: keep this file at <= 5 confirm calls
  // (currently 4) or the 'portal-auth' bucket starts answering 429.
  function confirm(token: string, newPassword: string) {
    return request(app.getHttpServer())
      .post('/api/v1/portal/auth/password-reset/confirm')
      .send({ token, newPassword });
  }

  it('applicant: 200 with a one-time token, hash-only storage, admin as creator, audit row without the token', async () => {
    const admin = await createStaff(adminRoleId);
    const target = await createPortalAccount('applicant');

    const res = await issue(admin.email, target.body, 200);
    const body = forcePasswordResetResponseSchema.parse(res.body);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const reset = await systemPrisma.portalPasswordReset.findFirstOrThrow({ where: { userId: target.userId } });
    expect(reset.tokenHash).toBe(sha256(body.token));
    expect(reset.createdById).toBe(admin.id);
    expect(reset.consumedAt).toBeNull();

    const audit = await systemPrisma.auditLog.findFirstOrThrow({
      where: { entityId: target.userId, action: 'PORTAL_RESET_ISSUED' },
    });
    expect(audit.userId).toBe(admin.id);
    expect(audit.companyId).toBe(fx.companyId);
    expect(audit.after).toMatchObject({ portalPasswordResetId: reset.id, applicantId: target.body.applicantId });
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(body.token);
    expect(auditText).not.toContain(reset.tokenHash);
  });

  it('broker: 200 with a one-time token, admin recorded as creator', async () => {
    const admin = await createStaff(adminRoleId);
    const target = await createPortalAccount('broker');

    const res = await issue(admin.email, target.body, 200);
    const body = forcePasswordResetResponseSchema.parse(res.body);

    const reset = await systemPrisma.portalPasswordReset.findFirstOrThrow({ where: { userId: target.userId } });
    expect(reset.tokenHash).toBe(sha256(body.token));
    expect(reset.createdById).toBe(admin.id);
  });

  it('the returned token completes /portal/auth/password-reset/confirm, exactly once', async () => {
    const admin = await createStaff(adminRoleId);
    const target = await createPortalAccount('applicant');
    const { body } = await issue(admin.email, target.body, 200);

    await confirm(body.token, 'PortalResetByAdmin123').expect(204);
    const updated = await systemPrisma.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(await argon2.verify(updated.passwordHash, 'PortalResetByAdmin123')).toBe(true);

    await confirm(body.token, 'SomethingElse456').expect(401);
  });

  it('issuing a second link invalidates the first', async () => {
    const admin = await createStaff(adminRoleId);
    const target = await createPortalAccount('applicant');
    const first = (await issue(admin.email, target.body, 200)).body.token;
    const second = (await issue(admin.email, target.body, 200)).body.token;

    await confirm(first, 'FromFirstLink123').expect(401);
    await confirm(second, 'FromSecondLink123').expect(204);
  });

  it(`409 with code ${NO_PORTAL_ACCOUNT_ERROR} when the applicant has never accepted an invite`, async () => {
    const admin = await createStaff(adminRoleId);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);

    const res = await issue(admin.email, { applicantId }, 409);
    expect(res.body.code).toBe(NO_PORTAL_ACCOUNT_ERROR);
    expect(res.body.message).toMatch(/portal invite/i);
    expect(await systemPrisma.portalPasswordReset.count({ where: { createdById: admin.id } })).toBe(0);
  });

  it('409 without that code when the portal account is deactivated, and issues nothing', async () => {
    const admin = await createStaff(adminRoleId);
    const target = await createPortalAccount('applicant', false);

    const res = await issue(admin.email, target.body, 409);
    expect(res.body.code).toBeUndefined();
    expect(res.body.message).toMatch(/deactivated/i);
    expect(await systemPrisma.portalPasswordReset.count({ where: { userId: target.userId } })).toBe(0);
  });

  it('404 for an applicant in a different company', async () => {
    const admin = await createStaff(adminRoleId);
    const other = await seedCompany(systemPrisma);
    try {
      const applicantId = await makeApplicant(systemPrisma, other.companyId);
      await issue(admin.email, { applicantId }, 404);
      expect(await systemPrisma.portalPasswordReset.count({ where: { createdById: admin.id } })).toBe(0);
    } finally {
      await cleanupCompany(systemPrisma, other.companyId);
    }
  });

  it('400 when both applicantId and brokerId are supplied, and when neither is', async () => {
    const admin = await createStaff(adminRoleId);
    await issue(admin.email, { applicantId: randomUUID(), brokerId: randomUUID() }, 400);
    await issue(admin.email, {}, 400);
  });

  it('403 for a caller without ADMIN_PORTAL_INVITE_SEND', async () => {
    const caller = await createStaff(noPermRoleId);
    const target = await createPortalAccount('applicant');

    await issue(caller.email, target.body, 403);
    expect(await systemPrisma.portalPasswordReset.count({ where: { userId: target.userId } })).toBe(0);
  });

  it('never calls CommunicationProvider.send', async () => {
    const { COMMUNICATION_PROVIDER } = createRequire(import.meta.url)('../dist/queues/communication-provider');
    const provider = app.get(COMMUNICATION_PROVIDER);
    const send = vi.spyOn(provider, 'send');
    try {
      const admin = await createStaff(adminRoleId);
      const applicant = await createPortalAccount('applicant');
      const broker = await createPortalAccount('broker');

      await issue(admin.email, applicant.body, 200);
      await issue(admin.email, broker.body, 200);
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });
});
