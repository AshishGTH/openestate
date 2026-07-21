import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
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
import { QueuesModule } from './queues/queues.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './auth/guards/permissions.guard';
import { CsrfGuard } from './auth/csrf.guard';
import { TenantMiddleware } from './auth/tenant.middleware';
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
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
