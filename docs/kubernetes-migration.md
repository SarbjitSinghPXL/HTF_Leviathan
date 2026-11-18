# HTF Leviathan: Kubernetes migration notes

This file records what the repository audit found, what was changed and why, and the design decisions behind the Kubernetes setup.
For step-by-step operations, see:

- [deployment.md](deployment.md)
- [database-backup-restore.md](database-backup-restore.md)
- [monitoring.md](monitoring.md)

## Target architecture

```
Internet ──► K3s Traefik v3 (kube-system, :80/:443, cert-manager TLS)
              ├─ https://HOST/          → Service frontend:80 → nginx-unprivileged :8080 (static Vue build)
              ├─ https://HOST/api/*     → strip /api → Service api:3000 → Bun/Elysia
              └─ /api/swagger, /api/metrics → 403 (internal only)
                                            api ──► Service mariadb:3306 → StatefulSet mariadb (local-path PVC)
Namespace htf-leviathan: Pod Security "restricted", default-deny NetworkPolicies.
```

- **Manifests:** Kustomize, at `deploy/k8s`.
  - `base/` holds the app.
  - `overlays/production/` sets the hostname, issuer and images.
  - `jobs/` holds the explicit DB jobs.
  - `components/backup/` holds the nightly dump.
- **Local development:** Docker Compose, which still works and now uses the same images.

## Audit findings and resolutions

### Database safety (critical)

| # | Finding | Resolution |
|---|---------|------------|
| 1 | `api/entrypoint.sh` ran `bun add drizzle-kit`, **dropped every table** (`clear_database.ts`), ran `drizzle-kit push --force` and re-imported the seeds **on every container start**. Any restart wiped the data. Startup also needed network access and installed unpinned packages. | The entrypoint now only runs `exec bun src/index.ts`. The API never migrates, drops or seeds. |
| 2 | `services/insert.ts` started all five SQL files **concurrently without `await`**, so the import order was not guaranteed. Voyage inserts are not idempotent, so a second run would duplicate data. | Replaced by `src/db/seed.ts`. It runs the files in order, one transaction per file. A `seed_history` table records each imported file by checksum, and a named lock prevents parallel runs. Re-running is a no-op. If voyages already exist without seed history, it refuses to run (`SEED_ADOPT_EXISTING=true` adopts them). |
| 3 | There were no versioned migrations; the schema came only from `push --force`. | `api/app/drizzle/0000_init.sql` is identical to what `push` created; `0001_seed_history.sql` adds the seed tracking table. `src/db/migrate.ts` applies pending migrations under a lock. A legacy `push` database is detected and left untouched unless `MIGRATE_BASELINE_EXISTING=true` is set. CI fails if `schema.ts` changes without a migration. |
| 4 | `clear_database.ts` is destructive and was part of normal startup. | Kept only as a local development tool. It now requires `CONFIRM_DROP_ALL_TABLES=<db name>` and is excluded from the image by `.dockerignore`. |
| 5 | `setupDatabase()` leaked its test connection and exited immediately if MariaDB wasn't up yet. | It now releases the connection and retries (configurable). Migrate and seed retry too. |
| 6 | `test4.sql` contains a `DELETE … WHERE voyage_id = @voyage_id`. | It only deletes rows of the voyage the same file just inserted, inside that file's transaction. It is harmless and left unchanged. |

### API

