import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { addTicketMessageSchema, updateTicketStatusSchema, TICKET_STATUS, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload, TicketStatusValue } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { TicketService } from './ticket.service';

class RespondDto extends createZodDto(addTicketMessageSchema) {}
class UpdateStatusDto extends createZodDto(updateTicketStatusSchema) {}

@ApiTags('Tickets (Admin)')
@Controller('admin/tickets')
export class AdminTicketController {
  constructor(private readonly tickets: TicketService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_TICKET_RESPOND)
  @ApiOperation({ summary: 'Staff ticket queue, optionally filtered by status' })
  listQueue(@Query('status') status: string | undefined, @Req() req: Request) {
    const user = req.user as JwtPayload;
    const isValidStatus = status && (Object.values(TICKET_STATUS) as string[]).includes(status);
    return this.tickets.listQueue(user.companyId, isValidStatus ? (status as TicketStatusValue) : undefined);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_TICKET_RESPOND)
  @ApiOperation({ summary: 'View a ticket thread (staff)' })
  getOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.tickets.getOne(user.companyId, id);
  }

  @Post(':id/respond')
  @RequirePermissions(PERMISSIONS.ADMIN_TICKET_RESPOND)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Reply to a ticket as staff' })
  respond(@Param('id') id: string, @Body() dto: RespondDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.tickets.addMessage(user.companyId, id, user.sub, true, dto.body);
  }

  @Patch(':id/status')
  @RequirePermissions(PERMISSIONS.ADMIN_TICKET_RESPOND)
  @ApiOperation({ summary: 'Update ticket status' })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.tickets.updateStatus(user.companyId, id, dto.status);
  }
}
