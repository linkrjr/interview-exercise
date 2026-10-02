-- Schema for every milestone (DESIGN.md §15, §8). Every tenant table carries org_id and its
-- foreign keys to other tenant tables are composite on (org_id, id) (DESIGN.md §11), so a row can
-- never reference another tenant's row. All tables have created_at and updated_at.

CREATE TYPE user_role AS ENUM ('director', 'lead', 'crew');
--> statement-breakpoint
CREATE TYPE user_status AS ENUM ('invited', 'active', 'deactivated');
--> statement-breakpoint
CREATE TYPE mission_status AS ENUM (
  'draft', 'crewing', 'pending_approval', 'approved', 'active', 'completed', 'cancelled'
);
--> statement-breakpoint
CREATE TYPE approval_decision_kind AS ENUM ('approved', 'rejected');
--> statement-breakpoint

CREATE TABLE organisations (
  id                    uuid PRIMARY KEY,
  name                  text NOT NULL,
  time_zone             text NOT NULL DEFAULT 'UTC',
  max_upcoming_missions smallint NOT NULL DEFAULT 3
                        CONSTRAINT organisations_max_upcoming_missions_range
                        CHECK (max_upcoming_missions BETWEEN 1 AND 20),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organisations (id),
  email         citext NOT NULL,
  name          text NOT NULL,
  role          user_role NOT NULL,
  password_hash text,
  status        user_status NOT NULL DEFAULT 'invited',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT users_active_has_password CHECK (status = 'invited' OR password_hash IS NOT NULL)
);
--> statement-breakpoint

CREATE TABLE invites (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organisations (id),
  user_id    uuid NOT NULL,
  code_hash  text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invites_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT invites_org_id_code_hash_key UNIQUE (org_id, code_hash),
  CONSTRAINT invites_user_fk FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id)
);
--> statement-breakpoint

CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organisations (id),
  user_id    uuid NOT NULL,
  family_id  uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refresh_tokens_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT refresh_tokens_org_id_token_hash_key UNIQUE (org_id, token_hash),
  CONSTRAINT refresh_tokens_user_fk FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id)
);
--> statement-breakpoint
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (org_id, family_id);
--> statement-breakpoint

-- Created when a Crew Member is invited; kept (dormant) if the user later changes role
-- (DESIGN.md §3 "Role changes"), so there is deliberately no role = 'crew' foreign key.
CREATE TABLE crew_profiles (
  user_id    uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organisations (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crew_profiles_org_id_user_id_key UNIQUE (org_id, user_id),
  CONSTRAINT crew_profiles_user_fk FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id)
);
--> statement-breakpoint

CREATE TABLE skills (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organisations (id),
  name       citext NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skills_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT skills_org_id_name_key UNIQUE (org_id, name)
);
--> statement-breakpoint

CREATE TABLE crew_skills (
  org_id         uuid NOT NULL REFERENCES organisations (id),
  crew_member_id uuid NOT NULL,
  skill_id       uuid NOT NULL,
  level          smallint NOT NULL CONSTRAINT crew_skills_level_range CHECK (level BETWEEN 1 AND 5),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (crew_member_id, skill_id),
  CONSTRAINT crew_skills_crew_fk FOREIGN KEY (org_id, crew_member_id)
    REFERENCES crew_profiles (org_id, user_id),
  CONSTRAINT crew_skills_skill_fk FOREIGN KEY (org_id, skill_id) REFERENCES skills (org_id, id)
);
--> statement-breakpoint

-- period is an inclusive date range built with daterange(start, end, '[]').
CREATE TABLE unavailability (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES organisations (id),
  crew_member_id uuid NOT NULL,
  period         daterange NOT NULL CONSTRAINT unavailability_period_valid
                 CHECK (NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period)),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unavailability_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT unavailability_crew_fk FOREIGN KEY (org_id, crew_member_id)
    REFERENCES crew_profiles (org_id, user_id)
);
--> statement-breakpoint
CREATE INDEX unavailability_crew_period_idx ON unavailability USING gist (crew_member_id, period);
--> statement-breakpoint

CREATE TABLE missions (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organisations (id),
  lead_id     uuid NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  status      mission_status NOT NULL DEFAULT 'draft',
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT missions_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT missions_dates_ordered CHECK (end_date >= start_date),
  CONSTRAINT missions_lead_fk FOREIGN KEY (org_id, lead_id) REFERENCES users (org_id, id)
);
--> statement-breakpoint
CREATE INDEX missions_org_status_idx ON missions (org_id, status);
--> statement-breakpoint

