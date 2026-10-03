# Mission Control

## Project Description

Mission Control is a multi-tenant platform for planning the crews of space missions. Each organisation has its own Directors, Leads and Crew Members, a skill catalogue, and missions that move through an explicit lifecycle (Draft, Crewing, Pending approval, Approved, Active, Completed, Cancelled).

- **Roles:** Leads create missions and crew them. Directors approve or reject them. Crew Members keep their skills and unavailability up to date and acknowledge their assignments.
- **Holds:** submitting a mission reserves its crew, so nobody is double-booked or put over the workload cap. Holds are released with a recorded reason.
- **Matcher:** an optimising auto-matcher (HiGHS) proposes a team. It is advisory; the Lead applies it.
- **Scheduler:** a separate process activates and completes missions, and expires stale approvals, on each organisation's own calendar day. Failures raise alerts that Directors read with `mc alerts`.
- **Isolation:** tenants are isolated by Postgres row-level security as well as by the application code.
- **Interfaces:** a REST API (OpenAPI 3.1 at `/v1/openapi.json`) and the `mc` command line.

The product decisions and architecture are in [DESIGN.md](DESIGN.md). The implementation specs are in [docs/](docs/).

## How to Install and Run the Project

### Requirements

- Node.js 24 or later (`.nvmrc`) and pnpm 12 (`corepack enable` is enough)
- Docker, for Postgres 16 and for the integration tests (testcontainers)

### Run everything with Docker Compose

```sh
cp .env.example .env        # optional: compose falls back to the same defaults
docker compose up --build
```

This starts Postgres, applies the migrations (`migrate`), then starts the API on <http://localhost:3000> and the scheduler. In this setup `NODE_ENV=development` and `ENABLE_TEST_ENDPOINTS=true`, so the API also serves the development-only helpers (`mc dev ...`) and generates an ephemeral token key. Tokens stop working when the API restarts. For stable keys, run `pnpm --filter @mc/api keygen` and set `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY`.

Reset the data with `docker compose down -v`.

### Run in development (hot code, local processes)

```sh
pnpm install
cp .env.example .env
set -a; source .env; set +a                          # load the connection URLs into your shell
docker compose up -d postgres                        # just the database
DATABASE_URL_MIGRATOR=postgres://postgres:postgres@localhost:5432/mission_control \
  pnpm db:migrate                                    # migrations and role logins (run once, and after pulling)
pnpm build                                           # or `pnpm exec tsc -b --watch` in a second terminal
pnpm --filter @mc/api start                          # API on :3000 (set ENABLE_TEST_ENDPOINTS=true in .env for `mc dev ...`)
pnpm --filter @mc/scheduler start                    # scheduler (every 5 minutes, and once at start-up)
```

Use the CLI from the build output:

```sh
alias mc="node $PWD/packages/cli/dist/bin/mc.js"
mc config set-url http://localhost:3000
```

Useful scripts:

| Command                                            | Does                                                      |
| -------------------------------------------------- | --------------------------------------------------------- |
| `pnpm build`                                       | Compile every package (`tsc -b`)                          |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | Static checks (`pnpm format` fixes formatting)            |
| `pnpm test:unit`                                   | Unit tests                                                |
| `pnpm test:integration`                            | Integration tests on a disposable Postgres (needs Docker) |
| `pnpm test:coverage`                               | Coverage gate: at least 90% for `core` and `matcher`      |
| `pnpm openapi:generate` / `pnpm openapi:check`     | Regenerate / verify the committed `openapi/openapi.json`  |
| `pnpm audit:ci`                                    | Dependency audit                                          |

Settings are environment variables, validated at start-up (see `.env.example`). The important ones are `DATABASE_URL_TENANT`, `DATABASE_URL_PLATFORM`, `DATABASE_URL_SCHEDULER`, `PLATFORM_OPERATOR_TOKEN` (at least 32 characters), `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` (required in production), `MATCH_RATE_MAX` (default 30 a minute per user), `BODY_LIMIT_BYTES` and `SCHEDULER_INTERVAL_SECONDS`.

### Production notes

The `/v1/test/*` endpoints (seed, scheduler run) exist only with `ENABLE_TEST_ENDPOINTS=true`, which is off by default and which a `NODE_ENV=production` start-up refuses. The API needs only the tenant and platform logins, and the scheduler needs the tenant and scheduler logins. TLS ends at your load balancer; the API sends HSTS and other security headers.

## How to Use the Project

The `mc` command is the primary client; add `--json` to any command for machine-readable output. Exit codes: 0 ok, 1 usage or validation, 2 authentication or permission, 3 not found, 4 conflict, 5 server or network.

### Try it with demo data (development servers)

```sh
export MC_OPERATOR_TOKEN=dev-operator-token-change-me-0123456789
mc dev seed --scenario demo      # two organisations with people and missions in every state
mc auth login --org <organisation id> --email director@lunar-gateway.example   # password: demo-password-123
mc missions list
```

`mc dev seed` prints the organisation ids and every seeded user's email. Run it once per empty database.

