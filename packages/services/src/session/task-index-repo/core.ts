import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskGroupRepository } from "#src/task-groups/index.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getTasksIndexDatabasePath, getZCodeDataRootDir } from "#src/paths.js";
import { projectStorage, type ProjectMigrationContext } from "#src/project-storage/index.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

import { DatabaseSync, type DatabaseSyncInstance } from "./database.js";
import { backfillOffPeakTaskMarkers, migrateLegacyAcpTaskIds } from "./legacyAcpMigration.js";
import { rowToMeta, serializeMetaJson, workspaceKey } from "./rowMapping.js";
import type { TaskIndexRow, TaskIndexWriteRecord } from "./types.js";

/** task index 的 sqlite 连接、迁移与串行写入基础设施；组织态/CLI 事实端口由子类暴露。 */
export class TaskIndexRepoCore {
  /** 启动迁移结果，供 main 提示；不参与任务事实或组织状态。 */
  migrationBackupSkipped = false;
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(
    private readonly migrationSettings?: ProjectMigrationContext["settings"],
    private readonly storageHostId?: string,
    private readonly startupDbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {}

  /** Host 装配层共用迁移后的组织库；UI 只能通过 project/remote-projects 服务访问。 */
  protected admitTaskGroup(meta: ZCodeTaskMeta, archived: boolean, deleted: boolean) {
    if (this.storageHostId && this.storageHostId !== "local") return;
    // 本机只登记本机事实；远程成员由控制端服务验证远端投影后写入。
    if (meta.workspaceIdentity?.trim()) return;
    new TaskGroupRepository(this.getDatabase()).admit([
      { ...meta, hostId: "local", archived, deleted },
    ]);
  }

  async getOrganizationDatabase() {
    await this.ensureReady();
    return this.getDatabase();
  }

  async getProjectRepository() {
    await this.ensureReady();
    return projectStorage.repository(this.getDatabase(), this.storageHostId);
  }

  async ensureReady(): Promise<void> {
    const path = this.startupDbPath ?? getTasksIndexDatabasePath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        // 释放失败连接；迁移后修复可能已部分提交，重试仍走原幂等初始化。
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore close errors
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    this.writeChains.clear();
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      // 多窗口 Host 共用 tasks-index；写事务和首次 schema 升级应短暂等待，而不是立即 SQLITE_BUSY。
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    const taskMigration = await runTasksDatabaseMigrations(this.db, path);
    const migration = await projectStorage.migrate(this.getDatabase(), {
      settings: this.migrationSettings,
      hostId: this.storageHostId,
      backupDirectories: [join(getZCodeDataRootDir(), "backup")],
      warn: (message, details) => createServiceLogger("project-migration").warn(message, details),
    });
    this.migrationBackupSkipped = taskMigration.backupSkipped || migration.backupSkipped;
    backfillOffPeakTaskMarkers(this.getDatabase());
    // Bugfix: z-code-2 早期列表 task_id 是 wrapper id，真实 ZCode session id 在旧列
    // acp_session_id。直接运行时映射会让 read/send/subscribe 到处变成双 ID 兜底；
    // 初始化时把索引行迁到真实 session id，后续统一走新协议正常路径。
    migrateLegacyAcpTaskIds(this.getDatabase());
  }

  protected getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("task index sqlite 尚未初始化");
    }
    return this.db;
  }

  private writeKey(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): string {
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  protected enqueueWrite<T>(
    params: { workspacePath: string; workspaceIdentity?: string; taskId: string },
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const key = this.writeKey(params);
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(key, completion);
    void completion.finally(() => {
      if (this.writeChains.get(key) === completion) {
        this.writeChains.delete(key);
      }
    });
    return result;
  }

  protected getTaskRow(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): TaskIndexRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .get(workspaceKey(params), params.taskId) as TaskIndexRow | undefined;
    return row ?? null;
  }

  protected writeRecord(record: TaskIndexWriteRecord): ZCodeTaskMeta {
    const database = this.getDatabase();
    const ownTransaction = !database.isTransaction;
    if (ownTransaction) database.exec("BEGIN IMMEDIATE");
    try {
      // 本方法只在预留行首次落 CLI 事实时调用，正文索引与未读 CAS marker 都不归它写：
      // 读一次现有行，ON CONFLICT 时原样保留 searchable_text / unread_at。
      const existing = this.getTaskRow({
        workspacePath: record.meta.workspacePath,
        workspaceIdentity: record.meta.workspaceIdentity,
        taskId: record.meta.taskId,
      });
      const searchableText = existing?.searchable_text ?? "";
      this.getDatabase()
        .prepare(
          `INSERT INTO tasks (
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        ) VALUES (
          @workspace_key,
          @workspace_path,
          @workspace_identity,
          @task_id,
          @title,
          @task_status,
          @provider,
          @mode,
          @model,
          @migration_source,
          @forked_from_task_id,
          @cron_automation_id,
          @off_peak_task_id,
          @created_at,
          @updated_at,
          @unread_at,
          @last_unread_at,
          @pinned,
          @archived,
          @deleted,
          @title_overridden,
          @searchable_text,
          @meta_json
        )
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          title = excluded.title,
          task_status = excluded.task_status,
          provider = excluded.provider,
          mode = excluded.mode,
          model = excluded.model,
          migration_source = excluded.migration_source,
          forked_from_task_id = excluded.forked_from_task_id,
          cron_automation_id = excluded.cron_automation_id,
          off_peak_task_id = excluded.off_peak_task_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          unread_at = tasks.unread_at,
          last_unread_at = MAX(tasks.last_unread_at, COALESCE(tasks.unread_at, 0)),
          pinned = excluded.pinned,
          archived = excluded.archived,
          deleted = excluded.deleted,
          title_overridden = excluded.title_overridden,
          searchable_text = excluded.searchable_text,
          meta_json = excluded.meta_json`,
        )
        .run({
          workspace_key: workspaceKey(record.meta),
          workspace_path: record.meta.workspacePath,
          workspace_identity: record.meta.workspaceIdentity ?? null,
          task_id: record.meta.taskId,
          title: record.meta.title,
          task_status: record.meta.status ?? null,
          provider: record.meta.provider ?? null,
          mode: record.meta.mode,
          model: record.meta.model ?? null,
          migration_source: record.meta.migrationSource ?? null,
          forked_from_task_id: record.meta.forkedFromTaskId ?? null,
          // cron automation 身份从 meta 投影到索引列（meta_json 里也保留一份，见 serializeMetaJson）。
          cron_automation_id: record.meta.cronAutomationId ?? null,
          // off-peak 身份（D48）同款投影。
          off_peak_task_id: record.meta.offPeakTaskId ?? null,
          created_at: record.meta.createdAt,
          updated_at: record.meta.updatedAt,
          unread_at: record.meta.unreadAt ?? null,
          last_unread_at: record.meta.unreadAt ?? 0,
          pinned: record.pinned ? 1 : 0,
          archived: record.archived ? 1 : 0,
          deleted: record.deleted ? 1 : 0,
          title_overridden: record.titleOverridden ? 1 : 0,
          searchable_text: searchableText,
          meta_json: serializeMetaJson(record.meta),
        });
      projectStorage.admitTaskIdentity(database, record.meta, this.storageHostId);
      if (record.titleOverridden)
        database
          .prepare(
            "UPDATE tasks SET handoff_pending=handoff_pending | 2 WHERE workspace_key=? AND task_id=? AND cli_title_source IS NULL",
          )
          .run(workspaceKey(record.meta), record.meta.taskId);

      const persisted = this.getTaskRow(record.meta);
      if (!persisted) {
        throw new Error(`task index 写入后缺少 task: ${record.meta.taskId}`);
      }
      this.admitTaskGroup(rowToMeta(persisted), persisted.archived === 1, persisted.deleted === 1);
      if (ownTransaction) database.exec("COMMIT");
      return rowToMeta(persisted);
    } catch (error) {
      if (ownTransaction && database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }
}
