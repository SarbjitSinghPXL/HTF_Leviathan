# Deploying HTF Leviathan to K3s

Target: the Hetzner CX33 `k8s-control-01` (public IP `178.105.83.76`), running a single-node K3s with its bundled Traefik v3 and cert-manager. The ClusterIssuers `letsencrypt-staging` and `letsencrypt-production` already exist there.

All commands assume Ubuntu 24.04 and a working `kubectl` that points at this cluster. On the server, `sudo kubectl` uses `/etc/rancher/k3s/k3s.yaml`; elsewhere, set `KUBECONFIG`.

**Before every command, check you are on the right cluster:** `kubectl config current-context && kubectl get nodes`.

Background and design decisions are in [kubernetes-migration.md](kubernetes-migration.md).

---

## 0. Decisions and inputs you need

| Item | Where it goes |
|---|---|
| Public hostname (for example `leviathan.<your-domain>`) | `deploy/k8s/overlays/production/site-config.yaml` → `hostname` |
| DNS `A` record from that hostname to `178.105.83.76` | Your DNS provider. Change only this one record |
| GHCR image visibility (public, or private with a pull secret) | Step 1 |
| OpenAI API key, ideally from a dedicated project with a monthly budget limit | Step 4 |

## 1. Build and publish images

### With GitHub Actions (recommended)

`.github/workflows/images.yml` builds both images and pushes them to GHCR using the workflow's own `GITHUB_TOKEN`:

- every push to `main` produces `sha-<commit>`;
- every tag `vX.Y.Z` produces `vX.Y.Z`.

It never deploys.

1. Make sure Actions are enabled for the repository. Under **Settings → Actions → General → Workflow permissions**, allow "Read and write permissions", or rely on the workflow's `packages: write` permission.
2. Push to `main`, or create a release tag:
   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   ```
3. The workflow summary lists the tags and the image digest. The images are:
   - `ghcr.io/teopxl/htf-leviathan-api`
   - `ghcr.io/teopxl/htf-leviathan-frontend`
4. New GHCR packages are **private**. Either:
   - make them public: on GitHub, go to **Packages → package → Package settings → Change visibility**; or
   - keep them private and create a pull secret (step 4b).

### Manually from a workstation

```bash
# A classic PAT with write:packages; type it at the prompt, don't paste it into files or chat.
read -rsp "GHCR token: " CR_PAT; echo
echo "$CR_PAT" | docker login ghcr.io -u <github-user> --password-stdin; unset CR_PAT

TAG=sha-$(git rev-parse --short HEAD)
docker buildx build --platform linux/amd64 -t ghcr.io/teopxl/htf-leviathan-api:$TAG      --push ./api
docker buildx build --platform linux/amd64 -t ghcr.io/teopxl/htf-leviathan-frontend:$TAG --push ./frontend
```

## 2. Pin the release in the overlay

Edit `deploy/k8s/overlays/production/images/kustomization.yaml` and set `newTag` for both images (for example `sha-1a2b3c4` or `v1.0.0`). For full immutability, add a digest:

```yaml
  - name: htf-leviathan-api
    newName: ghcr.io/teopxl/htf-leviathan-api
    digest: sha256:<digest from the workflow summary>
```

Never use `latest`. The placeholder `set-release-tag` makes pods fail with `ImagePullBackOff` on purpose until you set a real tag.

## 3. Set hostname and issuer

In `deploy/k8s/overlays/production/site-config.yaml`:

```yaml
  hostname: leviathan.example.org   # your real hostname
  clusterIssuer: letsencrypt-staging # keep staging for the first issuance
