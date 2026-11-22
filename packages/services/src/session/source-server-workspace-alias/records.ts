import { cancelConflictingOffPeakBindings } from "#src/session/offPeakWorkspaceIdentityMigration.js";
import { hasColumn, hasTable, rollbackQuietly, type Database } from "./database.js";
import {
  SourceServerWorkspaceIdentityConflictError,
  type SourceServerWorkspaceAliasContext,
  type WorkspaceTaskIdentityConflict,
} from "./types.js";

const TASK_IDENTITY_META_FIELDS = [
  ["cronAutomationId", "cron_automation_id"],
  ["offPeakTaskId", "off_peak_task_id"],
  ["forkedFromTaskId", "forked_from_task_id"],
] as const;

interface TaskCliFactsRow {
  cli_title: string | null;
  cli_title_source: string | null;
  cli_created_at: number | null;
  cli_updated_at: number | null;
  cli_last_outcome: string | null;
  cli_deleted: number | null;
  handoff_pending: number;
}

/**
 * Bug 原因：项目化索引从 cli_* 列投影标题、时间与状态；只合并旧列会在删除 source 后丢失
 * 其中较新的 CLI 事实。沿用 TaskIndexRepo.applyCliFacts 的规则：时间取最早/最晚，
 * 较新 outcome 为空时保留旧值，custom 标题不被非 custom 覆盖，待交接标记取并集。
 */
function mergeTaskCliFacts(newer: TaskCliFactsRow, older: TaskCliFactsRow): TaskCliFactsRow {
  const title =
    older.cli_title_source === "custom" && newer.cli_title_source !== "custom" ? older : newer;
  const times = (key: "cli_created_at" | "cli_updated_at") =>
    [newer[key], older[key]].filter((value): value is number => value !== null);
  const created = times("cli_created_at");
  const updated = times("cli_updated_at");
  return {
    cli_title: title.cli_title,
    cli_title_source: title.cli_title_source,
    cli_created_at: created.length ? Math.min(...created) : null,
    cli_updated_at: updated.length ? Math.max(...updated) : null,
    cli_last_outcome: newer.cli_last_outcome ?? older.cli_last_outcome,
    cli_deleted:
      newer.cli_deleted === null && older.cli_deleted === null
        ? null
        : Math.max(newer.cli_deleted ?? 0, older.cli_deleted ?? 0),
    handoff_pending: newer.handoff_pending | older.handoff_pending,
  };
}

interface WorkspaceTaskMetaRow {
  meta_json: string;
  updated_at: number;
  cron_automation_id: string | null;
  off_peak_task_id: string | null;
  forked_from_task_id: string | null;
}

export function parseMetaRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mergeTaskMetaJson(
  canonical: WorkspaceTaskMetaRow,
  source: WorkspaceTaskMetaRow,
  canonicalKey: string,
): { status: "merged"; metaJson: string } | { status: "identity-conflict" } {
  const canonicalMeta = parseMetaRecord(canonical.meta_json);
  const sourceMeta = parseMetaRecord(source.meta_json);
  // Bug 原因：历史身份可能只回填索引列，相同 JSON 也可能对应不同身份。
  // 与 TaskIndexRepo 读取一致，先补齐有效身份，再由预检和写事务共用同一冲突规则。
  for (const [key, column] of TASK_IDENTITY_META_FIELDS) {
    const canonicalValue = canonicalMeta?.[key] ?? canonical[column] ?? undefined;
    const sourceValue = sourceMeta?.[key] ?? source[column] ?? undefined;
    if (
      canonicalValue !== undefined &&
      sourceValue !== undefined &&
      canonicalValue !== sourceValue
    ) {
      return { status: "identity-conflict" };
    }
    if (canonicalMeta && canonicalValue !== undefined) canonicalMeta[key] = canonicalValue;
    if (sourceMeta && sourceValue !== undefined) sourceMeta[key] = sourceValue;
  }
  if (!canonicalMeta || !sourceMeta) {
    return canonical.meta_json === source.meta_json
      ? { status: "merged", metaJson: canonical.meta_json }
      : { status: "identity-conflict" };
  }
  const [older, newer] =
    canonical.updated_at <= source.updated_at
      ? [canonicalMeta, sourceMeta]
      : [sourceMeta, canonicalMeta];
  const merged = { ...older, ...newer };
  if ("workspaceIdentity" in merged) merged.workspaceIdentity = canonicalKey;
  return { status: "merged", metaJson: JSON.stringify(merged) };
}

