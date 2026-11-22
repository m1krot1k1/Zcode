import { stat } from "node:fs/promises";
import type { SourceServerMigrationReport, SourceServerMigrationReportRow } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import {
  computeVariantActivityDigests,
  parseAbandonedActivity,
  parseVariantKeys,
} from "./activity.js";
import { readVariantConfigSnapshots } from "./configDirectories.js";
import { openDatabase, rollbackQuietly } from "./database.js";
import { writeAlias } from "./ledger.js";
import { resolveCanonicalWorkspaceKeyInternal } from "./resolve.js";
import type {
  ResolveCanonicalWorkspaceKeyResult,
  SourceServerWorkspaceAliasContext,
} from "./types.js";

export async function countFailedPaths(ctx: SourceServerWorkspaceAliasContext): Promise<number> {
  const taskDb = openDatabase(ctx.taskDbPath);
  try {
    await runTasksDatabaseMigrations(taskDb, "source-server");
    const row = taskDb
      .prepare(
        `SELECT COUNT(*) AS count
           FROM workspace_migration_ledger current
           WHERE current.status = 'failed'
             AND NOT EXISTS (
               SELECT 1 FROM workspace_migration_ledger newer
               WHERE newer.path = current.path
                 AND (newer.updated_at > current.updated_at
                   OR (newer.updated_at = current.updated_at
                     AND (newer.created_at > current.created_at
                       OR (newer.created_at = current.created_at
                         AND newer.rowid > current.rowid))))
             )`,
      )
      .get() as { count: number };
    return row.count;
  } finally {
    taskDb.close();
  }
}

export async function countAbandonedPaths(ctx: SourceServerWorkspaceAliasContext): Promise<number> {
  const taskDb = openDatabase(ctx.taskDbPath);
  try {
    await runTasksDatabaseMigrations(taskDb, "source-server");
    const row = taskDb
      .prepare(
        `SELECT COUNT(*) AS count
           FROM workspace_migration_ledger current
           WHERE current.status = 'abandoned'
             AND NOT EXISTS (
               SELECT 1 FROM workspace_migration_ledger newer
               WHERE newer.path = current.path
                 AND (newer.updated_at > current.updated_at
                   OR (newer.updated_at = current.updated_at
                     AND (newer.created_at > current.created_at
                       OR (newer.created_at = current.created_at
                         AND newer.rowid > current.rowid))))
             )`,
      )
      .get() as { count: number };
    return row.count;
  } finally {
    taskDb.close();
  }
}

