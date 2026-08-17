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
  createInquirySchema,
  updateInquirySchema,
  assignInquirySchema,
  paginationQuerySchema,
  PERMISSIONS,
  SYSTEM_ROLES,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { InquiryService } from './inquiry.service';

class CreateInquiryDto extends createZodDto(createInquirySchema) {}
class UpdateInquiryDto extends createZodDto(updateInquirySchema) {}
class AssignInquiryDto extends createZodDto(assignInquirySchema) {}
class PaginationQueryDto extends createZodDto(paginationQuerySchema) {}

/** Sales executives see only their own queue; managers/admins see everything. */
function scopeFor(user: JwtPayload) {
  if (user.roleSlug === SYSTEM_ROLES.SALES_EXECUTIVE) {
    return { scopeToUserId: user.sub };
  }
  return {};
}

@ApiTags('Inquiries')
@Controller('inquiries')
export class InquiryController {
  constructor(private readonly inquiryService: InquiryService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_READ)
  @ApiOperation({ summary: 'List inquiries (scoped to own queue for sales executives)' })
  findAll(@Query() query: PaginationQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.findAll(user.companyId, query, scopeFor(user));
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
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.findOne(user.companyId, id, scopeFor(user));
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
  update(@Param('id') id: string, @Body() dto: UpdateInquiryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.update(user.companyId, id, dto, scopeFor(user));
  }

  @Patch(':id/assign')
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_ASSIGN)
  @ApiOperation({ summary: 'Manually reassign an inquiry' })
  assign(@Param('id') id: string, @Body() dto: AssignInquiryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.assign(user.companyId, id, dto.toUserId, user.sub, dto.reason);
  }
}
