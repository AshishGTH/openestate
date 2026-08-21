import {
  BadRequestException,
  Controller,
  Get,
  Param,
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
import { ImportExportService } from './import-export.service';

@ApiTags('Unit Import/Export')
@Controller('projects/:projectId/units')
export class ImportExportController {
  constructor(private readonly importExportService: ImportExportService) {}

  @Post('import')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_IMPORT)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'XLSX file with unit data' })
  @ApiOperation({ summary: 'Import units from Excel file' })
  async importUnits(
    @Param('projectId') projectId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const user = req.user as JwtPayload;
    return this.importExportService.importUnits(user.companyId, projectId, file.buffer);
  }

  @Get('import-template')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_IMPORT)
  @ApiOperation({ summary: 'Download a blank import template — column set matches the project shape' })
  async importTemplate(
    @Param('projectId') projectId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as JwtPayload;
    const buffer = await this.importExportService.getImportTemplate(user.companyId, projectId);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="unit-import-template-${projectId}.xlsx"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }

  @Get('export')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_EXPORT)
  @ApiOperation({ summary: 'Export units to Excel file' })
  async exportUnits(
    @Param('projectId') projectId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as JwtPayload;
    const buffer = await this.importExportService.exportUnits(user.companyId, projectId);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="units-${projectId}.xlsx"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }
}
