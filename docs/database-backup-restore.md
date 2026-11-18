# MariaDB backup and restore

## Principles

- **Persistent storage is not a backup.** The database lives on a K3s `local-path` volume, a directory on the server's single disk.
  - Pod restarts and redeploys keep it (verified).
  - A disk failure, a deleted server, or a deleted PVC or namespace loses it.
- **Back up to somewhere other than the server.** Follow the 3-2-1 rule: 3 copies, 2 media, 1 off-site.
- Most of the current data is the historical seed set, which can be rebuilt from `api/app/src/assets/*.sql`. Anything added later cannot. Treat the database as valuable.
- **Always take a backup before running migrations or restores.**

## What is in place

| Mechanism | Protects against | Doesn't protect against |
|---|---|---|
| `local-path` PVC with reclaim policy patched to `Retain` | Pod or node restarts, redeploys, accidental PVC deletion | Disk or server loss |
| CronJob `mariadb-backup` (`deploy/k8s/components/backup`): a nightly `mariadb-dump` at 02:30, gzipped, kept 14 days on PVC `mariadb-backups` | Bad migrations, accidental deletes, corruption | Disk or server loss (same disk) |
| **Off-site copy (you must set this up)**: copy the dumps off the server | Server loss | — |

How the CronJob behaves:

