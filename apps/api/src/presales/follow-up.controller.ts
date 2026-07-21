import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { createFollowUpSchema, updateFollowUpSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { FollowUpService } from './follow-up.service';

class CreateFollowUpDto extends createZodDto(createFollowUpSchema) {}
class UpdateFollowUpDto extends createZodDto(updateFollowUpSchema) {}

@ApiTags('Follow-Ups')
@Controller('inquiries/:inquiryId/follow-ups')
export class FollowUpController {
  constructor(private readonly followUpService: FollowUpService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PRESALES_FOLLOW_UP_READ)
  @ApiOperation({ summary: 'Follow-up timeline for an inquiry' })
  findAll(@Param('inquiryId') inquiryId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.followUpService.findAllForInquiry(user.companyId, inquiryId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PRESALES_FOLLOW_UP_CREATE)
  @ApiOperation({ summary: 'Log a follow-up (site visit = type Site Visit + scheduledAt/venue)' })
  create(
    @Param('inquiryId') inquiryId: string,
    @Body() dto: CreateFollowUpDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.followUpService.create(user.companyId, inquiryId, dto, user.sub);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.PRESALES_FOLLOW_UP_UPDATE)
  @ApiOperation({ summary: 'Update a follow-up' })
  update(@Param('id') id: string, @Body() dto: UpdateFollowUpDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.followUpService.update(user.companyId, id, dto);
  }
}
