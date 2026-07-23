import { Module } from '@nestjs/common';
import { PresalesModule } from '../presales/presales.module';
import { LeadApiKeyService } from './lead-api-key.service';
import { LeadApiKeyController } from './lead-api-key.controller';
import { LeadApiKeyGuard } from './lead-api-key.guard';
import { LeadInboundThrottlerGuard } from './lead-inbound-throttler.guard';
import { LeadInboundController } from './lead-inbound.controller';

@Module({
  imports: [PresalesModule],
  controllers: [LeadApiKeyController, LeadInboundController],
  providers: [LeadApiKeyService, LeadApiKeyGuard, LeadInboundThrottlerGuard],
})
export class LeadsModule {}
