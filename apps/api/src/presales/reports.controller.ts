import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { ReportsService, type ReportScope } from './reports.service';
import { toCsv } from './csv.util';

function scopeFor(user: JwtPayload): ReportScope {
  if (user.roleSlug === SYSTEM_ROLES.SALES_EXECUTIVE) return { scopeToUserId: user.sub };
  return {};
}

function respond(res: Response, format: string | undefined, filename: string, rows: unknown[]) {
  if (format === 'csv') {
    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}.csv"`,
    });
    res.send(toCsv(rows as Array<Record<string, unknown>>));
    return;
  }
  res.json(rows);
}

@ApiTags('Presales Reports')
@Controller('reports/presales')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('daily-inquiries')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Daily inquiries, staff-wise' })
  async dailyInquiries(
    @Query('date') date: string | undefined,
    @Query('format') format: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.dailyInquiriesStaffWise(
      user.companyId,
      date ? new Date(date) : new Date(),
      scopeFor(user),
    );
    respond(res, format, 'daily-inquiries', rows);
  }

  @Get('inquiries-export')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({
    summary: 'Per-inquiry export, including a column per active custom field',
  })
  async inquiriesExport(
    @Query('format') format: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.inquiriesExport(user.companyId, scopeFor(user));
    respond(res, format, 'inquiries-export', rows);
  }

  @Get('funnel')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Funnel by status' })
  async funnel(
    @Query('format') format: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.funnelByStatus(user.companyId, scopeFor(user));
    respond(res, format, 'funnel', rows);
  }

  @Get('source-wise')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Source-wise inquiry count with conversion %' })
  async sourceWise(
    @Query('format') format: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.sourceWiseConversion(user.companyId, scopeFor(user));
    respond(res, format, 'source-wise', rows);
  }

  @Get('budget-band')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Budget-band analysis' })
  async budgetBand(
    @Query('format') format: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.budgetBandAnalysis(user.companyId, scopeFor(user));
    respond(res, format, 'budget-band', rows);
  }

  @Get('ageing')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Ageing buckets (0-7 / 8-30 / 31-90 / 90+) for open inquiries' })
  async ageing(
    @Query('format') format: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.ageingBuckets(user.companyId, scopeFor(user));
    respond(res, format, 'ageing', rows);
  }

  @Get('staff-performance')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Staff performance (assigned / successful / conversion %)' })
  async staffPerformance(
    @Query('format') format: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.staffPerformance(user.companyId, scopeFor(user));
    respond(res, format, 'staff-performance', rows);
  }

  @Get('manager-wise')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Manager-wise interaction counts' })
  async managerWise(
    @Query('format') format: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.managerWiseInteractions(user.companyId);
    respond(res, format, 'manager-wise', rows);
  }
}
