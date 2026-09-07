/**
 * The email ?? phone ?? name fallback in PortalAuthService.setupTotp()
 * has a phone-only branch that a Playwright click-through can never
 * reach: the harness's seeded portal user has both an email and a
 * phone (see apps/e2e/fixtures/seed.ts), so its enrollment always hits
 * the first branch. This test creates a portal user with a phone and
 * no email — the same shape e2e-portal.test.ts's own customer fixture
 * already uses — and proves the otpauthUrl's label resolves to the
 * phone, not silently to the empty string or the user's name.
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
import { ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
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

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-totp-portal-label-${process.pid}-${Date.now()}-`;

const CUSTOMER_PASSWORD = 'CustomerPass123';

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

describeIf('e2e TOTP label fallback: phone-only portal user', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let phone: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    const permissions = await systemPrisma.permission.findMany({ select: { id: true, key: true } });
    const permByKey = new Map(permissions.map((p: { id: string; key: string }) => [p.key, p.id]));

    const customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    const customerPermIds = ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]
      .map((key) => permByKey.get(key))
      .filter((id): id is string => !!id);
    await systemPrisma.rolePermission.createMany({
      data: customerPermIds.map((permissionId: string) => ({ roleId: customerRoleId, permissionId })),
    });

    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const applicant = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } });
    phone = applicant.primaryPhone;

    // No `email` field — matches Applicant.email being optional and the
    // portal User row deliberately not synthesizing a placeholder address.
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        applicantId,
        phone,
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
  });

  function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string {
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
    for (const h of headers) {
      const match = new RegExp(`${name}=([^;]+)`).exec(h);
      if (match) return match[1];
    }
    throw new Error(`cookie ${name} not found`);
  }

  it("resolves the otpauthUrl label to the user's phone when email is absent", async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/api/v1/portal/auth/login')
      .send({ identifier: phone, password: CUSTOMER_PASSWORD })
      .expect(200);
    const token = login.body.accessToken as string;
    const csrf = extractCookie(login.headers['set-cookie'], 'openestate_portal_csrf');

    const setup = await agent
      .post('/api/v1/portal/auth/totp/setup')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(200);

    expect(setup.body.otpauthUrl).toContain(encodeURIComponent(phone));
  });
});
