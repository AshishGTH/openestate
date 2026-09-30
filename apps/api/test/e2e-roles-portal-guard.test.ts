/**
 * PATCH /roles/:id refuses to give a portal role (isPortal) any permission
 * outside portal.*, naming the refused keys, and writes nothing. Staff
 * roles can still hold any permission.
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
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const PW = 'StaffPass12345';
const TAG = Date.now();

describeIf('Roles API: portal roles hold only portal permissions', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let permByKey: Map<string, string>;
  let adminEmail: string;
  let portalRoleId: string;
  let staffRoleId: string;

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

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    const adminRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E RPG Admin', slug: `e2e-rpg-admin-${TAG}` },
    });
    // v0.8.2: editing a role now requires the caller to already hold both
    // the role's current permissions and whatever it's being granted —
    // the admin fixture needs every permission these tests edit roles
    // with, not just the ADMIN_ROLE_* pair that lets it call the endpoint.
    await systemPrisma.rolePermission.createMany({
      data: [
        PERMISSIONS.ADMIN_ROLE_READ,
        PERMISSIONS.ADMIN_ROLE_UPDATE,
        PERMISSIONS.PORTAL_BOOKING_READ,
        PERMISSIONS.PORTAL_TICKET_READ,
        PERMISSIONS.REPORTS_BROKER_VIEW,
        PERMISSIONS.ADMIN_USER_READ,
      ].map((key) => ({
        roleId: adminRole.id,
        permissionId: permByKey.get(key),
      })),
    });
    adminEmail = `e2e-rpg-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(PW, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E RPG Admin',
        roleId: adminRole.id,
        forcePasswordChange: false,
      },
    });

    const portalRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E RPG Portal', slug: `e2e-rpg-portal-${TAG}`, isSystem: true, isPortal: true },
    });
    portalRoleId = portalRole.id;
    await systemPrisma.rolePermission.create({
      data: { roleId: portalRoleId, permissionId: permByKey.get(PERMISSIONS.PORTAL_BOOKING_READ) },
    });

    const staffRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E RPG Staff', slug: `e2e-rpg-staff-${TAG}` },
    });
    staffRoleId = staffRole.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (fx) await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma?.$disconnect();
  });

  async function session() {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: PW }).expect(200);
    const csrf = /openestate_csrf=([^;]+)/.exec(String(login.headers['set-cookie']))![1];
    return { agent, token: login.body.accessToken as string, csrf };
  }

  async function patchRole(roleId: string, keys: string[]) {
    const { agent, token, csrf } = await session();
    return agent
      .patch(`/api/v1/roles/${roleId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ permissionIds: keys.map((k) => permByKey.get(k)) });
  }

  async function heldKeys(roleId: string): Promise<string[]> {
    const rows = await systemPrisma.rolePermission.findMany({ where: { roleId }, include: { permission: true } });
    return rows.map((r: { permission: { key: string } }) => r.permission.key).sort();
  }

  it('refuses staff permissions on a portal role with a 400 naming them, and writes nothing', async () => {
    const res = await patchRole(portalRoleId, [
      PERMISSIONS.PORTAL_BOOKING_READ,
      PERMISSIONS.REPORTS_BROKER_VIEW,
      PERMISSIONS.ADMIN_USER_READ,
    ]);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      `Portal roles can only hold portal permissions. Not allowed: ${PERMISSIONS.ADMIN_USER_READ}, ${PERMISSIONS.REPORTS_BROKER_VIEW}`,
    );
    expect(await heldKeys(portalRoleId)).toEqual([PERMISSIONS.PORTAL_BOOKING_READ]);
  });

  it('control: a portal role accepts portal permissions', async () => {
    const res = await patchRole(portalRoleId, [PERMISSIONS.PORTAL_BOOKING_READ, PERMISSIONS.PORTAL_TICKET_READ]);
    expect(res.status).toBe(200);
    expect(await heldKeys(portalRoleId)).toEqual([PERMISSIONS.PORTAL_BOOKING_READ, PERMISSIONS.PORTAL_TICKET_READ].sort());
  });

  it('control: a staff role still accepts any permission, staff or portal', async () => {
    const keys = [PERMISSIONS.REPORTS_BROKER_VIEW, PERMISSIONS.ADMIN_USER_READ, PERMISSIONS.PORTAL_BOOKING_READ];
    const res = await patchRole(staffRoleId, keys);
    expect(res.status).toBe(200);
    expect(await heldKeys(staffRoleId)).toEqual([...keys].sort());
  });
});
