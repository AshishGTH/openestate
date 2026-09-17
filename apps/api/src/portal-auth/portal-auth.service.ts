import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID, createHash } from 'node:crypto';
import * as argon2 from '@node-rs/argon2';
import { PrismaClient, getCurrentIpAddress } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import { TokenService } from '../auth/token.service';
import { TotpService } from '../auth/totp.service';
import { reserveTotpAttempt, TOTP_ATTEMPTS_CLEARED, TOTP_CLEARED } from '../auth/totp-lockout';
import { PORTAL_QUEUE } from '../queues/queues.module';
import { PROCESS_PASSWORD_RESET_JOB } from './portal-password-reset.processor';
import { SYSTEM_ROLES, NO_PORTAL_ACCOUNT_ERROR } from '@openestate/shared';
import type {
  AdminPortalPasswordResetDto,
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
const RESET_EXPIRY_MS = 30 * 60 * 1000;

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
      const tempToken = this.tokenService.signTwoFactorPendingToken({
        sub: user.id,
        companyId: user.companyId,
        email: user.email,
        roleSlug: user.role.slug,
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
        await this.prisma.user.update({ where: { id: user.id }, data: { recoveryCodes: remaining, ...TOTP_ATTEMPTS_CLEARED } });
        return this.issueTokens(user);
      }
    }

    throw new UnauthorizedException('Invalid TOTP code');
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, phone: true, name: true, totpEnabled: true },
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
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecret: encrypted, totpEnabled: false } });
    return { secret, otpauthUrl, qrDataUrl };
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
      data: TOTP_CLEARED,
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

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentRefreshToken?: string,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const valid = await argon2.verify(user.passwordHash, currentPassword);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    const hash = await argon2.hash(newPassword, { algorithm: argon2.Algorithm.Argon2id });
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } }),
      this.consumeResetLinks(userId),
    ]);

    // Leaves the session that made this request alone — mirrors the
    // staff-side fix in AuthService.changePassword (see CLAUDE.md's
    // mirrored-auth standing rule).
    if (currentRefreshToken) {
      await this.tokenService.revokeAllForUserExceptToken(userId, currentRefreshToken);
    } else {
      await this.tokenService.revokeAllForUser(userId);
    }
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

    // An existing account can hold reset links; a brand-new one can't.
    const user = existingUser
      ? (
          await this.prisma.$transaction([
            this.prisma.user.update({
              where: { id: existingUser.id },
              data: { passwordHash, isActive: true, forcePasswordChange: false },
              include: { role: { include: { permissions: { include: { permission: true } } } } },
            }),
            this.consumeResetLinks(existingUser.id),
          ])
        )[0]
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
    // Same inactive-account refusal as AuthService.confirmPasswordReset: the
    // link is already claimed, and the conditional write can't race a
    // deactivation.
    const { count } = await this.prisma.user.updateMany({
      where: { id: reset.userId, isActive: true },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
    });
    if (count === 0) throw new UnauthorizedException('Invalid or expired reset token');
    await this.tokenService.revokeAllForUser(reset.userId);
  }

  /**
   * Staff-triggered reset for an applicant's or broker's EXISTING portal
   * account — the portal counterpart of UsersService.forcePasswordReset.
   * Returns a one-time token for the admin to deliver out-of-band; only the
   * SHA-256 hash is stored, and the existing confirmPasswordReset accepts it
   * unchanged. Issuing a token consumes any still-live one for that account
   * (self-service ones included), so at most one link is in circulation.
   *
   * Deliberately never calls CommunicationProvider.send: this install has no
   * mailer, and ConsoleCommunicationProvider logs message bodies in plaintext
   * (docs/todo.md) — a send here would only add a log line holding a live
   * token. Delivery is entirely the admin's job.
   */
  async issueAdminPasswordReset(
    companyId: string,
    adminUserId: string,
    dto: AdminPortalPasswordResetDto,
  ): Promise<{ token: string; expiresAt: Date }> {
    // The zod schema already enforces this at the API boundary; repeated here
    // because an absent id would otherwise become Prisma's "no filter".
    if (!dto.applicantId === !dto.brokerId) {
      throw new BadRequestException('Exactly one of applicantId or brokerId is required');
    }
    const principal = dto.applicantId ? { applicantId: dto.applicantId } : { brokerId: dto.brokerId };

    const exists = dto.applicantId
      ? await this.prisma.applicant.findFirst({ where: { id: dto.applicantId, companyId }, select: { id: true } })
      : await this.prisma.broker.findFirst({ where: { id: dto.brokerId, companyId }, select: { id: true } });
    if (!exists) throw new NotFoundException(dto.applicantId ? 'Applicant not found' : 'Broker not found');

    const user = await this.prisma.user.findFirst({
      where: { companyId, ...principal },
      select: { id: true, isActive: true },
    });
    if (!user) {
      throw new ConflictException({
        message: 'This person has no portal account yet — send them a portal invite instead.',
        code: NO_PORTAL_ACCOUNT_ERROR,
      });
    }
    if (!user.isActive) {
      throw new ConflictException(
        'Cannot reset the password of a deactivated portal account. Reactivate it first.',
      );
    }

    const token = randomUUID();
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + RESET_EXPIRY_MS);
    const ipAddress = getCurrentIpAddress();

    await this.prisma.$transaction(async (tx) => {
      // Raw SQL because Prisma has no SELECT ... FOR UPDATE. Locking the user
      // row serializes concurrent issuances for one account, so the supersede
      // below cannot miss a token another request is creating at that moment.
      await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      const now = new Date();
      await tx.portalPasswordReset.updateMany({
        where: { companyId, userId: user.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      const reset = await tx.portalPasswordReset.create({
        data: { companyId, userId: user.id, tokenHash, expiresAt, createdById: adminUserId },
      });
      // SYSTEM_PRISMA carries no audit extension, so this auth event is written
      // explicitly — same direct insert as the staff path. The token is never
      // recorded.
      await tx.auditLog.create({
        data: {
          companyId,
          userId: adminUserId,
          entityType: 'User',
          entityId: user.id,
          action: 'PORTAL_RESET_ISSUED',
          after: {
            portalPasswordResetId: reset.id,
            applicantId: dto.applicantId ?? null,
            brokerId: dto.brokerId ?? null,
            expiresAt: expiresAt.toISOString(),
          },
          ipAddress,
        },
      });
    });

    return { token, expiresAt };
  }

  /**
   * A reset link still live when the user sets their password another way
   * predates that password, so it must not be able to overwrite it. Always
   * batched after the password write, in the same transaction: that update
   * waits on the row lock issueAdminPasswordReset takes, so a link issued at
   * the same moment is either consumed here or created after the change.
   * Mirrors AuthService.consumeResetLinks.
   */
  private consumeResetLinks(userId: string) {
    const now = new Date();
    return this.prisma.portalPasswordReset.updateMany({
      where: { userId, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
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
