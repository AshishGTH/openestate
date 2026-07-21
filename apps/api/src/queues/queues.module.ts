import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import Redis from 'ioredis';
import {
  COMMUNICATION_PROVIDER,
  ConsoleCommunicationProvider,
} from './communication-provider';

export const COMMUNICATION_QUEUE = 'communication';
export const ESCALATION_QUEUE = 'escalation';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
          maxRetriesPerRequest: null,
        }),
      }),
    }),
    BullModule.registerQueue(
      { name: COMMUNICATION_QUEUE },
      { name: ESCALATION_QUEUE },
    ),
  ],
  providers: [
    { provide: COMMUNICATION_PROVIDER, useClass: ConsoleCommunicationProvider },
  ],
  exports: [BullModule, COMMUNICATION_PROVIDER],
})
export class QueuesModule {}
