import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paginationQuerySchema } from '@openestate/shared';

/**
 * Regression guard for the exact bug that broke UserForm.tsx's manager
 * picker (v0.4): a hardcoded `?limit=500` query string exceeded
 * paginationQuerySchema's real max (100), the request 400'd, and nothing
 * surfaced the failure — the dropdown just silently stayed empty. This is
 * the third or fourth instance of "frontend sends a value a `.strict()`
 * schema rejects, 400s, nothing visible" in this codebase (see
 * `pickForSchema`'s own history) — `pickForSchema` doesn't apply here
 * (it projects a request BODY onto an update schema; this bug is a query
 * STRING literal), so this is a standalone grep+schema-validate guard
 * instead, matching `team-scope-guard.test.ts`'s established pattern.
 *
 * Every `limit=N` literal found in source is validated against the REAL
 * schema (not a hardcoded threshold that could drift out of sync with it).
 */
const SRC_ROOT = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('no hardcoded limit= query param exceeds paginationQuerySchema.limit', () => {
  it('every literal limit=N in source parses against the real schema', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(/limit=(\d+)/g)) {
        const value = Number(match[1]);
        const result = paginationQuerySchema.shape.limit.safeParse(value);
        if (!result.success) {
          offenders.push(`${file}: limit=${value} (${result.error.issues[0]?.message})`);
        }
      }
    }
    expect(
      offenders,
      `Found a hardcoded limit= exceeding paginationQuerySchema's real max — this 400s silently:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
