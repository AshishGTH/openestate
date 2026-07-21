import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { allocate, type CreatePaymentPlanDto, type InstallmentInput } from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

@Injectable()
export class PaymentPlanService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  /** Instantiate a plan from a template's milestones (percent → allocated amounts). */
  async instantiateFromTemplate(
    companyId: string,
    bookingId: string,
    templateId: string,
    actorId: string | null,
  ) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const booking = await this.loadBookingForPlan(tx, companyId, bookingId);
        const template = await tx.paymentPlanTemplate.findFirst({
          where: { id: templateId, companyId },
          include: { milestones: { orderBy: { seq: 'asc' } } },
        });
        if (!template) throw new NotFoundException('Payment plan template not found');
        if (template.milestones.length === 0) {
          throw new BadRequestException('Template has no milestones');
        }

        await this.deactivateExistingPlans(tx, companyId, bookingId);

        const weights = template.milestones.map((m: { percent: Prisma.Decimal }) =>
          BigInt(Math.round(Number(m.percent) * 1000)),
        );
        const amounts = allocate(booking.agreedPricePaise, weights);

        const plan = await tx.paymentPlan.create({
          data: { companyId, bookingId, templateId, name: template.name, isCustom: false, version: 1, createdById: actorId },
        });

        for (let i = 0; i < template.milestones.length; i++) {
          const m = template.milestones[i];
          await tx.installment.create({
            data: {
              companyId,
              bookingId,
              planId: plan.id,
              seq: m.seq,
              label: m.label,
              dueDate: addDays(booking.bookingDate, m.dueOffsetDays),
              amountPaise: amounts[i],
              milestonePercent: m.percent,
            },
          });
        }

        return this.loadActivePlanInTx(tx, companyId, bookingId);
      }),
    );
  }

  /** Instantiate a custom plan (explicit amounts, or percents allocated over the price). */
  async createCustomPlan(
    companyId: string,
    bookingId: string,
    dto: CreatePaymentPlanDto,
    actorId: string | null,
  ) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const booking = await this.loadBookingForPlan(tx, companyId, bookingId);
        await this.deactivateExistingPlans(tx, companyId, bookingId);

        const amounts = this.resolveAmounts(dto.installments, booking.agreedPricePaise);

        const plan = await tx.paymentPlan.create({
          data: { companyId, bookingId, name: dto.name, isCustom: true, version: 1, createdById: actorId },
        });

        for (let i = 0; i < dto.installments.length; i++) {
          const inst = dto.installments[i];
          await tx.installment.create({
            data: {
              companyId,
              bookingId,
              planId: plan.id,
              seq: i + 1,
              label: inst.label,
              dueDate: inst.dueDate,
              amountPaise: amounts[i],
              milestonePercent: inst.milestonePercent ?? null,
            },
          });
        }

        return this.loadActivePlanInTx(tx, companyId, bookingId);
      }),
    );
  }

  /**
   * Edit the schedule mid-way. Installments that have ANY allocation
   * (allocatedPaise > 0) are FROZEN and untouched; only strictly-unpaid
   * installments are replaced by the new ones. The new installments must
   * cover exactly the residual (agreed price − Σ frozen amounts) so the
   * schedule always still sums to the agreed price.
   */
  async editPlan(
    companyId: string,
    bookingId: string,
    installments: InstallmentInput[],
    _actorId: string | null,
  ) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const booking = await this.loadBookingForPlan(tx, companyId, bookingId);
        const plan = await tx.paymentPlan.findFirst({
          where: { companyId, bookingId, isActive: true },
          include: { installments: true },
        });
        if (!plan) throw new NotFoundException('No active payment plan to edit');

        const frozen = plan.installments.filter((i: { allocatedPaise: bigint }) => i.allocatedPaise > 0n);
        const unpaid = plan.installments.filter((i: { allocatedPaise: bigint }) => i.allocatedPaise === 0n);

        const frozenSum = frozen.reduce((s: bigint, i: { amountPaise: bigint }) => s + i.amountPaise, 0n);
        const residual = booking.agreedPricePaise - frozenSum;
        if (residual < 0n) {
          throw new BadRequestException('Frozen installments already exceed the agreed price');
        }

        const amounts = this.resolveAmounts(installments, residual);

        // Remove strictly-unpaid installments (no allocations → no ledger impact).
        await tx.installment.deleteMany({
          where: { id: { in: unpaid.map((i: { id: string }) => i.id) } },
        });

        const maxFrozenSeq = frozen.reduce((mx: number, i: { seq: number }) => Math.max(mx, i.seq), 0);
        for (let i = 0; i < installments.length; i++) {
          const inst = installments[i];
          await tx.installment.create({
            data: {
              companyId,
              bookingId,
              planId: plan.id,
              seq: maxFrozenSeq + i + 1,
              label: inst.label,
              dueDate: inst.dueDate,
              amountPaise: amounts[i],
              milestonePercent: inst.milestonePercent ?? null,
            },
          });
        }

        await tx.paymentPlan.update({ where: { id: plan.id }, data: { version: { increment: 1 } } });

        return this.loadActivePlanInTx(tx, companyId, bookingId);
      }),
    );
  }

  async getActivePlan(companyId: string, bookingId: string) {
    const plan = await this.systemPrisma.paymentPlan.findFirst({
      where: { companyId, bookingId, isActive: true },
      include: { installments: { orderBy: { seq: 'asc' } } },
    });
    if (!plan) throw new NotFoundException('No active payment plan');
    return plan;
  }

  /** Read the active plan within the current transaction (uncommitted rows visible). */
  private async loadActivePlanInTx(
    tx: Prisma.TransactionClient,
    companyId: string,
    bookingId: string,
  ) {
    const plan = await tx.paymentPlan.findFirst({
      where: { companyId, bookingId, isActive: true },
      include: { installments: { orderBy: { seq: 'asc' } } },
    });
    if (!plan) throw new NotFoundException('No active payment plan');
    return plan;
  }

  // ── helpers ──

  private resolveAmounts(installments: InstallmentInput[], total: bigint): bigint[] {
    const anyPercent = installments.some((i) => i.milestonePercent != null);
    const anyAmount = installments.some((i) => i.amountPaise != null);
    if (anyPercent && anyAmount) {
      throw new BadRequestException('Use either amounts or percents for all installments, not a mix');
    }
    if (anyPercent) {
      const weights = installments.map((i) => BigInt(Math.round((i.milestonePercent as number) * 1000)));
      return allocate(total, weights);
    }
    const amounts = installments.map((i) => i.amountPaise as bigint);
    const sum = amounts.reduce((s, a) => s + a, 0n);
    if (sum !== total) {
      throw new BadRequestException(
        `Installment amounts (${sum}) must sum to the amount to schedule (${total})`,
      );
    }
    return amounts;
  }

  private async deactivateExistingPlans(
    tx: Prisma.TransactionClient,
    companyId: string,
    bookingId: string,
  ) {
    const existing = await tx.paymentPlan.findMany({
      where: { companyId, bookingId, isActive: true },
      include: { installments: true },
    });
    for (const p of existing) {
      const hasAllocations = p.installments.some((i: { allocatedPaise: bigint }) => i.allocatedPaise > 0n);
      if (hasAllocations) {
        throw new BadRequestException(
          'Cannot replace a plan that already has paid installments; edit it instead',
        );
      }
      await tx.installment.deleteMany({ where: { planId: p.id } });
      await tx.paymentPlan.update({ where: { id: p.id }, data: { isActive: false } });
    }
  }

  private async loadBookingForPlan(
    tx: Prisma.TransactionClient,
    companyId: string,
    bookingId: string,
  ): Promise<{ id: string; agreedPricePaise: bigint; bookingDate: Date }> {
    const booking = await tx.booking.findFirst({ where: { id: bookingId, companyId } });
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }
}
