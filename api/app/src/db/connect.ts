import mysql from "mysql2/promise"
import { dbConfig } from "./config"
import { drizzle } from "drizzle-orm/mysql2"

const MAX_ATTEMPTS = Number(process.env.DB_CONNECT_ATTEMPTS || 10)
const RETRY_DELAY_MS = Number(process.env.DB_CONNECT_RETRY_MS || 3000)

// Single connection with retries, for one-off jobs (migrate/seed). Retrying also covers
// the few seconds after pod start before Kubernetes NetworkPolicy rules are programmed.
export async function connectWithRetry(options: mysql.ConnectionOptions = {}) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await mysql.createConnection({ ...dbConfig, ...options })
        } catch (error) {
            if (attempt >= MAX_ATTEMPTS) throw error
            console.warn(`⏳ Database not reachable (attempt ${attempt}/${MAX_ATTEMPTS}): ${(error as Error).message}`)
            await Bun.sleep(RETRY_DELAY_MS)
        }
    }
}

export async function setupDatabase() {
    console.log(`🔄 Creating connection pool for ${dbConfig.host}:${dbConfig.port}...`)
    const poolConnection = mysql.createPool({
        ...dbConfig,
        waitForConnections: true,
        connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
        queueLimit: 0,
        enableKeepAlive: true,
    })

    // Wait for the database (it may still be starting after a node restart).
    for (let attempt = 1; ; attempt++) {
        try {
            const connection = await poolConnection.getConnection()
            connection.release()
            console.log("✅ Pool connection established successfully")
            break
        } catch (error) {
            if (attempt >= MAX_ATTEMPTS) {
                console.error("❌ Pool connection failed:", (error as Error).message)
                await poolConnection.end().catch(() => {})
                throw error
            }
            console.warn(`⏳ Database not reachable (attempt ${attempt}/${MAX_ATTEMPTS}), retrying...`)
            await Bun.sleep(RETRY_DELAY_MS)
        }
    }

    return drizzle({ client: poolConnection })
}
