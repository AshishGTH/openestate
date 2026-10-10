-- v0.8.4: forbid_unlinked_portal_role() is no longer owned by a login role.
--
-- v0.8.2 made openestate_system its owner so the SECURITY DEFINER body could
-- read roles.is_portal past row-level security. But an owner may also DROP
-- the function (with CASCADE, which drops the users trigger with it) or
-- ALTER it, so the role the running API logs in as could switch the check
-- off. The function now belongs to openestate_guard_owner: NOLOGIN, no
-- members, BYPASSRLS (writes through the system client carry no company
-- context, so without it the roles row would be invisible and every such
-- write would be refused), and SELECT on exactly the two columns it reads.
-- The function body, search_path and trigger are unchanged.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openestate_guard_owner') THEN
    CREATE ROLE openestate_guard_owner NOLOGIN BYPASSRLS;
  END IF;
END
$$;
-- Also for a role that already existed with other attributes.
ALTER ROLE openestate_guard_owner NOLOGIN BYPASSRLS;

GRANT USAGE ON SCHEMA public TO openestate_guard_owner;
GRANT SELECT (id, is_portal) ON roles TO openestate_guard_owner;
ALTER FUNCTION forbid_unlinked_portal_role() OWNER TO openestate_guard_owner;
