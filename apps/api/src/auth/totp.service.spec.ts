import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { TotpService } from './totp.service';

// Regression coverage for the QR-code enrolment change: generateSecret()
// went from taking no arguments (hardcoded label: 'OpenEstate CRM') to
// taking a caller-supplied label (the user's email/phone/name), plus a
// server-rendered qrDataUrl built from the same otpauthUrl. The risk this
// pins down is the classic bug in this area — otpauth already
// URL-encodes the label in toString(), so pre-encoding it here would
// double-encode (e.g. an email's "@" becoming "%2540" instead of "%40").

function fakeConfigService(): { getOrThrow: (key: string) => string } {
  return {
    getOrThrow: (key: string) => {
      if (key === 'TOTP_ENCRYPTION_KEY') return 'a1b2c3d4'.repeat(8);
      throw new Error(`unexpected config key: ${key}`);
    },
  };
}

// RFC 6238, matching TotpService exactly: SHA1, 6 digits, 30s period.
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of input.replace(/=+$/, '').toUpperCase()) {
    const val = alphabet.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpCode(secretBase32: string): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

describe('TotpService.generateSecret', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new TotpService(fakeConfigService() as any);

  it('URL-encodes the label exactly once, including an email with @ and +', () => {
    const label = 'user+test@example.com';
    const { otpauthUrl } = service.generateSecret(label);

    expect(otpauthUrl).toContain(encodeURIComponent(label));
    // The classic double-encoding bug: pre-encoding before otpauth's own
    // toString() encodes again turns "@" into "%2540" instead of "%40".
    expect(otpauthUrl).not.toContain('%2540');
    expect(otpauthUrl).not.toContain('%252B');
  });

  it('qrDataUrl decodes to an SVG', () => {
    const { qrDataUrl } = service.generateSecret('someone@example.com');
    expect(qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(qrDataUrl.split(',')[1], 'base64').toString('utf8');
    expect(svg).toContain('<svg');
  });

  it('the label is display-only: verify() works the same regardless of the label used at generation', () => {
    const a = service.generateSecret('label-a@example.com');
    expect(service.verify(a.secret, totpCode(a.secret))).toBe(true);

    const b = service.generateSecret('label-b@example.com');
    expect(service.verify(b.secret, totpCode(b.secret))).toBe(true);
  });
});
