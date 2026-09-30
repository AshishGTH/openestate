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

describe('dayBoundsInTimeZone: zones behind UTC, half-hour DST, and transitions at midnight', () => {
  const hours = (b: { start: Date; end: Date }) => (b.end.getTime() - b.start.getTime()) / 3_600_000;
  const bounds = (at: string, tz: string) => {
    const b = dayBoundsInTimeZone(new Date(at), tz);
    return { start: iso(b.start), end: iso(b.end), hours: hours(b) };
  };
  it('behind UTC: America/Los_Angeles is still on the previous day at 03:00Z', () => {
    expect(bounds('2026-09-30T03:00:00Z', 'America/Los_Angeles')).toEqual({ start: '2026-09-29T07:00:00.000Z', end: '2026-09-30T07:00:00.000Z', hours: 24 });
  });
  it('Los_Angeles: 25-hour day on 1 Nov 2026 and 23-hour day on 8 Mar 2026', () => {
    expect(bounds('2026-11-01T12:00:00Z', 'America/Los_Angeles')).toEqual({ start: '2026-11-01T07:00:00.000Z', end: '2026-11-02T08:00:00.000Z', hours: 25 });
    expect(bounds('2026-03-08T12:00:00Z', 'America/Los_Angeles')).toEqual({ start: '2026-03-08T08:00:00.000Z', end: '2026-03-09T07:00:00.000Z', hours: 23 });
  });
  it('Europe/London: 25 hours on 25 Oct 2026 (BST ends) and 23 on 29 Mar 2026 (BST starts); a day at UTC+0 offset in winter', () => {
    expect(bounds('2026-10-25T12:00:00Z', 'Europe/London')).toEqual({ start: '2026-10-24T23:00:00.000Z', end: '2026-10-26T00:00:00.000Z', hours: 25 });
    expect(bounds('2026-03-29T12:00:00Z', 'Europe/London')).toEqual({ start: '2026-03-29T00:00:00.000Z', end: '2026-03-29T23:00:00.000Z', hours: 23 });
    expect(bounds('2026-01-15T12:00:00Z', 'Europe/London')).toEqual({ start: '2026-01-15T00:00:00.000Z', end: '2026-01-16T00:00:00.000Z', hours: 24 });
  });
  it('Australia/Lord_Howe shifts by 30 minutes: 24.5-hour and 23.5-hour days', () => {
    expect(bounds('2026-04-05T00:00:00Z', 'Australia/Lord_Howe')).toEqual({ start: '2026-04-04T13:00:00.000Z', end: '2026-04-05T13:30:00.000Z', hours: 24.5 });
    expect(bounds('2026-10-04T00:00:00Z', 'Australia/Lord_Howe')).toEqual({ start: '2026-10-03T13:30:00.000Z', end: '2026-10-04T13:00:00.000Z', hours: 23.5 });
  });
  it('Asia/Kathmandu (+05:45)', () => {
    expect(bounds('2026-09-30T10:00:00Z', 'Asia/Kathmandu')).toEqual({ start: '2026-09-29T18:15:00.000Z', end: '2026-09-30T18:15:00.000Z', hours: 24 });
  });
  it('a zone whose DST starts AT midnight (Africa/Cairo, 24 Apr 2026): the day begins at 01:00 local, 23 hours long', () => {
    expect(bounds('2026-04-24T12:00:00Z', 'Africa/Cairo')).toEqual({ start: '2026-04-23T22:00:00.000Z', end: '2026-04-24T21:00:00.000Z', hours: 23 });
  });
  it('an instant is always inside the day it is reported for, in every zone, across a year of hourly samples', () => {
    for (const tz of ['Asia/Kolkata', 'UTC', 'Pacific/Auckland', 'America/Los_Angeles', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Africa/Cairo', 'America/New_York']) {
      for (let h = 0; h < 366 * 24; h += 7) {
        const at = new Date(Date.UTC(2026, 0, 1) + h * 3_600_000);
        const b = dayBoundsInTimeZone(at, tz);
        expect(b.start.getTime() <= at.getTime() && at.getTime() < b.end.getTime(), `${tz} ${at.toISOString()}`).toBe(true);
        const len = (b.end.getTime() - b.start.getTime()) / 3_600_000;
        expect([23, 23.5, 24, 24.5, 25]).toContain(len);
      }
    }
  });
});

