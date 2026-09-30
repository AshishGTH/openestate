import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  createInquirySchema,
  updateInquirySchema,
  assignInquirySchema,
  inquiryListQuerySchema,
  inquirySummaryQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { InquiryService, type InquiryScope } from './inquiry.service';
import { TeamScopeService } from '../team-scope/team-scope.service';

class CreateInquiryDto extends createZodDto(createInquirySchema) {}
class UpdateInquiryDto extends createZodDto(updateInquirySchema) {}
class AssignInquiryDto extends createZodDto(assignInquirySchema) {}
class InquiryListQueryDto extends createZodDto(inquiryListQuerySchema) {}
class InquirySummaryQueryDto extends createZodDto(inquirySummaryQuerySchema) {}

@ApiTags('Inquiries')
@Controller('inquiries')
export class InquiryController {
  constructor(
    private readonly inquiryService: InquiryService,
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
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_READ)
  @ApiOperation({ summary: "List inquiries (scoped to the caller's reporting subtree)" })
  @ApiQuery({
    name: 'search',
    required: false,
    description:
      'Case-insensitive match on applicant name, email or phone digits, or project name. ' +
      'Fewer than 2 characters is ignored (unfiltered list). Combined with the caller\'s team scope, never widening it.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Comma-separated (or repeated) subset of OPEN, CONTINUED, SUCCESSFUL, DUMPED. Unknown values are a 400; omitted or empty means no status filter.',
    example: 'OPEN,CONTINUED',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'updatedAt', 'nextFollowupAt', 'status'],
    description: 'Default createdAt descending. nextFollowupAt sorts leads with no follow-up last. Any other value is a 400.',
  })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'], description: 'Applies when sortBy is given. Default asc.' })
  @ApiQuery({ name: 'followUpAfter', required: false, description: 'Inclusive lower bound on the lead\'s next follow-up. ISO 8601 instant WITH offset (2026-10-01T00:00:00+05:30 or ...Z); date-only or offset-less values are a 400.' })
  @ApiQuery({ name: 'followUpBefore', required: false, description: 'Exclusive upper bound on the next follow-up. Same format. Must be later than followUpAfter.' })
  @ApiQuery({ name: 'followUp', required: false, enum: ['none'], description: 'none = no follow-up date set. Cannot be combined with followUpAfter/followUpBefore.' })
  @ApiQuery({ name: 'assignedTo', required: false, description: '"me" or a user id inside the caller\'s visible team (404 otherwise).' })
  async findAll(@Query() query: InquiryListQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.findAll(user.companyId, query, await this.scopeFor(user), user.sub);
  }

  @Get('summary')
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_READ)
  @ApiOperation({ summary: "Dashboard counts over the caller's visible leads (total, by status, overdue, due today, new)" })
  @ApiQuery({ name: 'dayStart', required: false, description: 'Start (inclusive) of the caller\'s "today", ISO 8601 with offset. Give with dayEnd. Default: the company\'s day (CompanyConfig.timezone).' })
  @ApiQuery({ name: 'dayEnd', required: false, description: 'End (exclusive) of "today". At most 26 hours after dayStart.' })
  @ApiQuery({ name: 'since', required: false, description: 'Count leads created at or after this instant as "new". Default: dayEnd minus 7 days.' })
  @ApiQuery({ name: 'assignedTo', required: false, description: '"me" or a user id in the caller\'s visible team. Default: everyone the caller can see.' })
  async summary(@Query() query: InquirySummaryQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.summary(user.companyId, query, await this.scopeFor(user), user.sub);
  }

  @Get('my-day')
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_READ)
  @ApiOperation({ summary: "Today's and overdue follow-ups assigned to me" })
  myDay(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.myDay(user.companyId, user.sub);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_READ)
  @ApiOperation({ summary: 'Get inquiry by ID' })
  async findOne(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.findOne(user.companyId, id, await this.scopeFor(user));
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_CREATE)
  @ApiOperation({ summary: 'Create inquiry (dedup-checks/links applicant, auto-assigns if project pool configured)' })
  create(@Body() dto: CreateInquiryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.create(user.companyId, dto, user.sub);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_UPDATE)
  @ApiOperation({ summary: 'Update inquiry' })
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateInquiryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.update(user.companyId, id, dto, await this.scopeFor(user), user.sub);
  }

  @Patch(':id/assign')
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_ASSIGN)
  @ApiOperation({ summary: 'Manually reassign an inquiry (both the inquiry and the target user must be in the caller\'s visible set)' })
  async assign(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AssignInquiryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.assign(
      user.companyId,
      id,
      dto.toUserId,
      user.sub,
      dto.reason,
      await this.scopeFor(user),
    );
  }
}
