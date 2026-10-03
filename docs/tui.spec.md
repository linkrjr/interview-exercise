# TUI

Implementing the TUI version of the cli

## Scope

- login screen
  - the login screen should contain 3 field: email, org and password
  - user should be able to click a login button or just hit enter
  - authentication should work as close as possible to the cli

- main screen
  - main screen is presented after successful Login
  - Navigation Bar
    - Navigation bar should display options for all the actions each role can perform
    - A role should never see an action it cannot perform

- Approvals List
  - should list only missions waiting approval
  - approvals should be listed in a table
  - table should be scrollable without hidding the navigation bar
  - each row should be selectable and should present the mission view screen (decided: the real Missions View, not a placeholder)
  - mission view should be presented as a popup screen in the center of the window, mission list should stay visible behind, ESC should close the view

- Missions List
  - should list all missions
  - same table as Approvals (decided: rows open the Missions View, more pages load as the end is reached, no filters yet)
  - mission view should be presented as a popup screen in the center of the window, mission list should stay visible behind, ESC should close the view.

- Missions View
  - should have boarders around similar to the navigation bar
  - should present all information about the mission
    - requirements
    - crew
    - missions fields
  - the navigation bar stays visible, and Esc returns to the list with the same rows and selection (decided)
  - a Director can Approve or Reject a mission waiting for a decision (decided, see below)

- Users List
  - should list all users in the organisation
    - each row is selectable, shows a popup screen with the selected user main info (no missions, no skills) and the ability to deactivate and reinvite if user have not yet accepted the invitation
  - show a submenu at the bottom of the screen with the ability to Invite a user
    - show a popup form with the required fields to invite a user

- Approve and Reject (in the Missions View)
  - the buttons show only when the mission's `allowedActions` include `approve` / `reject`, so a Lead viewing the same mission never sees them
  - Approve opens a small form with an optional comment; Reject opens the same form with a required reason; Enter confirms, Esc cancels
  - after a successful decision the screen stays on the updated mission, hides the buttons and the user navigates back

- Remove the Crew option from the navigation bar
  - Crew is similar to Users
  - Users List and all actions in there should be sufficent to provide all required actions on crew and users

- Skills List
  - should list all skills
    - each row is selectable, shows a popup screen with the selected skill info and the ability rename the skill
  - show a submenu at the bottom of the screen with the ability to add a skill
    - show a popup form with the required fields to add s skill

- Settings
  - show all the available settings in a form like structure, allow the values to be editable and a Save button at the bottom

- Datatables styles
  - Style all tables with surrouding borders and column borders
  - make the table take up the entire screen with (decided: the full width and down to the bottom of the content area; a line under the header only, none between rows)

- Login screen: Accept invite
  - an "Accept invite" option below the login button opens a screen with the fields needed to accept an invite (invite code, name, password twice); after accepting, the person is signed in (decided, see Implementation notes)

- Invite codes
  - wherever an invite code is shown (inviting a user, reinviting) it can be copied to the clipboard

