/**
 * v0.8.4 Part B: scripts/lint-migration-drops.mjs. Runs the real lint on the
 * real migrations, then on throwaway migration folders to prove each rule.
 * The cutoff is lowered through the function's parameter, never by editing an
 * old migration.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations
import { lintMigrationDrops, CUTOFF } from '../../../scripts/lint-migration-drops.mjs';

const lint = lintMigrationDrops as (o?: { migrationsDir?: string; approvedPath?: string; cutoff?: string }) => string[];

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** A scratch migrations folder with one migration and an approved-removals file. */
function scratch(migration: string, sql: string, approved: unknown[] = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'droplint-'));
  dirs.push(root);
  mkdirSync(path.join(root, 'migrations', migration), { recursive: true });
  writeFileSync(path.join(root, 'migrations', migration, 'migration.sql'), sql);
  writeFileSync(path.join(root, 'approved.json'), JSON.stringify(approved));
  return { migrationsDir: path.join(root, 'migrations'), approvedPath: path.join(root, 'approved.json') };
}

const NEW = '29990101000000_new_migration';
const DROP = 'ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_installment_id_fkey";\n';

describe('v0.8.4 Part B: migration drop lint', () => {
  it('the real migrations pass', () => {
    expect(lint()).toEqual([]);
  });

  it('an unmarked DROP CONSTRAINT in a new migration fails, naming the file and line', () => {
    const problems = lint({ ...scratch(NEW, `-- some change\n${DROP}`), cutoff: CUTOFF });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/29990101000000_new_migration[\\/]migration\.sql:2: DROP CONSTRAINT ledger_entries_installment_id_fkey needs "-- ALLOW-DROP: <reason>"/);
  });

  it('the same drop at or before the cutoff passes (cutoff lowered by parameter)', () => {
    expect(lint({ ...scratch(NEW, DROP), cutoff: NEW })).toEqual([]);
    expect(lint({ ...scratch(NEW, DROP), cutoff: '29991231000000_later' })).toEqual([]);
  });

  it('an empty ALLOW-DROP reason fails', () => {
    const problems = lint({ ...scratch(NEW, `-- ALLOW-DROP:   \n${DROP}`), cutoff: CUTOFF });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('empty ALLOW-DROP reason');
  });

  it('a marked drop that is not in approved-removals.json fails', () => {
    const problems = lint({ ...scratch(NEW, `-- ALLOW-DROP: replaced by a stricter one below\n${DROP}`), cutoff: CUTOFF });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('approved-removals.json');
  });

  it('a marked and approved drop passes', () => {
    const approved = [
      {
        migration: NEW,
        statement: 'DROP CONSTRAINT',
        name: 'ledger_entries_installment_id_fkey',
        reason: 'replaced by a stricter one below',
        approvedBy: 'architect, 2026-10-10',
      },
    ];
    expect(lint({ ...scratch(NEW, `-- ALLOW-DROP: replaced by a stricter one below\n${DROP}`, approved), cutoff: CUTOFF })).toEqual([]);
  });

  it('also covers DROP TRIGGER, DROP POLICY, DROP FUNCTION and DISABLE TRIGGER, and ignores comments', () => {
    const sql = [
      '-- DROP CONSTRAINT x in a comment is ignored',
      'DROP TRIGGER users_forbid_unlinked_portal_role ON users;',
      'DROP POLICY IF EXISTS tenant_isolation_policy ON users;',
      'DROP FUNCTION forbid_financial_mutation() CASCADE;',
      'ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_delete;',
    ].join('\n');
    const problems = lint({ ...scratch(NEW, sql), cutoff: CUTOFF });
    expect(problems.map((p) => p.replace(/^.*?: /, ''))).toEqual([
      'DROP TRIGGER users_forbid_unlinked_portal_role needs "-- ALLOW-DROP: <reason>" on the line above',
      'DROP POLICY tenant_isolation_policy needs "-- ALLOW-DROP: <reason>" on the line above',
      'DROP FUNCTION forbid_financial_mutation needs "-- ALLOW-DROP: <reason>" on the line above',
      'DISABLE TRIGGER ledger_entries_no_delete needs "-- ALLOW-DROP: <reason>" on the line above',
    ]);
  });
});
