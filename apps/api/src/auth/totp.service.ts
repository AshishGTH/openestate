import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

@Injectable()
export class TotpService {
  private readonly encryptionKey: Buffer;

  constructor(config: ConfigService) {
    const keyHex = config.getOrThrow<string>('TOTP_ENCRYPTION_KEY');
    this.encryptionKey = Buffer.from(keyHex, 'hex');
    if (this.encryptionKey.length !== 32) {
      throw new Error('TOTP_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
    }
  }

  generateSecret(): { secret: string; otpauthUrl: string } {
    const totp = new OTPAuth.TOTP({
      issuer: 'OpenEstate',
      label: 'OpenEstate CRM',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
    return {
      secret: totp.secret.base32,
      otpauthUrl: totp.toString(),
    };
  }

  verify(secret: string, code: string): boolean {
    const totp = new OTPAuth.TOTP({
      issuer: 'OpenEstate',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const delta = totp.validate({ token: code, window: 1 });
    return delta !== null;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
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

  generateRecoveryCodes(count = 8): string[] {
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const bytes = randomBytes(5);
      codes.push(
        bytes
          .toString('hex')
          .toUpperCase()
          .replace(/(.{5})/g, '$1-')
          .slice(0, -1),
      );
    }
    return codes;
  }
}
