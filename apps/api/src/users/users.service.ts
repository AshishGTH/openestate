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
          role: { select: { id: true, name: true, slug: true } },
        },
      }),
      this.systemPrisma.user.count({ where }),
    ]);

    return {
      data,
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
            forcePasswordChange: true,
          },
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            createdAt: true,
          },
        }),
      ),
    );
  }

  async update(companyId: string, userId: string, dto: UpdateUserDto) {
    await this.findOne(companyId, userId);

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
            updatedAt: true,
            role: { select: { id: true, name: true, slug: true } },
          },
        }),
      ),
    );
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
