import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { requestCommissionPaymentSchema, payCommissionPaymentSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { CommissionPaymentService } from './commission-payment.service';
import { CommissionService } from './commission.service';

class RequestCommissionPaymentDto extends createZodDto(requestCommissionPaymentSchema) {}
class PayCommissionPaymentDto extends createZodDto(payCommissionPaymentSchema) {}

@ApiTags('Commission Payments')
@Controller('commission-payments')
export class CommissionPaymentController {
  constructor(
    private readonly payments: CommissionPaymentService,
    private readonly commission: CommissionService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.ACCOUNTS_COMMISSION_CREATE)
  @ApiOperation({ summary: 'Request a commission payment (validated against the broker\'s outstanding)' })
  request(@Body() dto: RequestCommissionPaymentDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.payments.request(u.companyId, dto, u.sub);
  }

  @Post(':id/approve')
  @RequirePermissions(PERMISSIONS.ACCOUNTS_COMMISSION_APPROVE)
  @ApiOperation({ summary: 'Approve a requested commission payment (no ledger effect yet)' })
  approve(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.payments.approve(u.companyId, id, u.sub);
  }

  @Post(':id/reject')
  @RequirePermissions(PERMISSIONS.ACCOUNTS_COMMISSION_APPROVE)
  @ApiOperation({ summary: 'Reject a requested commission payment' })
  reject(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.payments.reject(u.companyId, id, u.sub);
  }

  @Post(':id/pay')
  @RequirePermissions(PERMISSIONS.ACCOUNTS_COMMISSION_PAY)
  @ApiOperation({ summary: 'Pay an approved commission payment (posts PAYMENT + TDS_WITHHELD ledger entries)' })
  pay(@Param('id') id: string, @Body() dto: PayCommissionPaymentDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.payments.pay(u.companyId, id, dto, u.sub);
  }

  @Get('brokers/:brokerId/balance')
  @RequirePermissions(PERMISSIONS.ACCOUNTS_COMMISSION_READ)
  @ApiOperation({ summary: "A broker's current commission outstanding" })
  async balance(@Param('brokerId') brokerId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    const balancePaise = await this.commission.balance(u.companyId, brokerId);
    return { brokerId, balancePaise: balancePaise.toString() };
  }

  @Get('brokers/:brokerId')
  @RequirePermissions(PERMISSIONS.ACCOUNTS_COMMISSION_READ)
  @ApiOperation({ summary: "A broker's commission payment history" })
  history(@Param('brokerId') brokerId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.payments.history(u.companyId, brokerId);
  }
}
