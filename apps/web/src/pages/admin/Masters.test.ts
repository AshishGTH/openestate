import { describe, it, expect } from 'vitest';
import { MASTER_CATEGORIES } from './Masters';

/**
 * Regression guard for the categorisation refactor: MASTER_CATEGORIES
 * replaced a single flat MASTER_TABLES array (each master type declared
 * once, no grouping) with a nested {category, tables}[] config that
 * MASTER_TABLES is now derived from via flatMap. A config typo — a table
 * left out while splitting into categories, one accidentally listed under
 * two categories, or a future addition forgetting to name a category at
 * all — would silently drop or duplicate a master type from the UI with no
 * error, the exact "declared with intent, never wired in" class of bug this
 * codebase has hit before (see CLAUDE.md's lint-rules entry). This list is
 * frozen at exactly what the flat MASTER_TABLES contained immediately
 * before the refactor — the ground truth this guards against drifting
 * from, not something to update casually when a master type's grouping
 * changes.
 */
const ORIGINAL_MASTER_KEYS = [
  'unit-types',
  'plc-types',
  'inquiry-sources',
  'inquiry-types',
  'inquiry-temperatures',
  'follow-up-types',
  'dump-reasons',
  'ticket-categories',
  'communication-types',
  'project-types',
  'receipt-types',
  'registration-types',
  'area-locations',
  'document-types',
  'charge-types',
  'banks',
  'interest-rules',
  'transfer-fee-rules',
  'payment-plan-templates',
  'gst-rates',
  'tds-rules',
  'letter-templates',
];

describe('MASTER_CATEGORIES', () => {
  it('flattens to exactly the same set of keys as the original flat list — no additions, no omissions, no duplicates', () => {
    const flattenedKeys = MASTER_CATEGORIES.flatMap((c) => c.tables.map((t) => t.key));

    expect(flattenedKeys.length, 'total table count changed').toBe(ORIGINAL_MASTER_KEYS.length);
    expect(new Set(flattenedKeys).size, 'a key appears more than once across categories').toBe(
      flattenedKeys.length,
    );

    const missing = ORIGINAL_MASTER_KEYS.filter((k) => !flattenedKeys.includes(k));
    const added = flattenedKeys.filter((k) => !ORIGINAL_MASTER_KEYS.includes(k));
    expect(missing, 'key(s) present before the refactor but missing now — silently vanished from the UI').toEqual([]);
    expect(added, 'key(s) present now but not before — an addition with no matching category entry expected').toEqual(
      [],
    );
  });

  it('every category has at least one table (no empty category declared in config)', () => {
    for (const category of MASTER_CATEGORIES) {
      expect(category.tables.length, `category "${category.category}" has zero tables`).toBeGreaterThan(0);
    }
  });
});
