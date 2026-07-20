import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  updateCompanySchema,
  updateCompanyConfigSchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { CompanyService } from './company.service';

class UpdateCompanyDto extends createZodDto(updateCompanySchema) {}
class UpdateCompanyConfigDto extends createZodDto(updateCompanyConfigSchema) {}

@ApiTags('Company')
@Controller('company')
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_COMPANY_READ)
  @ApiOperation({ summary: 'Get current company' })
  findOne(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.companyService.findOne(user.companyId);
  }

  @Patch()
  @RequirePermissions(PERMISSIONS.ADMIN_COMPANY_UPDATE)
  @ApiOperation({ summary: 'Update company' })
  update(@Body() dto: UpdateCompanyDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.companyService.update(user.companyId, dto);
  }

  @Get('config')
  @RequirePermissions(PERMISSIONS.ADMIN_CONFIG_READ)
  @ApiOperation({ summary: 'Get company config' })
  getConfig(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.companyService.getConfig(user.companyId);
  }

  @Patch('config')
  @RequirePermissions(PERMISSIONS.ADMIN_CONFIG_UPDATE)
  @ApiOperation({ summary: 'Update company config' })
  updateConfig(@Body() dto: UpdateCompanyConfigDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.companyService.updateConfig(user.companyId, dto);
  }

  @Get('terminology')
  @ApiOperation({ summary: 'Get terminology labels' })
  getTerminology(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.companyService.getTerminology(user.companyId);
  }
}
