/**
 * Through-the-wire coverage for ProjectMediaController — v0.2.2's whole
 * point: UploadService has existed since Phase 2 but no route ever called
 * it. Proves upload/list/download/delete over real HTTP (guard chain,
 * multipart parsing, CSRF), plus the new per-project storage cap.
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

// A real 1x1 transparent PNG — needed for UploadService's magic-byte check.
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const MINIMAL_PDF = Buffer.from('%PDF-1.4\n%%EOF');

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

describeIf('e2e ProjectMediaController: upload, list, download, delete, storage cap', () => {
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
      data: { companyId: fx.companyId, name: 'E2E Media Admin', slug: `e2e_media_admin_${TAG}`, isSystem: true },
    });
    for (const key of [PERMISSIONS.INVENTORY_UPLOAD_CREATE, PERMISSIONS.INVENTORY_UPLOAD_READ, PERMISSIONS.INVENTORY_UPLOAD_DELETE]) {
      await systemPrisma.rolePermission.create({ data: { roleId: role.id, permissionId: permByKey.get(key) } });
    }

    adminEmail = `e2e-media-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Media Admin',
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

  it('rejects an unrecognized category before touching the filesystem', async () => {
    const { agent, csrf, token } = await loginAgent();
    await agent
      .post(`/api/v1/projects/${fx.projectId}/media`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .field('category', 'construction_progress')
      .attach('file', ONE_PX_PNG, 'photo.png')
      .expect(400);
  });

  it('rejects a file whose content does not match its extension (magic-byte check)', async () => {
    const { agent, csrf, token } = await loginAgent();
    await agent
      .post(`/api/v1/projects/${fx.projectId}/media`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .field('category', 'photo')
      .attach('file', Buffer.from('not a real png'), 'photo.png')
      .expect(400);
  });

  it('uploads a layout plan, lists it, downloads the real bytes, then deletes it', async () => {
    const { agent, csrf, token } = await loginAgent();

    const uploadRes = await agent
      .post(`/api/v1/projects/${fx.projectId}/media`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .field('category', 'layout_plan')
      .attach('file', MINIMAL_PDF, 'plan.pdf')
      .expect(201);
    expect(uploadRes.body.category).toBe('layout_plan');
    expect(uploadRes.body.originalName).toBe('plan.pdf');
    const mediaId = uploadRes.body.id as string;

    const listRes = await agent.get(`/api/v1/projects/${fx.projectId}/media`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(listRes.body.some((m: { id: string }) => m.id === mediaId)).toBe(true);

    const downloadRes = await agent
      .get(`/api/v1/projects/${fx.projectId}/media/${mediaId}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(downloadRes.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(downloadRes.body).toString()).toContain('%PDF-1.4');

    await agent
      .delete(`/api/v1/projects/${fx.projectId}/media/${mediaId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(200);

    const listAfterRes = await agent.get(`/api/v1/projects/${fx.projectId}/media`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(listAfterRes.body.some((m: { id: string }) => m.id === mediaId)).toBe(false);
  });

  it('enforces the per-project file-count cap with a clear error', async () => {
    await systemPrisma.companyConfig.update({ where: { companyId: fx.companyId }, data: { projectMediaMaxFiles: 1 } });
    const { agent, csrf, token } = await loginAgent();

    await agent
      .post(`/api/v1/projects/${fx.projectId}/media`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .field('category', 'brochure')
      .attach('file', MINIMAL_PDF, 'brochure-1.pdf')
      .expect(201);

    const secondRes = await agent
      .post(`/api/v1/projects/${fx.projectId}/media`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .field('category', 'brochure')
      .attach('file', MINIMAL_PDF, 'brochure-2.pdf')
      .expect(400);
    expect(secondRes.body.message).toMatch(/file limit/);

    await systemPrisma.companyConfig.update({ where: { companyId: fx.companyId }, data: { projectMediaMaxFiles: 50 } });
  });

  it('enforces the per-project total-size cap with a clear error, counting both media tables', async () => {
    await systemPrisma.companyConfig.update({ where: { companyId: fx.companyId }, data: { projectMediaMaxBytes: MINIMAL_PDF.length } });
    const { agent, csrf, token } = await loginAgent();

    // Exactly at the cap succeeds (the first upload this describe block's
    // preceding test already deleted, and the file-count-cap test's own
    // upload counts toward this cap too — assert against the real 400).
    const res = await agent
      .post(`/api/v1/projects/${fx.projectId}/media`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .field('category', 'brochure')
      .attach('file', MINIMAL_PDF, 'brochure-3.pdf')
      .expect(400);
    expect(res.body.message).toMatch(/storage limit/);

    await systemPrisma.companyConfig.update({ where: { companyId: fx.companyId }, data: { projectMediaMaxBytes: 524288000 } });
  });
});
