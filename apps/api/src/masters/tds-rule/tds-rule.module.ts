import { Module } from '@nestjs/common';
import { TdsRuleController } from './tds-rule.controller';
import { TdsRuleService } from './tds-rule.service';

@Module({
  controllers: [TdsRuleController],
  providers: [TdsRuleService],
  exports: [TdsRuleService],
})
export class TdsRuleModule {}
