// src/db/migrate.ts
// Applies versioned SQL migrations from ./drizzle (generated with `bun run db:generate`).
// Run explicitly: `bun run db:migrate` locally, or the htf-db-migrate Kubernetes Job.
//
// Safety:
//   - Never drops tables. Only pending migrations are applied, in order.
//   - A database created by the old `drizzle-kit push` (tables exist but no migration
//     journal) is detected and the run aborts, unless MIGRATE_BASELINE_EXISTING=true,
//     which records 0000_init as already applied without executing it.
//   - A MariaDB named lock prevents two migration runs at the same time.
//
// Flags: --status  print applied/pending migrations and exit without changes.
import { drizzle } from "drizzle-orm/mysql2"
import { migrate } from "drizzle-orm/mysql2/migrator"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { resolve } from "path"
import { dbConfig } from "./config"
import { connectWithRetry } from "./connect"

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../drizzle")
const JOURNAL_TABLE = "__drizzle_migrations"
const APP_TABLES = ["ships", "voyages", "events"]
const LOCK_NAME = "htf_leviathan_migrate"

async function main() {
    const statusOnly = process.argv.includes("--status")
    const baselineExisting = process.env.MIGRATE_BASELINE_EXISTING === "true"
    const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })

    const connection = await connectWithRetry()
    try {
        const [lockRows] = await connection.query("SELECT GET_LOCK(?, 30) AS acquired", [LOCK_NAME])
        if ((lockRows as any[])[0]?.acquired !== 1) {
            throw new Error("Another migration is running (could not acquire lock).")
        }

        const [tableRows] = await connection.query(
            "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
        )
        const tables = new Set((tableRows as any[]).map((r) => r.name as string))
        const hasJournal = tables.has(JOURNAL_TABLE)
        const existingAppTables = APP_TABLES.filter((t) => tables.has(t))

        let appliedMillis: number[] = []
        if (hasJournal) {
            const [rows] = await connection.query(`SELECT created_at FROM \`${JOURNAL_TABLE}\``)
            appliedMillis = (rows as any[]).map((r) => Number(r.created_at))
        }
        const lastApplied = appliedMillis.length ? Math.max(...appliedMillis) : -1
        const pending = migrations.filter((m) => m.folderMillis > lastApplied)

        console.log(`Database: ${dbConfig.database} @ ${dbConfig.host}:${dbConfig.port}`)
        console.log(`Migrations in image: ${migrations.length}, applied: ${appliedMillis.length}, pending: ${hasJournal || !existingAppTables.length ? pending.length : "unknown (legacy schema)"}`)

        if (statusOnly) return

        if (!hasJournal && existingAppTables.length > 0) {
            if (existingAppTables.length !== APP_TABLES.length) {
                throw new Error(
                    `Partial legacy schema found (${existingAppTables.join(", ")}). Refusing to continue; inspect the database manually.`,
                )
            }
            if (!baselineExisting) {
                throw new Error(
                    "Existing tables found without a migration journal (database created by the old `drizzle-kit push`).\n" +
                    "Back up the database, then re-run with MIGRATE_BASELINE_EXISTING=true to mark 0000_init as applied.\n" +
                    "No changes were made.",
                )
            }
            const init = migrations[0]
            console.log(`Baselining existing schema: marking ${init.hash.slice(0, 12)}… (0000_init) as applied.`)
            await connection.query(
                `CREATE TABLE IF NOT EXISTS \`${JOURNAL_TABLE}\` (id serial primary key, hash text not null, created_at bigint)`,
            )
            await connection.query(`INSERT INTO \`${JOURNAL_TABLE}\` (hash, created_at) VALUES (?, ?)`, [init.hash, init.folderMillis])
        }

        await migrate(drizzle({ client: connection }), { migrationsFolder: MIGRATIONS_FOLDER })
        console.log("✅ Migrations are up to date.")
    } finally {
        await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]).catch(() => {})
        await connection.end()
    }
}

main().catch((error) => {
    console.error("❌ Migration failed:", error.message ?? error)
    process.exit(1)
})
