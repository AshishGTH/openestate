import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PortalAuthController } from './portal-auth.controller';
import { PortalInviteAdminController } from './portal-invite-admin.controller';
import { PortalBrandingController } from './portal-branding.controller';
import { PortalAuthService } from './portal-auth.service';
import { PortalPasswordResetProcessor } from './portal-password-reset.processor';
import { PortalAuthThrottlerGuard, PortalReadThrottlerGuard } from './portal-throttler.guard';
import { PORTAL_QUEUE } from '../queues/queues.module';
import { AuthModule } from '../auth/auth.module';

/**
 * The 'portal-auth'/'portal-read' named throttler buckets these guards
 * filter themselves down to (see portal-throttler.guard.ts) are registered
 * in AppModule's single, application-wide `ThrottlerModule.forRoot()` call
 * — NOT a second one here. `@nestjs/throttler`'s `ThrottlerModule` is
 * `@Global()`, so a second `forRoot()` call in this module would create a
 * competing global registration (real bug, Phase 6 commit 4 — see
 * DefaultThrottlerGuard's doc comment). Neither guard is registered as an
 * `APP_GUARD` — both stay attached only via `@UseGuards()` on the specific
 * routes that need them, so staff routes are structurally unreachable by
 * either bucket.
 */
@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: PORTAL_QUEUE })],
  controllers: [PortalAuthController, PortalInviteAdminController, PortalBrandingController],
  providers: [
    PortalAuthService,
    PortalPasswordResetProcessor,
    PortalAuthThrottlerGuard,
    PortalReadThrottlerGuard,
  ],
  exports: [PortalAuthService, PortalReadThrottlerGuard],
})
export class PortalAuthModule {}
