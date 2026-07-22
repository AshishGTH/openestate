import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule } from '@nestjs/throttler';
import { PortalAuthController } from './portal-auth.controller';
import { PortalInviteAdminController } from './portal-invite-admin.controller';
import { PortalAuthService } from './portal-auth.service';
import { PortalPasswordResetProcessor } from './portal-password-reset.processor';
import { PortalAuthThrottlerGuard, PortalReadThrottlerGuard } from './portal-throttler.guard';
import { PORTAL_QUEUE } from '../queues/queues.module';
import { AuthModule } from '../auth/auth.module';

/**
 * Named throttlers scoped to THIS module only (not the root AppModule's
 * ThrottlerModule.forRoot, and not registered as an APP_GUARD) — see
 * PortalAuthThrottlerGuard's doc comment for why. Uses the package default
 * (in-memory) storage, same as the existing staff default bucket; a
 * Redis-backed ThrottlerStorage for both realms is docs/todo.md (CLAUDE.md
 * Phase 6 decisions) — introducing a new dependency + touching the frozen
 * staff throttler config is out of this phase's approved scope.
 */
@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue({ name: PORTAL_QUEUE }),
    ThrottlerModule.forRoot([
      { name: 'portal-auth', ttl: 300_000, limit: 5 },
      { name: 'portal-read', ttl: 60_000, limit: 60 },
    ]),
  ],
  controllers: [PortalAuthController, PortalInviteAdminController],
  providers: [
    PortalAuthService,
    PortalPasswordResetProcessor,
    PortalAuthThrottlerGuard,
    PortalReadThrottlerGuard,
  ],
  exports: [PortalAuthService, PortalReadThrottlerGuard],
})
export class PortalAuthModule {}
