import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  createApplicantSchema,
  updateApplicantSchema,
  recordConsentSchema,
  paginationQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { ApplicantService } from './applicant.service';

class CreateApplicantDto extends createZodDto(createApplicantSchema) {}
class UpdateApplicantDto extends createZodDto(updateApplicantSchema) {}
class RecordConsentDto extends createZodDto(recordConsentSchema) {}
class PaginationQueryDto extends createZodDto(paginationQuerySchema) {}

@ApiTags('Applicants')
@Controller('applicants')
export class ApplicantController {
  constructor(private readonly applicantService: ApplicantService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_READ)
  @ApiOperation({ summary: 'List applicants' })
  findAll(@Query() query: PaginationQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_READ)
  @ApiOperation({ summary: 'Get applicant by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.findOne(user.companyId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_CREATE)
  @ApiOperation({ summary: 'Create applicant (returns possibleDuplicateApplicantIds)' })
  create(@Body() dto: CreateApplicantDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_UPDATE)
  @ApiOperation({ summary: 'Update applicant' })
  update(@Param('id') id: string, @Body() dto: UpdateApplicantDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.update(user.companyId, id, dto);
  }

  @Get(':id/consent')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_READ)
  @ApiOperation({ summary: 'Full consent history (append-only ledger)' })
  consentHistory(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.getConsentHistory(user.companyId, id);
  }

  @Get(':id/consent/current')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_READ)
  @ApiOperation({ summary: 'Current consent (latest ledger row)' })
  currentConsent(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.getCurrentConsent(user.companyId, id);
  }

  @Post(':id/consent')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_UPDATE)
  @ApiOperation({ summary: 'Record a consent event (grant or revoke)' })
  recordConsent(
    @Param('id') id: string,
    @Body() dto: RecordConsentDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.applicantService.recordConsent(
      user.companyId,
      id,
      user.sub,
      dto.given,
      dto.source,
    );
  }

  @Get(':id/communications')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_READ)
  @ApiOperation({ summary: 'Communication timeline, including merged-in applicants' })
  communications(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.getCommunicationTimeline(user.companyId, id);
  }

  @Post(':survivorId/merge/:mergedId')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_MERGE)
  @ApiOperation({ summary: 'Merge a duplicate applicant into a survivor' })
  merge(
    @Param('survivorId') survivorId: string,
    @Param('mergedId') mergedId: string,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.applicantService.merge(user.companyId, survivorId, mergedId, user.sub);
  }
}
