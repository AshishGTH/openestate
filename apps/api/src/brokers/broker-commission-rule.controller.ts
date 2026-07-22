import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { createCommissionRuleSchema, updateCommissionRuleSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { BrokerCommissionRuleService } from './broker-commission-rule.service';

class CreateCommissionRuleDto extends createZodDto(createCommissionRuleSchema) {}
class UpdateCommissionRuleDto extends createZodDto(updateCommissionRuleSchema) {}

@ApiTags('Broker Commission Rules')
@Controller('brokers/:brokerId/commission-rules')
export class BrokerCommissionRuleController {
  constructor(private readonly rules: BrokerCommissionRuleService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_BROKER_READ)
  @ApiOperation({ summary: "List a broker's commission rules" })
  findAll(@Param('brokerId') brokerId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.rules.findAllForBroker(u.companyId, brokerId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_BROKER_UPDATE)
  @ApiOperation({ summary: 'Create a commission rule (flat percent, flat amount, or slab-based)' })
  create(@Body() dto: CreateCommissionRuleDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.rules.create(u.companyId, dto);
  }

  @Patch(':ruleId')
  @RequirePermissions(PERMISSIONS.ADMIN_BROKER_UPDATE)
  @ApiOperation({ summary: 'Update a commission rule' })
  update(@Param('ruleId') ruleId: string, @Body() dto: UpdateCommissionRuleDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.rules.update(u.companyId, ruleId, dto);
  }

  @Post(':ruleId/deactivate')
  @RequirePermissions(PERMISSIONS.ADMIN_BROKER_UPDATE)
  @ApiOperation({ summary: 'Deactivate a commission rule' })
  deactivate(@Param('ruleId') ruleId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.rules.deactivate(u.companyId, ruleId);
  }
}
