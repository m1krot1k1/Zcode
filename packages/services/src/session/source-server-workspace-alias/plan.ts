import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE } from "@zcode/shared";
import {
  assertSessionConfigDirectoriesMergeable,
  mergeSessionConfigDirectories,
} from "./configDirectories.js";
import { ensureDatabaseBackup, type Database } from "./database.js";
import {
  commitMigrationPhase,
  markFailedPathResolved,
  recordConfigConflict,
  recordTaskIdentityConflicts,
  writeAlias,
  writeLedger,
} from "./ledger.js";
import { findTaskIdentityConflicts, mergeTaskDatabase } from "./records.js";
import {
  ensureSessionDatabaseGeneration,
  mergeSessionDatabase,
  readSessionDatabaseGeneration,
} from "./sessionDatabase.js";
import {
  hasReachedMigrationPhase,
  SourceServerWorkspaceConfigConflictError,
  SourceServerWorkspaceIdentityConflictError,
  SourceServerWorkspaceMigrationPlanDivergedError,
  type ActiveWorkspaceMigration,
  type ResolveCanonicalWorkspaceKeyResult,
  type SourceServerWorkspaceAliasContext,
} from "./types.js";
import { findVariants } from "./variants.js";

const MAX_FOLLOW_UP_MIGRATIONS = 3;

export async function mergeVariants(
  ctx: SourceServerWorkspaceAliasContext,
  input: {
    taskDb: Database;
    sessionDb: Database | null;
    workspacePath: string;
    canonicalKey: string;
    variants: string[];
    mergedKeys: string[];
    followUpDepth?: number;
  },
): Promise<ResolveCanonicalWorkspaceKeyResult> {
  const {
    taskDb,
    sessionDb,
    workspacePath,
    canonicalKey,
    variants,
    mergedKeys,
    followUpDepth = 0,
  } = input;
  const identityConflicts = findTaskIdentityConflicts(
    taskDb,
    workspacePath,
    canonicalKey,
    mergedKeys,
  );
  if (identityConflicts.length > 0) {
    recordTaskIdentityConflicts(ctx, taskDb, {
      workspacePath,
      canonicalKey,
      variants,
      conflicts: identityConflicts,
    });
    throw new SourceServerWorkspaceIdentityConflictError(workspacePath);
  }
  try {
    await assertSessionConfigDirectoriesMergeable(ctx, workspacePath, canonicalKey, mergedKeys);
  } catch (error) {
    if (error instanceof SourceServerWorkspaceConfigConflictError) {
      recordConfigConflict(ctx, taskDb, {
        workspacePath,
        canonicalKey,
        variants,
        conflict: error,
      });
    }
    throw error;
  }
  const migrationId = ctx.createMigrationId();
  const migrationDir = join(ctx.backupRoot, migrationId);
  const taskBackupPath = join(migrationDir, "tasks-index.sqlite");
  const sessionBackupPath = sessionDb ? join(migrationDir, "db.sqlite") : null;
  const sessionDatabaseGeneration = sessionDb
    ? (readSessionDatabaseGeneration(sessionDb) ?? randomUUID())
    : null;
  writeLedger(ctx, taskDb, {
    migrationId,
    workspacePath,
    canonicalKey,
    variants,
    status: "running",
    taskBackupPath,
    sessionBackupPath,
    sessionDatabaseGeneration,
  });
  try {
    if (sessionDb && sessionDatabaseGeneration) {
      // 先持久化 frozen ledger，再给 session DB 写 identity；中途崩溃时 preflight
      // resume 可按 ledger 中的期望 generation 幂等补写，不留下无 owner 的数据库变更。
      ensureSessionDatabaseGeneration(sessionDb, sessionDatabaseGeneration);
    }
    await ctx.afterPhaseCommitted?.("preflight");
  } catch (error) {
    taskDb
      .prepare(
        "UPDATE workspace_migration_ledger SET status = 'failed', error = ?, updated_at = ? WHERE migration_id = ?",
      )
      .run(
        error instanceof Error ? error.message.slice(0, 1_000) : String(error),
        ctx.now(),
        migrationId,
      );
    throw error;
  }
  return await runMigrationPlan(ctx, {
    taskDb,
    sessionDb,
    workspacePath,
    migration: {
      migrationId,
      canonicalKey,
      variants,
      phase: "preflight",
      taskBackupPath,
      sessionBackupPath,
      sessionDatabaseGeneration,
    },
    followUpDepth,
  });
}

