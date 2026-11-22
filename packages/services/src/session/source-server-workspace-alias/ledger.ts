import { rollbackQuietly, type Database } from "./database.js";
import {
  parseMigrationPhase,
  type ActiveWorkspaceMigration,
  type SourceServerWorkspaceAliasContext,
  type SourceServerWorkspaceConfigConflictError,
  type WorkspaceMigrationPhase,
  type WorkspaceTaskIdentityConflict,
} from "./types.js";

export function readActiveMigration(
  db: Database,
  workspacePath: string,
): ActiveWorkspaceMigration | null {
  const row = db
    .prepare(`
        SELECT migration_id, canonical_key, variant_keys_json, phase,
               task_backup_path, session_backup_path, session_db_generation
        FROM workspace_migration_ledger
        WHERE path = ? AND status IN ('running', 'failed') AND phase IS NOT NULL
        ORDER BY updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      `)
    .get(workspacePath) as
    | {
        migration_id: string;
        canonical_key: string;
        variant_keys_json: string;
        phase: string;
        task_backup_path: string;
        session_backup_path: string | null;
        session_db_generation: string | null;
      }
    | undefined;
  if (!row) return null;
  const phase = parseMigrationPhase(row.phase);
  let variants: unknown;
  try {
    variants = JSON.parse(row.variant_keys_json);
  } catch {
    variants = null;
  }
  if (
    !phase ||
    !Array.isArray(variants) ||
    variants.some((value) => typeof value !== "string") ||
    !variants.includes(row.canonical_key)
  ) {
    throw new Error(`Invalid active Source Server migration ledger: ${row.migration_id}`);
  }
  return {
    migrationId: row.migration_id,
    canonicalKey: row.canonical_key,
    variants,
    phase,
    taskBackupPath: row.task_backup_path,
    sessionBackupPath: row.session_backup_path,
    sessionDatabaseGeneration: row.session_db_generation,
  };
}

export function readLatestAbandonedMigration(
  db: Database,
  workspacePath: string,
): { canonicalKey: string } | null {
  const row = db
    .prepare(`
        SELECT canonical_key, status
        FROM workspace_migration_ledger
        WHERE path = ?
        ORDER BY updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      `)
    .get(workspacePath) as
    | { canonical_key: string; status: "running" | "completed" | "failed" | "abandoned" }
    | undefined;
  return row?.status === "abandoned" ? { canonicalKey: row.canonical_key } : null;
}

export function failActiveMigration(
  ctx: SourceServerWorkspaceAliasContext,
  db: Database,
  migrationId: string,
  errorCode: string,
): void {
  // Bug 原因：session generation 异常过去无条件保留 phase，连尚未搬运数据的计划也无法
  // abandon。仅 preflight/backups-created 可安全释放 resume owner；post-merge 继续保留。
  db.prepare(`
      UPDATE workspace_migration_ledger
      SET status = 'failed',
          phase = CASE WHEN phase IN ('preflight', 'backups-created') THEN NULL ELSE phase END,
          error = ?, updated_at = ?
      WHERE migration_id = ?
    `).run(errorCode, ctx.now(), migrationId);
}

export async function commitMigrationPhase(
  ctx: SourceServerWorkspaceAliasContext,
  db: Database,
  migrationId: string,
  phase: WorkspaceMigrationPhase,
  status: "running" | "completed" = "running",
): Promise<WorkspaceMigrationPhase> {
  db.prepare(
    "UPDATE workspace_migration_ledger SET phase = ?, status = ?, error = NULL, updated_at = ? WHERE migration_id = ?",
  ).run(phase, status, ctx.now(), migrationId);
  await ctx.afterPhaseCommitted?.(phase);
  return phase;
}

export function writeAlias(
  ctx: SourceServerWorkspaceAliasContext,
  db: Database,
  workspacePath: string,
  canonicalKey: string,
): void {
  const now = ctx.now();
  db.prepare(`
      INSERT INTO workspace_alias (path, canonical_key, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET canonical_key = excluded.canonical_key, updated_at = excluded.updated_at
    `).run(workspacePath, canonicalKey, now, now);
}

export function markFailedPathResolved(
  ctx: SourceServerWorkspaceAliasContext,
  db: Database,
  workspacePath: string,
): void {
  db.prepare(`
      UPDATE workspace_migration_ledger
      SET status = 'completed', error = NULL, updated_at = ?
      WHERE path = ? AND status = 'failed'
    `).run(ctx.now(), workspacePath);
}

export function writeLedger(
  ctx: SourceServerWorkspaceAliasContext,
  db: Database,
  input: {
    migrationId: string;
    workspacePath: string;
    canonicalKey: string;
    variants: string[];
    status: "running" | "completed" | "failed";
    taskBackupPath: string;
    sessionBackupPath: string | null;
    sessionDatabaseGeneration: string | null;
  },
): void {
  const now = ctx.now();
  db.prepare(`
      INSERT INTO workspace_migration_ledger (
        migration_id, path, canonical_key, variant_keys_json, status, phase,
        task_backup_path, session_backup_path, created_at, updated_at,
        session_db_generation
      ) VALUES (?, ?, ?, ?, ?, 'preflight', ?, ?, ?, ?, ?)
    `).run(
    input.migrationId,
    input.workspacePath,
    input.canonicalKey,
    JSON.stringify(input.variants),
    input.status,
    input.taskBackupPath,
    input.sessionBackupPath,
    now,
    now,
    input.sessionDatabaseGeneration,
  );
}

