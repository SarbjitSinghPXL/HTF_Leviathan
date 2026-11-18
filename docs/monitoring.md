# Monitoring

A lightweight Prometheus and Grafana setup (kube-prometheus-stack) for the single-node CX33 (4 vCPU, 8 GB RAM). Nothing in it is publicly exposed; access is through `kubectl port-forward`. **It isn't installed yet; installing it needs your approval.**

## What gets monitored

| Area | Source |
|---|---|
| Node CPU, RAM, disk, network | node-exporter |
| Pods, restarts, deployment/StatefulSet readiness, Jobs and CronJobs | kube-state-metrics |
| Container CPU and memory | kubelet / cAdvisor |
| API request rate, status codes, latency per route, captain chat outcomes | API `/metrics` (`prom-client`) via the `ServiceMonitor` |
| Frontend and API traffic at the edge (requests, codes, latency per service) | K3s Traefik metrics (port `metrics`/9100) via the `PodMonitor` |
| MariaDB health | StatefulSet readiness, which uses `healthcheck.sh --connect --innodb_initialized`, and the `HTFMariaDBNotReady` alert |
| Backups | `HTFBackupFailed` and `HTFBackupMissing` (no success in 26 h) |

Files:

- `deploy/monitoring/kube-prometheus-stack-values.yaml`: conservative Helm values. Alertmanager is off, and the K3s-embedded control-plane components aren't scraped.
- `deploy/monitoring/htf-leviathan-monitoring.yaml`: ServiceMonitor (API), PodMonitor (Traefik) and PrometheusRule (alerts).
- `deploy/monitoring/htf-leviathan-dashboard.yaml`: "HTF Leviathan" Grafana dashboard.

## Resource budget

| Component | Request | Limit |
|---|---|---|
| Prometheus (7 days / 6 GB retention, 30 s scrape, 8 Gi PVC) | 100m / 400Mi | 1Gi |
| Grafana (+ sidecar, 1 Gi PVC) | 25m / 144Mi | 352Mi |
| Prometheus operator (+ config reloader) | 30m / 96Mi | 256Mi |
| kube-state-metrics | 10m / 48Mi | 128Mi |
| node-exporter | 10m / 24Mi | 64Mi |
| **Total** | **~175m / ~0.7 GiB** | **~1.8 GiB** |

Together with the app (about 1.6 GiB of limits, about 0.15 GiB measured idle), this leaves plenty of headroom on 8 GB for the other sites. Check real usage after installing (see Verify).

## Install (needs approval)

On the server, or wherever `kubectl` and `helm` point at the cluster:

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm search repo prometheus-community/kube-prometheus-stack --versions | head -5   # choose and pin a version

kubectl create namespace monitoring      # the name matters: the app's NetworkPolicy allows scrapes from "monitoring"

# Grafana admin credentials, generated on the server and never printed or committed
umask 077; d=$(mktemp -d); printf admin > "$d/u"; openssl rand -hex 20 | tr -d '\n' > "$d/p"
kubectl -n monitoring create secret generic grafana-admin --from-file=admin-user="$d/u" --from-file=admin-password="$d/p"
shred -u "$d"/*; rmdir "$d"

helm upgrade --install kps prometheus-community/kube-prometheus-stack \
  --namespace monitoring --version <PINNED_VERSION> \
  -f deploy/monitoring/kube-prometheus-stack-values.yaml --wait --timeout 10m

kubectl apply -f deploy/monitoring/htf-leviathan-monitoring.yaml
kubectl apply -f deploy/monitoring/htf-leviathan-dashboard.yaml
```

## Access (port-forward only)

```bash
# Grafana → http://localhost:3001  (user "admin")
# Prints the password to your own terminal only; don't paste it into tickets, chat or logs.
kubectl -n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d; echo
kubectl -n monitoring port-forward svc/kps-grafana 3001:80

# Prometheus → http://localhost:9090  (Status → Targets, Alerts)
kubectl -n monitoring port-forward svc/kps-prometheus 9090:9090
```

From a workstation, either run `kubectl` there with the cluster's kubeconfig, or tunnel over SSH:

```bash
ssh -L 3001:localhost:3001 <user>@178.105.83.76
# then run the port-forward on the server
```

Don't create an Ingress for Grafana or Prometheus. If public access is needed later, put them behind authentication (for example, a Traefik ForwardAuth middleware) and TLS.

## Verify

```bash
kubectl -n monitoring get pods
kubectl top pods -n monitoring        # K3s ships metrics-server
kubectl top node
```

In Prometheus, under **Status → Targets**, these should be `UP`:

- `serviceMonitor/htf-leviathan/htf-leviathan-api`
- `podMonitor/kube-system/traefik`
- node-exporter, kube-state-metrics, kubelet and apiserver

Useful queries:

```promql
sum by (route, status) (rate(http_requests_total{namespace="htf-leviathan"}[5m]))
histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{namespace="htf-leviathan"}[5m])))
sum by (outcome) (increase(htf_chat_requests_total{namespace="htf-leviathan"}[24h]))
sum by (service, code) (rate(traefik_service_requests_total{service=~"htf-leviathan.*"}[5m]))
kube_statefulset_status_replicas_ready{namespace="htf-leviathan"}
```

If Prometheus memory approaches its limit, reduce `retention` / `retentionSize`, or raise `scrapeInterval` to 60s.

## Alerts

These are defined in `htf-leviathan-monitoring.yaml`:

- `HTFApiUnavailable`
- `HTFFrontendUnavailable`
- `HTFMariaDBNotReady`
- `HTFApiScrapeFailing`
- `HTFPodRestarting`
- `HTFApiHighErrorRate` (more than 5% 5xx, excluding chat)
- `HTFApiHighLatency` (p95 above 1 s, excluding chat)
- `HTFChatErrors`
- `HTFChatDailyLimitReached`
- `HTFBackupFailed`
- `HTFBackupMissing`

kube-prometheus-stack also adds the default node and Kubernetes rules, including disk filling up.

With Alertmanager disabled, alerts are only visible in Prometheus and Grafana. To get notifications, set `alertmanager.enabled: true` and add a receiver (email, Slack and so on) in the values file. Keep its credentials in a Secret.

## What was and wasn't validated

What was validated, without Helm, on a local K3s v1.33 with its bundled Traefik:

- All three monitoring YAML files parse.
- The dashboard JSON is valid (11 panels).
- K3s Traefik exposes metrics on the container port named `metrics` (9100) and serves `traefik_service_requests_total`.
- The API's `/metrics` is reachable from a pod in the `monitoring` namespace and blocked from other namespaces.

What wasn't validated: installing the kube-prometheus-stack chart itself. Downloading Helm wasn't permitted in the preparation environment. Do the install with a pinned chart version, then check targets and memory as described above.

## Uninstall

```bash
kubectl delete -f deploy/monitoring/htf-leviathan-dashboard.yaml -f deploy/monitoring/htf-leviathan-monitoring.yaml
helm -n monitoring uninstall kps
kubectl delete namespace monitoring     # also deletes Prometheus/Grafana PVCs (metrics history)
```
