-- Holds are never deleted (DESIGN.md §8), but a Lead must be able to remove a tentative
-- assignment after a reject or withdraw, when its released holds still point at it. The link is
-- therefore nullable and cleared when the assignment is deleted: the released hold stays as
-- history (crew member, mission, dates, release reason) without an assignment.
ALTER TABLE holds ALTER COLUMN assignment_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE holds DROP CONSTRAINT holds_assignment_fk;
--> statement-breakpoint
ALTER TABLE holds ADD CONSTRAINT holds_assignment_fk
  FOREIGN KEY (org_id, assignment_id) REFERENCES assignments (org_id, id)
  ON DELETE SET NULL (assignment_id);
--> statement-breakpoint
-- A live hold always belongs to its assignment, so an assignment with a live hold cannot be removed.
ALTER TABLE holds ADD CONSTRAINT holds_live_has_assignment
  CHECK (released_at IS NOT NULL OR assignment_id IS NOT NULL);
