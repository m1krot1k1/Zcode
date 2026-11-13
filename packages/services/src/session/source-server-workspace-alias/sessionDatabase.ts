import { randomUUID } from "node:crypto";
import { runSessionDatabaseIdentityMigration } from "@zcode/shared/sqlite-migrations";
import { hasColumn, hasTable, openDatabase, rollbackQuietly, type Database } from "./database.js";
import { pathExists } from "./fileSystem.js";
import { hasReachedMigrationPhase, type ActiveWorkspaceMigration } from "./types.js";

export function mergeSessionDatabase(
  sessionDb: Database | null,
  workspacePath: string,
  canonicalKey: string,
  mergedKeys: string[],
): void {
  if (!sessionDb || !hasTable(sessionDb, "session") || mergedKeys.length === 0) return;
  const placeholders = mergedKeys.map(() => "?").join(", ");
  sessionDb.exec("BEGIN IMMEDIATE");
  try {
    sessionDb
      .prepare(
        `UPDATE session SET workspace_id = ?
           WHERE workspace_id IN (${placeholders})
             AND (directory = ? OR path = ?)`,
      )
      .run(canonicalKey, ...mergedKeys, workspacePath, workspacePath);
    sessionDb.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(sessionDb);
    throw error;
  }
}

export function hasSessionDatabaseOwnedState(
  db: Database,
  workspacePath: string,
  variants: string[],
): boolean {
  for (const table of ["session", "sessions"]) {
    if (!hasTable(db, table)) continue;
    const workspaceColumn = ["workspace_id", "workspace_key", "workspace_identity"].find((column) =>
      hasColumn(db, table, column),
    );
    const pathColumns = ["directory", "path", "workspace_path"].filter((column) =>
      hasColumn(db, table, column),
    );
    const predicates: string[] = [];
    const values: string[] = [];
    if (workspaceColumn && variants.length > 0) {
      predicates.push(`${workspaceColumn} IN (${variants.map(() => "?").join(", ")})`);
      values.push(...variants);
    }
    for (const column of pathColumns) {
      predicates.push(`${column} = ?`);
      values.push(workspacePath);
    }
    if (
      predicates.length > 0 &&
      db.prepare(`SELECT 1 FROM ${table} WHERE ${predicates.join(" OR ")} LIMIT 1`).get(...values)
    ) {
      return true;
    }
  }
  return false;
}

export function readSessionDatabaseGeneration(db: Database): string | null {
  if (!hasTable(db, "zcode_database_identity")) return null;
  const row = db
    .prepare("SELECT identity FROM zcode_database_identity WHERE scope = 'session' LIMIT 1")
    .get() as { identity: string } | undefined;
  return row?.identity?.trim() || null;
}

export async function adoptLegacySessionDatabaseGeneration(
  currentDb: Database,
  workspacePath: string,
  migration: ActiveWorkspaceMigration,
): Promise<string | null> {
  if (!migration.sessionBackupPath || !(await pathExists(migration.sessionBackupPath))) {
    return null;
  }
  const backupDb = openDatabase(migration.sessionBackupPath);
  try {
    if (!hasTable(backupDb, "session") || !hasTable(currentDb, "session")) {
      return !hasTable(backupDb, "session") && !hasTable(currentDb, "session")
        ? persistAdoptedSessionGeneration(currentDb, backupDb)
        : null;
    }
    const backupRows = backupDb
      .prepare("SELECT id, workspace_id, directory, path, time_updated FROM session")
      .all() as unknown as Array<{
      id: string;
      workspace_id: string | null;
      directory: string;
      path: string | null;
      time_updated: number;
    }>;
    if (backupRows.length === 0) {
      return hasSessionDatabaseOwnedState(currentDb, workspacePath, migration.variants)
        ? null
        : persistAdoptedSessionGeneration(currentDb, backupDb);
    }
    const findCurrent = currentDb.prepare(
      "SELECT workspace_id, directory, path, time_updated FROM session WHERE id = ?",
    );
    const mergedKeys = new Set(
      migration.variants.filter((variant) => variant !== migration.canonicalKey),
    );
    for (const row of backupRows) {
      const current = findCurrent.get(row.id) as
        | {
            workspace_id: string | null;
            directory: string;
            path: string | null;
            time_updated: number;
          }
        | undefined;
      const belongsToWorkspace = row.directory === workspacePath || row.path === workspacePath;
      const expectedWorkspaceId =
        belongsToWorkspace &&
        hasReachedMigrationPhase(migration.phase, "session-db-merged") &&
        row.workspace_id &&
        mergedKeys.has(row.workspace_id)
          ? migration.canonicalKey
          : row.workspace_id;
      if (
        !current ||
        current.workspace_id !== expectedWorkspaceId ||
        current.directory !== row.directory ||
        current.path !== row.path ||
        current.time_updated < row.time_updated
      ) {
        return null;
      }
    }
    return persistAdoptedSessionGeneration(currentDb, backupDb);
  } finally {
    backupDb.close();
  }
}

function persistAdoptedSessionGeneration(currentDb: Database, backupDb: Database): string {
  const identity = randomUUID();
  ensureSessionDatabaseGeneration(backupDb, identity);
  return ensureSessionDatabaseGeneration(currentDb, identity);
}

export function ensureSessionDatabaseGeneration(
  db: Database,
  identity: string = randomUUID(),
): string {
  // 修复原因：Repo 曾直接建表，绕过 Agent 的正式账本；复用同一 migration 接管存量表。
  runSessionDatabaseIdentityMigration(db);
  const existing = readSessionDatabaseGeneration(db);
  if (existing) return existing;
  db.prepare("INSERT INTO zcode_database_identity (scope, identity) VALUES ('session', ?)").run(
    identity,
  );
  return identity;
}
