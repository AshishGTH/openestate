/**
 * v0.8.4 Part B: the constraint manifest.
 *
 * `packages/db/constraint-manifest.json` records, from a database built only by
 * `prisma migrate deploy` on PostgreSQL 16, every constraint (foreign keys
 * with their delete/update rules, primary keys, unique and check constraints),
 * every trigger, every row-level security policy, and each table's row-level
 * security flags. packages/db/test/constraint-manifest.test.ts compares the
 * migrated test database against it, so a migration that silently drops or
 * changes one of them fails CI.
 *
 * Why this exists: schema.prisma declares many links as plain columns (the
 * Phase 4 "scalar FK, no Prisma relation" policy), so `prisma migrate dev`
 * treats their foreign keys as drift and generates DROP statements for them.
 * That is how 71 foreign keys disappeared in 2026-08. `prisma migrate diff`
 * can't be the check: it reports those foreign keys as drift forever.
 *
 * Regenerate after a deliberate change (against a freshly migrated database):
 *   DATABASE_URL=<superuser url> pnpm --filter @openestate/db constraint-manifest
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

export const MANIFEST_PATH = path.join(__dirname, '..', 'constraint-manifest.json');
export const MANIFEST_PG_MAJOR = 16;

export interface Manifest {
  postgresMajor: number;
  constraints: Array<{ table: string; name: string; type: string; definition: string }>;
  triggers: Array<{ table: string; name: string; definition: string }>;
  policies: Array<{ table: string; name: string; command: string; permissive: boolean; roles: string; using: string | null; withCheck: string | null }>;
  rowLevelSecurity: Array<{ table: string; enabled: boolean; forced: boolean }>;
}

type Reader = { $queryRawUnsafe: <T>(q: string, ...a: unknown[]) => Promise<T> };

/** Whitespace-insensitive text, so formatting differences between 16.x point releases don't matter. */
export const norm = (s: string | null): string | null => (s == null ? null : s.replace(/\s+/g, ' ').trim());

export async function readManifest(db: Reader): Promise<Manifest> {
  const [{ v }] = await db.$queryRawUnsafe<Array<{ v: number }>>(
    `SELECT current_setting('server_version_num')::int / 10000 AS v`,
  );
  const constraints = await db.$queryRawUnsafe<Manifest['constraints']>(
    `SELECT c.conrelid::regclass::text AS table, c.conname AS name,
            CASE c.contype WHEN 'f' THEN 'foreign key' WHEN 'p' THEN 'primary key'
                           WHEN 'u' THEN 'unique' WHEN 'c' THEN 'check' ELSE c.contype::text END AS type,
            pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype IN ('f', 'p', 'u', 'c')
      ORDER BY 1, 2`,
  );
  const triggers = await db.$queryRawUnsafe<Manifest['triggers']>(
    `SELECT c.relname AS table, t.tgname AS name, pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
      ORDER BY 1, 2`,
  );
  const policies = await db.$queryRawUnsafe<Manifest['policies']>(
    `SELECT tablename AS table, policyname AS name, cmd AS command, permissive = 'PERMISSIVE' AS permissive,
            array_to_string(roles, ',') AS roles, qual AS using, with_check AS "withCheck"
       FROM pg_policies WHERE schemaname = 'public'
      ORDER BY 1, 2`,
  );
  const rowLevelSecurity = await db.$queryRawUnsafe<Manifest['rowLevelSecurity']>(
    `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND (c.relrowsecurity OR c.relforcerowsecurity)
      ORDER BY 1`,
  );
  return {
    postgresMajor: Number(v),
    constraints: constraints.map((c) => ({ ...c, definition: norm(c.definition)! })),
    triggers: triggers.map((t) => ({ ...t, definition: norm(t.definition)! })),
    policies: policies.map((p) => ({ ...p, using: norm(p.using), withCheck: norm(p.withCheck) })),
    rowLevelSecurity,
  };
}

/** Lines present in `expected` but not `actual` ("missing") and the reverse ("unexpected"). */
export function diffManifest(expected: Manifest, actual: Manifest): { missing: string[]; unexpected: string[] } {
  const lines = (m: Manifest) =>
    new Set([
      ...m.constraints.map((c) => `constraint ${JSON.stringify(c)}`),
      ...m.triggers.map((t) => `trigger ${JSON.stringify(t)}`),
      ...m.policies.map((p) => `policy ${JSON.stringify(p)}`),
      ...m.rowLevelSecurity.map((r) => `rls ${JSON.stringify(r)}`),
    ]);
  const e = lines(expected);
  const a = lines(actual);
  return { missing: [...e].filter((l) => !a.has(l)), unexpected: [...a].filter((l) => !e.has(l)) };
}

/** Foreign keys the database has not validated. */
export async function unvalidatedForeignKeys(db: Reader): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT c.conname AS name FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype = 'f' AND NOT c.convalidated ORDER BY 1`,
  );
  return rows.map((r) => r.name);
}

/**
 * Functions run by a trigger, and SECURITY DEFINER functions, whose owner is a
 * role that can log in without being a superuser, or by one of the two
 * application roles. An owner can drop or alter its function (DROP ... CASCADE
 * also removes the trigger), so such a function must belong to a superuser or
 * to a role nobody logs in as. The application roles are named explicitly
 * because a migrations-built database (CI) creates them NOLOGIN; only a real
 * install's setup-database.sh gives them a password and LOGIN.
 */
export async function functionsOwnedByLoginRoles(db: Reader): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ fn: string; owner: string }>>(
    `SELECT DISTINCT p.proname AS fn, r.rolname AS owner
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
      WHERE n.nspname = 'public'
        AND ((r.rolcanlogin AND NOT r.rolsuper) OR r.rolname IN ('openestate_app', 'openestate_system'))
        AND (p.prosecdef OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid))
      ORDER BY 1`,
  );
  return rows.map((r) => `${r.fn} (owner ${r.owner})`);
}

/** One entry per line, so a change shows up as a one-line diff in review. */
export function serialize(m: Manifest): string {
  const block = (items: unknown[]) => `[\n${items.map((i) => `    ${JSON.stringify(i)}`).join(',\n')}\n  ]`;
  return `{\n  "postgresMajor": ${m.postgresMajor},\n  "constraints": ${block(m.constraints)},\n  "triggers": ${block(
    m.triggers,
  )},\n  "policies": ${block(m.policies)},\n  "rowLevelSecurity": ${block(m.rowLevelSecurity)}\n}\n`;
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL to a superuser connection to a freshly migrated database.');
  const db = new PrismaClient({ datasourceUrl: url });
  (async () => {
    const m = await readManifest(db);
    if (m.postgresMajor !== MANIFEST_PG_MAJOR) {
      throw new Error(`Generate the manifest on PostgreSQL ${MANIFEST_PG_MAJOR}; this server is ${m.postgresMajor}.`);
    }
    const unvalidated = await unvalidatedForeignKeys(db);
    if (unvalidated.length) throw new Error(`These foreign keys are NOT VALID; use a clean database: ${unvalidated.join(', ')}`);
    writeFileSync(MANIFEST_PATH, serialize(m));
    console.log(
      `Wrote ${MANIFEST_PATH}: ${m.constraints.length} constraints, ${m.triggers.length} triggers, ${m.policies.length} policies, ${m.rowLevelSecurity.length} tables with row-level security.`,
    );
  })()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
