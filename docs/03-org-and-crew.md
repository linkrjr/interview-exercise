# Spec 03 — Org and crew

Milestone 3 of DESIGN.md §20. Source of truth for all detail: [DESIGN.md](../DESIGN.md).

## Goal

Organisation settings, the skill catalogue, crew profiles (skills and unavailability), crew search, and audit writing and reading. Done when crew can manage their profiles and Leads can search crew.

## Depends on

- **Spec 01 (hard):** schema, `withTenant`, `AuditWriter` port.
- **Spec 02 (soft):** real authentication, `can()`, API/CLI skeletons, user and `crew_profiles` creation. Can be built against a test helper that mints an `Actor` and inserts users/profiles via SQL, then integrated once 02 lands.
- No dependency on 04–06. The OQ-1 guard reads the `holds` table directly; it exists from Spec 01 and is simply empty until Spec 04.

## Interfaces consumed (stubs)

| Interface | From | Stub until available |
|---|---|---|
| `can(actor, action, resource)` | 02 | Permissive/table-driven fake in tests |
| Authenticated `Actor` on requests | 02 | Test helper injecting an `Actor` |
| `holds` rows | 04 | Rows inserted directly by tests |

## Interfaces provided

```ts
// core — real implementation of the Spec 01 port, used by every later spec
AuditWriter.record(tx, { action, entityType, entityId, before, after, actorId | null })

OrgSettings.get(tx): Promise<{ timeZone: string; maxUpcomingMissions: number }>
```

## Scope

1. **Audit writing** (§15, §17): `AuditWriter` implementation, written in the same transaction as the change. Wire it into the Spec 02 sites (invites, role changes, deactivation, login failures) and add assertions that they emit. Secrets never appear in payloads (§18).
2. **Audit read** (§13, §14): `GET /v1/audit` (Director) with entity, actor and time filters, cursor pagination; `mc audit list [--entity mission:<id>] [--since …]`.
3. **Org settings** (§6, §13, OQ-2, OQ-9): `GET/PATCH /v1/org/settings` — IANA time zone (validated), max upcoming missions (1–20, default 3). Directors write, everyone reads. Lowering the cap never affects existing holds (§5.2 invariant 6). CLI: `mc org settings show | set`.
4. **Skill catalogue** (§6, §13, OQ-7): `GET/POST /v1/skills`, `PATCH /v1/skills/{id}` (Director writes; all read). Names unique per organisation, case-insensitive. Skills can be added, listed and renamed (OQ-11); they can be neither archived nor deleted (archiving is future work, §22), so there is no archive state anywhere in the system. CLI: `mc skills add | list | rename`.
5. **Crew profile** (§6, §13, OQ-5): `PUT/DELETE /v1/crew/me/skills/{skillId}` (level 1–5, own profile only); editing while held is allowed. CLI: `mc profile show | skill set | skill remove`.
6. **Unavailability** (§6, §13, OQ-1): `POST/DELETE /v1/crew/me/unavailability[/{id}]` (inclusive `daterange`, optional note). Reject a range overlapping any unreleased hold with a conflict listing the missions (`409`, stable `code`). Keep the guard in one function so OQ-1 is easy to change. CLI: `mc profile unavailable add | list | remove`.
7. **Crew listing** (§6, §13, §14): `GET /v1/crew` and `GET /v1/crew/{id}` — Director and Lead see all; a Crew Member only themself (404 for others). Only users whose current role is Crew appear; dormant profiles of former Crew Members are never listed (§3 "Role changes"). Response carries skills, unavailability and current load (count of unreleased holds on Pending approval/Approved/Active missions; zero until Spec 04). Filters for `--skill "Medicine>=3"` and `--available <from>:<to>`. CLI: `mc crew list | show`.
8. Contracts first for every endpoint above (§21).

## Out of scope

Anything on missions, holds creation, notifications or the matcher.

## Open points needing a product decision

None open. Skill archiving is removed (DESIGN.md OQ-7). Renaming is OQ-11, implemented per its default (Directors may rename). The questions raised while building were decided (see the implementation notes).

## Acceptance criteria

