# syntax=docker/dockerfile:1
# HTF Leviathan frontend (Vue 3 + Vite) served as static files by unprivileged nginx.
# Build context: ./frontend   →   docker build -t htf-leviathan-frontend ./frontend

ARG BUN_VERSION=1.4.2
ARG NGINX_VERSION=1.28.2

# ── Build ─────────────────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app

# Install exactly what the lockfile specifies (cached unless deps change).
COPY app/package.json app/bun.lock ./
RUN bun install --frozen-lockfile

COPY app/ ./
RUN bun run build

# ── Runtime ───────────────────────────────────────────────────────
# Runs as uid 101 and listens on 8080 (no root, no privileged port).
FROM nginxinc/nginx-unprivileged:${NGINX_VERSION}-alpine AS runtime

USER root

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html

RUN chmod 644 /etc/nginx/conf.d/default.conf \
    /etc/nginx/snippets/security-headers.conf \
    && chmod -R a+rX /usr/share/nginx/html

USER 101

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
