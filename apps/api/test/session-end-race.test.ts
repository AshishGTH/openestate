/**
 * A refresh and a session-ending action (password change, deactivation) running
 * at the same moment must never leave a usable session behind.
 *
 * "Usable" is judged the way the API judges it: an access token is accepted only
 * while its `av` equals AuthzVersionService.current() (SessionVersionGuard), and
 * a refresh token is usable while it is live.
 *
 * Each test forces one interleaving (CLAUDE.md, "a concurrency test must force
 * its interleaving") by pausing one side at a chosen Prisma call through a
 * wrapped client, running the other side to completion, then resuming.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from '@node-rs/argon2';
import { createSystemPrismaClient, createTenantPrismaClient } from '@openestate/db';
import { TokenService } from '../src/auth/token.service';
import { AuthService } from '../src/auth/auth.service';
import { AuthzVersionService } from '../src/auth/authz-version.service';
import { UsersService } from '../src/users/users.service';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const TENANT_URL = process.env.DATABASE_URL_TEST;
const REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
const describeIf = SYSTEM_URL && TENANT_URL ? describe : describe.skip;

/* eslint-disable @typescript-eslint/no-explicit-any -- test-only Prisma proxying */

interface Gate {
  hit: Promise<void>;
  onHit: () => void;
  released: Promise<void>;
  release: () => void;
}
function makeGate(): Gate {
  let onHit!: () => void;
  let release!: () => void;
  const hit = new Promise<void>((r) => (onHit = r));
  const released = new Promise<void>((r) => (release = r));
  return { hit, onHit, released, release };
}

/**
 * A client that pauses once at `point`: 'user.findUnique:after' pauses after
 * that call returns; '$transaction' pauses before a transaction opens.
 */
