/**
 * Phase 7 commit 1 (plugin-core): through-the-wire supertest for
 * PluginAdminController — the standing rule since Phase 6 commit 2
 * (CLAUDE.md decisions): a controller-method-direct-call test can't
 * prove the route is registered, the permission guard is wired, or that
 * PluginsModule resolves cleanly inside the real DI graph. This is that
 * proof for the new admin/plugins surface. The full install → configure
 * → enable happy path against a REAL registered plugin is commit 3's
 * generic-sales end-to-end test + the manual click-through — this
 * phase's registry is intentionally empty (FIRST_PARTY_PLUGINS = []
 * until then), so this file proves the guard chain and the
 * unknown/unavailable-plugin error paths instead.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from 'argon2';
import { ALL_PERMISSIONS, PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';

describeIf('Phase 7 e2e: PluginAdminController through the full guard pipeline', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let adminEmail: string;
  let noPluginPermsEmail: string;

  beforeAll(async () => {
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

    // See e2e-portal.test.ts's identical comment: must boot from the
    // COMPILED dist/, not TS source — vitest's esbuild transform doesn't
    // emit correct design:paramtypes decorator metadata for NestJS DI.
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
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    const adminRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Plugin Admin', slug: `e2e-plugin-admin-${Date.now()}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [PERMISSIONS.ADMIN_PLUGIN_READ, PERMISSIONS.ADMIN_PLUGIN_MANAGE].map((key) => ({ roleId: adminRole.id, permissionId: permByKey.get(key) })),
    });

    // Deliberately WITHOUT any admin.plugin.* permission — proves the
    // guard actually gates this controller, not just that it's mounted.
    const limitedRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E No Plugin Access', slug: `e2e-no-plugin-${Date.now()}`, isSystem: true },
    });

    const tag = Date.now();
    adminEmail = `e2e-plugin-admin-${tag}@test.com`;
    noPluginPermsEmail = `e2e-no-plugin-${tag}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { type: argon2.argon2id }),
        name: 'E2E Plugin Admin',
        roleId: adminRole.id,
        forcePasswordChange: false,
      },
    });
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: noPluginPermsEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { type: argon2.argon2id }),
        name: 'E2E No Plugin Access',
        roleId: limitedRole.id,
        forcePasswordChange: false,
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  async function loginAs(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string {
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
    for (const h of headers) {
      const match = new RegExp(`${name}=([^;]+)`).exec(h);
      if (match) return match[1];
    }
    throw new Error(`Cookie ${name} not found in Set-Cookie headers`);
  }

  /** POST/PUT/DELETE mutations need both the Bearer token AND the
   * double-submit CSRF cookie/header pair (same as e2e-portal.test.ts's
   * staffLoginWithCsrf) — without it CsrfGuard 403s before
   * PermissionsGuard is ever reached, which would be misread as a
   * permission-denial false positive. */
  async function loginWithCsrf(email: string) {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(res.headers['set-cookie'], 'openestate_csrf');
    return { agent, token: res.body.accessToken as string, csrf };
  }

  it('GET /admin/plugins over HTTP returns 200 with an array (route registered, guard passes, module resolves)', async () => {
    const token = await loginAs(adminEmail);
    const res = await request(app.getHttpServer()).get('/api/v1/admin/plugins').set('Authorization', `Bearer ${token}`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /admin/plugins is rejected 403 for a staff user without admin.plugin.read', async () => {
    const token = await loginAs(noPluginPermsEmail);
    await request(app.getHttpServer()).get('/api/v1/admin/plugins').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('GET /admin/plugins/:pluginId for a pluginId that was never installed nor registered is 404', async () => {
    const token = await loginAs(adminEmail);
    await request(app.getHttpServer()).get('/api/v1/admin/plugins/never-heard-of-it').set('Authorization', `Bearer ${token}`).expect(404);
  });

  it('POST /admin/plugins/:pluginId/install for an unregistered pluginId is 409, not a 500 or silent success', async () => {
    const { agent, token, csrf } = await loginWithCsrf(adminEmail);
    const res = await agent
      .post('/api/v1/admin/plugins/never-heard-of-it/install')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(409);
    expect(res.body.message).toMatch(/not available in this build/);
  });

  it('POST /admin/plugins/:pluginId/install is rejected 403 for a staff user without admin.plugin.manage', async () => {
    const { agent, token, csrf } = await loginWithCsrf(noPluginPermsEmail);
    await agent
      .post('/api/v1/admin/plugins/never-heard-of-it/install')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(403);
  });
});
