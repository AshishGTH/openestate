import { Module } from '@nestjs/common';
import { QueuesModule } from '../queues/queues.module';
import { PluginsModule } from '../plugins/plugins.module';
import { WebhookEndpointService } from './webhook-endpoint.service';
import { WebhookEndpointController } from './webhook-endpoint.controller';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookDeliveryController } from './webhook-delivery.controller';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';

@Module({
  imports: [QueuesModule, PluginsModule],
  controllers: [WebhookEndpointController, WebhookDeliveryController],
  providers: [WebhookEndpointService, WebhookDeliveryService, WebhookDeliveryProcessor],
  exports: [WebhookDeliveryService],
})
export class WebhooksModule {}
