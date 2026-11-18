import { describe, expect, test } from "bun:test"
import { ChatRateLimiter, clientIp } from "./rateLimit"

describe("ChatRateLimiter", () => {
    const t0 = Date.parse("2026-01-01T12:00:00Z")

    test("limits per IP within a minute and resets afterwards", () => {
        const limiter = new ChatRateLimiter(2, 100, 1000)
        expect(limiter.check("a", t0).ok).toBe(true)
        expect(limiter.check("a", t0 + 1).ok).toBe(true)
        const blocked = limiter.check("a", t0 + 2)
        expect(blocked).toMatchObject({ ok: false, reason: "ip" })
        expect(limiter.check("b", t0 + 3).ok).toBe(true) // other IPs unaffected
        expect(limiter.check("a", t0 + 60_000).ok).toBe(true)
    })

    test("enforces a global per-minute limit", () => {
        const limiter = new ChatRateLimiter(100, 2, 1000)
        limiter.check("a", t0)
        limiter.check("b", t0)
        expect(limiter.check("c", t0)).toMatchObject({ ok: false, reason: "global" })
    })

    test("enforces a daily cap that resets at UTC midnight", () => {
        const limiter = new ChatRateLimiter(100, 100, 2)
        limiter.check("a", t0)
        limiter.check("b", t0 + 61_000)
        const blocked = limiter.check("c", t0 + 122_000)
        expect(blocked).toMatchObject({ ok: false, reason: "daily" })
        expect(limiter.check("c", Date.parse("2026-01-02T00:00:01Z")).ok).toBe(true)
    })

    test("rejected requests are not counted", () => {
        const limiter = new ChatRateLimiter(1, 100, 2)
        limiter.check("a", t0)
        limiter.check("a", t0) // rejected (ip)
        expect(limiter.check("b", t0).ok).toBe(true) // daily count is 2 only now
    })
})

describe("clientIp", () => {
    const req = (headers: Record<string, string>) => new Request("http://x/", { headers })

    test("prefers X-Real-IP, then X-Forwarded-For when proxy headers are trusted", () => {
        expect(clientIp(req({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }), null, true)).toBe("1.1.1.1")
        expect(clientIp(req({ "x-forwarded-for": "3.3.3.3, 10.0.0.1" }), null, true)).toBe("3.3.3.3")
    })

    test("ignores headers when proxy headers are not trusted", () => {
        const server = { requestIP: () => ({ address: "9.9.9.9" }) }
        expect(clientIp(req({ "x-real-ip": "1.1.1.1" }), server, false)).toBe("9.9.9.9")
    })
})
