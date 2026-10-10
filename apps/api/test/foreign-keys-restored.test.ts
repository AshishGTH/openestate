/**
 * v0.8.4 Part A: the 71 foreign keys dropped in 2026-08 are back.
 * Migrations: 20261022000000_restore_foreign_keys (ADD ... NOT VALID) and
 * 20261022000100_validate_restored_foreign_keys (VALIDATE where orphan-free).
 *
 * The list of links is read from the ADD migration itself, so the test and
 * the migration cannot drift apart.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS, SYSTEM_CLOCK } from '@openestate/shared';
import { PrismaClient } from '@openestate/db';
import {
  makeClients,
  buildServices,
  seedCompany,
  makeUnit,
  makeApplicant,
  cleanupCompany,
  TEST_SUPER_URL,
  type Services,
  type CompanyFixture,
} from './helpers/postsales-harness';
import { insertFillers, deleteFillers, probeForeignKeys, type Fillers } from './helpers/fk-probe';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const ADD_SQL = readFileSync(
  path.join(__dirname, '../../../packages/db/prisma/migrations/20261022000000_restore_foreign_keys/migration.sql'),
  'utf8',
);
const LINKS = [
  ...ADD_SQL.matchAll(/ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)" FOREIGN KEY \("(\w+)"\) REFERENCES "(\w+)"/g),
].map(([, table, name, column, parent]) => ({ table, name, column, parent }));

const PASSWORD = 'FkRestore123';
const L = (rupees: number) => BigInt(rupees) * 100n;

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

describeIf('v0.8.4 Part A: restored foreign keys', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let sup: PrismaClient;
  let svc: Services;
  let fx: CompanyFixture;
  let staffRoleId: string;
  let adminEmail: string;
  // One committed filler row per child table, inserted with every foreign key
  // switched off. Committed on purpose: PostgreSQL re-checks EVERY foreign key
  // of a row updated in the transaction that inserted it, so an uncommitted
  // filler would trip over its own placeholder values.
  let fillers: Fillers | undefined;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    fx = await seedCompany(systemPrisma);
    sup = new PrismaClient({ datasourceUrl: TEST_SUPER_URL });
    staffRoleId = (await systemPrisma.user.findUniqueOrThrow({ where: { id: fx.userId } })).roleId;
    fillers = await insertFillers(sup, new Set(LINKS.map((l) => l.table)), (table) =>
      table === 'users' ? { company_id: fx.companyId, role_id: staffRoleId } : { company_id: fx.companyId },
    );

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const perms = await systemPrisma.permission.findMany();
    const role = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'FK admin', slug: `fk-admin-${Date.now()}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: perms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })),
    });
    adminEmail = `fk-admin-${Date.now()}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'FK admin',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });
    app = await bootstrapApp();
  });

  afterAll(async () => {
    await app?.close();
    if (sup && fillers) await deleteFillers(sup, fillers);
    if (fx) await cleanupCompany(systemPrisma, fx.companyId);
    await Promise.all([sup?.$disconnect(), systemPrisma?.$disconnect(), tenantPrisma?.$disconnect()]);
  });

  async function login() {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: PASSWORD }).expect(200);
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const csrf = /openestate_csrf=([^;]+)/.exec(setCookie.join(';'))?.[1] ?? '';
    return { agent, token: res.body.accessToken as string, csrf };
  }

  it('the migration lists exactly 71 links', () => {
    expect(LINKS).toHaveLength(71);
    expect(new Set(LINKS.map((l) => l.name)).size).toBe(71);
  });

  it('every one of the 71 links refuses a pointer to a row that does not exist', async () => {
    const notRejected = await probeForeignKeys(sup, LINKS, fillers!);
    const problems = notRejected.filter((x) => !x.endsWith(': accepted'));
    expect(problems, 'setup problems').toEqual([]);
    expect(notRejected).toEqual([]);
  });

  it('on orphan-free data all 71 are present and validated', async () => {
    const rows = await sup.$queryRawUnsafe<Array<{ conname: string; convalidated: boolean }>>(
      `SELECT conname, convalidated FROM pg_constraint WHERE contype = 'f' AND conname = ANY($1::text[])`,
      LINKS.map((l) => l.name),
    );
    expect(rows.filter((r) => r.convalidated).map((r) => r.conname).sort()).toEqual(LINKS.map((l) => l.name).sort());
  });

  it('the three RESTRICT links refuse deletion: ON DELETE is RESTRICT', async () => {
    const rows = await sup.$queryRawUnsafe<Array<{ conname: string; confdeltype: string }>>(
      `SELECT conname, confdeltype FROM pg_constraint WHERE conname IN
        ('ledger_entries_installment_id_fkey','interest_accruals_installment_id_fkey','interest_accruals_interest_rule_id_fkey')
       ORDER BY conname`,
    );
    expect(rows).toEqual([
      { conname: 'interest_accruals_installment_id_fkey', confdeltype: 'r' },
      { conname: 'interest_accruals_interest_rule_id_fkey', confdeltype: 'r' },
      { conname: 'ledger_entries_installment_id_fkey', confdeltype: 'r' },
    ]);
  });

  async function bookingWithInterestCharged() {
    const rule = await systemPrisma.interestRule.create({
      data: { companyId: fx.companyId, name: `FK 18% ${Date.now()}`, rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY' },
    });
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-01-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000), gstRateId: fx.defaultGstRateId }],
      },
      fx.userId,
    );
    await systemPrisma.booking.update({ where: { id: booking.id }, data: { interestRuleId: rule.id } });
    const plan = await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: new Date('2026-07-02'), amountPaise: L(10_00_000) }] },
      fx.userId,
    );
    const accrued = await svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2026-08-01'));
    expect(accrued.postedPaise).toBeGreaterThan(0n);
    return { bookingId: booking.id, ruleId: rule.id, installmentId: plan.installments[0].id as string };
  }

  it('editing a plan whose unpaid installment has interest charged is refused with a plain 409, and nothing changes', async () => {
    const { bookingId, installmentId } = await bookingWithInterestCharged();
    const ledgerBefore = await systemPrisma.ledgerEntry.count({ where: { bookingId } });
    const { agent, token, csrf } = await login();
    const res = await agent
      .post(`/api/v1/bookings/${bookingId}/plan/edit`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Edited', installments: [{ label: 'New', dueDate: '2026-12-01', amountPaise: L(10_00_000).toString() }] });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.message).toBe("This installment has interest charged and can't be removed.");
    // The edit rolled back: the installment is still there and its ledger and accrual rows still point at it.
    expect(await systemPrisma.installment.count({ where: { id: installmentId } })).toBe(1);
    expect(await systemPrisma.ledgerEntry.count({ where: { bookingId } })).toBe(ledgerBefore);
    expect(await systemPrisma.interestAccrual.count({ where: { installmentId } })).toBe(1);
  });

  it('deleting an interest rule that has charged interest is refused with a plain 409', async () => {
    const { ruleId } = await bookingWithInterestCharged();
    const { agent, token, csrf } = await login();
    const res = await agent
      .delete(`/api/v1/masters/interest-rules/${ruleId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(
      "This interest rule has been used to charge interest and can't be deleted. Mark it inactive instead.",
    );
    expect(await systemPrisma.interestRule.count({ where: { id: ruleId } })).toBe(1);
  });

  it('control: an interest rule nothing uses can still be deleted', async () => {
    const rule = await systemPrisma.interestRule.create({
      data: { companyId: fx.companyId, name: `FK unused ${Date.now()}`, rateType: 'SIMPLE', ratePercent: 12, frequency: 'YEARLY' },
    });
    const { agent, token, csrf } = await login();
    const res = await agent
      .delete(`/api/v1/masters/interest-rules/${rule.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf);
    expect(res.status).toBeLessThan(300);
  });
});
