import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { createFollowUpSchema, updateFollowUpSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { FollowUpService } from './follow-up.service';
import { TeamScopeService } from '../team-scope/team-scope.service';
import type { InquiryScope } from './inquiry.service';

class CreateFollowUpDto extends createZodDto(createFollowUpSchema) {}
class UpdateFollowUpDto extends createZodDto(updateFollowUpSchema) {}

@ApiTags('Follow-Ups')
@Controller('inquiries/:inquiryId/follow-ups')
export class FollowUpController {
  constructor(
    private readonly followUpService: FollowUpService,
    private readonly teamScope: TeamScopeService,
  ) {}

  private async scopeFor(user: JwtPayload): Promise<InquiryScope> {
    const visibleUserIds = await this.teamScope.getVisibleUserIds(
      user.companyId,
      user.sub,
      user.permissions,
    );
    return { visibleUserIds };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.PRESALES_FOLLOW_UP_READ)
  @ApiOperation({ summary: "Follow-up timeline for an inquiry (caller must have the inquiry in their visible set)" })
  async findAll(@Param('inquiryId') inquiryId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.followUpService.findAllForInquiry(user.companyId, inquiryId, await this.scopeFor(user));
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PRESALES_FOLLOW_UP_CREATE)
  @ApiOperation({ summary: 'Log a follow-up (site visit = type Site Visit + scheduledAt/venue)' })
  async create(
    @Param('inquiryId') inquiryId: string,
    @Body() dto: CreateFollowUpDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.followUpService.create(
      user.companyId,
      inquiryId,
      dto,
      user.sub,
      await this.scopeFor(user),
    );
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.PRESALES_FOLLOW_UP_UPDATE)
  @ApiOperation({ summary: 'Update a follow-up' })
  async update(@Param('id') id: string, @Body() dto: UpdateFollowUpDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.followUpService.update(user.companyId, id, dto, await this.scopeFor(user));
  }
}
