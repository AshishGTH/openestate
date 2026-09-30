import { describe, expect, it } from 'vitest';
import { dayBoundsInTimeZone, isValidTimeZone } from '../src/tz';

const iso = (d: Date) => d.toISOString();

describe('dayBoundsInTimeZone', () => {
  it('Asia/Kolkata (+05:30, no DST): the local day starts at 18:30Z the day before', () => {
    const b = dayBoundsInTimeZone(new Date('2026-09-30T10:00:00Z'), 'Asia/Kolkata');
    expect([iso(b.start), iso(b.end)]).toEqual(['2026-09-29T18:30:00.000Z', '2026-09-30T18:30:00.000Z']);
  });
  it('uses the COMPANY day, not the UTC day: 20:00Z is already tomorrow in Kolkata', () => {
    const b = dayBoundsInTimeZone(new Date('2026-09-30T20:00:00Z'), 'Asia/Kolkata');
    expect(iso(b.start)).toBe('2026-09-30T18:30:00.000Z');
    expect(iso(b.end)).toBe('2026-10-01T18:30:00.000Z');
  });
  it('the boundary instants belong to the right days (start inclusive, end exclusive)', () => {
    const at = (s: string) => dayBoundsInTimeZone(new Date(s), 'Asia/Kolkata').start.toISOString();
    expect(at('2026-09-29T18:30:00Z')).toBe('2026-09-29T18:30:00.000Z');
    expect(at('2026-09-29T18:29:59Z')).toBe('2026-09-28T18:30:00.000Z');
  });
  it('UTC', () => {
    const b = dayBoundsInTimeZone(new Date('2026-09-30T23:59:59Z'), 'UTC');
    expect([iso(b.start), iso(b.end)]).toEqual(['2026-09-30T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
  });
  it('a 25-hour day: America/New_York falls back on 1 Nov 2026', () => {
    const b = dayBoundsInTimeZone(new Date('2026-11-01T12:00:00Z'), 'America/New_York');
    expect([iso(b.start), iso(b.end)]).toEqual(['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']);
    expect((b.end.getTime() - b.start.getTime()) / 3_600_000).toBe(25);
  });
  it('a 23-hour day: America/New_York springs forward on 8 Mar 2026', () => {
    const b = dayBoundsInTimeZone(new Date('2026-03-08T15:00:00Z'), 'America/New_York');
    expect([iso(b.start), iso(b.end)]).toEqual(['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z']);
    expect((b.end.getTime() - b.start.getTime()) / 3_600_000).toBe(23);
  });
  it('a zone east of the date line: 12:00Z on 31 Dec is already 1 Jan in Auckland (+13)', () => {
    const b = dayBoundsInTimeZone(new Date('2026-12-31T12:00:00Z'), 'Pacific/Auckland');
    expect([iso(b.start), iso(b.end)]).toEqual(['2026-12-31T11:00:00.000Z', '2027-01-01T11:00:00.000Z']);
  });
  it('an unknown or empty zone falls back to Asia/Kolkata instead of throwing', () => {
    for (const tz of ['Not/AZone', '', 'x'.repeat(50)]) {
      const b = dayBoundsInTimeZone(new Date('2026-09-30T10:00:00Z'), tz);
      expect(b.timeZone).toBe('Asia/Kolkata');
      expect(iso(b.start)).toBe('2026-09-29T18:30:00.000Z');
    }
  });
  it('isValidTimeZone', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Nope/Zone')).toBe(false);
  });
});
