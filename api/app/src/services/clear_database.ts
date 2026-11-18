// DESTRUCTIVE local-development tool: drops ALL tables in the configured database.
// It is never run automatically, is excluded from the API container image
// (api/.dockerignore), and refuses to run unless you confirm the exact database name:
//
//   CONFIRM_DROP_ALL_TABLES=<database name> bun run src/services/clear_database.ts
//
// Take a backup first (docs/database-backup-restore.md).
import mysql from "mysql2/promise";
import { setupDatabase } from "../db/connect";

async function clearDatabase() {
    const db = await setupDatabase();

    const [[{ dbName }]] = (await db.execute(`SELECT DATABASE() AS dbName`)) as any;
    if (!dbName || process.env.CONFIRM_DROP_ALL_TABLES !== dbName) {
        console.error(
            `Refusing to drop tables. Set CONFIRM_DROP_ALL_TABLES=${dbName ?? "<database>"} to confirm.`,
        );
        await (db.$client as mysql.Pool).end();
        process.exit(1);
    }

    // Get all table names
    const result = await db.execute(`
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE();
  `);

    // result[0] is the rows array
    const tables = (result[0] as unknown) as { TABLE_NAME: string }[];

    if (tables.length === 0) {
        console.log("No tables found to drop.");
        await (db.$client as mysql.Pool).end();
        return;
    }

    await db.execute(`SET FOREIGN_KEY_CHECKS = 0;`);

    for (const row of tables) {
        const tableName = row.TABLE_NAME;
        console.log(`Dropping table: ${tableName}`);
        await db.execute(`DROP TABLE IF EXISTS \`${tableName}\`;`);
    }

    await db.execute(`SET FOREIGN_KEY_CHECKS = 1;`);

    console.log("✅ All tables dropped.");
    await (db.$client as mysql.Pool).end();
}

clearDatabase().catch((e) => {
    console.error("Failed to clear database:", e);
    process.exit(1);
});
