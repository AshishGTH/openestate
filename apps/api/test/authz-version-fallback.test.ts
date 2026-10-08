/**
 * AuthzVersionService / SessionVersionGuard when Redis is unavailable, and the
 * per-request cost when it is.
 *
 * Redis down: the version is read from the database, so a stale token is still
 * refused and a current one still allowed. It never fails open: with the
 * database unreachable too, the check throws (the request fails).
 * Mutation check: with the fallback replaced by "allow when Redis errors", the
 * stale-token test fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { createSystemPrismaClient } from '@openestate/db';
import { AuthzVersionService } from '../src/auth/authz-version.service';
import { SessionVersionGuard } from '../src/auth/guards/session-version.guard';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
const DEAD_REDIS = 'redis://127.0.0.1:6399'; // nothing listens here
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const ctx = (user: object) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

describeIf('session authorisation version: Redis unavailable, and the cost per request', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let downService: AuthzVersionService;
  let upService: AuthzVersionService;

  beforeAll(async () => {
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    downService = new AuthzVersionService(systemPrisma, DEAD_REDIS);
    upService = new AuthzVersionService(systemPrisma, REDIS_URL);
    await upService.ready();
  });

  afterAll(async () => {
    await downService.onModuleDestroy();
    await upService.onModuleDestroy();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  const version = async () =>
    (await systemPrisma.user.findUniqueOrThrow({ where: { id: fx.userId }, select: { authzVersion: true } })).authzVersion as number;

  it('Redis down: the current version is read from the database', async () => {
    expect(await downService.current(fx.userId)).toBe(await version());
  });

  it('Redis down: a bump still reaches the database, and a stale token is refused while a current one passes', async () => {
    const before = await version();
    await downService.bumpUsers([fx.userId]); // the Redis write fails; the database is the source of truth
    const after = await version();
    expect(after).toBe(before + 1);
    const guard = new SessionVersionGuard(downService);
    await expect(guard.canActivate(ctx({ sub: fx.userId, av: before }))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(ctx({ sub: fx.userId, av: after }))).resolves.toBe(true);
  });

  it('never fails open: with Redis AND the database unreachable, the check throws instead of allowing', async () => {
    const deadDb = createSystemPrismaClient('postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1');
    const broken = new AuthzVersionService(deadDb, DEAD_REDIS);
    try {
      const guard = new SessionVersionGuard(broken);
      await expect(guard.canActivate(ctx({ sub: fx.userId, av: await version() }))).rejects.toThrow();
    } finally {
      await broken.onModuleDestroy();
      await deadDb.$disconnect();
    }
  });

  it('a failed cache write after the bump deletes the key, so the old token is refused at once (not after the TTL)', async () => {
    const before = await version();
    // The cache holds the current (soon to be old) version.
    expect(await upService.current(fx.userId)).toBe(before);
    // Redis is reachable, but the write of the new value fails once.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redis = (upService as any).redis;
    expect(await redis.get(`authz:v:${fx.userId}`)).toBe(String(before)); // precondition: the old value is cached
    const realEval = redis.eval.bind(redis);
    redis.eval = () => Promise.reject(new Error('simulated cache write failure'));
    try {
      await upService.bumpUsers([fx.userId]);
    } finally {
      redis.eval = realEval;
    }
    const after = await version();
    expect(after).toBe(before + 1);
    expect(await redis.get(`authz:v:${fx.userId}`)).toBeNull(); // deleted, not left stale
    const guard = new SessionVersionGuard(upService);
    await expect(guard.canActivate(ctx({ sub: fx.userId, av: before }))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(ctx({ sub: fx.userId, av: after }))).resolves.toBe(true);
  });

  it('cost per request: one Redis GET on a cache hit (measured)', async () => {
    const guard = new SessionVersionGuard(upService);
    const user = { sub: fx.userId, av: await version() };
    await guard.canActivate(ctx(user)); // warm the cache and the connection
    const n = 500;
    const start = process.hrtime.bigint();
    for (let i = 0; i < n; i++) await guard.canActivate(ctx(user));
    const avgMs = Number(process.hrtime.bigint() - start) / 1e6 / n;
    console.log(`[authz-version] SessionVersionGuard cache hit: ${avgMs.toFixed(3)} ms per request (n=${n})`);
    expect(avgMs).toBeLessThan(5);
  });
});
