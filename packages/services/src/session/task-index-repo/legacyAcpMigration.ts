import type { ZCodeTaskMeta } from "@zcode/shared";

import { type DatabaseSyncInstance, type SQLInputValue } from "./database.js";
import { taskIndexLogger } from "./logging.js";
import { migrateLegacyTaskMetaJson } from "./rowMapping.js";
import type { LegacyAcpTaskIndexRow, TaskIndexRow } from "./types.js";

function hasColumn(database: DatabaseSyncInstance, table: string, column: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return columns.some((item) => item.name === column);
}

/**
 * 存量回填（幂等，每次 bootstrap 自愈）：打点上线前产生的 off-peak 会话行没有
 * offPeakTaskId。off_peak_tasks 与 tasks 同库（tasks-index.sqlite），按 session 绑定
 * join 只补投影列——rowToMeta 以列兜底即可生效，下次展示更新会回填 meta_json。
 * 全新安装时 off_peak_tasks 可能尚未由 OffPeakTaskRepo 建表，需 guard。
 */
export function backfillOffPeakTaskMarkers(database: DatabaseSyncInstance): void {
  const hasOffPeakTable = database
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'off_peak_tasks'`)
    .get();
  if (!hasOffPeakTable) {
    return;
  }
  database
    .prepare(
      `UPDATE tasks SET off_peak_task_id = (
          SELECT o.off_peak_task_id FROM off_peak_tasks o
          WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
        )
        WHERE off_peak_task_id IS NULL
          AND EXISTS (
            SELECT 1 FROM off_peak_tasks o
            WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
          )`,
    )
    .run();
}

export function migrateLegacyAcpTaskIds(db: DatabaseSyncInstance): void {
  if (!hasColumn(db, "tasks", "acp_session_id")) {
    return;
  }

  const rows = db
    .prepare(
      `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          acp_session_id,
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
        WHERE acp_session_id IS NOT NULL
          AND trim(acp_session_id) <> ''
          AND trim(acp_session_id) <> task_id`,
    )
    .all() as unknown as LegacyAcpTaskIndexRow[];
  if (rows.length === 0) {
    return;
  }

  const findTarget = db.prepare(
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
  );
  const updateRow = db.prepare(
    `UPDATE tasks
      SET task_id = @task_id,
        title = @title,
        task_status = @task_status,
        provider = @provider,
        mode = @mode,
        model = @model,
        migration_source = @migration_source,
        forked_from_task_id = @forked_from_task_id,
        created_at = @created_at,
        updated_at = @updated_at,
        unread_at = @unread_at,
        last_unread_at = @last_unread_at,
        pinned = @pinned,
        archived = @archived,
        deleted = @deleted,
        title_overridden = @title_overridden,
        searchable_text = @searchable_text,
        meta_json = @meta_json,
        acp_session_id = NULL
      WHERE workspace_key = @workspace_key AND task_id = @old_task_id`,
  );
  const updateTarget = db.prepare(
    `UPDATE tasks
      SET title = @title,
        task_status = @task_status,
        provider = @provider,
        mode = @mode,
        model = @model,
        migration_source = @migration_source,
        forked_from_task_id = @forked_from_task_id,
        created_at = @created_at,
        updated_at = @updated_at,
        unread_at = @unread_at,
        last_unread_at = @last_unread_at,
        pinned = @pinned,
        archived = @archived,
        deleted = @deleted,
        title_overridden = @title_overridden,
        searchable_text = @searchable_text,
        meta_json = @meta_json
      WHERE workspace_key = @workspace_key AND task_id = @task_id`,
  );
  const deleteOld = db.prepare(`DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?`);

  db.exec("BEGIN IMMEDIATE");
  try {
    let migrated = 0;
    for (const row of rows) {
      const nextTaskId = row.acp_session_id?.trim();
      if (!nextTaskId) {
        continue;
      }
      const target = findTarget.get(row.workspace_key, nextTaskId) as TaskIndexRow | undefined;
      const merged = buildLegacyAcpMigratedRow(row, target ?? null, nextTaskId);
      if (target) {
        updateTarget.run(merged);
        deleteOld.run(row.workspace_key, row.task_id);
      } else {
        updateRow.run({ ...merged, old_task_id: row.task_id });
      }
      migrated += 1;
    }
    db.exec("COMMIT");
    if (migrated > 0) {
      taskIndexLogger.info(
        undefined,
        `已迁移 legacy ACP task_id 到 ZCode session id 数量=${migrated}`,
      );
    }
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function buildLegacyAcpMigratedRow(
  source: LegacyAcpTaskIndexRow,
  target: TaskIndexRow | null,
  taskId: string,
): Record<string, SQLInputValue> {
  const sourceMeta = migrateLegacyTaskMetaJson(source.meta_json, {
    taskId,
    workspacePath: source.workspace_path,
    workspaceIdentity: source.workspace_identity ?? undefined,
    title: source.title,
    createdAt: source.created_at,
    updatedAt: source.updated_at,
    mode: source.mode,
    provider: source.provider ?? undefined,
    model: source.model ?? undefined,
    status: source.task_status ? (source.task_status as ZCodeTaskMeta["status"]) : undefined,
  });
  if (!target) {
    return {
      workspace_key: source.workspace_key,
      task_id: taskId,
      title: source.title,
      task_status: source.task_status,
      provider: source.provider,
      mode: source.mode,
      model: source.model,
      migration_source: null,
      forked_from_task_id: source.forked_from_task_id,
      created_at: source.created_at,
      updated_at: source.updated_at,
      unread_at: source.unread_at,
      last_unread_at: Math.max(source.last_unread_at, source.unread_at ?? 0),
      pinned: source.pinned,
      archived: source.archived,
      deleted: source.deleted,
      title_overridden: source.title_overridden,
      searchable_text: source.searchable_text,
      meta_json: JSON.stringify(sourceMeta),
    };
  }

  const targetMeta = migrateLegacyTaskMetaJson(target.meta_json, {
    ...sourceMeta,
    taskId,
    workspacePath: target.workspace_path,
    workspaceIdentity: target.workspace_identity ?? undefined,
    title: target.title || source.title,
    createdAt: Math.min(target.created_at, source.created_at),
    updatedAt: Math.max(target.updated_at, source.updated_at),
    mode: target.mode || source.mode,
    provider: target.provider ?? source.provider ?? undefined,
    model: target.model ?? source.model ?? undefined,
    status: target.task_status
      ? (target.task_status as ZCodeTaskMeta["status"])
      : source.task_status
        ? (source.task_status as ZCodeTaskMeta["status"])
        : undefined,
  });
  const title = source.title_overridden === 1 ? source.title : target.title || source.title;
  const updatedAt = Math.max(target.updated_at, source.updated_at);
  const unreadAt =
    source.unread_at !== null && target.unread_at !== null
      ? Math.max(source.unread_at, target.unread_at)
      : (source.unread_at ?? target.unread_at);
  return {
    workspace_key: source.workspace_key,
    task_id: taskId,
    title,
    task_status: target.task_status ?? source.task_status,
    provider: target.provider ?? source.provider,
    mode: target.mode || source.mode,
    model: target.model ?? source.model,
    migration_source: null,
    forked_from_task_id: target.forked_from_task_id ?? source.forked_from_task_id,
    created_at: Math.min(target.created_at, source.created_at),
    updated_at: updatedAt,
    unread_at: unreadAt,
    last_unread_at: Math.max(source.last_unread_at, target.last_unread_at, unreadAt ?? 0),
    pinned: source.pinned === 1 || target.pinned === 1 ? 1 : 0,
    archived: source.archived === 1 || target.archived === 1 ? 1 : 0,
    deleted: source.deleted === 1 ? 1 : target.deleted,
    title_overridden: source.title_overridden === 1 || target.title_overridden === 1 ? 1 : 0,
    searchable_text: target.searchable_text || source.searchable_text,
    meta_json: JSON.stringify({
      ...targetMeta,
      title,
      updatedAt,
      unreadAt: unreadAt ?? undefined,
      migrationSource: undefined,
    }),
  };
}
