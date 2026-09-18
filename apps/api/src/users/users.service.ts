import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from '@node-rs/argon2';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient, withTenantTx, runWithTenant, getCurrentIpAddress } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { TokenService } from '../auth/token.service';
import { TOTP_CLEARED } from '../auth/totp-lockout';
import { authAuditData } from '../auth/auth-audit';
import type {
  CreateUserDto,
  UpdateUserDto,
  PaginationQuery,
} from '@openestate/shared';

const RESET_EXPIRY_MS = 30 * 60 * 1000;

export interface HierarchyNode {
  id: string;
  name: string;
  /** Nullable — staff users can be phone-identified with no email. */
  email: string | null;
  roleName: string | null;
  roleSlug: string | null;
  directReportCount: number;
  reports: HierarchyNode[];
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly tokenService: TokenService,
  ) {}

  async findAll(companyId: string, query: PaginationQuery) {
    const { page, limit, search, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.systemPrisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          isActive: true,
          forcePasswordChange: true,
          totpEnabled: true,
          lastLoginAt: true,
          createdAt: true,
          managerId: true,
          // Portal-linked (customer/broker) users are created via invite-
          // consume and never through this table's own create/edit forms —
          // apps/web's Users/UserForm screens use these to redirect a
          // staff admin to the applicant/broker record instead of a dead
          // "force password reset" action that the backend would 400 on.
          applicantId: true,
          brokerId: true,
          role: { select: { id: true, name: true, slug: true } },
        },
      }),
      this.systemPrisma.user.count({ where }),
    ]);

    // managerId has no Prisma relation (User relation-bloat policy) — the
    // manager's display name is resolved with a second, small lookup
    // rather than an `include`, same trade-off as every other User-linked
    // scalar FK in this codebase.
    const managerIds = [...new Set(data.map((u: { managerId: string | null }) => u.managerId).filter((id: string | null): id is string => id !== null))];
    const managers = managerIds.length
      ? await this.systemPrisma.user.findMany({
          where: { id: { in: managerIds }, companyId },
          select: { id: true, name: true },
        })
      : [];
    const managerNameById = new Map(managers.map((m: { id: string; name: string }) => [m.id, m.name]));

    return {
      data: data.map((u: { managerId: string | null }) => ({
        ...u,
        managerName: u.managerId ? (managerNameById.get(u.managerId) ?? null) : null,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Read-only org tree, scoped to what the caller may see: admin-tier
   * callers (`visibleUserIds === null`) get the whole company; everyone
   * else gets their own reporting subtree, which `TeamScopeService`
   * already computes — this method never decides scope itself, it only
   * shapes the rows it is handed into a tree.
   *
   * Roots are the visible users whose own manager is either unset or NOT
   * in the visible set. That second condition matters: a manager viewing
   * their own subtree has a manager above them who is deliberately not
   * visible, and without it the tree would come back empty (no node's
   * parent would be present) rather than rooted at the caller.
   */
  async getHierarchy(
    companyId: string,
    visibleUserIds: string[] | null,
  ): Promise<HierarchyNode[]> {
    const users = await this.systemPrisma.user.findMany({
      where: {
        companyId,
        isActive: true,
        ...(visibleUserIds ? { id: { in: visibleUserIds } } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        managerId: true,
        role: { select: { name: true, slug: true } },
      },
      orderBy: { name: 'asc' },
    });

    type Row = (typeof users)[number];

    const visible = new Set(users.map((u: Row) => u.id));
    const nodeById = new Map<string, HierarchyNode>(
      users.map((u: Row) => [
        u.id,
        {
          id: u.id,
          name: u.name,
          email: u.email,
          roleName: u.role?.name ?? null,
          roleSlug: u.role?.slug ?? null,
          directReportCount: 0,
          reports: [],
        },
      ]),
    );

    const roots: HierarchyNode[] = [];
    for (const u of users) {
      const node = nodeById.get(u.id)!;
      const parent = u.managerId && visible.has(u.managerId) ? nodeById.get(u.managerId) : undefined;
      if (parent) {
        parent.reports.push(node);
        parent.directReportCount++;
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  async findOne(companyId: string, userId: string) {
    const user = await this.systemPrisma.user.findFirst({
      where: { id: userId, companyId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        isActive: true,
        forcePasswordChange: true,
        totpEnabled: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        managerId: true,
        // See the identical comment on findAll's select.
        applicantId: true,
        brokerId: true,
        role: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async create(companyId: string, dto: CreateUserDto) {
    const existing = await this.systemPrisma.user.findFirst({
      where: { email: dto.email, companyId },
    });
    if (existing) {
      throw new BadRequestException('Email already in use');
    }
    if (dto.managerId !== undefined) {
      await this.assertValidManager(companyId, null, dto.managerId);
    }

    const hash = await argon2.hash(dto.password, { algorithm: argon2.Algorithm.Argon2id });

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.user.create({
          data: {
            companyId,
            email: dto.email,
            name: dto.name,
            passwordHash: hash,
            roleId: dto.roleId,
            phone: dto.phone,
            managerId: dto.managerId ?? null,
            forcePasswordChange: true,
          },
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            managerId: true,
            createdAt: true,
          },
        }),
      ),
    );
  }

  async update(companyId: string, userId: string, dto: UpdateUserDto) {
    await this.findOne(companyId, userId);
    if (dto.managerId !== undefined) {
      await this.assertValidManager(companyId, userId, dto.managerId);
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.user.update({
          where: { id: userId },
          data: dto,
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            managerId: true,
            updatedAt: true,
            role: { select: { id: true, name: true, slug: true } },
          },
        }),
      ),
    );
  }

  /**
   * Validates a candidate managerId before it's written: must exist in the
   * same company, can't be the user's own id, and can't create a cycle.
   *
   * Cycle check is a bounded walk (cap 20 hops — deep enough for any real
   * org chart) up the CANDIDATE's own manager chain: if it reaches back to
   * `userId`, assigning this manager would close a loop. This is
   * defense-in-depth, not the only thing preventing cycles — every write
   * goes through this function, so a cycle should never exist in stored
   * data in the first place. Postgres has no native cycle prevention for
   * adjacency lists, and TeamScopeService's recursive CTE assumes an
   * acyclic graph (an actual cycle there would loop until Postgres's own
   * recursion-depth safety net kills the query) — this check is what keeps
   * that assumption true.
   */
  private async assertValidManager(
    companyId: string,
    userId: string | null,
    candidateManagerId: string | null,
  ): Promise<void> {
    if (candidateManagerId === null) return;
    if (userId !== null && candidateManagerId === userId) {
      throw new BadRequestException('A user cannot be their own manager');
    }
    const candidate = await this.systemPrisma.user.findFirst({
      where: { id: candidateManagerId, companyId },
      select: { managerId: true },
    });
    if (!candidate) {
      throw new BadRequestException('Manager not found in this company');
    }
    if (userId === null) return; // creating a new user — no cycle possible yet

    let current: string | null = candidate.managerId;
    for (let hop = 0; hop < 20 && current; hop++) {
      if (current === userId) {
        throw new BadRequestException('This manager assignment would create a management cycle');
      }
      const row: { managerId: string | null } | null = await this.systemPrisma.user.findFirst({
        where: { id: current, companyId },
        select: { managerId: true },
      });
      current = row?.managerId ?? null;
    }
  }

  async deactivate(companyId: string, userId: string) {
    await this.findOne(companyId, userId);

    const result = await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.user.update({
          where: { id: userId },
          data: { isActive: false },
          select: { id: true, isActive: true },
        }),
      ),
    );

    // A deactivated user's existing access token stays valid until it
    // expires (JwtStrategy does no DB lookup) — but their refresh tokens
    // must die here so they can't renew. Same pattern as
    // AuthService.forceChangePassword: DB write first, revoke after,
    // outside the tenant transaction (TokenService uses SYSTEM_PRISMA).
    await this.tokenService.revokeAllForUser(userId);

    // Outstanding reset links die too, staff and portal tables both (this
    // endpoint deactivates either kind of user), so reactivation can't bring
    // one back. Separate from the tenant transaction above: the staff reset
    // table isn't tenant-scoped. confirmPasswordReset's isActive check covers
    // the gap between the two writes.
    const now = new Date();
    const live = { userId, consumedAt: null, expiresAt: { gt: now } };
    await this.systemPrisma.$transaction([
      this.systemPrisma.passwordReset.updateMany({ where: live, data: { consumedAt: now } }),
      this.systemPrisma.portalPasswordReset.updateMany({ where: live, data: { consumedAt: now } }),
    ]);

    return result;
  }

  async reactivate(companyId: string, userId: string) {
    await this.findOne(companyId, userId);

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.user.update({
          where: { id: userId },
          data: { isActive: true },
          select: { id: true, isActive: true },
        }),
      ),
    );
  }

  /**
   * Admin-triggered reset for a STAFF user. Returns a one-time token for the
   * admin to deliver out-of-band (WhatsApp, phone, in person); never sets or
   * reveals a password. Only the SHA-256 hash is stored, so this return value
   * is the one place the raw token ever exists. Issuing a token consumes any
   * still-live one — links are handed around manually now, so at most one may
   * be in circulation per user. Portal users are refused: they reset through
   * the portal path.
   *
   * Deliberately never calls CommunicationProvider.send: this install has no
   * mailer, and ConsoleCommunicationProvider logs message bodies in plaintext
   * (docs/todo.md) — a send here would only add a log line holding a live
   * token. Delivery is entirely the admin's job. Same rule as
   * PortalAuthService.issueAdminPasswordReset.
   */
  async forcePasswordReset(
    companyId: string,
    userId: string,
    adminUserId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const user = await this.systemPrisma.user.findFirst({ where: { id: userId, companyId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.isActive) {
      throw new ConflictException(
        'Cannot reset the password of a deactivated user. Reactivate the account first.',
      );
    }
    if (user.applicantId || user.brokerId) {
      throw new BadRequestException(
        'This is a portal user — portal passwords are reset through the portal, not here.',
      );
    }

    const token = randomUUID();
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + RESET_EXPIRY_MS);
    const ipAddress = getCurrentIpAddress();

    await this.systemPrisma.$transaction(async (tx) => {
      // Raw SQL because Prisma has no SELECT ... FOR UPDATE. Locking the user
      // row serializes concurrent issuances for one user, so the supersede
      // below cannot miss a token another request is creating at that moment.
      await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const now = new Date();
      await tx.passwordReset.updateMany({
        where: { companyId, userId, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      const reset = await tx.passwordReset.create({
        data: { companyId, userId, tokenHash, expiresAt, createdById: adminUserId },
      });
      // SYSTEM_PRISMA carries no audit extension, so this auth event is written
      // explicitly — same direct insert as CustomFieldsService's purge. The
      // token itself is never recorded.
      await tx.auditLog.create({
        data: {
          companyId,
          userId: adminUserId,
          entityType: 'User',
          entityId: userId,
          action: 'RESET_LINK_ISSUED',
          after: { passwordResetId: reset.id, expiresAt: expiresAt.toISOString() },
          ipAddress,
        },
      });
    });

    return { token, expiresAt };
  }

  /**
   * Admin-side 2FA reset for a STAFF user who has lost both their
   * authenticator and their recovery codes. Clears the secret, the recovery
   * codes and the TOTP lockout (TOTP_CLEARED — the same fields self-service
   * disable clears), audits it, and revokes every session. The user signs in
   * with their password alone and can enrol again. Their password is not
   * touched: coupling the two would make a password-reset link a 2FA bypass.
   *
   * Portal users are refused: their 2FA resets through
   * PortalAuthService.adminResetTotp, which takes the applicant or broker.
   * Resetting yourself is refused too — Settings → Disable 2FA does that
   * without logging you out.
   *
   * Deactivated users are ALLOWED, unlike forcePasswordReset's 409. That 409
   * exists because a reset link is a live credential; this issues nothing,
   * and a deactivated account still cannot sign in (login refuses it, and
   * reset-link redemption refuses it since v0.6.0). Requiring reactivation
   * first would add an ordering step with no security gain.
   *
   * Sessions: revokeAllForUser stops every refresh token from renewing, but
   * an access token already issued stays valid until it expires — up to
   * JWT_ACCESS_EXPIRES_IN, 15 minutes by default — because JwtStrategy
   * checks only the signature and expiry, with no database lookup.
   *
   * The audit row is written even when 2FA was already off (wasEnabled:
   * false): the admin's action is itself worth recording.
   */
  async resetTotp(
    companyId: string,
    userId: string,
    adminUserId: string,
  ): Promise<{ wasEnabled: boolean }> {
    if (userId === adminUserId) {
      throw new BadRequestException(
        'You cannot reset your own 2FA here. Use Settings → Disable 2FA instead.',
      );
    }
    const user = await this.systemPrisma.user.findFirst({
      where: { id: userId, companyId },
      select: { applicantId: true, brokerId: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.applicantId || user.brokerId) {
      throw new BadRequestException(
        "This is a portal user — reset their 2FA from their customer or broker record, not here.",
      );
    }

    const wasEnabled = await this.systemPrisma.$transaction(async (tx) => {
      // Locked so wasEnabled is accurate when two admins reset at once: the
      // second sees 2FA already off. The clear itself is idempotent either way.
      const [row] = await tx.$queryRaw<Array<{ totp_enabled: boolean }>>`
        SELECT totp_enabled FROM users WHERE id = ${userId}::uuid FOR UPDATE
      `;
      await tx.user.update({ where: { id: userId }, data: TOTP_CLEARED });
      await tx.auditLog.create({
        data: authAuditData({
          companyId,
          actorId: adminUserId,
          targetUserId: userId,
          action: 'TOTP_RESET_BY_ADMIN',
          after: { surface: 'staff', wasEnabled: row.totp_enabled },
        }),
      });
      return row.totp_enabled;
    });

    // After the transaction, like deactivate(): TokenService writes through
    // its own client.
    await this.tokenService.revokeAllForUser(userId);
    return { wasEnabled };
  }
}
