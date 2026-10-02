-- A crew member's own unavailability ranges never overlap (ranges that merely touch are fine:
-- they are half-open internally). Enforced by the database so concurrent requests cannot both
-- insert an overlap; the API reports it as UNAVAILABILITY_OVERLAPS_EXISTING.
ALTER TABLE unavailability
  ADD CONSTRAINT unavailability_no_self_overlap EXCLUDE USING gist (crew_member_id WITH =, period WITH &&);