```

Review what will be applied:

```bash
kubectl kustomize deploy/k8s/overlays/production | less
```

## 4. Namespace and Secrets (once)

```bash
kubectl apply -f deploy/k8s/namespace.yaml     # deliberately separate from the kustomization
```

### 4a. Application secrets

Generate the values on the server and never print them. Each value goes into a file with `0600` permissions, and the files are shredded afterwards.

```bash
umask 077; d=$(mktemp -d)
printf htf > "$d/database"; printf htf > "$d/username"
openssl rand -hex 24 | tr -d '\n' > "$d/root-password"
openssl rand -hex 24 | tr -d '\n' > "$d/password"
kubectl -n htf-leviathan create secret generic htf-db \
  --from-file=database="$d/database" --from-file=username="$d/username" \
  --from-file=root-password="$d/root-password" --from-file=password="$d/password"

read -rsp "OpenAI API key: " k; echo; printf '%s' "$k" > "$d/openai-api-key"; unset k
kubectl -n htf-leviathan create secret generic htf-api --from-file=openai-api-key="$d/openai-api-key"

shred -u "$d"/*; rmdir "$d"
kubectl -n htf-leviathan describe secret htf-db htf-api    # shows key names and sizes only
```

Notes:

- If you're restoring an existing database ([database-backup-restore.md](database-backup-restore.md#migrating-the-existing-docker-compose-data)), use **that** database's name, user and password instead of generating new ones.
- MariaDB applies `root-password` and `password` **only when it first initialises an empty volume**. Changing the Secret later doesn't change the database password; see [Key rotation](#key-rotation).
- Chat is optional. Without the `htf-api` Secret the app runs and chat answers 503 "disabled".

### 4b. Only for private GHCR packages

```bash
read -rsp "GHCR read token (read:packages): " t; echo
kubectl -n htf-leviathan create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=<github-user> --docker-password="$t"; unset t
kubectl -n htf-leviathan patch serviceaccount default -p '{"imagePullSecrets":[{"name":"ghcr-pull"}]}'
```

## 5. Deploy

```bash
kubectl diff  -k deploy/k8s/overlays/production            # preview changes
kubectl apply -k deploy/k8s/overlays/production --dry-run=server
kubectl apply -k deploy/k8s/overlays/production

kubectl -n htf-leviathan rollout status statefulset/mariadb --timeout=5m
```

Protect the database volume from accidental PVC deletion. K3s `local-path` defaults to `Delete`:

```bash
PV=$(kubectl -n htf-leviathan get pvc data-mariadb-0 -o jsonpath='{.spec.volumeName}')
kubectl patch pv "$PV" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl get pv "$PV"     # RECLAIM POLICY: Retain
```

## 6. Initialise the database (explicit, once)

For an **empty** database:

```bash
kubectl apply -k deploy/k8s/overlays/production/jobs     # creates htf-db-migrate and htf-db-seed
kubectl -n htf-leviathan wait --for=condition=complete job/htf-db-migrate --timeout=5m
kubectl -n htf-leviathan wait --for=condition=complete job/htf-db-seed --timeout=10m
kubectl -n htf-leviathan logs job/htf-db-migrate
kubectl -n htf-leviathan logs job/htf-db-seed
```

- The seed Job may show one failed pod ("Table 'ships' is missing") if it starts before the migration finishes. It retries on its own.
- Both jobs are safe to re-run; they only apply what is missing. To run them again, delete the finished Jobs first:
  ```bash
  kubectl -n htf-leviathan delete job htf-db-migrate htf-db-seed
  ```
- To **move the existing Docker Compose data** instead, follow [database-backup-restore.md](database-backup-restore.md#migrating-the-existing-docker-compose-data).

## 7. Verify

```bash
kubectl -n htf-leviathan get pods,svc,ingress,pvc
kubectl -n htf-leviathan rollout status deployment/api
kubectl -n htf-leviathan rollout status deployment/frontend
kubectl -n htf-leviathan logs deployment/api --tail=50
kubectl -n htf-leviathan logs statefulset/mariadb --tail=50
kubectl -n htf-leviathan get events --sort-by=.lastTimestamp | tail -20
kubectl top pods -n htf-leviathan
```

## 8. Test routing before changing DNS

`--resolve` sends the real hostname to the server's IP without DNS. Until a certificate exists, Traefik serves its default certificate, hence `-k`.

```bash
H=leviathan.example.org; IP=178.105.83.76
curl -sI  --resolve $H:80:$IP  http://$H/ | head -3                  # 301 → https://$H/
curl -sk  --resolve $H:443:$IP https://$H/ -o /dev/null -w '%{http_code}\n'           # 200
curl -sk  --resolve $H:443:$IP https://$H/home -o /dev/null -w '%{http_code}\n'       # 200 (SPA fallback)
curl -sk  --resolve $H:443:$IP https://$H/api/v1/status                               # {"status":"healthy"}
curl -sk  --resolve $H:443:$IP https://$H/api/v1/voyages-geo | head -c 200; echo
curl -sk  --resolve $H:443:$IP https://$H/api/swagger -o /dev/null -w '%{http_code}\n' # 403
curl -sk  --resolve $H:443:$IP https://$H/api/metrics -o /dev/null -w '%{http_code}\n' # 403
```

To test in a browser, temporarily add `178.105.83.76 leviathan.example.org` to your workstation's `/etc/hosts` and accept the certificate warning.

## 9. DNS and TLS

1. Create the DNS `A` record from the hostname to `178.105.83.76`. Don't touch other records.
2. Wait until it resolves everywhere, then confirm HTTP-01 can reach the cluster:
   ```bash
   dig +short leviathan.example.org      # must print 178.105.83.76
   ```
3. **Staging certificate first** (the issuer is already `letsencrypt-staging`):
   ```bash
   kubectl -n htf-leviathan get certificate,certificaterequest,order,challenge
   kubectl -n htf-leviathan describe certificate htf-leviathan-tls   # wait for Ready=True
   ```
   If it stays pending, run `kubectl -n htf-leviathan describe challenge` and check the logs with `kubectl -n cert-manager logs deploy/cert-manager`. The NetworkPolicy `allow-traefik-to-acme-solver` already lets Traefik reach the solver pod.
4. **Switch to production** once staging reports `Ready=True`. Set `clusterIssuer: letsencrypt-production` in `site-config.yaml`, then:
   ```bash
   kubectl apply -k deploy/k8s/overlays/production
   kubectl -n htf-leviathan delete secret htf-leviathan-tls    # forces re-issue from the new issuer
   kubectl -n htf-leviathan get certificate -w                 # Ready=True
   curl -sI https://leviathan.example.org/ | head -5           # valid certificate, HSTS header
   ```

## 10. Enforce the Content Security Policy

nginx sends the CSP as `Content-Security-Policy-Report-Only`. Open the site, use the globe, timeline and chat, and check the browser console for CSP reports. If there are none, rename the header in `frontend/nginx/security-headers.conf` to `Content-Security-Policy`, then rebuild and redeploy the frontend.

## Updating to a new release

1. Back up first (always before migrations): [database-backup-restore.md](database-backup-restore.md#manual-backup).
2. Set the new tag or digest in `overlays/production/images/kustomization.yaml`.
3. If the release adds files under `api/app/drizzle/`, run the migrate job **before** rolling out the API:
   ```bash
   kubectl -n htf-leviathan delete job htf-db-migrate --ignore-not-found
   kubectl apply -k deploy/k8s/overlays/production/jobs
   kubectl -n htf-leviathan wait --for=condition=complete job/htf-db-migrate --timeout=5m
   ```
   The seed job does nothing if all seed files are already applied.
4. Roll out:
   ```bash
   kubectl apply -k deploy/k8s/overlays/production
   kubectl -n htf-leviathan rollout status deployment/api
   ```

## Rolling back

```bash
kubectl -n htf-leviathan rollout history deployment/api
kubectl -n htf-leviathan rollout undo deployment/api                 # previous ReplicaSet
kubectl -n htf-leviathan rollout undo deployment/frontend
```

Then also put the previous tag back in the overlay; otherwise the next `apply -k` rolls forward again.

Migrations are forward-only. If a migration must be undone, restore the backup taken before it ([database-backup-restore.md](database-backup-restore.md#restore)).

## Operations

```bash
# Logs / restart
kubectl -n htf-leviathan logs -f deployment/api
kubectl -n htf-leviathan rollout restart deployment/api

# Turn chat off immediately (cost emergency), then back on
kubectl -n htf-leviathan set env deployment/api CHAT_ENABLED=false
kubectl -n htf-leviathan set env deployment/api CHAT_ENABLED-

# Swagger (stays blocked at the Ingress; reachable only through the tunnel)
kubectl -n htf-leviathan set env deployment/api SWAGGER_ENABLED=true
kubectl -n htf-leviathan port-forward svc/api 3000:3000     # http://localhost:3000/swagger
kubectl -n htf-leviathan set env deployment/api SWAGGER_ENABLED-

# Database shell (no public port; credentials come from inside the pod's environment)
kubectl -n htf-leviathan exec -it mariadb-0 -- bash -c 'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"'

# Migration / seed status
kubectl -n htf-leviathan exec deploy/api -- bun src/db/migrate.ts --status
kubectl -n htf-leviathan exec deploy/api -- bun src/db/seed.ts --status
```

### phpMyAdmin (disabled by default)

phpMyAdmin is not deployed in Kubernetes: it runs as root, which the namespace's restricted policy forbids, and it shouldn't be public. When you need it, tunnel to MariaDB and run phpMyAdmin on your workstation:

```bash
kubectl -n htf-leviathan port-forward svc/mariadb 3306:3306
docker run --rm -p 127.0.0.1:8888:80 --add-host=host.docker.internal:host-gateway \
  -e PMA_HOST=host.docker.internal -e PMA_PORT=3306 phpmyadmin:5.2      # http://127.0.0.1:8888
```

## Key rotation

**OpenAI key.** Create a new key in OpenAI, then:

```bash
read -rsp "New OpenAI API key: " k; echo
kubectl -n htf-leviathan create secret generic htf-api --from-file=openai-api-key=<(printf '%s' "$k") \
  --dry-run=client -o yaml | kubectl apply -f -; unset k
kubectl -n htf-leviathan rollout restart deployment/api
```

Then revoke the old key in OpenAI.

**Database application password.** Change it in MariaDB first, then in the Secret, then restart the clients. This was tested on a local K3s. The API reports `damaged` for the few seconds between the `ALTER USER` and its restart.

```bash
NEW=$(openssl rand -hex 24)
kubectl -n htf-leviathan exec mariadb-0 -- env NEWPW="$NEW" bash -c \
  'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -e "ALTER USER \`$MARIADB_USER\`@\`%\` IDENTIFIED BY \"$NEWPW\""'
kubectl -n htf-leviathan patch secret htf-db --type merge -p "{\"stringData\":{\"password\":\"$NEW\"}}"; unset NEW
kubectl -n htf-leviathan rollout restart statefulset/mariadb deployment/api
```

Restarting MariaDB keeps its environment consistent with the Secret. The backup CronJob and the DB jobs read the Secret when they start.

**Root password.** Same pattern, with `ALTER USER 'root'@'%'` and `'root'@'localhost'`, and the `root-password` key.

## Optional: preserve client IPs (proposed, not applied)

By default, K3s' ServiceLB can hide client IPs behind the node IP. In that case, the per-IP chat limit and Traefik's `api-ratelimit` treat all visitors as one client. The global and daily chat caps still protect cost.

To preserve real client IPs, you would change the **system-managed** Traefik service. This affects every site served by this Traefik, so decide deliberately:

```yaml
# /var/lib/rancher/k3s/server/manifests/traefik-config.yaml  (on the server)
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    service:
      spec:
        externalTrafficPolicy: Local
```

This has not been applied.

## Removing the app safely

`kubectl delete -k deploy/k8s/overlays/production` removes the workloads. By design, it does **not** remove the namespace or the database PVC `data-mariadb-0`.

It **does** delete the backup PVC `mariadb-backups`, which is part of the kustomization. Copy the backups off the node first.

Deleting the namespace deletes the PVCs, and with reclaim policy `Delete`, the data too. Back up first.
