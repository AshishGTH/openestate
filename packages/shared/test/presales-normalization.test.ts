import { describe, it, expect } from 'vitest';
import {
  normalizePhone,
  normalizeEmail,
  computeAgeingBucket,
  isFollowUpOverdue,
  isEscalationEligible,
} from '../src/presales';

describe('normalizePhone', () => {
  it('normalizes +91 prefixed Indian mobile numbers', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('9876543210');
  });

  it('normalizes bare 91-prefixed Indian mobile numbers', () => {
    expect(normalizePhone('919876543210')).toBe('9876543210');
  });

  it('normalizes 0-trunk-prefixed Indian mobile numbers', () => {
    expect(normalizePhone('09876543210')).toBe('9876543210');
  });

  it('leaves an already-canonical 10-digit Indian mobile untouched', () => {
    expect(normalizePhone('9876543210')).toBe('9876543210');
  });

  it('does not corrupt an NRI-style number (US, +1)', () => {
    expect(normalizePhone('+14155551234')).toBe('+14155551234');
  });

  it('matches an identical NRI-style number by exact string equality', () => {
    const a = normalizePhone('+14155551234');
    const b = normalizePhone('+14155551234');
    expect(a).toBe(b);
  });

  it('does not falsely match an unrelated 10-digit Indian number', () => {
    const nri = normalizePhone('+14155551234');
    const indian = normalizePhone('9876543210');
    expect(nri).not.toBe(indian);
  });

  it('does not normalize a 10-digit number not starting 6-9', () => {
    expect(normalizePhone('1234567890')).toBe('1234567890');
  });

  it('trims whitespace on unnormalizable input', () => {
    expect(normalizePhone('  +14155551234  ')).toBe('+14155551234');
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Foo.Bar@Example.COM  ')).toBe('foo.bar@example.com');
  });
});

describe('computeAgeingBucket', () => {
  const now = new Date('2026-07-21T00:00:00.000Z');

  it('buckets 0-7 days', () => {
    expect(computeAgeingBucket(new Date('2026-07-18T00:00:00.000Z'), now)).toBe('0-7');
    expect(computeAgeingBucket(new Date('2026-07-14T00:00:00.000Z'), now)).toBe('0-7');
  });

  it('buckets 8-30 days', () => {
    expect(computeAgeingBucket(new Date('2026-07-13T00:00:00.000Z'), now)).toBe('8-30');
    expect(computeAgeingBucket(new Date('2026-06-21T00:00:00.000Z'), now)).toBe('8-30');
  });

  it('buckets 31-90 days', () => {
    expect(computeAgeingBucket(new Date('2026-06-20T00:00:00.000Z'), now)).toBe('31-90');
    expect(computeAgeingBucket(new Date('2026-04-22T00:00:00.000Z'), now)).toBe('31-90');
  });

  it('buckets 90+ days', () => {
    expect(computeAgeingBucket(new Date('2026-04-21T00:00:00.000Z'), now)).toBe('90+');
    expect(computeAgeingBucket(new Date('2025-01-01T00:00:00.000Z'), now)).toBe('90+');
  });
});

describe('isFollowUpOverdue', () => {
  const now = new Date('2026-07-21T12:00:00.000Z');

  it('is overdue when nextFollowupAt is in the past', () => {
    expect(isFollowUpOverdue(new Date('2026-07-21T00:00:00.000Z'), now)).toBe(true);
  });

  it('is not overdue when nextFollowupAt is in the future', () => {
    expect(isFollowUpOverdue(new Date('2026-07-22T00:00:00.000Z'), now)).toBe(false);
  });

  it('is not overdue when nextFollowupAt is null', () => {
    expect(isFollowUpOverdue(null, now)).toBe(false);
  });
});

describe('isEscalationEligible', () => {
  const now = new Date('2026-07-21T12:00:00.000Z');
  const overdue = new Date('2026-07-20T00:00:00.000Z');
  const future = new Date('2026-07-25T00:00:00.000Z');

  it('is not eligible when not overdue', () => {
    expect(isEscalationEligible(future, null, now)).toBe(false);
  });

  it('is eligible when overdue and never escalated', () => {
    expect(isEscalationEligible(overdue, null, now)).toBe(true);
  });

  it('is not eligible when already escalated after the current nextFollowupAt was set', () => {
    const lastEscalatedAfter = new Date('2026-07-20T06:00:00.000Z');
    expect(isEscalationEligible(overdue, lastEscalatedAfter, now)).toBe(false);
  });

  it('is eligible again when nextFollowupAt was pushed forward after the last escalation and has now lapsed', () => {
    const lastEscalatedBefore = new Date('2026-07-19T00:00:00.000Z');
    expect(isEscalationEligible(overdue, lastEscalatedBefore, now)).toBe(true);
  });
});
