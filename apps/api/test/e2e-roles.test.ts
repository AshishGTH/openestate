/**
 * Regression coverage for a gap found during the v0.2.0 manual click-through:
 * RolesService.update() rejected ANY change to a system role (isSystem: true),
 * including a permissionIds-only update — not just a rename. Since a staff
 * user's effective permissions are baked into their JWT from `role_permissions`
 * rows (never live-recomputed from any TS constant), and the seeded system
 * roles (super_admin, company_admin, etc.) are exactly the roles a real admin
 * needs to grant a newly-added permission to, this meant a permission added
 * in a later release could NEVER be granted to any existing seeded role,
 * through any path — sync-permissions.ts (see CLAUDE.md's upgrade-path entry)
 * only inserts the Permission row, it deliberately never touches
 * role_permissions, and the UI's own RoleForm always sends the role's current
 * name alongside permissionIds, so even editing a system role's own
 * (unchanged) name tripped the blanket guard. Fixed by scoping the guard to
 * an actual name CHANGE, not the mere presence of a name field.
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

describeIf('e2e PATCH /roles/:id: system-role permission grants', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let adminEmail: string;
  let systemRoleId: string;
  let systemRoleName: string;
  let plcManageId: string;
  let chargeManageId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));
    plcManageId = permByKey.get(PERMISSIONS.INVENTORY_UNIT_PLC_MANAGE) as string;
    chargeManageId = permByKey.get(PERMISSIONS.INVENTORY_UNIT_CHARGE_MANAGE) as string;

    // Admin's own role, so it can call the Roles endpoints at all.
    const adminRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Roles Admin', slug: `e2e-roles-admin-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [PERMISSIONS.ADMIN_ROLE_READ, PERMISSIONS.ADMIN_ROLE_UPDATE, PERMISSIONS.ADMIN_ROLE_DELETE].map((key) => ({
        roleId: adminRole.id,
        permissionId: permByKey.get(key),
      })),
    });
    adminEmail = `e2e-roles-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Roles Admin',
        roleId: adminRole.id,
        forcePasswordChange: false,
      },
    });

    // A SEPARATE seeded system role, standing in for company_admin/etc —
    // this is the one the test grants the new permissions to.
    systemRoleName = `E2E System Role ${TAG}`;
    const systemRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: systemRoleName, slug: `e2e-system-role-${TAG}`, isSystem: true },
    });
    systemRoleId = systemRole.id;
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

  it('grants a newly-synced permission to a system role, exactly as the real RoleForm request shape does', async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;

    // RoleForm.tsx always sends the role's current (unchanged) name
    // alongside permissionIds — this must NOT trip the rename guard.
    const patchRes = await agent
      .patch(`/api/v1/roles/${systemRoleId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: systemRoleName, permissionIds: [plcManageId, chargeManageId] })
      .expect(200);
    expect(patchRes.body.permissions.map((p: { permission: { key: string } }) => p.permission.key).sort()).toEqual(
      [PERMISSIONS.INVENTORY_UNIT_PLC_MANAGE, PERMISSIONS.INVENTORY_UNIT_CHARGE_MANAGE].sort(),
    );

    const getRes = await agent
      .get(`/api/v1/roles/${systemRoleId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(getRes.body.permissions.map((p: { permission: { key: string } }) => p.permission.key).sort()).toEqual(
      [PERMISSIONS.INVENTORY_UNIT_PLC_MANAGE, PERMISSIONS.INVENTORY_UNIT_CHARGE_MANAGE].sort(),
    );
  });

  it('still rejects an actual rename of a system role', async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;

    const res = await agent
      .patch(`/api/v1/roles/${systemRoleId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: `${systemRoleName} Renamed` })
      .expect(400);
    expect(res.body.message).toContain('Cannot rename system roles');
  });

  it('still rejects deleting a system role', async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: adminEmail, password: STAFF_PASSWORD }).expect(200);
    const csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    const token = loginRes.body.accessToken as string;

    const res = await agent
      .delete(`/api/v1/roles/${systemRoleId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .expect(400);
    expect(res.body.message).toContain('Cannot delete system roles');
  });
});
