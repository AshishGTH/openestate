import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

export const COMMUNICATION_PROVIDER = 'COMMUNICATION_PROVIDER';

export interface CommunicationMessage {
  channel: 'EMAIL' | 'SMS';
  toAddress: string;
  subject?: string;
  body: string;
}

export interface CommunicationSendResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface CommunicationProvider {
  send(message: CommunicationMessage): Promise<CommunicationSendResult>;
}

/**
 * Dev provider: logs the message to the console instead of calling a real
 * SMS/email gateway. Real providers (MSG91, Textlocal, SMTP/mailpit, generic
 * HTTP) are plugins (Phase 7) implementing the same CommunicationProvider
 * interface, swapped in via the COMMUNICATION_PROVIDER DI token.
 */
@Injectable()
export class ConsoleCommunicationProvider implements CommunicationProvider {
  private readonly logger = new Logger(ConsoleCommunicationProvider.name);

  async send(message: CommunicationMessage): Promise<CommunicationSendResult> {
    this.logger.log(
      `[dev-provider] ${message.channel} -> ${message.toAddress}` +
        (message.subject ? ` | subject="${message.subject}"` : '') +
        ` | body="${message.body}"`,
    );
    return { success: true, providerMessageId: `console-${randomUUID()}` };
  }
}
