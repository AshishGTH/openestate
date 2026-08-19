/**
 * Item 7 (phone as universal identifier): through-the-wire coverage for the
 * two new endpoints, GET /applicants/:id/duplicates and
 * POST /applicants/:id/confirm-distinct — the "these are different people"
 * counterpart to the existing merge ("these are the same person") flow.
 *
 * Real HTTP, real guard/JWT/permission pipeline, per the standing rule that
 * a direct-service-call test alone proves handler logic, never that the
 * route is registered and the permission guard actually gates it (Phase 5
 * lesson, restated throughout CLAUDE.md). Direct-service edge cases
 * (self-conflict, idempotency, ordering symmetry, "does not suppress a
 * different pair") live in presales-applicant.test.ts; this file proves
 * the same behavior survives the real HTTP boundary and that permissions
 * are actually enforced.
 *
 * Requires the compiled dist/ — see e2e-company-update.test.ts for why.
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

describeIf('e2e GET /applicants/:id/duplicates and POST /applicants/:id/confirm-distinct', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let fullEmail: string;
  let readOnlyEmail: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    const fullRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Full Applicant', slug: `e2e-full-applicant-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [
        PERMISSIONS.PRESALES_APPLICANT_READ,
        PERMISSIONS.PRESALES_APPLICANT_CREATE,
        PERMISSIONS.PRESALES_APPLICANT_MERGE,
      ].map((key) => ({ roleId: fullRole.id, permissionId: permByKey.get(key) })),
    });

    // Read-only-tier user: can see the duplicates list, but must NOT be
    // able to confirm-distinct (that's the same trust level as merge —
    // deciding applicant identity).
    const readOnlyRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E ReadOnly Applicant', slug: `e2e-readonly-applicant-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [PERMISSIONS.PRESALES_APPLICANT_READ].map((key) => ({
        roleId: readOnlyRole.id,
        permissionId: permByKey.get(key),
      })),
    });

    fullEmail = `e2e-full-applicant-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: fullEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Full Applicant User',
        roleId: fullRole.id,
        forcePasswordChange: false,
      },
    });

    readOnlyEmail = `e2e-readonly-applicant-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: readOnlyEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E ReadOnly Applicant User',
        roleId: readOnlyRole.id,
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

  it('GET /applicants/:id/duplicates lists a same-phone applicant; POST confirm-distinct stops it resurfacing', async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: fullEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;

    const phone = `98125${TAG.toString().slice(-5)}`;
    const firstRes = await agent
      .post('/api/v1/applicants')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Wire Distinct A', primaryPhone: phone, alternatePhones: [] })
      .expect(201);
    const secondRes = await agent
      .post('/api/v1/applicants')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Wire Distinct B', primaryPhone: phone, alternatePhones: [] })
      .expect(201);
    const aId = firstRes.body.id as string;
    const bId = secondRes.body.id as string;

    const dupsBefore = await agent
      .get(`/api/v1/applicants/${aId}/duplicates`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((dupsBefore.body as Array<{ id: string }>).map((d) => d.id)).toContain(bId);

    await agent
      .post(`/api/v1/applicants/${aId}/confirm-distinct`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ otherApplicantId: bId })
      .expect(201);

    const dupsAfter = await agent
      .get(`/api/v1/applicants/${aId}/duplicates`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(dupsAfter.body).toEqual([]);
  });

  it('confirm-distinct is idempotent over real HTTP — a second identical call still 2xx-succeeds', async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: fullEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;

    const phone = `98126${TAG.toString().slice(-5)}`;
    const firstRes = await agent
      .post('/api/v1/applicants')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Idem Wire A', primaryPhone: phone, alternatePhones: [] })
      .expect(201);
    const secondRes = await agent
      .post('/api/v1/applicants')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Idem Wire B', primaryPhone: phone, alternatePhones: [] })
      .expect(201);
    const aId = firstRes.body.id as string;
    const bId = secondRes.body.id as string;

    await agent
      .post(`/api/v1/applicants/${aId}/confirm-distinct`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ otherApplicantId: bId })
      .expect(201);
    await agent
      .post(`/api/v1/applicants/${aId}/confirm-distinct`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ otherApplicantId: bId })
      .expect(201);

    const rows = await systemPrisma.applicantDistinctPair.findMany({ where: { companyId: fx.companyId } });
    const matching = rows.filter(
      (r: { applicantAId: string; applicantBId: string }) =>
        (r.applicantAId === aId && r.applicantBId === bId) || (r.applicantAId === bId && r.applicantBId === aId),
    );
    expect(matching).toHaveLength(1);
  });

  it('a read-only-tier user (PRESALES_APPLICANT_READ only) can list duplicates but is 403d from confirm-distinct', async () => {
    const fullAgent = request.agent(app.getHttpServer());
    const fullLogin = await fullAgent.post('/api/v1/auth/login').send({ email: fullEmail, password: STAFF_PASSWORD }).expect(200);
    const fullCsrf = extractCookie(fullLogin.headers['set-cookie'], 'openestate_csrf');
    const fullToken = fullLogin.body.accessToken as string;

    const phone = `98127${TAG.toString().slice(-5)}`;
    const firstRes = await fullAgent
      .post('/api/v1/applicants')
      .set('Authorization', `Bearer ${fullToken}`)
      .set('X-CSRF-Token', fullCsrf)
      .send({ name: 'Perm Wire A', primaryPhone: phone, alternatePhones: [] })
      .expect(201);
    const secondRes = await fullAgent
      .post('/api/v1/applicants')
      .set('Authorization', `Bearer ${fullToken}`)
      .set('X-CSRF-Token', fullCsrf)
      .send({ name: 'Perm Wire B', primaryPhone: phone, alternatePhones: [] })
      .expect(201);
    const aId = firstRes.body.id as string;
    const bId = secondRes.body.id as string;

    const readOnlyAgent = request.agent(app.getHttpServer());
    const readOnlyLogin = await readOnlyAgent.post('/api/v1/auth/login').send({ email: readOnlyEmail, password: STAFF_PASSWORD }).expect(200);
    const readOnlyCsrf = extractCookie(readOnlyLogin.headers['set-cookie'], 'openestate_csrf');
    const readOnlyToken = readOnlyLogin.body.accessToken as string;

    const dups = await readOnlyAgent
      .get(`/api/v1/applicants/${aId}/duplicates`)
      .set('Authorization', `Bearer ${readOnlyToken}`)
      .expect(200);
    expect((dups.body as Array<{ id: string }>).map((d) => d.id)).toContain(bId);

    await readOnlyAgent
      .post(`/api/v1/applicants/${aId}/confirm-distinct`)
      .set('Authorization', `Bearer ${readOnlyToken}`)
      .set('X-CSRF-Token', readOnlyCsrf)
      .send({ otherApplicantId: bId })
      .expect(403);
  });

  it('confirm-distinct rejects a self-pair with a 400, over real HTTP', async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: fullEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;

    const createRes = await agent
      .post('/api/v1/applicants')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Self Wire A', primaryPhone: `98128${TAG.toString().slice(-5)}`, alternatePhones: [] })
      .expect(201);
    const aId = createRes.body.id as string;

    await agent
      .post(`/api/v1/applicants/${aId}/confirm-distinct`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ otherApplicantId: aId })
      .expect(400);
  });
});
