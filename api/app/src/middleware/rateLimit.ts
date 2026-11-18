// src/middleware/rateLimit.ts
// In-memory limits protecting the paid OpenAI chat endpoint.
// The API runs as a single replica, so process memory is a sufficient store.
// With more replicas, the effective limits multiply; use a shared store (e.g. Redis) then.

type Window = { start: number; count: number }

export type ChatLimitResult =
    | { ok: true }
    | { ok: false; reason: "ip" | "global" | "daily"; retryAfterSeconds: number }

export class ChatRateLimiter {
    private perIp = new Map<string, Window>()
    private global: Window = { start: 0, count: 0 }
    private day = { key: "", count: 0 }

    constructor(
        private readonly perIpPerMinute: number,
        private readonly globalPerMinute: number,
        private readonly dailyLimit: number,
    ) {}

    check(ip: string, now = Date.now()): ChatLimitResult {
        const minute = 60_000
        const dayKey = new Date(now).toISOString().slice(0, 10) // UTC day

        if (this.day.key !== dayKey) this.day = { key: dayKey, count: 0 }
        if (this.dailyLimit > 0 && this.day.count >= this.dailyLimit) {
            const tomorrow = Date.parse(`${dayKey}T00:00:00Z`) + 86_400_000
            return { ok: false, reason: "daily", retryAfterSeconds: Math.ceil((tomorrow - now) / 1000) }
        }

        if (now - this.global.start >= minute) this.global = { start: now, count: 0 }
        if (this.globalPerMinute > 0 && this.global.count >= this.globalPerMinute) {
            return { ok: false, reason: "global", retryAfterSeconds: Math.ceil((this.global.start + minute - now) / 1000) }
        }

        let entry = this.perIp.get(ip)
        if (!entry || now - entry.start >= minute) {
            entry = { start: now, count: 0 }
            this.perIp.set(ip, entry)
        }
        if (this.perIpPerMinute > 0 && entry.count >= this.perIpPerMinute) {
            return { ok: false, reason: "ip", retryAfterSeconds: Math.ceil((entry.start + minute - now) / 1000) }
        }

        entry.count++
        this.global.count++
        this.day.count++
        if (this.perIp.size > 10_000) this.prune(now)
        return { ok: true }
    }

    private prune(now: number) {
        for (const [ip, entry] of this.perIp) {
            if (now - entry.start >= 60_000) this.perIp.delete(ip)
        }
    }
}

export function clientIp(request: Request, server: any, trustProxyHeaders: boolean): string {
    if (trustProxyHeaders) {
        const realIp = request.headers.get("x-real-ip")
        if (realIp) return realIp.trim()
        const forwarded = request.headers.get("x-forwarded-for")
        if (forwarded) return forwarded.split(",")[0].trim()
    }
    return server?.requestIP?.(request)?.address ?? "unknown"
}
