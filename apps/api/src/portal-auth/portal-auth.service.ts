import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID, createHash } from 'node:crypto';
import * as argon2 from '@node-rs/argon2';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import { TokenService } from '../auth/token.service';
import { TotpService } from '../auth/totp.service';
import { PORTAL_QUEUE } from '../queues/queues.module';
import { PROCESS_PASSWORD_RESET_JOB } from './portal-password-reset.processor';
import { SYSTEM_ROLES } from '@openestate/shared';
import type {
  PortalLoginDto,
  PortalInviteConsumeDto,
  PortalPasswordResetRequestDto,
  PortalPasswordResetConfirmDto,
  SendPortalInviteDto,
} from '@openestate/shared';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const INVITE_WRONG_ATTEMPT_CAP = 3;
const INVITE_EXPIRY_DAYS = 7;

interface PortalLoginResult {
  requiresTwoFactor: boolean;
  tempToken?: string;
  accessToken?: string;
  refreshRaw?: string;
  expiresAt?: Date;
}

/**
 * Portal counterpart to AuthService. Reuses TokenService/TotpService/argon2
 * as-is (Phase 6 decisions: "shared, unmodified") but is its own service
 * class — the login-identifier shape, invite-consume, and BullMQ-backed
 * reset flow have no staff equivalent to share code with.
 */
