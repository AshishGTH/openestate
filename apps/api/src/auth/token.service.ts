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

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(SYSTEM_PRISMA) private readonly prisma: PrismaClient,
  ) {
    this.refreshSecret = this.config.getOrThrow('JWT_REFRESH_SECRET');
    this.refreshExpiresIn = this.config.get('JWT_REFRESH_EXPIRES_IN') ?? '7d';
  }

  signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
    return this.jwt.sign(payload);
  }

  async createRefreshToken(
    userId: string,
    family?: string,
  ): Promise<{ raw: string; expiresAt: Date }> {
    const raw = randomUUID();
    const hash = this.hashToken(raw);
    const jti = randomUUID();
    const tokenFamily = family ?? randomUUID();
    const expiresAt = this.computeExpiry(this.refreshExpiresIn);

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

  async rotateRefreshToken(
    rawToken: string,
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
      await this.prisma.refreshToken.updateMany({
        where: { family: existing.family, isRevoked: false },
        data: { isRevoked: true },
      });
      return null;
    }

    if (existing.expiresAt < new Date()) {
      await this.prisma.refreshToken.update({
        where: { id: existing.id },
        data: { isRevoked: true },
      });
      return null;
    }

    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { isRevoked: true },
    });

    const newRaw = randomUUID();
    const newHash = this.hashToken(newRaw);
    const newJti = randomUUID();
    const expiresAt = this.computeExpiry(this.refreshExpiresIn);

    await this.prisma.refreshToken.create({
      data: {
        id: newJti,
        userId: existing.userId,
        tokenHash: newHash,
        family: existing.family,
        expiresAt,
      },
    });

    return { userId: existing.userId, newRaw, expiresAt };
  }

  async revokeFamily(rawToken: string): Promise<void> {
    const hash = this.hashToken(rawToken);
    const existing = await this.prisma.refreshToken.findFirst({
      where: { tokenHash: hash },
    });
    if (existing) {
      await this.prisma.refreshToken.updateMany({
        where: { family: existing.family, isRevoked: false },
        data: { isRevoked: true },
      });
    }
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, isRevoked: false },
      data: { isRevoked: true },
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
