/**
 * Regression coverage for the "a rep's own inquiry silently reassigns to
 * admin" bug: InquiryService.create() used to run round-robin
 * unconditionally whenever a project was set, with zero notion of who
 * created the inquiry — Inquiry had no createdById column at all, and
 * InquiryController never passed the caller through. Fixed with a
 * creator-retains-lead policy (CompanyConfig.presalesCreatorRetainsLead,
 * default true): an interactively-created inquiry is assigned straight to
 * its creator; round-robin only ever runs for machine-driven intake
 * (inbound lead API, bulk import), which has no human creator to retain
 * ownership for.
 *
 * Through-the-wire (real HTTP, real guard/JWT pipeline) because the bug
 * lived partly in the controller never forwarding `user.sub` — a
 * direct-service-call test can't prove that wiring, only a real request
 * through JwtAuthGuard can. Requires the compiled dist/ — see
 * e2e-company-update.test.ts for why.
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

// main.ts patches BigInt.prototype.toJSON so money fields (this file hits
// it via CompanyConfig.chequeBounceChargePaise on PATCH /company/config)
// serialize instead of crashing JSON.stringify — but every e2e-*.test.ts
// file bootstraps AppModule directly, never main.ts's own bootstrap(), so
// without this the same real fix would falsely look like a 500 in tests
// while working fine in the real, main.ts-booted app. Applied here for
// test/production parity, not because it's a real product bug — see
// e2e-master-creation.test.ts for the same pattern.
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

describeIf('e2e POST /inquiries: creator-retains-lead assignment policy', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let repAEmail: string;
  let repAId: string;
  let repBId: string;

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
      data: { companyId: fx.companyId, name: 'E2E Sales Rep', slug: `e2e-sales-rep-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [
        PERMISSIONS.PRESALES_INQUIRY_CREATE,
        PERMISSIONS.PRESALES_INQUIRY_READ,
        PERMISSIONS.ADMIN_CONFIG_UPDATE,
        PERMISSIONS.PRESALES_FOLLOW_UP_CREATE,
        PERMISSIONS.PRESALES_FOLLOW_UP_READ,
      ].map((key) => ({ roleId: role.id, permissionId: permByKey.get(key) })),
    });

    repAEmail = `e2e-rep-a-${TAG}@test.com`;
    const repA = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: repAEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Rep A',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });
    repAId = repA.id;

    const repB = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: `e2e-rep-b-${TAG}@test.com`,
        passwordHash: 'x',
        name: 'E2E Rep B',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });
    repBId = repB.id;

    // Pool contains ONLY rep B — if round-robin ever fired for rep A's
    // own creation, it could only ever land on rep B, making a false
    // pass (creator accidentally matching the pool pick) impossible.
    await systemPrisma.projectAssignmentPool.create({
      data: { companyId: fx.companyId, projectId: fx.projectId, userId: repBId, isActive: true },
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

  it('default (creator-retains on): assigns to the creator, not the project pool, and stays visible in their own scoped list', async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: repAEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;

    const createRes = await agent
      .post('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({
        projectId: fx.projectId,
        applicant: { name: 'Creator Retains Applicant', primaryPhone: '9812300001' },
      })
      .expect(201);

    expect(createRes.body.assignedToId).toBe(repAId);
    expect(createRes.body.createdById).toBe(repAId);
    expect(createRes.body.assignedToId).not.toBe(repBId);

    const listRes = await agent
      .get('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ids = (listRes.body.data as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(createRes.body.id);
  });

  it('toggle off: falls back to round-robin against the project pool', async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: repAEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;

    await agent
      .patch('/api/v1/company/config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ presalesCreatorRetainsLead: false })
      .expect(200);

    const createRes = await agent
      .post('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({
        projectId: fx.projectId,
        applicant: { name: 'Round Robin Applicant', primaryPhone: '9812300002' },
      })
      .expect(201);

    expect(createRes.body.assignedToId).toBe(repBId);
    expect(createRes.body.createdById).toBe(repAId);

    // Restore the toggle so it doesn't leak into any other test file
    // sharing this company row across the same suite run.
    await agent
      .patch('/api/v1/company/config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ presalesCreatorRetainsLead: true })
      .expect(200);
  });

  it('assignedTo/createdBy are scoped selects: real leak, found while wiring follow-up attribution — a bare `include: { relation: true }` was returning every scalar column on User, passwordHash/totpSecret included', async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: repAEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;

    const createRes = await agent
      .post('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({
        projectId: fx.projectId,
        applicant: { name: 'Leak Check Applicant', primaryPhone: '9812300003' },
      })
      .expect(201);
    const inquiryId = createRes.body.id as string;

    const followUpRes = await agent
      .post(`/api/v1/inquiries/${inquiryId}/follow-ups`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ notes: 'Called, will call back tomorrow' })
      .expect(201);
    expect(followUpRes.body.createdBy).toBeUndefined(); // service.create() doesn't include it — findAllForInquiry does

    const listRes = await agent.get('/api/v1/inquiries').set('Authorization', `Bearer ${token}`).expect(200);
    const created = (listRes.body.data as Array<{ id: string; assignedTo: Record<string, unknown> }>).find(
      (i) => i.id === inquiryId,
    );
    expect(created?.assignedTo).toMatchObject({ id: repAId, name: 'E2E Rep A' });
    expect(created?.assignedTo).not.toHaveProperty('passwordHash');
    expect(created?.assignedTo).not.toHaveProperty('totpSecret');

    const detailRes = await agent.get(`/api/v1/inquiries/${inquiryId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(detailRes.body.assignedTo).not.toHaveProperty('passwordHash');
    expect(detailRes.body.assignedTo).not.toHaveProperty('totpSecret');

    const followUpsRes = await agent
      .get(`/api/v1/inquiries/${inquiryId}/follow-ups`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(followUpsRes.body[0].createdBy).toMatchObject({ id: repAId, name: 'E2E Rep A' });
    expect(followUpsRes.body[0].createdBy).not.toHaveProperty('passwordHash');
    expect(followUpsRes.body[0].createdBy).not.toHaveProperty('totpSecret');
    expect(followUpsRes.body[0].createdBy).not.toHaveProperty('recoveryCodes');
  });
});
