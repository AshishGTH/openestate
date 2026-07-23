import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { bulkRetryDeliveriesSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { WebhookDeliveryService } from './webhook-delivery.service';

class BulkRetryDeliveriesDto extends createZodDto(bulkRetryDeliveriesSchema) {}

@ApiTags('Admin Webhooks')
@Controller('admin/webhook-deliveries')
export class WebhookDeliveryController {
  constructor(private readonly deliveries: WebhookDeliveryService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_WEBHOOK_READ)
  @ApiOperation({ summary: 'List deliveries for a webhook endpoint' })
  listForEndpoint(@Query('webhookEndpointId') webhookEndpointId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.deliveries.listForEndpoint(user.companyId, webhookEndpointId);
  }

  @Get(':id/attempts')
  @RequirePermissions(PERMISSIONS.ADMIN_WEBHOOK_READ)
  @ApiOperation({ summary: 'Full attempt history for one delivery' })
  getAttempts(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.deliveries.getAttempts(user.companyId, id);
  }

  @Post(':id/retry')
  @RequirePermissions(PERMISSIONS.ADMIN_WEBHOOK_MANAGE)
  @ApiOperation({ summary: 'Re-enqueue an EXHAUSTED delivery with a fresh attempt budget (addendum A4)' })
  retry(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.deliveries.retry(user.companyId, id);
  }

  @Post('retry')
  @RequirePermissions(PERMISSIONS.ADMIN_WEBHOOK_MANAGE)
  @ApiOperation({ summary: 'Bulk-replay every EXHAUSTED delivery matching an endpoint + time range filter' })
  bulkRetry(@Body() dto: BulkRetryDeliveriesDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.deliveries.bulkRetry(user.companyId, dto);
  }
}