- A crew member can set and remove their own skills and unavailability; cannot touch another profile (404).
- Adding an unavailability range that overlaps an unreleased hold returns the conflict with the mission list; touching only a released hold is allowed.
- Leads can filter crew by skill level and by availability window.
- Every mutating call here writes an audit event in the same transaction; a rolled-back change leaves no audit row.
- Director can read the audit log; Lead and Crew get 403/404 per §6.
- Settings changes take effect for the next request; invalid time zones and out-of-range caps are rejected with field errors. `organisations.time_zone` is free text in the database, so this validation is the only guard: a bad value would break the scheduler (Spec 06).

## Tests

Permission matrix rows for these capabilities; cross-tenant 404 per endpoint; audit-atomicity test; filter correctness (skill level boundary, inclusive date ranges, adjacent-day edges); OQ-1 guard tests with directly inserted holds.

## Implementation notes

Status: implemented. Decisions taken while building, for the specs that follow:

- **Audit:** `DbAuditWriter` (in `core`) writes through the caller's transaction, taking the organisation from `app.org_id` and the time from the injected `Clock`; the API server now uses it. Payloads containing keys that look like secrets (`password`, `token`, `secret`, `hash`, `invite_code`) are refused. Entity types in use: `user`, `organisation`, `skill`, `crew_profile`, `unavailability`. Actions: `org.settings_updated`, `skill.created`, `skill.renamed`, `crew.skill_set`, `crew.skill_removed`, `crew.unavailability_added`, `crew.unavailability_removed`, plus the Spec 02 ones. No-op changes write nothing. The unavailability `note` is kept out of audit payloads.
- **Audit read:** newest first, paged by `(time, id)`. Filters: `entity=<type>:<id>`, `actor=<userId>|system`, `since` (inclusive) and `until` (exclusive); a bare date is that day's start in UTC.
- **Settings:** the time zone is valid when the runtime's `Intl` accepts it (UTC offsets such as `+01:00` are refused) and is stored as given. `Intl.supportedValuesOf` is not used: it omits `UTC` and `Asia/Kolkata`. `getOrgSettings(tx)` is exported for the later specs; `todayIn(now, timeZone)` gives "today" in the organisation's time zone.
- **Catalogue:** names are trimmed with inner whitespace collapsed (max 100); unique per organisation ignoring case; list is paged by id.
- **Crew listing:** only users whose role is Crew and whose status is `active`. `crew.read` conceals other people's profiles as 404. A Crew Member's list contains only themself. Filters are `skill=<skillId>:<minLevel>` (repeatable, AND) and `available=<from>:<to>` (no overlapping unavailability and no overlapping unreleased hold; the cap is ignored). `load` is the number of unreleased holds.
- **Unavailability:** a range is rejected when it ends before today in the organisation's time zone (`UNAVAILABILITY_IN_PAST`, 400), overlaps one of the person's own ranges (`UNAVAILABILITY_OVERLAPS_EXISTING`, 409, lists them) or overlaps a live hold (`UNAVAILABILITY_CONFLICTS_WITH_MISSIONS`, 409, lists every blocking mission in full). The crew profile row is locked first, so this serialises with a submission taking holds (§8); migration `0004` adds a database exclusion constraint for the self-overlap rule. `findBlockingMissions` is the single place implementing OQ-1. The `note` is shown only to its owner.
- **Problem extensions:** problem bodies carry extension members (`missions`, `unavailability`, `errors`); `ProblemDetailsSchema` is a loose object so the CLI keeps them.
- **API conventions:** forbidden by role → 403; another organisation's or malformed ids → 404; `DELETE` returns 204 (404 when the skill level or range does not exist); creating returns 201; `GET /v1/crew/me` is not an endpoint (the CLI uses the stored user id).
- **CLI:** `mc profile skill set|remove` and `mc crew list --skill` take skill names, resolved case-insensitively against the catalogue; `--skill` needs the `Name>=N` form. `mc profile show` for a Lead or Director exits 3 (they have no crew profile).
- **Wiring renames:** `createIdentityServices`/`IdentityHarness` became `createServices`/`Harness`; the API's `identity` dependency is now `services`; `services.auditLog` reads the log while `audit` is the writer. `@mc/db/testing` gained `openAdminDb` for fixtures that bypass RLS.
- **Grants:** unchanged from Spec 01. `app_tenant` cannot `SELECT … FOR UPDATE` on `unavailability` (no UPDATE privilege), so removal selects then deletes.
