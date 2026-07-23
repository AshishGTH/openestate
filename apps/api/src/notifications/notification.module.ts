import { Global, Module } from '@nestjs/common';
import { NotificationService } from './notification.service';

/**
 * Global (like DatabaseModule/QueuesModule, whose SYSTEM_PRISMA and
 * COMMUNICATION_PROVIDER tokens this service consumes) so every module
 * that fires a notification (postsales, pdf, customer-portal,
 * commission) can inject NotificationService without adding a
 * module-to-module import for it specifically.
 */
@Global()
@Module({
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
