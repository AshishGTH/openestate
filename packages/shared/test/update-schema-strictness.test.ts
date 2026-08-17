import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import * as shared from '../src';

/**
 * Regression guard for the bug class that hit UserForm.tsx, BrokerDetail's
 * Pay button, and Masters.tsx's PATCH — a create-shaped payload sent
 * straight to a `.strict()` update endpoint, carrying a field the update
 * schema never declared. `pickForSchema` (dto-utils.ts) fixes the frontend
 * side by projecting onto the update schema instead of subtracting from
 * the create schema; this test proves the OTHER half — the update schema
 * itself actually rejects any field unique to its create sibling, for
 * every create/update pair this package exports. If a future update
 * schema silently grows to accept a create-only field (e.g. someone
 * "fixes" a 400 by widening the schema instead of fixing the caller),
 * this fails loudly instead of quietly reopening the class of bug
 * `pickForSchema` exists to prevent.
 */
describe('every exported create*Schema/update*Schema pair', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exported = shared as Record<string, any>;
  const createKeys = Object.keys(exported).filter((k) => /^create[A-Z]\w*Schema$/.test(k));

  for (const createKey of createKeys) {
    const base = createKey.slice('create'.length, -'Schema'.length);
    const updateKey = `update${base}Schema`;
    const createSchema = exported[createKey];
    const updateSchema = exported[updateKey];

    if (!(createSchema instanceof z.ZodObject) || !(updateSchema instanceof z.ZodObject)) continue;

    const createOnlyKeys = Object.keys(createSchema.shape).filter(
      (k) => !(k in updateSchema.shape),
    );
    if (createOnlyKeys.length === 0) continue;

    it(`${updateKey} rejects every field unique to ${createKey} (${createOnlyKeys.join(', ')})`, () => {
      const probe: Record<string, unknown> = {};
      for (const k of createOnlyKeys) probe[k] = 'probe-value';
      const result = updateSchema.safeParse(probe);
      expect(result.success).toBe(false);
    });
  }

  it('found at least one real create-only-key pair to guard (sanity check the discovery logic itself works)', () => {
    const guarded = createKeys.filter((createKey) => {
      const base = createKey.slice('create'.length, -'Schema'.length);
      const updateSchema = exported[`update${base}Schema`];
      const createSchema = exported[createKey];
      if (!(createSchema instanceof z.ZodObject) || !(updateSchema instanceof z.ZodObject)) return false;
      return Object.keys(createSchema.shape).some((k) => !(k in updateSchema.shape));
    });
    expect(guarded.length).toBeGreaterThan(0);
  });
});
