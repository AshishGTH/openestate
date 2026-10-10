/**
 * v0.8.4 Part G: the append-only escape hatch (app.allow_financial_mutation)
 * works only for a login that is a member of openestate_maintenance, which in
 * practice means a superuser. Migration:
 * packages/db/prisma/migrations/20261020000000_scope_financial_mutation_hatch.
 *
 * Every attempt runs inside a transaction that is rolled back, so the fixture
 * rows survive whatever the trigger decides. Each table gets one committed row
 * (inserted as superuser with session_replication_role = replica, so its other
 * foreign keys don't need real parents): a row-level trigger only fires on rows
 * that exist, and an UPDATE/DELETE that matches nothing would "succeed" and
 * prove nothing. Every attempt therefore also asserts how many rows it touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@openestate/db';
import { makeClients, seedCompany, cleanupCompany, TEST_SUPER_URL, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const TABLES = [
  'ledger_entries',
  'receipt_allocations',
  'cheque_status_events',
  'interest_accruals',
  'tds_deductions',
  'tds_certificates',
  'commission_ledger_entries',
] as const;

type Tx = { $executeRawUnsafe: (q: string, ...a: unknown[]) => Promise<number>; $queryRawUnsafe: <T>(q: string, ...a: unknown[]) => Promise<T> };

const ROLLBACK = new Error('rollback');

/** Runs fn in a transaction that is always rolled back; returns fn's result or the error. */
async function attempt<T>(client: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let out: { ok: true; value: T } | { ok: false; error: string } = { ok: false, error: 'not run' };
  try {
    await client.$transaction(async (tx) => {
      try {
        out = { ok: true, value: await fn(tx as unknown as Tx) };
      } catch (e) {
        out = { ok: false, error: (e as Error).message };
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out;
}

/** Builds an INSERT that fills every NOT NULL column with a type-appropriate value. */
async function insertFiller(tx: Tx, table: string, overrides: Record<string, string>): Promise<string> {
  const cols = await tx.$queryRawUnsafe<{ column_name: string; data_type: string; udt_name: string }[]>(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`,
    table,
  );
  const id = overrides.id ?? randomUUID();
  const names: string[] = [];
  const values: string[] = [];
  for (const c of cols) {
    names.push(`"${c.column_name}"`);
    if (c.column_name in overrides || c.column_name === 'id') {
      values.push(`'${c.column_name === 'id' ? id : overrides[c.column_name]}'::${c.udt_name === 'uuid' ? 'uuid' : 'text'}`);
      continue;
    }
    if (c.data_type === 'USER-DEFINED') {
      values.push(`(SELECT enumlabel::"${c.udt_name}" FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = '${c.udt_name}' ORDER BY enumsortorder LIMIT 1)`);
    } else if (c.udt_name === 'uuid') values.push('gen_random_uuid()');
    else if (['int2', 'int4', 'int8', 'numeric', 'float8'].includes(c.udt_name)) values.push('1');
    else if (c.udt_name === 'bool') values.push('false');
    else if (c.udt_name.startsWith('timestamp')) values.push('now()');
    else if (c.udt_name === 'date') values.push('current_date');
    else if (c.udt_name === 'jsonb' || c.udt_name === 'json') values.push(`'{}'`);
    else values.push(`'x'`);
  }
  await tx.$executeRawUnsafe(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${values.join(', ')})`);
  return id;
}

describeIf('v0.8.4 Part G: append-only escape hatch is superuser-only', () => {
  let fx: CompanyFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrismaExt: any;
  let app: PrismaClient;
  let sys: PrismaClient;
  let sup: PrismaClient;
  const rowIds: Record<string, string> = {};

  beforeAll(async () => {
    const clients = makeClients();
    systemPrismaExt = clients.systemPrisma;
    await clients.tenantPrisma.$disconnect();
    fx = await seedCompany(systemPrismaExt);
    app = new PrismaClient({ datasourceUrl: APP_URL });
    sys = new PrismaClient({ datasourceUrl: SYSTEM_URL });
    sup = new PrismaClient({ datasourceUrl: TEST_SUPER_URL });
    await sup.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      for (const t of TABLES) rowIds[t] = await insertFiller(tx as unknown as Tx, t, { company_id: fx.companyId });
    });
  });

  afterAll(async () => {
    if (fx) await cleanupCompany(systemPrismaExt, fx.companyId);
    await Promise.all([app?.$disconnect(), sys?.$disconnect(), sup?.$disconnect(), systemPrismaExt?.$disconnect()]);
  });

  /** One mutation on the fixture row of `table`, with the hatch setting on. */
  async function mutate(client: PrismaClient, table: string, op: 'UPDATE' | 'DELETE', hatch = true) {
    return attempt(client, async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_company_id', $1, true)`, fx.companyId);
      if (hatch) await tx.$executeRawUnsafe(`SET LOCAL app.allow_financial_mutation = 'on'`);
      return op === 'DELETE'
        ? tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE id = $1::uuid`, rowIds[table])
        : tx.$executeRawUnsafe(`UPDATE ${table} SET company_id = company_id WHERE id = $1::uuid`, rowIds[table]);
    });
  }

  it('1. the app role and the system role cannot use the hatch on any of the 7 tables', async () => {
    const allowed: string[] = [];
    for (const [name, client] of [['app', app], ['system', sys]] as const) {
      for (const t of TABLES) {
        for (const op of ['UPDATE', 'DELETE'] as const) {
          const r = await mutate(client, t, op);
          if (r.ok) allowed.push(`${name} ${op} ${t} (${r.value} row)`);
          else expect(r.error).toContain('append-only');
        }
      }
    }
    expect(allowed).toEqual([]);
  });

  it('1b. control: the superuser CAN use the hatch, and the fixture row is really there', async () => {
    for (const t of TABLES) {
      const r = await mutate(sup, t, 'DELETE');
      expect(r).toEqual({ ok: true, value: 1 });
    }
  });

  it('2. a member of openestate_maintenance may use it; an identical non-member may not; neither without the setting', async () => {
    const r = await attempt(sup, async (tx) => {
      await tx.$executeRawUnsafe(`CREATE ROLE zz_hatch_member NOLOGIN BYPASSRLS`);
      await tx.$executeRawUnsafe(`CREATE ROLE zz_hatch_plain NOLOGIN BYPASSRLS`);
      await tx.$executeRawUnsafe(`GRANT openestate_maintenance TO zz_hatch_member`);
      await tx.$executeRawUnsafe(`GRANT ALL ON ledger_entries TO zz_hatch_member, zz_hatch_plain`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_company_id', $1, true)`, fx.companyId);
      const results: Record<string, string> = {};
      for (const [who, hatch] of [['zz_hatch_member', true], ['zz_hatch_member', false], ['zz_hatch_plain', true]] as const) {
        await tx.$executeRawUnsafe(`SAVEPOINT s`);
        await tx.$executeRawUnsafe(`SET SESSION AUTHORIZATION ${who}`);
        await tx.$executeRawUnsafe(`SET LOCAL app.allow_financial_mutation = '${hatch ? 'on' : 'off'}'`);
        try {
          const n = await tx.$executeRawUnsafe(`DELETE FROM ledger_entries WHERE id = $1::uuid`, rowIds.ledger_entries);
          results[`${who}/${hatch}`] = `deleted ${n}`;
        } catch (e) {
          results[`${who}/${hatch}`] = (e as Error).message.includes('append-only') ? 'refused' : (e as Error).message;
        }
        await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT s`);
        await tx.$executeRawUnsafe(`RESET SESSION AUTHORIZATION`);
      }
      return results;
    });
    expect(r).toEqual({
      ok: true,
      value: {
        'zz_hatch_member/true': 'deleted 1',
        'zz_hatch_member/false': 'refused',
        'zz_hatch_plain/true': 'refused',
      },
    });
  });

  it('3. a cascade from a parent row into an append-only table works for a member (the trigger checks session_user)', async () => {
    const r = await attempt(sup, async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      const receiptId = await insertFiller(tx, 'receipts', { company_id: fx.companyId });
      const eventId = await insertFiller(tx, 'cheque_status_events', { company_id: fx.companyId, receipt_id: receiptId });
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = origin`);
      await tx.$executeRawUnsafe(`CREATE ROLE zz_hatch_member NOLOGIN BYPASSRLS`);
      await tx.$executeRawUnsafe(`GRANT openestate_maintenance TO zz_hatch_member`);
      await tx.$executeRawUnsafe(`GRANT ALL ON receipts, cheque_status_events TO zz_hatch_member`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_company_id', $1, true)`, fx.companyId);
      await tx.$executeRawUnsafe(`SET SESSION AUTHORIZATION zz_hatch_member`);
      await tx.$executeRawUnsafe(`SET LOCAL app.allow_financial_mutation = 'on'`);
      const deleted = await tx.$executeRawUnsafe(`DELETE FROM receipts WHERE id = $1::uuid`, receiptId);
      await tx.$executeRawUnsafe(`RESET SESSION AUTHORIZATION`);
      const left = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM cheque_status_events WHERE id = $1::uuid`, eventId);
      return { deleted, eventsLeft: Number(left[0].n) };
    });
    expect(r).toEqual({ ok: true, value: { deleted: 1, eventsLeft: 0 } });
  });

  it('4. no non-superuser role is a member of openestate_maintenance, and the app/system roles are not', async () => {
    const rows = await sup.$queryRawUnsafe<{ rolname: string }[]>(
      `SELECT rolname FROM pg_roles
        WHERE NOT rolsuper AND rolname <> 'openestate_maintenance' AND rolname !~ '^pg_'
          AND pg_has_role(oid, 'openestate_maintenance', 'MEMBER')`,
    );
    expect(rows).toEqual([]);
    const exists = await sup.$queryRawUnsafe<{ rolcanlogin: boolean }[]>(
      `SELECT rolcanlogin FROM pg_roles WHERE rolname = 'openestate_maintenance'`,
    );
    expect(exists).toEqual([{ rolcanlogin: false }]);
  });

  it('5. if the role is missing, the trigger refuses even a superuser with the setting on (fails closed)', async () => {
    const r = await attempt(sup, async (tx) => {
      await tx.$executeRawUnsafe(`DROP ROLE openestate_maintenance`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_company_id', $1, true)`, fx.companyId);
      await tx.$executeRawUnsafe(`SET LOCAL app.allow_financial_mutation = 'on'`);
      try {
        const n = await tx.$executeRawUnsafe(`DELETE FROM ledger_entries WHERE id = $1::uuid`, rowIds.ledger_entries);
        return `allowed (${n} row)`;
      } catch (e) {
        return `refused: ${(e as Error).message}`;
      }
    });
    // ok:true means the DROP ROLE itself worked, so the role really was there.
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toMatch(/^refused: [\s\S]*role "openestate_maintenance" does not exist/);
  });

  // Test 6 is the whole suite: ~100 files tear down through cleanupCompany(),
  // which now uses the superuser login.

  it('7. the app and system roles cannot TRUNCATE, disable or drop the triggers, or replace the function', async () => {
    const allowed: string[] = [];
    for (const [name, client] of [['app', app], ['system', sys]] as const) {
      for (const t of TABLES) {
        for (const [label, sql] of [
          ['TRUNCATE', `TRUNCATE ${t}`],
          ['DISABLE TRIGGER', `ALTER TABLE ${t} DISABLE TRIGGER ${t}_no_delete`],
          ['DISABLE TRIGGER ALL', `ALTER TABLE ${t} DISABLE TRIGGER ALL`],
          ['DROP TRIGGER', `DROP TRIGGER ${t}_no_delete ON ${t}`],
        ] as const) {
          const r = await attempt(client, (tx) => tx.$executeRawUnsafe(sql));
          if (r.ok) allowed.push(`${name} ${label} ${t}`);
        }
      }
      const fn = await attempt(client, (tx) =>
        tx.$executeRawUnsafe(
          `CREATE OR REPLACE FUNCTION forbid_financial_mutation() RETURNS trigger AS 'BEGIN RETURN NEW; END' LANGUAGE plpgsql`,
        ),
      );
      if (fn.ok) allowed.push(`${name} REPLACE forbid_financial_mutation`);
      const srr = await attempt(client, (tx) => tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`));
      if (srr.ok) allowed.push(`${name} SET session_replication_role`);
    }
    expect(allowed).toEqual([]);
  });

  it('7b. control: the same statements DO succeed for the superuser (so test 7 can tell allowed from refused)', async () => {
    const r = await attempt(sup, (tx) => tx.$executeRawUnsafe(`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_delete`));
    expect(r.ok).toBe(true);
  });
});
