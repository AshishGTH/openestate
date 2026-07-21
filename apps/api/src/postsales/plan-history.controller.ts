import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { PrismaClient } from '@openestate/db';
import { PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { SYSTEM_PRISMA } from '../database/database.module';

/**
 * Read-only plan version history for the installment schedule view. Every
 * plan edit creates a new PaymentPlan row (isActive flips on the old one) —
 * see the Phase 4 Decisions log — so this is a plain read over that
 * existing versioning, not a new capability on PaymentPlanService (frozen).
 */
@ApiTags('Bookings')
@Controller('bookings')
export class PlanHistoryController {
  constructor(
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  @Get(':id/plan-history')
  @RequirePermissions(PERMISSIONS.POSTSALES_PLAN_READ)
  @ApiOperation({ summary: 'All payment-plan versions for a booking, newest first' })
  async history(@Param('id') bookingId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.systemPrisma.paymentPlan.findMany({
      where: { companyId: u.companyId, bookingId },
      include: { installments: { orderBy: { seq: 'asc' } } },
      orderBy: { version: 'desc' },
    });
  }
}
