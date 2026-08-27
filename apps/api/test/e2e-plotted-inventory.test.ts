/**
 * Through-the-wire coverage for plotted-farmhouse-inventory Phase B's new
 * API surface (plan §11.3): InventoryGroup CRUD, the LAND_BASED unit-create
 * route, the shape-conditional 400s on the existing HIGH_RISE-only
 * endpoints, and — the one that actually protects real money —
 * BookingCostLineVerifier's gate on POST /bookings.
 *
 * Requires the compiled dist/ — see e2e-stage-raise.test.ts for why.
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
import { makeClients, seedCompany, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-plotted-inventory-${process.pid}-${Date.now()}-`;

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

describeIf('e2e plotted-farmhouse-inventory Phase B', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  // Real staff session: same-cookie-jar agent + the double-submit CSRF
  // header every mutating request needs (POST/PATCH/DELETE all 403
  // without it — a plain Authorization header is not enough).
  let agent: ReturnType<typeof request.agent>;
  let auth: { Authorization: string; 'X-CSRF-Token': string };
  let landProjectId: string;
  let highRiseProjectId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    highRiseProjectId = fx.projectId;

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));
    const role = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Plotted Admin', slug: `e2e-plotted-admin-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: ALL_PERMISSIONS.map((key) => ({ roleId: role.id, permissionId: permByKey.get(key) })),
    });
    const email = `e2e-plotted-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Plotted Admin',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });
    agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    auth = {
      Authorization: `Bearer ${login.body.accessToken as string}`,
      'X-CSRF-Token': extractCookie(login.headers['set-cookie'], 'openestate_csrf'),
    };

    const highRiseProject = await systemPrisma.project.findUniqueOrThrow({ where: { id: highRiseProjectId } });
    const landProject = await systemPrisma.project.create({
      data: {
        companyId: fx.companyId,
        name: `Land Project ${TAG}`,
        code: `LP-${TAG}`,
        shape: 'LAND_BASED',
        areaLocationId: highRiseProject.areaLocationId,
      },
    });
    landProjectId = landProject.id;
  }, 60_000);

  afterAll(async () => {
    if (fx?.companyId) await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await app?.close();
  });

  it('POST /projects/:id/towers refuses on a LAND_BASED project with a legible message', async () => {
    const res = await agent
      .post(`/api/v1/projects/${landProjectId}/towers`)
      .set(auth)
      .send({ name: 'T1', code: `T1-${TAG}`, totalFloors: 1 })
      .expect(400);
    expect(res.body.message).toContain('LAND_BASED');
  });

  it('POST /projects/:id/inventory-groups: happy path, then a cross-project group id 404s from the other project', async () => {
    const create = await agent
      .post(`/api/v1/projects/${landProjectId}/inventory-groups`)
      .set(auth)
      .send({ name: 'Sector 1', code: `S1-${TAG}`, kind: 'Sector' })
      .expect(201);
    expect(create.body.projectId).toBe(landProjectId);

    // Same group id, wrong project — must not be reachable from a project
    // it doesn't belong to.
    await agent
      .get(`/api/v1/projects/${highRiseProjectId}/inventory-groups/${create.body.id}`)
      .set(auth)
      .expect(404);
  });

  it('POST /projects/:id/inventory-groups on a HIGH_RISE project 400s', async () => {
    const res = await agent
      .post(`/api/v1/projects/${highRiseProjectId}/inventory-groups`)
      .set(auth)
      .send({ name: 'Sector X', code: `SX-${TAG}` })
      .expect(400);
    expect(res.body.message).toContain('HIGH_RISE');
  });

  it('POST /projects/:id/units/land-based: happy path, then the same route on a HIGH_RISE project 400s', async () => {
    const create = await agent
      .post(`/api/v1/projects/${landProjectId}/units/land-based`)
      .set(auth)
      .send({
        number: `PLOT-${TAG}`,
        landAreaEntered: 0.372,
        landAreaEnteredUnit: 'ACRE',
        rateUnit: 'ACRE',
        baseRatePaise: '50000000',
      })
      .expect(201);
    expect(create.body.shape).toBe('LAND_BASED');
    expect(create.body.floorId).toBeNull();
    // landAreaSqft derived server-side, not accepted from the client —
    // 0.372 acre * 43,560 sqft/acre = 16,204.32 sqft.
    expect(Number(create.body.landAreaSqft)).toBeCloseTo(16204.32, 2);

    const onHighRise = await agent
      .post(`/api/v1/projects/${highRiseProjectId}/units/land-based`)
      .set(auth)
      .send({
        number: `PLOT-WRONG-${TAG}`,
        landAreaEntered: 1,
        landAreaEnteredUnit: 'ACRE',
        rateUnit: 'ACRE',
        baseRatePaise: '1',
      })
      .expect(400);
    expect(onHighRise.body.message).toContain('HIGH_RISE');
  });

  // Phase C: the create-project surface never had a shape field at all
  // before this — every project the API could create was HIGH_RISE by
  // the DB default, regardless of what a caller sent. This is what
  // actually unblocks Project.shape being settable at all, and confirms
  // it's immutable afterwards (excluded from updateProjectSchema, same
  // treatment as `code`).
  it('POST /projects accepts shape: LAND_BASED, and PATCH /projects/:id rejects a shape key', async () => {
    const create = await agent
      .post('/api/v1/projects')
      .set(auth)
      .send({ name: `Phase C Land ${TAG}`, code: `PCL-${TAG}`, shape: 'LAND_BASED', landAreaDefaultUnit: 'ACRE' })
      .expect(201);
    expect(create.body.shape).toBe('LAND_BASED');
    expect(create.body.landAreaDefaultUnit).toBe('ACRE');

    // updateProjectSchema (.strict(), shape omitted — immutable per
    // plotted-farmhouse-inventory.md §13.3) rejects the unrecognized key
    // before the handler ever runs. The e2e harness's ZodValidationPipe
    // is the bare nestjs-zod one (every e2e bootstrap in this suite uses
    // it, not the custom-message wrapper main.ts uses in production —
    // see CLAUDE.md), so the message is the generic "Validation failed",
    // not a field-specific one; the 400 itself is what proves rejection.
    await agent
      .patch(`/api/v1/projects/${create.body.id}`)
      .set(auth)
      .send({ shape: 'HIGH_RISE' })
      .expect(400);
  });

  it('GET /projects/:id/units filters by inventoryGroupId', async () => {
    const group = await agent
      .post(`/api/v1/projects/${landProjectId}/inventory-groups`)
      .set(auth)
      .send({ name: `Filter Group ${TAG}`, code: `FG-${TAG}` })
      .expect(201);
    const grouped = await agent
      .post(`/api/v1/projects/${landProjectId}/units/land-based`)
      .set(auth)
      .send({
        number: `GROUPED-${TAG}`,
        inventoryGroupId: group.body.id,
        landAreaEntered: 0.1,
        landAreaEnteredUnit: 'ACRE',
        rateUnit: 'ACRE',
        baseRatePaise: '1000000',
      })
      .expect(201);

    const filtered = await agent
      .get(`/api/v1/projects/${landProjectId}/units?inventoryGroupId=${group.body.id}`)
      .set(auth)
      .expect(200);
    const ids = filtered.body.data.map((u: { id: string }) => u.id as string);
    expect(ids).toContain(grouped.body.id);
    // Every row returned actually belongs to the filtered group — not
    // just that the one grouped unit happens to be present among an
    // unfiltered list.
    for (const unit of filtered.body.data as Array<{ inventoryGroup: { id: string } | null }>) {
      expect(unit.inventoryGroup?.id).toBe(group.body.id);
    }
  });

  describe('LAND_BASED bulk import/export template', () => {
    it('GET /projects/:id/units/import-template on a LAND_BASED project returns the LAND_BASED header row, not the HIGH_RISE one', async () => {
      const res = await agent
        .get(`/api/v1/projects/${landProjectId}/units/import-template`)
        .set(auth)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');

      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body as Buffer);
      const headerRow = workbook.getWorksheet('Units')!.getRow(1);
      const headers: string[] = [];
      headerRow.eachCell((cell) => headers.push(String(cell.value)));
      expect(headers).toContain('Group Code');
      expect(headers).toContain('Unit Number');
      expect(headers).not.toContain('Tower Code');
    });

    it('POST /projects/:id/units/import on a LAND_BASED project creates a plot from an XLSX row', async () => {
      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Units');
      const importUnitNumber = `IMPORTED-${TAG}`;
      sheet.addRow([
        'Group Code',
        'Unit Number',
        'Unit Type',
        'Land Area Entered',
        'Land Area Unit (SQFT/SQYD/SQM/ACRE/GUNTA)',
        'Rate Unit (SQFT/SQYD/SQM/ACRE/GUNTA)',
        'Base Rate (paise, per Rate Unit)',
      ]);
      sheet.addRow(['', importUnitNumber, '', 5, 'GUNTA', 'GUNTA', 100000]);
      const buffer = await workbook.xlsx.writeBuffer();

      const res = await agent
        .post(`/api/v1/projects/${landProjectId}/units/import`)
        .set(auth)
        .attach('file', Buffer.from(buffer), 'import.xlsx')
        .expect(201);
      expect(res.body.success).toBe(true);
      expect(res.body.createdCount).toBe(1);

      const listRes = await agent
        .get(`/api/v1/projects/${landProjectId}/units?search=${importUnitNumber}`)
        .set(auth)
        .expect(200);
      expect(listRes.body.data).toHaveLength(1);
      // 5 gunta = 5,445 sqft (1 gunta = 1,089 sqft), matched-unit pricing —
      // confirms the import path derives landAreaSqft server-side same as
      // the direct create route, not trusting a client-supplied value.
      expect(Number(listRes.body.data[0].landAreaSqft)).toBeCloseTo(5445, 1);
    });

    it('GET /projects/:id/units/export on a LAND_BASED project returns the LAND_BASED column layout', async () => {
      const res = await agent
        .get(`/api/v1/projects/${landProjectId}/units/export`)
        .set(auth)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);

      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body as Buffer);
      const headerRow = workbook.getWorksheet('Units')!.getRow(1);
      const headers: string[] = [];
      headerRow.eachCell((cell) => headers.push(String(cell.value)));
      expect(headers).toContain('Group Code');
      expect(headers).not.toContain('Tower Code');
    });
  });

  describe('BookingCostLineVerifier gate on POST /bookings', () => {
    let landUnitId: string;
    let applicantId: string;

    beforeAll(async () => {
      const unit = await agent
        .post(`/api/v1/projects/${landProjectId}/units/land-based`)
        .set(auth)
        .send({
          number: `VERIFY-PLOT-${TAG}`,
          landAreaEntered: 0.5,
          landAreaEnteredUnit: 'ACRE',
          rateUnit: 'ACRE',
          baseRatePaise: '5000000',
        })
        .expect(201);
      landUnitId = unit.body.id;
      applicantId = await makeApplicant(systemPrisma, fx.companyId);
    });

    // Correct: 0.5 acre * 50,00,000 paise/acre = 25,00,000 paise.
    const CORRECT_AMOUNT = '2500000';

    it('rejects a BASE amount off by 1000 paise, naming the line and both amounts', async () => {
      const res = await agent
        .post('/api/v1/bookings')
        .set(auth)
        .send({
          unitId: landUnitId,
          primaryApplicantId: applicantId,
          coApplicantIds: [],
          bookingDate: '2026-06-01',
          costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: String(BigInt(CORRECT_AMOUNT) + 1000n), gstRateId: fx.defaultGstRateId }],
        })
        .expect(400);
      expect(res.body.message).toContain('Base');
      expect(res.body.message).toContain(CORRECT_AMOUNT);
    });

    it('accepts a BASE amount off by exactly 1 paise (the allowed slack)', async () => {
      await agent
        .post('/api/v1/bookings')
        .set(auth)
        .send({
          unitId: landUnitId,
          primaryApplicantId: applicantId,
          coApplicantIds: [],
          bookingDate: '2026-06-01',
          costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: String(BigInt(CORRECT_AMOUNT) + 1n), gstRateId: fx.defaultGstRateId }],
        })
        .expect(201);
    });

    it('accepts the exact computed amount', async () => {
      const unit2 = await agent
        .post(`/api/v1/projects/${landProjectId}/units/land-based`)
        .set(auth)
        .send({
          number: `VERIFY-PLOT-2-${TAG}`,
          landAreaEntered: 0.5,
          landAreaEnteredUnit: 'ACRE',
          rateUnit: 'ACRE',
          baseRatePaise: '5000000',
        })
        .expect(201);
      await agent
        .post('/api/v1/bookings')
        .set(auth)
        .send({
          unitId: unit2.body.id,
          primaryApplicantId: applicantId,
          coApplicantIds: [],
          bookingDate: '2026-06-01',
          costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: CORRECT_AMOUNT, gstRateId: fx.defaultGstRateId }],
        })
        .expect(201);
    });
  });
});
