# Spec 05 — Matcher

Milestone 5 of DESIGN.md §20. Source of truth for all detail: [DESIGN.md](../DESIGN.md).

## Goal

A pure auto-matching engine that proposes the best whole team, plus the endpoints and CLI that expose it. Done when the property tests against the brute-force oracle pass.

## Structure and dependencies

This spec has two parts with very different dependencies.

| Part | Depends on |
|---|---|
| **A. Engine** (`packages/matcher`) | **Nothing** except the monorepo shell from Spec 01. Can be built and fully tested first, or in parallel with 02–04 |
| **B. Endpoints, persistence, CLI** | **Spec 04 (hard):** missions, `replaceCrew`, `loadUpcomingLoad`, state. **Spec 03 (hard for real data):** crew skills, unavailability, org settings. **Spec 02 (soft):** auth and CLI skeleton. Spec 01 (hard): `match_proposals` table |

## Part A — Engine

Package `matcher` must stay pure: no imports from `db`, `api` or Node I/O (§21).

```ts
match(input: MatchInput): MatchResult
// MatchInput: mission dates, requirements[{ skillId, minLevel, count }],   // no crew size: team size is whatever covers the requirements
//   candidates[{ id, load, skills: Map<skillId, level>, blockedReason? }], exclude[], cap
// MatchResult: exactly the shape in §9.4
```

Scope:
1. **Candidate filtering** (§9.2): hard constraints with the reason codes `UNAVAILABLE`, `COMMITTED`, `AT_CAPACITY`, `EXCLUDED`. The engine receives the facts about each candidate (unavailability and hold overlap flags, load, cap) and applies the rules. Loading them is Part B.
2. **Exact solver** (§9.3): HiGHS (WASM) ILP with variables `x_i` and `u_r` (no seat variable, no cardinality constraint), solved lexicographically in three passes: coverage (`min Σ u_r`), workload balance (`(load_i + 1)²`, which also yields the smallest covering team), skill fit (margin capped at +2 per requirement). Final ties broken by crew member ID for determinism. 2-second limit per pass.
3. **Heuristic fallback** (§9.3): greedy by most unmet slots covered, tie-break lowest load then fit, then 1-swap local search. `method` is `"exact"` or `"heuristic"` in the result.
4. **Explanations** (§9.4): per-requirement `met`, `gap.qualifiedTotal` and `gap.blocked` counts by reason code (counts only, never names), `complete` (every requirement met), and up to 3 `alternates` per requirement. There is no `unfilledSeats`.
5. **Infeasible input** returns the best partial team (§3), never throws for infeasibility.

## Part B — Endpoints and persistence

1. `POST /v1/missions/{id}/match` (owner, mission in Crewing; body `exclude`): load candidates and mission data in a tenant transaction, call the engine, and store the result in `match_proposals` with a `proposalId`, a `team_hash` and a 30-minute expiry (§9.5). The `team_hash` is a SHA-256 over the proposed team members' emails (unique per user), lower-cased, sorted and joined; it is returned to the Lead with the proposal. There is no `pin`: Leads cannot force people onto a proposal, and add anyone they want by hand through `PUT /v1/missions/{id}/crew`. The per-user rate limit on this endpoint is 30 requests per minute, configured in Spec 06 (§18); expose it as a policy so 06 only sets the number.
2. `POST /v1/missions/{id}/match/{proposalId}/apply`: takes the `teamHash` the Lead was shown, recomputes the hash from the stored proposal's team members' current emails, and replaces the tentative crew via `MissionService.replaceCrew` only if both equal the stored `team_hash`; otherwise `409` and the Lead re-runs. This guarantees the team applied is exactly the one proposed and that no member was dropped or altered since. Submission re-validates regardless.
3. Contracts first for request/response (§21). CLI: `mc missions match <id> [--exclude]` printing team, coverage and gaps, and `mc missions match apply <id> <proposalId>`.

## Interfaces consumed (Part B stubs)

| Interface | From | Stub until available |
|---|---|---|
| `MissionService.replaceCrew`, mission loading | 04 | In-memory fake that records the crew set |
| `loadUpcomingLoad(tx, ids)` | 04 | Direct SQL count of unreleased holds |
| Crew skills, unavailability, `OrgSettings` | 03 | SQL-seeded fixtures; fake settings |
| `Actor`, `can()` | 02 | Injected actor |

## Out of scope

The rate-limit configuration and OpenAPI (06); changing mission state (the matcher is advisory and never submits).

## Acceptance criteria

- Property tests (fast-check) on small instances agree with a brute-force oracle on coverage, then balance, then fit.
- Same input always produces byte-identical output (determinism test).
- A forced solver timeout yields a valid result with `method: "heuristic"`.
- Gap counts reconcile: qualified people = met contributors + sum of blocked reasons + not selected.
- Excluded people never appear in a proposal; the request and CLI have no `pin`.
- Proposals contain the email of each team member and a `teamHash`; the hash is order-independent and case-insensitive over emails.
- Apply succeeds with the correct `teamHash`; it fails with 409 if the supplied hash differs from the stored one or if a stored team member's email no longer produces the stored hash; an expired proposal fails.
- Engine never returns blocked individuals' names or reasons per person.

