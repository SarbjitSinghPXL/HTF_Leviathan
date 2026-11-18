# HTF_Leviathan

Historical whaling and sailing voyages on an interactive 3D globe. You can replay voyages event by event and chat with an AI captain who only knows what has happened so far.

**Stack:**

- Frontend: Vue 3, Vite, Pinia, globe.gl/Three.js
- API: Bun + Elysia, Drizzle ORM, MariaDB
- Captain chat: OpenAI
- Routing: Traefik

## Local development (Docker Compose)

```bash
cp .env.example db.env        # fill in local values (db.env is git-ignored)
docker compose up --build     # http://localhost:8899
```

- The one-shot `db-init-htf` service applies migrations and imports the seed data. Both steps are idempotent, and the API never changes the schema.
- Swagger is available at `http://localhost:8899/api/swagger`.

## Database tasks (api/app)

```bash
bun run db:generate        # after editing src/db/schema.ts: create a versioned migration
bun run db:migrate         # apply pending migrations   (db:migrate:status to inspect)
bun run db:seed            # import seed files once     (db:seed:status to inspect)
bun test                   # unit tests
```

## Production (Kubernetes / K3s)

- [docs/kubernetes-migration.md](docs/kubernetes-migration.md): audit findings, design and environment variables
- [docs/deployment.md](docs/deployment.md): build, secrets, deploy, TLS, rollback, operations
- [docs/database-backup-restore.md](docs/database-backup-restore.md): backups, restore, migrating the Compose data
- [docs/monitoring.md](docs/monitoring.md): Prometheus and Grafana
