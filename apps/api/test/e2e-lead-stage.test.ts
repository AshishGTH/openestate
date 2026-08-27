/**
 * Through-the-wire coverage for three fixes made during code review of
 * the uncommitted Phase 0 (lead-stage foundation) work, before it ever
 * reached master:
 *
 * 1. Deactivating the CURRENT DEFAULT lead stage is now refused with a
 *    clear 400, not silently left isActive:false + isDefault:true — the
 *    prior shape would have kept LeadStageTransitionService.resolveInitialStage
 *    routing every new inquiry to a stage that had just become invisible
 *    everywhere isActive is filtered. See LeadStageService.update()'s
 *    new guard.
 * 2. The hard-DELETE endpoint on lead stages is gone — it used to bypass
 *    update()'s occupancy/reassignment safety net entirely, with no
 *    confirmation and no history row. Deactivation is the only way to
 *    retire a stage now; this asserts the route itself is gone (404),
 *    not just discouraged.
 * 3. Inquiry.stageId is validated against the caller's own company
 *    before being persisted, on both POST /inquiries and PATCH
 *    /inquiries/:id. RLS filters what a query can READ; it never
 *    validated a client-supplied foreign key on WRITE — before this fix
 *    a caller could set an inquiry's stage to another company's
 *    LeadStage.id and the write would silently succeed.
 *
 * Through-the-wire (real HTTP, real guard/CSRF/JWT pipeline) per this
 * project's standing rule: a direct-service-call test can prove the
 * service logic is right but not that the route/guard chain actually
 * delivers a client-supplied value to it unvalidated.
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
let phoneSeq = 0;
const nextPhone = () => `9${String(TAG).slice(-5)}${String(phoneSeq++).padStart(4, '0')}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

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

function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
  for (const h of headers) {
    const match = new RegExp(`${name}=([^;]+)`).exec(h);
    if (match) return match[1];
  }
  throw new Error(`Cookie ${name} not found in Set-Cookie headers`);
}

describeIf('e2e lead stages: default-deactivation guard, no hard-delete, cross-company stageId validation', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let token: string;
  let csrf: string;
  let agent: ReturnType<typeof request.agent>;

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
      data: { companyId: fx.companyId, name: 'E2E Lead Stage Admin', slug: `e2e-lead-stage-admin-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [
        PERMISSIONS.ADMIN_MASTER_READ,
        PERMISSIONS.ADMIN_MASTER_CREATE,
        PERMISSIONS.ADMIN_MASTER_UPDATE,
        PERMISSIONS.PRESALES_INQUIRY_READ,
        PERMISSIONS.PRESALES_INQUIRY_CREATE,
        PERMISSIONS.PRESALES_INQUIRY_UPDATE,
      ].map((key) => ({ roleId: role.id, permissionId: permByKey.get(key) })),
    });

    const email = `e2e-lead-stage-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Lead Stage Admin',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });

    agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    token = loginRes.body.accessToken as string;
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  it('refuses to deactivate the default stage with a clear message, and a later inquiry still lands on a visible stage', async () => {
    const createDefault = await agent
      .post('/api/v1/masters/lead-stages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: `Default Stage ${TAG}`, sortOrder: 0, isDefault: true })
      .expect(201);
    const defaultStageId = createDefault.body.id as string;
    expect(createDefault.body.isDefault).toBe(true);

    await agent
      .post('/api/v1/masters/lead-stages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: `Other Stage ${TAG}`, sortOrder: 1, isDefault: false })
      .expect(201);

    const rejectRes = await agent
      .patch(`/api/v1/masters/lead-stages/${defaultStageId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ isActive: false })
      .expect(400);
    expect(rejectRes.body.message).toMatch(/default/i);

    // Still active and still the default — the rejected request changed nothing.
    const afterReject = await agent
      .get(`/api/v1/masters/lead-stages/${defaultStageId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(afterReject.body.isActive).toBe(true);
    expect(afterReject.body.isDefault).toBe(true);

    // A brand-new inquiry, created with no explicit stageId, still lands
    // on this stage — and the stage is genuinely visible (active).
    const inquiryRes = await agent
      .post('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ applicant: { name: 'Default Stage Applicant', primaryPhone: nextPhone() } })
      .expect(201);
    expect(inquiryRes.body.stageId).toBe(defaultStageId);
  });

  it('has no DELETE route for lead stages — deactivation is the only way to retire one', async () => {
    const created = await agent
      .post('/api/v1/masters/lead-stages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: `Delete-Attempt Stage ${TAG}`, sortOrder: 2, isDefault: false })
      .expect(201);

    await agent
      .delete(`/api/v1/masters/lead-stages/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(404);

    // Untouched — still there, still active.
    const stillThere = await agent
      .get(`/api/v1/masters/lead-stages/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(stillThere.body.isActive).toBe(true);
  });

  it('rejects a cross-company stageId on both inquiry create and update', async () => {
    const foreignCompany = await systemPrisma.company.create({
      data: { name: `Foreign Co ${TAG}`, slug: `foreign-co-${TAG}` },
    });
    const foreignStage = await systemPrisma.leadStage.create({
      data: { companyId: foreignCompany.id, name: 'Foreign Stage', sortOrder: 0 },
    });

    try {
      const createRes = await agent
        .post('/api/v1/inquiries')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({
          applicant: { name: 'Cross Company Stage Applicant', primaryPhone: nextPhone() },
          stageId: foreignStage.id,
        })
        .expect(404);
      expect(createRes.body.message).toMatch(/lead stage/i);

      const ownInquiry = await agent
        .post('/api/v1/inquiries')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ applicant: { name: 'Update Target Applicant', primaryPhone: nextPhone() } })
        .expect(201);

      const updateRes = await agent
        .patch(`/api/v1/inquiries/${ownInquiry.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ stageId: foreignStage.id })
        .expect(404);
      expect(updateRes.body.message).toMatch(/lead stage/i);

      // Untouched — the rejected PATCH never wrote the foreign stageId.
      const afterReject = await agent
        .get(`/api/v1/inquiries/${ownInquiry.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(afterReject.body.stageId).not.toBe(foreignStage.id);
    } finally {
      await systemPrisma.leadStage.deleteMany({ where: { companyId: foreignCompany.id } });
      await systemPrisma.company.delete({ where: { id: foreignCompany.id } });
    }
  });
});
