/**
 * v0.8.4: forbid_unlinked_portal_role() (the v0.8.2 database check that a
 * portal-role account carries an applicant or broker link) is owned by the
 * NOLOGIN role openestate_guard_owner instead of openestate_system.
 * Migration: 20261021000000_portal_guard_function_owner.
 *
 * The ownership attempts run as the real install role names
 * (openestate_app / openestate_system) as well as the test login roles, via
 * SET SESSION AUTHORIZATION on a superuser connection, because the function
 * was owned by the real openestate_system name, not by the test login.
 * Everything runs in rolled-back transactions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@openestate/db';
import {
  makeClients,
  seedCompany,
  makePortalRole,
  makeApplicant,
  cleanupCompany,
  TEST_SUPER_URL,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

type Tx = { $executeRawUnsafe: (q: string, ...a: unknown[]) => Promise<number> };
const ROLLBACK = new Error('rollback');

async function attempt(client: PrismaClient, fn: (tx: Tx) => Promise<unknown>): Promise<string> {
  let out = 'not run';
  try {
    await client.$transaction(async (tx) => {
      try {
        await fn(tx as unknown as Tx);
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

const ROLES = ['openestate_app', 'openestate_system', 'openestate_test_app', 'openestate_test_system'];
const STATEMENTS: Array<[string, string]> = [
  ['DROP FUNCTION', 'DROP FUNCTION forbid_unlinked_portal_role()'],
  ['DROP FUNCTION CASCADE', 'DROP FUNCTION forbid_unlinked_portal_role() CASCADE'],
  ['ALTER FUNCTION SECURITY INVOKER', 'ALTER FUNCTION forbid_unlinked_portal_role() SECURITY INVOKER'],
  ['ALTER FUNCTION RESET search_path', 'ALTER FUNCTION forbid_unlinked_portal_role() RESET search_path'],
  ['ALTER FUNCTION RENAME', 'ALTER FUNCTION forbid_unlinked_portal_role() RENAME TO zz_renamed'],
  [
    'CREATE OR REPLACE',
    `CREATE OR REPLACE FUNCTION forbid_unlinked_portal_role() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`,
  ],
  ['DROP TRIGGER', 'DROP TRIGGER users_forbid_unlinked_portal_role ON users'],
  ['DISABLE TRIGGER', 'ALTER TABLE users DISABLE TRIGGER users_forbid_unlinked_portal_role'],
];

describeIf('v0.8.4: the portal-link check is not owned by a login role', () => {
  let fx: CompanyFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrismaExt: any;
  let app: PrismaClient;
  let sys: PrismaClient;
  let sup: PrismaClient;
  let customerRoleId: string;
  let applicantId: string;

  beforeAll(async () => {
    const clients = makeClients();
    systemPrismaExt = clients.systemPrisma;
    await clients.tenantPrisma.$disconnect();
    fx = await seedCompany(systemPrismaExt);
    customerRoleId = await makePortalRole(systemPrismaExt, fx.companyId, 'customer');
    applicantId = await makeApplicant(systemPrismaExt, fx.companyId);
    app = new PrismaClient({ datasourceUrl: APP_URL });
    sys = new PrismaClient({ datasourceUrl: SYSTEM_URL });
    sup = new PrismaClient({ datasourceUrl: TEST_SUPER_URL });
  });

  afterAll(async () => {
    if (fx) await cleanupCompany(systemPrismaExt, fx.companyId);
    await Promise.all([app?.$disconnect(), sys?.$disconnect(), sup?.$disconnect(), systemPrismaExt?.$disconnect()]);
  });

  it('no app or system role can drop, alter, replace or disable the function or its trigger', async () => {
    const allowed: string[] = [];
    for (const role of ROLES) {
      for (const [label, sql] of STATEMENTS) {
        const r = await attempt(sup, async (tx) => {
          await tx.$executeRawUnsafe(`SET SESSION AUTHORIZATION ${role}`);
          await tx.$executeRawUnsafe(sql);
        });
        if (r === 'ALLOWED') allowed.push(`${role}: ${label}`);
      }
    }
    expect(allowed).toEqual([]);
  });

  it('control: the same statements succeed for the superuser (plain DROP FUNCTION aside: the trigger depends on it)', async () => {
    for (const [label, sql] of STATEMENTS) {
      if (label === 'DROP FUNCTION') continue;
      expect(await attempt(sup, (tx) => tx.$executeRawUnsafe(sql)), label).toBe('ALLOWED');
    }
  });

  it('the function is owned by a role that cannot log in, has no members and is not a superuser', async () => {
    const rows = await sup.$queryRawUnsafe<
      Array<{ owner: string; canlogin: boolean; super: boolean; secdef: boolean; members: bigint }>
    >(
      `SELECT r.rolname AS owner, r.rolcanlogin AS canlogin, r.rolsuper AS super, p.prosecdef AS secdef,
              (SELECT count(*) FROM pg_auth_members m WHERE m.roleid = r.oid) AS members
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = 'forbid_unlinked_portal_role'`,
    );
    expect(rows).toEqual([{ owner: 'openestate_guard_owner', canlogin: false, super: false, secdef: true, members: 0n }]);
  });

  /** Inserts a user row, as the given client; returns 'ALLOWED' or the refusal. */
  function insertUser(client: PrismaClient, roleId: string, link: string | null, withCompanyContext: boolean) {
    return attempt(client, async (tx) => {
      if (withCompanyContext) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_company_id', $1, true)`, fx.companyId);
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO users (id, company_id, email, password_hash, name, role_id, applicant_id, is_active, force_password_change, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'x', 'guard probe', $4::uuid, $5::uuid, true, false, now())`,
        randomUUID(),
        fx.companyId,
        `guard-${randomUUID()}@test`,
        roleId,
        link,
      );
    });
  }

  it('v0.8.2 behaviour unchanged: a portal-role account with no link is refused, through both app and system roles', async () => {
    expect(await insertUser(app, customerRoleId, null, true)).toMatch(/A portal role requires an applicant_id or broker_id link/);
    expect(await insertUser(sys, customerRoleId, null, false)).toMatch(/A portal role requires an applicant_id or broker_id link/);
  });

  it('control: a linked portal-role account is accepted, including through the system role with no company context (needs BYPASSRLS)', async () => {
    expect(await insertUser(app, customerRoleId, applicantId, true)).toBe('ALLOWED');
    expect(await insertUser(sys, customerRoleId, applicantId, false)).toBe('ALLOWED');
  });
});
