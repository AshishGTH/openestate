import { BadRequestException, Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { PortalPropertyService } from './portal-property.service';

@ApiTags('Portal Property')
@Controller('portal/property')
export class PortalPropertyController {
  constructor(private readonly propertyService: PortalPropertyService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PORTAL_CONSTRUCTION_UPDATE_READ)
  @ApiOperation({ summary: 'Unit/project details and construction-progress gallery for my booking(s)' })
  async getMyProperties(@Req() req: Request) {
    const user = req.user as JwtPayload;
    if (!user.applicantId) throw new BadRequestException('Not a customer portal session');
    return this.propertyService.getMyProperties(user.companyId, user.applicantId);
  }
}
