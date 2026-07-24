/**
 * Phase 6 commit 4: portal rate limits proven over REAL HTTP (the standing
 * rule from CLAUDE.md's Phase 6 commit 2 decisions — a direct
 * service/controller-method call never touches `ThrottlerGuard` at all, so
 * only a through-the-wire supertest request can prove throttling actually
 * fires). Two independent named buckets, registered in AppModule's single
 * `ThrottlerModule.forRoot` (see DefaultThrottlerGuard's doc comment for
 * why there is exactly one such call, not one per module) but never
 * registered as an `APP_GUARD` themselves — see portal-auth.module.ts:
 *
 *   - `portal-auth` (`PortalAuthThrottlerGuard`): 5 requests / 5 minutes,
 *     tracked by `req.ip`.
 *   - `portal-read` (`PortalReadThrottlerGuard`): 60 requests / minute,
 *     tracked by the authenticated user's JWT `sub`, falling back to IP
 *     only when unauthenticated.
 *
 * Each bucket gets its OWN app instance / `beforeAll` (rather than one
 * shared app for the whole file, as `e2e-portal.test.ts` uses) — kept even
 * after Phase 8 moved storage to Redis (see RedisThrottlerStorage), since
 * the two tests below would otherwise cross-contaminate each other's
 * budget regardless of storage backend: e.g. the two logins the
 * portal-read test needs would themselves count against the portal-auth
 * bucket a preceding test had already exhausted down to 429.
 * THROTTLE_TEST_KEY_PREFIX (below) additionally isolates this whole
 * file's Redis keys from every OTHER e2e file that touches the same
 * IP-keyed portal-auth bucket.
 *
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM + Redis, and a
 * fresh `pnpm --filter @openestate/api build` (see e2e-portal.test.ts's
 * doc comment for why the compiled dist/ is required, not source — esbuild
 * transform doesn't emit correct decorator metadata for DI).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import Redis from 'ioredis';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from 'argon2';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { makeClients, seedCompany, makePortalRole, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

const CUSTOMER_PASSWORD = 'CustomerPass123';

// Redis-backed ThrottlerStorage (Phase 8) is real, shared, external state —
// unlike the in-memory default it replaced, this file no longer gets free
// isolation from OTHER e2e files (e2e-portal, e2e-broker-portal,
// portal-csrf-guard) that ALSO log in through the portal-auth-guarded
// route and can run concurrently under vitest's forked pool. Those other
// files don't assert exact hit counts so sharing the default namespace is
// harmless for them — but THIS file's portal-auth test deliberately drives
// the bucket to its exact 5-then-429 boundary, which a single stray
// concurrent login from another file would throw off. A private key
// prefix, unique per test-file PROCESS (vitest's fork pool gives each
// concurrently-active worker its own PID), gives this file's portal-auth
// assertions their own Redis keyspace without touching production
// behavior at all (RedisThrottlerStorage defaults this to '' — see its
// own doc comment).
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-portal-throttle-${process.pid}-${Date.now()}-`;

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

// Phase 8: RedisThrottlerStorage made the portal-auth bucket REAL shared
// state (previously @nestjs/throttler's in-memory default meant each
// describe block's own fresh app instance was automatically isolated —
// that free isolation is gone now). THROTTLE_TEST_KEY_PREFIX (set above,
// once per test-file process) already gives this file's own keys a
// private namespace other e2e files never touch — this clear is a second,
// cheap layer of defense (a crashed prior run reusing the exact same
// pid+timestamp prefix is astronomically unlikely, but a within-file
// describe-block-to-describe-block reset is still exactly what's needed
// so this file's OWN two describe blocks don't contaminate each other).
async function clearPortalAuthThrottleState(): Promise<void> {
  const redis = new Redis(process.env.REDIS_TEST_URL ?? 'redis://localhost:6380');
  const staleKeys = await redis.keys(`${process.env.THROTTLE_TEST_KEY_PREFIX}throttle:portal-auth:*`);
  if (staleKeys.length) await redis.del(...staleKeys);
  await redis.quit();
}

describeIf('Phase 6 commit 4: portal-auth throttle bucket over real HTTP', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await clearPortalAuthThrottleState();
    app = await bootstrapApp();
  });

  afterAll(async () => {
    await app?.close();
    await clearPortalAuthThrottleState();
  });

  it('the 6th login attempt within 5 minutes from the same IP returns 429; the first 5 do not', async () => {
    // A non-existent identifier so PortalAuthService.login() throws
    // UnauthorizedException(401) WITHOUT touching any account's
    // failedLoginAttempts/lockedUntil — isolates the throttle guard's own
    // behaviour from the separate account-lockout mechanism, which also
    // lives on this same route and would otherwise confound the count.
    const attempt = () =>
      request(app.getHttpServer()).post('/api/v1/portal/auth/login').send({ identifier: 'no-such-identifier', password: 'whatever' });

    for (let i = 0; i < 5; i++) {
      const res = await attempt();
      expect(res.status).toBe(401);
    }
    const sixth = await attempt();
    expect(sixth.status).toBe(429);
  });
});

describeIf('Phase 6 commit 4: portal-read throttle bucket over real HTTP', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let phoneX: string;
  let phoneY: string;

  beforeAll(async () => {
    app = await bootstrapApp();

    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    const customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    const customerPermIds = ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]
      .map((key) => permByKey.get(key))
      .filter((id): id is string => !!id);
    await systemPrisma.rolePermission.createMany({
      data: customerPermIds.map((permissionId) => ({ roleId: customerRoleId, permissionId })),
    });

    // NOT makeApplicant() — its phone counter (appSeq) resets to 0 per
    // forked test-file process, so two e2e files run concurrently by the
    // default `pnpm test` invocation can generate the IDENTICAL phone
    // number for their first applicant. PortalAuthService.login()'s
    // identifier lookup is deliberately company-unscoped (phone/email
    // must be globally unique across the whole install, CLAUDE.md Phase 6
    // commit 1) — a collision there can resolve to a DIFFERENT test
    // file's user entirely, which can then vanish mid-test when that
    // file's own afterAll cleanup runs (observed as a flaky "no record
    // found" 500, only when run alongside other e2e files, never in
    // isolation). High-entropy phone numbers here sidestep the collision
    // without touching the shared harness helper other tests rely on.
    const uniquePhone = () => `9${Date.now()}${Math.floor(Math.random() * 10_000)}`.slice(0, 15);
    phoneX = uniquePhone();
    phoneY = uniquePhone();
    const applicantXId = (await systemPrisma.applicant.create({
      data: { companyId: fx.companyId, name: 'Throttle Test X', primaryPhone: phoneX, primaryPhoneNormalized: phoneX },
    })).id as string;
    const applicantYId = (await systemPrisma.applicant.create({
      data: { companyId: fx.companyId, name: 'Throttle Test Y', primaryPhone: phoneY, primaryPhoneNormalized: phoneY },
    })).id as string;

    for (const [applId, phone, name] of [
      [applicantXId, phoneX, 'Throttle Test X'],
      [applicantYId, phoneY, 'Throttle Test Y'],
    ] as const) {
      await systemPrisma.user.create({
        data: {
          companyId: fx.companyId,
          applicantId: applId,
          phone,
          name,
          passwordHash: await argon2.hash(CUSTOMER_PASSWORD, { type: argon2.argon2id }),
          roleId: customerRoleId,
          forcePasswordChange: false,
        },
      });
    }
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  it(
    "is keyed by the authenticated user's sub, not IP: exhausting one user's 60-per-minute budget leaves a second user on the SAME loopback IP unaffected",
    async () => {
      const loginX = await request(app.getHttpServer())
        .post('/api/v1/portal/auth/login')
        .send({ identifier: phoneX, password: CUSTOMER_PASSWORD })
        .expect(200);
      const tokenX = loginX.body.accessToken as string;

      // Exhaust X's entire portal-read budget (60/minute) against a
      // class-guarded portal-read route (GET /portal/profile).
      for (let i = 0; i < 60; i++) {
        const res = await request(app.getHttpServer()).get('/api/v1/portal/profile').set('Authorization', `Bearer ${tokenX}`);
        expect(res.status).toBe(200);
      }
      const overBudget = await request(app.getHttpServer()).get('/api/v1/portal/profile').set('Authorization', `Bearer ${tokenX}`);
      expect(overBudget.status).toBe(429);

      // A DIFFERENT portal user — supertest always dials the same loopback
      // address, so this proves the bucket key is the JWT sub, not the IP:
      // if it were IP-keyed, this request would also 429.
      const loginY = await request(app.getHttpServer())
        .post('/api/v1/portal/auth/login')
        .send({ identifier: phoneY, password: CUSTOMER_PASSWORD })
        .expect(200);
      const tokenY = loginY.body.accessToken as string;
      const stillOk = await request(app.getHttpServer()).get('/api/v1/portal/profile').set('Authorization', `Bearer ${tokenY}`);
      expect(stillOk.status).toBe(200);
    },
    30_000,
  );
});

describeIf('Phase 8: throttle state survives a fresh app instance (Redis-backed, not in-memory)', () => {
  // Two INDEPENDENT app instances, each its own NestFactory.create() call —
  // each constructs its own `new RedisThrottlerStorage()` (app.module.ts's
  // ThrottlerModule.forRoot's `storage` option is a plain value, not a
  // DI-shared singleton), simulating two replicas/a restart. With the old
  // in-memory default this test would fail: a fresh app means a fresh,
  // empty Map, and the 6th request against appB would see 0 prior hits and
  // return 200, not 429. It only passes because both instances point at
  // the SAME Redis (REDIS_TEST_URL) and RedisThrottlerStorage's key space
  // (`throttle:${throttlerName}:${key}`) is keyed by tracker value alone,
  // not by which process wrote it.
  let appA: INestApplication;
  let appB: INestApplication;

  beforeAll(async () => {
    await clearPortalAuthThrottleState();
  });

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await clearPortalAuthThrottleState();
  });

  it('5 requests against instance A, then the 6th against a BRAND NEW instance B is already 429', async () => {
    appA = await bootstrapApp();

    const attemptA = () =>
      request(appA.getHttpServer()).post('/api/v1/portal/auth/login').send({ identifier: 'no-such-identifier-redis-persistence', password: 'x' });
    for (let i = 0; i < 5; i++) {
      const res = await attemptA();
      expect(res.status).toBe(401);
    }
    await appA.close();

    appB = await bootstrapApp();
    const sixthOnB = await request(appB.getHttpServer())
      .post('/api/v1/portal/auth/login')
      .send({ identifier: 'no-such-identifier-redis-persistence', password: 'x' });
    expect(sixthOnB.status).toBe(429);
  });
});
