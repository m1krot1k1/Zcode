import type { ZCodeTaskMeta, ZCodeProvider } from "@zcode/shared";
import type { ZCodeTaskListQuery, ZCodeTaskListResult } from "#src/session/zcodeTaskListTypes.js";

import { TaskIndexRepoCore } from "./core.js";
import {
  appendZCodeAgentIndexedProviderFilter,
  isUncommittedSessionReservation,
  normalizeLimit,
  normalizeWorkspaceKeys,
  rowToMeta,
  rowToTaskListItem,
  serializeMetaJson,
  workspaceKey,
} from "./rowMapping.js";
import type { TaskIndexRow, TaskIndexStatePatch } from "./types.js";

/** task index 的公共读写端口：CLI 事实同步与组织态写入/查询。 */
export class TaskIndexRepo extends TaskIndexRepoCore {
  async listReconciliationRows(target: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<Array<{ meta: ZCodeTaskMeta; handoffPending: number }>> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare("SELECT * FROM tasks WHERE workspace_key=?")
      .all(workspaceKey(target)) as unknown as TaskIndexRow[];
    return rows.flatMap((row) => {
      // Bugfix: 创建会话前的空 meta 预留行不是 CLI 事实，不能投影为任务或记录非法 meta 警告。
      if (isUncommittedSessionReservation(row)) return [];
      return [{ meta: rowToMeta(row), handoffPending: row.handoff_pending ?? 0 }];
    });
  }