| # | Finding | Resolution |
|---|---------|------------|
| 7 | SIGTERM was not handled. Bun runs as PID 1, so the signal was ignored and containers were killed after the grace period. | SIGTERM and SIGINT handlers stop the server and close the pool. Measured: `docker compose stop` now takes about 0.4 s and the process exits with code 0. |
| 8 | The chaos middleware added 300–750 ms to **every** request and logged about 6 lines per request. Its error injection never ran, because the hook was local to the plugin. | Controlled by environment variables (`CHAOS_*`): off in Kubernetes, on in Compose so local behaviour is unchanged. Debug logging is behind `CHAOS_DEBUG`. |
| 9 | Captain chat had no rate limiting, no cost cap and no timeout. A missing key sent `Bearer undefined`, errors returned HTTP 200, and the prompt template appended a stray `: ''}` to every event line. | See the chat security list below. |
| 10 | Random path colours could be invalid (fewer than 6 hex digits). | Fixed with `padStart(6, "0")`. |
| 11 | Swagger was public at `/api/swagger`. | `SWAGGER_ENABLED=false` in Kubernetes, and the Ingress also returns 403 for `/api/swagger*`. Use `kubectl port-forward` to reach it. |
| 12 | Prometheus and OpenTelemetry packages were installed but not wired up. | `prom-client` now serves `/metrics` (request count and latency by route pattern, chat outcomes, process metrics). It is blocked publicly. |
| 13 | Several dependencies were unused. | Removed `@elysiajs/cron`, `@elysiajs/opentelemetry`, three `@opentelemetry/*` packages, `axios`, `cheerio`, `elysia-prometheus-metrics`, `postgres`, `@types/pg`, `@types/cheerio` and `tsx`. `dotenv` moved to devDependencies; only `drizzle.config.ts` uses it. The versions of the remaining dependencies are unchanged. `drizzle-kit` is not imported at runtime and is not in the image. |
| 14 | There was no readiness signal tied to the database. | `/health` is liveness. The new `/ready` returns 503 when the database is unreachable. |
| 15 | No validation limits, and errors could leak internals. | Body limit is 16 KB (Bun) and 64 KB at the edge (Traefik). Chat `message` must be 1–500 characters and `:id` must be numeric. A global `onError` returns `{error}` JSON without stack traces. The OpenAI key is never logged. |

**Chat security list (finding 9):**

- Per-IP limit of 6 per minute, global limit of 30 per minute, and a daily cap of 500. All three return 429 with `Retry-After`.
- 20 s timeout on the OpenAI call.
- Returns 503 when no key is set.
- Proper status codes.
- The prompt template bug is fixed.
- Model and base URL are configurable.

### Frontend

| # | Finding | Resolution |
|---|---------|------------|
| 16 | The frontend was served by `serve -s` (installed unpinned at build time) on port 81. `health-check.js` hit `/health`, which the SPA fallback answers with `index.html` (200), so it was not a real check. | Multi-stage build with `nginx-unprivileged:1.28.2-alpine` (uid 101, port 8080), a real `/healthz`, SPA fallback, gzip and security headers. The CSP is report-only until checked in a browser. |
| 17 | The Compose Traefik `static-assets-cache` middleware set `immutable, max-age=1y` on **every** frontend response, including `index.html`. Browsers would keep stale builds after a deploy. | nginx now caches only fingerprinted `/assets/*` as immutable and serves `index.html` with `no-cache`. |
| 18 | Globe textures were loaded at runtime from `unpkg.com/three-globe/...` without a version, so the latest version was always used. | They are bundled from the locked `three-globe@2.45.0` via a Vite alias (`@globe-textures`), fingerprinted and served by the app. The UI is unchanged. |
| 19 | API base URL. | Already the relative `/api/...` path. No change needed, and no CORS is needed (same origin). |
| 20 | Fonts come from `fonts.gstatic.com`. | Unchanged; the CSP allows it. Self-hosting them is optional. |

### Infrastructure and Compose

