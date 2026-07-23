import { BadRequestException, Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { PortalReadThrottlerGuard } from '../portal-auth/portal-throttler.guard';
import { DocumentService } from '../pdf/document.service';

@ApiTags('Portal Broker Documents')
@Controller('portal/broker/documents')
@UseGuards(PortalReadThrottlerGuard)
export class PortalBrokerDocumentsController {
  constructor(private readonly documents: DocumentService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PORTAL_DOCUMENT_READ)
  @ApiOperation({ summary: 'List self-service commission statements' })
  async list(@Req() req: Request) {
    const user = req.user as JwtPayload;
    if (!user.brokerId) throw new BadRequestException('Not a broker portal session');
    return this.documents.listForBrokerPortal(user.companyId, user.brokerId);
  }

  @Get(':id/download')
  @RequirePermissions(PERMISSIONS.PORTAL_DOCUMENT_READ)
  @ApiOperation({ summary: 'Download a stored commission statement — never regenerated (Phase 6 decisions)' })
  async download(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const { buffer, mimeType, originalName } = await this.documents.getDocumentBytesForPortal(user.companyId, id);
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `inline; filename="${originalName}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }
}
