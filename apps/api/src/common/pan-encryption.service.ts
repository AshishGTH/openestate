import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * PAN encryption at rest (AES-256-GCM, PAN_ENCRYPTION_KEY) — the columns
 * for this have existed on Applicant since Phase 4
 * (panCiphertext/panMasked/panKeyVersion) but no encryption service was
 * ever built; this is the first one, modeled directly on
 * TotpService's identical AES-256-GCM implementation
 * (apps/api/src/auth/totp.service.ts). Phase 5 wires it only to
 * Broker.pan* — retrofitting Applicant is docs/todo.md, not this phase.
 *
 * Reads PAN_ENCRYPTION_KEY directly from process.env rather than Nest's
 * ConfigService, deliberately: every other Phase 4/5 service in this
 * codebase is constructed directly in integration tests
 * (`new XxxService(...)`, no DI container), and this keeps
 * PanEncryptionService constructible the same zero-argument way rather
 * than requiring a real ConfigService instance in every test.
 */
@Injectable()
export class PanEncryptionService {
  private readonly encryptionKey: Buffer;

  constructor() {
    const keyHex = process.env.PAN_ENCRYPTION_KEY;
    if (!keyHex) {
      throw new Error('PAN_ENCRYPTION_KEY is not set');
    }
    this.encryptionKey = Buffer.from(keyHex, 'hex');
    if (this.encryptionKey.length !== 32) {
      throw new Error('PAN_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  decrypt(ciphertext: string): string {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }

  /** PAN display mask, e.g. "ABCDE1234F" → "XXXXX1234F" (last 5 chars visible). */
  mask(pan: string): string {
    if (pan.length !== 10) return 'X'.repeat(pan.length);
    return 'X'.repeat(5) + pan.slice(5);
  }
}
