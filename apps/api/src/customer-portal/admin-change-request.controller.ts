import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { rejectChangeRequestSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { ApplicantChangeRequestService } from './applicant-change-request.service';

class RejectChangeRequestDto extends createZodDto(rejectChangeRequestSchema) {}

@ApiTags('Change Requests (Admin)')
@Controller('admin/change-requests')
export class AdminChangeRequestController {
  constructor(private readonly changeRequests: ApplicantChangeRequestService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_CHANGE_REQUEST_APPROVE)
  @ApiOperation({ summary: 'List pending applicant change requests' })
  listPending(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.changeRequests.listPending(user.companyId);
  }

  @Post(':id/approve')
  @RequirePermissions(PERMISSIONS.ADMIN_CHANGE_REQUEST_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a change request (TOCTOU-safe: 409 if the applicant drifted since submission)' })
  approve(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.changeRequests.approve(user.companyId, id, user.sub);
  }

  @Post(':id/reject')
  @RequirePermissions(PERMISSIONS.ADMIN_CHANGE_REQUEST_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a change request with a note' })
  reject(@Param('id') id: string, @Body() dto: RejectChangeRequestDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.changeRequests.reject(user.companyId, id, user.sub, dto.reviewNote);
  }
}
