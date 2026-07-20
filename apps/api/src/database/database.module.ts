import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import {
  PrismaClient,
  createTenantPrismaClient,
  createSystemPrismaClient,
} from '@openestate/db';

export const TENANT_PRISMA = 'TENANT_PRISMA';
export const SYSTEM_PRISMA = 'SYSTEM_PRISMA';

@Global()
@Module({
  providers: [
    {
      provide: TENANT_PRISMA,
      useFactory: () => createTenantPrismaClient(),
    },
    {
      provide: SYSTEM_PRISMA,
      useFactory: () =>
        createSystemPrismaClient(
          process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL,
        ),
    },
  ],
  exports: [TENANT_PRISMA, SYSTEM_PRISMA],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async onModuleDestroy() {
    await (this.tenantPrisma as PrismaClient)?.$disconnect?.();
    await this.systemPrisma?.$disconnect?.();
  }
}
