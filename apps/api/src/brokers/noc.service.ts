import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { NOC_STATUS, type RequestNocDto, type RejectNocDto } from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';

/**
 * REQUESTED -> APPROVED | REJECTED, mirroring RefundStatus's shape
 * (apps/api/src/postsales/refund.service.ts, frozen — used only as a
 * design template, never imported). request()/approve()/reject() are the
 * staff-facing endpoints, each its own withTenantTx — same independence as
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

  async request(companyId: string, bookingId: string, dto: RequestNocDto, actorId: string | null) {
    const booking = await this.systemPrisma.booking.findFirst({ where: { id: bookingId, companyId } });
    if (!booking) throw new NotFoundException('Booking not found');
    const brokerId: string | null = booking.brokerId;
    if (!brokerId) throw new BadRequestException('Booking has no sourcing broker');

    return runWithTenant({ companyId }, () =>
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
    return runWithTenant({ companyId }, () =>
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
    return runWithTenant({ companyId }, () =>
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