| # | Finding | Resolution |
|---|---------|------------|
| 21 | Hidden Compose assumptions: `DB_HOST` defaults to `db-htf`; upstreams were `api-htf:3000` and `vue-htf:81`; fixed `container_name`s prevent running parallel stacks; images used `latest`; the `version:` key is obsolete. | Kubernetes sets `DB_HOST=mariadb`. Images are pinned (Bun 1.4.2, nginx 1.28.2, MariaDB 11.8.9, Traefik 3.5.6). The redundant `db/Dockerfile` (just `FROM mariadb:latest`) was removed. |
| 22 | Broken healthchecks: Traefik used `curl`, which isn't in the image, and a `/ping` router pointing at itself without ping enabled. phpMyAdmin probed `:8080` but listens on 80. | Traefik uses `traefik healthcheck --ping` with ping enabled. MariaDB uses `healthcheck.sh`. phpMyAdmin is behind the `admin` profile and bound to `127.0.0.1`. |
| 23 | The Traefik `writeTimeout` of 10 s was shorter than a slow chat response could take. Logs went to a file inside the container. | 60 s write timeout, JSON logs to stdout, access log enabled. |
| 24 | Windows checkouts with `core.autocrlf` would put CRLF into `entrypoint.sh` and break `sh` in the container. | `.gitattributes` forces LF for `*.sh`, Dockerfiles and YAML. |
| 25 | `db.env` / `jwt.env` were required. `jwt.env` (`JWT_SECRET`) is read by **no code**. | Compose needs only `db.env` (template: `.env.example`). `jwt.env` is no longer referenced. |

### JWT and the Traefik plugin

- `traefik/traefik.yml` declared `agilezebra/jwt-middleware v1.3.4`, and the Compose command loaded `antoniomika/dynamic-jwt-validation` without a version.
- **No router in `dynamic.yml` referenced either plugin**, so they protected nothing. The only effect was downloading plugin code from GitHub when Traefik started.
- `middleware/auth.ts` (cookie JWT check) exists but is not registered on any route, and the frontend has no login.
- So the application is public by design: every endpoint is anonymous.

What was done:

- The inert plugin declarations were removed from the local Traefik config.
- They were not recreated in Kubernetes. That would need a change to the K3s-managed Traefik (a `HelmChartConfig` with `experimental.plugins`) and would protect nothing.
- Abuse protection for the one costly endpoint (chat) is in the application instead (finding 9), plus a coarse Traefik rate limit and a body limit.

If authentication is needed later, either:

1. register `authMiddleware` with `@elysiajs/jwt` (already a dependency) on the routes that need it, and add a login flow to the frontend; or
2. put a Traefik `ForwardAuth` middleware (for example oauth2-proxy) in front of `/api`. That works with the stock K3s Traefik without plugins.

### Security posture in Kubernetes

- Namespace enforces the **restricted** Pod Security Standard. Every pod:
  - runs as non-root;
  - has `allowPrivilegeEscalation: false`;
  - drops all capabilities;
  - uses the `RuntimeDefault` seccomp profile;
  - has a read-only root filesystem with an `emptyDir` for `/tmp`;
  - has no service-account token.
- **NetworkPolicies** (enforced by K3s kube-router):
  - default-deny for incoming traffic;
  - Traefik may reach the frontend, the API and the ACME solver;
  - only pods labelled `htf-leviathan/db-client=true` (API, DB jobs, backup) may reach MariaDB;
  - only the `monitoring` namespace may reach the API on port 3000.
  - All of this was verified on a local K3s: an unlabelled pod and another namespace were blocked, the labelled pod and `monitoring` were allowed.
- Nothing is exposed except through the Ingress. MariaDB, Swagger, metrics, Grafana and Prometheus are ClusterIP only, or blocked.
- Secrets are created with `kubectl` from files that are never committed. Images contain no secrets (verified).

## Environment variables

