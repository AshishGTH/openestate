/**
 * Regression coverage for a severe bug found on the first real-browser
 * mutation ever attempted against the deployed VM (a full admin
 * walkthrough — every prior "VM verification" this project's history
 * used curl/wget, which never enforces cookie security rules the way a
 * real browser does): setRefreshCookie/setCsrfCookie (both staff and
 * portal) set `secure: process.env.NODE_ENV === 'production'` — but
 * NODE_ENV is 'production' on every real native install regardless of
 * whether TLS is actually configured in front of it (deliberately not,
 * out of the box — see deploy/native's nginx config). A Secure cookie
 * is silently never stored by any real browser over a plain HTTP
 * connection. Every native install without its own TLS-terminating
 * proxy therefore had CSRF and session persistence completely broken
 * for every real user, staff or portal — not a degraded case, a
 * universal one, invisible to curl/wget because neither enforces the
 * Secure-cookie-requires-HTTPS rule.
 *
 * Fixed by keying `secure` off `req.secure` (via `trust proxy` in
 * main.ts, honoring nginx's X-Forwarded-Proto) instead of NODE_ENV.
 * These tests reproduce the exact bug condition — NODE_ENV=production,
 * set explicitly here since the shared test bootstrap never sets it —
 * over what looks like a plain HTTP request (no X-Forwarded-Proto sent,
 * same as this file's real e2e app), and confirm the cookies are NOT
 * Secure. A second pair confirms the opposite: with X-Forwarded-Proto:
 * https present (simulating a real TLS-terminating proxy in front),
 * trust-proxy-aware req.secure correctly flips Secure on.
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
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-cookie-secure-${process.pid}-${Date.now()}-`;

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
  // The exact bug condition — every real native install runs with this
  // set. Restored in afterAll so it doesn't leak into sibling test files
  // sharing this forked worker (vitest runs multiple test files per
  // process — see this repo's own THROTTLE_TEST_KEY_PREFIX precedent for
  // why cross-file leakage here is a real, previously-hit failure mode).
  process.env.NODE_ENV = 'production';

  const require = createRequire(import.meta.url);
  const { AppModule } = require('../dist/app.module');

  const nestApp = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  nestApp.use(helmet());
  nestApp.use(cookieParser());
  nestApp.setGlobalPrefix('api/v1');
  nestApp.useGlobalPipes(new ZodValidationPipe());
  // Mirrors main.ts's own trust-proxy setup — see that file's doc
  // comment for why this is the fix, not NODE_ENV.
  nestApp.getHttpAdapter().getInstance().set('trust proxy', 1);
  await nestApp.init();
  return nestApp;
}

function cookieHeaders(res: request.Response): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

describeIf('e2e cookie Secure flag: keyed off req.secure (via trust proxy), not NODE_ENV', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let staffEmail: string;
  let customerPhone: string;
  const STAFF_PASSWORD = 'CookieSecureStaff123';
  const CUSTOMER_PASSWORD = 'CookieSecureCustomer123';
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    const staffRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Cookie Staff', slug: `e2e-cookie-${TAG}`, isSystem: true },
    });
    staffEmail = `e2e-cookie-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: staffEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Cookie Staff',
        roleId: staffRole.id,
        forcePasswordChange: false,
      },
    });

    const customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const applicant = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } });
    customerPhone = applicant.primaryPhone;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        applicantId,
        phone: customerPhone,
        name: applicant.name,
        passwordHash: await argon2.hash(CUSTOMER_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        roleId: customerRoleId,
        forcePasswordChange: false,
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('staff login over what looks like plain HTTP does NOT set Secure cookies, even with NODE_ENV=production', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: STAFF_PASSWORD })
      .expect(200);
    const cookies = cookieHeaders(res);
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c.toLowerCase()).not.toMatch(/;\s*secure/);
    }
  });

  it('portal login over what looks like plain HTTP does NOT set Secure cookies, even with NODE_ENV=production', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/portal/auth/login')
      .send({ identifier: customerPhone, password: CUSTOMER_PASSWORD })
      .expect(200);
    const cookies = cookieHeaders(res);
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c.toLowerCase()).not.toMatch(/;\s*secure/);
    }
  });

  it('staff login DOES set Secure cookies when X-Forwarded-Proto: https is present (real TLS-terminating proxy)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .send({ email: staffEmail, password: STAFF_PASSWORD })
      .expect(200);
    const cookies = cookieHeaders(res);
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c.toLowerCase()).toMatch(/;\s*secure/);
    }
  });
});
