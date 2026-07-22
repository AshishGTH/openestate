import { Module } from '@nestjs/common';
import { BrokerReportsController } from './broker-reports.controller';
import { BrokerReportsService } from './broker-reports.service';

@Module({
  controllers: [BrokerReportsController],
  providers: [BrokerReportsService],
})
export class BrokerReportsModule {}
