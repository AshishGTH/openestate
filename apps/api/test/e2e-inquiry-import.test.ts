/**
 * Regression coverage for a real routing hazard found while building this
 * endpoint: InquiryController's GET /inquiries/:id is registered before
 * InquiryImportController in presales.module.ts's controllers array — a
 * request for the literal path GET /inquiries/import-template would
 * otherwise be swallowed as id="import-template" and 404 (no inquiry with
 * that id exists) instead of reaching the template download. Fixed by
 * reordering the module's controllers array; this test proves the actual
 * route resolves to the right handler, not just that some 200 comes back.
 *
 * Also covers the real import path end to end (row-level validation
 * errors AND a successful create), confirming what CLAUDE.md's triage
 * already found true of InquiryImportService — the check-before-building
 * item was "does the backend already work," and this is the through-the-
 * wire proof of that, now that a caller (the new UI) actually exists.
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
import * as ExcelJS from 'exceljs';
import { ALL_PERMISSIONS, PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();

// main.ts patches BigInt.prototype.toJSON so money fields (this file hits
// it via CompanyConfig.chequeBounceChargePaise on PATCH /company/config,
// exercised for the first time by the presalesPhoneDedupAutoLink toggle
// tests below) serialize instead of crashing JSON.stringify — but every
// e2e-*.test.ts file bootstraps AppModule directly, never main.ts's own
// bootstrap(). See e2e-inquiry-assignment.test.ts for the same pattern.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

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

async function buildXlsx(rows: Array<Record<string, unknown>>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Inquiries');
  sheet.columns = [
    { header: 'Applicant Name', key: 'applicantName' },
    { header: 'Primary Phone', key: 'primaryPhone' },
    { header: 'Email', key: 'email' },
    { header: 'Project Code', key: 'projectCode' },
    { header: 'Source Name', key: 'sourceName' },
    { header: 'Inquiry Type Name', key: 'inquiryTypeName' },
    { header: 'Budget Min (paise)', key: 'budgetMinPaise' },
    { header: 'Budget Max (paise)', key: 'budgetMaxPaise' },
    { header: 'Notes', key: 'notes' },
  ];
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describeIf('e2e /inquiries/import-template and /inquiries/import', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let staffEmail: string;

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
      data: { companyId: fx.companyId, name: 'E2E Importer', slug: `e2e-importer-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [
        PERMISSIONS.PRESALES_INQUIRY_IMPORT,
        PERMISSIONS.PRESALES_INQUIRY_READ,
        PERMISSIONS.ADMIN_CONFIG_UPDATE,
      ].map((key) => ({
        roleId: role.id,
        permissionId: permByKey.get(key),
      })),
    });

    staffEmail = `e2e-importer-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: staffEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Importer',
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

  it('GET /inquiries/import-template resolves to the real template handler, not GET /inquiries/:id', async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: staffEmail, password: STAFF_PASSWORD }).expect(200);
    const token = loginRes.body.accessToken as string;

    const res = await agent
      .get('/api/v1/inquiries/import-template')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Pre-fix (wrong controller order): this would 404 as
    // GET /inquiries/:id with id="import-template" — a plain Nest
    // "Inquiry not found" JSON body (content-type application/json),
    // never reaching the real template handler at all. A real XLSX
    // response, correctly typed with real byte content, is proof this
    // resolved to the actual handler, not the swallowed route.
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('inquiry-import-template.xlsx');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(1000);
  });

  it('POST /inquiries/import: row-level validation errors are reported, no rows created', async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: staffEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;

    const badFile = await buildXlsx([{ applicantName: 'No Phone Applicant', primaryPhone: '' }]);
    const res = await agent
      .post('/api/v1/inquiries/import')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .attach('file', badFile, 'bad-import.xlsx')
      .expect(201);

    expect(res.body.success).toBe(false);
    expect(res.body.createdCount).toBe(0);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it('POST /inquiries/import: a valid row creates a real inquiry, visible via the list endpoint', async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: staffEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;

    const goodFile = await buildXlsx([
      { applicantName: `E2E Import Applicant ${TAG}`, primaryPhone: '9812399999' },
    ]);
    const res = await agent
      .post('/api/v1/inquiries/import')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .attach('file', goodFile, 'good-import.xlsx')
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.createdCount).toBe(1);

    // Not via GET /inquiries as this same importer: v0.4's TeamScopeService
    // now scopes that list to the caller's own assignedToId, and a bulk
    // import with no configured pool leaves the row unassigned
    // (AssignmentService.autoAssign returns null for an empty pool) — an
    // unassigned inquiry is invisible to any non-admin-tier scoped caller
    // by design (the same was already true of the old sales_executive-only
    // scoping; it just applies more broadly now). Confirming the row was
    // actually created is a direct DB read; inquiry VISIBILITY is
    // e2e-team-scope.test.ts's concern, not this file's.
    const created = await systemPrisma.inquiry.findFirst({
      where: { companyId: fx.companyId, applicant: { name: `E2E Import Applicant ${TAG}` } },
      include: { applicant: true },
    });
    expect(created?.applicant.name).toBe(`E2E Import Applicant ${TAG}`);
  });

  // ── Item 7: CompanyConfig.presalesPhoneDedupAutoLink toggle ────

  describe('presalesPhoneDedupAutoLink toggle', () => {
    afterAll(async () => {
      await systemPrisma.companyConfig.upsert({
        where: { companyId: fx.companyId },
        update: { presalesPhoneDedupAutoLink: true },
        create: { companyId: fx.companyId, presalesPhoneDedupAutoLink: true },
      });
    });

    it('default (on): a phone match against an existing applicant is auto-linked, not created', async () => {
      const agent = request.agent(app.getHttpServer());
      const loginRes = await agent.post('/api/v1/auth/login').send({ email: staffEmail, password: STAFF_PASSWORD }).expect(200);
      const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
      const token = loginRes.body.accessToken as string;

      const phone = `98123${TAG.toString().slice(-5)}`;
      const first = await buildXlsx([{ applicantName: `Import Link First ${TAG}`, primaryPhone: phone }]);
      await agent
        .post('/api/v1/inquiries/import')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .attach('file', first, 'first.xlsx')
        .expect(201);

      const second = await buildXlsx([{ applicantName: `Import Link Second ${TAG}`, primaryPhone: phone }]);
      const res = await agent
        .post('/api/v1/inquiries/import')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .attach('file', second, 'second.xlsx')
        .expect(201);

      expect(res.body.linkedCount).toBe(1);
      expect(res.body.flaggedCount).toBe(0);
      const applicantCount = await systemPrisma.applicant.count({ where: { companyId: fx.companyId, primaryPhone: phone } });
      expect(applicantCount).toBe(1);
    });

    it('off: a phone match is NOT auto-linked — a new applicant is created and reported in `flagged`', async () => {
      const agent = request.agent(app.getHttpServer());
      const loginRes = await agent.post('/api/v1/auth/login').send({ email: staffEmail, password: STAFF_PASSWORD }).expect(200);
      const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
      const token = loginRes.body.accessToken as string;

      await agent
        .patch('/api/v1/company/config')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .send({ presalesPhoneDedupAutoLink: false })
        .expect(200);

      const phone = `98124${TAG.toString().slice(-5)}`;
      const first = await buildXlsx([{ applicantName: `Import Flag First ${TAG}`, primaryPhone: phone }]);
      await agent
        .post('/api/v1/inquiries/import')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .attach('file', first, 'first-flag.xlsx')
        .expect(201);

      const second = await buildXlsx([{ applicantName: `Import Flag Second ${TAG}`, primaryPhone: phone }]);
      const res = await agent
        .post('/api/v1/inquiries/import')
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf)
        .attach('file', second, 'second-flag.xlsx')
        .expect(201);

      expect(res.body.linkedCount).toBe(0);
      expect(res.body.flaggedCount).toBe(1);
      expect(res.body.flagged[0]).toMatchObject({ applicantName: `Import Flag Second ${TAG}` });
      expect(res.body.flagged[0].possibleDuplicateOfApplicantId).toBeTruthy();
      expect(res.body.flagged[0].applicantId).not.toBe(res.body.flagged[0].possibleDuplicateOfApplicantId);

      const applicantCount = await systemPrisma.applicant.count({ where: { companyId: fx.companyId, primaryPhone: phone } });
      expect(applicantCount).toBe(2); // NOT linked — a real second applicant
    });
  });
});
