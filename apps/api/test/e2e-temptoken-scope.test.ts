/**
 * Regression suite for the 2FA bypass through the mid-login tempToken.
 *
 * The bug: login returns a tempToken instead of a session when TOTP is on,
 * signed with permissions: ['auth.totp.verify'] and meant only for
 * totp/verify. But PermissionsGuard lets any route without
 * @RequirePermissions through without looking at the token, so the tempToken
 * was accepted by every such route on BOTH surfaces (staff and portal share
 * a JWT secret) — including totp/setup, confirm and disable. A password
 * alone could strip 2FA, or take it over in a single login by enrolling the
 * attacker's own authenticator and verifying with it. CSRF was no barrier:
 * the attacker runs their own client and makes up the cookie/header pair.
 *
 * The fix: TwoFactorPendingGuard (global) refuses a 2FA-pending token on
 * every route except those that require auth.totp.verify — the two verify
 * endpoints, which now require it, so a full session can't call them.
 *
 * Every test here was first written to assert the attack SUCCEEDED, and
 * passed against the unfixed code (12/12, twice). The attack assertions are
 * now flipped; the rest cover the legitimate flows the fix must not break.
 *
 * Threat model throughout: the attacker has the victim's password and
 * nothing else — exactly what 2FA exists to stop.
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
import { ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { makeClients, seedCompany, makePortalRole, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

// Private throttle keyspace for this file, and room for more than five
// portal logins (production default: 5 per 5 minutes per IP).
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-temptoken-scope-${process.pid}-${Date.now()}-`;
process.env.PORTAL_AUTH_THROTTLE_LIMIT = '100';
// This file verifies the same user six times within a minute; the per-user
// verify limit is tested in e2e-totp-verify-throttle.test.ts, not here.
process.env.TOTP_VERIFY_THROTTLE_LIMIT = '100';

const TAG = Date.now();
const STAFF_PASSWORD = 'StaffPassword123';
const PORTAL_PASSWORD = 'PortalPassword123';
const STAFF_CSRF = 'openestate_csrf';
const PORTAL_CSRF = 'openestate_portal_csrf';
const PENDING_PERMISSION = 'auth.totp.verify';
// TWO_FACTOR_PENDING_TTL_SECONDS in two-factor-pending.guard.ts.
const PENDING_TTL_SECONDS = 300;

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

function cookieValue(setCookie: string[] | string | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  for (const h of headers) {
    const match = new RegExp(`(?:^|\\s)${name}=([^;]+)`).exec(h);
    if (match) return match[1];
  }
  return undefined;
}

function claims(token: string): { permissions: string[]; iat: number; exp: number } {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

/** The 403 an attacker sees must not explain itself. */
function expectOpaque403(res: request.Response) {
  expect(res.status).toBe(403);
  expect(res.body.message).toBe('Forbidden');
  expect(JSON.stringify(res.body)).not.toMatch(/totp|2fa|two.?factor|pending|temp/i);
}

