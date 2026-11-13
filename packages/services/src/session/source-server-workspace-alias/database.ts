import { rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathExists } from "./fileSystem.js";

export type Database = InstanceType<typeof DatabaseSync>;
const require = createRequire(import.meta.url);
const { backup, DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export function hasTable(db: Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

export function hasColumn(db: Database, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  ).some((row) => row.name === column);
}

export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  return db;
}

export function rollbackQuietly(db: Database): void {
  try {
    if (db.isTransaction) db.exec("ROLLBACK");
  } catch {
    // SQLite 可能已自动回滚，或清理也遇到 IO 故障；不能用二次错误覆盖原始迁移错误。
  }
}

export async function ensureDatabaseBackup(db: Database, backupPath: string): Promise<void> {
  if (await pathExists(backupPath)) return;
  const temporaryPath = `${backupPath}.tmp`;
  await rm(temporaryPath, { force: true });
  await backup(db, temporaryPath);
  await rename(temporaryPath, backupPath);
}
