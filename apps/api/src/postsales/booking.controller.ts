import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  createBookingSchema,
  createPaymentPlanSchema,
  extraChargeSchema,
  interestWaiverSchema,
  createTransferSchema,
  cancellationSchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { BookingService } from './booking.service';
import { PaymentPlanService } from './payment-plan.service';
import { ExtraChargeService } from './extra-charge.service';
import { InterestService } from './interest.service';
import { TransferService } from './transfer.service';
import { CancellationService } from './cancellation.service';

class CreateBookingDto extends createZodDto(createBookingSchema) {}
class CreatePaymentPlanDto extends createZodDto(createPaymentPlanSchema) {}
class ExtraChargeDto extends createZodDto(extraChargeSchema) {}
class InterestWaiverDto extends createZodDto(interestWaiverSchema) {}
class CreateTransferDto extends createZodDto(createTransferSchema) {}
class CancellationDto extends createZodDto(cancellationSchema) {}
class DateBodyDto extends createZodDto(z.object({ date: z.coerce.date() }).strict()) {}
class TemplateBodyDto extends createZodDto(z.object({ templateId: z.string().uuid() }).strict()) {}

@ApiTags('Bookings')
@Controller('bookings')
export class BookingController {
  constructor(
    private readonly bookings: BookingService,
    private readonly plans: PaymentPlanService,
    private readonly extraCharges: ExtraChargeService,
    private readonly interest: InterestService,
    private readonly transfers: TransferService,
    private readonly cancellations: CancellationService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_CREATE)
  @ApiOperation({ summary: 'Create a booking (books the unit; posts the cost breakup to the ledger)' })
  create(@Body() dto: CreateBookingDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.bookings.createBooking(u.companyId, dto, u.sub);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_READ)
  @ApiOperation({ summary: 'Get a booking with its ledger balance' })
  get(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.bookings.findOne(u.companyId, id);
  }

  @Post(':id/allot')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_ALLOT)
  @ApiOperation({ summary: 'Allot (BOOKED → ALLOTTED)' })
  allot(@Param('id') id: string, @Body() dto: DateBodyDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.bookings.allot(u.companyId, id, dto.date, u.sub);
  }

  @Post(':id/register')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_REGISTER)
  @ApiOperation({ summary: 'Register (ALLOTTED → REGISTERED)' })
  register(@Param('id') id: string, @Body() dto: DateBodyDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.bookings.register(u.companyId, id, dto.date, u.sub);
  }

  @Post(':id/plan/from-template')
  @RequirePermissions(PERMISSIONS.POSTSALES_PLAN_EDIT)
  @ApiOperation({ summary: 'Instantiate a payment plan from a template' })
  planFromTemplate(@Param('id') id: string, @Body() dto: TemplateBodyDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.plans.instantiateFromTemplate(u.companyId, id, dto.templateId, u.sub);
  }

  @Post(':id/plan/custom')
  @RequirePermissions(PERMISSIONS.POSTSALES_PLAN_EDIT)
  @ApiOperation({ summary: 'Create a custom payment plan' })
  planCustom(@Param('id') id: string, @Body() dto: CreatePaymentPlanDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.plans.createCustomPlan(u.companyId, id, dto, u.sub);
  }

  @Post(':id/plan/edit')
  @RequirePermissions(PERMISSIONS.POSTSALES_PLAN_EDIT)
  @ApiOperation({ summary: 'Edit the plan (only unpaid installments regenerate)' })
  planEdit(@Param('id') id: string, @Body() dto: CreatePaymentPlanDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.plans.editPlan(u.companyId, id, dto.installments, u.sub);
  }

  @Get(':id/plan')
  @RequirePermissions(PERMISSIONS.POSTSALES_PLAN_READ)
  @ApiOperation({ summary: 'Get the active payment plan / schedule' })
  plan(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.plans.getActivePlan(u.companyId, id);
  }

  @Post(':id/extra-charge')
  @RequirePermissions(PERMISSIONS.POSTSALES_EXTRA_CHARGE_CREATE)
  @ApiOperation({ summary: 'Add an off-schedule charge (GST snapshotted at entry)' })
  extraCharge(@Param('id') id: string, @Body() dto: ExtraChargeDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.extraCharges.add(u.companyId, id, dto, u.sub);
  }

  @Post(':id/interest/accrue')
  @RequirePermissions(PERMISSIONS.POSTSALES_INTEREST_WAIVE)
  @ApiOperation({ summary: 'Accrue delay interest up to today (idempotent)' })
  accrue(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.interest.accrueForBooking(u.companyId, id);
  }

  @Post(':id/interest/waive')
  @RequirePermissions(PERMISSIONS.POSTSALES_INTEREST_WAIVE)
  @ApiOperation({ summary: 'Waive interest (audited credit)' })
  waive(@Param('id') id: string, @Body() dto: InterestWaiverDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.interest.waiveInterest(u.companyId, id, dto, u.sub);
  }

  @Post(':id/transfer')
  @RequirePermissions(PERMISSIONS.POSTSALES_TRANSFER_CREATE)
  @ApiOperation({ summary: 'Transfer to a new unit or applicant (carry-forward + fee)' })
  transfer(@Param('id') id: string, @Body() dto: CreateTransferDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.transfers.transfer(u.companyId, id, dto, u.sub);
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_CANCEL)
  @ApiOperation({ summary: 'Cancel/surrender (deduction from master, computes refundable)' })
  cancel(@Param('id') id: string, @Body() dto: CancellationDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.cancellations.cancel(u.companyId, id, dto, u.sub);
  }
}
