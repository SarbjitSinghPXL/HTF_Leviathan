import { Elysia } from "elysia"
import { swagger } from "@elysiajs/swagger"
import mysql from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { sql } from "drizzle-orm"
import { generalRoutes } from "./routes/general"
import { chaosMiddleware } from "./middleware/chaos"
import { setupDatabase } from "./db/connect"
import { voyagesRoutes } from "./routes/coords"
import { metricsPlugin } from "./metrics"
import { config } from "./config"

// Drizzle database instance
let db: ReturnType<typeof drizzle>

// Initialize the database and start the server.
// NOTE: this process never migrates, drops or seeds the database.
// Schema changes and seed imports are explicit operations (see docs/deployment.md).
(async () => {
    try {
        db = await setupDatabase()

        const app = new Elysia({
            serve: { maxRequestBodySize: config.maxRequestBodyBytes },
        })
            // Consistent JSON errors without stack traces or internals.
            .onError(({ code, error, set }) => {
                if (code === "VALIDATION") {
                    set.status = 400
                    return { error: "Invalid request parameters" }
                }
                if (code === "NOT_FOUND") {
                    set.status = 404
                    return { error: "Not found" }
                }
                if (code === "PARSE") {
                    set.status = 400
                    return { error: "Malformed request body" }
                }
                console.error("Unhandled error:", error)
                set.status = 500
                return { error: "Internal server error" }
            })
            .use(metricsPlugin(config.metricsEnabled))
            .use(chaosMiddleware())
            // Liveness: the process is up and serving HTTP.
            .get("/health", () => "Healthy")
            // Readiness: the database is reachable.
            .get("/ready", async ({ set }) => {
                try {
                    await db.execute(sql`SELECT 1`)
                    return "Ready"
                } catch {
                    set.status = 503
                    return "Database unavailable"
                }
            })

        if (config.swaggerEnabled) app.use(swagger())

        voyagesRoutes(app as any, db)
        generalRoutes(app as any, db)

        const server = app.listen(config.port)

        console.log(
            `🚀 API is running at ${server.server?.hostname}:${server.server?.port} ` +
            `(swagger=${config.swaggerEnabled}, metrics=${config.metricsEnabled})`,
        )

        // Graceful shutdown. Kubernetes sends SIGTERM; Docker Compose `stop` too.
        // Bun runs as PID 1 in the container, so without these handlers the signal
        // would be ignored and the container killed only after the grace period.
        let shuttingDown = false
        const shutdown = async (signal: string) => {
            if (shuttingDown) return
            shuttingDown = true
            console.log(`🔄 ${signal} received, shutting down...`)
            const force = setTimeout(() => {
                console.error("⏱️ Shutdown timed out, forcing exit.")
                process.exit(1)
            }, config.shutdownTimeoutSeconds * 1000)
            try {
                await app.stop() // stop accepting connections, let in-flight requests finish
                await (db.$client as mysql.Pool).end()
                console.log("✅ Shutdown complete.")
                clearTimeout(force)
                process.exit(0)
            } catch (error) {
                console.error("Error during shutdown:", error)
                process.exit(1)
            }
        }
        process.on("SIGTERM", () => shutdown("SIGTERM"))
        process.on("SIGINT", () => shutdown("SIGINT"))
    } catch (error) {
        console.error("❌ Server initialization failed:", error)
        process.exit(1)
    }
})()
