import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { inquiryActivityQuerySchema, PERMISSIONS, type InquiryActivityType } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { TeamScopeService } from '../team-scope/team-scope.service';
import { InquiryActivityService } from './inquiry-activity.service';

class InquiryActivityQueryDto extends createZodDto(inquiryActivityQuerySchema) {}

@ApiTags('Inquiries')
@Controller('inquiries/:id/activity')
export class InquiryActivityController {
  constructor(
    private readonly activity: InquiryActivityService,
    private readonly teamScope: TeamScopeService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_READ)
  @ApiOperation({ summary: "A lead's activity, newest first: follow-ups, stage changes, status changes, assignments (kinds the caller may read)" })
  @ApiQuery({ name: 'type', required: false, description: 'Comma-separated (or repeated) subset of follow_up, stage_change, status_change, assignment. Unknown values are a 400.' })
  @ApiQuery({ name: 'page', required: false, description: '1-10' })
  @ApiQuery({ name: 'limit', required: false, description: '1-100, default 20' })
  async list(@Param('id', new ParseUUIDPipe()) id: string, @Query() query: InquiryActivityQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    const visibleUserIds = await this.teamScope.getVisibleUserIds(user.companyId, user.sub, user.permissions);
    const allowed: InquiryActivityType[] = ['stage_change', 'status_change', 'assignment'];
    // Follow-up notes are gated by their own permission, exactly as GET /inquiries/:id/follow-ups.
    if (user.permissions.includes(PERMISSIONS.PRESALES_FOLLOW_UP_READ)) allowed.push('follow_up');
    return this.activity.list(user.companyId, id, query, { visibleUserIds }, allowed);
  }
}
