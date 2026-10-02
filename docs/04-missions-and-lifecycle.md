# Spec 04 — Missions and lifecycle

Milestone 4 of DESIGN.md §20. Source of truth for all detail: [DESIGN.md](../DESIGN.md).

## Goal

Missions with requirements, manual crewing, the full state machine, holds, approvals, notifications and assignment acknowledgement. Done when the full manual workflow and the invariant tests pass.

## Depends on

- **Spec 01 (hard):** schema including `holds` and its exclusion constraint, `withTenant`, `AuditWriter` port, `Actor`.
- **Spec 02 (soft):** authentication, `can()`, API/CLI skeletons. Buildable with an injected `Actor`.
- **Spec 03 (soft):** org settings (cap, time zone), skills, crew skills/unavailability, real `AuditWriter`. Buildable with stubs and SQL-seeded fixtures.
- No dependency on 05 or 06. The matcher's apply endpoint (05) calls this spec's crew-replacement service.

## Interfaces consumed (stubs)

| Interface | From | Stub until available |
|---|---|---|
| `Actor` on requests, `can()` | 02 | Injected actor, table-driven policy fake |
| `AuditWriter` | 03 | Spec 01 in-memory fake |
| `OrgSettings.get(tx)` | 03 | Fake returning `{ timeZone: 'UTC', maxUpcomingMissions: 3 }`, overridable per test |
| Skills, crew profiles, crew skills, unavailability | 03 | Rows inserted via SQL in test fixtures |

## Interfaces provided

```ts
// core — used by 05 (apply) and 06 (scheduler)
MissionService.transition(actor, missionId, { action, version, comment? })
MissionService.replaceCrew(actor, missionId, crewMemberIds, { version })   // tentative crew, Crewing only
MissionService.runSystemTransitions(tx, today /* org-tz date */)           // expire, activate, complete; idempotent
NotificationService.notify(tx, userIds, type, payload)
loadUpcomingLoad(tx, crewMemberIds): Map<crewMemberId, number>             // reused by 05
```

## Scope

1. **Missions** (§5, §7.1, §13): `GET/POST /v1/missions`, `PATCH /v1/missions/{id}`, `PUT /v1/missions/{id}/requirements`, `PUT /v1/missions/{id}/crew`. Ownership rules and visibility rules per §6 (Crew see own assignments from Approved onward and no co-assignees, OQ-3). Cursor pagination and filters by status, lead, dates. `If-Match: <version>` with 412 on stale versions.
2. **State machine** (§7.2, §21): the single place that changes `missions.status`. All transitions in one transaction with optimistic concurrency and an audit event, via `POST /v1/missions/{id}/transitions`. Invalid actions return `409 MISSION_INVALID_TRANSITION` listing the actions allowed for this actor. Includes the system transitions `activate`, `complete` and `expire` as service functions taking the `system` actor, so Spec 06 only has to schedule them. `approve` fails if the start date has passed. Moving back to Draft clears tentative assignments. `start_crewing` requires at least one requirement (there is no crew size).
   - **Crew validation** (§7.1): every read of a Crewing mission (`GET` and the response of any mutation) includes `crewValidation { valid, assignmentIssues[{ assignmentId, crewMemberId, code: "NOT_ELIGIBLE" }], unmetRequirements[{ skillId, minLevel, required, met }] }`, computed by one function. `NOT_ELIGIBLE` covers unavailability overlap, overlapping hold, at the workload cap, and no-longer-active Crew Member, deliberately without per-person reasons. Changing dates or requirements never removes assignments and never blocks the edit; only submit is blocked by an invalid crew.
3. **Submit and holds** (§8): inside the submit transaction, `SELECT … FOR UPDATE` on each assignee's crew profile row, check unavailability, overlapping holds and the workload cap, then create holds atomically. Holds are released (never deleted) with the reasons in §8. Distinct problem codes such as `CREW_DOUBLE_BOOKED`, `WORKLOAD_CAP_EXCEEDED`.
4. **Approvals** (§7.2, §13): approve (optional comment) and reject (mandatory reason) by any Director, recorded in `approval_decisions`; reject returns to Crewing. `mc approvals list`; `mc missions approve | reject`.
5. **Withdraw and cancel** (OQ-6, §7.2): owner-only, with hold release and crew notification when cancelling an Approved mission.
6. **Assignments** (§13): `GET /v1/assignments/me`, `POST /v1/assignments/{id}/acknowledge` (own, binding, cannot refuse). CLI: `mc assignments list | acknowledge`.
7. **Notifications** (§17, OQ-8): `NotificationService` and the recipient table of §17; `GET /v1/notifications`, `POST /v1/notifications/{id}/read` (own only). CLI: `mc inbox [--unread] | read`.
8. **Deactivation guards** (OQ-4): add the Crew (has holds) and Lead (owns non-terminal missions) guards to user deactivation, behind the single policy function Spec 02 introduced.
9. **CLI** (§14): `mc missions create | requirements set | start-crewing | crew set | submit | withdraw | cancel | list | show`.
10. Contracts first for every endpoint (§21).

## Out of scope

Matcher and its endpoints (05); the scheduler process itself (06); seed data (06).

## Open points needing a product decision

None open. The `start_crewing` guard and the crew-validation shape are decided in DESIGN.md §7.

## Acceptance criteria

- Every (state, action, role) combination behaves per §7.2, including denial responses.
- A mission cannot start crewing without a requirement; there is no crew-size field in any request or response, and submit needs at least one assignee satisfying every requirement.
- After changing dates or requirements in Crewing, the mission read shows the correct `crewValidation` and nothing is removed or rejected.
- Invariants 2–9 of §5.2 hold; two concurrent submits of different missions sharing one crew member and overlapping dates yield exactly one success.
- Workload cap enforced at submit; lowering the cap does not release existing holds.
- Reject, withdraw, cancel and expire release holds with the correct `release_reason`; complete releases holds as history.
- A Lead cannot edit, crew, submit or cancel another Lead's mission; Directors cannot cancel; Active missions cannot be cancelled.
- Approved and later missions reject edits to details, requirements and crew.
- Notification recipients match §17 exactly.
- The full manual flow runs from `mc`: create → requirements → crewing → crew set → submit → approve → crew acknowledges.

## Tests

Table-driven lifecycle test generated from the transition table; concurrency test on submit; permission matrix rows; cross-tenant 404 per endpoint; stale-version 412 tests; audit-event-per-transition test; system transitions tested with an injected `today` including idempotence and time-zone edges.
