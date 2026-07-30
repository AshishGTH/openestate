import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../../database/database.module';
import type {
  CreateLetterTemplateDto,
  UpdateLetterTemplateDto,
  PaginationQuery,
} from '@openestate/shared';

@Injectable()
export class LetterTemplateService {
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
    if (search) where.name = { contains: search, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      this.systemPrisma.letterTemplate.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { sortOrder: 'asc' },
      }),
      this.systemPrisma.letterTemplate.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(companyId: string, id: string) {
    const item = await this.systemPrisma.letterTemplate.findFirst({ where: { id, companyId } });
    if (!item) throw new NotFoundException('Letter template not found');
    return item;
  }

  async create(companyId: string, dto: CreateLetterTemplateDto) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.letterTemplate.create({ data: { ...dto, companyId } }),
      ),
    );
  }

  async update(companyId: string, id: string, dto: UpdateLetterTemplateDto) {
    await this.findOne(companyId, id);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.letterTemplate.update({ where: { id }, data: dto }),
      ),
    );
  }

  async remove(companyId: string, id: string) {
    await this.findOne(companyId, id);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) => tx.letterTemplate.delete({ where: { id } })),
    );
  }
}
