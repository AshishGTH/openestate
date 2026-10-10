/**
 * Helpers for proving that foreign keys reject a pointer to a row that does
 * not exist (v0.8.4 Parts A and B).
 *
 * One filler row per child table is inserted with every foreign key switched
 * off (session_replication_role = replica) and COMMITTED: PostgreSQL re-checks
 * every foreign key of a row updated in the transaction that inserted it, so
 * an uncommitted filler would trip over its own placeholder values. Each probe
 * then points one column at a random id in a transaction that is rolled back.
 * Rows are addressed by ctid because some tables have no `id` column; the
 * rollback leaves each ctid unchanged.
 */
import type { PrismaClient } from '@openestate/db';

export type RawTx = {
  $executeRawUnsafe: (q: string, ...a: unknown[]) => Promise<number>;
  $queryRawUnsafe: <T>(q: string, ...a: unknown[]) => Promise<T>;
};

export interface FkLink {
  name: string;
  table: string;
  column: string;
  /** Extra assignments the same UPDATE needs to satisfy a CHECK constraint. */
  alsoSet?: string;
}

const ROLLBACK = new Error('rollback');

/** "CODE message" from a Prisma raw-query error, without the wrapper text. */
export function pgError(e: unknown): string {
  const msg = (e as Error).message;
  const m = /Code: `(\w+)`\. Message: `([^`]*)`/.exec(msg);
  return m ? `${m[1]} ${m[2]}` : msg.slice(-300);
}

/** INSERTs a row filling every NOT NULL column without a default; returns its ctid. */
export async function insertFillerRow(tx: RawTx, table: string, overrides: Record<string, string>): Promise<string> {
  const cols = await tx.$queryRawUnsafe<
    Array<{
      column_name: string;
      data_type: string;
      udt_name: string;
      character_maximum_length: number | null;
      required: boolean;
    }>
  >(
    `SELECT column_name, data_type, udt_name, character_maximum_length,
            (is_nullable = 'NO' AND column_default IS NULL) AS required
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    table,
  );
  const names: string[] = [];
  const values: string[] = [];
  // Required columns, plus any optional column the caller sets (a CHECK may need it).
  for (const c of cols.filter((c) => c.required || overrides[c.column_name] !== undefined)) {
    names.push(`"${c.column_name}"`);
    const v = overrides[c.column_name];
    if (v !== undefined) values.push(`'${v}'::"${c.udt_name}"`);
    else if (c.data_type === 'USER-DEFINED')
      values.push(
        `(SELECT enumlabel::"${c.udt_name}" FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = '${c.udt_name}' ORDER BY enumsortorder LIMIT 1)`,
      );
    else if (c.data_type === 'ARRAY') values.push(`'{}'`);
    else if (c.udt_name === 'uuid') values.push('gen_random_uuid()');
    else if (['int2', 'int4', 'int8', 'numeric', 'float8'].includes(c.udt_name)) values.push('1');
    else if (c.udt_name === 'bool') values.push('false');
    else if (c.udt_name.startsWith('timestamp')) values.push('now()');
    else if (c.udt_name === 'date') values.push('current_date');
    else if (c.udt_name === 'jsonb' || c.udt_name === 'json') values.push(`'{}'`);
    else values.push(`left(md5(random()::text), ${Math.min(c.character_maximum_length ?? 12, 12)})`);
  }
  const [{ ctid }] = await tx.$queryRawUnsafe<Array<{ ctid: string }>>(
    `INSERT INTO "${table}" (${names.join(', ')}) VALUES (${values.join(', ')}) RETURNING ctid::text`,
  );
  return ctid;
}

/**
 * Inserts and commits one filler row per table. Where a unique key stops the
 * insert (company_configs has one row per company), the company's existing row
 * is probed instead and left in place at cleanup.
 */
export interface Fillers {
  ctids: Record<string, string>;
  inserted: string[];
}

export async function insertFillers(
  sup: PrismaClient,
  tables: Iterable<string>,
  overridesFor: (table: string, columns: Set<string>) => Record<string, string>,
): Promise<Fillers> {
  const out: Fillers = { ctids: {}, inserted: [] };
  await sup.$transaction(
    async (raw) => {
      const tx = raw as unknown as RawTx;
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      for (const table of tables) {
        const cols = await tx.$queryRawUnsafe<Array<{ column_name: string }>>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
          table,
        );
        const overrides = overridesFor(table, new Set(cols.map((c) => c.column_name)));
        await tx.$executeRawUnsafe(`SAVEPOINT filler`);
        try {
          out.ctids[table] = await insertFillerRow(tx, table, overrides);
          out.inserted.push(table);
        } catch (e) {
          if (!pgError(e).startsWith('23505') || !overrides.company_id) throw e;
          await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT filler`);
          const [row] = await tx.$queryRawUnsafe<Array<{ ctid: string }>>(
            `SELECT ctid::text FROM "${table}" WHERE company_id = $1::uuid LIMIT 1`,
            overrides.company_id,
          );
          if (!row) throw e;
          out.ctids[table] = row.ctid;
        }
      }
    },
    { timeout: 60_000 },
  );
  return out;
}

/** Deletes the filler rows again, with foreign keys and triggers switched off. */
export async function deleteFillers(sup: PrismaClient, fillers: Fillers): Promise<void> {
  await sup.$transaction(async (raw) => {
    const tx = raw as unknown as RawTx;
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    for (const table of fillers.inserted) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ctid = $1::tid`, fillers.ctids[table]);
    }
  });
}

/**
 * For each link, points the filler row's column at a random id and reports
 * every link that did NOT refuse it with 23503 naming that constraint.
 */
export async function probeForeignKeys(
  sup: PrismaClient,
  links: FkLink[],
  fillers: Fillers,
): Promise<string[]> {
  const notRejected: string[] = [];
  for (const l of links) {
    let outcome = 'not run';
    try {
      await sup.$transaction(async (raw) => {
        const tx = raw as unknown as RawTx;
        // The superuser may use the append-only hatch, so the protected
        // tables' own trigger doesn't answer before the foreign key does.
        await tx.$executeRawUnsafe(`SET LOCAL app.allow_financial_mutation = 'on'`);
        // Likewise the portal-link trigger on users answers a bad role_id first
        // ("does not resolve to a known role"). Off for this rolled-back probe only.
        if (l.table === 'users' && l.column === 'role_id') {
          await tx.$executeRawUnsafe(`ALTER TABLE users DISABLE TRIGGER users_forbid_unlinked_portal_role`);
        }
        try {
          await tx.$executeRawUnsafe(
            `UPDATE "${l.table}" SET "${l.column}" = gen_random_uuid()${l.alsoSet ? `, ${l.alsoSet}` : ''} WHERE ctid = $1::tid`,
            fillers.ctids[l.table],
          );
          outcome = 'accepted';
        } catch (e) {
          const msg = pgError(e);
          outcome = msg.startsWith('23503') && msg.includes(l.name) ? 'rejected' : `other error: ${msg}`;
        }
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) outcome = `setup failed: ${pgError(e)}`;
    }
    if (outcome !== 'rejected') notRejected.push(`${l.name}: ${outcome}`);
  }
  return notRejected;
}