export async function listMigrationReports(
  ctx: SourceServerWorkspaceAliasContext,
): Promise<SourceServerMigrationReport> {
  const taskDb = openDatabase(ctx.taskDbPath);
  const sessionDb = await stat(ctx.sessionDbPath).then(
    (value) => (value.isFile() ? openDatabase(ctx.sessionDbPath) : null),
    () => null,
  );
  try {
    await runTasksDatabaseMigrations(taskDb, "source-server");
    const ledgerRows = taskDb
      .prepare(`
          SELECT migration_id, path, canonical_key, variant_keys_json, status, phase,
                 task_backup_path, session_backup_path, error, updated_at,
                 abandoned_at, abandoned_trigger, abandoned_activity_json
          FROM workspace_migration_ledger
          ORDER BY updated_at DESC, created_at DESC, rowid DESC
        `)
      .all() as unknown as Array<{
      migration_id: string;
      path: string;
      canonical_key: string;
      variant_keys_json: string;
      status: "running" | "completed" | "failed" | "abandoned";
      phase: string | null;
      task_backup_path: string;
      session_backup_path: string | null;
      error: string | null;
      updated_at: number;
      abandoned_at: number | null;
      abandoned_trigger: string | null;
      abandoned_activity_json: string | null;
    }>;
    const readConflicts = taskDb.prepare(`
        SELECT conflict_kind, conflict_key, task_id, relative_path, source_key,
               canonical_key, reason
        FROM workspace_migration_conflicts
        WHERE migration_id = ?
        ORDER BY conflict_kind, conflict_key, source_key
      `);
    const rows: SourceServerMigrationReportRow[] = [];
    for (const ledger of ledgerRows) {
      const variantKeys = parseVariantKeys(ledger.variant_keys_json);
      let status: SourceServerMigrationReportRow["status"] = ledger.status;
      if (ledger.status === "abandoned" && ledger.abandoned_activity_json) {
        const baseline = parseAbandonedActivity(ledger.abandoned_activity_json);
        const current = await computeVariantActivityDigests(
          ctx,
          taskDb,
          sessionDb,
          ledger.path,
          variantKeys.filter((key) => key !== ledger.canonical_key),
          baseline.version,
        );
        if (JSON.stringify(current) !== JSON.stringify(baseline.digests)) {
          status = "abandoned-diverged";
        }
      }
      const conflicts = readConflicts.all(ledger.migration_id) as unknown as Array<{
        conflict_kind: "task-identity" | "config-file";
        conflict_key: string;
        task_id: string | null;
        relative_path: string | null;
        source_key: string;
        canonical_key: string;
        reason: string;
      }>;
      rows.push({
        migrationId: ledger.migration_id,
        workspacePath: ledger.path,
        canonicalKey: ledger.canonical_key,
        variantKeys,
        status,
        ...(ledger.phase ? { phase: ledger.phase } : {}),
        ...(ledger.error ? { errorCode: ledger.error } : {}),
        ...(ledger.task_backup_path ? { taskBackupPath: ledger.task_backup_path } : {}),
        ...(ledger.session_backup_path ? { sessionBackupPath: ledger.session_backup_path } : {}),
        updatedAt: ledger.updated_at,
        ...(ledger.abandoned_at !== null ? { abandonedAt: ledger.abandoned_at } : {}),
        ...(ledger.abandoned_trigger ? { abandonedTrigger: ledger.abandoned_trigger } : {}),
        conflicts: conflicts.map((conflict) => ({
          kind: conflict.conflict_kind,
          key: conflict.conflict_key,
          ...(conflict.task_id ? { taskId: conflict.task_id } : {}),
          ...(conflict.relative_path ? { relativePath: conflict.relative_path } : {}),
          sourceKey: conflict.source_key,
          canonicalKey: conflict.canonical_key,
          reason: conflict.reason,
        })),
      });
    }
    return { rows };
  } finally {
    sessionDb?.close();
    taskDb.close();
  }
}

