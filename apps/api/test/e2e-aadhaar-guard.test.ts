/**
 * v0.8.0: the Aadhaar guard on custom fields, through the real HTTP
 * pipeline (guards, validation pipe, service wiring).
 *
 * Layer (a) — definition names/labels; layer (b) — values, options and
 * defaults; layer (c) — the per-field exemption. The guard is deterrence
 * against accidental storage, not prevention (see aadhaar-guard.ts).
 *
 * No 12-digit literal appears here: Aadhaar-like values are random
 * digits plus a computed Verhoeff check digit; "invalid" values are a
 * valid one with its check digit changed.
 *
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
import { ALL_PERMISSIONS, CUSTOM_FIELD_VALUE_ENTITIES } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { aadhaarLike, withWrongCheckDigit, spaced } from './helpers/aadhaar-like';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';

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

// 10-digit mobile, high entropy (makeApplicant's counter collides across files).
const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

describeIf('e2e Aadhaar guard on custom fields', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  let fx: CompanyFixture;
  let adminEmail: string;
  let adminId: string;
  let session: { agent: ReturnType<typeof request.agent>; csrf: string; token: string };

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma, tenantPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const role = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Aadhaar Admin', slug: `e2e_aadhaar_${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: allPerms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })),
    });
    adminEmail = `e2e-aadhaar-${TAG}@test.com`;
    const admin = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Aadhaar Admin',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });
    adminId = admin.id;

    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: STAFF_PASSWORD }).expect(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const csrf = /openestate_csrf=([^;]+)/.exec(cookies.join(';'))![1];
    session = { agent, csrf, token: res.body.accessToken };
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  const send = (method: 'post' | 'patch', url: string, body: unknown) =>
    session.agent[method](`/api/v1${url}`)
      .set('Authorization', `Bearer ${session.token}`)
      .set('X-CSRF-Token', session.csrf)
      .send(body as object);

  let fieldSeq = 0;
  async function defineField(body: Record<string, unknown>) {
    const res = await send('post', '/custom-fields', {
      entityType: 'APPLICANT',
      key: `f_${TAG}_${fieldSeq++}`,
      label: `Field ${fieldSeq}`,
      fieldType: 'TEXT',
      ...body,
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; key: string; label: string };
  }
  async function deactivate(id: string) {
    await session.agent
      .delete(`/api/v1/custom-fields/${id}`)
      .set('Authorization', `Bearer ${session.token}`)
      .set('X-CSRF-Token', session.csrf)
      .expect(200);
  }

  // ── Layer (a): names and labels ─────────────────────────────

  it('refuses a field keyed or labelled with an Aadhaar word, naming the matched word', async () => {
    const byKey = await send('post', '/custom-fields', {
      entityType: 'APPLICANT', key: 'aadhaar_number', label: 'ID', fieldType: 'TEXT',
    });
    expect(byKey.status).toBe(400);
    expect(byKey.body.message).toContain('"aadhaar"');

    const byLabel = await send('post', '/custom-fields', {
      entityType: 'APPLICANT', key: `id_no_${TAG}`, label: 'Adhaar No', fieldType: 'TEXT',
    });
    expect(byLabel.status).toBe(400);
    expect(byLabel.body.message).toContain('"adhaar"');

    const hindi = await send('post', '/custom-fields', {
      entityType: 'APPLICANT', key: `base_${TAG}`, label: 'आधार मूल्य', fieldType: 'TEXT',
    });
    expect(hindi.status).toBe(400);
    expect(hindi.body.message).toContain('मूल'); // suggests मूल

    const n = await systemPrisma.customFieldDefinition.count({
      where: { companyId: fx.companyId, key: { in: ['aadhaar_number', `id_no_${TAG}`, `base_${TAG}`] } },
    });
    expect(n).toBe(0);
  });

  it('accepts "uid", "guide", and a short spelling only as part of a longer word', async () => {
    for (const [key, label] of [['uid', 'UID'], ['guide', 'Guide'], [`via_dharavi_${TAG}`, 'Via Dharavi']]) {
      const res = await send('post', '/custom-fields', { entityType: 'INQUIRY', key, label, fieldType: 'TEXT' });
      expect(res.status).toBe(201);
      await deactivate(res.body.id);
    }
  });

  it('checks a label rename, but leaves a pre-guard Aadhaar-named field editable', async () => {
    const f = await defineField({});
    const renamed = await send('patch', `/custom-fields/${f.id}`, { label: 'Aadhar card' });
    expect(renamed.status).toBe(400);
    expect(renamed.body.message).toContain('"aadhar"');

    // A field created before the guard existed, as on the verification VM.
    const legacy = await systemPrisma.customFieldDefinition.create({
      data: { companyId: fx.companyId, entityType: 'APPLICANT', key: `aadhaar_number_${TAG}`, label: 'Aadhaar number', fieldType: 'TEXT' },
    });
    await send('patch', `/custom-fields/${legacy.id}`, { label: 'Aadhaar number', isRequired: false }).expect(200);
    await send('patch', `/custom-fields/${legacy.id}`, { sortOrder: 3 }).expect(200);

    // ...but it can never be exempted from the value check.
    const exempt = await send('patch', `/custom-fields/${legacy.id}`, { allowsTwelveDigitValues: true });
    expect(exempt.status).toBe(400);
    expect(exempt.body.message).toMatch(/can't allow 12-digit values/);
    expect((await systemPrisma.customFieldDefinition.findUnique({ where: { id: legacy.id } })).allowsTwelveDigitValues).toBe(false);

    await deactivate(f.id);
    await deactivate(legacy.id);
  });

  // ── Layer (b) on definitions: options and default value ─────

  it('refuses an Aadhaar-like option or default value unless the field is exempt', async () => {
    const opt = await send('post', '/custom-fields', {
      entityType: 'APPLICANT', key: `opt_${TAG}`, label: 'Ref', fieldType: 'SELECT', options: ['A', spaced(aadhaarLike())],
    });
    expect(opt.status).toBe(400);
    const def = await send('post', '/custom-fields', {
      entityType: 'APPLICANT', key: `def_${TAG}`, label: 'Ref', fieldType: 'TEXT', defaultValue: aadhaarLike(),
    });
    expect(def.status).toBe(400);

    const exempt = await defineField({ defaultValue: aadhaarLike(), allowsTwelveDigitValues: true });
    const later = await send('patch', `/custom-fields/${exempt.id}`, { allowsTwelveDigitValues: false, defaultValue: aadhaarLike() });
    expect(later.status).toBe(400);
    await deactivate(exempt.id);
  });

  // ── Layers (b) and (c) on values, end to end ────────────────

  it('an exempt field accepts an Aadhaar-like value; the same value is refused, naming the field, when not exempt', async () => {
    const value = spaced(aadhaarLike());

    const exempt = await defineField({ label: 'Bank account', allowsTwelveDigitValues: true });
    const okPhone = phone();
    const ok = await send('post', '/applicants', { name: 'Exempt Ok', primaryPhone: okPhone, customFields: { [exempt.key]: value } });
    expect(ok.status).toBe(201);
    const stored = await systemPrisma.applicant.findFirst({ where: { companyId: fx.companyId, primaryPhone: okPhone } });
    expect(stored.customFields[exempt.key]).toBe(value);
    await deactivate(exempt.id);

    const checked = await defineField({ label: 'Reference number' });
    const refusedPhone = phone();
    const refused = await send('post', '/applicants', { name: 'Refused', primaryPhone: refusedPhone, customFields: { [checked.key]: value } });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain('Reference number: this looks like an Aadhaar number');
    expect(await systemPrisma.applicant.count({ where: { companyId: fx.companyId, primaryPhone: refusedPhone } })).toBe(0);

    // A wrong check digit and a spaced +91 mobile are ordinary values.
    for (const v of [withWrongCheckDigit(aadhaarLike()), '+91 98765 43210']) {
      await send('post', '/applicants', { name: 'Ordinary', primaryPhone: phone(), customFields: { [checked.key]: v } }).expect(201);
    }
    await deactivate(checked.id);
  });

  it('refuses an Aadhaar-like number in a NUMBER field', async () => {
    const f = await defineField({ fieldType: 'NUMBER', label: 'Count' });
    const res = await send('post', '/applicants', { name: 'Num', primaryPhone: phone(), customFields: { [f.key]: Number(aadhaarLike()) } });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Count: this looks like an Aadhaar number');
    await deactivate(f.id);
  });

  it('turning the exemption on writes an UPDATE audit row naming the admin', async () => {
    const f = await defineField({ label: 'Account no' });
    await send('patch', `/custom-fields/${f.id}`, { allowsTwelveDigitValues: true }).expect(200);
    const rows = await systemPrisma.auditLog.findMany({
      where: { companyId: fx.companyId, entityType: 'CustomFieldDefinition', entityId: f.id, action: 'UPDATE' },
    });
    // The audit extension records after-values only on UPDATE (before is
    // always null) — docs/todo.md tracks that. What it does record is
    // enough here: who turned the exemption on, and when.
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(adminId);
    expect(rows[0].ipAddress).toBeTruthy();
    expect(rows[0].after).toMatchObject({ allowsTwelveDigitValues: true });
    await deactivate(f.id);
  });

  it('creating a field with the exemption on writes a CREATE audit row naming the admin', async () => {
    // CLAUDE.md's audit rule: a write path to an audited model is tested
    // through HTTP for its row AND its actor, not just for the write.
    const f = await defineField({ label: 'Bank account (created exempt)', allowsTwelveDigitValues: true });
    const rows = await systemPrisma.auditLog.findMany({
      where: { companyId: fx.companyId, entityType: 'CustomFieldDefinition', entityId: f.id, action: 'CREATE' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(adminId);
    expect(rows[0].ipAddress).toBeTruthy();
    expect(rows[0].after).toMatchObject({ allowsTwelveDigitValues: true });
    await deactivate(f.id);
  });

  it('a record already holding an Aadhaar-like value can still be edited (only new or changed values are checked)', async () => {
    const f = await send('post', '/custom-fields', { entityType: 'PROJECT', key: `proj_ref_${TAG}`, label: 'Project ref', fieldType: 'TEXT' });
    expect(f.status).toBe(201);
    const existing = spaced(aadhaarLike());
    // Stored before the guard existed.
    await systemPrisma.project.update({ where: { id: fx.projectId }, data: { customFields: { [f.body.key]: existing } } });

    await send('patch', `/projects/${fx.projectId}`, { name: `Renamed ${TAG}` }).expect(200);
    // What the Edit Project form actually sends: every stored value back.
    await send('patch', `/projects/${fx.projectId}`, { name: `Renamed again ${TAG}`, customFields: { [f.body.key]: existing } }).expect(200);

    const changed = await send('patch', `/projects/${fx.projectId}`, { customFields: { [f.body.key]: spaced(aadhaarLike()) } });
    expect(changed.status).toBe(400);

    const row = await systemPrisma.project.findUnique({ where: { id: fx.projectId } });
    expect(row.name).toBe(`Renamed again ${TAG}`);
    expect(row.customFields[f.body.key]).toBe(existing);
    await deactivate(f.body.id);
  });

  it('every entity that stores values goes through the same check (BOOKING joins this list in PR 2)', async () => {
    const service = new CustomFieldsService(tenantPrisma, systemPrisma);
    for (const entityType of CUSTOM_FIELD_VALUE_ENTITIES) {
      const def = await systemPrisma.customFieldDefinition.create({
        data: { companyId: fx.companyId, entityType, key: `cover_${TAG}`, label: `Cover ${entityType}`, fieldType: 'TEXT' },
      });
      await expect(
        service.resolveValuesForWrite(fx.companyId, entityType, { [def.key]: aadhaarLike() }),
      ).rejects.toThrow(`Cover ${entityType}: this looks like an Aadhaar number`);
      await expect(
        service.resolveValuesForWrite(fx.companyId, entityType, { [def.key]: withWrongCheckDigit(aadhaarLike()) }),
      ).resolves.toBeDefined();
      await systemPrisma.customFieldDefinition.update({ where: { id: def.id }, data: { isActive: false } });
    }
  });
});
