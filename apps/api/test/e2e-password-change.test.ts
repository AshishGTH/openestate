/**
 * Through-the-wire coverage for the password-change feature (staff +
 * portal, together — per CLAUDE.md's mirrored-auth standing rule):
 *  - POST /auth/change-password + /portal/auth/change-password: succeeds
 *    with the correct current password, fails with a wrong one, revokes
 *    OTHER sessions but leaves the calling session's own refresh token
 *    alone (see TokenService.revokeAllForUserExceptToken — the old
 *    behavior revoked everything, including the session that just
 *    changed its own password), and is rate-limited.
 *  - POST /users/:id/force-password-reset (admin-triggered, for another
 *    STAFF user): returns a one-time token for manual out-of-band delivery,
 *    confirmed via /auth/password-reset/confirm. A new token supersedes any
 *    live one; portal users (400) and deactivated users (409) are refused.
 *    Never sets/reveals a password directly.
 *
 * Requires the compiled dist/ — see e2e-portal.test.ts for why.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  forcePasswordResetResponseSchema,
} from '@openestate/shared';
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

// Isolates this file's 'password-change' bucket usage (5 req/5min, tracked
// by user id) from any other file that might exercise the same routes —
// same established pattern as e2e-csrf-refresh.test.ts and friends.
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-password-change-${process.pid}-${Date.now()}-`;

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

describeIf('e2e password-change + admin force-password-reset', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let permByKey: Map<string, string>;
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

    const staffRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E PwdChange Staff', slug: `e2e-pwdchange-${TAG}`, isSystem: true },
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

  async function createStaffUser(password: string) {
    const email = `e2e-pwdchange-staff-${TAG}-${seq++}@test.com`;
    const user = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: await argon2.hash(password, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E PwdChange Staff',
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

  describe('staff change-password', () => {
    it('succeeds with the correct current password', async () => {
      const { email } = await createStaffUser('OldPass111');
      const { agent, token, csrf } = await staffLogin(email, 'OldPass111');
      await agent
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ currentPassword: 'OldPass111', newPassword: 'NewPassword2222' })
        .expect(204);

      // New password now works; old one doesn't.
      await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: 'NewPassword2222' }).expect(200);
      await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: 'OldPass111' }).expect(401);
    });

    it('fails with the wrong current password', async () => {
      const { email } = await createStaffUser('OldPass111');
      const { agent, token, csrf } = await staffLogin(email, 'OldPass111');
      await agent
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ currentPassword: 'WrongPassword', newPassword: 'NewPassword2222' })
        .expect(401);
    });

    it('revokes OTHER sessions but not the one that made the change', async () => {
      const { email } = await createStaffUser('OldPass111');
      const sessionA = await staffLogin(email, 'OldPass111');
      const sessionB = await staffLogin(email, 'OldPass111');

      await sessionA.agent
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${sessionA.token}`)
        .set('X-CSRF-Token', sessionA.csrf)
        .send({ currentPassword: 'OldPass111', newPassword: 'NewPassword2222' })
        .expect(204);

      // Session A's own refresh token (the one that made the request) is
      // still valid — this is the bug: it used to revoke everything.
      await sessionA.agent.post('/api/v1/auth/refresh').expect(200);
      // Session B's refresh token was an OTHER session and is revoked.
      await sessionB.agent.post('/api/v1/auth/refresh').expect(401);
    });

    it('is rate-limited', async () => {
      const { email } = await createStaffUser('OldPass111');
      const { agent, token, csrf } = await staffLogin(email, 'OldPass111');

      for (let i = 0; i < 5; i++) {
        await agent
          .post('/api/v1/auth/change-password')
          .set('Authorization', `Bearer ${token}`)
          .set('X-CSRF-Token', csrf)
          .send({ currentPassword: 'WrongOnPurpose', newPassword: 'NewPassword2222' })
          .expect(401);
      }
      await agent
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ currentPassword: 'WrongOnPurpose', newPassword: 'NewPassword2222' })
        .expect(429);
    });
  });

  describe('portal change-password', () => {
    it('succeeds with the correct current password', async () => {
      const { phone } = await createCustomerUser('OldPortal111');
      const { agent, token, csrf } = await portalLogin(phone, 'OldPortal111');
      await agent
        .post('/api/v1/portal/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ currentPassword: 'OldPortal111', newPassword: 'NewPortalPass222' })
        .expect(204);

      // Verified directly (not via another real portal login) — this
      // file's total portal-auth login count is deliberately kept at or
      // under that bucket's own 5-per-5min limit (shared, IP-tracked,
      // unrelated to the 'password-change' bucket this suite is actually
      // testing) so this file doesn't trip on its own setup traffic; see
      // the login-count accounting in this describe block's other tests.
      const updated = await systemPrisma.user.findFirst({ where: { phone } });
      expect(await argon2.verify(updated.passwordHash, 'NewPortalPass222')).toBe(true);
    });

    it('fails with the wrong current password', async () => {
      const { phone } = await createCustomerUser('OldPortal111');
      const { agent, token, csrf } = await portalLogin(phone, 'OldPortal111');
      await agent
        .post('/api/v1/portal/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ currentPassword: 'WrongPassword', newPassword: 'NewPortalPass222' })
        .expect(401);
    });

    it('revokes OTHER sessions but not the one that made the change', async () => {
      const { phone } = await createCustomerUser('OldPortal111');
      const sessionA = await portalLogin(phone, 'OldPortal111');
      const sessionB = await portalLogin(phone, 'OldPortal111');

      await sessionA.agent
        .post('/api/v1/portal/auth/change-password')
        .set('Authorization', `Bearer ${sessionA.token}`)
        .set('X-CSRF-Token', sessionA.csrf)
        .send({ currentPassword: 'OldPortal111', newPassword: 'NewPortalPass222' })
        .expect(204);

      await sessionA.agent.post('/api/v1/portal/auth/refresh').expect(200);
      await sessionB.agent.post('/api/v1/portal/auth/refresh').expect(401);
    });

    it('is rate-limited', async () => {
      const { phone } = await createCustomerUser('OldPortal111');
      const { agent, token, csrf } = await portalLogin(phone, 'OldPortal111');

      for (let i = 0; i < 5; i++) {
        await agent
          .post('/api/v1/portal/auth/change-password')
          .set('Authorization', `Bearer ${token}`)
          .set('X-CSRF-Token', csrf)
          .send({ currentPassword: 'WrongOnPurpose', newPassword: 'NewPortalPass222' })
          .expect(401);
      }
      await agent
        .post('/api/v1/portal/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ currentPassword: 'WrongOnPurpose', newPassword: 'NewPortalPass222' })
        .expect(429);
    });
  });

  describe('admin force-password-reset for another user', () => {
    // Every confirm call here is unauthenticated, so PasswordChangeThrottlerGuard
    // tracks it by IP: keep this block at <= 5 confirm calls (currently 4), or
    // the 'password-change' bucket starts answering 429.

    // Takes the expected status rather than returning the request: a supertest
    // Test is thenable, so returning it from an async function would send it
    // unasserted and hand back a Response with no .expect().
    async function forceReset(adminEmail: string, adminPassword: string, targetId: string, status: number) {
      const { agent, token, csrf } = await staffLogin(adminEmail, adminPassword);
      return agent
        .post(`/api/v1/users/${targetId}/force-password-reset`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .expect(status);
    }

    function confirm(token: string, newPassword: string) {
      return request(app.getHttpServer())
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token, newPassword });
    }

    it('returns 200 with a one-time token, stores only its hash, and audits the issue', async () => {
      const admin = await createStaffUser('AdminPass111');
      const target = await createStaffUser('TargetOldPass111');

      const res = await forceReset(admin.email, 'AdminPass111', target.id, 200);
      const body = forcePasswordResetResponseSchema.parse(res.body);
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const reset = await systemPrisma.passwordReset.findFirstOrThrow({ where: { userId: target.id } });
      expect(reset.tokenHash).toBe(createHash('sha256').update(body.token).digest('hex'));
      expect(reset.consumedAt).toBeNull();
      expect(reset.createdById).toBe(admin.id);

      const audit = await systemPrisma.auditLog.findFirstOrThrow({
        where: { entityId: target.id, action: 'RESET_LINK_ISSUED' },
      });
      expect(audit.userId).toBe(admin.id);
      expect(JSON.stringify(audit.after)).not.toContain(body.token);
    });

    it('the returned token completes /auth/password-reset/confirm, exactly once', async () => {
      const admin = await createStaffUser('AdminPass111');
      const target = await createStaffUser('TargetOldPass111');
      const { body } = await forceReset(admin.email, 'AdminPass111', target.id, 200);

      await confirm(body.token, 'ResetViaAdmin123').expect(204);
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: target.email, password: 'ResetViaAdmin123' })
        .expect(200);
      await confirm(body.token, 'SomethingElse456').expect(401);
    });

    it('issuing a second link invalidates the first', async () => {
      const admin = await createStaffUser('AdminPass111');
      const target = await createStaffUser('TargetOldPass111');
      const first = (await forceReset(admin.email, 'AdminPass111', target.id, 200)).body.token;
      const second = (await forceReset(admin.email, 'AdminPass111', target.id, 200)).body.token;

      await confirm(first, 'FromFirstLink123').expect(401);
      await confirm(second, 'FromSecondLink123').expect(204);
    });

    it('returns 409 for a deactivated user and issues nothing', async () => {
      const admin = await createStaffUser('AdminPass111');
      const target = await createStaffUser('TargetOldPass111');
      await systemPrisma.user.update({ where: { id: target.id }, data: { isActive: false } });

      await forceReset(admin.email, 'AdminPass111', target.id, 409);
      expect(await systemPrisma.passwordReset.count({ where: { userId: target.id } })).toBe(0);
    });

    it('returns 400 for a portal user and issues nothing', async () => {
      const admin = await createStaffUser('AdminPass111');
      const target = await createCustomerUser('TargetOldPortal111');

      await forceReset(admin.email, 'AdminPass111', target.id, 400);
      expect(await systemPrisma.passwordReset.count({ where: { userId: target.id } })).toBe(0);
      expect(await systemPrisma.portalPasswordReset.count({ where: { userId: target.id } })).toBe(0);
    });

    it('returns 404 for a user in a different company', async () => {
      const admin = await createStaffUser('AdminPass111');
      const other = await seedCompany(systemPrisma);
      try {
        await forceReset(admin.email, 'AdminPass111', other.userId, 404);
        expect(await systemPrisma.passwordReset.count({ where: { userId: other.userId } })).toBe(0);
      } finally {
        await cleanupCompany(systemPrisma, other.companyId);
      }
    });

    it('never calls CommunicationProvider.send', async () => {
      const { COMMUNICATION_PROVIDER } = createRequire(import.meta.url)('../dist/queues/communication-provider');
      const provider = app.get(COMMUNICATION_PROVIDER);
      const send = vi.spyOn(provider, 'send');
      try {
        const admin = await createStaffUser('AdminPass111');
        const target = await createStaffUser('TargetOldPass111');

        await forceReset(admin.email, 'AdminPass111', target.id, 200);
        expect(send).not.toHaveBeenCalled();
      } finally {
        send.mockRestore();
      }
    });

    it('rejects a non-admin caller (permission-gated)', async () => {
      const noPermsRole = await systemPrisma.role.create({
        data: { companyId: fx.companyId, name: 'E2E No Perms', slug: `e2e-pwdchange-noperm-${TAG}`, isSystem: true },
      });
      const email = `e2e-pwdchange-noperm-${TAG}-${seq++}@test.com`;
      await systemPrisma.user.create({
        data: {
          companyId: fx.companyId,
          email,
          passwordHash: await argon2.hash('NoPermPass111', { algorithm: argon2.Algorithm.Argon2id }),
          name: 'No Perms',
          roleId: noPermsRole.id,
          forcePasswordChange: false,
        },
      });
      const target = await createStaffUser('TargetOldPass111');
      const { agent, token, csrf } = await staffLogin(email, 'NoPermPass111');

      await agent
        .post(`/api/v1/users/${target.id}/force-password-reset`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .expect(403);
    });
  });

  describe('forced first-login password change', () => {
    // A fresh staff user (forcePasswordChange: true) was previously
    // usable through the real app forever with their temporary password
    // — the flag was set on creation and checked by nothing on either
    // side. Fixed by putting forcePasswordChange on the JWT payload
    // (decoded here the same way the frontend does) so ProtectedRoute
    // can gate on it; these tests are the regression coverage that never
    // existed for force-change-password at all before this.
    function decodeJwt(token: string): { forcePasswordChange?: boolean } {
      const payload = token.split('.')[1];
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    }

    it('a freshly created user gets forcePasswordChange: true on the JWT', async () => {
      const { email } = await createStaffUser('FreshTempPass111');
      // createStaffUser sets forcePasswordChange: false for the other
      // tests' convenience — flip it to true here to simulate a real
      // admin-created user (UsersService.create always sets it true).
      const user = await systemPrisma.user.findFirstOrThrow({ where: { email } });
      await systemPrisma.user.update({ where: { id: user.id }, data: { forcePasswordChange: true } });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'FreshTempPass111' })
        .expect(200);
      expect(decodeJwt(res.body.accessToken).forcePasswordChange).toBe(true);
    });

    it('force-change-password clears the flag, revokes sessions, and the new password works', async () => {
      const { email } = await createStaffUser('FreshTempPass222');
      const user = await systemPrisma.user.findFirstOrThrow({ where: { email } });
      await systemPrisma.user.update({ where: { id: user.id }, data: { forcePasswordChange: true } });

      const { agent, token, csrf } = await staffLogin(email, 'FreshTempPass222');
      await agent
        .post('/api/v1/auth/force-change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ newPassword: 'RealChosenPass333' })
        .expect(204);

      // The session that made the change is itself revoked (force-change
      // revokes ALL sessions, unlike change-password) — matches the
      // frontend's own onDone-logs-out behavior.
      await agent.post('/api/v1/auth/refresh').expect(401);

      // Old password no longer works; new one does, and its JWT now
      // shows the flag cleared.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'FreshTempPass222' })
        .expect(401);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'RealChosenPass333' })
        .expect(200);
      expect(decodeJwt(res.body.accessToken).forcePasswordChange).toBe(false);
    });
  });
});
