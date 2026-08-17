import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { InquiryImportService } from './inquiry-import.service';

@ApiTags('Inquiry Import')
@Controller('inquiries')
export class InquiryImportController {
  constructor(private readonly importService: InquiryImportService) {}

  @Get('import-template')
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_IMPORT)
  @ApiOperation({ summary: 'Download the XLSX header template for bulk inquiry import' })
  async importTemplate(@Res() res: Response) {
    const buffer = await this.importService.buildImportTemplate();
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="inquiry-import-template.xlsx"',
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }

  @Post('import')
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_IMPORT)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'XLSX file with inquiry data' })
  @ApiOperation({ summary: 'Bulk import inquiries from Excel (applicant dedup applied)' })
  async importInquiries(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    if (!file) throw new BadRequestException('No file uploaded');
    const user = req.user as JwtPayload;
    return this.importService.importInquiries(user.companyId, file.buffer);
  }
}
