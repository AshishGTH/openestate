/**
 * Second-factor lockout on totp/verify, staff and portal
 * (apps/api/src/auth/totp-lockout.ts): 5 consecutive failed codes, TOTP or
 * recovery, lock the second factor for 5 minutes. A successful verify clears
 * the count; a lock that has run out restarts it. It never touches the
 * password lockout.
 *
 * Isolated from the per-user verify rate limit, which fires at the same
 * count: TOTP_VERIFY_THROTTLE_LIMIT is raised here, so every refusal in this
 * file comes from the lockout, and each test checks the lockout's own message
 * to prove it. What the lockout adds on top of the rate limit at the shipped
 * limits is tested in e2e-totp-verify-throttle.test.ts.
 *
 * The app's database session runs in Asia/Kolkata, like the verification
 * VM, because the lock is written in raw SQL and a time-zone slip there
 * would move it by 5.5 hours.
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
import { createSystemPrismaClient } from '@openestate/db';
import { ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { makeClients, seedCompany, makePortalRole, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-totp-lockout-${process.pid}-${Date.now()}-`;
process.env.TOTP_VERIFY_THROTTLE_LIMIT = '100';
process.env.PORTAL_AUTH_THROTTLE_LIMIT = '100';

// Mirrors totp-lockout.ts.
const MAX_FAILED = 5;
const LOCK_MINUTES = 5;
const LOCKED_MESSAGE = 'Too many incorrect codes. Wait a few minutes, then sign in again.';

const TAG = Date.now();
const PASSWORD = 'LockoutPassword123';
const SESSION_TIME_ZONE = 'Asia/Kolkata';
const withSessionTimeZone = (url: string) =>
  `${url}${url.includes('?') ? '&' : '?'}options=-c%20TimeZone%3D${encodeURIComponent(SESSION_TIME_ZONE)}`;

async function bootstrapApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = APP_URL;
  // The client AuthService/PortalAuthService write the lock through.
  process.env.DATABASE_URL_SYSTEM = withSessionTimeZone(SYSTEM_URL!);
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

/** A well-formed code that isn't the current one. */
const wrongCode = (secret: string) => String((Number(totpCode(secret)) + 500_000) % 1_000_000).padStart(6, '0');
const WRONG_RECOVERY = 'AAAAA-AAAAA';

function cookieValue(setCookie: string[] | string | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  for (const h of headers) {
    const match = new RegExp(`(?:^|\\s)${name}=([^;]+)`).exec(h);
    if (match) return match[1];
  }
  return undefined;
}

type Surface = 'staff' | 'portal';
const LOGIN = { staff: '/api/v1/auth/login', portal: '/api/v1/portal/auth/login' };
const VERIFY = { staff: '/api/v1/auth/totp/verify', portal: '/api/v1/portal/auth/totp/verify' };
const CSRF = { staff: 'openestate_csrf', portal: 'openestate_portal_csrf' };
const GUARDED = { staff: '/api/v1/users', portal: '/api/v1/portal/profile' };
// Self-service 2FA routes, for the disable-clears-the-lock case below.
const AUTH = { staff: '/api/v1/auth', portal: '/api/v1/portal/auth' };

interface TestUser {
  id: string;
  surface: Surface;
  identifier: string;
  secret: string;
  recoveryCodes: string[];
}

