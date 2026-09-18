import { HttpException, HttpStatus } from '@nestjs/common';
import type { PrismaClient } from '@openestate/db';

/**
 * Second-factor lockout, shared by staff and portal totp/verify so the two
 * can't drift. Deliberately separate from the password lockout
 * (failedLoginAttempts/lockedUntil): that one gates the PASSWORD step, and an
 * attacker who already has the password could otherwise use wrong codes to
 * lock the owner out of their own account on demand. Nothing here touches
 * the password fields.
 *
 * The per-user rate limit (TotpVerifyThrottlerGuard) is the primary control.
 * This counter lives on the user row, so it holds across BOTH verify
 * endpoints — a 2FA-pending token is accepted by both, and the rate limit
 * keys them separately — and survives a Redis flush.
 */
export const MAX_FAILED_TOTP_ATTEMPTS = 5;
export const TOTP_LOCKOUT_MINUTES = 5;
export const TOTP_LOCKED_MESSAGE = 'Too many incorrect codes. Wait a few minutes, then sign in again.';

/** Spread into the update that follows a successful verify. */
export const TOTP_ATTEMPTS_CLEARED = { failedTotpAttempts: 0, totpLockedUntil: null };

/**
 * Everything that has to go for a clean re-enrolment — the credentials AND
 * the lockout state. Shared by self-service disable (staff and portal) and
 * the admin 2FA reset, so those four call sites cannot drift apart.
 *
 * The two lockout fields are the part that is easy to leave out, and leaving
 * them out is a real defect, not tidiness: a user who burned five codes is
 * locked for TOTP_LOCKOUT_MINUTES, and that lock outlives a disable. Turn 2FA
 * off and straight back on inside that window — exactly what someone does
 * after locking themselves out, and exactly the flow the admin reset exists
 * for — and the first code from the brand-new authenticator is refused 429 by
 * a lock belonging to the secret that was just thrown away. Outside the
 * window it self-heals, which is why it went unnoticed.
 */
export const TOTP_CLEARED = {
  totpEnabled: false,
  totpSecret: null,
  recoveryCodes: [] as string[],
  ...TOTP_ATTEMPTS_CLEARED,
};

/**
 * Reserves one attempt before the code is checked, or throws 429 if the user
 * is TOTP-locked — the code is never evaluated while locked, so the response
 * can't reveal whether it was right. A successful verify then clears the
 * counter; a failure leaves the reservation counted. The 5th reservation sets
 * the lock. A lock that has run out restarts the count at this attempt
 * rather than re-locking on it.
 *
 * Raw SQL because it must be one statement: a read-then-write lets N
 * concurrent requests all pass the lock check before any failure is recorded.
 * Under READ COMMITTED, Postgres re-checks the WHERE after taking the row
 * lock, so concurrent reservations serialise and stop at the limit.
 * Parameters are bound, never interpolated. The column is TIMESTAMP (no time
 * zone) holding UTC, as Prisma writes it, so the comparison and the new value
 * both use `now() AT TIME ZONE 'UTC'` — a bare now() would be shifted by the
 * session time zone (Asia/Kolkata on the verification VM).
 */
export async function reserveTotpAttempt(prisma: PrismaClient, userId: string): Promise<void> {
  const reserved = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE users SET
      failed_totp_attempts = CASE WHEN totp_locked_until IS NULL THEN failed_totp_attempts + 1 ELSE 1 END,
      totp_locked_until = CASE
        WHEN (CASE WHEN totp_locked_until IS NULL THEN failed_totp_attempts + 1 ELSE 1 END) >= ${MAX_FAILED_TOTP_ATTEMPTS}::int
          THEN (now() AT TIME ZONE 'UTC') + ${TOTP_LOCKOUT_MINUTES}::int * interval '1 minute'
        ELSE NULL
      END
    WHERE id = ${userId}::uuid
      AND (totp_locked_until IS NULL OR totp_locked_until <= (now() AT TIME ZONE 'UTC'))
    RETURNING id
  `;
  if (reserved.length === 0) {
    throw new HttpException(TOTP_LOCKED_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
  }
}
