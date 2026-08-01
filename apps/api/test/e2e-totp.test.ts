/**
 * Through-the-wire TOTP 2FA coverage — real HTTP through the full guard
 * pipeline (JwtAuthGuard, CsrfGuard, PermissionsGuard), not a direct
 * service call.
 *
 * The "login response sets the CSRF cookie on both branches" test below
 * is a regression test for a real bug found via live VM verification:
 * AuthController.login()'s 2FA-pending branch returned before
 * setCsrfCookie(res) ran, so a 2FA-enabled account's browser session
 * never received a CSRF cookie to echo back — every totp/verify call
 * 403'd with "CSRF token mismatch" and 2FA login could never complete,
 * for any account, ever. Confirmed end-to-end (curl against the real API
 * and a read of apps/web's actual fetch client, which only attaches
 * X-CSRF-Token when the cookie exists). No direct-service-call test
 * could have caught this — it lives entirely in the controller's cookie
 * side effects, which CsrfGuard then enforces at the HTTP layer.
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
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();

async function bootstrapApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = APP_URL;
  process.env.DATABASE_URL_SYSTEM = SYSTEM_URL;
  process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6380';
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

describeIf('e2e TOTP 2FA: real HTTP through the full guard pipeline', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let staffEmail: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    const role = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E TOTP Staff', slug: `e2e-totp-${TAG}`, isSystem: true },
    });
    staffEmail = `e2e-totp-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: staffEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E TOTP Staff',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string | undefined {
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
    for (const h of headers) {
      const match = new RegExp(`${name}=([^;]+)`).exec(h);
      if (match) return match[1];
    }
    return undefined;
  }

  async function passwordLogin() {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email: staffEmail, password: STAFF_PASSWORD }).expect(200);
    return { agent, res };
  }

  it('enrolls TOTP: setup returns a secret, confirm with a valid code enables it and returns recovery codes', async () => {
    const { agent, res } = await passwordLogin();
    const token = res.body.accessToken as string;
    const csrf = extractCookie(res.headers['set-cookie'], 'openestate_csrf')!;

    const setup = await agent
      .post('/api/v1/auth/totp/setup')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(200);
    expect(setup.body.secret).toBeTruthy();

    const confirm = await agent
      .post('/api/v1/auth/totp/confirm')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ code: totpCode(setup.body.secret) })
      .expect(200);
    expect(confirm.body.recoveryCodes).toHaveLength(8);

    // Cleanup: disable so later tests in this file start from a known
    // (2FA-off) state regardless of `it` execution order.
    await agent
      .post('/api/v1/auth/totp/disable')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(204);
  });

  describe('once TOTP is enabled', () => {
    let secret: string;
    let recoveryCodes: string[];

    beforeAll(async () => {
      const { agent, res } = await passwordLogin();
      const token = res.body.accessToken as string;
      const csrf = extractCookie(res.headers['set-cookie'], 'openestate_csrf')!;
      const setup = await agent
        .post('/api/v1/auth/totp/setup')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .expect(200);
      secret = setup.body.secret;
      const confirm = await agent
        .post('/api/v1/auth/totp/confirm')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ code: totpCode(secret) })
        .expect(200);
      recoveryCodes = confirm.body.recoveryCodes;
    });

    it('login response sets the CSRF cookie on the 2FA-pending branch too (regression)', async () => {
      const { agent, res } = await passwordLogin();
      expect(res.body.requiresTwoFactor).toBe(true);
      expect(res.body.accessToken).toBeUndefined();
      const csrf = extractCookie(res.headers['set-cookie'], 'openestate_csrf');
      expect(csrf).toBeTruthy();

      // Proves the cookie is actually usable, not just present: a real
      // verify call with it must succeed, exactly what apps/web's fetch
      // client does by reading document.cookie for this same name.
      const verify = await agent
        .post('/api/v1/auth/totp/verify')
        .set('Authorization', `Bearer ${res.body.tempToken}`)
        .set('X-CSRF-Token', csrf!)
        .send({ code: totpCode(secret) })
        .expect(200);
      expect(verify.body.accessToken).toBeTruthy();
    });

    it('rejects a wrong TOTP code', async () => {
      const { agent, res } = await passwordLogin();
      const csrf = extractCookie(res.headers['set-cookie'], 'openestate_csrf')!;
      await agent
        .post('/api/v1/auth/totp/verify')
        .set('Authorization', `Bearer ${res.body.tempToken}`)
        .set('X-CSRF-Token', csrf)
        .send({ code: '000000' })
        .expect(401);
    });

    it('accepts a recovery code and consumes it (a second use of the same code is rejected)', async () => {
      const code = recoveryCodes[0];

      const first = await passwordLogin();
      const csrf1 = extractCookie(first.res.headers['set-cookie'], 'openestate_csrf')!;
      const verify1 = await first.agent
        .post('/api/v1/auth/totp/verify')
        .set('Authorization', `Bearer ${first.res.body.tempToken}`)
        .set('X-CSRF-Token', csrf1)
        .send({ code })
        .expect(200);
      expect(verify1.body.accessToken).toBeTruthy();

      const second = await passwordLogin();
      const csrf2 = extractCookie(second.res.headers['set-cookie'], 'openestate_csrf')!;
      await second.agent
        .post('/api/v1/auth/totp/verify')
        .set('Authorization', `Bearer ${second.res.body.tempToken}`)
        .set('X-CSRF-Token', csrf2)
        .send({ code })
        .expect(401);
    });
  });
});
