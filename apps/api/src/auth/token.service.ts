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
   * and was never revoked wholesale. We then rotate that live token and hand
   * the caller the result, so the client converges on a valid cookie. Every
   * concurrent load in a burst therefore succeeds, and out-of-order
   * responses self-heal: whichever cookie the client ends up with is either
   * live or recently-consumed, and both paths lead back here.
   *
   * Security: a token replayed after the window, or after the family was
   * revoked, still triggers full family revocation exactly as before. The
   * accepted trade-off (standard for rotation-with-grace) is that a token
   * stolen AND replayed inside the window yields a session — a few seconds
   * of exposure, against the alternative of logging real users out for
   * ordinary browser behaviour. Tune or disable with
   * REFRESH_REUSE_GRACE_SECONDS (0 restores the strict pre-fix behaviour).
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
          // REPLAY path (E5): the winner's rotation already committed
          // inside its own transaction on this same row's lock. If
          // there's a live successor in the family, this caller is a
          // legitimate concurrent presenter of the same-cookie burst —
          // hand back a `replayed` result carrying only the userId, so
          // the controller mints an access token but SKIPS the refresh/
          // CSRF cookie set. The client's cookie jar converges
          // deterministically on the winner's rotated cookie regardless
          // of response-arrival order, and every caller in the burst
          // still returns 200 with a fresh access token.
          //
          // Standard OAuth 2.0 rotation-with-reuse-detection pattern:
          // N concurrent presentations of the same token → 1 rotation +
          // N-1 replays. No new refresh_token rows created for replays.
          // No orphaned successors. No cookie ambiguity.
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
