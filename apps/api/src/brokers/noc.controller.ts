import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { rejectNocSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { NocService } from './noc.service';

class RejectNocDto extends createZodDto(rejectNocSchema) {}

@ApiTags('Broker NOCs')
@Controller('nocs')
export class NocController {
  constructor(private readonly nocs: NocService) {}

  @Post(':id/approve')
  @RequirePermissions(PERMISSIONS.ACCOUNTS_NOC_APPROVE)
  @ApiOperation({ summary: 'Approve a requested broker NOC (unblocks cancellation)' })
  approve(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.nocs.approve(u.companyId, id, u.sub);
  }

  @Post(':id/reject')
  @RequirePermissions(PERMISSIONS.ACCOUNTS_NOC_APPROVE)
  @ApiOperation({ summary: 'Reject a requested broker NOC' })
  reject(@Param('id') id: string, @Body() dto: RejectNocDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.nocs.reject(u.companyId, id, dto, u.sub);
  }

  @Get('booking/:bookingId')
  @RequirePermissions(PERMISSIONS.ACCOUNTS_NOC_APPROVE)
  @ApiOperation({ summary: 'NOC history for a booking' })
  forBooking(@Param('bookingId') bookingId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.nocs.findForBooking(u.companyId, bookingId);
  }
}
