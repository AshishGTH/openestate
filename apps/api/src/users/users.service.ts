import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from '@node-rs/argon2';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { COMMUNICATION_PROVIDER, type CommunicationProvider } from '../queues/communication-provider';
import type {
  CreateUserDto,
  UpdateUserDto,
  PaginationQuery,
} from '@openestate/shared';

const RESET_EXPIRY_MS = 30 * 60 * 1000;

@Injectable()
export class UsersService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    @Inject(COMMUNICATION_PROVIDER)
    private readonly provider: CommunicationProvider,
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

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.user.update({
          where: { id: userId },
          data: { isActive: false },
          select: { id: true, isActive: true },
        }),
      ),
    );
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
   * Admin-triggered — issues a reset link, never sets or reveals a
   * password directly. Portal-linked targets (applicantId/brokerId set)
   * reuse the existing self-service PortalPasswordReset model and its
   * existing confirm endpoint unchanged; staff targets use the new
   * PasswordReset model + AuthController's confirm endpoint (staff had no
   * reset-link mechanism at all before this). Sent synchronously, not via
   * the queue — unlike self-service requestPasswordReset, there's no
   * identifier-guessing/timing concern here: the admin already knows this
   * is a real user by id.
   */
  async forcePasswordReset(companyId: string, userId: string, adminUserId: string): Promise<void> {
    const user = await this.systemPrisma.user.findFirst({ where: { id: userId, companyId } });
    if (!user) throw new NotFoundException('User not found');

    const raw = randomUUID();
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(Date.now() + RESET_EXPIRY_MS);

    if (user.applicantId || user.brokerId) {
      await this.systemPrisma.portalPasswordReset.create({
        data: { companyId, userId, tokenHash, expiresAt },
      });
    } else {
      await this.systemPrisma.passwordReset.create({
        data: { companyId, userId, tokenHash, expiresAt, createdById: adminUserId },
      });
    }

    const toAddress = user.email ?? user.phone;
    if (!toAddress) return;

    await this.provider.send({
      channel: user.email ? 'EMAIL' : 'SMS',
      toAddress,
      subject: 'Your OpenEstate password has been reset by an administrator',
      body: `Use this code to set a new password: ${raw} (valid for 30 minutes). If you didn't expect this, contact your administrator.`,
    });
  }
}
