import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import { TokenService } from './token.service';
import { TotpService } from './totp.service';
import type { LoginDto } from '@openestate/shared';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  constructor(
    @Inject(SYSTEM_PRISMA) private readonly prisma: PrismaClient,
    private readonly tokenService: TokenService,
    private readonly totpService: TotpService,
  ) {}

  async login(
    dto: LoginDto,
    _ipAddress?: string,
  ): Promise<
    | { requiresTwoFactor: true; tempToken: string }
    | {
        requiresTwoFactor: false;
        accessToken: string;
        refreshRaw: string;
        expiresAt: Date;
      }
  > {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email },
      include: {
        role: {
          include: {
            permissions: { include: { permission: true } },
          },
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException(
        'Account locked. Try again later.',
      );
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      await this.recordFailedAttempt(user.id, user.failedLoginAttempts);
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    if (user.totpEnabled && user.totpSecret) {
      const tempToken = this.tokenService.signAccessToken({
        sub: user.id,
        companyId: user.companyId,
        email: user.email,
        roleSlug: user.role.slug,
        permissions: ['auth.totp.verify'],
      });
      return { requiresTwoFactor: true, tempToken };
    }

    const tokens = await this.issueTokens(user);
    return { requiresTwoFactor: false as const, ...tokens };
  }

  async verifyTotp(
    userId: string,
    code: string,
  ): Promise<{
    accessToken: string;
    refreshRaw: string;
    expiresAt: Date;
  }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        role: {
          include: {
            permissions: { include: { permission: true } },
          },
        },
      },
    });

    if (!user.totpEnabled || !user.totpSecret) {
      throw new BadRequestException('2FA not enabled');
    }

    const decryptedSecret = this.totpService.decrypt(user.totpSecret);

    if (this.totpService.verify(decryptedSecret, code)) {
      return this.issueTokens(user);
    }

    if (user.recoveryCodes) {
      const codes = user.recoveryCodes as string[];
      const idx = codes.indexOf(code);
      if (idx !== -1) {
        const remaining = [...codes];
        remaining.splice(idx, 1);
        await this.prisma.user.update({
          where: { id: user.id },
          data: { recoveryCodes: remaining },
        });
        return this.issueTokens(user);
      }
    }

    throw new UnauthorizedException('Invalid TOTP code');
  }

  async setupTotp(userId: string) {
    const { secret, otpauthUrl } = this.totpService.generateSecret();
    const encrypted = this.totpService.encrypt(secret);

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: encrypted, totpEnabled: false },
    });

    return { secret, otpauthUrl };
  }

  async confirmTotp(userId: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    if (!user.totpSecret) {
      throw new BadRequestException('TOTP setup not started');
    }

    const decryptedSecret = this.totpService.decrypt(user.totpSecret);
    if (!this.totpService.verify(decryptedSecret, code)) {
      throw new BadRequestException('Invalid TOTP code');
    }

    const recoveryCodes = this.totpService.generateRecoveryCodes();

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: true, recoveryCodes },
    });

    return { recoveryCodes };
  }

  async disableTotp(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totpEnabled: false,
        totpSecret: null,
        recoveryCodes: [],
      },
    });
  }

  async refreshTokens(
    rawRefreshToken: string,
  ): Promise<{
    accessToken: string;
    refreshRaw: string;
    expiresAt: Date;
  } | null> {
    const result = await this.tokenService.rotateRefreshToken(rawRefreshToken);
    if (!result) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: result.userId },
      include: {
        role: {
          include: {
            permissions: { include: { permission: true } },
          },
        },
      },
    });

    if (!user || !user.isActive) return null;

    const permissions = user.role.permissions.map(
      (rp) => rp.permission.key,
    );

    const accessToken = this.tokenService.signAccessToken({
      sub: user.id,
      companyId: user.companyId,
      email: user.email,
      roleSlug: user.role.slug,
      permissions,
    });

    return {
      accessToken,
      refreshRaw: result.newRaw,
      expiresAt: result.expiresAt,
    };
  }

  async logout(rawRefreshToken: string) {
    await this.tokenService.revokeFamily(rawRefreshToken);
  }

  async logoutAll(userId: string) {
    await this.tokenService.revokeAllForUser(userId);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const valid = await argon2.verify(user.passwordHash, currentPassword);
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: hash,
        forcePasswordChange: false,
      },
    });

    await this.tokenService.revokeAllForUser(userId);
  }

  async forceChangePassword(userId: string, newPassword: string) {
    const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: hash,
        forcePasswordChange: false,
      },
    });
    await this.tokenService.revokeAllForUser(userId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async issueTokens(user: any): Promise<{
    accessToken: string;
    refreshRaw: string;
    expiresAt: Date;
  }> {
    const permissions = user.role.permissions.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (rp: any) => rp.permission.key,
    );

    const accessToken = this.tokenService.signAccessToken({
      sub: user.id,
      companyId: user.companyId,
      email: user.email,
      roleSlug: user.role.slug,
      permissions,
    });

    const { raw: refreshRaw, expiresAt } =
      await this.tokenService.createRefreshToken(user.id);

    return { accessToken, refreshRaw, expiresAt };
  }

  private async recordFailedAttempt(
    userId: string,
    currentAttempts: number,
  ) {
    const attempts = currentAttempts + 1;
    const lockedUntil =
      attempts >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
        : null;

    await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: attempts, lockedUntil },
    });
  }
}
