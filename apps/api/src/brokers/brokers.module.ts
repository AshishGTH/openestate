import { Module } from '@nestjs/common';
import { BrokerController } from './broker.controller';
import { BrokerCommissionRuleController } from './broker-commission-rule.controller';
import { NocController } from './noc.controller';
import { BrokerService } from './broker.service';
import { BrokerCommissionRuleService } from './broker-commission-rule.service';
import { NocService } from './noc.service';
import { PanEncryptionService } from '../common/pan-encryption.service';

@Module({
  controllers: [BrokerController, BrokerCommissionRuleController, NocController],
  providers: [BrokerService, BrokerCommissionRuleService, NocService, PanEncryptionService],
  exports: [BrokerService, BrokerCommissionRuleService, NocService, PanEncryptionService],
})
export class BrokersModule {}
