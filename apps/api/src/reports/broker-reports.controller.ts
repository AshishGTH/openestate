import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { reportDateRangeSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { BrokerReportsService } from './broker-reports.service';
import { streamCsv } from './csv-stream.util';

class ReportQueryDto extends createZodDto(reportDateRangeSchema) {}
// sold-units accepts an optional brokerId filter — reportDateRangeSchema is
// .strict(), so a plain @Query('brokerId') alongside @Query() ReportQueryDto
// fails validation (unrecognized key); extend the schema instead. Exported
// for a direct schema-level regression test (commission-pure.test.ts) —
// calling the controller method directly bypasses Nest's validation pipe,
// so only a schema-level test actually catches this class of bug.
export const soldUnitsQuerySchema = reportDateRangeSchema.extend({ brokerId: z.string().uuid().optional() });
class SoldUnitsQueryDto extends createZodDto(soldUnitsQuerySchema) {}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

@ApiTags('Broker Reports')
@Controller('reports/brokers')
export class BrokerReportsController {
  constructor(private readonly reports: BrokerReportsService) {}

  @Get('sold-units')
  @RequirePermissions(PERMISSIONS.REPORTS_BROKER_VIEW)
  @ApiOperation({ summary: 'Broker-wise sold units (streamed CSV supported)' })
  async soldUnits(@Query() q: SoldUnitsQueryDto, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Broker', 'Booking No.', 'Applicant', 'Unit', 'Agreed Price', 'Status'];
    const gen = this.reports.soldUnits(u.companyId, q.brokerId);
    if (q.format === 'csv') return streamCsv(res, 'broker-sold-units.csv', headers, gen);
    res.json(await collect(gen));
  }

  @Get('commission-summary')
  @RequirePermissions(PERMISSIONS.REPORTS_BROKER_VIEW)
  @ApiOperation({ summary: 'Commission summary per broker: accrued, paid, TDS, clawed back, outstanding (streamed CSV supported)' })
  async commissionSummary(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Broker', 'Accrued', 'Paid', 'TDS Withheld', 'Clawed Back', 'Outstanding'];
    const gen = this.reports.commissionSummary(u.companyId);
    if (q.format === 'csv') return streamCsv(res, 'broker-commission-summary.csv', headers, gen);
    res.json(await collect(gen));
  }

  @Get('dues')
  @RequirePermissions(PERMISSIONS.REPORTS_BROKER_VIEW)
  @ApiOperation({ summary: 'Brokers with outstanding commission dues (streamed CSV supported)' })
  async dues(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Broker', 'Phone', 'Outstanding'];
    const gen = this.reports.dues(u.companyId);
    if (q.format === 'csv') return streamCsv(res, 'broker-dues.csv', headers, gen);
    res.json(await collect(gen));
  }

  @Get(':brokerId/customer-detail')
  @RequirePermissions(PERMISSIONS.REPORTS_BROKER_VIEW)
  @ApiOperation({ summary: 'Customer-wise detail for one broker (streamed CSV supported)' })
  async customerDetail(@Param('brokerId') brokerId: string, @Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Applicant', 'Booking No.', 'Unit', 'Agreed Price', 'Commission Accrued', 'Commission Paid', 'Outstanding'];
    const gen = this.reports.customerDetail(u.companyId, brokerId);
    if (q.format === 'csv') return streamCsv(res, `broker-${brokerId}-customer-detail.csv`, headers, gen);
    res.json(await collect(gen));
  }

  @Get('summary')
  @RequirePermissions(PERMISSIONS.REPORTS_BROKER_VIEW)
  @ApiOperation({ summary: 'Company-wide broker/commission rollup' })
  async summary(@Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.reports.summary(u.companyId);
  }
}
