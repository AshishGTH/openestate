import { Module } from '@nestjs/common';
import { CommissionService } from './commission.service';
import { CommissionPaymentService } from './commission-payment.service';
import { CommissionPaymentController } from './commission-payment.controller';
import { BrokersModule } from '../brokers/brokers.module';

@Module({
  imports: [BrokersModule],
  controllers: [CommissionPaymentController],
  providers: [CommissionService, CommissionPaymentService],
  exports: [CommissionService, CommissionPaymentService],
})
export class CommissionModule {}
