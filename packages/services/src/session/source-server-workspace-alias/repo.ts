import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SourceServerMigrationReport } from "@zcode/shared";
import { getDataBaseDir, getTasksIndexDatabasePath } from "#src/paths.js";
import {
  abandonFailedWorkspaceInternal,
  countAbandonedPaths,
  countFailedPaths,
  listMigrationReports,
  retryFailedWorkspaceInternal,
} from "./reports.js";
import { resolveCanonicalWorkspaceKeyInternal } from "./resolve.js";
import type {
  ResolveCanonicalWorkspaceKeyInput,
  ResolveCanonicalWorkspaceKeyResult,
  SourceServerWorkspaceAliasContext,
  SourceServerWorkspaceAliasRepoOptions,
} from "./types.js";

export class SourceServerWorkspaceAliasRepo {
  private readonly context: SourceServerWorkspaceAliasContext;
  private readonly workspaceOperations = new Map<string, Promise<void>>();

  public constructor(options: SourceServerWorkspaceAliasRepoOptions = {}) {
    this.context = {
      taskDbPath: options.taskDbPath ?? getTasksIndexDatabasePath(),
      sessionDbPath:
        options.sessionDbPath ?? join(getDataBaseDir(), ".zcode", "cli", "db", "db.sqlite"),
      backupRoot:
        options.backupRoot ?? join(getDataBaseDir(), ".zcode", "server", "migration-backups"),
      now: options.now ?? Date.now,
      createMigrationId: options.migrationId ?? randomUUID,
      afterPhaseCommitted: options.afterPhaseCommitted,
    };
  }

  public async resolveCanonicalWorkspaceKey(
    input: ResolveCanonicalWorkspaceKeyInput,
    options: { ignoreAbandoned?: boolean } = {},
  ): Promise<ResolveCanonicalWorkspaceKeyResult> {
    return await this.runWorkspaceOperation(input.workspacePath, (workspacePath) =>
      resolveCanonicalWorkspaceKeyInternal(this.context, { ...input, workspacePath }, options),
    );
  }

  private async runWorkspaceOperation<T>(
    rawWorkspacePath: string,
    operation: (workspacePath: string) => Promise<T>,
  ): Promise<T> {
    const workspacePath = rawWorkspacePath.trim();
    if (!workspacePath) throw new Error("workspacePath is required");
    // Bug 原因：alias/ledger 读取后的异步 IO 会让同路径解析交错，返回不同 canonical，
    // 甚至重复搬运配置目录。三个修改入口按规范化路径串行，覆盖读取、提交和连接关闭。
    const previous = this.workspaceOperations.get(workspacePath) ?? Promise.resolve();
    const result = previous.then(() => operation(workspacePath));
    // 失败仍返回给当前调用方；队列继续消费下一项，让其从已提交的 ledger 恢复。
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.workspaceOperations.set(workspacePath, settled);
    try {
      return await result;
    } finally {
      if (this.workspaceOperations.get(workspacePath) === settled) {
        this.workspaceOperations.delete(workspacePath);
      }
    }
  }

  public async getFailedPathCount(): Promise<number> {
    return await countFailedPaths(this.context);
  }

  public async getAbandonedPathCount(): Promise<number> {
    return await countAbandonedPaths(this.context);
  }

  public async listMigrationReports(): Promise<SourceServerMigrationReport> {
    return await listMigrationReports(this.context);
  }

  public async abandonFailedWorkspace(workspacePath: string, migrationId?: string): Promise<void> {
    return await this.runWorkspaceOperation(workspacePath, (normalizedPath) =>
      abandonFailedWorkspaceInternal(this.context, normalizedPath, migrationId),
    );
  }

  public async retryFailedWorkspace(
    workspacePath: string,
    migrationId?: string,
  ): Promise<ResolveCanonicalWorkspaceKeyResult> {
    return await this.runWorkspaceOperation(workspacePath, (normalizedPath) =>
      retryFailedWorkspaceInternal(this.context, normalizedPath, migrationId),
    );
  }
}
