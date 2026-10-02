-- Extensions needed by the schema (DESIGN.md §15): btree_gist for the holds exclusion
-- constraint on (uuid =, daterange &&), citext for case-insensitive emails and skill names.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint

-- Application roles (DESIGN.md §11). They are created NOLOGIN, without BYPASSRLS and without
-- owning any table; the provisioning step (packages/db/src/provision.ts) grants LOGIN and a
-- password from the environment, so no credentials live in version control.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_tenant', 'app_platform', 'app_scheduler'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', r);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint

-- Keeps updated_at current; attached to every table with the column in 0001_schema.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;
