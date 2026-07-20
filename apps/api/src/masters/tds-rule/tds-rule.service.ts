import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../../database/database.module';
import type {
  CreateTdsRuleDto,
  UpdateTdsRuleDto,
  PaginationQuery,
} from '@openestate/shared';

@Injectable()
export class TdsRuleService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async findAll(companyId: string, query: PaginationQuery) {
    const { page, limit, search, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId };
    if (search) {
      where.OR = [
        { section: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.systemPrisma.tdsRule.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { sortOrder: 'asc' },
      }),
      this.systemPrisma.tdsRule.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(companyId: string, id: string) {
    const item = await this.systemPrisma.tdsRule.findFirst({
      where: { id, companyId },
    });
    if (!item) throw new NotFoundException('TDS rule not found');
    return item;
  }

  async create(companyId: string, dto: CreateTdsRuleDto) {
    await this.validateNoOverlap(
      companyId,
      dto.section,
      dto.effectiveFrom,
      dto.effectiveTo,
    );

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.tdsRule.create({
          data: { ...dto, companyId },
        }),
      ),
    );
  }

  async update(companyId: string, id: string, dto: UpdateTdsRuleDto) {
    const existing = await this.findOne(companyId, id);

    const section = dto.section ?? existing.section;
    const from = dto.effectiveFrom ?? existing.effectiveFrom;
    const to = dto.effectiveTo ?? existing.effectiveTo;
    await this.validateNoOverlap(companyId, section, from, to, id);

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.tdsRule.update({ where: { id }, data: dto }),
      ),
    );
  }

  async remove(companyId: string, id: string) {
    await this.findOne(companyId, id);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.tdsRule.delete({ where: { id } }),
      ),
    );
  }

  private async validateNoOverlap(
    companyId: string,
    section: string,
    from: Date,
    to: Date | null | undefined,
    excludeId?: string,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
      companyId,
      section,
      isActive: true,
      effectiveFrom: { lte: to ?? new Date('9999-12-31') },
      OR: [
        { effectiveTo: null },
        { effectiveTo: { gte: from } },
      ],
    };

    if (excludeId) {
      where.id = { not: excludeId };
    }

    const overlap = await this.systemPrisma.tdsRule.findFirst({ where });
    if (overlap) {
      throw new BadRequestException(
        `Date range overlaps with existing TDS rule for section "${overlap.section}" (${overlap.effectiveFrom.toISOString().slice(0, 10)} – ${overlap.effectiveTo?.toISOString().slice(0, 10) ?? 'open'})`,
      );
    }
  }
}
