import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from '@node-rs/argon2';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import { TokenService } from './token.service';
import { TotpService } from './totp.service';
import { reserveTotpAttempt, TOTP_ATTEMPTS_CLEARED } from './totp-lockout';
import type { LoginDto, PasswordResetConfirmDto } from '@openestate/shared';

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
      const tempToken = this.tokenService.signTwoFactorPendingToken({
        sub: user.id,
        companyId: user.companyId,
        email: user.email,
        roleSlug: user.role.slug,
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

    // Throws 429 without looking at the code if the user is TOTP-locked.
    await reserveTotpAttempt(this.prisma, user.id);

    const decryptedSecret = this.totpService.decrypt(user.totpSecret);

    if (this.totpService.verify(decryptedSecret, code)) {
      await this.prisma.user.update({ where: { id: user.id }, data: TOTP_ATTEMPTS_CLEARED });
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
          data: { recoveryCodes: remaining, ...TOTP_ATTEMPTS_CLEARED },
        });
        return this.issueTokens(user);
      }
    }

    throw new UnauthorizedException('Invalid TOTP code');
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, totpEnabled: true },
    });
    return user;
  }

  async setupTotp(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, phone: true, name: true },
    });
    const label = user.email ?? user.phone ?? user.name;

    const { secret, otpauthUrl, qrDataUrl } = this.totpService.generateSecret(label);
    const encrypted = this.totpService.encrypt(secret);

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: encrypted, totpEnabled: false },
    });

    return { secret, otpauthUrl, qrDataUrl };
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
      forcePasswordChange: user.forcePasswordChange,
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
    currentRefreshToken?: string,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const valid = await argon2.verify(user.passwordHash, currentPassword);
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const hash = await argon2.hash(newPassword, { algorithm: argon2.Algorithm.Argon2id });
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash: hash,
          forcePasswordChange: false,
        },
      }),
      this.consumeResetLinks(userId),
    ]);

    // Leaves the session that made this request alone — only OTHER
    // sessions are revoked (see TokenService.revokeAllForUserExceptToken).
    if (currentRefreshToken) {
      await this.tokenService.revokeAllForUserExceptToken(userId, currentRefreshToken);
    } else {
      await this.tokenService.revokeAllForUser(userId);
    }
  }

  /**
   * Confirms a staff reset link issued by UsersService.forcePasswordReset,
   * which serves staff users only — it refuses portal users, whose passwords
   * reset through the portal's own PortalPasswordReset flow. Public route,
   * no auth — the token itself is the credential.
   */
  async confirmPasswordReset(dto: PasswordResetConfirmDto): Promise<void> {
    const tokenHash = createHash('sha256').update(dto.token).digest('hex');
    const reset = await this.prisma.passwordReset.findFirst({ where: { tokenHash } });

    if (!reset || reset.consumedAt || reset.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE password_resets SET consumed_at = now()
      WHERE id = ${reset.id}::uuid AND consumed_at IS NULL
      RETURNING id
    `;
    if (claimed.length === 0) throw new UnauthorizedException('Invalid or expired reset token');

    const passwordHash = await argon2.hash(dto.newPassword, { algorithm: argon2.Algorithm.Argon2id });
    // A deactivated account is refused. The link was claimed above, so it
    // stays dead if the account is reactivated later. Conditional write, not
    // check-then-write, so a deactivation at the same moment can't slip
    // between the two.
    const { count } = await this.prisma.user.updateMany({
      where: { id: reset.userId, isActive: true },
      data: { passwordHash, forcePasswordChange: false, failedLoginAttempts: 0, lockedUntil: null },
    });
    if (count === 0) throw new UnauthorizedException('Invalid or expired reset token');
    await this.tokenService.revokeAllForUser(reset.userId);
  }

  async forceChangePassword(userId: string, newPassword: string) {
    const hash = await argon2.hash(newPassword, { algorithm: argon2.Algorithm.Argon2id });
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash: hash,
          forcePasswordChange: false,
        },
      }),
      this.consumeResetLinks(userId),
    ]);
    await this.tokenService.revokeAllForUser(userId);
  }

  /**
   * A reset link still live when the user sets their own password predates
   * that password, so it must not be able to overwrite it. Always batched
   * after the password write, in the same transaction: that update waits on
   * the row lock UsersService.forcePasswordReset takes, so a link issued at
   * the same moment is either consumed here or created after the change.
   * Mirrors PortalAuthService.consumeResetLinks.
   */
  private consumeResetLinks(userId: string) {
    const now = new Date();
    return this.prisma.passwordReset.updateMany({
      where: { userId, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
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
      forcePasswordChange: user.forcePasswordChange,
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
