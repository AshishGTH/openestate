import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { submitChangeRequestSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { PortalProfileService } from './portal-profile.service';
import { ApplicantChangeRequestService } from './applicant-change-request.service';

class SubmitChangeRequestDto extends createZodDto(submitChangeRequestSchema) {}

/**
 * Customer-only. applicantId is ALWAYS taken from the authenticated JWT
 * claim (user.applicantId) — never from a request body/param — so there is
 * no client-controlled identifier that could even be tried against another
 * applicant's row; RLS backs this up structurally as well (see Phase 6
 * decisions), but this endpoint doesn't rely on RLS alone to enforce it.
 */
@ApiTags('Portal Profile')
@Controller('portal/profile')
export class PortalProfileController {
  constructor(
    private readonly profileService: PortalProfileService,
    private readonly changeRequests: ApplicantChangeRequestService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PORTAL_PROFILE_UPDATE)
  @ApiOperation({ summary: 'View own profile and co-applicant details' })
  async getProfile(@Req() req: Request) {
    const user = req.user as JwtPayload;
    if (!user.applicantId) throw new BadRequestException('Not a customer portal session');
    return this.profileService.getProfile(user.companyId, user.applicantId);
  }

  @Post('change-requests')
  @RequirePermissions(PERMISSIONS.PORTAL_CHANGE_REQUEST_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a change request for whitelisted profile fields' })
  async submitChangeRequest(@Body() dto: SubmitChangeRequestDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    if (!user.applicantId) throw new BadRequestException('Not a customer portal session');
    const request = await this.changeRequests.submit(user.companyId, user.applicantId, user.sub, dto);
    return { ...request, submittedAt: request.createdAt };
  }
}
