import { Module } from '@nestjs/common';
import { BrokerController } from './broker.controller';
import { BrokerCommissionRuleController } from './broker-commission-rule.controller';
import { BrokerService } from './broker.service';
import { BrokerCommissionRuleService } from './broker-commission-rule.service';
import { PanEncryptionService } from '../common/pan-encryption.service';

@Module({
  controllers: [BrokerController, BrokerCommissionRuleController],
  providers: [BrokerService, BrokerCommissionRuleService, PanEncryptionService],
  exports: [BrokerService, BrokerCommissionRuleService, PanEncryptionService],
})
export class BrokersModule {}
