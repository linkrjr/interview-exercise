# Workspace image used by the one-shot migration service and, later, the API and scheduler.
FROM node:24-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
