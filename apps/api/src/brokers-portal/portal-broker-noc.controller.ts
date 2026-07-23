import { BadRequestException, Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { rejectNocSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { NocService } from '../brokers/noc.service';

class RejectNocDto extends createZodDto(rejectNocSchema) {}

/**
 * Reuses NocService.approve()/reject() UNCHANGED from the staff-facing
 * NocController (apps/api/src/brokers/noc.controller.ts) — no brokerId
 * parameter needed on those methods. Both go through withTenantTx and a
 * `findFirst`/`update` on BrokerNoc, a direct-column PORTAL_SCOPED_MODELS
 * entry (brokerField: 'brokerId'): with the ambient portalBrokerId this
 * controller's requests carry (set by TenantContextInterceptor from the
 * broker's JWT), tenant.extension.ts's injectPortalScope narrows both
 * queries to the ambient broker's own NOCs automatically — a foreign
 * broker's nocId 404s before any write happens, never an IDOR. See
 * CLAUDE.md Phase 6 commit 3 decisions for why NocService itself needed
 * no changes.
 */
@ApiTags('Portal Broker NOCs')
@Controller('portal/broker/nocs')
export class PortalBrokerNocController {
  constructor(private readonly nocs: NocService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PORTAL_NOC_ACTION)
  @ApiOperation({ summary: 'NOC history for the logged-in broker' })
  list(@Req() req: Request) {
    const user = req.user as JwtPayload;
    if (!user.brokerId) throw new BadRequestException('Not a broker portal session');
    return this.nocs.listForBroker(user.companyId, user.brokerId);
  }

  @Post(':id/approve')
  @RequirePermissions(PERMISSIONS.PORTAL_NOC_ACTION)
  @ApiOperation({ summary: 'Approve a requested NOC on the logged-in broker\'s own booking' })
  approve(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    if (!user.brokerId) throw new BadRequestException('Not a broker portal session');
    return this.nocs.approve(user.companyId, id, user.sub);
  }

  @Post(':id/reject')
  @RequirePermissions(PERMISSIONS.PORTAL_NOC_ACTION)
  @ApiOperation({ summary: 'Reject a requested NOC on the logged-in broker\'s own booking' })
  reject(@Param('id') id: string, @Body() dto: RejectNocDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    if (!user.brokerId) throw new BadRequestException('Not a broker portal session');
    return this.nocs.reject(user.companyId, id, dto, user.sub);
  }
}
