// src/config.ts
// Central place for runtime configuration read from environment variables.
// Every value has a safe default so local development works without extra setup.

function bool(name: string, fallback: boolean): boolean {
    const raw = Bun.env[name]
    if (raw === undefined || raw === "") return fallback
    return ["1", "true", "yes", "on"].includes(raw.toLowerCase())
}

function int(name: string, fallback: number): number {
    const raw = Bun.env[name]
    if (raw === undefined || raw === "") return fallback
    const value = Number.parseInt(raw, 10)
    return Number.isFinite(value) ? value : fallback
}

export const config = {
    port: int("PORT", 3000),

    // Swagger UI at /swagger. Disabled by default in Kubernetes (see deploy/k8s).
    swaggerEnabled: bool("SWAGGER_ENABLED", true),

    // Prometheus metrics at /metrics (blocked from the public internet by the Ingress).
    metricsEnabled: bool("METRICS_ENABLED", true),

    // Maximum accepted request body in bytes (the chat body is tiny).
    maxRequestBodyBytes: int("MAX_REQUEST_BODY_BYTES", 16 * 1024),

    // Use X-Real-IP / X-Forwarded-For set by Traefik to identify clients for rate limiting.
    trustProxyHeaders: bool("TRUST_PROXY_HEADERS", true),

    // Seconds to wait for in-flight requests on SIGTERM before forcing exit.
    shutdownTimeoutSeconds: int("SHUTDOWN_TIMEOUT_SECONDS", 10),

    chat: {
        enabled: bool("CHAT_ENABLED", true),
        openaiApiKey: Bun.env.OPENAI_API_KEY ?? "",
        model: Bun.env.OPENAI_MODEL || "gpt-4o-mini",
        baseUrl: (Bun.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
        timeoutMs: int("OPENAI_TIMEOUT_MS", 20_000),
        perIpPerMinute: int("CHAT_RATE_LIMIT_PER_IP_PER_MINUTE", 6),
        globalPerMinute: int("CHAT_RATE_LIMIT_GLOBAL_PER_MINUTE", 30),
        dailyLimit: int("CHAT_DAILY_LIMIT", 500),
    },

    chaos: {
        // Artificial latency/errors from the original hackathon setup. Off unless enabled.
        delayEnabled: bool("CHAOS_DELAY_ENABLED", false),
        minDelayMs: int("CHAOS_MIN_DELAY_MS", 300),
        maxDelayMs: int("CHAOS_MAX_DELAY_MS", 750),
        errorsEnabled: bool("CHAOS_ERRORS_ENABLED", false),
        debugLogging: bool("CHAOS_DEBUG", false),
    },
}
