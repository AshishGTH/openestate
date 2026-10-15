/**
 * Concurrency tests for refresh-token rotation and revocation.
 *
 * Each test forces one interleaving rather than hoping for it (CLAUDE.md:
 * "a concurrency test must force its interleaving"). Request A is paused at
 * a chosen Prisma call through a wrapped client (the wrapper reaches inside
 * $transaction too), request B is started, and the test waits until B has
 * either finished or is blocked on a lock before letting A continue. The
 * login test pauses the revoke inside its UPDATE instead, by holding a row
 * lock the UPDATE must wait for.
 *
 * Direct TokenService tests, like refresh-reuse-grace.test.ts: the property
 * under test is the rotation rule, and the through-the-wire half is the
 * Playwright concurrent-refresh checks in rapid-reload-session.spec.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { createSystemPrismaClient } from '@openestate/db';
import { TokenService } from '../src/auth/token.service';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = SYSTEM_URL ? describe : describe.skip;

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
 * A client whose refreshToken.<op> calls pause on a gate. Works for calls made
 * on the client itself and on the transaction client $transaction hands out.
 */
function pausing(base: any, pauses: Array<{ op: string; gate: Gate }>) {
  const model = (m: any) =>
    new Proxy(m, {
      get(target, op) {
        const fn = target[op];
        if (typeof fn !== 'function') return fn;
        return async (...args: unknown[]) => {
          const i = pauses.findIndex((p) => p.op === op);
          if (i !== -1) {
            const [p] = pauses.splice(i, 1);
            p.gate.onHit();
            await p.gate.released;
          }
          return fn.apply(target, args);
        };
      },
    });
  const wrap = (client: any): any =>
    new Proxy(client, {
      get(target, prop) {
        if (prop === 'refreshToken') return model(target.refreshToken);
        if (prop === '$transaction') {
          return (arg: any, opts?: any) =>
            typeof arg === 'function'
              ? target.$transaction((tx: any) => arg(wrap(tx)), opts)
              : target.$transaction(arg, opts);
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  return wrap(base);
}

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

describeIf('refresh-token rotation and revocation under concurrency', () => {
  let prisma: any;
  let observer: any;
  const companyIds: string[] = [];

  const service = (client: any, graceSeconds = 30) =>
    new TokenService(
      new JwtService({ secret: 'test-secret-0123456789' }),
      {
        getOrThrow: () => 'test-refresh-secret-0123456789',
        get: (key: string) => (key === 'REFRESH_REUSE_GRACE_SECONDS' ? String(graceSeconds) : undefined),
      } as unknown as ConfigService,
      client,
    );

  async function makeUser(label: string) {
    const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const company = await prisma.company.create({ data: { name: `Race ${label} ${tag}`, slug: `race-${label}-${tag}` } });
    companyIds.push(company.id);
    const role = await prisma.role.create({ data: { companyId: company.id, name: 'R', slug: `r-${tag}`, isSystem: false } });
    const user = await prisma.user.create({
      data: { companyId: company.id, roleId: role.id, name: 'Race user', email: `race-${tag}@test.com`, passwordHash: 'x' },
    });
    return { companyId: company.id, userId: user.id as string };
  }

  async function tokens(userId: string) {
    return prisma.refreshToken.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  /**
   * Resolves once `p` has settled, or once some backend is waiting on this
   * user's refresh-token advisory lock or on a lock held by `blockerPid`.
   */
  async function settledOrBlocked(p: Promise<unknown>, userId: string, blockerPid?: number) {
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let i = 0; i < 400; i++) {
      if (settled) return 'settled';
      const rows = await observer.$queryRawUnsafe(
        `SELECT
           (SELECT count(*) FROM pg_locks
             WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
               AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
               AND ((classid::bigint << 32) | objid::bigint) = hashtextextended('refresh:' || $1, 0))::int AS advisory,
           (SELECT count(*) FROM pg_stat_activity
             WHERE $2::int IS NOT NULL AND $2::int = ANY(pg_blocking_pids(pid)))::int AS rowwait`,
        userId,
        blockerPid ?? null,
      );
      if (rows[0].advisory > 0 || rows[0].rowwait > 0) return 'blocked';
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('neither settled nor blocked within 10 s');
  }

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!);
    observer = createSystemPrismaClient(SYSTEM_URL!);
  });

  afterAll(async () => {
    for (const companyId of companyIds) {
      await prisma.refreshToken.deleteMany({ where: { user: { companyId } } });
      await prisma.user.deleteMany({ where: { companyId } });
      await prisma.role.deleteMany({ where: { companyId } });
      await prisma.leadStage.deleteMany({ where: { companyId } });
      await prisma.companyConfig.deleteMany({ where: { companyId } });
      await prisma.company.delete({ where: { id: companyId } });
    }
    await prisma.$disconnect();
    await observer.$disconnect();
  });

  it('two refreshes with the same token both succeed when the second arrives mid-rotation', async () => {
    const { userId } = await makeUser('pair');
    const t0 = await service(prisma).createRefreshToken(userId);
    const gate = makeGate();
    const a = service(pausing(prisma, [{ op: 'create', gate }]));
    const b = service(prisma);

    const aP = a.rotateRefreshToken(t0.raw);
    await gate.hit; // A has consumed t0; its successor is not written yet
    const bP = b.rotateRefreshToken(t0.raw);
    await settledOrBlocked(bP, userId);
    gate.release();
    const [ra, rb] = await Promise.all([aP, bP]);

    expect(ra).not.toBeNull();
    expect(rb).not.toBeNull();
    // Whichever cookie the browser keeps must still lead to a session.
    const live = (await tokens(userId)).filter((t: any) => !t.isRevoked);
    expect(live.length).toBeGreaterThan(0);
  });

  it('an old token replayed outside the window while a rotation is mid-flight leaves no live token', async () => {
    const { userId } = await makeUser('theft');
    const svc = service(prisma);
    const old = await svc.createRefreshToken(userId);
    const family = (await prisma.refreshToken.findFirst({ where: { tokenHash: hash(old.raw) } })).family;
    const current = await svc.createRefreshToken(userId, family);
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hash(old.raw) },
      data: { isRevoked: true, revokedAt: new Date(Date.now() - 60_000) },
    });

    const gate = makeGate();
    const legit = service(pausing(prisma, [{ op: 'create', gate }]));
    const legitP = legit.rotateRefreshToken(current.raw);
    await gate.hit;
    const replayP = service(prisma).rotateRefreshToken(old.raw);
    await settledOrBlocked(replayP, userId);
    gate.release();
    const [, replay] = await Promise.all([legitP, replayP]);

    expect(replay).toBeNull();
    const live = (await tokens(userId)).filter((t: any) => !t.isRevoked);
    expect(live).toHaveLength(0);
  });

  it('ending every session while a rotation is mid-flight leaves no live token', async () => {
    const { userId } = await makeUser('endall');
    const t0 = await service(prisma).createRefreshToken(userId);
    const gate = makeGate();
    const a = service(pausing(prisma, [{ op: 'create', gate }]));

    const aP = a.rotateRefreshToken(t0.raw);
    await gate.hit;
    const revokeP = service(prisma).revokeAllForUser(userId);
    await settledOrBlocked(revokeP, userId);
    gate.release();
    await Promise.all([aP, revokeP]);

    const live = (await tokens(userId)).filter((t: any) => !t.isRevoked);
    expect(live).toHaveLength(0);
  });

  it('a session created while every session is being ended is either revoked or created after the end', async () => {
    const { userId } = await makeUser('login');
    const existing = await service(prisma).createRefreshToken(userId);
    const existingId = (await prisma.refreshToken.findFirst({ where: { tokenHash: hash(existing.raw) } })).id;

    // Hold a row lock on the existing token so the revoke's UPDATE stops part
    // way through, after it has taken its snapshot.
    const holder = createSystemPrismaClient(SYSTEM_URL!);
    const held = makeGate();
    let holderPid = 0;
    const lockTaken = makeGate();
    const holderTx = holder.$transaction(
      async (tx: any) => {
        holderPid = (await tx.$queryRawUnsafe('SELECT pg_backend_pid()::int AS pid'))[0].pid;
        await tx.$queryRawUnsafe('SELECT id FROM refresh_tokens WHERE id = $1::uuid FOR UPDATE', existingId);
        lockTaken.onHit();
        await held.released;
      },
      { timeout: 30_000 },
    );
    try {
      await lockTaken.hit;
      let revokeDone = false;
      const revokeP = service(prisma)
        .revokeAllForUser(userId)
        .then(() => (revokeDone = true));
      expect(await settledOrBlocked(revokeP, userId, holderPid)).toBe('blocked');

      let loginBeforeRevoke = false;
      const loginP = service(prisma)
        .createRefreshToken(userId)
        .then((r) => {
          loginBeforeRevoke = !revokeDone;
          return r;
        });
      // Login counts as blocked only on the advisory lock: the revoke is
      // already waiting on the row lock, which would satisfy a row-wait check.
      await settledOrBlocked(loginP, userId);
      held.release();
      await holderTx;
      const [, login] = await Promise.all([revokeP, loginP]);

      const row = await prisma.refreshToken.findFirst({ where: { tokenHash: hash(login.raw) } });
      // A session that finished before the revoke must not survive it.
      if (loginBeforeRevoke) expect(row.isRevoked).toBe(true);
      const old = await prisma.refreshToken.findUnique({ where: { id: existingId } });
      expect(old.isRevoked).toBe(true);
    } finally {
      held.release();
      await holderTx.catch(() => undefined);
      await holder.$disconnect();
    }
  });

  describe('isolation between users and companies', () => {
    it("re-presenting one user's consumed token never yields another user's session", async () => {
      const x = await makeUser('iso-x');
      const y = await makeUser('iso-y'); // another company
      const svc = service(prisma);
      const t1 = await svc.createRefreshToken(x.userId);
      const rotated = await svc.rotateRefreshToken(t1.raw);
      await svc.revokeFamily(rotated!.newRaw); // logout: x's family is now dead
      const yTok = await svc.createRefreshToken(y.userId);

      // t1 was consumed seconds ago, but x has no live token left.
      const r = await svc.rotateRefreshToken(t1.raw);
      expect(r).toBeNull();
      const yRow = await prisma.refreshToken.findFirst({ where: { tokenHash: hash(yTok.raw) } });
      expect(yRow.isRevoked).toBe(false);
    });

    it("theft detection and ending every session touch only that user's tokens", async () => {
      const x = await makeUser('iso-a');
      const z = await makeUser('iso-b');
      // A second user in x's own company.
      const role = await prisma.role.findFirst({ where: { companyId: x.companyId } });
      const w = await prisma.user.create({
        data: { companyId: x.companyId, roleId: role.id, name: 'W', email: `w-${Date.now()}@test.com`, passwordHash: 'x' },
      });
      const svc = service(prisma);
      const xOld = await svc.createRefreshToken(x.userId);
      const zTok = await svc.createRefreshToken(z.userId);
      const wTok = await svc.createRefreshToken(w.id);
      await svc.rotateRefreshToken(xOld.raw);
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hash(xOld.raw) },
        data: { revokedAt: new Date(Date.now() - 60_000) },
      });

      expect(await svc.rotateRefreshToken(xOld.raw)).toBeNull(); // replay outside the window
      await svc.revokeAllForUser(x.userId);

      for (const raw of [zTok.raw, wTok.raw]) {
        const row = await prisma.refreshToken.findFirst({ where: { tokenHash: hash(raw) } });
        expect(row.isRevoked).toBe(false);
      }
      expect((await tokens(x.userId)).every((t: any) => t.isRevoked)).toBe(true);
    });
  });
});