- It waits for database connectivity first.
- It uses `--single-transaction`, so there's no table locking.
- It **fails** (and doesn't write a file) if the dump is incomplete. This was verified with a forced failure.
- The alerts `HTFBackupFailed` and `HTFBackupMissing` ([monitoring.md](monitoring.md)) watch it.

## Manual backup

Stream a consistent dump straight to the machine you run `kubectl` on. Nothing is written in the cluster, and the password stays inside the pod.

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
kubectl -n htf-leviathan exec mariadb-0 -- bash -c \
  'mariadb-dump -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" --single-transaction --quick --routines --triggers --events "$MARIADB_DATABASE"' \
  | gzip > htf-$TS.sql.gz
gunzip -c htf-$TS.sql.gz | tail -n 1      # must print "-- Dump completed on ..."
```

Start a CronJob run now (for example, right before a migration):

```bash
kubectl -n htf-leviathan create job backup-$(date +%s) --from=cronjob/mariadb-backup
kubectl -n htf-leviathan logs -f job/<name>
```

## List and copy the nightly dumps off the server

```bash
# Temporary pod that mounts the backup PVC read-only
kubectl -n htf-leviathan apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: backup-reader }
spec:
  securityContext: { runAsNonRoot: true, runAsUser: 999, runAsGroup: 999, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: r
      image: mariadb:11.8.9
      command: ["sleep", "3600"]
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
      volumeMounts: [{ name: b, mountPath: /backups, readOnly: true }]
  volumes: [{ name: b, persistentVolumeClaim: { claimName: mariadb-backups, readOnly: true } }]
EOF
kubectl -n htf-leviathan wait --for=condition=Ready pod/backup-reader
kubectl -n htf-leviathan exec backup-reader -- ls -lh /backups
kubectl -n htf-leviathan exec backup-reader -- cat /backups/htf-<timestamp>.sql.gz > htf-<timestamp>.sql.gz
kubectl -n htf-leviathan delete pod backup-reader
```

For an automated off-site copy, run a nightly job on another machine (your workstation, or a Hetzner Storage Box via `rsync`/`restic`) using the "Manual backup" command above. Store those copies encrypted, because they contain all data.

## Restore

> Restoring **replaces** the current data. This is a deliberate, destructive operation: take a fresh backup first, and double-check the target.

```bash
NS=htf-leviathan
# 1. Safety backup of the current state (see "Manual backup").
# 2. Stop writers.
kubectl -n $NS scale deployment/api --replicas=0
# 3. Recreate the database empty (root), then load the dump as the app user.
kubectl -n $NS exec mariadb-0 -- bash -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -e "DROP DATABASE \`$MARIADB_DATABASE\`; CREATE DATABASE \`$MARIADB_DATABASE\`; GRANT ALL ON \`$MARIADB_DATABASE\`.* TO \`$MARIADB_USER\`@\`%\`;"'
gunzip -c htf-<timestamp>.sql.gz | kubectl -n $NS exec -i mariadb-0 -- bash -c 'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"'
# 4. Bring the schema up to date (no-op if the dump is current), then start the API.
kubectl -n $NS scale deployment/api --replicas=1
kubectl -n $NS rollout status deployment/api
kubectl -n $NS exec deploy/api -- bun src/db/migrate.ts --status
kubectl -n $NS exec deploy/api -- bun src/db/seed.ts --status
```

Dumps made with the commands above don't contain `CREATE DATABASE`/`USE`, so they restore into whatever database you pipe them to. The CronJob's dumps were made with `--databases`, so they do contain them. Strip those lines when restoring into a different name:

```bash
gunzip -c file.sql.gz | sed -E '/^(CREATE DATABASE|USE )/d'
```

**Restore drill (non-destructive).** Restore into a scratch database (`CREATE DATABASE restore_test`), compare row counts, then `DROP DATABASE restore_test`. This was tested on a local K3s: 5 voyages, 923 events and 2 migration records restored correctly. Do this every few months.

## Migrating the existing Docker Compose data

The old Compose stack created its tables with `drizzle-kit push`, so it has no migration journal. Its startup script also seeded the data, so it has no seed history. The new migrate and seed scripts detect this and **refuse to change anything** until you explicitly adopt the data. This whole procedure was rehearsed locally: 5 voyages and 923 events were kept, with no duplicates.

1. **Dump from Compose** (on the machine running it). It uses the credentials inside the container:
   ```bash
   docker compose exec -T db-htf sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --quick --routines --triggers --events "$MARIADB_DATABASE"' \
     | gzip > htf-compose.sql.gz
   gunzip -c htf-compose.sql.gz | tail -n 1     # "-- Dump completed on ..."
   ```
2. Copy the file to where you run `kubectl` (for example `scp`). Keep it private; it contains all data.
3. Deploy as in [deployment.md](deployment.md) steps 1–5, but **skip step 6** (the init jobs).
4. **Restore** into the empty Kubernetes database:
   ```bash
   gunzip -c htf-compose.sql.gz | kubectl -n htf-leviathan exec -i mariadb-0 -- bash -c 'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"'
   ```
5. **Adopt** the schema and data. These commands run inside the running API pod, which has the right credentials and network access:
   ```bash
   kubectl -n htf-leviathan exec deploy/api -- env MIGRATE_BASELINE_EXISTING=true bun src/db/migrate.ts
   kubectl -n htf-leviathan exec deploy/api -- env SEED_ADOPT_EXISTING=true bun src/db/seed.ts
   ```
   - `MIGRATE_BASELINE_EXISTING` records `0000_init` as applied (the tables already exist) and then applies `0001_seed_history`.
   - `SEED_ADOPT_EXISTING` records all five seed files as imported without importing them again.
   - **Only use these flags for this one-time adoption.**
6. Verify:
   ```bash
   kubectl -n htf-leviathan exec deploy/api -- bun src/db/migrate.ts --status   # applied: 2, pending: 0
   kubectl -n htf-leviathan exec deploy/api -- bun src/db/seed.ts --status      # all "applied"
   ```

The MariaDB version can differ between Compose (previously `latest`) and Kubernetes (`11.8.9`), because this is a logical (SQL) dump, not a copy of the data directory.

**Local Compose volumes** created by the old setup are handled the same way. Run this once:

```bash
MIGRATE_BASELINE_EXISTING=true SEED_ADOPT_EXISTING=true docker compose up db-init-htf
```

## Where the data physically lives

```bash
kubectl get pv $(kubectl -n htf-leviathan get pvc data-mariadb-0 -o jsonpath='{.spec.volumeName}') \
  -o jsonpath='{.spec.hostPath.path}{.spec.local.path}{"\n"}'
# typically /var/lib/rancher/k3s/storage/pvc-<uid>_htf-leviathan_data-mariadb-0 on k8s-control-01
```

Never copy these files while MariaDB is running; use `mariadb-dump`. If the server dies, these files go with it.
