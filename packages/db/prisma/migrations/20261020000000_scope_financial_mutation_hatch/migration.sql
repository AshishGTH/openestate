-- v0.8.4 Part G: the append-only escape hatch now needs the right login, not
-- just the setting.
--
-- Until now forbid_financial_mutation() honoured app.allow_financial_mutation
-- = 'on' from ANY role, including openestate_app and openestate_system, the
-- roles the running API uses. From this migration on the setting is honoured
-- only when the LOGIN role (session_user) is a member of
-- openestate_maintenance. Superusers count as members of every role, so in
-- production only the postgres superuser can use the hatch; no login role is
-- granted membership by any script.
--
-- session_user, not current_user: rows removed or nulled by a foreign-key
-- cascade are changed by PostgreSQL as the table OWNER, so current_user inside
-- the trigger is the owner, not the role that issued the DELETE. session_user
-- is fixed at login and is not changed by SET ROLE or by cascades.
--
-- Fails closed: if the role is missing, pg_has_role raises, so the change is
-- refused.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openestate_maintenance') THEN
    CREATE ROLE openestate_maintenance NOLOGIN;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION forbid_financial_mutation() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_financial_mutation', true) = 'on' THEN
    IF pg_catalog.pg_has_role(session_user, 'openestate_maintenance', 'MEMBER') THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'Table % is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING HINT = 'Financial rows are immutable; post a reversal entry instead.';
END;
$$ LANGUAGE plpgsql;
