import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

interface MigrationRecord {
  name: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(directory: string): Promise<MigrationRecord[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations: MigrationRecord[] = [];

  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".sql")).sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = await readFile(path.join(directory, entry.name), "utf8");
    migrations.push({
      name: entry.name,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }

  return migrations;
}

async function applyMigrations(databasePath: string, directory: string): Promise<void> {
  const migrations = await loadMigrations(directory);
  let existed = false;
  try {
    existed = (await stat(databasePath)).size > 0;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const database = new Database(databasePath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const appliedRows = database
      .prepare("SELECT name, checksum FROM schema_migrations")
      .all() as Array<{ name: string; checksum: string }>;
    const applied = new Map(appliedRows.map((row) => [row.name, row.checksum]));
    const knownNames = new Set(migrations.map((migration) => migration.name));
    const unknown = appliedRows.find((row) => !knownNames.has(row.name));
    if (unknown) throw new Error(`Unknown database migration: ${unknown.name}.`);

    for (const migration of migrations) {
      const checksum = applied.get(migration.name);
      if (checksum && checksum !== migration.checksum) {
        throw new Error(`Database migration checksum mismatch: ${migration.name}.`);
      }
    }

    const pending = migrations.filter((migration) => !applied.has(migration.name));
    if (pending.length === 0) return;
    if (existed) {
      await database.backup(`${databasePath}.pre-migration-${Date.now()}.bak`);
    }

    const applyOne = database.transaction((migration: MigrationRecord) => {
      database.exec(migration.sql);
      database.prepare(
        "INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
      ).run(migration.name, migration.checksum, new Date().toISOString());
    });

    for (const migration of pending) applyOne(migration);
  } finally {
    database.close();
  }
}

export async function openDatabase(
  databasePath: string,
  migrationsDirectory: string,
): Promise<Database.Database> {
  await mkdir(path.dirname(databasePath), { recursive: true });
  await applyMigrations(databasePath, migrationsDirectory);

  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  return database;
}

export function newId(): string {
  return randomUUID();
}