describeIf('totp/verify lockout, staff and portal', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let staffRoleId: string;
  let customerRoleId: string;
  let passwordHash: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let totp: any;
  let userSeq = 0;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    passwordHash = await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id });

    const require = createRequire(import.meta.url);
    const { TotpService } = require('../dist/auth/totp.service');
    totp = new TotpService({ getOrThrow: () => process.env.TOTP_ENCRYPTION_KEY });

    const permissions = await systemPrisma.permission.findMany({ select: { id: true, key: true } });
    const permByKey = new Map(permissions.map((p: { id: string; key: string }) => [p.key, p.id]));
    const grant = async (roleId: string, keys: readonly string[]) => {
      const ids = keys.map((k) => permByKey.get(k)).filter((id): id is string => !!id);
      await systemPrisma.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId, permissionId })) });
    };
    staffRoleId = (
      await systemPrisma.role.create({
        data: { companyId: fx.companyId, name: 'E2E TOTP Lockout', slug: `e2e-tlo-${TAG}`, isSystem: true },
      })
    ).id;
    await grant(staffRoleId, ROLE_PERMISSIONS[SYSTEM_ROLES.SUPER_ADMIN]);
    customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    await grant(customerRoleId, ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]);
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  async function makeUser(surface: Surface): Promise<TestUser> {
    const n = ++userSeq;
    let id: string;
    let identifier: string;
    if (surface === 'staff') {
      identifier = `e2e-tlo-${TAG}-${n}@test.com`;
      id = (
        await systemPrisma.user.create({
          data: { companyId: fx.companyId, email: identifier, passwordHash, name: `Staff ${n}`, roleId: staffRoleId, forcePasswordChange: false },
        })
      ).id;
    } else {
      // High-entropy phone: portal login looks the identifier up across ALL companies.
      identifier = `7${String(TAG).slice(-6)}${String(n).padStart(3, '0')}`;
      const applicant = await systemPrisma.applicant.create({
        data: { companyId: fx.companyId, name: `Customer ${n}`, primaryPhone: identifier, primaryPhoneNormalized: identifier },
      });
      id = (
        await systemPrisma.user.create({
          data: { companyId: fx.companyId, applicantId: applicant.id, phone: identifier, name: `Customer ${n}`, passwordHash, roleId: customerRoleId, forcePasswordChange: false },
        })
      ).id;
    }
    const { secret } = totp.generateSecret(identifier);
    const recoveryCodes: string[] = totp.generateRecoveryCodes();
    await systemPrisma.user.update({
      where: { id },
      data: { totpSecret: totp.encrypt(secret), totpEnabled: true, recoveryCodes },
    });
    return { id, surface, identifier, secret, recoveryCodes };
  }

  async function pending(user: TestUser) {
    const agent = request.agent(app.getHttpServer());
    const body = user.surface === 'staff' ? { email: user.identifier, password: PASSWORD } : { identifier: user.identifier, password: PASSWORD };
    const res = await agent.post(LOGIN[user.surface]).send(body).expect(200);
    expect(res.body.requiresTwoFactor).toBe(true);
    return { user, agent, tempToken: res.body.tempToken as string, csrf: cookieValue(res.headers['set-cookie'], CSRF[user.surface])! };
  }

  // Not async: returns the supertest Test itself so callers can chain .expect().
  function verify(p: Awaited<ReturnType<typeof pending>>, code: string) {
    return p.agent.post(VERIFY[p.user.surface]).set('Authorization', `Bearer ${p.tempToken}`).set('X-CSRF-Token', p.csrf).send({ code });
  }

  const state = (userId: string) =>
    systemPrisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { failedTotpAttempts: true, totpLockedUntil: true, failedLoginAttempts: true, lockedUntil: true, recoveryCodes: true },
    });

  /** Drives the user into the TOTP lock with wrong codes. */
  async function lockOut(p: Awaited<ReturnType<typeof pending>>) {
    for (let i = 0; i < MAX_FAILED; i++) await verify(p, wrongCode(p.user.secret)).expect(401);
  }

  function expectLocked(res: request.Response) {
    expect(res.status).toBe(429);
    expect(res.body.message).toBe(LOCKED_MESSAGE);
    expect(cookieValue(res.headers['set-cookie'], 'openestate_refresh')).toBeUndefined();
    expect(cookieValue(res.headers['set-cookie'], 'openestate_portal_refresh')).toBeUndefined();
    expect(res.body.accessToken).toBeUndefined();
  }

  it(`the app's database session really runs in ${SESSION_TIME_ZONE}`, async () => {
    const probe = createSystemPrismaClient(process.env.DATABASE_URL_SYSTEM!);
    try {
      const [row] = await probe.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`;
      expect(row.tz).toBe(SESSION_TIME_ZONE);
    } finally {
      await probe.$disconnect();
    }
  });

  for (const surface of ['staff', 'portal'] as const) {
    describe(surface, () => {
      it('E3a: failures count up, the 5th sets a 5-minute lock, and a locked user is refused even with the right code', async () => {
        const user = await makeUser(surface);
        const p = await pending(user);

        for (let i = 1; i < MAX_FAILED; i++) {
          await verify(p, wrongCode(user.secret)).expect(401);
          const s = await state(user.id);
          expect(s.failedTotpAttempts).toBe(i);
          expect(s.totpLockedUntil).toBeNull();
        }

        await verify(p, wrongCode(user.secret)).expect(401);
        const locked = await state(user.id);
        expect(locked.failedTotpAttempts).toBe(MAX_FAILED);
        // 5 minutes from now in real time: a time-zone slip would be hours off.
        const lockMs = locked.totpLockedUntil.getTime() - Date.now();
        expect(lockMs).toBeGreaterThan(LOCK_MINUTES * 60_000 - 20_000);
        expect(lockMs).toBeLessThan(LOCK_MINUTES * 60_000 + 20_000);

        expectLocked(await verify(p, totpCode(user.secret)));
        expect((await state(user.id)).failedTotpAttempts).toBe(MAX_FAILED);
      });

      it('E3b: a successful verify clears both the count and a lock set by that same attempt', async () => {
        const user = await makeUser(surface);
        const p = await pending(user);
        for (let i = 0; i < MAX_FAILED - 1; i++) await verify(p, wrongCode(user.secret)).expect(401);
        expect((await state(user.id)).failedTotpAttempts).toBe(MAX_FAILED - 1);

        // The 5th attempt is right: its reservation sets the lock, success clears it.
        await verify(p, totpCode(user.secret)).expect(200);
        const s = await state(user.id);
        expect(s.failedTotpAttempts).toBe(0);
        expect(s.totpLockedUntil).toBeNull();
      });

      it('E3c: wrong codes, the lock and a later success never touch failedLoginAttempts or lockedUntil', async () => {
        const user = await makeUser(surface);
        const p = await pending(user);
        // Distinctive values, so any write to either field shows — including a write of 0 or null.
        const sentinel = new Date('2020-01-01T00:00:00.000Z');
        await systemPrisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 3, lockedUntil: sentinel } });

        await lockOut(p);
        expectLocked(await verify(p, totpCode(user.secret)));
        let s = await state(user.id);
        expect(s.totpLockedUntil).not.toBeNull();
        expect(s.failedLoginAttempts).toBe(3);
        expect(s.lockedUntil).toEqual(sentinel);

        await systemPrisma.user.update({ where: { id: user.id }, data: { totpLockedUntil: new Date(Date.now() - 1000) } });
        await verify(p, totpCode(user.secret)).expect(200);
        s = await state(user.id);
        expect(s.failedTotpAttempts).toBe(0);
        expect(s.failedLoginAttempts).toBe(3);
        expect(s.lockedUntil).toEqual(sentinel);
      });

      it('E3d: a TOTP-locked user can still pass the password step; only the code is refused', async () => {
        const user = await makeUser(surface);
        await lockOut(await pending(user));

        const again = await pending(user); // asserts 200 + requiresTwoFactor
        const s = await state(user.id);
        expect(s.failedLoginAttempts).toBe(0);
        expect(s.lockedUntil).toBeNull();
        expectLocked(await verify(again, totpCode(user.secret)));
      });

      it('E3e: once the lock runs out, the count starts again — one more mistake does not re-lock', async () => {
        const user = await makeUser(surface);
        const p = await pending(user);
        await lockOut(p);
        await systemPrisma.user.update({ where: { id: user.id }, data: { totpLockedUntil: new Date(Date.now() - 1000) } });

        await verify(p, wrongCode(user.secret)).expect(401);
        let s = await state(user.id);
        expect(s.failedTotpAttempts).toBe(1);
        expect(s.totpLockedUntil).toBeNull();

        await verify(p, totpCode(user.secret)).expect(200);
        s = await state(user.id);
        expect(s.failedTotpAttempts).toBe(0);
      });

      it('E3f: an honest user who mistypes twice, then enters the right code, gets in with the count back at zero', async () => {
        const user = await makeUser(surface);
        const p = await pending(user);
        await verify(p, wrongCode(user.secret)).expect(401);
        await verify(p, wrongCode(user.secret)).expect(401);
        const ok = await verify(p, totpCode(user.secret)).expect(200);

        await request(app.getHttpServer()).get(GUARDED[surface]).set('Authorization', `Bearer ${ok.body.accessToken}`).expect(200);
        const s = await state(user.id);
        expect(s.failedTotpAttempts).toBe(0);
        expect(s.totpLockedUntil).toBeNull();
      });

      it('E3g: wrong recovery codes count exactly like wrong TOTP codes, and a valid recovery code is refused (and not spent) while locked', async () => {
        const user = await makeUser(surface);
        const p = await pending(user);
        for (let i = 0; i < 3; i++) await verify(p, wrongCode(user.secret)).expect(401);
        await verify(p, WRONG_RECOVERY).expect(401);
        expect((await state(user.id)).failedTotpAttempts).toBe(4);
        await verify(p, WRONG_RECOVERY).expect(401);
        expect((await state(user.id)).totpLockedUntil).not.toBeNull();

        expectLocked(await verify(p, user.recoveryCodes[0]));
        expect((await state(user.id)).recoveryCodes).toContain(user.recoveryCodes[0]);

        // After the lock: a wrong recovery code counts, a valid one clears the count and is spent.
        await systemPrisma.user.update({ where: { id: user.id }, data: { totpLockedUntil: new Date(Date.now() - 1000) } });
        await verify(p, WRONG_RECOVERY).expect(401);
        expect((await state(user.id)).failedTotpAttempts).toBe(1);
        await verify(p, user.recoveryCodes[0]).expect(200);
        const s = await state(user.id);
        expect(s.failedTotpAttempts).toBe(0);
        expect(s.recoveryCodes).not.toContain(user.recoveryCodes[0]);
      });

      it('E3h: turning 2FA off clears the lock too, so an immediate re-enrolment is not refused by the old lock', async () => {
        const user = await makeUser(surface);

        // A live session on one device while a second device gets locked out —
        // the only way to reach disable at all, since a locked user cannot
        // complete a login to get there.
        const session = await pending(user);
        const ok = await verify(session, totpCode(user.secret)).expect(200);
        const csrf = cookieValue(ok.headers['set-cookie'], CSRF[surface])!;
        const withSession = (r: request.Test) =>
          r.set('Authorization', `Bearer ${ok.body.accessToken}`).set('X-CSRF-Token', csrf);

        await lockOut(await pending(user));
        expect((await state(user.id)).totpLockedUntil).not.toBeNull();

        await withSession(session.agent.post(`${AUTH[surface]}/totp/disable`)).expect(204);
        const cleared = await state(user.id);
        expect(cleared.failedTotpAttempts).toBe(0);
        expect(cleared.totpLockedUntil).toBeNull();

        // The consequence, not just the columns: a brand-new authenticator
        // enrolled inside the old lock's window works on its first code.
        // Before TOTP_CLEARED this returned 429 from a lock belonging to the
        // secret that was just discarded.
        const setup = await withSession(session.agent.post(`${AUTH[surface]}/totp/setup`)).expect(200);
        await withSession(session.agent.post(`${AUTH[surface]}/totp/confirm`))
          .send({ code: totpCode(setup.body.secret) })
          .expect(200);
        await verify(await pending(user), totpCode(setup.body.secret)).expect(200);
      });

      it('concurrent wrong codes cannot slip past the lock: exactly 5 of 8 are checked', async () => {
        const user = await makeUser(surface);
        const p = await pending(user);
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            request(app.getHttpServer())
              .post(VERIFY[surface])
              .set('Cookie', `${CSRF[surface]}=${p.csrf}`)
              .set('Authorization', `Bearer ${p.tempToken}`)
              .set('X-CSRF-Token', p.csrf)
              .send({ code: wrongCode(user.secret) }),
          ),
        );
        const statuses = results.map((r) => r.status).sort();
        expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
        for (const r of results.filter((r) => r.status === 429)) expect(r.body.message).toBe(LOCKED_MESSAGE);
        expect((await state(user.id)).failedTotpAttempts).toBe(MAX_FAILED);
      });
    });
  }
});
