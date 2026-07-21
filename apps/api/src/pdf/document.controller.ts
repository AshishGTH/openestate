import { Controller, Get, Param, Post, Body, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { GENERATED_DOCUMENT_TYPE, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { DocumentService } from './document.service';

class GenerateLetterDto extends createZodDto(
  z
    .object({
      templateId: z.string().uuid(),
      installmentId: z.string().uuid().optional(),
    })
    .strict(),
) {}

@ApiTags('Documents')
@Controller()
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}

  @Post('receipts/:receiptId/pdf')
  @RequirePermissions(PERMISSIONS.POSTSALES_RECEIPT_READ)
  @ApiOperation({ summary: 'Generate (idempotently) the PDF for a receipt' })
  generateReceiptPdf(@Param('receiptId') receiptId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.documents.generateReceiptPdf(u.companyId, receiptId, u.sub);
  }

  @Post('receipts/:receiptId/pdf/reprint')
  @RequirePermissions(PERMISSIONS.POSTSALES_RECEIPT_READ)
  @ApiOperation({ summary: 'Reprint a receipt (new watermarked DUPLICATE artifact)' })
  reprintReceiptPdf(@Param('receiptId') receiptId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.documents.reprintReceiptPdf(u.companyId, receiptId, u.sub);
  }

  @Post('bookings/:bookingId/documents/statement')
  @RequirePermissions(PERMISSIONS.POSTSALES_LETTER_GENERATE)
  @ApiOperation({ summary: 'Generate a fresh statement-of-account PDF snapshot' })
  generateStatement(@Param('bookingId') bookingId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.documents.generateStatementPdf(u.companyId, bookingId, u.sub);
  }

  @Post('bookings/:bookingId/documents/allotment-letter')
  @RequirePermissions(PERMISSIONS.POSTSALES_LETTER_GENERATE)
  @ApiOperation({ summary: 'Generate an allotment letter from a template' })
  generateAllotmentLetter(
    @Param('bookingId') bookingId: string,
    @Body() dto: GenerateLetterDto,
    @Req() req: Request,
  ) {
    const u = req.user as JwtPayload;
    return this.documents.generateLetterPdf(
      u.companyId,
      GENERATED_DOCUMENT_TYPE.ALLOTMENT_LETTER,
      bookingId,
      dto.templateId,
      u.sub,
    );
  }

  @Post('bookings/:bookingId/documents/demand-letter')
  @RequirePermissions(PERMISSIONS.POSTSALES_DEMAND_GENERATE)
  @ApiOperation({ summary: 'Generate a demand letter for a due installment' })
  generateDemandLetter(
    @Param('bookingId') bookingId: string,
    @Body() dto: GenerateLetterDto,
    @Req() req: Request,
  ) {
    const u = req.user as JwtPayload;
    return this.documents.generateLetterPdf(
      u.companyId,
      GENERATED_DOCUMENT_TYPE.DEMAND_LETTER,
      bookingId,
      dto.templateId,
      u.sub,
      dto.installmentId,
    );
  }

  @Post('bookings/:bookingId/documents/reminder-letter')
  @RequirePermissions(PERMISSIONS.POSTSALES_LETTER_GENERATE)
  @ApiOperation({ summary: 'Generate a reminder letter for a due installment' })
  generateReminderLetter(
    @Param('bookingId') bookingId: string,
    @Body() dto: GenerateLetterDto,
    @Req() req: Request,
  ) {
    const u = req.user as JwtPayload;
    return this.documents.generateLetterPdf(
      u.companyId,
      GENERATED_DOCUMENT_TYPE.REMINDER_LETTER,
      bookingId,
      dto.templateId,
      u.sub,
      dto.installmentId,
    );
  }

  @Get('bookings/:bookingId/documents')
  @RequirePermissions(PERMISSIONS.POSTSALES_LETTER_READ)
  @ApiOperation({ summary: 'List generated documents for a booking' })
  listForBooking(@Param('bookingId') bookingId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.documents.listForBooking(u.companyId, bookingId);
  }

  @Get('applicants/:applicantId/documents')
  @RequirePermissions(PERMISSIONS.POSTSALES_LETTER_READ)
  @ApiOperation({ summary: 'List generated documents for an applicant' })
  listForApplicant(@Param('applicantId') applicantId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.documents.listForApplicant(u.companyId, applicantId);
  }

  @Get('documents/:id/download')
  @RequirePermissions(PERMISSIONS.POSTSALES_LETTER_READ)
  @ApiOperation({ summary: 'Download a generated document (never regenerated — served from storage)' })
  async download(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const { buffer, mimeType, originalName } = await this.documents.getDocumentBytes(u.companyId, id);
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `inline; filename="${originalName}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }
}
