/**
 * v0.8.4 Part B: the migrated test database must match constraint-manifest.json
 * exactly, every foreign key must be validated (CI data is clean), and no
 * trigger or SECURITY DEFINER function may belong to a non-superuser login role.
 *
 * The last three tests prove the checks can fail: each makes the change inside
 * a transaction that is rolled back, reads the catalog in that transaction, and
 * expects the check to report it.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  MANIFEST_PATH,
  MANIFEST_PG_MAJOR,
  diffManifest,
  functionsOwnedByLoginRoles,
  readManifest,
  unvalidatedForeignKeys,
  type Manifest,
} from '../prisma/constraint-manifest';

const SUPER_URL =
  process.env.DATABASE_URL_TEST_SUPER ?? 'postgresql://openestate_super:test_super_pass@localhost:5432/openestate_test';
const describeIf = process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;
const REGENERATE = 'DATABASE_URL=<superuser url of a freshly migrated database> pnpm --filter @openestate/db constraint-manifest';
const ROLLBACK = new Error('rollback');

type Tx = { $executeRawUnsafe: (q: string) => Promise<number>; $queryRawUnsafe: <T>(q: string, ...a: unknown[]) => Promise<T> };

describeIf('v0.8.4 Part B: constraint manifest', () => {
  let db: PrismaClient;
  let expected: Manifest;
  let actual: Manifest;

  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: SUPER_URL });
    expected = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    actual = await readManifest(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  /** Runs fn inside a transaction that is always rolled back and returns its result. */
  async function inRolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    let out!: T;
    try {
      await db.$transaction(async (tx) => {
        out = await fn(tx as unknown as Tx);
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    return out;
  }

  it(`runs on PostgreSQL ${MANIFEST_PG_MAJOR}, the version the manifest was generated on`, () => {
    if (actual.postgresMajor !== MANIFEST_PG_MAJOR && !process.env.CI) {
      console.warn(`Skipping the exact comparison: this server is PostgreSQL ${actual.postgresMajor}.`);
      return;
    }
    expect(actual.postgresMajor).toBe(MANIFEST_PG_MAJOR);
  });

  it('the database has exactly the constraints, triggers, policies and RLS flags in the manifest', () => {
    if (actual.postgresMajor !== MANIFEST_PG_MAJOR && !process.env.CI) return;
    const d = diffManifest(expected, actual);
    expect(d, `If this change is deliberate, regenerate the manifest: ${REGENERATE}`).toEqual({ missing: [], unexpected: [] });
  });

  it('every foreign key is validated', async () => {
    expect(await unvalidatedForeignKeys(db)).toEqual([]);
  });

  it('no trigger or SECURITY DEFINER function is owned by a login or application role', async () => {
    expect(await functionsOwnedByLoginRoles(db)).toEqual([]);
  });

  // The comparison is checked on copies of the manifest, not by altering the
  // shared test database: a DROP CONSTRAINT here, even rolled back, takes
  // ACCESS EXCLUSIVE locks while the other test packages run and deadlocked
  // them. Dropping a real foreign key was proven to fail the test above by
  // hand (see the v0.8.4 decisions entry in CLAUDE.md).
  it('self-check: a foreign key missing from the database is reported', () => {
    const name = 'ledger_entries_installment_id_fkey';
    const d = diffManifest(expected, { ...actual, constraints: actual.constraints.filter((c) => c.name !== name) });
    expect(d.unexpected).toEqual([]);
    expect(d.missing).toHaveLength(1);
    expect(d.missing[0]).toContain(name);
  });

  it('self-check: a foreign key with a changed delete rule is reported', () => {
    const name = 'ledger_entries_installment_id_fkey';
    const changed = actual.constraints.map((c) =>
      c.name === name ? { ...c, definition: c.definition.replace('ON DELETE RESTRICT', 'ON DELETE SET NULL') } : c,
    );
    const d = diffManifest(expected, { ...actual, constraints: changed });
    expect(d.missing).toHaveLength(1);
    expect(d.unexpected).toHaveLength(1);
    expect(d.unexpected[0]).toContain('ON DELETE SET NULL');
  });

  it('self-check: a trigger function owned by the system login role (the pre-v0.8.4 state) is reported', async () => {
    const found = await inRolledBack(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER FUNCTION forbid_unlinked_portal_role() OWNER TO openestate_system`);
      return functionsOwnedByLoginRoles(tx);
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^forbid_unlinked_portal_role \(owner /);
  });
});
