import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runScoped } from '@openestate/db';
import { NOC_STATUS, type RequestNocDto, type RejectNocDto } from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';

/**
 * REQUESTED -> APPROVED | REJECTED, mirroring RefundStatus's shape
 * (apps/api/src/postsales/refund.service.ts, frozen — used only as a
 * design template, never imported). request() is staff-only;
 * approve()/reject() are shared by the staff NocController (Phase 5) AND
 * the broker portal (Phase 6 commit 3, see @openestate/db's runScoped()
 * doc comment for why that reuse needed a context-shadowing fix — this
 * was the first real call site to hit the bug; runScoped() has since
 * been promoted to the shared db package, Phase 6 commit 4, so future
 * dual-purpose services reuse one implementation instead of
 * reinventing it). Each is its own withTenantTx — same independence as
 * RefundService.request/.approve. assertApprovedOrAutoApprove() is the
 * gate consumed by BookingController.cancel() (commit 2): it takes an
 * ALREADY-OPEN tx so it joins that controller's outer transaction via
 * withTenantTx's same-companyId nesting-reuse (see CLAUDE.md Phase 5
 * decisions) rather than opening its own.
 */
@Injectable()
export class NocService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async findForBooking(companyId: string, bookingId: string) {
    return this.systemPrisma.brokerNoc.findMany({ where: { companyId, bookingId }, orderBy: { createdAt: 'desc' } });
  }

  /**
   * Portal-facing (Phase 6 commit 3): every NOC for the ambient broker,
   * not scoped to one booking — used by the broker portal's NOC list.
   * Goes through TENANT_PRISMA/withTenantTx (not systemPrisma), so
   * PORTAL_SCOPED_MODELS' brokerId narrowing + RLS both apply, same
   * defense-in-depth as approve()/reject() below. BrokerNoc has no
   * Prisma relation to Booking (scalar-FK-only, see schema.prisma's own
   * comment on that model) — booking numbers are resolved with a
   * follow-up query, same pattern as BrokerReportsService.soldUnits.
   */
  async listForBroker(companyId: string, brokerId: string) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const nocs = await tx.brokerNoc.findMany({ where: { brokerId }, orderBy: { createdAt: 'desc' } });
      const bookingIds = [...new Set(nocs.map((n: { bookingId: string }) => n.bookingId))];
      const bookings = await tx.booking.findMany({
        where: { id: { in: bookingIds } },
        select: { id: true, bookingNumber: true },
      });
      const bookingNumbers = new Map(
        bookings.map((b: { id: string; bookingNumber: string }) => [b.id, b.bookingNumber]),
      );
      return nocs.map((n: { bookingId: string }) => ({
        ...n,
        bookingNumber: bookingNumbers.get(n.bookingId) ?? null,
      }));
    });
  }

  async request(companyId: string, bookingId: string, dto: RequestNocDto, actorId: string | null) {
    const booking = await this.systemPrisma.booking.findFirst({ where: { id: bookingId, companyId } });
    if (!booking) throw new NotFoundException('Booking not found');
    const brokerId: string | null = booking.brokerId;
    if (!brokerId) throw new BadRequestException('Booking has no sourcing broker');

    return runScoped(companyId, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.brokerNoc.create({
          data: {
            companyId,
            bookingId,
            brokerId,
            status: NOC_STATUS.REQUESTED,
            reason: dto.reason ?? null,
            requestedById: actorId,
          },
        }),
      ),
    );
  }

  async approve(companyId: string, nocId: string, actorId: string | null) {
    return runScoped(companyId, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const noc = await tx.brokerNoc.findFirst({ where: { id: nocId, companyId } });
        if (!noc) throw new NotFoundException('NOC not found');
        if (noc.status !== NOC_STATUS.REQUESTED) {
          throw new ConflictException(`NOC is ${noc.status}; only REQUESTED can be approved`);
        }
        return tx.brokerNoc.update({
          where: { id: nocId },
          data: { status: NOC_STATUS.APPROVED, approvedById: actorId, approvedAt: new Date() },
        });
      }),
    );
  }

  async reject(companyId: string, nocId: string, dto: RejectNocDto, actorId: string | null) {
    return runScoped(companyId, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const noc = await tx.brokerNoc.findFirst({ where: { id: nocId, companyId } });
        if (!noc) throw new NotFoundException('NOC not found');
        if (noc.status !== NOC_STATUS.REQUESTED) {
          throw new ConflictException(`NOC is ${noc.status}; only REQUESTED can be rejected`);
        }
        return tx.brokerNoc.update({
          where: { id: nocId },
          data: { status: NOC_STATUS.REJECTED, reason: dto.reason, approvedById: actorId, approvedAt: new Date() },
        });
      }),
    );
  }

  /**
   * Cancellation gate, called from inside BookingController.cancel()'s
   * outer transaction (tx already open). Throws BadRequestException unless
   * an APPROVED NOC already exists for this booking — UNLESS the broker is
   * inactive, in which case it auto-creates an already-APPROVED NOC with
   * reason "broker_inactive_auto_approved" (audited via the normal
   * AUDITED_MODELS wiring on BrokerNoc) and lets cancellation proceed.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async assertApprovedOrAutoApprove(tx: any, companyId: string, bookingId: string, brokerId: string, actorId: string | null): Promise<void> {
    const broker = await tx.broker.findFirst({ where: { id: brokerId, companyId } });
    if (broker && !broker.isActive) {
      const approved = await tx.brokerNoc.findFirst({ where: { companyId, bookingId, status: NOC_STATUS.APPROVED } });
      if (!approved) {
        await tx.brokerNoc.create({
          data: {
            companyId,
            bookingId,
            brokerId,
            status: NOC_STATUS.APPROVED,
            reason: 'broker_inactive_auto_approved',
            requestedById: actorId,
            approvedById: actorId,
            approvedAt: new Date(),
          },
        });
      }
      return;
    }

    const approved = await tx.brokerNoc.findFirst({ where: { companyId, bookingId, status: NOC_STATUS.APPROVED } });
    if (!approved) {
      throw new BadRequestException(
        'Cancellation is blocked: this booking has a sourcing broker and no APPROVED NOC exists. Request and approve an NOC first.',
      );
    }
  }
}
