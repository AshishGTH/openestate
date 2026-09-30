// Day boundaries in an IANA time zone, without a date library. Used so "today"
// means the COMPANY's day (CompanyConfig.timezone, default Asia/Kolkata), not the
// API server's, whatever zone the server happens to run in.

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/** True when `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `tz` from UTC at the instant `utcMs`, in ms (positive east of UTC). */
function offsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return local - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant at which the local calendar date (y, m, d) begins in `tz`. */
function localMidnightUtc(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = offsetMs(guess, tz);
  const t = guess - first;
  const second = offsetMs(t, tz);
  // Crossing a DST change between the guess and the answer: use the offset in force at the answer.
  return second === first ? t : guess - second;
}

/**
 * `[start, end)` of the local day containing `now` in `tz`, as UTC instants. A
 * day is 23, 24 or 25 hours long across a DST change. An unknown `tz` falls
 * back to DEFAULT_TIME_ZONE rather than throwing (the setting is free text).
 */
export function dayBoundsInTimeZone(now: Date, tz: string): { start: Date; end: Date; timeZone: string } {
  const timeZone = isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
  const p = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
  const num = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const y = num('year');
  const m = num('month');
  const d = num('day');
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    start: new Date(localMidnightUtc(y, m, d, timeZone)),
    end: new Date(localMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone)),
    timeZone,
  };
}