- Lead: New mission and the Missions View actions
  - New mission creates a mission; in the Missions View a Lead (the owning Lead, as the server's `allowedActions` say) can start crewing, reopen, submit, withdraw and cancel, edit the mission, set its requirements and set its crew

- Director: Audit log, Alerts, Inbox
  - read-only lists (Inbox is for every role); a row opens the entry in full

- Crew Member: My profile, My assignments
  - My profile: own skills (set a level, remove) and unavailability (add, remove); My assignments: a list where an assignment can be acknowledged

## Color Styles

- User the same colors the old clipper programs had.
- lists screens background - R:10, G:0, B:178
  - Font color - White
- popup screens background - R:81, G:179, B:180
  - Font color - R:10, G:0, B:178
- Form field background - R:178, G:180, B:177
  - Font color - Black

## Out of Scope

- any cli mc platform command
- changes to the cli
- changes to the current api

## Implementation notes

Status: all of the above is implemented in `packages/tui` (OpenTUI with React, run on Bun; the rest of the repository stays on Node 24 because `@opentui/core` needs Bun 1.3+ or Node 26.4+). Decisions taken while building:

- **Shared state with the CLI:** the TUI uses `@mc/cli`'s `ApiClient` and `Store` as they are, so it reads the same `config.json` (API URL, `mc config set-url`) and `credentials.json`, refreshes tokens the same way and shows the same error texts. Signing in on one signs in on the other. No change to the CLI or the API.
- **Login:** fields Email, Organisation (pre-filled with the CLI's remembered organisation) and Password, which is masked by a custom field because OpenTUI's `<input>` cannot mask. Tab/Shift+Tab move between the fields and the button; Enter in any field, Enter on the button or a click on it signs in. It posts to `/v1/auth/login` like `mc auth login` and stores the session in the same shape. Missing fields are named without calling the server; a failure shows the server's problem text (field errors included), clears the password and returns focus to it; a second submit while one is in flight is ignored. There is no API URL field: without `mc config set-url` the screen shows the CLI's own message. A stored session skips the login screen.
- **Navigation bar** (from the role matrix of DESIGN.md §6; Crew is not an item, Users covers the people of the organisation): Director: Approvals, Missions, Users, Skills, Settings, Audit log, Alerts, Inbox, Sign out. Lead: Missions, New mission, Skills, Inbox, Sign out. Crew: My profile, My assignments, Inbox, Sign out. A role the TUI does not know gets only Sign out. A test checks that every item shown to a role maps to an action the API's policy (`policy.can`) allows that role, and that a new item cannot skip the mapping. ←/→ and Tab choose; clicking selects; the bar wraps on narrow terminals. A navigation id with no screen would show its title, a one-line summary and "not built yet", but every item above has a screen.
- **Sign out** follows `mc auth logout`: revoke the refresh token (best effort), forget the tokens, keep the organisation, return to the login screen. It needs Enter or a click on its button, so passing over it never signs out.
- **Keys:** `q` quits only where it cannot be text (not on the login screen, not while a form is open); Ctrl+C quits everywhere. While a text field is being typed in (a decision form), `q`, the arrow keys and Tab are the field's, not the screen's (`useTextEntry`).
- **Tables:** one `DataTable`, framed: an outside border, a line between the columns and one under the header (none between rows), so it needs no per-row lines and the most rows fit. It is exactly as wide as the terminal (columns start at their content width and share the spare room in proportion; when there is not enough, the widest are narrowed first, down to 6 characters, and cut with an ellipsis) and runs down to the bottom of the content area, with `n/N` in the bottom border. The column lines of the body are full-height boxes drawn over the rows (rows are plain text between them), so the frame is complete from the first paint whatever the number of rows, even none, and nothing has to be measured; the selected row's highlight is exactly as wide as the space between the outer lines, so it never reaches past the frame. The list's counter (`Missions: 12+`) sits one blank line below the navigation bar and starts in the column of the table's left border. The header stays put while the rows scroll in a scroll box (↑/↓, PgUp/PgDn, Home/End, the mouse wheel; its scrollbar is hidden so the right border stays whole), so the navigation bar is never covered, and the selected row is kept in view. Missions columns: Name, Status, Start, End, Lead (a Lead without a name shows the id). Approvals asks the API for `status=pending_approval`; Missions asks for all. The next page (the API pages at 25) is fetched when the selection is within 5 rows of the end. Loading, empty and error states are shown, and `r` retries. Choosing a section again loads it fresh.
- **Colours** (`theme.tsx`, from "Color Styles"): the whole screen, the login screen included, is white on blue (R10 G0 B178, `#0A00B2`), the colour of the lists; popups are blue on cyan (R81 G179 B180, `#51B3B4`); form fields (login, the invite form, the Approve/Reject form, the password field) are black on grey (R178 G180 B177, `#B2B4B1`). What the spec does not name follows Clipper's habits: the selected row and the selected navigation item are inverse (blue on cyan on the screen, white on blue in a popup), buttons are cyan with blue text on the screen and blue with white text in popups (Approve green, Reject and Deactivate dark red, white text), table headers, titles and the focused field's label are bright yellow on blue (black in popups), muted text is grey (`#B2B4B1`) on blue and dark blue on cyan, errors bright red on blue and dark red on cyan. Every text goes through `Txt`, which takes its colours from the surface it sits on (`screen` or `popup`), so a popup's content cannot end up in screen colours. Tests read the colour of rendered cells against the three RGB values; a pseudo-terminal run confirmed the same values in a real terminal.
- **Popups** (`Popup`): the Missions View and the Users popups are bordered rounded boxes with a title, centred in the content area under the navigation bar, at most 104 (mission) or 92 (users) columns wide and always leaving two rows of the list above and below. They paint an opaque background (the list shows around them) and everything inside takes the popup colours. While one is open the list keeps its place but reads neither keys nor clicks; Esc closes it (first the confirmation or form inside it, if any).
- **Missions View:** a popup over the list; `GET /v1/missions/{id}` shown as scrollable lines: name, status, version, dates, lead, created, id, description, requirements, crew (with acknowledgements), the crew check of a Crewing mission with names, the approval decisions and what the user can do next. The list stays visible and mounted behind the popup, so Esc returns to the same rows and selection; choosing another section leaves it.
- **Approve / Reject:** `POST /v1/missions/{id}/transitions` with `If-Match` set to the version the Director is looking at, so a mission that changed since is refused (412) instead of being decided unseen; the error is shown in the form, which stays open. Reject's reason is the transition's `comment`; a blank one is refused locally. The buttons also have the keys `a` and `r`. After a decision the Approvals list is fetched again when the Director goes back, so the decided mission is gone from it.
- **Users:** a paged table (Email, Name, Role, Status; a user who has not accepted has no name) and a menu at the bottom, `Invite a user (i)`. A row opens that user's popup: name, email, role, status, created and id (no missions, no skills). Deactivate (`d`) is offered unless the user is already deactivated and asks for confirmation first (Enter confirms, Esc cancels); Reinvite (`r`) is offered only while the status is `invited` and shows the new invite code once. The invite popup asks for the two things the API requires, email and role (Tab switches, ←/→ choose among director, lead and crew, starting on crew), and shows the invite code once after sending. These are the CLI's `users invite|deactivate|reinvite` calls; changing a role is not in the spec and is not offered. A popup that changed something refreshes the list when it closes; server refusals (for instance the last active Director) are shown in the popup.
- **Skills:** a paged table (Name, Created) of the catalogue. A row opens the skill's popup (name, created, id). A Director also gets Rename (`r`: a field with the current name, Enter saves, Esc cancels, a blank name is refused locally) and a menu at the bottom, `Add a skill (a)`, which opens a popup with one required field, the name (spaces tidied as the API does). A Lead sees the catalogue read-only: no Rename and no Add, and the keys do nothing. Duplicate names (`SKILL_NAME_TAKEN`) and other refusals show in the popup; a popup that changed something refreshes the list when it closes.
- **Settings:** a Director-only section (not in a Lead's bar) shown as a form: Time zone (an IANA name, checked with the contracts' `isIanaTimeZone`) and Most upcoming missions per crew member (a whole number from 1 to 20), each with a hint, and a Save button at the bottom. Only what changed is sent (`PATCH /v1/org/settings`); nothing changed says so without calling the server; field errors show beside the fields; the server's refusals show beside Save; after saving the fields show the settings as the server now has them. The form starts at rest so ←/→ and Tab still carry on past the section; Enter (or a click on a field) engages it, Tab/Shift+Tab then move between the fields and Save, Enter saves, and Esc lets go again. Engaged, `q`, the arrow keys and Tab are the form's.
- **Shared building blocks** (what the later screens are made of): `PagedList` (a table fetched a page at a time) and `ListSection` (a `PagedList` whose row opens a popup, refreshing the list when a popup that changed something closes); `InfoPopup` (facts, optional scrolling body lines, and actions with a key and a button, each optionally asking first); `Form` (one line per field, text or ←/→ choice, Tab moves, Enter sends) and `FormPopup` (a `Form` in a popup: throw an Error to show it and keep the popup open); `FieldForm` (one field, for the small popups); `call` (runs an API call and turns failures into plain messages). Every screen takes its API as an injectable interface (`Apis`), so tests use fakes.
- **Audit log** (Director): `GET /v1/audit`, a paged table (Time (UTC), Action, Entity as `type:short id`, Actor, `system` when there is none), newest first. A row opens the event: time, action, entity, actor, id and the before/after JSON.
- **Alerts** (Director): `GET /v1/alerts`, a paged table (Time (UTC), Code, Message), newest first (`mc alerts`). A row opens the alert with its source and details JSON.
- **Inbox** (every role): `GET /v1/notifications`, a paged table with a dot for unread, time, type and what it is about (the mission and the reason or comment, worded as the CLI does). Opening a notification marks it read once (`POST /v1/notifications/{id}/read`, like `mc inbox read`), the popup shows when, and the list refreshes on close.
- **My profile** (Crew Member): two tabs, `1` Skills and `2` Unavailability, with a menu at the bottom (`Set a skill (s)`, `Add unavailability (u)`). Skills (`GET /v1/crew/{me}`): a row opens a popup where ←/→ choose the level and Enter saves (`PUT /v1/crew/me/skills/{id}`) and `x` removes it after asking. Set a skill picks from the catalogue and a level 1 to 5. Unavailability: a row opens the range with Remove; Add takes From, To (inclusive) and a private note, dates checked as real `YYYY-MM-DD` before calling the server. It needs the user id the sign-in stored; without it the screen says to sign in again.
- **My assignments** (Crew Member): `GET /v1/assignments/me`, a paged table (Mission, Status, Start, End, Acknowledged). A row opens the mission; an assignment not yet acknowledged offers Acknowledge (`a`), which asks first (it is binding and cannot be refused) and then shows the time and hides the button.
- **Rendering quirks worth knowing:** an earlier version drew the empty rows' column lines from a measured viewport height; that measurement could be stale, which left the frame short or missing until a key press redrew the table, and a table with one row never got one. The row highlight was also one cell wider than the frame. Both are why the body is built as above. And the renderer keeps a box's old props when a reused box loses them, so the list's loading, empty, error and table states carry distinct keys; before that, the "Loading…" box's padding left every table one cell down and to the right.
- **Testing:** `bun test` in `packages/tui` (React state only updates inside `act`, so tests use a `perform()` helper) and a pseudo-terminal run against `docker compose` as a Director, a Lead and a Crew Member. The one known leftover is React's "not wrapped in act" warning from OpenTUI's own first render.
- **Lead's mission actions:** all use the Missions View, so they appear for whoever the server allows (`allowedActions`), never by role. Moves (`POST /v1/missions/{id}/transitions`, `If-Match` the version on screen): Start crewing (`s`), Reopen (`o`), Submit (`u`), Withdraw (`w`), Cancel mission (`x`); each asks first (Enter confirms, Esc cancels) and the screen stays on the updated mission. Edits, offered only when the server allows moving a Draft/Crewing mission: Edit (`e`: name, dates, description, only what changed is sent, `PATCH`), Requirements (`p`: one line, `Skill:level:count; ...` as `mc missions requirements set`, skill names matched to the catalogue ignoring case, empty clears) and, in Crewing, Crew (`c`: a picker over the organisation's Crew Members, ↑/↓ move, Space ticks, Enter saves, nothing ticked clears). A refusal (stale version, a crew member not eligible) is shown in the popup or under the question. The list behind refreshes when the view closes. Esc closes the editor on top first, then the question, then the view.
- **New mission** (Lead): a section at rest (so ←/→ and Tab carry on past it); `n`, Enter or the button opens a form (name, start, end, description). Input is checked locally with the contracts' `CreateMissionRequestSchema`; on success the new mission opens in the Missions View so requirements and crew can follow.
- **Accept invite:** the login screen has an "Accept invite" option below the Login button (Tab to it then Enter, or a click). It opens a screen with what `mc auth accept-invite` asks for: the invite code, the person's name and a new password typed twice (masked). It checks locally what it can (all fields present, the two passwords match, 12 to 128 characters), posts to `/v1/auth/accept-invite`, stores the session in the CLI's credentials file and goes straight to the main screen, as the CLI signs the person in. A refusal (bad or expired code) is shown, the passwords are cleared and focus returns to them; Esc or "Back to sign in" returns to the login screen.
- **Copying an invite code:** wherever a code is shown (the invite form and Reinvite) there is a "Copy (c)" button, also the key `c`. It uses the system clipboard tool (`pbcopy`, `wl-copy`, `xclip`, `xsel`, `clip`) and otherwise, or over SSH, asks the terminal to copy (OSC 52). It says "Copied to the clipboard." or that it could not; the code stays on screen to select by hand either way.
- **Not built yet:** an organisation name in the header (the stored session only has the id); the auto-matcher (`mc missions match`), which is not in this spec; changing a user's role; and any `mc platform` command (out of scope).
