import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { MastersModule } from './masters/masters.module';
import { CustomFieldsModule } from './custom-fields/custom-fields.module';
import { CompanyModule } from './company/company.module';
import { AuditModule } from './audit/audit.module';
import { InventoryModule } from './inventory/inventory.module';
import { PresalesModule } from './presales/presales.module';
import { PostsalesModule } from './postsales/postsales.module';
import { PdfModule } from './pdf/pdf.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { PostsalesReportsModule } from './reports/postsales-reports.module';
import { BrokerReportsModule } from './reports/broker-reports.module';
import { BrokersModule } from './brokers/brokers.module';
import { CommissionModule } from './commission/commission.module';
import { QueuesModule } from './queues/queues.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { TenantContextInterceptor } from './auth/interceptors/tenant-context.interceptor';
import { PermissionsGuard } from './auth/guards/permissions.guard';
import { CsrfGuard } from './auth/csrf.guard';
import { PortalAuthModule } from './portal-auth/portal-auth.module';
import { CustomerPortalModule } from './customer-portal/customer-portal.module';
import { BrokersPortalModule } from './brokers-portal/brokers-portal.module';
import { LOG_REDACTION_PATHS } from './common/logger/redaction';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: { paths: LOG_REDACTION_PATHS, censor: '[REDACTED]' },
        autoLogging: true,
      },
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 100,
      },
    ]),
    DatabaseModule,
    HealthModule,
    AuthModule,
    UsersModule,
    RolesModule,
    MastersModule,
    CustomFieldsModule,
    CompanyModule,
    AuditModule,
    QueuesModule,
    InventoryModule,
    PresalesModule,
    PostsalesModule,
    PdfModule,
    DispatchModule,
    PostsalesReportsModule,
    BrokerReportsModule,
    BrokersModule,
    CommissionModule,
    PortalAuthModule,
    CustomerPortalModule,
    BrokersPortalModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Establishes ambient tenant/portal context for the rest of the
    // request. Runs as a global INTERCEPTOR, not a guard — Nest's fixed
    // pipeline order is middleware → guards → interceptors → pipes →
    // handler, so interceptors always run after every guard regardless
    // of registration order, guaranteeing req.user (set by JwtAuthGuard)
    // is populated here. See TenantContextInterceptor's doc comment and
    // CLAUDE.md Phase 6 commit 2 decisions for why this replaced both
    // Express middleware (ran before guards — req.user never existed)
    // AND a first attempt at a Guard using enterWith (context was lost
    // across prisma.$transaction()'s internal async boundary).
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
export class AppModule {}
