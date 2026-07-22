import { Module } from '@nestjs/common';
import { ClockProvider } from '../common/clock.provider';
import { InventoryModule } from '../inventory/inventory.module';
import { BrokersModule } from '../brokers/brokers.module';
import { BookingController } from './booking.controller';
import { ReceiptController } from './receipt.controller';
import { RefundController } from './refund.controller';
import { BookingDraftController } from './booking-draft.controller';
import { BookingDraftService } from './booking-draft.service';
import { PlanHistoryController } from './plan-history.controller';
import { NumberSequenceService } from './number-sequence.service';
import { LedgerService } from './ledger.service';
import { BookingService } from './booking.service';
import { PaymentPlanService } from './payment-plan.service';
import { ReceiptService } from './receipt.service';
import { ExtraChargeService } from './extra-charge.service';
import { InterestService } from './interest.service';
import { InterestScheduler, InterestProcessor } from './interest.scheduler';
import { TransferService } from './transfer.service';
import { CancellationService } from './cancellation.service';
import { RefundService } from './refund.service';

@Module({
  imports: [InventoryModule, BrokersModule],
  controllers: [BookingController, ReceiptController, RefundController, BookingDraftController, PlanHistoryController],
  providers: [
    ClockProvider,
    NumberSequenceService,
    LedgerService,
    BookingService,
    PaymentPlanService,
    ReceiptService,
    ExtraChargeService,
    InterestService,
    InterestScheduler,
    InterestProcessor,
    TransferService,
    CancellationService,
    RefundService,
    BookingDraftService,
  ],
  exports: [LedgerService, BookingService, ReceiptService, InterestService],
})
export class PostsalesModule {}