export function findTaskIdentityConflicts(
  db: Database,
  workspacePath: string,
  canonicalKey: string,
  mergedKeys: string[],
): WorkspaceTaskIdentityConflict[] {
  if (!hasTable(db, "tasks")) return [];
  const listTasks = db.prepare(
    "SELECT task_id, meta_json, updated_at, cron_automation_id, off_peak_task_id, forked_from_task_id FROM tasks WHERE workspace_key = ? AND workspace_path = ?",
  );
  const findCanonical = db.prepare(
    "SELECT task_id, meta_json, updated_at, cron_automation_id, off_peak_task_id, forked_from_task_id FROM tasks WHERE workspace_key = ? AND task_id = ?",
  );
  // Bug 原因：写事务按 mergedKeys 顺序把 source 逐个并入 canonical，后一个 source 比较的是
  // 已累积的合并结果；预检只比 canonical 快照，canonical 缺该 task 或缺身份字段时会漏掉
  // source 之间的冲突，备份后才在写事务里失败，每次打开都重新建账、备份两库。
  // 预检按同一顺序累积每个 taskId 的合并结果，和写事务用同一条冲突规则。
  const merged = new Map<string, WorkspaceTaskMetaRow>();
  const conflicts: WorkspaceTaskIdentityConflict[] = [];
  for (const sourceKey of mergedKeys) {
    const rows = listTasks.all(sourceKey, workspacePath) as unknown as Array<
      WorkspaceTaskMetaRow & { task_id: string }
    >;
    for (const row of rows) {
      const target =
        merged.get(row.task_id) ??
        (findCanonical.get(canonicalKey, row.task_id) as WorkspaceTaskMetaRow | undefined);
      if (!target) {
        merged.set(row.task_id, row);
        continue;
      }
      const result = mergeTaskMetaJson(target, row, canonicalKey);
      if (result.status === "identity-conflict") {
        conflicts.push({ taskId: row.task_id, sourceKey });
        continue;
      }
      // 无冲突时每个身份字段至多一个取值，取并集即写事务投影后的有效身份。
      merged.set(row.task_id, {
        meta_json: result.metaJson,
        updated_at: Math.max(target.updated_at, row.updated_at),
        cron_automation_id: target.cron_automation_id ?? row.cron_automation_id,
        off_peak_task_id: target.off_peak_task_id ?? row.off_peak_task_id,
        forked_from_task_id: target.forked_from_task_id ?? row.forked_from_task_id,
      });
    }
  }
  return conflicts;
}

