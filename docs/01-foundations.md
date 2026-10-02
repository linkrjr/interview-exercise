# Spec 01 — Foundations

Milestone 1 of DESIGN.md §20. Source of truth for all detail: [DESIGN.md](../DESIGN.md).

## Goal

A buildable monorepo with the full database schema, tenant isolation (RLS + roles + `withTenant`), shared base contracts, local infrastructure and CI. Every later spec builds on this one.

## Depends on

Nothing. This spec is the root; all others hard-depend on it.

## Scope

1. **Monorepo** (§10.1, §10.2): pnpm workspaces with packages `contracts`, `core`, `matcher`, `db`, `api`, `scheduler`, `cli`. Node 22, TypeScript strict, Vitest, lint. Packages other than `contracts`, `db` and `core` may be empty shells that build and test cleanly.
2. **Schema and migrations** (§15, §8): every table in §15 for all milestones, including `holds` with the exclusion constraint, `missions.version`, `match_proposals`, `notifications`, `audit_events`, `alerts`. There is no `crew_size` and no skill archive column. SQL migrations via Drizzle. Composite FKs including `org_id` (§11). Extensions: `btree_gist`, `citext`.
3. **Roles and RLS** (§11): `app_tenant` (no `BYPASSRLS`, not table owner), `app_platform`, `app_scheduler` with the minimal grants described; `ENABLE` + `FORCE ROW LEVEL SECURITY` and the `tenant_isolation` policy on every tenant table; `UPDATE`/`DELETE` revoked on `audit_events` from `app_tenant`.
4. **Data-access helpers** (§10.3, §11): `db.withTenant(orgId, fn)` (`BEGIN; SET LOCAL app.org_id; SET LOCAL ROLE app_tenant`), plus the platform and scheduler entry points. Lint rule forbidding the raw connection outside `db/`.
5. **Shared base types and errors**: see "Interfaces provided".
6. **Local infrastructure**: `docker-compose.yml` with Postgres 16 (API and scheduler services added as they come into existence).
7. **CI** (§19, §18): typecheck, lint, unit, integration (Testcontainers Postgres), `pnpm audit`. Coverage gate configured for `core` and `matcher`.

## Out of scope

Any HTTP route, authentication, business logic or CLI command.

## Interfaces provided (consumed as stubs by specs 02–06)

```ts
// contracts
type Role = 'director' | 'lead' | 'crew';
type Actor =
  | { kind: 'user'; userId: string; orgId: string; role: Role }
  | { kind: 'system' };                       // scheduler
type ProblemDetails = { type: string; title: string; status: number; code: string; detail?: string; errors?: FieldError[] };
type Page<T> = { items: T[]; nextCursor: string | null };
class AppError extends Error { constructor(code: string, status: number, detail?: string, extra?: object) }

// db
db.withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T>
db.withPlatform<T>(fn: (tx: PlatformTx) => Promise<T>): Promise<T>        // app_platform
db.withScheduler<T>(fn: (tx: SchedulerTx) => Promise<T>): Promise<T>      // app_scheduler: read organisations(id, time_zone), insert/delete alerts
newId(): string                                                           // UUIDv7

// core (port only; implementation is Spec 03)
interface AuditWriter { record(tx: Tx, event: AuditEventInput): Promise<void> }
// plus an in-memory fake exported for tests
```

## Acceptance criteria

- `pnpm install && pnpm build && pnpm test` pass from a clean checkout; `docker compose up` gives a migrated Postgres.
- With `app.org_id` unset, `SELECT` on every tenant table returns zero rows; with another org's ID it returns zero rows; `INSERT` with a foreign `org_id` is rejected by `WITH CHECK`.
- A row cannot reference another tenant's row via a crafted ID (composite FK test).
- `app_tenant` cannot update or delete `audit_events`, cannot bypass RLS, and cannot read `organisations` beyond its own row. `app_platform` cannot select tenant data. `app_scheduler` can read only `organisations(id, time_zone)` and insert into and delete from `alerts` (§16.1); it cannot select, update or delete anything else.
- `SET LOCAL` context does not leak between two sequential `withTenant` calls on the same pooled connection.
- Inserting two unreleased holds for one crew member with overlapping `period` fails; a released hold does not conflict.
- CI runs all of the above on every push.

## Tests

Raw SQL isolation tests across every tenant table (generated from the table list so new tables cannot be forgotten), constraint tests for the exclusion constraint and CHECK ranges (level 1–5, cap 1–20, `end_date ≥ start_date`), role-grant tests.

## Notes

- Schema-creation order must satisfy the composite-FK graph; generate RLS policies from a single list of tenant tables.