export async function runMigrationPlan(
  ctx: SourceServerWorkspaceAliasContext,
  input: {
    taskDb: Database;
    sessionDb: Database | null;
    workspacePath: string;
    migration: ActiveWorkspaceMigration;
    followUpDepth?: number;
  },
): Promise<ResolveCanonicalWorkspaceKeyResult> {
  const { taskDb, sessionDb, workspacePath, migration } = input;
  const { migrationId, canonicalKey, variants, taskBackupPath, sessionBackupPath } = migration;
  const followUpDepth = input.followUpDepth ?? 0;
  const mergedKeys = variants.filter((key) => key !== canonicalKey);
  let phase = migration.phase;
  let followUpMergedKeys: string[] = [];
  if (phase !== "completed") {
    const newVariants = findVariants(taskDb, sessionDb, workspacePath).filter(
      (variant) => !variants.includes(variant),
    );
    if (newVariants.length > 0 && !hasReachedMigrationPhase(phase, "task-db-merged")) {
      // Bug 原因：resume 只消费 frozen variants，新出现的身份线会被当次迁移遗漏；
      // 继续发布 alias 会返回“已完成”但结果不完整，因此必须保留原计划并显式失败。
      taskDb
        .prepare(
          `UPDATE workspace_migration_ledger
             SET status = 'failed',
                 phase = CASE WHEN phase IN ('preflight', 'backups-created') THEN NULL ELSE phase END,
                 error = ?, updated_at = ?
             WHERE migration_id = ?`,
        )
        .run(WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE, ctx.now(), migrationId);
      throw new SourceServerWorkspaceMigrationPlanDivergedError(workspacePath, newVariants);
    }
    const identityConflicts = findTaskIdentityConflicts(
      taskDb,
      workspacePath,
      canonicalKey,
      mergedKeys,
    );
    if (identityConflicts.length > 0) {
      // Bug 原因：首次 preflight 后到恢复前仍可能出现同 taskId 的另一条身份线；旧恢复
      // 直接跳过 preflight，mergeTaskDatabase 只保留冲突 task，却继续 rekey 其余关联表并
      // 最终标 completed，形成不可解释的部分搬运第三态。恢复必须复检并复用原 ledger。
      recordTaskIdentityConflicts(ctx, taskDb, {
        migrationId,
        workspacePath,
        canonicalKey,
        variants,
        conflicts: identityConflicts,
      });
      throw new SourceServerWorkspaceIdentityConflictError(workspacePath);
    }
    try {
      // Bug 原因：frozen plan 首次 preflight 后仍可能新增配置；恢复若只执行旧计划，
      // DB 已搬完后才在文件移动阶段发现冲突，会留下跨介质的部分迁移。
      await assertSessionConfigDirectoriesMergeable(ctx, workspacePath, canonicalKey, mergedKeys);
    } catch (error) {
      if (error instanceof SourceServerWorkspaceConfigConflictError) {
        recordConfigConflict(ctx, taskDb, {
          migrationId,
          workspacePath,
          canonicalKey,
          variants,
          conflict: error,
        });
      }
      throw error;
    }
  }
  taskDb
    .prepare(
      "UPDATE workspace_migration_ledger SET status = 'running', error = NULL, updated_at = ? WHERE migration_id = ?",
    )
    .run(ctx.now(), migrationId);
  if (phase === "completed") {
    // Bug 原因：completed phase 写入成功后进程可能在返回前退出；恢复入口不能把它降回 running。
    taskDb
      .prepare(
        "UPDATE workspace_migration_ledger SET status = 'completed', error = NULL, updated_at = ? WHERE migration_id = ?",
      )
      .run(ctx.now(), migrationId);
  }
  try {
    if (!hasReachedMigrationPhase(phase, "backups-created")) {
      await mkdir(dirname(taskBackupPath), { recursive: true, mode: 0o700 });
      await ensureDatabaseBackup(taskDb, taskBackupPath);
      if (sessionBackupPath) {
        if (!sessionDb) {
          throw new Error(`Source Server session database is missing: ${ctx.sessionDbPath}`);
        }
        await ensureDatabaseBackup(sessionDb, sessionBackupPath);
      }
      phase = await commitMigrationPhase(ctx, taskDb, migrationId, "backups-created");
    }
    if (!hasReachedMigrationPhase(phase, "task-db-merged")) {
      mergeTaskDatabase(ctx, taskDb, workspacePath, canonicalKey, mergedKeys);
      phase = await commitMigrationPhase(ctx, taskDb, migrationId, "task-db-merged");
    }
    if (!hasReachedMigrationPhase(phase, "session-db-merged")) {
      mergeSessionDatabase(sessionDb, workspacePath, canonicalKey, mergedKeys);
      phase = await commitMigrationPhase(ctx, taskDb, migrationId, "session-db-merged");
    }
    if (!hasReachedMigrationPhase(phase, "config-dirs-merged")) {
      await mergeSessionConfigDirectories(ctx, workspacePath, canonicalKey, mergedKeys);
      phase = await commitMigrationPhase(ctx, taskDb, migrationId, "config-dirs-merged");
    }
    if (!hasReachedMigrationPhase(phase, "alias-published")) {
      writeAlias(ctx, taskDb, workspacePath, canonicalKey);
      phase = await commitMigrationPhase(ctx, taskDb, migrationId, "alias-published");
    }
    if (!hasReachedMigrationPhase(phase, "completed")) {
      phase = await commitMigrationPhase(ctx, taskDb, migrationId, "completed", "completed");
    }
    markFailedPathResolved(ctx, taskDb, workspacePath);
    followUpMergedKeys = findVariants(taskDb, sessionDb, workspacePath).filter(
      (variant) => variant !== canonicalKey,
    );
  } catch (error) {
    if (error instanceof SourceServerWorkspaceIdentityConflictError && error.conflicts.length > 0) {
      recordTaskIdentityConflicts(ctx, taskDb, {
        migrationId,
        workspacePath,
        canonicalKey,
        variants,
        conflicts: error.conflicts,
      });
      throw error;
    }
    if (error instanceof SourceServerWorkspaceConfigConflictError) {
      recordConfigConflict(ctx, taskDb, {
        migrationId,
        workspacePath,
        canonicalKey,
        variants,
        conflict: error,
      });
      throw error;
    }
    taskDb
      .prepare(
        "UPDATE workspace_migration_ledger SET status = 'failed', error = ?, updated_at = ? WHERE migration_id = ?",
      )
      .run(
        error instanceof Error ? error.message.slice(0, 1_000) : String(error),
        ctx.now(),
        migrationId,
      );
    throw error;
  }
  if (followUpMergedKeys.length > 0) {
    if (followUpDepth >= MAX_FOLLOW_UP_MIGRATIONS) {
      throw new SourceServerWorkspaceMigrationPlanDivergedError(workspacePath, followUpMergedKeys);
    }
    // Bug 原因：task DB 已提交后出现的新 variant 不能清 phase/abandon，也不能让 frozen
    // plan 永久重抛。先完成原计划，再用独立 ledger/备份做增量合并，保持两次事务可审计。
    const followUp = await mergeVariants(ctx, {
      taskDb,
      sessionDb,
      workspacePath,
      canonicalKey,
      variants: [canonicalKey, ...followUpMergedKeys],
      mergedKeys: followUpMergedKeys,
      followUpDepth: followUpDepth + 1,
    });
    return {
      ...followUp,
      mergedKeys: [...new Set([...mergedKeys, ...followUp.mergedKeys])],
    };
  }
  return { canonicalKey, mergedKeys, migrationId };
}