describeIf('tempToken scope — regression suite for the 2FA bypass', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let staffUserId: string;
  let staffEmail: string;
  let portalUserId: string;
  let portalPhone: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    const permissions = await systemPrisma.permission.findMany({ select: { id: true, key: true } });
    const permByKey = new Map(permissions.map((p: { id: string; key: string }) => [p.key, p.id]));
    const grant = async (roleId: string, keys: readonly string[]) => {
      const ids = keys.map((k) => permByKey.get(k)).filter((id): id is string => !!id);
      await systemPrisma.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId, permissionId })) });
    };

    // Worst case on the staff side: a victim holding the full super_admin
    // permission set, so "full session" means full control of the company.
    const adminRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E TempToken Admin', slug: `e2e-tt-admin-${TAG}`, isSystem: true },
    });
    await grant(adminRole.id, ROLE_PERMISSIONS[SYSTEM_ROLES.SUPER_ADMIN]);
    staffEmail = `e2e-tt-${TAG}@test.com`;
    staffUserId = (
      await systemPrisma.user.create({
        data: {
          companyId: fx.companyId,
          email: staffEmail,
          passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
          name: 'E2E TempToken Staff',
          roleId: adminRole.id,
          forcePasswordChange: false,
        },
      })
    ).id;

    const customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    await grant(customerRoleId, ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]);
    // High-entropy phone: portal login looks the identifier up across ALL
    // companies, so a harness phone reused by another fixture could log in
    // as someone else (see e2e-portal-throttle.test.ts).
    portalPhone = `9${String(TAG).slice(-9)}`;
    const applicant = await systemPrisma.applicant.create({
      data: { companyId: fx.companyId, name: 'E2E TempToken Customer', primaryPhone: portalPhone, primaryPhoneNormalized: portalPhone },
    });
    portalUserId = (
      await systemPrisma.user.create({
        data: {
          companyId: fx.companyId,
          applicantId: applicant.id,
          phone: portalPhone,
          name: 'E2E TempToken Customer',
          passwordHash: await argon2.hash(PORTAL_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
          roleId: customerRoleId,
          forcePasswordChange: false,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  // Test setup only: return a user to "2FA off, original password" so each
  // test starts from the same state regardless of order.
  async function resetUser(userId: string, password: string) {
    await systemPrisma.user.update({
      where: { id: userId },
      data: {
        totpEnabled: false,
        totpSecret: null,
        recoveryCodes: [],
        failedLoginAttempts: 0,
        lockedUntil: null,
        passwordHash: await argon2.hash(password, { algorithm: argon2.Algorithm.Argon2id }),
      },
    });
  }

  const totpState = (userId: string) =>
    systemPrisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpEnabled: true, totpSecret: true, recoveryCodes: true },
    });

  // ── staff helpers ──

  async function staffLogin(password = STAFF_PASSWORD) {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email: staffEmail, password }).expect(200);
    return { agent, res, csrf: cookieValue(res.headers['set-cookie'], STAFF_CSRF)! };
  }

  /** The victim's own enrolment from a full session (C4's first half). */
  async function enableStaffTotp(): Promise<{ secret: string; recoveryCodes: string[] }> {
    const { agent, res, csrf } = await staffLogin();
    const token = res.body.accessToken as string;
    const setup = await agent.post('/api/v1/auth/totp/setup').set('Authorization', `Bearer ${token}`).set('X-CSRF-Token', csrf).expect(200);
    const confirm = await agent
      .post('/api/v1/auth/totp/confirm')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ code: totpCode(setup.body.secret) })
      .expect(200);
    return { secret: setup.body.secret, recoveryCodes: confirm.body.recoveryCodes };
  }

  /** What the attacker gets from the password alone. */
  async function staffPending() {
    const { agent, res, csrf } = await staffLogin();
    expect(res.body.requiresTwoFactor).toBe(true);
    expect(res.body.accessToken).toBeUndefined();
    return { agent, tempToken: res.body.tempToken as string, csrf, setCookie: res.headers['set-cookie'] };
  }

  // Not async: returns the supertest Test itself so callers can chain
  // .expect() — an async wrapper would hand back a Promise instead.
  function staffVerify(pending: Awaited<ReturnType<typeof staffPending>>, code: string) {
    return pending.agent
      .post('/api/v1/auth/totp/verify')
      .set('Authorization', `Bearer ${pending.tempToken}`)
      .set('X-CSRF-Token', pending.csrf)
      .send({ code });
  }

  describe('staff: the attack is refused', () => {
    it('A1: a password-only tempToken cannot remove 2FA via POST /auth/totp/disable', async () => {
      await resetUser(staffUserId, STAFF_PASSWORD);
      await enableStaffTotp();
      const before = await totpState(staffUserId);
      expect(before.totpEnabled).toBe(true);

      const { agent, tempToken, csrf } = await staffPending();
      expectOpaque403(await agent.post('/api/v1/auth/totp/disable').set('Authorization', `Bearer ${tempToken}`).set('X-CSRF-Token', csrf));

      expect(await totpState(staffUserId)).toEqual(before);
      // The password alone still doesn't get a session.
      await staffPending();
    });

    it('A3: a tempToken is refused on every staff route, undecorated or permission-guarded', async () => {
      await resetUser(staffUserId, STAFF_PASSWORD);
      await enableStaffTotp();
      const { agent, tempToken, csrf } = await staffPending();
      const auth = (r: request.Test) => r.set('Authorization', `Bearer ${tempToken}`).set('X-CSRF-Token', csrf);

      const observed = {
        'GET /auth/me': (await auth(agent.get('/api/v1/auth/me'))).status,
        'GET /company/terminology': (await auth(agent.get('/api/v1/company/terminology'))).status,
        'GET /users': (await auth(agent.get('/api/v1/users'))).status,
        'POST /users': (await auth(agent.post('/api/v1/users')).send({})).status,
        'GET /roles': (await auth(agent.get('/api/v1/roles'))).status,
        'GET /inquiries': (await auth(agent.get('/api/v1/inquiries'))).status,
      };
      expect(observed).toEqual({
        'GET /auth/me': 403,
        'GET /company/terminology': 403,
        'GET /users': 403,
        'POST /users': 403,
        'GET /roles': 403,
        'GET /inquiries': 403,
      });
      expectOpaque403(await auth(agent.get('/api/v1/auth/me')));
    });

    it('A3: POST /auth/logout-all with a tempToken is refused and every live session survives', async () => {
      await resetUser(staffUserId, STAFF_PASSWORD);
      await staffLogin(); // the victim's own session somewhere else
      await enableStaffTotp();
      const live = () => systemPrisma.refreshToken.count({ where: { userId: staffUserId, isRevoked: false } });
      const before = await live();
      expect(before).toBeGreaterThan(0);

      const { agent, tempToken, csrf } = await staffPending();
      expectOpaque403(await agent.post('/api/v1/auth/logout-all').set('Authorization', `Bearer ${tempToken}`).set('X-CSRF-Token', csrf));
      expect(await live()).toBe(before);
    });

    it('A3: POST /auth/force-change-password with a tempToken is refused and the password is unchanged', async () => {
      await resetUser(staffUserId, STAFF_PASSWORD);
      await enableStaffTotp();
      const { agent, tempToken, csrf } = await staffPending();
      const newPassword = 'AttackerChosen-2026';
      expectOpaque403(
        await agent
          .post('/api/v1/auth/force-change-password')
          .set('Authorization', `Bearer ${tempToken}`)
          .set('X-CSRF-Token', csrf)
          .send({ newPassword }),
      );

      await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: staffEmail, password: newPassword }).expect(401);
      await staffPending(); // original password still works, still needs 2FA
    });

    it('A3: POST /auth/change-password with a tempToken is refused even with the right current password', async () => {
      await resetUser(staffUserId, STAFF_PASSWORD);
      await enableStaffTotp();
      const { agent, tempToken, csrf } = await staffPending();
      expectOpaque403(
        await agent
          .post('/api/v1/auth/change-password')
          .set('Authorization', `Bearer ${tempToken}`)
          .set('X-CSRF-Token', csrf)
          .send({ currentPassword: STAFF_PASSWORD, newPassword: 'AttackerChosen-2027' }),
      );
      await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: staffEmail, password: 'AttackerChosen-2027' }).expect(401);
    });

    it('A3 cross-surface: a STAFF tempToken is refused by /portal/auth/totp/disable, even with a made-up CSRF pair', async () => {
      await resetUser(staffUserId, STAFF_PASSWORD);
      await enableStaffTotp();
      const { tempToken } = await staffPending();
      expectOpaque403(
        await request(app.getHttpServer())
          .post('/api/v1/portal/auth/totp/disable')
          .set('Authorization', `Bearer ${tempToken}`)
          .set('Cookie', `${PORTAL_CSRF}=forged`)
          .set('X-CSRF-Token', 'forged'),
      );
      expect((await totpState(staffUserId)).totpEnabled).toBe(true);
    });

    it('A4: the refresh endpoint cannot mint a session from a 2FA-pending login', async () => {
      await resetUser(staffUserId, STAFF_PASSWORD);
      await enableStaffTotp();
      const { agent, tempToken, setCookie } = await staffPending();
      expect(cookieValue(setCookie, 'openestate_refresh')).toBeUndefined();

      await agent.post('/api/v1/auth/refresh').expect(401);
      await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Authorization', `Bearer ${tempToken}`).expect(401);
    });

    it("A4: the one-login takeover fails — setup and confirm refuse the tempToken, and the victim's authenticator still works", async () => {
      await resetUser(staffUserId, STAFF_PASSWORD);
      const { secret: victimSecret } = await enableStaffTotp();
      const before = await totpState(staffUserId);
      const pending = await staffPending();
      const withTemp = (r: request.Test) => r.set('Authorization', `Bearer ${pending.tempToken}`).set('X-CSRF-Token', pending.csrf);

      expectOpaque403(await withTemp(pending.agent.post('/api/v1/auth/totp/setup')));
      expectOpaque403(await withTemp(pending.agent.post('/api/v1/auth/totp/confirm')).send({ code: '123456' }));
      expect(await totpState(staffUserId)).toEqual(before);

      // Only the victim's own code turns this tempToken into a session.
      await staffVerify(pending, totpCode(victimSecret)).expect(200);
    });

    it('B3: the tempToken lives 5 minutes and carries only the verify permission; a session token is unaffected', async () => {
      await resetUser(staffUserId, STAFF_PASSWORD);
      const full = await staffLogin();
      const session = claims(full.res.body.accessToken);
      expect(session.permissions).not.toContain(PENDING_PERMISSION);
      expect(session.exp - session.iat).toBe(15 * 60);

      await enableStaffTotp();
      const temp = claims((await staffPending()).tempToken);
      expect(temp.permissions).toEqual([PENDING_PERMISSION]);
      expect(temp.exp - temp.iat).toBe(PENDING_TTL_SECONDS);
    });
  });

  describe('staff: legitimate flows still work', () => {
    it('C2: login with 2FA, submit a correct code, get a full session that reaches a permission-guarded route', async () => {
      await resetUser(staffUserId, STAFF_PASSWORD);
      const { secret } = await enableStaffTotp();
      const pending = await staffPending();

      const verify = await staffVerify(pending, totpCode(secret)).expect(200);
      expect(cookieValue(verify.headers['set-cookie'], 'openestate_refresh')).toBeTruthy();
      expect(claims(verify.body.accessToken).permissions).not.toContain(PENDING_PERMISSION);
      await request(app.getHttpServer()).get('/api/v1/users').set('Authorization', `Bearer ${verify.body.accessToken}`).expect(200);
    });

    it('C3: a recovery code works as the second factor, once', async () => {
      await resetUser(staffUserId, STAFF_PASSWORD);
      const { recoveryCodes } = await enableStaffTotp();

      const first = await staffVerify(await staffPending(), recoveryCodes[0]).expect(200);
      await request(app.getHttpServer()).get('/api/v1/users').set('Authorization', `Bearer ${first.body.accessToken}`).expect(200);
      await staffVerify(await staffPending(), recoveryCodes[0]).expect(401);
    });

    it('C4: a full session reached through 2FA can still set up, confirm and disable 2FA', async () => {
      await resetUser(staffUserId, STAFF_PASSWORD);
      const { secret } = await enableStaffTotp(); // setup + confirm from a 2FA-off session
      const pending = await staffPending();
      const verify = await staffVerify(pending, totpCode(secret)).expect(200);
      const csrf = cookieValue(verify.headers['set-cookie'], STAFF_CSRF)!;
      const withSession = (r: request.Test) => r.set('Authorization', `Bearer ${verify.body.accessToken}`).set('X-CSRF-Token', csrf);

      // Re-enrol a new device from the post-2FA session…
      const setup = await withSession(pending.agent.post('/api/v1/auth/totp/setup')).expect(200);
      await withSession(pending.agent.post('/api/v1/auth/totp/confirm')).send({ code: totpCode(setup.body.secret) }).expect(200);
      expect((await withSession(pending.agent.get('/api/v1/auth/me')).expect(200)).body.totpEnabled).toBe(true);

      // …then turn 2FA off.
      await withSession(pending.agent.post('/api/v1/auth/totp/disable')).expect(204);
      expect((await totpState(staffUserId)).totpEnabled).toBe(false);
    });

    it('C5: a full session token is refused by totp/verify', async () => {
      await resetUser(staffUserId, STAFF_PASSWORD);
      const { secret } = await enableStaffTotp();
      const pending = await staffPending();
      const verify = await staffVerify(pending, totpCode(secret)).expect(200);
      const csrf = cookieValue(verify.headers['set-cookie'], STAFF_CSRF)!;

      const again = await pending.agent
        .post('/api/v1/auth/totp/verify')
        .set('Authorization', `Bearer ${verify.body.accessToken}`)
        .set('X-CSRF-Token', csrf)
        .send({ code: totpCode(secret) });
      expect(again.status).toBe(403);
    });
  });

  // ── portal helpers ──

  async function portalLogin() {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/portal/auth/login').send({ identifier: portalPhone, password: PORTAL_PASSWORD }).expect(200);
    return { agent, res, csrf: cookieValue(res.headers['set-cookie'], PORTAL_CSRF)! };
  }

  async function enablePortalTotp(): Promise<{ secret: string; recoveryCodes: string[] }> {
    const { agent, res, csrf } = await portalLogin();
    const token = res.body.accessToken as string;
    const setup = await agent.post('/api/v1/portal/auth/totp/setup').set('Authorization', `Bearer ${token}`).set('X-CSRF-Token', csrf).expect(200);
    const confirm = await agent
      .post('/api/v1/portal/auth/totp/confirm')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ code: totpCode(setup.body.secret) })
      .expect(200);
    return { secret: setup.body.secret, recoveryCodes: confirm.body.recoveryCodes };
  }

  async function portalPending() {
    const { agent, res, csrf } = await portalLogin();
    expect(res.body.requiresTwoFactor).toBe(true);
    expect(res.body.accessToken).toBeUndefined();
    return { agent, tempToken: res.body.tempToken as string, csrf, setCookie: res.headers['set-cookie'] };
  }

  // Not async, same reason as staffVerify.
  function portalVerify(pending: Awaited<ReturnType<typeof portalPending>>, code: string) {
    return pending.agent
      .post('/api/v1/portal/auth/totp/verify')
      .set('Authorization', `Bearer ${pending.tempToken}`)
      .set('X-CSRF-Token', pending.csrf)
      .send({ code });
  }

  describe('portal: the attack is refused', () => {
    it('A2: a password-only portal tempToken cannot remove 2FA via POST /portal/auth/totp/disable', async () => {
      await resetUser(portalUserId, PORTAL_PASSWORD);
      await enablePortalTotp();
      const before = await totpState(portalUserId);
      expect(before.totpEnabled).toBe(true);

      const { agent, tempToken, csrf } = await portalPending();
      expectOpaque403(await agent.post('/api/v1/portal/auth/totp/disable').set('Authorization', `Bearer ${tempToken}`).set('X-CSRF-Token', csrf));

      expect(await totpState(portalUserId)).toEqual(before);
      await portalPending();
    });

    it('A3: a portal tempToken is refused on every portal route, undecorated or permission-guarded', async () => {
      await resetUser(portalUserId, PORTAL_PASSWORD);
      await enablePortalTotp();
      const { agent, tempToken, csrf } = await portalPending();
      const auth = (r: request.Test) => r.set('Authorization', `Bearer ${tempToken}`).set('X-CSRF-Token', csrf);

      const observed = {
        'GET /portal/auth/me': (await auth(agent.get('/api/v1/portal/auth/me'))).status,
        'GET /portal/branding': (await auth(agent.get('/api/v1/portal/branding'))).status,
        'GET /portal/profile': (await auth(agent.get('/api/v1/portal/profile'))).status,
        'GET /portal/account': (await auth(agent.get('/api/v1/portal/account'))).status,
        'GET /portal/account/documents': (await auth(agent.get('/api/v1/portal/account/documents'))).status,
        'GET /portal/property': (await auth(agent.get('/api/v1/portal/property'))).status,
        'GET /portal/tickets': (await auth(agent.get('/api/v1/portal/tickets'))).status,
        'POST /portal/auth/logout-all': (await auth(agent.post('/api/v1/portal/auth/logout-all'))).status,
        'POST /portal/auth/change-password': (
          await auth(agent.post('/api/v1/portal/auth/change-password')).send({ currentPassword: PORTAL_PASSWORD, newPassword: 'AttackerChosen-2028' })
        ).status,
      };
      expect(observed).toEqual({
        'GET /portal/auth/me': 403,
        'GET /portal/branding': 403,
        'GET /portal/profile': 403,
        'GET /portal/account': 403,
        'GET /portal/account/documents': 403,
        'GET /portal/property': 403,
        'GET /portal/tickets': 403,
        'POST /portal/auth/logout-all': 403,
        'POST /portal/auth/change-password': 403,
      });
      expectOpaque403(await auth(agent.get('/api/v1/portal/auth/me')));
    });

    it('A3 cross-surface: a PORTAL tempToken is refused by the staff /auth/totp/disable, even with a made-up CSRF pair', async () => {
      await resetUser(portalUserId, PORTAL_PASSWORD);
      await enablePortalTotp();
      const { tempToken } = await portalPending();
      expectOpaque403(
        await request(app.getHttpServer())
          .post('/api/v1/auth/totp/disable')
          .set('Authorization', `Bearer ${tempToken}`)
          .set('Cookie', `${STAFF_CSRF}=forged`)
          .set('X-CSRF-Token', 'forged'),
      );
      expect((await totpState(portalUserId)).totpEnabled).toBe(true);
    });

    it('A4: the portal refresh endpoint cannot mint a session from a 2FA-pending login', async () => {
      await resetUser(portalUserId, PORTAL_PASSWORD);
      await enablePortalTotp();
      const { agent, tempToken, setCookie } = await portalPending();
      expect(cookieValue(setCookie, 'openestate_portal_refresh')).toBeUndefined();

      await agent.post('/api/v1/portal/auth/refresh').expect(401);
      await request(app.getHttpServer()).post('/api/v1/portal/auth/refresh').set('Authorization', `Bearer ${tempToken}`).expect(401);
    });

    it("A4: the one-login portal takeover fails — setup and confirm refuse the tempToken, and the victim's authenticator still works", async () => {
      await resetUser(portalUserId, PORTAL_PASSWORD);
      const { secret: victimSecret } = await enablePortalTotp();
      const before = await totpState(portalUserId);
      const pending = await portalPending();
      const withTemp = (r: request.Test) => r.set('Authorization', `Bearer ${pending.tempToken}`).set('X-CSRF-Token', pending.csrf);

      expectOpaque403(await withTemp(pending.agent.post('/api/v1/portal/auth/totp/setup')));
      expectOpaque403(await withTemp(pending.agent.post('/api/v1/portal/auth/totp/confirm')).send({ code: '123456' }));
      expect(await totpState(portalUserId)).toEqual(before);

      await portalVerify(pending, totpCode(victimSecret)).expect(200);
    });

    it('B3: the portal tempToken lives 5 minutes and carries only the verify permission', async () => {
      await resetUser(portalUserId, PORTAL_PASSWORD);
      await enablePortalTotp();
      const temp = claims((await portalPending()).tempToken);
      expect(temp.permissions).toEqual([PENDING_PERMISSION]);
      expect(temp.exp - temp.iat).toBe(PENDING_TTL_SECONDS);
    });
  });

  describe('portal: legitimate flows still work', () => {
    it('C2: login with 2FA, submit a correct code, get a full session that reaches a permission-guarded route', async () => {
      await resetUser(portalUserId, PORTAL_PASSWORD);
      const { secret } = await enablePortalTotp();
      const verify = await portalVerify(await portalPending(), totpCode(secret)).expect(200);
      expect(cookieValue(verify.headers['set-cookie'], 'openestate_portal_refresh')).toBeTruthy();
      expect(claims(verify.body.accessToken).permissions).not.toContain(PENDING_PERMISSION);
      await request(app.getHttpServer()).get('/api/v1/portal/profile').set('Authorization', `Bearer ${verify.body.accessToken}`).expect(200);
    });

    it('C3: a recovery code works as the second factor, once', async () => {
      await resetUser(portalUserId, PORTAL_PASSWORD);
      const { recoveryCodes } = await enablePortalTotp();

      const first = await portalVerify(await portalPending(), recoveryCodes[0]).expect(200);
      await request(app.getHttpServer()).get('/api/v1/portal/profile').set('Authorization', `Bearer ${first.body.accessToken}`).expect(200);
      await portalVerify(await portalPending(), recoveryCodes[0]).expect(401);
    });

    it('C4: a full session reached through 2FA can still set up, confirm and disable 2FA', async () => {
      await resetUser(portalUserId, PORTAL_PASSWORD);
      const { secret } = await enablePortalTotp();
      const pending = await portalPending();
      const verify = await portalVerify(pending, totpCode(secret)).expect(200);
      const csrf = cookieValue(verify.headers['set-cookie'], PORTAL_CSRF)!;
      const withSession = (r: request.Test) => r.set('Authorization', `Bearer ${verify.body.accessToken}`).set('X-CSRF-Token', csrf);

      const setup = await withSession(pending.agent.post('/api/v1/portal/auth/totp/setup')).expect(200);
      await withSession(pending.agent.post('/api/v1/portal/auth/totp/confirm')).send({ code: totpCode(setup.body.secret) }).expect(200);
      expect((await withSession(pending.agent.get('/api/v1/portal/auth/me')).expect(200)).body.totpEnabled).toBe(true);

      await withSession(pending.agent.post('/api/v1/portal/auth/totp/disable')).expect(204);
      expect((await totpState(portalUserId)).totpEnabled).toBe(false);
    });

    it('C5: a full session token is refused by portal totp/verify', async () => {
      await resetUser(portalUserId, PORTAL_PASSWORD);
      const { secret } = await enablePortalTotp();
      const pending = await portalPending();
      const verify = await portalVerify(pending, totpCode(secret)).expect(200);
      const csrf = cookieValue(verify.headers['set-cookie'], PORTAL_CSRF)!;

      const again = await pending.agent
        .post('/api/v1/portal/auth/totp/verify')
        .set('Authorization', `Bearer ${verify.body.accessToken}`)
        .set('X-CSRF-Token', csrf)
        .send({ code: totpCode(secret) });
      expect(again.status).toBe(403);
    });
  });
});
