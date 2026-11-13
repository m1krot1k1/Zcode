// 命令中心默认视图的上下文分区：最近改动文件与最近任务。
// 仅在无搜索词时渲染（调用方保证），保持原有的空态与行 key 规则。

import { ChevronDownIcon, MessageSquareIcon } from "lucide-react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import type { IntlInstance } from "@/i18n/index.js";
import {
  COMMAND_CENTER_SECTION_LIMIT,
  getTaskTitle,
  type TaskChangedFileSummary,
} from "./commandCenterSearch.js";
import { quickPickItemClassName, quickPickMetadataClassName } from "@/quickpick/quickPickStyles.js";

/**
 * 分区折叠时追加的「更多结果」行；已展开或未超出上限时不渲染。
 */
export function CommandCenterMoreResultsRow({
  expanded,
  count,
  label,
  onExpand,
}: {
  expanded: boolean;
  count: number;
  label: string;
  onExpand: () => void;
}) {
  if (expanded || count <= COMMAND_CENTER_SECTION_LIMIT) {
    return null;
  }

  return (
    <button
      type="button"
      className="mt-0.5 flex min-h-7 w-full items-center gap-1.5 rounded-xl px-2.5 pl-8 text-left text-ui-base text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
      onClick={onExpand}
    >
      {label}
      <ChevronDownIcon className="size-3.5" />
    </button>
  );
}

export function CommandCenterRecentChangesSection({
  rows,
  showEmpty = false,
  workspaceAbsPath,
  onSelect,
  intl,
}: {
  rows: TaskChangedFileSummary[];
  showEmpty?: boolean;
  workspaceAbsPath: string;
  onSelect: (file: TaskChangedFileSummary) => void;
  intl: IntlInstance;
}) {
  if (rows.length === 0 && !showEmpty) {
    return null;
  }

  return (
    <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.recentChanges" })}>
      {rows.length === 0 ? (
        <CommandEmpty className="px-4 py-5 text-foreground-subtle">
          {intl.formatMessage({ id: "commandCenter.empty.recentChanges" })}
        </CommandEmpty>
      ) : null}
      {rows.map((file) => {
        const relativePath = toWorkspaceRelativePath(workspaceAbsPath, file.path);
        const descriptor = resolveFileDisplayDescriptor(file.path);
        return (
          <CommandItem
            key={file.path}
            value={`${relativePath} +${file.added} -${file.removed}`}
            className={quickPickItemClassName}
            onSelect={() => onSelect(file)}
          >
            <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{relativePath}</span>
            <CommandShortcut className={quickPickMetadataClassName}>
              <span className="text-diff-added">+{file.added}</span>{" "}
              <span className="text-diff-removed">-{file.removed}</span>
            </CommandShortcut>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

export function CommandCenterRecentTasksSection({
  rows,
  showEmpty = false,
  intl,
  onSelect,
}: {
  rows: ZCodeTaskMeta[];
  showEmpty?: boolean;
  intl: IntlInstance;
  onSelect: (task: ZCodeTaskMeta) => void;
}) {
  if (rows.length === 0 && !showEmpty) {
    return null;
  }

  return (
    <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.recentTasks" })}>
      {rows.length === 0 ? (
        <CommandEmpty className="px-4 py-5 text-foreground-subtle">
          {intl.formatMessage({ id: "commandCenter.empty.recentTasks" })}
        </CommandEmpty>
      ) : null}
      {rows.map((task) => {
        const title = getTaskTitle(task, intl.formatMessage({ id: "taskList.untitled" }));
        // Bugfix：cmdk 按 value 判断选中；标题可重复，必须用工作区身份和任务 ID 隔离重名行。
        return (
          <CommandItem
            key={`${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`}
            value={`recent-task:${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`}
            className={quickPickItemClassName}
            onSelect={() => onSelect(task)}
          >
            <MessageSquareIcon className="size-3.5 text-foreground-subtle" />
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <CommandShortcut className={quickPickMetadataClassName}>
              {formatTaskRelativeTime(task.updatedAt, intl)}
            </CommandShortcut>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}
