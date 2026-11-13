import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
} from "@zcode/shared";
import { runSessionDatabaseIdentityMigration } from "@zcode/shared/sqlite-migrations";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { openDatabase, type Database } from "./database.js";
import {
  failActiveMigration,
  markFailedPathResolved,
  readActiveMigration,
  readLatestAbandonedMigration,
  writeAlias,
} from "./ledger.js";
import { mergeVariants, runMigrationPlan } from "./plan.js";
import {
  adoptLegacySessionDatabaseGeneration,
  ensureSessionDatabaseGeneration,
  hasSessionDatabaseOwnedState,
  readSessionDatabaseGeneration,
} from "./sessionDatabase.js";
import {
  SourceServerWorkspaceSessionGenerationChangedError,
  type ResolveCanonicalWorkspaceKeyInput,
  type ResolveCanonicalWorkspaceKeyResult,
  type SourceServerWorkspaceAliasContext,
} from "./types.js";
import {
  chooseCanonicalKey,
  findVariants,
  hasWorkspaceOwnedStateForHint,
  isLegacyRemoteKey,
} from "./variants.js";

export async function resolveCanonicalWorkspaceKeyInternal(
  ctx: SourceServerWorkspaceAliasContext,
  input: ResolveCanonicalWorkspaceKeyInput,
  options: { ignoreAbandoned?: boolean } = {},
): Promise<ResolveCanonicalWorkspaceKeyResult> {
  const { workspacePath } = input;
  await mkdir(join(ctx.taskDbPath, ".."), { recursive: true }).catch(() => undefined);
  const taskDb = openDatabase(ctx.taskDbPath);
  let sessionDb: Database | null = null;
  try {
    await runTasksDatabaseMigrations(taskDb, "source-server");
    const activeMigration = readActiveMigration(taskDb, workspacePath);
    const sessionDatabaseExists = await stat(ctx.sessionDbPath).then(
      (value) => value.isFile(),
      () => false,
    );
    if (activeMigration?.sessionBackupPath && !sessionDatabaseExists) {
      failActiveMigration(
        ctx,
        taskDb,
        activeMigration.migrationId,
        WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
      );
      throw new SourceServerWorkspaceSessionGenerationChangedError(workspacePath);
    }
    if (sessionDatabaseExists) {
      sessionDb = openDatabase(ctx.sessionDbPath);
    }
    if (activeMigration?.sessionBackupPath && sessionDb) {
      let currentGeneration = readSessionDatabaseGeneration(sessionDb);
      if (
        activeMigration.sessionDatabaseGeneration &&
        !currentGeneration &&
        activeMigration.phase === "preflight"
      ) {
        currentGeneration = ensureSessionDatabaseGeneration(
          sessionDb,
          activeMigration.sessionDatabaseGeneration,
        );
      }
      if (!activeMigration.sessionDatabaseGeneration) {
        if (activeMigration.phase === "preflight") {
          currentGeneration = ensureSessionDatabaseGeneration(sessionDb);
        } else {
          currentGeneration = await adoptLegacySessionDatabaseGeneration(
            sessionDb,
            workspacePath,
            activeMigration,
          );
        }
        if (currentGeneration) {
          activeMigration.sessionDatabaseGeneration = currentGeneration;
          taskDb
            .prepare(
              "UPDATE workspace_migration_ledger SET session_db_generation = ?, updated_at = ? WHERE migration_id = ?",
            )
            .run(currentGeneration, ctx.now(), activeMigration.migrationId);
        }
      }
      if (
        !activeMigration.sessionDatabaseGeneration ||
        currentGeneration !== activeMigration.sessionDatabaseGeneration
      ) {
        failActiveMigration(
          ctx,
          taskDb,
          activeMigration.migrationId,
          WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
        );
        throw new SourceServerWorkspaceSessionGenerationChangedError(workspacePath);
      }
    }
    if (activeMigration && sessionDb && !activeMigration.sessionBackupPath) {
      if (hasSessionDatabaseOwnedState(sessionDb, workspacePath, activeMigration.variants)) {
        // Bug 原因：plan 冻结时没有 session DB，恢复期间新出现的空库不应被误杀；
        // 只有新代际已经承载本 workspace/variant 数据时，才无法证明可安全并入。
        failActiveMigration(
          ctx,
          taskDb,
          activeMigration.migrationId,
          WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
        );
        throw new SourceServerWorkspaceSessionGenerationChangedError(workspacePath);
      }
      // frozen plan 没有 session backup 且新库不含 owned state：显式排除该 generation，
      // 后续阶段不得依赖“UPDATE 恰好匹配不到行”来维持无副作用。
      sessionDb.close();
      sessionDb = null;
    }
    // frozen plan 明确排除的晚到空库保持不变；只接管本次实际参与解析/合并的库。
    if (sessionDb) runSessionDatabaseIdentityMigration(sessionDb);
    if (activeMigration) {
      // Bug 原因：task DB 已提交、session DB 尚未提交时重新扫描活跃度会反向选主，
      // 甚至创建第二条 migration。活动 ledger 是恢复 owner，计划必须原样续跑。
      return await runMigrationPlan(ctx, {
        taskDb,
        sessionDb,
        workspacePath,
        migration: activeMigration,
      });
    }
    const abandonedMigration = options.ignoreAbandoned
      ? null
      : readLatestAbandonedMigration(taskDb, workspacePath);
    if (abandonedMigration) {
      // Bug 原因：放弃合并只写 alias，但旧入口仍因遗留 variant 再次进入 mergeVariants，
      // 于是同一冲突会立刻阻塞重开并创建第二条 ledger。abandoned 是用户明确选择的
      // 冻结 canonical；只有 retryFailedWorkspace 显式清除 abandoned 后才允许重新合并。
      return { canonicalKey: abandonedMigration.canonicalKey, mergedKeys: [] };
    }
    const existing = taskDb
      .prepare("SELECT canonical_key FROM workspace_alias WHERE path = ?")
      .get(workspacePath) as { canonical_key: string } | undefined;
    const variants = findVariants(taskDb, sessionDb, workspacePath);
    const legacyRouteHint = input.legacyRouteHint?.trim();
    if (
      legacyRouteHint &&
      isLegacyRemoteKey(legacyRouteHint) &&
      !variants.includes(legacyRouteHint) &&
      (await hasWorkspaceOwnedStateForHint(ctx, taskDb, workspacePath, legacyRouteHint))
    ) {
      variants.push(legacyRouteHint);
      variants.sort();
    }
    if (existing) {
      const mergedKeys = variants.filter((key) => key !== existing.canonical_key);
      if (mergedKeys.length === 0) {
        markFailedPathResolved(ctx, taskDb, workspacePath);
        return { canonicalKey: existing.canonical_key, mergedKeys: [] };
      }
      return await mergeVariants(ctx, {
        taskDb,
        sessionDb,
        workspacePath,
        canonicalKey: existing.canonical_key,
        variants: [existing.canonical_key, ...mergedKeys],
        mergedKeys,
      });
    }
    if (variants.length === 0) {
      const hint = input.legacyRouteHint?.trim();
      // 新 URL Server 没有旧 SSH 路由；仅初次无历史绑定可使用稳定 server identity。
      // 已有 alias 与历史 variants 的裁决顺序保持不变，避免改变 CLI 配置目录。
      if (!hint || !isRemoteWorkspaceIdentity(hint)) {
        throw new Error("A legacyRouteHint is required for a new Source Server workspace");
      }
      writeAlias(ctx, taskDb, workspacePath, hint);
      markFailedPathResolved(ctx, taskDb, workspacePath);
      return { canonicalKey: hint, mergedKeys: [] };
    }
    if (variants.length === 1) {
      const canonicalKey = variants[0]!;
      writeAlias(ctx, taskDb, workspacePath, canonicalKey);
      markFailedPathResolved(ctx, taskDb, workspacePath);
      return { canonicalKey, mergedKeys: [] };
    }

    const canonicalKey = chooseCanonicalKey(taskDb, sessionDb, workspacePath, variants);
    const mergedKeys = variants.filter((key) => key !== canonicalKey);
    return await mergeVariants(ctx, {
      taskDb,
      sessionDb,
      workspacePath,
      canonicalKey,
      variants,
      mergedKeys,
    });
  } finally {
    sessionDb?.close();
    taskDb.close();
  }
}
