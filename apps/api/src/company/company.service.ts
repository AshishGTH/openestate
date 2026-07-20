import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import {
  DEFAULT_LABEL_OVERRIDES,
  type UpdateCompanyDto,
  type UpdateCompanyConfigDto,
} from '@openestate/shared';

@Injectable()
export class CompanyService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async findOne(companyId: string) {
    const company = await this.systemPrisma.company.findUnique({
      where: { id: companyId },
    });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  async update(companyId: string, dto: UpdateCompanyDto) {
    await this.findOne(companyId);
    return this.systemPrisma.company.update({
      where: { id: companyId },
      data: dto,
    });
  }

  async getConfig(companyId: string) {
    const config = await this.systemPrisma.companyConfig.findUnique({
      where: { companyId },
    });
    if (!config) {
      return {
        companyId,
        labelOverrides: DEFAULT_LABEL_OVERRIDES,
        enabledModules: ['presales', 'postsales', 'accounts'],
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        fyStartMonth: 4,
        dateFormat: 'DD-MM-YYYY',
      };
    }
    return config;
  }

  async updateConfig(companyId: string, dto: UpdateCompanyConfigDto) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const existing = await this.systemPrisma.companyConfig.findUnique({
          where: { companyId },
        });

        if (existing) {
          return tx.companyConfig.update({
            where: { companyId },
            data: dto,
          });
        }

        return tx.companyConfig.create({
          data: {
            companyId,
            ...dto,
          },
        });
      }),
    );
  }

  async getTerminology(companyId: string): Promise<Record<string, string>> {
    const config = await this.getConfig(companyId);
    const overrides = (config.labelOverrides ?? {}) as Record<string, string>;
    return { ...DEFAULT_LABEL_OVERRIDES, ...overrides };
  }
}
