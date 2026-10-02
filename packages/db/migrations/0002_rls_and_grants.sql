-- Row-level security and grants (DESIGN.md §11).
--
-- The tenant tables are listed once, here: RLS, FORCE RLS and the tenant_isolation policy are
-- generated from that list. A test (rls.integration.test.ts) compares the list with every table
-- that has an org_id column, so a new tenant table cannot be forgotten.

-- A tenant is selected with SET LOCAL app.org_id inside each transaction. When the setting is
-- unset it is NULL, or '' once a previous transaction on the connection has set and released
-- it; NULLIF turns both into NULL so every policy fails closed with zero rows.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'invites', 'refresh_tokens', 'crew_profiles', 'skills', 'crew_skills',
    'unavailability', 'missions', 'requirements', 'assignments', 'holds',
    'approval_decisions', 'match_proposals', 'notifications', 'audit_events', 'alerts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$CREATE POLICY tenant_isolation ON %I
           USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
           WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)$p$,
      t
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- organisations is the tenant root: a tenant sees only its own row.
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organisations
  USING      (id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app_tenant, app_platform, app_scheduler;
--> statement-breakpoint

-- app_tenant: the minimum implied by DESIGN.md; later milestones extend this in their own
-- migrations. holds, audit_events and approval_decisions are never deleted; audit_events is
-- append-only (no UPDATE, no DELETE). UPDATE on crew_profiles is required by the SELECT ... FOR
-- UPDATE that serialises submissions (§8).
GRANT SELECT ON organisations TO app_tenant;
--> statement-breakpoint
GRANT UPDATE (time_zone, max_upcoming_missions) ON organisations TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON users, invites, refresh_tokens, crew_profiles, skills,
  missions, holds, notifications TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON crew_skills, requirements, assignments TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON unavailability, match_proposals TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT ON approval_decisions, audit_events TO app_tenant;
--> statement-breakpoint
GRANT SELECT ON alerts TO app_tenant;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM app_tenant, app_platform, app_scheduler;
--> statement-breakpoint

-- app_platform: provisioning only. It can create an organisation, its first Director and the
-- Director's invite, and cannot select anything. Its INSERT policies are the only way these
-- rows can be written without an app.org_id.
GRANT INSERT ON organisations, users, invites TO app_platform;
--> statement-breakpoint
CREATE POLICY platform_provisioning ON organisations FOR INSERT TO app_platform WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY platform_provisioning ON users FOR INSERT TO app_platform WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY platform_provisioning ON invites FOR INSERT TO app_platform WITH CHECK (true);
--> statement-breakpoint

-- app_scheduler: iterates tenants (organisations id and time_zone only) and writes and purges
-- alerts. SELECT on alerts.occurred_at is needed by the retention DELETE ... WHERE; no other
-- alerts column is readable, and nothing can be updated.
GRANT SELECT (id, time_zone) ON organisations TO app_scheduler;
--> statement-breakpoint
GRANT SELECT (occurred_at) ON alerts TO app_scheduler;
--> statement-breakpoint
GRANT INSERT, DELETE ON alerts TO app_scheduler;
--> statement-breakpoint
CREATE POLICY scheduler_iteration ON organisations FOR SELECT TO app_scheduler USING (true);
--> statement-breakpoint
CREATE POLICY scheduler_alerts_select ON alerts FOR SELECT TO app_scheduler USING (true);
--> statement-breakpoint
CREATE POLICY scheduler_alerts_insert ON alerts FOR INSERT TO app_scheduler WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY scheduler_alerts_delete ON alerts FOR DELETE TO app_scheduler USING (true);
