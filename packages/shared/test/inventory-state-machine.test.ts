import { describe, it, expect } from 'vitest';
import {
  isValidTransition,
  UNIT_TRANSITIONS,
  UNIT_STATUS,
  REASON_REQUIRED_STATUSES,
} from '../src/inventory';
import type { UnitStatus } from '../src/inventory';

describe('Unit Status State Machine', () => {
  it('AVAILABLE can transition to HELD, BLOCKED, BOOKED', () => {
    expect(isValidTransition('AVAILABLE', 'HELD')).toBe(true);
    expect(isValidTransition('AVAILABLE', 'BLOCKED')).toBe(true);
    expect(isValidTransition('AVAILABLE', 'BOOKED')).toBe(true);
  });

  it('AVAILABLE cannot transition to ALLOTTED, REGISTERED, CANCELLED', () => {
    expect(isValidTransition('AVAILABLE', 'ALLOTTED')).toBe(false);
    expect(isValidTransition('AVAILABLE', 'REGISTERED')).toBe(false);
    expect(isValidTransition('AVAILABLE', 'CANCELLED')).toBe(false);
  });

  it('HELD can transition to BOOKED and AVAILABLE only', () => {
    expect(isValidTransition('HELD', 'BOOKED')).toBe(true);
    expect(isValidTransition('HELD', 'AVAILABLE')).toBe(true);
    expect(isValidTransition('HELD', 'BLOCKED')).toBe(false);
    expect(isValidTransition('HELD', 'ALLOTTED')).toBe(false);
  });

  it('BLOCKED can only transition back to AVAILABLE', () => {
    expect(isValidTransition('BLOCKED', 'AVAILABLE')).toBe(true);
    expect(isValidTransition('BLOCKED', 'HELD')).toBe(false);
    expect(isValidTransition('BLOCKED', 'BOOKED')).toBe(false);
  });

  it('BOOKED can transition to ALLOTTED and CANCELLED', () => {
    expect(isValidTransition('BOOKED', 'ALLOTTED')).toBe(true);
    expect(isValidTransition('BOOKED', 'CANCELLED')).toBe(true);
    expect(isValidTransition('BOOKED', 'AVAILABLE')).toBe(false);
    expect(isValidTransition('BOOKED', 'HELD')).toBe(false);
  });

  it('ALLOTTED can transition to REGISTERED and CANCELLED', () => {
    expect(isValidTransition('ALLOTTED', 'REGISTERED')).toBe(true);
    expect(isValidTransition('ALLOTTED', 'CANCELLED')).toBe(true);
    expect(isValidTransition('ALLOTTED', 'AVAILABLE')).toBe(false);
  });

  it('REGISTERED is terminal (no valid transitions)', () => {
    const allStatuses = Object.values(UNIT_STATUS) as UnitStatus[];
    for (const status of allStatuses) {
      expect(isValidTransition('REGISTERED', status)).toBe(false);
    }
  });

  it('CANCELLED can only transition to AVAILABLE (re-release)', () => {
    expect(isValidTransition('CANCELLED', 'AVAILABLE')).toBe(true);
    expect(isValidTransition('CANCELLED', 'HELD')).toBe(false);
    expect(isValidTransition('CANCELLED', 'BOOKED')).toBe(false);
  });

  it('all statuses are represented in the transition map', () => {
    const allStatuses = Object.values(UNIT_STATUS) as UnitStatus[];
    for (const status of allStatuses) {
      expect(UNIT_TRANSITIONS).toHaveProperty(status);
    }
  });

  it('BLOCKED and CANCELLED require reason', () => {
    expect(REASON_REQUIRED_STATUSES).toContain('BLOCKED');
    expect(REASON_REQUIRED_STATUSES).toContain('CANCELLED');
    expect(REASON_REQUIRED_STATUSES).not.toContain('AVAILABLE');
    expect(REASON_REQUIRED_STATUSES).not.toContain('HELD');
  });
});
