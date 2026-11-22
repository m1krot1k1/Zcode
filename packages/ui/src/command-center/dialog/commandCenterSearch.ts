// 命令中心搜索的纯函数层：范围前缀解析、命令匹配、任务与文件结果整形。
// 从 CommandCenterDialog.tsx 拆出，保持原有判定顺序、去重键与截断上限不变。

import type { WorkspaceFileEntry, ZCodeTaskChangeSummary, ZCodeTaskMeta } from "@zcode/shared";
import type { CommandCenterSearchScope } from "@/command-center/commandCenterSearchHistory.js";
import type { QuickPickCommand } from "@/quickpick/quickPickCommands.js";

export const EMPTY_QUICK_PICK_COMMANDS: QuickPickCommand[] = [];
export const COMMAND_CENTER_SECTION_LIMIT = 3;
export const COMMAND_CENTER_CONTEXT_SECTION_LIMIT = 3;
export const COMMAND_CENTER_FILE_RESULT_LIMIT = 80;
export const COMMAND_CENTER_TASK_RESULT_LIMIT = 80;

export type CommandCenterSectionId = "commands" | "conversations" | "files";
export type TaskSearchResultItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};
export type TaskChangedFileSummary = ZCodeTaskChangeSummary["files"][number];
export type TaskSearchResultRow = {
  key: string;
  task: TaskSearchResultItem;
  searchSnippet?: string;
  snippetIndex?: number;
};

export function getWorkspaceFileDirectory(entry: WorkspaceFileEntry): string {
  const slashIndex = entry.relativePath.lastIndexOf("/");
  return slashIndex === -1 ? "" : entry.relativePath.slice(0, slashIndex);
}

function buildWorkspaceFileSearchText(entry: WorkspaceFileEntry): string {
  return `${entry.name} ${entry.relativePath}`.toLocaleLowerCase();
}

export function filterWorkspaceFileEntries(
  entries: readonly WorkspaceFileEntry[],
  query: string,
): WorkspaceFileEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const parts = normalizedQuery.split(/\s+/).filter(Boolean);
  return entries
    .filter((entry) => entry.type === "file")
    .filter((entry) => {
      const searchText = buildWorkspaceFileSearchText(entry);
      return parts.every((part) => searchText.includes(part));
    })
    .slice(0, COMMAND_CENTER_FILE_RESULT_LIMIT);
}

function normalizeSnippetForDedupe(snippet: string): string {
  return snippet
    .replace(/^\.\.\./, "")
    .replace(/\.\.\.$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function getUniqueTaskSearchSnippets(task: TaskSearchResultItem): string[] {
  const snippets = task.searchSnippets?.length
    ? task.searchSnippets
    : task.searchSnippet
      ? [task.searchSnippet]
      : [];
  const seen = new Set<string>();
  const uniqueSnippets: string[] = [];
  for (const snippet of snippets) {
    const normalized = normalizeSnippetForDedupe(snippet);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueSnippets.push(snippet);
  }

  return uniqueSnippets;
}

export function getTaskTitle(task: ZCodeTaskMeta, untitledLabel: string): string {
  return task.title.trim() || untitledLabel;
}

export function compareRecentChangedFiles(
  left: TaskChangedFileSummary,
  right: TaskChangedFileSummary,
): number {
  if (right.lastTurnIndex !== left.lastTurnIndex) {
    return right.lastTurnIndex - left.lastTurnIndex;
  }
  if (right.writeCount !== left.writeCount) {
    return right.writeCount - left.writeCount;
  }
  return left.path.localeCompare(right.path);
}

export function resolveQueryScope(rawQuery: string): {
  query: string;
  scope: CommandCenterSearchScope;
  explicitScope: boolean;
} {
  const trimmed = rawQuery.trimStart();
  const prefix = trimmed[0];
  if (prefix === ">") {
    return { query: trimmed.slice(1).trimStart(), scope: "commands", explicitScope: true };
  }
  if (prefix === "#") {
    return { query: trimmed.slice(1).trimStart(), scope: "conversations", explicitScope: true };
  }
  if (prefix === "@") {
    return { query: trimmed.slice(1).trimStart(), scope: "files", explicitScope: true };
  }

  return { query: rawQuery.trim(), scope: "all", explicitScope: false };
}

/**
 * 搜索历史 chip 的 scope 前缀（如 commands → ">"）。
 * 提取为独立函数以便 CommandCenterSearchHistory 组件复用。
 */
export function scopeToPrefix(scope: CommandCenterSearchScope): string {
  switch (scope) {
    case "commands":
      return ">";
    case "conversations":
      return "#";
    case "files":
      return "@";
    default:
      return "";
  }
}

export function matchesCommand(command: QuickPickCommand, title: string, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const searchText = `${title} ${command.keywords.join(" ")}`.toLocaleLowerCase();
  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => searchText.includes(part));
}

export function buildTaskResultRows(params: {
  tasks: readonly TaskSearchResultItem[];
  query: string;
}): TaskSearchResultRow[] {
  const rows: TaskSearchResultRow[] = [];
  const taskByKey = new Map<string, TaskSearchResultItem>();

  for (const task of params.tasks) {
    const taskKey = `${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`;
    const existingTask = taskByKey.get(taskKey);
    if (!existingTask) {
      taskByKey.set(taskKey, task);
      continue;
    }

    taskByKey.set(taskKey, {
      ...existingTask,
      searchSnippets: [
        ...getUniqueTaskSearchSnippets(existingTask),
        ...getUniqueTaskSearchSnippets(task),
      ],
    });
  }

  for (const task of taskByKey.values()) {
    const taskKey = `${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`;
    const snippets = params.query ? getUniqueTaskSearchSnippets(task) : [];
    if (snippets.length === 0) {
      rows.push({ key: taskKey, task });
      continue;
    }

    snippets.forEach((snippet, snippetIndex) => {
      rows.push({
        key: `${taskKey}:${snippetIndex}`,
        task,
        searchSnippet: snippet,
        snippetIndex,
      });
    });
  }

  return rows;
}
