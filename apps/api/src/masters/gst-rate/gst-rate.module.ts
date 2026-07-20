import { Module } from '@nestjs/common';
import { GstRateController } from './gst-rate.controller';
import { GstRateService } from './gst-rate.service';

@Module({
  controllers: [GstRateController],
  providers: [GstRateService],
  exports: [GstRateService],
})
export class GstRateModule {}
