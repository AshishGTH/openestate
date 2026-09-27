/**
 * Piece 2 proof: the staff auth surface must refuse a PORTAL account at
 * every entry point — login and refresh — mirroring the exclusion the portal
 * side already applies to staff accounts. Before piece 2, a portal user with
 * an email could obtain a staff-shaped token (no applicantId/brokerId), which
 * then passed staff routes on permission.
 *
 * Same bootstrap/fixtures as e2e-portal-token-boundary.test.ts; local test
 * containers only; needs the compiled dist/.
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
import { ALL_PERMISSIONS } from '@openestate/shared';
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
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-staff-exclusion-${process.pid}-${Date.now()}-`;

const PW = 'PortalUserPass123';

describeIf('Staff auth surface refuses portal accounts at every entry point', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let portalEmail: string;

  beforeAll(async () => {
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
    app = nestApp;

    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }

    // A PORTAL user (customer) that also has an email set — the exact case
    // staff login must refuse. Email is what staff login searches on.
    const customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const tag = Date.now();
    portalEmail = `e2e-portal-with-email-${tag}@example.invalid`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        applicantId,
        email: portalEmail,
        phone: String(9100000000 + (tag % 100000000)),
        name: 'E2E Portal With Email',
        passwordHash: await argon2.hash(PW, { algorithm: argon2.Algorithm.Argon2id }),
        roleId: customerRoleId,
        forcePasswordChange: false,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (fx) await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma?.$disconnect();
  });

  it('staff login refuses a portal account (opaque 401, no token issued)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: portalEmail, password: PW });
    expect([401]).toContain(res.status);
    expect(res.body.accessToken, 'no staff access token issued to a portal account').toBeUndefined();
    expect(res.body.tempToken, 'no staff 2FA temp token issued to a portal account').toBeUndefined();
  });

  it('staff refresh does not mint a staff token from a portal refresh cookie', async () => {
    const portalLogin = await request(app.getHttpServer())
      .post('/api/v1/portal/auth/login')
      .send({ identifier: portalEmail, password: PW })
      .expect(200);
    const portalRefreshCookie = portalLogin.headers['set-cookie'];
    expect(portalRefreshCookie, 'portal login set a refresh cookie').toBeTruthy();

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', portalRefreshCookie);
    expect(res.body.accessToken, 'no staff access token from a portal refresh').toBeUndefined();
    expect([401, 403]).toContain(res.status);
  });

  it('control: the portal account can still use its own surface', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/portal/auth/login')
      .send({ identifier: portalEmail, password: PW })
      .expect(200);
    expect(res.body.accessToken, 'portal login issues a portal access token').toBeTruthy();
  });
});
