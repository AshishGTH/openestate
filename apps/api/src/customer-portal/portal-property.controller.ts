import { BadRequestException, Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { PortalReadThrottlerGuard } from '../portal-auth/portal-throttler.guard';
import { PortalPropertyService } from './portal-property.service';
import { ConstructionUpdateService } from './construction-update.service';

@ApiTags('Portal Property')
@Controller('portal/property')
@UseGuards(PortalReadThrottlerGuard)
export class PortalPropertyController {
  constructor(
    private readonly propertyService: PortalPropertyService,
    private readonly constructionUpdates: ConstructionUpdateService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PORTAL_CONSTRUCTION_UPDATE_READ)
  @ApiOperation({ summary: 'Unit/project details, layout plans/brochures, and construction-progress gallery for my booking(s)' })
  async getMyProperties(@Req() req: Request) {
    const user = req.user as JwtPayload;
    if (!user.applicantId) throw new BadRequestException('Not a customer portal session');
    return this.propertyService.getMyProperties(user.companyId, user.applicantId);
  }

  @Get('media/:mediaId/download')
  @RequirePermissions(PERMISSIONS.PORTAL_CONSTRUCTION_UPDATE_READ)
  @ApiOperation({ summary: 'Download a layout plan / brochure / photo for my project' })
  async downloadProjectMedia(@Param('mediaId') mediaId: string, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const { buffer, mimeType, originalName } = await this.propertyService.getProjectMediaBytesForPortal(user.companyId, mediaId);
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `inline; filename="${originalName}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }

  @Get('construction-media/:mediaId/download')
  @RequirePermissions(PERMISSIONS.PORTAL_CONSTRUCTION_UPDATE_READ)
  @ApiOperation({ summary: 'Download a construction-progress photo' })
  async downloadConstructionMedia(@Param('mediaId') mediaId: string, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const { buffer, mimeType, originalName } = await this.constructionUpdates.getMediaBytesForPortal(user.companyId, mediaId);
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `inline; filename="${originalName}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }
}
