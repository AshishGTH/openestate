import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { DashboardService } from './dashboard.service';

@ApiTags('Dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_READ)
  @ApiOperation({
    summary:
      "The caller's own work summary, plus their reporting subtree's if they have one (scoped by TeamScopeService)",
  })
  get(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.dashboardService.getDashboard(user.companyId, user.sub, user.roleSlug);
  }
}
