import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./schema.ts";

export const DB_FILEPATH = "data/main.sqlite";
export const DB_BACKUP_DIRECTORY = "data/backups";

// Create the raw sqlite connection and run migrations BEFORE building the
// drizzle instance. This ensures all tables exist before any prepared
// statements in queries.ts are compiled at module load time.
const sqlite = Database(DB_FILEPATH).defaultSafeIntegers();
const _db = drizzle(sqlite, { schema });
migrate(_db, { migrationsFolder: "data/migrations" });

export let db = _db;

export namespace Db {
	export function reload() {
		db = drizzle(Database(DB_FILEPATH).defaultSafeIntegers(), { schema });
	}

	export function printLoadMessage() {
		console.log(`Loaded ${Object.keys(db._.schema).length} tables from database: ${DB_FILEPATH}`);
	}
}
