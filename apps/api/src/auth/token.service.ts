import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import type { JwtPayload } from '@openestate/shared';
import { TWO_FACTOR_PENDING_PERMISSION, TWO_FACTOR_PENDING_TTL_SECONDS } from './guards/two-factor-pending.guard';

/** The client a $transaction callback receives. */
type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Every write to a user's refresh tokens (create, rotate, revoke) runs in one
 * transaction holding a per-user advisory lock, so these writes happen one at a
 * time per user and each sees the others' committed results. Without it, a
 * second refresh arriving between a rotation's revoke and its insert was refused
 * as theft, and a revoke running in that gap missed the new token.
 *
 * Each wait is bounded twice: lock_timeout makes PostgreSQL give up on a lock
 * after 5 s (freeing the connection), and the transaction is cancelled after
 * 10 s. The locked work is a few single-row statements with no outside I/O, and
 * only one user's own requests ever queue on the same lock.
 */
const LOCK_TIMEOUT = '5s';
const TX_OPTIONS = { maxWait: 10_000, timeout: 10_000 };

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
    this.reuseGraceMs =
      Number(this.config.get('REFRESH_REUSE_GRACE_SECONDS') ?? 30) * 1000;
  }

  /**
   * Every token carries the user's CURRENT authorisation version (`av`), read
   * here from the database at the moment of issue rather than taken from the
   * caller, so a caller holding a user row loaded before a version bump can never
   * mint a token that is stale on arrival. SessionVersionGuard compares it on
   * every request.
   */
  async signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp' | 'av'>): Promise<string> {
    return this.jwt.sign({ ...payload, av: await this.currentAuthzVersion(payload.sub) });
  }

  private async currentAuthzVersion(userId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ authz_version: number }>>`
      SELECT authz_version FROM users WHERE id = ${userId}::uuid`;
    if (!rows.length) throw new Error('Cannot issue a token for a user that does not exist');
    return rows[0].authz_version;
  }

  /**
   * What login returns instead of a session when TOTP is on. Good for
   * totp/verify and nothing else (TwoFactorPendingGuard). One signer for
   * staff and portal, so the marker and the lifetime can't drift apart.
   */
  async signTwoFactorPendingToken(
    payload: Omit<JwtPayload, 'iat' | 'exp' | 'permissions' | 'forcePasswordChange' | 'av'>,
  ): Promise<string> {
    return this.jwt.sign(
      { ...payload, permissions: [TWO_FACTOR_PENDING_PERMISSION], av: await this.currentAuthzVersion(payload.sub) },
      { expiresIn: TWO_FACTOR_PENDING_TTL_SECONDS },
    );
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

    await this.withUserLock(userId, (tx) =>
      tx.refreshToken.create({
        data: {
          id: jti,
          userId,
          tokenHash: hash,
          family: tokenFamily,
          expiresAt,
        },
      }),
    );

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
    const owner = await this.ownerOf(hash);
    if (!owner) return null;

    return this.withUserLock(owner, async (tx) => {
      // Read again under the lock: another request may have rotated or
      // revoked this token while this one waited.
      const existing = await tx.refreshToken.findFirst({
        where: { tokenHash: hash },
      });

      if (!existing) return null;

      if (existing.isRevoked) {
        const revokedAgoMs = existing.revokedAt
          ? Date.now() - existing.revokedAt.getTime()
          : Number.POSITIVE_INFINITY;

        if (revokedAgoMs <= this.reuseGraceMs) {
          // Most recent live token in the same family, if the chain is intact.
          const live = await tx.refreshToken.findFirst({
            where: {
              family: existing.family,
              isRevoked: false,
              expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: 'desc' },
          });
          if (live) return this.rotateRow(tx, live, expiresInOverride);
        }

        // Genuine reuse: outside the window, or the family is already dead.
        await this.revokeFamilyById(tx, existing.family);
        return null;
      }

      if (existing.expiresAt < new Date()) {
        await tx.refreshToken.update({
          where: { id: existing.id },
          data: { isRevoked: true, revokedAt: new Date() },
        });
        return null;
      }

      return this.rotateRow(tx, existing, expiresInOverride);
    });
  }

  /** Consumes one live token row and issues its successor in the same family. */
  private async rotateRow(
    tx: Tx,
    row: { id: string; userId: string; family: string },
    expiresInOverride?: string,
  ): Promise<{ userId: string; newRaw: string; expiresAt: Date }> {
    await tx.refreshToken.update({
      where: { id: row.id },
      data: { isRevoked: true, revokedAt: new Date() },
    });

    const newRaw = randomUUID();
    const newHash = this.hashToken(newRaw);
    const newJti = randomUUID();
    const expiresAt = this.computeExpiry(expiresInOverride ?? this.refreshExpiresIn);

    await tx.refreshToken.create({
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

  private async revokeFamilyById(tx: Tx, family: string): Promise<void> {
    await tx.refreshToken.updateMany({
      where: { family, isRevoked: false },
      data: { isRevoked: true, revokedAt: new Date() },
    });
  }

  async revokeFamily(rawToken: string): Promise<void> {
    const hash = this.hashToken(rawToken);
    const owner = await this.ownerOf(hash);
    if (!owner) return;
    await this.withUserLock(owner, async (tx) => {
      const existing = await tx.refreshToken.findFirst({ where: { tokenHash: hash } });
      if (existing) await this.revokeFamilyById(tx, existing.family);
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.withUserLock(userId, (tx) =>
      tx.refreshToken.updateMany({
        where: { userId, isRevoked: false },
        data: { isRevoked: true, revokedAt: new Date() },
      }),
    );
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
    await this.withUserLock(userId, async (tx) => {
      const current = await tx.refreshToken.findFirst({ where: { tokenHash: hash } });
      await tx.refreshToken.updateMany({
        where: {
          userId,
          isRevoked: false,
          ...(current ? { family: { not: current.family } } : {}),
        },
        data: { isRevoked: true, revokedAt: new Date() },
      });
    });
  }

  /** The user a token belongs to, so its writes can take that user's lock. */
  private async ownerOf(tokenHash: string): Promise<string | null> {
    const row = await this.prisma.refreshToken.findFirst({
      where: { tokenHash },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }

  private withUserLock<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // Raw SQL: transaction-scoped settings and advisory locks have no Prisma
      // API. Both values are bound parameters.
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('refresh:' || ${userId}, 0))`;
      return fn(tx);
    }, TX_OPTIONS);
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