export async function abandonFailedWorkspaceInternal(
  ctx: SourceServerWorkspaceAliasContext,
  workspacePath: string,
  migrationId?: string,
): Promise<void> {
  const taskDb = openDatabase(ctx.taskDbPath);
  const sessionDb = await stat(ctx.sessionDbPath).then(
    (value) => (value.isFile() ? openDatabase(ctx.sessionDbPath) : null),
    () => null,
  );
  try {
    await runTasksDatabaseMigrations(taskDb, "source-server");
    const ledger = taskDb
      .prepare(`
          SELECT migration_id, canonical_key, variant_keys_json, phase
          FROM workspace_migration_ledger
          WHERE path = ? AND status = 'failed'
            ${migrationId ? "AND migration_id = ?" : ""}
          ORDER BY updated_at DESC, created_at DESC, rowid DESC
          LIMIT 1
        `)
      .get(workspacePath, ...(migrationId ? [migrationId] : [])) as
      | {
          migration_id: string;
          canonical_key: string;
          variant_keys_json: string;
          phase: string | null;
        }
      | undefined;
    if (!ledger) throw new Error(`No failed Source Server migration for path: ${workspacePath}`);
    if (ledger.phase !== null) {
      // phase 非空的 failed ledger 仍是 crash resume owner，不能被 abandon 销毁。
      throw new Error(`Source Server resumable migration cannot be abandoned: ${workspacePath}`);
    }
    const variantKeys = parseVariantKeys(ledger.variant_keys_json);
    const abandonedVariants = variantKeys.filter((key) => key !== ledger.canonical_key);
    const configSnapshots = await readVariantConfigSnapshots(ctx, workspacePath, abandonedVariants);
    const now = ctx.now();
    taskDb.exec("BEGIN IMMEDIATE");
    try {
      // 配置 IO 期间其他进程可能已完成或换了计划；取得写锁后复查，避免旧 abandon
      // 覆盖新 ledger/alias。updated_at 可在同一毫秒内重复，必须比较状态与冻结计划本身。
      const current = taskDb
        .prepare(`
          SELECT canonical_key, variant_keys_json
          FROM workspace_migration_ledger
          WHERE migration_id = ? AND path = ? AND status = 'failed' AND phase IS NULL
        `)
        .get(ledger.migration_id, workspacePath) as
        | { canonical_key: string; variant_keys_json: string }
        | undefined;
      if (
        !current ||
        current.canonical_key !== ledger.canonical_key ||
        current.variant_keys_json !== ledger.variant_keys_json
      ) {
        throw Object.assign(
          new Error(`Source Server migration changed during abandon: ${workspacePath}`),
          { retryable: true },
        );
      }
      sessionDb?.exec("BEGIN");
      taskDb
        .prepare(`
          UPDATE workspace_migration_ledger
          SET status = 'abandoned', phase = NULL, abandoned_at = ?,
              abandoned_trigger = 'user', abandoned_activity_json = NULL, updated_at = ?
          WHERE migration_id = ?
        `)
        .run(now, now, ledger.migration_id);
      writeAlias(ctx, taskDb, workspacePath, ledger.canonical_key);
      // Bug 原因：旧实现先算 digest 再开启 ledger 事务，事务触发器/并发 task 写入会在
      // abandoned 提交前落盘，却被误判成“放弃后的 divergence”。先提交逻辑状态，再在
      // 同一未提交事务的最终视图上取 DB 基线；session DB 用读事务固定同一轮快照。
      // config 文件已在加写锁前并行读取，避免目录大小直接延长 task DB 写锁。
      const activity = await computeVariantActivityDigests(
        ctx,
        taskDb,
        sessionDb,
        workspacePath,
        abandonedVariants,
        2,
        configSnapshots,
      );
      taskDb
        .prepare(
          "UPDATE workspace_migration_ledger SET abandoned_activity_json = ? WHERE migration_id = ?",
        )
        .run(JSON.stringify({ schemaVersion: 2, digests: activity }), ledger.migration_id);
      sessionDb?.exec("COMMIT");
      taskDb.exec("COMMIT");
    } catch (error) {
      if (sessionDb) rollbackQuietly(sessionDb);
      rollbackQuietly(taskDb);
      throw error;
    }
  } finally {
    sessionDb?.close();
    taskDb.close();
  }
}

export async function retryFailedWorkspaceInternal(
  ctx: SourceServerWorkspaceAliasContext,
  workspacePath: string,
  migrationId?: string,
): Promise<ResolveCanonicalWorkspaceKeyResult> {
  const taskDb = openDatabase(ctx.taskDbPath);
  let canonicalKey: string | undefined;
  try {
    await runTasksDatabaseMigrations(taskDb, "source-server");
    const failed = taskDb
      .prepare(`
        SELECT canonical_key
        FROM workspace_migration_ledger
        WHERE path = ? AND status IN ('failed', 'abandoned')
          ${migrationId ? "AND migration_id = ?" : ""}
        ORDER BY updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      `)
      .get(workspacePath, ...(migrationId ? [migrationId] : [])) as
      | { canonical_key: string }
      | undefined;
    canonicalKey = failed?.canonical_key;
  } finally {
    taskDb.close();
  }
  if (!canonicalKey)
    throw new Error(`No retryable Source Server migration for path: ${workspacePath}`);
  // retry 只绕过本次 abandoned 短路；若仍冲突会创建新的 failed attempt，原审计保留。
  // 当前操作已占有同路径队列，直接复用内部入口，避免重新排队后等待自身。
  return await resolveCanonicalWorkspaceKeyInternal(
    ctx,
    {
      workspacePath,
      legacyRouteHint: canonicalKey,
    },
    { ignoreAbandoned: true },
  );
}
