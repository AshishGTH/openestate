#!/usr/bin/env node
/**
 * v0.8.4 Part B: refuse a migration that drops or disables a database
 * safeguard unless the removal is marked and approved.
 *
 * In every migration newer than CUTOFF, each of these statements
 *   DROP CONSTRAINT, DROP TRIGGER, DROP POLICY, DROP FUNCTION, DISABLE TRIGGER
 * needs BOTH
 *   1. a comment on the line directly above:  -- ALLOW-DROP: <non-empty reason>
 *   2. an entry in packages/db/approved-removals.json:
 *        { "migration": "<folder name>", "statement": "DROP CONSTRAINT",
 *          "name": "<object name>", "reason": "...", "approvedBy": "..." }
 * otherwise this exits 1, naming the file and line.
 *
 * Why: `prisma migrate dev` generates DROP CONSTRAINT lines for every foreign
 * key that schema.prisma declares as a plain column. That is how 71 foreign
 * keys were removed in 20260801131113_add_password_reset without anyone
 * noticing. See packages/db/prisma/constraint-manifest.ts for the other half
 * of this guard (the manifest test).
 *
 * CUTOFF: the last migration on master before this lint existed (v0.8.3).
 * Migrations up to and including it are exempt: they are already applied on
 * real installs, and Prisma checksums every applied migration, so they can
 * never be edited to add markers (the 2026-08 one alone has 78 unmarked drops).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CUTOFF = '20261015000000_portal_document_scope';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATEMENT = /\b(DROP\s+CONSTRAINT|DROP\s+TRIGGER|DROP\s+POLICY|DROP\s+FUNCTION|DISABLE\s+TRIGGER)\s+(?:IF\s+EXISTS\s+)?("?)([\w.]+)\2/i;

/** Returns a list of problems ("file:line: message"); empty means clean. */
export function lintMigrationDrops({
  migrationsDir = path.join(REPO, 'packages/db/prisma/migrations'),
  approvedPath = path.join(REPO, 'packages/db/approved-removals.json'),
  cutoff = CUTOFF,
} = {}) {
  const approved = JSON.parse(readFileSync(approvedPath, 'utf8'));
  const problems = [];
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name > cutoff)
    .map((d) => d.name)
    .sort();
  for (const dir of dirs) {
    const file = path.join(migrationsDir, dir, 'migration.sql');
    let lines;
    try {
      lines = readFileSync(file, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    lines.forEach((line, i) => {
      const code = line.replace(/--.*$/, '');
      const m = STATEMENT.exec(code);
      if (!m) return;
      const statement = m[1].replace(/\s+/g, ' ').toUpperCase();
      const name = m[3];
      const where = `${path.relative(REPO, file)}:${i + 1}`;
      const marker = /^\s*--\s*ALLOW-DROP:(.*)$/.exec(lines[i - 1] ?? '');
      if (!marker) {
        problems.push(`${where}: ${statement} ${name} needs "-- ALLOW-DROP: <reason>" on the line above`);
        return;
      }
      if (!marker[1].trim()) {
        problems.push(`${where}: ${statement} ${name} has an empty ALLOW-DROP reason`);
        return;
      }
      const ok = approved.some(
        (a) => a.migration === dir && a.statement === statement && a.name === name && a.reason?.trim() && a.approvedBy?.trim(),
      );
      if (!ok) {
        problems.push(
          `${where}: ${statement} ${name} is not listed (with a reason and approvedBy) in packages/db/approved-removals.json`,
        );
      }
    });
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = lintMigrationDrops();
  if (problems.length) {
    console.error('Migration drop lint failed:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`Migration drop lint: no unapproved drops after ${CUTOFF}.`);
}
