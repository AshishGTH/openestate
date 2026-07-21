import {
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import type {
  CreateTowerDto,
  UpdateTowerDto,
  PaginationQuery,
} from '@openestate/shared';

@Injectable()
export class TowerService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async findAll(companyId: string, projectId: string, query: PaginationQuery) {
    const { page, limit, search, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId, projectId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.systemPrisma.tower.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { code: 'asc' },
        include: { _count: { select: { floors: true } } },
      }),
      this.systemPrisma.tower.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(companyId: string, projectId: string, id: string) {
    const item = await this.systemPrisma.tower.findFirst({
      where: { id, companyId, projectId },
      include: {
        floors: {
          orderBy: { floorNumber: 'asc' },
          include: { _count: { select: { units: true } } },
        },
      },
    });
    if (!item) throw new NotFoundException('Tower not found');
    return item;
  }

  async create(companyId: string, projectId: string, dto: CreateTowerDto) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.tower.create({
          data: { ...dto, companyId, projectId },
        }),
      ),
    );
  }

  async update(companyId: string, projectId: string, id: string, dto: UpdateTowerDto) {
    await this.findOne(companyId, projectId, id);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.tower.update({ where: { id }, data: dto }),
      ),
    );
  }

  async remove(companyId: string, projectId: string, id: string) {
    await this.findOne(companyId, projectId, id);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.tower.delete({ where: { id } }),
      ),
    );
  }
}
