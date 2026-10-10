/**
 * Superuser controls for the guard tests: the statements the app and system
 * roles are refused (portal-guard-owner.test.ts, financial-hatch-guard.test.ts
 * test 7) DO succeed for the superuser, so those tests can tell "refused" from
 * "statement is broken".
 *
 * They live here, alone, because a statement that succeeds takes a SHARE ROW
 * EXCLUSIVE or ACCESS EXCLUSIVE lock on users / ledger_entries until it is
 * rolled back, which blocks every other test file writing those tables. (The
 * refused attempts are rejected before any lock is taken.)
 *
 * How "cannot overlap" is enforced: vitest.config.ts excludes *.serial.test.ts;
 * vitest.serial.config.ts runs only these, one file at a time; and turbo.json's
 * `test:serial` task depends on `test` and `^test`, so it starts only after the
 * api and packages/db suites (the other users of the shared test database)
 * have finished. `pnpm test` at the root runs both tasks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@openestate/db';
import { TEST_SUPER_URL } from './helpers/postsales-harness';
import { PORTAL_GUARD_STATEMENTS } from './helpers/guard-statements';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

type Tx = { $executeRawUnsafe: (q: string) => Promise<number> };
const ROLLBACK = new Error('rollback');

/** Runs sql in a rolled-back transaction; 'ALLOWED' or the refusal. */
async function attempt(client: PrismaClient, sql: string): Promise<string> {
  let out = 'not run';
  try {
    await client.$transaction(async (tx) => {
      try {
        await (tx as unknown as Tx).$executeRawUnsafe(sql);
        out = 'ALLOWED';
      } catch (e) {
        out = `refused: ${(e as Error).message}`;
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out;
}

describeIf('superuser controls for the guard tests (serial)', () => {
  let sup: PrismaClient;

  beforeAll(() => {
    sup = new PrismaClient({ datasourceUrl: TEST_SUPER_URL });
  });

  afterAll(async () => {
    await sup?.$disconnect();
  });

  it('portal-link check: the statements succeed for the superuser (plain DROP FUNCTION aside: the trigger depends on it)', async () => {
    for (const [label, sql] of PORTAL_GUARD_STATEMENTS) {
      if (label === 'DROP FUNCTION') continue;
      expect(await attempt(sup, sql), label).toBe('ALLOWED');
    }
  });

  it('append-only hatch, control for test 7: the superuser can disable the ledger_entries trigger', async () => {
    expect(await attempt(sup, `ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_delete`)).toBe('ALLOWED');
  });
});
