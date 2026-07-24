import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { PrismaClient } from '@openestate/db';
import type { BulkRetryDeliveriesDto } from '@openestate/shared';
import { SYSTEM_PRISMA } from '../database/database.module';
import { WEBHOOK_QUEUE } from '../queues/queues.module';

/** Amplification-path guard (addendum A4): an oversized payload stored
 * once and retried up to 6 times, times however many endpoints subscribe
 * to the event, is a real cost multiplier. Rejected at write time, not
 * silently truncated (a truncated webhook payload is worse than none). */
const MAX_PAYLOAD_BYTES = 256 * 1024;

const RETRY_OPTS = { attempts: 6, backoff: { type: 'exponential' as const, delay: 30_000 } };

@Injectable()
export class WebhookDeliveryService {
  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: PrismaClient,
    @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * The generic event-dispatch entry point — any domain service can call
   * this to fan an event out to every active, subscribed endpoint. No
   * specific booking/receipt/etc. call sites are wired to it in this
   * phase (deliberate scope boundary — see CLAUDE.md Phase 7 commit 2
   * decisions); this method is the mechanism, exercised directly by
   * tests and available for a future phase to wire real triggers into.
   */
  async dispatchEvent(companyId: string, eventType: string, payload: unknown): Promise<{ dispatchedTo: number }> {
    const payloadJson = JSON.stringify(payload);
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new BadRequestException(`Webhook event payload exceeds the ${MAX_PAYLOAD_BYTES} byte cap`);
    }

    const endpoints = await this.systemPrisma.webhookEndpoint.findMany({
      where: { companyId, isActive: true, eventTypes: { has: eventType } },
    });

    for (const endpoint of endpoints) {
      const delivery = await this.systemPrisma.webhookDelivery.create({
        data: { companyId, webhookEndpointId: endpoint.id, eventType, payload: payload as never, status: 'PENDING' },
      });
      // Redis I/O happens after the row commits — no external I/O inside a transaction (CLAUDE.md standing rule).
      await this.queue.add('deliver', { companyId, webhookDeliveryId: delivery.id }, RETRY_OPTS);
    }
    return { dispatchedTo: endpoints.length };
  }

  /** Admin "send test event" — delivers directly to ONE endpoint,
   * bypassing its own eventTypes subscription filter (the whole point of
   * a test button is "prove this endpoint is reachable," independent of
   * what event types it's configured to care about). Same retry/signing/
   * attempt-logging path as a real event — this is not a fire-and-forget
   * ping, it goes through the exact same WebhookDeliveryProcessor. */
  async sendTestEvent(companyId: string, webhookEndpointId: string): Promise<{ deliveryId: string }> {
    const endpoint = await this.systemPrisma.webhookEndpoint.findFirst({ where: { id: webhookEndpointId, companyId } });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');

    const delivery = await this.systemPrisma.webhookDelivery.create({
      data: {
        companyId,
        webhookEndpointId: endpoint.id,
        eventType: 'test.ping',
        payload: { message: 'This is a test event from OpenEstate', sentAt: new Date().toISOString() },
        status: 'PENDING',
      },
    });
    await this.queue.add('deliver', { companyId, webhookDeliveryId: delivery.id }, RETRY_OPTS);
    return { deliveryId: delivery.id };
  }

  async listForEndpoint(companyId: string, webhookEndpointId: string) {
    return this.systemPrisma.webhookDelivery.findMany({
      where: { companyId, webhookEndpointId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async getAttempts(companyId: string, deliveryId: string) {
    const delivery = await this.systemPrisma.webhookDelivery.findFirst({ where: { id: deliveryId, companyId } });
    if (!delivery) throw new NotFoundException('Webhook delivery not found');
    return this.systemPrisma.webhookDeliveryAttempt.findMany({
      where: { companyId, webhookDeliveryId: deliveryId },
      orderBy: { attemptNumber: 'asc' },
    });
  }

  /** Addendum A4: re-enqueues a FRESH job for the same delivery row — a
   * new BullMQ job gets its own fresh 6-attempt budget; the attempt log
   * (WebhookDeliveryAttempt) keeps appending, nothing is reset. Only an
   * EXHAUSTED delivery can be replayed — PENDING is already in-flight,
   * SUCCESS needs no replay. */
  async retry(companyId: string, deliveryId: string): Promise<{ id: string; requeued: boolean }> {
    const delivery = await this.systemPrisma.webhookDelivery.findFirst({ where: { id: deliveryId, companyId } });
    if (!delivery) throw new NotFoundException('Webhook delivery not found');
    if (delivery.status !== 'EXHAUSTED') {
      throw new BadRequestException(`Only an EXHAUSTED delivery can be retried (current status: ${delivery.status})`);
    }

    await this.systemPrisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'PENDING', completedAt: null } });
    await this.queue.add('deliver', { companyId, webhookDeliveryId: deliveryId }, RETRY_OPTS);
    return { id: deliveryId, requeued: true };
  }

  async bulkRetry(companyId: string, filter: BulkRetryDeliveriesDto): Promise<{ requeuedCount: number }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId, status: 'EXHAUSTED' };
    if (filter.webhookEndpointId) where.webhookEndpointId = filter.webhookEndpointId;
    if (filter.from || filter.to) {
      where.createdAt = {};
      if (filter.from) where.createdAt.gte = filter.from;
      if (filter.to) where.createdAt.lte = filter.to;
    }

    const matches = await this.systemPrisma.webhookDelivery.findMany({ where, select: { id: true } });
    for (const { id } of matches) {
      await this.systemPrisma.webhookDelivery.update({ where: { id }, data: { status: 'PENDING', completedAt: null } });
      await this.queue.add('deliver', { companyId, webhookDeliveryId: id }, RETRY_OPTS);
    }
    return { requeuedCount: matches.length };
  }
}
