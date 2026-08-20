/**
 * Regression coverage for a gap found during the VM admin walkthrough:
 * CompanyConfig.tsx only ever called PATCH /company/config, never PATCH
 * /company, so the company's own `name` field had no working UI path even
 * though the backend endpoint (ADMIN_COMPANY_UPDATE) existed all along.
 * Frontend now calls both; this confirms the endpoint itself round-trips
 * a name change through the real HTTP guard pipeline.
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
import { ALL_PERMISSIONS, PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();

// Private throttle keyspace for this file, set BEFORE the app bootstraps
// so RedisThrottlerStorage picks it up — see e2e-dashboard-hierarchy.test.ts's
// identical comment and CLAUDE.md's Phase 8 entry: the default bucket is
// IP-keyed (100/min) and every e2e file shares one loopback IP and one
// Redis, so an unprefixed file's logins can push an already-near-limit
// shared bucket over and cause UNRELATED files to 429 — this file was
// caught doing exactly that in CI run 32400252992.
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-company-update-${process.pid}-${Date.now()}-`;

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

describeIf('e2e PATCH /company: persists a name change', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let adminEmail: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    const role = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Company Admin', slug: `e2e-company-admin-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [PERMISSIONS.ADMIN_COMPANY_READ, PERMISSIONS.ADMIN_COMPANY_UPDATE].map((key) => ({
        roleId: role.id,
        permissionId: permByKey.get(key),
      })),
    });

    adminEmail = `e2e-company-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Company Admin',
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

  function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string {
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
    for (const h of headers) {
      const match = new RegExp(`${name}=([^;]+)`).exec(h);
      if (match) return match[1];
    }
    throw new Error(`Cookie ${name} not found in Set-Cookie headers`);
  }

  it('PATCH /company updates name and GET /company reflects it', async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;

    const newName = `E2E Renamed Co ${TAG}`;
    const patchRes = await agent
      .patch('/api/v1/company')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: newName })
      .expect(200);
    expect(patchRes.body.name).toBe(newName);

    const getRes = await agent
      .get('/api/v1/company')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(getRes.body.name).toBe(newName);
  });
});
