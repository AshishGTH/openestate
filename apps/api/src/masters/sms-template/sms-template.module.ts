import { Module } from '@nestjs/common';
import { SmsTemplateController } from './sms-template.controller';
import { SmsTemplateService } from './sms-template.service';

@Module({
  controllers: [SmsTemplateController],
  providers: [SmsTemplateService],
  exports: [SmsTemplateService],
})
export class SmsTemplateModule {}