@Injectable()
export class PortalAuthService {
  private readonly portalRefreshExpiresIn =
    process.env.PORTAL_JWT_REFRESH_EXPIRES_IN ?? '24h';

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly prisma: PrismaClient,
    private readonly tokenService: TokenService,
    private readonly totpService: TotpService,
    @InjectQueue(PORTAL_QUEUE) private readonly portalQueue: Queue,
  ) {}

  async login(dto: PortalLoginDto): Promise<PortalLoginResult> {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: dto.identifier }, { phone: dto.identifier }],
        NOT: { applicantId: null, brokerId: null },
      },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('Account locked. Try again later.');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      await this.recordFailedAttempt(user.id, user.failedLoginAttempts);
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    if (user.totpEnabled && user.totpSecret) {
      const tempToken = this.tokenService.signAccessToken({
        sub: user.id,
        companyId: user.companyId,
        email: user.email,
        roleSlug: user.role.slug,
        permissions: ['auth.totp.verify'],
        applicantId: user.applicantId ?? undefined,
        brokerId: user.brokerId ?? undefined,
      });
      return { requiresTwoFactor: true, tempToken };
    }

    const tokens = await this.issueTokens(user);
    return { requiresTwoFactor: false, ...tokens };
  }

  async verifyTotp(userId: string, code: string): Promise<Required<Omit<PortalLoginResult, 'requiresTwoFactor' | 'tempToken'>>> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
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
        await this.prisma.user.update({ where: { id: user.id }, data: { recoveryCodes: remaining } });
        return this.issueTokens(user);
      }
    }

    throw new UnauthorizedException('Invalid TOTP code');
  }

  async setupTotp(userId: string) {
    const { secret, otpauthUrl } = this.totpService.generateSecret();
    const encrypted = this.totpService.encrypt(secret);
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecret: encrypted, totpEnabled: false } });
    return { secret, otpauthUrl };
  }

  async confirmTotp(userId: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpSecret) throw new BadRequestException('TOTP setup not started');

    const decryptedSecret = this.totpService.decrypt(user.totpSecret);
    if (!this.totpService.verify(decryptedSecret, code)) {
      throw new BadRequestException('Invalid TOTP code');
    }

    const recoveryCodes = this.totpService.generateRecoveryCodes();
    await this.prisma.user.update({ where: { id: userId }, data: { totpEnabled: true, recoveryCodes } });
    return { recoveryCodes };
  }

  async disableTotp(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: false, totpSecret: null, recoveryCodes: [] },
    });
  }

  async refreshTokens(rawRefreshToken: string) {
    const result = await this.tokenService.rotateRefreshToken(rawRefreshToken, this.portalRefreshExpiresIn);
    if (!result) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: result.userId },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });

    if (!user || !user.isActive || (!user.applicantId && !user.brokerId)) return null;

    const permissions = user.role.permissions.map((rp) => rp.permission.key);
    const accessToken = this.tokenService.signAccessToken({
      sub: user.id,
      companyId: user.companyId,
      email: user.email,
      roleSlug: user.role.slug,
      permissions,
      applicantId: user.applicantId ?? undefined,
      brokerId: user.brokerId ?? undefined,
    });

    return { accessToken, refreshRaw: result.newRaw, expiresAt: result.expiresAt };
  }

  async logout(rawRefreshToken: string) {
    await this.tokenService.revokeFamily(rawRefreshToken);
  }

  async logoutAll(userId: string) {
    await this.tokenService.revokeAllForUser(userId);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const valid = await argon2.verify(user.passwordHash, currentPassword);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    const hash = await argon2.hash(newPassword, { algorithm: argon2.Algorithm.Argon2id });
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } });
    await this.tokenService.revokeAllForUser(userId);
  }

  /**
   * Staff-triggered. Re-inviting always creates a NEW row (never mutates an
   * old one) so both a staff resend and a wrong-attempt invalidation leave
   * a clean trail — see PortalInvite's schema doc comment.
   */
  async sendInvite(companyId: string, createdById: string, dto: SendPortalInviteDto) {
    if (dto.applicantId) {
      const applicant = await this.prisma.applicant.findFirst({
        where: { id: dto.applicantId, companyId },
      });
      if (!applicant) throw new BadRequestException('Applicant not found');
    } else if (dto.brokerId) {
      const broker = await this.prisma.broker.findFirst({
        where: { id: dto.brokerId, companyId },
      });
      if (!broker) throw new BadRequestException('Broker not found');
    }

    const raw = randomUUID();
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const invite = await this.prisma.portalInvite.create({
      data: {
        companyId,
        applicantId: dto.applicantId,
        brokerId: dto.brokerId,
        channel: dto.channel,
        tokenHash,
        expiresAt,
        createdById,
      },
    });

    return { inviteId: invite.id, token: raw, expiresAt };
  }

  /**
   * Atomic, race-free wrong-attempt cap (Phase 6 decisions): a mismatch
   * increments wrong_attempts and — only once the post-increment count
   * reaches the cap — invalidates the row, all in ONE UPDATE guarded by
   * `consumed_at IS NULL`. Concurrent mismatches serialize on Postgres's
   * row lock; whichever loses the race re-evaluates against the
   * now-invalidated row and simply matches zero rows.
   */
  async consumeInvite(inviteId: string, dto: PortalInviteConsumeDto) {
    const invite = await this.prisma.portalInvite.findUnique({ where: { id: inviteId } });
    if (!invite) throw new UnauthorizedException('Invalid invite');
    if (invite.consumedAt) throw new UnauthorizedException('Invite is no longer valid');
    if (invite.expiresAt < new Date()) throw new UnauthorizedException('Invite has expired');

    const tokenHash = createHash('sha256').update(dto.token).digest('hex');

    if (tokenHash !== invite.tokenHash) {
      const rows = await this.prisma.$queryRaw<
        Array<{ wrong_attempts: number; consumed_at: Date | null; invalidated_reason: string | null }>
      >`
        UPDATE portal_invites
        SET wrong_attempts = wrong_attempts + 1,
            consumed_at = CASE WHEN wrong_attempts + 1 >= ${INVITE_WRONG_ATTEMPT_CAP} THEN now() ELSE consumed_at END,
            invalidated_reason = CASE WHEN wrong_attempts + 1 >= ${INVITE_WRONG_ATTEMPT_CAP} THEN 'TOO_MANY_ATTEMPTS' ELSE invalidated_reason END
        WHERE id = ${inviteId}::uuid AND consumed_at IS NULL
        RETURNING wrong_attempts, consumed_at, invalidated_reason
      `;
      const row = rows[0];
      if (!row) throw new UnauthorizedException('Invite is no longer valid');
      if (row.invalidated_reason === 'TOO_MANY_ATTEMPTS') {
        throw new ForbiddenException('Too many attempts. Ask staff to resend the invite.');
      }
      throw new UnauthorizedException('Invalid token');
    }

    // Correct token — atomically claim the row so a concurrent correct-token
    // request can't also succeed (only one caller creates the User below).
    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE portal_invites SET consumed_at = now()
      WHERE id = ${inviteId}::uuid AND consumed_at IS NULL
      RETURNING id
    `;
    if (claimed.length === 0) throw new UnauthorizedException('Invite is no longer valid');

    return this.finalizeInviteConsumption(invite, dto.password);
  }

  private async finalizeInviteConsumption(
    invite: { companyId: string; applicantId: string | null; brokerId: string | null },
    password: string,
  ) {
    const roleSlug = invite.applicantId ? SYSTEM_ROLES.CUSTOMER : SYSTEM_ROLES.BROKER;
    const role = await this.prisma.role.findFirst({ where: { companyId: invite.companyId, slug: roleSlug } });
    if (!role) throw new BadRequestException(`No ${roleSlug} role configured for this company`);

    let name: string;
    let email: string | null;
    let phone: string | null;

    if (invite.applicantId) {
      const applicant = await this.prisma.applicant.findUniqueOrThrow({ where: { id: invite.applicantId } });
      name = applicant.name;
      email = applicant.email;
      phone = applicant.primaryPhone;
    } else {
      const broker = await this.prisma.broker.findUniqueOrThrow({ where: { id: invite.brokerId! } });
      name = broker.name;
      email = broker.email;
      phone = broker.phone;
    }

    const passwordHash = await argon2.hash(password, { algorithm: argon2.Algorithm.Argon2id });

    const existingUser = await this.prisma.user.findFirst({
      where: invite.applicantId ? { applicantId: invite.applicantId } : { brokerId: invite.brokerId },
    });

    const user = existingUser
      ? await this.prisma.user.update({
          where: { id: existingUser.id },
          data: { passwordHash, isActive: true, forcePasswordChange: false },
          include: { role: { include: { permissions: { include: { permission: true } } } } },
        })
      : await this.prisma.user.create({
          data: {
            companyId: invite.companyId,
            email,
            phone,
            name,
            passwordHash,
            roleId: role.id,
            applicantId: invite.applicantId,
            brokerId: invite.brokerId,
            forcePasswordChange: false,
          },
          include: { role: { include: { permissions: { include: { permission: true } } } } },
        });

    const tokens = await this.issueTokens(user);
    return { requiresTwoFactor: false as const, ...tokens };
  }

  /**
   * Structurally timing-equal (Phase 6 decisions): the lookup cost is the
   * same either way, and a job is enqueued synchronously for BOTH branches
   * — the response never depends on which one actually did work, only the
   * async PortalPasswordResetProcessor does.
   */
  async requestPasswordReset(dto: PortalPasswordResetRequestDto): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: dto.identifier }, { phone: dto.identifier }],
        NOT: { applicantId: null, brokerId: null },
      },
      select: { id: true, companyId: true, isActive: true },
    });

    await this.portalQueue.add(PROCESS_PASSWORD_RESET_JOB, {
      userId: user?.isActive ? user.id : null,
      companyId: user?.isActive ? user.companyId : null,
    });
  }

  async confirmPasswordReset(dto: PortalPasswordResetConfirmDto): Promise<void> {
    const tokenHash = createHash('sha256').update(dto.token).digest('hex');
    const reset = await this.prisma.portalPasswordReset.findFirst({ where: { tokenHash } });

    if (!reset || reset.consumedAt || reset.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE portal_password_resets SET consumed_at = now()
      WHERE id = ${reset.id}::uuid AND consumed_at IS NULL
      RETURNING id
    `;
    if (claimed.length === 0) throw new UnauthorizedException('Invalid or expired reset token');

    const passwordHash = await argon2.hash(dto.newPassword, { algorithm: argon2.Algorithm.Argon2id });
    await this.prisma.user.update({
      where: { id: reset.userId },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
    });
    await this.tokenService.revokeAllForUser(reset.userId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async issueTokens(user: any): Promise<{ accessToken: string; refreshRaw: string; expiresAt: Date }> {
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
      applicantId: user.applicantId ?? undefined,
      brokerId: user.brokerId ?? undefined,
    });

    const { raw: refreshRaw, expiresAt } = await this.tokenService.createRefreshToken(
      user.id,
      undefined,
      this.portalRefreshExpiresIn,
    );

    return { accessToken, refreshRaw, expiresAt };
  }

  private async recordFailedAttempt(userId: string, currentAttempts: number) {
    const attempts = currentAttempts + 1;
    const lockedUntil =
      attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null;
    await this.prisma.user.update({ where: { id: userId }, data: { failedLoginAttempts: attempts, lockedUntil } });
  }
}
