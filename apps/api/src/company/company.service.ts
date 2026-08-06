import { Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import {
  DEFAULT_LABEL_OVERRIDES,
  type UpdateCompanyDto,
  type UpdateCompanyConfigDto,
} from '@openestate/shared';

@Injectable()
export class CompanyService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CompanyService.name);

  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  /**
   * Warn, don't fail, at boot: a company with an incomplete GST config
   * doesn't stop the app from starting (other companies, and non-GST
   * work, must keep functioning), but isIntraStateSupply() now throws
   * the moment that company actually tries to book or add a charge — an
   * admin should find out from the log the moment the app comes up, not
   * from a locked-out sales team days later. See CLAUDE.md's "v0.2.0 —
   * upgrade-path permission delivery" entry for why this was never
   * caught before: gstStateCode/companyGstin were added nullable, no
   * default, so every company that existed before that migration has
   * been silently getting intra-state GST ever since.
   *
   * Wrapped in try/catch deliberately: NestJS does not call app.listen()
   * until every OnApplicationBootstrap hook resolves, so an unhandled
   * rejection here — e.g. the DB not yet accepting connections the
   * instant this fires, a real failure mode under docker-compose's
   * healthcheck-based startup ordering — would take the ENTIRE app down
   * before it ever starts listening. A boot-time diagnostic must never
   * be able to do that; log and move on.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const companies = await this.systemPrisma.company.findMany({
        select: { id: true, name: true, config: { select: { companyGstin: true, gstStateCode: true } } },
      });
      const incomplete = companies.filter((c) => !c.config?.gstStateCode || !c.config?.companyGstin);
      if (incomplete.length > 0) {
        this.logger.warn(
          `${incomplete.length} of ${companies.length} companies have incomplete GST config ` +
            '(missing companyGstin and/or gstStateCode) — bookings and extra charges will be ' +
            `rejected until Company Config is completed for: ${incomplete
              .map((c) => `${c.name} (${c.id})`)
              .join(', ')}`,
        );
      }
    } catch (e) {
      this.logger.warn(`GST config completeness check failed at boot (non-fatal): ${(e as Error).message}`);
    }
  }

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