  /** CLI 确认 child 后移除旧版本误建的派生行，不修改会话正文或 CLI deleted。 */
  async removeSubagentIndexRow(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      this.getDatabase()
        .prepare("DELETE FROM tasks WHERE workspace_key=? AND task_id=?")
        .run(workspaceKey(target), target.taskId);
    });
  }

  async markCliOrphan(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      this.getDatabase()
        .prepare(
          "UPDATE tasks SET handoff_pending=handoff_pending | 4 WHERE workspace_key=? AND task_id=?",
        )
        .run(workspaceKey(target), target.taskId);
    });
  }

  /** 仅 syncer 消费 CLI 明确删除，不以列表缺席推断删除。 */
  async applyCliDeletion(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE tasks SET cli_deleted=1,deleted=1,handoff_pending=handoff_pending & ~1 WHERE workspace_key=? AND task_id=?",
        ).run(workspaceKey(target), target.taskId);
        const row = this.getTaskRow(target);
        if (row) this.admitTaskGroup(rowToMeta(row), row.archived === 1, true);
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 仅 syncer 调用：CLI 事实是唯一来源，组织态写者不得合成这些值。 */
  async applyCliFacts(params: {
    meta: ZCodeTaskMeta;
    titleSource?: string;
    lastOutcome?: "completed" | "interrupted" | "error";
    deleted?: boolean;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params.meta, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.getTaskRow(params.meta);
        // 预留行尚无 CLI 事实。首条事实补齐 provider/展示基线，保留预留后发生的组织操作。
        if (!existing || (existing.cli_created_at == null && existing.created_at === 0))
          this.writeRecord({
            meta: {
              ...params.meta,
              ...(existing?.title_overridden === 1 ? { title: existing.title } : {}),
            },
            pinned: existing?.pinned === 1,
            archived: existing?.archived === 1,
            deleted: existing?.deleted === 1,
            titleOverridden: existing?.title_overridden === 1,
          });
        const source = params.titleSource ?? "default";
        db.prepare(`UPDATE tasks SET
          cli_title=CASE WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title ELSE ? END,
          cli_title_source=CASE WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title_source ELSE ? END,
          cli_created_at=?,cli_updated_at=max(coalesce(cli_updated_at,0),?),
          cli_last_outcome=coalesce(?,cli_last_outcome),cli_deleted=max(coalesce(cli_deleted,0),?),
          title=CASE WHEN (handoff_pending & 2)<>0 THEN title WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title ELSE ? END,
          title_overridden=CASE WHEN (handoff_pending & 2)<>0 THEN title_overridden WHEN ?='custom' OR cli_title_source='custom' THEN 1 ELSE 0 END,
          updated_at=?,created_at=?,task_status=coalesce(?,task_status),deleted=max(deleted,?),
          handoff_pending=(handoff_pending & ~4) & CASE WHEN ?=1 THEN ~1 ELSE -1 END & CASE WHEN ?=title AND ?='custom' THEN ~2 ELSE -1 END
          WHERE workspace_key=? AND task_id=?`).run(
          source,
          params.meta.title,
          source,
          source,
          params.meta.createdAt,
          params.meta.updatedAt,
          params.lastOutcome ?? null,
          params.deleted ? 1 : 0,
          source,
          params.meta.title,
          source,
          params.meta.updatedAt,
          params.meta.createdAt,
          params.lastOutcome ?? null,
          params.deleted ? 1 : 0,
          params.deleted ? 1 : 0,
          params.meta.title,
          source,
          workspaceKey(params.meta),
          params.meta.taskId,
        );
        const persisted = this.getTaskRow(params.meta)!;
        this.admitTaskGroup(
          rowToMeta(persisted),
          persisted.archived === 1,
          persisted.deleted === 1,
        );
        db.exec("COMMIT");
        return rowToMeta(persisted);
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async clearTaskUnreadIfMatches(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    expectedUnreadAt: number;
  }): Promise<{ meta: ZCodeTaskMeta; cleared: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        // 旧库补列时 watermark 默认为 0；清除前必须吸收现存 marker，避免重启后时钟回拨复用旧值。
        const updated = db
          .prepare(
            "UPDATE tasks SET last_unread_at=max(last_unread_at,unread_at),unread_at=NULL WHERE workspace_key=? AND task_id=? AND deleted=0 AND unread_at=?",
          )
          .run(workspaceKey(params), params.taskId, params.expectedUnreadAt);
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1)
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        db.exec("COMMIT");
        return { meta: rowToMeta(row), cleared: Number(updated.changes) > 0 };
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async deleteArchivedTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        // 确认框可能停留期间被另一端恢复；归档检查必须与 tombstone 写入同事务，
        // 不能先读后删。已删除/不存在也跳过，避免重试从 CLI seed 后复活。
        if (!row || row.deleted === 1 || row.archived !== 1) {
          database.exec("COMMIT");
          return null;
        }
        const meta = this.writeRecord({
          meta: rowToMeta(row),
          pinned: row.pinned === 1,
          archived: true,
          deleted: true,
          titleOverridden: row.title_overridden === 1,
        });
        // 删除事实交给 CLI；持久化意图使中途断线后仍可按既有 handoff 对账完成。
        database
          .prepare(
            "UPDATE tasks SET handoff_pending=handoff_pending | 1 WHERE workspace_key=? AND task_id=?",
          )
          .run(row.workspace_key, row.task_id);
        database.exec("COMMIT");
        return meta;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async updateTaskState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: TaskIndexStatePatch;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1)
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        const hasUnread = "unreadAt" in params.patch;
        // marker 的 watermark 在清除后仍保留；旧手机 CAS 不能清除同毫秒内的新未读。
        const unread =
          typeof params.patch.unreadAt === "number"
            ? Math.max(params.patch.unreadAt, row.last_unread_at + 1, (row.unread_at ?? 0) + 1)
            : null;
        db.prepare(`UPDATE tasks SET pinned=coalesce(?,pinned),archived=coalesce(?,archived),
          unread_at=CASE WHEN ? THEN ? ELSE unread_at END,
          last_unread_at=max(last_unread_at,coalesce(?,0)) WHERE workspace_key=? AND task_id=?`).run(
          params.patch.pinned === undefined ? null : Number(params.patch.pinned),
          params.patch.archived === undefined ? null : Number(params.patch.archived),
          Number(hasUnread),
          unread,
          hasUnread ? unread : null,
          workspaceKey(params),
          params.taskId,
        );
        const result = rowToMeta(this.getTaskRow(params)!);
        this.admitTaskGroup(result, row.archived === 1, row.deleted === 1);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 展示缓存不接受 title/time/status/deleted；CLI 事实由独立端口写入。 */
  async updateTaskPresentation(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    presentation: Partial<
      Pick<
        ZCodeTaskMeta,
        | "mode"
        | "model"
        | "thoughtLevel"
        | "lastError"
        | "target"
        | "migrationSource"
        | "cronAutomationId"
        | "offPeakTaskId"
      >
    >;
    searchableText?: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        if (!row) {
          db.exec("COMMIT");
          return null;
        }
        const meta = { ...rowToMeta(row), ...params.presentation };
        this.getDatabase()
          .prepare(
            `UPDATE tasks SET mode=?,model=?,migration_source=?,cron_automation_id=?,off_peak_task_id=?,meta_json=?,searchable_text=coalesce(?,searchable_text) WHERE workspace_key=? AND task_id=?`,
          )
          .run(
            meta.mode,
            meta.model ?? null,
            meta.migrationSource ?? null,
            meta.cronAutomationId ?? null,
            meta.offPeakTaskId ?? null,
            serializeMetaJson(meta),
            params.searchableText ?? null,
            workspaceKey(params),
            params.taskId,
          );
        const result = rowToMeta(this.getTaskRow(params)!);
        this.admitTaskGroup(result, row.archived === 1, row.deleted === 1);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async listTaskMetas(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    pinned?: boolean;
    archived?: boolean;
    includeDeleted?: boolean;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    // listTaskMetas 支持不传 workspacePath 查询全部任务，但 workspaceKey 只接受必填路径。
    // 先把可选入参收窄成明确的 workspace target，避免类型层把全量查询和 workspace 查询混在一起。
    const targetWorkspaceKey = params.workspacePath
      ? workspaceKey({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        })
      : null;
    const rows = this.getDatabase()
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
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
          AND cli_created_at IS NOT NULL
          AND (@include_deleted = 1 OR (deleted = 0 AND coalesce(cli_deleted,0) = 0))
          -- Bugfix: ZCode Agent 列表只接受当前 glm provider；Claude Code 导入也属于非 glm 历史数据。
          AND (@provider IS NULL OR provider = @provider)
          AND (@pinned IS NULL OR pinned = @pinned)
          AND (@archived IS NULL OR archived = @archived)
        ORDER BY cli_updated_at DESC, cli_created_at DESC, task_id DESC`,
      )
      .all({
        workspace_key: targetWorkspaceKey,
        include_deleted: params.includeDeleted ? 1 : 0,
        provider: params.provider ?? null,
        pinned: typeof params.pinned === "boolean" ? (params.pinned ? 1 : 0) : null,
        archived: typeof params.archived === "boolean" ? (params.archived ? 1 : 0) : null,
      }) as unknown as TaskIndexRow[];
    return rows.map(rowToMeta);
  }

  /**
   * 读取 workspace 下的删除 tombstone。
   *
   * CLI session store 会继续保留会话内容；如果列表 join 只读取 active/pinned/archived，
   * deleted task 会因“不在 archived 集合”被误判成普通 task，并在冷启动后重新出现。
   */
  async listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<string[]> {
    await this.ensureReady();
    const workspaceKeyValue = workspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const rows = this.getDatabase()
      .prepare(
        `SELECT task_id
        FROM tasks
        WHERE workspace_key = @workspace_key
          AND deleted = 1
          AND (@provider IS NULL OR provider = @provider)
        ORDER BY task_id`,
      )
      .all({
        workspace_key: workspaceKeyValue,
        provider: params.provider ?? null,
      }) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  async queryTaskList(
    params: ZCodeTaskListQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeTaskListResult> {
    await this.ensureReady();
    const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
    if (workspaceKeys.length === 0) {
      return { items: [], total: 0, hasMore: false };
    }

    const search = params.search?.trim();
    const normalizedSearchLike =
      search && search.length > 0 ? `%${search.toLocaleLowerCase()}%` : null;
    const where = [
      "deleted = 0",
      "coalesce(cli_deleted,0) = 0",
      "cli_created_at IS NOT NULL",
      `workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`,
    ];
    const args: Array<string | number> = [...workspaceKeys];
    if (params.provider) {
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    if (params.kind === "pinned") {
      where.push("pinned = 1", "archived = 0");
    } else if (params.kind === "archived") {
      where.push("archived = 1");
    } else {
      where.push("pinned = 0", "archived = 0");
    }
    if (normalizedSearchLike) {
      // 之前只按 title 模糊匹配，没有命中聊天正文；TaskSearchDialog 长期搜不到内容。
      // 现在 title 或 searchable_text 任一命中即视为匹配，正文摘要在结果阶段构建。
      where.push(
        "(LOWER(CASE WHEN title_overridden=1 THEN title ELSE cli_title END) LIKE ? OR LOWER(searchable_text) LIKE ?)",
      );
    }

    if (normalizedSearchLike) {
      args.push(normalizedSearchLike, normalizedSearchLike);
    }
    const whereClause = where.join(" AND ");
    const totalRow = this.getDatabase()
      .prepare(`SELECT COUNT(1) AS total FROM tasks WHERE ${whereClause}`)
      .get(...args) as { total: number } | undefined;
    const total = totalRow?.total ?? 0;

    const limit = normalizeLimit(params.limit);
    const listArgs: Array<string | number> = [...args];
    if (limit !== null) {
      listArgs.push(limit);
    }
    const orderBy =
      params.sortBy === "created"
        ? "cli_created_at DESC, cli_updated_at DESC, task_id DESC"
        : "cli_updated_at DESC, cli_created_at DESC, task_id DESC";
    const rows = this.getDatabase()
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
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE ${whereClause}
        ORDER BY ${orderBy}${limit === null ? "" : " LIMIT ?"}`,
      )
      .all(...listArgs) as unknown as TaskIndexRow[];
    const workspacePurposeByKey = new Map(
      params.workspaceScopes.flatMap((scope) =>
        scope.workspacePurpose ? [[workspaceKey(scope), scope.workspacePurpose] as const] : [],
      ),
    );

    return {
      items: rows.map((row) => {
        const item = rowToTaskListItem(row, search ?? null);
        const workspacePurpose = workspacePurposeByKey.get(row.workspace_key);
        return workspacePurpose ? { ...item, workspacePurpose } : item;
      }),
      total,
      hasMore: total > rows.length,
    };
  }

  async getTaskMeta(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    const row = this.getTaskRow(params);
    if (!row || row.deleted === 1) {
      return null;
    }
    return rowToMeta(row);
  }
}
