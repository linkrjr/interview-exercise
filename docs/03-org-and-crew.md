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

None open. Skill archiving is removed (DESIGN.md OQ-7). Renaming is OQ-11, implemented per its default (Directors may rename).

## Acceptance criteria

- A crew member can set and remove their own skills and unavailability; cannot touch another profile (404).
- Adding an unavailability range that overlaps an unreleased hold returns the conflict with the mission list; touching only a released hold is allowed.
- Leads can filter crew by skill level and by availability window.
- Every mutating call here writes an audit event in the same transaction; a rolled-back change leaves no audit row.
- Director can read the audit log; Lead and Crew get 403/404 per §6.
- Settings changes take effect for the next request; invalid time zones and out-of-range caps are rejected with field errors.

## Tests

Permission matrix rows for these capabilities; cross-tenant 404 per endpoint; audit-atomicity test; filter correctness (skill level boundary, inclusive date ranges, adjacent-day edges); OQ-1 guard tests with directly inserted holds.