function pausing(base: any, point: string, gate: Gate) {
  let fired = false;
  const fire = async () => {
    if (fired) return;
    fired = true;
    gate.onHit();
    await gate.released;
  };
  const model = (name: string, m: any) =>
    new Proxy(m, {
      get(target, op) {
        const fn = target[op];
        if (typeof fn !== 'function') return fn;
        return async (...args: unknown[]) => {
          const result = await fn.apply(target, args);
          if (`${name}.${String(op)}:after` === point) await fire();
          return result;
        };
      },
    });
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'user') return model('user', target.user);
      if (prop === '$transaction' && point === '$transaction') {
        return async (...args: any[]) => {
          await fire();
          return target.$transaction(...args);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describeIf('session-ending actions racing a refresh', () => {
  let prisma: any;
  let tenant: any;
  let authz: AuthzVersionService;
  const companyIds: string[] = [];
  const jwt = new JwtService({ secret: 'test-secret-0123456789' });
  const config = {
    getOrThrow: () => 'test-refresh-secret-0123456789',
    get: () => undefined,
  } as unknown as ConfigService;

  const tokens = (client: any) => new TokenService(jwt, config, client);
  const auth = (client: any, tokenService = tokens(prisma)) =>
    new AuthService(client, tokenService, undefined as never, authz);
  const users = (tokenClient: any) => new UsersService(tenant, prisma, tokens(tokenClient), authz);

  async function fixture(label: string) {
    const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const company = await prisma.company.create({ data: { name: `End ${label} ${tag}`, slug: `end-${label}-${tag}` } });
    companyIds.push(company.id);
    const role = await prisma.role.create({ data: { companyId: company.id, name: 'Staff', slug: `staff-${tag}`, isSystem: false } });
    const passwordHash = await argon2.hash('Old-password-1', { algorithm: argon2.Algorithm.Argon2id });
    const mk = (who: string) =>
      prisma.user.create({
        data: { companyId: company.id, roleId: role.id, name: who, email: `${who}-${tag}@test.com`, passwordHash },
      });
    const user = await mk('target');
    const admin = await mk('admin');
    return { companyId: company.id as string, userId: user.id as string, adminId: admin.id as string };
  }

  /** True when the API would still accept this access token. */
  async function usable(accessToken: string | undefined, userId: string) {
    if (!accessToken) return false;
    const { av } = jwt.decode(accessToken) as { av: number };
    return (await authz.current(userId)) === av;
  }

  const liveCount = async (userId: string) =>
    prisma.refreshToken.count({ where: { userId, isRevoked: false } });

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!);
    tenant = createTenantPrismaClient(TENANT_URL!);
    authz = new AuthzVersionService(prisma, REDIS_URL);
    await authz.ready();
  });

  afterAll(async () => {
    for (const companyId of companyIds) {
      await prisma.refreshToken.deleteMany({ where: { user: { companyId } } });
      await prisma.auditLog.deleteMany({ where: { companyId } });
      await prisma.user.deleteMany({ where: { companyId } });
      await prisma.role.deleteMany({ where: { companyId } });
      await prisma.leadStage.deleteMany({ where: { companyId } });
      await prisma.companyConfig.deleteMany({ where: { companyId } });
      await prisma.company.delete({ where: { id: companyId } });
    }
    await authz.onModuleDestroy();
    await tenant.$disconnect();
    await prisma.$disconnect();
  });

  it('(1) a password change between a refresh rotating its token and signing it leaves the access token unusable', async () => {
    const { userId } = await fixture('pw-mid-refresh');
    const t0 = await tokens(prisma).createRefreshToken(userId);

    const gate = makeGate();
    const refreshing = auth(pausing(prisma, 'user.findUnique:after', gate)).refreshTokens(t0.raw);
    await gate.hit; // rotated, user read, not yet signed
    await auth(prisma).changePassword(userId, 'Old-password-1', 'New-password-2');
    gate.release();
    const result = await refreshing;

    expect(await usable(result?.accessToken, userId)).toBe(false);
    expect(await liveCount(userId)).toBe(0);
  });

  it('(2) a refresh just before a password change opens its token transaction leaves nothing usable', async () => {
    const { userId } = await fixture('pw-before-end');
    const t0 = await tokens(prisma).createRefreshToken(userId);

    const gate = makeGate();
    const changing = auth(prisma, tokens(pausing(prisma, '$transaction', gate))).changePassword(
      userId,
      'Old-password-1',
      'New-password-2',
    );
    await gate.hit; // password written; sessions not yet ended
    const result = await auth(prisma).refreshTokens(t0.raw);
    gate.release();
    await changing;

    expect(await usable(result?.accessToken, userId)).toBe(false);
    expect(await liveCount(userId)).toBe(0);
  });

  it('(3a) a deactivation between a refresh rotating its token and signing it leaves the access token unusable', async () => {
    const { companyId, userId, adminId } = await fixture('deact-mid-refresh');
    const t0 = await tokens(prisma).createRefreshToken(userId);

    const gate = makeGate();
    const refreshing = auth(pausing(prisma, 'user.findUnique:after', gate)).refreshTokens(t0.raw);
    await gate.hit;
    await users(prisma).deactivate(companyId, userId, adminId);
    gate.release();
    const result = await refreshing;

    expect(await usable(result?.accessToken, userId)).toBe(false);
    expect(await liveCount(userId)).toBe(0);
  });

  it('(3b) a refresh after the account is deactivated, before its sessions are ended, issues nothing', async () => {
    const { companyId, userId, adminId } = await fixture('deact-before-end');
    const t0 = await tokens(prisma).createRefreshToken(userId);
    const rowsBefore = await prisma.refreshToken.count({ where: { userId } });

    const gate = makeGate();
    const deactivating = users(pausing(prisma, '$transaction', gate)).deactivate(companyId, userId, adminId);
    await gate.hit; // isActive = false committed; sessions not yet ended
    const result = await auth(prisma).refreshTokens(t0.raw);
    const rowsDuring = await prisma.refreshToken.count({ where: { userId } });
    gate.release();
    await deactivating;

    expect(result).toBeNull();
    expect(rowsDuring).toBe(rowsBefore); // no refresh token issued to an inactive account
    expect(await liveCount(userId)).toBe(0);
  });
});
