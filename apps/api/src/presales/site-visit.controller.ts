import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { siteVisitListQuerySchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { FollowUpService } from './follow-up.service';
import { TeamScopeService } from '../team-scope/team-scope.service';

class SiteVisitListQueryDto extends createZodDto(siteVisitListQuerySchema) {}

@ApiTags('Site Visits')
@Controller('site-visits')
export class SiteVisitController {
  constructor(
    private readonly followUpService: FollowUpService,
    private readonly teamScope: TeamScopeService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PRESALES_SITE_VISIT_READ)
  @ApiOperation({ summary: "List scheduled site visits (follow-ups of a type flagged is_site_visit) on leads in the caller's visible team" })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive lower bound on scheduledAt. ISO 8601 instant WITH offset; date-only/offset-less is a 400.' })
  @ApiQuery({ name: 'to', required: false, description: 'Exclusive upper bound on scheduledAt. Same format; must be later than from.' })
  @ApiQuery({ name: 'state', required: false, enum: ['scheduled', 'awaiting_outcome', 'outcome_recorded'] })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'], description: 'Order by scheduledAt. Default asc.' })
  @ApiQuery({ name: 'assignedTo', required: false, description: '"me" or a user id inside the caller\'s visible team (404 otherwise).' })
  async list(@Query() query: SiteVisitListQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    const visibleUserIds = await this.teamScope.getVisibleUserIds(user.companyId, user.sub, user.permissions);
    return this.followUpService.listSiteVisits(user.companyId, query, { visibleUserIds }, user.sub);
  }
}
