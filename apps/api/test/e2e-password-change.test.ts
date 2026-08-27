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
 *    user): staff targets get a new PasswordReset row + confirm via
 *    /auth/password-reset/confirm; portal targets reuse the existing
 *    PortalPasswordReset row + the existing /portal/auth/password-reset/
 *    confirm unchanged. Never sets/reveals a password directly.
 *
 * Requires the compiled dist/ — see e2e-portal.test.ts for why.
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
        .send({ currentPassword: 'OldPass111', newPassword: 'NewPass222' })
        .expect(204);

      // New password now works; old one doesn't.
      await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: 'NewPass222' }).expect(200);
      await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: 'OldPass111' }).expect(401);
    });

    it('fails with the wrong current password', async () => {
      const { email } = await createStaffUser('OldPass111');
      const { agent, token, csrf } = await staffLogin(email, 'OldPass111');
      await agent
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ currentPassword: 'WrongPassword', newPassword: 'NewPass222' })
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
        .send({ currentPassword: 'OldPass111', newPassword: 'NewPass222' })
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
          .send({ currentPassword: 'WrongOnPurpose', newPassword: 'NewPass222' })
          .expect(401);
      }
      await agent
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ currentPassword: 'WrongOnPurpose', newPassword: 'NewPass222' })
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
        .send({ currentPassword: 'OldPortal111', newPassword: 'NewPortal222' })
        .expect(204);

      // Verified directly (not via another real portal login) — this
      // file's total portal-auth login count is deliberately kept at or
      // under that bucket's own 5-per-5min limit (shared, IP-tracked,
      // unrelated to the 'password-change' bucket this suite is actually
      // testing) so this file doesn't trip on its own setup traffic; see
      // the login-count accounting in this describe block's other tests.
      const updated = await systemPrisma.user.findFirst({ where: { phone } });
      expect(await argon2.verify(updated.passwordHash, 'NewPortal222')).toBe(true);
    });

    it('fails with the wrong current password', async () => {
      const { phone } = await createCustomerUser('OldPortal111');
      const { agent, token, csrf } = await portalLogin(phone, 'OldPortal111');
      await agent
        .post('/api/v1/portal/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ currentPassword: 'WrongPassword', newPassword: 'NewPortal222' })
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
        .send({ currentPassword: 'OldPortal111', newPassword: 'NewPortal222' })
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
          .send({ currentPassword: 'WrongOnPurpose', newPassword: 'NewPortal222' })
          .expect(401);
      }
      await agent
        .post('/api/v1/portal/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ currentPassword: 'WrongOnPurpose', newPassword: 'NewPortal222' })
        .expect(429);
    });
  });

  describe('admin force-password-reset for another user', () => {
    it('staff target: issues a reset link (never a password) and the confirm flow works end-to-end', async () => {
      const admin = await createStaffUser('AdminPass111');
      const target = await createStaffUser('TargetOldPass111');
      const { agent, token, csrf } = await staffLogin(admin.email, 'AdminPass111');

      await agent
        .post(`/api/v1/users/${target.id}/force-password-reset`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .expect(204);

      const reset = await systemPrisma.passwordReset.findFirst({
        where: { userId: target.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(reset).toBeTruthy();
      expect(reset.consumedAt).toBeNull();
      expect(reset.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // The raw token only ever crosses the (simulated) notification
      // channel — reconstruct a request with a token we control instead of
      // trying to intercept ConsoleCommunicationProvider's console.log, to
      // test the real confirm endpoint's guard chain and single-use logic.
      // Unique per run — a fixed literal here previously collided with an
      // already-consumed row left by an earlier run against this same
      // persistent test DB (findFirst with no ordering picked the stale,
      // already-consumed row instead of this test's fresh one, a false
      // "Invalid or expired reset token"; not a bug in the confirm
      // endpoint itself, which only ever sees real, cryptographically
      // random tokens in production).
      const raw = `e2e-known-staff-reset-token-${TAG}`;
      await systemPrisma.passwordReset.update({
        where: { id: reset.id },
        data: { tokenHash: createHash('sha256').update(raw).digest('hex') },
      });

      await request(app.getHttpServer())
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token: raw, newPassword: 'ResetViaAdmin123' })
        .expect(204);

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: target.email, password: 'ResetViaAdmin123' })
        .expect(200);

      // Single-use: the same token can't be replayed.
      await request(app.getHttpServer())
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token: raw, newPassword: 'SomethingElse456' })
        .expect(401);
    });

    it('portal target: reuses the existing self-service PortalPasswordReset model and confirm endpoint', async () => {
      const admin = await createStaffUser('AdminPass111');
      const target = await createCustomerUser('TargetOldPortal111');
      const { agent, token, csrf } = await staffLogin(admin.email, 'AdminPass111');

      await agent
        .post(`/api/v1/users/${target.id}/force-password-reset`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .expect(204);

      const reset = await systemPrisma.portalPasswordReset.findFirst({
        where: { userId: target.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(reset).toBeTruthy();

      const raw = `e2e-known-portal-reset-token-${TAG}`;
      await systemPrisma.portalPasswordReset.update({
        where: { id: reset.id },
        data: { tokenHash: createHash('sha256').update(raw).digest('hex') },
      });

      await request(app.getHttpServer())
        .post('/api/v1/portal/auth/password-reset/confirm')
        .send({ token: raw, newPassword: 'ResetViaAdminPortal123' })
        .expect(204);

      // Verified directly, not via another real portal login — see the
      // login-count accounting note in the portal change-password tests
      // above (this file shares the portal-auth bucket's own 5/5min budget).
      const updated = await systemPrisma.user.findFirst({ where: { id: target.id } });
      expect(await argon2.verify(updated.passwordHash, 'ResetViaAdminPortal123')).toBe(true);
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
