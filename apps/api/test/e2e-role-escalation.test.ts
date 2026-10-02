/**
 * v0.8.2 Part F: nobody may act on a user, or grant a role, beyond the
 * permissions they hold themselves. Every case goes over real HTTP against
 * the compiled dist/, with the caller loaded fresh from the database (never
 * from the JWT snapshot).
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
import { assertSuperAdminNotEmptied } from '../src/common/permission-subset.util';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const PW = 'StaffPass12345';
const TAG = Date.now();

describeIf('v0.8.2 role/user escalation boundary', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let permId: Map<string, string>;
  let hash: string;
  let seq = 0;

  let superRoleId: string;
  // "company_admin-like": all admin.* but NOT every permission.
  let adminRoleId: string;
  let adminRole2Id: string; // identical permission set to adminRole (peer)
  let lowRoleId: string; // holds a strict subset of adminRole

  const ADMIN_KEYS = [
    PERMISSIONS.ADMIN_USER_READ,
    PERMISSIONS.ADMIN_USER_CREATE,
    PERMISSIONS.ADMIN_USER_UPDATE,
    PERMISSIONS.ADMIN_USER_DEACTIVATE,
    PERMISSIONS.ADMIN_ROLE_READ,
    PERMISSIONS.ADMIN_ROLE_CREATE,
    PERMISSIONS.ADMIN_ROLE_UPDATE,
    PERMISSIONS.ADMIN_ROLE_DELETE,
  ];
  const LOW_KEYS = [PERMISSIONS.ADMIN_USER_READ, PERMISSIONS.ADMIN_USER_UPDATE];

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
    process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-role-escalation-${process.pid}-${Date.now()}-`;

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
    hash = await argon2.hash(PW, { algorithm: argon2.Algorithm.Argon2id });

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const all = await systemPrisma.permission.findMany();
    permId = new Map(all.map((p: { key: string; id: string }) => [p.key, p.id]));

    const mkRole = async (slug: string, keys: readonly string[]) => {
      const r = await systemPrisma.role.create({
        data: { companyId: fx.companyId, name: slug, slug, isSystem: slug === 'super_admin' },
      });
      await systemPrisma.rolePermission.createMany({
        data: keys.map((k) => ({ roleId: r.id, permissionId: permId.get(k) })),
      });
      return r.id as string;
    };
    superRoleId = await mkRole('super_admin', ALL_PERMISSIONS);
    adminRoleId = await mkRole(`e2e-esc-admin-${TAG}`, ADMIN_KEYS);
    adminRole2Id = await mkRole(`e2e-esc-admin2-${TAG}`, ADMIN_KEYS);
    lowRoleId = await mkRole(`e2e-esc-low-${TAG}`, LOW_KEYS);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (fx) await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma?.$disconnect();
  });

  async function mkUser(roleId: string, extra: Record<string, unknown> = {}) {
    const email = `e2e-esc-${TAG}-${seq++}@test.com`;
    const u = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: hash,
        name: email,
        roleId,
        forcePasswordChange: false,
        ...extra,
      },
    });
    return { id: u.id as string, email };
  }

  async function login(email: string) {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email, password: PW }).expect(200);
    const csrf = /openestate_csrf=([^;]+)/.exec(String(res.headers['set-cookie']))![1];
    return { agent, token: res.body.accessToken as string, csrf };
  }

  type S = Awaited<ReturnType<typeof login>>;
  const call = (s: S, method: 'post' | 'patch' | 'delete', url: string, body?: object) => {
    const r = s.agent[method](`/api/v1${url}`).set('Authorization', `Bearer ${s.token}`).set('X-CSRF-Token', s.csrf);
    return body ? r.send(body) : r;
  };

  const roleOf = async (id: string) => (await systemPrisma.user.findUniqueOrThrow({ where: { id } })).roleId;

  it('create: a caller cannot give a new user a role holding permissions they lack (403)', async () => {
    const caller = await login((await mkUser(adminRoleId)).email);
    const email = `e2e-esc-new-${TAG}-${seq++}@test.com`;
    const res = await call(caller, 'post', '/users', { email, name: 'N', password: PW, roleId: superRoleId });
    expect(res.status).toBe(403);
    expect(await systemPrisma.user.findFirst({ where: { email } })).toBeNull();
  });

  it('update: cannot change your OWN role, even to a role you hold (400)', async () => {
    const me = await mkUser(adminRoleId);
    const res = await call(await login(me.email), 'patch', `/users/${me.id}`, { roleId: adminRole2Id });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('You cannot change your own role.');
    expect(await roleOf(me.id)).toBe(adminRoleId);
  });

  it('update: a company_admin-like caller cannot promote another user to super_admin (403)', async () => {
    const target = await mkUser(lowRoleId);
    const res = await call(await login((await mkUser(adminRoleId)).email), 'patch', `/users/${target.id}`, {
      roleId: superRoleId,
    });
    expect(res.status).toBe(403);
    expect(await roleOf(target.id)).toBe(lowRoleId);
  });

  it('update/deactivate/force-reset/reset-2fa: a non-super caller cannot act on a super_admin (403)', async () => {
    const victim = await mkUser(superRoleId);
    const s = await login((await mkUser(adminRoleId)).email);
    for (const [method, url, body] of [
      ['patch', `/users/${victim.id}`, { name: 'pwned' }],
      ['post', `/users/${victim.id}/deactivate`, undefined],
      ['post', `/users/${victim.id}/force-password-reset`, undefined],
      ['post', `/users/${victim.id}/reset-2fa`, undefined],
    ] as const) {
      const res = await call(s, method, url, body as object | undefined);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    const row = await systemPrisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(row.name).not.toBe('pwned');
    expect(row.isActive).toBe(true);
    expect(await systemPrisma.passwordReset.count({ where: { userId: victim.id } })).toBe(0);
  });

  it('peer action is allowed: two callers with identical permission sets can act on each other (200)', async () => {
    const peer = await mkUser(adminRole2Id);
    const res = await call(await login((await mkUser(adminRoleId)).email), 'patch', `/users/${peer.id}`, {
      name: 'peer-renamed',
    });
    expect(res.status).toBe(200);
  });

  it('a super_admin caller can still act on another super_admin (control)', async () => {
    const other = await mkUser(superRoleId);
    const res = await call(await login((await mkUser(superRoleId)).email), 'patch', `/users/${other.id}`, {
      name: 'by-super',
    });
    expect(res.status).toBe(200);
  });

  it('roles: cannot create a role with permissions you lack, nor grant them to an existing role (403)', async () => {
    const s = await login((await mkUser(adminRoleId)).email);
    const created = await call(s, 'post', '/roles', {
      name: 'x',
      slug: `e2e-esc-newrole-${TAG}`,
      permissionIds: [permId.get(PERMISSIONS.ADMIN_ROLE_READ), permId.get(PERMISSIONS.INVENTORY_UNIT_PLC_MANAGE)],
    });
    expect(created.status).toBe(403);
    expect(await systemPrisma.role.findFirst({ where: { slug: `e2e-esc-newrole-${TAG}` } })).toBeNull();

    const grant = await call(s, 'patch', `/roles/${lowRoleId}`, {
      permissionIds: [permId.get(PERMISSIONS.INVENTORY_UNIT_PLC_MANAGE)],
    });
    expect(grant.status).toBe(403);
  });

  it('roles: cannot edit a role holding permissions you lack, including to widen your OWN role (403)', async () => {
    const s = await login((await mkUser(lowRoleId)).email);
    // low caller has USER_READ/USER_UPDATE only; ROLE_UPDATE missing so route guard 403s too —
    // use adminRole caller against super_admin role instead.
    const adminCaller = await login((await mkUser(adminRoleId)).email);
    const wipe = await call(adminCaller, 'patch', `/roles/${superRoleId}`, { permissionIds: [] });
    expect(wipe.status).toBe(403);
    expect(await systemPrisma.rolePermission.count({ where: { roleId: superRoleId } })).toBe(ALL_PERMISSIONS.length);

    const selfWiden = await call(adminCaller, 'patch', `/roles/${adminRoleId}`, {
      permissionIds: [...ADMIN_KEYS, PERMISSIONS.INVENTORY_UNIT_PLC_MANAGE].map((k) => permId.get(k)),
    });
    expect(selfWiden.status).toBe(403);
    expect(s.token).toBeTruthy();
  });

  it('super_admin is judged as holding EVERY permission: unticking one on its own role does not stop it re-granting it', async () => {
    const s = await login((await mkUser(superRoleId)).email);
    const key = PERMISSIONS.INVENTORY_UNIT_PLC_MANAGE;
    const without = ALL_PERMISSIONS.filter((k) => k !== key).map((k) => permId.get(k));
    expect((await call(s, 'patch', `/roles/${superRoleId}`, { permissionIds: without })).status).toBe(200);
    const again = await call(s, 'patch', `/roles/${superRoleId}`, {
      permissionIds: ALL_PERMISSIONS.map((k) => permId.get(k)),
    });
    expect(again.status).toBe(200);
    expect(await systemPrisma.rolePermission.count({ where: { roleId: superRoleId } })).toBe(ALL_PERMISSIONS.length);
  });

  it('roles: a permitted edit writes a ROLE_PERMS_CHANGED audit row naming the actor', async () => {
    const actor = await mkUser(adminRoleId);
    const res = await call(await login(actor.email), 'patch', `/roles/${lowRoleId}`, {
      permissionIds: LOW_KEYS.map((k) => permId.get(k)),
    });
    expect(res.status).toBe(200);
    const row = await systemPrisma.auditLog.findFirst({
      where: { companyId: fx.companyId, entityId: lowRoleId, action: 'ROLE_PERMS_CHANGED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row.userId).toBe(actor.id);
  });

  it('stale JWT: a caller demoted AFTER login is refused with their old (broader) token', async () => {
    const caller = await mkUser(adminRoleId);
    const s = await login(caller.email);
    const target = await mkUser(adminRoleId);
    await systemPrisma.user.update({ where: { id: caller.id }, data: { roleId: lowRoleId } });
    const res = await call(s, 'patch', `/users/${target.id}`, { name: 'stale' });
    expect(res.status).toBe(403);
  });

  it('stale JWT: a caller deactivated AFTER login is refused with their still-valid access token', async () => {
    const caller = await mkUser(adminRoleId);
    const s = await login(caller.email);
    const target = await mkUser(lowRoleId);
    await systemPrisma.user.update({ where: { id: caller.id }, data: { isActive: false } });
    const res = await call(s, 'patch', `/users/${target.id}`, { name: 'stale' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Your account is no longer active.');
  });

  it('wildcard expansion: the subset check compares stored literal keys, so a role holding every admin.* key passes against an admin.* role', async () => {
    const adminStar = ALL_PERMISSIONS.filter((k) => k.startsWith('admin.'));
    const roleId = (
      await systemPrisma.role.create({ data: { companyId: fx.companyId, name: 'star', slug: `e2e-esc-star-${TAG}` } })
    ).id as string;
    await systemPrisma.rolePermission.createMany({
      data: adminStar.map((k) => ({ roleId, permissionId: permId.get(k) })),
    });
    const target = await mkUser(roleId);
    const caller = await mkUser(roleId);
    expect((await call(await login(caller.email), 'patch', `/users/${target.id}`, { name: 'ok' })).status).toBe(200);
  });

  it('lockout guard: refuses to leave the company with no active super_admin (and allows it when another remains)', async () => {
    const co = await seedCompany(systemPrisma);
    try {
      const role = await systemPrisma.role.create({
        data: { companyId: co.companyId, name: 'super_admin', slug: 'super_admin', isSystem: true },
      });
      const mk = async (n: string) =>
        (
          await systemPrisma.user.create({
            data: { companyId: co.companyId, email: `e2e-lock-${TAG}-${n}@test.com`, passwordHash: hash, name: n, roleId: role.id },
          })
        ).id as string;
      const a = await mk('a');
      const b = await mk('b');
      await expect(
        systemPrisma.$transaction((tx: unknown) => assertSuperAdminNotEmptied(tx, co.companyId, a)),
      ).resolves.toBeUndefined();
      await systemPrisma.user.update({ where: { id: b }, data: { isActive: false } });
      await expect(
        systemPrisma.$transaction((tx: unknown) => assertSuperAdminNotEmptied(tx, co.companyId, a)),
      ).rejects.toThrow(/no active super_admin/);
    } finally {
      await cleanupCompany(systemPrisma, co.companyId);
    }
  });
});
