import { readdir } from "node:fs/promises";
import { isRemoteWorkspaceIdentity, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { getSessionConfigDirectory } from "./configDirectories.js";
import { hasColumn, hasTable, type Database } from "./database.js";
import { pathExists } from "./fileSystem.js";
import {
  WORKSPACE_PATH_TABLES,
  type SourceServerWorkspaceAliasContext,
  type WorkspaceActivityRow,
} from "./types.js";

export function isLegacyRemoteKey(value: string): boolean {
  return (
    isRemoteWorkspaceIdentity(value) &&
    (value.startsWith("remote:ssh:") ||
      value.startsWith("remote:wsl:") ||
      value.startsWith("remote:docker:"))
  );
}

export function findVariants(
  taskDb: Database,
  sessionDb: Database | null,
  workspacePath: string,
): string[] {
  const variants = new Set<string>();
  for (const table of WORKSPACE_PATH_TABLES) {
    if (
      !hasTable(taskDb, table) ||
      !hasColumn(taskDb, table, "workspace_key") ||
      !hasColumn(taskDb, table, "workspace_path")
    ) {
      continue;
    }
    const rows = taskDb
      .prepare(
        `SELECT DISTINCT workspace_key FROM ${table}
           WHERE workspace_path = ? AND workspace_key LIKE 'remote:%'`,
      )
      .all(workspacePath) as unknown as Array<{ workspace_key: string }>;
    for (const row of rows)
      if (isLegacyRemoteKey(row.workspace_key)) variants.add(row.workspace_key);
  }
  for (const table of ["task_group_workspace_bootstraps", "automation_runs"] as const) {
    if (!hasTable(taskDb, table) || !hasColumn(taskDb, table, "workspace_key")) continue;
    const rows = taskDb
      .prepare(`SELECT DISTINCT workspace_key FROM ${table} WHERE workspace_key LIKE 'remote:%'`)
      .all() as unknown as Array<{ workspace_key: string }>;
    for (const row of rows) {
      if (
        isLegacyRemoteKey(row.workspace_key) &&
        parseRemoteWorkspaceIdentity(row.workspace_key)?.workspacePath === workspacePath
      ) {
        variants.add(row.workspace_key);
      }
    }
  }
  if (hasTable(taskDb, "task_group_view_node_orders")) {
    const rows = taskDb
      .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
      .all() as unknown as Array<{ node_key: string }>;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.node_key) as unknown;
        const workspaceKey = Array.isArray(parsed) ? parsed[0] : null;
        if (
          typeof workspaceKey === "string" &&
          isLegacyRemoteKey(workspaceKey) &&
          parseRemoteWorkspaceIdentity(workspaceKey)?.workspacePath === workspacePath
        ) {
          variants.add(workspaceKey);
        }
      } catch {
        // 非结构化 node key 不属于 workspace task 排序记录。
      }
    }
  }
  if (sessionDb && hasTable(sessionDb, "session")) {
    const rows = sessionDb
      .prepare(
        "SELECT DISTINCT workspace_id FROM session WHERE (directory = ? OR path = ?) AND workspace_id LIKE 'remote:%'",
      )
      .all(workspacePath, workspacePath) as unknown as Array<{ workspace_id: string }>;
    for (const row of rows) if (isLegacyRemoteKey(row.workspace_id)) variants.add(row.workspace_id);
  }
  return [...variants].sort();
}

export async function hasWorkspaceOwnedStateForHint(
  ctx: SourceServerWorkspaceAliasContext,
  taskDb: Database,
  workspacePath: string,
  workspaceKey: string,
): Promise<boolean> {
  for (const table of [
    "tasks",
    "task_group_members",
    "task_group_workspace_bootstraps",
    "automations",
    "automation_runs",
    "off_peak_tasks",
  ] as const) {
    if (
      hasTable(taskDb, table) &&
      hasColumn(taskDb, table, "workspace_key") &&
      taskDb.prepare(`SELECT 1 FROM ${table} WHERE workspace_key = ? LIMIT 1`).get(workspaceKey)
    ) {
      return true;
    }
  }
  if (hasTable(taskDb, "task_group_view_node_orders")) {
    const rows = taskDb
      .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
      .all() as unknown as Array<{ node_key: string }>;
    if (
      rows.some((row) => {
        try {
          const parsed = JSON.parse(row.node_key) as unknown;
          return Array.isArray(parsed) && parsed[0] === workspaceKey;
        } catch {
          return false;
        }
      })
    ) {
      return true;
    }
  }
  const configDir = getSessionConfigDirectory(ctx, workspacePath, workspaceKey);
  if (!(await pathExists(configDir))) return false;
  return (await readdir(configDir)).length > 0;
}

export function chooseCanonicalKey(
  taskDb: Database,
  sessionDb: Database | null,
  workspacePath: string,
  variants: string[],
): string {
  const activity = new Map(variants.map((key) => [key, 0]));
  for (const table of WORKSPACE_PATH_TABLES) {
    if (
      !hasTable(taskDb, table) ||
      !hasColumn(taskDb, table, "workspace_key") ||
      !hasColumn(taskDb, table, "workspace_path") ||
      !hasColumn(taskDb, table, "updated_at")
    ) {
      continue;
    }
    const rows = taskDb
      .prepare(
        `SELECT workspace_key, MAX(updated_at) AS last_active_at FROM ${table}
           WHERE workspace_path = ? GROUP BY workspace_key`,
      )
      .all(workspacePath) as unknown as WorkspaceActivityRow[];
    for (const row of rows) {
      if (activity.has(row.workspace_key)) {
        activity.set(
          row.workspace_key,
          Math.max(activity.get(row.workspace_key) ?? 0, row.last_active_at),
        );
      }
    }
  }
  if (sessionDb && hasTable(sessionDb, "session")) {
    const rows = sessionDb
      .prepare(
        "SELECT workspace_id AS workspace_key, MAX(time_updated) AS last_active_at FROM session WHERE directory = ? OR path = ? GROUP BY workspace_id",
      )
      .all(workspacePath, workspacePath) as unknown as WorkspaceActivityRow[];
    for (const row of rows) {
      if (activity.has(row.workspace_key)) {
        activity.set(
          row.workspace_key,
          Math.max(activity.get(row.workspace_key) ?? 0, row.last_active_at),
        );
      }
    }
  }
  return [...variants].sort((left, right) => {
    const activityOrder = (activity.get(right) ?? 0) - (activity.get(left) ?? 0);
    return activityOrder || left.localeCompare(right);
  })[0]!;
}
