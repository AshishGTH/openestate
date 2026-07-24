import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { createWebhookEndpointSchema, updateWebhookEndpointSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { WebhookEndpointService } from './webhook-endpoint.service';
import { WebhookDeliveryService } from './webhook-delivery.service';

class CreateWebhookEndpointDto extends createZodDto(createWebhookEndpointSchema) {}
class UpdateWebhookEndpointDto extends createZodDto(updateWebhookEndpointSchema) {}

@ApiTags('Admin Webhooks')
@Controller('admin/webhook-endpoints')
export class WebhookEndpointController {
  constructor(
    private readonly endpoints: WebhookEndpointService,
    private readonly deliveries: WebhookDeliveryService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_WEBHOOK_READ)
  @ApiOperation({ summary: 'List this company\'s webhook endpoints' })
  list(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.endpoints.list(user.companyId);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_WEBHOOK_READ)
  @ApiOperation({ summary: 'Get one webhook endpoint (secret never returned)' })
  getOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.endpoints.getOne(user.companyId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_WEBHOOK_MANAGE)
  @ApiOperation({ summary: 'Create a webhook endpoint — secret is encrypted at rest, never returned again' })
  create(@Body() dto: CreateWebhookEndpointDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.endpoints.create(user.companyId, dto, user.sub);
  }

  @Put(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_WEBHOOK_MANAGE)
  @ApiOperation({ summary: 'Update a webhook endpoint (secret optional — omit to keep the existing one)' })
  update(@Param('id') id: string, @Body() dto: UpdateWebhookEndpointDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.endpoints.update(user.companyId, id, dto);
  }

  @Post(':id/enable')
  @RequirePermissions(PERMISSIONS.ADMIN_WEBHOOK_MANAGE)
  @ApiOperation({ summary: 'Re-enable a webhook endpoint (resets the consecutive-failure counter)' })
  enable(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.endpoints.enable(user.companyId, id);
  }

  @Post(':id/disable')
  @RequirePermissions(PERMISSIONS.ADMIN_WEBHOOK_MANAGE)
  @ApiOperation({ summary: 'Disable a webhook endpoint' })
  disable(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.endpoints.disable(user.companyId, id);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_WEBHOOK_MANAGE)
  @ApiOperation({ summary: 'Delete a webhook endpoint (deliveries cascade)' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.endpoints.remove(user.companyId, id);
  }

  @Post(':id/test')
  @RequirePermissions(PERMISSIONS.ADMIN_WEBHOOK_MANAGE)
  @ApiOperation({ summary: 'Send a test event to this endpoint (bypasses its eventTypes filter — proves reachability)' })
  sendTestEvent(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.deliveries.sendTestEvent(user.companyId, id);
  }
}
