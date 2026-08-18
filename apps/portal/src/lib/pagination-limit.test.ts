import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paginationQuerySchema } from '@openestate/shared';

/**
 * Same guard as apps/web/src/lib/pagination-limit.test.ts, duplicated
 * here rather than shared — matches this pair's existing precedent
 * (api.test.ts exists identically in both) — see that file's comment
 * for the full "why" (v0.4's UserForm.tsx manager-picker bug: a
 * hardcoded limit= exceeding paginationQuerySchema's real max 400s
 * silently, nothing surfaces the failure).
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