### The workflow from scratch

```sh
# Operator: create an organisation and its first Director
mc platform org create --name "Lunar Research Lab" --director-email dir@example.com

# Director: accept the invite (prompts for name and password), then invite a Lead and crew
mc auth accept-invite <invite code>
mc users invite --email lead@example.com --role lead
mc users invite --email ann@example.com --role crew
mc skills add Medicine

# Crew Member: accept the invite, then maintain the profile
mc profile skill set Medicine 4
mc profile unavailable add 2027-01-10 2027-01-15 --note "Training"

# Lead: create and crew a mission, then submit it
mc missions create --name "Artemis Relay" --start 2027-03-01 --end 2027-03-10
mc missions requirements set <missionId> --req "Medicine:3:1"
mc missions start-crewing <missionId>
mc missions match <missionId>              # propose a team; nothing changes yet
mc missions match apply <missionId> <proposalId> --team-hash <hash>   # make it the tentative crew (the output shows the hash)
mc missions submit <missionId>

# Director: decide
mc approvals list
mc missions approve <missionId>

# Crew: see and acknowledge the assignment
mc assignments list
mc assignments acknowledge <assignmentId>
```

`mc --help` and `mc <command> --help` list every command and option. Others you will use:

- `mc crew list --skill "Medicine>=3" --available 2027-03-01:2027-03-10`
- `mc inbox [--unread]`
- `mc audit list [--entity mission:<id>] [--since 2026-09-01]`
- `mc alerts [--since 2026-09-01]`: scheduler failures (Directors)
- `mc org settings show | set`

### Time-based transitions

The scheduler activates Approved missions on their start date, completes Active ones after their end date, and returns stale Pending approvals to Crewing. On a development server you can move time yourself:

```sh
mc dev run-scheduler --date 2027-03-02
```

### The HTTP API

The API is documented in OpenAPI 3.1 at `GET /v1/openapi.json` (public), and a committed copy is in [openapi/openapi.json](openapi/openapi.json). Sign in with `POST /v1/auth/login`, then send `Authorization: Bearer <accessToken>`. Every change to a mission sends the version you last saw in `If-Match`. Errors are `application/problem+json` with a stable `code`.

## Terminal UI

`packages/tui` is a full-screen terminal client for the same API, built with [OpenTUI](https://opentui.com/) and React. It shares the CLI's configuration and credentials, so signing in on one signs in on the other. The full description is in [docs/tui.spec.md](docs/tui.spec.md).

What it does:

- **Sign in** with email, organisation and password. **Accept invite**, below the Login button, takes the invite code, your name and a new password (twice) and signs you in.
- **A navigation bar** shows only what your role can do (←/→ or Tab to choose, Enter on Sign out to leave). `q` quits where it cannot be text; Ctrl+C always quits.
  - Director: Approvals, Missions, Users, Skills, Settings, Audit log, Alerts, Inbox.
  - Lead: Missions, New mission, Skills (read only), Inbox.
  - Crew Member: My profile, My assignments, Inbox.
- **Tables** (missions, users, skills, audit, alerts, inbox, assignments) scroll with ↑/↓, PgUp/PgDn, Home/End or the mouse wheel, load more pages as you reach the end, and open a row as a popup with Enter or a click (Esc closes it, `r` reloads).
- **Missions:** a popup shows the mission in full. A Director approves (`a`) or rejects (`r`, a reason is required) a mission waiting for a decision. A Lead, on their own missions, starts crewing (`s`), reopens (`o`), submits (`u`), withdraws (`w`) or cancels (`x`), edits the mission (`e`), sets its requirements (`p`) and its crew (`c`); New mission creates one. Buttons appear only when the server's `allowedActions` allow them.
- **Users:** invite (`i`), deactivate (`d`) and reinvite (`r`). An invite code is shown once and can be copied with `c`.
- **Skills** (a Director adds with `a` and renames with `r`), **Settings** (time zone and workload cap, a Save button).
- **Crew Members** maintain their skills and unavailability and acknowledge assignments.

Colours follow the old Clipper programs: white on blue screens, blue on cyan popups, black on grey form fields.

### Running the TUI

OpenTUI needs Bun 1.3 or later (or Node 26.4+), so this package runs on Bun while the rest of the repository stays on Node 24. Install [Bun](https://bun.sh/), then, with the API running (see [Run everything with Docker Compose](#run-everything-with-docker-compose)):

```sh
pnpm install
pnpm build                          # the TUI reads the CLI's config through @mc/cli
mc config set-url http://localhost:3000   # once; the TUI uses the same setting (see the alias above)
bun packages/tui/src/index.tsx      # or: pnpm --filter @mc/tui start
```

`pnpm --filter @mc/tui dev` runs it in watch mode. Sign in on the login screen, or with `mc auth login` beforehand (a stored session skips the login screen). `MC_CONFIG_DIR` changes where the shared configuration and credentials are kept.

Tests (`bun test`, no server or Docker needed): `pnpm --filter @mc/tui test:unit`.
