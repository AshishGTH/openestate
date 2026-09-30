-- v0.8.2: a portal role (customer/broker) must always carry an
-- applicant_id or broker_id link. Defense-in-depth alongside the
-- application-layer fix in AuthService/UsersService (which closes the
-- staff-login gap that let an unlinked portal-role account exist at all).
--
-- SECURITY DEFINER, owned by openestate_system (this project's existing
-- BYPASSRLS role, created in 20260720000000_phase1_core): the internal
-- SELECT on roles must see the role row regardless of the triggering
-- session's own RLS context, including under a future FORCE ROW LEVEL
-- SECURITY on roles, since BYPASSRLS overrides FORCE RLS unconditionally.
-- SET search_path pins name resolution against both pg_catalog and public,
-- standard SECURITY DEFINER hardening against a session-level search_path
-- manipulation redirecting name lookups to an attacker-controlled object.
--
-- Fails CLOSED: an unresolvable role (a bad role_id, or the RLS-visibility
-- gap this SECURITY DEFINER shape exists to rule out) is rejected outright,
-- never silently allowed through. A bare `IF NULL AND ...` evaluates to
-- NULL, which Postgres's IF treats as false -- that would silently ALLOW
-- the write, the opposite of what's wanted here.
CREATE OR REPLACE FUNCTION forbid_unlinked_portal_role() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_is_portal boolean;
BEGIN
  SELECT is_portal INTO v_is_portal FROM roles WHERE id = NEW.role_id;

  IF v_is_portal IS NULL THEN
    RAISE EXCEPTION 'role_id % does not resolve to a known role', NEW.role_id;
  END IF;

  IF v_is_portal IS TRUE AND NEW.applicant_id IS NULL AND NEW.broker_id IS NULL THEN
    RAISE EXCEPTION 'A portal role requires an applicant_id or broker_id link';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION forbid_unlinked_portal_role() OWNER TO openestate_system;

-- Scoped to these three columns specifically, not a bare BEFORE UPDATE:
-- an ordinary update (last_login_at, password_hash, etc.) never touches
-- role_id/applicant_id/broker_id, so it never fires the trigger -- a
-- pre-existing bad-state row elsewhere can still be used normally by its
-- own account holder. Only a write that touches one of these three columns
-- is checked.
CREATE TRIGGER users_forbid_unlinked_portal_role
  BEFORE INSERT OR UPDATE OF role_id, applicant_id, broker_id ON users
  FOR EACH ROW EXECUTE FUNCTION forbid_unlinked_portal_role();
