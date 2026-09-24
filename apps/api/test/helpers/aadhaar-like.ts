import { verhoeffCheckDigit } from '@openestate/shared';

// Test values for the Aadhaar guard. Never a hardcoded 12-digit number:
// random digits (first digit 2-9) plus a computed Verhoeff check digit.
// Such a value could in principle collide with a real Aadhaar number, but
// it is never written anywhere outside a disposable test database.
export function aadhaarLike(): string {
  let body = String(2 + Math.floor(Math.random() * 8));
  for (let i = 0; i < 10; i++) body += String(Math.floor(Math.random() * 10));
  return body + verhoeffCheckDigit(body);
}

/** A valid value with its check digit changed — always fails Verhoeff. */
export function withWrongCheckDigit(valid: string): string {
  return valid.slice(0, 11) + String((Number(valid[11]) + 1) % 10);
}

export const spaced = (n: string) => `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8)}`;
