/**
 * Through-the-wire coverage for v0.4's manager hierarchy
 * (`User.managerId` + `TeamScopeService`), the FollowUp IDOR security fix
 * found while auditing it, and scoped reassignment.
 *
 * Builds a real three-level chain — senior manager (SM) -> manager (M) ->
 * exec (E) — plus an unrelated peer (P) in the same company with no
 * management relationship to the chain, and a company_admin. Every
 * assertion goes over real HTTP through the actual guard/JWT/scoping
 * pipeline, not a direct service call — this is exactly the class of bug
 * (a controller never forwarding the right scope) that a direct-call test
 * structurally cannot catch.
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
import { ALL_PERMISSIONS, PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();

// See e2e-inquiry-assignment.test.ts for why this patch is needed in
// every e2e-*.test.ts file that bootstraps AppModule directly.
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

describeIf('e2e team scoping: manager hierarchy, FollowUp IDOR fix, scoped reassign', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;

  let smEmail: string, mEmail: string, eEmail: string, peerEmail: string, adminEmail: string;
  let smId: string, mId: string, eId: string, peerId: string;
  let execInquiryId: string;

  async function login(email: string) {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    return {
      agent,
      token: res.body.accessToken as string,
      csrf: extractCookie(res.headers['set-cookie'], 'openestate_csrf'),
    };
  }

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    // One role for everyone below admin — the whole point of this test is
    // that scoping comes from managerId, not from role. Includes ASSIGN
    // and ADMIN_USER_UPDATE so the same users can also exercise the
    // reassign-scoping and cycle-prevention checks below.
    const staffRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Staff', slug: `e2e-staff-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [
        PERMISSIONS.PRESALES_INQUIRY_READ,
        PERMISSIONS.PRESALES_INQUIRY_CREATE,
        PERMISSIONS.PRESALES_INQUIRY_UPDATE,
        PERMISSIONS.PRESALES_INQUIRY_ASSIGN,
        PERMISSIONS.PRESALES_FOLLOW_UP_READ,
        PERMISSIONS.PRESALES_FOLLOW_UP_CREATE,
        PERMISSIONS.PRESALES_FOLLOW_UP_UPDATE,
        PERMISSIONS.PRESALES_REPORT_VIEW,
        PERMISSIONS.ADMIN_USER_READ,
        PERMISSIONS.ADMIN_USER_UPDATE,
      ].map((key) => ({ roleId: staffRole.id, permissionId: permByKey.get(key) })),
    });

    const adminRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Admin', slug: SYSTEM_ROLES.COMPANY_ADMIN, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      // ADMIN_TEAM_SCOPE_ALL is what now confers company-wide visibility.
      // This role previously got it purely from its SLUG being
      // `company_admin`, which is exactly the coupling that broke a
      // company's own custom full-permission admin role — it was scoped to
      // its own subtree with no error to explain why. The real seeded
      // company_admin holds this permission (it takes every admin.* key),
      // so granting it here matches production rather than working around
      // the change.
      data: [
        PERMISSIONS.PRESALES_INQUIRY_READ,
        PERMISSIONS.ADMIN_USER_UPDATE,
        PERMISSIONS.ADMIN_TEAM_SCOPE_ALL,
      ].map((key) => ({
        roleId: adminRole.id,
        permissionId: permByKey.get(key),
      })),
    });

    const pw = await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id });

    smEmail = `e2e-sm-${TAG}@test.com`;
    const sm = await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: smEmail, passwordHash: pw, name: 'Senior Manager', roleId: staffRole.id, forcePasswordChange: false },
    });
    smId = sm.id;

    mEmail = `e2e-m-${TAG}@test.com`;
    const m = await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: mEmail, passwordHash: pw, name: 'Manager', roleId: staffRole.id, forcePasswordChange: false, managerId: smId },
    });
    mId = m.id;

    eEmail = `e2e-e-${TAG}@test.com`;
    const e = await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: eEmail, passwordHash: pw, name: 'Exec', roleId: staffRole.id, forcePasswordChange: false, managerId: mId },
    });
    eId = e.id;

    peerEmail = `e2e-peer-${TAG}@test.com`;
    const peer = await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: peerEmail, passwordHash: pw, name: 'Peer', roleId: staffRole.id, forcePasswordChange: false },
    });
    peerId = peer.id;

    adminEmail = `e2e-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: adminEmail, passwordHash: pw, name: 'Admin', roleId: adminRole.id, forcePasswordChange: false },
    });

    // The exec creates their own inquiry — creator-retains-lead (v0.3.1)
    // means this lands on `e`, exactly the case that matters here: can
    // the exec's OWN manager and senior manager see it, and can a peer
    // with no relation to the chain NOT see it.
    const { agent, token, csrf } = await login(eEmail);
    const createRes = await agent
      .post('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ projectId: fx.projectId, applicant: { name: 'Chain Applicant', primaryPhone: '9812400001' } })
      .expect(201);
    execInquiryId = createRes.body.id;
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  it('senior manager (2 hops up) sees the exec\'s inquiry — full subtree, not just direct reports', async () => {
    const { agent, token } = await login(smEmail);
    const listRes = await agent.get('/api/v1/inquiries').set('Authorization', `Bearer ${token}`).expect(200);
    const ids = (listRes.body.data as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(execInquiryId);

    const detailRes = await agent.get(`/api/v1/inquiries/${execInquiryId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(detailRes.body.id).toBe(execInquiryId);
  });

  it('direct manager sees the exec\'s inquiry', async () => {
    const { agent, token } = await login(mEmail);
    const listRes = await agent.get('/api/v1/inquiries').set('Authorization', `Bearer ${token}`).expect(200);
    const ids = (listRes.body.data as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(execInquiryId);
  });

  it('a peer with no management relationship to the chain does NOT see the exec\'s inquiry', async () => {
    const { agent, token } = await login(peerEmail);
    const listRes = await agent.get('/api/v1/inquiries').set('Authorization', `Bearer ${token}`).expect(200);
    const ids = (listRes.body.data as Array<{ id: string }>).map((i) => i.id);
    expect(ids).not.toContain(execInquiryId);

    // findOne must 404, not leak existence via a 403 or empty-but-200 body.
    await agent.get(`/api/v1/inquiries/${execInquiryId}`).set('Authorization', `Bearer ${token}`).expect(404);
  });

  it('company_admin sees the exec\'s inquiry regardless of the org chart (no managerId set at all)', async () => {
    const { agent, token } = await login(adminEmail);
    const listRes = await agent.get('/api/v1/inquiries').set('Authorization', `Bearer ${token}`).expect(200);
    const ids = (listRes.body.data as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(execInquiryId);
  });

  it('SECURITY: a peer cannot list, create, or update follow-ups on the exec\'s inquiry by id (the FollowUp IDOR fix)', async () => {
    const { agent, token, csrf } = await login(peerEmail);

    await agent
      .get(`/api/v1/inquiries/${execInquiryId}/follow-ups`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    await agent
      .post(`/api/v1/inquiries/${execInquiryId}/follow-ups`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ notes: 'A peer should never be able to write this' })
      .expect(404);
  });

  it('the exec\'s own manager CAN read and log a follow-up on the exec\'s inquiry (in-scope, not blocked)', async () => {
    const { agent, token, csrf } = await login(mEmail);

    const followUpRes = await agent
      .post(`/api/v1/inquiries/${execInquiryId}/follow-ups`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ notes: 'Manager checking in on the team' })
      .expect(201);

    const listRes = await agent
      .get(`/api/v1/inquiries/${execInquiryId}/follow-ups`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ids = (listRes.body as Array<{ id: string }>).map((f) => f.id);
    expect(ids).toContain(followUpRes.body.id);
  });

  it('reassign is scoped on both ends: manager cannot move the exec\'s inquiry to a peer, or to their own senior manager', async () => {
    const { agent, token, csrf } = await login(mEmail);

    // Peer is outside the manager's visible set entirely — not a valid target.
    await agent
      .patch(`/api/v1/inquiries/${execInquiryId}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ toUserId: peerId })
      .expect(404);

    // The senior manager is the MANAGER's own manager, not a report — also
    // outside the manager's visible set (visible set is downward only).
    await agent
      .patch(`/api/v1/inquiries/${execInquiryId}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ toUserId: smId })
      .expect(404);

    // Reassigning to the manager themself IS valid — they're in their own visible set.
    const assignRes = await agent
      .patch(`/api/v1/inquiries/${execInquiryId}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ toUserId: mId, reason: 'Taking this one myself' })
      .expect(200);
    expect(assignRes.body.toUserId).toBe(mId);

    // Restore for any later test in this file that assumes the exec still holds it.
    await agent
      .patch(`/api/v1/inquiries/${execInquiryId}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ toUserId: eId, reason: 'Restoring for test isolation' })
      .expect(200);
  });

  it('cycle prevention: rejects a managerId change that would close a loop', async () => {
    const { agent, token, csrf } = await login(adminEmail);

    // Chain is SM -> M -> E. Setting SM's manager to E would close the loop.
    const res = await agent
      .patch(`/api/v1/users/${smId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ managerId: eId })
      .expect(400);
    expect(res.body.message).toMatch(/cycle/i);

    // A user cannot be their own manager either.
    const selfRes = await agent
      .patch(`/api/v1/users/${mId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ managerId: mId })
      .expect(400);
    expect(selfRes.body.message).toMatch(/own manager/i);
  });

  it('changing a manager takes effect immediately — no caching, no re-login needed', async () => {
    // Peer currently sees nothing of the chain. Move the exec under the
    // peer instead, and the VERY NEXT request (same already-issued token,
    // no re-login) must reflect it — TeamScopeService computes fresh from
    // the database on every call.
    const admin = await login(adminEmail);
    await admin.agent
      .patch(`/api/v1/users/${eId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('X-CSRF-Token', admin.csrf)
      .send({ managerId: peerId })
      .expect(200);

    const { agent: peerAgent, token: peerToken } = await login(peerEmail);
    const listRes = await peerAgent.get('/api/v1/inquiries').set('Authorization', `Bearer ${peerToken}`).expect(200);
    const ids = (listRes.body.data as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(execInquiryId);

    // Restore the original chain for test isolation.
    await admin.agent
      .patch(`/api/v1/users/${eId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('X-CSRF-Token', admin.csrf)
      .send({ managerId: mId })
      .expect(200);
  });

  it('presales reports are scoped the same way: senior manager sees the exec\'s inquiry in the funnel, a peer does not', async () => {
    const sm = await login(smEmail);
    const smFunnel = await sm.agent.get('/api/v1/reports/presales/funnel').set('Authorization', `Bearer ${sm.token}`).expect(200);
    const smTotal = (smFunnel.body as Array<{ status: string; count: number }>).reduce((sum, r) => sum + r.count, 0);
    expect(smTotal).toBeGreaterThanOrEqual(1);

    const peer = await login(peerEmail);
    const peerFunnel = await peer.agent.get('/api/v1/reports/presales/funnel').set('Authorization', `Bearer ${peer.token}`).expect(200);
    const peerTotal = (peerFunnel.body as Array<{ status: string; count: number }>).reduce((sum, r) => sum + r.count, 0);
    expect(peerTotal).toBe(0);
  });
});
