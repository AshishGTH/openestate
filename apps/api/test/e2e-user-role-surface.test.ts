/**
 * A user's role must match the kind of account: a portal account (customer
 * or broker, applicantId/brokerId set) only a portal role (isPortal), a
 * staff account only a staff role. Checked on PATCH /users/:id and on
 * POST /users (which always creates staff accounts). A role from another
 * company is refused too.
 *
 * Needs the compiled dist/ and the local test database.
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
import { makeClients, seedCompany, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const PW = 'StaffPass12345';
const TAG = Date.now();
const PORTAL_ACCOUNT_MSG = 'A customer or broker portal account can only be given a portal role.';
const STAFF_ACCOUNT_MSG = 'A staff account cannot be given a portal role.';

describeIf('Users API: a role must match the kind of account', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let otherFx: CompanyFixture;
  let adminEmail: string;
  let staffRoleId: string;
  let otherStaffRoleId: string;
  let portalRoleId: string;
  let otherPortalRoleId: string;
  let foreignRoleId: string;
  let staffUserId: string;
  let portalUserId: string;

  beforeAll(async () => {
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
    app = nestApp;

    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    otherFx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    const role = async (companyId: string, slug: string, isPortal: boolean) =>
      (await systemPrisma.role.create({ data: { companyId, name: slug, slug, isPortal } })).id as string;
    const adminRoleId = await role(fx.companyId, `e2e-urs-admin-${TAG}`, false);
    await systemPrisma.rolePermission.createMany({
      data: [PERMISSIONS.ADMIN_USER_READ, PERMISSIONS.ADMIN_USER_CREATE, PERMISSIONS.ADMIN_USER_UPDATE].map((key) => ({
        roleId: adminRoleId,
        permissionId: permByKey.get(key),
      })),
    });
    staffRoleId = await role(fx.companyId, `e2e-urs-staff-${TAG}`, false);
    otherStaffRoleId = await role(fx.companyId, `e2e-urs-staff2-${TAG}`, false);
    portalRoleId = await role(fx.companyId, `e2e-urs-portal-${TAG}`, true);
    otherPortalRoleId = await role(fx.companyId, `e2e-urs-portal2-${TAG}`, true);
    foreignRoleId = await role(otherFx.companyId, `e2e-urs-foreign-${TAG}`, false);

    const hash = await argon2.hash(PW, { algorithm: argon2.Algorithm.Argon2id });
    adminEmail = `e2e-urs-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: adminEmail, passwordHash: hash, name: 'E2E URS Admin', roleId: adminRoleId, forcePasswordChange: false },
    });
    staffUserId = (
      await systemPrisma.user.create({
        data: { companyId: fx.companyId, email: `e2e-urs-staff-${TAG}@test.com`, passwordHash: hash, name: 'E2E URS Staff', roleId: staffRoleId },
      })
    ).id;
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    portalUserId = (
      await systemPrisma.user.create({
        data: { companyId: fx.companyId, applicantId, phone: `6${String(TAG).slice(-9)}`, passwordHash: hash, name: 'E2E URS Customer', roleId: portalRoleId },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (fx) await cleanupCompany(systemPrisma, fx.companyId);
    if (otherFx) await cleanupCompany(systemPrisma, otherFx.companyId);
    await systemPrisma?.$disconnect();
  });

  async function session() {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: PW }).expect(200);
    const csrf = /openestate_csrf=([^;]+)/.exec(String(login.headers['set-cookie']))![1];
    return { agent, token: login.body.accessToken as string, csrf };
  }

  async function patchUser(userId: string, roleId: string) {
    const { agent, token, csrf } = await session();
    return agent
      .patch(`/api/v1/users/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ roleId });
  }

  async function roleOf(userId: string): Promise<string> {
    return (await systemPrisma.user.findUniqueOrThrow({ where: { id: userId } })).roleId;
  }

  it('refuses a staff role for a portal account (400, message), and leaves its role unchanged', async () => {
    const res = await patchUser(portalUserId, staffRoleId);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(PORTAL_ACCOUNT_MSG);
    expect(await roleOf(portalUserId)).toBe(portalRoleId);
  });

  it('refuses a portal role for a staff account (400, message), and leaves its role unchanged', async () => {
    const res = await patchUser(staffUserId, portalRoleId);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(STAFF_ACCOUNT_MSG);
    expect(await roleOf(staffUserId)).toBe(staffRoleId);
  });

  it('refuses a role from another company (400)', async () => {
    const res = await patchUser(staffUserId, foreignRoleId);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Role not found');
    expect(await roleOf(staffUserId)).toBe(staffRoleId);
  });

  it('refuses creating a staff user with a portal role (400, message)', async () => {
    const { agent, token, csrf } = await session();
    const email = `e2e-urs-new-${TAG}@test.com`;
    const res = await agent
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ email, name: 'E2E URS New', password: PW, roleId: portalRoleId });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(STAFF_ACCOUNT_MSG);
    expect(await systemPrisma.user.findFirst({ where: { email } })).toBeNull();
  });

  it('control: staff account to another staff role, portal account to another portal role (200)', async () => {
    expect((await patchUser(staffUserId, otherStaffRoleId)).status).toBe(200);
    expect(await roleOf(staffUserId)).toBe(otherStaffRoleId);
    expect((await patchUser(portalUserId, otherPortalRoleId)).status).toBe(200);
    expect(await roleOf(portalUserId)).toBe(otherPortalRoleId);
  });
});
