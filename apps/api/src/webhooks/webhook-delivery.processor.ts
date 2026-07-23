import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import type { PrismaClient } from '@openestate/db';
import { signWebhookPayload } from '../common/webhook-signing';
import { SYSTEM_PRISMA } from '../database/database.module';
import { WEBHOOK_QUEUE } from '../queues/queues.module';
import { PluginSecretEncryptionService } from '../plugins/plugin-secret-encryption.service';

/** Auto-disable threshold (addendum A3) — a constant this phase, not yet
 * a per-company CompanyConfig value (documented as a future iteration in
 * the plan, same as CLAUDE.md's existing pattern for other not-yet-
 * configurable thresholds). */
export const WEBHOOK_DISABLE_THRESHOLD = 10;
const REQUEST_TIMEOUT_MS = 10_000;

interface DeliverJobData {
  companyId: string;
  webhookDeliveryId: string;
}

/**
 * Mirrors DispatchProcessor's shape: loads the delivery + endpoint,
 * POSTs (external I/O, never inside a transaction), records one
 * WebhookDeliveryAttempt per try. No SSRF guard on the target URL —
 * unlike a plugin's ctx.http (which might dispatch to a URL a PLUGIN
 * dynamically constructs), a WebhookEndpoint.url is staff-configured
 * admin input, the same trust level as e.g. a company's configured SMS
 * gateway URL — see CLAUDE.md Phase 7 decisions for the explicit
 * contrast with §2's ctx.http design.
 */
@Processor(WEBHOOK_QUEUE)
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: PrismaClient,
    private readonly secretEncryption: PluginSecretEncryptionService,
  ) {
    super();
  }

  async process(job: Job<DeliverJobData>): Promise<void> {
    if (job.name !== 'deliver') return;
    const { companyId, webhookDeliveryId } = job.data;

    const delivery = await this.systemPrisma.webhookDelivery.findFirst({ where: { id: webhookDeliveryId, companyId } });
    if (!delivery) return;

    const endpoint = await this.systemPrisma.webhookEndpoint.findFirst({ where: { id: delivery.webhookEndpointId, companyId } });
    // Endpoint was deleted or manually disabled since this delivery was
    // enqueued — no-op rather than attempting or erroring. This delivery
    // stays PENDING; a future admin action (replay/A4) can still move it.
    if (!endpoint || !endpoint.isActive) return;

    const secret = this.secretEncryption.decrypt(endpoint.secretCiphertext, endpoint.secretKeyVersion);
    const rawBody = JSON.stringify(delivery.payload);
    const timestampMs = Date.now();
    const signature = signWebhookPayload(secret, timestampMs, rawBody);

    const attemptNumber = (job.attemptsMade ?? 0) + 1;
    const startedAt = Date.now();
    let responseStatus: number | undefined;
    let responseSnippet: string | undefined;
    let errorMessage: string | undefined;
    let success = false;

    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenEstate-Signature': `sha256=${signature}`,
          'X-OpenEstate-Timestamp': String(timestampMs),
        },
        body: rawBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      responseStatus = res.status;
      const text = await res.text().catch(() => '');
      responseSnippet = text.slice(0, 1000);
      success = res.status >= 200 && res.status < 300;
      if (!success) errorMessage = `HTTP ${res.status}`;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    const latencyMs = Date.now() - startedAt;

    await this.systemPrisma.webhookDeliveryAttempt.create({
      data: { companyId, webhookDeliveryId, attemptNumber, responseStatus, responseSnippet, errorMessage, latencyMs },
    });
    await this.systemPrisma.webhookDelivery.update({ where: { id: webhookDeliveryId }, data: { attemptCount: { increment: 1 } } });

    if (success) {
      // Success-vs-exhaustion race rule (addendum A3): only resets the
      // counter if the endpoint is STILL active — a stray in-flight
      // success arriving after a concurrent failure-path disable simply
      // updates 0 rows; it never resurrects a disabled endpoint. Updated
      // BEFORE the delivery's own status flips to SUCCESS (not after) so
      // any observer that sees the terminal delivery status can rely on
      // the endpoint's counter already reflecting it — two sequential
      // awaits are never atomic together, so the ORDER decides which
      // side of that gap an observer can land on.
      await this.systemPrisma.$executeRawUnsafe(
        `UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = $1::uuid AND is_active = true`,
        endpoint.id,
      );
      await this.systemPrisma.webhookDelivery.update({ where: { id: webhookDeliveryId }, data: { status: 'SUCCESS', completedAt: new Date() } });
      return;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;
    if (!isLastAttempt) {
      // Not exhausted yet — record the failed attempt (already done above)
      // and rethrow so BullMQ schedules the next retry per its backoff.
      throw new Error(errorMessage ?? 'Webhook delivery failed');
    }

    // Atomic per-exhausted-DELIVERY increment (addendum A3) — a single
    // parameterized UPDATE with CASE WHEN clauses, RETURNING nothing
    // (callers don't need the post-state here; PluginAdminService-style
    // patterns that DO need it use RETURNING — this call site doesn't),
    // race-free under concurrent exhausted deliveries for the same
    // endpoint (Postgres row-level locking serializes it), same pattern
    // as Phase 6's invite wrong-attempt cap. Runs BEFORE the delivery's
    // own status flips to EXHAUSTED — same observability-ordering
    // reasoning as the success path above.
    await this.systemPrisma.$executeRawUnsafe(
      `UPDATE webhook_endpoints SET
         consecutive_failures = consecutive_failures + 1,
         is_active = CASE WHEN consecutive_failures + 1 >= $2 THEN false ELSE is_active END,
         disabled_at = CASE WHEN consecutive_failures + 1 >= $2 AND is_active THEN now() ELSE disabled_at END,
         disabled_reason = CASE WHEN consecutive_failures + 1 >= $2 AND is_active THEN $3 ELSE disabled_reason END
       WHERE id = $1::uuid`,
      endpoint.id,
      WEBHOOK_DISABLE_THRESHOLD,
      `Auto-disabled after ${WEBHOOK_DISABLE_THRESHOLD} consecutive exhausted deliveries`,
    );

    await this.systemPrisma.webhookDelivery.update({ where: { id: webhookDeliveryId }, data: { status: 'EXHAUSTED', completedAt: new Date() } });
    this.logger.warn(`Webhook delivery ${webhookDeliveryId} exhausted for endpoint ${endpoint.id} (company ${companyId})`);
  }
}
