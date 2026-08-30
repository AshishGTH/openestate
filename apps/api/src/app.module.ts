import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
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
import { NotificationModule } from './notifications/notification.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { DefaultThrottlerGuard } from './auth/guards/default-throttler.guard';
import { TenantContextInterceptor } from './auth/interceptors/tenant-context.interceptor';
import { PermissionsGuard } from './auth/guards/permissions.guard';
import { CsrfGuard } from './auth/csrf.guard';
import { RedisThrottlerStorage } from './common/redis-throttler-storage';
import { PortalAuthModule } from './portal-auth/portal-auth.module';
import { CustomerPortalModule } from './customer-portal/customer-portal.module';
import { BrokersPortalModule } from './brokers-portal/brokers-portal.module';
import { PluginsModule } from './plugins/plugins.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { LeadsModule } from './leads/leads.module';
import { DashboardModule } from './dashboard/dashboard.module';
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
    // Single, application-wide registration of every named throttler
    // bucket (the unnamed/'default' staff bucket, plus PortalAuthModule's
    // 'portal-auth'/'portal-read' buckets) — see DefaultThrottlerGuard's
    // doc comment for why there must be exactly ONE ThrottlerModule.forRoot()
    // call anywhere in this app's module graph: @nestjs/throttler's
    // ThrottlerModule is @Global(), so a SECOND forRoot() call (as
    // PortalAuthModule's own used to be) creates a second, competing
    // global THROTTLER_OPTIONS registration — which of the two "wins" for
    // any given consumer is compile-order-dependent, not something to
    // rely on (empirically proven flaky by a real bug this fixes: the
    // portal-read rate-limit test intermittently either leaked the tiny
    // portal-auth bucket onto every staff/portal-read route, or caused
    // PortalAuthThrottlerGuard's own bucket to silently stop enforcing).
    ThrottlerModule.forRootAsync({
      // Phase 8: Redis-backed, not @nestjs/throttler's in-memory default
      // (closes the Phase 1/6/7 docs/todo.md gap — rate-limit state now
      // survives a restart and is shared across replicas, for all four
      // buckets below at once since they share this one registration).
      // See RedisThrottlerStorage's own doc comment for why this is
      // hand-rolled on the existing ioredis dependency rather than a new
      // package.
      //
      // forRootAsync + useFactory, NOT forRoot's plain `storage: new
      // RedisThrottlerStorage()` — a plain value is only constructed ONCE,
      // at @Module({imports:[...]}) decorator-evaluation time, which Node
      // caches on the module (require('../dist/app.module') resolves to
      // the SAME AppModule class, and therefore the SAME storage instance
      // and its ONE ioredis connection, across every NestFactory.create()
      // call in a process — real bug, caught by this phase's own e2e test:
      // closing one app instance ran RedisThrottlerStorage's
      // onApplicationShutdown() and disconnected the ioredis client that
      // every OTHER already-running or later-created app instance in the
      // same process also depended on, throwing "Connection is closed" on
      // their very next throttled request. useFactory runs fresh at
      // application-bootstrap time (once per NestFactory.create() call,
      // via that app's own DI container), giving each app instance its
      // own RedisThrottlerStorage and its own connection — the correct
      // ownership boundary regardless of the test-only symptom that
      // surfaced it.
      useFactory: () => ({
        storage: new RedisThrottlerStorage(),
        throttlers: [
          // Default bucket for every route that doesn't opt into a named
          // one (staff auth, most reads/writes). 100/60s is the production
          // baseline that protects against unauthenticated scraping/
          // brute-force volume per IP. Overridable via
          // DEFAULT_THROTTLE_LIMIT specifically for the apps/e2e harness,
          // where 4 parallel Playwright workers all originate from the
          // one runner IP and legitimately exceed 100 requests/minute in
          // combined normal traffic (each spec's login + AuthProvider
          // mount refresh + AppShell banners' company-config/zero-gst
          // reads + whatever data the spec actually exercises); production
          // deployments never set this and continue at 100. See CLAUDE.md
          // Decisions log ("E2E refresh-rotation cascade") for the trace
          // evidence — 4 of 5 residual failing specs after the cascade
          // fix hit 429s on /auth/refresh, blocking the client's own
          // 401-retry from ever getting a fresh token.
          { ttl: 60_000, limit: Number(process.env.DEFAULT_THROTTLE_LIMIT ?? 100) },
          { name: 'portal-auth', ttl: 300_000, limit: 5 },
          { name: 'portal-read', ttl: 60_000, limit: 60 },
          // Password-change/reset-confirm across staff and portal — see
          // PasswordChangeThrottlerGuard's doc comment for why one bucket
          // covers all three routes.
          { name: 'password-change', ttl: 300_000, limit: 5 },
          // Phase 7 commit 2: per-API-key limit, not a global constant —
          // the resolver reads the LeadApiKeyGuard-populated
          // req.leadApiKey (that guard runs first in the route's guard
          // chain). Falls back to 60 for any request that somehow reaches
          // here without a resolved key (defense-in-depth; LeadApiKeyGuard
          // already rejects those with a 401 before this throttler would
          // matter).
          {
            name: 'lead-inbound',
            ttl: 60_000,
            limit: (context) => context.switchToHttp().getRequest().leadApiKey?.rateLimitPerMinute ?? 60,
          },
        ],
      }),
    }),
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
    NotificationModule,
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
    PluginsModule,
    WebhooksModule,
    LeadsModule,
    DashboardModule,
  ],
  providers: [
    // Filtered to the unnamed/'default' bucket only — see
    // DefaultThrottlerGuard's doc comment for the real bug (Phase 6
    // commit 4) this fixes: ThrottlerModule is @Global(), so the plain
    // ThrottlerGuard class would otherwise pick up PortalAuthModule's
    // 'portal-auth'/'portal-read' buckets too and enforce them on every
    // route in the app, including staff routes.
    { provide: APP_GUARD, useClass: DefaultThrottlerGuard },
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
