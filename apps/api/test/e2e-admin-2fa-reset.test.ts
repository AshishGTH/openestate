/**
 * Through-the-wire coverage for the admin 2FA reset, staff
 * (POST /users/:id/reset-2fa) and portal (POST /admin/portal-2fa-resets).
 *
 * What a reset must leave behind: 2FA off with no secret, no recovery codes
 * and no TOTP lockout (TOTP_CLEARED); every refresh token revoked; one
 * TOTP_RESET_BY_ADMIN audit row naming the admin, holding no secret; the
 * password untouched. Then the proof that matters: the user signs in with
 * the password alone.
 *
 * The permission split is tested on a REAL sales_manager role
 * (ROLE_PERMISSIONS), not a stripped-down one: sales managers can issue a
 * portal password-reset link but must not be able to clear portal 2FA.
 *
 * Requires the compiled dist/ — see e2e-portal.test.ts for why.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  twoFactorResetResponseSchema,
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
const PASSWORD = 'AdminTwoFactorReset123';

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-admin-2fa-reset-${process.pid}-${Date.now()}-`;
// Portal login is IP-keyed at 5 per 5 minutes in production; this file logs
// portal users in more often than that. Scoped to this file's fork.
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

describeIf('admin 2FA reset, staff and portal', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let adminRoleId: string;
  let salesManagerRoleId: string;
  let customerRoleId: string;
  let brokerRoleId: string;
  let passwordHash: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let totp: any;
  let seq = 0;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    passwordHash = await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id });

    const require = createRequire(import.meta.url);
    const { TotpService } = require('../dist/auth/totp.service');
    totp = new TotpService({ getOrThrow: () => process.env.TOTP_ENCRYPTION_KEY });

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const permissions = await systemPrisma.permission.findMany({ select: { id: true, key: true } });
    const permByKey = new Map(permissions.map((p: { id: string; key: string }) => [p.key, p.id]));
    const grant = async (roleId: string, keys: readonly string[]) => {
      const ids = keys.map((k) => permByKey.get(k)).filter((id): id is string => !!id);
      await systemPrisma.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId, permissionId })) });
    };
    const makeRole = async (name: string, keys: readonly string[]) => {
      const role = await systemPrisma.role.create({
        data: { companyId: fx.companyId, name, slug: `e2e-a2fa-${name.toLowerCase().replace(/\W+/g, '-')}-${TAG}`, isSystem: true },
      });
      await grant(role.id, keys);
      return role.id as string;
    };
    adminRoleId = await makeRole('Admin', ALL_PERMISSIONS);
    salesManagerRoleId = await makeRole('Sales Manager', ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_MANAGER]);
    customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    await grant(customerRoleId, ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]);
    brokerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'broker');
    await grant(brokerRoleId, ROLE_PERMISSIONS[SYSTEM_ROLES.BROKER]);
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  // ── fixtures ──

  async function createStaff(roleId: string, opts: { isActive?: boolean; companyId?: string } = {}) {
    const email = `e2e-a2fa-${TAG}-${++seq}@test.com`;
    const user = await systemPrisma.user.create({
      data: {
        companyId: opts.companyId ?? fx.companyId,
        email,
        passwordHash,
        name: `Staff ${seq}`,
        roleId,
        forcePasswordChange: false,
        isActive: opts.isActive ?? true,
      },
    });
    return { id: user.id as string, email };
  }

  /**
   * A portal account with a phone high-entropy enough to be unique across
   * the whole test database — portal login looks the identifier up in every
   * company (see e2e-portal-throttle.test.ts).
   */
  async function createPortalAccount(kind: 'applicant' | 'broker', opts: { isActive?: boolean } = {}) {
    const n = ++seq;
    const phone = `8${String(TAG).slice(-6)}${String(n).padStart(3, '0')}`;
    if (kind === 'applicant') {
      const applicant = await systemPrisma.applicant.create({
        data: { companyId: fx.companyId, name: `Customer ${n}`, primaryPhone: phone, primaryPhoneNormalized: phone },
      });
      const user = await systemPrisma.user.create({
        data: {
          companyId: fx.companyId, applicantId: applicant.id, phone, name: `Customer ${n}`,
          passwordHash, roleId: customerRoleId, forcePasswordChange: false, isActive: opts.isActive ?? true,
        },
      });
      return { userId: user.id as string, phone, body: { applicantId: applicant.id as string } };
    }
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    await systemPrisma.broker.update({ where: { id: brokerId }, data: { phone } });
    const user = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId, brokerId, phone, name: `Broker ${n}`,
        passwordHash, roleId: brokerRoleId, forcePasswordChange: false, isActive: opts.isActive ?? true,
      },
    });
    return { userId: user.id as string, phone, body: { brokerId } };
  }

  /** Turns 2FA on and leaves the user TOTP-locked — the worst state to recover from. */
  async function enableTotpAndLock(userId: string) {
    const { secret } = totp.generateSecret('e2e');
    await systemPrisma.user.update({
      where: { id: userId },
      data: {
        totpSecret: totp.encrypt(secret),
        totpEnabled: true,
        recoveryCodes: totp.generateRecoveryCodes(),
        failedTotpAttempts: 5,
        totpLockedUntil: new Date(Date.now() + 5 * 60_000),
      },
    });
  }

  const totpState = (userId: string) =>
    systemPrisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        totpEnabled: true, totpSecret: true, recoveryCodes: true,
        failedTotpAttempts: true, totpLockedUntil: true, passwordHash: true, isActive: true,
      },
    });

  function expectCleared(s: Awaited<ReturnType<typeof totpState>>) {
    expect(s.totpEnabled).toBe(false);
    expect(s.totpSecret).toBeNull();
    expect(s.recoveryCodes).toEqual([]);
    expect(s.failedTotpAttempts).toBe(0);
    expect(s.totpLockedUntil).toBeNull();
  }

  // A full session answers { accessToken } only; requiresTwoFactor appears
  // solely on the 2FA-pending branch.
  function expectFullSession(body: { accessToken?: string; requiresTwoFactor?: boolean }) {
    expect(body.requiresTwoFactor).toBeUndefined();
    expect(body.accessToken).toBeTruthy();
  }

  const liveRefreshTokens = (userId: string) =>
    systemPrisma.refreshToken.count({ where: { userId, isRevoked: false } });

  const resetAudits = (targetUserId: string) =>
    systemPrisma.auditLog.findMany({
      where: { entityId: targetUserId, action: 'TOTP_RESET_BY_ADMIN' },
      orderBy: { createdAt: 'asc' },
    });

  async function staffSession(email: string) {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
    const csrf = cookieValue(login.headers['set-cookie'], 'openestate_csrf')!;
    return { agent, login, csrf, token: login.body.accessToken as string | undefined };
  }

  // Takes the expected status rather than returning the request: a supertest
  // Test is thenable, so returning it from an async function would send it
  // unasserted.
  async function resetStaff(adminEmail: string, targetId: string, status: number) {
    const s = await staffSession(adminEmail);
    return s.agent
      .post(`/api/v1/users/${targetId}/reset-2fa`)
      .set('Authorization', `Bearer ${s.token}`)
      .set('X-CSRF-Token', s.csrf)
      .expect(status);
  }

  async function resetPortal(adminEmail: string, body: object, status: number) {
    const s = await staffSession(adminEmail);
    return s.agent
      .post('/api/v1/admin/portal-2fa-resets')
      .set('Authorization', `Bearer ${s.token}`)
      .set('X-CSRF-Token', s.csrf)
      .send(body)
      .expect(status);
  }

  // ── staff ──

  describe('staff: POST /users/:id/reset-2fa', () => {
    it('clears 2FA and the lockout, revokes sessions, audits without secrets, and the password alone signs in', async () => {
      const admin = await createStaff(adminRoleId);
      const target = await createStaff(adminRoleId);
      // A live session from before 2FA was on, so there is a refresh token to revoke.
      const before = await staffSession(target.email);
      expectFullSession(before.login.body);
      await enableTotpAndLock(target.id);
      const secretBefore = (await totpState(target.id)).totpSecret;
      expect(await liveRefreshTokens(target.id)).toBeGreaterThan(0);

      const res = await resetStaff(admin.email, target.id, 200);
      expect(twoFactorResetResponseSchema.parse(res.body)).toEqual({ wasEnabled: true });

      const s = await totpState(target.id);
      expectCleared(s);
      expect(s.passwordHash).toBe(passwordHash);
      expect(await liveRefreshTokens(target.id)).toBe(0);
      // Refreshing seconds later is inside the reuse grace window — which must
      // not resurrect a session: revokeAllForUser leaves no live token in the family.
      await before.agent.post('/api/v1/auth/refresh').expect(401);

      const [audit, ...extra] = await resetAudits(target.id);
      expect(extra).toHaveLength(0);
      expect(audit.userId).toBe(admin.id);
      expect(audit.companyId).toBe(fx.companyId);
      expect(audit.entityType).toBe('User');
      expect(audit.after).toEqual({ surface: 'staff', wasEnabled: true });
      expect(audit.ipAddress).toBeTruthy();
      expect(JSON.stringify(audit)).not.toContain(secretBefore);

      const after = await staffSession(target.email);
      expectFullSession(after.login.body);
      await request(app.getHttpServer()).get('/api/v1/users').set('Authorization', `Bearer ${after.token}`).expect(200);
    });

    it('a reset with nothing to clear returns wasEnabled false and is still audited', async () => {
      const admin = await createStaff(adminRoleId);
      const target = await createStaff(adminRoleId);
      await enableTotpAndLock(target.id);

      await resetStaff(admin.email, target.id, 200);
      const again = await resetStaff(admin.email, target.id, 200);
      expect(again.body).toEqual({ wasEnabled: false });

      const audits = await resetAudits(target.id);
      expect(audits.map((a: { after: unknown }) => a.after)).toEqual([
        { surface: 'staff', wasEnabled: true },
        { surface: 'staff', wasEnabled: false },
      ]);
    });

    it('allows a deactivated user, who still cannot sign in afterwards', async () => {
      const admin = await createStaff(adminRoleId);
      const target = await createStaff(adminRoleId, { isActive: false });
      await enableTotpAndLock(target.id);

      await resetStaff(admin.email, target.id, 200);
      const s = await totpState(target.id);
      expectCleared(s);
      expect(s.isActive).toBe(false);
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: target.email, password: PASSWORD })
        .expect(401);
    });

    it('403 for a real sales_manager, and nothing changes', async () => {
      const caller = await createStaff(salesManagerRoleId);
      const target = await createStaff(adminRoleId);
      await enableTotpAndLock(target.id);

      await resetStaff(caller.email, target.id, 403);
      expect((await totpState(target.id)).totpEnabled).toBe(true);
      expect(await resetAudits(target.id)).toHaveLength(0);
    });

    it('404 for a user in another company', async () => {
      const admin = await createStaff(adminRoleId);
      const other = await seedCompany(systemPrisma);
      try {
        const otherRole = await systemPrisma.role.create({
          data: { companyId: other.companyId, name: 'Other', slug: `e2e-a2fa-other-${TAG}`, isSystem: true },
        });
        const target = await createStaff(otherRole.id, { companyId: other.companyId });
        await enableTotpAndLock(target.id);

        await resetStaff(admin.email, target.id, 404);
        expect((await totpState(target.id)).totpEnabled).toBe(true);
        expect(await resetAudits(target.id)).toHaveLength(0);
      } finally {
        await cleanupCompany(systemPrisma, other.companyId);
      }
    });

    it('400 for a portal user, pointing at the customer or broker record', async () => {
      const admin = await createStaff(adminRoleId);
      const portal = await createPortalAccount('applicant');
      await enableTotpAndLock(portal.userId);

      const res = await resetStaff(admin.email, portal.userId, 400);
      expect(res.body.message).toMatch(/portal user/i);
      expect((await totpState(portal.userId)).totpEnabled).toBe(true);
    });

    it('400 for your own account', async () => {
      const admin = await createStaff(adminRoleId);
      const res = await resetStaff(admin.email, admin.id, 400);
      expect(res.body.message).toMatch(/Disable 2FA/);
      expect(await resetAudits(admin.id)).toHaveLength(0);
    });

    it('403 for a 2FA-pending token, even from an admin', async () => {
      const admin = await createStaff(adminRoleId);
      await enableTotpAndLock(admin.id);
      const target = await createStaff(adminRoleId);
      await enableTotpAndLock(target.id);

      const pending = await staffSession(admin.email);
      expect(pending.login.body.requiresTwoFactor).toBe(true);
      await pending.agent
        .post(`/api/v1/users/${target.id}/reset-2fa`)
        .set('Authorization', `Bearer ${pending.login.body.tempToken}`)
        .set('X-CSRF-Token', pending.csrf)
        .expect(403);
      expect((await totpState(target.id)).totpEnabled).toBe(true);
    });

    it('403 without the CSRF header', async () => {
      const admin = await createStaff(adminRoleId);
      const target = await createStaff(adminRoleId);
      await enableTotpAndLock(target.id);

      const s = await staffSession(admin.email);
      await s.agent.post(`/api/v1/users/${target.id}/reset-2fa`).set('Authorization', `Bearer ${s.token}`).expect(403);
      expect((await totpState(target.id)).totpEnabled).toBe(true);
    });
  });

  // ── portal ──

  describe('portal: POST /admin/portal-2fa-resets', () => {
    it('applicant: clears 2FA and the lockout, revokes sessions, audits, and the password alone signs in', async () => {
      const admin = await createStaff(adminRoleId);
      const target = await createPortalAccount('applicant');
      const beforeAgent = request.agent(app.getHttpServer());
      const beforeLogin = await beforeAgent
        .post('/api/v1/portal/auth/login')
        .send({ identifier: target.phone, password: PASSWORD })
        .expect(200);
      expectFullSession(beforeLogin.body);
      await enableTotpAndLock(target.userId);
      expect(await liveRefreshTokens(target.userId)).toBeGreaterThan(0);

      const res = await resetPortal(admin.email, target.body, 200);
      expect(twoFactorResetResponseSchema.parse(res.body)).toEqual({ wasEnabled: true });

      const s = await totpState(target.userId);
      expectCleared(s);
      expect(s.passwordHash).toBe(passwordHash);
      expect(await liveRefreshTokens(target.userId)).toBe(0);
      await beforeAgent.post('/api/v1/portal/auth/refresh').expect(401);

      const [audit, ...extra] = await resetAudits(target.userId);
      expect(extra).toHaveLength(0);
      expect(audit.userId).toBe(admin.id);
      expect(audit.after).toEqual({
        surface: 'portal', wasEnabled: true, applicantId: target.body.applicantId, brokerId: null,
      });

      const after = await request(app.getHttpServer())
        .post('/api/v1/portal/auth/login')
        .send({ identifier: target.phone, password: PASSWORD })
        .expect(200);
      expectFullSession(after.body);
      await request(app.getHttpServer())
        .get('/api/v1/portal/profile')
        .set('Authorization', `Bearer ${after.body.accessToken}`)
        .expect(200);
    });

    it('broker: 200, and wasEnabled false when 2FA was never on', async () => {
      const admin = await createStaff(adminRoleId);
      const target = await createPortalAccount('broker');

      const res = await resetPortal(admin.email, target.body, 200);
      expect(res.body).toEqual({ wasEnabled: false });
      const [audit] = await resetAudits(target.userId);
      expect(audit.after).toEqual({ surface: 'portal', wasEnabled: false, applicantId: null, brokerId: target.body.brokerId });
    });

    it('403 for a real sales_manager — who CAN issue the same account a password-reset link', async () => {
      const caller = await createStaff(salesManagerRoleId);
      const target = await createPortalAccount('broker');
      await enableTotpAndLock(target.userId);

      await resetPortal(caller.email, target.body, 403);
      expect((await totpState(target.userId)).totpEnabled).toBe(true);
      expect(await resetAudits(target.userId)).toHaveLength(0);

      // The split is deliberate, not a broken role: the same caller is allowed
      // the password-reset link under ADMIN_PORTAL_INVITE_SEND.
      const s = await staffSession(caller.email);
      await s.agent
        .post('/api/v1/admin/portal-password-resets')
        .set('Authorization', `Bearer ${s.token}`)
        .set('X-CSRF-Token', s.csrf)
        .send(target.body)
        .expect(200);
    });

    it(`409 with code ${NO_PORTAL_ACCOUNT_ERROR} when the applicant has no portal account`, async () => {
      const admin = await createStaff(adminRoleId);
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);

      const res = await resetPortal(admin.email, { applicantId }, 409);
      expect(res.body.code).toBe(NO_PORTAL_ACCOUNT_ERROR);
    });

    it('404 for an applicant in another company', async () => {
      const admin = await createStaff(adminRoleId);
      const other = await seedCompany(systemPrisma);
      try {
        const applicantId = await makeApplicant(systemPrisma, other.companyId);
        await resetPortal(admin.email, { applicantId }, 404);
      } finally {
        await cleanupCompany(systemPrisma, other.companyId);
      }
    });

    it('400 when both ids are supplied, and when neither is', async () => {
      const admin = await createStaff(adminRoleId);
      await resetPortal(admin.email, { applicantId: randomUUID(), brokerId: randomUUID() }, 400);
      await resetPortal(admin.email, {}, 400);
    });

    it('allows a deactivated portal account', async () => {
      const admin = await createStaff(adminRoleId);
      const target = await createPortalAccount('applicant', { isActive: false });
      await enableTotpAndLock(target.userId);

      await resetPortal(admin.email, target.body, 200);
      const s = await totpState(target.userId);
      expectCleared(s);
      expect(s.isActive).toBe(false);
    });
  });

  // ── concurrency ──

  /**
   * Several admins clicking Reset on the same account at once. Each reset
   * reads totp_enabled under SELECT ... FOR UPDATE, so the requests serialise
   * on the row: exactly one sees 2FA on and reports wasEnabled true; the rest
   * wait for it to commit and see it off. Without the lock, READ COMMITTED
   * lets several read "on" before any commits, and both the responses and the
   * audit trail overstate what happened.
   *
   * The overlap is forced, not hoped for. Simply firing requests together
   * proved unreliable: with the lock removed, the staff test still passed
   * two runs in three, because the requests often happened to run in turn.
   * So the test takes its own lock on the row, fires the requests, waits
   * until every one of them is blocked behind that lock, then releases it.
   * With FOR UPDATE, each request blocks BEFORE its read. Without it, a plain
   * read is not blocked by a row lock, so every request reads "on" and then
   * blocks at its UPDATE, and all of them report true. The outcome is fixed
   * either way.
   *
   * 4 requests, not 5: each blocked request holds one of the app's system
   * pool connections (connection_limit=5 in the test URLs), and a fifth
   * would wait for a connection instead of the lock, so the barrier would
   * never fill.
   */
  describe('concurrent resets of the same account', () => {
    const CONCURRENT = 4;

    /** Sessions blocked by `holderPid`, directly or behind other waiters in the queue. */
    async function blockedBehind(holderPid: number): Promise<number> {
      const [{ n }] = await systemPrisma.$queryRaw<Array<{ n: number }>>`
        WITH RECURSIVE blocked(pid) AS (
          SELECT ${holderPid}::int
          UNION
          SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY (pg_blocking_pids(a.pid))
        )
        SELECT (count(*) - 1)::int AS n FROM blocked
      `;
      return n;
    }

    async function fireWhileRowLocked(userId: string, send: () => request.Test): Promise<request.Response[]> {
      let responses!: Promise<request.Response[]>;
      await systemPrisma.$transaction(
        async (tx: typeof systemPrisma) => {
          await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          responses = Promise.all(Array.from({ length: CONCURRENT }, () => send().then((r) => r)));

          const deadline = Date.now() + 15_000;
          let n = 0;
          while ((n = await blockedBehind(pid)) < CONCURRENT) {
            if (Date.now() > deadline) throw new Error(`only ${n} of ${CONCURRENT} resets reached the row lock`);
            await new Promise((r) => setTimeout(r, 50));
          }
        },
        { timeout: 30_000 },
      );
      return responses;
    }

    async function expectExactlyOneWasEnabled(responses: request.Response[], targetUserId: string, surface: 'staff' | 'portal') {
      expect(responses.map((r) => r.status)).toEqual(Array(CONCURRENT).fill(200));
      const flags = responses.map((r) => twoFactorResetResponseSchema.parse(r.body).wasEnabled);
      expect(flags.filter(Boolean)).toHaveLength(1);

      // The audit trail tells the same story as the responses.
      const audits = await resetAudits(targetUserId);
      expect(audits).toHaveLength(CONCURRENT);
      expect(audits.filter((a: { after: { wasEnabled: boolean } }) => a.after.wasEnabled)).toHaveLength(1);
      for (const a of audits) expect((a.after as { surface: string }).surface).toBe(surface);

      expectCleared(await totpState(targetUserId));
    }

    it('staff: exactly one of several simultaneous resets reports wasEnabled true', async () => {
      const admin = await createStaff(adminRoleId);
      const target = await createStaff(adminRoleId);
      await enableTotpAndLock(target.id);
      const s = await staffSession(admin.email);

      const responses = await fireWhileRowLocked(target.id, () =>
        request(app.getHttpServer())
          .post(`/api/v1/users/${target.id}/reset-2fa`)
          .set('Cookie', `openestate_csrf=${s.csrf}`)
          .set('Authorization', `Bearer ${s.token}`)
          .set('X-CSRF-Token', s.csrf),
      );
      await expectExactlyOneWasEnabled(responses, target.id, 'staff');
    });

    it('portal: exactly one of several simultaneous resets reports wasEnabled true', async () => {
      const admin = await createStaff(adminRoleId);
      const target = await createPortalAccount('broker');
      await enableTotpAndLock(target.userId);
      const s = await staffSession(admin.email);

      const responses = await fireWhileRowLocked(target.userId, () =>
        request(app.getHttpServer())
          .post('/api/v1/admin/portal-2fa-resets')
          .set('Cookie', `openestate_csrf=${s.csrf}`)
          .set('Authorization', `Bearer ${s.token}`)
          .set('X-CSRF-Token', s.csrf)
          .send(target.body),
      );
      await expectExactlyOneWasEnabled(responses, target.userId, 'portal');
    });
  });
});