export function recordTaskIdentityConflicts(
  ctx: SourceServerWorkspaceAliasContext,
  db: Database,
  input: {
    migrationId?: string;
    workspacePath: string;
    canonicalKey: string;
    variants: string[];
    conflicts: WorkspaceTaskIdentityConflict[];
  },
): void {
  const existing = input.migrationId
    ? (db
        .prepare("SELECT migration_id FROM workspace_migration_ledger WHERE migration_id = ?")
        .get(input.migrationId) as { migration_id: string } | undefined)
    : (db
        .prepare(`
            SELECT migration_id
            FROM workspace_migration_ledger
            WHERE path = ? AND status = 'failed'
              AND error = 'workspace-task-identity-conflict'
            ORDER BY updated_at DESC, created_at DESC, rowid DESC
            LIMIT 1
          `)
        .get(input.workspacePath) as { migration_id: string } | undefined);
  const migrationId = existing?.migration_id ?? ctx.createMigrationId();
  const now = ctx.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (existing) {
      // Bug 原因：冲突 ledger 幂等去重后直接 return，后续新增/消失的冲突不会更新报告。
      // 复用同一 migrationId，但事务性替换当前冲突集，仍不重复备份或新建 ledger。
      // preflight/backups-created 尚未搬运数据，可清 phase 让用户 abandon；之后的 phase
      // 保留 resume owner，禁止把部分迁移伪装成普通冲突。
      db.prepare(`
          UPDATE workspace_migration_ledger
          SET canonical_key = ?, variant_keys_json = ?, status = 'failed',
              phase = CASE WHEN phase IN ('preflight', 'backups-created') THEN NULL ELSE phase END,
              error = 'workspace-task-identity-conflict', updated_at = ?
          WHERE migration_id = ?
        `).run(input.canonicalKey, JSON.stringify(input.variants), now, migrationId);
      db.prepare("DELETE FROM workspace_migration_conflicts WHERE migration_id = ?").run(
        migrationId,
      );
    } else {
      db.prepare(`
          INSERT INTO workspace_migration_ledger (
            migration_id, path, canonical_key, variant_keys_json, status,
            task_backup_path, session_backup_path, error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'failed', '', NULL, 'workspace-task-identity-conflict', ?, ?)
        `).run(
        migrationId,
        input.workspacePath,
        input.canonicalKey,
        JSON.stringify(input.variants),
        now,
        now,
      );
    }
    const insertConflict = db.prepare(`
        INSERT INTO workspace_migration_conflicts (
          migration_id, path, conflict_kind, conflict_key, task_id, relative_path,
          source_key, canonical_key, reason, created_at
        ) VALUES (?, ?, 'task-identity', ?, ?, NULL, ?, ?,
          'task-identity-metadata-conflict', ?)
      `);
    for (const conflict of input.conflicts) {
      insertConflict.run(
        migrationId,
        input.workspacePath,
        conflict.taskId,
        conflict.taskId,
        conflict.sourceKey,
        input.canonicalKey,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

export function recordConfigConflict(
  ctx: SourceServerWorkspaceAliasContext,
  db: Database,
  input: {
    migrationId?: string;
    workspacePath: string;
    canonicalKey: string;
    variants: string[];
    conflict: SourceServerWorkspaceConfigConflictError;
  },
): void {
  const existing = input.migrationId
    ? (db
        .prepare("SELECT migration_id FROM workspace_migration_ledger WHERE migration_id = ?")
        .get(input.migrationId) as { migration_id: string } | undefined)
    : (db
        .prepare(`
        SELECT migration_id
        FROM workspace_migration_ledger
        WHERE path = ? AND status = 'failed'
          AND error = 'workspace-config-file-conflict'
        ORDER BY updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      `)
        .get(input.workspacePath) as { migration_id: string } | undefined);
  const migrationId = existing?.migration_id ?? ctx.createMigrationId();
  const now = ctx.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (existing) {
      // 仅 pre-merge phase 能安全转成可 abandon 冲突；DB 已提交后的冲突必须保留 resume owner。
      db.prepare(`
          UPDATE workspace_migration_ledger
          SET canonical_key = ?, variant_keys_json = ?, status = 'failed',
              phase = CASE WHEN phase IN ('preflight', 'backups-created') THEN NULL ELSE phase END,
              error = 'workspace-config-file-conflict', updated_at = ?
          WHERE migration_id = ?
        `).run(input.canonicalKey, JSON.stringify(input.variants), now, migrationId);
      db.prepare("DELETE FROM workspace_migration_conflicts WHERE migration_id = ?").run(
        migrationId,
      );
    } else {
      db.prepare(`
          INSERT INTO workspace_migration_ledger (
            migration_id, path, canonical_key, variant_keys_json, status, phase,
            task_backup_path, session_backup_path, error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'failed', NULL, '', NULL,
            'workspace-config-file-conflict', ?, ?)
        `).run(
        migrationId,
        input.workspacePath,
        input.canonicalKey,
        JSON.stringify(input.variants),
        now,
        now,
      );
    }
    db.prepare(`
        INSERT INTO workspace_migration_conflicts (
          migration_id, path, conflict_kind, conflict_key, task_id, relative_path,
          source_key, canonical_key, reason, created_at
        ) VALUES (?, ?, 'config-file', ?, NULL, ?, ?, ?,
          'workspace-config-file-conflict', ?)
      `).run(
      migrationId,
      input.workspacePath,
      input.conflict.relativePath,
      input.conflict.relativePath,
      input.conflict.sourceKey,
      input.canonicalKey,
      now,
    );
    db.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}
