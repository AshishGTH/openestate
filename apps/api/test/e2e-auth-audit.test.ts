/**
 * Audit rows for self-service auth events, staff and portal, through the
 * real HTTP pipeline: TOTP_ENABLED, TOTP_DISABLED, PASSWORD_CHANGED (self,
 * first-login, invite) and PASSWORD_RESET_USED. The admin reset's own row is
 * covered in e2e-admin-2fa-reset.test.ts.
 *
 * Each event must write exactly one row naming the account holder as both
 * actor and target, with the surface in `after`, an IP address, and no
 * secret. Each refusal must write nothing. The two password-reset confirms
 * and invite consumption are @Public() routes with no tenant context, so
 * their IP is threaded from the controller — asserted here, because a
 * missing IP would otherwise pass silently as null.
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
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { makeClients, seedCompany, makePortalRole, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const TAG = Date.now();
const PASSWORD = 'AuthAuditPassword123';
const NEW_PASSWORD = 'AuthAuditChanged456';

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-auth-audit-${process.pid}-${Date.now()}-`;
// Portal login and portal confirm/consume are on the IP-keyed portal-auth
// bucket (5 per 5 minutes in production). Scoped to this file's fork. The
// staff reset confirm is on the password-change bucket, 5 per 300s per IP
// per handler, which is NOT raised: this file spends 4 of those.
process.env.PORTAL_AUTH_THROTTLE_LIMIT = '100';

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

function cookieValue(setCookie: string[] | string | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  for (const h of headers) {
    const match = new RegExp(`(?:^|\\s)${name}=([^;]+)`).exec(h);
    if (match) return match[1];
  }
  return undefined;
}

// RFC 6238, matching TotpService: SHA1, 6 digits, 30s period.
function totpCode(secretBase32: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretBase32.replace(/=+$/, '').toUpperCase()) {
    const val = alphabet.indexOf(c);
    if (val !== -1) bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const hmac = createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const o = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[o] & 0x7f) << 24) | ((hmac[o + 1] & 0xff) << 16) | ((hmac[o + 2] & 0xff) << 8) | (hmac[o + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

type Surface = 'staff' | 'portal';
const BASE = { staff: '/api/v1/auth', portal: '/api/v1/portal/auth' };
const CSRF = { staff: 'openestate_csrf', portal: 'openestate_portal_csrf' };

describeIf('auth audit rows, staff and portal', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let adminRoleId: string;
  let customerRoleId: string;
  let passwordHash: string;
  let seq = 0;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    passwordHash = await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id });

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const permissions = await systemPrisma.permission.findMany({ select: { id: true, key: true } });
    const permByKey = new Map(permissions.map((p: { id: string; key: string }) => [p.key, p.id]));
    const grant = async (roleId: string, keys: readonly string[]) => {
      const ids = keys.map((k) => permByKey.get(k)).filter((id): id is string => !!id);
      await systemPrisma.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId, permissionId })) });
    };
    adminRoleId = (
      await systemPrisma.role.create({
        data: { companyId: fx.companyId, name: 'E2E Auth Audit', slug: `e2e-auth-audit-${TAG}`, isSystem: true },
      })
    ).id;
    await grant(adminRoleId, ALL_PERMISSIONS);
    customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    await grant(customerRoleId, ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]);
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  // ── fixtures ──

  async function createStaff(opts: { forcePasswordChange?: boolean } = {}) {
    const email = `e2e-auth-audit-${TAG}-${++seq}@test.com`;
    const user = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId, email, passwordHash, name: `Staff ${seq}`, roleId: adminRoleId,
        forcePasswordChange: opts.forcePasswordChange ?? false,
      },
    });
    return { id: user.id as string, identifier: email, surface: 'staff' as const };
  }

  /** Portal login looks the phone up across every company, so it must be globally unique. */
  async function createApplicant(withAccount = true) {
    const n = ++seq;
    const phone = `9${String(TAG).slice(-6)}${String(n).padStart(3, '0')}`;
    const applicant = await systemPrisma.applicant.create({
      data: { companyId: fx.companyId, name: `Customer ${n}`, primaryPhone: phone, primaryPhoneNormalized: phone },
    });
    const user = withAccount
      ? await systemPrisma.user.create({
          data: {
            companyId: fx.companyId, applicantId: applicant.id, phone, name: `Customer ${n}`,
            passwordHash, roleId: customerRoleId, forcePasswordChange: false,
          },
        })
      : null;
    return { id: (user?.id ?? '') as string, applicantId: applicant.id as string, identifier: phone, surface: 'portal' as const };
  }

  type Who = { identifier: string; surface: Surface };

  async function session(who: Who, password = PASSWORD) {
    const agent = request.agent(app.getHttpServer());
    const body = who.surface === 'staff' ? { email: who.identifier, password } : { identifier: who.identifier, password };
    const login = await agent.post(`${BASE[who.surface]}/login`).send(body).expect(200);
    expect(login.body.accessToken).toBeTruthy();
    const csrf = cookieValue(login.headers['set-cookie'], CSRF[who.surface])!;
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${login.body.accessToken}`).set('X-CSRF-Token', csrf);
    return { agent, auth };
  }

  const rows = (userId: string, action: string) =>
    systemPrisma.auditLog.findMany({ where: { entityId: userId, action }, orderBy: { createdAt: 'asc' } });

  /** Exactly one row, self-attributed, with an IP and the expected `after`. */
  async function expectOneRow(userId: string, action: string, after: object) {
    const found = await rows(userId, action);
    expect(found).toHaveLength(1);
    const [row] = found;
    expect(row.userId).toBe(userId);
    expect(row.entityType).toBe('User');
    expect(row.companyId).toBe(fx.companyId);
    expect(row.after).toEqual(after);
    expect(row.ipAddress).toBeTruthy();
    return row;
  }

  async function issueStaffResetLink(targetId: string): Promise<string> {
    const admin = await createStaff();
    const s = await session(admin);
    const res = await s.auth(s.agent.post(`/api/v1/users/${targetId}/force-password-reset`)).expect(200);
    return res.body.token as string;
  }

  async function issuePortalResetLink(applicantId: string): Promise<string> {
    const admin = await createStaff();
    const s = await session(admin);
    const res = await s.auth(s.agent.post('/api/v1/admin/portal-password-resets')).send({ applicantId }).expect(200);
    return res.body.token as string;
  }

  // ── 2FA enable / disable, both surfaces ──

  for (const surface of ['staff', 'portal'] as const) {
    const make = () => (surface === 'staff' ? createStaff() : createApplicant());

    it(`${surface}: TOTP_ENABLED on confirm, TOTP_DISABLED on disable; neither row holds the secret or a recovery code`, async () => {
      const who = await make();
      const s = await session(who);

      const setup = await s.auth(s.agent.post(`${BASE[surface]}/totp/setup`)).expect(200);
      // A wrong code is refused and writes nothing.
      const wrong = String((Number(totpCode(setup.body.secret)) + 500_000) % 1_000_000).padStart(6, '0');
      await s.auth(s.agent.post(`${BASE[surface]}/totp/confirm`)).send({ code: wrong }).expect(400);
      expect(await rows(who.id, 'TOTP_ENABLED')).toHaveLength(0);

      const confirm = await s.auth(s.agent.post(`${BASE[surface]}/totp/confirm`))
        .send({ code: totpCode(setup.body.secret) })
        .expect(200);
      const enabled = await expectOneRow(who.id, 'TOTP_ENABLED', { surface });
      const text = JSON.stringify(enabled);
      expect(text).not.toContain(setup.body.secret);
      for (const code of confirm.body.recoveryCodes as string[]) expect(text).not.toContain(code);

      await s.auth(s.agent.post(`${BASE[surface]}/totp/disable`)).expect(204);
      await expectOneRow(who.id, 'TOTP_DISABLED', { surface });
    });

    it(`${surface}: PASSWORD_CHANGED via self; a wrong current password writes nothing`, async () => {
      const who = await make();
      const s = await session(who);

      await s.auth(s.agent.post(`${BASE[surface]}/change-password`))
        .send({ currentPassword: 'not-the-password-at-all', newPassword: NEW_PASSWORD })
        .expect(401);
      expect(await rows(who.id, 'PASSWORD_CHANGED')).toHaveLength(0);

      await s.auth(s.agent.post(`${BASE[surface]}/change-password`))
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(204);
      const row = await expectOneRow(who.id, 'PASSWORD_CHANGED', { surface, via: 'self' });
      expect(JSON.stringify(row)).not.toContain(NEW_PASSWORD);
    });
  }

  it('staff: PASSWORD_CHANGED via first-login on force-change-password', async () => {
    const who = await createStaff({ forcePasswordChange: true });
    const s = await session(who);
    await s.auth(s.agent.post('/api/v1/auth/force-change-password')).send({ newPassword: NEW_PASSWORD }).expect(204);
    await expectOneRow(who.id, 'PASSWORD_CHANGED', { surface: 'staff', via: 'first-login' });
  });

  // ── reset-link redemption, both surfaces, including replay ──

  it('staff: PASSWORD_RESET_USED once; replaying the same token 401s and writes no second row', async () => {
    const who = await createStaff();
    const token = await issueStaffResetLink(who.id);
    const reset = await systemPrisma.passwordReset.findFirstOrThrow({ where: { userId: who.id } });

    const confirm = () => request(app.getHttpServer()).post('/api/v1/auth/password-reset/confirm');
    await confirm().send({ token, newPassword: NEW_PASSWORD }).expect(204);
    // @Public() route: the IP must come from the controller, not the (absent) tenant context.
    const row = await expectOneRow(who.id, 'PASSWORD_RESET_USED', { surface: 'staff', passwordResetId: reset.id });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(reset.tokenHash);

    await confirm().send({ token, newPassword: 'ReplayAttempt789' }).expect(401);
    expect(await rows(who.id, 'PASSWORD_RESET_USED')).toHaveLength(1);
    const user = await systemPrisma.user.findUniqueOrThrow({ where: { id: who.id } });
    expect(await argon2.verify(user.passwordHash, NEW_PASSWORD)).toBe(true);
  });

  it('staff: a garbage token and a claimed-but-refused (inactive) redemption both write nothing', async () => {
    const who = await createStaff();
    const confirm = () => request(app.getHttpServer()).post('/api/v1/auth/password-reset/confirm');
    await confirm().send({ token: 'not-a-real-token', newPassword: NEW_PASSWORD }).expect(401);

    const token = await issueStaffResetLink(who.id);
    // Deactivated directly, not through deactivate(), which would consume the
    // link first: this reaches the conditional write and its rollback.
    await systemPrisma.user.update({ where: { id: who.id }, data: { isActive: false } });
    await confirm().send({ token, newPassword: NEW_PASSWORD }).expect(401);

    expect(await rows(who.id, 'PASSWORD_RESET_USED')).toHaveLength(0);
    const user = await systemPrisma.user.findUniqueOrThrow({ where: { id: who.id } });
    expect(user.passwordHash).toBe(passwordHash);
    // The claim sits outside the rolled-back transaction, so the refused link stays used up.
    const reset = await systemPrisma.passwordReset.findFirstOrThrow({ where: { userId: who.id } });
    expect(reset.consumedAt).not.toBeNull();
  });

  it('portal: PASSWORD_RESET_USED once; replaying the same token 401s and writes no second row', async () => {
    const who = await createApplicant();
    const token = await issuePortalResetLink(who.applicantId);
    const reset = await systemPrisma.portalPasswordReset.findFirstOrThrow({ where: { userId: who.id } });

    const confirm = () => request(app.getHttpServer()).post('/api/v1/portal/auth/password-reset/confirm');
    await confirm().send({ token, newPassword: NEW_PASSWORD }).expect(204);
    const row = await expectOneRow(who.id, 'PASSWORD_RESET_USED', { surface: 'portal', portalPasswordResetId: reset.id });
    expect(JSON.stringify(row)).not.toContain(token);

    await confirm().send({ token, newPassword: 'ReplayAttempt789' }).expect(401);
    expect(await rows(who.id, 'PASSWORD_RESET_USED')).toHaveLength(1);
  });

  it('portal: a claimed-but-refused (inactive) redemption writes nothing and leaves the password alone', async () => {
    const who = await createApplicant();
    const token = await issuePortalResetLink(who.applicantId);
    await systemPrisma.user.update({ where: { id: who.id }, data: { isActive: false } });

    await request(app.getHttpServer())
      .post('/api/v1/portal/auth/password-reset/confirm')
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(401);
    expect(await rows(who.id, 'PASSWORD_RESET_USED')).toHaveLength(0);
    expect((await systemPrisma.user.findUniqueOrThrow({ where: { id: who.id } })).passwordHash).toBe(passwordHash);
  });

  // ── invite consumption ──

  async function sendInvite(applicantId: string) {
    const admin = await createStaff();
    const s = await session(admin);
    const res = await s.auth(s.agent.post('/api/v1/admin/portal-invites')).send({ applicantId, channel: 'SMS' }).expect(201);
    return res.body as { inviteId: string; token: string };
  }

  it('portal: re-inviting an existing (deactivated) account writes PASSWORD_CHANGED via invite, flagging the reactivation', async () => {
    const who = await createApplicant();
    await systemPrisma.user.update({ where: { id: who.id }, data: { isActive: false } });
    const invite = await sendInvite(who.applicantId);

    await request(app.getHttpServer())
      .post(`/api/v1/portal/auth/invite/${invite.inviteId}/consume`)
      .send({ token: invite.token, password: NEW_PASSWORD })
      .expect(200);
    const row = await expectOneRow(who.id, 'PASSWORD_CHANGED', {
      surface: 'portal', via: 'invite', inviteId: invite.inviteId, reactivated: true,
    });
    expect(JSON.stringify(row)).not.toContain(invite.token);
  });

  it('portal: a first-time invite creates the account and writes no PASSWORD_CHANGED row', async () => {
    const who = await createApplicant(false);
    const invite = await sendInvite(who.applicantId);

    await request(app.getHttpServer())
      .post(`/api/v1/portal/auth/invite/${invite.inviteId}/consume`)
      .send({ token: invite.token, password: NEW_PASSWORD })
      .expect(200);
    const user = await systemPrisma.user.findFirstOrThrow({ where: { applicantId: who.applicantId } });
    expect(await rows(user.id, 'PASSWORD_CHANGED')).toHaveLength(0);
  });
});
