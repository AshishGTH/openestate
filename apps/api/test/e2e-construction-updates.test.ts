/**
 * Through-the-wire coverage for the staff Construction Updates UI's
 * backend surface (ConstructionUpdateAdminController): create, attach a
 * photo, list, and the new DELETE route — the one endpoint that didn't
 * exist before the staff UI was built (backend/portal-rendering had
 * shipped in Phase 6 with zero caller in apps/web; see docs/todo.md's
 * "must-fix-before-pilot" entry). Requires the compiled dist/ — see
 * e2e-portal.test.ts for why.
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

// A real 1x1 transparent PNG — needed for UploadService's magic-byte check.
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

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

describeIf('e2e ConstructionUpdateAdminController: create, photo, list, delete', () => {
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
      data: { companyId: fx.companyId, name: 'E2E Construction Admin', slug: `e2e_construction_admin_${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permByKey.get(PERMISSIONS.ADMIN_CONSTRUCTION_UPDATE_MANAGE) },
    });

    adminEmail = `e2e-construction-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Construction Admin',
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

  async function loginAgent() {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;
    return { agent, csrf, token };
  }

  it('creates an update, attaches a photo, lists it, downloads the photo, then deletes it', async () => {
    const { agent, csrf, token } = await loginAgent();

    const createRes = await agent
      .post('/api/v1/admin/construction-updates')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ projectId: fx.projectId, title: `Slab casting complete ${TAG}`, description: '3rd floor slab cast', publishedAt: '2026-03-01' })
      .expect(201);
    expect(createRes.body.id).toBeTruthy();
    const updateId = createRes.body.id as string;

    const mediaRes = await agent
      .post(`/api/v1/admin/construction-updates/${updateId}/media`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .attach('file', ONE_PX_PNG, 'progress.png')
      .expect(201);
    const mediaId = mediaRes.body.id as string;

    const listRes = await agent
      .get(`/api/v1/admin/construction-updates?projectId=${fx.projectId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const listed = listRes.body.find((u: { id: string }) => u.id === updateId);
    expect(listed).toBeTruthy();
    expect(listed.media.map((m: { id: string }) => m.id)).toContain(mediaId);

    const downloadRes = await agent
      .get(`/api/v1/admin/construction-updates/media/${mediaId}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(downloadRes.headers['content-type']).toBe('image/png');

    await agent
      .delete(`/api/v1/admin/construction-updates/${updateId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(200);

    const listAfterRes = await agent
      .get(`/api/v1/admin/construction-updates?projectId=${fx.projectId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listAfterRes.body.some((u: { id: string }) => u.id === updateId)).toBe(false);

    // Media cascades with the parent row (schema's onDelete: Cascade) —
    // confirm no orphaned media row survives, not just the update itself.
    const orphanCount = await systemPrisma.constructionUpdateMedia.count({ where: { id: mediaId } });
    expect(orphanCount).toBe(0);
  });

  it('404s deleting a construction update that does not exist', async () => {
    const { agent, csrf, token } = await loginAgent();
    await agent
      .delete('/api/v1/admin/construction-updates/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(404);
  });
});
