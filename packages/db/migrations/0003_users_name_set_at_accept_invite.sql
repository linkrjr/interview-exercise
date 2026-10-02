-- The invitee supplies their name together with their password when accepting the invite
-- (DESIGN.md §12), so an invited user has no name yet. An active user must have both a name and
-- a password. Deactivated users may lack them: an invited user who never accepted can be
-- deactivated.
ALTER TABLE users ALTER COLUMN name DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT users_active_has_password;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_active_has_credentials
  CHECK (status <> 'active' OR (password_hash IS NOT NULL AND name IS NOT NULL));
