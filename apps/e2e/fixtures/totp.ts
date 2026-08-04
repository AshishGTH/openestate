import * as OTPAuth from 'otpauth';

// Same library, same params (SHA1/6 digits/30s) as apps/api/src/auth/totp.service.ts —
// reusing the real library the backend verifies against, not a hand-rolled
// HMAC-SHA1 implementation, so this can't drift from what the server
// actually accepts.
export function currentTotpCode(base32Secret: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: 'OpenEstate',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(base32Secret),
  });
  return totp.generate();
}
