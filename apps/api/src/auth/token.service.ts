import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import type { JwtPayload } from '@openestate/shared';

/**
 * Discriminated result of a refresh-token rotation attempt.
 *
 * `rotated` — this caller was the SOLE OR WINNING presenter of the
 * refresh token: it consumed the ancestor row and produced a fresh
 * successor. Controller MUST set a new refresh cookie with `newRaw`
 * and rotate the CSRF cookie.
 *
 * `replayed` — this caller lost the race (was concurrent with another
 * presentation of the same token, waited on the FOR UPDATE lock, and
 * arrived to find the token already consumed within the reuse-grace
 * window with a live successor). No new refresh cookie is issued —
 * the client's cookie jar already carries (or will carry, from the
 * winner's response) the correct successor. Controller MUST NOT touch
 * cookies; it should only mint and return an access token from
 * `userId`.
 *
 * Under E5 (see CLAUDE.md's E2E refresh-rotation cascade Decisions
 * entry): using a `null | { newRaw }` shape here would be a footgun —
 * an optional field that silently means "skip the cookie" is exactly
 * the kind of split-brain state this bug already burned twice on. The
 * discriminated union makes exhaustive-check on `kind` mandatory at
 * every call site; forgetting a branch is a TypeScript error.
 */
export type RotateRefreshTokenResult =
  | { kind: 'rotated'; userId: string; newRaw: string; expiresAt: Date }
  | { kind: 'replayed'; userId: string };

type LockedTokenRow = {
  id: string;
  user_id: string;
  family: string;
  is_revoked: boolean;
  revoked_at: Date | null;
  expires_at: Date;
};

