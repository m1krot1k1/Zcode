import { createHash } from "node:crypto";
import { getSessionConfigDirectory, readSessionConfigEntries } from "./configDirectories.js";
import { hasColumn, hasTable, type Database } from "./database.js";
import type {
  SessionConfigEntries,
  SourceServerWorkspaceAliasContext,
  WorkspaceActivityDigestBaseline,
  WorkspaceActivityDigestVersion,
} from "./types.js";

export function parseVariantKeys(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export function parseAbandonedActivity(raw: string): WorkspaceActivityDigestBaseline {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (
        record.schemaVersion === 2 &&
        record.digests &&
        typeof record.digests === "object" &&
        !Array.isArray(record.digests)
      ) {
        return {
          version: 2,
          digests: parseDigestMap(record.digests as Record<string, unknown>),
        };
      }
      // Bug 原因：旧 abandoned 行没有算法版本；若直接用新增 bootstrap/过滤 node-order
      // 后的算法比较，升级本身就会制造 divergence。无 envelope 的行必须固定按 v1 回放。
      return { version: 1, digests: parseDigestMap(record) };
    }
    return { version: 1, digests: {} };
  } catch {
    return { version: 1, digests: {} };
  }
}

function parseDigestMap(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export async function computeVariantActivityDigests(
  ctx: SourceServerWorkspaceAliasContext,
  taskDb: Database,
  sessionDb: Database | null,
  workspacePath: string,
  variants: string[],
  version: WorkspaceActivityDigestVersion = 2,
  configSnapshots?: ReadonlyMap<string, SessionConfigEntries>,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const variant of [...variants].sort()) {
    const hash = createHash("sha256");
    updateDatabaseActivityHash(
      hash,
      taskDb,
      workspacePath,
      variant,
      version === 1
        ? [
            "tasks",
            "task_group_members",
            "task_group_view_node_orders",
            "automations",
            "automation_runs",
            "off_peak_tasks",
          ]
        : [
            "tasks",
            "task_group_members",
            "task_group_workspace_bootstraps",
            "task_group_view_node_orders",
            "automations",
            "automation_runs",
            "off_peak_tasks",
          ],
      version,
    );
    if (sessionDb) {
      updateDatabaseActivityHash(
        hash,
        sessionDb,
        workspacePath,
        variant,
        ["session", "sessions"],
        version,
      );
    }
    const configEntries =
      configSnapshots?.get(variant) ??
      (await readSessionConfigEntries(getSessionConfigDirectory(ctx, workspacePath, variant)));
    for (const [relativePath, entry] of [...configEntries.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      hash.update(relativePath);
      hash.update(entry.kind);
      if (entry.kind === "file") hash.update(entry.content);
    }
    result[variant] = hash.digest("hex");
  }
  return result;
}

function updateDatabaseActivityHash(
  hash: ReturnType<typeof createHash>,
  db: Database,
  workspacePath: string,
  workspaceKey: string,
  tables: string[],
  version: WorkspaceActivityDigestVersion,
): void {
  for (const table of tables) {
    if (!hasTable(db, table)) continue;
    const column = [
      "workspace_key",
      "workspace_identity",
      "workspace_id",
      "workspace_path",
      "path",
    ].find((candidate) => hasColumn(db, table, candidate));
    let rows = (
      column
        ? db
            .prepare(`SELECT * FROM ${table} WHERE ${column} = ?`)
            .all(column === "workspace_path" || column === "path" ? workspacePath : workspaceKey)
        : db.prepare(`SELECT * FROM ${table}`).all()
    ) as unknown[];
    if (version === 2 && !column && table === "task_group_view_node_orders") {
      rows = rows.filter((row) => {
        const nodeKey = (row as { node_key?: unknown }).node_key;
        if (typeof nodeKey !== "string") return false;
        try {
          const parsed = JSON.parse(nodeKey) as unknown;
          return Array.isArray(parsed) && parsed[0] === workspaceKey;
        } catch {
          return false;
        }
      });
    }
    const normalized = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [
            key,
            typeof item === "bigint"
              ? item.toString()
              : Buffer.isBuffer(item)
                ? item.toString("base64")
                : item,
          ]),
      ),
    );
    normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    hash.update(table);
    hash.update(JSON.stringify(normalized));
  }
}
