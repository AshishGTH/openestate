import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { saveBookingDraftSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { BookingDraftService } from './booking-draft.service';

class SaveBookingDraftDto extends createZodDto(saveBookingDraftSchema) {}

@ApiTags('Booking Drafts')
@Controller('booking-drafts')
export class BookingDraftController {
  constructor(private readonly drafts: BookingDraftService) {}

  @Post()
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_CREATE)
  @ApiOperation({ summary: 'Save a new booking-wizard draft' })
  create(@Body() dto: SaveBookingDraftDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.drafts.create(u.companyId, dto, u.sub);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_CREATE)
  @ApiOperation({ summary: 'List my own booking-wizard drafts, most recent first' })
  listMine(@Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.drafts.listMine(u.companyId, u.sub);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_CREATE)
  @ApiOperation({ summary: 'Get one of my drafts' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.drafts.findOne(u.companyId, id, u.sub);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_CREATE)
  @ApiOperation({ summary: 'Update a draft (autosave as the wizard progresses)' })
  update(@Param('id') id: string, @Body() dto: SaveBookingDraftDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.drafts.update(u.companyId, id, dto, u.sub);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_CREATE)
  @ApiOperation({ summary: 'Discard a draft (booking confirmed, or abandoned)' })
  discard(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.drafts.discard(u.companyId, id, u.sub);
  }
}
