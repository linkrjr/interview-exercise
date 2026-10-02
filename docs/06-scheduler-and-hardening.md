# Spec 06 — Scheduler and hardening

Milestone 6 of DESIGN.md §20. Source of truth for all detail: [DESIGN.md](../DESIGN.md).

## Goal

The lifecycle scheduler, rate limits, the generated OpenAPI document, the demo seed scenario, the end-to-end suite and the README.

## Depends on

This is the integration spec; most of it needs the others, but the parts differ.

| Part | Depends on |
|---|---|
| Scheduler process | **Spec 04 (hard):** `MissionService.runSystemTransitions`. **Spec 01 (hard):** `withScheduler`, `app_scheduler` role. Can be built and tested against a fake service |
| Alerts (`alerts` writes, `GET /v1/alerts`, `mc alerts`) | **Spec 01 (hard):** `alerts` table and `app_scheduler` grants. **Spec 02 (soft):** auth and `can()`. Writes can be tested against a fake failing `runSystemTransitions` |
| Rate limits, request size limits | **Spec 02 (soft):** API skeleton. Matcher limit needs **Spec 05 (hard)** for the endpoint |
| OpenAPI | **Specs 02–05 (hard)** for complete coverage; the generator itself needs only the contracts package |
| Seed scenario (`mc dev seed`) | **Specs 02–04 (hard)**; **05** only if the seed includes proposals |
| E2E suite and README | **All specs (hard)** |

## Interfaces consumed (stubs)

| Interface | From | Stub until available |
|---|---|---|
| `runSystemTransitions(tx, today)` | 04 | Fake that records calls and the `today` it was given |
| `db.withScheduler` | 01 | Provided |
| Clock | this spec | Injectable `Clock` used by the scheduler and by tests |

## Scope

1. **Scheduler** (§16): package `scheduler`. Runs every 5 minutes and once on start-up. For each organisation (via `app_scheduler`), computes today in the organisation's time zone and applies, through the normal `withTenant` path with actor `system`: expire (Pending approval, start < today → Crewing), activate (Approved, start ≤ today → Active), complete (Active, end < today → Completed, releasing holds). Idempotent, audited. A single instance guarded by a Postgres advisory lock. One failing organisation must not stop the others: the failure is logged, an alert is raised (item 2) and the scheduler continues. The failed organisation's changes for that run are rolled back as a whole and retried on the next run.
2. **Alerts** (§16.1, OQ-10): on a per-organisation failure, write a row to `alerts` (`source = scheduler`, stable `code`, message, structured details, no secrets or personal data) in its own transaction, separate from the failed organisation's one, via the `app_scheduler` role (`INSERT` and `DELETE` on `alerts`). One alert is written per failed run, with no deduplication, so a persistently failing organisation produces an alert every run. Alerts are kept for 30 days: each run deletes alerts older than 30 days. Expose `GET /v1/alerts` (Director of that organisation only, filter by time, cursor pagination) and `mc alerts [--since 2026-09-01]`. Contract first (§21), policy rule, permission and cross-tenant tests.
3. **Rate limits and limits** (§18, §12): per-user rate limit on the matcher endpoint, **30 requests per minute** (configurable, to be re-evaluated after launch), and request size limits. Login limiting already exists from Spec 02.
4. **OpenAPI** (§13): generate OpenAPI 3.1 from the Zod contracts and serve it at `/v1/openapi.json`; fail CI if it drifts from the contracts.
5. **Seed scenario** (§14): `mc dev seed --scenario demo`, dev builds only: two organisations with Directors, Leads, crew, skills and missions in various states, so every workflow and tenant isolation can be demonstrated quickly. Must not be reachable in production builds.
6. **Test-only clock endpoint** (§3, §13, §19): an endpoint that runs one scheduler pass as if "today" were a supplied date (the scheduler is a separate process, so the endpoint triggers a pass rather than changing a clock), so the e2e suite can move missions through Approved → Active → Completed without waiting. Registered only in non-production builds (the same switch as the seed command), absent from the OpenAPI document and the public API, and covered by a test proving it is not registered when built for production.
7. **E2E suite** (§19): CLI scripts against docker-compose covering operator → director → lead → crew → approve → activate (time advanced through the test-only clock endpoint), plus cross-tenant checks and a forced scheduler failure that produces an alert visible through `mc alerts`.
8. **Operations**: add the API and scheduler services to `docker-compose.yml`; no PII in logs (emails masked, §18); HSTS and security headers.
9. **README**: setup, running locally, running tests, the CLI walkthrough.

## Out of scope

New product features. Notification delivery beyond the inbox, a web UI and everything in §22.

## Open points needing a product decision

None open.

## Acceptance criteria

- With an injected clock, a mission moves Approved → Active on its start date and Active → Completed the day after its end, in the organisation's time zone, including orgs east and west of UTC around midnight.
- Pending approval missions whose start date passed return to Crewing with the owner notified.
- When processing one organisation throws, the scheduler logs it, writes an `alerts` row (surviving the rollback), still processes the remaining organisations, and retries the failed one on the next run.
- A Director sees only their own organisation's alerts through `GET /v1/alerts` and `mc alerts [--since …]`; Leads and Crew are denied, and another organisation's Director gets nothing (cross-tenant test). Alerts contain no secrets or personal data.
- The test-only clock endpoint exists in dev/test builds and returns 404 (is not registered) in production builds.
- Running the scheduler twice for the same instant changes nothing the second time; two instances never run concurrently.
- `/v1/openapi.json` validates as OpenAPI 3.1 and covers every endpoint.
- Seed produces two organisations; a user from one cannot read the other's data by ID.
- The full e2e flow passes in CI; coverage is ≥ 90% for `core` and `matcher`.
- Matcher endpoint returns `429` beyond the configured rate (default 30 requests per minute per user).
- A persistently failing organisation gets one alert per run; alerts older than 30 days are deleted by the next run.

## Tests

Scheduler with injected clock and time-zone edge cases; failure isolation and alert-writing tests; alerts permission and cross-tenant tests; advisory-lock exclusivity test; OpenAPI validation; CLI e2e scripts; log redaction test.
