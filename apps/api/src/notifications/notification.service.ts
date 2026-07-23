import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@openestate/db';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationEventValue, type NotificationPrefs } from '@openestate/shared';
import { SYSTEM_PRISMA } from '../database/database.module';
import { COMMUNICATION_PROVIDER, type CommunicationProvider } from '../queues/communication-provider';

export interface NotifyRecipient {
  applicantId?: string;
  brokerId?: string;
}

/**
 * Phase 6 commit 4: the five portal notification events (receipt
 * confirmed, demand letter issued, construction update published, query
 * replied, commission paid) all funnel through here rather than through
 * CommunicationService/CommunicationLog — that model has a non-nullable
 * applicantId and NO brokerId column at all (Phase 3 schema), so it
 * cannot address a broker recipient (commission paid, and the broker
 * branch of query replied). This service instead calls
 * CommunicationProvider.send() directly (same "no persistent log row"
 * convention EscalationService already uses for its own notifications —
 * apps/api/src/presales/escalation.service.ts), keyed off the
 * recipient's portal User row (not the underlying Applicant/Broker
 * record), so notificationPrefs gating works uniformly for both portal
 * principal types.
 *
 * A portal User row is NOT guaranteed to exist for every
 * applicant/broker — most of this codebase's business events (a
 * receipt, a demand letter, a commission payment, ...) can fire for a
 * contact who was never invited to the portal at all. That is the
 * expected, common case here, not an error: no portal account means
 * silently do nothing, mirroring EscalationService's own `if
 * (!manager.email) continue;` defensive-skip precedent.
 *
 * Never throws — a failed or skipped notification must never fail the
 * business operation that triggered it. Errors are logged and
 * swallowed, same posture as EscalationService's per-recipient
 * try/catch.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    @Inject(COMMUNICATION_PROVIDER)
    private readonly provider: CommunicationProvider,
  ) {}

  async notify(
    companyId: string,
    event: NotificationEventValue,
    recipient: NotifyRecipient,
    subject: string,
    body: string,
  ): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let user: any = null;
      if (recipient.applicantId) {
        user = await this.systemPrisma.user.findFirst({
          where: { companyId, applicantId: recipient.applicantId },
        });
      } else if (recipient.brokerId) {
        user = await this.systemPrisma.user.findFirst({
          where: { companyId, brokerId: recipient.brokerId },
        });
      }
      if (!user) return; // no portal account for this contact — expected, not an error

      const stored = user.notificationPrefs as NotificationPrefs | null;
      const prefs = stored?.[event] ?? DEFAULT_NOTIFICATION_PREFS[event];

      if (prefs.email && user.email) {
        await this.provider.send({ channel: 'EMAIL', toAddress: user.email, subject, body });
      }
      if (prefs.sms && user.phone) {
        await this.provider.send({ channel: 'SMS', toAddress: user.phone, subject, body });
      }
    } catch (err) {
      this.logger.warn(`Notification ${event} for company ${companyId} failed: ${String(err)}`);
    }
  }
}
