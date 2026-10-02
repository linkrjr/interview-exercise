# Spec 01 — Foundations

Milestone 1 of DESIGN.md §20. Source of truth for all detail: [DESIGN.md](../DESIGN.md).

## Goal

A buildable monorepo with the full database schema, tenant isolation (RLS + roles + `withTenant`), shared base contracts, local infrastructure and CI. Every later spec builds on this one.

## Depends on

Nothing. This spec is the root; all others hard-depend on it.

## Scope

1. **Monorepo** (§10.1, §10.2): pnpm workspaces with packages `contracts`, `core`, `matcher`, `db`, `api`, `scheduler`, `cli`. Node 24 LTS, TypeScript strict, Vitest, lint. Packages other than `contracts`, `db` and `core` may be empty shells that build and test cleanly.
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
- `app_tenant` cannot update or delete `audit_events`, cannot bypass RLS, and cannot read `organisations` beyond its own row. `app_platform` cannot select tenant data. `app_scheduler` can read only `organisations(id, time_zone)`, and can insert into and delete from `alerts` (§16.1) with `SELECT` limited to the `occurred_at` column (needed by the retention `DELETE … WHERE`); it cannot read any other column or table, and cannot update anything.
- `SET LOCAL` context does not leak between two sequential `withTenant` calls on the same pooled connection.
- Inserting two unreleased holds for one crew member with overlapping `period` fails; a released hold does not conflict.
- CI runs all of the above on every push.

## Tests

Raw SQL isolation tests across every tenant table (generated from the table list so new tables cannot be forgotten), constraint tests for the exclusion constraint and CHECK ranges (level 1–5, cap 1–20, `end_date ≥ start_date`), role-grant tests.

## Notes

- Schema-creation order must satisfy the composite-FK graph; generate RLS policies from a single list of tenant tables.

## Implementation notes

Status: implemented. Decisions taken while building, for the specs that follow:

- **Node 24 LTS** (not 22), TypeScript 6.0 (typescript-eslint does not yet support 7.x), ESLint + Prettier, Vitest 5, pnpm 12. Package scope is `@mc/*`.
- **Migrations** are hand-written SQL in `packages/db/migrations`, scaffolded with `drizzle-kit generate --custom` and applied by Drizzle's migrator. `packages/db/src/schema` is the column-level Drizzle view of the same tables; a test fails if the two drift apart.
- **Roles** are created `NOLOGIN` by the migrations. `provisionRoles` (run by `mc-db-migrate`, the compose `migrate` service and the test harness) sets their login and password from `APP_TENANT_PASSWORD`, `APP_PLATFORM_PASSWORD` and `APP_SCHEDULER_PASSWORD`. Each role has its own pool, configured by `DATABASE_URL_TENANT`, `DATABASE_URL_PLATFORM` and `DATABASE_URL_SCHEDULER`; migrations use `DATABASE_URL_MIGRATOR`.
- **RLS** uses `NULLIF(current_setting('app.org_id', true), '')::uuid`. After a transaction that used `SET LOCAL`, the setting reads as an empty string on that connection, which would make a plain `::uuid` cast raise an error instead of returning zero rows (DESIGN.md §11 updated).
- **Grants** are the minimum implied by DESIGN.md; later specs add grants in their own migrations. `app_tenant` has no `DELETE` on `holds`, `audit_events`, `approval_decisions`, `users`, `skills`, `missions` and `organisations`, and `UPDATE` on `organisations` only for `time_zone` and `max_upcoming_missions`. It has `UPDATE` on `crew_profiles` because `SELECT … FOR UPDATE` (§8) requires it. `app_platform` has `INSERT` only on `organisations`, `users` and `invites`, so inserts must not use `RETURNING` and ids are generated by the caller with `newId()`. `app_scheduler` has `SELECT (occurred_at)` on `alerts`, which the retention `DELETE … WHERE` needs.
- **No pre-authentication lookup path** exists in the database. Login takes the organisation ID, and refresh tokens and invite codes carry it (DESIGN.md §11, §12), so every authentication step runs through `withTenant`.
- `holds` has a partial unique index allowing one live hold per assignment, and `assignment_id` is a plain (restricting) composite foreign key. Spec 04 must decide what happens to hold history when a tentative assignment is removed.
- `crew_profiles.user_id` references `users` only; there is no `role = 'crew'` constraint, because profiles of former Crew Members are kept (DESIGN.md §3).
- Test infrastructure for later specs: `@mc/db/testing` exports `startTestDatabase`, `seedTenant`, `addMission`, `addAssignment` and `addHold`; `packages/db/test/global-setup.ts` shows how to share one container per package.