export function mergeTaskDatabase(
  ctx: SourceServerWorkspaceAliasContext,
  db: Database,
  workspacePath: string,
  canonicalKey: string,
  mergedKeys: string[],
): void {
  if (!hasTable(db, "tasks")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const conflicts = findTaskIdentityConflicts(db, workspacePath, canonicalKey, mergedKeys);
    if (conflicts.length > 0) {
      // Bug 原因：独立 preflight 与真正写事务之间仍有竞态窗口。冲突复检必须在
      // BEGIN IMMEDIATE 取得写锁后完成，失败时由本事务整体回滚，再写审计报告。
      throw new SourceServerWorkspaceIdentityConflictError(workspacePath, conflicts);
    }
    const listTasks = db.prepare(
      "SELECT task_id, title, created_at, updated_at, pinned, archived, deleted, title_overridden, searchable_text, unread_at, last_unread_at, task_status, provider, mode, model, migration_source, forked_from_task_id, cron_automation_id, off_peak_task_id, meta_json FROM tasks WHERE workspace_key = ? AND workspace_path = ?",
    );
    const findCanonical = db.prepare(
      "SELECT task_id, title, created_at, updated_at, pinned, archived, deleted, title_overridden, searchable_text, unread_at, last_unread_at, task_status, provider, mode, model, migration_source, forked_from_task_id, cron_automation_id, off_peak_task_id, meta_json FROM tasks WHERE workspace_key = ? AND task_id = ?",
    );
    const moveTask = db.prepare(
      "UPDATE tasks SET workspace_key = ?, workspace_identity = ?, meta_json = ? WHERE workspace_key = ? AND task_id = ?",
    );
    const mergeTask = db.prepare(`
        UPDATE tasks SET
          created_at = MIN(created_at, ?),
          updated_at = MAX(updated_at, ?),
          pinned = MAX(pinned, ?),
          archived = MAX(archived, ?),
          deleted = MAX(deleted, ?),
          title = CASE WHEN title_overridden = 1 THEN title WHEN ? = 1 THEN ? ELSE title END,
          title_overridden = MAX(title_overridden, ?),
          searchable_text = CASE WHEN searchable_text <> '' THEN searchable_text ELSE ? END,
          unread_at = ?,
          last_unread_at = ?,
          task_status = ?,
          provider = ?,
          mode = ?,
          model = ?,
          migration_source = ?,
          forked_from_task_id = ?,
          cron_automation_id = ?,
          off_peak_task_id = ?,
          meta_json = ?
        WHERE workspace_key = ? AND task_id = ?
      `);
    const deleteTask = db.prepare("DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?");
    // 只跑过 tasks schema 迁移的库没有项目化列，此时旧列已是全部事实。
    const hasCliFacts = hasColumn(db, "tasks", "cli_updated_at");
    const readCliFacts = db.prepare(
      hasCliFacts
        ? "SELECT cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending FROM tasks WHERE workspace_key = ? AND task_id = ?"
        : "SELECT NULL WHERE 0",
    );
    const writeCliFacts = db.prepare(
      hasCliFacts
        ? "UPDATE tasks SET cli_title = ?, cli_title_source = ?, cli_created_at = ?, cli_updated_at = ?, cli_last_outcome = ?, cli_deleted = ?, handoff_pending = ? WHERE workspace_key = ? AND task_id = ?"
        : "SELECT NULL WHERE 0",
    );
    for (const sourceKey of mergedKeys) {
      const rows = listTasks.all(sourceKey, workspacePath) as unknown as Array<{
        task_id: string;
        title: string;
        created_at: number;
        updated_at: number;
        pinned: number;
        archived: number;
        deleted: number;
        title_overridden: number;
        searchable_text: string;
        unread_at: number | null;
        last_unread_at: number;
        task_status: string | null;
        provider: string | null;
        mode: string;
        model: string | null;
        migration_source: string | null;
        forked_from_task_id: string | null;
        cron_automation_id: string | null;
        off_peak_task_id: string | null;
        meta_json: string;
      }>;
      for (const row of rows) {
        const existing = findCanonical.get(canonicalKey, row.task_id) as typeof row | undefined;
        if (!existing) {
          const meta = parseMetaRecord(row.meta_json);
          const movedMetaJson =
            meta && "workspaceIdentity" in meta
              ? JSON.stringify({ ...meta, workspaceIdentity: canonicalKey })
              : row.meta_json;
          moveTask.run(canonicalKey, canonicalKey, movedMetaJson, sourceKey, row.task_id);
          continue;
        }
        const metaMerge = mergeTaskMetaJson(existing, row, canonicalKey);
        if (metaMerge.status === "identity-conflict") {
          throw new SourceServerWorkspaceIdentityConflictError(workspacePath, [
            { taskId: row.task_id, sourceKey },
          ]);
        }
        // Bug 原因：只合并壳字段后删除 source 会永久丢失正文索引和未读状态。
        // 在删除前保留可搜索正文，并延续索引已有的未读 marker 合并规则。
        const unreadAt =
          existing.unread_at !== null && row.unread_at !== null
            ? Math.max(existing.unread_at, row.unread_at)
            : (existing.unread_at ?? row.unread_at);
        // Bug 原因：meta 已按新旧合并，查询投影却保留 canonical 旧值，导致状态过滤和身份反查失真。
        // 从合并后的 meta 重建投影；旧 meta 未携带的字段沿用索引列，保留历史回填的身份。
        const mergedMeta = parseMetaRecord(metaMerge.metaJson);
        const [newer, older] =
          existing.updated_at <= row.updated_at ? [row, existing] : [existing, row];
        const project = (key: string, legacyValue: string | null): string | null => {
          const value = mergedMeta?.[key];
          return typeof value === "string" ? value : legacyValue;
        };
        mergeTask.run(
          row.created_at,
          row.updated_at,
          row.pinned,
          row.archived,
          row.deleted,
          row.title_overridden,
          row.title,
          row.title_overridden,
          row.searchable_text,
          unreadAt,
          Math.max(existing.last_unread_at, row.last_unread_at, unreadAt ?? 0),
          project("status", newer.task_status ?? older.task_status),
          project("provider", newer.provider ?? older.provider),
          project("mode", newer.mode),
          project("model", newer.model ?? older.model),
          project("migrationSource", newer.migration_source ?? older.migration_source),
          project("forkedFromTaskId", newer.forked_from_task_id ?? older.forked_from_task_id),
          project("cronAutomationId", newer.cron_automation_id ?? older.cron_automation_id),
          project("offPeakTaskId", newer.off_peak_task_id ?? older.off_peak_task_id),
          metaMerge.metaJson,
          canonicalKey,
          row.task_id,
        );
        if (hasCliFacts) {
          const canonicalFacts = readCliFacts.get(
            canonicalKey,
            row.task_id,
          ) as unknown as TaskCliFactsRow;
          const sourceFacts = readCliFacts.get(
            sourceKey,
            row.task_id,
          ) as unknown as TaskCliFactsRow;
          // Bug 原因：旧 ACP ID 合并只抬高 updated_at、不改 cli_*，两列在存量库中会分叉；按
          // updated_at 选胜者会把较旧的状态/标题配上较新的 cli_updated_at。CLI 事实只按自身
          // 时间裁决，无事实的一方不胜出，同时间沿用 source 优先。
          const cliTime = (facts: TaskCliFactsRow) =>
            facts.cli_updated_at ?? Number.NEGATIVE_INFINITY;
          const facts =
            cliTime(canonicalFacts) <= cliTime(sourceFacts)
              ? mergeTaskCliFacts(sourceFacts, canonicalFacts)
              : mergeTaskCliFacts(canonicalFacts, sourceFacts);
          writeCliFacts.run(
            facts.cli_title,
            facts.cli_title_source,
            facts.cli_created_at,
            facts.cli_updated_at,
            facts.cli_last_outcome,
            facts.cli_deleted,
            facts.handoff_pending,
            canonicalKey,
            row.task_id,
          );
        }
        deleteTask.run(sourceKey, row.task_id);
      }
      if (hasTable(db, "task_group_members")) {
        db.prepare(`DELETE FROM task_group_members
            WHERE workspace_key = ? AND EXISTS (
              SELECT 1 FROM task_group_members target
              WHERE target.workspace_key = ? AND target.task_id = task_group_members.task_id
            )`).run(sourceKey, canonicalKey);
        db.prepare(
          "UPDATE task_group_members SET workspace_key = ?, workspace_identity = ? WHERE workspace_key = ?",
        ).run(canonicalKey, canonicalKey, sourceKey);
      }
      if (hasTable(db, "task_group_workspace_bootstraps")) {
        const canonicalBootstrap = db
          .prepare("SELECT 1 FROM task_group_workspace_bootstraps WHERE workspace_key = ?")
          .get(canonicalKey);
        if (canonicalBootstrap) {
          db.prepare("DELETE FROM task_group_workspace_bootstraps WHERE workspace_key = ?").run(
            sourceKey,
          );
        } else {
          db.prepare(
            "UPDATE task_group_workspace_bootstraps SET workspace_key = ? WHERE workspace_key = ?",
          ).run(canonicalKey, sourceKey);
        }
      }
      migrateTaskNodeOrders(db, sourceKey, canonicalKey);
      updateWorkspaceIdentityColumns(db, "automations", sourceKey, canonicalKey);
      updateWorkspaceIdentityColumns(db, "automation_runs", sourceKey, canonicalKey);
      cancelConflictingOffPeakBindings(db, sourceKey, canonicalKey, ctx.now());
      updateWorkspaceIdentityColumns(db, "off_peak_tasks", sourceKey, canonicalKey);
    }
    db.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

function migrateTaskNodeOrders(db: Database, sourceKey: string, canonicalKey: string): void {
  if (!hasTable(db, "task_group_view_node_orders")) return;
  const rows = db
    .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
    .all() as unknown as Array<{ node_key: string }>;
  const deleteRow = db.prepare(
    "DELETE FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?",
  );
  const updateRow = db.prepare(
    "UPDATE task_group_view_node_orders SET node_key = ? WHERE node_type = 'task' AND node_key = ?",
  );
  const targetExists = db.prepare(
    "SELECT 1 FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?",
  );
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.node_key);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== sourceKey) continue;
    const canonicalNodeKey = JSON.stringify([canonicalKey, parsed[1]]);
    if (targetExists.get(canonicalNodeKey)) {
      deleteRow.run(row.node_key);
    } else {
      updateRow.run(canonicalNodeKey, row.node_key);
    }
  }
}

function updateWorkspaceIdentityColumns(
  db: Database,
  table: "automations" | "automation_runs" | "off_peak_tasks",
  sourceKey: string,
  canonicalKey: string,
): void {
  if (!hasTable(db, table) || !hasColumn(db, table, "workspace_key")) return;
  if (hasColumn(db, table, "workspace_identity")) {
    db.prepare(
      `UPDATE ${table} SET workspace_key = ?, workspace_identity = ? WHERE workspace_key = ?`,
    ).run(canonicalKey, canonicalKey, sourceKey);
    return;
  }
  db.prepare(`UPDATE ${table} SET workspace_key = ? WHERE workspace_key = ?`).run(
    canonicalKey,
    sourceKey,
  );
}
