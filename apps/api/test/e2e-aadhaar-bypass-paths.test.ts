/**
 * v0.8.0: the Aadhaar guard's two BYPASS paths.
 *
 * resolveValuesForWrite (the staff UI and staff API) checks values and
 * REJECTS them. Two machine-driven paths write `custom_fields` without
 * going through it, because nobody is there to show an error to:
 *
 *   - InquiryService.createFromLead, which serves POST /leads/inbound AND a
 *     plugin's ctx.leads.create — writes `{ leadNote }`
 *   - InquiryImportService (POST /inquiries/import) — writes `{ importNotes }`
 *
 * Each must REDACT instead. Each test sends a checksum-valid value through
 * that exact entry point and asserts what was STORED in the database — not
 * that a function was called.
 *
 * No 12-digit literal appears here: valid values are random digits plus a
 * computed Verhoeff check digit.
 *
 * Requires the compiled dist/ — see e2e-portal.test.ts for why. (The plugin
 * test constructs services from src directly, like lead-inbound.test.ts.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import * as ExcelJS from 'exceljs';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { z } from 'zod';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS, SYSTEM_CLOCK, AADHAAR_REDACTION, findAadhaarLikeNumbers } from '@openestate/shared';
import type { Plugin } from '@openestate/plugin-sdk';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { aadhaarLike, withWrongCheckDigit, spaced } from './helpers/aadhaar-like';
import { InquiryService } from '../src/presales/inquiry.service';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';
import { AssignmentService } from '../src/presales/assignment.service';
import { ApplicantService } from '../src/presales/applicant.service';
import { LeadStageTransitionService } from '../src/presales/lead-stage-transition.service';
import { InquiryDispositionTransitionService } from '../src/presales/inquiry-disposition-transition.service';
import { PanEncryptionService } from '../src/common/pan-encryption.service';
import { PluginSecretEncryptionService } from '../src/plugins/plugin-secret-encryption.service';
import { PluginRuntimeService } from '../src/plugins/plugin-runtime.service';
import { CompanyService } from '../src/company/company.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'c9d8e7f6'.repeat(8)}`;
process.env.PAN_ENCRYPTION_KEY ??= 'a1b2c3d4'.repeat(8);

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();
const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

async function bootstrapApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = APP_URL;
  process.env.DATABASE_URL_SYSTEM = SYSTEM_URL;
  process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
  process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-0123456789';
  process.env.JWT_REFRESH_SECRET ??= 'e2e-test-refresh-secret-0123456789';
  process.env.TOTP_ENCRYPTION_KEY ??= 'e5f6a7b8'.repeat(8);
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
    { header: 'Notes', key: 'notes' },
  ];
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describeIf('Aadhaar guard: redaction on the machine-driven bypass paths', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  let fx: CompanyFixture;
  let session: { agent: ReturnType<typeof request.agent>; csrf: string; token: string };

  // A note carrying: a checksum-valid number (spaced, as people write it), a
  // spaced +91 mobile, and a wrong-check-digit 12-digit number. Only the
  // first is an Aadhaar-like value; the other two must survive untouched.
  const valid = aadhaarLike();
  const wrong = withWrongCheckDigit(aadhaarLike());
  const note = `Call back on +91 98765 43210, card ${spaced(valid)}, ref ${wrong}.`;
  const expectedStored = `Call back on +91 98765 43210, card ${AADHAAR_REDACTION}, ref ${wrong}.`;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma, tenantPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const role = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Bypass Admin', slug: `e2e_bypass_${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: allPerms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })),
    });
    const email = `e2e-bypass-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Bypass Admin',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    session = { agent, csrf: /openestate_csrf=([^;]+)/.exec(cookies.join(';'))![1], token: res.body.accessToken };
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  /** The stored custom_fields of the inquiry belonging to the applicant with this phone. */
  async function storedCustomFields(mobile: string): Promise<Record<string, unknown>> {
    const applicant = await systemPrisma.applicant.findFirst({ where: { companyId: fx.companyId, primaryPhone: mobile } });
    expect(applicant, 'the applicant was created').toBeTruthy();
    const inquiry = await systemPrisma.inquiry.findFirst({ where: { companyId: fx.companyId, applicantId: applicant.id } });
    expect(inquiry, 'the inquiry was created').toBeTruthy();
    return inquiry.customFields as Record<string, unknown>;
  }

  it('POST /leads/inbound: an Aadhaar-like value in the note is stored redacted; other numbers are untouched', async () => {
    const created = await session.agent
      .post('/api/v1/admin/lead-api-keys')
      .set('Authorization', `Bearer ${session.token}`)
      .set('X-CSRF-Token', session.csrf)
      .send({ name: 'Bypass Vendor', fieldMapping: { name: 'lead.name', phone: 'lead.mobile', note: 'lead.note' } })
      .expect(201);

    const mobile = phone();
    await request(app.getHttpServer())
      .post('/api/v1/leads/inbound')
      .set('X-Api-Key', created.body.rawKey)
      .send({ lead: { name: 'Inbound Bypass', mobile, note } })
      .expect(201);

    const stored = await storedCustomFields(mobile);
    expect(stored.leadNote).toBe(expectedStored);
    expect(findAadhaarLikeNumbers(JSON.stringify(stored))).toHaveLength(0);
  });

  it("a plugin's ctx.leads.create: the note is stored redacted", async () => {
    const assignment = new AssignmentService(tenantPrisma);
    const customFields = new CustomFieldsService(tenantPrisma, systemPrisma);
    const applicants = new ApplicantService(tenantPrisma, systemPrisma, new PanEncryptionService(), customFields);
    const inquiries = new InquiryService(
      tenantPrisma, systemPrisma, SYSTEM_CLOCK, assignment, applicants, customFields,
      new LeadStageTransitionService(), new InquiryDispositionTransitionService(),
    );
    const runtime = new PluginRuntimeService(
      new PluginSecretEncryptionService(), applicants, new CompanyService(tenantPrisma, systemPrisma), inquiries,
    );
    const plugin: Plugin = {
      manifest: {
        id: 'aadhaar-bypass-test', name: 'test', version: '1.0.0', kind: 'lead-source', coreApiVersion: '^1.0.0',
        description: 'test', configSchema: z.object({}), configFields: [], capabilities: ['leads.create'],
      },
      hooks: {},
    };

    const mobile = phone();
    const ctx = runtime.buildContext(plugin, fx.companyId, {});
    await ctx.leads.create({ name: 'Plugin Bypass', phone: mobile, note });

    const stored = await storedCustomFields(mobile);
    expect(stored.leadNote).toBe(expectedStored);
    expect(findAadhaarLikeNumbers(JSON.stringify(stored))).toHaveLength(0);
  });

  it('POST /inquiries/import: an Aadhaar-like value in the Notes column is stored redacted', async () => {
    const mobile = phone();
    const file = await buildXlsx([{ applicantName: 'Import Bypass', primaryPhone: mobile, notes: note }]);
    const res = await session.agent
      .post('/api/v1/inquiries/import')
      .set('Authorization', `Bearer ${session.token}`)
      .set('X-CSRF-Token', session.csrf)
      .attach('file', file, 'bypass.xlsx')
      .expect(201);
    expect(res.body.createdCount).toBe(1);

    const stored = await storedCustomFields(mobile);
    expect(stored.importNotes).toBe(expectedStored);
    expect(findAadhaarLikeNumbers(JSON.stringify(stored))).toHaveLength(0);
  });

  it('a note with no Aadhaar-like value is stored exactly as sent (import path)', async () => {
    const plain = `Interested in a 2 BHK, budget 50 lakh, call +91 98765 43210, ref ${wrong}`;
    const mobile = phone();
    const file = await buildXlsx([{ applicantName: 'Plain Import', primaryPhone: mobile, notes: plain }]);
    await session.agent
      .post('/api/v1/inquiries/import')
      .set('Authorization', `Bearer ${session.token}`)
      .set('X-CSRF-Token', session.csrf)
      .attach('file', file, 'plain.xlsx')
      .expect(201);
    expect((await storedCustomFields(mobile)).importNotes).toBe(plain);
  });
});