| Variable | Where | Required | Notes |
|---|---|---|---|
| `MARIADB_ROOT_PASSWORD`, `MARIADB_DATABASE`, `MARIADB_USER`, `MARIADB_PASSWORD` | MariaDB | yes | K8s Secret `htf-db` (keys `root-password`, `database`, `username`, `password`) |
| `DB_HOST`, `DB_PORT` | API, jobs | yes | ConfigMap: `mariadb`, `3306` (Compose: `db-htf`) |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | API, jobs | yes | From the `htf-db` Secret. The legacy names `MYSQL_DATABASE/USER/PASSWORD` still work |
| `OPENAI_API_KEY` | API | no | Secret `htf-api` key `openai-api-key`. Without it, chat returns 503 |
| `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OPENAI_TIMEOUT_MS` | API | no | `gpt-4o-mini`, OpenAI, 20000 |
| `CHAT_ENABLED`, `CHAT_RATE_LIMIT_PER_IP_PER_MINUTE`, `CHAT_RATE_LIMIT_GLOBAL_PER_MINUTE`, `CHAT_DAILY_LIMIT` | API | no | `true`, 6, 30, 500 |
| `SWAGGER_ENABLED`, `METRICS_ENABLED` | API | no | K8s: `false`, `true` |
| `TRUST_PROXY_HEADERS`, `MAX_REQUEST_BODY_BYTES`, `SHUTDOWN_TIMEOUT_SECONDS`, `PORT` | API | no | `true`, 16384, 10 (K8s 20), 3000 |
| `DB_POOL_SIZE`, `DB_CONNECT_ATTEMPTS`, `DB_CONNECT_RETRY_MS` | API, jobs | no | 10, 10 (K8s 50), 3000 |
| `CHAOS_DELAY_ENABLED`, `CHAOS_MIN_DELAY_MS`, `CHAOS_MAX_DELAY_MS`, `CHAOS_ERRORS_ENABLED`, `CHAOS_DEBUG` | API | no | Off by default; Compose turns on the delay |
| `MIGRATE_BASELINE_EXISTING`, `SEED_ADOPT_EXISTING` | jobs only | no | One-off flags for adopting a database from the old Compose setup |

## Design decisions

- **Kustomize, not Helm.** One environment, `kubectl` already has Kustomize built in, and there's no templating to maintain. The hostname and issuer are set in one file (`overlays/production/site-config.yaml`) through `replacements`. Image tags are set in one component that both the app and the jobs use.
- **MariaDB as a StatefulSet with one replica** and a `volumeClaimTemplate` on `local-path`:
  - Exactly one writer for the data directory.
  - `persistentVolumeClaimRetentionPolicy: Retain`.
  - Probes use the image's `healthcheck.sh --connect --innodb_initialized`, which checks real availability.
  - The namespace is applied separately, so `kubectl delete -k` can never delete the PVC.
- **K3s `local-path` limitations:**
  - Data lives in a host directory on this one node (`/var/lib/rancher/k3s/storage/...`).
  - It has no replication and no snapshots, and can't move to another node.
  - Its default `reclaimPolicy` is `Delete`: deleting the PVC deletes the data. The deployment guide patches the PV to `Retain`.
  - **Persistent storage is not a backup.** A dead disk or a deleted server loses it. See [database-backup-restore.md](database-backup-restore.md).
- **Single API replica.** Chat rate limits are in memory. Rolling updates use `maxSurge: 1, maxUnavailable: 0` plus a `preStop` delay and graceful shutdown. Zero errors in 428 requests during a rolling restart on local K3s.
- **Existing K3s Traefik reused** through standard `Ingress` objects plus `traefik.io/v1alpha1` Middlewares. No second ingress controller, and no change to the system Traefik chart. One *optional* proposal (client IP preservation) is in [deployment.md](deployment.md#optional-preserve-client-ips-proposed-not-applied).
- **Database initialisation is a manual Job** (`overlays/production/jobs`): migrate, then seed. Both are idempotent and guarded, and neither drops data.

## Resource budget (requests / limits)

| Component | CPU req | Mem req | Mem limit |
|---|---|---|---|
| MariaDB | 100m | 384Mi | 1Gi |
| API | 50m | 128Mi | 512Mi |
| Frontend | 10m | 32Mi | 128Mi |
| Jobs / backup (short-lived) | 50m | 64Mi | 256Mi |
| Monitoring stack (optional) | ~200m | ~0.8Gi | ~1.9Gi |

Measured idle usage on local K3s: API 31 Mi, frontend 3 Mi, MariaDB 101 Mi.
