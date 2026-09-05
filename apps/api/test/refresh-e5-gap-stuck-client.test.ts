/**
 * Regression guard for the split-window grace design (replay band +
 * healing band + full revocation).
 *
 * Background: E5-as-first-shipped treated every presentation of a
 * just-revoked token as a concurrent-burst loser — kind 'replayed',
 * access token only, no new cookie. That is correct for a burst of N
 * concurrent refreshes on one cookie whose winner's Set-Cookie will
 * reach the browser via a sibling response. It is silently wrong for
 * a genuinely stuck client whose winner's response never landed (e.g.
 * mid-navigation abort before the browser committed the winner's
 * Set-Cookie header): every subsequent presentation the stuck client
 * fires is a REPLAY carrying no new cookie, and past reuseGraceMs the
 * family is revoked and the user is logged out. See CLAUDE.md's
 * "E5 gap — split the grace window" Decisions entry for the full
 * account and the CHANGELOG security callout for the shape change
 * this exposes.
 *
 * These tests encode the HEALED behaviour, not the broken one:
 *   [0, replayWindowMs]                       -> REPLAY  (kind 'replayed', no cookie)
 *   (replayWindowMs, reuseGraceMs]            -> HEAL    (kind 'rotated', new cookie)
 *   (reuseGraceMs, ∞)                         -> revoke family, null
 *
 * The regression test that covers concurrent-burst replay behaviour
 * (invariants 1-5 across N × K bursts on both endpoints) lives in
 * refresh-concurrent-rotation.test.ts; those bursts fire within
 * milliseconds of each other and stay firmly in the replay band, so
 * that file's assertions are unchanged by the split. This file
 * complements it by driving the SLOW cases the fast-burst test can
 * never reach — sleep-driven, deterministic, one call at a time.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createSystemPrismaClient } from '@openestate/db';
import { TokenService } from '../src/auth/token.service';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = SYSTEM_URL ? describe : describe.skip;

describeIf('rotateRefreshToken — split-window grace (replay / heal / revoke)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let companyId: string;
  let userId: string;

  const makeService = (graceSeconds: number, replayWindowMs: number) =>
    new TokenService(
      new JwtService({ secret: 'test-secret-0123456789' }),
      {
        getOrThrow: () => 'test-refresh-secret-0123456789',
        get: (key: string) => {
          if (key === 'REFRESH_REUSE_GRACE_SECONDS') return String(graceSeconds);
          if (key === 'REFRESH_REPLAY_WINDOW_MS') return String(replayWindowMs);
          return undefined;
        },
      } as unknown as ConfigService,
      prisma,
    );

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!);
    const tag = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const company = await prisma.company.create({
      data: { name: `SplitGrace ${tag}`, slug: `split-grace-${tag}` },
    });
    companyId = company.id;
    const role = await prisma.role.create({
      data: { companyId, name: 'Admin', slug: `admin-${tag}`, isSystem: false },
    });
    const user = await prisma.user.create({
      data: {
        companyId,
        email: `split-grace-${tag}@test.com`,
        passwordHash: 'x',
        name: 'Split Grace User',
        roleId: role.id,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { companyId } });
    await prisma.role.deleteMany({ where: { companyId } });
    // Under a full-suite run, syncLeadStages' unscoped scan can seed
    // this fixture's company between the user delete above and the
    // company delete below — matches the pattern documented in the
    // Phase 0 follow-up decisions log entry.
    await prisma.leadStage.deleteMany({ where: { companyId } });
    await prisma.companyConfig.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
    await prisma.$disconnect();
  });

  /**
   * Family lookup helper — the shared beforeAll user accumulates live
   * tokens across tests, so every count assertion in this file scopes
   * by family to stay isolated from sibling tests.
   */
  async function familyOfLatestLiveToken(): Promise<string> {
    const seed = await prisma.refreshToken.findFirst({
      where: { userId, isRevoked: false },
      orderBy: { createdAt: 'desc' },
    });
    if (!seed) throw new Error('no live token found for shared fixture user');
    return seed.family;
  }

  it('REPLAY band: presenting T0 within replayWindowMs returns kind "replayed" with no newRaw', async () => {
    // Large replay window (30s) so wall-clock jitter between the
    // winner rotation and the replay presentations cannot push a call
    // out of the band accidentally. The assertion is about semantics
    // (a fast replay returns 'replayed'), not about the boundary
    // sharpness itself, which the healing-band test below decides.
    const svc = makeService(60, 30_000);
    const { raw: t0 } = await svc.createRefreshToken(userId);
    const family = await familyOfLatestLiveToken();

    const winner = await svc.rotateRefreshToken(t0);
    if (winner?.kind !== 'rotated') {
      throw new Error(
        `expected rotated on winner; got ${JSON.stringify(winner)}`,
      );
    }
    // Discard winner.newRaw — model the burst where sibling responses
    // in the same navigation will land the cookie, but for the purpose
    // of testing REPLAY-band semantics only what matters is that we
    // re-present T0 without moving forward in the client's jar.

    for (let i = 1; i <= 6; i++) {
      const r = await svc.rotateRefreshToken(t0);
      expect(r, `replay #${i} must not be null inside replay window`).not.toBeNull();
      expect(r!.kind).toBe('replayed');
      // Discriminated shape: 'replayed' carries no newRaw or expiresAt.
      // A runtime check catches any accidental widening.
      expect((r as { newRaw?: string }).newRaw).toBeUndefined();
      expect((r as { expiresAt?: Date }).expiresAt).toBeUndefined();
      expect(r!.userId).toBe(userId);
    }

    // No new rows were created on any replay. Family stays at exactly
    // one revoked ancestor + one live successor.
    const rows = await prisma.refreshToken.findMany({
      where: { family },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].isRevoked).toBe(true);
    expect(rows[1].isRevoked).toBe(false);
  });

  it('HEAL band: presenting T0 past replayWindowMs but within reuseGraceMs returns kind "rotated" with a fresh raw', async () => {
    // 500ms replay window, 30s reuse grace. Sleep 700ms between
    // rotation and re-presentation to land firmly in the healing band.
    const svc = makeService(30, 500);
    const { raw: t0 } = await svc.createRefreshToken(userId);
    const family = await familyOfLatestLiveToken();

    // Winner rotates T0 → T1. Discard T1 to model the aborted-response
    // stuck-client case.
    const winner = await svc.rotateRefreshToken(t0);
    if (winner?.kind !== 'rotated') {
      throw new Error(
        `expected rotated on winner; got ${JSON.stringify(winner)}`,
      );
    }

    // Sleep past the replay window, well inside the reuse grace.
    await new Promise((resolve) => setTimeout(resolve, 700));

    // HEAL: the stuck client re-presents T0. Server sees T0 revoked,
    // past replay window, within reuse grace, live successor exists →
    // rotates the successor and hands the caller a fresh cookie.
    const healed = await svc.rotateRefreshToken(t0);
    if (healed?.kind !== 'rotated') {
      throw new Error(
        `HEAL band must return kind 'rotated' with newRaw; got ${JSON.stringify(healed)}`,
      );
    }
    expect(healed.userId).toBe(userId);
    expect(typeof healed.newRaw).toBe('string');
    expect(healed.newRaw.length).toBeGreaterThan(0);
    expect(healed.expiresAt).toBeInstanceOf(Date);

    // Family now has three rows in this family: T0 (revoked), T1
    // (revoked by the heal), T2 (live, from the heal).
    const rows = await prisma.refreshToken.findMany({
      where: { family },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(3);
    expect(rows[0].isRevoked).toBe(true);
    expect(rows[1].isRevoked).toBe(true);
    expect(rows[2].isRevoked).toBe(false);

    // End-to-end self-heal: the client now holds the healed token
    // (T2 = healed.newRaw). Prove it can complete a further normal
    // rotation with it. This is the "cookie the client got is
    // usable" assertion the E5-only design could not satisfy for a
    // stuck client — the whole point of the split-window fix.
    const nextRotation = await svc.rotateRefreshToken(healed.newRaw);
    if (nextRotation?.kind !== 'rotated') {
      throw new Error(
        `healed cookie must be usable for a further rotation; got ${JSON.stringify(nextRotation)}`,
      );
    }
    expect(nextRotation.userId).toBe(userId);
    expect(nextRotation.newRaw).not.toBe(healed.newRaw);

    // Family has grown by one more successor (T3), old T2 now revoked.
    const rowsAfter = await prisma.refreshToken.findMany({
      where: { family },
      orderBy: { createdAt: 'asc' },
    });
    expect(rowsAfter).toHaveLength(4);
    const liveCount = rowsAfter.filter((r: { isRevoked: boolean }) => !r.isRevoked).length;
    expect(liveCount).toBe(1);
    expect(rowsAfter[rowsAfter.length - 1].isRevoked).toBe(false);
  });

  it('REVOKE past grace: presenting T0 past reuseGraceMs returns null and revokes the whole family', async () => {
    // 500ms replay window, 500ms reuse grace. Sleep 700ms to land
    // past reuseGraceMs.
    const svc = makeService(0.5, 500);
    const { raw: t0 } = await svc.createRefreshToken(userId);
    const family = await familyOfLatestLiveToken();

    const winner = await svc.rotateRefreshToken(t0);
    if (winner?.kind !== 'rotated') {
      throw new Error(
        `expected rotated on winner; got ${JSON.stringify(winner)}`,
      );
    }

    // Verify T1 (winner's successor) is live before the sleep.
    const beforeSleep = await prisma.refreshToken.count({
      where: { family, isRevoked: false },
    });
    expect(beforeSleep).toBe(1);

    // Sleep past the reuse-grace ceiling.
    await new Promise((resolve) => setTimeout(resolve, 700));

    // Genuine reuse territory — return null, revoke the whole family.
    // This IS the theft-detection signal; unchanged from the E5-only
    // design and from every rotation-with-reuse-detection scheme
    // before it.
    const afterGrace = await svc.rotateRefreshToken(t0);
    expect(afterGrace).toBeNull();

    const liveInFamily = await prisma.refreshToken.count({
      where: { family, isRevoked: false },
    });
    expect(liveInFamily).toBe(0);
  });

});
