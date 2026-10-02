# Mission Control

## Project specification

The full project specification is in [DESIGN.md](DESIGN.md). It is the source of truth for product decisions (§3), open questions and their defaults (§4), the domain model, API, CLI, data model and architecture. Read the guidance for coding agents in §21 before changing code. The specs below are thin, link back to DESIGN.md sections for detail, and do not replace it.

## Implementation specs

One spec per milestone of DESIGN.md §20, in implementation order, in `docs/`. Each lists the interfaces it consumes from earlier specs together with a stub to build against, so it can be implemented in isolation.

| # | Spec | Delivers |
|---|---|---|
| 01 | [Foundations](docs/01-foundations.md) | Monorepo, full schema, RLS and roles, `withTenant`, base types, docker-compose, CI |
| 02 | [Identity](docs/02-identity.md) | Operator provisioning, auth, policy layer, user management, CLI auth |
| 03 | [Org and crew](docs/03-org-and-crew.md) | Audit write/read, org settings, skills, crew profiles, unavailability, crew search |
| 04 | [Missions and lifecycle](docs/04-missions-and-lifecycle.md) | Missions, state machine, holds, approvals, notifications, assignments |
| 05 | [Matcher](docs/05-matcher.md) | Pure matching engine, then match/apply endpoints and CLI |
| 06 | [Scheduler and hardening](docs/06-scheduler-and-hardening.md) | Scheduler, failure alerts (`mc alerts`), rate limits, OpenAPI, seed, test-only clock endpoint, e2e, README |

## Dependencies between specs

**Hard** means it blocks isolated implementation. **Soft** means it can be built against the stub in the spec and integrated later.

| Spec | Hard dependencies | Soft dependencies (stubbable) |
|---|---|---|
| 01 | none | none |
| 02 | 01 | `AuditWriter` implementation (03) |
| 03 | 01 | 02 (auth, `can()`, API/CLI skeletons); `holds` rows from 04 |
| 04 | 01 | 02 (auth, `can()`); 03 (org settings, skills, crew data, `AuditWriter`) |
| 05 engine | none beyond the 01 monorepo shell | none |
| 05 endpoints | 01, 03, 04 | 02 |
| 06 scheduler and alerts | 01, 04 (`runSystemTransitions`) | 02 (auth, `can()`) for the alerts endpoint |
| 06 seed, OpenAPI, e2e, README | 02, 03, 04, 05 (everything) | none |

What blocks isolated work:

- **01 blocks everything.** The schema, RLS roles and `withTenant` have no stub worth building against.
- **05 endpoints need 04** (mission state and `replaceCrew`) and **03** (crew data) for real behaviour; the matcher engine itself can be built at any time.
- **06 is the integration spec.** Only the scheduler can be built early, against a fake `runSystemTransitions`.
- **Later specs edit earlier ones in small ways:** 03 wires real audit writes into the 02 call sites; 04 adds the Crew and Lead deactivation guards (OQ-4) to the 02 user-management code.

## Open points

Each spec ends with "Open points needing a product decision". Do not guess these; ask the product owner first.
