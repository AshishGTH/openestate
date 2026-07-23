import { BadRequestException, Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { PortalReadThrottlerGuard } from '../portal-auth/portal-throttler.guard';
import { PortalBrokerDashboardService } from './portal-broker-dashboard.service';

@ApiTags('Portal Broker Dashboard')
@Controller('portal/broker/dashboard')
@UseGuards(PortalReadThrottlerGuard)
export class PortalBrokerDashboardController {
  constructor(private readonly dashboard: PortalBrokerDashboardService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.REPORTS_BROKER_VIEW)
  @ApiOperation({ summary: 'Commission summary, sold-units count, and pending NOC count for the logged-in broker' })
  async getDashboard(@Req() req: Request) {
    const user = req.user as JwtPayload;
    if (!user.brokerId) throw new BadRequestException('Not a broker portal session');
    return this.dashboard.getDashboard(user.companyId, user.brokerId);
  }
}
