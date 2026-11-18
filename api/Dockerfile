# syntax=docker/dockerfile:1
# HTF Leviathan API (Bun + Elysia)
# Build context: ./api   →   docker build -t htf-leviathan-api ./api

ARG BUN_VERSION=1.4.2

# ── Dependencies (production only, exactly as locked) ─────────────
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY app/package.json app/bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# ── Runtime ───────────────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    # Do not write a transpiler cache (allows a read-only root filesystem).
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

COPY --from=deps /app/node_modules ./node_modules
COPY app/package.json app/tsconfig.json app/health-check.js ./
# Versioned SQL migrations, applied only by the explicit migrate job.
COPY app/drizzle ./drizzle
COPY app/src ./src
COPY entrypoint.sh ./entrypoint.sh

# Unprivileged user provided by the oven/bun image (uid/gid 1000).
USER bun

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["bun", "health-check.js"]

# entrypoint.sh only `exec`s the server: no migrations, no seeding, no installs.
# One-off jobs override the command, e.g. ["bun", "src/db/migrate.ts"].
CMD ["sh", "./entrypoint.sh"]
