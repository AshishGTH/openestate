import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { sendDispatchSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { DispatchService } from './dispatch.service';

class SendDispatchDto extends createZodDto(sendDispatchSchema) {}

@ApiTags('Dispatch')
@Controller()
export class DispatchController {
  constructor(private readonly dispatch: DispatchService) {}

  @Post('dispatch')
  @RequirePermissions(PERMISSIONS.POSTSALES_DISPATCH_SEND)
  @ApiOperation({ summary: 'Send a generated document via email/SMS (dev provider)' })
  send(@Body() dto: SendDispatchDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.dispatch.send(u.companyId, dto.generatedDocumentId as string, dto.recipientAddress, dto.channel, u.sub);
  }

  @Post('dispatch/:id/retry')
  @RequirePermissions(PERMISSIONS.POSTSALES_DISPATCH_SEND)
  @ApiOperation({ summary: 'Retry a failed dispatch (creates a new attempt row)' })
  retry(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.dispatch.retry(u.companyId, id, u.sub);
  }

  @Get('bookings/:bookingId/dispatch-history')
  @RequirePermissions(PERMISSIONS.POSTSALES_DISPATCH_READ)
  @ApiOperation({ summary: 'Dispatch history for a booking' })
  historyForBooking(@Param('bookingId') bookingId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.dispatch.historyForBooking(u.companyId, bookingId);
  }

  @Get('applicants/:applicantId/dispatch-history')
  @RequirePermissions(PERMISSIONS.POSTSALES_DISPATCH_READ)
  @ApiOperation({ summary: 'Dispatch history for an applicant' })
  historyForApplicant(@Param('applicantId') applicantId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.dispatch.historyForApplicant(u.companyId, applicantId);
  }
}
