import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { createTicketSchema, addTicketMessageSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { TicketService } from './ticket.service';

class CreateTicketDto extends createZodDto(createTicketSchema) {}
class AddTicketMessageDto extends createZodDto(addTicketMessageSchema) {}

@ApiTags('Portal Tickets')
@Controller('portal/tickets')
export class PortalTicketController {
  constructor(private readonly tickets: TicketService) {}

  @Get('categories')
  @RequirePermissions(PERMISSIONS.PORTAL_TICKET_CREATE)
  @ApiOperation({ summary: 'Active ticket categories, for the "raise a query" form' })
  listCategories(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.tickets.listCategories(user.companyId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PORTAL_TICKET_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Raise a support ticket' })
  create(@Body() dto: CreateTicketDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.tickets.create(user.companyId, user.sub, { applicantId: user.applicantId, brokerId: user.brokerId }, dto);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.PORTAL_TICKET_READ)
  @ApiOperation({ summary: 'List my tickets' })
  listMine(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.tickets.listMine(user.companyId);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PORTAL_TICKET_READ)
  @ApiOperation({ summary: 'View a ticket thread' })
  getOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.tickets.getOne(user.companyId, id);
  }

  @Post(':id/messages')
  @RequirePermissions(PERMISSIONS.PORTAL_TICKET_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Reply on a ticket thread' })
  addMessage(@Param('id') id: string, @Body() dto: AddTicketMessageDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.tickets.addMessage(user.companyId, id, user.sub, false, dto.body);
  }
}