@Injectable()
export class TokenService {
  private readonly refreshSecret: string;
  private readonly refreshExpiresIn: string;
  private readonly reuseGraceMs: number;
  private readonly replayWindowMs: number;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(SYSTEM_PRISMA) private readonly prisma: PrismaClient,
  ) {
    this.refreshSecret = this.config.getOrThrow('JWT_REFRESH_SECRET');
    this.refreshExpiresIn = this.config.get('JWT_REFRESH_EXPIRES_IN') ?? '7d';
    // Default 60s, not 30 or 120: the client-side cooldown (both apps'
    // AuthProvider — see apps/web/src/lib/api.ts's auth-cache block) is
    // meant to break the CI Playwright refresh-rotation cascade at its
    // source. If it works, the cascade never approaches this ceiling; if
    // this ceiling still fires under the fix, that proves the client fix
    // failed and widening further would just hide it. 60s is defence in
    // depth for a slightly wider real-world race (multi-tab restore,
    // flaky-network double-refresh) without weakening theft detection —
    // family revocation on genuine post-grace replay is unchanged.
    // Tunable per-install; 0 restores the strict pre-fix behaviour.
    this.reuseGraceMs =
      Number(this.config.get('REFRESH_REUSE_GRACE_SECONDS') ?? 60) * 1000;
    // The grace window is now SPLIT. Presentations of a just-revoked
    // token in [0, replayWindowMs] are treated as concurrent-burst
    // losers (REPLAY: no cookie, access token only — E5 semantics from
    // the prior fix). Presentations in
    // (replayWindowMs, reuseGraceMs] are treated as a legitimate
    // stuck client whose winner's Set-Cookie never landed (the E5 gap
    // — see refresh-e5-gap-stuck-client.test.ts): rotate the family's
    // live successor and hand the caller a fresh cookie. This is the
    // pre-E5 CHAIN behaviour, applied only in the healing band —
    // acknowledged in CHANGELOG's security callout, not a comment.
    // Default 5000ms: 3+ orders of magnitude above the observed
    // concurrent-burst fetch spread (Promise.all against a local
    // Nest server, sub-ms per the concurrent-rotation regression
    // test), and 2 orders of magnitude below the access-token TTL
    // (JWT_ACCESS_EXPIRES_IN=15m) so a stuck client's next scheduled
    // refresh lands well outside the replay band. Tunable per-install
    // via REFRESH_REPLAY_WINDOW_MS.
    this.replayWindowMs = Number(
      this.config.get('REFRESH_REPLAY_WINDOW_MS') ?? 5000,
    );
  }

  signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
    return this.jwt.sign(payload);
  }

  async createRefreshToken(
    userId: string,
    family?: string,
    // Phase 6: lets a caller issue a shorter-lived refresh token (portal:
    // 24h) without duplicating this method — staff callers omit it and get
    // the configured JWT_REFRESH_EXPIRES_IN as before.
    expiresInOverride?: string,
  ): Promise<{ raw: string; expiresAt: Date }> {
    const raw = randomUUID();
    const hash = this.hashToken(raw);
    const jti = randomUUID();
    const tokenFamily = family ?? randomUUID();
    const expiresAt = this.computeExpiry(expiresInOverride ?? this.refreshExpiresIn);

    await this.prisma.refreshToken.create({
      data: {
        id: jti,
        userId,
        tokenHash: hash,
        family: tokenFamily,
        expiresAt,
      },
    });

    return { raw, expiresAt };
  }

  /**
   * Single-use rotation with reuse detection, plus a short grace window for
   * the one case where re-presenting a consumed token is NOT an attack.
   *
   * The bug this grace window fixes, diagnosed from captured traffic rather
   * than guessed: a full page load fires /auth/refresh from AuthProvider's
   * mount effect. If the user navigates or reloads again before that
   * response lands, the browser ABORTS the request — but the server has
   * already processed it, consuming the token and issuing a replacement the
   * client never receives. Its cookie therefore still holds the OLD token,
   * and the next load re-presents it. Pre-fix that was read as token theft
   * and revoked the entire family, logging the user out with no
   * explanation. Reproduced with a burst of full page loads; the same thing
   * happens when a browser restores several tabs at once (each fires its own
   * refresh with the SAME cookie) or when a refresh response is simply lost.
   * The client-side refreshSession() de-dupe cannot help — it is per-tab, and
   * these are separate page contexts.
   *
   * Benign re-presentation is recognised structurally, not assumed: the
   * presented token must be revoked RECENTLY (within reuseGraceMs) AND its
   * family must still have a live token — i.e. the chain moved on normally
   * and was never revoked wholesale. The grace window is SPLIT into two
   * sub-windows so each half serves its own real case, not one policy
   * approximating both:
   *
   *   [0, replayWindowMs]                       -> REPLAY (E5)
   *     A concurrent-burst loser. The winner rotated a few ms ago; the
   *     browser's cookie jar will receive the winner's Set-Cookie via a
   *     sibling response in this same navigation. Return kind: 'replayed',
   *     no cookie, access token only. Deterministic convergence; no
   *     chain accumulation; no orphaned successors.
   *
   *   (replayWindowMs, reuseGraceMs]            -> HEAL (pre-E5 CHAIN)
   *     A stuck client whose winner's response never landed (aborted
   *     mid-navigation, so the browser never committed the Set-Cookie
   *     header). By construction under E5-only, this client is
   *     unrecoverable — every subsequent presentation of the ancestor
   *     is a REPLAY carrying no new cookie, and past reuseGraceMs the
   *     family is revoked and the user is logged out. Made observable
   *     by refresh-e5-gap-stuck-client.test.ts. In the healing band we
   *     rotate the family's live successor for the caller, mirroring
   *     the pre-E5 CHAIN behaviour so a genuinely stuck client can
   *     recover. Presented revoked token yields a fresh refresh token
   *     (not just an access token) — this is a real difference from
   *     E5-as-first-shipped, covered in CHANGELOG's security callout.
   *
   *   (reuseGraceMs, ∞)                         -> revoke family, null
   *     Genuine reuse — either theft, or a client that stayed silent
   *     long past any legitimate race window. Family revocation is the
   *     detection signal the family model exists for. Unchanged.
   *
   * Security: the healing-band change widens the window during which a
   * stolen-and-replayed token yields a session, but the shape (access
   * token AND refresh cookie) has always been what the grace window was
   * designed to permit. The narrower E5-only design (access token only in
   * the whole grace band) traded that off against the stuck-client case,
   * and that trade-off was wrong in the direction of denying real users
   * access after ordinary browser behaviour. Full family revocation for
   * genuine post-window reuse is unchanged. Tune per-install:
   * REFRESH_REPLAY_WINDOW_MS (default 5000) and REFRESH_REUSE_GRACE_SECONDS
   * (default 60). Setting REFRESH_REUSE_GRACE_SECONDS=0 restores the
   * strict pre-fix behaviour and makes the replay window irrelevant.
   */
  async rotateRefreshToken(
    rawToken: string,
    expiresInOverride?: string,
  ): Promise<RotateRefreshTokenResult | null> {
    const hash = this.hashToken(rawToken);

    // The whole function runs inside one interactive $transaction with
    // SELECT ... FOR UPDATE on the token row. Rationale: the pre-fix
    // code did findFirst → update → create as three separate
    // auto-committed statements. Two exactly-concurrent callers with
    // the same cookie could race between the winner's UPDATE (marks
    // token revoked) and INSERT (creates successor): the loser reads
    // the row as revoked-within-grace, finds NO live successor
    // (winner's INSERT hasn't committed yet), falls through to
    // revokeFamilyById + returns null → 401. Legitimate rapid-nav
    // burst → parked on /login. See CLAUDE.md's E2E refresh-rotation
    // cascade Decisions entry for the full account.
    //
    // FOR UPDATE serializes concurrent callers on this row; the
    // transaction's atomicity ensures that when the loser's lock
    // acquires, the family is in a coherent state (revoked ancestor +
    // live successor, never revoked-with-no-successor). RefreshToken
    // is NOT tenant-scoped (no companyId column, uses SYSTEM_PRISMA,
    // not in TENANT_SCOPED_MODELS) so there's no tenant SET LOCAL to
    // preserve inside the tx — the concern that a $transaction +
    // $queryRaw would lose per-query tenant context does not apply
    // here.
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedTokenRow[]>`
        SELECT id, user_id, family, is_revoked, revoked_at, expires_at
        FROM refresh_tokens
        WHERE token_hash = ${hash}
        FOR UPDATE
      `;
      if (rows.length === 0) return null;
      const existing = rows[0];

      if (existing.is_revoked) {
        const revokedAgoMs = existing.revoked_at
          ? Date.now() - existing.revoked_at.getTime()
          : Number.POSITIVE_INFINITY;

        if (revokedAgoMs <= this.reuseGraceMs) {
          if (revokedAgoMs <= this.replayWindowMs) {
            // REPLAY BAND — concurrent-burst loser (E5 semantics).
            //
            // The winner's rotation committed a few ms ago inside its
            // own transaction on this same row's lock. If a live
            // successor exists in the family, this caller is a
            // legitimate loser in the same-cookie N-way burst — hand
            // back `replayed` carrying only userId, so the controller
            // mints an access token but SKIPS the refresh/CSRF cookie
            // set. The client's cookie jar converges deterministically
            // on the winner's Set-Cookie regardless of response-arrival
            // order, and every caller in the burst returns 200 with a
            // fresh access token.
            //
            // Standard OAuth 2.0 rotation-with-reuse-detection pattern:
            // N concurrent presentations of the same token → 1 rotation
            // + N-1 replays. No new refresh_token rows for replays. No
            // orphaned successors. No cookie ambiguity.
            const live = await tx.refreshToken.findFirst({
              where: {
                family: existing.family,
                isRevoked: false,
                expiresAt: { gt: new Date() },
              },
              orderBy: { createdAt: 'desc' },
            });
            if (live) {
              return { kind: 'replayed' as const, userId: existing.user_id };
            }
            // No live successor within the replay window: fall through
            // to full family revocation. This shape shouldn't arise
            // under E5 (a burst always has a winner's successor to
            // find), but if the family was independently revoked
            // between the winner's INSERT and now, treat that as
            // genuine reuse.
          } else {
            // HEALING BAND — stuck client whose winner's cookie never
            // landed (the E5 gap made observable by
            // refresh-e5-gap-stuck-client.test.ts). Rotate the family's
            // live successor for this caller so it recovers rather
            // than being logged out at reuseGraceMs.
            //
            // Re-select the live successor FOR UPDATE inside this same
            // transaction so two concurrent stuck clients serialize on
            // the SUCCESSOR row (we already hold FOR UPDATE on the
            // ancestor row via the outer SELECT). Without this the
            // heal path would race and could create orphaned
            // successors — the exact bug class FOR UPDATE was
            // introduced to close for the winner path.
            // The ::uuid cast on the family parameter is load-bearing:
            // Prisma's tagged-template $queryRaw binds string params as
            // TEXT by default, and refresh_tokens.family is UUID —
            // Postgres refuses `uuid = text` at query-plan time
            // (error 42883). Same lesson as Phase 7 commit 2's
            // decisions entry ("any new $executeRawUnsafe/$queryRaw
            // comparing a parameter against a uuid-typed column
            // needs an explicit ::uuid cast — nothing catches this
            // at compile time, only a real query against a real
            // Postgres schema does"). Caught here by the
            // refresh-e5-gap-stuck-client HEAL band test on first
            // run before commit.
            const liveRows = await tx.$queryRaw<LockedTokenRow[]>`
              SELECT id, user_id, family, is_revoked, revoked_at, expires_at
              FROM refresh_tokens
              WHERE family = ${existing.family}::uuid
                AND is_revoked = false
                AND expires_at > NOW()
              ORDER BY created_at DESC
              LIMIT 1
              FOR UPDATE
            `;
            if (liveRows.length > 0) {
              const live = liveRows[0];
              const newRaw = randomUUID();
              const newHash = this.hashToken(newRaw);
              const newJti = randomUUID();
              const expiresAt = this.computeExpiry(
                expiresInOverride ?? this.refreshExpiresIn,
              );
              await tx.refreshToken.update({
                where: { id: live.id },
                data: { isRevoked: true, revokedAt: new Date() },
              });
              await tx.refreshToken.create({
                data: {
                  id: newJti,
                  userId: live.user_id,
                  tokenHash: newHash,
                  family: live.family,
                  expiresAt,
                },
              });
              return {
                kind: 'rotated' as const,
                userId: live.user_id,
                newRaw,
                expiresAt,
              };
            }
            // No live successor in the healing band either: family
            // has already been revoked wholesale, fall through.
          }
        }

        // Genuine reuse: past the grace window, or the family is
        // already dead. Trip full family revocation — this IS the
        // reuse-detection signal the family model exists to catch.
        await this.revokeFamilyById(existing.family);
        return null;
      }

      if (existing.expires_at < new Date()) {
        await tx.refreshToken.update({
          where: { id: existing.id },
          data: { isRevoked: true, revokedAt: new Date() },
        });
        return null;
      }

      // Winner path: rotate. UPDATE (mark revoked) + INSERT (create
      // successor) both commit atomically as part of this same tx, so
      // any serialized loser waiting on the FOR UPDATE lock finds a
      // coherent family state when its lock acquires.
      const newRaw = randomUUID();
      const newHash = this.hashToken(newRaw);
      const newJti = randomUUID();
      const expiresAt = this.computeExpiry(expiresInOverride ?? this.refreshExpiresIn);
      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { isRevoked: true, revokedAt: new Date() },
      });
      await tx.refreshToken.create({
        data: {
          id: newJti,
          userId: existing.user_id,
          tokenHash: newHash,
          family: existing.family,
          expiresAt,
        },
      });
      return { kind: 'rotated' as const, userId: existing.user_id, newRaw, expiresAt };
    });
  }

  private async revokeFamilyById(family: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { family, isRevoked: false },
      data: { isRevoked: true, revokedAt: new Date() },
    });
  }

  async revokeFamily(rawToken: string): Promise<void> {
    const hash = this.hashToken(rawToken);
    const existing = await this.prisma.refreshToken.findFirst({
      where: { tokenHash: hash },
    });
    if (existing) {
      await this.prisma.refreshToken.updateMany({
        where: { family: existing.family, isRevoked: false },
        data: { isRevoked: true, revokedAt: new Date() },
      });
    }
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, isRevoked: false },
      data: { isRevoked: true, revokedAt: new Date() },
    });
  }

  /**
   * Same as revokeAllForUser, but leaves the CALLER's own session family
   * alone — for change-password, which must not log the user themselves
   * out. exceptRawToken is the raw refresh token from the request's own
   * cookie; if it doesn't resolve to a live token (missing/expired/already
   * rotated-away), falls back to revoking everything, same as
   * revokeAllForUser — there's no "current session" to preserve.
   */
  async revokeAllForUserExceptToken(userId: string, exceptRawToken: string): Promise<void> {
    const hash = this.hashToken(exceptRawToken);
    const current = await this.prisma.refreshToken.findFirst({ where: { tokenHash: hash } });

    await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        isRevoked: false,
        ...(current ? { family: { not: current.family } } : {}),
      },
      data: { isRevoked: true, revokedAt: new Date() },
    });
  }

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private computeExpiry(duration: string): Date {
    const match = /^(\d+)([smhd])$/.exec(duration);
    if (!match) {
      return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };
    return new Date(Date.now() + value * multipliers[unit]);
  }
}