CREATE TABLE requirements (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organisations (id),
  mission_id uuid NOT NULL,
  skill_id   uuid NOT NULL,
  min_level  smallint NOT NULL CONSTRAINT requirements_min_level_range
             CHECK (min_level BETWEEN 1 AND 5),
  count      integer NOT NULL CONSTRAINT requirements_count_positive CHECK (count >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT requirements_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT requirements_mission_id_skill_id_key UNIQUE (mission_id, skill_id),
  CONSTRAINT requirements_mission_fk FOREIGN KEY (org_id, mission_id)
    REFERENCES missions (org_id, id),
  CONSTRAINT requirements_skill_fk FOREIGN KEY (org_id, skill_id) REFERENCES skills (org_id, id)
);
--> statement-breakpoint

CREATE TABLE assignments (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organisations (id),
  mission_id      uuid NOT NULL,
  crew_member_id  uuid NOT NULL,
  assigned_by     uuid NOT NULL,
  acknowledged_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assignments_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT assignments_mission_id_crew_member_id_key UNIQUE (mission_id, crew_member_id),
  CONSTRAINT assignments_mission_fk FOREIGN KEY (org_id, mission_id)
    REFERENCES missions (org_id, id),
  CONSTRAINT assignments_crew_fk FOREIGN KEY (org_id, crew_member_id)
    REFERENCES crew_profiles (org_id, user_id),
  CONSTRAINT assignments_assigned_by_fk FOREIGN KEY (org_id, assigned_by)
    REFERENCES users (org_id, id)
);
--> statement-breakpoint
CREATE INDEX assignments_crew_idx ON assignments (crew_member_id);
--> statement-breakpoint

-- Binding commitments (DESIGN.md §8). Holds are never deleted: releasing sets released_at and
-- release_reason. The exclusion constraint makes double-booking impossible at the database.
CREATE TABLE holds (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES organisations (id),
  assignment_id  uuid NOT NULL,
  crew_member_id uuid NOT NULL,
  mission_id     uuid NOT NULL,
  period         daterange NOT NULL CONSTRAINT holds_period_valid
                 CHECK (NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period)),
  released_at    timestamptz,
  release_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT holds_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT holds_release_reason_values CHECK (
    release_reason IS NULL
    OR release_reason IN ('rejected', 'withdrawn', 'cancelled', 'expired', 'completed')
  ),
  CONSTRAINT holds_released_consistent CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  CONSTRAINT holds_no_overlap EXCLUDE USING gist (crew_member_id WITH =, period WITH &&)
    WHERE (released_at IS NULL),
  CONSTRAINT holds_assignment_fk FOREIGN KEY (org_id, assignment_id)
    REFERENCES assignments (org_id, id),
  CONSTRAINT holds_crew_fk FOREIGN KEY (org_id, crew_member_id)
    REFERENCES crew_profiles (org_id, user_id),
  CONSTRAINT holds_mission_fk FOREIGN KEY (org_id, mission_id) REFERENCES missions (org_id, id)
);
--> statement-breakpoint
-- An assignment has at most one live hold; released holds accumulate as history.
CREATE UNIQUE INDEX holds_one_live_per_assignment_idx ON holds (assignment_id)
  WHERE released_at IS NULL;
--> statement-breakpoint
CREATE INDEX holds_mission_idx ON holds (mission_id);
--> statement-breakpoint

CREATE TABLE approval_decisions (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organisations (id),
  mission_id  uuid NOT NULL,
  director_id uuid NOT NULL,
  decision    approval_decision_kind NOT NULL,
  comment     text,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_decisions_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT approval_decisions_reject_has_reason CHECK (
    decision = 'approved' OR length(btrim(coalesce(comment, ''))) > 0
  ),
  CONSTRAINT approval_decisions_mission_fk FOREIGN KEY (org_id, mission_id)
    REFERENCES missions (org_id, id),
  CONSTRAINT approval_decisions_director_fk FOREIGN KEY (org_id, director_id)
    REFERENCES users (org_id, id)
);
--> statement-breakpoint

CREATE TABLE match_proposals (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organisations (id),
  mission_id uuid NOT NULL,
  team_hash  text NOT NULL,
  result     jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_proposals_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT match_proposals_mission_fk FOREIGN KEY (org_id, mission_id)
    REFERENCES missions (org_id, id)
);
--> statement-breakpoint

CREATE TABLE notifications (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organisations (id),
  user_id    uuid NOT NULL,
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT notifications_user_fk FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id)
);
--> statement-breakpoint
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at);
--> statement-breakpoint

-- Append-only: UPDATE and DELETE are never granted to app_tenant (0002_rls_and_grants).
-- actor_id NULL means the system actor; the composite FK is not enforced for NULL.
CREATE TABLE audit_events (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organisations (id),
  actor_id    uuid,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  before      jsonb,
  after       jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT audit_events_actor_fk FOREIGN KEY (org_id, actor_id) REFERENCES users (org_id, id)
);
--> statement-breakpoint
CREATE INDEX audit_events_entity_idx ON audit_events (org_id, entity_type, entity_id, occurred_at);
--> statement-breakpoint
CREATE INDEX audit_events_time_idx ON audit_events (org_id, occurred_at);
--> statement-breakpoint

-- Scheduler failure alerts (DESIGN.md §16.1).
CREATE TABLE alerts (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organisations (id),
  source      text NOT NULL CONSTRAINT alerts_source_values CHECK (source IN ('scheduler')),
  code        text NOT NULL,
  message     text NOT NULL,
  details     jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alerts_org_id_id_key UNIQUE (org_id, id)
);
--> statement-breakpoint
CREATE INDEX alerts_time_idx ON alerts (org_id, occurred_at);
--> statement-breakpoint

-- updated_at maintenance on every table.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organisations', 'users', 'invites', 'refresh_tokens', 'crew_profiles', 'skills',
    'crew_skills', 'unavailability', 'missions', 'requirements', 'assignments', 'holds',
    'approval_decisions', 'match_proposals', 'notifications', 'audit_events', 'alerts'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t || '_set_updated_at', t
    );
  END LOOP;
END
$$;
