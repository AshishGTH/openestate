/**
 * Statements that would weaken a database guard. Each refusal test runs them
 * as the app and system roles (refused before any table lock is taken); the
 * matching superuser controls live in exclusive-lock-controls.serial.test.ts,
 * because when they succeed they lock users / ledger_entries.
 */

/** forbid_unlinked_portal_role() and its trigger on users. */
export const PORTAL_GUARD_STATEMENTS: Array<[string, string]> = [
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
