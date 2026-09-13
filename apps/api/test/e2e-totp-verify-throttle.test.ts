/**
 * Second-factor brute-force limits on totp/verify, staff and portal.
 *
 * Before: staff verify had only the default 100/min per-IP bucket, and an
 * attacker holding the password can mint a fresh tempToken whenever one
 * expires — so a six-digit code had effectively unlimited guesses. Portal
 * verify was capped per IP only, which rotating addresses also defeats.
 *
 * Now both verify endpoints share TotpVerifyThrottlerGuard: 5 attempts per
 * 5 minutes per USER (keyed by the verified tempToken's sub), TOTP and
 * recovery codes alike. Portal verify also keeps its pre-existing per-IP
 * portal-auth bucket.
 *
 * Runs at the shipped limits on purpose, with its own throttle keyspace.
 * Every test uses fresh users (the verify key is per user) and fresh client
 * addresses (the portal login/verify buckets are per IP), so exhausting one
 * budget here can't starve another test or file.
 *
 * The second-factor lockout (5 consecutive failures, separate counter) is
 * tested on its own in e2e-totp-lockout.test.ts. The last test here is the
 * one place both run at the shipped limits, showing what the lockout adds.
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

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-totp-verify-throttle-${process.pid}-${Date.now()}-`;
// The shipped limits, not a harness override: this file is what checks them.
delete process.env.TOTP_VERIFY_THROTTLE_LIMIT;
delete process.env.PORTAL_AUTH_THROTTLE_LIMIT;
const VERIFY_LIMIT = 5;
const PORTAL_AUTH_LIMIT = 5;

const TAG = Date.now();
const PASSWORD = 'ThrottlePassword123';

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
  // Same as main.ts: req.ip comes from X-Forwarded-For, which is how these
  // tests stand in for different client addresses.
  nestApp.getHttpAdapter().getInstance().set('trust proxy', 1);
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

function cookieValue(setCookie: string[] | string | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  for (const h of headers) {
    const match = new RegExp(`(?:^|\\s)${name}=([^;]+)`).exec(h);
    if (match) return match[1];
  }
  return undefined;
}

let ipSeq = 0;
const freshIp = () => `203.0.113.${++ipSeq}`;

type Surface = 'staff' | 'portal';
const LOGIN = { staff: '/api/v1/auth/login', portal: '/api/v1/portal/auth/login' };
const VERIFY = { staff: '/api/v1/auth/totp/verify', portal: '/api/v1/portal/auth/totp/verify' };
const CSRF = { staff: 'openestate_csrf', portal: 'openestate_portal_csrf' };
const GUARDED = { staff: '/api/v1/users', portal: '/api/v1/portal/profile' };

interface TestUser {
  id: string;
  surface: Surface;
  identifier: string;
  secret: string;
  recoveryCodes: string[];
}

describeIf('totp/verify brute-force limits, staff and portal', () => {
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

    // The real TotpService, so seeded secrets are encrypted exactly as the
    // app encrypts them — enrolment itself isn't what this file tests.
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
        data: { companyId: fx.companyId, name: 'E2E Verify Throttle', slug: `e2e-tvt-${TAG}`, isSystem: true },
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

  /** A fresh user with 2FA already on, so each test has its own verify budget. */
  async function makeUser(surface: Surface): Promise<TestUser> {
    const n = ++userSeq;
    let id: string;
    let identifier: string;
    if (surface === 'staff') {
      identifier = `e2e-tvt-${TAG}-${n}@test.com`;
      id = (
        await systemPrisma.user.create({
          data: { companyId: fx.companyId, email: identifier, passwordHash, name: `Staff ${n}`, roleId: staffRoleId, forcePasswordChange: false },
        })
      ).id;
    } else {
      // High-entropy phone: portal login looks the identifier up across ALL companies.
      identifier = `8${String(TAG).slice(-6)}${String(n).padStart(3, '0')}`;
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

  async function pending(user: TestUser, ip = freshIp()) {
    const agent = request.agent(app.getHttpServer());
    const body = user.surface === 'staff' ? { email: user.identifier, password: PASSWORD } : { identifier: user.identifier, password: PASSWORD };
    const res = await agent.post(LOGIN[user.surface]).set('X-Forwarded-For', ip).send(body).expect(200);
    expect(res.body.requiresTwoFactor).toBe(true);
    return { user, agent, tempToken: res.body.tempToken as string, csrf: cookieValue(res.headers['set-cookie'], CSRF[user.surface])! };
  }

  // Not async: returns the supertest Test itself so callers can chain .expect().
  function verify(p: Awaited<ReturnType<typeof pending>>, code: string, ip: string) {
    return p.agent
      .post(VERIFY[p.user.surface])
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${p.tempToken}`)
      .set('X-CSRF-Token', p.csrf)
      .send({ code });
  }

  for (const surface of ['staff', 'portal'] as const) {
    describe(surface, () => {
      it(`E1/E2: ${VERIFY_LIMIT} attempts per user per 5 minutes, then 429 — however many addresses they come from`, async () => {
        const user = await makeUser(surface);
        const p = await pending(user);
        for (let i = 0; i < VERIFY_LIMIT; i++) {
          const r = await verify(p, wrongCode(user.secret), freshIp());
          expect(r.status).toBe(401);
          expect(r.headers['x-ratelimit-limit-totp-verify']).toBe(String(VERIFY_LIMIT));
        }
        // The sixth attempt is refused even with the right code, from a new address.
        const blocked = await verify(p, totpCode(user.secret), freshIp());
        expect(blocked.status).toBe(429);
        expect(blocked.headers['retry-after-totp-verify']).toBeDefined();
      });

      it('E4: an honest user who mistypes twice, then enters the right code, gets in', async () => {
        const user = await makeUser(surface);
        const ip = freshIp();
        const p = await pending(user, ip);
        await verify(p, wrongCode(user.secret), ip).expect(401);
        await verify(p, wrongCode(user.secret), ip).expect(401);
        const ok = await verify(p, totpCode(user.secret), ip).expect(200);
        await request(app.getHttpServer()).get(GUARDED[surface]).set('Authorization', `Bearer ${ok.body.accessToken}`).expect(200);
      });

      it('E5: recovery-code guesses spend the same budget, and a valid recovery code cannot get past an exhausted one', async () => {
        const user = await makeUser(surface);
        const p = await pending(user);
        for (let i = 0; i < VERIFY_LIMIT; i++) {
          await verify(p, 'AAAAA-AAAAA', freshIp()).expect(401);
        }
        await verify(p, user.recoveryCodes[0], freshIp()).expect(429);
        // Refused before the service ran, so the code wasn't spent either.
        const stored = await systemPrisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { recoveryCodes: true } });
        expect(stored.recoveryCodes).toContain(user.recoveryCodes[0]);
      });
    });
  }

  it('E1: staff verify is per user, so a colleague behind the same office address is unaffected', async () => {
    const office = freshIp();
    const alice = await makeUser('staff');
    const bob = await makeUser('staff');
    const pa = await pending(alice, office);
    for (let i = 0; i < VERIFY_LIMIT; i++) {
      await verify(pa, wrongCode(alice.secret), office).expect(401);
    }
    await verify(pa, totpCode(alice.secret), office).expect(429);

    const pb = await pending(bob, office);
    await verify(pb, totpCode(bob.secret), office).expect(200);
  });

  it('E2: the existing portal per-address limit still holds — two customers on one address share 5 attempts', async () => {
    const shared = freshIp();
    const c1 = await makeUser('portal');
    const c2 = await makeUser('portal');
    const p1 = await pending(c1); // logins from their own addresses: the login
    const p2 = await pending(c2); // bucket is separate from the verify one
    for (let i = 0; i < 3; i++) {
      await verify(p1, wrongCode(c1.secret), shared).expect(401);
    }
    for (let i = 0; i < PORTAL_AUTH_LIMIT - 3; i++) {
      const r = await verify(p2, wrongCode(c2.secret), shared).expect(401);
      expect(r.headers['x-ratelimit-limit-portal-auth']).toBe(String(PORTAL_AUTH_LIMIT));
    }
    // c2 has used 2 of their own 5, but the address has used 5.
    const blocked = await verify(p2, totpCode(c2.secret), shared);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after-portal-auth']).toBeDefined();
  });

  it('the lockout holds where the rate limit does not: after 5 failures on staff verify, the same tempToken is refused on portal verify, whose rate limit still has room', async () => {
    const user = await makeUser('staff');
    const p = await pending(user);
    for (let i = 0; i < VERIFY_LIMIT; i++) {
      await verify(p, wrongCode(user.secret), freshIp()).expect(401);
    }

    // A 2FA-pending token is accepted by both verify endpoints, and the rate
    // limit keys them separately — so this request passes it (4 left). The
    // attacker supplies their own portal CSRF pair.
    const crossSurface = await request(app.getHttpServer())
      .post(VERIFY.portal)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${p.tempToken}`)
      .set('Cookie', `${CSRF.portal}=forged`)
      .set('X-CSRF-Token', 'forged')
      .send({ code: totpCode(user.secret) });
    expect(crossSurface.headers['x-ratelimit-remaining-totp-verify']).toBe(String(VERIFY_LIMIT - 1));
    expect(crossSurface.status).toBe(429);
    expect(crossSurface.body.message).toBe('Too many incorrect codes. Wait a few minutes, then sign in again.');
  });
});
