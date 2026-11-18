// src/metrics.ts
// Minimal Prometheus instrumentation using prom-client (already a dependency).
import { Elysia } from "elysia"
import client from "prom-client"

export const registry = new client.Registry()

try {
    client.collectDefaultMetrics({ register: registry })
} catch (error) {
    // Some Node APIs used by default metrics may be unavailable under Bun.
    console.warn("Default process metrics unavailable:", (error as Error).message)
}

const httpRequests = new client.Counter({
    name: "http_requests_total",
    help: "HTTP requests handled by the API",
    labelNames: ["method", "route", "status"] as const,
    registers: [registry],
})

const httpDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
})

export const chatRequests = new client.Counter({
    name: "htf_chat_requests_total",
    help: "Captain chat requests by outcome",
    labelNames: ["outcome"] as const,
    registers: [registry],
})

const startTimes = new WeakMap<Request, number>()

// Fixed set of route labels keeps metric cardinality bounded, whatever paths clients send.
const ROUTES: [RegExp, string][] = [
    [/^\/health$/, "/health"],
    [/^\/ready$/, "/ready"],
    [/^\/v1\/status$/, "/v1/status"],
    [/^\/v1\/voyages-geo$/, "/v1/voyages-geo"],
    [/^\/v1\/voyages\/[^/]+\/details$/, "/v1/voyages/:id/details"],
    [/^\/v1\/voyages\/[^/]+\/chat$/, "/v1/voyages/:id/chat"],
    [/^\/swagger(\/.*)?$/, "/swagger"],
]

export function routeLabel(pathname: string): string {
    for (const [pattern, label] of ROUTES) if (pattern.test(pathname)) return label
    return "other"
}

export function metricsPlugin(enabled: boolean) {
    const app = new Elysia({ name: "metrics" })
    if (!enabled) return app

    return app
        .onRequest(({ request }) => {
            startTimes.set(request, performance.now())
        })
        .onAfterResponse({ as: "global" }, (ctx: any) => {
            const started = startTimes.get(ctx.request)
            if (started === undefined) return
            const pathname = new URL(ctx.request.url).pathname
            if (pathname === "/metrics") return
            const route = routeLabel(pathname)
            const status = String(typeof ctx.set?.status === "number" ? ctx.set.status : 200)
            const labels = { method: ctx.request.method, route, status }
            httpRequests.inc(labels)
            httpDuration.observe(labels, (performance.now() - started) / 1000)
        })
        .get("/metrics", async ({ set }) => {
            set.headers["content-type"] = registry.contentType
            return registry.metrics()
        })
}