## Tests

Oracle property tests, determinism, explanation accuracy, heuristic path, exclude edge cases (excluding everyone qualified yields a partial team with gaps), endpoint ownership and cross-tenant 404, proposal expiry and hash-mismatch.

## Open points needing a product decision

None open. Pinning is removed, and the proposal hash is the team-email hash defined above (DESIGN.md §9.5). The questions raised while building were decided (see the implementation notes).

## Implementation notes

Status: implemented. Decisions taken while building, for the specs that follow:

- **Engine and solver:** `@mc/matcher` is pure: `match(input, { solver, timeLimitSeconds? })` is synchronous and talks to a `Solver` port. The only file that loads a runtime is `src/highs.ts` (entry point `@mc/matcher/highs`, `createHighsSolver()`, async because HiGHS loads its WebAssembly module). A lint rule forbids Node built-ins, `process`, `Buffer`, `@mc/*` and `highs` anywhere else in the engine, and is tested. The signature is therefore `match(input, options): MatchResult`, not `match(input)`.
- **Four passes, one model:** coverage, workload `(load+1)²`, skill fit (margin above each requirement capped at 2), then a last pass minimising the sum of ID-order ranks. Candidates and requirements are sorted by ID, HiGHS runs single-threaded with a fixed seed, and the MIP gaps are 0, so the same input gives byte-identical output in any input order. This prefers low IDs deterministically; it does not guarantee the lexicographically smallest optimal team.
- **Pool:** only eligible people who qualify for at least one requirement enter the model (anyone else only adds cost). A time-out or failure of any pass, or `time_limit`/`error` from the solver, falls back to the greedy heuristic plus 1-swap search (drop a member or swap one), which scores teams by the same four objectives. With nobody qualified the empty team is trivially optimal and reported as `exact`.
- **Block reasons:** a candidate is blocked by `UNAVAILABLE`, `COMMITTED`, `AT_CAPACITY` (load at or above the cap) or `EXCLUDED`; each blocked person is counted once, under the first that applies in that order. `gap` appears only on unmet requirements, and `qualifiedTotal = met + Σ blocked` there.
- **Part B:** `MatchService` (core) loads every active Crew Member with their skills, the unavailability and hold overlaps (through `memberIssues`, `DOUBLE_BOOKED` is `COMMITTED`), and loads (`loadUpcomingLoad`); `exclude` takes crew member user IDs and refuses ids that are not active Crew Members of the organisation (`CREW_MEMBER_NOT_ASSIGNABLE`); the request body is strict, so `pin` is a 400. The mission must be Crewing and owned by the caller. The proposal stores `{ missionVersion, memberIds, result }` in `match_proposals.result` (no schema change). Proposing writes no audit event and changes nothing.
- **No transaction around the solver:** `propose` reads the mission and the facts in one short transaction, solves with no transaction and no connection held, then stores the proposal in a second transaction that first locks the mission and refuses (`409 MATCH_PROPOSAL_STALE`) if it is no longer Crewing at the version the proposal was computed for. The solver is still synchronous and runs on the event loop for as long as it takes (typically milliseconds, at most four passes of the time limit); moving it to a worker thread would be a further step that leaves the engine unchanged.
- **Housekeeping:** every `propose` deletes the organisation's expired proposals (of any mission) and this mission's proposals made for an older mission version (a version never comes back). Proposals of the current version stay usable until they expire, so a Lead can compare two runs.
- **Apply:** the owner, `If-Match` (412 first), then proposal found (404), unexpired (`MATCH_PROPOSAL_EXPIRED`), computed for the current mission version (`MATCH_PROPOSAL_STALE`, with both versions), the supplied hash equal to the stored one and to the hash recomputed from the members' current emails (`MATCH_TEAM_HASH_MISMATCH`); then `MissionService.replaceCrew` with `within: tx`, which still refuses members who stopped being active Crew Members and audits `mission.crew_set` with the `matchProposalId`. All of apply runs in one transaction with the mission locked, so an expiry, an edit or a change of email cannot fall between the checks and the replacement.
- **Services config:** `createServices` now requires a `solver`; the test harness shares one HiGHS instance per process and accepts an override (`solver`), and the API server creates it at start-up.
- **Rate limit:** the API has the per-user mechanism (`matchRate`, off unless configured, matcher only, invalid requests not counted); spec 06 sets the number.
- **CLI:** `mc missions match <id> [--exclude <crewId>]...` prints the team, coverage with gaps, next best, the hash and the apply command; `mc missions match apply <id> <proposalId> --team-hash <hash> [--version n]`. There is no `--pin`.
- **Scale:** 500 candidates and four requirements solve in well under a second; the property tests run 100 to 250 random instances per property against a brute-force oracle (all four objectives, eligibility, coverage, gap reconciliation, determinism under permutation, privacy, alternates, heuristic validity).
