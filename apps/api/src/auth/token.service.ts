import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import type { JwtPayload } from '@openestate/shared';

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
  ): Promise<{
    userId: string;
    newRaw: string;
    expiresAt: Date;
  } | null> {
    const hash = this.hashToken(rawToken);

    const existing = await this.prisma.refreshToken.findFirst({
      where: { tokenHash: hash },
    });

    if (!existing) return null;

    if (existing.isRevoked) {
      const revokedAgoMs = existing.revokedAt
        ? Date.now() - existing.revokedAt.getTime()
        : Number.POSITIVE_INFINITY;

      if (revokedAgoMs <= this.reuseGraceMs) {
        // Most recent live token in the same family, if the chain is intact.
        const live = await this.prisma.refreshToken.findFirst({
          where: {
            family: existing.family,
            isRevoked: false,
            expiresAt: { gt: new Date() },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (live) return this.rotateRow(live, expiresInOverride);
      }

      // Genuine reuse: outside the window, or the family is already dead.
      await this.revokeFamilyById(existing.family);
      return null;
    }

    if (existing.expiresAt < new Date()) {
      await this.prisma.refreshToken.update({
        where: { id: existing.id },
        data: { isRevoked: true, revokedAt: new Date() },
      });
      return null;
    }

    return this.rotateRow(existing, expiresInOverride);
  }

  /** Consumes one live token row and issues its successor in the same family. */
  private async rotateRow(
    row: { id: string; userId: string; family: string },
    expiresInOverride?: string,
  ): Promise<{ userId: string; newRaw: string; expiresAt: Date }> {
    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { isRevoked: true, revokedAt: new Date() },
    });

    const newRaw = randomUUID();
    const newHash = this.hashToken(newRaw);
    const newJti = randomUUID();
    const expiresAt = this.computeExpiry(expiresInOverride ?? this.refreshExpiresIn);

    await this.prisma.refreshToken.create({
      data: {
        id: newJti,
        userId: row.userId,
        tokenHash: newHash,
        family: row.family,
        expiresAt,
      },
    });

    return { userId: row.userId, newRaw, expiresAt };
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
