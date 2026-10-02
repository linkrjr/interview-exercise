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

None open. Pinning is removed, and the proposal hash is the team-email hash defined above (DESIGN.md §9.5).
