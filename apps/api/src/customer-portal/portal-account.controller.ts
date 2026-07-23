import { BadRequestException, Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { PortalReadThrottlerGuard } from '../portal-auth/portal-throttler.guard';
import { PortalAccountService } from './portal-account.service';
import { DocumentService } from '../pdf/document.service';

@ApiTags('Portal Account')
@Controller('portal/account')
@UseGuards(PortalReadThrottlerGuard)
export class PortalAccountController {
  constructor(
    private readonly accountService: PortalAccountService,
    private readonly documents: DocumentService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PORTAL_PAYMENT_SCHEDULE_READ)
  @ApiOperation({ summary: 'Cost breakup, payment plan, payment history, and next due per booking' })
  async getAccount(@Req() req: Request) {
    const user = req.user as JwtPayload;
    if (!user.applicantId) throw new BadRequestException('Not a customer portal session');
    return this.accountService.getAccount(user.companyId, user.applicantId);
  }

  @Get('documents')
  @RequirePermissions(PERMISSIONS.PORTAL_DOCUMENT_READ)
  @ApiOperation({ summary: 'List self-service documents (statement, receipts, demand letter)' })
  async listDocuments(@Req() req: Request) {
    const user = req.user as JwtPayload;
    if (!user.applicantId) throw new BadRequestException('Not a customer portal session');
    return this.documents.listForPortal(user.companyId, user.applicantId);
  }

  @Get('documents/:id/download')
  @RequirePermissions(PERMISSIONS.PORTAL_DOCUMENT_READ)
  @ApiOperation({ summary: 'Download a stored document — never regenerated (Phase 6 decisions)' })
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
