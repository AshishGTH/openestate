/**
 * Staff-route surface sweep (SF-01 family, proof for piece 1).
 *
 * Property under test: a PORTAL session (broker or customer) must never get
 * anything but 401/403 from a STAFF route. NestJS runs guards before pipes
 * and handlers, so ANY other status (200/201/400/404/409/500) means the
 * request passed authorization and reached the handler — a boundary failure.
 * A 400 is a failure, not a pass.
 *
 * Both portal roles here hold EVERY permission on purpose: then the only
 * thing that can return 401/403 is the surface boundary, never a missing
 * permission. If the boundary holds against an all-permissions portal token,
 * it holds against any portal token whatever an admin ticks in the Roles
 * screen. The route list is read from the running app (ModulesContainer), so
 * a staff route added later is covered without editing this file.
 *
 * EXPECTED TODAY (no surface guard yet): RED — every GET staff route the
 * token reaches returns non-401/403. Write routes may already answer 403 via
 * CSRF (no staff CSRF cookie is sent), so the GET routes carry the
 * demonstration. After piece 1 lands, this file must be GREEN.
 *
 * Same bootstrap/fixtures as e2e-portal-token-boundary.test.ts; local test
 * containers only; needs the compiled dist/.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory, ModulesContainer } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS } from '@openestate/shared';
import {
  makeClients,
  seedCompany,
  makeApplicant,
  makeBroker,
  makePortalRole,
  cleanupCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

// Source of truth: apps/api/src/auth/csrf-cookie-names.ts
const PORTAL_PATH_PREFIX = '/api/v1/portal/';
// Source of truth: apps/api/src/auth/guards/jwt-auth.guard.ts
const IS_PUBLIC_KEY = 'isPublic';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-staff-route-sweep-${process.pid}-${Date.now()}-`;

const PORTAL_PASSWORD = 'PortalPass123';

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface SweptRoute {
  method: HttpMethod;
  registeredPath: string; // with :params, for display
  requestPath: string;    // params substituted, for the actual call
}

const METHOD_NAME: Record<number, HttpMethod | undefined> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

function joinPath(...parts: Array<string | undefined>): string {
  const cleaned = parts
    .filter((p): p is string => !!p)
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  return '/' + cleaned.join('/');
}

const substituteParams = (path: string): string =>
  path.replace(/:[^/]+/g, 'x').replace(/\*/g, 'x');

// Excluded from the sweep, with reasons. Each uses a credential OTHER than a
// full access token, or is unauthenticated by design, so the access-token
// surface guard (piece 1) is not what governs it. The staff-side exclusions
// for refresh/2FA are piece 2's job. Printed at runtime for review.
const EXCLUSIONS: Array<{ re: RegExp; why: string }> = [
  { re: /^\/api\/v1\/health(\/|$)/, why: 'health check, unauthenticated by design' },
  { re: /^\/api\/v1\/auth\/login$/, why: 'staff login accepts unauthenticated requests' },
  { re: /^\/api\/v1\/auth\/refresh$/, why: 'refresh uses the refresh cookie, not an access token (staff-side check is piece 2)' },
  { re: /^\/api\/v1\/auth\/totp\/verify$/, why: '2FA-at-login uses a pending token, not a full session (staff-side check is piece 2)' },
];

function decodeJwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function enumerateStaffRoutes(app: INestApplication): {
  staff: SweptRoute[];
  excluded: Array<{ method: string; path: string; why: string }>;
  publicSkipped: Array<{ method: string; path: string }>;
  portalSkipped: number;
} {
  const modulesContainer = app.get(ModulesContainer);
  const seen = new Set<string>();
  const staff: SweptRoute[] = [];
  const excluded: Array<{ method: string; path: string; why: string }> = [];
  const publicSkipped: Array<{ method: string; path: string }> = [];
  let portalSkipped = 0;

  for (const moduleRef of modulesContainer.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const metatype = wrapper.metatype as (new (...args: any[]) => any) | undefined;
      if (!metatype || !metatype.prototype) continue;

      const ctrlPathMeta = Reflect.getMetadata(PATH_METADATA, metatype) as string | string[] | undefined;
      const ctrlPaths = Array.isArray(ctrlPathMeta) ? ctrlPathMeta : [ctrlPathMeta ?? ''];
      const ctrlPublic = Reflect.getMetadata(IS_PUBLIC_KEY, metatype) === true;

      const proto = metatype.prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = proto[name];
        if (typeof handler !== 'function') continue;

        const methodMeta = Reflect.getMetadata(METHOD_METADATA, handler);
        if (methodMeta === undefined) continue; // not a route handler
        const method = METHOD_NAME[methodMeta as number];
        if (!method) continue; // skip ALL/OPTIONS/HEAD/etc.

        const methodPathMeta = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        const methodPaths = Array.isArray(methodPathMeta) ? methodPathMeta : [methodPathMeta ?? ''];
        const isPublic = ctrlPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;

        for (const cp of ctrlPaths) {
          for (const mp of methodPaths) {
            const registeredPath = joinPath('api/v1', cp, mp);
            const key = `${method} ${registeredPath}`;
            if (seen.has(key)) continue;
            seen.add(key);

            if (registeredPath.startsWith(PORTAL_PATH_PREFIX)) {
              portalSkipped++;
              continue;
            }
            if (isPublic) {
              publicSkipped.push({ method, path: registeredPath });
              continue;
            }
            const ex = EXCLUSIONS.find((e) => e.re.test(registeredPath));
            if (ex) {
              excluded.push({ method, path: registeredPath, why: ex.why });
              continue;
            }
            staff.push({ method, registeredPath, requestPath: substituteParams(registeredPath) });
          }
        }
      }
    }
  }
  return { staff, excluded, publicSkipped, portalSkipped };
}

