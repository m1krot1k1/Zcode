import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import type { AutomationRow } from "./rows.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

export abstract class AutomationRepoDatabase {
  migrationBackupSkipped = false;
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  // db 路径不能从进程级全局 _dataBaseDir（getTasksIndexDatabasePath）解析：
  // vitest threads 池会在同一进程并发跑多个测试文件，各文件的 setDataBaseDir(tempDir)
  // 互相覆盖全局值，导致 repo 与裸 SQL 操作在并发窗口内写进真实库 ~/.zcode/v2（历史脏数据
  // /tmp/ws 系列即因此污染）。改为构造期固定一份 dbPath，测试通过依赖注入传入临时库路径，
  // 生产路径不传则回退 getTasksIndexDatabasePath，向后兼容。
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
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
      // ignore
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db))
      this.migrationBackupSkipped = (await runTasksDatabaseMigrations(this.db, path)).backupSkipped;
  }

  protected getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("AutomationRepo 未初始化：请先 await ensureReady()");
    }
    return this.db;
  }

  // workspaceKey 传入时强制归属校验（写/单查路径,防跨 workspace 越界）；省略=不加过滤,
  // 供 scheduler/host 跨 workspace 的调度状态机使用。
  protected getRow(automationId: string, workspaceKey?: string): AutomationRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT * FROM automations
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .get({ id: automationId, workspace_key: workspaceKey ?? null }) as AutomationRow | undefined;
    return row ?? null;
  }
}
