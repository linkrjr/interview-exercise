#!/usr/bin/env bash
# Builds and starts the docker-compose stack on its own ports and volume, runs the end-to-end suite
# against it with the real `mc` binary, and always tears the stack down again.
set -euo pipefail
cd "$(dirname "$0")/../.."

export COMPOSE_PROJECT_NAME="${E2E_COMPOSE_PROJECT:-mc-e2e}"
export API_PORT="${E2E_API_PORT:-3100}"
export POSTGRES_PORT="${E2E_POSTGRES_PORT:-5543}"
export E2E_COMPOSE_PROJECT="$COMPOSE_PROJECT_NAME"
export E2E_API_URL="http://localhost:${API_PORT}"

cleanup() { docker compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
pnpm build
docker compose up -d --build
pnpm --filter @mc/e2e test:e2e