describeIf('Staff-route surface sweep: no portal session may reach a staff route', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let brokerToken: string;
  let customerToken: string;
  let routes: SweptRoute[];

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
    const grantAll = (roleId: string) =>
      systemPrisma.rolePermission.createMany({
        data: allPerms.map((p: { id: string }) => ({ roleId, permissionId: p.id })),
        skipDuplicates: true,
      });

    const tag = Date.now();

    // Broker portal user, role holding every permission.
    const brokerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'broker');
    await grantAll(brokerRoleId);
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    const broker = await systemPrisma.broker.findUniqueOrThrow({ where: { id: brokerId } });
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        brokerId,
        phone: broker.phone,
        name: broker.name,
        passwordHash: await argon2.hash(PORTAL_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        roleId: brokerRoleId,
        forcePasswordChange: false,
      },
    });

    // Customer portal user, role holding every permission.
    const customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    await grantAll(customerRoleId);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const customerPhone = String(9000000000 + (tag % 1000000000));
    const customerEmail = `e2e-sweep-customer-${tag}@example.invalid`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        applicantId,
        phone: customerPhone,
        email: customerEmail,
        name: 'E2E Sweep Customer',
        passwordHash: await argon2.hash(PORTAL_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        roleId: customerRoleId,
        forcePasswordChange: false,
      },
    });

    const brokerRes = await request(app.getHttpServer())
      .post('/api/v1/portal/auth/login')
      .send({ identifier: broker.phone, password: PORTAL_PASSWORD })
      .expect(200);
    brokerToken = brokerRes.body.accessToken as string;

    const customerRes = await request(app.getHttpServer())
      .post('/api/v1/portal/auth/login')
      .send({ identifier: customerPhone, password: PORTAL_PASSWORD })
      .expect(200);
    customerToken = customerRes.body.accessToken as string;

    // Positive control: prove both tokens are real portal sessions by their
    // claims, so a blanket 401 later can't be a broken-token false green.
    expect(decodeJwtClaims(brokerToken).brokerId, 'broker token carries brokerId').toBeTruthy();
    expect(decodeJwtClaims(customerToken).applicantId, 'customer token carries applicantId').toBeTruthy();

    const enumerated = enumerateStaffRoutes(app);
    routes = enumerated.staff;

    // Enumeration sanity: if this is near zero, the route walk failed and a
    // green result would be meaningless. Fail loud instead.
    if (routes.length < 20) {
      throw new Error(`Route enumeration likely failed: only ${routes.length} staff routes found`);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[sweep] asserting ${routes.length} staff routes | ` +
        `portal skipped ${enumerated.portalSkipped} | @Public() skipped ${enumerated.publicSkipped.length} | ` +
        `explicitly excluded ${enumerated.excluded.length}`,
    );
    // eslint-disable-next-line no-console
    console.log('[sweep] @Public() routes skipped:');
    for (const p of enumerated.publicSkipped) console.log(`    ${p.method.toUpperCase()} ${p.path}`);
    // eslint-disable-next-line no-console
    console.log('[sweep] explicitly excluded:');
    for (const e of enumerated.excluded) console.log(`    ${e.method.toUpperCase()} ${e.path} — ${e.why}`);
    // eslint-disable-next-line no-console
    console.log('[sweep] staff routes asserted:');
    for (const r of routes) console.log(`    ${r.method.toUpperCase()} ${r.registeredPath}`);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    if (fx) await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma?.$disconnect();
  });

  async function sweep(token: string): Promise<{
    leaks: Array<{ method: string; path: string; status: number }>;
    throttled: Array<{ method: string; path: string }>;
  }> {
    const leaks: Array<{ method: string; path: string; status: number }> = [];
    const throttled: Array<{ method: string; path: string }> = [];
    for (const r of routes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let req: any = request(app.getHttpServer())[r.method](r.requestPath).set('Authorization', `Bearer ${token}`);
      if (r.method !== 'get') req = req.send({});
      const res = await req;
      if (res.status === 429) {
        throttled.push({ method: r.method.toUpperCase(), path: r.registeredPath });
      } else if (res.status !== 401 && res.status !== 403) {
        leaks.push({ method: r.method.toUpperCase(), path: r.registeredPath, status: res.status });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { leaks, throttled };
  }

  function assertClean(
    who: string,
    result: { leaks: Array<{ method: string; path: string; status: number }>; throttled: Array<{ method: string; path: string }> },
  ): void {
    // Throttling makes the run inconclusive — never read a 429 as either a
    // leak or a pass. Surface it so we fix the harness, not the reading.
    expect(
      result.throttled,
      `sweep inconclusive: ${result.throttled.length} routes returned 429 (throttled). Raise the test throttle limit or slow the sweep.`,
    ).toEqual([]);

    const msg = result.leaks.length
      ? `${result.leaks.length} of ${routes.length} staff routes admitted a ${who} portal token:\n` +
        result.leaks.map((l) => `  ${l.method} ${l.path} -> ${l.status}`).join('\n')
      : '';
    expect(result.leaks, msg).toEqual([]);
  }

  it('a broker portal token (all permissions) is refused by every staff route', async () => {
    assertClean('broker', await sweep(brokerToken));
  }, 180_000);

  it('a customer portal token (all permissions) is refused by every staff route', async () => {
    assertClean('customer', await sweep(customerToken));
  }, 180_000);
});
