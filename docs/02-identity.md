# Spec 02 — Identity

Milestone 2 of DESIGN.md §20. Source of truth for all detail: [DESIGN.md](../DESIGN.md).

## Goal

Operator provisioning, authentication, the role policy layer, user management and CLI authentication. Done when the onboarding chain operator → Director → Lead → Crew works from the CLI.

## Depends on

- **Spec 01 (hard):** schema (`organisations`, `users`, `invites`, `refresh_tokens`, `crew_profiles`), roles, `withTenant` / `withPlatform`, `Actor`, `AppError`.
- No dependency on specs 03–06. Mission-related deactivation guards are added later by Spec 04.

## Interfaces consumed (stubs)

| Interface | From | Stub until available |
|---|---|---|
| `AuditWriter` | 01 port / 03 implementation | Use the in-memory fake or a no-op. Call it at every audited site now; Spec 03 wires the real writer and adds assertions |

## Scope

1. **Operator provisioning** (§6, §11, §12, §13): `POST /v1/platform/organisations` creates the organisation and its first Director and returns a one-time invite code. Separate operator credential from deploy configuration, accepted only on `/v1/platform/*`, no `org` claim, no tenant context. CLI: `mc platform org create`.
2. **Sessions** (§12): `POST /v1/auth/login | refresh | logout | accept-invite`. argon2id; EdDSA JWT access tokens (15 min) with `sub`, `org`, `role`, `exp`; opaque single-use rotating refresh tokens (30 days, hashed), reuse revokes the family. Login rate limiting per email and per IP, generic errors, login failures recorded as security events via `AuditWriter`.
3. **`GET /v1/me`** (§13).
4. **Policy layer** (§6, §21): `can(actor, action, resource)` evaluated in the service layer. The role matrix of §6 as data, so permission tests can be table-driven. Out-of-visibility resources return 404 (§6). This spec registers the rules for the capabilities it owns; later specs add their own.
5. **User management** (§6, §13): `GET/POST /v1/users`, `PATCH /v1/users/{id}` (Director only): invite with role, change role, deactivate. Role changes and deactivation revoke refresh tokens. Inviting a Crew Member user creates its `crew_profiles` row. CLI: `mc users invite | list | set-role | deactivate`.
   - **Role-change rules** (§3 "Role changes"): a Crew Member may become a Lead or a Director; Lead ↔ Director is allowed; **no user can ever be changed to Crew** (reject with a stable problem code). The same blocking conditions as deactivation apply (OQ-4), through the single guard function.
   - When a Crew Member leaves the Crew role, their `crew_profiles` row, skills and unavailability are kept as dormant data. They are excluded from crew listings and matching (the §9.2 "active Crew Member" filter is role-based), and tentative assignments they still hold are reported as `NOT_ELIGIBLE` by Spec 04's crew validation.
6. **Deactivation guards** (OQ-4): the "last active Director" guard is implemented here. The Crew (has holds) and Lead (owns non-terminal missions) guards need mission data and are delivered by Spec 04 behind a single policy function. Until then they are inactive.
7. **CLI auth** (§12, §14): `mc config set-url`, `mc auth login | logout | accept-invite | whoami`; tokens in `~/.config/mission-control/credentials.json`, mode `0600`, transparent refresh. Exit codes per §14. The CLI package skeleton, HTTP client over shared contracts and `--json` handling are established here.
8. **API skeleton**: Fastify app, Zod validation, RFC 9457 error mapping, auth plugin that derives the `Actor`, cursor-pagination helper. Contracts for every endpoint above are added to `contracts` first (§21).

## Out of scope

Org settings, skills, crew skills/unavailability (03); audit read endpoint (03); missions and notifications (04).

## Open points needing a product decision

None open. Role-change behaviour is decided in DESIGN.md §3.

## Acceptance criteria

- operator → Director → Lead → Crew onboarding works end to end from `mc` against docker-compose.
- Refresh-token reuse revokes the whole family; role change and deactivation revoke refresh tokens; deactivated users cannot log in or refresh.
- Invite codes are single-use, expire after 72 h, and are stored hashed.
- Operator credential is rejected on non-platform routes; user JWTs are rejected on platform routes.
- A Director cannot be deactivated if they are the last active Director.
- Changing any user to the Crew role is rejected; Crew → Lead/Director succeeds only when the deactivation guards (OQ-4) pass, and leaves the crew profile intact but not listed.
- Email is unique platform-wide, case-insensitively.
- A second organisation's user addressing another org's user ID gets 404.

## Tests

Auth flows incl. expiry and reuse detection; role matrix tests table-driven from the matrix data; cross-tenant 404 test on every endpoint here; rate-limit test; CLI e2e of the onboarding chain.
