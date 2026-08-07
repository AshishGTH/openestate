/**
 * v0.2.3: through-the-wire coverage for custom field VALUES.
 *
 * Values have been writable since Phase 3 via `z.record(z.unknown())` —
 * any key, any value, straight into JSONB, with `validateCustomFields`
 * sitting unused in CustomFieldsService the whole time. These tests
 * drive the real HTTP pipeline (guards, ZodValidationPipe, the service
 * wiring) because a direct service call can't prove the DTO actually
 * rejects what a real client sends — the Phase 5 `soldUnitsQuerySchema`
 * lesson.
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
import { ALL_PERMISSIONS } from '@openestate/shared';
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

describeIf('e2e custom field values: validation, lifecycle, purge', () => {
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

    const role = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E CF Admin', slug: `e2e_cf_admin_${TAG}`, isSystem: true },
    });
    // Full permission set — this test exercises admin CRUD, presales
    // writes and reports, so scoping it down would only add noise.
    await systemPrisma.rolePermission.createMany({
      data: allPerms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })),
    });

    adminEmail = `e2e-cf-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E CF Admin',
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
    throw new Error(`Cookie ${name} not found`);
  }

  async function loginAgent() {
    const agent = request.agent(app.getHttpServer());
    const res = await agent
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: STAFF_PASSWORD })
      .expect(200);
    return {
      agent,
      csrf: extractCookie(res.headers['set-cookie'], 'openestate_csrf'),
      token: res.body.accessToken as string,
    };
  }

  it('refuses to define a custom field for BOOKING (no storage exists for it)', async () => {
    const { agent, csrf, token } = await loginAgent();
    const res = await agent
      .post('/api/v1/custom-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ entityType: 'BOOKING', key: 'nope', label: 'Nope', fieldType: 'TEXT' })
      .expect(400);
    expect(res.body.message).toMatch(/not supported for BOOKING/i);
  });

  it('rejects an unknown custom field key on applicant create, not silently strips it', async () => {
    const { agent, csrf, token } = await loginAgent();
    await agent
      .post('/api/v1/custom-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ entityType: 'APPLICANT', key: `known_${TAG}`, label: 'Known', fieldType: 'TEXT' })
      .expect(201);

    const res = await agent
      .post('/api/v1/applicants')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({
        name: 'Unknown Key Applicant',
        primaryPhone: `9${String(Date.now()).slice(-9)}`,
        customFields: { totally_made_up: 'junk' },
      })
      .expect(400);
    expect(res.body.message).toMatch(/Unrecognized custom field/i);
  });

  it('blocks a create that omits a REQUIRED field, and accepts it once supplied', async () => {
    const { agent, csrf, token } = await loginAgent();
    const key = `req_${TAG}`;
    await agent
      .post('/api/v1/custom-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ entityType: 'PROJECT', key, label: 'Required Code', fieldType: 'TEXT', isRequired: true })
      .expect(201);

    const bad = await agent
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: `CF Project A ${TAG}`, code: `CFA-${TAG}` })
      .expect(400);
    expect(bad.body.message).toMatch(new RegExp(key));

    const ok = await agent
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: `CF Project B ${TAG}`, code: `CFB-${TAG}`, customFields: { [key]: 'RERA-9' } })
      .expect(201);
    expect(ok.body.customFields[key]).toBe('RERA-9');
  });

  it('validates the MERGED result on PATCH, so a partial update cannot bypass a required field', async () => {
    const { agent, csrf, token } = await loginAgent();
    const key = `req_${TAG}`; // required PROJECT field from the previous test

    const created = await agent
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: `CF Project C ${TAG}`, code: `CFC-${TAG}`, customFields: { [key]: 'RERA-1' } })
      .expect(201);

    // A PATCH that supplies an empty customFields object must NOT be
    // treated as "nothing to check" — the merged result still needs the
    // required key, which it has from storage, so this succeeds and
    // preserves the stored value rather than wiping it.
    const patched = await agent
      .patch(`/api/v1/projects/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ customFields: {} })
      .expect(200);
    expect(patched.body.customFields[key]).toBe('RERA-1');

    // Explicitly clearing a required field is refused.
    await agent
      .patch(`/api/v1/projects/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ customFields: { [key]: '' } })
      .expect(400);
  });

  it('preserves stored values when the definition is renamed (label) or deactivated', async () => {
    const { agent, csrf, token } = await loginAgent();
    const key = `keep_${TAG}`;
    const defRes = await agent
      .post('/api/v1/custom-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ entityType: 'APPLICANT', key, label: 'Original Label', fieldType: 'TEXT' })
      .expect(201);

    const applicant = await agent
      .post('/api/v1/applicants')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({
        name: 'Keeps Values',
        primaryPhone: `9${String(Date.now() + 1).slice(-9)}`,
        customFields: { [key]: 'survives' },
      })
      .expect(201);

    // Rename the LABEL — values are keyed by the immutable `key`, so a
    // rename can never orphan one.
    await agent
      .patch(`/api/v1/custom-fields/${defRes.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ label: 'Renamed Label' })
      .expect(200);

    let row = await systemPrisma.applicant.findUnique({ where: { id: applicant.body.id } });
    expect(row.customFields[key]).toBe('survives');

    // Soft delete (the default DELETE action) — value must survive.
    await agent
      .delete(`/api/v1/custom-fields/${defRes.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(200);

    row = await systemPrisma.applicant.findUnique({ where: { id: applicant.body.id } });
    expect(row.customFields[key]).toBe('survives');

    const stillThere = await systemPrisma.customFieldDefinition.findUnique({ where: { id: defRes.body.id } });
    expect(stillThere.isActive).toBe(false);
  });

  it('refuses to empty the options of a SELECT field', async () => {
    const { agent, csrf, token } = await loginAgent();
    const created = await agent
      .post('/api/v1/custom-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({
        entityType: 'UNIT',
        key: `facing_${TAG}`,
        label: 'Facing',
        fieldType: 'SELECT',
        options: ['North', 'South'],
      })
      .expect(201);

    const res = await agent
      .patch(`/api/v1/custom-fields/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ options: [] })
      .expect(400);
    expect(res.body.message).toMatch(/at least one option/i);
  });

  it('hard purge requires the field key typed back, then strips values and audits the row count', async () => {
    const { agent, csrf, token } = await loginAgent();
    const key = `purge_${TAG}`;
    const defRes = await agent
      .post('/api/v1/custom-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ entityType: 'APPLICANT', key, label: 'To Purge', fieldType: 'TEXT' })
      .expect(201);

    const applicant = await agent
      .post('/api/v1/applicants')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({
        name: 'Purge Me',
        primaryPhone: `9${String(Date.now() + 2).slice(-9)}`,
        customFields: { [key]: 'doomed' },
      })
      .expect(201);

    const count = await agent
      .get(`/api/v1/custom-fields/${defRes.body.id}/value-count`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(count.body.affectedRows).toBe(1);

    // Wrong confirmation is refused — a count alone is not consent.
    const wrong = await agent
      .post(`/api/v1/custom-fields/${defRes.body.id}/purge`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ confirmKey: 'not-the-key' })
      .expect(400);
    expect(wrong.body.message).toMatch(/Type the field key/i);

    const stillThere = await systemPrisma.applicant.findUnique({ where: { id: applicant.body.id } });
    expect(stillThere.customFields[key]).toBe('doomed');

    const purged = await agent
      .post(`/api/v1/custom-fields/${defRes.body.id}/purge`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ confirmKey: key })
      .expect(201);
    expect(purged.body.purgedValueRows).toBe(1);

    const after = await systemPrisma.applicant.findUnique({ where: { id: applicant.body.id } });
    expect(after.customFields?.[key]).toBeUndefined();

    const audit = await systemPrisma.auditLog.findFirst({
      where: { companyId: fx.companyId, entityId: defRes.body.id, action: 'PURGE' },
    });
    expect(audit).toBeTruthy();
    expect((audit.after as { purgedValueRows: number }).purgedValueRows).toBe(1);
  });

  it('exports one CSV column per active custom field, with the value in the row', async () => {
    const { agent, csrf, token } = await loginAgent();

    // An inquiry carrying values on BOTH entity types, so the export
    // proves the applicant-side and inquiry-side bags are each read
    // from the right place rather than one masking the other.
    const inqKey = `inq_note_${TAG}`;
    await agent
      .post('/api/v1/custom-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ entityType: 'INQUIRY', key: inqKey, label: 'Inquiry Note', fieldType: 'TEXT' })
      .expect(201);

    await agent
      .post('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({
        applicant: {
          name: 'Export Applicant',
          primaryPhone: `9${String(Date.now() + 3).slice(-9)}`,
          alternatePhones: [],
          customFields: { [`known_${TAG}`]: 'applicant-side' },
        },
        customFields: { [inqKey]: 'inquiry-side' },
      })
      .expect(201);

    const res = await agent
      .get('/api/v1/reports/presales/inquiries-export?format=csv')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    // Prefixed headers — APPLICANT and INQUIRY may define the same key,
    // and an unprefixed collision would silently drop one.
    expect(res.text).toMatch(/applicant\.Known/);
    expect(res.text).toMatch(/inquiry\.Inquiry Note/);
    expect(res.text).toContain('applicant-side');
    expect(res.text).toContain('inquiry-side');
  });
});
