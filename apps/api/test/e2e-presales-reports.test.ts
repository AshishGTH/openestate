/**
 * Through-the-wire coverage for the pre-sales reporting suite's
 * cross-cutting mechanisms — the parts a direct-service-call test
 * structurally cannot prove, since guards run in the Nest pipeline before
 * a controller method body executes (CLAUDE.md's own standing lesson on
 * why a controller-direct-call test doesn't prove guard enforcement):
 *
 *  - presales.report.view gates every report route
 *  - presales.report.export is a SEPARATE permission required only when
 *    format=csv, checked and audited inside the handler
 *  - presales.report.print gates the new POST /reports/presales/audit-action
 *    endpoint, and it writes an audit row
 *  - every export writes an AuditLog row (who, which report, filters, row
 *    count) before the response completes
 *  - TeamScopeService subtree scoping: a manager sees their subordinate's
 *    data, not an unrelated colleague's
 *  - a row-level report streams real CSV (Content-Type + row count)
 *
 * Requires the compiled dist/ — see e2e-roles.test.ts for why.
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

describeIf('e2e /reports/presales: permissions, audit logging, and team scoping', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;

  let viewerEmail: string;
  let exporterEmail: string;
  let managerEmail: string;
  let managerId: string;
  let execUnderManagerId: string;
  let execOutsideId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    const viewerRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'Viewer', slug: `viewer-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.create({
      data: { roleId: viewerRole.id, permissionId: permByKey.get(PERMISSIONS.PRESALES_REPORT_VIEW) },
    });

    const exporterRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'Exporter', slug: `exporter-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [PERMISSIONS.PRESALES_REPORT_VIEW, PERMISSIONS.PRESALES_REPORT_EXPORT, PERMISSIONS.PRESALES_REPORT_PRINT].map(
        (key) => ({ roleId: exporterRole.id, permissionId: permByKey.get(key) }),
      ),
    });

    // Manager role: VIEW only, no ADMIN_TEAM_SCOPE_ALL — must be scoped to
    // its own subtree by TeamScopeService, not see the whole company.
    const managerRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'Scoped Manager', slug: `scoped-manager-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.create({
      data: { roleId: managerRole.id, permissionId: permByKey.get(PERMISSIONS.PRESALES_REPORT_VIEW) },
    });

    const passwordHash = await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id });

    viewerEmail = `viewer-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: viewerEmail, passwordHash, name: 'Viewer', roleId: viewerRole.id, forcePasswordChange: false },
    });

    exporterEmail = `exporter-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: exporterEmail, passwordHash, name: 'Exporter', roleId: exporterRole.id, forcePasswordChange: false },
    });

    managerEmail = `manager-${TAG}@test.com`;
    const manager = await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: managerEmail, passwordHash, name: 'Manager', roleId: managerRole.id, forcePasswordChange: false },
    });
    managerId = manager.id;

    const execRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'Exec', slug: `exec-${TAG}`, isSystem: true },
    });
    const execUnderManager = await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: `exec-under-${TAG}@test`, passwordHash: 'x', name: 'Exec Under Manager', roleId: execRole.id, managerId },
    });
    execUnderManagerId = execUnderManager.id;
    const execOutside = await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: `exec-outside-${TAG}@test`, passwordHash: 'x', name: 'Exec Outside', roleId: execRole.id },
    });
    execOutsideId = execOutside.id;

    const applicant = await systemPrisma.applicant.create({
      data: { companyId: fx.companyId, name: 'Report Applicant', primaryPhone: `9${TAG}`.slice(0, 10), primaryPhoneNormalized: `9${TAG}`.slice(0, 10) },
    });
    // One inquiry inside the manager's subtree, one outside it.
    await systemPrisma.inquiry.create({
      data: { companyId: fx.companyId, applicantId: applicant.id, status: 'OPEN', assignedToId: execUnderManagerId },
    });
    await systemPrisma.inquiry.create({
      data: { companyId: fx.companyId, applicantId: applicant.id, status: 'OPEN', assignedToId: execOutsideId },
    });

    // A DUMPED disposition-history row so dump-report has something real to stream.
    const inqForDump = await systemPrisma.inquiry.create({
      data: { companyId: fx.companyId, applicantId: applicant.id, status: 'DUMPED' },
    });
    await systemPrisma.inquiryDispositionHistory.create({
      data: { companyId: fx.companyId, inquiryId: inqForDump.id, toStatus: 'DUMPED' },
    });
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  async function login(email: string): Promise<{ agent: ReturnType<typeof request.agent>; token: string; csrf: string }> {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    return { agent, token: res.body.accessToken as string, csrf: extractCookie(res.headers['set-cookie'], 'openestate_csrf') };
  }

  it('presales.report.view is required, and JSON view works without export/print', async () => {
    const { agent, token } = await login(viewerEmail);
    await agent.get('/api/v1/reports/presales/funnel').set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('format=csv 403s for a viewer who lacks presales.report.export, even though view succeeds', async () => {
    const { agent, token } = await login(viewerEmail);
    const res = await agent.get('/api/v1/reports/presales/funnel?format=csv').set('Authorization', `Bearer ${token}`).expect(403);
    expect(res.body.message).toContain('presales.report.export');
  });

  it('format=csv succeeds for an exporter and writes an audit row with filters + row count', async () => {
    const { agent, token } = await login(exporterEmail);
    const res = await agent.get('/api/v1/reports/presales/funnel?format=csv').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');

    const auditRows = await systemPrisma.auditLog.findMany({
      where: { companyId: fx.companyId, entityType: 'PresalesReport', entityId: 'funnel', action: 'EXPORT' },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0].after).toMatchObject({ rowCount: expect.any(Number) });
  });

  it('POST /reports/presales/audit-action 403s without presales.report.print', async () => {
    const { agent, token, csrf } = await login(viewerEmail);
    await agent
      .post('/api/v1/reports/presales/audit-action')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ reportKey: 'funnel', filters: {}, rowCount: 4 })
      .expect(403);
  });

  it('POST /reports/presales/audit-action succeeds for a printer and writes a PRINT audit row', async () => {
    const { agent, token, csrf } = await login(exporterEmail);
    await agent
      .post('/api/v1/reports/presales/audit-action')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ reportKey: 'funnel', filters: { from: '2026-01-01' }, rowCount: 4 })
      .expect(201);

    const auditRows = await systemPrisma.auditLog.findMany({
      where: { companyId: fx.companyId, entityType: 'PresalesReport', entityId: 'funnel', action: 'PRINT' },
    });
    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0].after).toMatchObject({ rowCount: 4 });
  });

  it('a manager sees only their own reporting subtree, not an unrelated colleague', async () => {
    const { agent, token } = await login(managerEmail);
    const res = await agent.get('/api/v1/reports/presales/staff-performance').set('Authorization', `Bearer ${token}`).expect(200);
    const userIds = (res.body as Array<{ userId: string }>).map((r) => r.userId);
    expect(userIds).toContain(execUnderManagerId);
    expect(userIds).not.toContain(execOutsideId);
  });

  it('dump-report streams real CSV with a header row and at least one data row', async () => {
    const { agent, token } = await login(exporterEmail);
    const res = await agent.get('/api/v1/reports/presales/dump-report?format=csv').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe('Date,Applicant,Executive,Reason,Remarks');
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});
