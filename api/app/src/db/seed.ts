// src/db/seed.ts
// Imports the historical voyage seed files exactly once each.
// Run explicitly: `bun run db:seed` locally, or the htf-db-seed Kubernetes Job.
// Requires migrations to have been applied first (src/db/migrate.ts).
//
// Safety:
//   - Each file runs in its own transaction together with its seed_history record,
//     so a file is either fully imported and recorded, or not at all.
//   - Files already listed in seed_history are skipped, so re-running is harmless.
//   - If voyages already exist but seed_history is empty (a database seeded by the old
//     startup script), the run aborts unless SEED_ADOPT_EXISTING=true, which records
//     all seed files as applied WITHOUT importing them.
//   - Never drops or truncates tables. (test4.sql contains a DELETE limited to rows of
//     the voyage it inserts itself, inside the same transaction.)
//
// Flags: --status  print applied/pending seed files and exit without changes.
import { createHash } from "crypto"
import { readFileSync } from "fs"
import { resolve } from "path"
import { dbConfig } from "./config"
import { connectWithRetry } from "./connect"

// Same order as the original insert.ts.
const SEED_FILES = ["test.sql", "test2.sql", "test3.sql", "big.sql", "test4.sql"]
const SEED_DIR = resolve(import.meta.dir, "../assets")
const LOCK_NAME = "htf_leviathan_seed"

async function main() {
    const statusOnly = process.argv.includes("--status")
    const adoptExisting = process.env.SEED_ADOPT_EXISTING === "true"

    const files = SEED_FILES.map((name) => {
        const sql = readFileSync(resolve(SEED_DIR, name), "utf-8")
        return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") }
    })

    const connection = await connectWithRetry({ multipleStatements: true })
    try {
        const [lockRows] = await connection.query("SELECT GET_LOCK(?, 0) AS acquired", [LOCK_NAME])
        if ((lockRows as any[])[0]?.acquired !== 1) {
            throw new Error("Another seed run is in progress (could not acquire lock).")
        }

        const [tableRows] = await connection.query(
            "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
        )
        const tables = new Set((tableRows as any[]).map((r) => r.name as string))
        for (const required of ["ships", "voyages", "events", "seed_history"]) {
            if (!tables.has(required)) {
                throw new Error(`Table '${required}' is missing. Run the migrations first (bun run db:migrate).`)
            }
        }

        const [historyRows] = await connection.query("SELECT name, checksum FROM seed_history")
        const applied = new Map((historyRows as any[]).map((r) => [r.name as string, r.checksum as string]))
        const [[{ voyageCount }]] = (await connection.query("SELECT COUNT(*) AS voyageCount FROM voyages")) as any

        for (const file of files) {
            const known = applied.get(file.name)
            const state = !known ? "pending" : known === file.checksum ? "applied" : "applied (file changed since import — not re-applied)"
            console.log(`  ${file.name.padEnd(12)} ${state}`)
        }
        console.log(`Voyages currently in database: ${voyageCount}`)

        if (statusOnly) return

        if (applied.size === 0 && Number(voyageCount) > 0) {
            if (!adoptExisting) {
                throw new Error(
                    "Voyages already exist but no seed history is recorded (seeded by the old startup script).\n" +
                    "Importing again would create duplicates. Re-run with SEED_ADOPT_EXISTING=true to record the\n" +
                    "seed files as applied without importing them. No changes were made.",
                )
            }
            for (const file of files) {
                await connection.query("INSERT IGNORE INTO seed_history (name, checksum) VALUES (?, ?)", [file.name, file.checksum])
            }
            console.log("✅ Existing data adopted: all seed files recorded as applied (nothing imported).")
            return
        }

        let imported = 0
        for (const file of files) {
            if (applied.has(file.name)) continue
            console.log(`Importing ${file.name}...`)
            await connection.beginTransaction()
            try {
                await connection.query(file.sql)
                await connection.query("INSERT INTO seed_history (name, checksum) VALUES (?, ?)", [file.name, file.checksum])
                await connection.commit()
                imported++
            } catch (error) {
                await connection.rollback()
                throw new Error(`Failed to import ${file.name} (rolled back): ${(error as Error).message}`)
            }
        }
        console.log(imported ? `✅ Imported ${imported} seed file(s).` : "✅ Nothing to import; all seed files already applied.")
    } finally {
        await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]).catch(() => {})
        await connection.end()
    }
}

main().catch((error) => {
    console.error("❌ Seed failed:", error.message ?? error)
    process.exit(1)
})
